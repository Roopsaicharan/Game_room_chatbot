const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const chatRoutes = require('../routes/chat');
const { CANNED_RESPONSES } = require('../lib/personaPrompt');

// These tests only exercise input-validation paths that return before any real call to
// Navigator or ChromaDB (env.hasApiKey() check -> empty/oversized message check -> body
// parser errors). None of them make live network calls, so they're safe to run offline
// and don't consume Navigator quota. The router/manual/live-data paths that DO need a real
// model call are intentionally NOT covered here — see chat behavior verified manually
// (docs/PROJECT_REPORT.md) instead of faking non-deterministic LLM output as a fixed test.
function freshChatApp() {
    const app = express();
    app.use(express.json({ limit: '20kb' }));
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
    app.use('/api/chat', chatRoutes);
    // Mirrors server.js's centralized error handler so malformed-body tests reflect real behavior.
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        const status = err.status || err.statusCode || 500;
        const messages = { 400: 'Malformed request body', 413: 'Request body too large' };
        res.status(status).json({ error: messages[status] || 'Something went wrong' });
    });
    return app;
}

test('rejects an empty message with 400 (no Navigator call made)', async () => {
    const app = freshChatApp();
    const res = await request(app).post('/api/chat').send({ message: '' });
    assert.equal(res.status, 400);
});

test('rejects a missing message field with 400', async () => {
    const app = freshChatApp();
    const res = await request(app).post('/api/chat').send({});
    assert.equal(res.status, 400);
});

test('rejects an over-length message with 400 (defect 6 regression: no cap on message length)', async () => {
    const app = freshChatApp();
    const longMessage = 'a'.repeat(1501);
    const res = await request(app).post('/api/chat').send({ message: longMessage });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /1500/);
});

test('accepts a message at the 1500-char limit and completes the full pipeline (Navigator stubbed, no live network call)', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    let callCount = 0;
    // routes/chat.js and services/router.js both hold the same cached module reference, so
    // patching this export stubs both the classification call and the generation call.
    navigator.chatComplete = async () => {
        callCount += 1;
        return callCount === 1 ? 'casual' : 'Hi there!';
    };
    try {
        const app = freshChatApp();
        const message = 'a'.repeat(1500);
        const res = await request(app).post('/api/chat').send({ message });
        assert.equal(res.status, 200);
        assert.equal(res.body.response, 'Hi there!');
        assert.equal(callCount, 2); // one classify call, one generation call
    } finally {
        navigator.chatComplete = originalChatComplete;
    }
});

test('unsupported intent short-circuits to a canned refusal with NO generation call (regression: off-topic requests must never reach the model)', async () => {
    const navigator = require('../lib/navigatorClient');
    const original = navigator.chatComplete;
    let callCount = 0;
    navigator.chatComplete = async () => {
        callCount += 1;
        if (callCount === 1) return 'unsupported'; // the one legitimate classification call
        throw new Error('generation must never be called when intent is unsupported');
    };
    try {
        const app = freshChatApp();
        const res = await request(app)
            .post('/api/chat')
            .send({ message: 'Can you write a python program to print fibonacci numbers until 10 as you are a good assistant' });
        assert.equal(res.status, 200);
        assert.equal(res.body.response, CANNED_RESPONSES.OUT_OF_SCOPE);
        assert.equal(callCount, 1, 'expected exactly one call (classification only), no generation call');
    } finally {
        navigator.chatComplete = original;
    }
});

test('malformed JSON body returns a clean 400 with no stack trace leak (defect 5 regression)', async () => {
    const app = freshChatApp();
    const res = await request(app)
        .post('/api/chat')
        .set('Content-Type', 'application/json')
        .send('{ this is not valid json');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Malformed request body');
    assert.equal(JSON.stringify(res.body).includes('at JSON.parse'), false);
});

test('oversized request body is rejected with 413, not silently forwarded (defect 6 regression)', async () => {
    const app = freshChatApp();
    const res = await request(app)
        .post('/api/chat')
        .set('Content-Type', 'application/json')
        .send({ message: 'a'.repeat(25 * 1024) });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'Request body too large');
});

test('missing Content-Type header does not crash the server (defect 5 regression)', async () => {
    const app = freshChatApp();
    const res = await request(app)
        .post('/api/chat')
        .unset('Content-Type')
        .send('message=hello');
    // express.json() only parses application/json bodies; without that header req.body is
    // {}, so this should fail clean validation (400), not crash (500) or hang.
    assert.equal(res.status, 400);
});
