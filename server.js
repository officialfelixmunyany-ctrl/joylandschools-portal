const express = require('express');
const session = require('express-session');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { initDatabase } = require('./database');

const authRoutes = require('./routes/auth');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const teacherRoutes = require('./routes/teacher');
const learnerRoutes = require('./routes/learner');
const parentRoutes = require('./routes/parent');
const notificationRoutes = require('./routes/notifications');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
app.set('etag', false);

const PUBLIC_DIR = path.join(__dirname, 'public');
const liveClients = new Set();
let liveEventId = 0;
let devRefreshTimer = null;

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
}

function sendNoStoreHtml(res, fileName) {
  noStore(res);
  res.type('html').send(fs.readFileSync(path.join(PUBLIC_DIR, fileName), 'utf8'));
}

function writeLiveEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcastPortalUpdate(payload = {}) {
  const data = {
    id: ++liveEventId,
    at: new Date().toISOString(),
    ...payload
  };
  for (const res of Array.from(liveClients)) {
    try {
      writeLiveEvent(res, 'portal-update', data);
    } catch (_) {
      liveClients.delete(res);
    }
  }
}

function changeKindFromPath(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('/notifications')) return 'notifications';
  if (value.includes('/school') || value.includes('/signature') || value.includes('/comment-bank')) return 'school';
  if (value.includes('/marks') || value.includes('/assessment')) return 'marks';
  if (value.includes('/attendance')) return 'attendance';
  if (value.includes('/learners') || value.includes('/classes') || value.includes('/subjects')) return 'class-data';
  if (value.includes('/teachers') || value.includes('/parents')) return 'people';
  return 'general';
}

function liveSyncMutationMiddleware(source) {
  const methods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  return (req, res, next) => {
    if (!methods.has(req.method)) return next();

    let responseSuccess;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'success')) {
        responseSuccess = body.success;
      }
      return originalJson(body);
    };

    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 400 && responseSuccess !== false) {
        broadcastPortalUpdate({
          source,
          kind: changeKindFromPath(req.originalUrl),
          method: req.method,
          path: req.originalUrl
        });
      }
    });
    next();
  };
}

function startDevRefreshWatcher() {
  if (process.env.PORTAL_DEV_REFRESH !== '1') return;
  const watchedDirs = [
    path.join(PUBLIC_DIR, 'admin'),
    path.join(PUBLIC_DIR, 'app')
  ].filter((dir) => fs.existsSync(dir));
  const ignored = /(?:^|[\\/])uploads[\\/]|\.map$|\.tmp$|\.bak$|~$/i;
  watchedDirs.forEach((dir) => {
    try {
      fs.watch(dir, { recursive:true }, (eventType, fileName) => {
        if (!fileName || ignored.test(String(fileName))) return;
        clearTimeout(devRefreshTimer);
        devRefreshTimer = setTimeout(() => {
          broadcastPortalUpdate({
            source:'dev-watch',
            kind:'dev-refresh',
            method:eventType,
            path:String(fileName).replace(/\\/g, '/')
          });
        }, 250);
      });
    } catch (err) {
      console.warn('[WARN] Dev refresh watcher could not watch', dir, err.message);
    }
  });
  if (watchedDirs.length) {
    console.log('[DEV] Soft browser refresh enabled for public/admin and public/app changes.');
  }
}

app.get(['/app/v2', '/app/v2/'], (req, res) => {
  noStore(res);
  res.redirect(302, '/app/');
});

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(session({
  secret: 'joyland-schools-2026-secure',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 8 * 60 * 60 * 1000 }
}));

app.get('/api/events', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ success:false, message:'Login required' });
  }
  noStore(res);
  res.set({
    'Content-Type': 'text/event-stream',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  liveClients.add(res);
  writeLiveEvent(res, 'connected', { success:true, at:new Date().toISOString() });
  req.on('close', () => liveClients.delete(res));
});

setInterval(() => {
  for (const res of Array.from(liveClients)) {
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch (_) {
      liveClients.delete(res);
    }
  }
}, 25000);

app.get(/^\/app(\/|$)/, (req, res, next) => {
  const appDir = path.join(PUBLIC_DIR, 'app');
  const requested = decodeURIComponent(req.path.replace(/^\/app\/?/, ''));
  if (requested && path.extname(requested)) {
    const filePath = path.resolve(appDir, requested);
    if (filePath.startsWith(appDir + path.sep) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      noStore(res);
      return res.sendFile(filePath);
    }
    return next();
  }
  noStore(res);
  const role = req.session.user?.role;
  const fileName = role && role !== 'teacher' ? 'index.legacy.html' : 'index.html';
  res.sendFile(path.join(PUBLIC_DIR, 'app', fileName));
});

