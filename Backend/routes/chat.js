const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const navigator = require('../lib/navigatorClient');
const { buildSystemPrompt, CANNED_RESPONSES } = require('../lib/personaPrompt');
const router_ = require('../services/router');
const liveInfo = require('../services/liveInfo');
const { searchManual } = require('../services/searchManual');
const outputGuard = require('../services/outputGuard');
const analyticsStore = require('../services/analyticsStore');
const reservationFlow = require('../services/reservationFlow');
const reservationSubmitter = require('../services/reservationSubmitter');
const reservationStore = require('../services/reservationStore');

const router = express.Router();

// Every chat message can trigger up to three Navigator API calls (classify+rewrite, embed,
// complete), so an unthrottled /api/chat is both a cost risk and a DoS surface. Throttle per
// client. Uses the session id when present (a logged-in staff/admin shares one), else the IP.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN, 10) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    // Prefer the session id (a logged-in staff/admin shares one) so a single user is one
    // bucket; fall back to the IP via the library's ipKeyGenerator, which normalizes IPv6
    // into a /64 subnet key so v6 clients can't trivially rotate addresses to bypass limits.
    keyGenerator: (req) => req.sessionID || ipKeyGenerator(req.ip),
    message: { response: "You're sending messages a little too fast — give me a moment and try again!" },
});

const NOT_CONFIGURED_MESSAGE = "I'm not fully configured yet — the site owner needs to set up the Navigator API key. Please check back soon!";
const MAX_MESSAGE_LENGTH = 1500;

// The router (an LLM) is imperfect and, even at temperature 0, occasionally dumps a legitimate
// question into "unsupported" and would hard-refuse it. So we CONFIRM IN CODE before refusing:
// only an off-topic / rule-override / code-generation attempt is hard-refused pre-generation.
// Everything else the router flagged unsupported (including credential wording on its own)
// falls through to a grounded attempt — the sanitizer already stripped real credentials from
// the manual at ingestion, and the persona prompt refuses to output them itself, so it's safe to
// let the model see the question and answer whatever legitimate part it can.
const OFFTOPIC_ATTACK = /\b(python|javascript|typescript|java|c\+\+|golang|rust|sql|code|coding|program|programming|script|algorithm|essay|poem|story|homework|recipe|joke|translate)\b|ignore (the|your|all|previous)|disregard (the|your|all|previous)|pretend (you|to be|that)|act as|you are now|roleplay|jailbreak|developer mode|system prompt|tell me everything|dump (the|everything|all)|entire manual|whole manual/i;
// The venue's own answerable public info — used to route a rescued question to the live path
// (which blends the manual) since contact/hours/pricing facts often live on the page.
const PUBLIC_INFO = /\b(phone|contact|address|e-?mail|hours?|pricing|price|cost|rate|fee|location|located|directions|reservation|bowling|billiards?|pool table|foosball|snooker|esports|air hockey|ping.?pong|table tennis|board game|lane|offering)\b/i;
// Narrower than PUBLIC_INFO on purpose — the reservation CTA should only fire on messages that
// are actually about BOOKING THE VENUE, not generic equipment rental (bowling shoes, tables,
// controllers) or other unrelated "rent"/"book" usage. A bare rent(al)?/book(ing)? was too
// broad — a question like "do I need to rent shoes if I have my own?" isn't a reservation
// request, but matched the old pattern. "rent"/"book" now require a venue-shaped object nearby.
const RESERVATION_TOPIC = /\b(reservation|reserve(?:[^\w]+\w+){0,6}[^\w]+(?:lane|room|space|house|table|party|event)s?|house rental|half house|weekend rental package|book(?:[^\w]+\w+){0,6}[^\w]+(?:room|space|house|lane|party|event)s?|rent(?:[^\w]+\w+){0,6}[^\w]+(?:room|space|house|lane|party|event)s?|private event)\b/i;
// Lets a visitor opt out of the reservation CTA for the rest of the session (checked only when
// no reservation flow is active - "cancel" is the exit word once inside the flow itself).
const STOP_CTA_RE = /^stop$/i;

