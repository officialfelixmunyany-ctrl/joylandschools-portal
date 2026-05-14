const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDB } = require('../database');
const { todayInSchoolTime } = require('../lib/dates');
const router = express.Router();

function requireParent(req, res, next) {
  if (req.session.user?.role === 'parent') return next();
  const parentUser = req.session.roleUsers?.parent;
  if (!parentUser) return res.status(401).json({ success:false, message:'Parent session expired. Please log in as parent again.' });
  req.session.user = parentUser;
  next();
}
router.use(requireParent);

const TEMPLATE_DIR = path.join(__dirname, '..', 'data', 'templates');
function templatePath(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
  return path.join(TEMPLATE_DIR, slug + '.json');
}
function readTemplateState(name) {
  if (!name) return null;
  try {
    const fp = templatePath(name);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch {
    return null;
  }
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
function detectAssessmentPeriod(term, today) {
  if (!term) return null;
  const start = new Date(term.start_date);
  const end = new Date(term.end_date);
  const now = today ? new Date(today) : new Date();
  const totalMs = end - start;
  const elapsedMs = now - start;
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
function defaultTerm(db, today) {
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
  return defaultTerm(db, todayStr());
}
const VALID_ASSESSMENTS = new Set(['opener','midterm','endterm']);
function validAssessment(value, fallback='opener') {
  return VALID_ASSESSMENTS.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : fallback;
}
function attendanceStatusToApi(value) {
  const s = String(value || '').toLowerCase();
  if (s === 'present' || s === 'p') return 'P';
  if (s === 'late' || s === 'l') return 'L';
  if (s === 'absent' || s === 'a') return 'A';
  return null;
}
function roleLabel(role) {
  return { class_teacher:'Class Teacher', headteacher:'Headteacher', director:'Director' }[role] || role;
}

function requireLinkedLearner(req, res, db, learnerIdInput) {
  const learnerId = Number(learnerIdInput);
  if (!Number.isInteger(learnerId) || learnerId <= 0) {
    res.status(400).json({ success:false, message:'learner_id required' });
    return null;
  }
  const row = db.prepare(`
    SELECT u.id, u.user_id, u.name, u.email, u.phone, u.admission_no, u.class_name, u.sex,
           u.date_of_birth, u.address, u.portrait_path, u.status, pll.relationship
    FROM parent_learner_links pll
    JOIN users u ON u.id=pll.learner_id
    WHERE pll.parent_id=? AND pll.learner_id=? AND u.role='learner'
  `).get(req.session.user.id, learnerId);
  if (!row) {
    res.status(403).json({ success:false, message:'Not your child' });
    return null;
  }
  return row;
}

function classForLearner(db, learner) {
  return learner?.class_name ? db.prepare(`
    SELECT c.id, c.name, c.grade_level, c.template_name, u.name AS class_teacher_name
    FROM classes c
    LEFT JOIN users u ON u.id=c.class_teacher_id
    WHERE c.name=?
  `).get(learner.class_name) : null;
}

function attendanceSummary(db, learnerId, classId, termId) {
  if (!classId || !termId) return null;
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT ar.id) AS opened,
      SUM(CASE WHEN ae.status IN ('present','P') THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status IN ('absent','A') THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ae.status IN ('late','L') THEN 1 ELSE 0 END) AS late
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
    WHERE ar.class_id=? AND ar.term_id=?
  `).get(learnerId, classId, termId);
  const opened = Number(row?.opened || 0);
  const present = Number(row?.present || 0);
  const absent = Number(row?.absent || 0);
  const late = Number(row?.late || 0);
  return { opened, present, absent, late, pct: opened ? Math.round((present / opened) * 100) : 0 };
}

function learnerSummary(db, learner) {
  const classRow = classForLearner(db, learner);
  const activeSession = db.prepare(`SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1`).get();
  const term = defaultTerm(db, todayStr());
  const subjectsCount = classRow ? db.prepare(`SELECT COUNT(*) c FROM class_subjects WHERE class_id=?`).get(classRow.id).c : 0;
  return {
    profile: {
      id: learner.id,
      user_id: learner.user_id,
      name: learner.name,
      email: learner.email,
      phone: learner.phone,
      admission_no: learner.admission_no,
      class_name: learner.class_name,
      sex: learner.sex,
      date_of_birth: learner.date_of_birth,
      address: learner.address,
      portrait_path: learner.portrait_path,
      relationship: learner.relationship
    },
    class: classRow ? {
      id: classRow.id,
      name: classRow.name,
      grade_level: classRow.grade_level,
      class_teacher_name: classRow.class_teacher_name,
      template_name: classRow.template_name
    } : null,
    current_session: activeSession ? { id: activeSession.id, name: activeSession.name } : null,
    current_term: term ? { id: term.id, name: term.name, term_number: term.term_number, start_date: term.start_date, end_date: term.end_date } : null,
    current_assessment: detectAssessmentPeriod(term, todayStr()),
    attendance_summary: classRow && term ? attendanceSummary(db, learner.id, classRow.id, term.id) : null,
    subjects_count: subjectsCount
  };
}

function learnerMarks(db, learner, query) {
  const classRow = classForLearner(db, learner);
  if (!classRow) return { term:null, assessment_type:null, subjects:[], overall_percent:null };
  const term = resolveTerm(db, query.term_id);
  if (!term) return { term:null, assessment_type:null, subjects:[], overall_percent:null };
  const assessment = validAssessment(query.assessment_type, detectAssessmentPeriod(term, todayStr()));
  const subjects = db.prepare(`
    SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
    FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=? ORDER BY s.name
  `).all(classRow.id).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));

  const subjectsOut = subjects.map((sub) => {
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
    `).all(learner.id, classRow.id, sub.subject_id, term.id, assessment).forEach((r) => { scoreMap[r.component_key] = r.score; });
    const populated = components.map((c) => ({ key:c.key, name:c.name, max:Number(c.max), score:scoreMap[c.key] != null ? Number(scoreMap[c.key]) : null }));
    const totalMax = populated.reduce((a, c) => a + (Number(c.max) || 0), 0);
    const totalScore = populated.reduce((a, c) => a + (c.score != null ? Number(c.score) : 0), 0);
    const anyScore = populated.some((c) => c.score != null);
    const percent = anyScore && totalMax > 0 ? Math.round((totalScore / totalMax) * 1000) / 10 : null;
    return { ...sub, components:populated, total:anyScore ? Math.round(totalScore * 10)/10 : null, max_total:totalMax || null, percent };
  });
  const subjectPercents = subjectsOut.map((s) => s.percent).filter((p) => p != null);
  const overallPercent = subjectPercents.length ? Math.round((subjectPercents.reduce((a, b) => a + b, 0) / subjectPercents.length) * 10) / 10 : null;
  return { term:{ id:term.id, name:term.name }, assessment_type:assessment, subjects:subjectsOut, overall_percent:overallPercent };
}

