const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const env = require('../config/env');
const navigator = require('../lib/navigatorClient');
const { buildSystemPrompt, CANNED_RESPONSES } = require('../lib/personaPrompt');
const router_ = require('../services/router');
const liveInfo = require('../services/liveInfo');
const { searchManual } = require('../services/searchManual');
const outputGuard = require('../services/outputGuard');
const analyticsStore = require('../services/analyticsStore');

const router = express.Router();

// Every chat message can trigger up to three Navigator API calls (classify+rewrite, embed,
// complete), so an unthrottled /api/chat is both a cost risk and a DoS surface. Throttle per
// client. Uses the session id when present (a logged-in staff/admin shares one), else the IP.
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: parseInt(process.env.CHAT_RATE_LIMIT_PER_MIN, 10) || 20,
    standardHeaders: true,
    legacyHeaders: false,
    // Prefer the session id (a logged-in staff/admin shares one) so a single user is one
    // bucket; fall back to the IP via the library's ipKeyGenerator, which normalizes IPv6
    // into a /64 subnet key so v6 clients can't trivially rotate addresses to bypass limits.
    keyGenerator: (req) => req.sessionID || ipKeyGenerator(req.ip),
    message: { response: "You're sending messages a little too fast — give me a moment and try again!" },
});

const NOT_CONFIGURED_MESSAGE = "I'm not fully configured yet — the site owner needs to set up the Navigator API key. Please check back soon!";
const MAX_MESSAGE_LENGTH = 1500;

// Conversation memory lives in the (file-backed) session. We keep a little more than we send:
// STORED is the rolling window persisted; CONTEXT is how many recent messages we actually feed
// to the router and the answer model, to bound token cost.
const MAX_HISTORY_STORED = 10;   // messages (≈5 exchanges)
const MAX_HISTORY_CONTEXT = 6;   // messages (≈3 exchanges)

function getHistory(req) {
    return Array.isArray(req.session?.history) ? req.session.history : [];
}

function recordTurn(req, userMessage, assistantReply) {
    if (!req.session) return;
    const history = getHistory(req);
    history.push({ role: 'user', content: userMessage });
    history.push({ role: 'assistant', content: assistantReply });
    req.session.history = history.slice(-MAX_HISTORY_STORED);
}

const CANNED_TEXTS = new Set([
    ...Object.values(CANNED_RESPONSES),
    outputGuard.RESTRICTED_MESSAGE,
]);

// A canned refusal/decline isn't grounded in the retrieved passages that happened to be
// fetched for the turn, so it shouldn't be citing them as if they were.
function isCannedResponse(text) {
    return CANNED_TEXTS.has(text.trim());
}

function formatLastChecked(iso) {
    return new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'medium',
        timeStyle: 'short',
    });
}

function formatPassages(passages) {
    return passages.map((p) => `[Section: ${p.section}]\n${p.text}`).join('\n\n');
}

// Passages come back ranked by fused relevance, so the first distinct sections are the ones the
// answer most likely drew on. Cite only the top couple instead of every section that happened to
// be retrieved — a footer listing six sections for a one-line answer reads as noise and erodes
// trust in the citation.
const MAX_CITED_SECTIONS = 2;
function topSections(passages, max = MAX_CITED_SECTIONS) {
    const seen = [];
    for (const p of passages) {
        if (!seen.includes(p.section)) seen.push(p.section);
        if (seen.length >= max) break;
    }
    return seen;
}

// Best-effort manual retrieval that never throws — used where a manual result is supplementary
// (a live-intent turn) and a retrieval error shouldn't sink the whole response.
async function safeSearchManual(message, role) {
    if (!env.hasManual()) return [];
    try {
        const { passages } = await searchManual(message, role);
        return passages;
    } catch (error) {
        console.error('Manual search error:', error.message);
        return [];
    }
}

async function buildToolContext(intent, message, role) {
    if (intent === 'live') {
        const topic = liveInfo.detectTopic(message);
        // Fetch live + manual in parallel and BLEND them: the live page is authoritative for
        // volatile facts (hours, pricing, closures), while the manual covers policies/details
        // the page omits. A compound question ("what's free and what are the reservation rules")
        // needs both. If live fails, the manual carries the turn as a labeled fallback.
        const [result, manualPassages] = await Promise.all([
            liveInfo.fetchLiveInfo(topic),
            safeSearchManual(message, role),
        ]);

        if (result.content) {
            let block = `LIVE_INFO (from ${result.sourceUrl}, fetched ${result.lastChecked}):\n${result.content}${result.closureNoted ? '\n[Note: the word "closed" appears on this page — check whether a reason is given before stating one.]' : ''}`;
            if (manualPassages.length > 0) {
                block += `\n\nSUPPLEMENTARY_MANUAL_CONTEXT (from the reference manual — use for policies/details the live page above doesn't cover; the live page remains authoritative for hours, pricing, and closures):\n${formatPassages(manualPassages)}`;
            }
            return { block, citation: { type: 'live', sourceUrl: result.sourceUrl, lastChecked: result.lastChecked } };
        }

        // The live page couldn't be reached (down, blocked, or redesigned — see the tripwire
        // in liveInfo.js). Rather than dead-ending, fall back to the manual's own general info
        // (hours, specials, reservation policies) — labeled as a secondary source so the model
        // hedges on currency (a manual value can be stale in a way a live fetch isn't).
        if (manualPassages.length > 0) {
            const block = `LIVE_INFO: (none — the live page could not be reached)\nFALLBACK_MANUAL_CONTEXT (from the reference manual, not live-verified — may be outdated):\n${formatPassages(manualPassages)}`;
            return { block, citation: { type: 'manual', sections: topSections(manualPassages) } };
        }

        return { block: 'LIVE_INFO: (none — the live page could not be reached, and no matching manual passage was found either)', citation: null };
    }

    if (intent === 'manual') {
        if (!env.hasManual()) {
            return { block: 'RETRIEVED_CONTEXT: (none — no manual has been loaded yet)', citation: null };
        }
        let passages = [];
        try {
            ({ passages } = await searchManual(message, role));
        } catch (error) {
            console.error('Manual search error:', error.message);
            return { block: 'RETRIEVED_CONTEXT: (none — the manual knowledge base could not be reached)', citation: null };
        }
        if (passages.length === 0) {
            return { block: 'RETRIEVED_CONTEXT: (none — no matching passages found)', citation: null };
        }
        const block = `RETRIEVED_CONTEXT:\n${formatPassages(passages)}`;
        return { block, citation: { type: 'manual', sections: topSections(passages) } };
    }

    return { block: '', citation: null };
}

