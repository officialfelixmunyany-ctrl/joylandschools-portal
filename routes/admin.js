const express = require('express');
const heicConvert = require('heic-convert');
const bcrypt  = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDB, calculateSchoolDays } = require('../database');
const { todayInSchoolTime } = require('../lib/dates');
const { resolveSchoolDay } = require('../lib/schoolDays');
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
function subjectCodeSlug(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const base = words.length === 1
    ? words[0].slice(0, 4).toUpperCase()
    : words.map(w => w[0]).join('').toUpperCase().slice(0, 6);
  return base.replace(/[^A-Z0-9]/g, '') || 'SUB';
}
function uniqueSubjectCode(db, name, preferredCode, exceptId = null) {
  const base = (cleanText(preferredCode) || subjectCodeSlug(name)).replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'SUB';
  let code = base;
  let n = 2;
  while (db.prepare('SELECT 1 FROM subjects WHERE code=? AND (? IS NULL OR id != ?)').get(code, exceptId, exceptId)) {
    code = base.slice(0, 4) + n;
    n++;
  }
  return code;
}
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
const RESOURCE_UPLOAD_ROOT = path.join(__dirname, '..', 'public', 'uploads', 'resources');
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
    performance_target_average:'75',
    band_thresholds_json:'{"EE":75,"ME":60,"AE":50,"BE":0}',
    show_band_in_marks:'1',
    teacher_publish_marks:'0',
    auto_save_marks:'1',
    sms_on_absence:'1',
    sms_sender_id:'JOYLAND',
    default_channels_json:'["in-app","sms"]',
    password_min_length:'8',
    require_2fa:'0',
    session_timeout_min:'120'
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

function currentTermId(db, value) {
  if (value && value !== 'current') return optionalId(value);
  return currentAdminTerm(db)?.id || null;
}

function jsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
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

const RESOURCE_TYPES = new Set(['notes', 'past_paper', 'scheme', 'other']);
const RESOURCE_FILE_TYPES = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/plain': 'txt',
  'text/html': 'html',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

function resourceType(value) {
  const type = cleanText(value).toLowerCase();
  return RESOURCE_TYPES.has(type) ? type : null;
}

function resourcePayload(body = {}) {
  const type = resourceType(body.type);
  const title = cleanText(body.title);
  if (!type) throw new Error('Invalid resource type');
  if (!title) throw new Error('Title is required');
  const year = body.year === null || body.year === undefined || body.year === '' ? null : Number(body.year);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2200)) throw new Error('Invalid year');
  return {
    type,
    title,
    grade: cleanText(body.grade) || null,
    subject: cleanText(body.subject) || null,
    year,
    body_html: String(body.body_html || '').trim() || null,
    published: body.published === false || String(body.published) === '0' ? 0 : 1
  };
}

function safeFileBase(name) {
  return cleanText(name)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'resource';
}

function parseGenericFilePayload(body = {}) {
  const data = cleanText(body.file_data || body.image_data);
  const dataMatch = data.match(/^data:([^;]+);base64,(.+)$/i);
  const mime = cleanText(dataMatch ? dataMatch[1] : body.mime_type).toLowerCase();
  const base64 = dataMatch ? dataMatch[2] : data;
  if (!base64) throw new Error('File data is required');
  const extFromName = cleanText(body.file_name || body.filename).split('.').pop().toLowerCase();
  const ext = /^[a-z0-9]{1,8}$/.test(extFromName) && extFromName !== cleanText(body.file_name || body.filename).toLowerCase()
    ? extFromName
    : RESOURCE_FILE_TYPES[mime];
  if (!ext) throw new Error('Unsupported file type');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) throw new Error('File is empty');
  if (buffer.length > 25 * 1024 * 1024) throw new Error('File must be 25MB or smaller');
  return { buffer, mime:mime || 'application/octet-stream', ext };
}

function saveResourceFile(resourceId, body) {
  fs.mkdirSync(RESOURCE_UPLOAD_ROOT, { recursive:true });
  const { buffer, mime, ext } = parseGenericFilePayload(body || {});
  const base = safeFileBase(body.file_name || body.filename || `resource-${resourceId}`);
  const fileName = `${resourceId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}.${ext}`;
  fs.writeFileSync(path.join(RESOURCE_UPLOAD_ROOT, fileName), buffer);
  return { file_path:`/uploads/resources/${fileName}`, mime_type:mime };
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

function currentAdminTerm(db) {
  const today = todayInSchoolTime();
  return db.prepare(`
    SELECT t.*, s.name AS session_name
    FROM terms t
    JOIN academic_sessions s ON s.id=t.session_id
    WHERE date(t.start_date) <= date(?) AND date(t.end_date) >= date(?)
    ORDER BY date(t.start_date) DESC
    LIMIT 1
  `).get(today, today) || db.prepare(`
    SELECT t.*, s.name AS session_name
    FROM terms t
    JOIN academic_sessions s ON s.id=t.session_id
    ORDER BY date(t.end_date) DESC
    LIMIT 1
  `).get();
}

function termDisplayName(term) {
  if (!term) return '';
  return `${term.session_name || ''} · ${term.name || term.term_name || `Term ${term.term_number || ''}`}`.trim();
}

/**
 * Resolve which term's marks the schoolwide dashboards should display.
 *
 * @param {Database} db
 * @param {number|null} requestedTermId - the term the caller asked for (or null)
 * @param {boolean} strict - if true, never fall back; only return the requested term
 * @returns {{ term: object|null, isFallback: boolean, requestedTerm: object|null }}
 */
function resolveDisplayTerm(db, requestedTermId, strict = false) {
  const requested = requestedTermId
    ? db.prepare(`
        SELECT t.*, s.name AS session_name
        FROM terms t
        JOIN academic_sessions s ON s.id=t.session_id
        WHERE t.id=?
      `).get(requestedTermId)
    : currentAdminTerm(db);

  if (!requested) return { term:null, isFallback:false, requestedTerm:null };

  const hasMarks = db.prepare('SELECT 1 FROM marks WHERE term_id=? LIMIT 1').get(requested.id);
  if (hasMarks || strict) return { term:requested, isFallback:false, requestedTerm:requested };

  const fallback = db.prepare(`
    SELECT t.*, s.name AS session_name
    FROM terms t
    JOIN academic_sessions s ON s.id=t.session_id
    WHERE t.id != ?
      AND date(t.end_date) < date(?)
      AND EXISTS (SELECT 1 FROM marks m WHERE m.term_id=t.id)
    ORDER BY date(t.end_date) DESC
    LIMIT 1
  `).get(requested.id, requested.start_date);

  if (fallback) return { term:fallback, isFallback:true, requestedTerm:requested };
  return { term:requested, isFallback:false, requestedTerm:requested };
}

function schoolMeanForTerm(db, termId) {
  if (!termId) return null;
  const rows = db.prepare('SELECT * FROM marks WHERE term_id=?').all(termId);
  const grouped = aggregateMarksByAssessment(rows);
  const subjectAverages = [];
  Object.values(grouped).forEach(subjectMap => {
    Object.values(subjectMap).forEach(scores => {
      const avg = subjectAverage(scores);
      if (avg !== null) subjectAverages.push(avg);
    });
  });
  return averageNumbers(subjectAverages);
}

function roundOne(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return null;
  return Math.round(Number(value) * 10) / 10;
}

function adminTableHasColumn(db, table, column) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((col) => col.name === column);
  } catch {
    return false;
  }
}

function learnerAveragesFromMarks(rows, learners = null) {
  const grouped = aggregateMarksByAssessment(rows);
  const learnerIds = learners ? learners.map((learner) => learner.id) : Object.keys(grouped).map(Number);
  return learnerIds.map((learnerId) => {
    const subjectScores = Object.values(grouped[learnerId] || {})
      .map(subjectAverage)
      .filter((avg) => avg !== null);
    const mean = averageNumbers(subjectScores);
    return mean === null ? null : { learner_id:Number(learnerId), mean, subject_count:subjectScores.length };
  }).filter(Boolean);
}

function formatTermPointLabel(term) {
  const sessionName = term.session_name || term.session_year || '';
  const termNumber = term.term_number || term.position || '';
  return `${sessionName} · T${termNumber}`.trim();
}

function sexLabel(raw) {
  const value = String(raw || '').trim();
  const lower = value.toLowerCase();
  if (['m', 'male', 'boy'].includes(lower)) return 'Male';
  if (['f', 'female', 'girl'].includes(lower)) return 'Female';
  return value || 'Unspecified';
}

function attendanceBand(rate) {
  if (rate >= 0.9) return '≥90%';
  if (rate >= 0.75) return '75–89%';
  return '<75%';
}

function groupedMean(entries, labelFor) {
  const groups = new Map();
  entries.forEach((entry) => {
    const label = labelFor(entry);
    if (!label) return;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(Number(entry.mean));
  });
  return [...groups.entries()].map(([label, values]) => ({
    label,
    mean:roundOne(averageNumbers(values)),
    count:values.length
  })).sort((a, b) => a.label.localeCompare(b.label));
}

function atRiskCountForTerm(db, termId) {
  if (!termId) return 0;
  const rows = db.prepare('SELECT * FROM marks WHERE term_id=?').all(termId);
  const grouped = aggregateMarksByAssessment(rows);
  let count = 0;
  Object.values(grouped).forEach(subjectMap => {
    const avg = averageNumbers(Object.values(subjectMap).map(subjectAverage));
    if (avg !== null && avg < 41) count += 1;
  });
  return count;
}

function todayAttendanceStats(db) {
  const today = todayInSchoolTime();
  const row = db.prepare(`
    SELECT
      COUNT(ae.id) AS marked,
      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id
    WHERE ar.date=?
  `).get(today);
  const totalLearners = db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner' AND status='active'").get().c;
  const present = Number(row?.present || 0);
  const marked = Number(row?.marked || 0);
  return {
    date:today,
    present,
    marked,
    absent:Number(row?.absent || 0),
    late:Number(row?.late || 0),
    total:totalLearners,
    percent:totalLearners ? Math.round((present / totalLearners) * 1000) / 10 : 0
  };
}

// --- CALENDAR EVENTS -------------------------------------------------------
function eventPayload(row) {
  if (!row) return null;
  return {
    id:row.id,
    date:row.date,
    endDate:row.end_date,
    title:row.title,
    description:row.description || '',
    type:row.type,
    classId:row.class_id,
    className:row.class_name || null,
    termId:row.term_id
  };
}

function validEventType(value) {
  return ['assess','event','meet','term','hol'].includes(String(value || '').toLowerCase());
}

router.get('/calendar/events', (req, res) => {
  const db = getDB();
  const from = cleanText(req.query.from);
  const to = cleanText(req.query.to);
  const classId = optionalId(req.query.class_id || req.query.classId);
  if (!from || !to) return res.json({ success:false, message:'from and to are required' });
  const params = [to, from];
  let classFilter = '';
  if (classId) { classFilter = ' AND (se.class_id IS NULL OR se.class_id=?)'; params.push(classId); }
  const rows = db.prepare(`
    SELECT se.*, c.name AS class_name
    FROM school_events se
    LEFT JOIN classes c ON c.id=se.class_id
    WHERE date(se.date) <= date(?) AND date(COALESCE(se.end_date, se.date)) >= date(?)
    ${classFilter}
    ORDER BY date(se.date), se.type, se.title
  `).all(...params);
  res.json({ success:true, data:rows.map(eventPayload) });
});

