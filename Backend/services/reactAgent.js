// ReACT (Reasoning + Acting) retrieval planner.
//
// Instead of a single-shot retrieval (services → buildToolContext), this runs a bounded
// Thought → Action → Observation loop: the model reasons about what it still needs, picks ONE
// tool, we execute it, feed the result back, and repeat until it decides it has enough (or a step
// cap is hit). The gathered context is then handed to the SAME guarded, streamed generation that
// already exists — this module only decides WHAT to retrieve, never writes the final answer.
//
// Safety is preserved by construction, consistent with this codebase's "control flow stays in
// code" philosophy (see CLAUDE.md):
//   - The model only SUGGESTS an action as JSON; our code decides whether/how to run it. There is
//     no native tool-calling and no arbitrary code/tool access.
//   - The only tools are read-only: role-scoped manual search and the allowlisted live-page fetch.
//     `search_manual` passes the session role straight through, so the agent can never retrieve a
//     chunk the user isn't cleared for — the exact same boundary the single-shot path enforces.
//   - The loop is hard-bounded (REACT_MAX_STEPS), so it always terminates.
//   - The closure fail-safe directive is re-attached to live results, same as buildToolContext.
//   - The final answer still flows through outputGuard + canned-response detection downstream.

const navigator = require('../lib/navigatorClient');
const { searchManual } = require('./searchManual');
const liveInfo = require('./liveInfo');
const env = require('../config/env');

const MAX_STEPS = Math.max(1, parseInt(process.env.REACT_MAX_STEPS || '4', 10));
const PASSAGES_PER_SEARCH = 4;

// Contact/volatile-topic questions (phone, hours, pricing, "is it open") need the live page even
// when the router calls them "manual" — the public phone/email are redacted from the manual, so
// they live ONLY on the live page. buildToolContext blends live in deterministically for these;
// the seed does the same so the ReACT planner isn't relied on to remember to fetch it (that
// reliance regressed phone-number answers in testing). Mirrors LIVE_RELEVANT in routes/chat.js.
const LIVE_RELEVANT = /\b(hour|open|clos|price|cost|rate|fee|today|tonight|right now|free|when|schedul|availab|holiday|phone|contact|e-?mail|number|reach|call)/i;

const PLANNER_SYSTEM = `You are the retrieval planner for the University of Florida Reitz Union Game Room assistant. Your job is to gather the information needed to answer the user's latest message, one step at a time, using tools. You do NOT write the final answer; a separate step does that from what you gather.

Reply with EXACTLY ONE minified JSON object and nothing else, choosing one action:
- {"thought":"<what is still missing>","action":"search_manual","query":"<self-contained thing to look up in the Game Room manual: policies, rules, procedures, how-tos, prices, staff operations>"}
- {"thought":"<why live data is needed>","action":"live_info","query":"<current hours / closures / today's availability to fetch from the live union.ufl.edu page>"}
- {"thought":"<why you have enough>","action":"finish"}

Rules:
- First resolve any follow-up/pronoun into a standalone query (e.g. "is it free?" after foosball -> "is foosball free").
- Use search_manual for the manual; use live_info only for volatile facts (current hours, closures, "open right now").
- You may search more than once with refined queries if the first result is thin or the question has multiple parts.
- Choose "finish" as soon as the observations cover the question, or immediately if it's small talk that needs no lookup. Never pad with extra steps.`;

function parseAction(raw) {
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        if (obj && typeof obj.action === 'string') return obj;
    } catch (_) { /* fall through */ }
    return null;
}

function closureAlertText(content) {
    const alert = liveInfo.closureAlertForToday(content);
    if (!alert) return '';
    return `\n\n[CLOSURE ALERT — the live page's closure/holiday notice references TODAY (${alert.date}). The regular weekly hours do NOT override this. Read the notice ("${alert.snippet}"): if it means we are closed or closing early today, state that plainly. If it is at all ambiguous, tell the user we may be closed or on reduced holiday hours today and to call 352-392-1637 to confirm. Do NOT confidently claim we are open over a closure notice for today.]`;
}

