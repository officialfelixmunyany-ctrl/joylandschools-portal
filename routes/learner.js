const express = require('express');
const bcrypt  = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { getDB, calculateSchoolDays } = require('../database');
const { todayInSchoolTime } = require('../lib/dates');
const router  = express.Router();

function requireLearner(req, res, next) {
  if (req.session.user?.role === 'learner') return next();
  const learnerUser = req.session.roleUsers?.learner;
  if (!learnerUser) return res.status(401).json({ success:false, message:'Learner session expired. Please log in as learner again.' });
  req.session.user = learnerUser;
  next();
}
router.use(requireLearner);

// ─── helpers (mirroring routes/teacher.js patterns) ───────────────────────────
const TEMPLATE_DIR = path.join(__dirname, '..', 'data', 'templates');
function learnerTemplatePath(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
  return path.join(TEMPLATE_DIR, slug + '.json');
}
function readTemplateState(name) {
  if (!name) return null;
  try {
    const fp = learnerTemplatePath(name);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return null; }
}
function slugifyKey(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}
function publicSubjectCode(value) {
  const code = String(value || '').trim();
  return code && !/^SYSAUTO/i.test(code) ? code : null;
}
function todayStr() {
  return todayInSchoolTime();
}
function detectAssessmentPeriod(term, todayStr) {
  if (!term) return null;
  const start = new Date(term.start_date);
  const end = new Date(term.end_date);
  const today = todayStr ? new Date(todayStr) : new Date();
  const totalMs = end - start;
  const elapsedMs = today - start;
  if (elapsedMs < 0) return 'opener';
  if (elapsedMs > totalMs) return 'endterm';
  const progress = elapsedMs / totalMs;
  if (progress < 1/3) return 'opener';
  if (progress < 2/3) return 'midterm';
  return 'endterm';
}
function termForDate(db, date) {
  return db.prepare(`
    SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number
    FROM terms
    WHERE date(start_date) <= date(?) AND date(end_date) >= date(?)
    ORDER BY start_date DESC LIMIT 1
  `).get(date, date);
}
function defaultLearnerTerm(db, today) {
  return termForDate(db, today) || db.prepare(`
    SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number
    FROM terms
    WHERE date(end_date) < date(?) ORDER BY date(end_date) DESC LIMIT 1
  `).get(today);
}
function resolveTerm(db, termIdQuery) {
  if (termIdQuery) {
    const t = db.prepare(`SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number FROM terms WHERE id=?`).get(termIdQuery);
    if (t) return t;
  }
  return defaultLearnerTerm(db, todayStr());
}
const VALID_ASSESSMENTS = new Set(['opener','midterm','endterm']);
function validAssessment(value, fallback='opener') {
  return VALID_ASSESSMENTS.has(String(value||'').toLowerCase()) ? String(value).toLowerCase() : fallback;
}
function attendanceStatusToApi(value) {
  const s = String(value||'').toLowerCase();
  if (s === 'present' || s === 'p') return 'P';
  if (s === 'late' || s === 'l') return 'L';
  return 'A';
}

router.get('/me', (req, res) => {
  const user = getDB().prepare("SELECT id,user_id,name,email,phone,admission_no,class_name,sex,date_of_birth,address,portrait_path,status FROM users WHERE id=?").get(req.session.user.id);
  res.json({ success:true, data:user });
});

router.get('/photos', (req, res) => {
  const photos = getDB().prepare("SELECT id,title,file_path,created_at FROM learner_photos WHERE learner_id=? ORDER BY created_at DESC, id DESC").all(req.session.user.id);
  res.json({ success:true, data:photos });
});

router.get('/dashboard', (req, res) => {
  const db = getDB();
  const active = db.prepare("SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1").get();
  const terms  = active ? db.prepare("SELECT * FROM terms WHERE session_id=? ORDER BY term_number").all(active.id).map(t => {
    const holidays = db.prepare("SELECT * FROM holidays WHERE term_id=?").all(t.id);
    const weekdays = JSON.parse(t.weekdays || '[]');
    return { ...t, weekdays, holidays, school_days: calculateSchoolDays(t.start_date, t.end_date, weekdays, holidays) };
  }) : [];
  res.json({ success:true, data:{ active_session:active, terms }});
});

