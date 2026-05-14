const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'joyland.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db;

function getDB() {
  if (!db) {
    db = new DatabaseSync(DB_PATH);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const db = getDB();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      admission_no TEXT,
      class_name TEXT,
      sex TEXT,
      date_of_birth TEXT,
      address TEXT,
      portrait_path TEXT,
      subject TEXT,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','teacher','learner')),
      is_admin INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      temp_code TEXT,
      temp_code_expiry TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS parent_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password TEXT NOT NULL,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      temp_code TEXT,
      temp_code_expiry TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS parent_learner_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER NOT NULL,
      learner_id INTEGER NOT NULL,
      relationship TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(parent_id, learner_id),
      FOREIGN KEY (parent_id) REFERENCES parent_accounts(id) ON DELETE CASCADE,
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS academic_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS terms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      term_number INTEGER NOT NULL,
      term_name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      weekdays TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday"]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES academic_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      grade_level TEXT,
      class_teacher_id INTEGER,
      capacity INTEGER DEFAULT 40,
      template_name TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (class_teacher_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      code TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS class_subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      teacher_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(class_id, subject_id),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS learner_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      title TEXT,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(class_id, date),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attendance_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id INTEGER NOT NULL,
      learner_id INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('present','absent','late')),
      note TEXT,
      UNIQUE(record_id, learner_id),
      FOREIGN KEY (record_id) REFERENCES attendance_records(id) ON DELETE CASCADE,
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('opener','midterm','endterm')),
      component_key TEXT NOT NULL DEFAULT 'exam',
      score REAL,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(learner_id, subject_id, term_id, assessment_type, component_key),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS assessment_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('opener','midterm','endterm')),
      component_key TEXT NOT NULL,
      component_name TEXT NOT NULL,
      max_score REAL NOT NULL DEFAULT 100,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(class_id, subject_id, assessment_type, component_key),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS school_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS learner_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL DEFAULT 'endterm' CHECK(assessment_type IN ('opener','midterm','endterm')),
      category_key TEXT NOT NULL,
      item_key TEXT NOT NULL,
      rating INTEGER,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(learner_id, term_id, assessment_type, category_key, item_key),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS report_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK(role IN ('class_teacher','headteacher','director')),
      class_id INTEGER,
      min_score INTEGER NOT NULL,
      max_score INTEGER NOT NULL,
      comment_text TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS learner_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      class_id INTEGER,
      term_id INTEGER,
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('opener','midterm','endterm')),
      role TEXT NOT NULL CHECK(role IN ('class_teacher','headteacher','director')),
      comment_text TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(learner_id, term_id, assessment_type, role),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_role TEXT NOT NULL CHECK(user_role IN ('admin','teacher','learner','parent')),
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      platform TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      last_seen TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      audience TEXT NOT NULL,
      target_class_id INTEGER,
      created_by_role TEXT,
      created_by_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (target_class_id) REFERENCES classes(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS notification_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL,
      user_role TEXT NOT NULL CHECK(user_role IN ('admin','teacher','learner','parent')),
      user_id INTEGER NOT NULL,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(notification_id, user_role, user_id),
      FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
    );
  `);

  migrateMarksAndSkills(db);

  // Teacher marks are scoped by learner + class + subject + term + assessment + component.
  // Keep the table's older unique key for existing admin upserts, and add the stricter key
  // required by the teacher mobile marks endpoint.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_marks_unique_teacher_scope
    ON marks (learner_id, class_id, subject_id, term_id, assessment_type, component_key)
  `);

  seedDefaultAssessmentComponents(db);
  seedDefaultReportComments(db);

  // Idempotent migration: add classes.template_name to legacy databases
  try {
    const cols = db.prepare("PRAGMA table_info(classes)").all();
    if (!cols.find(c => c.name === 'template_name')) {
      db.exec("ALTER TABLE classes ADD COLUMN template_name TEXT");
      console.log('[OK] Added classes.template_name column');
    }
  } catch (e) {
    console.error('classes.template_name migration failed:', e.message);
  }

  const schoolUploadDir = path.join(__dirname, 'public', 'uploads', 'school');
  fs.mkdirSync(schoolUploadDir, { recursive: true });
  const bundledLogo = path.join(schoolUploadDir, 'logo.jpg');
  const userLogo = path.join('C:\\Users\\BYU\\Desktop', 'download.jpg');
  if (!fs.existsSync(bundledLogo) && fs.existsSync(userLogo)) {
    try { fs.copyFileSync(userLogo, bundledLogo); } catch {}
  }

  const defaultSchoolSettings = {
    school_name: 'JOYLAND SCHOOLS',
    school_motto: 'Education Is Treasure',
    school_address: 'P.O. Box 123',
    school_phone: '0700 000 000',
    school_email: 'info@joylandschools.ac.ke',
    school_logo: '/uploads/school/logo.jpg',
    result_title: 'END OF TERM REPORT CARD',
    footer_text: '',
    theme_color: '#d4147a',
    performance_target_average: '75'
  };
  const insertSetting = db.prepare("INSERT OR IGNORE INTO school_settings (key, value) VALUES (?, ?)");
  Object.entries(defaultSchoolSettings).forEach(([key, value]) => insertSetting.run(key, value));

  [
    "ALTER TABLE users ADD COLUMN sex TEXT",
    "ALTER TABLE users ADD COLUMN date_of_birth TEXT",
    "ALTER TABLE users ADD COLUMN address TEXT",
    "ALTER TABLE users ADD COLUMN portrait_path TEXT"
  ].forEach((sql) => {
    try { db.exec(sql); } catch (e) {
      if (!String(e.message).includes('duplicate column name')) throw e;
    }
  });

  db.prepare(`
    INSERT OR IGNORE INTO classes (name, grade_level, capacity)
    SELECT DISTINCT TRIM(class_name), TRIM(class_name), 40
    FROM users
    WHERE role='learner' AND class_name IS NOT NULL AND TRIM(class_name) != ''
  `).run();

  const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' AND is_admin=1 LIMIT 1").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`INSERT INTO users (user_id,name,email,password,role,is_admin,status)
                VALUES (?,?,?,?,'admin',1,'active')`)
      .run('ADM001', 'Super Admin', 'admin@joylandschools.ac.ke', hash);
    console.log('[OK] Default admin created: ADM001 / admin123');
  }

  const sessionExists = db.prepare('SELECT id FROM academic_sessions LIMIT 1').get();
  if (!sessionExists) {
    const sid = db.prepare('INSERT INTO academic_sessions (year,name,is_active) VALUES (?,?,1)')
      .run('2026', '2026 Academic Year').lastInsertRowid;
    db.prepare("INSERT INTO terms (session_id,term_number,term_name,start_date,end_date) VALUES (?,1,'Term 1','2026-01-06','2026-04-04')").run(sid);
    db.prepare("INSERT INTO terms (session_id,term_number,term_name,start_date,end_date) VALUES (?,2,'Term 2','2026-05-04','2026-07-31')").run(sid);
    db.prepare("INSERT INTO terms (session_id,term_number,term_name,start_date,end_date) VALUES (?,3,'Term 3','2026-09-07','2026-11-06')").run(sid);
  }

  return db;
}

function tableHasColumn(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function migrateMarksAndSkills(db) {
  const needsMarks = tableHasColumn(db, 'marks', 'exam_type') && !tableHasColumn(db, 'marks', 'assessment_type');
  const needsSkills = tableHasColumn(db, 'learner_skills', 'category_key') && !tableHasColumn(db, 'learner_skills', 'assessment_type');
  if (!needsMarks && !needsSkills) return;
  db.exec('PRAGMA foreign_keys = OFF');
  // Migrate marks: rename exam_type -> assessment_type, add component_key, change unique key
  if (needsMarks) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE marks_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          learner_id INTEGER NOT NULL,
          class_id INTEGER NOT NULL,
          subject_id INTEGER NOT NULL,
          term_id INTEGER NOT NULL,
          assessment_type TEXT NOT NULL CHECK(assessment_type IN ('opener','midterm','endterm')),
          component_key TEXT NOT NULL DEFAULT 'exam',
          score REAL,
          created_by INTEGER,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(learner_id, subject_id, term_id, assessment_type, component_key),
          FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
          FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE CASCADE,
          FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
        );
        INSERT INTO marks_new (id, learner_id, class_id, subject_id, term_id, assessment_type, component_key, score, created_by, created_at, updated_at)
        SELECT id, learner_id, class_id, subject_id, term_id, exam_type, 'exam', score, created_by, created_at, updated_at FROM marks;
        DROP TABLE marks;
        ALTER TABLE marks_new RENAME TO marks;
      `);
      db.exec('COMMIT');
      console.log('[OK] Migrated marks table to assessment_type + component_key');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Migrate learner_skills: add assessment_type column if missing
  if (needsSkills) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`
        CREATE TABLE learner_skills_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          learner_id INTEGER NOT NULL,
          class_id INTEGER NOT NULL,
          term_id INTEGER NOT NULL,
          assessment_type TEXT NOT NULL DEFAULT 'endterm' CHECK(assessment_type IN ('opener','midterm','endterm')),
          category_key TEXT NOT NULL,
          item_key TEXT NOT NULL,
          rating INTEGER,
          created_by INTEGER,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          UNIQUE(learner_id, term_id, assessment_type, category_key, item_key),
          FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
          FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
        );
        INSERT INTO learner_skills_new (id, learner_id, class_id, term_id, assessment_type, category_key, item_key, rating, created_by, created_at, updated_at)
        SELECT id, learner_id, class_id, term_id, 'endterm', category_key, item_key, rating, created_by, created_at, updated_at FROM learner_skills;
        DROP TABLE learner_skills;
        ALTER TABLE learner_skills_new RENAME TO learner_skills;
      `);
      db.exec('COMMIT');
      console.log('[OK] Migrated learner_skills table to include assessment_type');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');
}

