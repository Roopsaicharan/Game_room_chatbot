const chromaClient = require('./chromaClient');
const navigator = require('../lib/navigatorClient');
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

// Role is re-enforced here regardless of what the `where` filter already did — the prompt
// (and even the DB filter) is not the security boundary; this function is.
async function searchManual(query, role) {
    const collection = await chromaClient.getOrCreateCollection();
    const subQueries = splitSubQueries(query);
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
            const similarity = 1 - distance / 2; // cosine distance in Chroma ranges 0 (identical)..2 (opposite)
            if (similarity < env.RELEVANCE_THRESHOLD) continue;

            // The same chunk can surface for more than one sub-query — keep its best score.
            const existing = bestByText.get(documents[i]);
            if (!existing || similarity > existing.score) {
                bestByText.set(documents[i], { section: metadata.section || 'Manual', text: documents[i], score: similarity });
            }
        }
    }

    const passages = [...bestByText.values()].sort((a, b) => b.score - a.score).slice(0, N_RESULTS);

    return { passages, usedFallback: passages.length === 0 };
}

module.exports = { searchManual, splitSubQueries };
