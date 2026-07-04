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

// The router (an LLM) is imperfect and, even at temperature 0, occasionally dumps a legitimate
// question into "unsupported" and would hard-refuse it. So we CONFIRM IN CODE before refusing:
// only a message that actually looks like a credential grab or an off-topic / rule-override /
// code-generation attempt is hard-refused. Everything else the router flagged unsupported falls
// through to a grounded attempt (the persona prompt still refuses genuine off-topic itself).
const SECRET_TERMS = /\b(password|passcode|passwd|pw|credential|api\s*key|access\s*code|door\s*code|alarm\s*code|admin\s*login)\b/i;
const OFFTOPIC_ATTACK = /\b(python|javascript|typescript|java|c\+\+|golang|rust|sql|code|coding|program|programming|script|algorithm|essay|poem|story|homework|recipe|joke|translate)\b|ignore (the|your|all|previous)|disregard (the|your|all|previous)|pretend (you|to be|that)|act as|you are now|roleplay|jailbreak|developer mode|system prompt|tell me everything|dump (the|everything|all)|entire manual|whole manual/i;
// The venue's own answerable public info — used to route a rescued question to the live path
// (which blends the manual) since contact/hours/pricing facts often live on the page.
const PUBLIC_INFO = /\b(phone|contact|address|e-?mail|hours?|pricing|price|cost|rate|fee|location|located|directions|reservation|bowling|billiards?|pool table|foosball|snooker|esports|air hockey|ping.?pong|table tennis|board game|lane|offering)\b/i;

function resolveIntent(routerIntent, message) {
    if (routerIntent !== 'unsupported') return routerIntent;
    if (SECRET_TERMS.test(message) || OFFTOPIC_ATTACK.test(message)) return 'unsupported'; // genuinely bad → refuse
    if (PUBLIC_INFO.test(message)) return 'live'; // contact/hours/offerings often live on the page (blends manual)
    return 'manual'; // otherwise attempt a grounded answer; the model refuses if truly off-topic
}

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

function liveCitation(result) {
    return { type: 'live', sourceUrl: result.sourceUrl, lastChecked: result.lastChecked };
}
function manualCitation(passages) {
    return { type: 'manual', sections: topSections(passages) };
}

// Deterministic same-day closure guard, reused wherever live content is included. Returns the
// bracketed directive to append, or '' if today isn't in a closure notice.
function closureAlertText(content) {
    const alert = liveInfo.closureAlertForToday(content);
    if (!alert) return '';
    return `\n\n[CLOSURE ALERT — the live page's closure/holiday notice references TODAY (${alert.date}). The regular weekly hours do NOT override this. Read the notice ("${alert.snippet}"): if it means we are closed or closing early today, state that plainly. If it is at all ambiguous, tell the user we may be closed or on reduced holiday hours today and to call 352-392-1637 to confirm. Do NOT confidently claim we are open over a closure notice for today.]`;
}