function seedDefaultReportComments(db) {
  // Seed a CBC-aligned default comment bank on first run so the page is not empty.
  // class_id is NULL for global defaults; per-class entries can override later.
  const existing = db.prepare('SELECT COUNT(*) c FROM report_comments').get().c;
  if (existing) return;
  const insert = db.prepare(`
    INSERT INTO report_comments (role, class_id, min_score, max_score, comment_text, sort_order)
    VALUES (?, NULL, ?, ?, ?, ?)
  `);
  const bands = [
    { min: 80, max: 100, order: 1 },
    { min: 60, max:  79, order: 2 },
    { min: 40, max:  59, order: 3 },
    { min:  0, max:  39, order: 4 }
  ];
  const defaults = {
    class_teacher: {
      80: 'Excellent performance. Keep up the great work.',
      60: 'Good work. Continue striving for the top.',
      40: 'Fair effort. More practice will improve results.',
      0:  'Needs improvement. Please put in more effort.'
    },
    headteacher: {
      80: 'A commendable performance. We are proud of you.',
      60: 'Encouraging progress. Keep pushing yourself.',
      40: 'Satisfactory. Focus on weak areas with your teacher.',
      0:  'You can do better. Seek help and study harder.'
    },
    director: {
      80: 'Outstanding! Continue setting a great example.',
      60: 'Well done. Maintain the good work ethic.',
      40: 'You have potential. Aim higher next term.',
      0:  'A serious change of approach is needed.'
    }
  };
  ['class_teacher','headteacher','director'].forEach(role => {
    bands.forEach(b => insert.run(role, b.min, b.max, defaults[role][b.min], b.order));
  });
  console.log('[OK] Seeded default report comments');
}

