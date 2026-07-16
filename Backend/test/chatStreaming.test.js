const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');

const navigator = require('../lib/navigatorClient');
const chatRoutes = require('../routes/chat');
const outputGuard = require('../services/outputGuard');
const { parseNdjsonEvents, fullText, doneEvent } = require('./helpers/ndjson');

// Focused coverage for streamGuardedReply() (routes/chat.js) — the incremental holdback-buffer
// guard introduced alongside token streaming. This is the most security-sensitive new code in
// that change: it re-implements, chunk-by-chunk, the same fail-closed behavior
// services/outputGuard.js's guard() already guarantees for a single complete string. These
// tests assert the SAME guarantee holds when the text arrives in fragments that split a
// sensitive pattern across chunk boundaries — the scenario a naive "stream tokens straight
// through" implementation would get wrong.
function freshApp() {
    const app = express();
    app.use(express.json({ limit: '20kb' }));
    app.use(session({ secret: 'stream-test-secret', resave: false, saveUninitialized: false, cookie: { secure: false } }));
    app.use('/api/chat', chatRoutes);
    return app;
}

// Splits `text` into small multi-character fragments (not single chars — real model deltas are
// sub-word tokens, not individual letters) to simulate realistic streaming boundaries that can
// still land in the middle of a sensitive pattern.
function fragment(text, size = 3) {
    const parts = [];
    for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
    return parts;
}

