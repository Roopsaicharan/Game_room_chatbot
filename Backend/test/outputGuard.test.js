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

test('blocks on a Luhn-valid credit-card number, not just partial redaction', () => {
    // 4111111111111111 is the canonical Visa test number and passes the Luhn check.
    const { text, blocked } = outputGuard.guard('Your card 4111111111111111 is on file.');
    assert.equal(blocked, true);
    assert.equal(text, outputGuard.RESTRICTED_MESSAGE);
});

test('does NOT block a long digit run that fails the Luhn check (e.g. an order/reference id)', () => {
    // 1234567890123456 is 16 digits but not Luhn-valid — a reference id, not a card number.
    const input = 'Your reservation reference 1234567890123456 is confirmed.';
    const { text, blocked } = outputGuard.guard(input);
    assert.equal(blocked, false);
    assert.equal(text, input);
});

test('redacts a labeled account/terminal number inline instead of blocking the whole reply', () => {
    const { text, blocked, redacted } = outputGuard.guard('The front desk terminal number 998877 is by register two.');
    assert.equal(blocked, false);
    assert.equal(redacted, true);
    assert.equal(text.includes('998877'), false);
    assert.ok(text.includes('by register two'), 'the non-sensitive remainder of the answer should survive');
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