function seedDefaultAssessmentComponents(db) {
  // Seed a default 'exam' component (max 100) for every (class, subject) across all 3 assessment types
  // so existing class-subject pairs aren't empty when admin opens the Assessments page.
  const pairs = db.prepare('SELECT class_id, subject_id FROM class_subjects').all();
  if (!pairs.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO assessment_components
      (class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order)
    VALUES (?, ?, ?, 'exam', 'Exam', 100, 0)
  `);
  ['opener', 'midterm', 'endterm'].forEach((at) => {
    pairs.forEach((p) => insert.run(p.class_id, p.subject_id, at));
  });
}

function calculateSchoolDays(startDate, endDate, weekdays, holidays = []) {
  const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const selectedNums = new Set(weekdays.map((day) => dayMap[day]));
  const holidayDates = new Set();

  holidays.forEach((holiday) => {
    const holidayStart = new Date(`${holiday.start_date}T00:00:00`);
    const holidayEnd = new Date(`${holiday.end_date}T00:00:00`);
    const current = new Date(holidayStart);
    while (current <= holidayEnd) {
      holidayDates.add(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }
  });

  let count = 0;
  const current = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  while (current <= end) {
    if (selectedNums.has(current.getDay()) && !holidayDates.has(current.toISOString().split('T')[0])) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

module.exports = { getDB, initDatabase, calculateSchoolDays };

