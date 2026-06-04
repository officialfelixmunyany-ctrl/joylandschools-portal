# Daraja / Joyland Portal

Daraja is a school portal served by a small Python HTTP backend against the local SQLite database in `data/joyland.db`. The frontend is static HTML/CSS/JS in `public/`, with the mobile app shell under `public/app/` and admin screens under `public/admin/`.

## Requirements

- Python 3.11+
- `pip install -r requirements.txt`
- Node.js/npm only for Capacitor Android tooling

## Local Development

```powershell
python -m pip install -r requirements.txt
$env:SESSION_SECRET='local-dev-secret-change-me'
python py_backend.py
```

Open:

- Login: `http://localhost:3000/`
- Daraja app: `http://localhost:3000/app/`
- Admin after login: `http://localhost:3000/admin/overview.html`

## Checks

```powershell
python scripts/check_python.py
npm test
```

## Runtime Data

These paths are runtime/local state and are intentionally ignored:

- `data/*.db`, `data/backups/`
- `public/uploads/`
- `secrets/`
- Android and package build outputs

Do not delete or commit live database, upload, or secret files.

## Deployment Notes

Set `APP_ENV=production` and provide a strong `SESSION_SECRET` or `DARAJA_SESSION_SECRET`. Production startup fails without a session secret so misconfigured deployments do not silently invalidate sessions on restart.