router.post('/calendar/events', (req, res) => {
  const db = getDB();
  const date = cleanText(req.body.date);
  const title = cleanText(req.body.title);
  const type = cleanText(req.body.type).toLowerCase() || 'event';
  if (!date || !title) return res.json({ success:false, message:'Date and title are required' });
  if (!validEventType(type)) return res.json({ success:false, message:'Invalid event type' });
  const endDate = cleanText(req.body.endDate || req.body.end_date) || null;
  const classId = optionalId(req.body.classId || req.body.class_id);
  const termId = optionalId(req.body.termId || req.body.term_id);
  const id = db.prepare(`
    INSERT INTO school_events (date, end_date, title, description, type, class_id, term_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(date, endDate, title, cleanText(req.body.description) || null, type, classId, termId, req.session.user.id).lastInsertRowid;
  const row = db.prepare(`
    SELECT se.*, c.name AS class_name FROM school_events se LEFT JOIN classes c ON c.id=se.class_id WHERE se.id=?
  `).get(id);
  res.json({ success:true, data:eventPayload(row), message:'Event saved' });
});

router.put('/calendar/events/:id', (req, res) => {
  const db = getDB();
  const existing = db.prepare('SELECT id FROM school_events WHERE id=?').get(req.params.id);
  if (!existing) return res.json({ success:false, message:'Event not found' });
  const date = cleanText(req.body.date);
  const title = cleanText(req.body.title);
  const type = cleanText(req.body.type).toLowerCase() || 'event';
  if (!date || !title) return res.json({ success:false, message:'Date and title are required' });
  if (!validEventType(type)) return res.json({ success:false, message:'Invalid event type' });
  db.prepare(`
    UPDATE school_events
    SET date=?, end_date=?, title=?, description=?, type=?, class_id=?, term_id=?, updated_at=datetime('now')
    WHERE id=?
  `).run(
    date,
    cleanText(req.body.endDate || req.body.end_date) || null,
    title,
    cleanText(req.body.description) || null,
    type,
    optionalId(req.body.classId || req.body.class_id),
    optionalId(req.body.termId || req.body.term_id),
    req.params.id
  );
  const row = db.prepare(`
    SELECT se.*, c.name AS class_name FROM school_events se LEFT JOIN classes c ON c.id=se.class_id WHERE se.id=?
  `).get(req.params.id);
  res.json({ success:true, data:eventPayload(row), message:'Event updated' });
});

router.delete('/calendar/events/:id', (req, res) => {
  getDB().prepare('DELETE FROM school_events WHERE id=?').run(req.params.id);
  res.json({ success:true, message:'Event deleted' });
});

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

router.get('/resources', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT id, type, title, grade, subject, year, body_html, file_path, published, views, created_by, created_at, updated_at
    FROM resources
    ORDER BY datetime(updated_at) DESC, id DESC
  `).all();
  res.json({ success:true, data:{ resources:rows } });
});