function learnerAttendance(db, learner, query) {
  const classRow = classForLearner(db, learner);
  if (!classRow) return { term:null, summary:null, days:[] };
  const term = resolveTerm(db, query.term_id);
  if (!term) return { term:null, summary:null, days:[] };
  const days = db.prepare(`
    SELECT ar.date, ae.status, ae.note
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
    WHERE ar.class_id=? AND ar.term_id=?
    ORDER BY date(ar.date) DESC
  `).all(learner.id, classRow.id, term.id).map((d) => ({
    date:d.date,
    status:attendanceStatusToApi(d.status),
    note:d.note || ''
  }));
  const counts = days.reduce((acc, d) => {
    if (d.status === 'P') acc.present++;
    else if (d.status === 'A') acc.absent++;
    else if (d.status === 'L') acc.late++;
    return acc;
  }, { present:0, absent:0, late:0 });
  const opened = days.filter((d) => d.status).length;
  return {
    term:{ id:term.id, name:term.name, start_date:term.start_date, end_date:term.end_date },
    summary:{ opened, ...counts, pct:opened ? Math.round((counts.present / opened) * 100) : 0 },
    days
  };
}

function learnerSkills(db, learner, query) {
  const classRow = classForLearner(db, learner);
  if (!classRow) return { term:null, categories:[], ratings:[], rating_labels:[] };
  const term = resolveTerm(db, query.term_id);
  if (!term) return { term:null, categories:[], ratings:[], rating_labels:[] };
  const assessment = validAssessment(query.assessment_type, detectAssessmentPeriod(term, todayStr()));
  const state = readTemplateState(classRow.template_name);
  const sk = (state && state.customizations && state.customizations.skills) || {};
  const DEFAULTS = {
    affective: ['Punctuality','Attentiveness','Neatness','Honesty','Politeness'],
    psychomotor: ['Handwriting','Drawing','Sports','Crafts','Verbal Fluency'],
    ratings: [5,4,3,2,1],
    rating_labels: ['Excellent','Very Good','Good','Fair','Poor']
  };
  const affective = (Array.isArray(sk.affective) && sk.affective.length) ? sk.affective : DEFAULTS.affective;
  const psychomotor = (Array.isArray(sk.psychomotor) && sk.psychomotor.length) ? sk.psychomotor : DEFAULTS.psychomotor;
  const ratings = (Array.isArray(sk.ratings) && sk.ratings.length) ? sk.ratings : DEFAULTS.ratings;
  const ratingLabels = (Array.isArray(sk.rating_labels) && sk.rating_labels.length) ? sk.rating_labels : DEFAULTS.rating_labels;
  const rows = db.prepare(`
    SELECT category_key, item_key, rating FROM learner_skills
    WHERE learner_id=? AND term_id=? AND assessment_type=?
  `).all(learner.id, term.id, assessment);
  const ratingMap = {};
  rows.forEach((r) => {
    if (!ratingMap[r.category_key]) ratingMap[r.category_key] = {};
    ratingMap[r.category_key][r.item_key] = r.rating;
  });
  const categories = [
    { key:'affective', label:'Affective Traits', items:affective.map((label) => ({ key:slugifyKey(label), label, rating:ratingMap.affective?.[slugifyKey(label)] ?? null })) },
    { key:'psychomotor', label:'Psychomotor Skills', items:psychomotor.map((label) => ({ key:slugifyKey(label), label, rating:ratingMap.psychomotor?.[slugifyKey(label)] ?? null })) }
  ];
  return { term:{ id:term.id, name:term.name }, assessment_type:assessment, categories, ratings, rating_labels:ratingLabels };
}

