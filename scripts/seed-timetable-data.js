/*
 * One-shot seed: add 10 teachers, set lessons-per-week, reassign class_subjects.
 *
 * Idempotent — safe to re-run. Teachers are matched by name (won't duplicate).
 * Class_subject reassignment uses subject specialty.
 *
 *   node scripts/seed-timetable-data.js
 */
const { getDB, initDatabase } = require('../database');
initDatabase();
const db = getDB();

/* ── Roster of dummy teachers (Kenyan names, subject specialties) ── */
const NEW_TEACHERS = [
  { name: 'Mary Wanjiru',   subject: 'English' },
  { name: 'Patrick Mutua',  subject: 'Integrated Science' },
  { name: 'Eunice Kiprop',  subject: 'Kiswahili' },
  { name: 'Rose Akinyi',    subject: 'Social Studies' },
  { name: 'James Maina',    subject: 'Mathematical Activities' },
  { name: 'Linda Wambui',   subject: 'English Activities' },
  { name: 'Faith Wairimu',  subject: 'Creative Activities' },
  { name: 'David Omondi',   subject: 'Agriculture and Nutrition' },
  { name: 'Samuel Kibet',   subject: 'Psychomotor and Creative Activities' },
  { name: 'Grace Achieng',  subject: 'Christian Religious Education' },
  { name: 'Sharon Otieno',  subject: 'Language Activities' }
];

/* ── Subject → preferred teacher (lowercase match on subject name) ── */
const SUBJECT_TEACHER = {
  'mathematics':                         'Joseph Kamau',   /* existing KAMAU */
  'mathematical activities':             'James Maina',
  'english':                             'Mary Wanjiru',
  'english activities':                  'Linda Wambui',
  'language activities':                 'Sharon Otieno',
  'reading':                             'Linda Wambui',
  'kusoma':                              'Eunice Kiprop',
  'kiswahili':                           'Eunice Kiprop',
  'integrated science':                  'Patrick Mutua',
  'science and technology':              'Patrick Mutua',
  'environmental activities':            'James Maina',
  'social studies':                      'Rose Akinyi',
  'creative activities':                 'Faith Wairimu',
  'creative arts and sports':            'Faith Wairimu',
  'psychomotor and creative activities': 'Samuel Kibet',
  'christian religious education':       'Grace Achieng',
  'islamic religious education':         'Grace Achieng',
  'religious education activities':      'Grace Achieng',
  'agriculture and nutrition':           'David Omondi',
  'pre-technical studies':               'David Omondi'
};

/* ── Lessons per week per subject (CBC-aligned defaults) ── */
const LESSONS_PER_WEEK = {
  'mathematics':                         6,
  'mathematical activities':             5,
  'english':                             6,
  'english activities':                  5,
  'language activities':                 5,
  'kiswahili':                           4,
  'kusoma':                              3,
  'reading':                             4,
  'integrated science':                  5,
  'science and technology':              4,
  'environmental activities':            4,
  'social studies':                      3,
  'creative activities':                 3,
  'creative arts and sports':            3,
  'psychomotor and creative activities': 3,
  'christian religious education':       2,
  'islamic religious education':         2,
  'religious education activities':      2,
  'agriculture and nutrition':           3,
  'pre-technical studies':               2
};

function nextStaffIdGenerator(db) {
  /* Find the highest existing T### id and continue from there */
  const row = db.prepare(
    "SELECT MAX(CAST(SUBSTR(user_id, 2) AS INTEGER)) AS m FROM users WHERE role='teacher' AND user_id LIKE 'T%'"
  ).get();
  let n = (row?.m || 0) + 1;
  return () => 'T' + String(n++).padStart(3, '0');
}

console.log('▶  Seeding timetable data…\n');

/* ─────────────────────────────────────────────────────────────
   STEP 1 — Rename existing all-caps "KAMAU" to "Joseph Kamau"
   ───────────────────────────────────────────────────────────── */
const kamau = db.prepare("SELECT id, name FROM users WHERE role='teacher' AND UPPER(name)='KAMAU'").get();
if (kamau) {
  db.prepare("UPDATE users SET name='Joseph Kamau', subject='Mathematics', updated_at=datetime('now') WHERE id=?").run(kamau.id);
  console.log('✓  Renamed teacher #' + kamau.id + ' → Joseph Kamau · Mathematics');
} else {
  console.log('⚠  No existing teacher matched KAMAU — skipping rename.');
}

/* ─────────────────────────────────────────────────────────────
   STEP 2 — Insert 10 dummy teachers (idempotent by name)
   ───────────────────────────────────────────────────────────── */
const existingNames = new Set(
  db.prepare("SELECT name FROM users WHERE role='teacher'").all().map(r => r.name.toLowerCase().trim())
);

/* Re-use an existing teacher's password hash so the dummies can log in with the same credentials.
   This keeps the script simple — no bcrypt dependency required. */