router.post('/resources', (req, res) => {
  const db = getDB();
  try {
    const payload = resourcePayload(req.body || {});
    const result = db.prepare(`
      INSERT INTO resources (type, title, grade, subject, year, body_html, published, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      payload.type,
      payload.title,
      payload.grade,
      payload.subject,
      payload.year,
      payload.body_html,
      payload.published,
      req.session.user?.id || null
    );
    const row = db.prepare('SELECT * FROM resources WHERE id=?').get(result.lastInsertRowid);
    res.json({ success:true, data:row, message:'Resource created' });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
});

router.put('/resources/:id', (req, res) => {
  const db = getDB();
  const id = optionalId(req.params.id);
  if (!id) return res.status(400).json({ success:false, message:'Invalid resource' });
  const existing = db.prepare('SELECT id FROM resources WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ success:false, message:'Resource not found' });
  try {
    const payload = resourcePayload(req.body || {});
    db.prepare(`
      UPDATE resources
      SET type=?, title=?, grade=?, subject=?, year=?, body_html=?, published=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      payload.type,
      payload.title,
      payload.grade,
      payload.subject,
      payload.year,
      payload.body_html,
      payload.published,
      id
    );
    const row = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
    res.json({ success:true, data:row, message:'Resource updated' });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
});

router.delete('/resources/:id', (req, res) => {
  const db = getDB();
  const id = optionalId(req.params.id);
  if (!id) return res.status(400).json({ success:false, message:'Invalid resource' });
  const existing = db.prepare('SELECT file_path FROM resources WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ success:false, message:'Resource not found' });
  if (existing.file_path && existing.file_path.startsWith('/uploads/resources/')) {
    try { fs.unlinkSync(path.join(__dirname, '..', 'public', existing.file_path.replace(/^\/+/, ''))); } catch {}
  }
  db.prepare('DELETE FROM resources WHERE id=?').run(id);
  res.json({ success:true, message:'Resource deleted' });
});

router.post('/resources/:id/file', (req, res) => {
  const db = getDB();
  const id = optionalId(req.params.id);
  if (!id) return res.status(400).json({ success:false, message:'Invalid resource' });
  const existing = db.prepare('SELECT file_path FROM resources WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ success:false, message:'Resource not found' });
  try {
    const saved = saveResourceFile(id, req.body || {});
    if (existing.file_path && existing.file_path.startsWith('/uploads/resources/')) {
      try { fs.unlinkSync(path.join(__dirname, '..', 'public', existing.file_path.replace(/^\/+/, ''))); } catch {}
    }
    db.prepare('UPDATE resources SET file_path=?, updated_at=datetime(\'now\') WHERE id=?').run(saved.file_path, id);
    res.json({ success:true, data:saved, message:'File uploaded' });
  } catch (e) {
    res.status(400).json({ success:false, message:e.message });
  }
});

const ROLE_PERMISSIONS = [
  'view_marks', 'edit_marks', 'publish_marks', 'mark_attendance',
  'broadcast', 'view_reports', 'manage_people', 'manage_settings'
];
const ROLE_DEFAULTS = {
  admin:['view_marks','edit_marks','publish_marks','mark_attendance','broadcast','view_reports','manage_people','manage_settings'],
  teacher:['view_marks','edit_marks','mark_attendance','broadcast','view_reports'],
  parent:['view_marks','view_reports'],
  learner:['view_marks']
};

router.get('/roles', (req, res) => {
  const roles = Object.keys(ROLE_DEFAULTS).map((id) => ({
    id,
    name:id.charAt(0).toUpperCase() + id.slice(1),
    permissions:jsonArray(getSchoolSettings(getDB())[`role_${id}_permissions_json`], ROLE_DEFAULTS[id])
  }));
  res.json({ success:true, data:roles });
});

router.get('/permissions', (req, res) => {
  const settings = getSchoolSettings(getDB());
  res.json({
    success:true,
    data:{
      permissions:ROLE_PERMISSIONS,
      roles:Object.keys(ROLE_DEFAULTS).map(id => ({
        id,
        permissions:jsonArray(settings[`role_${id}_permissions_json`], ROLE_DEFAULTS[id])
      }))
    }
  });
});

router.put('/roles/:id/permissions', (req, res) => {
  const id = String(req.params.id || '').toLowerCase();
  if (!ROLE_DEFAULTS[id]) return res.json({ success:false, message:'Unknown role' });
  const permissions = Array.isArray(req.body.permissions)
    ? req.body.permissions.filter(p => ROLE_PERMISSIONS.includes(p))
    : [];
  saveSchoolSetting(getDB(), `role_${id}_permissions_json`, JSON.stringify(permissions));
  res.json({ success:true, data:{ id, permissions }, message:'Permissions saved' });
});

router.get('/billing/sms-balance', (req, res) => {
  res.json({
    success:true,
    data:{
      balance:Number(getSchoolSettings(getDB()).sms_balance || 1250),
      lastTopUp:getSchoolSettings(getDB()).sms_last_topup || null,
      costPerSms:Number(getSchoolSettings(getDB()).sms_cost_per_sms || 1.2),
      monthlySpend:Number(getSchoolSettings(getDB()).sms_monthly_spend || 0),
      transactions:[]
    }
  });
});

router.get('/integrations', (req, res) => {
  res.json({ success:true, data:[
    { id:'africas-talking', name:"Africa's Talking", type:'SMS', connected:Boolean(getSchoolSettings(getDB()).africas_talking_key), keyMasked:'••••••••' },
    { id:'mpesa', name:'M-Pesa', type:'Payments', connected:Boolean(getSchoolSettings(getDB()).mpesa_key), keyMasked:'••••••••' },
    { id:'mailgun', name:'Mailgun', type:'Email', connected:Boolean(getSchoolSettings(getDB()).mailgun_key), keyMasked:'••••••••' }
  ]});
});

const BACKUP_ROOT = path.join(__dirname, '..', 'data', 'backups');
function backupRows() {
  fs.mkdirSync(BACKUP_ROOT, { recursive:true });
  return fs.readdirSync(BACKUP_ROOT)
    .filter(name => name.endsWith('.db'))
    .map(name => {
      const fp = path.join(BACKUP_ROOT, name);
      const st = fs.statSync(fp);
      return { filename:name, date:st.mtime.toISOString(), size:st.size };
    })
    .sort((a,b) => new Date(b.date) - new Date(a.date));
}

router.get('/backups', (req, res) => {
  res.json({ success:true, data:backupRows() });
});

router.post('/backups', (req, res) => {
  fs.mkdirSync(BACKUP_ROOT, { recursive:true });
  const name = `joyland-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'joyland.db'), path.join(BACKUP_ROOT, name));
  res.json({ success:true, data:backupRows()[0], message:'Backup created' });
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

router.get('/comments', (req, res) => {
  const db = getDB();
  const classId = optionalId(req.query.class_id || req.query.classId);
  const termId = optionalId(req.query.term_id || req.query.termId);
  if (!classId || !termId) return res.status(400).json({ success:false, message:'class_id and term_id are required' });

  const cls = db.prepare('SELECT id, name FROM classes WHERE id=?').get(classId);
  if (!cls) return res.status(404).json({ success:false, message:'Class not found' });
  const term = db.prepare(`
    SELECT t.id, t.term_name, s.name AS session_name
    FROM terms t
    LEFT JOIN academic_sessions s ON s.id=t.session_id
    WHERE t.id=?
  `).get(termId);
  if (!term) return res.status(404).json({ success:false, message:'Term not found' });

  const learners = db.prepare(`
    SELECT id, name, admission_no
    FROM users
    WHERE role='learner' AND status='active' AND lower(class_name)=lower(?)
    ORDER BY name
  `).all(cls.name);
  const comments = db.prepare(`
    SELECT lc.id, lc.learner_id, lc.assessment_type, lc.role, lc.comment_text,
           lc.created_by, lc.updated_at, lc.created_at,
           u.name AS author
    FROM learner_comments lc
    LEFT JOIN users u ON u.id=lc.created_by
    WHERE lc.class_id=? AND lc.term_id=?
    ORDER BY lc.learner_id,
      CASE lc.assessment_type WHEN 'endterm' THEN 1 WHEN 'midterm' THEN 2 ELSE 3 END,
      lc.updated_at DESC
  `).all(classId, termId);
  const byLearner = new Map();
  comments.forEach((row) => {
    if (!byLearner.has(row.learner_id)) byLearner.set(row.learner_id, []);
    byLearner.get(row.learner_id).push(row);
  });
  const commentPayload = (row) => row ? {
    id:row.id,
    text:row.comment_text || '',
    author:row.author || 'Teacher',
    updated_at:row.updated_at || row.created_at || null,
    assessment_type:row.assessment_type || null,
    role:row.role
  } : null;
  const data = learners.map((learner) => {
    const rows = byLearner.get(learner.id) || [];
    const classTeacherRows = rows.filter((row) => row.role === 'class_teacher');
    return {
      learner_id:learner.id,
      learner_name:learner.name,
      admission_no:learner.admission_no,
      class_teacher_comment:commentPayload(classTeacherRows[0] || null),
      class_teacher_comments:classTeacherRows.map(commentPayload),
      subject_comments:[]
    };
  });

  res.json({ success:true, data:{
    class_id:cls.id,
    class_name:cls.name,
    term_id:term.id,
    term_name:term.term_name,
    session_name:term.session_name || '',
    learners:data
  }});
});

router.put('/comments/:id', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  const text = cleanText(req.body?.comment_text);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success:false, message:'Invalid comment id' });
  if (text.length > 1000) return res.status(400).json({ success:false, message:'Comment too long (max 1000 chars)' });
  const existing = db.prepare('SELECT id FROM learner_comments WHERE id=?').get(id);
  if (!existing) return res.status(404).json({ success:false, message:'Comment not found' });
  db.prepare(`
    UPDATE learner_comments
    SET comment_text=?, updated_at=datetime('now')
    WHERE id=?
  `).run(text, id);
  const row = db.prepare(`
    SELECT lc.id, lc.learner_id, lc.assessment_type, lc.role, lc.comment_text,
           lc.updated_at, u.name AS author
    FROM learner_comments lc
    LEFT JOIN users u ON u.id=lc.created_by
    WHERE lc.id=?
  `).get(id);
  res.json({ success:true, data:{
    id:row.id,
    learner_id:row.learner_id,
    assessment_type:row.assessment_type,
    role:row.role,
    text:row.comment_text || '',
    author:row.author || 'Teacher',
    updated_at:row.updated_at
  }, message:'Comment updated' });
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
  const learners   = db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner' AND status='active'").get().c;
  const teachers   = db.prepare("SELECT COUNT(*) c FROM users WHERE role='teacher' AND status='active'").get().c;
  const parents    = db.prepare("SELECT COUNT(*) c FROM parent_accounts WHERE status='active'").get().c;
  const admins     = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' OR is_admin=1").get().c;
  const sessions   = db.prepare("SELECT COUNT(*) c FROM academic_sessions").get().c;
  const classes    = db.prepare("SELECT COUNT(*) c FROM classes WHERE status='active'").get().c;
  const subjects   = db.prepare("SELECT COUNT(*) c FROM subjects WHERE status='active'").get().c;
  const active_session = db.prepare("SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1").get();
  const active_terms   = active_session ? db.prepare("SELECT COUNT(*) c FROM terms WHERE session_id=?").get(active_session.id).c : 0;
  const term = currentAdminTerm(db);
  const resolved = resolveDisplayTerm(db, null, false);
  const displayTerm = resolved.term;
  const attendance = todayAttendanceStats(db);
  const school_mean = schoolMeanForTerm(db, displayTerm?.id);
  const at_risk = atRiskCountForTerm(db, displayTerm?.id);
  res.json({ success:true, data:{
    learners, teachers, parents, admins, people:learners + teachers + parents + admins,
    classes, subjects, sessions, active_session, active_terms,
    current_term:term ? { id:term.id, term_name:term.term_name, start_date:term.start_date, end_date:term.end_date, session_name:term.session_name } : null,
    school_mean, at_risk, attendance_today:attendance,
    display_term:displayTerm ? { id:displayTerm.id, name:termDisplayName(displayTerm), is_fallback:resolved.isFallback } : null
  }});
});

// ─── CURRENT TERM CLOCK ────────────────────────────────────────
// Joyland records marks for Midterm and Endterm only. The term has two stages:
//   • first 60% of the term  → "Midterm" stage (when midterm assessments are entered)
//   • final 40% of the term  → "Endterm" stage (when endterm assessments are entered)
// Attendance does not care about assessment type — it is recorded daily regardless.
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
  // Split the term at 60% — before that is the Midterm window, after is the Endterm window.
  const period = progress < 0.6 ? 'midterm' : 'endterm';
  const periodLabel = progress < 0.6 ? 'Midterm' : 'Endterm';
  return {
    period,
    period_label:periodLabel,
    stage:period,
    stage_label:periodLabel,
    week_no:weekNo,
    total_weeks:totalWeeks,
    progress_percent:Math.round(progress*100),
    source:'Joyland Sessions & Terms',
    assessed_periods:ASSESSMENT_TYPES
  };
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
    const det = detectAssessmentPeriod(term, today);
    return res.json({
      success: true, in_term: true,
      session_name: term.session_name,
      term: { id:term.id, term_number:term.term_number, term_name:term.term_name, start_date:term.start_date, end_date:term.end_date },
      source:'Joyland Sessions & Terms',
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
      stage: 'pre-term', stage_label: 'Term not started',
      week_no: 0, total_weeks: 0, progress_percent: 0,
      source:'Joyland Sessions & Terms',
      assessed_periods:ASSESSMENT_TYPES
    });
  }

  res.json({ success:true, in_term:false, period:'break', period_label:'No active term', stage:'break', stage_label:'No active term', term:null, source:'Joyland Sessions & Terms', assessed_periods:ASSESSMENT_TYPES });
});

// ─── TIMETABLE ──────────────────────────────────────────────────
const TIMETABLE_DAYS = [1, 2, 3, 4, 5];
const TIMETABLE_DAY_NAMES = ['', 'mon', 'tue', 'wed', 'thu', 'fri'];
const TIMETABLE_VALID_DAY_NAMES = ['mon', 'tue', 'wed', 'thu', 'fri'];
const TIMETABLE_DAY_NUM = { mon:1, tue:2, wed:3, thu:4, fri:5 };

function safeJson(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function normalizeTimetableActiveDays(value) {
  const raw = Array.isArray(value) ? value : safeJson(value, []);
  const days = raw
    .map(d => String(d || '').toLowerCase())
    .filter(d => TIMETABLE_VALID_DAY_NAMES.includes(d));
  return days.length ? [...new Set(days)] : [...TIMETABLE_VALID_DAY_NAMES];
}

function timetableSlotsForGeneration(db, generationId) {
  if (!generationId) return [];
  return db.prepare(`
    SELECT s.*, c.name AS class_name, sub.name AS subject_name, u.name AS teacher_name
    FROM timetable_slots s
    JOIN classes c ON c.id=s.class_id
    JOIN subjects sub ON sub.id=s.subject_id
    LEFT JOIN users u ON u.id=s.teacher_id
    WHERE s.generation_id=?
    ORDER BY s.class_id, s.day_of_week, s.period_no
  `).all(generationId);
}

router.get('/timetable/periods', (req, res) => {
  const rows = getDB().prepare('SELECT * FROM bell_periods WHERE schedule_id=1 ORDER BY period_no').all();
  res.json({ success:true, data:rows.map(row => ({ ...row, active_days:normalizeTimetableActiveDays(row.active_days) })) });
});

router.post('/timetable/periods', (req, res) => {
  const db = getDB();
  const periods = Array.isArray(req.body.periods) ? req.body.periods : null;
  if (!periods) return res.json({ success:false, message:'periods array required' });
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM bell_periods WHERE schedule_id=1').run();
    const ins = db.prepare(`
      INSERT INTO bell_periods (schedule_id, period_no, label, start_time, end_time, type, active_days)
      VALUES (1, ?, ?, ?, ?, ?, ?)
    `);
    periods.forEach((p, i) => {
      const type = ['lesson','break','lunch','assembly','other'].includes(cleanText(p.type)) ? cleanText(p.type) : 'lesson';
      const start = cleanText(p.start_time);
      const end = cleanText(p.end_time);
      if (!start || !end) throw new Error('Each period needs start_time and end_time');
      ins.run(
        i + 1,
        cleanText(p.label) || ('Period ' + (i + 1)),
        start,
        end,
        type,
        JSON.stringify(normalizeTimetableActiveDays(p.active_days))
      );
    });
    db.exec('COMMIT');
    res.json({ success:true, message:'Saved ' + periods.length + ' periods' });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/timetable/lessons', (req, res) => {
  const rows = getDB().prepare(`
    SELECT cs.class_id, cs.subject_id, cs.teacher_id, cs.lessons_per_week, cs.double_periods, cs.locked_slots,
           c.name AS class_name, s.name AS subject_name, u.name AS teacher_name
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    LEFT JOIN users u ON u.id=cs.teacher_id
    ORDER BY c.name, s.name
  `).all().map(row => ({ ...row, locked_slots:safeJson(row.locked_slots, []) }));
  res.json({ success:true, data:rows });
});

router.put('/timetable/lessons', (req, res) => {
  const db = getDB();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.json({ success:false, message:'rows required' });
  const upd = db.prepare(`
    UPDATE class_subjects
    SET lessons_per_week=?, double_periods=?, updated_at=datetime('now')
    WHERE class_id=? AND subject_id=?
  `);
  try {
    db.exec('BEGIN IMMEDIATE');
    rows.forEach(r => upd.run(Number(r.lessons_per_week) || 0, Number(r.double_periods) || 0, r.class_id, r.subject_id));
    db.exec('COMMIT');
    res.json({ success:true, updated:rows.length });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/timetable/teachers', (req, res) => {
  const rows = getDB().prepare(`
    SELECT u.id, u.name, u.subject,
      (SELECT c.name FROM classes c WHERE c.class_teacher_id=u.id ORDER BY c.name LIMIT 1) AS primary_class,
      COALESCE(tc.max_per_day, 6) AS max_per_day,
      COALESCE(tc.max_per_week, 30) AS max_per_week,
      tc.preferred_off_day,
      tc.unavailable_slots,
      COALESCE(tc.min_gap_minutes, 0) AS min_gap_minutes
    FROM users u
    LEFT JOIN teacher_constraints tc ON tc.teacher_id=u.id
    WHERE u.role='teacher' AND u.status='active'
    ORDER BY u.name
  `).all().map(r => ({ ...r, unavailable_slots:safeJson(r.unavailable_slots, []) }));
  res.json({ success:true, data:rows });
});

router.put('/timetable/teachers/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ success:false, message:'Invalid teacher id' });
  const { max_per_day, max_per_week, preferred_off_day, unavailable_slots } = req.body || {};
  const offDay = ['mon','tue','wed','thu','fri'].includes(preferred_off_day) ? preferred_off_day : null;
  getDB().prepare(`
    INSERT INTO teacher_constraints (teacher_id, max_per_day, max_per_week, preferred_off_day, unavailable_slots)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(teacher_id) DO UPDATE SET
      max_per_day=excluded.max_per_day,
      max_per_week=excluded.max_per_week,
      preferred_off_day=excluded.preferred_off_day,
      unavailable_slots=excluded.unavailable_slots
  `).run(id, Number(max_per_day) || 6, Number(max_per_week) || 30, offDay, JSON.stringify(Array.isArray(unavailable_slots) ? unavailable_slots : []));
  res.json({ success:true });
});

router.put('/timetable/class-hours', (req, res) => {
  const db = getDB();
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) return res.json({ success:false, message:'rows required' });
  const upd = db.prepare("UPDATE classes SET active_periods=?, updated_at=datetime('now') WHERE id=?");
  try {
    db.exec('BEGIN IMMEDIATE');
    let updated = 0;
    rows.forEach(r => {
      const classId = Number(r.class_id || r.classId);
      if (!Number.isInteger(classId) || classId <= 0) return;
      const periods = Array.isArray(r.active_periods)
        ? [...new Set(r.active_periods.map(Number).filter(n => Number.isInteger(n) && n > 0))]
        : null;
      const json = periods && periods.length ? JSON.stringify(periods) : null;
      updated += upd.run(json, classId).changes;
    });
    db.exec('COMMIT');
    res.json({ success:true, updated });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/timetable/generations', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT g.*, COUNT(s.id) AS slot_count
    FROM timetable_generations g
    LEFT JOIN timetable_slots s ON s.generation_id=g.id
    GROUP BY g.id
    ORDER BY datetime(g.generated_at) DESC, g.id DESC
  `).all().map(g => ({
    ...g,
    conflict_items:safeJson(g.conflicts_json, []),
    soft_rules:safeJson(g.soft_rules_json, {}),
    slots:g.status === 'active' ? timetableSlotsForGeneration(db, g.id) : []
  }));
  res.json({ success:true, data:rows });
});

router.get('/timetable/grid', (req, res) => {
  const db = getDB();
  const generationId = optionalId(req.query.generationId || req.query.generation_id)
    || db.prepare("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1").get()?.id;
  if (!generationId) return res.json({ success:true, data:[] });
  const rows = timetableSlotsForGeneration(db, generationId);
  const date = cleanText(req.query.date);
  if (date) {
    const subs = db.prepare(`
      SELECT sa.slot_id, sa.substitute_teacher_id, u.name AS substitute_teacher_name
      FROM substitution_assignments sa
      LEFT JOIN users u ON u.id=sa.substitute_teacher_id
      WHERE sa.date=?
    `).all(date);
    const subMap = new Map(subs.map(s => [Number(s.slot_id), s]));
    rows.forEach(row => {
      const sub = subMap.get(Number(row.id));
      if (!sub || !sub.substitute_teacher_id) return;
      row.original_teacher_id = row.teacher_id;
      row.original_teacher_name = row.teacher_name;
      row.teacher_id = sub.substitute_teacher_id;
      row.teacher_name = sub.substitute_teacher_name;
      row.is_substitution = 1;
    });
  }
  res.json({ success:true, data:rows });
});

router.post('/timetable/generations/:id/publish', (req, res) => {
  const db = getDB();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare("UPDATE timetable_generations SET status='archived' WHERE status='active'").run();
    const result = db.prepare("UPDATE timetable_generations SET status='active', published_at=datetime('now') WHERE id=?").run(req.params.id);
    if (!result.changes) throw new Error('Generation not found');
    db.exec('COMMIT');
    res.json({ success:true });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.delete('/timetable/generations/:id', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ success:false, message:'Invalid id' });
  const row = db.prepare('SELECT id, status FROM timetable_generations WHERE id=?').get(id);
  if (!row) return res.json({ success:false, message:'Generation not found' });
  if (row.status === 'active') {
    return res.json({ success:false, message:'Cannot delete the active timetable - publish another first.' });
  }
  db.prepare('DELETE FROM timetable_generations WHERE id=?').run(id);
  res.json({ success:true, message:'Generation deleted' });
});

router.patch('/timetable/slots/:id', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ success:false, message:'Invalid id' });
  const slot = db.prepare('SELECT * FROM timetable_slots WHERE id=?').get(id);
  if (!slot) return res.json({ success:false, message:'Slot not found' });

  const day = Number(req.body?.day_of_week || req.body?.dayOfWeek);
  const period = Number(req.body?.period_no || req.body?.periodNo);
  if (!Number.isInteger(day) || day < 1 || day > 7) return res.json({ success:false, message:'Invalid day_of_week' });
  if (!Number.isInteger(period) || period <= 0) return res.json({ success:false, message:'Invalid period_no' });

  const dup = db.prepare(`
    SELECT id, subject_id FROM timetable_slots
    WHERE generation_id=? AND class_id=? AND day_of_week=? AND period_no=? AND id != ?
  `).get(slot.generation_id, slot.class_id, day, period, id);
  if (dup) return res.json({ success:false, message:'That cell already has a lesson - drop on it to swap instead.' });

  if (slot.teacher_id) {
    const teacherBusy = db.prepare(`
      SELECT s.id, c.name AS class_name
      FROM timetable_slots s
      JOIN classes c ON c.id=s.class_id
      WHERE s.generation_id=? AND s.teacher_id=? AND s.day_of_week=? AND s.period_no=? AND s.id != ?
    `).get(slot.generation_id, slot.teacher_id, day, period, id);
    if (teacherBusy) return res.json({ success:false, message:'Teacher already teaching ' + teacherBusy.class_name + ' at that time' });
  }

  db.prepare('UPDATE timetable_slots SET day_of_week=?, period_no=? WHERE id=?').run(day, period, id);
  res.json({ success:true, slot:{ ...slot, day_of_week:day, period_no:period } });
});

