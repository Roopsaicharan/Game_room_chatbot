const { test } = require('node:test');
const assert = require('node:assert/strict');
const liveInfo = require('../services/liveInfo');

test('extractText strips scripts/styles/nav but keeps body content (incl. <header>-wrapped text)', () => {
    const html = `
        <html><head><style>.x{color:red}</style></head>
        <body>
          <header>Game Room hours: Monday-Friday 12 PM - 11 PM. Call 352-392-1637.</header>
          <nav>Home About Contact</nav>
          <script>console.log('tracking')</script>
          <footer>Copyright 2026</footer>
        </body></html>`;
    const text = liveInfo.extractText(html);
    assert.ok(text.includes('Monday-Friday 12 PM - 11 PM'), 'header-wrapped content must be preserved');
    assert.ok(text.includes('352-392-1637'));
    assert.ok(!text.includes('tracking'), 'script content must be stripped');
    assert.ok(!text.includes('Copyright'), 'footer content must be stripped');
});

test('extractText truncates to the configured max length', () => {
    const long = '<body>' + 'game room info '.repeat(4000) + '</body>';
    const text = liveInfo.extractText(long);
    assert.ok(text.length <= liveInfo.MAX_CONTENT_CHARS, `expected <= ${liveInfo.MAX_CONTENT_CHARS}, got ${text.length}`);
});

test('detectTopic routes esports terms to the esports page and everything else to gameroom', () => {
    assert.equal(liveInfo.detectTopic('is the valorant arena open'), 'esports');
    assert.equal(liveInfo.detectTopic('how much is bowling today'), 'gameroom');
});
