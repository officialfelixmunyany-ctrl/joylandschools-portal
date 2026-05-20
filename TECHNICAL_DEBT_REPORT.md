# Technical Debt Report

This report ranks current technical debt by risk and business impact.

## Critical

### 1. Session and secret hardening — RESOLVED (2026-05-20)

Original risk:

- Session secret was hardcoded in `server.js`.
- Session store was the default in-memory Express store (lost on restart).
- Cookie settings were not production hardened.

Action taken:

- Secret now resolves from `SESSION_SECRET` (env), with a persisted dev fallback at
  `secrets/session-secret.txt`; production refuses to boot without the env var. See `lib/security.js`.
- Added a persistent SQLite-backed session store on the existing `node:sqlite` DB
  (`lib/session-store.js`, table `sessions`). Sessions now survive restarts.
- Cookie hardened: `httpOnly`, `sameSite=lax`, `secure` in production, named `joyland.sid`, 8h rolling expiry.
- Added `trust proxy` handling, helmet-lite security headers, and a per-IP login rate limiter
  on `/api/auth/login` and `/api/auth/temp-login`.
- Env documented in `.env.example`.

Residual (deferred, not Critical):

- No `helmet` package (used a dependency-free header middleware instead).
- No CSRF tokens on admin writes yet — relies on `sameSite=lax` for now.
- No strict Content-Security-Policy: admin pages still use inline scripts; CSP needs its own migration.
- Rate limiter is in-memory (single instance); a multi-instance deployment needs a shared store.

### 2. Database and uploads deployment risk

Current risk:

- SQLite database and uploads live on the server filesystem.
- Source deployment is separate from data, which is good, but backup discipline must be explicit.

Recommended action:

- Document backup/restore.
- Add scheduled DB backup.
- Add upload backup.
- Keep `data/` and `public/uploads/` outside deploy overwrite paths where possible.

### 3. Live mojibake in JS/CSS — RESOLVED (fixed + guarded 2026-05-20)

Re-audit finding:

- No U+FFFD replacement characters anywhere. The non-ASCII bytes in `daraja.js/css`
  and the admin shared files are intentional, valid UTF-8 (box-drawing banners `═ ─`
  and em-dash `—`) — not mojibake.
- However `routes/teacher.js` DID contain real double-encoded mojibake: em-dashes and
  box-drawing banners stored as "UTF-8 read as CP1252" (e.g. an em-dash as three chars
  `U+00E2 U+20AC U+201D`), including one user-facing teacher error message.

Action taken:

- Repaired `routes/teacher.js` by reversing the exact corrupt sequences back to clean
  UTF-8 (`═ ─ —`), preserving the one already-correct em-dash.
- Added `npm run check` (`scripts/check.js`): syntax-checks all owned JS and fails on the
  U+FFFD replacement char or double-encoded byte patterns, so corruption cannot re-enter.
  Patterns are built from char codes so the checker stays ASCII and never flags itself.

## High

### 4. Oversized backend route files

- `routes/admin.js`: more than 3,400 lines.
- `routes/teacher.js`: more than 2,000 lines.

Impact:

- Hard to review safely.
- Easy to duplicate logic.
- Harder to test.

Recommended split:

```text
routes/admin/
  index.js
  people.js
  academics.js
  attendance.js
  marks.js
  reports.js
  timetable.js
  settings.js
  resources.js
```

### 5. Oversized app file

- `public/app/daraja.js` is over 1,300 lines and growing.

Impact:

- Role features are coupled.
- Hard to test one screen without loading everything.
- Increases risk of accidental regressions.

Recommended action:

- Split by router, API, UI, auth, learner, parent, teacher modules.

### 6. No build/lint/test pipeline

Current risk:

- Syntax checks are manual.
- Inline scripts can break silently.
- Encoding issues recur.

Recommended action:

- Add `npm run check` for backend JS, app JS, inline admin scripts, and mojibake scan.
- Add smoke tests for auth, school-info, marks, attendance, and reports.

## Medium

### 7. Service worker is minimal

Current risk:

- Cache name still references the old Framework7 app.
- Offline behavior is not aligned with the public resources promise.

Recommended action:

- Rename cache.
- Precache shell assets.
- Runtime cache public resources.
- Never cache protected API responses unless explicitly designed.

### 8. Frontend component drift

Current risk:

- Admin pages still implement local patterns.
- Daraja app components are functions inside one file.

Recommended action:

- Promote repeated patterns into shared components.
- Maintain `COMPONENT_REGISTRY.md` with every new primitive.

### 9. Security middleware gaps

Recommended additions:

- `helmet`
- login rate limiting
- CSRF review for admin writes
- audit log for destructive changes
- upload file-type verification beyond MIME strings

## Low

### 10. Naming drift

Examples:

- Admin uses `Comms` in navigation while route/file is notifications.
- The service worker cache name still references the old app generation.
- Some academic concepts are still scattered across sessions, calendar, assessments, marks, reports, and analysis.

Recommended action:

- Create a glossary for academic terms: term, assessment stage, holiday, half-term, school day, report, broadsheet.

## Immediate Engineering Order

1. Clean mojibake.
2. Add check scripts.
3. Harden session/cookie config.
4. Add backup/deploy documentation.
5. Split route files after active app/admin work is committed.

## Performance Strategy

- Keep app shell assets small and cacheable.
- Avoid caching protected API responses unless a role-specific offline model is designed.
- Add pagination or virtualization before very large admin tables become slow.
- Keep report rendering reusable and lazy-loaded where possible.
- Avoid repeated dashboard calls when one aggregate endpoint can serve a screen.
- Add indexes before introducing expensive analytics queries.
- Measure first: route timing logs, slow query logs, and browser performance traces should guide optimization.