// Runs the ReACT loop and returns { block, citations, trace } in the SAME shape buildToolContext
// produces, so answerAndStream is a drop-in swap. `trace` is the step log (for debugging/analytics;
// never shown to the user).
async function planContext({ message, standaloneQuery, history = [], role = 'public', intent = 'manual' }) {
    const historyText = history.map((h) => `${h.role}: ${h.content}`).join('\n') || '(none)';
    const trace = [];
    const manualPassages = [];
    let liveResult = null;

    async function doManualSearch(query) {
        let passages = [];
        try {
            ({ passages } = await searchManual(query, role)); // ROLE-SCOPED — never leaks a higher tier
        } catch (_) { passages = []; }
        passages = (passages || []).slice(0, PASSAGES_PER_SEARCH);
        for (const p of passages) manualPassages.push(p);
        return passages.length
            ? passages.map((p) => `[Section: ${p.section}] ${p.text}`).join('\n')
            : 'No matching manual content for that query.';
    }
    async function doLive(query) {
        try {
            liveResult = await liveInfo.fetchLiveInfo(liveInfo.detectTopic(query)) || liveResult;
        } catch (_) { /* keep any earlier liveResult */ }
        return liveResult && liveResult.content
            ? `LIVE (${liveResult.sourceUrl}, fetched ${liveResult.lastChecked}): ${liveResult.content.slice(0, 1200)}`
            : 'The live page could not be reached.';
    }

    // Step 0 (SEED): anchor the first retrieval on the router's standalone rewrite, which already
    // resolves pronouns/ellipsis with tuned few-shot examples (e.g. "is it free?" -> "is foosball
    // free"). The weaker planner model re-deriving that query was regressing follow-ups, so we do
    // it deterministically and let the ReACT loop below only ADD refinement/extra-part searches.
    const seedQuery = standaloneQuery || message;
    const seedObs = await doManualSearch(seedQuery);
    trace.push({ render: `Thought: (seed) resolve the question and look it up in the manual.\nAction: search_manual(${seedQuery})\nObservation: ${seedObs.slice(0, 600)}` });
    if (intent === 'live' || LIVE_RELEVANT.test(message) || LIVE_RELEVANT.test(seedQuery)) {
        const liveObs = await doLive(seedQuery);
        trace.push({ render: `Action: live_info(${seedQuery})\nObservation: ${liveObs.slice(0, 600)}` });
    }

    for (let step = 1; step < MAX_STEPS; step++) {
        const planMessages = [
            { role: 'system', content: PLANNER_SYSTEM },
            {
                role: 'user',
                content: `Recent conversation:\n${historyText}\n\nUser's latest message: ${message}\nStandalone rewrite (hint): ${standaloneQuery || message}\nInitial intent guess: ${intent}\n\nSteps taken so far:\n${trace.length ? trace.map((t) => t.render).join('\n\n') : '(none yet)'}\n\nRespond with the next action as one JSON object.`,
            },
        ];

        let raw;
        try {
            raw = await navigator.chatComplete(planMessages, { temperature: 0, model: env.ROUTER_MODEL });
        } catch (err) {
            // Planner call failed — stop and answer from whatever we've gathered so far.
            trace.push({ render: `Thought: (planner error: ${err.message}) — stopping.` });
            break;
        }

        const action = parseAction(raw);
        // Malformed or explicit finish → stop. A malformed first step still leaves us able to fall
        // back below (empty gathered context) rather than crashing the turn.
        if (!action || action.action === 'finish') break;

        const query = String(action.query || standaloneQuery || message).slice(0, 300);
        let observation;

        if (action.action === 'search_manual') {
            observation = await doManualSearch(query);
        } else if (action.action === 'live_info') {
            observation = await doLive(query);
        } else {
            break; // unknown action — stop rather than guess
        }

        trace.push({ render: `Thought: ${action.thought || ''}\nAction: ${action.action}(${query})\nObservation: ${observation.slice(0, 600)}` });
    }

    // Assemble the gathered context into the block + citations shape answerAndStream expects.
    const parts = [];
    const citations = [];

    const uniqueByText = [];
    const seenText = new Set();
    for (const p of manualPassages) {
        if (!seenText.has(p.text)) { seenText.add(p.text); uniqueByText.push(p); }
    }
    if (uniqueByText.length) {
        parts.push(`RETRIEVED_CONTEXT:\n${uniqueByText.map((p) => `[Section: ${p.section}]\n${p.text}`).join('\n\n')}`);
        const sections = [...new Set(uniqueByText.map((p) => p.section))].slice(0, 3);
        citations.push({ type: 'manual', sections });
    }
    if (liveResult && liveResult.content) {
        let block = `LIVE_INFO (current data from ${liveResult.sourceUrl}, fetched ${liveResult.lastChecked} — authoritative for hours/pricing/contact/closures; ignore anything unrelated to the question):\n${liveResult.content}`;
        block += closureAlertText(liveResult.content);
        parts.push(block);
        citations.push({ type: 'live', sourceUrl: liveResult.sourceUrl, lastChecked: liveResult.lastChecked });
    }

    const block = parts.length ? parts.join('\n\n') : 'RETRIEVED_CONTEXT: (none found)';
    return { block, citations, trace: trace.map((t) => t.render) };
}

module.exports = { planContext, MAX_STEPS };