const seedPasswordRow = db.prepare("SELECT password FROM users WHERE role='teacher' LIMIT 1").get();
const seedPassword = seedPasswordRow?.password || '$2a$10$X.placeholder.hash.for.testing.only..............';

const nextId = nextStaffIdGenerator(db);
const insertTeacher = db.prepare(`
  INSERT INTO users (user_id, name, subject, password, role, status, is_admin, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'teacher', 'active', 0, datetime('now'), datetime('now'))
`);

let inserted = 0;
db.exec('BEGIN');
try {
  for (const t of NEW_TEACHERS) {
    if (existingNames.has(t.name.toLowerCase().trim())) {
      console.log('•  Skipped (already exists): ' + t.name);
      continue;
    }
    insertTeacher.run(nextId(), t.name, t.subject, seedPassword);
    inserted++;
    console.log('+  Added teacher: ' + t.name + ' · ' + t.subject);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗  Rolled back teacher inserts:', e.message);
  process.exit(1);
}
console.log('\n→  ' + inserted + ' new teachers added.\n');

/* ─────────────────────────────────────────────────────────────
   STEP 3 — Build teacher-name → id lookup
   ───────────────────────────────────────────────────────────── */
const teachersById = new Map();
const teachersByName = new Map();
db.prepare("SELECT id, name FROM users WHERE role='teacher' AND status='active'").all().forEach(t => {
  teachersById.set(t.id, t);
  teachersByName.set(t.name.toLowerCase().trim(), t);
});

/* ─────────────────────────────────────────────────────────────
   STEP 4 — Walk class_subjects: set lessons_per_week + reassign teacher
   ───────────────────────────────────────────────────────────── */
const rows = db.prepare(`
  SELECT cs.id, cs.class_id, cs.subject_id, cs.teacher_id, cs.lessons_per_week,
         c.name AS class_name, s.name AS subject_name
  FROM class_subjects cs
  JOIN classes c ON c.id = cs.class_id
  JOIN subjects s ON s.id = cs.subject_id
  ORDER BY c.id, s.name
`).all();

const update = db.prepare(`
  UPDATE class_subjects
  SET lessons_per_week = ?, teacher_id = ?, updated_at = datetime('now')
  WHERE id = ?
`);

let touched = 0, unmatched = 0, lessonsSet = 0, teachersAssigned = 0;
db.exec('BEGIN');
try {
  for (const r of rows) {
    const key = String(r.subject_name).toLowerCase().trim();
    const lpw = LESSONS_PER_WEEK[key] ?? 3;     /* Sensible fallback for unmapped subjects */
    const preferredTeacherName = SUBJECT_TEACHER[key];
    let teacher = preferredTeacherName ? teachersByName.get(preferredTeacherName.toLowerCase().trim()) : null;
    if (!teacher) {
      /* Fall back to Joseph Kamau (the original teacher) if no specialist matched */
      teacher = teachersByName.get('joseph kamau') || teachersById.get(r.teacher_id);
      if (!preferredTeacherName) unmatched++;
    }
    if (r.lessons_per_week !== lpw)        lessonsSet++;
    if (teacher && teacher.id !== r.teacher_id) teachersAssigned++;
    update.run(lpw, teacher?.id || r.teacher_id, r.id);
    touched++;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('✗  Rolled back class_subjects updates:', e.message);
  process.exit(1);
}

console.log('→  Touched ' + touched + ' class_subjects rows.');
console.log('   • ' + lessonsSet + ' lessons_per_week values set');
console.log('   • ' + teachersAssigned + ' teacher reassignments');
if (unmatched) console.log('   • ' + unmatched + ' subjects had no specialty mapping (fell back to Joseph Kamau)\n');

/* ─────────────────────────────────────────────────────────────
   Final summary
   ───────────────────────────────────────────────────────────── */
console.log('\n=== FINAL STATE ===');
console.log('Teachers per subject specialty:');
console.table(db.prepare(`
  SELECT u.name AS teacher, u.subject, COUNT(cs.id) AS class_subjects, SUM(cs.lessons_per_week) AS lessons_pw
  FROM users u
  LEFT JOIN class_subjects cs ON cs.teacher_id = u.id
  WHERE u.role='teacher' AND u.status='active'
  GROUP BY u.id
  ORDER BY lessons_pw DESC
`).all());

console.log('\nLessons-per-week distribution across all class_subjects:');
console.table(db.prepare(`
  SELECT s.name AS subject,
         COUNT(cs.id) AS classes_teaching,
         AVG(cs.lessons_per_week) AS avg_lpw,
         SUM(cs.lessons_per_week) AS total_lpw
  FROM subjects s
  JOIN class_subjects cs ON cs.subject_id = s.id
  GROUP BY s.id
  ORDER BY total_lpw DESC
`).all());

console.log('\n✔  Seed complete. Open /admin/timetable.html and press Generate.\n');
