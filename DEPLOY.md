# Joyland Portal Deploy

Use `deploy.bat` from the project folder to publish laptop changes to the live Google Cloud VM.

What it does:

1. Commits local changes if any exist.
2. Pushes to GitHub.
3. SSHs into the VM.
4. Runs `git pull`, `npm install`, JavaScript syntax checks, and `pm2 restart joyland-portal`.

The VM keeps live school data locally:

- `data/*.db`
- `public/uploads/`
- `secrets/`

Those are intentionally ignored by Git and are not overwritten by this deploy flow.

Live URLs:

- `http://136.112.61.134`
- `http://136.112.61.134/admin`
- `http://136.112.61.134/app/`
