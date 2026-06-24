# MySQL Database Setup for Render Deployment

Your app is now configured to use MySQL from cPanel. Follow these steps to complete the setup.

## Step 1: Get Database Credentials from cPanel

1. Log in to your cPanel at: `cpanel.civicom.org`
2. Go to **"Manage My Databases"** (you saw this in the screenshot)
3. Look for your existing database or create one:
   - Database name: e.g., `civicomo_joyland`
   - Note down the **Database Name**, **Username**, and **Password**

## Step 2: Configure Remote Database Access in cPanel

1. In cPanel, go to **"Remote Database Access"** (shown in your screenshot)
2. The access hosts already configured (172.18.x.x, 41.80.x.x, etc.) are existing
3. You need to add Render's IP for remote access:
   - After deploying to Render, Render will provide an outgoing IP
   - Add that IP in Remote Database Access (or use wildcard `%` to allow all)

## Step 3: Migrate Data to MySQL (First Time Only)

If you want to copy existing data from SQLite to MySQL:

### Option A: Direct SQL Export/Import
1. Export your SQLite database as SQL
2. Import into your cPanel MySQL database using phpMyAdmin

### Option B: Use Python Migration Script
I can create a script that automatically migrates data from SQLite to MySQL.

**For now, skip this** - the app will auto-create tables if they don't exist.

## Step 4: Configure Render Environment Variables

1. Log in to your Render dashboard (shown in your screenshot)
2. Go to your service: **joyland-schools-portal**
3. Click **Settings** → **Environment**
4. Add these variables:

```
DB_HOST        = your-mysql-host (e.g., mysql.civicom.org or localhost)
DB_USER        = your-database-username
DB_PASSWORD    = your-database-password
DB_NAME        = your-database-name
DB_PORT        = 3306
SESSION_SECRET = generate-random-secret (use: python -c "import secrets; print(secrets.token_urlsafe(48))")
APP_ENV        = production
```

## Step 5: Test Connection

After setting env vars in Render:

1. Render will auto-redeploy
2. Check **Logs** in Render dashboard for connection success
3. Go to: `https://school.civicom.org/login`
4. Try login (should work if database connected)

## Troubleshooting

### "Can't connect to MySQL server"
- Check DB_HOST is correct (from cPanel)
- Verify credentials in Render env vars
- In cPanel Remote Database Access, add Render's IP address

### "Unknown database"
- Database name is case-sensitive
- Copy exact name from cPanel "Manage My Databases"

### Tables don't exist after connection
- App auto-creates tables on first run
- If not created, check database permissions in cPanel

## Database Details Format

From your cPanel, you'll need:

| Variable   | Example              | Where to find               |
|-----------|----------------------|-----------------------------|
| DB_HOST   | mysql.civicom.org    | cPanel → Databases section  |
| DB_USER   | civicomo_user123     | cPanel → Manage Databases   |
| DB_PASSWORD| (your password)     | cPanel → Manage Databases   |
| DB_NAME   | civicomo_joyland     | cPanel → Manage Databases   |

## Next Steps

1. Push this code to GitHub
2. Render will auto-deploy
3. Add MySQL credentials to Render environment
4. Test login at `https://school.civicom.org`