// Issue #14: "where do I find the Connect2 password", "what's the login for the punch-in
// desktop" and similar credential-LOCATION questions are answered deterministically in code, not
// left to the model. Credentials are ALWAYS sanitized out of the vector store
// (services/sanitizer.js), so no retrieval ever legitimately contains the value — the model was
// observed inventing plausible-but-fake sign-in steps by repurposing an unrelated system's
// password section (e.g. applying POS "Menu > Change Password" steps to a Connect2 question).
// A code short-circuit removes that variance: public users are told it's restricted, and staff
// are pointed to where they can look it up in person. This deliberately only matches "where/what
// IS the credential" phrasing, NOT "how do I CHANGE/reset my password", which stays a normal
// answerable how-to.
const CREDENTIAL_NOUN_RE = /\b(passwords?|passcodes?|pass ?codes?|logins?|log ?in|credentials?|access codes?|api keys?|pin numbers?)\b/i;
const CREDENTIAL_LOCATION_RE = /\b(where|what(?:'?s| is| are)?|find|finding|locate|located|look ?up|get|retrieve|obtain)\b/i;
const CREDENTIAL_CHANGE_RE = /\b(change|changing|reset|resetting|update|updating|set ?up|create|creating|make|forgot|expired)\b/i;
function isCredentialLocationQuery(msg) {
    return CREDENTIAL_NOUN_RE.test(msg) && CREDENTIAL_LOCATION_RE.test(msg) && !CREDENTIAL_CHANGE_RE.test(msg);
}
const STAFF_CREDENTIAL_POINTER = "I can't display logins or passwords here. For a specific credential, check the physical operations manual kept at the front desk first, then the copy in the Teams channel — and if it's still not there, ask your supervisor.";
// Used inside the reservation flow to tell "this doesn't parse as a valid answer because it's
// actually a question" from "this doesn't parse as a valid answer because it's just wrong" - a
// message that fails step validation AND looks question-shaped gets answered for real instead
// of being met with a bare "sorry, I didn't catch that" (see handleReservationTurn).
const QUESTION_LIKE_RE = /\?\s*$|^\s*(what|how|why|can|could|should|would|is|are|do|does|did|where|when|will|may|need|has|have)\b/i;

function resolveIntent(routerIntent, message) {
    if (routerIntent !== 'unsupported') return routerIntent;
    if (OFFTOPIC_ATTACK.test(message)) return 'unsupported'; // injection/jailbreak/code-gen → refuse, never reaches the model
    // A bare SECRET_TERMS match (the word "password"/"access code"/etc, with no injection
    // language) no longer forces a blanket refusal on its own. A compound question like "how do
    // I access the POS and what's the password" deserves the legitimate half answered, not a
    // total non-answer — and the credential half is still safe to let through: the sanitizer
    // already stripped real credential values from the manual at ingestion (they're not in
    // retrievable context to leak), and the persona prompt's access_control rule refuses to
    // output them even when asked directly, falling back to the RESTRICTED canned response.
    if (PUBLIC_INFO.test(message)) return 'live'; // contact/hours/offerings often live on the page (blends manual)
    return 'manual'; // otherwise attempt a grounded answer; the model refuses if truly off-topic or restricted
}

// Conversation memory lives in the (file-backed) session. We keep a little more than we send:
// STORED is the rolling window persisted; CONTEXT is how many recent messages we actually feed
// to the router and the answer model, to bound token cost.
const MAX_HISTORY_STORED = 10;   // messages (≈5 exchanges)
const MAX_HISTORY_CONTEXT = 6;   // messages (≈3 exchanges)

function getHistory(req) {
    return Array.isArray(req.session?.history) ? req.session.history : [];
}

function recordTurn(req, userMessage, assistantReply) {
    if (!req.session) return;
    const history = getHistory(req);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantReply });
    req.session.history = history.slice(-MAX_HISTORY_STORED);
}

const CANNED_TEXTS = new Set([
    ...Object.values(CANNED_RESPONSES),
    outputGuard.RESTRICTED_MESSAGE,
]);

// A canned refusal/decline isn't grounded in the retrieved passages that happened to be
// fetched for the turn, so it shouldn't be citing them as if they were.
// The model occasionally re-renders a canned string with typographic punctuation (a
// non-breaking hyphen in the phone number, an em/en dash, a non-breaking space), which broke a
// naive substring match and let a source badge slip back onto a canned reply. Normalize dashes
// and spaces on both sides before comparing so those variants still register as canned.
function normalizeForCanned(s) {
    return s
        .normalize('NFKC')
        .replace(/[‐-―−]/g, '-')      // hyphen/figure/en/em/minus dashes -> "-"
        .replace(/[    ]/g, ' ') // no-break / thin spaces -> " "
        .replace(/[‘’‚‛]/g, "'")       // curly / low single quotes -> apostrophe
        .replace(/[“”„‟]/g, '"')       // curly double quotes
        .replace(/\s+/g, ' ')
        .trim();
}
function isCannedResponse(text) {
    const norm = normalizeForCanned(text);
    for (const canned of CANNED_TEXTS) {
        if (norm.includes(normalizeForCanned(canned))) return true;
    }
    return false;
}

