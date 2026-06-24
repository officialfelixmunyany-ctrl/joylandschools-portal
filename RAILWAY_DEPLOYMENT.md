# Deploy to Railway.app

## Quick Start

### Step 1: Create Railway Account
1. Go to https://railway.app
2. Sign up (free tier available)
3. Create new project

### Step 2: Connect GitHub
1. Click "New Project"
2. Select "Deploy from GitHub repo"
3. Authorize Railway to access your GitHub
4. Select: `officialfelixmunyany-ctrl/joylandschools-portal`
5. Select branch: `codex/full-codebase-cleanup`

### Step 3: Railway will auto-detect and deploy
- Railway sees `Dockerfile` → builds and deploys
- Service will be live in 2-5 minutes

### Step 4: Set Environment Variables
1. In Railway dashboard, go to **Variables**
2. Add all 5 variables:

```
DB_HOST=41.80.37.74
DB_USER=civicomo_school
DB_PASSWORD=[your password]
DB_NAME=civicomo_school
DB_PORT=3306
SESSION_SECRET=[generated secret]
APP_ENV=production
```

### Step 5: Get Your Railway URL
Once deployed, Railway gives you a URL like:
```
https://joylandschools-portal-prod.railway.app
```

### Step 6: Add cPanel Access Hosts
In cPanel → Remote MySQL, make sure these are added:
- `74.228.48.0` (Railway IP range - will vary)
- Or use wildcard: `%`

### Step 7: Test Login
Go to your Railway URL/login and try:
- Username: `ADM001`
- Password: `admin123`

## Connecting Custom Domain
1. In Railway: Settings → Custom Domains
2. Add: `school.civicom.org`
3. In cPanel: Zone Editor → Add CNAME pointing to Railway URL
4. DNS propagates in 5-30 minutes

## Troubleshooting

### Deploy fails
- Check Railway logs for errors
- Common: Missing requirements (check `requirements.txt`)
- Check environment variables are all set

### "Can't connect to MySQL"
- Verify all 5 DB environment variables
- Confirm Railway IPs added to cPanel Remote MySQL
- Check cPanel MariaDB is running

### "Service error 500"
- Check Railway logs for database errors
- Might need to initialize database on first run

## Next Steps
1. Commit this configuration to GitHub
2. Push to `codex/full-codebase-cleanup` branch
3. Connect Railway to GitHub repo
4. Set environment variables
5. Test login
