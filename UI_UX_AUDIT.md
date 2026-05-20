# UI/UX Audit

This audit is based on the current repository structure and files, not a visual-only impression. It should be reviewed again after the active admin dashboard work is complete.

## Product Surfaces

### Admin Operations

Current direction: serious, editorial, operations-focused.

Strengths:

- Modular pages are easier to navigate than the old monolith.
- Sidebar grouping is clearer than the earlier admin dashboard.
- Shared shell creates consistent navigation and topbar behavior.
- Tables, chips, and slide-overs are moving toward a professional school office tool.
- Reports, sessions, timetable, and marks have real operational depth.

Risks:

- Some pages still feel visually heavy because of large typography and generous spacing.
- Admin CSS uses an elegant style, but operational pages need more density in tables and filters.
- Shared admin files contain mojibake that can leak into UI text.
- Large inline scripts make behavior consistency difficult.
- The command/search affordance is promising but should become genuinely useful before it is promoted visually.

### Daraja App

Current direction: mobile-first, premium, guided, role-aware.

Strengths:

- App shell is clean and lightweight.
- Login supports both password and temporary code.
- Role separation is understandable.
- Teacher experience is moving from menu tiles to a work-queue model, which is stronger.
- Mobile tokens are warm and polished.

Risks:

- App file is too large for long-term maintainability.
- Deep linking is not yet available inside app routes.
- Offline/resource promise is ahead of the current service worker implementation.
- Notification counts and read states need consistent display across app and admin.

## Accessibility Findings

Must improve:

- Replace icon-only controls without accessible labels.
- Ensure all custom interactive elements are keyboard reachable.
- Respect `prefers-reduced-motion` for page transitions and animated counters.
- Confirm color contrast for gold-on-light and green-on-gold combinations.
- Ensure modal and slide-over focus trapping.

## Responsiveness Findings

- Daraja is intentionally capped to a phone-width app frame. This is acceptable for the APK/webview model.
- Admin is desktop-first and should not pretend to be a full mobile admin. It should remain usable on tablets, but complex tables belong on desktop.
- Admin slide-overs need careful width behavior on smaller laptops.

## Interaction Quality Findings

Good:

- Slide-overs are better than page-hopping for admin detail work.
- Daraja stack screens are good for mobile flow.
- Toast feedback exists on both surfaces.

Needs work:

- Confirm/choice dialogs should be branded, not browser-native.
- Live refresh must detect dirty forms and avoid interrupting work.
- Loading states should avoid layout jumps, especially sidebar counts and dashboard stats.
- Long-running import/export should show progress text.

## Visual Consistency Findings

- Admin and Daraja both use green/gold but with different token systems.
- Admin uses a more editorial display style; Daraja uses native mobile system UI.
- This difference is acceptable, but shared semantics must match: primary, warning, danger, success, info, muted.

## Priority UX Fixes

1. Clean mojibake from live UI and source comments.
2. Stabilize sidebar count loading so refresh does not visually pop.
3. Standardize admin dialogs and remove native prompts.
4. Make marks/import/export progress and errors consistently visible.
5. Reduce admin page script duplication by moving repeated table/filter logic into shared helpers.
6. Improve Daraja service worker and offline states.
7. Add notification badges and read/delivery clarity in both admin and app.
8. Add a design QA checklist for every new screen.

## Donor And Partner Confidence

A donor-facing or partner-facing demo should show:

- Clean login and school branding.
- Admin overview with meaningful live school signals.
- Teacher app with today, classes, and gradebook working smoothly.
- Learner/parent app with results, attendance, timetable, and resources.
- Report card and broadsheet that look official and print correctly.
- Notifications with visible delivery/read status.
- No broken text, placeholder copy, or browser-native popups.
