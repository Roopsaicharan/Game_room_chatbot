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

// Pulls every chunk (text + access_level) out of the collection so the in-process BM25 index
// can be built. Fine at this manual's ~50-chunk scale; revisit if the corpus grows large.
// Routes through `api.getOrCreateCollection` (not the bare function) so a test that stubs the
// collection also intercepts this path.
async function getAllRecords() {
    const collection = await api.getOrCreateCollection();
    const result = await collection.get({ include: ['documents', 'metadatas'] });
    const ids = result.ids || [];
    const documents = result.documents || [];
    const metadatas = result.metadatas || [];
    return ids.map((id, i) => ({
        id,
        text: documents[i] || '',
        section: (metadatas[i] && metadatas[i].section) || 'Manual',
        accessLevel: (metadatas[i] && metadatas[i].access_level) || 'staff',
    }));
}

const api = { getClient, getOrCreateCollection, resetCollection, getAllRecords };
module.exports = api;
