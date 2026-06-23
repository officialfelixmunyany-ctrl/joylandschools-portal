# Project Guide & Status — Daraja / Civicom School Portal

> **Read this first.** It explains what the project is, what is already built, how it
> fits together, and **how to make changes safely**. It is the map for anyone
> picking the codebase up. Setup/deploy basics live in [README.md](README.md);
> contribution rules in [CONTRIBUTING.md](CONTRIBUTING.md).

_Last reviewed: 2026-06-05._

---

## 1. What this is

One product, three faces, served by a single Python backend:

1. **Daraja Digital Library** — a free, no-login public catalogue of Kenyan school
   resources (KCSE past papers, CBC notes, schemes, revision). This is the public
   front door at **`/portal/resources/`**.
2. **Civicom Schools (SaaS)** — onboarding + multi-tenant school management
   (admin, teachers, learners, parents, marks, attendance, **timetabling**, report
   cards, notifications, billing). Schools live under a slug, e.g. `/joyland/login`.
3. **Mobile app shell** — the same web app wrapped with Capacitor for Android.

The backend is **one file**, [py_backend.py](py_backend.py) (~6,000 lines), built on
Python's stdlib `http.server`. It serves the static frontends in [public/](public/)
**and** all JSON APIs, backed by SQLite. There is no framework, no build step for the
web app (the library is plain ES modules), and no external services required to run.

---

## 2. Status at a glance

This is a **broadly feature-complete** system, not a greenfield. "Complete" is not
100% — below is an honest read by area.

| Area | State | Notes |
|---|---|---|
| Public library (browse/search/save/contribute) | ✅ Done | Recently re-themed (hero, footer). See §6. |
| Library admin (review submissions, CRUD resources) | ✅ Done | `/portal/resources/#/admin`, separate resource-admin login. |
| Auth & sessions (login, temp-login, platform, resource-admin) | ✅ Done | Signed-cookie sessions; `SESSION_SECRET` required in prod. |
| School onboarding (`/schools`, create-school) | ✅ Done | Public APIs `/api/public/schools`, `/register-school`. |
| Admin: people (learners/teachers/parents/admins) | ✅ Done | Incl. bulk status, class moves, temp codes, **learner import**. |
| Admin: classes / subjects / sessions / terms | ✅ Done | |
| Admin: marks, analysis, broadsheet, publish | ✅ Done | Analysis stage-split + equity/cohort recently added. |
| Admin: attendance, calendar, holidays | ✅ Done | |
| Admin: **timetable** (generate, grid, rooms, swaps, substitutions, workload) | ✅ Done | Largest recent effort — see `docs/codex-prompts/CODEX_TIMETABLE*`. |
| Admin: report cards, comments, skills, templates, billing, integrations | ✅ Done | |
| Learner & parent portals (marks, timetable, comments, children) | ✅ Done | |
| Notifications (inbox, broadcasts, read state, SMS billing) | ✅ Done | |
| Platform/SaaS tier (`/api/platform/*`) | ✅ Done | Cross-school metrics & management. |
| **Known broken / gaps** | ⚠️ | See §10. |

**Bottom line:** every major domain has working routes and screens. The remaining
work is **polish, fixing a few stale references, and hardening** — not building
missing pillars. Do not advertise it as "100% done"; treat §10 as the punch list.

---

## 3. Architecture

```
Browser / Android (Capacitor)
        │  HTTP
        ▼
py_backend.py  (stdlib http.server, class Handler)
        ├── serves static files from public/
        ├── JSON APIs (/api/**)            → SQLite
        ├── multi-tenant routing by slug   (/<slug>/login, /<slug>/admin)
        └── auth via signed session cookie (SESSION_SECRET)
        ▼
SQLite
  ├── data/joyland.db            ← schools, users, marks, timetable, everything tenant
  └── data/resource_database.db  ← public library resources + submissions
```

Key backend facts (all in [py_backend.py](py_backend.py)):

- **Request dispatch** is a long `if path == ... / path.startswith(...)` ladder inside
  `Handler` (GET section around the auth/portal block; POST/PUT/PATCH/DELETE grouped
  by domain). Each domain group ends with a `"... route not implemented"` **404
  fallback** — those strings are *catch-alls, not missing features*.
- **Multi-tenancy**: a leading path segment that is not a reserved word
  (`api, admin, app, school, uploads, vendor, login, platform, template-editor`) is
  treated as a **school slug** and resolves tenant context (see `~line 2106`).
- **Page routes**: `/`, `/login`, `/schools`, `/admin`, `/template-editor`,
  `/<slug>/login`, plus the library SPA under `/portal/resources/` (`~line 2324`).
- **Two databases**: tenant data in `data/joyland.db`; library content in
  `data/resource_database.db`. Both are **runtime/local and git-ignored** — never
  commit them.

---

## 4. Repository map

