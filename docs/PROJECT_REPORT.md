# Project Report — Gator Game Room Assistant

| | |
|---|---|
| **Project** | Agentic RAG Chatbot for UF Reitz Union Game Room & Gator Esports Center |
| **Repository layout** | `frontend/` (client), `Backend/` (Node/Express server), `chroma_data/` + `.venv-chroma/` (vector DB infra, project root), `docs/` (this report + architecture) |
| **Status** | Functionally complete for v1 scope. Real (draft) manual content ingested and verified sanitized. Pending: final manual version, production deployment target |
| **Document type** | Engineering handoff / status report |

---

## 1. Executive summary

The Game Room's existing chatbot was a single-file Express prototype: one flat-file vector
store, one hardcoded model, no authentication, no role separation, and no safety layer
beyond a system-prompt instruction. It was rebuilt into a role-aware, multi-source agentic
RAG application per the project brief, with all generation and embedding running exclusively
against UF's locally-hosted Navigator models — no manual content, credential, or PII ever
reaches a third-party model.

The build was done in five milestones (scaffolding → auth → router/live-data →
manual RAG → documentation), each followed by hands-on testing rather than assumed-correct
delivery. That testing surfaced and fixed several defects that unit-level review would not
have caught — most notably a genuine hallucination failure mode where the model blended its
own training knowledge about this real, publicly-documented facility into an otherwise
"grounded" answer. Section 7 documents each finding with the failing input, root cause, and
fix.

A later enhancement pass (M8) built on that base: multi-turn conversation memory, hybrid
(vector + BM25) retrieval, a real four-tier access model with a working supervisor tier, an
admin self-improvement surface (edit manual / re-ingest / view question logs), analytics and
feedback logging, chat rate-limiting, and a 50-question evaluation harness. A break-and-fix
loop over that harness took answer quality from 43/50 to a stable 50/50 (two consecutive
runs), with the automated unit suite growing to 127 tests. A later robustness pass (M9) added
same-day closure handling, source-combination, router-reliability hardening, and a hostile-input
stress suite. See M8/M9 and Section 9/10.

A final quality pass (M10) was driven by a **persona stress harness** — five distinct "human"
personas (a casual freshman, a formal visiting parent, an ESL speaker, a staff member, an
adversarial probe) asking ~125 human-phrased questions per run across multi-turn sessions, each
question tagged with the behavior it should get so real defects separate from correct refusals.
Iterating against it took a multi-turn context-loss bug, off-topic leaks, and holiday-hours
dead-ends to a stable 125/125, and — most importantly — surfaced a **silent session-memory bug
the harness's own scoring had been masking**: anonymous visitors never received a session cookie
on the streamed chat path, so multi-turn memory only actually worked for logged-in users. That
pass also added contextual-retrieval chunking and an opt-in ReACT retrieval planner. The unit
suite grew to 165 tests. See M10, defects 15–16, and Section 9/10.

---

## 2. Objectives and scope

### In scope (delivered)
- Local-only inference: `gpt-oss-120b` (chat), `llama-3.1-8b-instruct` (routing),
  and `nomic-embed-text-v1.5` (embeddings) via the UF Navigator OpenAI-compatible API.
- A code-driven intent router (`manual` / `live` / `casual` / `unsupported`) — not native
  model tool-calling — so every safety check sits in auditable application code.
- Manual-grounded Q&A via ChromaDB, with precomputed embeddings and role-filtered retrieval.
- Live-data Q&A (hours, pricing, closures) from an allowlist of exactly two official pages,
  with source citation and a freshness timestamp.
- Four-tier access model (`public` / `staff` / `supervisor` / `admin`), with password-gated
  staff and admin entry points, independent rotatable credentials, and rate-limited login.
- A defense-in-depth safety stack: ingestion-time redaction, server-side role re-verification,
  prompt-level grounding discipline, and a final regex output guard on every response.
- A restructured `frontend/` / `Backend/` repository layout with all internal references
  rewired and re-verified.

### Out of scope (explicitly deferred — see Section 9)
- The real operations manual (not provided; a sample manual was authored solely to exercise
  the pipeline end-to-end).
- Formal evaluation Q&A set (30–50 questions + adversarial cases) — flagged as a `TODO` in
  the README per the original brief.
- Production deployment target and expected load — session store and Chroma topology depend
  on this.

---

## 3. System architecture

Full diagrams (system context, request sequence, ingestion pipeline) are in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md). Summary:

- **Client** (`frontend/`): static HTML/CSS/vanilla JS, no build step, no framework.
- **Server** (`Backend/`): Express 5 app. `routes/` is the HTTP boundary; `services/` holds
  all business logic; `lib/` wraps the two external dependencies (Navigator SDK, prompt
  templates); `middleware/` enforces role checks; `scripts/ingest.js` is an offline job, not
  part of the request path.
- **Vector store**: ChromaDB, run as an independent process (Python, via `chroma run` or
  Docker), storing precomputed vectors only — it never computes embeddings itself.
- **External services**: UF Navigator API (all generation/embeddings) and two allowlisted
  `union.ufl.edu` pages (live data only). No other outbound calls exist in the codebase.

---

## 4. Technology stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 18.19.1 | See Section 6 for a version-compatibility issue this caused |
| Web framework | Express 5.2 | |
| LLM SDK | `openai` npm package v6, pointed at Navigator's OpenAI-compatible base URL | |
| Vector DB | ChromaDB (Python package, run as a separate server) via `chromadb` npm client v1.10.5 | |
| HTML parsing (live-data extraction) | `cheerio` v1.0.0-rc.12 | |
| Auth | `bcryptjs`, `express-session`, `express-rate-limit` | |
| Session storage | `session-file-store` | File-backed (`Backend/private/sessions/`), added post-handoff to replace `express-session`'s in-memory default — see Section 5, M7 |
| Testing | Node's built-in `node:test` + `supertest` | Added post-handoff — see Section 5, M7 |
| Frontend | Vanilla HTML/CSS/JS | No build tooling — intentional, matches project scale |

---

## 5. Delivery timeline (milestones)