function formatLastChecked(iso) {
    return new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

function formatPassages(passages) {
    return passages.map((p) => `[Section: ${p.section}]\n${p.text}`).join('\n\n');
}

// Passages come back ranked by fused relevance, so the first distinct sections are the ones the
// answer most likely drew on. Cite only the top couple instead of every section that happened to
// be retrieved — a footer listing six sections for a one-line answer reads as noise and erodes
// trust in the citation.
const MAX_CITED_SECTIONS = 2;
function topSections(passages, max = MAX_CITED_SECTIONS) {
    const seen = [];
    for (const p of passages) {
        if (!seen.includes(p.section)) seen.push(p.section);
        if (seen.length >= max) break;
    }
    return seen;
}

// Best-effort manual retrieval that never throws — used where a manual result is supplementary
// (a live-intent turn) and a retrieval error shouldn't sink the whole response.
async function safeSearchManual(message, role) {
    if (!env.hasManual()) return [];
    try {
        const { passages } = await searchManual(message, role);
        return passages;
    } catch (error) {
        console.error('Manual search error:', error.message);
        return [];
    }
}

function liveCitation(result) {
    return { type: 'live', sourceUrl: result.sourceUrl, lastChecked: result.lastChecked };
}
function manualCitation(passages) {
    return { type: 'manual', sections: topSections(passages) };
}

// Deterministic same-day closure guard, reused wherever live content is included. Returns the
// bracketed directive to append, or '' if today isn't in a closure notice.
function closureAlertText(content) {
    const alert = liveInfo.closureAlertForToday(content);
    if (!alert) return '';
    return `\n\n[CLOSURE ALERT — the live page's closure/holiday notice references TODAY (${alert.date}). The regular weekly hours do NOT override this. Read the notice ("${alert.snippet}"): if it means we are closed or closing early today, state that plainly. If it is at all ambiguous, tell the user we may be closed or on reduced holiday hours today and to call 352-392-1637 to confirm. Do NOT confidently claim we are open over a closure notice for today.]`;
}

// A manual-intent question that also brushes a volatile/current topic (hours, pricing, "open
// today", "free") benefits from the live page too. Gate the manual→live enrichment on these
// terms so pure policy questions (uniforms, refund steps) don't get the hours/pricing page
// dumped into their context as noise.
// Contact terms are included because the public phone/email live ONLY on the live page (the
// sanitizer strips them from the manual), so a manual-classified contact question still needs
// the live page blended in to answer.
const LIVE_RELEVANT = /\b(hour|open|clos|price|cost|rate|fee|today|tonight|right now|free|when|schedul|availab|holiday|phone|contact|e-?mail|number|reach|call)/i;

async function buildToolContext(intent, message, role) {
    if (intent === 'live') {
        const topic = liveInfo.detectTopic(message);
        // Fetch live + manual in parallel and BLEND them: the live page is authoritative for
        // volatile facts (hours, pricing, closures), while the manual covers policies/details
        // the page omits. A compound question ("what's free and what are the reservation rules")
        // needs both. If live fails, the manual carries the turn as a labeled fallback.
        const [result, manualPassages] = await Promise.all([
            liveInfo.fetchLiveInfo(topic),
            safeSearchManual(message, role),
        ]);

        if (result.content) {
            let block = `LIVE_INFO (from ${result.sourceUrl}, fetched ${result.lastChecked}):\n${result.content}${result.closureNoted ? '\n[Note: the word "closed" appears on this page — check whether a reason is given before stating one.]' : ''}`;
            block += closureAlertText(result.content);
            const citations = [liveCitation(result)];
            if (manualPassages.length > 0) {
                block += `\n\nSUPPLEMENTARY_MANUAL_CONTEXT (from the reference manual — use for policies/details the live page above doesn't cover; the live page remains authoritative for hours, pricing, and closures):\n${formatPassages(manualPassages)}`;
                citations.push(manualCitation(manualPassages));
            }
            return { block, citations };
        }

        // The live page couldn't be reached (down, blocked, or redesigned — see the tripwire
        // in liveInfo.js). Rather than dead-ending, fall back to the manual's own general info
        // (hours, specials, reservation policies) — labeled as a secondary source so the model
        // hedges on currency (a manual value can be stale in a way a live fetch isn't).
        if (manualPassages.length > 0) {
            const block = `LIVE_INFO: (none — the live page could not be reached)\nFALLBACK_MANUAL_CONTEXT (from the reference manual, not live-verified — may be outdated):\n${formatPassages(manualPassages)}`;
            return { block, citations: [manualCitation(manualPassages)] };
        }

        return { block: 'LIVE_INFO: (none — the live page could not be reached, and no matching manual passage was found either)', citations: [] };
    }

    if (intent === 'manual') {
        if (!env.hasManual()) {
            return { block: 'RETRIEVED_CONTEXT: (none — no manual has been loaded yet)', citations: [] };
        }
        let passages = [];
        try {
            ({ passages } = await searchManual(message, role));
        } catch (error) {
            console.error('Manual search error:', error.message);
            return { block: 'RETRIEVED_CONTEXT: (none — the manual knowledge base could not be reached)', citations: [] };
        }

        let block = passages.length > 0 ? `RETRIEVED_CONTEXT:\n${formatPassages(passages)}` : '';
        const citations = passages.length > 0 ? [manualCitation(passages)] : [];

        // Combine in current data when the question touches a volatile/contact topic. Some facts
        // (the public phone/email) live ONLY on the live page — the sanitizer redacts them from
        // the manual — so this runs EVEN WHEN manual retrieval found nothing. When we already
        // have manual passages, use the warm cache (zero extra fetch); when the manual came up
        // empty, actively fetch so a contact/hours question still gets an answer.
        if (LIVE_RELEVANT.test(message) || passages.length === 0) {
            const topic = liveInfo.detectTopic(message);
            const live = passages.length > 0
                ? liveInfo.getCachedLiveInfo(topic)
                : await liveInfo.fetchLiveInfo(topic).catch(() => null);
            if (live && live.content) {
                block += `${block ? '\n\n' : ''}SUPPLEMENTARY_LIVE_INFO (current data from ${live.sourceUrl}, fetched ${live.lastChecked} — authoritative for hours/pricing/contact/closures; ignore anything here unrelated to the question):\n${live.content}`;
                block += closureAlertText(live.content);
                citations.push(liveCitation(live));
            }
        }

        if (!block) {
            return { block: 'RETRIEVED_CONTEXT: (none — no matching passages found)', citations: [] };
        }
        return { block, citations };
    }

    return { block: '', citations: [] };
}

// --- Streaming response protocol -------------------------------------------------------
// The client can't use EventSource for this (it only does GET, and /api/chat needs a POST
// body), so we stream a simple newline-delimited-JSON body instead: one JSON object per line,
// read via fetch()'s ReadableStream on the client. Event shapes:
//   {type:'chunk', text}   — a safe-to-render slice of the answer
//   {type:'blocked'}       — the output guard caught a credential/PII leak; client should
//                             discard anything shown so far and display outputGuard.RESTRICTED_MESSAGE
//   {type:'error', message}— something failed after the stream had already started (can't send
//                             a fresh HTTP status at this point)
//   {type:'done', sources} — generation finished cleanly; sources is the structured citation list
function startStream(res) {
    res.writeHead(200, {
        // text/plain (not a custom ndjson mime type) so every HTTP client — browsers' fetch,
        // supertest/superagent in tests, curl — reliably treats the body as text without
        // needing to recognize an unregistered content type.
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no', // hint any reverse proxy not to buffer the whole body first
    });
}
function writeEvent(res, obj) {
    res.write(JSON.stringify(obj) + '\n');
}

// Must exceed the longest realistic sensitive-pattern match span (see sensitivePatterns.js —
// the longest bounded pattern, account_number_label, tops out around 40-50 chars including its
// label and connector). We hold back this many characters behind the stream's leading edge
// before ever releasing text, so a pattern that straddles two model-generated chunks (e.g.
// "password:" arrives, then the value a moment later) is always fully visible to the guard
// BEFORE the "password:" prefix is ever sent to the client — never after.
const STREAM_HOLDBACK_CHARS = 80;

// Streams one generation call to the client, guarding incrementally instead of waiting for the
// full text. Two tiers, handled differently for a deliberate reason:
//   - BLOCK-tier: hasBlockingContent() re-scans the ENTIRE accumulated raw text on every delta
//     (cheap — replies are a few hundred chars), so a match assembled across chunk boundaries is
//     always caught. Nothing within STREAM_HOLDBACK_CHARS of the leading edge is ever released,
//     so text that's about to become part of a block match can't leak before the block fires.
//   - REDACT-tier: released text is NEVER redacted incrementally. Redacting a truncated prefix
//     can produce a false "complete" match (e.g. a \d{5,} run that looked finished at 5 digits
//     but had more digits arrive a moment later) whose later, correct redaction wouldn't line up
//     with what was already sent — a real bug caught by test/chatStreaming.test.js. Instead we
//     simply never release PAST the start of an in-progress redact match (earliestRedactMatchStart),
//     holding that tail back until the stream ends, then redact the COMPLETE raw text once with
//     the same applyRedactions() the non-streaming guard() already uses, and flush the remainder.
//     Cost: a reply mentioning an account/terminal number streams smoothly up to that point, then
//     arrives as one slightly bigger final chunk instead of continuing token-by-token — a minor,
//     rare-case smoothness trade for correctness that's trivial to reason about.
// Returns { text, blocked, streamError } the same shape outputGuard.guard() would, so callers
// downstream (recordTurn, analytics, citations) don't need to know generation was streamed.
async function streamGuardedReply(res, messages, userRole = 'public') {
    let raw = '';
    let sentPlain = ''; // always a literal, unmodified prefix of raw — never itself redacted

    try {
        for await (const delta of navigator.chatCompleteStream(messages, { temperature: 0.3 })) {
            raw += delta;
            if (userRole === 'public' && outputGuard.hasBlockingContent(raw)) {
                writeEvent(res, { type: 'blocked', text: outputGuard.RESTRICTED_MESSAGE });
                return { text: outputGuard.RESTRICTED_MESSAGE, blocked: true };
            }
            const safeLen = userRole === 'public' ? Math.max(0, raw.length - STREAM_HOLDBACK_CHARS) : raw.length;
            const redactStart = userRole === 'public' ? outputGuard.earliestRedactMatchStart(raw) : null;
            const cut = redactStart === null ? safeLen : Math.min(safeLen, redactStart);
            if (cut > sentPlain.length) {
                writeEvent(res, { type: 'chunk', text: raw.slice(sentPlain.length, cut) });
                sentPlain = raw.slice(0, cut);
            }
        }
    } catch (error) {
        console.error('Generation stream error:', error.message);
        if (!sentPlain) {
            // Nothing shown yet — report a clean error instead of a truncated partial reply.
            const message = 'Sorry, I ran into a problem answering that. Please try again in a moment.';
            writeEvent(res, { type: 'error', message });
            return { text: message, blocked: false, streamError: true };
        }
        // Some text already reached the client; stop here rather than claim it's complete.
        return { text: sentPlain, blocked: false, streamError: true };
    }

    // Final safety re-check against the complete text (defense in depth on top of the per-delta
    // checks above), then redact the whole thing ONCE and flush whatever's left unsent. Since
    // sentPlain is guaranteed to contain no redact match (we never cut through or past one), it's
    // unaffected by redaction — finalRedacted is guaranteed to start with sentPlain verbatim, so
    // slicing at sentPlain.length is safe.
    if (userRole === 'public') {
        if (outputGuard.hasBlockingContent(raw)) {
            writeEvent(res, { type: 'blocked', text: outputGuard.RESTRICTED_MESSAGE });
            return { text: outputGuard.RESTRICTED_MESSAGE, blocked: true };
        }
        const finalRedacted = outputGuard.applyRedactions(raw);
        if (finalRedacted.length > sentPlain.length) {
            writeEvent(res, { type: 'chunk', text: finalRedacted.slice(sentPlain.length) });
        }
        return { text: finalRedacted, blocked: false };
    } else {
        // Staff/Admin bypass the output guard
        if (raw.length > sentPlain.length) {
            writeEvent(res, { type: 'chunk', text: raw.slice(sentPlain.length) });
        }
        return { text: raw, blocked: false };
    }
}

// Runs the full manual/live/casual RAG pipeline for a message and streams the answer as chunk
// events (calls startStream/writeEvent itself). Returns { replyText, sources, blocked,
// streamError } - the caller still owns recordTurn + the final {type:'done'} event + res.end(),
// so extra content can be appended before the response is finalized (the reservation CTA here,
// or a "back to your reservation" reminder in handleReservationTurn's digression-question path
// below). This is exactly the logic the main POST handler used to run inline; factored out so
// both it and the reservation flow's mid-flow Q&A path share one implementation.
async function answerAndStream(req, res, userMessage, { suppressReservationCta = false } = {}) {
    const userRole = req.session?.tier || 'public';
    console.log('CHAT REQUEST: message=', userMessage, 'userRole=', userRole);
    // Include the current TIME, not just the date — "is it open right now" needs a clock
    // reference to answer definitively; without it the model has to hedge on "right now"
    // questions even when it has the correct hours in context.
    const currentDateTime = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'full',
        timeStyle: 'short',
    });
    const history = getHistory(req);
    const contextHistory = history.slice(-MAX_HISTORY_CONTEXT);

    // One call classifies intent AND rewrites the (possibly elliptical) message into a
    // standalone query using recent history, so a follow-up like "what about faculty?"
    // retrieves against "what is the faculty price for billiards?" instead of a bare pronoun.
    const { intent, standaloneQuery } = await router_.classifyAndRewrite(userMessage, contextHistory);
    const effectiveIntent = resolveIntent(intent, userMessage);

    // Enforced in code, not left to the model's judgment: an "unsupported" classification
    // short-circuits straight to a canned refusal with NO generation call at all.
    if (effectiveIntent === 'unsupported') {
        analyticsStore.logQuestion({ role: userRole, intent, question: userMessage, answered: false, citationType: null });
        startStream(res);
        writeEvent(res, { type: 'chunk', text: CANNED_RESPONSES.OUT_OF_SCOPE });
        return { replyText: CANNED_RESPONSES.OUT_OF_SCOPE, sources: [], blocked: false, streamError: false };
    }

    const { block, citations } = await buildToolContext(effectiveIntent, standaloneQuery, userRole);

    const messages = [
        { role: 'system', content: buildSystemPrompt(userRole, currentDateTime) },
    ];
    if (block) {
        messages.push({ role: 'system', content: block });
    }
    for (const turn of contextHistory) {
        messages.push({ role: turn.role, content: turn.content });
    }
    messages.push({ role: 'user', content: userMessage });

    startStream(res);
    const { text: reply, blocked, streamError } = await streamGuardedReply(res, messages, userRole);

    // Sources are returned as STRUCTURED DATA (not appended to the answer text) so the UI can
    // render a compact hover badge instead of a long "Source: ..." footer.
    const sources = (blocked || streamError || isCannedResponse(reply))
        ? []
        : citations.map((c) => c.type === 'live'
            ? { type: 'live', label: 'union.ufl.edu (live)', url: c.sourceUrl, lastChecked: c.lastChecked ? formatLastChecked(c.lastChecked) : null }
            : { type: 'manual', label: 'Game Room Manual', detail: c.sections.join(', ') });

    // Nudge toward the reservation flow after a genuinely reservation-shaped answer - never
    // after a refusal/blocked/failed reply, never for casual small talk, and never when already
    // mid-flow (suppressReservationCta) since offering to "start" while already inside the flow
    // doesn't make sense. Checked against the user's own words only, NOT the router's rewritten
    // standaloneQuery - that paraphrase can introduce trigger words the user never actually used.
    let replyText = reply;
    if (!suppressReservationCta && !blocked && !streamError && !isCannedResponse(reply)
        && !req.session?.reservationCtaDismissed
        && RESERVATION_TOPIC.test(userMessage)) {
        const cta = "\n\nWould you like to start a reservation request?\nIf so, just type **start** in the chat box and we'll begin filling out the form together — or type **stop** if you'd rather not be asked again.";
        replyText = reply + cta;
        writeEvent(res, { type: 'chunk', text: cta });
    }

    if (!streamError) {
        // A turn "counts as answered" when it produced a grounded, non-canned reply. Refusals
        // and "no evidence" non-answers are logged as unanswered — that's the admin signal for
        // which questions the current knowledge base can't yet handle.
        analyticsStore.logQuestion({
            role: userRole,
            intent: effectiveIntent,
            question: userMessage,
            answered: !isCannedResponse(reply),
            citationType: sources[0] ? sources[0].type : null,
        });
    }

    return { replyText, sources, blocked, streamError };
}

