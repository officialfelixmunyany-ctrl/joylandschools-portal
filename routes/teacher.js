const express = require('express');
const bcrypt  = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const { getDB } = require('../database');
const { todayInSchoolTime } = require('../lib/dates');
const router  = express.Router();

// Same template directory used by routes/admin.js â€” read-only access from here.
const TEMPLATE_DIR = path.join(__dirname, '..', 'data', 'templates');
function teacherTemplatePath(name) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80);
  return path.join(TEMPLATE_DIR, slug + '.json');
}
function readTemplateState(name) {
  if (!name) return null;
  try {
    const fp = teacherTemplatePath(name);
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

function performanceTargetAverage(db) {
  const row = db.prepare("SELECT value FROM school_settings WHERE key='performance_target_average'").get();
  const value = Number(row?.value ?? 75);
  if (!Number.isFinite(value)) return 75;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

// CBC defaults â€” used when no class template is set, or when the template has no skills config.
const DEFAULT_SKILLS = {
  affective: ['Punctuality', 'Attentiveness', 'Neatness', 'Honesty', 'Politeness'],
  psychomotor: ['Handwriting', 'Drawing', 'Sports', 'Crafts', 'Verbal Fluency'],
  ratings: [5, 4, 3, 2, 1],
  rating_labels: ['Excellent', 'Very Good', 'Good', 'Fair', 'Poor']
};

function requireTeacher(req, res, next) {
  if (req.session.user?.role === 'teacher') return next();
  const teacherUser = req.session.roleUsers?.teacher;
  if (!teacherUser) return res.status(401).json({ success:false, message:'Teacher session expired. Please log in as teacher again.' });
  req.session.user = teacherUser;
  next();
}
router.use(requireTeacher);

function teacherClassLists(db, teacherId) {
  const homeroom = db.prepare(`
    SELECT id, name, grade_level,
      (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=classes.name AND u.status='active') AS enrollment_count
    FROM classes
    WHERE class_teacher_id=?
    ORDER BY name
  `).all(teacherId);
  const subjects = db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name, s.id AS subject_id, s.name AS subject_name, s.code AS subject_code,
      (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=c.name AND u.status='active') AS enrollment_count
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.teacher_id=?
    ORDER BY c.name, s.name
  `).all(teacherId).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));
  return { homeroom, subjects };
}

// Verify a teacher teaches this (class_id, subject_id) pair. Returns the class row or null+writes 403.
function requireOwnedSubject(req, res, db, classId, subjectId) {
  const cid = Number(classId);
  const sid = Number(subjectId);
  if (!Number.isInteger(cid) || cid <= 0 || !Number.isInteger(sid) || sid <= 0) {
    res.status(400).json({ success:false, message:'class_id and subject_id required' });
    return null;
  }
  const cls = db.prepare('SELECT id, name FROM classes WHERE id=?').get(cid);
  if (!cls) {
    res.status(404).json({ success:false, message:'Class not found' });
    return null;
  }
  const link = db.prepare(`
    SELECT 1 FROM class_subjects
    WHERE class_id=? AND subject_id=? AND teacher_id=?
  `).get(cid, sid, req.session.user.id);
  if (!link) {
    res.status(403).json({ success:false, message:'You do not teach this subject' });
    return null;
  }
  return cls;
}

const VALID_ASSESSMENT_TYPES = new Set(['opener','midterm','endterm']);
function validAssessmentType(value) {
  return VALID_ASSESSMENT_TYPES.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : null;
}

function detectAssessmentPeriod(term, todayStr) {
  const start = new Date(term.start_date);
  const end = new Date(term.end_date);
  const today = todayStr ? new Date(todayStr) : new Date();
  const totalMs = end.getTime() - start.getTime();
  const elapsedMs = today.getTime() - start.getTime();
  const totalWeeks = Math.max(1, Math.round(totalMs / (7 * 86400000)));
  if (elapsedMs < 0) {
    return { period:'pre-term', period_label:'Term not started', week_no:0, total_weeks:totalWeeks, progress_percent:0 };
  }
  if (elapsedMs > totalMs) {
    return { period:'break', period_label:'On break', week_no:totalWeeks, total_weeks:totalWeeks, progress_percent:100 };
  }
  const progress = elapsedMs / totalMs;
  const weekNo = Math.min(totalWeeks, Math.max(1, Math.floor(elapsedMs / (7 * 86400000)) + 1));
  let period, periodLabel;
  if (progress < 1/3) { period = 'opener'; periodLabel = 'Opener'; }
  else if (progress < 2/3) { period = 'midterm'; periodLabel = 'Midterm'; }
  else { period = 'endterm'; periodLabel = 'Endterm'; }
  return { period, period_label:periodLabel, week_no:weekNo, total_weeks:totalWeeks, progress_percent:Math.round(progress * 100) };
}

function currentPeriodForToday(terms, today) {
  const term = terms.find((row) => row.start_date <= today && row.end_date >= today);
  if (!term) return null;
  const detected = detectAssessmentPeriod(term, today);
  return {
    term_name: term.term_name,
    period: detected.period,
    period_label: detected.period_label,
    week_no: detected.week_no,
    total_weeks: detected.total_weeks
  };
}

function todayAttendanceMap(db, classIds, today) {
  const marked = classIds.reduce((map, classId) => {
    map[classId] = false;
    return map;
  }, {});
  if (!classIds.length) return marked;

  const placeholders = classIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT class_id, date
    FROM attendance_records
    WHERE class_id IN (${placeholders}) AND date=?
  `).all(...classIds, today);

  rows.forEach((row) => {
    marked[row.class_id] = true;
  });
  return marked;
}

function todayStr() {
  return todayInSchoolTime();
}

function validDateStr(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return text;
}

function ownedClass(db, teacherId, classId) {
  return db.prepare(`
    SELECT id, name
    FROM classes
    WHERE id=? AND class_teacher_id=?
  `).get(classId, teacherId);
}

function requireOwnedClass(req, res, db, classId) {
  const id = Number(classId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ success:false, message:'class_id required' });
    return null;
  }
  const classRow = ownedClass(db, req.session.user.id, id);
  if (!classRow) {
    res.status(403).json({ success:false, message:'Not your class' });
    return null;
  }
  return classRow;
}

function termForDate(db, date) {
  return db.prepare(`
    SELECT id, term_name AS name, term_name, start_date, end_date
    FROM terms
    WHERE date(start_date) <= date(?) AND date(end_date) >= date(?)
    ORDER BY start_date DESC
    LIMIT 1
  `).get(date, date);
}

function defaultSummaryTerm(db, today) {
  return termForDate(db, today) || db.prepare(`
    SELECT id, term_name AS name, term_name, start_date, end_date
    FROM terms
    WHERE date(end_date) < date(?)
    ORDER BY date(end_date) DESC
    LIMIT 1
  `).get(today);
}

function attendanceStatusToDb(value) {
  const status = String(value || '').trim().toUpperCase();
  if (status === 'P' || status === 'PRESENT') return 'present';
  if (status === 'L' || status === 'LATE') return 'late';
  return 'absent';
}

function attendanceStatusToApi(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'present' || status === 'p') return 'P';
  if (status === 'late' || status === 'l') return 'L';
  return 'A';
}

function activeLearnerIdsForClass(db, className) {
  return new Set(db.prepare(`
    SELECT id
    FROM users
    WHERE role='learner' AND class_name=? AND status='active'
  `).all(className).map((row) => Number(row.id)));
}

router.get('/me', (req, res) => {
  const db = getDB();
  const user = db.prepare("SELECT id,user_id,name,email,phone,subject,status FROM users WHERE id=?").get(req.session.user.id);
  const classes = teacherClassLists(db, req.session.user.id);
  user.my_classes = classes.homeroom;
  user.subject_classes = classes.subjects;
  res.json({ success:true, data:user });
});

