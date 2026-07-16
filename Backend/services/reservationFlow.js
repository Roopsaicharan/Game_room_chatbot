// Deterministic, code-driven conversation state machine for the Game Room reservation request
// flow. No LLM calls happen anywhere in this module — every question, validation rule, and
// branch decision is plain code, matching this codebase's existing router/output-guard
// philosophy that control flow belongs in testable code, not model judgment.
//
// `STEPS` is the single source of truth for BOTH the chat conversation and the Playwright
// form-filling adapters (services/reservationSubmitter/*): each step's `question` field is the
// literal text that must also appear on the target form, so the adapters can locate fields by
// that same string instead of maintaining a second, separately-drifting field list.

const SCHEMA_VERSION = 1;

const CANCEL_RE = /^cancel$/i;
const START_TRIGGER_RE = /^start$/i;

const GREETING = "Great — let's get your reservation request started! I'll ask a few questions one at a time; type **cancel** anytime to stop.";
const CANCELLED_TEXT = "No problem, I've cancelled the reservation request. Let me know if you'd like to start again anytime.";

// --- Field-level validators ------------------------------------------------------------

function trimmed(raw) {
    return String(raw == null ? '' : raw).trim();
}

function validateText({ maxLength = 300 } = {}) {
    return (raw) => {
        const value = trimmed(raw);
        if (!value) return { ok: false, error: "That can't be empty — please give me an answer." };
        if (value.length > maxLength) return { ok: false, error: `That's a bit long — please keep it under ${maxLength} characters.` };
        return { ok: true, value };
    };
}

function validateOptionalText({ maxLength = 300 } = {}) {
    return (raw) => {
        const value = trimmed(raw);
        if (!value || /^(none|no|n\/a|skip)$/i.test(value)) return { ok: true, value: null };
        if (value.length > maxLength) return { ok: false, error: `That's a bit long — please keep it under ${maxLength} characters.` };
        return { ok: true, value };
    };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(raw) {
    const value = trimmed(raw);
    if (!EMAIL_RE.test(value)) return { ok: false, error: "That doesn't look like a valid email address — could you try again? (e.g. name@ufl.edu)" };
    return { ok: true, value };
}

function validatePhone(raw) {
    const digits = trimmed(raw).replace(/\D/g, '');
    if (digits.length !== 10) return { ok: false, error: 'Please enter a 10-digit US phone number (e.g. 352-392-1637).' };
    const value = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return { ok: true, value };
}

const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
function validateDate(raw) {
    const value = trimmed(raw);
    const match = DATE_RE.exec(value);
    if (!match) return { ok: false, error: 'Please use MM/DD/YYYY format (e.g. 12/31/2026).' };
    const [, mm, dd, yyyy] = match;
    const month = parseInt(mm, 10);
    const day = parseInt(dd, 10);
    const year = parseInt(yyyy, 10);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
        return { ok: false, error: "That date doesn't look valid — please double check it (MM/DD/YYYY)." };
    }
    return { ok: true, value: `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}` };
}

function validateOptionalDate(raw) {
    const value = trimmed(raw);
    if (!value || /^(none|no|n\/a|skip)$/i.test(value)) return { ok: true, value: null };
    return validateDate(raw);
}

// Accepts 24h "HH:MM" or 12h "H:MM AM/PM"; normalizes to a canonical 12h display string so
// the summary and the target form both see one consistent format.
const TIME_24H_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const TIME_12H_RE = /^(0?[1-9]|1[0-2]):([0-5]\d)\s*(am|pm)$/i;
function validateTime(raw) {
    const value = trimmed(raw);
    let hour24;
    let minute;
    const m24 = TIME_24H_RE.exec(value);
    const m12 = TIME_12H_RE.exec(value);
    if (m24) {
        hour24 = parseInt(m24[1], 10);
        minute = m24[2];
    } else if (m12) {
        let h = parseInt(m12[1], 10) % 12;
        if (/pm/i.test(m12[3])) h += 12;
        hour24 = h;
        minute = m12[2];
    } else {
        return { ok: false, error: 'Please give a time like "3:00 PM" or "15:00".' };
    }
    const displayHour = hour24 % 12 === 0 ? 12 : hour24 % 12;
    const suffix = hour24 < 12 ? 'AM' : 'PM';
    return { ok: true, value: `${displayHour}:${minute} ${suffix}` };
}

