const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const chatRoutes = require('../routes/chat');
const { parseNdjsonEvents, fullText } = require('./helpers/ndjson');

// Mirrors chat.validation.test.js's freshChatApp() helper.
function freshChatApp() {
    const app = express();
    app.use(express.json({ limit: '20kb' }));
    app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
    app.use('/api/chat', chatRoutes);
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);
        const status = err.status || err.statusCode || 500;
        const messages = { 400: 'Malformed request body', 413: 'Request body too large' };
        res.status(status).json({ error: messages[status] || 'Something went wrong' });
    });
    return app;
}

// Stubs Navigator to THROW if called at all - proves the reservation-flow bypass never reaches
// the router/generation path. Both routes/chat.js and services/router.js share this cached
// module object, so patching it here stubs both call sites (same technique as the other test
// files in this suite).
function stubNavigatorToThrow() {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => { throw new Error('router must not be called during an active reservation flow'); };
    navigator.chatCompleteStream = async function* () { throw new Error('generation must not be called during an active reservation flow'); };
    return () => {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    };
}

test('a cold "start" message enters the reservation flow without calling the router', async () => {
    const restore = stubNavigatorToThrow();
    try {
        const app = freshChatApp();
        const agent = request.agent(app);
        const res = await agent.post('/api/chat').send({ message: 'start' });
        assert.equal(res.status, 200);
        assert.match(fullText(parseNdjsonEvents(res.text)), /name/i);
    } finally {
        restore();
    }
});

test('a follow-up answer continues the flow across requests (session persists)', async () => {
    const restore = stubNavigatorToThrow();
    try {
        const app = freshChatApp();
        const agent = request.agent(app);
        await agent.post('/api/chat').send({ message: 'start' });
        const res = await agent.post('/api/chat').send({ message: 'Jane Doe' });
        assert.equal(res.status, 200);
        assert.match(fullText(parseNdjsonEvents(res.text)), /email/i);
    } finally {
        restore();
    }
});

