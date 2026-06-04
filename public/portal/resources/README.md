# Civicom Learning Portal

A fast, mobile-first education discovery portal for **schools.civicom.org**. Learners and teachers browse, search, and save Kenyan study and teaching resources - notes, past papers, schemes of work, revision guides, and curriculum designs - with no login required to browse.

School login is a separate, private door handled by the Civicom Schools Portal (the SaaS landing at the site root).

## What it does

- The resource **Library is the default landing page**, not a login screen.
- **Instant search** plus filters by audience, level, subject, and resource type.
- Learner and teacher paths are separated early (`#/learner`, `#/teacher`).
- **Save resources** locally with `localStorage` (no account needed).
- Uses the live API when available and **falls back to a bundled sample dataset** so the portal still works offline / in demo mode.
- **School Login** and **Create School** in the header link out to the Civicom Schools Portal.

## File structure

```txt
index.html                    App shell, navigation, School Login / Create School
assets/styles.css             Full responsive UI system (Civicom blue theme)
src/config.js                 App settings, levels, subjects, resource types, links
src/main.js                   Router, page rendering, search shortcut, event binding
src/components/
  SearchBar.js                Instant-search input row
  Filters.js                  Audience chips + level/type/subject/sort selects
  ResourceCard.js             Resource card
  Hero.js                     Landing hero
  Stats.js                    Result summary strip
  Modal.js                    Reader / access modal
  Toast.js                    Transient notifications
src/services/resourceService.js   Resource API, normalization, filtering
src/state/store.js            Lightweight store backed by localStorage
src/data/resources.js         Demo fallback resources
src/utils/dom.js              DOM helpers ($ , debounce, escapeHtml)
manifest.json                 PWA manifest
sw.js                         Basic offline cache
```

## Run locally

Because the app uses ES modules, serve it from a local server:

```bash
python3 -m http.server 8080
```

Then open the app folder, e.g. `http://localhost:8080/app/` (or `http://localhost:8080/` if this folder is the web root).

## Connect to your backend

The service calls:

```txt
GET /api/portal/resources?q=&type=&subject=&level=&audience=
```

Expected response:

```json
{
  "resources": [
    {
      "id": 1,
      "title": "Grade 7 Science Notes",
      "type": "notes",
      "audience": ["learner", "teacher"],
      "level": "junior-secondary",
      "grade": "Grade 7",
      "subject": "Science",
      "year": "2026",
      "summary": "Short description",
      "body_html": "<p>Readable content</p>",
      "file_path": "/uploads/file.pdf"
    }
  ]
}
```

Change `apiBase`, the School Login / Create School links, and the mock-fallback toggle in `src/config.js`.
