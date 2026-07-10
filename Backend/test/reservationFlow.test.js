const { test } = require('node:test');
const assert = require('node:assert/strict');
const reservationFlow = require('../services/reservationFlow');

// Drives the pure state machine end-to-end with a fixed sequence of answers, returning the
// final state. Throws if any answer is rejected (fails the test with a useful message) unless
// `allowRejections` is passed, in which case rejected replies are collected for inspection.
function driveFlow(answers) {
    let { state, reply } = reservationFlow.start();
    const replies = [reply];
    for (const answer of answers) {
        const result = reservationFlow.handleAnswer(state, answer);
        state = result.state;
        replies.push(result.reply);
        if (result.readyToSubmit) return { state, replies, readyToSubmit: true };
    }
    return { state, replies, readyToSubmit: false };
}

const HOUSE_RENTAL_ANSWERS = [
    'Jane Doe',                          // personName
    'jane.doe@ufl.edu',                  // contactEmail
    '352-123-4567',                      // contactPhone
    '2',                                 // affiliation -> UF Student (not with an organization)
    'Test Org',                          // orgName
    '1',                                 // requestType -> House Rental
    '12/31/2026',                        // requestedDate
    '3:00 PM',                           // startTime
    '5:00 PM',                           // endTime
    'none',                              // alternateDate
    '40',                                // attendees
    'Birthday party',                    // purpose
    '1,3',                               // addons -> Tables + AV setup
    '2',                                 // openOrClosed -> Closed
    '2',                                 // paymentForm -> Onsite
    '2',                                 // servingFood -> No
    '2',                                 // taxExempt -> No
];

test('start() greets and asks the first question', () => {
    const { reply, state } = reservationFlow.start();
    assert.match(reply, /name/i);
    assert.deepEqual(state.answers, {});
    assert.equal(state.awaitingConfirm, false);
});

test('full House Rental happy path reaches confirm, then submit', () => {
    const { state, replies, readyToSubmit } = driveFlow([...HOUSE_RENTAL_ANSWERS, 'submit']);
    assert.equal(readyToSubmit, true);
    assert.equal(state.answers.requestType, 'House Rental');
    assert.equal(state.answers.contactPhone, '352-123-4567');
    assert.deepEqual(state.answers.addons, ['Tables (6-ft foldable ones)', 'AV set up with TV ($50 flat rate)']);
    assert.equal(state.answers.taxExempt, 'No');
    // The summary (second-to-last reply before "submit") should list every collected field.
    const summary = replies[replies.length - 2];
    assert.match(summary, /Jane Doe/);
    assert.match(summary, /submit/i);
});

test('non-House-Rental request type skips straight to summary after the core fields', () => {
    const coreOnly = [
        'John Smith', 'john@ufl.edu', '352-555-0100',
        '1',                    // affiliation
        'Chess Club',           // orgName
        '4',                    // requestType -> Lane Reservation Only
        '01/15/2027', '2:00 PM', '4:00 PM', 'none', '10', 'Lane reservation test',
    ];
    const { state } = driveFlow(coreOnly);
    assert.equal(state.awaitingConfirm, true);
    assert.equal(state.answers.requestType, 'Lane Reservation Only');
    assert.equal('addons' in state.answers, false, 'House-Rental-only fields must not be asked');
    const summary = reservationFlow.summaryText(state.answers);
    assert.match(summary, /Lane Reservation Only/);
    assert.match(summary, /staff will follow up/i);
});

test('tax-exempt "Yes" appends a certificate-by-email note to the summary', () => {
    const answers = HOUSE_RENTAL_ANSWERS.slice(0, -1).concat(['1']); // taxExempt -> Yes
    const { state } = driveFlow(answers);
    const summary = reservationFlow.summaryText(state.answers);
    assert.match(summary, /email.*certificate|certificate.*email/i);
});

test('invalid email is rejected and re-prompts the same question', () => {
    const { state: afterName } = driveFlow(['Jane Doe']);
    const result = reservationFlow.handleAnswer(afterName, 'not-an-email');
    assert.equal('contactEmail' in result.state.answers, false);
    assert.match(result.reply, /valid email/i);
});

test('invalid phone number is rejected', () => {
    let state = reservationFlow.start().state;
    state = reservationFlow.handleAnswer(state, 'Jane Doe').state;
    state = reservationFlow.handleAnswer(state, 'jane@ufl.edu').state;
    const result = reservationFlow.handleAnswer(state, '12345');
    assert.equal('contactPhone' in result.state.answers, false);
    assert.match(result.reply, /10-digit/i);
});