// ═══════════════ LEARNER READ-ONLY DATA ═══════════════
// All endpoints scope to req.session.user.id — a learner CANNOT view another learner's data.

router.get('/summary', (req, res) => {
  const db = getDB();
  const learnerId = req.session.user.id;
  const me = db.prepare(`
    SELECT id, user_id, name, email, phone, admission_no, class_name, sex, date_of_birth, portrait_path, status
    FROM users WHERE id=?
  `).get(learnerId);
  if (!me) return res.status(404).json({ success:false, message:'Learner not found' });

  const classRow = me.class_name ? db.prepare(`
    SELECT c.id, c.name, c.grade_level, c.template_name, u.name AS class_teacher_name
    FROM classes c LEFT JOIN users u ON u.id=c.class_teacher_id
    WHERE c.name=?
  `).get(me.class_name) : null;

  const subjectsCount = classRow ? db.prepare(`SELECT COUNT(*) c FROM class_subjects WHERE class_id=?`).get(classRow.id).c : 0;
  const activeSession = db.prepare(`SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1`).get();
  const today = todayStr();
  const term = termForDate(db, today) || defaultLearnerTerm(db, today);
  const currentAssessment = detectAssessmentPeriod(term, today);

  // Attendance summary for current term
  let attSummary = null;
  if (classRow && term) {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT ar.id) AS opened,
        SUM(CASE WHEN ae.status IN ('present','P') THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN ae.status IN ('absent','A')  THEN 1 ELSE 0 END) AS absent,
        SUM(CASE WHEN ae.status IN ('late','L')    THEN 1 ELSE 0 END) AS late
      FROM attendance_records ar
      LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
      WHERE ar.class_id=? AND ar.term_id=?
    `).get(learnerId, classRow.id, term.id);
    const opened = Number(row?.opened || 0);
    const present = Number(row?.present || 0);
    const absent = Number(row?.absent || 0);
    const late = Number(row?.late || 0);
    attSummary = { opened, present, absent, late, pct: opened ? Math.round((present / opened) * 100) : 0 };
  }

  // Next term (term_number + 1, same session)
  let nextTermBegins = null;
  if (term && activeSession) {
    const next = db.prepare(`SELECT start_date FROM terms WHERE session_id=? AND term_number=?`).get(term.session_id, term.term_number + 1);
    if (next) nextTermBegins = next.start_date;
  }

  res.json({
    success: true,
    data: {
      profile: {
        id: me.id, user_id: me.user_id, name: me.name, email: me.email, phone: me.phone,
        admission_no: me.admission_no, class_name: me.class_name, sex: me.sex,
        date_of_birth: me.date_of_birth, portrait_path: me.portrait_path
      },
      class: classRow ? { id: classRow.id, name: classRow.name, grade_level: classRow.grade_level, class_teacher_name: classRow.class_teacher_name, template_name: classRow.template_name } : null,
      current_session: activeSession ? { id: activeSession.id, name: activeSession.name } : null,
      current_term: term ? { id: term.id, name: term.name, term_number: term.term_number, start_date: term.start_date, end_date: term.end_date } : null,
      current_assessment: currentAssessment,
      attendance_summary: attSummary,
      subjects_count: subjectsCount,
      next_term_begins: nextTermBegins
    }
  });
});

router.get('/marks', (req, res) => {
  const db = getDB();
  const learnerId = req.session.user.id;
  const me = db.prepare(`SELECT class_name FROM users WHERE id=?`).get(learnerId);
  const classRow = me?.class_name ? db.prepare(`SELECT id, name FROM classes WHERE name=?`).get(me.class_name) : null;
  if (!classRow) return res.json({ success:true, data:{ term:null, assessment_type:null, subjects:[], overall_percent:null } });

  const term = resolveTerm(db, req.query.term_id);
  if (!term) return res.json({ success:true, data:{ term:null, assessment_type:null, subjects:[], overall_percent:null } });
  const assessment = validAssessment(req.query.assessment_type, detectAssessmentPeriod(term, todayStr()));

  const subjects = db.prepare(`
    SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
    FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=? ORDER BY s.name
  `).all(classRow.id).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));

  const subjectsOut = subjects.map(sub => {
    const components = db.prepare(`
      SELECT component_key AS key, component_name AS name, max_score AS max
      FROM assessment_components
      WHERE class_id=? AND subject_id=? AND assessment_type=?
      ORDER BY sort_order, component_name
    `).all(classRow.id, sub.subject_id, assessment);

    const scoreMap = {};
    db.prepare(`
      SELECT component_key, score
      FROM marks
      WHERE learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=?
    `).all(learnerId, classRow.id, sub.subject_id, term.id, assessment).forEach(r => { scoreMap[r.component_key] = r.score; });

    const populated = components.map(c => ({ key: c.key, name: c.name, max: Number(c.max), score: scoreMap[c.key] != null ? Number(scoreMap[c.key]) : null }));
    const totalMax = populated.reduce((a,c) => a + (Number(c.max) || 0), 0);
    const totalScore = populated.reduce((a,c) => a + (c.score != null ? Number(c.score) : 0), 0);
    const anyScore = populated.some(c => c.score != null);
    const percent = anyScore && totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : null;
    return { ...sub, components: populated, total: anyScore ? Math.round(totalScore * 10)/10 : null, max_total: totalMax || null, percent };
  });

  // Overall percent: average of subject percents that have any score
  const subjectPercents = subjectsOut.map(s => s.percent).filter(p => p != null);
  const overallPercent = subjectPercents.length ? Math.round((subjectPercents.reduce((a,b)=>a+b,0) / subjectPercents.length) * 10) / 10 : null;

  res.json({
    success: true,
    data: { term: { id: term.id, name: term.name }, assessment_type: assessment, subjects: subjectsOut, overall_percent: overallPercent }
  });
});

router.get('/attendance', (req, res) => {
  const db = getDB();
  const learnerId = req.session.user.id;
  const me = db.prepare(`SELECT class_name FROM users WHERE id=?`).get(learnerId);
  const classRow = me?.class_name ? db.prepare(`SELECT id, name FROM classes WHERE name=?`).get(me.class_name) : null;
  if (!classRow) return res.json({ success:true, data:{ term:null, summary:null, days:[] } });

  const term = resolveTerm(db, req.query.term_id);
  if (!term) return res.json({ success:true, data:{ term:null, summary:null, days:[] } });

  const days = db.prepare(`
    SELECT ar.date, ae.status, ae.note
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
    WHERE ar.class_id=? AND ar.term_id=?
    ORDER BY date(ar.date) DESC
  `).all(learnerId, classRow.id, term.id).map(d => ({
    date: d.date,
    status: d.status ? attendanceStatusToApi(d.status) : null,
    note: d.note || ''
  }));

  const counts = days.reduce((acc, d) => {
    if (d.status === 'P') acc.present++;
    else if (d.status === 'A') acc.absent++;
    else if (d.status === 'L') acc.late++;
    return acc;
  }, { present:0, absent:0, late:0 });
  const opened = days.filter(d => d.status).length;
  const summary = { opened, ...counts, pct: opened ? Math.round((counts.present / opened) * 100) : 0 };

  res.json({ success: true, data: { term: { id: term.id, name: term.name, start_date: term.start_date, end_date: term.end_date }, summary, days } });
});

router.get('/skills', (req, res) => {
  const db = getDB();
  const learnerId = req.session.user.id;
  const me = db.prepare(`SELECT class_name FROM users WHERE id=?`).get(learnerId);
  const classRow = me?.class_name ? db.prepare(`SELECT id, name, template_name FROM classes WHERE name=?`).get(me.class_name) : null;
  if (!classRow) return res.json({ success:true, data:{ term:null, categories:[], ratings:[], rating_labels:[] } });

  const term = resolveTerm(db, req.query.term_id);
  if (!term) return res.json({ success:true, data:{ term:null, categories:[], ratings:[], rating_labels:[] } });
  const assessment = validAssessment(req.query.assessment_type, detectAssessmentPeriod(term, todayStr()));

  // Read skill structure from the class's template; fall back to CBC defaults
  const state = readTemplateState(classRow.template_name);
  const sk = (state && state.customizations && state.customizations.skills) || {};
  const DEFAULTS = {
    affective: ['Punctuality','Attentiveness','Neatness','Honesty','Politeness'],
    psychomotor: ['Handwriting','Drawing','Sports','Crafts','Verbal Fluency'],
    ratings: [5,4,3,2,1],
    rating_labels: ['Excellent','Very Good','Good','Fair','Poor']
  };
  const affective    = (Array.isArray(sk.affective)    && sk.affective.length)    ? sk.affective    : DEFAULTS.affective;
  const psychomotor  = (Array.isArray(sk.psychomotor)  && sk.psychomotor.length)  ? sk.psychomotor  : DEFAULTS.psychomotor;
  const ratings      = (Array.isArray(sk.ratings)      && sk.ratings.length)      ? sk.ratings      : DEFAULTS.ratings;
  const ratingLabels = (Array.isArray(sk.rating_labels) && sk.rating_labels.length) ? sk.rating_labels : DEFAULTS.rating_labels;

  const myRatings = db.prepare(`
    SELECT category_key, item_key, rating FROM learner_skills
    WHERE learner_id=? AND term_id=? AND assessment_type=?
  `).all(learnerId, term.id, assessment);
  const ratingMap = {};
  myRatings.forEach(r => {
    if (!ratingMap[r.category_key]) ratingMap[r.category_key] = {};
    ratingMap[r.category_key][r.item_key] = r.rating;
  });

  const categories = [
    { key:'affective',   label:'Affective Traits',   items: affective.map(label => ({ key:slugifyKey(label), label, rating: ratingMap['affective']?.[slugifyKey(label)] ?? null })) },
    { key:'psychomotor', label:'Psychomotor Skills', items: psychomotor.map(label => ({ key:slugifyKey(label), label, rating: ratingMap['psychomotor']?.[slugifyKey(label)] ?? null })) }
  ];

  res.json({ success:true, data:{ term:{ id: term.id, name: term.name }, assessment_type: assessment, categories, ratings, rating_labels: ratingLabels } });
});

router.get('/comments', (req, res) => {
  const db = getDB();
  const learnerId = req.session.user.id;
  const term = resolveTerm(db, req.query.term_id);
  if (!term) return res.json({ success:true, data:{ term:null, comments:[] } });
  const assessment = validAssessment(req.query.assessment_type, detectAssessmentPeriod(term, todayStr()));

  const rows = db.prepare(`
    SELECT role, comment_text
    FROM learner_comments
    WHERE learner_id=? AND term_id=? AND assessment_type=?
    ORDER BY role
  `).all(learnerId, term.id, assessment);
  const roleLabel = { class_teacher:'Class Teacher', headteacher:'Headteacher', director:'Director' };
  const comments = rows.map(r => ({ role: r.role, role_label: roleLabel[r.role] || r.role, text: r.comment_text || '' }));
  res.json({ success:true, data:{ term:{ id: term.id, name: term.name }, assessment_type: assessment, comments } });
});

router.put('/change-password', (req, res) => {
  const { current_password, new_password } = req.body;
  const db = getDB();
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(req.session.user.id);
  if (!bcrypt.compareSync(current_password, user.password)) return res.json({ success:false, message:'Current password incorrect' });
  db.prepare("UPDATE users SET password=?,temp_code=NULL,updated_at=datetime('now') WHERE id=?").run(bcrypt.hashSync(new_password,10), user.id);
  res.json({ success:true, message:'Password changed' });
});

module.exports = router;