// A manual-intent question that also brushes a volatile/current topic (hours, pricing, "open
// today", "free") benefits from the live page too. Gate the manual→live enrichment on these
// terms so pure policy questions (uniforms, refund steps) don't get the hours/pricing page
// dumped into their context as noise.
// Contact terms are included because the public phone/email live ONLY on the live page (the
// sanitizer strips them from the manual), so a manual-classified contact question still needs
// the live page blended in to answer.
const LIVE_RELEVANT = /\b(hour|open|clos|price|cost|rate|fee|today|tonight|right now|free|when|schedul|availab|holiday|phone|contact|e-?mail|number|reach|call)/i;

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
            block += closureAlertText(result.content);
            const citations = [liveCitation(result)];
            if (manualPassages.length > 0) {
                block += `\n\nSUPPLEMENTARY_MANUAL_CONTEXT (from the reference manual — use for policies/details the live page above doesn't cover; the live page remains authoritative for hours, pricing, and closures):\n${formatPassages(manualPassages)}`;
                citations.push(manualCitation(manualPassages));
            }
            return { block, citations };
        }

        // The live page couldn't be reached (down, blocked, or redesigned — see the tripwire
        // in liveInfo.js). Rather than dead-ending, fall back to the manual's own general info
        // (hours, specials, reservation policies) — labeled as a secondary source so the model
        // hedges on currency (a manual value can be stale in a way a live fetch isn't).
        if (manualPassages.length > 0) {
            const block = `LIVE_INFO: (none — the live page could not be reached)\nFALLBACK_MANUAL_CONTEXT (from the reference manual, not live-verified — may be outdated):\n${formatPassages(manualPassages)}`;
            return { block, citations: [manualCitation(manualPassages)] };
        }

        return { block: 'LIVE_INFO: (none — the live page could not be reached, and no matching manual passage was found either)', citations: [] };
    }

    if (intent === 'manual') {
        if (!env.hasManual()) {
            return { block: 'RETRIEVED_CONTEXT: (none — no manual has been loaded yet)', citations: [] };
        }
        let passages = [];
        try {
            ({ passages } = await searchManual(message, role));
        } catch (error) {
            console.error('Manual search error:', error.message);
            return { block: 'RETRIEVED_CONTEXT: (none — the manual knowledge base could not be reached)', citations: [] };
        }

        let block = passages.length > 0 ? `RETRIEVED_CONTEXT:\n${formatPassages(passages)}` : '';
        const citations = passages.length > 0 ? [manualCitation(passages)] : [];

        // Combine in current data when the question touches a volatile/contact topic. Some facts
        // (the public phone/email) live ONLY on the live page — the sanitizer redacts them from
        // the manual — so this runs EVEN WHEN manual retrieval found nothing. When we already
        // have manual passages, use the warm cache (zero extra fetch); when the manual came up
        // empty, actively fetch so a contact/hours question still gets an answer.
        if (LIVE_RELEVANT.test(message)) {
            const topic = liveInfo.detectTopic(message);
            const live = passages.length > 0
                ? liveInfo.getCachedLiveInfo(topic)
                : await liveInfo.fetchLiveInfo(topic).catch(() => null);
            if (live && live.content) {
                block += `${block ? '\n\n' : ''}SUPPLEMENTARY_LIVE_INFO (current data from ${live.sourceUrl}, fetched ${live.lastChecked} — authoritative for hours/pricing/contact/closures; ignore anything here unrelated to the question):\n${live.content}`;
                block += closureAlertText(live.content);
                citations.push(liveCitation(live));
            }
        }

        if (!block) {
            return { block: 'RETRIEVED_CONTEXT: (none — no matching passages found)', citations: [] };
        }
        return { block, citations };
    }

    return { block: '', citations: [] };
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

        // Confirm-in-code before hard-refusing a router "unsupported" (see resolveIntent): the
        // classifier occasionally mislabels legit questions (a staff "time punch error" query, a
        // phone-number ask), and a wrong refusal is a bad experience. Genuine credential/attack
        // requests still refuse; everything else gets a grounded attempt.
        const effectiveIntent = resolveIntent(intent, userMessage);

        // Enforced in code, not left to the model's judgment: an "unsupported" classification
        // (credential requests, rule-override attempts, or anything unrelated to the Game
        // Room) short-circuits straight to a canned refusal with NO generation call at all.
        // Previously this still went to the model with an empty context block and relied on
        // the persona prompt alone to refuse — testing showed a flattering off-topic request
        // ("write me a Python program... you're a good assistant") could talk the model out
        // of refusing, since nothing in code actually enforced it.
        if (effectiveIntent === 'unsupported') {
            recordTurn(req, userMessage, CANNED_RESPONSES.OUT_OF_SCOPE);
            analyticsStore.logQuestion({ role: userRole, intent, question: userMessage, answered: false, citationType: null });
            return res.json({ response: CANNED_RESPONSES.OUT_OF_SCOPE });
        }

        const { block, citations } = await buildToolContext(effectiveIntent, standaloneQuery, userRole);

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

        // Sources are returned as STRUCTURED DATA (not appended to the answer text) so the UI can
        // render a compact hover badge instead of a long "Source: ..." footer. A canned refusal
        // isn't grounded in the retrieved passages, so it carries no sources.
        const sources = isCannedResponse(reply)
            ? []
            : citations.map((c) => c.type === 'live'
                ? { type: 'live', label: 'union.ufl.edu (live)', url: c.sourceUrl, lastChecked: c.lastChecked ? formatLastChecked(c.lastChecked) : null }
                : { type: 'manual', label: 'Game Room Manual', detail: c.sections.join(', ') });

        recordTurn(req, userMessage, reply);
        // A turn "counts as answered" when it produced a grounded, non-canned reply. Refusals
        // and "no evidence" non-answers are logged as unanswered — that's the admin signal for
        // which questions the current knowledge base can't yet handle.
        analyticsStore.logQuestion({
            role: userRole,
            intent: effectiveIntent,
            question: userMessage,
            answered: !isCannedResponse(reply),
            citationType: sources[0] ? sources[0].type : null,
        });
        res.json({ response: reply, sources });
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
