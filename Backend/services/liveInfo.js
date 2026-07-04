const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const env = require('../config/env');

// ALLOWLIST — only these official pages may ever be fetched.
const ALLOWLIST = {
    gameroom: 'https://union.ufl.edu/gameroom/',
    esports: 'https://union.ufl.edu/gatoresportscenter/',
};

const FETCH_TIMEOUT_MS = 10000;
// The gameroom page runs ~6600 chars and the esports page more; the old 6000 cap sliced off
// the tail (reservation payment terms, contact info). 15000 captures the full current pages
// with headroom while still bounding token cost if a page balloons unexpectedly.
const MAX_CONTENT_CHARS = 15000;
// If UF ever redesigns these pages to render content client-side via JS, cheerio (which only
// parses static HTML) would silently start returning near-empty content instead of erroring —
// this tripwire makes that failure visible in logs instead of silent.
const MIN_EXPECTED_CONTENT_CHARS = 500;

// Disk-backed so a restart doesn't drop every cached page and trigger a cold-fetch stampede on
// the union.ufl.edu pages. In-memory Map is the hot path; the file is the durable backing store.
// (Still single-instance — a multi-instance deployment would want a shared cache like Redis.)
const CACHE_FILE = path.join(env.PRIVATE_DIR, 'live_cache.json');
const cache = new Map(); // topic -> { content, sourceUrl, lastChecked, closureNoted, expiresAt }

function loadCacheFromDisk() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        for (const [topic, entry] of Object.entries(data)) {
            if (entry && typeof entry.content === 'string') cache.set(topic, entry);
        }
    } catch (error) {
        console.warn('Could not load live-info cache from disk:', error.message);
    }
}

function persistCacheToDisk() {
    try {
        env.ensurePrivateDir();
        const obj = Object.fromEntries(cache.entries());
        fs.writeFileSync(CACHE_FILE, JSON.stringify(obj));
    } catch (error) {
        console.warn('Could not persist live-info cache to disk:', error.message);
    }
}

loadCacheFromDisk();

function detectTopic(message) {
    if (/esport|valorant|league of legends|overwatch|rocket league|gaming pc|arena zone|tournament/i.test(message)) {
        return 'esports';
    }
    return 'gameroom';
}

function extractText(html) {
    const $ = cheerio.load(html);
    // Note: deliberately NOT stripping <header> — this site's theme wraps the entire
    // page content (not just the masthead) inside a single <header> element, so
    // removing it would delete almost everything, including hours/pricing/closures.
    $('script, style, nav, footer, svg, noscript, iframe').remove();
    const text = $('body').text();
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT_CHARS);
}

const CLOSURE_KEYWORDS = /clos(?:e|ed|ing|ure)|holiday|independence day|thanksgiving|christmas|new year|labor day|memorial day|spring break|winter break/i;

// Deterministic guard for the most dangerous live-info failure: confidently telling a visitor
// "we're open" on a day the page actually flags as a closure/holiday. If the CURRENT date (in
// ET) appears within a closure/holiday notice on the page, we return an alert the route injects
// into the model's context so the regular weekly hours can't silently override a same-day
// closure. Computed at read time (not cached) because "today" changes daily. `now` is injectable
// for testing.
function closureAlertForToday(content, now = new Date()) {
    if (!content) return null;
    const monthDay = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' });
    const [mon, day] = monthDay.split(' ');
    const dateRe = new RegExp(`\\b${mon}\\s+${day}(?:st|nd|rd|th)?\\b`, 'i');
    const re = new RegExp(CLOSURE_KEYWORDS.source, 'gi');
    let m;
    while ((m = re.exec(content)) !== null) {
        const win = content.slice(Math.max(0, m.index - 180), m.index + 180);
        if (dateRe.test(win)) {
            return { date: monthDay, snippet: win.replace(/\s+/g, ' ').trim() };
        }
    }
    return null;
}

async function fetchLiveInfo(topic) {
    const sourceUrl = ALLOWLIST[topic];
    if (!sourceUrl) {
        throw new Error(`Unknown live-info topic: ${topic}`);
    }

    const cached = cache.get(topic);
    if (cached && cached.expiresAt > Date.now()) {
        return cached;
    }

    try {
        const response = await fetch(sourceUrl, {
            headers: { 'User-Agent': 'GatorGameRoomAssistant/1.0 (+https://union.ufl.edu/gameroom/)' },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`Fetch failed with status ${response.status}`);
        }
        const html = await response.text();
        const content = extractText(html);
        if (content.length < MIN_EXPECTED_CONTENT_CHARS) {
            console.warn(
                `Live info tripwire: extracted only ${content.length} chars from ${sourceUrl} ` +
                `(expected ${MIN_EXPECTED_CONTENT_CHARS}+). The page may have been redesigned to ` +
                `render content via JavaScript, which cheerio cannot execute — check the page ` +
                `manually and consider switching to a headless-browser fetch if so.`
            );
        }
        const result = {
            content,
            sourceUrl,
            lastChecked: new Date().toISOString(),
            closureNoted: /\bclosed\b/i.test(content),
            expiresAt: Date.now() + env.LIVE_CACHE_TTL_MINUTES * 60 * 1000,
        };
        cache.set(topic, result);
        persistCacheToDisk();
        return result;
    } catch (error) {
        console.error(`Live info fetch error (${topic}):`, error.message);
        // Serve a stale-but-usable cached copy if we have one rather than nothing — a slightly
        // old hours/pricing snapshot beats a dead end when union.ufl.edu is briefly unreachable.
        const stale = cache.get(topic);
        if (stale && stale.content) {
            return { ...stale, stale: true };
        }
        return { content: '', sourceUrl, lastChecked: null, closureNoted: false, error: true };
    }
}

// Cache-only read: returns an already-fetched page WITHOUT triggering a network fetch, so a
// manual-intent answer can be enriched with current hours/pricing for free when the data is
// already warm. Returns a stale entry too (its lastChecked conveys the age); a cold cache just
// returns null and the answer stays manual-only.
function getCachedLiveInfo(topic) {
    const cached = cache.get(topic);
    return cached && cached.content ? cached : null;
}

module.exports = { fetchLiveInfo, getCachedLiveInfo, detectTopic, extractText, closureAlertForToday, ALLOWLIST, MAX_CONTENT_CHARS };