router.get('/dashboard', (req, res) => {
  const db = getDB();
  const active = db.prepare("SELECT * FROM academic_sessions WHERE is_active=1 LIMIT 1").get();
  const terms  = active ? db.prepare("SELECT * FROM terms WHERE session_id=? ORDER BY term_number").all(active.id) : [];
  const totalLearners = db.prepare("SELECT COUNT(*) c FROM users WHERE role='learner' AND status='active'").get().c;
  const classes = teacherClassLists(db, req.session.user.id);
  const today = todayStr();
  const classIds = classes.homeroom.map((row) => row.id);
  const todayAttendance = todayAttendanceMap(db, classIds, today);
  const pendingCount = classIds.filter((classId) => !todayAttendance[classId]).length;
  res.json({
    success:true,
    data:{
      active_session:active,
      terms,
      total_learners:totalLearners,
      my_classes:classes.homeroom,
      subject_classes:classes.subjects,
      current_period:currentPeriodForToday(terms, today),
      today_attendance:todayAttendance,
      pending_count:pendingCount
    }
  });
});

router.get('/classes/:id/learners', (req, res) => {
  const db = getDB();
  const classRow = requireOwnedClass(req, res, db, req.params.id);
  if (!classRow) return;
  const learners = db.prepare(`
    SELECT id, user_id, name, admission_no, sex, portrait_path AS photo_url
    FROM users
    WHERE role='learner' AND class_name=? AND status='active'
    ORDER BY name
  `).all(classRow.name);
  res.json({ success:true, data:{ class:{ id:classRow.id, name:classRow.name }, learners } });
});

router.get('/attendance/overview', (req, res) => {
  const db = getDB();
  const date = validDateStr(req.query.date || todayStr());
  if (!date) return res.status(400).json({ success:false, message:'Invalid date' });
  if (date > todayStr()) return res.status(400).json({ success:false, message:'Future dates are not allowed' });

  const term = termForDate(db, date);
  if (!term) return res.status(400).json({ success:false, message:'No school term contains this date' });

  const classes = teacherClassLists(db, req.session.user.id).homeroom;
  let present = 0;
  let absent = 0;
  let late = 0;
  let total = 0;

  const classRows = classes.map((cls) => {
    const learnerCount = Number(cls.enrollment_count || 0);
    const record = db.prepare(`
      SELECT id, created_at
      FROM attendance_records
      WHERE class_id=? AND date=?
    `).get(cls.id, date);

    let counts = { present:0, absent:0, late:0, total:0 };
    if (record) {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) AS present,
          SUM(CASE WHEN status='absent' THEN 1 ELSE 0 END) AS absent,
          SUM(CASE WHEN status='late' THEN 1 ELSE 0 END) AS late,
          COUNT(*) AS total
        FROM attendance_entries
        WHERE record_id=?
      `).get(record.id);
      counts = {
        present:Number(row?.present || 0),
        absent:Number(row?.absent || 0),
        late:Number(row?.late || 0),
        total:Number(row?.total || 0)
      };
    }

    present += counts.present;
    absent += counts.absent;
    late += counts.late;
    total += counts.total;

    return {
      id:cls.id,
      name:cls.name,
      grade_level:cls.grade_level,
      learner_count:learnerCount,
      marked:!!record,
      marked_at:record?.created_at || null,
      present:counts.present,
      absent:counts.absent,
      late:counts.late,
      total:counts.total,
      pct:counts.total ? Math.round((counts.present / counts.total) * 100) : null
    };
  });

  const markedCount = classRows.filter((row) => row.marked).length;
  res.json({
    success:true,
    data:{
      date,
      term:{ id:term.id, name:term.name },
      total_classes:classRows.length,
      marked_count:markedCount,
      pending_count:Math.max(0, classRows.length - markedCount),
      present,
      absent,
      late,
      total,
      pct:total ? Math.round((present / total) * 100) : null,
      classes:classRows
    }
  });
});

router.get('/attendance', (req, res) => {
  const db = getDB();
  const classRow = requireOwnedClass(req, res, db, req.query.class_id);
  if (!classRow) return;
  const date = validDateStr(req.query.date || todayStr());
  if (!date) return res.status(400).json({ success:false, message:'Invalid date' });
  if (date > todayStr()) return res.status(400).json({ success:false, message:'Future dates are not allowed' });
  if (!termForDate(db, date)) return res.status(400).json({ success:false, message:'No school term contains this date' });

  const record = db.prepare("SELECT id FROM attendance_records WHERE class_id=? AND date=?").get(classRow.id, date);
  if (!record) return res.json({ success:true, data:{ entries:{} } });

  const rows = db.prepare(`
    SELECT learner_id, status, note
    FROM attendance_entries
    WHERE record_id=?
  `).all(record.id);
  const entries = rows.reduce((map, row) => {
    map[row.learner_id] = { status:attendanceStatusToApi(row.status), note:row.note || '' };
    return map;
  }, {});
  res.json({ success:true, data:{ entries } });
});

router.post('/attendance', (req, res) => {
  const db = getDB();
  const classRow = requireOwnedClass(req, res, db, req.body?.class_id);
  if (!classRow) return;
  const date = validDateStr(req.body?.date || todayStr());
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!date || !entries) return res.status(400).json({ success:false, message:'Invalid data' });
  if (date > todayStr()) return res.status(400).json({ success:false, message:'Future dates are not allowed' });

  const term = termForDate(db, date);
  if (!term) return res.status(400).json({ success:false, message:'No school term contains this date' });

  const learnerIds = activeLearnerIdsForClass(db, classRow.name);
  let saved = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(`
      INSERT OR IGNORE INTO attendance_records (class_id, term_id, date, created_by)
      VALUES (?, ?, ?, ?)
    `).run(classRow.id, term.id, date, req.session.user.id);
    db.prepare(`
      UPDATE attendance_records
      SET term_id=?
      WHERE class_id=? AND date=?
    `).run(term.id, classRow.id, date);
    const record = db.prepare("SELECT id FROM attendance_records WHERE class_id=? AND date=?").get(classRow.id, date);
    const upsert = db.prepare(`
      INSERT INTO attendance_entries (record_id, learner_id, status, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(record_id, learner_id) DO UPDATE SET
        status=excluded.status,
        note=excluded.note
    `);
    entries.forEach((entry) => {
      const learnerId = Number(entry?.learner_id);
      if (!Number.isInteger(learnerId) || !learnerIds.has(learnerId)) return;
      upsert.run(record.id, learnerId, attendanceStatusToDb(entry.status), String(entry.note || '').trim() || null);
      saved += 1;
    });
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${saved} entries` });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.json({ success:false, message:e.message });
  }
});

router.get('/attendance/history', (req, res) => {
  const db = getDB();
  const classRow = requireOwnedClass(req, res, db, req.query.class_id);
  if (!classRow) return;
  const rawDays = Number(req.query.days || 30);
  const days = Number.isInteger(rawDays) && rawDays > 0 ? Math.min(rawDays, 365) : 30;
  const endDate = todayStr();
  const rows = db.prepare(`
    SELECT ar.date,
      SUM(CASE WHEN ae.status IN ('present','P') THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status IN ('absent','A') THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ae.status IN ('late','L') THEN 1 ELSE 0 END) AS late,
      COUNT(ae.id) AS total
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id
    WHERE ar.class_id=?
      AND date(ar.date) >= date(?, ?)
      AND date(ar.date) <= date(?)
    GROUP BY ar.id, ar.date
    ORDER BY date(ar.date) DESC
  `).all(classRow.id, endDate, `-${days - 1} days`, endDate);
  res.json({
    success:true,
    data:{ days:rows.map((row) => ({
      date:row.date,
      present:Number(row.present || 0),
      absent:Number(row.absent || 0),
      late:Number(row.late || 0),
      total:Number(row.total || 0)
    })) }
  });
});

