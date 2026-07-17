# Gator Game Room Assistant 🐊

An agentic RAG chatbot for the University of Florida Reitz Union Game Room and Gator
Esports Center. It answers visitor and staff questions by routing each message to one of
three grounded sources — an internal operations manual (ChromaDB), the official UF Union
pages (live fetch), or a plain conversational reply — and never guesses at facts it
can't verify.

---

## Architecture at a glance

- **Models — UF Navigator only.** Generation uses `gpt-oss-120b`; routing uses
  `llama-3.1-8b-instruct` (much faster for the classification step); embeddings use
  `nomic-embed-text-v1.5`. All are called through the `openai` npm SDK pointed at
  `https://api.ai.it.ufl.edu/v1`. Manual content is never sent to any other model or provider.
- **Router — code, not native tool-calling.** `services/router.js` classifies each message
  into `manual` / `live` / `casual` / `unsupported` with one Navigator call using the fast
  `llama-3.1-8b-instruct` model, and `routes/chat.js` decides what to fetch based on that
  label. This keeps control flow (and the safety checks around it) in our code rather than
  trusting a model's own tool-choice.
- **Manual RAG — ChromaDB, self-hosted, precomputed embeddings.** The manual is chunked and
  embedded by `scripts/ingest.js` and stored in a Chroma collection with **no embedding
  function** — Chroma never computes its own vectors, only stores/searches ones we hand it.
- **Live data — an allowlist of two URLs only**, fetched and cached in memory
  (`services/liveInfo.js`), never anything else.
- **Safety is layered, not a single check**: ingestion-time redaction → role-filtered
  retrieval (re-enforced server-side, not just via the DB filter) → a system prompt that
  refuses to use outside/pretrained knowledge → a final regex output guard that runs on
  every response regardless of what the model produced.

```
project-root/
├── frontend/                    static site + chat UI, served by Express as static files
│   ├── index.html                landing page (Customer / Staff / Admin entry links)
│   ├── staff.html, admin.html    password-gated entry pages
│   ├── admin-content.html         admin: edit manual, re-ingest, view question/feedback logs
│   ├── app.js                     chat widget logic + safe markdown rendering
│   └── styles.css
├── Backend/                     Node/Express app — everything server-side
│   ├── server.js                  bootstrap: sessions, static serving, routes, error handling
│   ├── config/env.js              central env reading (API key present?, manual present?, ports, thresholds)
│   ├── lib/navigatorClient.js     openai SDK wrapper — chat + embeddings against Navigator
│   ├── lib/personaPrompt.js       the assistant's system prompt + canned refusal strings
│   ├── services/router.js         combined intent classification + follow-up query rewrite
│   ├── services/liveInfo.js       allowlisted page fetch + disk-durable cache + text extraction
│   ├── services/chromaClient.js   Chroma collection access (+ getAllRecords for the BM25 corpus)
│   ├── services/keywordIndex.js   in-process BM25 index, fused with vector search
│   ├── services/sanitizer.js      ingestion-time credential/PII redaction
│   ├── services/searchManual.js   role-filtered HYBRID (vector + BM25) search over the manual
│   ├── services/outputGuard.js    tiered regex safety net on every chat response
│   ├── services/analyticsStore.js append-only question + feedback logs
│   ├── services/authStore.js      bcrypt-hashed staff/supervisor/admin password storage
│   ├── routes/chat.js             orchestrates router → tool → prompt → guard → response; memory; feedback
│   ├── routes/auth.js             staff/supervisor/admin login, logout, password rotation, session
│   ├── routes/admin.js            admin-gated: manual read/edit, re-ingest, logs (requireTier)
│   ├── middleware/requireTier.js  role-based route protection (public<staff<supervisor<admin)
│   ├── scripts/ingest.js          (re)builds the Chroma collection; exports ingestManual()
│   ├── scripts/eval.js            50-question eval runner (npm run eval, vs a live server)
│   ├── eval/questions.js          the 50 graded eval questions
│   ├── package.json / package-lock.json
│   ├── .env                       git-ignored — never committed
│   └── private/                   git-ignored: manual_clean.txt, auth.json, sessions/, *_cache/*.jsonl
├── chroma_data/                 ChromaDB's own data directory (separate server, git-ignored)
├── .venv-chroma/                 local Python venv for running the Chroma server (git-ignored)
└── docs/                        architecture diagram + project report
```

The frontend and backend are split into their own top-level folders, but this is still a
single Express app: `Backend/server.js` serves `frontend/` as static files and exposes the
`/api/*` routes the frontend calls. There's no separate frontend build step or dev server.

---

## Setup