| # | Milestone | Key deliverables |
|---|---|---|
| M1 | Scaffolding & Navigator client | `config/env.js`, `lib/navigatorClient.js`, dependency resolution for the Node 18 environment, removal of the legacy flat-file vector store |
| M2 | Auth & sessions | `services/authStore.js`, `routes/auth.js`, rate-limited login, independent staff/admin bcrypt secrets, `staff.html`/`admin.html` |
| M3 | Router + live data | `services/router.js`, `services/liveInfo.js`, persona prompt, output guard, citation footer |
| M4 | Chroma + manual RAG | `services/chromaClient.js`, `services/sanitizer.js`, `scripts/ingest.js`, `services/searchManual.js` |
| M5 | Documentation | `README.md`, `SECURITY.md`, this report, architecture diagrams |
| — | Repository restructure | Split into `frontend/`/`Backend/`, all path references rewired, re-verified end-to-end |
| M6 | Real manual integration | Sanitizer hardening (email/`pw`/account-number patterns), heading-detection fix, hand-curated `manual_clean.txt` from the real source PDF, full re-ingestion, live-info time-awareness fix |
| M7 | Automated regression suite + persistent sessions | `Backend/test/` (`node:test`/`supertest` tests covering sanitizer, output guard, ingestion parsing, tier middleware, auth flow, chat input validation), `scripts/ingest.js` refactored to export its pure functions for testing, `session-file-store` replacing `express-session`'s in-memory default |
| M8 | Enhancement pass (post-handoff) | Conversation memory (session-backed) + combined classify/rewrite router; hybrid vector+BM25 retrieval (`services/keywordIndex.js`) with RRF fusion, chunk overlap, trimmed citations, live+manual blending; real supervisor tier (`[SUPERVISOR]` content, login) making access four-level; admin content/log APIs (`routes/admin.js`) + `frontend/admin-content.html`; analytics/feedback logging (`services/analyticsStore.js`); `/api/chat` rate-limiting + tiered output guard; disk-durable live cache; 50-question eval harness (`Backend/eval/`, `scripts/eval.js`). Unit suite grew to 91 tests; eval bar reached a stable 50/50 |
| M9 | Robustness pass (live-bug + stress driven) | Same-day closure/holiday guard (`liveInfo.closureAlertForToday` + prompt rules; fixes a confidently-wrong "we're open" on a closure day); structured sources returned to the client and rendered as a hover badge instead of a long footer; bidirectional live+manual combination (manual answers enriched with current data, incl. the phone number the sanitizer redacts from the manual); router reliability hardening (`resolveIntent` confirm-bad-before-refuse + few-shot examples, so the LLM router no longer hard-refuses legit questions it mislabels); stronger clock anchoring; non-string `message` rejected with 400 (found by the new stress suite). Added `test/edgecases.test.js` (33 hostile/degenerate cases) and `scripts/complex-probe.js`; unit suite now 127 tests, eval stable 50/50 |
| M10 | Quality pass (persona-stress driven) | Five-persona stress harness (~125 tagged, human-phrased, multi-turn questions/run) used as the break-and-fix loop. Fixes: **anonymous session memory on the streamed chat path** (express-session's cookie was never sent on turn 1 — see defect 15); **multi-turn elliptical context loss** ("is it free?" now resolves to the prior topic in both retrieval and the answer — defect 16); a hard STAY-IN-SCOPE persona rule (off-topic trivia declined even for staff); specific-day/holiday hours give day-of-week hours + a call-to-confirm caveat instead of "no information"; deterministic staff credential-location pointer (#14) and reservation-FAQ/phone fallbacks (#4, #8). Enhancements: **contextual-retrieval chunking** (`CONTEXTUAL_CHUNKING`, per-chunk LLM context sentence before embedding) and an **opt-in bounded ReACT retrieval planner** (`services/reactAgent.js`, `REACT_MODE`, off by default — single-shot scored higher on the harness). Reservation flow hardened (lane auto-calc, org-name auto-skip, verified Qualtrics/Google Forms submission). Stress harness reached a stable 125/125; unit suite grew to 165 tests, eval stable 50/50 |

M3 was pulled ahead of M2 mid-project after user testing surfaced hallucinated live-data
answers — the fix (real tool grounding) was prioritized over sequencing purity. M6 happened
opportunistically when the real manual PDF was dropped into `Backend/private/` mid-session
rather than at the originally planned time. M7 was requested directly against two items this
report had previously flagged as open (Section 9): no test suite, and a session store that
doesn't survive a restart.

### M6 detail: real manual integration

The source was an 8-page PDF (`Game Room Operation Manual DRAFT.pdf`), extracted with
`pdftotext`. It contained genuinely live-sensitive data: a real POS temp password, personal
staff cell numbers and emails, and real PCI merchant/account/terminal numbers — none of which
the sanitizer at the time could fully catch (no email pattern existed at all; `PW:` didn't
match `password|passwd|pwd`; 10-12 digit account numbers didn't match the 13-16 digit
credit-card pattern or a phone pattern). Rather than run the existing generic
heading-heuristic ingestion pipeline against a document this sensitive, the manual was
hand-reorganized into 31 clearly-labeled sections with explicit `[PUBLIC]`/`[STAFF]` markers,
sourced from a full read-through of the extracted text — a deliberate choice to not trust
automatic classification on a document where a misclassification could expose real internal
security/financial procedures. The automated sanitizer improvements (see Section 7, defects
11-13) still run as defense-in-depth on top of that manual curation.

Post-ingestion, every one of the 48 stored chunks was scanned for credential/PII patterns as
a verification step (not just trusted from the ingest log) — zero hits, with explicit
spot-checks confirming the specific known-sensitive strings (temp password, emails, account
numbers, a personal cell number) did not make it into the vector store.

---

## 6. Notable engineering decisions

- **Dependency pinning for Node 18 compatibility.** The latest `chromadb` and `cheerio`
  majors require Node 20+ and fail at import time on Node 18 (`cheerio@1.1.0+` pulls in
  `undici@7`, which references a browser-only `File` global). Verified this would crash
  before committing to it, then pinned `chromadb@1.10.5` / `cheerio@1.0.0-rc.12` and
  confirmed both load and function correctly.
- **Router implemented in application code, not native tool-calling.** One classification
  call decides the path in plain JavaScript, so every downstream safety check is testable
  and independent of a model's own tool-choice behavior.
- **Sanitize at ingestion, not just at output.** Credentials/access-codes/phone numbers are
  stripped from the manual *before* chunking or embedding, so they cannot be retrieved even
  by an authenticated `staff` session — this is stronger than relying solely on the output
  guard.
- **Independent staff/admin credentials.** The brief only specified one shared secret; after
  flagging the tradeoff, the decision was made to give admin its own rotatable password
  rather than reusing the staff one, at the cost of one extra field in `private/auth.json`.
- **No CORS.** Frontend and API are same-origin by construction; enabling CORS would only
  widen the attack surface now that session cookies are involved.
- **Full re-embed on every ingestion run, not incremental caching.** Chunk boundaries shift
  whenever the source text changes (inserting one sentence can shift every chunk after it),
  so "did this chunk change" isn't a safe question to answer by content-matching against a
  previous run. A full delete-and-recreate is also safer against a crash mid-run — the old
  collection stays intact until the new one is fully built. At the current manual size
  (48 chunks), the cost of re-embedding everything is a few seconds; this tradeoff should be
  revisited if the manual grows to hundreds of pages or is re-ingested on a tight schedule.
- **Contextual retrieval at ingest, not query time (M10).** Each chunk gets a short
  LLM-generated context sentence prepended before embedding/BM25 indexing (Anthropic's
  "Contextual Retrieval"), so terse or slide-derived chunks and elliptical follow-ups retrieve
  reliably. The cost is one extra Navigator call *per chunk* at ingest — acceptable at the
  current ~48-chunk scale and paid only when the manual changes, not per request. It's gated by
  `CONTEXTUAL_CHUNKING` (default on) with a raw-chunk fallback both per-chunk (on generation
  failure) and globally (the flag), so it can never harden into a single point of ingest failure.
- **ReACT planner kept opt-in, chosen by measurement, not intuition (M10).** A bounded ReACT
  retrieval loop was built and A/B'd against the tuned single-shot path on the persona stress
  harness; single-shot scored higher (the weaker planner regressed multi-turn scoping and some
  phone/live lookups), so it remains the default and ReACT ships behind `REACT_MODE` for future
  re-evaluation rather than being discarded.
- **Cheerio over Playwright for live-data fetching.** Verified early on (plain `curl`) that
  both allowlisted union.ufl.edu pages are fully server-rendered — the hours/pricing/closure
  text is present in the raw HTML with no client-side JavaScript required to produce it. A
  headless browser would add real overhead (process startup, memory, rendering time) for zero
  functional benefit here. `services/liveInfo.js` now has a content-length tripwire that logs
  a warning if extraction ever returns suspiciously little text, which would be the signal
  that this assumption has stopped holding (e.g. after a site redesign) and Playwright should
  be reconsidered.

---

## 7. Testing & defect log

Testing was performed in two passes: an API-level pass (curl-driven, covering error handling,
auth flows, and all four router intents) and a browser-driven pass using a `playwright-core`
script against the actual running app (headless Chrome, real clicks/typing, screenshots),
since the environment's preferred browser-automation tool wasn't available. A later pass (M10)
added a **five-persona stress harness** — scripted, human-phrased, multi-turn conversations with
per-question expected-behavior tags, run repeatedly against the live server — which drove
defects 15–16 and confirmed a stable 125/125. Every defect below was found by actually exercising
the running app, not by code inspection alone; defect 15 is a cautionary case where the harness's
own coarse scoring initially *hid* the bug until a targeted cookie/multi-turn check exposed it.

| # | Defect | How it was found | Fix |
|---|---|---|---|
| 1 | **Hallucination**: asked "can I play Valorant," got a confident wrong-ish answer with invented details | Manual conversation testing | Persona prompt now explicitly instructs the model to ignore its own background knowledge about this real, publicly-documented facility and treat only the current turn's retrieved context as truth |
| 2 | **Live-data extraction returned near-empty content** | Direct inspection of extracted text | The site's theme wraps the *entire* page (not just nav) in a `<header>` tag; stripping it during "cleanup" deleted 99.8% of the content. Removed `<header>` from the strip list |
| 3 | **Sanitizer missed natural-language phrasing** ("the alarm code is 4471" wasn't redacted, only `code: 4471` was) | Direct regex testing against sample sensitive content | Added natural-phrasing patterns requiring a digit/symbol in the value, to catch real secrets without flagging plain sentences |
| 4 | **Citation footer appended after a refusal** ("that's internal info… Source: [4 sections]") | Manual conversation testing | Canned refusals are now detected and suppress the citation footer |
| 5 | **Unhandled crash + stack-trace leak** on requests with no `Content-Type` header or malformed JSON | Deliberate malformed-input testing | Centralized JSON error handler; `req.body` defensively defaulted |
| 6 | **No cap on message length** — a 50KB message was silently forwarded to the LLM | Deliberate oversized-input testing | 1,500-char application limit + 20KB body-size limit |
| 7 | **No request timeouts** on Navigator or live-page fetches | Code review during QA pass | 30s timeout (Navigator SDK), 10s timeout (`AbortSignal.timeout` on live fetch) |
| 8 | **Open CORS** on a session-cookie-bearing, same-origin-only app | Code review during QA pass | Removed — unnecessary attack surface |
| 9 | **Chroma vector-count assumption unverified** | User explicitly asked to confirm the DB held real data | Queried the live collection directly (`.get()`), confirmed 9 vectors with correct section/access-level metadata, not just trusted the ingest log |
| 10 | **Port conflict during dev testing**: an unrelated ambient service in this sandbox environment repeatedly claimed port 8000 and killed the Chroma process mid-test | Chroma became unreachable mid-ingestion | Moved dev Chroma instance to port 8055; documented the fallback in the README |
| 11 | **Sanitizer had no email pattern at all**, and `PW: Bowling100!` didn't match the password pattern (only `password/passwd/pwd`, not `pw`) | Direct regex testing against the real manual's extracted text | Added an email pattern; added `pw` as a recognized password-label alias |
| 12 | **Account/merchant/terminal numbers (10-12 digits) weren't redacted** — too short for the credit-card pattern (13-16 digits), too long/oddly-punctuated for the phone pattern | Direct testing: `Account: # 120615366781` survived sanitization | Added a labeled account-number pattern; had to fix its separator matching twice (single-char `[:#]` didn't handle `": #"`, then bounded the whitespace span to avoid a runaway match) |
| 13 | **Heading-detection fragmented a real procedure**: a numbered step ("3. Message team members individually.") inside SHIFT COVERAGE PROCEDURE was detected as its own section heading and **auto-tagged `public`** | Inspecting the ingested collection's section list — found 33 sections instead of the intended 31 | Removed numbered-line heading detection entirely (Markdown/ALL-CAPS only); re-ingested; verified exactly 31 sections with correct tagging |
| 14 | **"Is it open right now" answers were inconsistent** — the model only had the current *date* in context, not the time, so it sometimes hedged even with correct hours available | Repeated manual testing of the same query | Pass full date+time (`dateStyle: 'full', timeStyle: 'short'`) instead of date-only; caught and fixed an `Intl.DateTimeFormat` option-conflict crash (`weekday` can't be combined with `dateStyle`) during this same change, before it shipped |
| 15 | **Anonymous visitors got no session cookie on the streamed chat path** — every message from a not-logged-in user started a fresh, memory-less session, so multi-turn memory silently only worked for logged-in users | Persona stress harness + a direct cookie/multi-turn check ("do you have foosball?" → "is it free?" returned a generic "it depends" instead of a foosball answer). The harness had *masked* it: its pass/fail classifier scores any substantive reply as PASS, so the amnesiac answer still "passed" | Root cause: express-session emits `Set-Cookie` via an `on-headers` hook that fires at `startStream()`'s `res.writeHead()` — before `recordTurn()` first mutates the session — and with `saveUninitialized:false` an untouched new session is treated as empty, so no cookie is sent (logged-in users were spared because the non-streamed `/api/auth/*-login` already set it). Fix: touch `req.session` (init `history`) at the top of `POST /api/chat`, before any `startStream()`, so the cookie ships on turn 1. Verified the foosball follow-up now answers "Yes, foosball is free" |
| 16 | **Multi-turn elliptical follow-ups lost context** — after "do you have foosball?", "is it free?" was answered as a bare pronoun (or classified as casual), losing the antecedent | Persona stress harness (issue #6), consistently on the "is it free?" turn | Two-part fix: (a) the router now classifies short elliptical follow-ups as *factual* and rewrites them into a standalone query by the resolved topic ("is foosball free"), steering retrieval; (b) `routes/chat.js` injects a one-line system hint with that resolved query immediately before the user's message, so the model answers the intended question rather than the raw pronoun. Both are needed — the rewrite fixes what's fetched, the hint fixes what's answered |

**Post-restructure regression**: after splitting into `frontend/`/`Backend/`, the full
browser-driven test suite (5-question conversation, staff login + role banner, staff-only
manual answer, admin panel) was re-run and produced identical results with **zero console
errors** — an improvement over the pre-restructure run, which had one benign favicon 404
(fixed by adding an explicit `<link rel="icon">`).

**Post-real-manual regression**: after replacing the sample manual with the real (draft)
one, public/staff access was re-tested against real content, including two adversarial edge
cases: a public request for the POS password (correctly restricted — the value never entered
the vector store) and a **staff-authenticated** request for the internal emergency codeword
(correctly restricted by the persona prompt's security-procedure rule, despite staff having a
legitimate operational reason to know it exists — the chatbot is deliberately not the channel
that repeats it).

---

## 8. Security posture

Full detail in [`SECURITY.md`](../SECURITY.md). Highlights relevant to a handoff review:

- No secret (API key, session secret, passwords) is ever hardcoded; all live in `Backend/.env`
  or `Backend/private/`, both git-ignored and confirmed absent from `git status` output.
- Role is derived exclusively from the server-side session; `services/searchManual.js`
  re-verifies the access-level filter in code after every Chroma query rather than trusting
  the database filter alone.
- Every chat response, regardless of source, passes through `services/outputGuard.js` before
  reaching the client. It's tiered (M8): genuine credential/PII shapes discard the whole
  response; broad, lower-severity labeled numbers are masked inline; credit-card detection is
  Luhn-gated.
- Login is rate-limited to 5 attempts/minute/IP on the staff, supervisor, and admin endpoints
  (verified: 6th rapid attempt returns `429`). `/api/chat` is separately rate-limited (M8) to
  cap Navigator cost and abuse.

---

## 9. Known limitations / technical debt

- Sessions are now file-backed (`session-file-store`, M7) and survive a restart, but still
  don't scale across multiple concurrent processes — fine for single-instance use, would need
  a shared store (e.g. Redis via `connect-redis`) for a multi-instance production deployment.
- `RELEVANCE_THRESHOLD` is calibrated against the current 48-chunk manual; re-tune if
  retrieval quality seems off as the manual grows or is replaced with a final version.
- The manual currently ingested is a **draft** ("Game Room Operation Manual DRAFT.pdf"),
  hand-transcribed and reorganized into 31 tagged sections — functionally real, but not
  necessarily the final version. Re-run `npm run ingest` after replacing
  `Backend/private/manual_clean.txt` when a final version is available.
- Section heading detection only recognizes Markdown/ALL-CAPS conventions (see Section 7,
  defect 13) — a manual using a different heading style will need explicit `[PUBLIC]`/
  `[STAFF]`/`[SUPERVISOR]` markers added by hand, or it will fall into one large `General`
  section.
- The automated regression suite (`Backend/test/`, now 165 tests, incl. a hostile-input
  `edgecases.test.js`) covers deterministic
  application logic. The LLM-answer-quality evaluation set now also exists (M8,
  `Backend/eval/`, `npm run eval`, 50 graded questions) and currently passes 50/50; the M10
  persona stress harness adds a second live-server signal (~125 tagged multi-turn questions,
  stable 125/125) — but both run against real, non-deterministic model calls, so treat them as
  regression signals, not a proof of perfection. Note the harness's coarse pass/fail scoring can
  mask a bug that still produces a plausible-looking answer (see defect 15), so pair it with
  targeted checks for anything session- or memory-related.
- `staff`, `supervisor`, and `admin` seed to the default `0000` password for handoff
  convenience — must be rotated via the admin panel before any real use. The server now logs a
  loud startup warning while any role is still on the default.
- The `[SUPERVISOR]` content tags live in the git-ignored private manual, not in the repo — a
  fresh clone will have code that *supports* the tier but a manual without the tags until they
  are re-applied and `npm run ingest` is re-run.
- Ingestion does a full re-embed of every chunk on every run rather than caching unchanged
  chunks — a deliberate simplicity/safety tradeoff (see Section 6) that's fine at the current
  manual size but worth revisiting if the manual grows substantially or is re-ingested
  frequently.
- The BM25 keyword index and the analytics/feedback logs are single-instance (in-process index
  cache with a short TTL; append-only JSONL files) — fine at current scale, would need a shared
  index/datastore for a multi-instance deployment.

---

## 10. Recommendations / next steps

1. Rotate the `staff`, `supervisor`, and `admin` default passwords immediately after handoff
   (the startup warning flags any still on `0000`).
2. Before any *multi-instance* production deployment: replace the file-backed session store
   with a shared one (e.g. Redis-backed via `connect-redis`); move the BM25 index and
   analytics logs to a shared store; and confirm the Chroma deployment topology (single
   instance is fine for expected small-scale internal use; revisit if usage grows).
   Single-instance restarts are already handled (M7).
3. Use the admin surface (M8) as the ongoing improvement loop: watch `GET /api/admin/logs`
   for unanswered questions, fill those gaps in the manual via `PUT /api/admin/manual`, then
   `POST /api/admin/reingest`. Add the recurring misses as new cases in `Backend/eval/`.
4. Wire the (already-built) `POST /api/chat/feedback` endpoint to 👍/👎 buttons in the chat UI
   — the only remaining piece of the analytics loop, deliberately left as UI work.
5. When the final (non-draft) manual is available, replace `Backend/private/manual_clean.txt`,
   re-apply the `[PUBLIC]`/`[STAFF]`/`[SUPERVISOR]` tags, and re-run `npm run ingest` — nothing
   else needs to change.