router.get('/attendance/summary', (req, res) => {
  const db = getDB();
  const classRow = requireOwnedClass(req, res, db, req.query.class_id);
  if (!classRow) return;
  const term = req.query.term_id
    ? db.prepare("SELECT id, term_name AS name, term_name, start_date, end_date FROM terms WHERE id=?").get(req.query.term_id)
    : defaultSummaryTerm(db, todayStr());
  if (!term) return res.status(400).json({ success:false, message:'No term found for attendance summary' });

  const rows = db.prepare(`
    SELECT u.id AS learner_id, u.name, u.admission_no,
      SUM(CASE WHEN att.status IN ('present','P') THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN att.status IN ('absent','A') THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN att.status IN ('late','L') THEN 1 ELSE 0 END) AS late,
      COUNT(att.status) AS total
    FROM users u
    LEFT JOIN (
      SELECT ae.learner_id, ae.status
      FROM attendance_entries ae
      JOIN attendance_records ar ON ar.id=ae.record_id
      WHERE ar.class_id=? AND ar.term_id=?
    ) att ON att.learner_id=u.id
    WHERE u.role='learner' AND u.status='active' AND u.class_name=?
    GROUP BY u.id
    ORDER BY u.name
  `).all(classRow.id, term.id, classRow.name).map((row) => {
    const present = Number(row.present || 0);
    const absent = Number(row.absent || 0);
    const late = Number(row.late || 0);
    const total = Number(row.total || 0);
    return {
      learner_id:row.learner_id,
      name:row.name,
      admission_no:row.admission_no,
      present,
      absent,
      late,
      total,
      pct:total ? Math.round((present / total) * 100) : 0
    };
  }).sort((a, b) => a.pct - b.pct || a.name.localeCompare(b.name));

  res.json({ success:true, data:{ term:{ id:term.id, name:term.name }, summary:rows } });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• ENTER MARKS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Privilege rule: teachers can READ components and READ/WRITE marks for subjects they teach.
// Teachers CANNOT create/edit/delete components â€” that's admin-only via routes/admin.js.

function gradeCodeFromPercent(p) {
  if (p == null) return null;
  const n = Number(p);
  if (!Number.isFinite(n)) return null;
  if (n >= 75) return 'EE';
  if (n >= 58) return 'ME';
  if (n >= 31) return 'AE';
  return 'BE';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• SHARED ANALYTICS HELPERS (mobile Home dashboard) â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
const ASSESSMENT_SEQUENCE = ['opener', 'midterm', 'endterm'];
const ASSESSMENT_SHORT = { opener: 'Op', midterm: 'Mid', endterm: 'End' };
const ASSESSMENT_FULL = { opener: 'Opener', midterm: 'Midterm', endterm: 'Endterm' };

function bandRank(code) {
  return { EE: 4, ME: 3, AE: 2, BE: 1 }[code] || 0;
}

function meanOf(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(Number(v)));
  if (!nums.length) return null;
  return Math.round((nums.reduce((a, b) => a + Number(b), 0) / nums.length) * 10) / 10;
}

// Sum of component max scores + how many components are configured for a (class, subject, assessment).
function subjectComponentTotals(db, classId, subjectId, assessment) {
  const rows = db.prepare(`
    SELECT max_score FROM assessment_components
    WHERE class_id=? AND subject_id=? AND assessment_type=?
  `).all(classId, subjectId, assessment);
  return {
    maxTotal: rows.reduce((sum, r) => sum + Number(r.max_score || 0), 0),
    count: rows.length
  };
}

// { learnerId: percent } for every learner with at least one score in this assessment window.
function subjectLearnerPercents(db, classId, subjectId, termId, assessment) {
  const { maxTotal, count } = subjectComponentTotals(db, classId, subjectId, assessment);
  if (!maxTotal || !count) return {};
  const marks = db.prepare(`
    SELECT learner_id, score FROM marks
    WHERE class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND score IS NOT NULL
  `).all(classId, subjectId, termId, assessment);
  const totals = {};
  marks.forEach((m) => { totals[m.learner_id] = (totals[m.learner_id] || 0) + Number(m.score); });
  const out = {};
  Object.entries(totals).forEach(([lid, total]) => {
    out[lid] = Math.round((total / maxTotal) * 1000) / 10;
  });
  return out;
}

// Overall mean % across every subject a teacher teaches, for one assessment window. Used for ranking.
function teacherWindowMean(db, teacherId, termId, assessment) {
  const assignments = db.prepare(`
    SELECT class_id, subject_id FROM class_subjects WHERE teacher_id=?
  `).all(teacherId);
  const all = [];
  assignments.forEach((a) => {
    all.push(...Object.values(subjectLearnerPercents(db, a.class_id, a.subject_id, termId, assessment)));
  });
  return meanOf(all);
}

// Per-subject analytics for the teacher's home screen — single round-trip so the dashboard
// can render Zeraki-style subject cards (mean %, mean grade, learners marked).
router.get('/teaching-analytics', (req, res) => {
  const db = getDB();
  const teacherId = req.session.user.id;
  const today = todayStr();

  const term = req.query.term_id
    ? db.prepare(`SELECT id, term_name AS name FROM terms WHERE id=?`).get(req.query.term_id)
    : defaultSummaryTerm(db, today);

  const livePeriod = (() => {
    const t = termForDate(db, today);
    if (!t) return 'opener';
    const det = detectAssessmentPeriod(t, today);
    return VALID_ASSESSMENT_TYPES.has(det.period) ? det.period : 'opener';
  })();
  const assessment = validAssessmentType(req.query.assessment_type) || livePeriod;

  const teaching = db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name,
      s.id AS subject_id, s.name AS subject_name, s.code AS subject_code,
      (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=c.name AND u.status='active') AS enrollment_count
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.teacher_id=?
    ORDER BY c.name, s.name
  `).all(teacherId).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));

  const subjects = teaching.map(t => {
    if (!term) {
      return { ...t, mean_percent:null, mean_grade:null, learners_marked:0, components_configured:0 };
    }
    const comps = db.prepare(`
      SELECT max_score FROM assessment_components
      WHERE class_id=? AND subject_id=? AND assessment_type=?
    `).all(t.class_id, t.subject_id, assessment);
    const maxTotal = comps.reduce((sum, c) => sum + Number(c.max_score), 0);
    if (!maxTotal || !comps.length) {
      return { ...t, mean_percent:null, mean_grade:null, learners_marked:0, components_configured:comps.length };
    }
    const marks = db.prepare(`
      SELECT learner_id, score
      FROM marks
      WHERE class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND score IS NOT NULL
    `).all(t.class_id, t.subject_id, term.id, assessment);
    const totalsByLearner = {};
    marks.forEach(m => {
      totalsByLearner[m.learner_id] = (totalsByLearner[m.learner_id] || 0) + Number(m.score);
    });
    const percents = Object.values(totalsByLearner).map(total => (total / maxTotal) * 100);
    const mean = percents.length ? Math.round((percents.reduce((a,b)=>a+b,0) / percents.length) * 10) / 10 : null;
    return {
      ...t,
      mean_percent: mean,
      mean_grade: gradeCodeFromPercent(mean),
      learners_marked: percents.length,
      components_configured: comps.length
    };
  });

  res.json({
    success: true,
    data: {
      subjects,
      current_term: term ? { id: term.id, name: term.name } : null,
      current_assessment: assessment
    }
  });
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• MOBILE HOME DASHBOARD â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// One round-trip powering the segmented Home (Today / Performance / Learners).
// Everything is scoped to the subjects/classes this teacher actually owns.
// Query params: term_id, assessment_type, class_id (all optional).
router.get('/home', (req, res) => {
  const db = getDB();
  const teacherId = req.session.user.id;
  const today = todayStr();

  // â”€â”€ Chronological list of every assessment window across all terms â”€â”€
  const allTerms = db.prepare(`
    SELECT t.id, t.term_name, t.term_number, t.start_date, t.end_date, s.year AS session_year
    FROM terms t
    LEFT JOIN academic_sessions s ON s.id=t.session_id
    ORDER BY date(t.start_date)
  `).all();

  if (!allTerms.length) {
    return res.json({ success: true, data: { empty: true, message: 'No academic terms configured yet.' } });
  }

  const windows = [];
  allTerms.forEach((t) => {
    ASSESSMENT_SEQUENCE.forEach((a) => {
      windows.push({
        term_id: t.id,
        term_name: t.term_name,
        term_number: t.term_number,
        session_year: t.session_year,
        assessment: a,
        label: `${ASSESSMENT_SHORT[a]} T${t.term_number}`
      });
    });
  });

  // â”€â”€ Resolve the selected term + assessment â”€â”€
  let selTerm = req.query.term_id
    ? allTerms.find((t) => String(t.id) === String(req.query.term_id))
    : null;
  if (!selTerm) {
    selTerm = allTerms.find((t) => t.start_date <= today && t.end_date >= today)
      || [...allTerms].reverse().find((t) => t.end_date < today)
      || allTerms[allTerms.length - 1];
  }
  const detected = detectAssessmentPeriod(selTerm, today);
  const livePeriod = ASSESSMENT_SEQUENCE.includes(detected.period) ? detected.period : 'opener';
  let selAssessment = validAssessmentType(req.query.assessment_type) || livePeriod;

  let selWindowIndex = windows.findIndex((w) => w.term_id === selTerm.id && w.assessment === selAssessment);

  // Smart default: when the teacher hasn't picked a window, and the live window has no
  // marks yet, fall back to their most recent window that actually has data.
  if (!req.query.term_id && !req.query.assessment_type && selWindowIndex >= 0) {
    let probe = selWindowIndex;
    let guard = 0;
    while (probe >= 0 && guard < windows.length) {
      const w = windows[probe];
      if (teacherWindowMean(db, teacherId, w.term_id, w.assessment) != null) break;
      probe--;
      guard++;
    }
    if (probe >= 0 && probe !== selWindowIndex) {
      const w = windows[probe];
      selTerm = allTerms.find((t) => t.id === w.term_id) || selTerm;
      selAssessment = w.assessment;
      selWindowIndex = probe;
    }
  }

  const prevWindow = selWindowIndex > 0 ? windows[selWindowIndex - 1] : null;
  const prev2Window = selWindowIndex > 1 ? windows[selWindowIndex - 2] : null;
  const targetAverage = performanceTargetAverage(db);

  // â”€â”€ Teacher's subject assignments + homerooms â”€â”€
  const assignments = db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name, c.grade_level,
      s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.teacher_id=?
    ORDER BY c.name, s.name
  `).all(teacherId).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));

  const homerooms = db.prepare(`
    SELECT id, name, grade_level FROM classes WHERE class_teacher_id=? ORDER BY name
  `).all(teacherId);

  if (!assignments.length && !homerooms.length) {
    return res.json({ success:true, data:{ empty:true, message:'No classes assigned.' } });
  }

  const classFilter = req.query.class_id ? Number(req.query.class_id) : null;
  const filteredAssignments = classFilter
    ? assignments.filter((a) => a.class_id === classFilter)
    : assignments;

  // Filter dropdown: union of subject classes + homerooms
  const classMap = new Map();
  assignments.forEach((a) => classMap.set(a.class_id, a.class_name));
  homerooms.forEach((h) => classMap.set(h.id, h.name));
  const filterClasses = [...classMap.entries()].map(([id, name]) => ({ id, name }));

  // â”€â”€ small caches â”€â”€
  const enrollCache = {};
  function enrollment(className) {
    if (enrollCache[className] == null) {
      enrollCache[className] = db.prepare(`
        SELECT COUNT(*) c FROM users WHERE role='learner' AND class_name=? AND status='active'
      `).get(className).c;
    }
    return enrollCache[className];
  }
  const nameCache = {};
  function learnerInfo(id) {
    if (nameCache[id] == null) {
      nameCache[id] = db.prepare('SELECT name, admission_no FROM users WHERE id=?').get(id) || { name: 'Learner' };
    }
    return nameCache[id];
  }
  function initialsOf(name) {
    return String(name || '?').split(/\s+/).map((x) => x[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
  }

  // â”€â”€ Per-subject percents for the SELECTED window (active learners only) â”€â”€
  const perSubject = filteredAssignments.map((a) => {
    const activeIds = activeLearnerIdsForClass(db, a.class_name);
    const raw = subjectLearnerPercents(db, a.class_id, a.subject_id, selTerm.id, selAssessment);
    const percents = {};
    Object.entries(raw).forEach(([lid, pct]) => {
      if (activeIds.has(Number(lid))) percents[lid] = pct;
    });
    return { ...a, activeIds, percents, vals: Object.values(percents) };
  });

  // â”€â”€ PERFORMANCE: distribution table â”€â”€
  const distribution = {
    subjects: perSubject.map((s) => {
      const bands = { EE: 0, ME: 0, AE: 0, BE: 0 };
      s.vals.forEach((p) => { bands[gradeCodeFromPercent(p)]++; });
      return {
        subject_id: s.subject_id, subject_name: s.subject_name, subject_code: s.subject_code,
        class_id: s.class_id, class_name: s.class_name,
        ee: bands.EE, me: bands.ME, ae: bands.AE, be: bands.BE,
        mean: meanOf(s.vals), marked: s.vals.length, total: enrollment(s.class_name)
      };
    }),
    overall: (() => {
      const all = perSubject.flatMap((s) => s.vals);
      const bands = { EE: 0, ME: 0, AE: 0, BE: 0 };
      all.forEach((p) => { bands[gradeCodeFromPercent(p)]++; });
      return { ee: bands.EE, me: bands.ME, ae: bands.AE, be: bands.BE, mean: meanOf(all) };
    })()
  };

  // â”€â”€ PERFORMANCE: trend (last 4 windows ending at selected) â”€â”€
  const trendSlice = windows.slice(Math.max(0, selWindowIndex - 3), selWindowIndex + 1);
  const trend = {
    labels: trendSlice.map((w) => w.label),
    current_index: trendSlice.length - 1,
    subjects: perSubject.map((s) => {
      const points = trendSlice.map((w) => meanOf(Object.values(
        subjectLearnerPercents(db, s.class_id, s.subject_id, w.term_id, w.assessment)
      )));
      const known = points.filter((p) => p != null);
      let arrow = 'flat';
      if (known.length >= 2) {
        const d = known[known.length - 1] - known[known.length - 2];
        arrow = d > 1 ? 'up' : d < -1 ? 'down' : 'flat';
      }
      return {
        subject_id: s.subject_id, subject_name: s.subject_name,
        points, arrow, current: points[points.length - 1]
      };
    })
  };

  // â”€â”€ PERFORMANCE: class vs school target â”€â”€
  const classVsSchool = perSubject.map((s) => {
    const you = meanOf(s.vals);
    return {
      subject_id: s.subject_id, subject_name: s.subject_name,
      you,
      school: targetAverage,
      target: targetAverage,
      delta: you != null ? Math.round((you - targetAverage) * 10) / 10 : null
    };
  });

  // â”€â”€ LEARNERS: subject champions (top 3 per subject) â”€â”€
  const champions = perSubject.map((s) => {
    const top = Object.entries(s.percents)
      .map(([lid, pct]) => ({ learner_id: Number(lid), score: pct }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((r) => ({ learner_id: r.learner_id, score: r.score, name: learnerInfo(r.learner_id).name }));
    return {
      subject_id: s.subject_id, subject_name: s.subject_name, subject_code: s.subject_code,
      top
    };
  }).filter((c) => c.top.length);

  // â”€â”€ LEARNERS: watchlist (rule-based flags) + band-movement counters â”€â”€
  const SEV = { high: 2, mid: 1 };
  const flagsByLearner = {};
  let bandMovesUp = 0;
  function addFlag(learnerId, flag) {
    const existing = flagsByLearner[learnerId];
    if (!existing || SEV[flag.severity] > SEV[existing.severity]) flagsByLearner[learnerId] = flag;
  }

  perSubject.forEach((s) => {
    const prevPcts = prevWindow
      ? subjectLearnerPercents(db, s.class_id, s.subject_id, prevWindow.term_id, prevWindow.assessment)
      : {};
    const prev2Pcts = prev2Window
      ? subjectLearnerPercents(db, s.class_id, s.subject_id, prev2Window.term_id, prev2Window.assessment)
      : {};

    Object.entries(s.percents).forEach(([lid, cur]) => {
      const curBand = gradeCodeFromPercent(cur);
      const prev = prevPcts[lid];
      const prev2 = prev2Pcts[lid];
      const prevBand = prev != null ? gradeCodeFromPercent(prev) : null;

      if (prevBand && bandRank(curBand) > bandRank(prevBand)) bandMovesUp++;

      if (prevBand && bandRank(curBand) < bandRank(prevBand)) {
        addFlag(lid, {
          learner_id: Number(lid), area: s.subject_name, severity: 'high',
          reason: 'dropped a grade band',
          viz: { type: 'band', from: prevBand, to: curBand }
        });
      } else if (prev != null && prev2 != null && prev2 > prev && prev > cur) {
        addFlag(lid, {
          learner_id: Number(lid), area: s.subject_name, severity: 'mid',
          reason: 'declining 3 assessments straight',
          viz: { type: 'bars', points: [prev2, prev, cur] }
        });
      } else if (curBand === 'BE' && prevBand === 'BE') {
        addFlag(lid, {
          learner_id: Number(lid), area: s.subject_name, severity: 'high',
          reason: 'BE band - 2 assessments running',
          viz: { type: 'band', to: 'BE' }
        });
      }
    });
  });

  // Attendance flags from homeroom classes (term-to-date)
  let attPresent = 0;
  let attTotal = 0;
  homerooms.forEach((h) => {
    const rows = db.prepare(`
      SELECT u.id AS learner_id,
        SUM(CASE WHEN att.status='present' THEN 1 ELSE 0 END) AS present,
        SUM(CASE WHEN att.status='late' THEN 1 ELSE 0 END) AS late,
        COUNT(att.status) AS total
      FROM users u
      LEFT JOIN (
        SELECT ae.learner_id, ae.status
        FROM attendance_entries ae
        JOIN attendance_records ar ON ar.id=ae.record_id
        WHERE ar.class_id=? AND ar.term_id=?
      ) att ON att.learner_id=u.id
      WHERE u.role='learner' AND u.status='active' AND u.class_name=?
      GROUP BY u.id
    `).all(h.id, selTerm.id, h.name);
    rows.forEach((r) => {
      const total = Number(r.total || 0);
      const present = Number(r.present || 0);
      attPresent += present;
      attTotal += total;
      if (total >= 5) {
        const pct = Math.round((present / total) * 100);
        if (pct < 80) {
          addFlag(r.learner_id, {
            learner_id: r.learner_id, area: 'Attendance', severity: 'mid',
            reason: `${total - present} days missed this term`,
            viz: { type: 'flag', text: `${pct}%` }
          });
        }
      }
    });
  });

  const watchlist = Object.values(flagsByLearner)
    .map((f) => {
      const info = learnerInfo(f.learner_id);
      return { ...f, name: info.name, initials: initialsOf(info.name) };
    })
    .sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.name.localeCompare(b.name))
    .slice(0, 8);

  // â”€â”€ TODAY: marking progress (every assignment, current assessment) â”€â”€
  const markingSubjects = assignments.map((a) => {
    const { count } = subjectComponentTotals(db, a.class_id, a.subject_id, selAssessment);
    const total = enrollment(a.class_name);
    let marked = 0;
    if (count) {
      marked = Object.keys(subjectLearnerPercents(db, a.class_id, a.subject_id, selTerm.id, selAssessment)).length;
    }
    return {
      class_id: a.class_id, class_name: a.class_name,
      subject_id: a.subject_id, subject_name: a.subject_name,
      configured: count > 0, marked, total,
      done: count > 0 && total > 0 && marked >= total
    };
  });
  const markDone = markingSubjects.filter((s) => s.done).length;
  const markingProgress = {
    assessment_label: ASSESSMENT_FULL[selAssessment],
    done: markDone,
    total: markingSubjects.length,
    percent: markingSubjects.length ? Math.round((markDone / markingSubjects.length) * 100) : 0,
    subjects: markingSubjects.map((s) => ({ subject_name: s.subject_name, class_name: s.class_name, done: s.done, configured: s.configured }))
  };

  // â”€â”€ TODAY: pending tasks â”€â”€
  const pendingTasks = [];
  const todayMarked = todayAttendanceMap(db, homerooms.map((h) => h.id), today);
  homerooms.forEach((h) => {
    if (!todayMarked[h.id]) {
      pendingTasks.push({
        type: 'warn', icon: 'clipboard-check',
        title: 'Attendance not marked',
        sub: `${h.name} - today's session`,
        action: { tab: 'attendance', url: `/attendance/${h.id}/` }
      });
    }
  });
  markingSubjects.forEach((s) => {
    if (s.configured && s.total > 0 && s.marked < s.total) {
      pendingTasks.push({
        type: 'danger', icon: 'pen-alt',
        title: `${s.total - s.marked} learner${(s.total - s.marked) === 1 ? '' : 's'} ungraded`,
        sub: `${s.subject_name} ${ASSESSMENT_FULL[selAssessment]} - ${s.class_name}`,
        action: { tab: 'marks', url: `/marks/${s.class_id}/${s.subject_id}/?assessment=${selAssessment}` }
      });
    }
  });
  const pendingTasksCapped = pendingTasks.slice(0, 6);

  // â”€â”€ HERO METRICS â”€â”€
  const myMean = meanOf(perSubject.flatMap((s) => s.vals));
  const prevMean = prevWindow
    ? meanOf(perSubject.flatMap((s) => Object.values(
        subjectLearnerPercents(db, s.class_id, s.subject_id, prevWindow.term_id, prevWindow.assessment)
      )))
    : null;
  const myMeanDelta = (myMean != null && prevMean != null)
    ? Math.round((myMean - prevMean) * 10) / 10
    : null;
  const attendanceRate = attTotal ? Math.round((attPresent / attTotal) * 100) : null;

  // Rank: teacher's overall mean among all teachers with marks this window
  let rank = null;
  try {
    const teacherIds = db.prepare('SELECT DISTINCT teacher_id FROM class_subjects WHERE teacher_id IS NOT NULL').all();
    const ranked = teacherIds
      .map((t) => ({ id: t.teacher_id, mean: teacherWindowMean(db, t.teacher_id, selTerm.id, selAssessment) }))
      .filter((t) => t.mean != null)
      .sort((a, b) => b.mean - a.mean);
    const idx = ranked.findIndex((t) => Number(t.id) === Number(teacherId));
    if (idx >= 0) rank = { value: idx + 1, total: ranked.length };
  } catch (_) { /* rank is best-effort */ }

  const metrics = {
    my_mean: { value: myMean, delta: myMeanDelta },
    attendance: { value: attendanceRate, delta: null },
    rank,
    pending: { value: pendingTasks.length }
  };

  // â”€â”€ TODAY: quick insights (derived) â”€â”€
  const insights = [];
  const drops = trend.subjects
    .map((s) => {
      const pts = s.points.filter((p) => p != null);
      if (pts.length < 2) return null;
      return { name: s.subject_name, delta: Math.round((pts[pts.length - 1] - pts[0]) * 10) / 10 };
    })
    .filter(Boolean)
    .sort((a, b) => a.delta - b.delta);
  if (drops.length && drops[0].delta < 0) {
    insights.push({
      type: 'warn', icon: 'down',
      text: `<b>${drops[0].name}</b> fell <b>${Math.abs(drops[0].delta)}%</b> over recent assessments - your steepest drop.`
    });
  }
  const strongest = [...distribution.subjects].filter((s) => s.mean != null).sort((a, b) => b.mean - a.mean)[0];
  if (strongest) {
    insights.push({
      type: 'good', icon: 'star',
      text: `<b>${strongest.subject_name}</b> is your strongest subject at <b>${strongest.mean}% mean</b>.`
    });
  }
  if (bandMovesUp > 0) {
    insights.push({
      type: 'up', icon: 'arrow-up',
      text: `<b>${bandMovesUp} learner${bandMovesUp === 1 ? '' : 's'}</b> moved up a grade band this assessment.`
    });
  }
  if (attendanceRate != null) {
    insights.push({
      type: 'info', icon: 'user-check',
      text: `Your class attendance is <b>${attendanceRate}%</b> this term.`
    });
  }
  if (!insights.length) {
    insights.push({
      type: 'info', icon: 'user-check',
      text: 'No assessment data yet for this window. Enter marks to unlock insights.'
    });
  }

  res.json({
    success: true,
    data: {
      context: {
        term: { id: selTerm.id, name: selTerm.term_name, session_year: selTerm.session_year },
        assessment: selAssessment,
        assessment_label: ASSESSMENT_FULL[selAssessment],
        period_label: detected.period_label,
        class_id: classFilter
      },
      filters: {
        terms: allTerms.map((t) => ({
          id: t.id,
          label: t.session_year ? `${t.term_name} - ${t.session_year}` : t.term_name
        })),
        assessments: ASSESSMENT_SEQUENCE.map((a) => ({ value: a, label: ASSESSMENT_FULL[a] })),
        classes: filterClasses
      },
      metrics,
      insights,
      marking_progress: markingProgress,
      pending_tasks: pendingTasksCapped,
      distribution,
      trend,
      class_vs_school: classVsSchool,
      performance_target_average: targetAverage,
      champions,
      watchlist
    }
  });
});

router.get('/teaching', (req, res) => {
  const db = getDB();
  const teacherId = req.session.user.id;
  const today = todayStr();

  const teaching = db.prepare(`
    SELECT c.id AS class_id, c.name AS class_name,
      s.id AS subject_id, s.name AS subject_name, s.code AS subject_code,
      (SELECT COUNT(*) FROM users u WHERE u.role='learner' AND u.class_name=c.name AND u.status='active') AS enrollment_count
    FROM class_subjects cs
    JOIN classes c ON c.id=cs.class_id
    JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.teacher_id=?
    ORDER BY c.name, s.name
  `).all(teacherId);

  const term = termForDate(db, today);
  let currentAssessment = 'opener';
  let currentTerm = null;
  if (term) {
    currentTerm = { id: term.id, name: term.name };
    const det = detectAssessmentPeriod(term, today);
    if (det.period === 'opener' || det.period === 'midterm' || det.period === 'endterm') {
      currentAssessment = det.period;
    }
  }
  res.json({ success:true, data:{ teaching:teaching.map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) })), current_term:currentTerm, current_assessment:currentAssessment } });
});

