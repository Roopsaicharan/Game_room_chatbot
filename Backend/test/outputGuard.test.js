const { test } = require('node:test');
const assert = require('node:assert/strict');
const outputGuard = require('../services/outputGuard');

test('passes clean text through unchanged', () => {
    const input = 'The Game Room is open until 9 PM today.';
    const { text, blocked } = outputGuard.guard(input);
    assert.equal(text, input);
    assert.equal(blocked, false);
});

test('blocks and fully replaces a response leaking a labeled password', () => {
    const { text, blocked } = outputGuard.guard('Sure! password: hunter2');
    assert.equal(blocked, true);
    assert.equal(text, outputGuard.RESTRICTED_MESSAGE);
    assert.equal(text.includes('hunter2'), false);
});

test('blocks on credit-card-shaped digit runs, not just partial redaction', () => {
    const { text, blocked } = outputGuard.guard('Your card 4111111111111111 is on file.');
    assert.equal(blocked, true);
    assert.equal(text, outputGuard.RESTRICTED_MESSAGE);
});

test('blocks on SSN-shaped strings', () => {
    const { blocked } = outputGuard.guard('SSN: 123-45-6789');
    assert.equal(blocked, true);
});

test('blocks on bearer-token-shaped strings', () => {
    const { blocked } = outputGuard.guard('Use Bearer abcd1234efgh5678ijkl to authenticate.');
    assert.equal(blocked, true);
});

test('does NOT block a legitimate public contact phone number (deliberate design choice)', () => {
    // sensitivePatterns.js explicitly excludes phone/email from the output-guard pattern set
    // because live-info responses legitimately relay the Game Room's public contact number.
    const input = 'Call 352-392-1637 for lane availability.';
    const { text, blocked } = outputGuard.guard(input);
    assert.equal(blocked, false);
    assert.equal(text, input);
});
