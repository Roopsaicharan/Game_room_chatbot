# Security Notes

## Secrets

- **Navigator API key** — lives only in `Backend/.env` (git-ignored). Never hardcoded anywhere
  in source. **Rotate it** if it's ever been shared, committed, or logged, via the UF Navigator
  portal, then update `Backend/.env` and restart the server.
- **Staff/supervisor/admin passwords** — stored as bcrypt hashes in
  `Backend/private/auth.json` (git-ignored), never plaintext, never logged. All three are
  seeded to `"0000"` on first boot — **change all three immediately** via the admin panel
  (`frontend/admin.html`) before this is used for anything real. The server logs a startup
  warning while any role is still on the default.
- **Session secret** (`SESSION_SECRET`) — set a fixed, random value in `Backend/.env` for
  anything beyond local testing. If unset, the app generates a random one at boot with a
  warning, which means every restart invalidates all sessions.

## Data handling

- The operations manual is treated as sensitive. It is **never** sent to any model or API
  other than UF Navigator's locally-hosted endpoints.
- `Backend/private/manual_clean.txt` and `Backend/private/auth.json` are git-ignored — verify
  `git status` never shows either as staged before committing.
- Manual content is sanitized (`services/sanitizer.js`) **before** embedding — passwords
  (including natural phrasing like "the password is X" and shorthand like "PW:"), access
  codes, phone numbers, email addresses, and labeled financial/account numbers (merchant,
  terminal, account, routing) are all redacted at ingestion time, so they cannot be retrieved
  even by an authenticated staff session. Verified against a real operations manual during
  development: zero credential/PII pattern hits across every stored chunk after redaction.
- Some content is intentionally excluded from the manual entirely rather than relying on
  regex redaction alone, when a value is embedded in prose the regex can't reliably bridge
  (e.g. "Serial Number for terminals: At Register A 65098281" — free text between the label
  and the value). When curating manual content, prefer omitting or generalizing values like
  this rather than trusting the sanitizer to catch every possible phrasing.
- Some content is kept in the manual but relies on the **prompt-level** safety rule instead
  of ingestion-time redaction — e.g. an internal emergency codeword that staff legitimately
  need to know about operationally. `lib/personaPrompt.js`'s access-control rule ("never
  output... security/emergency access procedures... use the RESTRICTED response instead")
  is the layer that keeps this from being repeated verbatim via chat, even to staff. Verified
  in testing: a staff-authenticated request for this codeword is still refused.
- Every chat response — regardless of role or source — passes through
  `services/outputGuard.js`, a regex-based final check for credential/PII-shaped text. It's
  tiered: genuine credential/PII shapes discard the *entire* response, while a broad,
  lower-severity labeled number is masked inline (credit-card detection is Luhn-gated to avoid
  false positives). The two-tier design keeps one benign match from destroying a good answer
  without weakening credential-leak protection.

## Access control

- Role (`public` / `staff` / `supervisor` / `admin`, an ordered ladder) comes only from the
  server-side session; nothing a user types can change it. This is re-verified in
  `services/searchManual.js` on both the vector and BM25 retrieval paths after every Chroma
  query — the database `where` filter is defense-in-depth, not the sole boundary. `[SUPERVISOR]`
  content (leadership/escalation, refunds, payment-card handling) is reachable only by
  supervisor and admin; a staff request for it is refused (verified in the eval set).
- Login is rate-limited (5 attempts/minute/IP) on `/api/auth/staff-login`,
  `/api/auth/supervisor-login`, and `/api/auth/admin-login`. `/api/chat` is separately
  rate-limited to cap Navigator cost and abuse.
- Admin content APIs (`/api/admin/*` — manual edit, re-ingest, question/feedback logs) are all
  gated by `requireTier('admin')`.
- Session cookies are `httpOnly` and `sameSite: lax`. Set `SESSION_COOKIE_SECURE=true` once
  this is deployed behind HTTPS.

## Known v1 limitations

- Sessions are file-backed (`session-file-store`) so they survive a restart, but are still
  single-instance — a multi-instance deployment would need a shared store (e.g. Redis). The
  BM25 keyword index and the append-only analytics/feedback logs are likewise single-instance.
- `staff`, `supervisor`, and `admin` all default to the same starting password (`"0000"`); they
  are independent secrets once rotated, but nothing forces rotation on first login yet (the
  server does log a startup warning while any remain default).
- The relevance threshold for manual retrieval (`RELEVANCE_THRESHOLD`) is a static value —
  recalibrate it if retrieval quality seems off as the manual grows, since score
  distributions depend on corpus size and topical diversity.
- Section heading detection in `scripts/ingest.js` only recognizes Markdown and ALL-CAPS
  headings (see README). A manual formatted with a different convention (e.g. numbered or
  Title Case headings with no other signal) will fall entirely into one `General` section
  unless explicit `[PUBLIC]`/`[STAFF]` markers are added by hand — safe (defaults to
  `staff`), but reduces retrieval quality.
- `services/liveInfo.js` has a content-length tripwire that logs a warning if a fetched page
  returns suspiciously little text (possible sign the page started requiring JavaScript to
  render). It only logs — it does not alert or fail the request — so watch server logs if
  live-data answers seem to degrade.
