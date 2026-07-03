const { test } = require('node:test');
const assert = require('node:assert/strict');
const { searchManual } = require('../services/searchManual');
const chromaClient = require('../services/chromaClient');
const navigator = require('../lib/navigatorClient');

// Stubs Chroma + the embedding call so these tests are offline and deterministic — they
// exercise searchManual.js's own filtering/ranking logic, not Chroma or Navigator itself.
async function withStubs(fakeQueryResult, run) {
    const originalGetCollection = chromaClient.getOrCreateCollection;
    const originalEmbed = navigator.embed;
    let capturedArgs = null;
    chromaClient.getOrCreateCollection = async () => ({
        query: async (args) => {
            capturedArgs = args;
            return fakeQueryResult;
        },
    });
    navigator.embed = async () => [0.1, 0.2, 0.3];
    try {
        await run(() => capturedArgs);
    } finally {
        chromaClient.getOrCreateCollection = originalGetCollection;
        navigator.embed = originalEmbed;
    }
}

const EMPTY_RESULT = { documents: [[]], metadatas: [[]], distances: [[]] };

test('requests more than 5 candidates per query (regression: a relevant public chunk — the general contact info section, 0.734 similarity — was previously excluded purely by an overly small top-K cutoff, not low relevance)', async () => {
    await withStubs(EMPTY_RESULT, async (getArgs) => {
        await searchManual('Where can I contact the game room supervisor?', 'public');
        assert.ok(getArgs().nResults >= 8, `expected at least 8 candidates requested, got ${getArgs().nResults}`);
    });
});

test('public role only queries for public-tagged chunks', async () => {
    await withStubs(EMPTY_RESULT, async (getArgs) => {
        await searchManual('any question', 'public');
        assert.deepEqual(getArgs().where, { access_level: 'public' });
    });
});

test('staff role queries for both public and staff-tagged chunks', async () => {
    await withStubs(EMPTY_RESULT, async (getArgs) => {
        await searchManual('any question', 'staff');
        assert.deepEqual(getArgs().where, { access_level: { $in: ['public', 'staff'] } });
    });
});

test('filters out passages below the relevance threshold', async () => {
    const fakeResult = {
        documents: [['relevant text', 'irrelevant text']],
        metadatas: [[{ section: 'A', access_level: 'public' }, { section: 'B', access_level: 'public' }]],
        // similarity = 1 - distance/2 -> 0.2 gives 0.9 (kept), 1.9 gives 0.05 (dropped, below the 0.35 default threshold)
        distances: [[0.2, 1.9]],
    };
    await withStubs(fakeResult, async () => {
        const { passages } = await searchManual('any question', 'public');
        assert.equal(passages.length, 1);
        assert.equal(passages[0].section, 'A');
    });
});

test('defensively re-checks access_level in code even if a disallowed chunk somehow comes back from Chroma (the where filter is not the sole boundary)', async () => {
    const fakeResult = {
        documents: [['staff-only text']],
        metadatas: [[{ section: 'Staff Section', access_level: 'staff' }]],
        distances: [[0.1]],
    };
    await withStubs(fakeResult, async () => {
        const { passages } = await searchManual('any question', 'public');
        assert.equal(passages.length, 0, 'a staff-tagged chunk must never reach a public caller, even if the where filter somehow missed it');
    });
});

test('splits a compound question into separate sub-queries so one topic cannot dilute another\'s embedding (regression: "what about tv streams? also, can i play without bowling shoes" failed to surface the bowling-shoes rule because the combined message was embedded as a single vector)', async () => {
    await withStubs(EMPTY_RESULT, async (getArgs) => {
        await searchManual('what about tv streams? also, can i play without bowling shoes', 'public');
        assert.equal(getArgs().queryEmbeddings.length, 2, 'expected one embedding per sub-question');
    });
});

test('merges and dedupes passages across sub-queries, keeping the best score for a chunk that matches more than one', async () => {
    const fakeResult = {
        // two sub-queries: first finds chunk A strongly and chunk B weakly, second finds chunk A weakly (duplicate) and chunk C strongly
        documents: [['chunk A text', 'chunk B text'], ['chunk A text', 'chunk C text']],
        metadatas: [
            [{ section: 'A', access_level: 'public' }, { section: 'B', access_level: 'public' }],
            [{ section: 'A', access_level: 'public' }, { section: 'C', access_level: 'public' }],
        ],
        distances: [[0.2, 1.2], [1.0, 0.1]],
    };
    await withStubs(fakeResult, async () => {
        const { passages } = await searchManual('first question? also, second question', 'public');
        const sections = passages.map((p) => p.section);
        assert.deepEqual(sections, ['C', 'A', 'B'], 'expected sections sorted by best score, chunk A deduped to its higher-scoring hit');
    });
});

test('reports usedFallback when nothing passes the relevance threshold', async () => {
    const fakeResult = {
        documents: [['barely related text']],
        metadatas: [[{ section: 'A', access_level: 'public' }]],
        distances: [[1.9]],
    };
    await withStubs(fakeResult, async () => {
        const { passages, usedFallback } = await searchManual('any question', 'public');
        assert.equal(passages.length, 0);
        assert.equal(usedFallback, true);
    });
});
