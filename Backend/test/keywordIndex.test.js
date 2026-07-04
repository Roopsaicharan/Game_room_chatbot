const { test } = require('node:test');
const assert = require('node:assert/strict');
const keywordIndex = require('../services/keywordIndex');

const RECORDS = [
    { id: 'a', text: 'BOGO Thursday and $2 Tuesday are regular promotions.', section: 'Specials', accessLevel: 'public' },
    { id: 'b', text: 'Bowling shoes or Bowling Buddies must be worn by anyone bowling.', section: 'Rules', accessLevel: 'public' },
    { id: 'c', text: 'Connect2 is used to log in and complete task lists and rounds.', section: 'Daily Tasks', accessLevel: 'staff' },
    { id: 'd', text: 'Foosball tables are free for everyone.', section: 'Rates', accessLevel: 'public' },
];

test('tokenize lowercases, drops stopwords, and keeps digit/acronym tokens', () => {
    const toks = keywordIndex.tokenize('What is the BOGO deal on $2 Tuesday?');
    assert.ok(toks.includes('bogo'));
    assert.ok(toks.includes('2'));
    assert.ok(toks.includes('tuesday'));
    assert.ok(!toks.includes('the'), 'stopwords should be removed');
    assert.ok(!toks.includes('is'));
});

test('an exact acronym query (BOGO) retrieves the right chunk lexically', () => {
    const index = keywordIndex.buildIndex(RECORDS);
    const hits = keywordIndex.search(index, 'when is BOGO', ['public', 'staff']);
    assert.equal(hits[0].id, 'a', 'the BOGO promotions chunk should rank first for a BOGO query');
});

test('a code-like term (Connect2) retrieves the staff chunk', () => {
    const index = keywordIndex.buildIndex(RECORDS);
    const hits = keywordIndex.search(index, 'how do I use Connect2', ['public', 'staff']);
    assert.equal(hits[0].id, 'c');
});

test('respects the allowed access levels (public role never sees the staff chunk)', () => {
    const index = keywordIndex.buildIndex(RECORDS);
    const hits = keywordIndex.search(index, 'Connect2 rounds task list', ['public']);
    assert.ok(hits.every((h) => h.accessLevel === 'public'), 'a public search must not return staff chunks');
});

test('returns nothing when no query term matches the corpus', () => {
    const index = keywordIndex.buildIndex(RECORDS);
    const hits = keywordIndex.search(index, 'quidditch broomstick', ['public', 'staff']);
    assert.equal(hits.length, 0);
});
