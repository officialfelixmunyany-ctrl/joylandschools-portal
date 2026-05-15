const express = require('express');
const heicConvert = require('heic-convert');
const bcrypt  = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDB, calculateSchoolDays } = require('../database');
const { todayInSchoolTime } = require('../lib/dates');
const router  = express.Router();

function requireAdmin(req, res, next) {
  if (req.session.user?.role === 'admin' || req.session.user?.is_admin === 1) return next();
  const adminUser = req.session.roleUsers?.admin;
  if (!adminUser) return res.status(401).json({ success:false, message:'Admin session expired. Please log in as admin again.' });
  req.session.user = adminUser;
  next();
}
router.use(requireAdmin);

function noStore(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
}

function genId(prefix) { return prefix + Date.now().toString(36).toUpperCase().slice(-4) + Math.random().toString(36).toUpperCase().slice(2,5); }
function genTempCode() { return Math.random().toString(36).toUpperCase().slice(2,9); }
function cleanText(value) { return String(value || '').trim(); }
function publicSubjectCode(value) {
  const code = cleanText(value);
  return code && !/^SYSAUTO/i.test(code) ? code : null;
}
function nextTeacherLoginId(db) {
  const rows = db.prepare("SELECT user_id FROM users WHERE role='teacher' AND user_id GLOB 'T[0-9][0-9][0-9]'").all();
  const highest = rows.reduce((max, row) => Math.max(max, Number(row.user_id.slice(1)) || 0), 36);
  return `T${String(highest + 1).padStart(3, '0')}`;
}
function nextParentLoginId(db) {
  const rows = db.prepare("SELECT parent_id FROM parent_accounts WHERE parent_id GLOB 'P[0-9][0-9][0-9]'").all();
  const highest = rows.reduce((max, row) => Math.max(max, Number(row.parent_id.slice(1)) || 0), 0);
  return `P${String(highest + 1).padStart(3, '0')}`;
}
function optionalId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'learners');
const SCHOOL_UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'school');
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'jpg',
  'image/heif': 'jpg'
};

function ensureUploadDirs() {
  ['portraits', 'gallery'].forEach((dir) => fs.mkdirSync(path.join(UPLOAD_ROOT, dir), { recursive:true }));
}

async function parseImagePayload(body) {
  const dataUrl = cleanText(body.image_data);
  const directMime = cleanText(body.mime_type).toLowerCase();
  const imageMatch = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif|heic|heif));base64,(.+)$/i);
  const octetMatch = !imageMatch && dataUrl.match(/^data:(?:application\/octet-stream|);base64,(.+)$/i);
  let mime;
  let base64;
  if (imageMatch) {
    mime = imageMatch[1].toLowerCase();
    base64 = imageMatch[2];
  } else if (octetMatch) {
    mime = directMime;
    base64 = octetMatch[1];
  } else {
    mime = directMime;
    base64 = dataUrl;
  }
  if (!IMAGE_TYPES[mime]) throw new Error('Only JPG, PNG, WEBP, GIF, or HEIC images are allowed');
  if (!base64) throw new Error('Image data is required');
  let buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('Image file is empty');
  if (buffer.length > 10 * 1024 * 1024) throw new Error('Image must be 10MB or smaller');
  if (mime === 'image/heic' || mime === 'image/heif') {
    try {
      buffer = Buffer.from(await heicConvert({ buffer, format:'JPEG', quality:0.92 }));
      mime = 'image/jpeg';
    } catch {
      throw new Error('Could not convert HEIC image. Try saving it as JPEG on your device first.');
    }
  }
  return { buffer, mime, ext: IMAGE_TYPES[mime] };
}

function publicUploadPath(folder, fileName) {
  return `/uploads/learners/${folder}/${fileName}`;
}

function deletePublicUpload(filePath) {
  if (!filePath || !filePath.startsWith('/uploads/learners/')) return;
  const absolutePath = path.join(__dirname, '..', 'public', filePath.replace(/^\/+/, ''));
  const resolved = path.resolve(absolutePath);
  const root = path.resolve(UPLOAD_ROOT);
  if (!resolved.startsWith(root)) return;
  try { fs.unlinkSync(resolved); } catch {}
}

async function saveLearnerImage(learnerId, folder, body) {
  ensureUploadDirs();
  const { buffer, mime, ext } = await parseImagePayload(body);
  const fileName = `${learnerId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_ROOT, folder, fileName), buffer);
  return { file_path: publicUploadPath(folder, fileName), mime_type:mime };
}

function defaultSchoolSettings() {
  return {
    school_name:'JOYLAND SCHOOLS',
    school_motto:'Education Is Treasure',
    school_address:'P.O. Box 123',
    school_phone:'0700 000 000',
    school_email:'info@joylandschools.ac.ke',
    school_logo:'/uploads/school/logo.jpg',
    result_title:'END OF TERM REPORT CARD',
    footer_text:'',
    theme_color:'#d4147a',
    performance_target_average:'75'
  };
}

function getSchoolSettings(db) {
  const settings = defaultSchoolSettings();
  db.prepare('SELECT key, value FROM school_settings').all().forEach(row => {
    settings[row.key] = row.value || '';
  });
  return settings;
}

function saveSchoolSetting(db, key, value) {
  db.prepare(`
    INSERT INTO school_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')
  `).run(key, value == null ? '' : String(value));
}

async function saveSchoolAsset(body) {
  fs.mkdirSync(SCHOOL_UPLOAD_ROOT, { recursive:true });
  const { buffer, mime, ext } = await parseImagePayload(body);
  const rawType = cleanText(body.asset_type).toLowerCase();
  const assetType = ['logo', 'stamp', 'background'].includes(rawType) ? rawType : 'asset';
  const fileName = `${assetType}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(SCHOOL_UPLOAD_ROOT, fileName), buffer);
  return { file_path:`/uploads/school/${fileName}`, mime_type:mime };
}

function classNameFromInput(db, body) {
  const classId = optionalId(body.class_id);
  if (classId) {
    const row = db.prepare("SELECT name FROM classes WHERE id=?").get(classId);
    if (!row) throw new Error('Class not found');
    return row.name;
  }
  const className = cleanText(body.class_name);
  if (!className) return null;
  db.prepare("INSERT OR IGNORE INTO classes (name, grade_level, capacity) VALUES (?,?,40)").run(className, className);
  return className;
}

function teacherIdOrNull(db, value) {
  const id = optionalId(value);
  if (!id) return null;
  const teacher = db.prepare("SELECT id FROM users WHERE id=? AND role='teacher'").get(id);
  if (!teacher) throw new Error('Teacher not found');
  return id;
}

const ASSESSMENT_TYPES = ['midterm', 'endterm'];
// Assessment windows used by marks, skills, reports, and analytics.
const EXAM_ORDER = ASSESSMENT_TYPES;
const COMPONENT_KEY_RE = /^[a-z0-9_]+$/;

function getAssessmentComponents(db, classId, subjectId, assessmentType) {
  return db.prepare(`
    SELECT id, class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order
    FROM assessment_components
    WHERE class_id=? AND subject_id=? AND assessment_type=?
    ORDER BY sort_order, component_name
  `).all(classId, subjectId, assessmentType);
}

function getMaxScoreFor(db, classId, subjectId, assessmentType, componentKey) {
  const row = db.prepare(`
    SELECT max_score FROM assessment_components
    WHERE class_id=? AND subject_id=? AND assessment_type=? AND component_key=?
  `).get(classId, subjectId, assessmentType, componentKey);
  return row ? Number(row.max_score) : null;
}

// Sum component scores into a single total per (learner, subject, assessment_type)
function aggregateMarksByAssessment(rows) {
  const map = {}; // learner -> subject -> assessment -> totalScore
  rows.forEach((m) => {
    const lid = m.learner_id;
    const sid = m.subject_id;
    const at = m.assessment_type;
    if (m.score === null || m.score === undefined) return;
    map[lid] = map[lid] || {};
    map[lid][sid] = map[lid][sid] || {};
    map[lid][sid][at] = (map[lid][sid][at] || 0) + Number(m.score);
  });
  return map;
}
const CBC_LEVELS = [
  { code:'EE1', descriptor:'Exceeding Expectations', points:8, min:90, label:'Exceptional' },
  { code:'EE2', descriptor:'Exceeding Expectations', points:7, min:75, label:'Very Good' },
  { code:'ME1', descriptor:'Meeting Expectations', points:6, min:58, label:'Good' },
  { code:'ME2', descriptor:'Meeting Expectations', points:5, min:41, label:'Fair' },
  { code:'AE1', descriptor:'Approaching Expectations', points:4, min:31, label:'Needs Improvement' },
  { code:'AE2', descriptor:'Approaching Expectations', points:3, min:21, label:'Below Average' },
  { code:'BE1', descriptor:'Below Expectations', points:2, min:11, label:'Poor' },
  { code:'BE2', descriptor:'Below Expectations', points:1, min:0, label:'Very Poor' }
];

function cbcLevel(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  const score = Math.max(0, Math.min(100, Number(value)));
  return CBC_LEVELS.find(level => score >= level.min) || CBC_LEVELS[CBC_LEVELS.length - 1];
}

function averageNumbers(values) {
  const nums = values.filter(value => value !== null && value !== undefined && !Number.isNaN(Number(value))).map(Number);
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 100) / 100;
}

function subjectAverage(scores = {}) {
  return averageNumbers(ASSESSMENT_TYPES.map(type => scores[type]));
}

