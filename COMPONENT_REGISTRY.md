# Component Registry

This registry defines what components exist or should exist. It prevents every page from inventing a slightly different button, table, card, modal, or status chip.

## Shared Admin Components

Source today: `public/admin/_shared/admin.css` and `public/admin/_shared/admin.js`.

### Shell

- `side`: left navigation shell.
- `topbar`: page topbar with search, notifications, help, avatar.
- `content`: page content container.
- `page-head`: page title and primary actions.

### Feedback

- `Joy.toast(message, options)`
- `Joy.openSlide(id)` / `Joy.closeSlide()`
- Loading skeleton patterns
- Empty states

### Data

- `.tbl`: standard table.
- `.table-wrap`: bordered table container.
- `.filter-row`: filters and search row.
- `.pagination`: pagination footer.
- `.bulk-bar`: bulk action panel.

### Controls

- `.btn`, `.btn-primary`, `.btn-brand`, `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.btn-icon`
- `.chip`, `.status`, `.role-chip`, `.band-tag`
- `.input`, `.field`, `.field-label`
- `.tabs`, `.tab`, `.toggle-pair`

### Admin Gaps

- A reusable confirm dialog should replace all ad hoc confirm flows.
- A reusable choice dialog should replace browser prompts.
- A reusable import/export progress component should be shared by marks and future imports.
- A reusable editable table component would reduce duplication in marks, skills, attendance, and timetable.

## Daraja App Components

Source today: `public/app/daraja.css` and render functions in `public/app/daraja.js`.

### Shell

- `#app`: fixed mobile app frame.
- `.screen`: tab and stack screens.
- `.tabbar`: bottom navigation.
- `.appbar`: in-app header.
- `.sheet`: bottom sheet.

### Feedback

- `UI.toast()`
- `UI.openSheet()` / `UI.closeSheet()`
- `loadingScroll()`
- `emptyState()`
- `errorState()`

### Content

- `.hero`
- `.card`
- `.metric`
- `.row`
- `.ava`
- `.badge`
- `.seg`
- `.progress`
- `.queue-item`
- `.tl-item`

### Daraja Gaps

- Route-level components are embedded directly inside TeacherApp, LearnerApp, and ParentApp.
- Attendance rows, marks grids, skill rating rows, and report selectors should become reusable functions.
- Notification badge/count should be a shared app component.
- Offline/resource reader should be a proper component family.

## Renderer Components

- `public/app/report-template-renderer.js`: official report template rendering.
- `public/app/broadsheet-renderer.js`: app-side broadsheet rendering.
- Admin report rendering should keep using the same logic or extract a shared browser-safe renderer.

## Component Governance

Before adding a new visual pattern, ask:

1. Does this already exist in the registry?
2. Is it admin-specific or app-specific?
3. Should it be a primitive, composed component, or one-off page layout?
4. Does it have loading, empty, error, and disabled states?
5. Does it work with keyboard and touch?
