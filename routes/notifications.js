const express = require('express');
const { getDB } = require('../database');
const { isConfigured, sendMulticast } = require('../lib/fcm');
const router = express.Router();

function requireUser(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ success:false, message:'Session expired. Please sign in again.' });
}
router.use(requireUser);

function isAdmin(req) {
  return req.session.user?.role === 'admin' || req.session.user?.is_admin === 1;
}
function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(403).json({ success:false, message:'Admin access required' });
}
function currentRecipient(req) {
  return { role:req.session.user.role, id:Number(req.session.user.id) };
}
function clean(value) { return String(value || '').trim(); }
function safeJsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function recipientsForAudience(db, audience, classId) {
  const rows = [];
  const add = (role, id) => rows.push({ user_role:role, user_id:Number(id) });
  if (audience === 'teachers' || audience === 'all') {
    db.prepare("SELECT id FROM users WHERE role='teacher' AND status='active'").all().forEach(u => add('teacher', u.id));
  }
  if (audience === 'learners' || audience === 'all') {
    db.prepare("SELECT id FROM users WHERE role='learner' AND status='active'").all().forEach(u => add('learner', u.id));
  }
  if (audience === 'parents' || audience === 'all') {
    db.prepare("SELECT id FROM parent_accounts WHERE status='active'").all().forEach(u => add('parent', u.id));
  }
  if (audience === 'class') {
    const cls = db.prepare('SELECT id, name FROM classes WHERE id=?').get(classId);
    if (!cls) return [];
    db.prepare("SELECT id FROM users WHERE role='learner' AND status='active' AND class_name=?").all(cls.name).forEach(u => add('learner', u.id));
    db.prepare(`
      SELECT DISTINCT p.id
      FROM parent_accounts p
      JOIN parent_learner_links pll ON pll.parent_id=p.id
      JOIN users u ON u.id=pll.learner_id
      WHERE p.status='active' AND u.role='learner' AND u.status='active' AND u.class_name=?
    `).all(cls.name).forEach(u => add('parent', u.id));
  }
  const seen = new Set();
  return rows.filter(r => {
    const key = `${r.user_role}:${r.user_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAudience(raw) {
  const value = clean(raw || 'all-parents').toLowerCase();
  if (value === 'all-parents' || value === 'parents') return { audience:'parents', classId:null, label:'all-parents' };
  if (value === 'all-teachers' || value === 'teachers') return { audience:'teachers', classId:null, label:'all-teachers' };
  if (value === 'all-learners' || value === 'learners') return { audience:'learners', classId:null, label:'all-learners' };
  if (value === 'everyone' || value === 'all') return { audience:'all', classId:null, label:'all' };
  const classMatch = value.match(/^class:(\d+)$/);
  if (classMatch) return { audience:'class', classId:Number(classMatch[1]), label:value };
  return { audience:'parents', classId:null, label:'all-parents' };
}

function deliveryStats(db, notificationId) {
  const rows = db.prepare('SELECT channel, status, delivered_at, read_at FROM notification_deliveries WHERE notification_id=?').all(notificationId);
  const total = rows.length;
  const delivered = rows.filter(r => ['delivered','read'].includes(r.status) || r.delivered_at || r.read_at).length;
  const read = rows.filter(r => r.status === 'read' || r.read_at).length;
  const byChannel = {};
  ['in-app','sms','email'].forEach(channel => {
    const channelRows = rows.filter(r => r.channel === channel);
    const ok = channelRows.filter(r => ['delivered','read'].includes(r.status) || r.delivered_at || r.read_at).length;
    byChannel[channel] = channelRows.length ? Math.round((ok / channelRows.length) * 1000) / 10 : 0;
  });
  return { delivered, total, readRate:total ? Math.round((read / total) * 1000) / 10 : 0, byChannel };
}

function recentBroadcastRows(db, limit, status) {
  let sql = `
    SELECT n.*, COALESCE(u.name, 'Admin') AS sender_name
    FROM notifications n
    LEFT JOIN users u ON u.id=COALESCE(n.sent_by, n.created_by_id)
    WHERE COALESCE(n.type, 'broadcast') IN ('broadcast','announcement','alert','event')
  `;
  const params = [];
  if (status && status !== 'sent') {
    sql += ' AND COALESCE(n.type, "broadcast")=?';
    params.push(status);
  }
  sql += ' ORDER BY datetime(COALESCE(n.sent_at, n.created_at)) DESC, n.id DESC LIMIT ?';
  params.push(limit);
  return db.prepare(sql).all(...params);
}

router.get('/', requireAdmin, (req, res) => {
  const db = getDB();
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const rows = recentBroadcastRows(db, limit, clean(req.query.status).toLowerCase()).map(row => ({
    id:row.id,
    title:row.title,
    body:row.body,
    sentAt:row.sent_at || row.created_at,
    senderName:row.sender_name,
    audience:row.audience,
    channels:safeJsonArray(row.channels, ['in-app']),
    type:row.type || 'broadcast',
    status:'sent',
    stats:deliveryStats(db, row.id)
  }));
  res.json({ success:true, data:rows });
});

router.get('/stats', requireAdmin, (req, res) => {
  const db = getDB();
  const days = String(req.query.range || '30days').match(/\d+/)?.[0] || '30';
  const rows = db.prepare(`
    SELECT nd.*
    FROM notification_deliveries nd
    JOIN notifications n ON n.id=nd.notification_id
    WHERE datetime(COALESCE(n.sent_at, n.created_at)) >= datetime('now', ?)
  `).all(`-${days} days`);
  const notifications = db.prepare(`
    SELECT COUNT(*) c FROM notifications
    WHERE datetime(COALESCE(sent_at, created_at)) >= datetime('now', ?)
  `).get(`-${days} days`).c;
  const total = rows.length;
  const delivered = rows.filter(r => ['delivered','read'].includes(r.status) || r.delivered_at || r.read_at).length;
  const readRows = rows.filter(r => r.status === 'read' || r.read_at);
  const byChannel = {};
  ['in-app','sms','email'].forEach(channel => {
    const channelRows = rows.filter(r => r.channel === channel);
    const ok = channelRows.filter(r => ['delivered','read'].includes(r.status) || r.delivered_at || r.read_at).length;
    byChannel[channel] = channelRows.length ? Math.round((ok / channelRows.length) * 1000) / 10 : 0;
  });
  const responseMs = readRows.map(r => {
    if (!r.read_at || !r.delivered_at) return null;
    return new Date(r.read_at) - new Date(r.delivered_at);
  }).filter(v => Number.isFinite(v));
  res.json({ success:true, data:{
    sent:Number(notifications || 0),
    delivered:total ? Math.round((delivered / total) * 1000) / 10 : 0,
    readRate:total ? Math.round((readRows.length / total) * 1000) / 10 : 0,
    avgResponseMs:responseMs.length ? Math.round(responseMs.reduce((s,v)=>s+v,0) / responseMs.length) : 0,
    byChannel
  }});
});

router.post('/broadcasts', requireAdmin, async (req, res) => {
  const subject = clean(req.body?.subject || req.body?.title);
  const body = clean(req.body?.body);
  const channels = safeJsonArray(req.body?.channels, ['in-app']).filter(c => ['in-app','sms','email'].includes(c));
  const normalized = normalizeAudience(req.body?.audience);
  if (!subject || !body) return res.status(400).json({ success:false, message:'Subject and message are required' });
  if (!channels.length) return res.status(400).json({ success:false, message:'Choose at least one channel' });
  const db = getDB();
  const recipients = recipientsForAudience(db, normalized.audience, normalized.classId);
  if (!recipients.length) return res.status(400).json({ success:false, message:'No recipients found for this audience' });
  let notificationId;
  db.exec('BEGIN IMMEDIATE');
  try {
    notificationId = db.prepare(`
      INSERT INTO notifications
        (title, body, audience, target_class_id, created_by_role, created_by_id, role_scope, type, sent_by, sent_at, channels, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, 'admin', 'broadcast', ?, datetime('now'), ?, datetime('now'))
    `).run(subject, body, normalized.label, normalized.classId, req.session.user.role, req.session.user.id, req.session.user.id, JSON.stringify(channels)).lastInsertRowid;
    const insertRecipient = db.prepare(`
      INSERT OR IGNORE INTO notification_recipients (notification_id, user_role, user_id)
      VALUES (?, ?, ?)
    `);
    recipients.forEach(r => insertRecipient.run(notificationId, r.user_role, r.user_id));
    const recipientRows = db.prepare('SELECT id, user_id FROM notification_recipients WHERE notification_id=?').all(notificationId);
    const insertDelivery = db.prepare(`
      INSERT OR IGNORE INTO notification_deliveries (notification_id, recipient_id, channel, status, delivered_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    recipientRows.forEach(recipient => channels.forEach(channel => {
      const deliveredNow = channel === 'in-app';
      insertDelivery.run(notificationId, recipient.id, channel, deliveredNow ? 'delivered' : 'pending', deliveredNow ? new Date().toISOString() : null);
    }));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return res.status(500).json({ success:false, message:error.message });
  }
  res.json({ success:true, message:`Sent to ${recipients.length} recipient(s)`, data:{ id:notificationId, recipients:recipients.length } });
});

router.post('/device-token', (req, res) => {
  const token = clean(req.body?.token);
  if (!token) return res.status(400).json({ success:false, message:'Device token required' });
  const platform = clean(req.body?.platform) || 'webview';
  const user = currentRecipient(req);
  getDB().prepare(`
    INSERT INTO device_tokens (user_role, user_id, token, platform, last_seen)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(token) DO UPDATE SET
      user_role=excluded.user_role,
      user_id=excluded.user_id,
      platform=excluded.platform,
      last_seen=datetime('now')
  `).run(user.role, user.id, token, platform);
  res.json({ success:true, message:'Device registered' });
});

router.get('/inbox', (req, res) => {
  const user = currentRecipient(req);
  const rows = getDB().prepare(`
    SELECT n.id, n.title, n.body, n.audience, n.target_class_id, n.created_at, nr.read_at
    FROM notification_recipients nr
    JOIN notifications n ON n.id=nr.notification_id
    WHERE nr.user_role=? AND nr.user_id=?
    ORDER BY datetime(n.created_at) DESC, n.id DESC
    LIMIT 100
  `).all(user.role, user.id);
  res.json({ success:true, data:{ notifications:rows } });
});

router.get('/unread-count', (req, res) => {
  const user = currentRecipient(req);
  const row = getDB().prepare(`
    SELECT COUNT(*) AS c
    FROM notification_recipients
    WHERE user_role=? AND user_id=? AND read_at IS NULL
  `).get(user.role, user.id);
  res.json({ success:true, data:{ unread_count:Number(row?.c || 0) } });
});

router.post('/read/:id', (req, res) => {
  const user = currentRecipient(req);
  const db = getDB();
  db.prepare(`
    UPDATE notification_recipients
    SET read_at=datetime('now')
    WHERE notification_id=? AND user_role=? AND user_id=?
  `).run(req.params.id, user.role, user.id);
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM notification_recipients
    WHERE user_role=? AND user_id=? AND read_at IS NULL
  `).get(user.role, user.id);
  res.json({ success:true, message:'Marked as read', data:{ unread_count:Number(row?.c || 0) } });
});

router.get('/admin/history', requireAdmin, (req, res) => {
  const rows = getDB().prepare(`
    SELECT n.*, c.name AS class_name,
      (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id=n.id) AS recipients_count,
      (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id=n.id AND nr.read_at IS NOT NULL) AS read_count,
      (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.notification_id=n.id AND nr.read_at IS NULL) AS unread_count
    FROM notifications n
    LEFT JOIN classes c ON c.id=n.target_class_id
    ORDER BY datetime(n.created_at) DESC, n.id DESC
    LIMIT 50
  `).all();
  res.json({ success:true, data:{ notifications:rows, fcm_configured:isConfigured() } });
});

router.get('/admin/:id/recipients', requireAdmin, (req, res) => {
  const db = getDB();
  const notification = db.prepare(`
    SELECT n.*, c.name AS class_name
    FROM notifications n
    LEFT JOIN classes c ON c.id=n.target_class_id
    WHERE n.id=?
  `).get(req.params.id);
  if (!notification) return res.status(404).json({ success:false, message:'Notification not found' });

  const rows = db.prepare(`
    SELECT nr.user_role, nr.user_id, nr.created_at AS delivered_at, nr.read_at,
      COALESCE(u.name, p.name, 'Unknown user') AS name,
      COALESCE(u.user_id, p.phone, '') AS login_id,
      COALESCE(u.admission_no, '') AS admission_no,
      COALESCE(u.class_name, '') AS class_name,
      CASE WHEN EXISTS (
        SELECT 1 FROM device_tokens dt
        WHERE dt.user_role=nr.user_role AND dt.user_id=nr.user_id
      ) THEN 1 ELSE 0 END AS has_device
    FROM notification_recipients nr
    LEFT JOIN users u ON nr.user_role IN ('admin','teacher','learner') AND u.id=nr.user_id
    LEFT JOIN parent_accounts p ON nr.user_role='parent' AND p.id=nr.user_id
    WHERE nr.notification_id=?
    ORDER BY nr.user_role, name
  `).all(req.params.id);

  const summary = {
    delivered: rows.length,
    read: rows.filter(r => r.read_at).length,
    unread: rows.filter(r => !r.read_at).length,
    devices: rows.filter(r => Number(r.has_device) === 1).length
  };
  res.json({ success:true, data:{ notification, recipients:rows, summary } });
});

router.delete('/admin/:id', requireAdmin, (req, res) => {
  const db = getDB();
  const existing = db.prepare('SELECT id FROM notifications WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ success:false, message:'Notification not found' });
  db.prepare('DELETE FROM notifications WHERE id=?').run(req.params.id);
  res.json({ success:true, message:'Notification deleted' });
});

router.post('/send', requireAdmin, async (req, res) => {
  const title = clean(req.body?.title);
  const body = clean(req.body?.body);
  const audience = clean(req.body?.audience || 'all').toLowerCase();
  const classId = req.body?.class_id ? Number(req.body.class_id) : null;
  if (!title || !body) return res.status(400).json({ success:false, message:'Title and message are required' });
  if (!['all','teachers','learners','parents','class'].includes(audience)) return res.status(400).json({ success:false, message:'Invalid audience' });
  if (audience === 'class' && (!Number.isInteger(classId) || classId <= 0)) return res.status(400).json({ success:false, message:'Choose a class' });

  const db = getDB();
  const recipients = recipientsForAudience(db, audience, classId);
  if (!recipients.length) return res.status(400).json({ success:false, message:'No recipients found for this audience' });

  let notificationId;
  db.exec('BEGIN IMMEDIATE');
  try {
    notificationId = db.prepare(`
      INSERT INTO notifications (title, body, audience, target_class_id, created_by_role, created_by_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, body, audience, audience === 'class' ? classId : null, req.session.user.role, req.session.user.id).lastInsertRowid;
    const insertRecipient = db.prepare(`
      INSERT OR IGNORE INTO notification_recipients (notification_id, user_role, user_id)
      VALUES (?, ?, ?)
    `);
    recipients.forEach(r => insertRecipient.run(notificationId, r.user_role, r.user_id));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    return res.status(500).json({ success:false, message:error.message });
  }

  const clauses = recipients.map(() => '(user_role=? AND user_id=?)').join(' OR ');
  const params = recipients.flatMap(r => [r.user_role, r.user_id]);
  const tokenRows = clauses ? db.prepare(`SELECT DISTINCT token FROM device_tokens WHERE ${clauses}`).all(...params) : [];
  let push = { attempted:0, success:0, failed:0, skipped: isConfigured() ? 'No registered device tokens' : 'Firebase service account not configured' };
  if (tokenRows.length && isConfigured()) {
    push = await sendMulticast(tokenRows.map(r => r.token), {
      title,
      body,
      link:'/app/#notifications',
      data:{ notification_id:String(notificationId), audience }
    });
  }

  res.json({ success:true, message:`Sent to ${recipients.length} recipient(s)`, data:{ notification_id:notificationId, recipients:recipients.length, tokens:tokenRows.length, push } });
});

module.exports = router;