// --- Reservation flow -------------------------------------------------------------------
// A stateful, multi-turn mode that completely bypasses the intent router while active. Every
// question, validation rule, and branch decision lives in services/reservationFlow.js (plain
// code, no LLM calls anywhere in this path) - this just adapts that pure state machine onto the
// same streaming protocol/session/analytics conventions the rest of this file already uses, so
// the frontend needs zero changes to render it. The one exception is the mid-flow digression
// path below, which DOES call the normal RAG pipeline (via answerAndStream) - answering a
// genuine question is exactly the kind of judgment call that belongs behind a real retrieval +
// generation call, not a canned string.
async function handleReservationTurn(req, res, userMessage) {
    const userRole = req.session?.tier || 'public';
    try {
        let flowState = req.session.reservationFlow || null;
        let reply;
        let sources = [];
        let readyToSubmit = false;

        if (!flowState) {
            const started = reservationFlow.start();
            flowState = started.state;
            reply = started.reply;
        } else {
            const result = reservationFlow.handleAnswer(flowState, userMessage);

            // A rejected answer that reads like a genuine question ("can I type a number?",
            // "what counts as a UF Department?") gets answered for real via the normal
            // manual/live pipeline, then the SAME pending question is re-shown as a reminder -
            // instead of silently treating every message as a failed answer attempt. Flow state
            // is left untouched; the visitor is still on the same step afterward.
            if (result.invalid && QUESTION_LIKE_RE.test(userMessage.trim())) {
                const answered = await answerAndStream(req, res, userMessage, { suppressReservationCta: true });
                const reminder = `\n\nGetting back to your reservation request — ${result.pendingPrompt}`;
                writeEvent(res, { type: 'chunk', text: reminder });
                reply = answered.replyText + reminder;
                sources = answered.sources;
                flowState = result.state;
            } else {
                flowState = result.state;
                reply = result.reply;
                readyToSubmit = Boolean(result.readyToSubmit);
            }
        }

        if (readyToSubmit) {
            const payload = reservationFlow.buildSubmissionPayload(flowState.answers);
            delete req.session.reservationFlow;
            try {
                const result = await reservationSubmitter.submitReservation(payload);
                reservationStore.logSubmission({
                    role: userRole,
                    answers: payload,
                    submitted: result.submitted,
                    dryRun: result.dryRun,
                    provider: result.provider,
                    error: result.error,
                });
                if (result.submitted || result.dryRun) {
                    reply = "Thanks! Your reservation request has been submitted. Please allow the usual processing time for Game Room staff to follow up.";
                } else {
                    reply = "I've recorded all your details, but hit a technical problem submitting the request automatically. Staff have the full request on file and will follow up directly.";
                }
            } catch (error) {
                console.error('Reservation submission error:', error.message);
                reservationStore.logSubmission({ role: userRole, answers: payload, submitted: false, dryRun: false, provider: null, error: error.message });
                reply = "I've recorded all your details, but hit a technical problem submitting the request automatically. Staff have the full request on file and will follow up directly.";
            }
        } else if (flowState) {
            req.session.reservationFlow = flowState;
        } else {
            delete req.session.reservationFlow; // cancelled
        }

        // The digression branch above already called answerAndStream, which starts the stream
        // and writes its own chunks - don't start it again or double-write the reply text.
        if (!res.headersSent) {
            startStream(res);
            writeEvent(res, { type: 'chunk', text: reply });
        }
        // Must happen BEFORE res.end() - see the identical note on the main handler's recordTurn call.
        recordTurn(req, userMessage, reply);
        writeEvent(res, { type: 'done', sources });
        res.end();
    } catch (error) {
        console.error('Reservation flow error:', error.message);
        const message = 'Sorry, I ran into a problem with the reservation request. Please try again in a moment.';
        if (res.headersSent) {
            if (!res.writableEnded) {
                writeEvent(res, { type: 'error', message });
                res.end();
            }
        } else {
            res.status(500).json({ response: message });
        }
    }
}