All `npm` commands below run from **`Backend/`** — that's where `package.json` lives.

### 1. Install dependencies

```bash
cd Backend
npm install
```

> **Node version note:** this project targets Node 18+. If you're on Node 18 specifically,
> the `chromadb` and `cheerio` versions in `package.json` are deliberately pinned to older
> releases — their latest majors require Node 20 and will crash on import under Node 18
> (confirmed during development: `cheerio@1.1.0+` pulls in `undici@7`, which references a
> browser-only `File` global that doesn't exist on Node 18). If you're on Node 20+, newer
> versions of both will also work fine.

### 2. Configure environment

From `Backend/`, copy `.env.example` to `.env` and fill in your Navigator API key:

```bash
cp .env.example .env
```

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NAVIGATOR_API_KEY` | Yes, for chat | — | Never hardcode this. If missing, the site still loads; chat returns a clear "not configured" message. |
| `NAVIGATOR_BASE_URL` | No | `https://api.ai.it.ufl.edu/v1` | |
| `CHROMA_URL` | No | `http://localhost:8000` | Point this at wherever your Chroma server is running. |
| `SESSION_SECRET` | Recommended | random per-boot | Sessions are file-backed (`session-file-store`) so they already survive an app restart, but a fixed secret is still required for that to matter — an ephemeral per-boot secret invalidates every existing session's signed cookie on restart anyway. Set a fixed value for anything beyond local testing. |
| `PORT` | No | `3000` | |
| `RELEVANCE_THRESHOLD` | No | `0.35` | Minimum cosine similarity for a manual passage to be used. Tune once you have real manual content — a small/homogeneous manual will naturally produce a narrower score spread than a large varied one. |
| `LIVE_CACHE_TTL_MINUTES` | No | `30` | How long fetched union.ufl.edu content is cached. |
| `CONTEXTUAL_CHUNKING` | No | `true` | When on, `npm run ingest` prepends a short LLM-generated context sentence to each chunk before embedding (Anthropic "Contextual Retrieval"), improving retrieval for terse/follow-up queries. Set `false` to store raw chunks. Changing it requires a re-ingest. |
| `REACT_MODE` | No | `false` | Opt-in bounded ReACT retrieval planner (`services/reactAgent.js`) for `manual`/`live` turns. Off by default — the single-shot path verified higher on the persona stress harness. |

### 3. Start ChromaDB (separate server)

The vector store is **not** embedded in the Node process — it's its own server, started
separately. Run these from the **project root** (not `Backend/`) — `chroma_data/` and
`.venv-chroma/` live at the root alongside `frontend/`/`Backend/` since Chroma is
infrastructure shared by the backend, not backend application code itself.

**Option A — Python venv (what this project was developed against):**
```bash
python3 -m venv .venv-chroma
.venv-chroma/bin/pip install chromadb
.venv-chroma/bin/chroma run --path ./chroma_data --port 8000
```

**Option B — Docker:**
```bash
docker run -p 8000:8000 -v "$(pwd)/chroma_data:/chroma/chroma" chromadb/chroma
```

Either way, confirm it's up before starting the app:
```bash
curl http://localhost:8000/api/v2/heartbeat
```

If port 8000 is already in use on your machine, run Chroma on a different port and set
`CHROMA_URL` in `.env` to match (e.g. `--port 8055` and `CHROMA_URL=http://localhost:8055`).

### 4. Add the manual and build embeddings

The manual is **not** in git — drop your sanitized-source manual at:
```
Backend/private/manual_clean.txt
```
Then, from `Backend/`, build the vector store:
```bash
npm run ingest
```
This reads the file, **redacts credentials/passwords/access codes/phone numbers/email
addresses before anything is embedded** (`services/sanitizer.js`), chunks it by section,
tags each chunk `public`/`staff`, embeds every chunk via Navigator, and rebuilds the Chroma
collection from scratch (safe to re-run any time the manual changes — it does a full
delete-and-recreate, not an incremental update, so there's no risk of stale leftover chunks
from a previous version).

By default (`CONTEXTUAL_CHUNKING=true`) each chunk is **contextualized** before embedding: a
short LLM-generated sentence naming the chunk's topic/equipment/procedure is prepended to it, so
terse or slide-derived chunks and elliptical follow-up queries retrieve far more reliably
(Anthropic's "Contextual Retrieval"). The added sentence is derived only from already-sanitized
text — it introduces no new PII — and a generation failure falls back to the raw chunk rather than
aborting the run. Set `CONTEXTUAL_CHUNKING=false` for raw chunks; either way it's an ingest-time
choice, so flipping it needs a re-ingest.

**Section headings** are detected as either Markdown (`# Heading`) or `ALL CAPS` lines.
Numbered lines (`1. Do the thing`) are deliberately **not** treated as headings — a real
manual will have numbered steps *inside* a procedure, and a heuristic that can't tell a
heading from a step will fragment that procedure into multiple chunks, which can then get
individually (and incorrectly) tagged by the keyword heuristic below.

**Tagging a section explicitly:** put a line containing only `[PUBLIC]` or `[STAFF]`
immediately after a section heading to override the automatic keyword-based guess. Anything
not explicitly marked and not obviously general information (hours, pricing, equipment
lists, "how to play") **defaults to `staff`** — the sanitizer errs toward restricting
content, not exposing it. For anything beyond a trivial manual, explicit markers are safer
than relying on the keyword heuristic — see the note in `docs/PROJECT_REPORT.md` about a
real mis-tagging bug this heuristic caused in testing.

If `Backend/private/manual_clean.txt` is missing, the app still runs — manual-based questions
get a clear "no manual loaded" fallback instead of a crash.

> The manual currently ingested is a **draft** operations manual, hand-transcribed and
> reorganized from a source PDF into clearly-tagged sections. Re-run `npm run ingest` after
> replacing `Backend/private/manual_clean.txt` whenever a newer/final version is available —
> until then, the existing vectors in ChromaDB remain valid and don't need to be regenerated
> (ingestion only needs to run again when the manual's *content* changes, not on a schedule).

### 5. Run the app

From `Backend/`:
```bash
npm start
```
Visit `http://localhost:3000`.

---

## Roles & access

| Tier | How to reach it | Notes |
|---|---|---|
| `public` | default, no login | Visitor chat: hours, pricing, games, general info. |
| `staff` | `staff.html`, password only | May receive manual content tagged `staff`. |
| `supervisor` | `/api/auth/supervisor-login`, own password | Adds `[SUPERVISOR]` content: leadership/escalation, refunds, payment-card handling. |
| `admin` | `admin.html`, separate password | Rotates all three passwords; `admin-content.html` edits the manual, re-ingests, and views question/feedback logs. |

The `staff`, `supervisor`, and `admin` passwords all default to `0000`, seeded as bcrypt hashes
into `Backend/private/auth.json` on first boot (also git-ignored — **change all three
immediately** via the admin panel; the server logs a startup warning while any are still
default). Login attempts are rate-limited to 5/minute per IP. Sessions are signed cookies
(`express-session`). The tiers form an ordered ladder — `public < staff < supervisor < admin` —
and `supervisor` is a real login with its own content tier (`[SUPERVISOR]`: leadership/
escalation, refunds, payment-card handling).

---

## The router

Every message gets classified once (`services/router.js`, one Navigator call that also rewrites
follow-ups into a standalone query using recent conversation history) into:

- **`manual`** — policies, procedures, equipment, staff operations → `services/searchManual.js`,
  a **hybrid vector + BM25 search** (`services/keywordIndex.js`, fused via reciprocal-rank
  fusion) filtered by the caller's tier (`public` sees `public` only; `staff` adds `staff`;
  `supervisor` adds `supervisor`; `admin` sees all). The filter is **re-checked in code** on
  both the vector and keyword paths — the DB filter is not the security boundary by itself.
- **`live`** — hours, closures, events, pricing, "is X open" → `services/liveInfo.js` fetches
  from an allowlist of exactly two pages (`union.ufl.edu/gameroom/`,
  `union.ufl.edu/gatoresportscenter/`), cached 15–60 min, returned with source URL + "last
  checked" timestamp.
- **`casual`** — greetings/small talk → answered directly, no retrieval. A short **elliptical
  follow-up** ("is it free?", "how many?", "what about billiards?") is *not* casual — it's
  resolved against recent turns and classified by the underlying topic (after talking about
  foosball, "is it free?" → `manual` "is foosball free"). `routes/chat.js` also injects a
  one-line hint with that resolved question right before the model answers, so it responds to the
  intended question rather than a bare pronoun (this is the fix for the multi-turn context-loss
  in issue #6).
- **`unsupported`** — credential requests, "dump everything", instruction-override attempts,
  off-topic → refused via a canned response, no tool calls. Off-topic trivia (capital cities,
  math, on-demand jokes) is declined even for a logged-in staff/supervisor/admin user — elevated
  access is for internal Game Room info, not general knowledge.

Both pages were confirmed **server-rendered** during development (a plain `fetch` sees the
same hours/pricing/closures text a browser would) — no headless browser is used.

For `manual`/`live` turns, context is gathered by a tuned single-shot fetch by default; an
opt-in bounded ReACT planner (`services/reactAgent.js`, `REACT_MODE=true`) can replace it, but
single-shot verified higher on the persona stress harness and remains the default.

---

## Safety layers

1. **Ingestion-time sanitization** (`services/sanitizer.js`): credentials, access codes, and
   phone numbers are redacted from the manual *before* anything is chunked or embedded — they
   never enter the vector store, so retrieval literally cannot surface them.
2. **Role-filtered retrieval, re-enforced server-side**: the tier is read from the session
   only; nothing a user types in chat can change it.
3. **Grounding discipline in the prompt** (`lib/personaPrompt.js`): the model is explicitly
   told to ignore its own background knowledge about UF/the Reitz Union and answer only from
   the RETRIEVED_CONTEXT/LIVE_INFO block for a given turn — found during testing that
   `gpt-oss-120b` will otherwise blend in plausible-sounding facts from its training data
   about this real, publicly-documented facility even when told to use tools.
4. **Output guard** (`services/outputGuard.js`): every response is regex-scanned for
   credential/PII shapes before it's returned, regardless of what generated it. It's tiered —
   genuine credential/PII shapes replace the *entire* response with the "contact your
   supervisor/admin" message, while a broad, lower-severity labeled number is masked inline so
   one benign match doesn't destroy a good answer. Credit-card detection is Luhn-gated.
5. **Abuse/cost control**: `/api/chat` is rate-limited (per-session, IP fallback), since each
   message can fan out to several Navigator calls.

---

## Development notes

- All commands (`npm start`, `npm run ingest`, `npm test`, `npm run eval`) run from `Backend/`.
- `npm start` — run the app (`PORT` from `.env`, default 3000).
- `npm run ingest` — rebuild the manual's vector store after editing
  `Backend/private/manual_clean.txt` (or use the admin UI's re-ingest).
- `npm test` — run the offline suite (`node --test --test-concurrency=1 test/`, 165 tests, incl. a hostile-input `edgecases.test.js`):
  unit tests for the sanitizer, tiered output guard, hybrid manual search/retrieval, the BM25
  keyword index, live-info extraction, the router's classify+rewrite parsing, manual-ingestion
  parsing/overlap, and tier middleware, plus `supertest`-driven integration tests for auth,
  session persistence, chat input validation, and the admin routes. `--test-concurrency=1` is
  required — two files snapshot/restore the real `auth.json` and race if run concurrently.
  Several tests are direct regressions for defects in `docs/PROJECT_REPORT.md`'s defect log.
- `npm run eval` — the 50-question answer-quality eval (`Backend/eval/`) run against a **live**
  server with real Navigator calls; a regression signal, not a hermetic unit test. Current bar:
  50/50. Router classification and live/manual retrieval quality are covered here rather than in
  the offline suite (non-deterministic model output can't be pinned to a fixed assertion).
- Sessions are file-backed (`session-file-store`, `Backend/private/sessions/`, git-ignored)
  rather than `express-session`'s in-memory default, so they survive an app restart on a
  single instance. This does not make sessions shared across multiple concurrent instances —
  that would need a real shared store (e.g. `connect-redis`) if this ever moves to a
  multi-instance deployment. Note: the streamed `/api/chat` reply flushes its response headers
  before the session is first written, so `POST /api/chat` deliberately touches `req.session`
  at the top of the handler — otherwise express-session never sends the `Set-Cookie` on turn 1
  and an anonymous visitor gets a new, memory-less session per message (fixed; see the defect
  log in `docs/PROJECT_REPORT.md`).
- No CORS is enabled — frontend and API are served from the same Express app
  (`Backend/server.js` serves `../frontend` as static files), so none is needed, and it keeps
  the attack surface smaller now that session cookies are in play.
- Centralized error handling never leaks stack traces to the client (malformed JSON,
  oversized payloads, and unhandled errors all return a clean JSON `{ error }`).

---

## TODO (left for you to provide)

- Evaluation Q&A set (30–50 staff/visitor questions + expected answers + adversarial/attack
  questions) to replace ad-hoc manual testing with a repeatable check. (Note: this is
  different from the automated regression suite in `Backend/test/` — that suite covers
  deterministic application logic like sanitization and access control, not LLM answer
  quality, which is what this eval set is for.)
- Expected user volume / final deployment target — single-process Chroma is fine for
  expected small-scale internal use; revisit if usage grows. Sessions now persist across
  restarts on one instance, but multi-instance deployment would still need a shared session
  store (e.g. Redis).

---

*Built for the Reitz Union Game Room, University of Florida.*
