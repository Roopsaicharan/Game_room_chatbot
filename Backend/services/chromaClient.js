const { ChromaClient } = require('chromadb');
const env = require('../config/env');

let client = null;

function getClient() {
    if (!client) {
        client = new ChromaClient({ path: env.CHROMA_URL });
    }
    return client;
}

// Chroma stores Navigator-computed embeddings — the collection is created WITHOUT an
// embedding function so it never tries to embed anything itself. "hnsw:space: cosine"
// keeps distances in the predictable [0, 2] range searchManual.js relies on.
async function getOrCreateCollection() {
    return getClient().getOrCreateCollection({
        name: env.CHROMA_COLLECTION,
        embeddingFunction: null,
        metadata: { 'hnsw:space': 'cosine' },
    });
}

async function resetCollection() {
    const chroma = getClient();
    try {
        await chroma.deleteCollection({ name: env.CHROMA_COLLECTION });
    } catch (error) {
        // Collection may not exist yet on a first run — that's fine.
    }
    return getOrCreateCollection();
}

module.exports = { getClient, getOrCreateCollection, resetCollection };