function validateAttendees(raw) {
    const value = trimmed(raw);
    if (!/^\d+$/.test(value)) return { ok: false, error: 'Please give a whole number (e.g. 25).' };
    const n = parseInt(value, 10);
    if (n < 1 || n > 500) return { ok: false, error: 'Please give a number between 1 and 500.' };
    return { ok: true, value: n };
}

// The manual's customer rules state bowling is 6 people per lane, so a "Lane Reservation Only"
// request can derive the number of lanes from the headcount rather than making the visitor work
// it out themselves.
const PEOPLE_PER_LANE = 6;
function lanesForAttendees(attendees) {
    return Math.ceil(attendees / PEOPLE_PER_LANE);
}

// --- Numbered-choice matching (deterministic, no LLM) -----------------------------------
// 1) an in-range number picks by index
// 2) else an exact (case-insensitive) label match
// 3) else an unambiguous substring match (exactly one option contains it)
// 4) else rejected as ambiguous/unrecognized
function matchChoice(raw, options) {
    const value = trimmed(raw);
    if (!value) return null;
    if (/^\d+$/.test(value)) {
        const n = parseInt(value, 10);
        if (n >= 1 && n <= options.length) return n - 1;
        return null;
    }
    const lower = value.toLowerCase();
    const exact = options.findIndex((o) => o.label.toLowerCase() === lower);
    if (exact !== -1) return exact;
    const contains = options
        .map((o, i) => ({ i, hit: o.label.toLowerCase().includes(lower) }))
        .filter((x) => x.hit);
    if (contains.length === 1) return contains[0].i;
    return null;
}

function formatOptionsList(options) {
    return options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
}

// Error text is intentionally short and does NOT repeat the options list - handleAnswer's
// re-prompt already appends renderPrompt(currentStep), which shows the list once. Duplicating
// it here as well produced a visibly repeated numbered list (a real reported bug).
function validateSingleChoice(options) {
    return (raw) => {
        const idx = matchChoice(raw, options);
        if (idx === null) {
            return { ok: false, error: "Sorry, I didn't catch that - please reply with just the number." };
        }
        return { ok: true, value: options[idx].label };
    };
}

function validateMultiChoice(options) {
    return (raw) => {
        const value = trimmed(raw);
        if (!value || /^(none|no|skip)$/i.test(value)) return { ok: true, value: [] };
        const tokens = value.split(',').map((t) => t.trim()).filter(Boolean);
        const chosen = new Set();
        for (const token of tokens) {
            const idx = matchChoice(token, options);
            if (idx === null) {
                return { ok: false, error: `I didn't recognize "${token}" - please reply with option numbers separated by commas.` };
            }
            chosen.add(idx);
        }
        return { ok: true, value: [...chosen].sort((a, b) => a - b).map((i) => options[i].label) };
    };
}

// --- Step schema -------------------------------------------------------------------------

const AFFILIATION_OPTIONS = [
    { label: 'Registered UF Organization/Club' },
    { label: 'UF Student (not with an organization)' },
    { label: 'UF Department (for departmental events only)' },
    { label: 'UF Faculty/staff' },
    { label: 'Non-Affiliated with UF' },
];

// Affiliations where the visitor has no organization/department to name. Issue #9: we don't ask
// these visitors for an org name. Issue #1: the target form still marks that field REQUIRED, so
// rather than leave it blank (which makes the form reject the submission) the orgName step
// auto-fills "N/A" for them via its autoAnswer hook below.
const NO_ORG_AFFILIATIONS = new Set([
    'UF Student (not with an organization)',
    'Non-Affiliated with UF',
]);

const REQUEST_TYPE_OPTIONS = [
    { label: 'House Rental' },
    { label: 'Half House Rental' },
    { label: 'Weekend Rental Package' },
    { label: 'Lane Reservation Only' },
    { label: 'A la carte (lanes, billiards tables, ping pong tables, etc)' },
];

const ADDON_OPTIONS = [
    { label: 'Tables (6-ft foldable ones)' },
    { label: 'Karaoke set up ($50/hour)' },
    { label: 'AV set up with TV ($50 flat rate)' },
    { label: 'Personalized Messaging on Lane Screens' },
];

const OPEN_CLOSED_OPTIONS = [{ label: 'Open' }, { label: 'Closed' }];
const PAYMENT_OPTIONS = [{ label: 'Chartfield' }, { label: 'Onsite (check/card)' }, { label: 'SAR (SG Funding)' }];
const YES_NO_OPTIONS = [{ label: 'Yes' }, { label: 'No' }];