test('invalid date is rejected (bad calendar date and bad format both)', () => {
    const stepsUntilDate = HOUSE_RENTAL_ANSWERS.slice(0, 6); // through requestType
    const { state } = driveFlow(stepsUntilDate);
    const badFormat = reservationFlow.handleAnswer(state, 'next Saturday');
    assert.equal('requestedDate' in badFormat.state.answers, false);
    const badCalendar = reservationFlow.handleAnswer(state, '02/30/2026');
    assert.equal('requestedDate' in badCalendar.state.answers, false);
});

test('numbered-choice matching: exact number, exact label, unambiguous substring, and ambiguous rejection', () => {
    const options = [{ label: 'Open' }, { label: 'Closed' }];
    assert.equal(reservationFlow.matchChoice('1', options), 0);
    assert.equal(reservationFlow.matchChoice('Closed', options), 1);
    assert.equal(reservationFlow.matchChoice('clos', options), 1); // unambiguous substring
    assert.equal(reservationFlow.matchChoice('z', options), null); // no match
    const ambiguous = [{ label: 'Onsite (check/card)' }, { label: 'Online only' }];
    assert.equal(reservationFlow.matchChoice('on', ambiguous), null, 'a substring matching multiple options must be rejected as ambiguous');
});

test('multi-choice accepts "none" as an empty selection', () => {
    const withNoAddons = HOUSE_RENTAL_ANSWERS.map((a, i) => (i === 12 ? 'none' : a));
    const { state } = driveFlow(withNoAddons);
    assert.deepEqual(state.answers.addons, []);
});

test('cancel mid-flow clears state and returns a cancellation message', () => {
    const { state: afterName } = driveFlow(['Jane Doe']);
    const result = reservationFlow.handleAnswer(afterName, 'cancel');
    assert.equal(result.state, null);
    assert.match(result.reply, /cancel/i);
});

test('cancel while awaiting confirm also clears state', () => {
    const { state } = driveFlow(HOUSE_RENTAL_ANSWERS);
    assert.equal(state.awaitingConfirm, true);
    const result = reservationFlow.handleAnswer(state, 'cancel');
    assert.equal(result.state, null);
});

test('an unrecognized reply while awaiting confirm re-shows the summary instead of advancing', () => {
    const { state } = driveFlow(HOUSE_RENTAL_ANSWERS);
    const result = reservationFlow.handleAnswer(state, 'looks good');
    assert.equal(result.readyToSubmit, undefined);
    assert.match(result.reply, /submit/i);
});

test('buildSubmissionPayload returns a plain shallow copy of the answers', () => {
    const answers = { personName: 'X', addons: ['A'] };
    const payload = reservationFlow.buildSubmissionPayload(answers);
    assert.deepEqual(payload, answers);
    assert.notEqual(payload, answers); // must be a copy, not the same reference
});

test('START_TRIGGER_RE matches only an exact "start" (case-insensitive), not a substring', () => {
    assert.equal(reservationFlow.START_TRIGGER_RE.test('start'), true);
    assert.equal(reservationFlow.START_TRIGGER_RE.test('START'), true);
    assert.equal(reservationFlow.START_TRIGGER_RE.test('lets start now'), false);
    assert.equal(reservationFlow.START_TRIGGER_RE.test('starting'), false);
});

test('a rejected single-choice answer marks invalid + pendingPrompt, and does NOT duplicate the options list (regression: the numbered list appeared twice in the reply)', () => {
    const { state } = driveFlow(['Jane Doe', 'jane@ufl.edu', '352-123-4567']); // now on affiliation
    const result = reservationFlow.handleAnswer(state, 'can I type a number as my answer?');
    assert.equal(result.invalid, true);
    assert.ok(result.pendingPrompt, 'pendingPrompt should be set on a rejected answer');
    // The options list (e.g. "3. UF Department...") must appear exactly once in the full reply,
    // not once in the error text and again in the re-prompt.
    const occurrences = (result.reply.match(/UF Department \(for departmental events only\)/g) || []).length;
    assert.equal(occurrences, 1);
});

test('renderPrompt (via a fresh single-choice prompt) tells the visitor to reply with a number', () => {
    const { replies } = driveFlow(['Jane Doe', 'jane@ufl.edu', '352-123-4567']);
    const affiliationPrompt = replies[replies.length - 1];
    assert.match(affiliationPrompt, /reply with the number/i);
});

test('a rejected answer at the awaitingConfirm stage also marks invalid + pendingPrompt', () => {
    const { state } = driveFlow(HOUSE_RENTAL_ANSWERS);
    const result = reservationFlow.handleAnswer(state, 'wait, can I change my date?');
    assert.equal(result.invalid, true);
    assert.match(result.pendingPrompt, /submit/i);
});