test('a credential split across many stream deltas never appears in any chunk event, and the reply is blocked', async () => {
    const originalComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"x"}';
    const secretReply = 'Sure, the password: hunter2 is the login.';
    navigator.chatCompleteStream = async function* () {
        for (const piece of fragment(secretReply)) yield piece;
    };
    try {
        // NOTE: the trigger message must NOT itself be a credential-LOCATION query (e.g. "what
        // is the password"), or routes/chat.js's issue-#14 guard short-circuits to a canned
        // pointer before generation and this streaming path never runs. This test is about the
        // output guard catching a credential the MODEL emits, so we use a neutral question and
        // let the mocked stream produce the secret.
        const res = await request(freshApp()).post('/api/chat').send({ message: 'give me the closing rundown' });
        assert.equal(res.status, 200);
        const events = parseNdjsonEvents(res.text);

        const chunkEvents = events.filter((e) => e.type === 'chunk');
        for (const e of chunkEvents) {
            assert.ok(!/hunter2/i.test(e.text), `a chunk event leaked the secret value: ${JSON.stringify(e.text)}`);
            assert.ok(!/password\s*[:=]/i.test(e.text), `a chunk event leaked the credential label+separator: ${JSON.stringify(e.text)}`);
        }
        const blocked = events.find((e) => e.type === 'blocked');
        assert.ok(blocked, 'expected a blocked event');
        assert.equal(blocked.text, outputGuard.RESTRICTED_MESSAGE);

        const done = doneEvent(events);
        assert.deepEqual(done.sources, []);
    } finally {
        navigator.chatComplete = originalComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a redact-tier match (labeled account number) split across deltas is masked, never appears raw in any chunk, and still streams progressively', async () => {
    const originalComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"x"}';
    const reply = 'Here are the closing steps: scan every item at the register, then verify the drawer. '
        + 'Account number: 120615366781 is used for end-of-shift reconciliation, so log it carefully '
        + 'in the closing paperwork binder before you leave for the night, every single time.';
    navigator.chatCompleteStream = async function* () {
        for (const piece of fragment(reply)) yield piece;
    };
    try {
        const res = await request(freshApp()).post('/api/chat').send({ message: 'how do I close' });
        assert.equal(res.status, 200);
        const events = parseNdjsonEvents(res.text);
        const chunkEvents = events.filter((e) => e.type === 'chunk');

        assert.ok(chunkEvents.length > 1, 'expected more than one chunk event — a single end-of-stream flush would defeat the point of streaming');
        for (const e of chunkEvents) {
            assert.ok(!e.text.includes('120615366781'), `a chunk event leaked the raw account number: ${JSON.stringify(e.text)}`);
        }
        assert.equal(events.some((e) => e.type === 'blocked'), false, 'a redact-tier match must not block the whole reply');

        const combined = fullText(events);
        assert.ok(combined.includes(outputGuard.REDACTION_PLACEHOLDER), 'expected the account number to be masked in the assembled text');
        assert.ok(combined.includes('closing paperwork binder'), 'the rest of the answer should survive around the redaction');
    } finally {
        navigator.chatComplete = originalComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a normal safe answer streams progressively (multiple chunk events) and reassembles exactly', async () => {
    const originalComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"x"}';
    const reply = 'We have 14 bowling lanes, 9 billiards tables, a snooker table, foosball, air hockey, '
        + 'table tennis, and an esports gaming area with consoles and PCs for you to enjoy any time we are open.';
    navigator.chatCompleteStream = async function* () {
        for (const piece of fragment(reply)) yield piece;
    };
    try {
        const res = await request(freshApp()).post('/api/chat').send({ message: 'what games do you have' });
        assert.equal(res.status, 200);
        const events = parseNdjsonEvents(res.text);
        const chunkEvents = events.filter((e) => e.type === 'chunk');

        assert.ok(chunkEvents.length > 1, 'expected progressive delivery, not one final blob');
        assert.equal(fullText(events), reply);
        assert.equal(events.some((e) => e.type === 'blocked' || e.type === 'error'), false);
    } finally {
        navigator.chatComplete = originalComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

test('a mid-stream generation failure with no text sent yet reports a clean error event, not a hang or crash', async () => {
    const originalComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    navigator.chatComplete = async () => '{"intent":"casual","standalone_query":"x"}';
    navigator.chatCompleteStream = async function* () {
        throw new Error('navigator connection dropped');
    };
    try {
        const res = await request(freshApp()).post('/api/chat').send({ message: 'hello' });
        assert.equal(res.status, 200); // headers already committed to the stream by this point
        const events = parseNdjsonEvents(res.text);
        const errorEvent = events.find((e) => e.type === 'error');
        assert.ok(errorEvent, 'expected an error event');
        assert.equal(errorEvent.message.includes('navigator connection dropped'), false, 'internal error text must not leak');
    } finally {
        navigator.chatComplete = originalComplete;
        navigator.chatCompleteStream = originalStream;
    }
});

// Issue #14: a "where do I find <credential>" question is answered deterministically in code and
// must never reach the router or the model — the model was observed inventing fake sign-in steps
// for a system it had no grounded context for. This asserts the short-circuit fires (canned
// pointer, empty sources) AND that neither the router call nor generation was invoked.
test('a credential-location question short-circuits to a canned pointer without calling the model', async () => {
    const originalComplete = navigator.chatComplete;
    const originalStream = navigator.chatCompleteStream;
    let modelCalled = false;
    navigator.chatComplete = async () => { modelCalled = true; return '{"intent":"casual","standalone_query":"x"}'; };
    navigator.chatCompleteStream = async function* () { modelCalled = true; yield 'should not happen'; };
    try {
        const res = await request(freshApp()).post('/api/chat').send({ message: 'where do I find the wifi password?' });
        assert.equal(res.status, 200);
        const events = parseNdjsonEvents(res.text);
        assert.equal(modelCalled, false, 'the model/router must not be called for a credential-location query');
        const text = fullText(events);
        assert.match(text, /restricted/i, 'a public user gets the RESTRICTED pointer');
        assert.ok(!/hunter2|should not happen/i.test(text), 'no generated text leaked through');
        assert.deepEqual(doneEvent(events).sources, [], 'a canned pointer carries no sources');
    } finally {
        navigator.chatComplete = originalComplete;
        navigator.chatCompleteStream = originalStream;
    }
});