const isHouseRental = (answers) => answers.requestType === 'House Rental';

const STEPS = [
    {
        id: 'personName',
        question: 'Name of Person Completing Form',
        promptText: "What's your name?",
        type: 'text',
        appliesTo: () => true,
        validate: validateText(),
    },
    {
        id: 'contactEmail',
        question: 'Contact Email Address',
        promptText: "What's the best contact email address?",
        type: 'email',
        appliesTo: () => true,
        validate: validateEmail,
    },
    {
        id: 'contactPhone',
        question: 'Phone Number',
        promptText: "And a phone number we can reach you at?",
        type: 'phone',
        appliesTo: () => true,
        validate: validatePhone,
    },
    {
        id: 'affiliation',
        question: 'Affiliation',
        promptText: 'Which affiliation applies to you for this event?',
        type: 'single-choice',
        options: AFFILIATION_OPTIONS,
        appliesTo: () => true,
        validate: validateSingleChoice(AFFILIATION_OPTIONS),
    },
    {
        id: 'orgName',
        question: 'Name of Organization/Department (no acronyms)',
        promptText: 'What organization or department is this for? (spell it out, no acronyms)',
        type: 'text',
        // Always part of the request (the form requires it), but silently auto-answered "N/A"
        // for the no-org affiliations so those visitors are never prompted for it (issues #9/#1).
        appliesTo: () => true,
        autoAnswer: (answers) => (NO_ORG_AFFILIATIONS.has(answers.affiliation) ? 'N/A' : undefined),
        validate: validateText(),
    },
    {
        id: 'requestType',
        question: 'Request Type',
        promptText: 'What type of reservation would you like?',
        type: 'single-choice',
        options: REQUEST_TYPE_OPTIONS,
        appliesTo: () => true,
        validate: validateSingleChoice(REQUEST_TYPE_OPTIONS),
    },
    {
        id: 'requestedDate',
        question: 'Requested Date (MM/DD/YYYY)',
        promptText: 'What date would you like to reserve? (MM/DD/YYYY)',
        type: 'date',
        appliesTo: () => true,
        validate: validateDate,
    },
    {
        id: 'startTime',
        question: 'Start Time of Reservation (HH:MM)',
        promptText: 'What time should the reservation start? (e.g. 3:00 PM)',
        type: 'time',
        appliesTo: () => true,
        validate: validateTime,
    },
    {
        id: 'endTime',
        question: 'End Time of Reservation (HH:MM)',
        promptText: 'And what time should it end?',
        type: 'time',
        appliesTo: () => true,
        validate: validateTime,
    },
    {
        id: 'alternateDate',
        question: "If your requested date is unavailable, is there an alternate date that you would prefer? Please list below.",
        // The Google Forms test target was built with a shorter paraphrase of this question -
        // formLabelHint lets the googleFormsAdapter match on that instead of the full literal
        // text, without changing `question` (which must stay the real Qualtrics form's exact
        // wording for that adapter's fallback matching).
        formLabelHint: 'Alternate date if requested date unavailable',
        promptText: "If your requested date isn't available, is there an alternate date you'd prefer? (or say \"none\")",
        type: 'date',
        appliesTo: () => true,
        validate: validateOptionalDate,
    },
    {
        id: 'attendees',
        question: 'Estimated number of attendees',
        promptText: 'About how many people will attend?',
        type: 'number',
        appliesTo: () => true,
        validate: validateAttendees,
        // For a lane-only request, confirm the derived lane count back to the visitor (6
        // people/lane per the manual) right after they give the headcount, so they don't have
        // to specify lanes directly. Returns null for every other request type.
        noteAfter: (answers) => {
            if (answers.requestType !== 'Lane Reservation Only' || typeof answers.attendees !== 'number') {
                return null;
            }
            const lanes = lanesForAttendees(answers.attendees);
            const overCap = lanes > 5
                ? ' Heads up: lane reservations over 5 lanes aren\'t guaranteed and are subject to approval.'
                : '';
            return `That works out to about ${lanes} lane${lanes === 1 ? '' : 's'} (we plan roughly ${PEOPLE_PER_LANE} people per lane), which I'll note on your request.${overCap}`;
        },
    },
    {
        id: 'purpose',
        question: 'What is the purpose of your event? (i.e. Organization social, birthday party, etc.)',
        formLabelHint: 'Purpose of event',
        promptText: "What's the purpose of the event? (e.g. organization social, birthday party)",
        type: 'text',
        appliesTo: () => true,
        validate: validateText({ maxLength: 500 }),
    },
    // --- House Rental branch only -------------------------------------------------------
    {
        id: 'addons',
        question: 'Please check which add-ons, if any, you would like to include in your reservation.',
        formLabelHint: 'Add-ons',
        promptText: "Any add-ons you'd like? Reply with numbers separated by commas, or \"none\":",
        type: 'multi-choice',
        options: ADDON_OPTIONS,
        appliesTo: isHouseRental,
        validate: validateMultiChoice(ADDON_OPTIONS),
    },
    {
        id: 'openOrClosed',
        question: 'Will your event be open or closed to the public?',
        promptText: 'Will your event be open or closed to the public?',
        type: 'single-choice',
        options: OPEN_CLOSED_OPTIONS,
        appliesTo: isHouseRental,
        validate: validateSingleChoice(OPEN_CLOSED_OPTIONS),
    },
    {
        id: 'paymentForm',
        question: 'Form of Payment',
        promptText: 'How will this be paid for?',
        type: 'single-choice',
        options: PAYMENT_OPTIONS,
        // Payment applies to every reservation, not just House Rentals — and the target form
        // marks Form of Payment REQUIRED for all request types, so gating it to House Rental left
        // every other request type unable to submit (issue #1). Asked for all types now.
        appliesTo: () => true,
        validate: validateSingleChoice(PAYMENT_OPTIONS),
    },
    {
        id: 'servingFood',
        question: 'Do you plan on serving food?',
        promptText: 'Do you plan on serving food at this event?',
        type: 'single-choice',
        options: YES_NO_OPTIONS,
        // Likewise required by the form for all request types (issue #1).
        appliesTo: () => true,
        validate: validateSingleChoice(YES_NO_OPTIONS),
    },
    {
        id: 'taxExempt',
        question: 'Is your organization/group tax-exempt?',
        promptText: 'Is your organization or group tax-exempt?',
        type: 'single-choice',
        options: YES_NO_OPTIONS,
        // Required by the form for all request types (issue #1) — tax status bears on any paid
        // reservation, so it's asked for every request type, not just House Rentals.
        appliesTo: () => true,
        validate: validateSingleChoice(YES_NO_OPTIONS),
    },
    // No file-upload step: the real form's tax-exempt certificate upload has no chat
    // equivalent yet. See summaryText()'s note appended when taxExempt === 'Yes'.
];

