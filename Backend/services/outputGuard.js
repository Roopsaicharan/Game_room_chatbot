const sensitivePatterns = require('./sensitivePatterns');

const RESTRICTED_MESSAGE = 'That information is restricted. Please contact your supervisor or the Game Room admin directly for it.';

// Final safety net: runs on every chat response regardless of what the model produced.
// If credential/secret-shaped text survived generation, the whole answer is replaced —
// partial redaction of an otherwise-leaky answer is not good enough here.
function guard(text) {
    const hits = sensitivePatterns.scan(text);
    if (hits.length > 0) {
        console.warn('outputGuard blocked a response:', hits.map((h) => h.name).join(', '));
        return { text: RESTRICTED_MESSAGE, blocked: true };
    }
    return { text, blocked: false };
}

module.exports = { guard, RESTRICTED_MESSAGE };