```
py_backend.py            ← THE backend: static serving + all APIs + SQLite
requirements.txt         ← Python deps
package.json             ← npm scripts (Capacitor Android + check wrapper)
capacitor.config.json    ← Android wrapper config
start.bat / deploy.bat   ← Windows run/deploy helpers
.env.example             ← config template (copy to .env locally)

public/
  index.html             ← "/schools" SaaS onboarding landing
  login.html             ← tenant login
  template-editor.html   ← report-card template designer
  portal/resources/      ← PUBLIC LIBRARY SPA  (vanilla ES modules) ── §6
  admin/                 ← per-school admin dashboard (HTML pages + _shared/)
  app/                   ← mobile/PWA app shell (wrapped by Capacitor)
  app.legacy/            ← old app shell (legacy; prefer app/)
  vendor/                ← fontawesome, lucide (local, no CDN)
  uploads/               ← runtime uploads (git-ignored)

data/                    ← SQLite DBs, backups, templates (git-ignored except templates/)
docs/
  phase2-route-map.md    ← generated map of every frontend→route call + status
  codex-prompts/         ← the task specs the build followed (timetable, imports, …)
scripts/
  check_python.py        ← AST/lint-style project check  (npm test)
  route_audit.py         ← regenerates docs/phase2-route-map.md
  smoke_python.py        ← writes sample data — DISPOSABLE DB ONLY
  *.mjs                  ← browser validators / screenshot helpers
android/                 ← Capacitor Android project (build outputs git-ignored)
secrets/                 ← local secrets (git-ignored)
tmp/                     ← scratch / screenshots (git-ignored)
```

---

## 5. Running it locally

```powershell
python -m pip install -r requirements.txt
$env:SESSION_SECRET = 'local-dev-secret-change-me'
$env:RESOURCE_ADMIN_PASSWORD = 'local-dev-resource-admin'   # for the library admin
python py_backend.py
```

Default port **3000** (override with `PORT`). Useful URLs:

| URL | What |
|---|---|
| `/portal/resources/` | Public library (start here) |
| `/portal/resources/#/admin` | Library admin (resource-admin login) |
| `/schools` | School onboarding / SaaS landing |
| `/login` | Tenant login |
| `/<slug>/login` → `/admin` | A school's admin (e.g. `joyland`) |
| `/template-editor` | Report-card template designer |
| `/app/` | Mobile app shell |

Config lives in environment variables — see [.env.example](.env.example)
(`SESSION_SECRET`, SMTP for school confirmation mail, `RESOURCE_ADMIN_*`,
`SCHOOL_TIME_ZONE`, `APP_ENV`). **Production refuses to start without strong
`SESSION_SECRET` and `RESOURCE_ADMIN_PASSWORD`** — that's intentional.

Checks before you ship:

```powershell
python scripts/check_python.py      # or: npm test
python scripts/route_audit.py       # refresh docs/phase2-route-map.md after route changes
```

---

## 6. The public library SPA (`public/portal/resources/`)

This is the most-recently-polished surface. It's a tiny hand-rolled SPA — no
framework, no bundler.

```
index.html                 app shell (mounts #main, loads src/main.js as a module)
assets/styles.css          the entire design system + animations (one file)
assets/hero-learners.jpg   hero photo (Pexels, free licence)
sw.js                      service worker (offline cache) ── BUMP ON EVERY CHANGE
manifest.json              PWA manifest
src/
  main.js                  bootstrap, hash routing, all event wiring
  config.js                CONFIG (org, emails, URLs, social links), taxonomies
  state/store.js           tiny observable store + localStorage (filters/saved/read)
  services/                resourceService.js (public API) · adminService.js (admin API)
  components/Home.js        the whole landing/results/footer markup
  components/Admin.js       library admin dashboard
  components/ResourceCard.js · Modal.js · Toast.js
  utils/dom.js             $, $$, escapeHtml, debounce
```

How it renders: `main.js` keeps a `store`, and on every state change calls
`renderRoute()` → sets `main.innerHTML = Home(state)`. Filters persist in
`localStorage` (`civicom.library.*`). The API is `/api/portal/resources` with a
bundled **mock fallback** (`CONFIG.useMockFallback`) so it works offline/in demos.

**Design language:** calm-utility — "trust comes from density + typography, not
decoration." Two deliberate exceptions frame the page: a **dark photo hero** at the
top and a **dark animated footer** at the bottom (the "bookends"). The dense
catalogue between them stays flat and clean — keep it that way.

### Recently added (this session)
- **Hero band** (`heroBanner()` in Home.js, `.home-hero` in styles.css): photo of
  Kenyan learners + navy gradient. Always shown on the library (full on the landing,
  **compact** when results are showing); hidden only on the school-login/create
  center routes.
- **Animated footer** (`footer()` / `.footer-signoff`): a CSS book that opens, pages
  turn, dots rise, then "Made with ♥ by Civicom" reveals on scroll-in
  (IntersectionObserver in `main.js` adds `.is-revealed`).