router.get('/assessment-components', (req, res) => {
  const db = getDB();
  const cls = requireOwnedSubject(req, res, db, req.query.class_id, req.query.subject_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.query.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });

  const components = db.prepare(`
    SELECT id, component_key, component_name, max_score, sort_order
    FROM assessment_components
    WHERE class_id=? AND subject_id=? AND assessment_type=?
    ORDER BY sort_order, component_name
  `).all(cls.id, Number(req.query.subject_id), assessment);

  res.json({ success:true, data:{ components } });
});

router.get('/marks', (req, res) => {
  const db = getDB();
  const cls = requireOwnedSubject(req, res, db, req.query.class_id, req.query.subject_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.query.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });

  let term;
  if (req.query.term_id) {
    term = db.prepare(`SELECT id, term_name AS name FROM terms WHERE id=?`).get(req.query.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = termForDate(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No current term available' });
  }

  const rows = db.prepare(`
    SELECT learner_id, component_key, score
    FROM marks
    WHERE class_id=? AND subject_id=? AND term_id=? AND assessment_type=?
  `).all(cls.id, Number(req.query.subject_id), term.id, assessment);

  const entries = {};
  rows.forEach((row) => {
    if (!entries[row.learner_id]) entries[row.learner_id] = {};
    entries[row.learner_id][row.component_key] = row.score;
  });

  res.json({ success:true, data:{ term:{ id:term.id, name:term.name }, entries } });
});

router.post('/marks', (req, res) => {
  const db = getDB();
  const cls = requireOwnedSubject(req, res, db, req.body?.class_id, req.body?.subject_id);
  if (!cls) return;
  const subjectId = Number(req.body.subject_id);
  const assessment = validAssessmentType(req.body.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  const entries = Array.isArray(req.body.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).json({ success:false, message:'entries array required' });

  let term;
  if (req.body.term_id) {
    term = db.prepare(`SELECT id FROM terms WHERE id=?`).get(req.body.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = termForDate(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No current term available' });
  }

  const compRows = db.prepare(`
    SELECT component_key, max_score
    FROM assessment_components
    WHERE class_id=? AND subject_id=? AND assessment_type=?
  `).all(cls.id, subjectId, assessment);
  const compMap = new Map(compRows.map((row) => [row.component_key, Number(row.max_score)]));
  if (!compMap.size) {
    return res.status(400).json({ success:false, message:'No components configured for this assessment â€” ask admin to set them up' });
  }

  const learnerIds = activeLearnerIdsForClass(db, cls.name);
  let saved = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const deleteStmt = db.prepare(`
      DELETE FROM marks
      WHERE learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND component_key=?
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO marks (learner_id, class_id, subject_id, term_id, assessment_type, component_key, score, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(learner_id, class_id, subject_id, term_id, assessment_type, component_key) DO UPDATE SET
        score=excluded.score,
        updated_at=datetime('now')
    `);
    for (const entry of entries) {
      const lid = Number(entry?.learner_id);
      const key = String(entry?.component_key || '').trim();
      if (!compMap.has(key)) {
        db.exec('ROLLBACK');
        return res.status(400).json({ success:false, message:`Unknown component "${key}" for this assessment` });
      }
      if (!Number.isInteger(lid) || !learnerIds.has(lid)) continue;
      const max = compMap.get(key);
      const rawScore = entry?.score;
      const notSat = entry?.not_sat === true || entry?.status === 'not_sat';
      if (notSat) {
        upsertStmt.run(lid, cls.id, subjectId, term.id, assessment, key, null, req.session.user.id);
        saved += 1;
        continue;
      }
      if (rawScore === null || rawScore === undefined || rawScore === '') {
        deleteStmt.run(lid, cls.id, subjectId, term.id, assessment, key);
        saved += 1;
        continue;
      }
      const score = Number(rawScore);
      if (!Number.isFinite(score) || score < 0 || score > max) {
        db.exec('ROLLBACK');
        return res.status(400).json({ success:false, message:`Score ${rawScore} out of range (0-${max}) for ${key}` });
      }
      upsertStmt.run(lid, cls.id, subjectId, term.id, assessment, key, score, req.session.user.id);
      saved += 1;
    }
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${saved} entries` });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(500).json({ success:false, message:e.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• RATE SKILLS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Privilege: only class teachers (`classes.class_teacher_id`) rate skills for their class.
// Skill structure (categories + items + rating scale) comes from the class's saved template;
// falls back to CBC defaults when the template has no custom skills config.

router.get('/skills/config', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.query.class_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.query.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });

  // Try class template; fall back to defaults
  const classRow = db.prepare('SELECT template_name FROM classes WHERE id=?').get(cls.id);
  const state = readTemplateState(classRow?.template_name);
  const sk = (state && state.customizations && state.customizations.skills) || {};
  const affective    = (Array.isArray(sk.affective)    && sk.affective.length)    ? sk.affective    : DEFAULT_SKILLS.affective;
  const psychomotor  = (Array.isArray(sk.psychomotor)  && sk.psychomotor.length)  ? sk.psychomotor  : DEFAULT_SKILLS.psychomotor;
  const ratings      = (Array.isArray(sk.ratings)      && sk.ratings.length)      ? sk.ratings      : DEFAULT_SKILLS.ratings;
  const ratingLabels = (Array.isArray(sk.rating_labels) && sk.rating_labels.length) ? sk.rating_labels : DEFAULT_SKILLS.rating_labels;

  const categories = [
    { key:'affective',   label:'Affective Traits',   items:affective.map((label) => ({ key:slugifyKey(label), label })) },
    { key:'psychomotor', label:'Psychomotor Skills', items:psychomotor.map((label) => ({ key:slugifyKey(label), label })) }
  ];
  res.json({ success:true, data:{ categories, ratings, rating_labels:ratingLabels, source: state ? 'template' : 'default' } });
});

router.get('/skills', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.query.class_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.query.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  let term;
  if (req.query.term_id) {
    term = db.prepare('SELECT id, term_name AS name FROM terms WHERE id=?').get(req.query.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }
  const rows = db.prepare(`
    SELECT learner_id, category_key, item_key, rating
    FROM learner_skills
    WHERE class_id=? AND term_id=? AND assessment_type=?
  `).all(cls.id, term.id, assessment);
  const entries = {};
  rows.forEach((row) => {
    if (!entries[row.learner_id]) entries[row.learner_id] = {};
    if (!entries[row.learner_id][row.category_key]) entries[row.learner_id][row.category_key] = {};
    entries[row.learner_id][row.category_key][row.item_key] = row.rating;
  });
  res.json({ success:true, data:{ term:{ id:term.id, name:term.name }, entries } });
});

router.post('/skills', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.body?.class_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.body?.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).json({ success:false, message:'entries array required' });

  let term;
  if (req.body.term_id) {
    term = db.prepare('SELECT id FROM terms WHERE id=?').get(req.body.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }

  const learnerIds = activeLearnerIdsForClass(db, cls.name);
  let saved = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const deleteStmt = db.prepare(`
      DELETE FROM learner_skills
      WHERE learner_id=? AND term_id=? AND assessment_type=? AND category_key=? AND item_key=?
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO learner_skills (learner_id, class_id, term_id, assessment_type, category_key, item_key, rating, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(learner_id, term_id, assessment_type, category_key, item_key) DO UPDATE SET
        rating=excluded.rating,
        updated_at=datetime('now')
    `);
    for (const entry of entries) {
      const lid = Number(entry?.learner_id);
      const catKey  = String(entry?.category_key || '').trim();
      const itemKey = String(entry?.item_key || '').trim();
      if (!Number.isInteger(lid) || !learnerIds.has(lid)) continue;
      if (!catKey || !itemKey) continue;
      const rawRating = entry?.rating;
      if (rawRating === null || rawRating === undefined || rawRating === '') {
        deleteStmt.run(lid, term.id, assessment, catKey, itemKey);
        saved += 1;
        continue;
      }
      const n = Number(rawRating);
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        db.exec('ROLLBACK');
        return res.status(400).json({ success:false, message:`Rating ${rawRating} out of range (1-5)` });
      }
      upsertStmt.run(lid, cls.id, term.id, assessment, catKey, itemKey, n, req.session.user.id);
      saved += 1;
    }
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${saved} ratings` });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(500).json({ success:false, message:e.message });
  }
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• MY COMMENTS â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Privilege: class teacher writes ONLY the class_teacher comment for learners in their class.
// Headteacher / director comments are written elsewhere (admin or a separate role app).
// The bank suggestion endpoint helps the teacher pre-fill from score-banded defaults.

router.get('/comments', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.query.class_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.query.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  let term;
  if (req.query.term_id) {
    term = db.prepare('SELECT id, term_name AS name FROM terms WHERE id=?').get(req.query.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }
  const rows = db.prepare(`
    SELECT learner_id, comment_text
    FROM learner_comments
    WHERE class_id=? AND term_id=? AND assessment_type=? AND role='class_teacher'
  `).all(cls.id, term.id, assessment);
  const map = {};
  rows.forEach((row) => { map[row.learner_id] = row.comment_text || ''; });
  res.json({ success:true, data:{ term:{ id:term.id, name:term.name }, entries:map } });
});

router.post('/comments', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.body?.class_id);
  if (!cls) return;
  const assessment = validAssessmentType(req.body?.assessment_type);
  if (!assessment) return res.status(400).json({ success:false, message:'Invalid assessment_type' });
  const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
  if (!entries) return res.status(400).json({ success:false, message:'entries array required' });
  let term;
  if (req.body.term_id) {
    term = db.prepare('SELECT id FROM terms WHERE id=?').get(req.body.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }
  const learnerIds = activeLearnerIdsForClass(db, cls.name);
  let saved = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    const deleteStmt = db.prepare(`
      DELETE FROM learner_comments
      WHERE learner_id=? AND term_id=? AND assessment_type=? AND role='class_teacher'
    `);
    const upsertStmt = db.prepare(`
      INSERT INTO learner_comments (learner_id, class_id, term_id, assessment_type, role, comment_text, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'class_teacher', ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(learner_id, term_id, assessment_type, role) DO UPDATE SET
        comment_text=excluded.comment_text,
        updated_at=datetime('now')
    `);
    for (const entry of entries) {
      const lid = Number(entry?.learner_id);
      if (!Number.isInteger(lid) || !learnerIds.has(lid)) continue;
      const text = (entry?.comment_text == null) ? '' : String(entry.comment_text).trim();
      if (!text) {
        deleteStmt.run(lid, term.id, assessment);
        saved += 1;
        continue;
      }
      if (text.length > 1000) {
        db.exec('ROLLBACK');
        return res.status(400).json({ success:false, message:'Comment too long (max 1000 chars)' });
      }
      upsertStmt.run(lid, cls.id, term.id, assessment, text, req.session.user.id);
      saved += 1;
    }
    db.exec('COMMIT');
    res.json({ success:true, message:`Saved ${saved} comments` });
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    res.status(500).json({ success:false, message:e.message });
  }
});

// Score-banded comment suggestions from the bank â€” used by the mobile app to pre-fill drafts
router.get('/comments/suggestions', (req, res) => {
  const db = getDB();
  const rows = db.prepare(`
    SELECT min_score, max_score, comment_text
    FROM report_comments
    WHERE role='class_teacher' AND class_id IS NULL
    ORDER BY max_score DESC
  `).all();
  res.json({ success:true, data:{ bands:rows } });
});

// Per-learner report readiness: for a class/term/assessment, how many of the class's
// subjects have marks recorded for each learner. Powers the report-cards picker status pills.
router.get('/report-readiness', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.query.class_id);
  if (!cls) return;

  let term;
  if (req.query.term_id) {
    term = db.prepare('SELECT id, term_name AS name, start_date, end_date FROM terms WHERE id=?').get(req.query.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }
  const detected = detectAssessmentPeriod(term, todayStr());
  const fallbackAssessment = ['opener','midterm','endterm'].includes(detected.period) ? detected.period : 'opener';
  const assessment = validAssessmentType(req.query.assessment_type) || fallbackAssessment;

  const subjectsTotal = db.prepare('SELECT COUNT(*) c FROM class_subjects WHERE class_id=?').get(cls.id).c;

  const learners = db.prepare(`
    SELECT id AS learner_id, name, admission_no
    FROM users
    WHERE role='learner' AND status='active' AND class_name=?
    ORDER BY name
  `).all(cls.name);

  const doneRows = db.prepare(`
    SELECT learner_id, COUNT(DISTINCT subject_id) AS done
    FROM marks
    WHERE class_id=? AND term_id=? AND assessment_type=?
    GROUP BY learner_id
  `).all(cls.id, term.id, assessment);
  const doneMap = {};
  doneRows.forEach((r) => { doneMap[r.learner_id] = Number(r.done || 0); });

  const result = learners.map((l) => {
    const done = Math.min(doneMap[l.learner_id] || 0, subjectsTotal);
    const status = (subjectsTotal === 0 || done >= subjectsTotal) ? 'ready' : 'partial';
    return {
      learner_id: l.learner_id,
      name: l.name,
      admission_no: l.admission_no,
      subjects_done: done,
      subjects_total: subjectsTotal,
      status
    };
  });

  res.json({
    success: true,
    data: {
      class: { id: cls.id, name: cls.name },
      term: { id: term.id, name: term.name },
      assessment,
      subjects_total: subjectsTotal,
      learners: result
    }
  });
});

router.get('/report-card', (req, res) => {
  const db = getDB();
  const cls = requireOwnedClass(req, res, db, req.query.class_id);
  if (!cls) return;
  const learnerId = Number(req.query.learner_id);
  if (!Number.isInteger(learnerId) || learnerId <= 0) return res.status(400).json({ success:false, message:'learner_id required' });
  const learner = db.prepare(`
    SELECT id, user_id, name, admission_no, class_name, sex, date_of_birth, portrait_path
    FROM users
    WHERE id=? AND role='learner' AND status='active' AND class_name=?
  `).get(learnerId, cls.name);
  if (!learner) return res.status(404).json({ success:false, message:'Learner not found in your class' });

  let term;
  if (req.query.term_id) {
    term = db.prepare('SELECT id, term_name AS name, term_name, start_date, end_date FROM terms WHERE id=?').get(req.query.term_id);
    if (!term) return res.status(400).json({ success:false, message:'Term not found' });
  } else {
    term = defaultSummaryTerm(db, todayStr());
    if (!term) return res.status(400).json({ success:false, message:'No term available' });
  }
  const detected = detectAssessmentPeriod(term, todayStr());
  const fallbackAssessment = ['opener','midterm','endterm'].includes(detected.period) ? detected.period : 'opener';
  const assessment = validAssessmentType(req.query.assessment_type) || fallbackAssessment;

  const subjects = db.prepare(`
    SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
    FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
    WHERE cs.class_id=? ORDER BY s.name
  `).all(cls.id).map((sub) => {
    sub = { ...sub, subject_code:publicSubjectCode(sub.subject_code) };
    const components = db.prepare(`
      SELECT component_key AS key, component_name AS name, max_score AS max
      FROM assessment_components
      WHERE class_id=? AND subject_id=? AND assessment_type=?
      ORDER BY sort_order, component_name
    `).all(cls.id, sub.subject_id, assessment);
    const scores = {};
    db.prepare(`
      SELECT component_key, score FROM marks
      WHERE learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=?
    `).all(learner.id, cls.id, sub.subject_id, term.id, assessment).forEach((row) => { scores[row.component_key] = row.score; });
    const populated = components.map((c) => ({ key:c.key, name:c.name, max:Number(c.max), score:scores[c.key] != null ? Number(scores[c.key]) : null }));
    const maxTotal = populated.reduce((sum, c) => sum + (Number(c.max) || 0), 0);
    const scoreTotal = populated.reduce((sum, c) => sum + (c.score != null ? Number(c.score) : 0), 0);
    const anyScore = populated.some((c) => c.score != null);
    return { ...sub, components:populated, total:anyScore ? Math.round(scoreTotal * 10)/10 : null, max_total:maxTotal || null, percent:anyScore && maxTotal ? Math.round((scoreTotal / maxTotal) * 1000)/10 : null };
  });
  const classLearners = db.prepare(`
    SELECT id, user_id, name, admission_no, class_name, sex, date_of_birth, portrait_path
    FROM users
    WHERE role='learner' AND status='active' AND class_name=?
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
  `).all(cls.id, term.id, assessment).map(row => ({ ...row, subject_code:publicSubjectCode(row.subject_code) }));
  const componentRows = db.prepare(`
    SELECT DISTINCT component_key AS key, component_key, component_name AS name, component_name, max_score
    FROM assessment_components
    WHERE class_id=? AND assessment_type=?
    ORDER BY sort_order, component_name
  `).all(cls.id, assessment);
  const subjectPercents = subjects.map(s => s.percent).filter(v => v != null);
  const overallPercent = subjectPercents.length ? Math.round((subjectPercents.reduce((a,b)=>a+b,0) / subjectPercents.length) * 10)/10 : null;

  const att = db.prepare(`
    SELECT
      COUNT(DISTINCT ar.id) AS opened,
      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
      SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
    FROM attendance_records ar
    LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
    WHERE ar.class_id=? AND ar.term_id=?
  `).get(learner.id, cls.id, term.id);
  const opened = Number(att?.opened || 0);
  const attendance = {
    opened,
    present:Number(att?.present || 0),
    absent:Number(att?.absent || 0),
    late:Number(att?.late || 0),
    pct:opened ? Math.round((Number(att?.present || 0) / opened) * 100) : 0
  };
  const attendanceRows = db.prepare(`
    SELECT u.id,
      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
      SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent
    FROM users u
    LEFT JOIN attendance_entries ae ON ae.learner_id=u.id
    LEFT JOIN attendance_records ar ON ar.id=ae.record_id AND ar.class_id=? AND ar.term_id=?
    WHERE u.role='learner' AND u.status='active' AND u.class_name=?
    GROUP BY u.id
  `).all(cls.id, term.id, cls.name);
  const attendanceSummary = { opened:opened || null, learners:{} };
  attendanceRows.forEach(row => {
    attendanceSummary.learners[String(row.id)] = opened ? {
      opened,
      present:Number(row.present || 0),
      absent:Number(row.absent || 0)
    } : { opened:null, present:null, absent:null };
  });

  const classRow = db.prepare('SELECT template_name FROM classes WHERE id=?').get(cls.id);
  const state = readTemplateState(classRow?.template_name);
  const sk = (state && state.customizations && state.customizations.skills) || {};
  const affective = (Array.isArray(sk.affective) && sk.affective.length) ? sk.affective : DEFAULT_SKILLS.affective;
  const psychomotor = (Array.isArray(sk.psychomotor) && sk.psychomotor.length) ? sk.psychomotor : DEFAULT_SKILLS.psychomotor;
  const skillRows = db.prepare(`
    SELECT category_key, item_key, rating FROM learner_skills
    WHERE learner_id=? AND term_id=? AND assessment_type=?
  `).all(learner.id, term.id, assessment);
  const skillMap = {};
  skillRows.forEach((row) => {
    if (!skillMap[row.category_key]) skillMap[row.category_key] = {};
    skillMap[row.category_key][row.item_key] = row.rating;
  });
  const allSkillRows = db.prepare(`
    SELECT learner_id, category_key, item_key, rating FROM learner_skills
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
  const skills = [
    { key:'affective', label:'Affective Traits', items:affective.map(label => ({ key:slugifyKey(label), label, rating:skillMap.affective?.[slugifyKey(label)] ?? null })) },
    { key:'psychomotor', label:'Psychomotor Skills', items:psychomotor.map(label => ({ key:slugifyKey(label), label, rating:skillMap.psychomotor?.[slugifyKey(label)] ?? null })) }
  ];

  const roleLabel = { class_teacher:'Class Teacher', headteacher:'Headteacher', director:'Director' };
  const comments = db.prepare(`
    SELECT role, comment_text FROM learner_comments
    WHERE learner_id=? AND term_id=? AND assessment_type=?
    ORDER BY role
  `).all(learner.id, term.id, assessment).map(row => ({ role:row.role, role_label:roleLabel[row.role] || row.role, text:row.comment_text || '' }));

  const school = {};
  db.prepare("SELECT key, value FROM school_settings WHERE key IN ('school_name','school_motto','school_logo','school_address','school_phone','school_email')").all().forEach(row => { school[row.key] = row.value; });

  res.json({
    success:true,
    data:{
      school,
      class:{ id:cls.id, name:cls.name, template_name:classRow?.template_name || null },
      learner,
      term:{ id:term.id, name:term.name, start_date:term.start_date, end_date:term.end_date },
      assessment_type:assessment,
      template:{ name:classRow?.template_name || 'Default Template', state:state || null },
      class_learners:classLearners,
      all_marks:allMarks,
      component_defs:componentRows,
      attendance_summary:attendanceSummary,
      skill_ratings:skillRatings,
      subjects,
      overall_percent:overallPercent,
      attendance,
      skills,
      comments
    }
  });
});
router.put('/profile', (req, res) => {
  const { name, email, phone } = req.body;
  getDB().prepare("UPDATE users SET name=?,email=?,phone=?,updated_at=datetime('now') WHERE id=?").run(name, email||null, phone||null, req.session.user.id);
  res.json({ success:true, message:'Profile updated' });
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
