const { test } = require('node:test');
const assert = require('node:assert/strict');
const router = require('../services/router');
const navigator = require('../lib/navigatorClient');

// parseRouterOutput is pure and deterministic — exercise its tolerance directly.
test('parses clean minified router JSON', () => {
    const { intent, standaloneQuery } = router.parseRouterOutput(
        '{"intent":"live","standalone_query":"what are the faculty billiards prices"}',
        'fallback'
    );
    assert.equal(intent, 'live');
    assert.equal(standaloneQuery, 'what are the faculty billiards prices');
});

test('tolerates a code fence and surrounding prose around the JSON', () => {
    const raw = 'Sure, here you go:\n```json\n{"intent":"manual","standalone_query":"do I need bowling shoes"}\n```';
    const { intent, standaloneQuery } = router.parseRouterOutput(raw, 'fallback');
    assert.equal(intent, 'manual');
    assert.equal(standaloneQuery, 'do I need bowling shoes');
});

test('recovers intent via regex when JSON is malformed but the field is present', () => {
    const { intent } = router.parseRouterOutput('{"intent": "casual", oops not json', 'hi there');
    assert.equal(intent, 'casual');
});

test('defaults to manual (not a refusal) and keeps the raw message when output is unparseable', () => {
    const { intent, standaloneQuery } = router.parseRouterOutput('total garbage, no json at all', 'how much is pool');
    assert.equal(intent, 'manual', 'a malformed router response must not wrongly refuse a legitimate question');
    assert.equal(standaloneQuery, 'how much is pool');
});

test('coerces an unknown intent label to the manual default', () => {
    const { intent } = router.parseRouterOutput('{"intent":"banana","standalone_query":"x"}', 'x');
    assert.equal(intent, 'manual');
});

test('classifyAndRewrite passes recent history into the model and returns parsed result', async () => {
    const original = navigator.chatComplete;
    let capturedUserContent = null;
    navigator.chatComplete = async (messages) => {
        capturedUserContent = messages[1].content;
        return '{"intent":"live","standalone_query":"what is the faculty billiards price"}';
    };
    try {
        const history = [
            { role: 'user', content: 'how much is pool' },
            { role: 'assistant', content: 'For students it is $5.00 per table per hour.' },
        ];
        const { intent, standaloneQuery } = await router.classifyAndRewrite('what about for faculty?', history);
        assert.equal(intent, 'live');
        assert.equal(standaloneQuery, 'what is the faculty billiards price');
        assert.ok(capturedUserContent.includes('how much is pool'), 'history should be included in the router prompt');
        assert.ok(capturedUserContent.includes('what about for faculty?'), 'latest message should be included');
    } finally {
        navigator.chatComplete = original;
    }
});
