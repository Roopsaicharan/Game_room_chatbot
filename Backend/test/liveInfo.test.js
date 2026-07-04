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

// The real page text that fooled the bot on July 4.
const CLOSURE_CONTENT = 'Upcoming Closures: Independence Day: Saturday, July 4, 2026 The Game Room will close at 9 PM on July 3 and July 5, 2026. Saturday-Sunday 4 PM - 11 PM.';

test('closureAlertForToday fires when today is a full-closure holiday named in the notice', () => {
    const july4 = new Date('2026-07-04T15:00:00Z'); // 11am ET on the 4th
    const alert = liveInfo.closureAlertForToday(CLOSURE_CONTENT, july4);
    assert.ok(alert, 'expected a closure alert on Independence Day');
    assert.equal(alert.date, 'July 4');
    assert.match(alert.snippet.toLowerCase(), /independence day|clos/);
});

test('closureAlertForToday fires for an early-closing day named in the notice', () => {
    const july3 = new Date('2026-07-03T15:00:00Z');
    const alert = liveInfo.closureAlertForToday(CLOSURE_CONTENT, july3);
    assert.ok(alert, 'expected an alert on July 3 (closes early at 9 PM)');
    assert.equal(alert.date, 'July 3');
});

test('closureAlertForToday does NOT fire on an ordinary day not mentioned in any closure notice', () => {
    const july12 = new Date('2026-07-12T15:00:00Z');
    assert.equal(liveInfo.closureAlertForToday(CLOSURE_CONTENT, july12), null);
});