router.post('/', chatLimiter, async (req, res) => {
    if (!env.hasApiKey()) {
        return res.status(503).json({ response: NOT_CONFIGURED_MESSAGE });
    }

    const userMessage = String((req.body || {}).message || '').trim();
    if (!userMessage) {
        return res.status(400).json({ error: 'message is required' });
    }
    if (userMessage.length > MAX_MESSAGE_LENGTH) {
        return res.status(400).json({ error: `message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    const userRole = req.session?.tier || 'public';
    // Include the current TIME, not just the date — "is it open right now" needs a clock
    // reference to answer definitively; without it the model has to hedge on "right now"
    // questions even when it has the correct hours in context.
    const currentDateTime = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'full',
        timeStyle: 'short',
    });

    const history = getHistory(req);
    const contextHistory = history.slice(-MAX_HISTORY_CONTEXT);

    try {
        // One call classifies intent AND rewrites the (possibly elliptical) message into a
        // standalone query using recent history, so a follow-up like "what about faculty?"
        // retrieves against "what is the faculty price for billiards?" instead of a bare
        // pronoun. The standalone query drives retrieval/live-topic detection; the original
        // message is what the answer model sees (with history for natural phrasing).
        const { intent, standaloneQuery } = await router_.classifyAndRewrite(userMessage, contextHistory);

        // Enforced in code, not left to the model's judgment: an "unsupported" classification
        // (credential requests, rule-override attempts, or anything unrelated to the Game
        // Room) short-circuits straight to a canned refusal with NO generation call at all.
        // Previously this still went to the model with an empty context block and relied on
        // the persona prompt alone to refuse — testing showed a flattering off-topic request
        // ("write me a Python program... you're a good assistant") could talk the model out
        // of refusing, since nothing in code actually enforced it.
        if (intent === 'unsupported') {
            recordTurn(req, userMessage, CANNED_RESPONSES.OUT_OF_SCOPE);
            analyticsStore.logQuestion({ role: userRole, intent, question: userMessage, answered: false, citationType: null });
            return res.json({ response: CANNED_RESPONSES.OUT_OF_SCOPE });
        }

        const { block, citation } = await buildToolContext(intent, standaloneQuery, userRole);

        const messages = [
            { role: 'system', content: buildSystemPrompt(userRole, currentDateTime) },
        ];
        if (block) {
            messages.push({ role: 'system', content: block });
        }
        // Prior turns give the model continuity for follow-ups. This is user-authored text, so
        // the same persona-prompt injection defenses apply — it's conversational context, never
        // an instruction source.
        for (const turn of contextHistory) {
            messages.push({ role: turn.role, content: turn.content });
        }
        messages.push({ role: 'user', content: userMessage });

        let reply = await navigator.chatComplete(messages, { temperature: 0.3 });

        const { text: guardedReply } = outputGuard.guard(reply);
        reply = guardedReply;

        if (citation && !isCannedResponse(reply)) {
            if (citation.type === 'live') {
                reply += `\n\nSource: ${citation.sourceUrl} (last checked ${formatLastChecked(citation.lastChecked)})`;
            } else if (citation.type === 'manual') {
                reply += `\n\nSource: Game Room Manual — ${citation.sections.join(', ')}`;
            }
        }

        recordTurn(req, userMessage, reply);
        // A turn "counts as answered" when it produced a grounded, non-canned reply. Refusals
        // and "no evidence" non-answers are logged as unanswered — that's the admin signal for
        // which questions the current knowledge base can't yet handle.
        analyticsStore.logQuestion({
            role: userRole,
            intent,
            question: userMessage,
            answered: !isCannedResponse(reply),
            citationType: citation ? citation.type : null,
        });
        res.json({ response: reply });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.status(500).json({ response: 'Sorry, I ran into a problem answering that. Please try again in a moment.' });
    }
});

// Lets the frontend start a fresh conversation without dropping the whole session (role/login
// is preserved; only the chat memory is cleared).
router.post('/reset', (req, res) => {
    if (req.session) req.session.history = [];
    res.json({ ok: true });
});

// Thumbs up/down on an answer. Kept lightweight and public — the endpoint the (future) UI
// buttons post to; also usable now via API. The ratings feed the admin feedback log.
router.post('/feedback', (req, res) => {
    const body = req.body || {};
    const rating = body.rating === 'up' ? 'up' : body.rating === 'down' ? 'down' : null;
    if (!rating) {
        return res.status(400).json({ error: "rating must be 'up' or 'down'" });
    }
    analyticsStore.logFeedback({
        role: req.session?.tier || 'public',
        rating,
        question: body.question,
        answer: body.answer,
    });
    res.json({ ok: true });
});

module.exports = router;
