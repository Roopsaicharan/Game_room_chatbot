const sensitivePatterns = require('./sensitivePatterns');

const INGESTION_PATTERNS = [
    ...sensitivePatterns.HARD_PATTERNS,
    sensitivePatterns.PHONE_PATTERN,
    sensitivePatterns.EMAIL_PATTERN,
];

// Strips/redacts credentials, access codes, phone numbers, and emails from manual text
// BEFORE it is ever chunked or embedded — so this content never enters the vector store at all.
function sanitize(text) {
    let sanitized = text;
    let redactionCount = 0;

    for (const { regex } of INGESTION_PATTERNS) {
        sanitized = sanitized.replace(regex, () => {
            redactionCount += 1;
            return '[REDACTED]';
        });
    }

    return { text: sanitized, redactionCount };
}

module.exports = { sanitize };
