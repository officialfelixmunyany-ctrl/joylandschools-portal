# Design System

Joyland has two product surfaces with different jobs:

- Admin Operations: dense, calm, table-first, work-focused.
- Daraja App: mobile-first, warm, guided, role-aware.

They should feel related, not identical. The shared brand is Joyland green and gold, but interaction density differs by user role.

## Design Principles

1. Whitespace first: use space to create clarity, not emptiness.
2. Typography first: hierarchy should come from size, weight, and rhythm before color.
3. Calm color: green for primary action, gold for emphasis, red only for risk.
4. Tables where tables belong: admin data entry and review should be spreadsheet-like when needed.
5. Cards only when they clarify grouping. Avoid cards inside cards.
6. Buttons must communicate priority: primary, secondary, destructive, utility.
7. Motion must be subtle and purposeful.
8. Every screen must work on the intended device class.

## Brand Tokens

Current tokens live in:

- `public/admin/_shared/admin.css`
- `public/app/daraja.css`

Recommended canonical tokens:

```css
--brand-900: #0b2e1a;
--brand-700: #14532d;
--brand-500: #268a4e;
--gold-500: #c99732;
--ink: #13201a;
--muted: #69776e;
--line: #e7ece8;
--surface: #ffffff;
--bg: #f4f7f3;
--danger: #dc2626;
--warn: #d97706;
--info: #2563eb;
--ok: #16a34a;
```

## Typography

### Daraja App

- Use system UI stack for speed and native feel.
- Large titles: 26-34px.
- Section headers: 12-14px uppercase or semibold.
- Body text: 14-16px.
- Support text: 12-13px.

### Admin Operations

- Use Inter/system UI for body.
- Display headings may use a restrained serif only for page identity.
- Page title: 30-36px only on true landing screens.
- Table text: 12.5-13.5px.
- Form labels: 11-12px.
- Avoid oversized admin cards.

## Components

### Shared

- Button
- Icon button
- Badge/chip/status
- Empty state
- Toast
- Dialog/slide-over
- Avatar
- Progress indicator
- Segmented control
- Form field
- Table

### Admin-Specific

- Data table with sticky header
- Filter row
- Action toolbar
- Bulk action bar
- Import preview modal
- Report preview shell
- Timetable grid
- Calendar/holiday editor

### App-Specific

- App frame
- Bottom navigation
- Stack screen
- Sheet
- Hero header
- Metric tile
- Learner row
- Teacher work queue row
- Swipe/large-tap attendance row
- Offline/resource reader

## Interaction Rules

- Minimum touch target: 44px for mobile.
- Desktop table row height: 40-48px.
- Admin utility actions should not compete with primary save/generate actions.
- Destructive actions require a branded confirmation dialog.
- Import/export must show progress and preview when data can be invalid.
- Real-time refresh must not interrupt active forms.

## Accessibility Rules

- All buttons require visible focus states.
- Icon-only controls require labels or title text.
- Do not rely on color alone for status.
- Maintain contrast on green/gold combinations.
- Respect reduced-motion preferences.
- Form errors must be inline and specific.

## Current Design Risks

- Live CSS/JS contains mojibake in comments and some UI text.
- Admin and app token systems are related but not unified.
- Admin uses strong visual personality, but some screens are still too spacious for operational work.
- Daraja app has good mobile language, but its single JS file makes consistency harder to preserve.