function getCurrentStep(answers) {
    return STEPS.find((step) => !(step.id in answers) && step.appliesTo(answers)) || null;
}

// Advances past any steps that can be answered WITHOUT prompting the visitor (a step whose
// autoAnswer(answers) returns a value — e.g. orgName -> "N/A" for a solo UF student). Loops so a
// run of consecutive auto-answers resolves in one advance, and returns the next step that must
// actually be asked (or null when everything is answered). The value-carrying `answers` it
// returns must be persisted by the caller so the auto-filled fields reach the summary/submission.
function resolveAutoAnswers(answers) {
    let current = answers;
    for (let i = 0; i <= STEPS.length; i++) {
        const step = getCurrentStep(current);
        if (!step) return { answers: current, step: null };
        if (typeof step.autoAnswer === 'function') {
            const value = step.autoAnswer(current);
            if (value !== undefined && value !== null) {
                current = { ...current, [step.id]: value };
                continue;
            }
        }
        return { answers: current, step };
    }
    return { answers: current, step: getCurrentStep(current) };
}

function renderPrompt(step) {
    // Multi-choice promptTexts already spell out how to answer ("Reply with numbers separated
    // by commas, or \"none\"") since that instruction is step-specific (comma list vs a single
    // pick) - single-choice steps don't, so the hint is added generically here, once, for all
    // of them, rather than repeated in every single-choice promptText.
    if (step.type === 'single-choice') {
        return `${step.promptText} (reply with the number)\n\n${formatOptionsList(step.options)}`;
    }
    if (step.type === 'multi-choice') {
        return `${step.promptText}\n\n${formatOptionsList(step.options)}`;
    }
    return step.promptText;
}

