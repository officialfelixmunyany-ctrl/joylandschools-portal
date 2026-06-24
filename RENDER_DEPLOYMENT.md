# Deploy to Render.com

## What is Render?
- Modern cloud hosting platform
- Free tier available with limits
- Auto-deploys from GitHub
- Handles Python, Node, Go, etc.
- Automatic HTTPS/SSL
- No more server configuration headaches

## Quick Start (10 minutes)

### Step 1: Push Code to GitHub
```bash
cd ~/Desktop/portal
git init
git add .
git commit -m "Initial commit for Render deployment"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/joyland-schools-portal.git
git push -u origin main
```

### Step 2: Create Render Account
1. Go to https://render.com
2. Sign up (free account)
3. Click "New +" button
4. Select "Web Service"

### Step 3: Connect GitHub
1. Choose "GitHub" as source
2. Authorize Render to access your GitHub
3. Select your `joyland-schools-portal` repository
4. Choose `main` branch

### Step 4: Configure Service
```
Name:                  joyland-schools-portal
Environment:           Python 3.11
Build Command:         pip install -r requirements.txt
Start Command:         python py_backend.py
Plan:                  Free (or Pro if you want better performance)
```

### Step 5: Environment Variables (Optional)
```
APP_ENV     = production
NODE_ENV    = production
PORT        = 3000
```

### Step 6: Deploy
- Click "Create Web Service"
- Render starts building (2-3 minutes)
- Once "Live" appears, your app is deployed!
- You'll get a URL like: `joyland-schools-portal-abc123.onrender.com`

## Connect cPanel Domain to Render

### Step 1: Get Render URL
After deployment, Render gives you a URL like:
```
https://joyland-schools-portal-abc123.onrender.com
```

### Step 2: Update DNS in cPanel
1. Login to cPanel
2. Go to **Zone Editor** or **DNS Zone**
3. For `school.civicom.org`:
   - **Type**: CNAME
   - **Name**: school
   - **Value**: joyland-schools-portal-abc123.onrender.com
4. Save changes

### Step 3: Add Custom Domain in Render
1. Go to your Render service dashboard
2. Click **Settings**
3. Go to **Custom Domains**
4. Click **Add Custom Domain**
5. Enter: `school.civicom.org`
6. Render auto-configures SSL certificate

### Step 4: Wait for DNS Propagation
- Can take 5-30 minutes
- Test: `https://school.civicom.org/login`

## File Structure for Render

```
joyland-schools-portal/
├── Procfile              (← Tells Render how to start app)
├── render.yaml           (← Render deployment config)
├── requirements.txt      (← Python dependencies)
├── py_backend.py         (← Main server)
├── db_helpers.py         (← Database functions)
├── public/               (← Frontend files)
│   ├── index.html
│   ├── login.html
│   ├── .htaccess        (← Routing config)
│   └── admin/
├── data/                 (← Database location)
│   └── .gitkeep
└── README.md
```

## Test Login on Render

1. Go to: `https://school.civicom.org/login`
2. Username: `ADM001`
3. Password: `admin123`
4. Should redirect to dashboard

## Render Features

✅ Auto SSL/HTTPS  
✅ Auto-deploy on git push  
✅ Free tier (5 services)  
✅ Paid tier ($7+/month)  
✅ No server management  
✅ Scalable  
✅ Environment variables  
✅ Persistent storage option  

## Troubleshooting

### Deploy fails
- Check Render logs: Service Dashboard → Logs
- Common: `ModuleNotFoundError` → Update requirements.txt
- Common: Port issues → Should auto-use 3000

### Domain not working
- Check DNS propagation: https://mxtoolbox.com/mxlookup.aspx
- Check Render custom domain status
- Clear browser cache

### Database issues
- Render has persistent storage
- Database auto-created at `/data/joyland.db`
- To reset: Delete and redeploy

### Slow startup
- Free tier: Cold starts after 15 min idle
- Pro tier: Always running
- First request may take 10-30 seconds

## GitHub Setup

Push updates automatically deploy:

```bash
git add .
git commit -m "Update login form"
git push origin main
# Render auto-deploys within 1 minute!
```

## Production Checklist

- [ ] Code pushed to GitHub
- [ ] Render account created
- [ ] GitHub connected to Render
- [ ] Service deployed and showing "Live"
- [ ] Custom domain added in Render
- [ ] CNAME record added in cPanel DNS
- [ ] DNS propagation complete
- [ ] Login test successful
- [ ] Admin can access dashboard

## Next Steps

1. Follow steps 1-6 above to deploy
2. Test at: `https://school.civicom.org`
3. Make changes → git push → Auto-deploys
4. Monitor at: Render dashboard

**That's it! Your app is now on production!** 🚀
