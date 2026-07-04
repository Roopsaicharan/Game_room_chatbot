const chromaClient = require('./chromaClient');
const navigator = require('../lib/navigatorClient');
const keywordIndex = require('./keywordIndex');
const env = require('../config/env');

// Was 5 — too narrow. A real query ("Where can I contact the game room supervisor?")
// scored the correct public GENERAL GAME ROOM INFO chunk (address/phone) at 0.734
// similarity, comfortably above RELEVANCE_THRESHOLD (0.35), but it ranked #6 among public
// chunks and was excluded purely by this cutoff — not because it was irrelevant. This
// manual's topically-adjacent sections (rules, reservations, lost & found, general info)
// routinely cluster within a narrow similarity band, so a small top-K reliably crowds out
// a genuinely relevant chunk. The relevance threshold below is still the real relevance
// gate; this is just how many candidates are allowed to compete against it.
const N_RESULTS = 8;

// Reciprocal Rank Fusion constant. The standard k=60 damps how much the very top ranks
// dominate, so a strong lexical-only hit can still surface alongside strong vector hits.
const RRF_K = 60;

// The BM25 index is derived from the same chunks Chroma holds. Cache it with a short TTL so we
// don't re-pull the whole corpus on every query, but still pick up a re-ingest within minutes.
// refreshKeywordIndex() forces an immediate rebuild (used by the admin re-ingest endpoint).
const KEYWORD_INDEX_TTL_MS = 5 * 60 * 1000;
let cachedIndex = null;
let cachedAt = 0;

async function getKeywordIndex() {
    if (cachedIndex && Date.now() - cachedAt < KEYWORD_INDEX_TTL_MS) {
        return cachedIndex;
    }
    const records = await chromaClient.getAllRecords();
    cachedIndex = keywordIndex.buildIndex(records);
    cachedAt = Date.now();
    return cachedIndex;
}

function refreshKeywordIndex() {
    cachedIndex = null;
    cachedAt = 0;
}

function allowedLevelsForRole(role) {
    return role === 'public' ? ['public'] : ['public', 'staff'];
}

function whereForRole(role) {
    const levels = allowedLevelsForRole(role);
    return levels.length === 1 ? { access_level: levels[0] } : { access_level: { $in: levels } };
}

// A single user message routinely bundles more than one question ("what about tv streams?
// also, can i play without bowling shoes"). Embedding the whole message as one vector blends
// both topics together, which can push a chunk that would otherwise clear
// RELEVANCE_THRESHOLD comfortably (e.g. the bowling-shoes rule, a real public chunk) down
// below it — not because it's irrelevant, but because the query vector itself is diluted.
// Splitting on strong separators and embedding each part separately avoids that dilution.
function splitSubQueries(message) {
    const parts = message
        .split(/[?？]+|\n+|(?:,?\s+(?:also|additionally|and also)\s*[,:]?\s*)/i)
        .map((part) => part.trim())
        .filter((part) => part.length > 2);
    return parts.length > 1 ? parts : [message];
}

// Vector (semantic) retrieval. Returns a Map text -> { section, text, similarity }, best score
// per chunk across all sub-queries, already role-filtered and threshold-gated.
async function vectorCandidates(subQueries, role) {
    const collection = await chromaClient.getOrCreateCollection();
    const queryEmbeddings = await Promise.all(subQueries.map((q) => navigator.embed(q)));
    const result = await collection.query({
        queryEmbeddings,
        nResults: N_RESULTS,
        where: whereForRole(role),
    });

    const allowedLevels = allowedLevelsForRole(role);
    const bestByText = new Map();
    const numQueries = result.documents?.length || 0;
    for (let q = 0; q < numQueries; q++) {
        const documents = result.documents[q] || [];
        const metadatas = result.metadatas?.[q] || [];
        const distances = result.distances?.[q] || [];
        for (let i = 0; i < documents.length; i++) {
            const metadata = metadatas[i] || {};
            if (!allowedLevels.includes(metadata.access_level)) continue; // defensive re-check
            const distance = distances[i] ?? 2;
            const similarity = 1 - distance / 2; // cosine distance in Chroma ranges 0..2
            if (similarity < env.RELEVANCE_THRESHOLD) continue;
            const existing = bestByText.get(documents[i]);
            if (!existing || similarity > existing.similarity) {
                bestByText.set(documents[i], { section: metadata.section || 'Manual', text: documents[i], similarity });
            }
        }
    }
    return bestByText;
}

// Lexical (BM25) retrieval over the same corpus. Best-effort: if the corpus can't be loaded
// (e.g. Chroma unreachable, or a unit test stub without a `get` method), we return nothing and
// the search degrades cleanly to vector-only. The role filter is applied here too, and every
// returned chunk is defensively re-checked before it's used.
async function keywordCandidates(query, role) {
    const allowedLevels = allowedLevelsForRole(role);
    try {
        const index = await getKeywordIndex();
        const hits = keywordIndex.search(index, query, allowedLevels, N_RESULTS);
        return hits.filter((h) => allowedLevels.includes(h.accessLevel)); // defensive re-check
    } catch (error) {
        console.error('Keyword search unavailable, falling back to vector-only:', error.message);
        return [];
    }
}

// Hybrid retrieval: fuse the semantic and lexical rankings with Reciprocal Rank Fusion. A chunk
// that ranks well in either list surfaces; one that ranks well in both is boosted. This catches
// exact-term questions (acronyms, codes, specific game names) that pure vector search blurs,
// without letting lexical noise dominate. Role is re-enforced on both paths — the prompt and the
// DB filter are defense-in-depth, this function is the boundary.
async function searchManual(query, role) {
    const subQueries = splitSubQueries(query);
    const [vectorMap, keywordHits] = await Promise.all([
        vectorCandidates(subQueries, role),
        keywordCandidates(query, role),
    ]);

    const vectorRanked = [...vectorMap.values()].sort((a, b) => b.similarity - a.similarity);

    // Fuse by text. RRF score sums 1/(k + rank) across whichever lists the chunk appears in.
    const fused = new Map(); // text -> { section, text, score }
    vectorRanked.forEach((cand, rank) => {
        fused.set(cand.text, { section: cand.section, text: cand.text, score: 1 / (RRF_K + rank) });
    });
    keywordHits.forEach((cand, rank) => {
        const rrf = 1 / (RRF_K + rank);
        const existing = fused.get(cand.text);
        if (existing) {
            existing.score += rrf;
        } else {
            fused.set(cand.text, { section: cand.section || 'Manual', text: cand.text, score: rrf });
        }
    });

    const passages = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, N_RESULTS);
    return { passages, usedFallback: passages.length === 0 };
}

module.exports = { searchManual, splitSubQueries, refreshKeywordIndex };