function learnerComments(db, learner, query) {
  const term = resolveTerm(db, query.term_id);
  if (!term) return { term:null, comments:[] };
  const assessment = validAssessment(query.assessment_type, detectAssessmentPeriod(term, todayStr()));
  const rows = db.prepare(`
    SELECT role, comment_text
    FROM learner_comments
    WHERE learner_id=? AND term_id=? AND assessment_type=?
    ORDER BY role
  `).all(learner.id, term.id, assessment);
  return {
    term:{ id:term.id, name:term.name },
    assessment_type:assessment,
    comments:rows.map((r) => ({ role:r.role, role_label:roleLabel(r.role), text:r.comment_text || '' }))
  };
}

router.get('/me', (req, res) => {
  const parent = getDB().prepare(`
    SELECT id, parent_id AS user_id, name, email, phone, status, created_at
    FROM parent_accounts WHERE id=?
  `).get(req.session.user.id);
  res.json({ success:true, data:parent });
});

router.get('/children', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT u.id, u.user_id, u.name, u.email, u.phone, u.admission_no, u.class_name, u.sex,
           u.date_of_birth, u.address, u.portrait_path, u.status, pll.relationship
    FROM parent_learner_links pll
    JOIN users u ON u.id=pll.learner_id
    WHERE pll.parent_id=? AND u.role='learner' AND u.status='active'
    ORDER BY u.class_name, u.name
  `).all(req.session.user.id);
  const children = rows.map((learner) => {
    const summary = learnerSummary(db, learner);
    const marks = learnerMarks(db, learner, { assessment_type:summary.current_assessment || 'opener' });
    return {
      ...summary.profile,
      class:summary.class,
      current_term:summary.current_term,
      current_assessment:summary.current_assessment,
      attendance_summary:summary.attendance_summary,
      subjects_count:summary.subjects_count,
      overall_percent:marks.overall_percent
    };
  });
  res.json({ success:true, data:{ children } });
});

router.get('/children/:learnerId/summary', (req, res) => {
  const db = getDB();
  const learner = requireLinkedLearner(req, res, db, req.params.learnerId);
  if (!learner) return;
  res.json({ success:true, data:learnerSummary(db, learner) });
});

router.get('/children/:learnerId/marks', (req, res) => {
  const db = getDB();
  const learner = requireLinkedLearner(req, res, db, req.params.learnerId);
  if (!learner) return;
  res.json({ success:true, data:learnerMarks(db, learner, req.query) });
});

router.get('/children/:learnerId/attendance', (req, res) => {
  const db = getDB();
  const learner = requireLinkedLearner(req, res, db, req.params.learnerId);
  if (!learner) return;
  res.json({ success:true, data:learnerAttendance(db, learner, req.query) });
});

router.get('/children/:learnerId/skills', (req, res) => {
  const db = getDB();
  const learner = requireLinkedLearner(req, res, db, req.params.learnerId);
  if (!learner) return;
  res.json({ success:true, data:learnerSkills(db, learner, req.query) });
});

router.get('/children/:learnerId/comments', (req, res) => {
  const db = getDB();
  const learner = requireLinkedLearner(req, res, db, req.params.learnerId);
  if (!learner) return;
  res.json({ success:true, data:learnerComments(db, learner, req.query) });
});

module.exports = router;