function summaryText(answers) {
    const lines = STEPS
        .filter((step) => step.appliesTo(answers) && step.id in answers)
        .map((step) => {
            const value = answers[step.id];
            const display = Array.isArray(value) ? (value.length ? value.join(', ') : 'None') : (value == null ? 'None' : value);
            return `- ${step.question}: ${display}`;
        });

    let notes = '';
    if (answers.requestType === 'Lane Reservation Only' && typeof answers.attendees === 'number') {
        const lanes = lanesForAttendees(answers.attendees);
        notes += `\n\nBased on ${answers.attendees} attendees at ${PEOPLE_PER_LANE} people per lane, that's about ${lanes} lane${lanes === 1 ? '' : 's'} — staff will confirm final lane availability.`;
    }
    if (answers.taxExempt === 'Yes') {
        notes += "\n\nSince you indicated tax-exempt status, please email a copy of your tax-exempt certificate separately — this chat can't accept file uploads yet.";
    }
    if (answers.requestType && answers.requestType !== 'House Rental') {
        notes += `\n\nSince this is a ${answers.requestType} request, Game Room staff will follow up with any additional details specific to that request type.`;
    }

    return `Here's what I have so far:\n${lines.join('\n')}${notes}\n\nType **submit** to send this request, or **cancel** to stop.`;
}

function start() {
    const { answers, step: firstStep } = resolveAutoAnswers({});
    const state = { version: SCHEMA_VERSION, answers, awaitingConfirm: false, startedAt: new Date().toISOString() };
    return { state, reply: `${GREETING}\n\n${renderPrompt(firstStep)}` };
}

// `invalid: true` + `pendingPrompt` mark a rejected answer (as opposed to an accepted one or a
// cancellation) - the caller (chat.js's handleReservationTurn) uses this to detect when a
// message that failed validation actually reads like a genuine question, so it can answer the
// question for real via the normal RAG pipeline and then re-show `pendingPrompt` as a reminder,
// instead of just repeating a "sorry, I didn't catch that" at someone who wasn't trying to
// answer at all.
function handleAnswer(state, rawMessage) {
    if (state.awaitingConfirm) {
        const trimmedMsg = trimmed(rawMessage).toLowerCase();
        if (trimmedMsg === 'submit') {
            return { state: { ...state, awaitingConfirm: false }, reply: null, readyToSubmit: true };
        }
        if (trimmedMsg === 'cancel') {
            return { state: null, reply: CANCELLED_TEXT };
        }
        const pendingPrompt = 'Please type **submit** to send this request, or **cancel** to stop.';
        return { state, reply: `${pendingPrompt}\n\n${summaryText(state.answers)}`, invalid: true, pendingPrompt };
    }

    if (CANCEL_RE.test(trimmed(rawMessage))) {
        return { state: null, reply: CANCELLED_TEXT };
    }

    const currentStep = getCurrentStep(state.answers);
    if (!currentStep) {
        // Defensive: every field is already answered but awaitingConfirm was never set.
        return { state: { ...state, awaitingConfirm: true }, reply: summaryText(state.answers) };
    }

    const result = currentStep.validate(rawMessage, state.answers);
    if (!result.ok) {
        const pendingPrompt = renderPrompt(currentStep);
        return { state, reply: `${result.error}\n\n${pendingPrompt}`, invalid: true, pendingPrompt };
    }

    const answered = { ...state.answers, [currentStep.id]: result.value };
    // An accepted answer can carry a derived confirmation (e.g. lanes-needed for a lane-only
    // request) that's shown before the next question / summary.
    const note = typeof currentStep.noteAfter === 'function' ? currentStep.noteAfter(answered) : null;
    const prefix = note ? `${note}\n\n` : '';
    // Silently fill any steps that don't need to be asked (e.g. orgName -> "N/A") before deciding
    // what to prompt next.
    const { answers, step: nextStep } = resolveAutoAnswers(answered);
    if (nextStep) {
        return { state: { ...state, answers }, reply: `${prefix}${renderPrompt(nextStep)}` };
    }
    return { state: { ...state, answers, awaitingConfirm: true }, reply: `${prefix}${summaryText(answers)}` };
}

function buildSubmissionPayload(answers) {
    return { ...answers };
}

module.exports = {
    SCHEMA_VERSION,
    CANCEL_RE,
    START_TRIGGER_RE,
    STEPS,
    start,
    handleAnswer,
    buildSubmissionPayload,
    summaryText,
    // exported for tests
    matchChoice,
    getCurrentStep,
};
