# Frontend Architecture

Joyland currently uses a framework-free frontend split into two surfaces.

## Surface 1: Admin Operations

Location: `public/admin/`

Admin is a modular multi-page application. Each page is an HTML file with local script, shared shell, and shared CSS.

Shared files:

- `public/admin/_shared/admin.js`
- `public/admin/_shared/admin.css`

Current pages include overview, people, classes, class detail, subjects, subject detail, attendance, marks, skills, assessments, sessions, analysis, reports, report-card, broadsheet, calendar, notifications, settings, and timetable.

### Strengths

- Legacy monolith has been split into pages.
- Shared sidebar/topbar exists.
- Shared Joy helpers exist for API, toast, slide-over, command menu, live refresh, avatars, and counts.
- Pages can be reasoned about independently.

### Risks

- Many pages still hold large inline scripts.
- Shared admin JS/CSS contains mojibake and should be cleaned.
- No bundling or linting means syntax and encoding errors can ship easily.
- Component reuse is convention-based, not enforced.
- Accessibility is inconsistent across custom controls.

## Surface 2: Daraja App

Location: `public/app/`

Files:

- `index.html`: shell only.
- `daraja.js`: router, state, UI helpers, public landing, login, learner, parent, teacher flows.
- `daraja.css`: mobile design tokens and primitives.
- `sw.js`: service worker.
- `manifest.json`: PWA metadata.

### Strengths

- Current app is mobile-first and role-aware.
- Login supports password and temporary code mode.
- App is framework-free and lightweight.
- Teacher work is moving toward a task-centered model.
- Shared renderers exist for broadsheet and report templates.

### Risks

- `daraja.js` is already over 1,300 lines and growing.
- Teacher, learner, parent, router, API, and UI primitives are in one file.
- No route-level deep linking exists inside the app.
- Offline behavior is minimal and cache naming is outdated.
- Mojibake exists in the live app JS and CSS.

## Recommended Module Target

Move toward this structure without a disruptive rewrite:

```text
public/app/
  index.html
  daraja.css
  js/
    api.js
    state.js
    router.js
    ui.js
    auth.js
    resources.js
    learner.js
    parent.js
    teacher/
      index.js
      today.js
      classes.js
      attendance.js
      gradebook.js
      reports.js
    renderers/
      report-template-renderer.js
      broadsheet-renderer.js
```

Admin can follow a similar path:

```text
public/admin/_shared/
  admin.css
  admin.js
  api.js
  components.js
  dialogs.js
  tables.js
  live.js
```

## Frontend Rules

- New UI patterns must be added to shared files before being copied across pages.
- Per-page scripts should hold orchestration, not reusable component logic.
- Avoid inline `onclick` in new complex components where event delegation is cleaner.
- Never show browser-native dialogs in product UI.
- All new screens need loading, empty, error, and success states.
- Test on mobile width for Daraja and desktop width for admin before handoff.

## Immediate Cleanup

1. Remove mojibake from `public/app/daraja.js`, `public/app/daraja.css`, `public/admin/_shared/admin.js`, and `public/admin/_shared/admin.css`.
2. Rename outdated service worker cache from Framework7-era naming.
3. Split Daraja app into modules once the current active app changes are committed.
4. Add a script to syntax-check all inline admin page scripts.
