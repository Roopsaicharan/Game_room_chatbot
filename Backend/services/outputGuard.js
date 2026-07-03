const sensitivePatterns = require('./sensitivePatterns');

const RESTRICTED_MESSAGE = 'That information is restricted. Please contact your supervisor or the Game Room admin directly for it.';
const REDACTION_PLACEHOLDER = '[redacted]';

const BLOCK_PATTERNS = sensitivePatterns.HARD_PATTERNS.filter((p) => (p.mode || 'block') === 'block');
const REDACT_PATTERNS = sensitivePatterns.HARD_PATTERNS.filter((p) => p.mode === 'redact');

// Final safety net: runs on every chat response regardless of what the model produced.
// Two tiers:
//   1. A 'block' hit (a real credential/PII leak) replaces the ENTIRE answer — partial
//      redaction of an otherwise-leaky answer is not good enough for that class of secret.
//   2. A 'redact' hit (a broad, lower-severity labeled number) masks just the matched span,
//      so one benign "account number 12345" mention doesn't destroy an otherwise-good reply.
function guard(text) {
    const blockHits = sensitivePatterns.scan(text, BLOCK_PATTERNS);
    if (blockHits.length > 0) {
        console.warn('outputGuard blocked a response:', blockHits.map((h) => h.name).join(', '));
        return { text: RESTRICTED_MESSAGE, blocked: true, redacted: false };
    }

    let redacted = false;
    let out = text;
    for (const { regex, validate } of REDACT_PATTERNS) {
        out = out.replace(regex, (match) => {
            if (validate && !validate(match)) return match;
            redacted = true;
            return REDACTION_PLACEHOLDER;
        });
    }
    if (redacted) {
        console.warn('outputGuard redacted sensitive spans from a response.');
    }
    return { text: out, blocked: false, redacted };
}

module.exports = { guard, RESTRICTED_MESSAGE, REDACTION_PLACEHOLDER };