// --- SCHOOL SETTINGS -------------------------------------------------------
router.get('/school-settings', (req, res) => {
  const db = getDB();
  res.json({ success:true, data:getSchoolSettings(db) });
});

router.put('/school-settings', (req, res) => {
  const db = getDB();
  const allowed = new Set(Object.keys(defaultSchoolSettings()).concat(['school_stamp', 'background_image']));
  try {
    db.exec('BEGIN IMMEDIATE');
    Object.entries(req.body || {}).forEach(([key, value]) => {
      if (allowed.has(key)) saveSchoolSetting(db, key, value);
    });
    db.exec('COMMIT');
    res.json({ success:true, data:getSchoolSettings(db), message:'School settings saved' });
  } catch (e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.post('/school-assets', async (req, res) => {
  const db = getDB();
  try {
    const asset = await saveSchoolAsset(req.body || {});
    const rawType = cleanText(req.body?.asset_type).toLowerCase();
    const key = rawType === 'stamp' ? 'school_stamp' : rawType === 'background' ? 'background_image' : 'school_logo';
    saveSchoolSetting(db, key, asset.file_path);
    res.json({ success:true, data:{ ...asset, key }, message:'Image uploaded' });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

// ─── REPORT COMMENT BANK + SIGNATURES ─────────────────────────
const COMMENT_ROLES = ['class_teacher','headteacher','director'];
const SIGNATURE_UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'signatures');

function isValidCommentRole(value) { return COMMENT_ROLES.includes(String(value||'').toLowerCase()); }

router.get('/comment-bank', (req, res) => {
  const db = getDB();
  const role = req.query.role && isValidCommentRole(req.query.role) ? String(req.query.role).toLowerCase() : null;
  const classId = optionalId(req.query.class_id);
  let sql = 'SELECT * FROM report_comments WHERE 1=1';
  const params = [];
  if (role) { sql += ' AND role=?'; params.push(role); }
  if (classId === null && req.query.class_id !== undefined && req.query.class_id !== '') {
    // explicit empty → only globals
    sql += ' AND class_id IS NULL';
  } else if (classId) {
    sql += ' AND (class_id=? OR class_id IS NULL)';
    params.push(classId);
  }
  sql += ' ORDER BY role, class_id IS NULL DESC, sort_order, min_score DESC';
  const rows = db.prepare(sql).all(...params);
  res.json({ success:true, data:rows });
});

router.post('/comment-bank', (req, res) => {
  const db = getDB();
  const role = String(req.body.role||'').toLowerCase();
  if (!isValidCommentRole(role)) return res.json({ success:false, message:'Invalid role' });
  const minScore = Number(req.body.min_score);
  const maxScore = Number(req.body.max_score);
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore)) return res.json({ success:false, message:'Score range is required' });
  if (minScore < 0 || maxScore > 100 || minScore > maxScore) return res.json({ success:false, message:'Score range must be 0-100 with min ≤ max' });
  const commentText = cleanText(req.body.comment_text);
  if (!commentText) return res.json({ success:false, message:'Comment text is required' });
  const classId = optionalId(req.body.class_id);
  const sortOrder = Number(req.body.sort_order) || 0;
  const id = optionalId(req.body.id);
  try {
    if (id) {
      db.prepare(`UPDATE report_comments
        SET role=?, class_id=?, min_score=?, max_score=?, comment_text=?, sort_order=?, updated_at=datetime('now')
        WHERE id=?`).run(role, classId, minScore, maxScore, commentText, sortOrder, id);
      return res.json({ success:true, message:'Comment updated', id });
    }
    const result = db.prepare(`INSERT INTO report_comments
      (role, class_id, min_score, max_score, comment_text, sort_order)
      VALUES (?,?,?,?,?,?)`).run(role, classId, minScore, maxScore, commentText, sortOrder);
    res.json({ success:true, message:'Comment added', id: result.lastInsertRowid });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

router.delete('/comment-bank/:id', (req, res) => {
  const db = getDB();
  const id = optionalId(req.params.id);
  if (!id) return res.json({ success:false, message:'Invalid id' });
  const result = db.prepare('DELETE FROM report_comments WHERE id=?').run(id);
  res.json({ success: result.changes > 0, message: result.changes > 0 ? 'Removed' : 'Not found' });
});

router.post('/signature/:role', async (req, res) => {
  const role = String(req.params.role||'').toLowerCase();
  if (!isValidCommentRole(role)) return res.json({ success:false, message:'Invalid role' });
  const db = getDB();
  try {
    fs.mkdirSync(SIGNATURE_UPLOAD_ROOT, { recursive:true });
    const { buffer, mime, ext } = await parseImagePayload(req.body || {});
    const fileName = `signature-${role}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(SIGNATURE_UPLOAD_ROOT, fileName), buffer);
    const publicPath = `/uploads/signatures/${fileName}`;
    // Remove old file
    const oldPath = db.prepare("SELECT value FROM school_settings WHERE key=?").get(`signature_${role}`)?.value;
    if (oldPath && oldPath.startsWith('/uploads/signatures/')) {
      try { fs.unlinkSync(path.join(__dirname, '..', 'public', oldPath.replace(/^\/+/, ''))); } catch {}
    }
    saveSchoolSetting(db, `signature_${role}`, publicPath);
    res.json({ success:true, file_path:publicPath, mime_type:mime, message:'Signature uploaded' });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

router.delete('/signature/:role', (req, res) => {
  const role = String(req.params.role||'').toLowerCase();
  if (!isValidCommentRole(role)) return res.json({ success:false, message:'Invalid role' });
  const db = getDB();
  const key = `signature_${role}`;
  const oldPath = db.prepare("SELECT value FROM school_settings WHERE key=?").get(key)?.value;
  if (oldPath && oldPath.startsWith('/uploads/signatures/')) {
    try { fs.unlinkSync(path.join(__dirname, '..', 'public', oldPath.replace(/^\/+/, ''))); } catch {}
  }
  saveSchoolSetting(db, key, '');
  res.json({ success:true, message:'Signature removed' });
});

router.get('/signatures', (req, res) => {
  const db = getDB();
  const out = {};
  COMMENT_ROLES.forEach(role => {
    const row = db.prepare("SELECT value FROM school_settings WHERE key=?").get(`signature_${role}`);
    out[role] = row?.value || '';
  });
  res.json({ success:true, data:out });
});

// ─── STATS ───────────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getDB();
  const learners   = db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner'").get().c;
  const teachers   = db.prepare("SELECT COUNT(*) c FROM users WHERE role='teacher'").get().c;
  const sessions   = db.prepare("SELECT COUNT(*) c FROM academic_sessions").get().c;
  const classes    = db.prepare("SELECT COUNT(*) c FROM classes WHERE status='active'").get().c;
  const subjects   = db.prepare("SELECT COUNT(*) c FROM subjects WHERE status='active'").get().c;
  const active_session = db.prepare("SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1").get();
  const active_terms   = active_session ? db.prepare("SELECT COUNT(*) c FROM terms WHERE session_id=?").get(active_session.id).c : 0;
  res.json({ success:true, data:{ learners, teachers, classes, subjects, sessions, active_session, active_terms }});
});

// ─── CURRENT ASSESSMENT PERIOD ─────────────────────────────────
// Joyland uses two assessment windows inside each term: Midterm and Endterm.
// Auto-detection splits the term proportionally in half based on today's date.
// First half of the term maps to Midterm; second half maps to Endterm.
function detectAssessmentPeriod(term, todayStr) {
  const start = new Date(term.start_date);
  const end   = new Date(term.end_date);
  const today = todayStr ? new Date(todayStr) : new Date();
  const totalMs   = end.getTime() - start.getTime();
  const elapsedMs = today.getTime() - start.getTime();
  const totalWeeks = Math.max(1, Math.round(totalMs / (7 * 86400000)));
  if (elapsedMs < 0) {
    return { period:'pre-term', period_label:'Term not started', week_no:0, total_weeks:totalWeeks, progress_percent:0 };
  }
  if (elapsedMs > totalMs) {
    return { period:'break', period_label:'On break', week_no:totalWeeks, total_weeks:totalWeeks, progress_percent:100 };
  }
  const progress = elapsedMs / totalMs;
  const weekNo   = Math.min(totalWeeks, Math.max(1, Math.floor(elapsedMs / (7 * 86400000)) + 1));
  let period, periodLabel;
  if (progress < 1/2) { period = 'midterm'; periodLabel = 'Midterm'; }
  else                { period = 'endterm'; periodLabel = 'Endterm'; }
  return { period, period_label:periodLabel, week_no:weekNo, total_weeks:totalWeeks, progress_percent:Math.round(progress*100) };
}

router.get('/current-period', (req, res) => {
  const db = getDB();
  const today = todayInSchoolTime();

  // Term containing today
  const term = db.prepare(`
    SELECT t.*, s.name AS session_name FROM terms t
    JOIN academic_sessions s ON s.id = t.session_id
    WHERE date(t.start_date) <= date(?) AND date(t.end_date) >= date(?)
    ORDER BY t.start_date DESC LIMIT 1
  `).get(today, today);

  if (term) {
    const det = detectAssessmentPeriod(term);
    return res.json({
      success: true, in_term: true,
      session_name: term.session_name,
      term: { id:term.id, term_number:term.term_number, term_name:term.term_name, start_date:term.start_date, end_date:term.end_date },
      ...det
    });
  }

  // Otherwise — fall back to next upcoming term, or just say "break"
  const next = db.prepare(`
    SELECT t.*, s.name AS session_name FROM terms t
    JOIN academic_sessions s ON s.id = t.session_id
    WHERE date(t.start_date) > date(?)
    ORDER BY t.start_date ASC LIMIT 1
  `).get(today);

  if (next) {
    return res.json({
      success: true, in_term: false,
      session_name: next.session_name,
      term: { id:next.id, term_number:next.term_number, term_name:next.term_name, start_date:next.start_date, end_date:next.end_date },
      period: 'pre-term', period_label: 'Term not started',
      week_no: 0, total_weeks: 0, progress_percent: 0
    });
  }

  res.json({ success:true, in_term:false, period:'break', period_label:'No active term', term:null });
});

// ─── LEARNERS ─────────────────────────────────────────────────
router.get('/learners', (req, res) => {
  const db = getDB();
  const rows = db.prepare("SELECT id,user_id,name,email,phone,admission_no,class_name,sex,date_of_birth,address,portrait_path,status,temp_code,created_at FROM users WHERE role='learner' ORDER BY class_name, admission_no, name").all();
  res.json({ success:true, data:rows });
});

router.get('/learners/:id/profile', (req, res) => {
  const db = getDB();
  const learner = db.prepare(`
    SELECT id,user_id,name,email,phone,admission_no,class_name,sex,date_of_birth,address,portrait_path,status,temp_code,temp_code_expiry,created_at,updated_at
    FROM users
    WHERE id=? AND role='learner'
  `).get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });

  let classInfo = null;
  let subjects = [];
  let classmates = [];

  if (learner.class_name) {
    classInfo = db.prepare(`
      SELECT c.*, t.user_id AS class_teacher_user_id, t.name AS class_teacher_name,
             t.email AS class_teacher_email, t.phone AS class_teacher_phone,
             (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=c.name) AS enrollment_count
      FROM classes c
      LEFT JOIN users t ON t.id=c.class_teacher_id
      WHERE lower(c.name)=lower(?)
      LIMIT 1
    `).get(learner.class_name);

    if (classInfo) {
      subjects = db.prepare(`
        SELECT s.id, s.name, s.code, cs.teacher_id,
               t.user_id AS teacher_user_id, t.name AS teacher_name, t.email AS teacher_email, t.phone AS teacher_phone
        FROM class_subjects cs
        JOIN subjects s ON s.id=cs.subject_id
        LEFT JOIN users t ON t.id=cs.teacher_id
        WHERE cs.class_id=?
        ORDER BY s.name
      `).all(classInfo.id).map(row => ({ ...row, code:publicSubjectCode(row.code) }));
    }

    classmates = db.prepare(`
      SELECT id,user_id,name,admission_no,status
      FROM users
      WHERE role='learner' AND class_name=? AND id<>?
      ORDER BY admission_no, name
      LIMIT 20
    `).all(learner.class_name, learner.id);
  }

  const activeSession = db.prepare("SELECT id,year,name FROM academic_sessions WHERE is_active=1 LIMIT 1").get();
  const photos = db.prepare("SELECT id,title,file_path,mime_type,created_at FROM learner_photos WHERE learner_id=? ORDER BY created_at DESC, id DESC").all(learner.id);
  res.json({ success:true, data:{ learner, class:classInfo, subjects, classmates, photos, active_session:activeSession } });
});

router.post('/learners', (req, res) => {
  const { name, email, phone, admission_no, sex, date_of_birth, address, password } = req.body;
  if (!name || !password) return res.json({ success:false, message:'Name and password are required' });
  const db = getDB();
  const user_id = genId('LRN');
  try {
    const class_name = classNameFromInput(db, req.body);
    const result = db.prepare(`INSERT INTO users (user_id,name,email,phone,admission_no,class_name,sex,date_of_birth,address,password,role,status)
                VALUES (?,?,?,?,?,?,?,?,?,?,'learner','active')`)
      .run(user_id, name.trim(), email||null, phone||null, admission_no||null, class_name||null, cleanText(sex)||null, cleanText(date_of_birth)||null, cleanText(address)||null, bcrypt.hashSync(password,10));
    res.json({ success:true, message:'Learner added successfully', id:result.lastInsertRowid, user_id });
  } catch(e) {
    res.json({ success:false, message: e.message.includes('UNIQUE') ? 'User ID conflict, try again' : e.message });
  }
});

router.put('/learners/:id', (req, res) => {
  const { name, email, phone, admission_no, sex, date_of_birth, address, password } = req.body;
  const db = getDB();
  let class_name;
  try {
    class_name = classNameFromInput(db, req.body);
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
  if (password) db.prepare("UPDATE users SET password=?,updated_at=datetime('now') WHERE id=? AND role='learner'").run(bcrypt.hashSync(password,10), req.params.id);
  db.prepare(`UPDATE users SET name=?,email=?,phone=?,admission_no=?,class_name=?,sex=?,date_of_birth=?,address=?,updated_at=datetime('now') WHERE id=? AND role='learner'`)
    .run(name, email||null, phone||null, admission_no||null, class_name||null, cleanText(sex)||null, cleanText(date_of_birth)||null, cleanText(address)||null, req.params.id);
  res.json({ success:true, message:'Learner updated' });
});

router.patch('/learners/:id/class', (req, res) => {
  const db = getDB();
  let className;
  try {
    className = classNameFromInput(db, req.body);
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
  const result = db.prepare("UPDATE users SET class_name=?,updated_at=datetime('now') WHERE id=? AND role='learner'").run(className, req.params.id);
  if (!result.changes) return res.json({ success:false, message:'Learner not found' });
  res.json({ success:true, message:className ? 'Learner assigned to class' : 'Learner unassigned from class' });
});

router.patch('/learners/class', (req, res) => {
  const db = getDB();
  const ids = Array.isArray(req.body.learner_ids) ? req.body.learner_ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.json({ success:false, message:'Select at least one learner' });
  let className;
  try {
    className = classNameFromInput(db, req.body);
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
  const update = db.prepare("UPDATE users SET class_name=?,updated_at=datetime('now') WHERE id=? AND role='learner'");
  try {
    db.exec('BEGIN IMMEDIATE');
    ids.forEach(id => update.run(className, id));
    db.exec('COMMIT');
    res.json({ success:true, message:className ? `Assigned ${ids.length} learner(s)` : `Unassigned ${ids.length} learner(s)` });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.delete('/learners/:id', (req, res) => {
  const db = getDB();
  const learner = db.prepare("SELECT id,portrait_path FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  const photos = db.prepare("SELECT file_path FROM learner_photos WHERE learner_id=?").all(learner.id);
  db.prepare("DELETE FROM users WHERE id=? AND role='learner'").run(learner.id);
  const files = new Set(photos.map(photo => photo.file_path));
  if (learner.portrait_path) files.add(learner.portrait_path);
  files.forEach(deletePublicUpload);
  res.json({ success:true, message:'Learner deleted' });
});

router.patch('/learners/:id/status', (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT status FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!user) return res.json({ success:false, message:'Not found' });
  const newStatus = user.status === 'active' ? 'inactive' : 'active';
  db.prepare("UPDATE users SET status=?,updated_at=datetime('now') WHERE id=?").run(newStatus, req.params.id);
  res.json({ success:true, message:`Access ${newStatus === 'active' ? 'activated' : 'deactivated'}`, status:newStatus });
});

router.patch('/learners/status', (req, res) => {
  const ids = Array.isArray(req.body.learner_ids) ? req.body.learner_ids.map(Number).filter(Number.isInteger) : [];
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  if (!ids.length) return res.json({ success:false, message:'Select at least one learner' });
  const db = getDB();
  const update = db.prepare("UPDATE users SET status=?,updated_at=datetime('now') WHERE id=? AND role='learner'");
  try {
    db.exec('BEGIN IMMEDIATE');
    ids.forEach(id => update.run(status, id));
    db.exec('COMMIT');
    res.json({ success:true, message:`${status === 'active' ? 'Activated' : 'Deactivated'} ${ids.length} learner(s)` });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.post('/learners/:id/temp-code', (req, res) => {
  const code   = genTempCode();
  const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
  getDB().prepare("UPDATE users SET temp_code=?,temp_code_expiry=?,updated_at=datetime('now') WHERE id=? AND role='learner'").run(code, expiry, req.params.id);
  res.json({ success:true, temp_code:code, message:'Temporary code generated (valid 24 hours)' });
});

router.post('/learners/temp-codes', (req, res) => {
  const ids = Array.isArray(req.body.learner_ids) ? req.body.learner_ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.json({ success:false, message:'Select at least one learner' });
  const db = getDB();
  const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
  const find = db.prepare("SELECT id,user_id,name FROM users WHERE id=? AND role='learner'");
  const update = db.prepare("UPDATE users SET temp_code=?,temp_code_expiry=?,updated_at=datetime('now') WHERE id=? AND role='learner'");
  const codes = [];
  try {
    db.exec('BEGIN IMMEDIATE');
    ids.forEach(id => {
      const learner = find.get(id);
      if (!learner) return;
      const code = genTempCode();
      update.run(code, expiry, id);
      codes.push({ id, user_id:learner.user_id, name:learner.name, temp_code:code });
    });
    db.exec('COMMIT');
    res.json({ success:true, message:`Generated ${codes.length} temp code(s)`, codes, expiry });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

// ─── TEACHERS ─────────────────────────────────────────────────
router.post('/learners/:id/portrait', async (req, res) => {
  const db = getDB();
  const learner = db.prepare("SELECT id,portrait_path FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  try {
    const saved = await saveLearnerImage(learner.id, 'portraits', req.body);
    db.prepare("UPDATE users SET portrait_path=?,updated_at=datetime('now') WHERE id=? AND role='learner'").run(saved.file_path, learner.id);
    if (learner.portrait_path && learner.portrait_path !== saved.file_path && learner.portrait_path.includes('/portraits/')) {
      deletePublicUpload(learner.portrait_path);
    }
    res.json({ success:true, message:'Learner portrait saved', portrait_path:saved.file_path });
  } catch(e) {
    res.json({ success:false, message:e.message });
  }
});

router.post('/learners/:id/photos', async (req, res) => {
  const db = getDB();
  const learner = db.prepare("SELECT id FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  try {
    const saved = await saveLearnerImage(learner.id, 'gallery', req.body);
    const title = cleanText(req.body.title) || null;
    const id = db.prepare("INSERT INTO learner_photos (learner_id,title,file_path,mime_type) VALUES (?,?,?,?)")
      .run(learner.id, title, saved.file_path, saved.mime_type).lastInsertRowid;
    res.json({ success:true, message:'Learner photo saved', photo:{ id, title, ...saved } });
  } catch(e) {
    res.json({ success:false, message:e.message });
  }
});

router.patch('/learners/:id/portrait-from-photo/:photoId', (req, res) => {
  const db = getDB();
  const learner = db.prepare("SELECT id,portrait_path FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  const photo = db.prepare("SELECT file_path FROM learner_photos WHERE id=? AND learner_id=?").get(req.params.photoId, learner.id);
  if (!photo) return res.json({ success:false, message:'Photo not found' });
  db.prepare("UPDATE users SET portrait_path=?,updated_at=datetime('now') WHERE id=? AND role='learner'").run(photo.file_path, learner.id);
  if (learner.portrait_path && learner.portrait_path !== photo.file_path && learner.portrait_path.includes('/portraits/')) {
    deletePublicUpload(learner.portrait_path);
  }
  res.json({ success:true, message:'Portrait assigned from learner photo', portrait_path:photo.file_path });
});

router.delete('/learners/:id/photos/:photoId', (req, res) => {
  const db = getDB();
  const learner = db.prepare("SELECT id,portrait_path FROM users WHERE id=? AND role='learner'").get(req.params.id);
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  const photo = db.prepare("SELECT id,file_path FROM learner_photos WHERE id=? AND learner_id=?").get(req.params.photoId, learner.id);
  if (!photo) return res.json({ success:false, message:'Photo not found' });
  db.prepare("DELETE FROM learner_photos WHERE id=? AND learner_id=?").run(photo.id, learner.id);
  if (learner.portrait_path === photo.file_path) {
    db.prepare("UPDATE users SET portrait_path=NULL,updated_at=datetime('now') WHERE id=?").run(learner.id);
  }
  deletePublicUpload(photo.file_path);
  res.json({ success:true, message:'Learner photo deleted' });
});

router.get('/teachers', (req, res) => {
  const rows = getDB().prepare("SELECT id,user_id,name,email,phone,subject,is_admin,status,temp_code,created_at FROM users WHERE role='teacher' ORDER BY name").all();
  res.json({ success:true, data:rows });
});

router.post('/teachers', (req, res) => {
  const { name, email, phone, subject, password } = req.body;
  if (!name || !password) return res.json({ success:false, message:'Name and password are required' });
  const db = getDB();
  const user_id = nextTeacherLoginId(db);
  try {
    db.prepare(`INSERT INTO users (user_id,name,email,phone,subject,password,role,status)
                VALUES (?,?,?,?,?,?,'teacher','active')`)
      .run(user_id, name.trim(), email||null, phone||null, subject||null, bcrypt.hashSync(password,10));
    res.json({ success:true, message:'Teacher added successfully', user_id });
  } catch(e) {
    res.json({ success:false, message: e.message });
  }
});

router.put('/teachers/:id', (req, res) => {
  const { name, email, phone, subject, password } = req.body;
  const db = getDB();
  if (password) db.prepare("UPDATE users SET password=?,updated_at=datetime('now') WHERE id=? AND role='teacher'").run(bcrypt.hashSync(password,10), req.params.id);
  db.prepare(`UPDATE users SET name=?,email=?,phone=?,subject=?,updated_at=datetime('now') WHERE id=? AND role='teacher'`)
    .run(name, email||null, phone||null, subject||null, req.params.id);
  res.json({ success:true, message:'Teacher updated' });
});

router.delete('/teachers/:id', (req, res) => {
  getDB().prepare("DELETE FROM users WHERE id=? AND role='teacher'").run(req.params.id);
  res.json({ success:true, message:'Teacher deleted' });
});

router.patch('/teachers/:id/status', (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT status FROM users WHERE id=? AND role='teacher'").get(req.params.id);
  if (!user) return res.json({ success:false, message:'Not found' });
  const newStatus = user.status === 'active' ? 'inactive' : 'active';
  db.prepare("UPDATE users SET status=?,updated_at=datetime('now') WHERE id=?").run(newStatus, req.params.id);
  res.json({ success:true, message:`Access ${newStatus === 'active' ? 'activated' : 'deactivated'}`, status:newStatus });
});

router.patch('/teachers/:id/make-admin', (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT is_admin FROM users WHERE id=? AND role='teacher'").get(req.params.id);
  if (!user) return res.json({ success:false, message:'Not found' });
  const newVal = user.is_admin ? 0 : 1;
  db.prepare("UPDATE users SET is_admin=?,updated_at=datetime('now') WHERE id=?").run(newVal, req.params.id);
  res.json({ success:true, message: newVal ? 'Admin access granted' : 'Admin access revoked', is_admin:newVal });
});

router.post('/teachers/:id/temp-code', (req, res) => {
  const code   = genTempCode();
  const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
  getDB().prepare("UPDATE users SET temp_code=?,temp_code_expiry=?,updated_at=datetime('now') WHERE id=? AND role='teacher'").run(code, expiry, req.params.id);
  res.json({ success:true, temp_code:code, message:'Temporary code generated (valid 24 hours)' });
});

// PARENTS
router.get('/parents', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT p.id, p.parent_id AS user_id, p.name, p.email, p.phone, p.status, p.temp_code, p.created_at,
      (SELECT COUNT(*) FROM parent_learner_links pll WHERE pll.parent_id=p.id) AS children_count
    FROM parent_accounts p
    ORDER BY p.name
  `).all();
  res.json({ success:true, data:rows });
});

router.get('/parents/:id', (req, res) => {
  const db = getDB();
  const parent = db.prepare(`
    SELECT id, parent_id AS user_id, name, email, phone, status, temp_code, temp_code_expiry, created_at, updated_at
    FROM parent_accounts WHERE id=?
  `).get(req.params.id);
  if (!parent) return res.json({ success:false, message:'Parent not found' });
  const children = db.prepare(`
    SELECT u.id, u.user_id, u.name, u.admission_no, u.class_name, u.status, pll.relationship
    FROM parent_learner_links pll
    JOIN users u ON u.id=pll.learner_id
    WHERE pll.parent_id=?
    ORDER BY u.class_name, u.name
  `).all(parent.id);
  res.json({ success:true, data:{ parent, children } });
});

router.post('/parents', (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!cleanText(name) || !cleanText(password)) return res.json({ success:false, message:'Name and password are required' });
  const db = getDB();
  const parentId = nextParentLoginId(db);
  try {
    const id = db.prepare(`
      INSERT INTO parent_accounts (parent_id, name, email, phone, password, status)
      VALUES (?, ?, ?, ?, ?, 'active')
    `).run(parentId, cleanText(name), cleanText(email) || null, cleanText(phone) || null, bcrypt.hashSync(password, 10)).lastInsertRowid;
    res.json({ success:true, message:'Parent added successfully', id, user_id:parentId });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

router.put('/parents/:id', (req, res) => {
  const { name, email, phone, password } = req.body;
  const db = getDB();
  const parent = db.prepare("SELECT id FROM parent_accounts WHERE id=?").get(req.params.id);
  if (!parent) return res.json({ success:false, message:'Parent not found' });
  try {
    if (password) db.prepare("UPDATE parent_accounts SET password=?,updated_at=datetime('now') WHERE id=?").run(bcrypt.hashSync(password, 10), parent.id);
    db.prepare(`
      UPDATE parent_accounts SET name=?, email=?, phone=?, updated_at=datetime('now') WHERE id=?
    `).run(cleanText(name), cleanText(email) || null, cleanText(phone) || null, parent.id);
    res.json({ success:true, message:'Parent updated' });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

router.patch('/parents/:id/status', (req, res) => {
  const db = getDB();
  const parent = db.prepare("SELECT status FROM parent_accounts WHERE id=?").get(req.params.id);
  if (!parent) return res.json({ success:false, message:'Parent not found' });
  const newStatus = parent.status === 'active' ? 'inactive' : 'active';
  db.prepare("UPDATE parent_accounts SET status=?,updated_at=datetime('now') WHERE id=?").run(newStatus, req.params.id);
  res.json({ success:true, message:`Access ${newStatus === 'active' ? 'activated' : 'deactivated'}`, status:newStatus });
});

router.delete('/parents/:id', (req, res) => {
  getDB().prepare("DELETE FROM parent_accounts WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Parent deleted' });
});

router.post('/parents/:id/temp-code', (req, res) => {
  const code = genTempCode();
  const expiry = new Date(Date.now() + 24*60*60*1000).toISOString();
  getDB().prepare("UPDATE parent_accounts SET temp_code=?,temp_code_expiry=?,updated_at=datetime('now') WHERE id=?").run(code, expiry, req.params.id);
  res.json({ success:true, temp_code:code, message:'Temporary code generated (valid 24 hours)' });
});

router.post('/parents/:id/children', (req, res) => {
  const db = getDB();
  const parent = db.prepare("SELECT id FROM parent_accounts WHERE id=?").get(req.params.id);
  if (!parent) return res.json({ success:false, message:'Parent not found' });
  const learnerId = optionalId(req.body.learner_id);
  const learner = learnerId ? db.prepare("SELECT id FROM users WHERE id=? AND role='learner'").get(learnerId) : null;
  if (!learner) return res.json({ success:false, message:'Learner not found' });
  try {
    db.prepare(`
      INSERT INTO parent_learner_links (parent_id, learner_id, relationship)
      VALUES (?, ?, ?)
      ON CONFLICT(parent_id, learner_id) DO UPDATE SET relationship=excluded.relationship
    `).run(parent.id, learner.id, cleanText(req.body.relationship) || null);
    res.json({ success:true, message:'Child linked to parent' });
  } catch (e) {
    res.json({ success:false, message:e.message });
  }
});

router.delete('/parents/:id/children/:learnerId', (req, res) => {
  getDB().prepare("DELETE FROM parent_learner_links WHERE parent_id=? AND learner_id=?").run(req.params.id, req.params.learnerId);
  res.json({ success:true, message:'Child unlinked from parent' });
});

// ACADEMICS: CLASSES
router.get('/classes', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT c.*, t.name AS class_teacher_name,
      (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=c.name) AS enrollment_count,
      (SELECT COUNT(*) FROM class_subjects cs WHERE cs.class_id=c.id) AS subject_count
    FROM classes c
    LEFT JOIN users t ON t.id=c.class_teacher_id
    ORDER BY c.name
  `).all();
  res.json({ success:true, data:rows });
});

router.post('/classes', (req, res) => {
  const db = getDB();
  const name = cleanText(req.body.name);
  if (!name) return res.json({ success:false, message:'Class name is required' });
  const gradeLevel = cleanText(req.body.grade_level) || name;
  const capacity = optionalId(req.body.capacity) || 40;
  const templateName = cleanText(req.body.template_name) || null;
  try {
    const classTeacherId = teacherIdOrNull(db, req.body.class_teacher_id);
    const id = db.prepare(`
      INSERT INTO classes (name, grade_level, class_teacher_id, capacity, template_name, status)
      VALUES (?,?,?,?,?, 'active')
    `).run(name, gradeLevel, classTeacherId, capacity, templateName).lastInsertRowid;
    res.json({ success:true, message:'Class created', id });
  } catch(e) {
    res.json({ success:false, message:e.message.includes('UNIQUE') ? 'Class already exists' : e.message });
  }
});

router.put('/classes/:id', (req, res) => {
  const db = getDB();
  const existing = db.prepare("SELECT * FROM classes WHERE id=?").get(req.params.id);
  if (!existing) return res.json({ success:false, message:'Class not found' });
  const name = cleanText(req.body.name);
  if (!name) return res.json({ success:false, message:'Class name is required' });
  const gradeLevel = cleanText(req.body.grade_level) || name;
  const capacity = optionalId(req.body.capacity) || 40;
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  const templateName = cleanText(req.body.template_name) || null;
  let classTeacherId;
  try {
    classTeacherId = teacherIdOrNull(db, req.body.class_teacher_id);
  } catch(e) {
    return res.json({ success:false, message:e.message });
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      UPDATE classes
      SET name=?, grade_level=?, class_teacher_id=?, capacity=?, template_name=?, status=?, updated_at=datetime('now')
      WHERE id=?
    `).run(name, gradeLevel, classTeacherId, capacity, templateName, status, req.params.id);
    const oldTeacherId = existing.class_teacher_id ? Number(existing.class_teacher_id) : null;
    const newTeacherId = classTeacherId ? Number(classTeacherId) : null;
    if (oldTeacherId !== newTeacherId) {
      if (oldTeacherId) {
        db.prepare(`
          UPDATE class_subjects
          SET teacher_id=NULL, updated_at=datetime('now')
          WHERE class_id=? AND teacher_id=?
        `).run(req.params.id, oldTeacherId);
      }
      if (newTeacherId) {
        db.prepare(`
          UPDATE class_subjects
          SET teacher_id=?, updated_at=datetime('now')
          WHERE class_id=? AND teacher_id IS NULL
        `).run(newTeacherId, req.params.id);
      }
    }
    if (existing.name !== name) {
      db.prepare("UPDATE users SET class_name=?,updated_at=datetime('now') WHERE role='learner' AND class_name=?").run(name, existing.name);
    }
    db.exec('COMMIT');
    res.json({ success:true, message:'Class updated' });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message.includes('UNIQUE') ? 'Class already exists' : e.message });
  }
});

router.delete('/classes/:id', (req, res) => {
  const db = getDB();
  const row = db.prepare("SELECT * FROM classes WHERE id=?").get(req.params.id);
  if (!row) return res.json({ success:false, message:'Class not found' });
  const enrolled = db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner' AND class_name=?").get(row.name).c;
  if (enrolled) return res.json({ success:false, message:`Move or unassign ${enrolled} learner(s) before deleting this class` });
  db.prepare("DELETE FROM classes WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Class deleted' });
});

router.get('/classes/:id/learners', (req, res) => {
  const db = getDB();
  const row = db.prepare("SELECT * FROM classes WHERE id=?").get(req.params.id);
  if (!row) return res.json({ success:false, message:'Class not found' });
  const learners = db.prepare("SELECT id,user_id,name,admission_no,class_name,status FROM users WHERE role='learner' AND class_name=? ORDER BY admission_no, name").all(row.name);
  res.json({ success:true, data:{ class:row, learners } });
});

// ACADEMICS: SUBJECTS
router.get('/subjects', (req, res) => {
  const rows = getDB().prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM class_subjects cs WHERE cs.subject_id=s.id) AS class_count
    FROM subjects s
    ORDER BY s.name
  `).all();
  res.json({ success:true, data:rows.map(row => ({ ...row, code:publicSubjectCode(row.code) })) });
});

router.post('/subjects', (req, res) => {
  const db = getDB();
  const name = cleanText(req.body.name);
  if (!name) return res.json({ success:false, message:'Subject name is required' });
  try {
    const id = db.prepare("INSERT INTO subjects (name, code, status) VALUES (?,?,'active')").run(name, cleanText(req.body.code) || null).lastInsertRowid;
    res.json({ success:true, message:'Subject created', id });
  } catch(e) {
    res.json({ success:false, message:e.message.includes('UNIQUE') ? 'Subject already exists' : e.message });
  }
});

router.put('/subjects/:id', (req, res) => {
  const db = getDB();
  const name = cleanText(req.body.name);
  if (!name) return res.json({ success:false, message:'Subject name is required' });
  const status = req.body.status === 'inactive' ? 'inactive' : 'active';
  try {
    const result = db.prepare("UPDATE subjects SET name=?,code=?,status=?,updated_at=datetime('now') WHERE id=?")
      .run(name, cleanText(req.body.code) || null, status, req.params.id);
    if (!result.changes) return res.json({ success:false, message:'Subject not found' });
    res.json({ success:true, message:'Subject updated' });
  } catch(e) {
    res.json({ success:false, message:e.message.includes('UNIQUE') ? 'Subject already exists' : e.message });
  }
});

router.delete('/subjects/:id', (req, res) => {
  const db = getDB();
  const assigned = db.prepare("SELECT COUNT(*) c FROM class_subjects WHERE subject_id=?").get(req.params.id).c;
  if (assigned) return res.json({ success:false, message:`Remove this subject from ${assigned} class(es) before deleting it` });
  const result = db.prepare("DELETE FROM subjects WHERE id=?").run(req.params.id);
  if (!result.changes) return res.json({ success:false, message:'Subject not found' });
  res.json({ success:true, message:'Subject deleted' });
});

// ACADEMICS: CLASS SUBJECTS
router.get('/class-subjects', (req, res) => {
  const rows = getDB().prepare(`
    SELECT cs.id, cs.class_id, cs.subject_id, cs.teacher_id,
           c.name AS class_name, c.grade_level,
           s.name AS subject_name, s.code AS subject_code,
           t.name AS teacher_name
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    LEFT JOIN users t ON t.id=cs.teacher_id
    ORDER BY c.name, s.name
  `).all();
  res.json({ success:true, data:rows.map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) })) });
});

router.post('/classes/:id/subjects', (req, res) => {
  const db = getDB();
  const classRow = db.prepare("SELECT id FROM classes WHERE id=?").get(req.params.id);
  if (!classRow) return res.json({ success:false, message:'Class not found' });
  const subjectId = optionalId(req.body.subject_id);
  if (!subjectId || !db.prepare("SELECT id FROM subjects WHERE id=?").get(subjectId)) {
    return res.json({ success:false, message:'Subject not found' });
  }
  try {
    const teacherId = teacherIdOrNull(db, req.body.teacher_id);
    db.prepare(`
      INSERT INTO class_subjects (class_id, subject_id, teacher_id)
      VALUES (?,?,?)
      ON CONFLICT(class_id, subject_id) DO UPDATE SET teacher_id=excluded.teacher_id, updated_at=datetime('now')
    `).run(req.params.id, subjectId, teacherId);
    // Seed default 'exam' component for this class+subject across all 3 assessments
    const seed = db.prepare(`INSERT OR IGNORE INTO assessment_components (class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order) VALUES (?, ?, ?, 'exam', 'Exam', 100, 0)`);
    ASSESSMENT_TYPES.forEach(at => seed.run(req.params.id, subjectId, at));
    res.json({ success:true, message:'Subject assigned to class' });
  } catch(e) {
    res.json({ success:false, message:e.message });
  }
});

router.put('/class-subjects/:id', (req, res) => {
  const db = getDB();
  try {
    const teacherId = teacherIdOrNull(db, req.body.teacher_id);
    const result = db.prepare("UPDATE class_subjects SET teacher_id=?,updated_at=datetime('now') WHERE id=?").run(teacherId, req.params.id);
    if (!result.changes) return res.json({ success:false, message:'Class subject not found' });
    res.json({ success:true, message:'Subject teacher updated' });
  } catch(e) {
    res.json({ success:false, message:e.message });
  }
});

router.delete('/class-subjects/:id', (req, res) => {
  const result = getDB().prepare("DELETE FROM class_subjects WHERE id=?").run(req.params.id);
  if (!result.changes) return res.json({ success:false, message:'Class subject not found' });
  res.json({ success:true, message:'Subject removed from class' });
});

router.post('/classes/:id/subjects/copy', (req, res) => {
  const db = getDB();
  const targetId = optionalId(req.params.id);
  const sourceId = optionalId(req.body.from_class_id);
  if (!targetId || !db.prepare("SELECT id FROM classes WHERE id=?").get(targetId)) return res.json({ success:false, message:'Target class not found' });
  if (!sourceId || !db.prepare("SELECT id FROM classes WHERE id=?").get(sourceId)) return res.json({ success:false, message:'Source class not found' });
  if (targetId === sourceId) return res.json({ success:false, message:'Choose a different target class' });
  try {
    db.exec('BEGIN IMMEDIATE');
    if (req.body.replace) db.prepare("DELETE FROM class_subjects WHERE class_id=?").run(targetId);
    db.prepare(`
      INSERT OR IGNORE INTO class_subjects (class_id, subject_id, teacher_id)
      SELECT ?, subject_id, teacher_id
      FROM class_subjects
      WHERE class_id=?
    `).run(targetId, sourceId);
    const count = db.prepare("SELECT COUNT(*) c FROM class_subjects WHERE class_id=?").get(targetId).c;
    db.exec('COMMIT');
    res.json({ success:true, message:`Class now has ${count} subject(s)` });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

// ─── SESSIONS ─────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  const db = getDB();
  const sessions = db.prepare("SELECT * FROM academic_sessions ORDER BY year DESC").all();
  const result = sessions.map(s => ({
    ...s,
    terms: db.prepare("SELECT * FROM terms WHERE session_id=? ORDER BY term_number").all(s.id)
  }));
  res.json({ success:true, data:result });
});

router.post('/sessions', (req, res) => {
  const { year, name } = req.body;
  if (!year || !name) return res.json({ success:false, message:'Year and name are required' });
  try {
    const id = getDB().prepare("INSERT INTO academic_sessions (year,name,is_active) VALUES (?,?,0)").run(year, name).lastInsertRowid;
    res.json({ success:true, message:'Session created', id });
  } catch(e) { res.json({ success:false, message:e.message }); }
});

router.put('/sessions/:id', (req, res) => {
  const { year, name } = req.body;
  getDB().prepare("UPDATE academic_sessions SET year=?,name=? WHERE id=?").run(year, name, req.params.id);
  res.json({ success:true, message:'Session updated' });
});

router.delete('/sessions/:id', (req, res) => {
  getDB().prepare("DELETE FROM academic_sessions WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Session deleted' });
});

router.patch('/sessions/:id/activate', (req, res) => {
  const db = getDB();
  db.prepare("UPDATE academic_sessions SET is_active=0").run();
  db.prepare("UPDATE academic_sessions SET is_active=1 WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Session activated' });
});

// ─── TERMS ────────────────────────────────────────────────────
router.get('/sessions/:sid/terms', (req, res) => {
  const db = getDB();
  const terms = db.prepare("SELECT * FROM terms WHERE session_id=? ORDER BY term_number").all(req.params.sid);
  const enriched = terms.map(t => {
    const holidays = db.prepare("SELECT * FROM holidays WHERE term_id=? ORDER BY start_date").all(t.id);
    const weekdays = JSON.parse(t.weekdays || '[]');
    return { ...t, weekdays, holidays, school_days: calculateSchoolDays(t.start_date, t.end_date, weekdays, holidays) };
  });
  res.json({ success:true, data:enriched });
});

router.post('/sessions/:sid/terms', (req, res) => {
  const { term_number, term_name, start_date, end_date, weekdays } = req.body;
  if (!term_name || !start_date || !end_date) return res.json({ success:false, message:'Term name and dates are required' });
  const wdJson = JSON.stringify(weekdays || ['Monday','Tuesday','Wednesday','Thursday','Friday']);
  const id = getDB().prepare("INSERT INTO terms (session_id,term_number,term_name,start_date,end_date,weekdays) VALUES (?,?,?,?,?,?)")
                    .run(req.params.sid, term_number||1, term_name, start_date, end_date, wdJson).lastInsertRowid;
  res.json({ success:true, message:'Term created', id });
});

router.put('/terms/:id', (req, res) => {
  const { term_number, term_name, start_date, end_date, weekdays } = req.body;
  const wdJson = JSON.stringify(weekdays || ['Monday','Tuesday','Wednesday','Thursday','Friday']);
  getDB().prepare("UPDATE terms SET term_number=?,term_name=?,start_date=?,end_date=?,weekdays=? WHERE id=?")
         .run(term_number, term_name, start_date, end_date, wdJson, req.params.id);
  res.json({ success:true, message:'Term updated' });
});

router.delete('/terms/:id', (req, res) => {
  getDB().prepare("DELETE FROM terms WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Term deleted' });
});

router.get('/terms/:id/calc', (req, res) => {
  const db = getDB();
  const term = db.prepare("SELECT * FROM terms WHERE id=?").get(req.params.id);
  if (!term) return res.json({ success:false });
  const holidays = db.prepare("SELECT * FROM holidays WHERE term_id=?").all(term.id);
  const weekdays = JSON.parse(term.weekdays || '[]');
  res.json({ success:true, school_days: calculateSchoolDays(term.start_date, term.end_date, weekdays, holidays) });
});

// ─── HOLIDAYS ─────────────────────────────────────────────────
router.get('/terms/:tid/holidays', (req, res) => {
  const rows = getDB().prepare("SELECT * FROM holidays WHERE term_id=? ORDER BY start_date").all(req.params.tid);
  res.json({ success:true, data:rows });
});

router.post('/terms/:tid/holidays', (req, res) => {
  const { name, start_date, end_date } = req.body;
  if (!name || !start_date || !end_date) return res.json({ success:false, message:'All fields required' });
  const id = getDB().prepare("INSERT INTO holidays (term_id,name,start_date,end_date) VALUES (?,?,?,?)").run(req.params.tid, name, start_date, end_date).lastInsertRowid;
  res.json({ success:true, message:'Holiday added', id });
});

router.put('/holidays/:id', (req, res) => {
  const { name, start_date, end_date } = req.body;
  getDB().prepare("UPDATE holidays SET name=?,start_date=?,end_date=? WHERE id=?").run(name, start_date, end_date, req.params.id);
  res.json({ success:true, message:'Holiday updated' });
});

router.delete('/holidays/:id', (req, res) => {
  getDB().prepare("DELETE FROM holidays WHERE id=?").run(req.params.id);
  res.json({ success:true, message:'Holiday deleted' });
});

// ─── PROFILE & ADMINS ─────────────────────────────────────────
router.get('/profile', (req, res) => {
  const user = getDB().prepare("SELECT id,user_id,name,email,phone,role,is_admin,created_at FROM users WHERE id=?").get(req.session.user.id);
  res.json({ success:true, data:user });
});

router.put('/profile/password', (req, res) => {
  const { current_password, new_password } = req.body;
  const db = getDB();
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) return res.json({ success:false, message:'Current password is incorrect' });
  db.prepare("UPDATE users SET password=?,updated_at=datetime('now') WHERE id=?").run(bcrypt.hashSync(new_password,10), user.id);
  res.json({ success:true, message:'Password changed successfully' });
});

router.get('/admins', (req, res) => {
  const rows = getDB().prepare("SELECT id,user_id,name,email,role,is_admin,status,created_at FROM users WHERE role='admin' OR is_admin=1 ORDER BY name").all();
  res.json({ success:true, data:rows });
});

router.post('/admins', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !password) return res.json({ success:false, message:'Name and password are required' });
  const db = getDB();
  const user_id = genId('ADM');
  try {
    db.prepare(`INSERT INTO users (user_id,name,email,password,role,is_admin,status) VALUES (?,?,?,?,'admin',1,'active')`)
      .run(user_id, name.trim(), email||null, bcrypt.hashSync(password,10));
    res.json({ success:true, message:'Admin added successfully', user_id });
  } catch(e) { res.json({ success:false, message:e.message }); }
});

router.delete('/admins/:id', (req, res) => {
  if (req.params.id == req.session.user.id) return res.json({ success:false, message:"You can't delete yourself" });
  getDB().prepare("DELETE FROM users WHERE id=? AND role='admin'").run(req.params.id);
  res.json({ success:true, message:'Admin removed' });
});

// ─── ATTENDANCE ──────────────────────────────────────────────
router.get('/attendance', (req, res) => {
  const db = getDB();
  const { class_id, date } = req.query;
  if (!class_id || !date) return res.json({ success:false, message:'class_id and date required' });
  const record = db.prepare("SELECT * FROM attendance_records WHERE class_id=? AND date=?").get(class_id, date);
  if (!record) return res.json({ success:true, data:null });
  const entries = db.prepare(`
    SELECT ae.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id
    FROM attendance_entries ae
    JOIN users u ON u.id=ae.learner_id
    WHERE ae.record_id=?
    ORDER BY u.name
  `).all(record.id);
  res.json({ success:true, data:{ record, entries } });
});

router.post('/attendance', (req, res) => {
  const db = getDB();
  const { class_id, term_id, date, entries } = req.body;
  if (!class_id || !term_id || !date || !Array.isArray(entries)) return res.json({ success:false, message:'Invalid data' });
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare("SELECT id FROM attendance_records WHERE class_id=? AND date=?").get(class_id, date);
    let recordId;
    if (existing) {
      recordId = existing.id;
      db.prepare("DELETE FROM attendance_entries WHERE record_id=?").run(recordId);
    } else {
      recordId = db.prepare("INSERT INTO attendance_records (class_id, term_id, date, created_by) VALUES (?,?,?,?)")
        .run(class_id, term_id, date, req.session.user.id).lastInsertRowid;
    }
    const ins = db.prepare("INSERT INTO attendance_entries (record_id, learner_id, status, note) VALUES (?,?,?,?)");
    entries.forEach(e => { if (e.learner_id && e.status) ins.run(recordId, e.learner_id, e.status, e.note || null); });
    db.exec('COMMIT');
    res.json({ success:true, message:'Attendance saved' });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/attendance/summary', (req, res) => {
  const db = getDB();
  const { class_id, term_id } = req.query;
  if (!class_id || !term_id) return res.json({ success:false, message:'class_id and term_id required' });
  const records = db.prepare("SELECT id, date FROM attendance_records WHERE class_id=? AND term_id=? ORDER BY date").all(class_id, term_id);
  const totalDays = records.length;
  const learners = db.prepare(`
    SELECT u.id, u.name, u.admission_no, u.user_id,
      (SELECT COUNT(*) FROM attendance_entries ae JOIN attendance_records ar ON ar.id=ae.record_id WHERE ae.learner_id=u.id AND ar.class_id=? AND ar.term_id=? AND ae.status='present') AS present_days,
      (SELECT COUNT(*) FROM attendance_entries ae JOIN attendance_records ar ON ar.id=ae.record_id WHERE ae.learner_id=u.id AND ar.class_id=? AND ar.term_id=? AND ae.status='absent') AS absent_days,
      (SELECT COUNT(*) FROM attendance_entries ae JOIN attendance_records ar ON ar.id=ae.record_id WHERE ae.learner_id=u.id AND ar.class_id=? AND ar.term_id=? AND ae.status='late') AS late_days
    FROM users u
    JOIN classes c ON lower(c.name)=lower(u.class_name)
    WHERE u.role='learner' AND u.status='active' AND c.id=?
    ORDER BY u.name
  `).all(class_id, term_id, class_id, term_id, class_id, term_id, class_id);
  res.json({ success:true, data:{ total_days:totalDays, learners, records } });
});

// ─── MARKS ───────────────────────────────────────────────────
router.get('/marks', (req, res) => {
  const db = getDB();
  const { class_id, term_id, assessment_type, subject_id } = req.query;
  if (!class_id || !term_id) return res.json({ success:false, message:'class_id and term_id required' });
  let sql = `
    SELECT m.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id,
           s.name AS subject_name, s.code AS subject_code
    FROM marks m
    JOIN users u ON u.id=m.learner_id
    JOIN subjects s ON s.id=m.subject_id
    WHERE m.class_id=? AND m.term_id=?
  `;
  const params = [class_id, term_id];
  if (assessment_type) { sql += ' AND m.assessment_type=?'; params.push(assessment_type); }
  if (subject_id) { sql += ' AND m.subject_id=?'; params.push(subject_id); }
  sql += ' ORDER BY u.name, s.name, m.component_key';
  const rows = db.prepare(sql).all(...params).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));
  res.json({ success:true, data:rows });
});

router.post('/marks', (req, res) => {
  const db = getDB();
  const { class_id, term_id, assessment_type, entries } = req.body;
  if (!class_id || !term_id || !assessment_type || !Array.isArray(entries)) return res.json({ success:false, message:'Invalid data' });
  if (!ASSESSMENT_TYPES.includes(assessment_type)) return res.json({ success:false, message:'Invalid assessment_type' });
  try {
    db.exec('BEGIN IMMEDIATE');
    const upsert = db.prepare(`
      INSERT INTO marks (learner_id, class_id, subject_id, term_id, assessment_type, component_key, score, created_by)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(learner_id, subject_id, term_id, assessment_type, component_key) DO UPDATE SET score=excluded.score, updated_at=datetime('now')
    `);
    const maxCache = {};
    let count = 0;
    entries.forEach(e => {
      if (!e.learner_id || !e.subject_id || !e.component_key) return;
      const cacheKey = `${e.subject_id}_${e.component_key}`;
      if (!(cacheKey in maxCache)) maxCache[cacheKey] = getMaxScoreFor(db, class_id, e.subject_id, assessment_type, e.component_key);
      const max = maxCache[cacheKey];
      if (max === null) return; // unknown component for this assessment — skip
      let score;
      if (e.score === null || e.score === '' || e.score === undefined) score = null;
      else score = Math.min(Math.max(0, Number(e.score)), max);
      upsert.run(e.learner_id, class_id, e.subject_id, term_id, assessment_type, e.component_key, score, req.session.user.id);
      count++;
    });
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${count} mark(s)` });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

// ══════════ ASSESSMENT COMPONENTS ══════════
router.get('/assessment-components', (req, res) => {
  const db = getDB();
  const { class_id, subject_id, assessment_type } = req.query;
  if (!class_id || !subject_id || !assessment_type) return res.json({ success:false, message:'class_id, subject_id and assessment_type required' });
  if (!ASSESSMENT_TYPES.includes(assessment_type)) return res.json({ success:false, message:'Invalid assessment_type' });
  const components = getAssessmentComponents(db, class_id, subject_id, assessment_type);
  const totalMax = components.reduce((sum, c) => sum + Number(c.max_score || 0), 0);
  res.json({ success:true, data:{ components, total_max: totalMax } });
});

router.post('/assessment-components', (req, res) => {
  const db = getDB();
  const { class_id, subject_id, assessment_type, components } = req.body;
  if (!class_id || !subject_id || !assessment_type || !Array.isArray(components)) return res.json({ success:false, message:'Invalid data' });
  if (!ASSESSMENT_TYPES.includes(assessment_type)) return res.json({ success:false, message:'Invalid assessment_type' });
  // Validate
  const seen = new Set();
  for (const c of components) {
    const key = String(c.component_key || '').trim();
    const name = String(c.component_name || '').trim();
    const max = Number(c.max_score);
    if (!key || !COMPONENT_KEY_RE.test(key)) return res.json({ success:false, message:`Invalid component key: ${c.component_key} (use lowercase letters, digits, underscore)` });
    if (!name) return res.json({ success:false, message:`Component name required for ${key}` });
    if (!(max > 0)) return res.json({ success:false, message:`Component ${key} max_score must be greater than 0` });
    if (seen.has(key)) return res.json({ success:false, message:`Duplicate component key: ${key}` });
    seen.add(key);
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`DELETE FROM assessment_components WHERE class_id=? AND subject_id=? AND assessment_type=?`)
      .run(class_id, subject_id, assessment_type);
    const ins = db.prepare(`
      INSERT INTO assessment_components (class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order)
      VALUES (?,?,?,?,?,?,?)
    `);
    components.forEach((c, i) => {
      ins.run(class_id, subject_id, assessment_type, String(c.component_key).trim(), String(c.component_name).trim(), Number(c.max_score), Number(c.sort_order ?? i));
    });
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${components.length} component(s)` });
  } catch (e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.delete('/assessment-components/:id', (req, res) => {
  const db = getDB();
  const result = db.prepare('DELETE FROM assessment_components WHERE id=?').run(req.params.id);
  res.json({ success: result.changes > 0 });
});

router.get('/marks/broadsheet', (req, res) => {
  const db = getDB();
  const { class_id, term_id } = req.query;
  if (!class_id || !term_id) return res.json({ success:false, message:'class_id and term_id required' });
  const classRow = db.prepare("SELECT * FROM classes WHERE id=?").get(class_id);
  const termRow = db.prepare("SELECT t.*, s.name AS session_name FROM terms t JOIN academic_sessions s ON s.id=t.session_id WHERE t.id=?").get(term_id);
  if (!classRow || !termRow) return res.json({ success:false, message:'Class or term not found' });
  const subjects = db.prepare(`
    SELECT s.id, s.name, s.code FROM class_subjects cs
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=? ORDER BY s.name
  `).all(class_id).map(row => ({ ...row, code:publicSubjectCode(row.code) }));
  const learners = db.prepare(`
    SELECT id, name, admission_no, user_id FROM users
    WHERE role='learner' AND status='active' AND class_name=?
    ORDER BY name
  `).all(classRow.name);
  const allMarks = db.prepare("SELECT * FROM marks WHERE class_id=? AND term_id=?").all(class_id, term_id);
  const aggregate = aggregateMarksByAssessment(allMarks);
  const rows = learners.map(l => {
    const subjectScores = subjects.map(s => {
      const scores = (aggregate[l.id] && aggregate[l.id][s.id]) || {};
      const midterm = scores.midterm ?? null;
      const endterm = scores.endterm ?? null;
      const average = subjectAverage(scores);
      return { subject_id:s.id, midterm, endterm, average, cbc:cbcLevel(average) };
    });
    const enteredSubjects = subjectScores.filter(subject => subject.average !== null);
    const overallAverage = averageNumbers(enteredSubjects.map(subject => subject.average));
    const totalScore = Math.round(enteredSubjects.reduce((sum, subject) => sum + subject.average, 0) * 100) / 100;
    return {
      ...l,
      subjects:subjectScores,
      total:enteredSubjects.length ? totalScore : null,
      average:overallAverage,
      cbc:cbcLevel(overallAverage),
      subject_count:enteredSubjects.length
    };
  });
  rows.sort((a,b) => (b.average ?? -1) - (a.average ?? -1));
  rows.forEach((r,i) => { r.position = r.average !== null ? i+1 : null; });
  res.json({ success:true, data:{ class:classRow, term:termRow, school:getSchoolSettings(db), subjects, learners:rows, cbc_levels:CBC_LEVELS } });
});

router.get('/marks/analysis', (req, res) => {
  const db = getDB();
  const { term_id } = req.query;
  if (!term_id) return res.json({ success:false, message:'term_id required' });
  const classes = db.prepare("SELECT id, name FROM classes WHERE status='active' ORDER BY name").all();
  const results = classes.map(cls => {
    const subjects = db.prepare(`SELECT s.id, s.name FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id WHERE cs.class_id=? ORDER BY s.name`).all(cls.id);
    const learners = db.prepare("SELECT id, name, admission_no FROM users WHERE role='learner' AND status='active' AND class_name=? ORDER BY name").all(cls.name);
    const allMarks = db.prepare("SELECT * FROM marks WHERE class_id=? AND term_id=?").all(cls.id, term_id);
    const learnerSubjectScores = aggregateMarksByAssessment(allMarks);
    const ranked = learners.map(l => {
      const subjectScores = Object.values(learnerSubjectScores[l.id] || {}).map(subjectAverage).filter(avg => avg !== null);
      const avg = averageNumbers(subjectScores);
      const total = avg === null ? null : Math.round(subjectScores.reduce((sum, score) => sum + score, 0) * 100) / 100;
      return { ...l, total, average:avg, cbc:cbcLevel(avg), subject_count:subjectScores.length };
    }).filter(l => l.subject_count > 0).sort((a,b) => b.average - a.average);
    ranked.forEach((r,i) => r.position = i+1);
    const needingSupport = [...ranked].filter(l => l.average < 41).sort((a,b) => a.average - b.average).slice(0,10);
    const improving = learners.map(l => {
      const subjectMap = learnerSubjectScores[l.id] || {};
      const midtermScores = [];
      const latestScores = [];
      Object.values(subjectMap).forEach(scores => {
        if (scores.midterm !== null && scores.midterm !== undefined) midtermScores.push(scores.midterm);
        const latest = scores.endterm ?? null;
        if (latest !== null && latest !== undefined) latestScores.push(latest);
      });
      const midtermAverage = averageNumbers(midtermScores);
      const latestAverage = averageNumbers(latestScores);
      if (midtermAverage === null || latestAverage === null) return null;
      return { ...l, midterm_average:midtermAverage, latest_average:latestAverage, improvement:Math.round((latestAverage - midtermAverage) * 100) / 100 };
    }).filter(Boolean).filter(l => l.improvement > 0).sort((a,b) => b.improvement - a.improvement).slice(0,10);
    const subjectAverages = subjects.map(s => {
      const perLearner = aggregateMarksByAssessment(allMarks.filter(m => m.subject_id === s.id));
      const averages = Object.values(perLearner).map(subjMap => subjectAverage(subjMap[s.id] || {})).filter(avg => avg !== null);
      const avg = averageNumbers(averages) ?? 0;
      return { ...s, average:avg, cbc:cbcLevel(avg), entries:averages.length };
    });
    return {
      class_id:cls.id,
      class_name:cls.name,
      learner_count:learners.length,
      ranked:ranked.slice(0,10),
      needing_support:needingSupport,
      improving,
      subject_averages:subjectAverages
    };
  }).filter(c => c.ranked.length > 0);

  const attendanceSummary = db.prepare(`
    SELECT u.id, u.name, u.class_name, u.admission_no,
      (SELECT COUNT(*) FROM attendance_entries ae JOIN attendance_records ar ON ar.id=ae.record_id WHERE ae.learner_id=u.id AND ar.term_id=? AND ae.status='absent') AS absent_days
    FROM users u WHERE u.role='learner' AND u.status='active'
    ORDER BY absent_days DESC LIMIT 15
  `).all(term_id);

  res.json({ success:true, data:{ classes:results, most_absent:attendanceSummary.filter(a=>a.absent_days>0), cbc_levels:CBC_LEVELS } });
});

// ══════════ TEMPLATE EDITOR ══════════
const TEMPLATE_DIR = path.join(__dirname, '..', 'data', 'templates');

function ensureTemplateDir() {
  if (!fs.existsSync(TEMPLATE_DIR)) fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
}

function templatePath(name) {
  const slug = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
  return path.join(TEMPLATE_DIR, slug + '.json');
}

router.get('/templates', (req, res) => {
  noStore(res);
  ensureTemplateDir();
  const files = fs.readdirSync(TEMPLATE_DIR).filter(f => f.endsWith('.json'));
  const templates = files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, f), 'utf8'));
      return data.template_name || f.replace('.json', '');
    } catch { return null; }
  }).filter(Boolean);
  if (!templates.length) templates.push('Default Template');
  res.json({ success: true, templates });
});

router.get('/templates/:name', (req, res) => {
  noStore(res);
  ensureTemplateDir();
  const fp = templatePath(req.params.name);
  if (!fs.existsSync(fp)) return res.json({ success: true, state: null });
  try {
    const state = JSON.parse(fs.readFileSync(fp, 'utf8'));
    res.json({ success: true, state });
  } catch (e) {
    res.json({ success: false, message: 'Failed to read template' });
  }
});

router.post('/templates', (req, res) => {
  ensureTemplateDir();
  const state = req.body.state;
  if (!state || !state.template_name) return res.json({ success: false, message: 'Template name is required' });
  const fp = templatePath(state.template_name);
  try {
    fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: 'Failed to save template' });
  }
});

router.delete('/templates/:name', (req, res) => {
  ensureTemplateDir();
  const fp = templatePath(req.params.name);
  if (!fs.existsSync(fp)) return res.json({ success: false, message: 'Template not found' });
  try {
    fs.unlinkSync(fp);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: 'Failed to delete template' });
  }
});

// ══════════ SKILLS / ATTRIBUTES ENTRY ══════════
router.get('/skills', (req, res) => {
  const db = getDB();
  const { class_id, term_id, assessment_type } = req.query;
  if (!class_id || !term_id) return res.json({ success:false, message:'class_id and term_id required' });
  let sql = `
    SELECT s.*, u.name AS learner_name, u.admission_no
    FROM learner_skills s
    JOIN users u ON u.id = s.learner_id
    WHERE s.class_id = ? AND s.term_id = ?
  `;
  const params = [class_id, term_id];
  if (assessment_type) { sql += ' AND s.assessment_type = ?'; params.push(assessment_type); }
  sql += ' ORDER BY u.name';
  const rows = db.prepare(sql).all(...params);
  res.json({ success:true, data: rows });
});

router.post('/skills', (req, res) => {
  const db = getDB();
  const { class_id, term_id, assessment_type, entries } = req.body;
  if (!class_id || !term_id || !assessment_type || !Array.isArray(entries)) return res.json({ success:false, message:'Invalid data' });
  if (!ASSESSMENT_TYPES.includes(assessment_type)) return res.json({ success:false, message:'Invalid assessment_type' });
  try {
    db.exec('BEGIN IMMEDIATE');
    const upsert = db.prepare(`
      INSERT INTO learner_skills (learner_id, class_id, term_id, assessment_type, category_key, item_key, rating, created_by)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(learner_id, term_id, assessment_type, category_key, item_key) DO UPDATE SET rating=excluded.rating, updated_at=datetime('now')
    `);
    let count = 0;
    entries.forEach(e => {
      if (!e.learner_id || !e.category_key || !e.item_key) return;
      const rating = e.rating === null || e.rating === '' || e.rating === undefined ? null : Number(e.rating);
      upsert.run(e.learner_id, class_id, term_id, assessment_type, e.category_key, e.item_key, rating, req.session.user.id);
      count++;
    });
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${count} skill rating(s)` });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

module.exports = router;