router.post('/', chatLimiter, async (req, res) => {
    if (!env.hasApiKey()) {
        return res.status(503).json({ response: NOT_CONFIGURED_MESSAGE });
    }

    // Require an actual string. Previously we String()-coerced whatever came in, which turned a
    // number/object/array body into garbage like "[object Object]" and forwarded it to the model.
    const rawMessage = (req.body || {}).message;
    if (typeof rawMessage !== 'string') {
        return res.status(400).json({ error: 'message is required' });
    }
    const userMessage = rawMessage.trim();
    if (!userMessage) {
        return res.status(400).json({ error: 'message is required' });
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    // A reservation flow already in progress, or a fresh "start" trigger, completely bypasses
    // the intent router below - every message is "the answer to the current question," handled
    // deterministically in code (see handleReservationTurn / services/reservationFlow.js).
    if (req.session?.reservationFlow || reservationFlow.START_TRIGGER_RE.test(userMessage)) {
        return handleReservationTurn(req, res, userMessage);
    }

    // A bare "stop" (only meaningful outside an active flow — "cancel" is the exit word inside
    // one) permanently dismisses the reservation CTA for the rest of this session, without ever
    // touching the router.
    if (!req.session?.reservationFlow && STOP_CTA_RE.test(userMessage)) {
        if (req.session) req.session.reservationCtaDismissed = true;
        const reply = "Got it — I won't bring up reservations again this session unless you ask. What else can I help with?";
        startStream(res);
        writeEvent(res, { type: 'chunk', text: reply });
        recordTurn(req, userMessage, reply);
        writeEvent(res, { type: 'done', sources: [] });
        return res.end();
    }

    // Issue #14: deterministic handling of credential-LOCATION questions (see the regexes above).
    // Never routes to the model, so it can't fabricate sign-in steps for a system it has no
    // grounded context for. No sources — this is a canned pointer, not a retrieved answer.
    if (!req.session?.reservationFlow && isCredentialLocationQuery(userMessage)) {
        const tier = req.session?.tier || 'public';
        const reply = tier === 'public' ? CANNED_RESPONSES.RESTRICTED : STAFF_CREDENTIAL_POINTER;
        startStream(res);
        writeEvent(res, { type: 'chunk', text: reply });
        recordTurn(req, userMessage, reply);
        writeEvent(res, { type: 'done', sources: [] });
        return res.end();
    }

    // startStream() is called lazily inside answerAndStream, right before the FIRST real event
    // (canned refusal or first generation chunk) — not unconditionally here. That way a failure
    // in the router call itself (before we've committed to an answer) can still return a clean
    // res.status(500).json exactly as before, instead of being downgraded to an in-stream error
    // event; only a failure that happens AFTER we've started writing the stream needs the
    // in-band {type:'error'} event (see the catch block below, which checks res.headersSent).
    try {
        const { replyText, sources, streamError } = await answerAndStream(req, res, userMessage);

        // Must happen BEFORE res.end() — express-session's auto-save hook fires exactly at
        // res.end(), so a session mutation made after that point never reaches the store. This
        // was a real bug: conversation memory (and history-restore) silently stopped surviving
        // a request once generation moved to a streamed response, because recordTurn used to run
        // after the response had already ended.
        if (!streamError) {
            recordTurn(req, userMessage, replyText);
        }

        writeEvent(res, { type: 'done', sources });
        res.end();
    } catch (error) {
        console.error('Chat error:', error.message);
        const message = 'Sorry, I ran into a problem answering that. Please try again in a moment.';
        // If nothing's been written yet (e.g. the router call itself failed), a real HTTP 500
        // is still possible and preferable — only fall back to the in-stream error event once
        // we've already committed to a 200 streaming response.
        if (res.headersSent) {
            if (!res.writableEnded) {
                writeEvent(res, { type: 'error', message });
                res.end();
            }
        } else {
            res.status(500).json({ response: message });
        }
    }
});

// Returns the current session's recent conversation memory so the frontend can rehydrate the
// visible transcript after a page refresh (the server already keeps it for router/model
// context — this just exposes it for display). No sources: those aren't persisted in
// req.session.history, only role/content are (see recordTurn above).
router.get('/history', (req, res) => {
    res.json({ history: getHistory(req) });
});

// Lets the frontend start a fresh conversation without dropping the whole session (role/login
// is preserved; only the chat memory is cleared).
router.post('/reset', (req, res) => {
    if (req.session) {
        req.session.history = [];
        delete req.session.reservationFlow;
        delete req.session.reservationCtaDismissed;
    }
    res.json({ ok: true });
});

// Returns the live facility status (checking for closures or special notices)
router.get('/status', async (req, res) => {
    try {
        const live = liveInfo.getCachedLiveInfo('gameroom') 
            || await liveInfo.fetchLiveInfo('gameroom').catch(() => null);
        
        if (live && live.content) {
            const alert = liveInfo.closureAlertForToday(live.content);
            if (alert) {
                return res.json({ hasClosure: true, notice: alert.snippet });
            }
        }
        res.json({ hasClosure: false });
    } catch (err) {
        res.json({ hasClosure: false });
    }
});

// Thumbs up/down on an answer. Kept lightweight and public — the endpoint the (future) UI
// buttons post to; also usable now via API. The ratings feed the admin feedback log.
router.post('/feedback', (req, res) => {
    const body = req.body || {};
    const rating = body.rating === 'up' ? 'up' : body.rating === 'down' ? 'down' : null;
    if (!rating) {
        return res.status(400).json({ error: "rating must be 'up' or 'down'" });
    }
    analyticsStore.logFeedback({
        role: req.session?.tier || 'public',
        rating,
        question: body.question,
        answer: body.answer,
    });
    res.json({ ok: true });
});

module.exports = router;
