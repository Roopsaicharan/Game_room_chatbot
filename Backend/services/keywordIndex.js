// A tiny in-process BM25 keyword index over the manual chunks. It exists to complement the
// vector search: exact terms an embedding blurs together — acronyms and codes like "BOGO",
// "PERF", "Connect2", "$2 Tuesday", a specific game name — are exactly what lexical scoring
// nails. At the manual's ~50-chunk scale this is trivially fast and needs no external service.

const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are',
    'was', 'were', 'be', 'been', 'do', 'does', 'did', 'i', 'you', 'we', 'they', 'it', 'this',
    'that', 'these', 'those', 'with', 'as', 'by', 'from', 'can', 'what', 'how', 'my', 'me',
    'if', 'so', 'not', 'no', 'yes', 'about', 'there', 'here', 'have', 'has',
]);

const K1 = 1.5;
const B = 0.75;

function tokenize(text) {
    const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
    // Keep multi-char words and any all-digit token (prices/codes like "2", "4471"), drop
    // stopwords. Short function words carry no retrieval signal and only add noise.
    return tokens.filter((t) => (t.length >= 2 || /^\d+$/.test(t)) && !STOPWORDS.has(t));
}

// records: [{ id, text, section, accessLevel }]
function buildIndex(records) {
    const docs = records.map((r) => {
        const terms = tokenize(r.text);
        const freq = new Map();
        for (const t of terms) freq.set(t, (freq.get(t) || 0) + 1);
        return { ...r, length: terms.length, freq };
    });

    const df = new Map();
    for (const d of docs) {
        for (const term of d.freq.keys()) df.set(term, (df.get(term) || 0) + 1);
    }
    const totalLen = docs.reduce((s, d) => s + d.length, 0);
    const avgdl = docs.length ? totalLen / docs.length : 0;

    return { docs, df, avgdl, n: docs.length };
}

function idf(index, term) {
    const n = index.n;
    const dft = index.df.get(term) || 0;
    // BM25 idf with the +1 inside the log so it never goes negative for very common terms.
    return Math.log(1 + (n - dft + 0.5) / (dft + 0.5));
}

// Returns [{ id, text, section, accessLevel, score }] sorted by BM25 score desc, filtered to
// allowedLevels and to positive scores only (at least one query term actually matched).
function search(index, query, allowedLevels, topK = 8) {
    if (!index || !index.n) return [];
    const qTerms = [...new Set(tokenize(query))];
    if (!qTerms.length) return [];

    const results = [];
    for (const d of index.docs) {
        if (allowedLevels && !allowedLevels.includes(d.accessLevel)) continue;
        let score = 0;
        for (const term of qTerms) {
            const tf = d.freq.get(term);
            if (!tf) continue;
            const denom = tf + K1 * (1 - B + B * (index.avgdl ? d.length / index.avgdl : 0));
            score += idf(index, term) * ((tf * (K1 + 1)) / (denom || 1));
        }
        if (score > 0) {
            results.push({ id: d.id, text: d.text, section: d.section, accessLevel: d.accessLevel, score });
        }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
}

module.exports = { tokenize, buildIndex, search };
