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

// Role is re-enforced here regardless of what the `where` filter already did — the prompt
// (and even the DB filter) is not the security boundary; this function is.
async function searchManual(query, role) {
    const collection = await chromaClient.getOrCreateCollection();
    const queryEmbedding = await navigator.embed(query);

    const result = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: N_RESULTS,
        where: whereForRole(role),
    });

    const documents = result.documents?.[0] || [];
    const metadatas = result.metadatas?.[0] || [];
    const distances = result.distances?.[0] || [];
    const allowedLevels = allowedLevelsForRole(role);

    const passages = [];
    for (let i = 0; i < documents.length; i++) {
        const metadata = metadatas[i] || {};
        if (!allowedLevels.includes(metadata.access_level)) continue; // defensive re-check

        const distance = distances[i] ?? 2;
        const similarity = 1 - distance / 2; // cosine distance in Chroma ranges 0 (identical)..2 (opposite)
        if (similarity < env.RELEVANCE_THRESHOLD) continue;

        passages.push({ section: metadata.section || 'Manual', text: documents[i], score: similarity });
    }

    return { passages, usedFallback: passages.length === 0 };
}

module.exports = { searchManual };