- **Dark themed footer band + social icons** (`.home-footer`, `.footer-social`):
  social links come from `CONFIG.socials` (Font Awesome brand icons). **Replace the
  placeholder URLs** in [config.js](public/portal/resources/src/config.js) with real
  Civicom handles.
- Accessibility: everything has a `prefers-reduced-motion` static fallback; the book
  is `aria-hidden`, the love line carries an `aria-label`.

---

## 7. How to make changes — recipes

**Restyle / add to the library UI**
→ Markup in [Home.js](public/portal/resources/src/components/Home.js); styles in
[styles.css](public/portal/resources/assets/styles.css). **Then bump `CACHE_NAME` in
[sw.js](public/portal/resources/sw.js)** (e.g. `v41` → `v42`) or returning users get
stale CSS/JS. Verify by hard-refreshing (`Ctrl+Shift+R`).

**Change the hero image** → drop a file at
`public/portal/resources/assets/hero-learners.jpg` (no code change) and bump the SW.

**Change social links / footer wording** → edit `CONFIG.socials` (and copy) in
[config.js](public/portal/resources/src/config.js); set a URL to `''` to hide an icon.

**Add a field to a library resource** → add it in the backend resource serializer and
in [resourceService.js](public/portal/resources/src/services/resourceService.js)
normalisation, then render it in `ResourceCard.js` / `Modal.js`.

**Add a backend API route** → find the matching domain group in
[py_backend.py](py_backend.py) (search for a sibling endpoint string), add your
`if path == ... and method == ...: return self.your_handler(...)` **above** that
group's 404 fallback, and write `your_handler`. Re-run `route_audit.py`.

**Add an admin screen** → admin pages are static HTML in
[public/admin/](public/admin/) sharing `_shared/admin.js` + `admin.css`; they call
`/api/admin/*`. Copy an existing page (e.g. `subjects.html`) as the template.

**Mobile app** → edit the web app, then `npm run android:sync` and
`npm run android:open` / `android:build`.

---

## 8. Conventions & gotchas

- **Service worker is network-first but caches core assets** — always bump
  `CACHE_NAME` when you touch `styles.css`, `main.js`, or precached files.
- **Never commit** `data/*.db`, `public/uploads/`, `secrets/`, `.env`, `tmp/`,
  Android build outputs, or `node_modules/` (see [.gitignore](.gitignore) /
  CONTRIBUTING). The live DB and uploads are real user state.
- **Secrets come from env**, never hard-code them. Production fails fast without them.
- **`scripts/smoke_python.py` writes data** — only against a throwaway DB.
- **Keep the library dense** — don't put imagery behind the catalogue; the hero and
  footer are the only decorative zones.
- The backend is a **single large file** on purpose (easy to deploy). When editing,
  match the surrounding handler style and keep the dispatch ladder ordered.

---

## 9. Validation & deployment

- `npm test` / `python scripts/check_python.py` — static project check (lint/AST).
  **Note: there are no functional/unit tests yet** (see §10).
- `python scripts/route_audit.py` — regenerates [docs/phase2-route-map.md](docs/phase2-route-map.md),
  which lists every frontend→backend call and whether it's `working`/`broken`.
- **Deploy**: pushing to `main` triggers the GitHub Actions workflow. Production needs
  GitHub secrets for the VM plus `SESSION_SECRET` and `RESOURCE_ADMIN_PASSWORD`.

---

## 10. Known gaps / punch list (the plan)

Prioritised. Tackle top-down.

1. **Fix the broken report-card asset.** `docs/phase2-route-map.md` flags
   `public/admin/report-card.html → /app/report-template-renderer.js` as **broken**
   (missing/moved file). Restore or repoint it, then re-run `route_audit.py`.
2. **Refresh stale docs to match the code.**
   - Root [README.md](README.md) still points at `/app/` and
     `/admin/overview.html` as the entry; the public front door is now
     `/portal/resources/`.
   - [public/portal/resources/README.md](public/portal/resources/README.md) and
     `PAGE-AUDIT.md` describe an older component set / neo-brutalist palette; the
     current system is calm-utility. Update or mark them historical.
3. **Set real social + contact details.** Replace placeholder `CONFIG.socials` URLs
   and confirm `supportEmail` everywhere.
4. **Add functional tests.** Today `npm test` is lint-only. Add a small smoke suite
   that boots the backend against a temp DB and hits the critical APIs
   (auth, resources, marks, timetable generate).
5. **Consider modularising `py_backend.py`.** 6k lines in one file is deployable but
   hard to navigate; if it keeps growing, split handlers by domain (resources, admin,
   timetable, notifications) behind the same dispatcher.
6. **Audit the `app.legacy/` shell** — confirm it's dead and remove, or document why
   it stays.
7. **Tighten library a11y** noted in `PAGE-AUDIT.md` (modal focus trap, broader
   keyboard focus outlines).

When you finish an item, update the table in §2 and this list so the next person
inherits the truth.
