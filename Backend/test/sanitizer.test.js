const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize } = require('../services/sanitizer');

test('redacts labeled password (defect 3 baseline)', () => {
    const { text, redactionCount } = sanitize('password: hunter2');
    assert.equal(text.includes('hunter2'), false);
    assert.match(text, /\[REDACTED\]/);
    assert.equal(redactionCount, 1);
});

test('redacts "pw" shorthand label (defect 11 regression)', () => {
    const { text } = sanitize('PW: Bowling100!');
    assert.equal(text.includes('Bowling100'), false);
    assert.match(text, /\[REDACTED\]/);
});

test('redacts natural-language password phrasing (defect 3 regression)', () => {
    const { text } = sanitize('Reminder: the password is Sw0rdfish!');
    assert.equal(text.includes('Sw0rdfish'), false);
});

test('redacts natural-language access-code phrasing ("the alarm code is 4471")', () => {
    const { text } = sanitize('If something goes wrong, the alarm code is 4471.');
    assert.equal(text.includes('4471'), false);
});

test('does NOT redact plain prose that merely mentions "password" (avoid false positives)', () => {
    const input = 'Remember that your password protects your account, so keep it safe.';
    const { text, redactionCount } = sanitize(input);
    assert.equal(text, input);
    assert.equal(redactionCount, 0);
});

test('redacts email addresses (defect 11 regression)', () => {
    const { text } = sanitize('Questions? Contact jsmith@ufl.edu for help.');
    assert.equal(text.includes('jsmith@ufl.edu'), false);
});

test('redacts phone numbers at ingestion time', () => {
    const { text } = sanitize('Call the manager at 352-392-1637 after hours.');
    assert.equal(text.includes('352-392-1637'), false);
});

test('redacts labeled account numbers with ": #" separator (defect 12 regression)', () => {
    const { text } = sanitize('Account: # 120615366781');
    assert.equal(text.includes('120615366781'), false);
});

test('redacts labeled merchant/terminal numbers', () => {
    const { text } = sanitize('Merchant ID 1234567890');
    assert.equal(text.includes('1234567890'), false);
});

test('redacts credit-card-shaped digit runs', () => {
    const { text } = sanitize('Card on file: 4111 1111 1111 1111');
    assert.equal(text.includes('4111 1111 1111 1111'), false);
});

test('redacts bearer tokens and api-key-shaped strings', () => {
    const { text: t1 } = sanitize('Authorization: Bearer abcd1234efgh5678ijkl');
    assert.equal(t1.includes('abcd1234efgh5678ijkl'), false);
    const { text: t2 } = sanitize('key is sk-abcdefghijklmnop1234567890');
    assert.equal(t2.includes('sk-abcdefghijklmnop1234567890'), false);
});

test('leaves ordinary manual prose untouched', () => {
    const input = 'The Game Room has 14 bowling lanes and 9 billiards tables, open daily.';
    const { text, redactionCount } = sanitize(input);
    assert.equal(text, input);
    assert.equal(redactionCount, 0);
});