// Guard the admin shell (HTML, CSS, JS, shared assets) before the static handler.
// APIs under /api/admin are already protected by adminRoutes middleware; this stops
// anonymous users from loading the UI shell at /admin/overview.html etc.
app.use('/admin', (req, res, next) => {
  const roleUser = req.session.roleUsers?.admin
    || (req.session.user?.role === 'admin' || req.session.user?.is_admin === 1 ? req.session.user : null);
  if (!roleUser) {
    // For JSON/asset requests, fail cleanly with 401; for HTML, redirect to login.
    const accept = String(req.headers.accept || '');
    if (accept.includes('application/json')) return res.status(401).json({ success:false, message:'Unauthorized' });
    return res.redirect('/');
  }
  req.session.user = roleUser;
  next();
});

app.use(express.static(PUBLIC_DIR, {
  etag: false,
  lastModified: false,
  setHeaders(res, filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    if (filePath.endsWith('.html') || normalizedPath.includes('/public/app/')) noStore(res);
  }
}));

app.use('/api', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', liveSyncMutationMiddleware('admin'), adminRoutes);
app.use('/api/teacher', teacherRoutes);
app.use('/api/learner', learnerRoutes);
app.use('/api/parent', parentRoutes);
app.use('/api/notifications', liveSyncMutationMiddleware('notifications'), notificationRoutes);

function guardPage(role) {
  return (req, res) => {
    const roleUser = role === 'admin'
      ? (req.session.roleUsers?.admin || (req.session.user?.role === 'admin' || req.session.user?.is_admin === 1 ? req.session.user : null))
      : (req.session.roleUsers?.[role] || (req.session.user?.role === role ? req.session.user : null));
    if (!roleUser) return res.redirect('/');
    req.session.user = roleUser;
    if (role === 'admin') return res.redirect('/admin/overview.html');
    if (role === 'teacher') return sendNoStoreHtml(res, 'teacher.html');
    if (role === 'learner') return sendNoStoreHtml(res, 'learner.html');
    res.redirect('/');
  };
}

function serveTemplateEditor(req, res) {
  const roleUser = req.session.roleUsers?.admin || (req.session.user?.role === 'admin' || req.session.user?.is_admin === 1 ? req.session.user : null);
  if (!roleUser) return res.redirect('/');
  req.session.user = roleUser;
  sendNoStoreHtml(res, 'template-editor.html');
}

app.get('/', (req, res) => {
  sendNoStoreHtml(res, 'login.html');
});
app.get('/admin', guardPage('admin'));
app.get('/template-editor', serveTemplateEditor);
app.get('/teacher', guardPage('teacher'));
app.get('/learner', guardPage('learner'));

initDatabase();
startDevRefreshWatcher();

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  const ignoredInterface = /brave|vpn|virtual|vEthernet|hyper-v|vmware|virtualbox|loopback|tunnel|tap|npcap|docker|wsl|tailscale|zerotier|anydesk/i;

  for (const [name, entries] of Object.entries(interfaces)) {
    if (ignoredInterface.test(name)) continue;

    for (const entry of entries || []) {
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal || !entry.address) continue;
      if (entry.address.startsWith('169.254.')) continue;

      addresses.push({ name, address: entry.address });
    }
  }

  return addresses.sort((a, b) => {
    const aWifi = /wi-?fi|wireless|wlan/i.test(a.name) ? 0 : 1;
    const bWifi = /wi-?fi|wireless|wlan/i.test(b.name) ? 0 : 1;
    if (aWifi !== bWifi) return aWifi - bWifi;
    return a.name.localeCompare(b.name) || a.address.localeCompare(b.address);
  });
}

app.listen(PORT, HOST, () => {
  const lanAddresses = getLanAddresses();

  console.log('\n============================================================');
  console.log(' JOYLAND SCHOOLS PORTAL');
  console.log(' EDUCATION IS TREASURE');
  console.log('------------------------------------------------------------');
  console.log(` Local access : http://localhost:${PORT}`);
  if (lanAddresses.length) {
    console.log(' LAN access   :');
    lanAddresses.forEach(({ name, address }) => {
      console.log(`   http://${address}:${PORT}  (${name})`);
    });
  } else {
    console.log(' LAN access   : No active LAN IPv4 address was found.');
  }
  console.log(' Admin login: ADM001 / admin123');
  console.log('============================================================\n');
});
