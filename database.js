const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'joyland.db');

const KENYA_SCHOOL_CALENDAR_2026 = {
  year: '2026',
  sessionName: '2026 Academic Year',
  terms: [
    {
      term_number: 1,
      term_name: 'Term 1',
      start_date: '2026-01-06',
      end_date: '2026-04-02',
      holidays: [
        { name: 'Term 1 Half-Term', start_date: '2026-02-25', end_date: '2026-03-01' }
      ]
    },
    {
      term_number: 2,
      term_name: 'Term 2',
      start_date: '2026-04-27',
      end_date: '2026-07-31',
      holidays: [
        { name: 'Term 2 Half-Term', start_date: '2026-06-24', end_date: '2026-06-28' }
      ]
    },
    {
      term_number: 3,
      term_name: 'Term 3',
      start_date: '2026-08-24',
      end_date: '2026-10-23',
      holidays: []
    }
  ],
  breaks: [
    { title: 'April Holiday', date: '2026-04-07', end_date: '2026-04-24', description: 'Kenya school calendar break', type: 'hol' },
    { title: 'August Holiday', date: '2026-08-03', end_date: '2026-08-21', description: 'Kenya school calendar break', type: 'hol' },
    { title: 'Long Holiday', date: '2026-10-26', end_date: '2027-01-01', description: 'Kenya school calendar break', type: 'hol' }
  ]
};

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
      active_periods TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (class_teacher_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      code TEXT,
      level TEXT,
      description TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','inactive')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS class_subjects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id INTEGER NOT NULL,
      subject_id INTEGER NOT NULL,
      teacher_id INTEGER,
      lessons_per_week INTEGER DEFAULT 0,
      double_periods INTEGER DEFAULT 0,
      locked_slots TEXT,
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
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('midterm','endterm')),
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
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('midterm','endterm')),
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

    CREATE TABLE IF NOT EXISTS resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK(type IN ('notes','past_paper','scheme','other')),
      title TEXT NOT NULL,
      grade TEXT,
      subject TEXT,
      year INTEGER,
      body_html TEXT,
      file_path TEXT,
      published INTEGER DEFAULT 1,
      views INTEGER DEFAULT 0,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type, grade, subject);

    CREATE TABLE IF NOT EXISTS learner_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      assessment_type TEXT NOT NULL DEFAULT 'endterm' CHECK(assessment_type IN ('midterm','endterm')),
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
      assessment_type TEXT NOT NULL CHECK(assessment_type IN ('midterm','endterm')),
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

    CREATE TABLE IF NOT EXISTS game_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      game_key TEXT NOT NULL,
      score INTEGER NOT NULL,
      played_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_game_scores_learner_game ON game_scores(learner_id, game_key, score);

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

    CREATE TABLE IF NOT EXISTS notification_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      notification_id INTEGER NOT NULL,
      recipient_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','read')),
      delivered_at TEXT,
      read_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(notification_id, recipient_id, channel),
      FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS school_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      end_date TEXT,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL CHECK(type IN ('assess','event','meet','term','hol')),
      class_id INTEGER,
      term_id INTEGER,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_school_events_date ON school_events(date);
    CREATE INDEX IF NOT EXISTS idx_school_events_class_date ON school_events(class_id, date);

    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      description TEXT,
      level TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS skill_ratings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL,
      skill_id INTEGER NOT NULL,
      term_id INTEGER NOT NULL,
      rating INTEGER CHECK(rating BETWEEN 1 AND 4),
      rated_by INTEGER,
      rated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(learner_id, skill_id, term_id),
      FOREIGN KEY (learner_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE,
      FOREIGN KEY (rated_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS school_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (term_id) REFERENCES terms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bell_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'Default schedule',
      is_default INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bell_periods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule_id INTEGER REFERENCES bell_schedules(id) ON DELETE CASCADE,
      period_no INTEGER NOT NULL,
      label TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      type TEXT CHECK(type IN ('lesson','break','lunch','assembly','other')) DEFAULT 'lesson',
      active_days TEXT DEFAULT '["mon","tue","wed","thu","fri"]',
      UNIQUE(schedule_id, period_no)
    );

    CREATE TABLE IF NOT EXISTS teacher_constraints (
      teacher_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_per_day INTEGER DEFAULT 6,
      max_per_week INTEGER DEFAULT 30,
      preferred_off_day TEXT,
      unavailable_slots TEXT,
      min_gap_minutes INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS timetable_generations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER REFERENCES terms(id),
      schedule_id INTEGER REFERENCES bell_schedules(id),
      status TEXT CHECK(status IN ('draft','active','archived')) DEFAULT 'draft',
      score INTEGER DEFAULT 0,
      placed INTEGER DEFAULT 0,
      total INTEGER DEFAULT 0,
      conflicts INTEGER DEFAULT 0,
      conflicts_json TEXT,
      soft_rules_json TEXT,
      generated_by INTEGER REFERENCES users(id),
      generated_at TEXT DEFAULT (datetime('now')),
      published_at TEXT,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS timetable_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      generation_id INTEGER REFERENCES timetable_generations(id) ON DELETE CASCADE,
      class_id INTEGER REFERENCES classes(id),
      day_of_week INTEGER CHECK(day_of_week BETWEEN 1 AND 7),
      period_no INTEGER NOT NULL,
      subject_id INTEGER REFERENCES subjects(id),
      teacher_id INTEGER REFERENCES users(id),
      locked INTEGER DEFAULT 0,
      UNIQUE(generation_id, class_id, day_of_week, period_no)
    );

    CREATE TABLE IF NOT EXISTS teacher_absences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date_from TEXT NOT NULL,
      date_to TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'other',
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_teacher_absences_dates ON teacher_absences(date_from, date_to);

    CREATE TABLE IF NOT EXISTS substitution_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_id INTEGER NOT NULL REFERENCES timetable_slots(id) ON DELETE CASCADE,
      absence_id INTEGER REFERENCES teacher_absences(id) ON DELETE SET NULL,
      date TEXT NOT NULL,
      original_teacher_id INTEGER REFERENCES users(id),
      substitute_teacher_id INTEGER REFERENCES users(id),
      notified_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(slot_id, date)
    );

    CREATE TABLE IF NOT EXISTS lesson_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      subject_id INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 1 AND 7),
      period_no INTEGER NOT NULL,
      date TEXT NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','declined','cancelled')),
      decided_by INTEGER REFERENCES users(id),
      decided_at TEXT,
      decision_note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_lesson_bookings_status ON lesson_bookings(status);
    CREATE INDEX IF NOT EXISTS idx_lesson_bookings_date ON lesson_bookings(date);

    CREATE TABLE IF NOT EXISTS timetable_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      cycle_weeks INTEGER DEFAULT 1,
      working_days TEXT DEFAULT 'mon,tue,wed,thu,fri',
      visible_to_teachers INTEGER DEFAULT 1,
      visible_to_parents INTEGER DEFAULT 1,
      soft_rules_json TEXT
    );

    INSERT OR IGNORE INTO timetable_settings (id) VALUES (1);
    INSERT OR IGNORE INTO bell_schedules (id, name, is_default) VALUES (1, 'Default schedule', 1);
  `);

  migrateMarksAndSkills(db);
  migrateAdminV2(db);
  seedDefaultBellSchedule(db);

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
    performance_target_average: '75',
    band_thresholds_json: '{"EE":75,"ME":60,"AE":50,"BE":0}',
    show_band_in_marks: '1',
    teacher_publish_marks: '0',
    auto_save_marks: '1',
    sms_on_absence: '1',
    sms_sender_id: 'JOYLAND',
    default_channels_json: '["in-app","sms"]',
    password_min_length: '8',
    require_2fa: '0',
    session_timeout_min: '120'
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
    KENYA_SCHOOL_CALENDAR_2026.terms.forEach((term) => {
      db.prepare("INSERT INTO terms (session_id,term_number,term_name,start_date,end_date) VALUES (?,?,?,?,?)")
        .run(sid, term.term_number, term.term_name, term.start_date, term.end_date);
    });
  }

  seedCoreSkills(db);
  seedSchoolEvents(db);
  seedKenyaSchoolCalendar2026(db);

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
          assessment_type TEXT NOT NULL CHECK(assessment_type IN ('midterm','endterm')),
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
          assessment_type TEXT NOT NULL DEFAULT 'endterm' CHECK(assessment_type IN ('midterm','endterm')),
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

function addColumnIfMissing(db, table, column, definition) {
  try {
    if (!tableHasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!String(e.message).includes('duplicate column name')) throw e;
  }
}

function migrateAdminV2(db) {
  addColumnIfMissing(db, 'subjects', 'level', 'TEXT');
  addColumnIfMissing(db, 'subjects', 'description', 'TEXT');
  addColumnIfMissing(db, 'class_subjects', 'lessons_per_week', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'class_subjects', 'double_periods', 'INTEGER DEFAULT 0');
  addColumnIfMissing(db, 'class_subjects', 'locked_slots', 'TEXT');
  addColumnIfMissing(db, 'bell_periods', 'active_days', 'TEXT DEFAULT \'["mon","tue","wed","thu","fri"]\'');
  addColumnIfMissing(db, 'classes', 'active_periods', 'TEXT');

  addColumnIfMissing(db, 'notifications', 'role_scope', 'TEXT');
  addColumnIfMissing(db, 'notifications', 'type', "TEXT DEFAULT 'broadcast'");
  addColumnIfMissing(db, 'notifications', 'sent_by', 'INTEGER');
  addColumnIfMissing(db, 'notifications', 'sent_at', 'TEXT');
  addColumnIfMissing(db, 'notifications', 'delivered_at', 'TEXT');
  addColumnIfMissing(db, 'notifications', 'read_at', 'TEXT');
  addColumnIfMissing(db, 'notifications', 'channels', 'TEXT');

  db.prepare(`
    UPDATE notifications
    SET role_scope=COALESCE(role_scope, created_by_role, 'admin'),
        type=COALESCE(type, 'broadcast'),
        sent_by=COALESCE(sent_by, created_by_id),
        sent_at=COALESCE(sent_at, created_at),
        channels=COALESCE(channels, '["in-app"]')
  `).run();
}

function seedDefaultBellSchedule(db) {
  try {
    db.prepare(`
      UPDATE bell_periods
      SET active_days='["mon","fri"]'
      WHERE schedule_id=1
        AND period_no=1
        AND type='assembly'
        AND (active_days IS NULL OR active_days='["mon","tue","wed","thu","fri"]')
    `).run();
  } catch {}

  const existing = db.prepare('SELECT COUNT(*) c FROM bell_periods').get().c;
  if (existing) return;
  const defaultPeriods = [
    [1, 'Morning assembly', '07:30', '08:00', 'assembly', '["mon","fri"]'],
    [2, 'Period 1', '08:00', '08:40', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [3, 'Period 2', '08:40', '09:20', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [4, 'Short break', '09:20', '09:35', 'break', '["mon","tue","wed","thu","fri"]'],
    [5, 'Period 3', '09:35', '10:15', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [6, 'Period 4', '10:15', '10:55', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [7, 'Long break', '10:55', '11:30', 'break', '["mon","tue","wed","thu","fri"]'],
    [8, 'Period 5', '11:30', '12:10', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [9, 'Period 6', '12:10', '12:50', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [10, 'Lunch', '12:50', '13:50', 'lunch', '["mon","tue","wed","thu","fri"]'],
    [11, 'Period 7', '13:50', '14:30', 'lesson', '["mon","tue","wed","thu","fri"]'],
    [12, 'Period 8', '14:30', '15:10', 'lesson', '["mon","tue","wed","thu","fri"]']
  ];
  const ins = db.prepare(`
    INSERT INTO bell_periods (schedule_id, period_no, label, start_time, end_time, type, active_days)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `);
  try {
    db.exec('BEGIN IMMEDIATE');
    defaultPeriods.forEach(p => ins.run(...p));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seedCoreSkills(db) {
  const existing = db.prepare('SELECT COUNT(*) c FROM skills').get().c;
  if (existing) return;
  const rows = [
    ['Communication & Collaboration', 'Works well in groups and expresses ideas clearly'],
    ['Critical Thinking & Problem Solving', 'Analyzes problems and finds practical solutions'],
    ['Creativity & Imagination', 'Brings original ideas and explores alternatives'],
    ['Citizenship', 'Respects rules, community, and shared responsibility'],
    ['Digital Literacy', 'Uses ICT tools appropriately and safely'],
    ['Learning to Learn', 'Reflects on learning and improves independently'],
    ['Self-Efficacy', 'Shows confidence, initiative, and persistence']
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO skills (name, description, level, sort_order) VALUES (?, ?, ?, ?)');
  rows.forEach((row, i) => insert.run(row[0], row[1], 'CBC Core', i + 1));
}

function seedSchoolEvents(db) {
  const existing = db.prepare('SELECT COUNT(*) c FROM school_events').get().c;
  if (existing) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO school_events (date, end_date, title, description, type, term_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  db.prepare('SELECT id, term_name, start_date, end_date FROM terms ORDER BY start_date').all().forEach((term) => {
    insert.run(term.start_date, term.start_date, `${term.term_name} begins`, '', 'term', term.id);
    insert.run(term.end_date, term.end_date, `${term.term_name} ends`, '', 'term', term.id);
  });
  const years = db.prepare(`
    SELECT DISTINCT substr(start_date, 1, 4) AS year FROM terms
    UNION
    SELECT DISTINCT substr(end_date, 1, 4) AS year FROM terms
  `).all().map(r => r.year).filter(Boolean);
  const holidays = [
    ['01-01', 'New Year', 'hol'],
    ['05-01', 'Labour Day', 'hol'],
    ['06-01', 'Madaraka Day', 'hol'],
    ['10-10', 'Huduma Day', 'hol'],
    ['10-20', 'Mashujaa Day', 'hol'],
    ['12-12', 'Jamhuri Day', 'hol'],
    ['12-25', 'Christmas Day', 'hol'],
    ['12-26', 'Boxing Day', 'hol']
  ];
  years.forEach(year => holidays.forEach(([md, title, type]) => {
    const date = `${year}-${md}`;
    insert.run(date, date, title, 'Kenyan public holiday', type, null);
  }));
}

function upsertSchoolEvent(db, event) {
  const existing = db.prepare(`
    SELECT id FROM school_events
    WHERE date=? AND title=? AND type=?
    LIMIT 1
  `).get(event.date, event.title, event.type);
  if (existing) {
    db.prepare(`
      UPDATE school_events
      SET end_date=?, description=?, term_id=?
      WHERE id=?
    `).run(event.end_date || event.date, event.description || '', event.term_id || null, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO school_events (date, end_date, title, description, type, term_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    event.date,
    event.end_date || event.date,
    event.title,
    event.description || '',
    event.type,
    event.term_id || null
  ).lastInsertRowid;
}

function seedKenyaSchoolCalendar2026(db) {
  const cfg = KENYA_SCHOOL_CALENDAR_2026;
  let session = db.prepare("SELECT id FROM academic_sessions WHERE year=? OR name=? LIMIT 1")
    .get(cfg.year, cfg.sessionName);
  if (!session) {
    const hasAnySession = db.prepare('SELECT id FROM academic_sessions LIMIT 1').get();
    session = {
      id: db.prepare('INSERT INTO academic_sessions (year,name,is_active) VALUES (?,?,?)')
        .run(cfg.year, cfg.sessionName, hasAnySession ? 0 : 1).lastInsertRowid
    };
  } else {
    db.prepare('UPDATE academic_sessions SET year=?, name=? WHERE id=?')
      .run(cfg.year, cfg.sessionName, session.id);
  }

  const managedEventTitles = [
    'Term 1 begins',
    'Term 1 ends',
    'Term 2 begins',
    'Term 2 ends',
    'Term 3 begins',
    'Term 3 ends',
    'Term 1 Half-Term',
    'Term 2 Half-Term',
    'April Holiday',
    'August Holiday',
    'Long Holiday'
  ];
  const placeholders = managedEventTitles.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM school_events
    WHERE title IN (${placeholders})
      AND date BETWEEN '2026-01-01' AND '2027-01-01'
  `).run(...managedEventTitles);

  const defaultWeekdays = JSON.stringify(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']);
  const selectTerm = db.prepare('SELECT id FROM terms WHERE session_id=? AND term_number=? LIMIT 1');
  const insertTerm = db.prepare(`
    INSERT INTO terms (session_id, term_number, term_name, start_date, end_date, weekdays)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateTerm = db.prepare(`
    UPDATE terms
    SET term_name=?, start_date=?, end_date=?, weekdays=COALESCE(NULLIF(weekdays, ''), ?)
    WHERE id=?
  `);
  const deleteManagedHoliday = db.prepare(`
    DELETE FROM holidays
    WHERE term_id=? AND name IN ('Term 1 Half-Term', 'Term 2 Half-Term')
  `);
  const insertHoliday = db.prepare(`
    INSERT INTO holidays (term_id, name, start_date, end_date)
    VALUES (?, ?, ?, ?)
  `);

  cfg.terms.forEach((term) => {
    let row = selectTerm.get(session.id, term.term_number);
    if (!row) {
      row = { id: insertTerm.run(
        session.id,
        term.term_number,
        term.term_name,
        term.start_date,
        term.end_date,
        defaultWeekdays
      ).lastInsertRowid };
    } else {
      updateTerm.run(term.term_name, term.start_date, term.end_date, defaultWeekdays, row.id);
    }

    deleteManagedHoliday.run(row.id);
    term.holidays.forEach((holiday) => {
      insertHoliday.run(row.id, holiday.name, holiday.start_date, holiday.end_date);
      upsertSchoolEvent(db, {
        date: holiday.start_date,
        end_date: holiday.end_date,
        title: holiday.name,
        description: 'Kenya school calendar break',
        type: 'hol',
        term_id: row.id
      });
    });

    upsertSchoolEvent(db, {
      date: term.start_date,
      end_date: term.start_date,
      title: `${term.term_name} begins`,
      description: '',
      type: 'term',
      term_id: row.id
    });
    upsertSchoolEvent(db, {
      date: term.end_date,
      end_date: term.end_date,
      title: `${term.term_name} ends`,
      description: '',
      type: 'term',
      term_id: row.id
    });
  });

  cfg.breaks.forEach((event) => upsertSchoolEvent(db, event));
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
  // Seed a default 'exam' component (max 100) for every (class, subject) across Joyland's assessment types
  // so existing class-subject pairs aren't empty when admin opens the Assessments page.
  const pairs = db.prepare('SELECT class_id, subject_id FROM class_subjects').all();
  if (!pairs.length) return;
  const insert = db.prepare(`
    INSERT OR IGNORE INTO assessment_components
      (class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order)
    VALUES (?, ?, ?, 'exam', 'Exam', 100, 0)
  `);
  ['midterm', 'endterm'].forEach((at) => {
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

