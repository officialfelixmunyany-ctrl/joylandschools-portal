# Project Governance

Joyland is governed as two connected products on one Node/Express platform:

- Admin Operations: `/admin/*.html`, a modular desktop back-office for school staff.
- Daraja App: `/app/`, a mobile-first role-aware app for learners, parents, and teachers.

This document is the operating contract for future work. It exists so the platform can grow without drifting into duplicated screens, inconsistent styling, weak security, or unclear ownership.

## Product Standard

Joyland must feel calm, trustworthy, modern, and useful. The goal is not decoration. The goal is a school platform that parents, teachers, administrators, donors, and technical partners can trust.

The benchmark is not old school-management software. The benchmark is the clarity of Linear, the trust of Stripe, the calm of Notion, and the learning friendliness of Duolingo.

## Non-Negotiable Rules

1. Do not delete files blindly. Confirm references first with `rg`.
2. Do not overwrite active work. Check `git status --short` before edits.
3. Keep API response shapes stable unless a migration is planned.
4. Use session-derived identity. Never trust role IDs from request bodies for protected user data.
5. Every new screen must use shared tokens and shared interaction patterns.
6. Every long action must show loading, success, and error states.
7. No browser-native `alert`, `confirm`, or `prompt` in production UI.
8. No developer placeholder copy in user-facing screens.
9. Keep uploaded files, databases, secrets, and generated builds out of git.
10. Accessibility is required: keyboard focus, readable contrast, visible states, and sane tap targets.

## Current Source Of Truth

- Backend entry: `server.js`
- Database and migrations: `database.js`
- API routes: `routes/*.js`
- Admin shell: `public/admin/_shared/admin.js`
- Admin design tokens: `public/admin/_shared/admin.css`
- Daraja shell: `public/app/index.html`
- Daraja logic: `public/app/daraja.js`
- Daraja design tokens: `public/app/daraja.css`
- Android wrapper: `android/`
- Capacitor config: `capacitor.config.json`

## Working Model

- Admin remains a desktop-first operations system.
- Daraja remains a mobile-first app experience.
- Backend remains Express plus SQLite for now.
- Frontend remains framework-free for now, but code must move toward modularity.
- Deployment uses GitHub plus VM pull/restart until a stable CI/CD path is active.

## Definition Of Done

A change is done only when:

- Related files were inspected before editing.
- Syntax checks pass for changed JavaScript.
- The route or screen was smoke-tested when practical.
- Loading, empty, success, and error states are handled.
- The change does not expose private data across roles.
- The UI follows the design system.
- No mojibake or broken encoding is introduced.
- No temporary test files remain.

## Release Phases

### Phase 0 - Stabilize

- Remove mojibake from live JS, CSS, and docs.
- Harden sessions, secrets, cookies, and login limits.
- Verify app/admin routing after legacy cleanup.
- Protect data files during deploys.

### Phase 1 - Foundation

- Split oversized route files into domain modules.
- Split Daraja app into modules.
- Create reusable admin and app primitives.
- Add smoke-test scripts for critical routes.

### Phase 2 - Product Quality

- Normalize admin UX: tables, filters, dialogs, forms, import/export.
- Normalize Daraja role flows: learner, parent, teacher.
- Improve offline and service worker behavior.
- Add stronger notification read/delivery tracking.

### Phase 3 - Platform Readiness

- Move secrets to environment variables.
- Replace MemoryStore sessions with persistent storage.
- Add observability: logs, audit trail, uptime checks.
- Add backup/restore procedure for SQLite and uploads.

### Phase 4 - Scale Path

- Decide when SQLite is no longer enough.
- Introduce a migration tool.
- Introduce a small build pipeline for app/admin assets.
- Prepare HTTPS/domain/Play Store release hygiene.

## Current Working Tree Notice

At the time of this audit, these active app files are modified and must be preserved:

- `public/app/daraja.js`
- `public/app/daraja.css`

They appear to contain current product work and should not be overwritten without review.