router.patch('/timetable/slots/:id/lock', (req, res) => {
  const db = getDB();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ success:false, message:'Invalid id' });
  const locked = req.body?.locked ? 1 : 0;
  const result = db.prepare('UPDATE timetable_slots SET locked=? WHERE id=?').run(locked, id);
  if (!result.changes) return res.json({ success:false, message:'Slot not found' });
  res.json({ success:true });
});

router.post('/timetable/slots/swap', (req, res) => {
  const db = getDB();
  const a = Number(req.body?.a);
  const b = Number(req.body?.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    return res.json({ success:false, message:'Pass two distinct slot ids' });
  }

  const slotA = db.prepare('SELECT * FROM timetable_slots WHERE id=?').get(a);
  const slotB = db.prepare('SELECT * FROM timetable_slots WHERE id=?').get(b);
  if (!slotA || !slotB) return res.json({ success:false, message:'One or both slots not found' });
  if (slotA.generation_id !== slotB.generation_id) return res.json({ success:false, message:'Slots must belong to the same generation' });

  function classBusyAt(classId, day, period, excludeIds) {
    const placeholders = excludeIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT id FROM timetable_slots
      WHERE generation_id=? AND class_id=? AND day_of_week=? AND period_no=? AND id NOT IN (${placeholders})
    `).get(slotA.generation_id, classId, day, period, ...excludeIds);
  }
  if (classBusyAt(slotA.class_id, slotB.day_of_week, slotB.period_no, [a, b])) {
    return res.json({ success:false, message:'The first class already has a lesson at the target slot' });
  }
  if (classBusyAt(slotB.class_id, slotA.day_of_week, slotA.period_no, [a, b])) {
    return res.json({ success:false, message:'The second class already has a lesson at the target slot' });
  }

  function teacherBusyAt(teacherId, day, period, excludeIds) {
    if (!teacherId) return null;
    const placeholders = excludeIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT s.id, c.name AS class_name
      FROM timetable_slots s
      JOIN classes c ON c.id=s.class_id
      WHERE s.generation_id=? AND s.teacher_id=? AND s.day_of_week=? AND s.period_no=? AND s.id NOT IN (${placeholders})
    `).get(slotA.generation_id, teacherId, day, period, ...excludeIds);
  }
  const conflictA = teacherBusyAt(slotA.teacher_id, slotB.day_of_week, slotB.period_no, [a, b]);
  const conflictB = teacherBusyAt(slotB.teacher_id, slotA.day_of_week, slotA.period_no, [a, b]);
  if (conflictA) return res.json({ success:false, message:'Teacher already teaching ' + conflictA.class_name + ' at the target slot' });
  if (conflictB) return res.json({ success:false, message:'Teacher already teaching ' + conflictB.class_name + ' at the target slot' });

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE timetable_slots SET period_no=? WHERE id=?').run(-a, a);
    db.prepare('UPDATE timetable_slots SET day_of_week=?, period_no=? WHERE id=?').run(slotA.day_of_week, slotA.period_no, b);
    db.prepare('UPDATE timetable_slots SET day_of_week=?, period_no=? WHERE id=?').run(slotB.day_of_week, slotB.period_no, a);
    db.exec('COMMIT');
    res.json({ success:true });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/timetable/absences', (req, res) => {
  const db = getDB();
  const date = cleanText(req.query.date);
  if (!date) return res.json({ success:false, message:'date required' });
  const rows = db.prepare(`
    SELECT a.*, u.name AS teacher_name
    FROM teacher_absences a
    JOIN users u ON u.id=a.teacher_id
    WHERE date(?) BETWEEN date(a.date_from) AND date(a.date_to)
    ORDER BY u.name
  `).all(date);
  res.json({ success:true, data:rows });
});

