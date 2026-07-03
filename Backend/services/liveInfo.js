const cheerio = require('cheerio');
const env = require('../config/env');

// ALLOWLIST — only these official pages may ever be fetched.
const ALLOWLIST = {
    gameroom: 'https://union.ufl.edu/gameroom/',
    esports: 'https://union.ufl.edu/gatoresportscenter/',
};

const cache = new Map(); // topic -> { content, sourceUrl, lastChecked, closureNoted, expiresAt }
const FETCH_TIMEOUT_MS = 10000;
// Real extracted pages run 6000-8000+ chars (truncated at 6000). If UF ever redesigns these
// pages to render content client-side via JS, cheerio (which only parses static HTML) would
// silently start returning near-empty content instead of erroring — this tripwire makes
// that failure visible in logs instead of silent.
const MIN_EXPECTED_CONTENT_CHARS = 500;

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
    return text.replace(/\s+/g, ' ').trim().slice(0, 6000);
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
        return result;
    } catch (error) {
        console.error(`Live info fetch error (${topic}):`, error.message);
        return { content: '', sourceUrl, lastChecked: null, closureNoted: false, error: true };
    }
}

module.exports = { fetchLiveInfo, detectTopic, ALLOWLIST };
