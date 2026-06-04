# Contributing

Thanks for helping build Daraja / Joyland Portal.

## Workflow

1. Fork or clone the repository.
2. Create a branch for your change.
3. Make focused commits with clear messages.
4. Run the checks before opening a pull request.
5. Open a pull request into `main`.

Direct commits to `main` are reserved for maintainers. Public contributors should use pull requests so changes can be reviewed before deployment.

## Local Setup

```powershell
python -m pip install -r requirements.txt
$env:SESSION_SECRET='local-dev-secret-change-me'
$env:RESOURCE_ADMIN_PASSWORD='local-dev-resource-admin'
python py_backend.py
```

Open `http://localhost:3000/`.

Node.js is only required for Capacitor Android tooling and the npm check wrapper.

## Checks

Run:

```powershell
python scripts/check_python.py
npm test
```

Use `scripts/smoke_python.py` only against a disposable local database because it writes test data.

## What Belongs in Git

Include source code, static assets, scripts, templates, docs, and configuration examples needed to build and review the project.

Do not commit:

- `.env` or `.env.*` files except `.env.example`
- `secrets/`
- `data/*.db`, SQLite journals, or live backups
- `public/uploads/`
- `tmp/` screenshots or audit output
- `node_modules/`
- Android build outputs such as APK/AAB files

If a feature needs sample data, add a small sanitized template under `data/templates/`.

## Deployment Notes

Pushing to `main` runs the GitHub Actions deploy workflow. Production requires GitHub secrets for the VM connection plus `SESSION_SECRET` and `RESOURCE_ADMIN_PASSWORD`.