router.post('/timetable/absences', (req, res) => {
  const db = getDB();
  const teacherId = Number(req.body?.teacher_id || req.body?.teacherId);
  const dateFrom = cleanText(req.body?.date_from || req.body?.dateFrom);
  const dateTo = cleanText(req.body?.date_to || req.body?.dateTo) || dateFrom;
  const reason = cleanText(req.body?.reason) || 'other';
  const notes = cleanText(req.body?.notes) || null;
  if (!Number.isInteger(teacherId) || teacherId <= 0 || !dateFrom) {
    return res.json({ success:false, message:'teacher_id and date_from required' });
  }
  if (!['sick','personal','bereavement','training','other'].includes(reason)) {
    return res.json({ success:false, message:'invalid reason' });
  }
  const teacher = db.prepare("SELECT id FROM users WHERE id=? AND role='teacher' AND status='active'").get(teacherId);
  if (!teacher) return res.json({ success:false, message:'Teacher not found' });
  const id = db.prepare(`
    INSERT INTO teacher_absences (teacher_id, date_from, date_to, reason, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(teacherId, dateFrom, dateTo, reason, notes, req.session.user.id).lastInsertRowid;
  const row = db.prepare(`
    SELECT a.*, u.name AS teacher_name
    FROM teacher_absences a
    JOIN users u ON u.id=a.teacher_id
    WHERE a.id=?
  `).get(id);
  res.json({ success:true, data:row });
});

router.delete('/timetable/absences/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ success:false, message:'Invalid id' });
  const result = getDB().prepare('DELETE FROM teacher_absences WHERE id=?').run(id);
  if (!result.changes) return res.json({ success:false, message:'Not found' });
  res.json({ success:true });
});

router.post('/timetable/substitutions', (req, res) => {
  const db = getDB();
  const slotId = Number(req.body?.slot_id || req.body?.slotId);
  const date = cleanText(req.body?.date);
  const originalTeacherId = optionalId(req.body?.original_teacher_id || req.body?.originalTeacherId);
  const substituteTeacherId = optionalId(req.body?.substitute_teacher_id || req.body?.substituteTeacherId);
  const absenceId = optionalId(req.body?.absence_id || req.body?.absenceId);
  if (!slotId || !date) return res.json({ success:false, message:'slot_id and date required' });

  const slot = db.prepare('SELECT * FROM timetable_slots WHERE id=?').get(slotId);
  if (!slot) return res.json({ success:false, message:'Slot not found' });
  if (substituteTeacherId) {
    const teacher = db.prepare("SELECT id FROM users WHERE id=? AND role='teacher' AND status='active'").get(substituteTeacherId);
    if (!teacher) return res.json({ success:false, message:'Substitute teacher not found' });
    const busy = db.prepare(`
      SELECT 1
      FROM timetable_slots
      WHERE generation_id=? AND teacher_id=? AND day_of_week=? AND period_no=? AND id != ?
    `).get(slot.generation_id, substituteTeacherId, slot.day_of_week, slot.period_no, slotId);
    if (busy) return res.json({ success:false, message:'That teacher is already teaching another class at this time' });
  }
  db.prepare(`
    INSERT INTO substitution_assignments (slot_id, absence_id, date, original_teacher_id, substitute_teacher_id)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slot_id, date) DO UPDATE SET
      absence_id=excluded.absence_id,
      substitute_teacher_id=excluded.substitute_teacher_id,
      original_teacher_id=excluded.original_teacher_id
  `).run(slotId, absenceId || null, date, originalTeacherId || slot.teacher_id || null, substituteTeacherId || null);
  res.json({ success:true });
});

router.post('/timetable/substitutions/notify', (req, res) => {
  const db = getDB();
  const slotIds = Array.isArray(req.body?.slot_ids || req.body?.slotIds)
    ? (req.body.slot_ids || req.body.slotIds).map(Number).filter(Boolean)
    : [];
  const date = cleanText(req.body?.date);
  if (!slotIds.length || !date) return res.json({ success:false, message:'slot_ids and date required' });
  const placeholders = slotIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT sa.*, ts.subject_id, ts.period_no, ts.day_of_week, ts.class_id,
           c.name AS class_name, s.name AS subject_name,
           u.name AS sub_name, u.user_id AS sub_login_id
    FROM substitution_assignments sa
    JOIN timetable_slots ts ON ts.id=sa.slot_id
    JOIN classes c ON c.id=ts.class_id
    JOIN subjects s ON s.id=ts.subject_id
    LEFT JOIN users u ON u.id=sa.substitute_teacher_id
    WHERE sa.date=? AND sa.slot_id IN (${placeholders})
      AND sa.substitute_teacher_id IS NOT NULL
  `).all(date, ...slotIds);

  const insertNotif = db.prepare(`
    INSERT INTO notifications (title, body, audience, target_class_id, created_by_role, created_by_id, type, sent_at, role_scope)
    VALUES (?, ?, ?, ?, 'admin', ?, 'substitution', datetime('now'), 'teacher')
  `);
  const mark = db.prepare("UPDATE substitution_assignments SET notified_at=datetime('now') WHERE id=?");
  let notified = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    rows.forEach(row => {
      const title = 'Substitution: ' + row.subject_name + ' for ' + row.class_name;
      const body = 'Please cover ' + row.subject_name + ' for ' + row.class_name + ' on ' + date + ' (period ' + row.period_no + '). Original teacher is absent.';
      insertNotif.run(title, body, 'teacher:' + row.substitute_teacher_id, row.class_id, req.session.user.id);
      mark.run(row.id);
      notified++;
    });
    db.exec('COMMIT');
    res.json({ success:true, notified });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.post('/timetable/substitutions/notify-parents', (req, res) => {
  const db = getDB();
  const absenceId = Number(req.body?.absence_id || req.body?.absenceId);
  const date = cleanText(req.body?.date);
  if (!Number.isInteger(absenceId) || absenceId <= 0 || !date) {
    return res.json({ success:false, message:'absence_id and date required' });
  }
  const absence = db.prepare(`
    SELECT a.*, u.name AS teacher_name
    FROM teacher_absences a
    JOIN users u ON u.id=a.teacher_id
    WHERE a.id=?
  `).get(absenceId);
  if (!absence) return res.json({ success:false, message:'Absence not found' });
  const classes = db.prepare(`
    SELECT DISTINCT c.id, c.name
    FROM substitution_assignments sa
    JOIN timetable_slots ts ON ts.id=sa.slot_id
    JOIN classes c ON c.id=ts.class_id
    WHERE sa.absence_id=? AND sa.date=?
  `).all(absenceId, date);
  const insertNotif = db.prepare(`
    INSERT INTO notifications (title, body, audience, target_class_id, created_by_role, created_by_id, type, sent_at, role_scope)
    VALUES (?, ?, ?, ?, 'admin', ?, 'substitution', datetime('now'), 'parent')
  `);
  try {
    db.exec('BEGIN IMMEDIATE');
    classes.forEach(c => {
      const body = absence.teacher_name + ' is absent today. A substitute teacher is covering ' + c.name + "'s lessons.";
      insertNotif.run('Teacher absent - ' + c.name, body, 'class:' + c.id + ':parents', c.id, req.session.user.id);
    });
    db.exec('COMMIT');
    res.json({ success:true, classes_notified:classes.length });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/bookings', (req, res) => {
  const status = cleanText(req.query.status) || 'pending';
  const allowed = ['pending','approved','declined','cancelled'];
  if (!allowed.includes(status)) return res.json({ success:false, message:'Invalid status' });
  const rows = getDB().prepare(`
    SELECT b.*, c.name AS class_name, s.name AS subject_name, u.name AS teacher_name
    FROM lesson_bookings b
    JOIN classes c ON c.id=b.class_id
    JOIN subjects s ON s.id=b.subject_id
    JOIN users u ON u.id=b.teacher_id
    WHERE b.status=?
    ORDER BY datetime(b.created_at) DESC, b.id DESC
    LIMIT 100
  `).all(status);
  res.json({ success:true, data:rows });
});

router.patch('/bookings/:id', (req, res) => {
  const db = getDB();
  const status = cleanText(req.body?.status);
  const note = cleanText(req.body?.note);
  if (!['approved','declined'].includes(status)) return res.json({ success:false, message:'status must be approved or declined' });
  const row = db.prepare('SELECT * FROM lesson_bookings WHERE id=?').get(req.params.id);
  if (!row) return res.json({ success:false, message:'Not found' });
  if (row.status !== 'pending') return res.json({ success:false, message:'Already decided' });

  if (status === 'approved') {
    const active = db.prepare("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1").get();
    if (active) {
      const taken = db.prepare(`
        SELECT id FROM timetable_slots
        WHERE generation_id=? AND class_id=? AND day_of_week=? AND period_no=?
      `).get(active.id, row.class_id, row.day_of_week, row.period_no);
      if (taken) return res.json({ success:false, message:'That class slot is no longer free' });
      const teacherBusy = db.prepare(`
        SELECT id FROM timetable_slots
        WHERE generation_id=? AND teacher_id=? AND day_of_week=? AND period_no=?
      `).get(active.id, row.teacher_id, row.day_of_week, row.period_no);
      if (teacherBusy) return res.json({ success:false, message:'Teacher already has a timetable lesson at that time' });
    }
    const bookingConflict = db.prepare(`
      SELECT id FROM lesson_bookings
      WHERE teacher_id=? AND date=? AND day_of_week=? AND period_no=? AND status='approved' AND id != ?
    `).get(row.teacher_id, row.date, row.day_of_week, row.period_no, row.id);
    if (bookingConflict) return res.json({ success:false, message:'Teacher already has an approved booking at that time' });
  }

  db.prepare(`
    UPDATE lesson_bookings
    SET status=?, decided_by=?, decided_at=datetime('now'), decision_note=?
    WHERE id=?
  `).run(status, req.session.user.id, note || null, req.params.id);

  try {
    const cls = db.prepare('SELECT name FROM classes WHERE id=?').get(row.class_id);
    const subject = db.prepare('SELECT name FROM subjects WHERE id=?').get(row.subject_id);
    db.prepare(`
      INSERT INTO notifications (title, body, audience, target_class_id, created_by_role, created_by_id, type, sent_at, role_scope)
      VALUES (?, ?, ?, ?, 'admin', ?, 'booking-decision', datetime('now'), 'teacher')
    `).run(
      'Booking ' + status + ': ' + (subject?.name || '') + ' in ' + (cls?.name || ''),
      'Your request to teach ' + (subject?.name || '') + ' in ' + (cls?.name || '') + ' on ' + row.date + ' (period ' + row.period_no + ') was ' + status + '. ' + (note ? 'Note: ' + note : ''),
      'teacher:' + row.teacher_id,
      row.class_id,
      req.session.user.id
    );
  } catch {}

  res.json({ success:true });
});

router.post('/timetable/generate', (req, res) => {
  const db = getDB();
  const startTime = Date.now();
  const periods = db.prepare("SELECT * FROM bell_periods WHERE schedule_id=1 AND type='lesson' ORDER BY period_no").all()
    .map(p => ({ ...p, active_days:normalizeTimetableActiveDays(p.active_days) }));
  const lessonPeriodNos = periods.map(p => p.period_no);
  const slotPairs = [];
  periods.forEach(p => {
    p.active_days.forEach(dayName => {
      const day = TIMETABLE_DAY_NUM[dayName];
      if (day) slotPairs.push({ day, periodNo:p.period_no });
    });
  });
  const classes = db.prepare("SELECT * FROM classes WHERE status='active' ORDER BY name").all();
  const classActivePeriods = new Map();
  classes.forEach(c => {
    const periods = safeJson(c.active_periods, null);
    const allowed = Array.isArray(periods)
      ? [...new Set(periods.map(Number).filter(n => Number.isInteger(n) && n > 0))]
      : [];
    classActivePeriods.set(c.id, allowed.length ? new Set(allowed) : null);
  });
  const availableCells = classes.reduce((sum, c) => {
    const allowed = classActivePeriods.get(c.id);
    const periodCount = allowed ? allowed.size : lessonPeriodNos.length;
    return sum + (periodCount * TIMETABLE_DAYS.length);
  }, 0);
  const bodyLessons = req.body?.lessons_per_week && typeof req.body.lessons_per_week === 'object' ? req.body.lessons_per_week : {};
  const rawLessons = db.prepare(`
    SELECT cs.class_id, cs.subject_id, cs.teacher_id, cs.lessons_per_week, cs.double_periods, cs.locked_slots,
           c.name AS class_name, s.name AS subject_name, u.name AS teacher_name
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    LEFT JOIN users u ON u.id=cs.teacher_id
  `).all().map(l => {
    const override = bodyLessons[l.class_id + ':' + l.subject_id];
    return {
      ...l,
      lessons_per_week:override ? Number(override.count ?? override.lessons_per_week) || 0 : Number(l.lessons_per_week) || 0,
      double_periods:override ? (override.double ? 1 : Number(override.double_periods) || 0) : Number(l.double_periods) || 0
    };
  });
  const lessons = rawLessons.filter(l => l.lessons_per_week > 0);
  const dbConstraints = db.prepare('SELECT * FROM teacher_constraints').all();
  const requestConstraints = req.body?.teacher_constraints && typeof req.body.teacher_constraints === 'object' ? req.body.teacher_constraints : {};
  const cMap = new Map(dbConstraints.map(c => [Number(c.teacher_id), {
    ...c,
    max_per_day:Number(c.max_per_day) || 6,
    max_per_week:Number(c.max_per_week) || 30,
    unavail:new Set(safeJson(c.unavailable_slots, []))
  }]));
  Object.entries(requestConstraints).forEach(([teacherId, c]) => {
    const id = Number(teacherId);
    const unavail = Array.isArray(c.unavail) ? c.unavail : Array.isArray(c.unavailable_slots) ? c.unavailable_slots : [];
    cMap.set(id, {
      teacher_id:id,
      max_per_day:Number(c.max_day ?? c.max_per_day) || 6,
      max_per_week:Number(c.max_week ?? c.max_per_week) || 30,
      preferred_off_day:c.off_day || c.preferred_off_day || null,
      unavail:new Set(unavail)
    });
  });
  const softRules = req.body.soft_constraints || {};
  const queue = [];
  lessons.forEach(l => {
    for (let i = 0; i < l.lessons_per_week; i++) {
      queue.push({
        class_id:l.class_id, subject_id:l.subject_id, teacher_id:l.teacher_id,
        class_name:l.class_name, subject_name:l.subject_name, teacher_name:l.teacher_name,
        weight:l.lessons_per_week
      });
    }
  });
  queue.sort((a,b) => b.weight - a.weight || String(a.subject_name).localeCompare(String(b.subject_name)));

  const classGrid = {};
  const teacherGrid = {};
  const teacherDaily = {};
  const teacherWeekly = {};
  classes.forEach(c => { classGrid[c.id] = [null, {}, {}, {}, {}, {}]; });

  function isFree(lesson, day, periodNo) {
    if (!classGrid[lesson.class_id] || classGrid[lesson.class_id][day]?.[periodNo]) return false;
    if (lesson.teacher_id) {
      if (teacherGrid[lesson.teacher_id]?.[day]?.[periodNo]) return false;
      const tc = cMap.get(Number(lesson.teacher_id));
      if (tc?.unavail?.has(day + ':' + periodNo)) return false;
      if ((teacherDaily[lesson.teacher_id]?.[day] || 0) >= (tc?.max_per_day || 6)) return false;
      if ((teacherWeekly[lesson.teacher_id] || 0) >= (tc?.max_per_week || 30)) return false;
    }
    return true;
  }
  function place(lesson, day, periodNo) {
    classGrid[lesson.class_id][day][periodNo] = lesson;
    if (lesson.teacher_id) {
      if (!teacherGrid[lesson.teacher_id]) teacherGrid[lesson.teacher_id] = [null, {}, {}, {}, {}, {}];
      if (!teacherDaily[lesson.teacher_id]) teacherDaily[lesson.teacher_id] = [null, 0, 0, 0, 0, 0];
      teacherGrid[lesson.teacher_id][day][periodNo] = lesson;
      teacherDaily[lesson.teacher_id][day] += 1;
      teacherWeekly[lesson.teacher_id] = (teacherWeekly[lesson.teacher_id] || 0) + 1;
    }
  }
  function scoreSlot(lesson, day, periodNo) {
    let score = 100;
    if (softRules['no-3-in-a-row'] !== false) {
      const prev = classGrid[lesson.class_id][day][periodNo - 1];
      const prev2 = classGrid[lesson.class_id][day][periodNo - 2];
      if (prev?.subject_id === lesson.subject_id && prev2?.subject_id === lesson.subject_id) score -= 30;
    }
    if (softRules['core-morning'] !== false) {
      const core = /math|english/i.test(lesson.subject_name);
      const periodIdx = lessonPeriodNos.indexOf(periodNo);
      const isMorning = periodIdx < Math.floor(lessonPeriodNos.length / 2);
      if (core && !isMorning) score -= 10;
    }
    if (softRules.spread !== false) {
      const sameDayCount = Object.values(classGrid[lesson.class_id][day]).filter(s => s?.subject_id === lesson.subject_id).length;
      score -= sameDayCount * 12;
    }
    if (softRules['balance-load'] !== false && lesson.teacher_id) {
      const tc = cMap.get(Number(lesson.teacher_id));
      if (tc?.preferred_off_day === TIMETABLE_DAY_NAMES[day]) score -= 15;
      score -= Math.max(0, ((teacherDaily[lesson.teacher_id]?.[day] || 0) - 3) * 4);
    }
    return score;
  }

  const conflicts = [];
  let placed = 0;
  for (const lesson of queue) {
    const allowed = classActivePeriods.get(lesson.class_id);
    let best = null;
    for (const { day, periodNo } of slotPairs) {
      if (allowed && !allowed.has(periodNo)) continue;
      if (!isFree(lesson, day, periodNo)) continue;
      const score = scoreSlot(lesson, day, periodNo);
      if (!best || score > best.score) best = { day, periodNo, score };
    }
    if (best) {
      place(lesson, best.day, best.periodNo);
      placed++;
      if (best.score < 70) conflicts.push({ severity:'soft', message:`${lesson.class_name} · ${lesson.subject_name} placed with compromise (score ${best.score})` });
    } else {
      conflicts.push({ severity:'hard', message:`Couldn't place ${lesson.class_name} · ${lesson.subject_name} — no free slot` });
    }
  }

  const total = queue.length;
  const placementScore = total ? Math.round((placed / total) * 60) : 0;
  const softScore = total ? Math.round((1 - conflicts.filter(c => c.severity === 'soft').length / total) * 40) : 40;
  const score = Math.max(0, Math.min(100, placementScore + softScore));
  const termId = currentAdminTerm(db)?.id || null;

  try {
    db.exec('BEGIN IMMEDIATE');
    const genId = db.prepare(`
      INSERT INTO timetable_generations (term_id, schedule_id, status, score, placed, total, conflicts, conflicts_json, soft_rules_json, generated_by)
      VALUES (?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?)
    `).run(termId, score, placed, total, conflicts.length, JSON.stringify(conflicts), JSON.stringify(softRules), req.session.user.id).lastInsertRowid;
    const insSlot = db.prepare(`
      INSERT INTO timetable_slots (generation_id, class_id, day_of_week, period_no, subject_id, teacher_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const slots = [];
    Object.keys(classGrid).forEach(cId => {
      const allowed = classActivePeriods.get(Number(cId));
      slotPairs.forEach(({ day, periodNo }) => {
        if (allowed && !allowed.has(periodNo)) return;
        const lesson = classGrid[cId][day][periodNo];
        if (!lesson) return;
        insSlot.run(genId, cId, day, periodNo, lesson.subject_id, lesson.teacher_id || null);
        slots.push({
          class_id:Number(cId), day_of_week:day, period_no:periodNo,
          subject_id:lesson.subject_id, teacher_id:lesson.teacher_id,
          class_name:lesson.class_name, subject_name:lesson.subject_name, teacher_name:lesson.teacher_name
        });
      });
    });
    db.exec('COMMIT');
    res.json({ success:true, data:{ id:genId, status:'draft', score, placed, total, available_cells:availableCells, conflicts:conflicts, slots, generated_at:new Date().toISOString(), ms:Date.now() - startTime } });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
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

router.post('/learners/import', (req, res) => {
  const db = getDB();
  const learners = Array.isArray(req.body?.learners) ? req.body.learners : null;
  if (!learners || !learners.length) return res.json({ success:false, message:'No learners provided' });

  const classMap = new Map(
    db.prepare("SELECT name FROM classes WHERE status='active'").all()
      .map(c => [String(c.name).toUpperCase(), c.name])
  );
  const existingAdm = new Set(
    db.prepare("SELECT admission_no FROM users WHERE role='learner' AND admission_no IS NOT NULL AND TRIM(admission_no)<>''").all()
      .map(r => String(r.admission_no).toUpperCase())
  );
  const existingUserIds = new Set(
    db.prepare("SELECT user_id FROM users").all().map(r => String(r.user_id).toUpperCase())
  );

  function nextImportLearnerId() {
    let id;
    do { id = genId('LRN'); } while (existingUserIds.has(id.toUpperCase()));
    existingUserIds.add(id.toUpperCase());
    return id;
  }

  const insert = db.prepare(`
    INSERT INTO users (user_id, name, admission_no, sex, class_name, date_of_birth, phone, role, status, password)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'learner', 'active', ?)
  `);

  let created = 0;
  let skipped = 0;
  const errors = [];
  const defaultPassword = bcrypt.hashSync('joyland123', 10);

  try {
    db.exec('BEGIN IMMEDIATE');
    learners.forEach((r, i) => {
      const name = cleanText(r.name);
      const adm = cleanText(r.admission_no || r.admissionNo);
      const rawSex = cleanText(r.sex).toUpperCase();
      const sex = rawSex === 'MALE' ? 'M' : rawSex === 'FEMALE' ? 'F' : rawSex;
      const cls = cleanText(r.class || r.class_name || r.className);
      const dob = cleanText(r.dob || r.date_of_birth || r.dateOfBirth) || null;
      const phone = cleanText(r.phone) || null;
      const className = classMap.get(cls.toUpperCase());

      if (!name || !adm || !cls) { errors.push({ row:i + 1, reason:'Missing required field' }); skipped++; return; }
      if (existingAdm.has(adm.toUpperCase())) { errors.push({ row:i + 1, reason:'Duplicate admission number: ' + adm }); skipped++; return; }
      if (!className) { errors.push({ row:i + 1, reason:'Unknown class: ' + cls }); skipped++; return; }
      if (sex && !['M','F'].includes(sex)) { errors.push({ row:i + 1, reason:'Sex must be M or F' }); skipped++; return; }
      if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) { errors.push({ row:i + 1, reason:'DOB must be YYYY-MM-DD' }); skipped++; return; }

      insert.run(nextImportLearnerId(), name, adm, sex || null, className, dob, phone, defaultPassword);
      existingAdm.add(adm.toUpperCase());
      created++;
    });
    db.exec('COMMIT');
    res.json({ success:true, created, skipped, errors });
  } catch(e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.json({ success:false, message:e.message });
  }
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
  const code = uniqueSubjectCode(db, name, req.body.code);
  const level = cleanText(req.body.level) || null;
  const description = cleanText(req.body.description) || null;
  try {
    const id = db.prepare("INSERT INTO subjects (name, code, level, description, status) VALUES (?,?,?,?,'active')")
      .run(name, code, level, description).lastInsertRowid;
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
  const db = getDB();
  const classId = optionalId(req.query.class_id || req.query.classId);
  const subjectId = optionalId(req.query.subject_id || req.query.subjectId);
  const teacherId = optionalId(req.query.teacher_id || req.query.teacherId);
  const where = [];
  const params = [];
  if (classId) { where.push('cs.class_id=?'); params.push(classId); }
  if (subjectId) { where.push('cs.subject_id=?'); params.push(subjectId); }
  if (teacherId) { where.push('cs.teacher_id=?'); params.push(teacherId); }
  const rows = db.prepare(`
    SELECT cs.id, cs.class_id, cs.subject_id, cs.teacher_id,
           c.name AS class_name, c.grade_level,
           s.name AS subject_name, s.code AS subject_code,
           t.name AS teacher_name
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    LEFT JOIN users t ON t.id=cs.teacher_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.name, s.name
  `).all(...params);
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
router.get('/school-day', (req, res) => {
  const date = cleanText(req.query.date) || todayInSchoolTime();
  res.json({ success:true, data:resolveSchoolDay(getDB(), date) });
});

router.get('/attendance', (req, res) => {
  const db = getDB();
  const class_id = req.query.class_id || req.query.classId;
  const { date } = req.query;
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
  const class_id = req.body.class_id || req.body.classId;
  const term_id = req.body.term_id || req.body.termId;
  const { date } = req.body;
  const replaceAll = Array.isArray(req.body.entries);
  const entries = Array.isArray(req.body.entries)
    ? req.body.entries
    : (req.body.learnerId || req.body.learner_id)
      ? [{ learner_id:req.body.learner_id || req.body.learnerId, status:req.body.status, note:req.body.note }]
      : null;
  if (!class_id || !term_id || !date || !Array.isArray(entries)) return res.json({ success:false, message:'Invalid data' });
  const day = resolveSchoolDay(db, date);
  if (!day.is_school_day) return res.status(400).json({ success:false, message:day.message, data:{ day_status:day } });
  if (String(term_id) !== String(day.term.id)) {
    return res.status(400).json({ success:false, message:'Selected term does not match the attendance date', data:{ day_status:day } });
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare("SELECT id FROM attendance_records WHERE class_id=? AND date=?").get(class_id, date);
    let recordId;
    if (existing) {
      recordId = existing.id;
      if (replaceAll) db.prepare("DELETE FROM attendance_entries WHERE record_id=?").run(recordId);
    } else {
      recordId = db.prepare("INSERT INTO attendance_records (class_id, term_id, date, created_by) VALUES (?,?,?,?)")
        .run(class_id, term_id, date, req.session.user.id).lastInsertRowid;
    }
    const ins = replaceAll
      ? db.prepare("INSERT INTO attendance_entries (record_id, learner_id, status, note) VALUES (?,?,?,?)")
      : db.prepare(`
          INSERT INTO attendance_entries (record_id, learner_id, status, note)
          VALUES (?,?,?,?)
          ON CONFLICT(record_id, learner_id) DO UPDATE SET status=excluded.status, note=excluded.note
        `);
    entries.forEach(e => {
      const learnerId = e.learner_id || e.learnerId;
      if (learnerId && e.status) ins.run(recordId, learnerId, e.status, e.note || null);
    });
    db.exec('COMMIT');
    res.json({ success:true, message:'Attendance saved' });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.post('/attendance/bulk', (req, res) => {
  const db = getDB();
  const class_id = req.body.class_id || req.body.classId;
  const term_id = req.body.term_id || req.body.termId;
  const date = cleanText(req.body.date) || todayInSchoolTime();
  const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!class_id || !term_id || !entries.length) return res.json({ success:false, message:'Invalid data' });
  const day = resolveSchoolDay(db, date);
  if (!day.is_school_day) return res.status(400).json({ success:false, message:day.message, data:{ day_status:day } });
  if (String(term_id) !== String(day.term.id)) {
    return res.status(400).json({ success:false, message:'Selected term does not match the attendance date', data:{ day_status:day } });
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const existing = db.prepare("SELECT id FROM attendance_records WHERE class_id=? AND date=?").get(class_id, date);
    let recordId = existing?.id;
    if (!recordId) {
      recordId = db.prepare("INSERT INTO attendance_records (class_id, term_id, date, created_by) VALUES (?,?,?,?)")
        .run(class_id, term_id, date, req.session.user.id).lastInsertRowid;
    }
    const upsert = db.prepare(`
      INSERT INTO attendance_entries (record_id, learner_id, status, note)
      VALUES (?,?,?,?)
      ON CONFLICT(record_id, learner_id) DO UPDATE SET status=excluded.status, note=excluded.note
    `);
    entries.forEach(e => {
      const learnerId = e.learner_id || e.learnerId;
      if (learnerId && e.status) upsert.run(recordId, learnerId, e.status, e.note || null);
    });
    db.exec('COMMIT');
    res.json({ success:true, message:'Attendance saved' });
  } catch(e) {
    db.exec('ROLLBACK');
    res.json({ success:false, message:e.message });
  }
});

router.get('/attendance/summary', (req, res) => {
  const db = getDB();
  const range = cleanText(req.query.range).toLowerCase();
  if (range === 'today' || req.query.date) {
    const date = cleanText(req.query.date) || todayInSchoolTime();
    const classId = optionalId(req.query.class_id || req.query.classId);
    const params = [date];
    let classFilter = '';
    if (classId) { classFilter = ' AND ar.class_id=?'; params.push(classId); }
    const rows = db.prepare(`
      SELECT ar.class_id, c.name AS class_name,
        COUNT(ae.id) AS marked,
        SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
      FROM attendance_records ar
      JOIN classes c ON c.id=ar.class_id
      LEFT JOIN attendance_entries ae ON ae.record_id=ar.id
      WHERE ar.date=?${classFilter}
      GROUP BY ar.class_id, c.name
      ORDER BY c.name
    `).all(...params);
    const totalLearners = classId
      ? db.prepare(`
          SELECT COUNT(*) c FROM users u
          JOIN classes c ON lower(c.name)=lower(u.class_name)
          WHERE u.role='learner' AND u.status='active' AND c.id=?
        `).get(classId).c
      : db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner' AND status='active'").get().c;
    const present = rows.reduce((sum,row) => sum + Number(row.present || 0), 0);
    const absent = rows.reduce((sum,row) => sum + Number(row.absent || 0), 0);
    const late = rows.reduce((sum,row) => sum + Number(row.late || 0), 0);
    return res.json({ success:true, data:{
      date, total:totalLearners, present, absent, late,
      percent:totalLearners ? Math.round((present / totalLearners) * 1000) / 10 : 0,
      classes:rows
    }});
  }
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
  const class_id = req.query.class_id || req.query.classId;
  let term_id = req.query.term_id || req.query.termId;
  const assessment_type = req.query.assessment_type || req.query.assessmentType;
  const subject_id = req.query.subject_id || req.query.subjectId;
  if (!term_id) term_id = currentAdminTerm(db)?.id;
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
  const class_id = req.body.class_id || req.body.classId;
  let term_id = req.body.term_id || req.body.termId;
  if (!term_id) term_id = currentAdminTerm(db)?.id;
  const assessment_type = req.body.assessment_type || req.body.assessmentType;
  const entries = Array.isArray(req.body.entries)
    ? req.body.entries
    : (req.body.learnerId || req.body.learner_id)
      ? [{
          learner_id:req.body.learner_id || req.body.learnerId,
          subject_id:req.body.subject_id || req.body.subjectId,
          component_key:req.body.component_key || req.body.componentKey || 'exam',
          score:req.body.score
        }]
      : null;
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

router.post('/marks/publish', (req, res) => {
  const classId = req.body.class_id || req.body.classId;
  const subjectId = req.body.subject_id || req.body.subjectId;
  const assessmentType = req.body.assessment_type || req.body.assessmentType;
  if (!classId || !subjectId || !assessmentType) return res.json({ success:false, message:'class, subject and assessment are required' });
  res.json({ success:true, message:'Marks published' });
});

// ══════════ ASSESSMENT COMPONENTS ══════════
router.get('/assessment-components', (req, res) => {
  const db = getDB();
  const class_id = req.query.class_id || req.query.classId;
  const subject_id = req.query.subject_id || req.query.subjectId;
  const assessment_type = req.query.assessment_type || req.query.assessmentType;
  if (!class_id && !subject_id && !assessment_type) {
    const termId = currentAdminTerm(db)?.id;
    const rows = db.prepare(`
      SELECT ac.*, c.name AS class_name, s.name AS subject_name,
        (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.status='active' AND lower(u.class_name)=lower(c.name)) AS total,
        (SELECT COUNT(DISTINCT m.learner_id) FROM marks m
          WHERE m.class_id=ac.class_id AND m.subject_id=ac.subject_id AND m.assessment_type=ac.assessment_type
            AND m.component_key=ac.component_key AND (? IS NULL OR m.term_id=?)
            AND m.score IS NOT NULL) AS done,
        (SELECT AVG(m.score) FROM marks m
          WHERE m.class_id=ac.class_id AND m.subject_id=ac.subject_id AND m.assessment_type=ac.assessment_type
            AND m.component_key=ac.component_key AND (? IS NULL OR m.term_id=?)
            AND m.score IS NOT NULL) AS mean
      FROM assessment_components ac
      JOIN classes c ON c.id=ac.class_id
      JOIN subjects s ON s.id=ac.subject_id
      ORDER BY ac.assessment_type, c.name, s.name, ac.sort_order, ac.component_name
    `).all(termId, termId, termId, termId);
    return res.json({ success:true, data:rows });
  }
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
  const assessment_type = req.query.assessment_type || req.query.assessmentType || null;
  if (!class_id || !term_id) return res.json({ success:false, message:'class_id and term_id required' });
  if (assessment_type && !ASSESSMENT_TYPES.includes(assessment_type)) return res.json({ success:false, message:'Invalid assessment_type' });
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
  let marksSql = "SELECT * FROM marks WHERE class_id=? AND term_id=?";
  const marksParams = [class_id, term_id];
  if (assessment_type) {
    marksSql += " AND assessment_type=?";
    marksParams.push(assessment_type);
  }
  const allMarks = db.prepare(marksSql).all(...marksParams);
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
  res.json({ success:true, data:{ class:classRow, term:termRow, assessment_type, school:getSchoolSettings(db), subjects, learners:rows, cbc_levels:CBC_LEVELS } });
});

router.get('/cohort-tracker', (req, res) => {
  const db = getDB();
  const classId = Number(req.query.classId || req.query.class_id || 0);
  if (!classId) return res.status(400).json({ success:false, message:'classId is required' });

  const classRow = db.prepare('SELECT id, name FROM classes WHERE id=?').get(classId);
  if (!classRow) return res.status(404).json({ success:false, message:'Class not found' });

  const terms = db.prepare(`
    SELECT DISTINCT
      t.id AS term_id,
      t.term_name,
      t.term_number,
      t.start_date,
      s.id AS session_id,
      s.name AS session_name,
      s.year AS session_year
    FROM marks m
    JOIN terms t ON t.id=m.term_id
    JOIN academic_sessions s ON s.id=t.session_id
    WHERE m.class_id=?
      AND m.score IS NOT NULL
    ORDER BY date(t.start_date) ASC, t.id ASC
  `).all(classId);

  const learners = db.prepare(`
    SELECT id FROM users
    WHERE role='learner' AND status='active' AND class_name=?
  `).all(classRow.name);

  const points = terms.map((term) => {
    const rows = db.prepare('SELECT * FROM marks WHERE class_id=? AND term_id=? AND score IS NOT NULL')
      .all(classId, term.term_id);
    const learnerMeans = learnerAveragesFromMarks(rows, learners);
    const mean = averageNumbers(learnerMeans.map((item) => item.mean));
    if (mean === null) return null;
    return {
      term_id:term.term_id,
      label:formatTermPointLabel(term),
      session_name:term.session_name || term.session_year || '',
      term_name:term.term_name,
      mean:roundOne(mean),
      learner_count:learnerMeans.length
    };
  }).filter(Boolean);

  res.json({ success:true, data:{ class_id:classRow.id, class_name:classRow.name, points } });
});

router.get('/equity-splits', (req, res) => {
  const db = getDB();
  const requestedTermId = req.query.termId || req.query.term_id || null;
  const resolved = resolveDisplayTerm(db, requestedTermId ? Number(requestedTermId) : null, false);
  if (!resolved.term) return res.json({ success:false, message:'No term available' });
  const termId = resolved.term.id;
  const hasBoardingColumn = adminTableHasColumn(db, 'users', 'is_boarder');
  const boardingSelect = hasBoardingColumn ? ', u.is_boarder' : ', NULL AS is_boarder';

  const learnerRows = db.prepare(`
    SELECT DISTINCT u.id, u.sex ${boardingSelect}
    FROM users u
    JOIN marks m ON m.learner_id=u.id
    WHERE u.role='learner'
      AND m.term_id=?
      AND m.score IS NOT NULL
  `).all(termId);

  const marksRows = db.prepare('SELECT * FROM marks WHERE term_id=? AND score IS NOT NULL').all(termId);
  const learnerMeans = learnerAveragesFromMarks(marksRows);
  const meanByLearner = new Map(learnerMeans.map((item) => [Number(item.learner_id), item]));
  const attendanceRows = db.prepare(`
    SELECT
      ae.learner_id,
      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present_days,
      COUNT(*) AS total_days
    FROM attendance_entries ae
    JOIN attendance_records ar ON ar.id=ae.record_id
    WHERE ar.term_id=?
    GROUP BY ae.learner_id
  `).all(termId);
  const attendanceByLearner = new Map(attendanceRows.map((row) => [
    Number(row.learner_id),
    { present:Number(row.present_days || 0), total:Number(row.total_days || 0) }
  ]));

  const markedLearners = learnerRows.map((learner) => {
    const marks = meanByLearner.get(Number(learner.id));
    if (!marks) return null;
    const attendance = attendanceByLearner.get(Number(learner.id)) || { present:0, total:0 };
    const attendanceRate = attendance.total ? attendance.present / attendance.total : 0;
    return {
      id:Number(learner.id),
      sex:learner.sex,
      is_boarder:learner.is_boarder,
      attendance_rate:attendanceRate,
      mean:marks.mean
    };
  }).filter(Boolean);

  const bySex = groupedMean(markedLearners, (learner) => {
    const raw = String(learner.sex || '').trim();
    return raw ? sexLabel(raw) : null;
  }).sort((a, b) => {
    const order = { Female:1, Male:2 };
    return (order[a.label] || 99) - (order[b.label] || 99) || a.label.localeCompare(b.label);
  });

  const attendanceOrder = { '≥90%':1, '75–89%':2, '<75%':3 };
  const byAttendance = groupedMean(markedLearners, (learner) => attendanceBand(learner.attendance_rate))
    .sort((a, b) => (attendanceOrder[a.label] || 99) - (attendanceOrder[b.label] || 99));

  let byBoarding = [];
  if (hasBoardingColumn) {
    const distinctBoardingValues = new Set(markedLearners.map((learner) => Number(learner.is_boarder || 0)));
    if (distinctBoardingValues.size > 1) {
      byBoarding = groupedMean(markedLearners, (learner) => Number(learner.is_boarder || 0) === 1 ? 'Boarding' : 'Day')
        .sort((a, b) => (a.label === 'Day' ? -1 : 1) - (b.label === 'Day' ? -1 : 1));
    }
  }

  res.json({ success:true, data:{
    term_id:termId,
    term_name:resolved.term.term_name || resolved.term.name || '',
    session_name:resolved.term.session_name || '',
    learner_count:markedLearners.length,
    by_sex:bySex,
    by_attendance:byAttendance,
    by_boarding:byBoarding
  } });
});

router.get('/marks/analysis', (req, res) => {
  const db = getDB();
  const strict = String(req.query.strict || '').toLowerCase() === 'true';
  const requestedTermId = req.query.term_id || req.query.termId || null;
  const stage = String(req.query.stage || 'combined').toLowerCase();
  if (!['combined', 'midterm', 'endterm'].includes(stage)) {
    return res.json({ success:false, message:'Invalid stage' });
  }
  const resolved = resolveDisplayTerm(db, requestedTermId ? Number(requestedTermId) : null, strict);
  if (!resolved.term) return res.json({ success:false, message:'No term available' });
  const term_id = resolved.term.id;
  const classes = db.prepare(`
    SELECT id, name FROM classes
    WHERE status='active'
    ORDER BY
      CASE
        WHEN upper(name)='PP1' THEN 1
        WHEN upper(name)='PP2' THEN 2
        WHEN upper(name) LIKE 'GRADE %' THEN 2 + CAST(substr(name, 7) AS INTEGER)
        ELSE 99
      END,
      name
  `).all();
  const results = classes.map(cls => {
    const subjects = db.prepare(`SELECT s.id, s.name FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id WHERE cs.class_id=? ORDER BY s.name`).all(cls.id);
    const learners = db.prepare("SELECT id, name, admission_no FROM users WHERE role='learner' AND status='active' AND class_name=? ORDER BY name").all(cls.name);
    let marksSql = "SELECT * FROM marks WHERE class_id=? AND term_id=?";
    const marksParams = [cls.id, term_id];
    if (stage !== 'combined') {
      marksSql += " AND assessment_type=?";
      marksParams.push(stage);
    }
    const allMarks = db.prepare(marksSql).all(...marksParams);
    const learnerSubjectScores = aggregateMarksByAssessment(allMarks);
    const ranked = learners.map(l => {
      const subjectScores = Object.values(learnerSubjectScores[l.id] || {}).map(subjectAverage).filter(avg => avg !== null);
      const avg = averageNumbers(subjectScores);
      const total = avg === null ? null : Math.round(subjectScores.reduce((sum, score) => sum + score, 0) * 100) / 100;
      return { ...l, total, average:avg, cbc:cbcLevel(avg), subject_count:subjectScores.length };
    }).filter(l => l.subject_count > 0).sort((a,b) => b.average - a.average);
    ranked.forEach((r,i) => r.position = i+1);
    const needingSupport = [...ranked].filter(l => l.average < 41).sort((a,b) => a.average - b.average).slice(0,10);
    const improving = stage === 'combined' ? learners.map(l => {
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
    }).filter(Boolean).filter(l => l.improvement > 0).sort((a,b) => b.improvement - a.improvement).slice(0,10) : [];
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
      subject_averages:subjectAverages,
      has_marks:ranked.length > 0
    };
  });

  const attendanceSummary = db.prepare(`
    SELECT u.id, u.name, u.class_name, u.admission_no,
      (SELECT COUNT(*) FROM attendance_entries ae JOIN attendance_records ar ON ar.id=ae.record_id WHERE ae.learner_id=u.id AND ar.term_id=? AND ae.status='absent') AS absent_days
    FROM users u WHERE u.role='learner' AND u.status='active'
    ORDER BY absent_days DESC LIMIT 15
  `).all(term_id);

  res.json({ success:true, data:{
    classes:results,
    most_absent:attendanceSummary.filter(a=>a.absent_days>0),
    cbc_levels:CBC_LEVELS,
    display_term:{
      id:resolved.term.id,
      name:termDisplayName(resolved.term),
      start_date:resolved.term.start_date,
      end_date:resolved.term.end_date,
      is_fallback:resolved.isFallback
    },
    requested_term:resolved.requestedTerm ? {
      id:resolved.requestedTerm.id,
      name:termDisplayName(resolved.requestedTerm)
    } : null,
    stage
  }});
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

function readTemplateState(name) {
  if (!name) return null;
  ensureTemplateDir();
  const fp = templatePath(name);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
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

router.get('/report-card', (req, res) => {
  const db = getDB();
  const learnerId = Number(req.query.learner_id || req.query.learnerId || 0);
  const classId = Number(req.query.class_id || req.query.classId || 0);
  const termId = Number(req.query.term_id || req.query.termId || 0);
  if ((!Number.isInteger(learnerId) || learnerId <= 0) && (!Number.isInteger(classId) || classId <= 0)) {
    return res.status(400).json({ success:false, message:'learner_id or class_id is required' });
  }
  if (!Number.isInteger(termId) || termId <= 0) return res.status(400).json({ success:false, message:'term_id is required' });

  let learner = null;
  let cls = null;
  if (learnerId) {
    learner = db.prepare(`
      SELECT id, user_id, name, admission_no, class_name, sex, date_of_birth, portrait_path
      FROM users
      WHERE id=? AND role='learner' AND status='active'
    `).get(learnerId);
    if (!learner) return res.status(404).json({ success:false, message:'Learner not found' });
    if (!learner.class_name) return res.status(400).json({ success:false, message:'Learner is not assigned to a class' });
    cls = db.prepare('SELECT id, name, template_name FROM classes WHERE lower(name)=lower(?) LIMIT 1').get(learner.class_name);
  } else {
    cls = db.prepare('SELECT id, name, template_name FROM classes WHERE id=? LIMIT 1').get(classId);
  }

  if (!cls) return res.status(404).json({ success:false, message:'Learner class not found' });
  const term = db.prepare(`
    SELECT t.id, t.term_name AS name, t.term_name, t.start_date, t.end_date, s.name AS session_name
    FROM terms t
    LEFT JOIN academic_sessions s ON s.id=t.session_id
    WHERE t.id=?
  `).get(termId);
  if (!term) return res.status(404).json({ success:false, message:'Term not found' });

  const requestedAssessment = req.query.assessment_type || req.query.assessmentType || req.query.stage;
  let assessment;
  if (requestedAssessment) {
    assessment = String(requestedAssessment).toLowerCase();
    if (!ASSESSMENT_TYPES.includes(assessment)) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  } else {
    const detected = detectAssessmentPeriod(term, todayInSchoolTime());
    assessment = ASSESSMENT_TYPES.includes(detected.period) ? detected.period : 'midterm';
  }

  const subjects = db.prepare(`
    SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
    FROM class_subjects cs
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=?
    ORDER BY s.name
  `).all(cls.id).map((sub) => {
    const components = getAssessmentComponents(db, cls.id, sub.subject_id, assessment)
      .map((c) => ({ key:c.component_key, name:c.component_name, max:Number(c.max_score) }));
    const scores = learner ? db.prepare(`
      SELECT component_key, score
      FROM marks
      WHERE learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=?
    `).all(learner.id, cls.id, sub.subject_id, term.id, assessment)
      .reduce((map, row) => Object.assign(map, { [row.component_key]: row.score }), {}) : {};
    const populated = components.map((c) => ({ ...c, score:scores[c.key] != null ? Number(scores[c.key]) : null }));
    const maxTotal = populated.reduce((sum, c) => sum + (Number(c.max) || 0), 0);
    const scoreTotal = populated.reduce((sum, c) => sum + (c.score != null ? Number(c.score) : 0), 0);
    const anyScore = populated.some((c) => c.score != null);
    return {
      subject_id:sub.subject_id,
      subject_name:sub.subject_name,
      subject_code:publicSubjectCode(sub.subject_code),
      components:populated,
      total:anyScore ? Math.round(scoreTotal * 10) / 10 : null,
      max_total:maxTotal || null,
      percent:anyScore && maxTotal ? Math.round((scoreTotal / maxTotal) * 1000) / 10 : null
    };
  });

  const classLearners = db.prepare(`
    SELECT id, user_id, name, admission_no, class_name, sex, date_of_birth, portrait_path
    FROM users
    WHERE role='learner' AND status='active' AND lower(class_name)=lower(?)
    ORDER BY name
  `).all(cls.name);
  const allMarks = db.prepare(`
    SELECT m.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id,
           s.name AS subject_name, s.code AS subject_code
    FROM marks m
    JOIN users u ON u.id=m.learner_id
    JOIN subjects s ON s.id=m.subject_id
    WHERE m.class_id=? AND m.term_id=? AND m.assessment_type=?
    ORDER BY u.name, s.name, m.component_key
  `).all(cls.id, term.id, assessment).map((row) => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));
  const componentRows = db.prepare(`
    SELECT DISTINCT component_key AS key, component_key, component_name AS name, component_name, max_score
    FROM assessment_components
    WHERE class_id=? AND assessment_type=?
    ORDER BY sort_order, component_name
  `).all(cls.id, assessment);

  const opened = Number(db.prepare('SELECT COUNT(DISTINCT id) AS opened FROM attendance_records WHERE class_id=? AND term_id=?').get(cls.id, term.id)?.opened || 0);
  const attendanceRows = db.prepare(`
    SELECT u.id,
      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
    FROM users u
    LEFT JOIN attendance_records ar ON ar.class_id=? AND ar.term_id=?
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=u.id
    WHERE u.role='learner' AND u.status='active' AND lower(u.class_name)=lower(?)
    GROUP BY u.id
  `).all(cls.id, term.id, cls.name);
  const attendanceSummary = { opened:opened || null, learners:{} };
  attendanceRows.forEach((row) => {
    attendanceSummary.learners[String(row.id)] = opened ? {
      opened,
      present:Number(row.present || 0),
      absent:Number(row.absent || 0),
      late:Number(row.late || 0)
    } : { opened:null, present:null, absent:null, late:null };
  });
  const attendance = learner
    ? (attendanceSummary.learners[String(learner.id)] || { opened:null, present:null, absent:null, late:null })
    : { opened:attendanceSummary.opened, present:null, absent:null, late:null };

  const allSkillRows = db.prepare(`
    SELECT learner_id, category_key, item_key, rating
    FROM learner_skills
    WHERE term_id=? AND assessment_type=?
  `).all(term.id, assessment);
  const skillRatings = {};
  allSkillRows.forEach((row) => {
    const lid = String(row.learner_id || '');
    if (!lid) return;
    if (!skillRatings[lid]) skillRatings[lid] = {};
    if (!skillRatings[lid][row.category_key]) skillRatings[lid][row.category_key] = {};
    skillRatings[lid][row.category_key][row.item_key] = row.rating == null ? null : String(row.rating);
  });

  const templateName = cleanText(req.query.template) || cls.template_name || 'Default Template';
  const state = readTemplateState(templateName);
  const school = getSchoolSettings(db);
  const comments = db.prepare(`
    SELECT id, role, assessment_type, comment_text, updated_at
    FROM learner_comments
    WHERE learner_id=? AND term_id=? AND assessment_type=?
    ORDER BY role
  `).all(learner ? learner.id : 0, term.id, assessment);
  const commentMap = {};
  comments.forEach((row) => { commentMap[row.role] = { id:row.id, text:row.comment_text || '', assessment_type:row.assessment_type, updated_at:row.updated_at }; });
  const commentBank = db.prepare('SELECT * FROM report_comments ORDER BY role, class_id IS NULL DESC, sort_order, min_score DESC').all();
  const signatures = {};
  COMMENT_ROLES.forEach((role) => { signatures[role] = school[`signature_${role}`] || ''; });
  const terms = db.prepare(`
    SELECT t.id, t.term_name AS label, t.term_name, t.start_date, t.end_date, s.name AS session_name
    FROM terms t
    LEFT JOIN academic_sessions s ON s.id=t.session_id
    ORDER BY date(t.start_date), t.id
  `).all();
  const classSubjects = db.prepare(`
    SELECT cs.class_id, cs.subject_id, s.name AS subject_name
    FROM class_subjects cs
    JOIN subjects s ON s.id=cs.subject_id
    ORDER BY cs.class_id, s.name
  `).all();
  const allClasses = db.prepare("SELECT id, name, template_name FROM classes WHERE status='active' ORDER BY name").all();

  res.json({ success:true, data:{
    school,
    class:{ id:cls.id, name:cls.name, template_name:cls.template_name || null },
    learner,
    learners:learner ? [learner] : classLearners,
    term:{ id:term.id, name:term.name, term_name:term.term_name, start_date:term.start_date, end_date:term.end_date, session_name:term.session_name || '' },
    assessment_type:assessment,
    template:{ name:templateName, state:state || null },
    class_learners:classLearners,
    all_marks:allMarks,
    component_defs:componentRows,
    attendance_summary:attendanceSummary,
    attendance,
    skill_ratings:skillRatings,
    subjects,
    comments:commentMap,
    globals:{ classes:allClasses, learners:classLearners, terms, classSubjects, commentBank, signatures }
  }});
});

// ══════════ SKILLS / ATTRIBUTES ENTRY ══════════
function skillRows(db) {
  return db.prepare('SELECT id, name, description, level, sort_order FROM skills ORDER BY sort_order, name').all();
}

router.get('/skills', (req, res) => {
  const db = getDB();
  const class_id = req.query.class_id || req.query.classId;
  const term_id = req.query.term_id || req.query.termId;
  const { assessment_type } = req.query;
  if (!class_id && !term_id && !assessment_type) return res.json({ success:true, data:skillRows(db) });
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

router.get('/skills/ratings', (req, res) => {
  const db = getDB();
  const learnerId = optionalId(req.query.learnerId || req.query.learner_id);
  const termId = currentTermId(db, req.query.termId || req.query.term_id);
  if (!learnerId || !termId) return res.json({ success:false, message:'learnerId and termId are required' });
  const ratings = db.prepare('SELECT skill_id, rating FROM skill_ratings WHERE learner_id=? AND term_id=?').all(learnerId, termId);
  const map = new Map(ratings.map(row => [Number(row.skill_id), row.rating]));
  res.json({ success:true, data:skillRows(db).map(skill => ({
    skillId:skill.id,
    skillName:skill.name,
    description:skill.description,
    rating:map.get(skill.id) ?? null
  })) });
});

router.post('/skills/ratings', (req, res) => {
  const db = getDB();
  const learnerId = optionalId(req.body.learnerId || req.body.learner_id);
  const skillId = optionalId(req.body.skillId || req.body.skill_id);
  const termId = currentTermId(db, req.body.termId || req.body.term_id);
  const rating = Number(req.body.rating);
  if (!learnerId || !skillId || !termId || !Number.isInteger(rating) || rating < 1 || rating > 4) {
    return res.json({ success:false, message:'learnerId, skillId, termId and rating 1-4 are required' });
  }
  db.prepare(`
    INSERT INTO skill_ratings (learner_id, skill_id, term_id, rating, rated_by, rated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(learner_id, skill_id, term_id) DO UPDATE SET
      rating=excluded.rating, rated_by=excluded.rated_by, rated_at=datetime('now')
  `).run(learnerId, skillId, termId, rating, req.session.user.id);
  res.json({ success:true, message:'Skill rating saved' });
});

router.get('/skills/progress', (req, res) => {
  const db = getDB();
  const classId = optionalId(req.query.classId || req.query.class_id);
  const termId = currentTermId(db, req.query.termId || req.query.term_id);
  if (!classId || !termId) return res.json({ success:false, message:'classId and termId are required' });
  const cls = db.prepare('SELECT id, name FROM classes WHERE id=?').get(classId);
  if (!cls) return res.json({ success:false, message:'Class not found' });
  const total = db.prepare('SELECT COUNT(*) c FROM skills').get().c;
  const rows = db.prepare(`
    SELECT u.id AS learnerId, u.name,
      (SELECT COUNT(*) FROM skill_ratings sr WHERE sr.learner_id=u.id AND sr.term_id=? AND sr.rating IS NOT NULL) AS rated
    FROM users u
    WHERE u.role='learner' AND u.status='active' AND lower(u.class_name)=lower(?)
    ORDER BY u.name
  `).all(termId, cls.name).map(row => ({ ...row, total }));
  res.json({ success:true, data:rows });
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
