// Shared regex patterns for credential/secret-shaped text.
// Used by outputGuard.js (every chat response) and sanitizer.js (manual ingestion).
//
// Deliberately NOT included: a blanket phone-number pattern. The live-info tool
// legitimately relays the Game Room's official public contact number from the
// union.ufl.edu pages (e.g. "Call 352-392-1637 for availability") — blocking all
// phone-shaped digit runs would break that feature. Personal/internal phone numbers
// are instead handled by sanitizer.js at ingestion time, scoped to the manual text.

// Luhn check — a real credit-card number passes it; an arbitrary 13-16 digit run (an order
// id, a long reference number) almost never does. Gating credit_card_like on this removes the
// main false-positive source without weakening detection of genuine card numbers.
function passesLuhn(candidate) {
    const digits = candidate.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
        let d = Number(digits[i]);
        if (double) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
        double = !double;
    }
    return sum % 10 === 0;
}

// `mode` controls how outputGuard.js handles a hit:
//   'block'  — a genuine credential/PII leak; the ENTIRE response is replaced (fail closed).
//   'redact' — broad/lower-severity; only the matched span is masked, the rest of the answer
//              survives (avoids one benign labeled number nuking an otherwise-good reply).
// sanitizer.js ignores `mode` — at ingestion time every match is stripped inline regardless.
const HARD_PATTERNS = [
    // Explicit "label: value" / "label= value" — punctuation alone is a strong enough
    // signal to redact regardless of what the value looks like. "pw" is a common enough
    // shorthand in real staff manuals to include alongside password/passwd/pwd.
    { name: 'password_label', mode: 'block', regex: /\b(password|passwd|pwd|pw)\s*[:=]\s*\S+/gi },
    { name: 'access_code_label', mode: 'block', regex: /\b(access|door|alarm|safe|vault|lock)\s*code\s*[:=]\s*[A-Za-z0-9#*-]{3,}/gi },
    // Natural phrasing ("the alarm code is 4471") has no punctuation to anchor on, so we
    // require the value to contain a digit/symbol to avoid catching plain sentences like
    // "the password protects your account".
    { name: 'password_natural', mode: 'block', regex: /\b(password|passwd|pwd)\s+is\s+(?=\S*[\d!@#$%^&*.,])\S{3,}\b/gi },
    { name: 'access_code_natural', mode: 'block', regex: /\b(access|door|alarm|safe|vault|lock)\s*code\s+is\s+(?=\S*\d)[A-Za-z0-9#*-]{2,}\b/gi },
    { name: 'api_key_like', mode: 'block', regex: /\b(sk|pk)-[A-Za-z0-9]{16,}\b/g },
    { name: 'bearer_token', mode: 'block', regex: /\bBearer\s+[A-Za-z0-9\-_.]{16,}\b/gi },
    { name: 'credit_card_like', mode: 'block', regex: /\b(?:\d[ -]?){13,16}\b/g, validate: passesLuhn },
    { name: 'ssn_like', mode: 'block', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
    // Financial account identifiers directly labeled as such (merchant/terminal/account IDs
    // seen in real payment-processor documentation) — "label [connector words] : # digits".
    // Broad and lower-severity, so it's redacted inline rather than blocking the whole reply.
    { name: 'account_number_label', mode: 'redact', regex: /\b(merchant|terminal|account|routing)\s*(?:id|number|no\.?|#)?\s*[:#\s]{0,20}\d{5,}\b/gi },
];

// Ingestion-only: the manual is described as containing sensitive operational info, so at
// ingestion time (not output time) we err toward stripping ALL phone-number-shaped text,
// public contact number included — staff can re-add a public contact number to the
// sanitized manual by hand if they want it searchable.
const PHONE_PATTERN = { name: 'phone_number', regex: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g };

// Ingestion-only, same reasoning as phone numbers: strip ALL email addresses from the
// manual before embedding — personal staff emails should never be retrievable via chat.
const EMAIL_PATTERN = { name: 'email_address', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g };

function scan(text, patterns = HARD_PATTERNS) {
    const hits = [];
    for (const { name, mode, regex, validate } of patterns) {
        const matches = text.match(regex);
        if (!matches) continue;
        const real = validate ? matches.filter(validate) : matches;
        if (real.length) {
            hits.push({ name, mode: mode || 'block', count: real.length });
        }
    }
    return hits;
}

module.exports = { HARD_PATTERNS, PHONE_PATTERN, EMAIL_PATTERN, scan, passesLuhn };
