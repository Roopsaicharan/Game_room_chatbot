const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    isHeadingLine,
    parseAccessMarker,
    parseSections,
    detectAccessLevel,
    chunkParagraphs,
    addOverlap,
    slugify,
} = require('../scripts/ingest');

test('recognizes Markdown headings', () => {
    assert.equal(isHeadingLine('# Introduction'), 'Introduction');
    assert.equal(isHeadingLine('## Sub Heading'), 'Sub Heading');
});

test('recognizes ALL-CAPS headings', () => {
    assert.equal(isHeadingLine('SHIFT COVERAGE PROCEDURE'), 'SHIFT COVERAGE PROCEDURE');
});

test('does NOT treat numbered steps as headings (defect 13 regression)', () => {
    // This exact line, mid-procedure, was previously auto-detected as its own section
    // heading and auto-tagged "public" instead of staying part of a staff-only procedure.
    assert.equal(isHeadingLine('3. Message team members individually.'), null);
    assert.equal(isHeadingLine('1. Post your shift for trade'), null);
});

test('does not treat blank or lowercase prose lines as headings', () => {
    assert.equal(isHeadingLine(''), null);
    assert.equal(isHeadingLine('   '), null);
    assert.equal(isHeadingLine('this is a normal sentence.'), null);
});

test('parses explicit [PUBLIC]/[STAFF] access markers, case-insensitive', () => {
    assert.equal(parseAccessMarker('[PUBLIC]'), 'public');
    assert.equal(parseAccessMarker('[STAFF]'), 'staff');
    assert.equal(parseAccessMarker('[public]'), 'public');
    assert.equal(parseAccessMarker('not a marker'), null);
});

test('a numbered line inside a section stays in the same section (defect 13 regression)', () => {
    const manual = [
        'SHIFT COVERAGE PROCEDURE',
        '[STAFF]',
        '1. Find a coworker to cover your shift.',
        '2. Get manager approval.',
        '3. Message team members individually.',
        '',
        'HOURS',
        '[PUBLIC]',
        'Open 12 PM - 11 PM daily.',
    ].join('\n');

    const sections = parseSections(manual);
    assert.equal(sections.length, 2);
    assert.equal(sections[0].title, 'SHIFT COVERAGE PROCEDURE');
    assert.equal(sections[0].accessOverride, 'staff');
    // All three numbered steps must remain inside the one section, not fragment into new ones.
    const body = sections[0].bodyLines.join('\n');
    assert.match(body, /3\. Message team members individually\./);
    assert.equal(sections[1].title, 'HOURS');
    assert.equal(sections[1].accessOverride, 'public');
});

test('detectAccessLevel honors an explicit override over keyword guessing', () => {
    const section = { title: 'HOURS', bodyLines: ['staff only content'], accessOverride: 'staff' };
    assert.equal(detectAccessLevel(section), 'staff');
});

test('detectAccessLevel defaults to staff (restrictive) when no marker or public keyword matches', () => {
    const section = { title: 'INTERNAL ESCALATION STEPS', bodyLines: ['do the thing'], accessOverride: null };
    assert.equal(detectAccessLevel(section), 'staff');
});

test('detectAccessLevel tags obvious general-info sections public via keyword heuristic', () => {
    const section = { title: 'HOURS', bodyLines: ['We are open daily.'], accessOverride: null };
    assert.equal(detectAccessLevel(section), 'public');
});

test('chunkParagraphs keeps chunks within the max length and preserves all content', () => {
    const longSentence = 'This is a fairly long sentence about game room rules. '.repeat(30).trim();
    const chunks = chunkParagraphs([longSentence], 200);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
        assert.ok(chunk.length <= 200, `chunk exceeded max length: ${chunk.length}`);
    }
});

test('chunkParagraphs merges short paragraphs instead of over-fragmenting', () => {
    const chunks = chunkParagraphs(['Short one.', 'Short two.'], 800);
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /Short one\.[\s\S]*Short two\./);
});

test('addOverlap prefixes each chunk after the first with the tail of the previous chunk', () => {
    const base = ['First chunk ends with alpha beta gamma delta.', 'Second chunk starts here.'];
    const overlapped = addOverlap(base, 20);
    assert.equal(overlapped[0], base[0], 'first chunk is unchanged');
    assert.ok(overlapped[1].endsWith('Second chunk starts here.'), 'original chunk text is preserved');
    assert.ok(overlapped[1].length > base[1].length, 'overlap text was prepended');
    assert.ok(/gamma|delta/.test(overlapped[1]), 'the prepended text comes from the end of the previous chunk');
});

test('addOverlap is a no-op for a single chunk or zero overlap', () => {
    assert.deepEqual(addOverlap(['only one chunk'], 120), ['only one chunk']);
    assert.deepEqual(addOverlap(['a', 'b'], 0), ['a', 'b']);
});

test('slugify produces a safe, bounded id fragment', () => {
    assert.equal(slugify('Shift Coverage Procedure!'), 'shift-coverage-procedure');
    assert.equal(slugify(''), 'section');
});
