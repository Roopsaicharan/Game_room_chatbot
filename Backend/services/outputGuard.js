const sensitivePatterns = require('./sensitivePatterns');

const RESTRICTED_MESSAGE = 'That information is restricted. Please contact your supervisor or the Game Room admin directly for it.';
const REDACTION_PLACEHOLDER = '[redacted]';

const BLOCK_PATTERNS = sensitivePatterns.HARD_PATTERNS.filter((p) => (p.mode || 'block') === 'block');
const REDACT_PATTERNS = sensitivePatterns.HARD_PATTERNS.filter((p) => p.mode === 'redact');

// True if `text` contains a genuine credential/PII shape. Exposed separately (not just via
// guard()) so a streaming caller can re-check accumulated text incrementally as it arrives,
// before any of it reaches the client — see routes/chat.js's streamGuardedReply().
function hasBlockingContent(text) {
    return sensitivePatterns.scan(text, BLOCK_PATTERNS).length > 0;
}

// Masks every 'redact'-tier span in `text` (broad, lower-severity labeled numbers). Exposed
// separately for the same streaming reason as hasBlockingContent above.
function applyRedactions(text) {
    let out = text;
    for (const { regex, validate } of REDACT_PATTERNS) {
        out = out.replace(regex, (match) => (validate && !validate(match)) ? match : REDACTION_PLACEHOLDER);
    }
    return out;
}

// Index of the earliest character where ANY redact-tier pattern starts matching in `text`, or
// null if none match. Used by streaming (routes/chat.js's streamGuardedReply) to know how far
// it's safe to release text WITHOUT redaction — up to, but never past, the start of an
// in-progress match. Patterns like the account-number one (`\d{5,}`, no upper bound) could still
// be mid-digit-run at the tail of what's arrived so far, so a match found against a growing
// prefix isn't final until more text confirms where it actually ends; only its START is stable.
// Clones each regex before use — reusing a shared global-flag RegExp's `.exec()` across calls
// would leak `lastIndex` state between unrelated invocations.
function earliestRedactMatchStart(text) {
    let earliest = null;
    for (const { regex } of REDACT_PATTERNS) {
        const fresh = new RegExp(regex.source, regex.flags);
        const m = fresh.exec(text);
        if (m && (earliest === null || m.index < earliest)) {
            earliest = m.index;
        }
    }
    return earliest;
}

// Final safety net: runs on every chat response regardless of what the model produced.
// Two tiers:
//   1. A 'block' hit (a real credential/PII leak) replaces the ENTIRE answer — partial
//      redaction of an otherwise-leaky answer is not good enough for that class of secret.
//   2. A 'redact' hit (a broad, lower-severity labeled number) masks just the matched span,
//      so one benign "account number 12345" mention doesn't destroy an otherwise-good reply.
function guard(text) {
    if (hasBlockingContent(text)) {
        console.warn('outputGuard blocked a response.');
        return { text: RESTRICTED_MESSAGE, blocked: true, redacted: false };
    }

    const out = applyRedactions(text);
    const redacted = out !== text;
    if (redacted) {
        console.warn('outputGuard redacted sensitive spans from a response.');
    }
    return { text: out, blocked: false, redacted };
}

module.exports = { guard, RESTRICTED_MESSAGE, REDACTION_PLACEHOLDER, hasBlockingContent, applyRedactions, earliestRedactMatchStart };