test('cancel mid-flow exits back to normal chat (router reached on the next message)', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    let routerCalls = 0;
    navigator.chatComplete = async () => { routerCalls += 1; return '{"intent":"casual","standalone_query":"hi"}'; };
    navigator.chatCompleteStream = async function* () { yield 'Hi there!'; };
    try {
        const app = freshChatApp();
        const agent = request.agent(app);
        await agent.post('/api/chat').send({ message: 'start' });
        await agent.post('/api/chat').send({ message: 'cancel' });
        const res = await agent.post('/api/chat').send({ message: 'hi' });
        assert.equal(res.status, 200);
        assert.equal(routerCalls, 1, 'the router should be reached once cancel has exited the flow');
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a reservation-topic answer gets the start-reservation CTA appended', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    // 'casual' avoids buildToolContext's manual/live branches entirely (no Chroma/live-page
    // network calls), matching the technique chat.validation.test.js already uses.
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"can I make a reservation"}';
    navigator.chatCompleteStream = async function* () { yield 'Sure, here is some info.'; };
    try {
        const app = freshChatApp();
        const res = await request(app).post('/api/chat').send({ message: 'Can I make a reservation for the game room?' });
        assert.equal(res.status, 200);
        assert.match(fullText(parseNdjsonEvents(res.text)), /type \*\*start\*\*/);
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a non-reservation-topic answer does NOT get the CTA appended', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"hello"}';
    navigator.chatCompleteStream = async function* () { yield 'Hi there!'; };
    try {
        const app = freshChatApp();
        const res = await request(app).post('/api/chat').send({ message: 'hello' });
        assert.equal(res.status, 200);
        assert.equal(/type \*\*start\*\*/.test(fullText(parseNdjsonEvents(res.text))), false);
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a generic equipment-rental question does NOT get the CTA, even when the router paraphrases it into a standalone "rent" query (regression: false positive on "renting shoes")', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    // The router's rewrite contains a bare "rent" - this used to falsely trigger the CTA when
    // the check also looked at standaloneQuery. The raw user message never says "rent" at all.
    navigator.chatComplete = async () => '{"intent":"manual","standalone_query":"is it necessary to rent bowling shoes if I have my own"}';
    navigator.chatCompleteStream = async function* () { yield 'No, you can wear your own bowling shoes.'; };
    try {
        const app = freshChatApp();
        const res = await request(app).post('/api/chat').send({
            message: 'what if I have bowling shoes of my own still renting out shoes at the front desk is necessary?',
        });
        assert.equal(res.status, 200);
        assert.equal(/type \*\*start\*\*/.test(fullText(parseNdjsonEvents(res.text))), false);
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a bare "stop" dismisses the reservation CTA for the rest of the session', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"can I make a reservation"}';
    navigator.chatCompleteStream = async function* () { yield 'Sure, here is some info.'; };
    try {
        const app = freshChatApp();
        const agent = request.agent(app);

        // First reservation-topic message: CTA should appear.
        const first = await agent.post('/api/chat').send({ message: 'Can I make a reservation for the game room?' });
        assert.match(fullText(parseNdjsonEvents(first.text)), /type \*\*start\*\*/);

        // "stop" is a control keyword, handled without any router call.
        const stopRes = await agent.post('/api/chat').send({ message: 'stop' });
        assert.equal(stopRes.status, 200);
        assert.match(fullText(parseNdjsonEvents(stopRes.text)), /won't bring up reservations/i);

        // Same reservation-topic message again: CTA must NOT reappear this session.
        const second = await agent.post('/api/chat').send({ message: 'Can I make a reservation for the game room?' });
        assert.equal(/type \*\*start\*\*/.test(fullText(parseNdjsonEvents(second.text))), false);
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a genuine question mid-flow gets answered via the normal RAG pipeline, then re-shows the same pending question (flow state untouched)', async () => {
    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    let routerCalls = 0;
    navigator.chatComplete = async () => { routerCalls += 1; return '{"intent":"casual","standalone_query":"can I type a number"}'; };
    navigator.chatCompleteStream = async function* () { yield 'Yes, just reply with the number shown.'; };
    try {
        const app = freshChatApp();
        const agent = request.agent(app);

        await agent.post('/api/chat').send({ message: 'start' });
        await agent.post('/api/chat').send({ message: 'Jane Doe' });
        await agent.post('/api/chat').send({ message: 'jane.doe@ufl.edu' });
        await agent.post('/api/chat').send({ message: '352-123-4567' });
        // Now on the affiliation (single-choice) question - ask a genuine question instead of
        // answering it.
        const digression = await agent.post('/api/chat').send({ message: 'can I type a number as my answer?' });
        assert.equal(digression.status, 200);
        assert.equal(routerCalls, 1, 'the digression question should reach the normal router exactly once');
        const digressionText = fullText(parseNdjsonEvents(digression.text));
        assert.match(digressionText, /just reply with the number/i, 'the real RAG answer should be included');
        assert.match(digressionText, /affiliation/i, 'the pending reservation question should be re-shown as a reminder');

        // Flow state must be untouched - answering the affiliation question for real now should
        // advance to the NEXT step (org name), not be treated as a second attempt at some
        // already-passed step.
        const answered = await agent.post('/api/chat').send({ message: '1' });
        assert.match(fullText(parseNdjsonEvents(answered.text)), /organization or department/i);
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a plain wrong (non-question) answer mid-flow still gets the deterministic re-prompt, no router call', async () => {
    const restore = stubNavigatorToThrow();
    try {
        const app = freshChatApp();
        const agent = request.agent(app);
        await agent.post('/api/chat').send({ message: 'start' });
        await agent.post('/api/chat').send({ message: 'Jane Doe' });
        await agent.post('/api/chat').send({ message: 'jane.doe@ufl.edu' });
        await agent.post('/api/chat').send({ message: '352-123-4567' });
        // Not question-shaped, and not a valid option - should stay fully deterministic.
        const res = await agent.post('/api/chat').send({ message: 'purple' });
        assert.equal(res.status, 200);
        assert.match(fullText(parseNdjsonEvents(res.text)), /didn't catch that/i);
    } finally {
        restore();
    }
});

test('POST /api/chat/reset clears an in-progress reservation flow', async () => {
    const restore = stubNavigatorToThrow();
    const app = freshChatApp();
    const agent = request.agent(app);
    try {
        await agent.post('/api/chat').send({ message: 'start' });
        const resetRes = await agent.post('/api/chat/reset').send({});
        assert.equal(resetRes.status, 200);
    } finally {
        restore();
    }

    const navigator = require('../lib/navigatorClient');
    const originalChatComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    let routerCalls = 0;
    navigator.chatComplete = async () => { routerCalls += 1; return '{"intent":"casual","standalone_query":"hi"}'; };
    navigator.chatCompleteStream = async function* () { yield 'Hi there!'; };
    try {
        const res = await agent.post('/api/chat').send({ message: 'hi' });
        assert.equal(res.status, 200);
        assert.equal(routerCalls, 1, 'reset should have cleared reservationFlow, so this message reaches the router instead of being treated as an answer to "what is your name"');
    } finally {
        navigator.chatComplete = originalChatComplete;
        navigator.chatCompleteStream = originalStream;
    }
});
