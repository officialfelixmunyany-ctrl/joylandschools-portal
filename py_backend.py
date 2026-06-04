#!/usr/bin/env python3
"""Daraja Python backend.

This keeps the existing phone frontend in public/app and serves the same
mobile-facing API contracts from Python against data/joyland.db. The public
learning resource portal uses its own data/resource_database.db.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import smtplib
import sqlite3
import sys
import time
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
APP_DIR = PUBLIC_DIR / "app"
# Learning resource library (portal surface) lives in its own portal folder,
# kept separate from the lightweight app in APP_DIR.
PORTAL_RES_DIR = PUBLIC_DIR / "portal" / "resources"
DB_PATH = ROOT / "data" / "joyland.db"
RESOURCE_DB_PATH = ROOT / "data" / "resource_database.db"
RESOURCE_PORTAL_TABLES = (
    "resources",
    "resource_categories",
    "resource_tags",
    "resource_tag_links",
    "resource_downloads",
    "resource_reviews",
    "resource_submissions",
)
SESSION_COOKIE = "joyland.sid"
TENANT_COOKIE = "civicom.school"
PLATFORM_COOKIE = "civicom.platform"
RESOURCE_ADMIN_COOKIE = "civicom.resource_admin"
SESSION_TTL = 8 * 60 * 60
APP_ENV = (os.environ.get("APP_ENV") or os.environ.get("NODE_ENV") or "").lower()
IS_PRODUCTION = APP_ENV in ("production", "prod")
SECRET_SOURCE = os.environ.get("SESSION_SECRET") or os.environ.get("DARAJA_SESSION_SECRET")
if IS_PRODUCTION and not SECRET_SOURCE:
    raise RuntimeError("SESSION_SECRET or DARAJA_SESSION_SECRET is required when APP_ENV/NODE_ENV is production.")
SECRET = SECRET_SOURCE or secrets.token_urlsafe(48)
SESSIONS: dict[str, dict] = {}
LOGIN_ATTEMPTS: dict[str, list[float]] = {}
REGISTRATION_ATTEMPTS: dict[str, list[float]] = {}
LOGIN_WINDOW = 15 * 60
LOGIN_LIMIT = 8
REGISTRATION_LIMIT = 5
CONN_SCHOOL: dict[int, int] = {}
SUPPORT_EMAIL = os.environ.get("SUPPORT_EMAIL", "schools@civicom.org")
RESOURCE_ADMIN_USERNAME = os.environ.get("RESOURCE_ADMIN_USERNAME", "admin")
RESOURCE_ADMIN_PASSWORD = os.environ.get("RESOURCE_ADMIN_PASSWORD", "")
if IS_PRODUCTION and not RESOURCE_ADMIN_PASSWORD:
    raise RuntimeError("RESOURCE_ADMIN_PASSWORD is required when APP_ENV/NODE_ENV is production.")

try:
    import bcrypt  # type: ignore
except ImportError:  # pragma: no cover - environment setup issue
    bcrypt = None


def now_kenya_date() -> str:
    return datetime.now(timezone(timedelta(hours=3))).date().isoformat()


def db(school_id: int | None = None) -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_phase2_tables(conn)
    CONN_SCHOOL[id(conn)] = int(school_id or 1)
    return conn


def resource_db() -> sqlite3.Connection:
    RESOURCE_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(RESOURCE_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    ensure_resource_portal_tables(conn, seed=False)
    migrate_resource_tables_from_legacy_db(conn)
    ensure_resource_portal_tables(conn)
    return conn


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def one(cur) -> dict | None:
    row = cur.fetchone()
    return dict(row) if row else None


def scalar(conn: sqlite3.Connection, sql: str, args=(), default=0):
    row = conn.execute(sql, args).fetchone()
    return row[0] if row else default


def clean(value) -> str:
    return str(value or "").strip()


def query_first(query: dict, *names, default=None):
    for name in names:
        value = query.get(name)
        if isinstance(value, list) and value:
            return value[0]
        if value not in (None, ""):
            return value
    return default


def body_first(body: dict, *names, default=None):
    for name in names:
        value = body.get(name)
        if value not in (None, ""):
            return value
    return default


def as_int(value, default=None):
    try:
        if value in (None, ""):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def gen_temp_code() -> str:
    return secrets.token_hex(3).upper()


def gen_login_id(conn: sqlite3.Connection, prefix: str, table: str = "users", column: str = "user_id") -> str:
    school_id = current_school_id_from_conn(conn)
    if table_columns(conn, table) and "school_id" in table_columns(conn, table):
        rows_ = rows(conn.execute(f"SELECT {column} AS code FROM {table} WHERE school_id=? AND {column} LIKE ? ORDER BY {column}", (school_id, f"{prefix}%")))
    else:
        rows_ = rows(conn.execute(f"SELECT {column} AS code FROM {table} WHERE {column} LIKE ? ORDER BY {column}", (f"{prefix}%",)))
    nums = []
    for r in rows_:
        m = re.search(r"(\d+)$", clean(r.get("code")))
        if m:
            nums.append(int(m.group(1)))
    return f"{prefix}{(max(nums) if nums else 0) + 1:03d}"


def safe_template_name(value) -> str:
    text = re.sub(r"[^A-Za-z0-9 ._-]+", "_", clean(value))[:80].strip(" ._-")
    return text or "Default Template"


def template_file_path(name) -> Path:
    template_dir = ROOT / "data" / "templates"
    path = (template_dir / f"{safe_template_name(name)}.json").resolve()
    if not str(path).startswith(str(template_dir.resolve())):
        raise ValueError("Invalid template name")
    return path


def tenant_template_file_path(school_slug: str, name) -> Path:
    template_dir = ROOT / "data" / "templates" / slugify_school(school_slug)
    path = (template_dir / f"{safe_template_name(name)}.json").resolve()
    if not str(path).startswith(str(template_dir.resolve())):
        raise ValueError("Invalid template name")
    return path


def public_asset_name(asset_type: str, mime: str) -> str:
    safe_type = re.sub(r"[^a-z0-9_-]+", "", clean(asset_type).lower()) or "asset"
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime)
    if not ext:
        raise ValueError("Only PNG, JPEG, and WebP images are supported.")
    return f"{safe_type}.{ext}"


def safe_upload_filename(value: str, fallback: str = "resource") -> str:
    name = Path(clean(value)).name
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip(".-")
    return name[:120] or fallback


def data_url_bytes(value: str) -> tuple[str, bytes]:
    image_data = clean(value)
    if "," not in image_data:
        raise ValueError("Invalid file upload.")
    header, encoded = image_data.split(",", 1)
    match = re.match(r"^data:([a-zA-Z0-9.+/-]+);base64$", header)
    if not match:
        raise ValueError("Invalid file upload.")
    return match.group(1).lower(), base64.b64decode(encoded, validate=True)


ALLOWED_RESOURCE_MIME_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "text/csv",
    "image/jpeg",
    "image/png",
    "image/webp",
}


def tenant_upload_dir(slug: str, *parts: str) -> Path:
    base = (PUBLIC_DIR / "uploads" / slugify_school(slug)).resolve()
    path = base.joinpath(*[re.sub(r"[^A-Za-z0-9_.-]+", "_", clean(p)) for p in parts if clean(p)]).resolve()
    if not str(path).startswith(str(base)):
        raise ValueError("Invalid upload path")
    path.mkdir(parents=True, exist_ok=True)
    return path


def global_upload_dir(*parts: str) -> Path:
    base = (PUBLIC_DIR / "uploads" / "resources").resolve()
    path = base.joinpath(*[re.sub(r"[^A-Za-z0-9_.-]+", "_", clean(p)) for p in parts if clean(p)]).resolve()
    if not str(path).startswith(str(base)):
        raise ValueError("Invalid upload path")
    path.mkdir(parents=True, exist_ok=True)
    return path


def json_default(obj):
    if isinstance(obj, sqlite3.Row):
      return dict(obj)
    return str(obj)


DEFAULT_ROLE_PERMISSIONS = {
    "admin": [
        "people_read", "people_write", "marks_read", "marks_write", "marks_publish",
        "reports_read", "attendance_write", "notifications_send", "timetable_write",
        "settings_write", "permissions_write",
    ],
    "teacher": ["marks_read", "marks_write", "attendance_write", "reports_read", "timetable_read"],
    "learner": ["marks_read", "reports_read", "timetable_read"],
    "parent": ["marks_read", "reports_read", "timetable_read", "notifications_read"],
}
PERMISSION_LABELS = sorted({p for values in DEFAULT_ROLE_PERMISSIONS.values() for p in values})

TENANT_TABLES = {
    "users", "parent_accounts", "parent_learner_links", "classes", "subjects", "class_subjects",
    "academic_sessions", "terms", "holidays", "school_holidays", "term_holidays",
    "attendance_records", "attendance_entries", "marks", "marks_publications",
    "assessment_components", "learner_comments", "learner_skills", "learner_photos",
    "skills", "skill_ratings", "notifications", "notification_recipients",
    "notification_deliveries", "calendar_events", "school_events", "bell_periods",
    "bell_schedules", "timetable_settings", "timetable_rooms", "timetable_generations",
    "timetable_slots", "teacher_absences", "timetable_substitutions",
    "substitution_assignments", "lesson_bookings", "teacher_constraints",
    "school_settings", "role_permissions", "resources", "device_tokens", "game_scores",
    "report_comments", "sessions",
}


def slugify_school(value: str) -> str:
    text = re.sub(r"[^a-z0-9-]+", "-", clean(value).lower())
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:60] or "school"


def slugify_resource(value: str) -> str:
    text = re.sub(r"[^a-z0-9-]+", "-", clean(value).lower())
    text = re.sub(r"-+", "-", text).strip("-")
    return text[:90] or secrets.token_hex(4)


def send_email(to_email: str, subject: str, body: str) -> bool:
    host = clean(os.environ.get("SMTP_HOST"))
    if not host or not clean(to_email):
        return False
    port = as_int(os.environ.get("SMTP_PORT"), 587) or 587
    username = clean(os.environ.get("SMTP_USER"))
    password = os.environ.get("SMTP_PASSWORD") or ""
    from_email = clean(os.environ.get("SMTP_FROM")) or username or SUPPORT_EMAIL
    use_tls = clean(os.environ.get("SMTP_STARTTLS") or "1").lower() not in ("0", "false", "no")

    msg = EmailMessage()
    msg["From"] = from_email
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body)

    try:
        with smtplib.SMTP(host, port, timeout=10) as smtp:
            if use_tls:
                smtp.starttls()
            if username and password:
                smtp.login(username, password)
            smtp.send_message(msg)
        return True
    except Exception as err:
        print(f"[mail] Could not send email to {to_email}: {err}", file=sys.stderr)
        return False


def send_school_registration_email(to_email: str, *, school_name: str, school_code: str, owner_code: str, login_path: str, status: str) -> bool:
    status_line = "approved and ready to open" if status == "approved" else "received and waiting for review"
    body = f"""Hello,

Your Civicom school portal request for {school_name} has been {status_line}.

School code: {school_code}
Owner code: {owner_code}
Login page: {login_path}

Keep this email for your school setup records. If you did not request this portal, contact {SUPPORT_EMAIL}.

Civicom Schools
{SUPPORT_EMAIL}
"""
    return send_email(to_email, f"Civicom school portal - {school_name}", body)


def normalize_resource_type(value: str) -> str:
    text = clean(value).lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "pastpaper": "past_paper",
        "past_papers": "past_paper",
        "knec_past_papers": "past_paper",
        "marking_schemes": "marking_scheme",
        "markingscheme": "marking_scheme",
        "marking_key": "marking_scheme",
        "answer_key": "marking_scheme",
        "county_mock": "mock",
        "county_mocks": "mock",
        "mocks": "mock",
        "joint_exam": "mock",
        "joint_exams": "mock",
        "joint_mock": "mock",
        "predictions": "prediction",
        "prediction_paper": "prediction",
        "prediction_papers": "prediction",
        "termly_exam": "exam",
        "termly_exams": "exam",
        "end_term_exam": "exam",
        "exams": "exam",
        "topical": "topic_test",
        "topical_question": "topic_test",
        "topical_questions": "topic_test",
        "topic_tests": "topic_test",
        "revision_booklet": "revision",
        "revision_booklets": "revision",
        "booklet": "revision",
        "setbook_guides": "setbook_guide",
        "setbook": "setbook_guide",
        "holiday_assignment": "assignment",
        "holiday_assignments": "assignment",
        "assignments": "assignment",
        "lessonplan": "lesson_plan",
        "lesson_plans": "lesson_plan",
        "records_of_work": "record_of_work",
        "record_of_work_covered": "record_of_work",
        "curriculumdesign": "curriculum_design",
        "syllabus": "curriculum_design",
        "teacherguide": "teacher_guide",
        "teacher_guides": "teacher_guide",
        "tpad_tools": "tpad",
        "appraisal": "tpad",
        "learning_activities": "activity",
        "activities": "activity",
        "worksheets": "worksheet",
    }
    return aliases.get(text, text or "")


def normalize_resource_level(value: str) -> str:
    text = clean(value).lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "cbc_primary": "primary",
        "primary_school": "primary",
        "junior_secondary": "junior_secondary",
        "jss": "junior_secondary",
        "secondary_844": "844",
        "8_4_4": "844",
        "form": "844",
        "senior_secondary": "secondary",
    }
    return aliases.get(text, text)


def infer_resource_level(grade: str, typ: str = "") -> str:
    value = clean(grade).lower()
    typ = normalize_resource_type(typ)
    if typ in ("lesson_plan", "scheme", "teacher_guide", "curriculum_design"):
        return "teacher"
    if "grade" in value:
        nums = [int(x) for x in re.findall(r"\d+", value)]
        if nums and max(nums) <= 6:
            return "primary"
        if nums and 7 <= max(nums) <= 9:
            return "junior_secondary"
        if nums and max(nums) >= 10:
            return "secondary"
        return "cbc"
    if "form" in value:
        return "844"
    return "everyone"


def infer_resource_audience(typ: str) -> str:
    typ = normalize_resource_type(typ)
    if typ in ("lesson_plan", "scheme", "teacher_guide", "curriculum_design"):
        return "teacher"
    return "everyone"


def table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    try:
        return {r["name"] for r in rows(conn.execute(f"PRAGMA table_info({name})"))}
    except sqlite3.Error:
        return set()


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return bool(one(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,))))


def current_school_id_from_conn(conn: sqlite3.Connection) -> int:
    sid = CONN_SCHOOL.get(id(conn))
    return int(sid or 1)


_RESOURCE_LEGACY_MIGRATED = False


def quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def migrate_resource_tables_from_legacy_db(conn: sqlite3.Connection):
    """Move the portal library out of joyland.db into data/resource_database.db once."""
    global _RESOURCE_LEGACY_MIGRATED
    if _RESOURCE_LEGACY_MIGRATED:
        return
    if not DB_PATH.exists() or DB_PATH.resolve() == RESOURCE_DB_PATH.resolve():
        _RESOURCE_LEGACY_MIGRATED = True
        return
    if any(table_exists(conn, table) and scalar(conn, f"SELECT COUNT(*) FROM {quote_ident(table)}", (), 0) for table in RESOURCE_PORTAL_TABLES):
        _RESOURCE_LEGACY_MIGRATED = True
        return

    legacy = sqlite3.connect(DB_PATH)
    legacy.row_factory = sqlite3.Row
    legacy.execute("PRAGMA busy_timeout=5000")
    try:
        if not table_exists(legacy, "resources") or not scalar(legacy, "SELECT COUNT(*) FROM resources", (), 0):
            _RESOURCE_LEGACY_MIGRATED = True
            return
        conn.commit()
        conn.execute("BEGIN IMMEDIATE")
        for table in RESOURCE_PORTAL_TABLES:
            if not table_exists(legacy, table) or not table_exists(conn, table):
                continue
            source_cols = [r["name"] for r in rows(legacy.execute(f"PRAGMA table_info({quote_ident(table)})"))]
            dest_cols = [r["name"] for r in rows(conn.execute(f"PRAGMA table_info({quote_ident(table)})"))]
            common_cols = [col for col in dest_cols if col in source_cols]
            if not common_cols:
                continue
            qcols = ",".join(quote_ident(col) for col in common_cols)
            placeholders = ",".join("?" for _ in common_cols)
            source_rows = rows(legacy.execute(f"SELECT {qcols} FROM {quote_ident(table)}"))
            if not source_rows:
                continue
            conn.executemany(
                f"INSERT OR IGNORE INTO {quote_ident(table)} ({qcols}) VALUES ({placeholders})",
                ([row[col] for col in common_cols] for row in source_rows),
            )
        conn.commit()
        _RESOURCE_LEGACY_MIGRATED = True
    except sqlite3.Error:
        conn.rollback()
        _RESOURCE_LEGACY_MIGRATED = False
        raise
    finally:
        legacy.close()


def tenant_clause(conn: sqlite3.Connection, table: str = "", alias: str = "") -> tuple[str, tuple]:
    school_id = current_school_id_from_conn(conn)
    if table and "school_id" not in table_columns(conn, table):
        return "", ()
    prefix = f"{alias}." if alias else ""
    return f"{prefix}school_id=?", (school_id,)


def add_where_tenant(conn: sqlite3.Connection, table: str, where: list[str], args: list, alias: str = ""):
    clause, vals = tenant_clause(conn, table, alias)
    if clause:
        where.append(clause)
        args.extend(vals)


def get_school_by_slug(conn: sqlite3.Connection, slug: str) -> dict | None:
    return one(conn.execute("SELECT * FROM schools WHERE slug=? AND COALESCE(status,'active') NOT IN ('deleted','rejected')", (slugify_school(slug),)))


def get_school_by_code(conn: sqlite3.Connection, code: str) -> dict | None:
    return one(conn.execute("SELECT * FROM schools WHERE UPPER(school_code)=UPPER(?) AND COALESCE(status,'active') NOT IN ('deleted','rejected')", (clean(code),)))


def joyland_school(conn: sqlite3.Connection) -> dict:
    row = one(conn.execute("SELECT * FROM schools WHERE slug='joyland'"))
    if row:
        return row
    conn.execute(
        """INSERT INTO schools(name, slug, school_code, email, phone, address, county, country, logo_url, status, created_at)
           VALUES('JOYLAND SCHOOLS','joyland','JS','info@joylandschools.ac.ke','0700 000 000','P.O. Box 123','','Kenya','/uploads/school/logo.jpg','active',datetime('now'))"""
    )
    return one(conn.execute("SELECT * FROM schools WHERE slug='joyland'"))


def ensure_phase2_tables(conn: sqlite3.Connection):
    conn.execute(
        """CREATE TABLE IF NOT EXISTS schools (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL,
           slug TEXT NOT NULL UNIQUE,
           school_code TEXT NOT NULL UNIQUE,
           email TEXT,
           phone TEXT,
           address TEXT,
           county TEXT,
           country TEXT DEFAULT 'Kenya',
           logo_url TEXT,
           status TEXT NOT NULL DEFAULT 'active',
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    for col, spec in {
        "center_code": "TEXT",
        "curriculum": "TEXT",
        "website": "TEXT",
        "logo": "TEXT",
        "created_by": "INTEGER",
        "registration_status": "TEXT DEFAULT 'approved'",
        "approved_at": "TEXT",
        "approved_by": "INTEGER",
        "updated_at": "TEXT",
    }.items():
        if col not in table_columns(conn, "schools"):
            conn.execute(f"ALTER TABLE schools ADD COLUMN {col} {spec}")
    conn.execute("UPDATE schools SET registration_status=COALESCE(registration_status, CASE WHEN status IN ('active','approved') THEN 'approved' ELSE status END), status=COALESCE(status,'active')")
    conn.execute(
        """CREATE TABLE IF NOT EXISTS platform_owners (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           email TEXT NOT NULL UNIQUE,
           name TEXT,
           password TEXT NOT NULL,
           status TEXT DEFAULT 'active',
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT
        )"""
    )
    platform_email = clean(os.environ.get("PLATFORM_OWNER_EMAIL")).lower()
    platform_password = clean(os.environ.get("PLATFORM_OWNER_PASSWORD"))
    if platform_email and platform_password and not one(conn.execute("SELECT id FROM platform_owners WHERE email=?", (platform_email,))):
        conn.execute(
            "INSERT INTO platform_owners(email,name,password,status,created_at) VALUES(?,?,?,?,datetime('now'))",
            (platform_email, "Platform Owner", hash_password(platform_password), "active"),
        )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS tenant_audit_log (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           actor_role TEXT,
           actor_id INTEGER,
           action TEXT NOT NULL,
           target_type TEXT,
           target_id TEXT,
           ip TEXT,
           details_json TEXT,
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS report_templates (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER NOT NULL,
           name TEXT NOT NULL,
           state_json TEXT NOT NULL,
           created_by INTEGER,
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT,
           UNIQUE(school_id, name)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS tenant_school_settings (
           school_id INTEGER NOT NULL,
           key TEXT NOT NULL,
           value TEXT,
           updated_at TEXT DEFAULT (datetime('now')),
           PRIMARY KEY(school_id, key)
        )"""
    )
    school = joyland_school(conn)
    joyland_id = int(school["id"])
    conn.execute("UPDATE schools SET registration_status='approved', status='active', approved_at=COALESCE(approved_at, created_at, datetime('now')) WHERE id=?", (joyland_id,))
    if table_exists(conn, "school_settings") and not scalar(conn, "SELECT COUNT(*) FROM tenant_school_settings WHERE school_id=?", (joyland_id,), 0):
        for r in rows(conn.execute("SELECT key, value, updated_at FROM school_settings")):
            conn.execute(
                "INSERT OR IGNORE INTO tenant_school_settings(school_id,key,value,updated_at) VALUES(?,?,?,COALESCE(?,datetime('now')))",
                (joyland_id, r["key"], r["value"], r.get("updated_at")),
            )
    template_dir = ROOT / "data" / "templates"
    if template_dir.exists() and not scalar(conn, "SELECT COUNT(*) FROM report_templates WHERE school_id=?", (joyland_id,), 0):
        for path in sorted(template_dir.glob("*.json")):
            try:
                state = path.read_text(encoding="utf-8")
                json.loads(state)
            except Exception:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO report_templates(school_id,name,state_json,created_at,updated_at) VALUES(?,?,?,datetime('now'),datetime('now'))",
                (joyland_id, path.stem, state),
            )
    for table in sorted(TENANT_TABLES):
        if not table_exists(conn, table):
            continue
        cols = table_columns(conn, table)
        if "school_id" not in cols:
            try:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN school_id INTEGER")
            except sqlite3.OperationalError:
                pass
        if "school_id" in table_columns(conn, table):
            conn.execute(f"UPDATE {table} SET school_id=? WHERE school_id IS NULL", (joyland_id,))
    if table_exists(conn, "users"):
        cols = table_columns(conn, "users")
        for col in ("public_code", "staff_no"):
            if col not in cols:
                conn.execute(f"ALTER TABLE users ADD COLUMN {col} TEXT")
        conn.execute(
            """UPDATE users
               SET public_code=CASE
                 WHEN role='learner' AND COALESCE(admission_no,'')<>'' THEN 'JS-' || admission_no
                 WHEN role='teacher' THEN 'JS-STF-' || printf('%04d', id)
                 WHEN role='admin' THEN 'JS-ADM-' || printf('%04d', id)
                 ELSE user_id END
               WHERE public_code IS NULL OR public_code=''"""
        )
    if table_exists(conn, "users"):
        conn.execute(
            """UPDATE users
               SET staff_no=CASE WHEN role IN ('teacher','admin') THEN substr(public_code, 4) ELSE staff_no END
               WHERE role IN ('teacher','admin') AND (staff_no IS NULL OR staff_no='')"""
        )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS marks_publications (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           class_id INTEGER NOT NULL,
           subject_id INTEGER,
           term_id INTEGER NOT NULL,
           assessment_type TEXT NOT NULL,
           status TEXT NOT NULL DEFAULT 'draft',
           mark_count INTEGER NOT NULL DEFAULT 0,
           learner_count INTEGER NOT NULL DEFAULT 0,
           published_by INTEGER,
           published_at TEXT,
           updated_at TEXT DEFAULT (datetime('now')),
           UNIQUE(class_id, subject_id, term_id, assessment_type)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS school_role_permissions (
           school_id INTEGER NOT NULL,
           role TEXT NOT NULL,
           permission TEXT NOT NULL,
           updated_by INTEGER,
           updated_at TEXT DEFAULT (datetime('now')),
           PRIMARY KEY(school_id, role, permission)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS role_permissions (
           school_id INTEGER,
           role TEXT NOT NULL,
           permission TEXT NOT NULL,
           updated_by INTEGER,
           updated_at TEXT DEFAULT (datetime('now')),
           PRIMARY KEY(role, permission)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS timetable_settings (
           school_id INTEGER,
           key TEXT PRIMARY KEY,
           value TEXT,
           updated_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS teacher_absences (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           teacher_id INTEGER NOT NULL,
           date_from TEXT NOT NULL,
           date_to TEXT NOT NULL,
           reason TEXT NOT NULL DEFAULT 'other',
           notes TEXT,
           created_by INTEGER,
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS timetable_substitutions (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           absence_id INTEGER,
           slot_id INTEGER NOT NULL,
           date TEXT NOT NULL,
           original_teacher_id INTEGER NOT NULL,
           substitute_teacher_id INTEGER,
           notified_at TEXT,
           parent_notified_at TEXT,
           created_by INTEGER,
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT DEFAULT (datetime('now')),
           UNIQUE(slot_id, date)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS timetable_rooms (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           name TEXT NOT NULL UNIQUE,
           capacity INTEGER,
           room_type TEXT,
           subject_tags TEXT,
           status TEXT DEFAULT 'active',
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT DEFAULT (datetime('now')),
           allow_sharing INTEGER DEFAULT 0,
           home_class_id INTEGER
        )"""
    )
    if "school_id" in table_columns(conn, "role_permissions"):
        conn.execute("UPDATE role_permissions SET school_id=? WHERE school_id IS NULL", (joyland_id,))
    if not scalar(conn, "SELECT COUNT(*) FROM school_role_permissions WHERE school_id=?", (joyland_id,), 0):
        for role, perms in DEFAULT_ROLE_PERMISSIONS.items():
            for perm in perms:
                conn.execute("INSERT OR IGNORE INTO school_role_permissions(school_id, role, permission) VALUES (?,?,?)", (joyland_id, role, perm))


_RESOURCE_CHECK_RELAXED = False


def relax_resources_type_check(conn: sqlite3.Connection):
    """The original `resources` table pins `type` to 7 values via a CHECK constraint,
    which rejects the expanded CBC/KCSE taxonomy (marking schemes, mocks, prediction,
    records of work, TPAD, etc.) for both seeding and admin uploads. SQLite cannot ALTER
    a CHECK, so rebuild the table once without it. Atomic and idempotent."""
    global _RESOURCE_CHECK_RELAXED
    if _RESOURCE_CHECK_RELAXED:
        return
    row = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='resources'").fetchone()
    if not row or not row[0]:
        return
    ddl = row[0]
    has_type_check = re.search(r"\btype\b[^,\n]*\bCHECK\s*\(\s*type\s+IN\s*\(", ddl, re.IGNORECASE)
    if not has_type_check:
        _RESOURCE_CHECK_RELAXED = True
        return
    new_ddl = re.sub(r"\s+CHECK\s*\(\s*type\s+IN\s*\([^)]*\)\s*\)", "", ddl, count=1, flags=re.IGNORECASE)
    new_ddl = re.sub(
        r"(?is)^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)\"?resources\"?",
        r'\1"resources_new"',
        new_ddl,
        count=1,
    )
    cols = [r["name"] for r in rows(conn.execute("PRAGMA table_info(resources)"))]
    collist = ",".join(f'"{c}"' for c in cols)
    recreate_sql = [
        r["sql"]
        for r in rows(conn.execute(
            """SELECT sql FROM sqlite_master
               WHERE tbl_name='resources' AND type IN ('index','trigger') AND sql IS NOT NULL
               ORDER BY type, name"""
        ))
    ]
    foreign_keys_enabled = scalar(conn, "PRAGMA foreign_keys", default=1)
    try:
        conn.commit()  # close any implicit transaction so BEGIN is valid and FK pragma can change
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DROP TABLE IF EXISTS resources_new")
        conn.execute(new_ddl)
        conn.execute(f"INSERT INTO resources_new ({collist}) SELECT {collist} FROM resources")
        conn.execute("DROP TABLE resources")
        conn.execute("ALTER TABLE resources_new RENAME TO resources")
        for sql in recreate_sql:
            conn.execute(sql)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type, grade, subject)")
        conn.commit()
        _RESOURCE_CHECK_RELAXED = True
    except sqlite3.Error as exc:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        _RESOURCE_CHECK_RELAXED = False
        raise RuntimeError("Could not relax resources.type CHECK constraint") from exc
    finally:
        if foreign_keys_enabled:
            conn.execute("PRAGMA foreign_keys=ON")


def ensure_resource_portal_tables(conn: sqlite3.Connection, seed: bool = True):
    """Resource portal schema. Kept out of core startup so the school app is detachable."""
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resources (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           school_id INTEGER,
           type TEXT,
           title TEXT NOT NULL,
           grade TEXT,
           subject TEXT,
           year INTEGER,
           body_html TEXT,
           file_path TEXT,
           published INTEGER DEFAULT 1,
           views INTEGER DEFAULT 0,
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_categories (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           slug TEXT NOT NULL UNIQUE,
           description TEXT,
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_tags (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           slug TEXT NOT NULL UNIQUE,
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_tag_links (
           resource_id INTEGER NOT NULL,
           tag_id INTEGER NOT NULL,
           PRIMARY KEY(resource_id, tag_id)
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_downloads (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           resource_id INTEGER NOT NULL,
           user_role TEXT,
           user_id INTEGER,
           ip TEXT,
           created_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_reviews (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           resource_id INTEGER NOT NULL,
           user_role TEXT,
           user_id INTEGER,
           rating INTEGER,
           review_text TEXT,
           status TEXT DEFAULT 'published',
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT
        )"""
    )
    conn.execute(
        """CREATE TABLE IF NOT EXISTS resource_submissions (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           title TEXT NOT NULL,
           type TEXT,
           grade TEXT,
           subject TEXT,
           level TEXT,
           audience TEXT,
           filename TEXT NOT NULL,
           file_path TEXT NOT NULL,
           file_size INTEGER,
           mime_type TEXT,
           contact TEXT,
           note TEXT,
           status TEXT DEFAULT 'pending',
           reviewer_note TEXT,
           reviewed_by INTEGER,
           reviewed_at TEXT,
           resource_id INTEGER,
           ip TEXT,
           created_at TEXT DEFAULT (datetime('now')),
           updated_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    cols = table_columns(conn, "resources")
    for col, spec in {
        "category_id": "INTEGER",
        "level": "TEXT",
        "audience": "TEXT",
        "premium": "INTEGER DEFAULT 0",
        "is_featured": "INTEGER DEFAULT 0",
        "is_verified": "INTEGER DEFAULT 0",
        "downloads_count": "INTEGER DEFAULT 0",
        "rating": "REAL DEFAULT 0",
        "status": "TEXT DEFAULT 'published'",
        "slug": "TEXT",
        "thumbnail": "TEXT",
        "mime_type": "TEXT",
        "file_size": "INTEGER",
        "visibility": "TEXT DEFAULT 'public'",
        "created_by_school_id": "INTEGER",
        "created_by_user_id": "INTEGER",
    }.items():
        if col not in cols:
            conn.execute(f"ALTER TABLE resources ADD COLUMN {col} {spec}")
    submission_cols = table_columns(conn, "resource_submissions")
    if "resource_id" not in submission_cols:
        conn.execute("ALTER TABLE resource_submissions ADD COLUMN resource_id INTEGER")
    relax_resources_type_check(conn)
    for r in rows(conn.execute("SELECT id,title,type,grade,file_path,published,level,audience,status,slug,visibility,created_by_school_id,file_size FROM resources")):
        updates = {}
        if not clean(r.get("level")):
            updates["level"] = infer_resource_level(r.get("grade"), r.get("type"))
        if not clean(r.get("audience")):
            updates["audience"] = infer_resource_audience(r.get("type"))
        if not clean(r.get("status")):
            updates["status"] = "published" if int(r.get("published") or 0) else "draft"
        if not clean(r.get("visibility")):
            updates["visibility"] = "public"
        if not clean(r.get("slug")):
            updates["slug"] = f"{slugify_resource(r.get('title'))}-{r['id']}"
        if not r.get("created_by_school_id"):
            updates["created_by_school_id"] = r.get("school_id")
        path_text = clean(r.get("file_path"))
        if path_text.startswith("/uploads/joyland/resources/"):
            updates["file_path"] = path_text.replace("/uploads/joyland/resources/", "/uploads/resources/", 1)
        if path_text and not r.get("file_size"):
            rel = path_text.lstrip("/")
            fpath = (PUBLIC_DIR / rel).resolve()
            if fpath.exists() and str(fpath).startswith(str(PUBLIC_DIR.resolve())):
                updates["file_size"] = fpath.stat().st_size
                updates["mime_type"] = mimetypes.guess_type(str(fpath))[0] or "application/octet-stream"
        if updates:
            assignments = ", ".join(f"{k}=?" for k in updates)
            conn.execute(f"UPDATE resources SET {assignments} WHERE id=?", (*updates.values(), r["id"]))
    if seed:
        seed_resource_library(conn)
        seed_resource_activity(conn)


_RESOURCE_SEED_DONE = False
_RESOURCE_ACTIVITY_SEEDED = False


def _seed_mime(typ: str) -> str:
    docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    if typ in ("scheme", "lesson_plan", "record_of_work", "curriculum_design", "teacher_guide", "tpad"):
        return docx
    if typ in ("notes", "quiz"):
        return ""  # read-online
    if typ == "video":
        return "video/mp4"
    return "application/pdf"


def _seed_body(typ: str, title: str) -> str:
    blurb = {
        "past_paper": "KNEC-style past paper for focused practice. Open the marking scheme alongside to self-mark.",
        "marking_scheme": "Marking scheme with expected answers and mark allocation. Use it to score practice papers.",
        "mock": "County / joint examination paper used for KCSE preparation. Sit it under timed conditions.",
        "prediction": "Prediction paper for the coming exam season, built from recent trends and topical weighting.",
        "exam": "Termly examination paper. Use as an opener, mid-term or end-term assessment.",
        "topic_test": "Topical questions grouped by topic for targeted revision and remedial work.",
        "revision": "Revision booklet with summaries and practice questions for quick review.",
        "setbook_guide": "Set book guide: summary, themes, characters and sample essay questions.",
        "assignment": "Holiday assignment to keep learners engaged between terms.",
        "notes": "Learning notes with key ideas, worked examples and self-check questions.",
        "scheme": "Scheme of work aligned to the term, with weeks, lessons and references.",
        "lesson_plan": "Ready-to-use lesson plan with objectives, activities and assessment.",
        "record_of_work": "Record of work covered template for tracking syllabus coverage.",
        "curriculum_design": "KICD curriculum design with strands, sub-strands and learning outcomes.",
        "teacher_guide": "Teacher guide with subject content, methodology and assessment tips.",
        "assessment": "CBC assessment rubric / CBA tool with performance levels.",
        "tpad": "TPAD appraisal and lesson-observation tool for TSC teachers.",
        "worksheet": "Printable worksheet for classwork and practice.",
        "activity": "Practical learning activity for hands-on, competency-based learning.",
        "quiz": "Short self-check quiz for quick revision and learner feedback.",
        "video": "Lesson video resource for guided review before or after class.",
    }.get(typ, "Open this resource to read more.")
    return f"<h2>{escape_html_text(title)}</h2><p>{blurb}</p>"


def escape_html_text(value: str) -> str:
    return (clean(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def build_seed_records() -> list[dict]:
    """A realistic CBC + KCSE demo library covering the full portal taxonomy."""
    recs: list[dict] = []

    def add(typ, title, subject, grade, level, *, year=None, audience="everyone", featured=0, verified=1, downloads=0, rating=0):
        # Titles are unique across the set, so a title-based slug is collision-free.
        key = f"lib-{slugify_resource(title)}"
        recs.append({
            "type": typ, "title": title, "subject": subject or "General", "grade": grade or "General",
            "level": level, "year": year, "audience": audience, "slug": key,
            "mime": _seed_mime(typ), "body": _seed_body(typ, title),
            "downloads": downloads, "rating": rating, "verified": verified, "featured": featured,
        })

    kcse_core = ["Mathematics", "English", "Kiswahili", "Biology", "Chemistry", "Physics"]
    kcse_all = kcse_core + ["Geography", "History", "Business Studies", "CRE", "Agriculture", "Computer Studies"]

    # KCSE (Form 1-4) notes
    for s in kcse_all:
        add("notes", f"KCSE {s} Form 4 Notes", s, "Form 4", "844", downloads=420, rating=4.6, featured=1 if s in ("Biology", "Mathematics") else 0)
    for s in kcse_core:
        add("notes", f"KCSE {s} Form 3 Notes", s, "Form 3", "844", downloads=260, rating=4.4)

    # KCSE past papers + paired marking schemes
    for s in kcse_core:
        for y in (2024, 2023, 2022):
            add("past_paper", f"{y} KCSE {s} Past Paper", s, "Form 4", "844", year=y, downloads=1100, rating=4.7)
            add("marking_scheme", f"{y} KCSE {s} Marking Scheme", s, "Form 4", "844", year=y, downloads=980, rating=4.7)

    # Mocks & joint exams, prediction, topical, revision
    for s in ("Biology", "Chemistry", "Mathematics", "English"):
        for y in (2025, 2024):
            add("mock", f"{y} {s} County Mock (Joint Exam)", s, "Form 4", "844", year=y, downloads=540, rating=4.5)
    for s in ("Biology", "Chemistry", "Mathematics", "Physics"):
        add("prediction", f"2026 KCSE {s} Prediction Paper", s, "Form 4", "844", year=2026, downloads=300, rating=4.3)
        add("topic_test", f"KCSE {s} Topical Questions", s, "Form 4", "844", downloads=410, rating=4.5)
    for s in ("Biology", "Chemistry", "Mathematics"):
        add("revision", f"KCSE {s} Revision Booklet", s, "Form 4", "844", downloads=360, rating=4.4)

    # Termly exams + holiday assignments
    for s in ("Mathematics", "English"):
        for term in ("Opener", "Mid-Term", "End-Term"):
            add("exam", f"Form 4 {s} {term} Exam", s, "Form 4", "844", downloads=180, rating=4.2)
    for s in ("Mathematics", "Biology"):
        add("assignment", f"Form 3 {s} Holiday Assignment", s, "Form 3", "844", downloads=140, rating=4.1)
        add("assignment", f"Form 4 {s} Holiday Assignment", s, "Form 4", "844", downloads=150, rating=4.1)

    # Set book guides (English + Kiswahili genres)
    for g in ("Novel", "Play", "Short Stories", "Poetry"):
        add("setbook_guide", f"English Set Book Guide - {g}", "English", "Form 4", "844", downloads=320, rating=4.6)
    for g in ("Riwaya", "Tamthilia", "Hadithi Fupi", "Ushairi"):
        add("setbook_guide", f"Kiswahili Fasihi - {g}", "Kiswahili", "Form 4", "844", downloads=300, rating=4.6)

    # Senior School (Grade 10-12) - CBC pioneer
    for s in ("Mathematics", "English", "Biology", "Chemistry", "Physics", "Agriculture"):
        add("notes", f"Grade 10 {s} Notes", s, "Grade 10", "secondary", downloads=210, rating=4.3)
    for s in ("Mathematics", "Biology"):
        add("exam", f"Grade 10 {s} End-Term Exam", s, "Grade 10", "secondary", downloads=120, rating=4.2)
    add("topic_test", "Grade 10 Mathematics Topical Questions", "Mathematics", "Grade 10", "secondary", downloads=140, rating=4.3)
    add("assessment", "Grade 10 CBC Assessment Rubrics", "Integrated Science", "Grade 10", "secondary", downloads=90, rating=4.2)

    # Junior School (Grade 7-9)
    for s in ("Integrated Science", "Mathematics", "English"):
        for g in ("Grade 7", "Grade 8", "Grade 9"):
            add("notes", f"{g} {s} Notes", s, g, "junior_secondary", downloads=230, rating=4.4)
    for s in ("Integrated Science", "Mathematics"):
        for g in ("Grade 7", "Grade 8", "Grade 9"):
            add("exam", f"{g} {s} End-Term Exam", s, g, "junior_secondary", downloads=150, rating=4.2)
    for g in ("Grade 7", "Grade 8", "Grade 9"):
        add("assessment", f"{g} Integrated Science CBC Rubric", "Integrated Science", g, "junior_secondary", downloads=80, rating=4.1)
    add("worksheet", "Grade 7 Mathematics Worksheet", "Mathematics", "Grade 7", "junior_secondary", downloads=110, rating=4.2)
    add("activity", "Grade 7 Creative Arts Activity Pack", "Creative Arts", "Grade 7", "junior_secondary", downloads=95, rating=4.2)
    add("quiz", "Grade 8 Integrated Science Quick Quiz", "Integrated Science", "Grade 8", "junior_secondary", downloads=75, rating=4.1)
    add("video", "Grade 9 Mathematics Revision Video", "Mathematics", "Grade 9", "junior_secondary", downloads=85, rating=4.2)

    # Primary (Grade 1-6)
    for s in ("Mathematics", "English", "Kiswahili"):
        for g in ("Grade 4", "Grade 5", "Grade 6"):
            add("notes", f"{g} {s} Notes", s, g, "primary", downloads=170, rating=4.3)
    for g in ("Grade 4", "Grade 5", "Grade 6"):
        add("exam", f"{g} Mathematics End-Term Exam", "Mathematics", g, "primary", downloads=130, rating=4.2)
    add("worksheet", "Grade 3 English Reading Worksheet", "English", "Grade 3", "primary", downloads=120, rating=4.2)

    # Pre-Primary (PP1 / PP2)
    for g in ("PP1", "PP2"):
        add("activity", f"{g} Learning Activity Pack", "Creative Arts", g, "pre_primary", downloads=140, rating=4.4)
        add("worksheet", f"{g} Numeracy Worksheet", "Mathematics", g, "pre_primary", downloads=130, rating=4.3)
        add("assessment", f"{g} Observation Assessment Tool", "Language Activities", g, "pre_primary", downloads=70, rating=4.1)

    # Teacher professional documents (audience = teacher)
    for s in ("Mathematics", "English", "Biology"):
        add("scheme", f"KCSE {s} Scheme of Work", s, "Form 4", "844", audience="teacher", downloads=260, rating=4.6)
    for s in ("Integrated Science", "Mathematics"):
        add("scheme", f"Grade 7 {s} Scheme of Work", s, "Grade 7", "junior_secondary", audience="teacher", downloads=240, rating=4.6, featured=1)
    add("scheme", "Grade 10 Mathematics Scheme of Work", "Mathematics", "Grade 10", "secondary", audience="teacher", downloads=160, rating=4.4)
    for s in ("Mathematics", "Biology"):
        add("lesson_plan", f"KCSE {s} Lesson Plans", s, "Form 4", "844", audience="teacher", downloads=210, rating=4.5)
    add("lesson_plan", "Grade 7 Integrated Science Lesson Plans", "Integrated Science", "Grade 7", "junior_secondary", audience="teacher", downloads=200, rating=4.5)
    add("record_of_work", "KCSE Mathematics Record of Work", "Mathematics", "Form 4", "844", audience="teacher", downloads=120, rating=4.3)
    add("record_of_work", "Grade 7 Integrated Science Record of Work", "Integrated Science", "Grade 7", "junior_secondary", audience="teacher", downloads=110, rating=4.3)
    add("curriculum_design", "Grade 7 Integrated Science Curriculum Design", "Integrated Science", "Grade 7", "junior_secondary", audience="teacher", downloads=180, rating=4.6)
    add("curriculum_design", "Grade 7 Mathematics Curriculum Design", "Mathematics", "Grade 7", "junior_secondary", audience="teacher", downloads=170, rating=4.6)
    add("curriculum_design", "Grade 10 Mathematics Curriculum Design", "Mathematics", "Grade 10", "secondary", audience="teacher", downloads=130, rating=4.4)
    add("curriculum_design", "PP1 Curriculum Design", "Language Activities", "PP1", "pre_primary", audience="teacher", downloads=90, rating=4.3)
    add("assessment", "Grade 7 Integrated Science CBA Tool", "Integrated Science", "Grade 7", "junior_secondary", audience="teacher", downloads=100, rating=4.3)
    for s in ("Mathematics", "Biology"):
        add("teacher_guide", f"{s} Teacher Guide", s, "Form 4", "844", audience="teacher", downloads=120, rating=4.4)
    add("tpad", "TPAD Appraisal Tool (TSC)", "Professional", "General", "844", audience="teacher", downloads=150, rating=4.5)
    add("tpad", "Lesson Observation Tool", "Professional", "General", "844", audience="teacher", downloads=130, rating=4.4)

    return recs


def seed_resource_library(conn: sqlite3.Connection):
    """Insert the demo library once per process; idempotent by 'lib-' slug."""
    global _RESOURCE_SEED_DONE
    if _RESOURCE_SEED_DONE:
        return
    seed_records = build_seed_records()
    try:
        have = {r["slug"] for r in rows(conn.execute("SELECT slug FROM resources WHERE slug LIKE 'lib-%'"))}
        new = [r for r in seed_records if r["slug"] not in have]
        if not new:
            _RESOURCE_SEED_DONE = True
            return
        conn.execute("SAVEPOINT seed_resource_library")
        for r in new:
            conn.execute(
                """INSERT INTO resources
                   (type,title,grade,subject,year,body_html,level,audience,published,status,
                    visibility,slug,mime_type,downloads_count,rating,is_verified,is_featured,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,1,'published','public',?,?,?,?,?,?,datetime('now'),datetime('now'))""",
                (r["type"], r["title"], r["grade"], r["subject"], r["year"], r["body"], r["level"],
                 r["audience"], r["slug"], r["mime"], r["downloads"], r["rating"], r["verified"], r["featured"]),
            )
        conn.execute("RELEASE seed_resource_library")
        conn.commit()
        _RESOURCE_SEED_DONE = True
    except sqlite3.Error:
        try:
            conn.execute("ROLLBACK TO seed_resource_library")
            conn.execute("RELEASE seed_resource_library")
        except sqlite3.Error:
            pass
        # Never let seeding break the API; tables may be mid-migration on first boot.
        _RESOURCE_SEED_DONE = False


def seed_resource_activity(conn: sqlite3.Connection):
    """Populate the download log with demo activity once, so the admin analytics
    charts are meaningful on a fresh install. Runs only when the log is empty, so
    real traffic is never mixed with or overwritten by demo data."""
    global _RESOURCE_ACTIVITY_SEEDED
    if _RESOURCE_ACTIVITY_SEEDED:
        return
    _RESOURCE_ACTIVITY_SEEDED = True
    try:
        if scalar(conn, "SELECT COUNT(*) FROM resource_downloads", (), 0) > 0:
            return  # real or prior activity exists - leave it untouched
        ids = [r["id"] for r in rows(conn.execute(
            "SELECT id FROM resources WHERE COALESCE(published,0)=1 ORDER BY COALESCE(downloads_count,0) DESC LIMIT 40"))]
        if not ids:
            _RESOURCE_ACTIVITY_SEEDED = False
            return
        import random
        rnd = random.Random(2026)
        ips = [f"154.{a}.{b}.{rnd.randint(2, 250)}" for a in range(1, 6) for b in range(1, 8)]
        weekday_weight = [1.0, 1.05, 1.1, 1.0, 0.95, 0.6, 0.5]  # Mon..Sun: lighter weekends
        now = datetime.now(timezone.utc)
        batch = []
        for i in range(30):  # last 30 days, newer days busier
            day = now - timedelta(days=i)
            base = 6 + 22 * ((30 - i) / 30.0)
            count = int(base * weekday_weight[day.weekday()])
            for _ in range(count):
                ts = day.replace(hour=rnd.randint(6, 21), minute=rnd.randint(0, 59), second=rnd.randint(0, 59))
                rid = rnd.choice(ids[:8]) if rnd.random() < 0.6 else rnd.choice(ids)
                batch.append((rid, "public", None, rnd.choice(ips), ts.strftime("%Y-%m-%d %H:%M:%S")))
        if batch:
            conn.executemany(
                "INSERT INTO resource_downloads(resource_id,user_role,user_id,ip,created_at) VALUES(?,?,?,?,?)",
                batch,
            )
            conn.commit()
    except sqlite3.Error:
        _RESOURCE_ACTIVITY_SEEDED = False


def role_permissions(conn: sqlite3.Connection, role: str) -> list[str]:
    school_id = current_school_id_from_conn(conn)
    stored = [r["permission"] for r in rows(conn.execute("SELECT permission FROM school_role_permissions WHERE school_id=? AND role=? ORDER BY permission", (school_id, role)))]
    if not stored:
        stored = [r["permission"] for r in rows(conn.execute("SELECT permission FROM role_permissions WHERE role=? ORDER BY permission", (role,)))]
    return stored if stored else list(DEFAULT_ROLE_PERMISSIONS.get(role, []))


def has_role_permission(conn: sqlite3.Connection, user: dict, permission: str) -> bool:
    role = user.get("role")
    if user.get("is_admin"):
        return True
    return permission in role_permissions(conn, clean(role))


def published_subject_ids(conn: sqlite3.Connection, class_id, term_id, assessment) -> set[int]:
    school_id = current_school_id_from_conn(conn)
    return {
        int(r["subject_id"])
        for r in rows(conn.execute(
            """SELECT subject_id FROM marks_publications
               WHERE class_id=? AND term_id=? AND assessment_type=? AND status='published' AND COALESCE(school_id,?)=?""",
            (class_id, term_id, assessment, school_id, school_id),
        ))
        if r.get("subject_id") is not None
    }


def subject_is_published(conn: sqlite3.Connection, class_id, subject_id, term_id, assessment) -> bool:
    school_id = current_school_id_from_conn(conn)
    return bool(one(conn.execute(
        """SELECT 1 FROM marks_publications
           WHERE class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND status='published' AND COALESCE(school_id,?)=?""",
        (class_id, subject_id, term_id, assessment, school_id, school_id),
    )))


def admin_permission_for(path: str, method: str) -> str | None:
    if method == "GET":
        return None
    if path == "/api/admin/marks":
        return "marks_write"
    if path == "/api/admin/marks/publish":
        return "marks_publish"
    if path == "/api/admin/attendance" or path == "/api/admin/attendance/bulk":
        return "attendance_write"
    if path.startswith("/api/admin/learners") or path.startswith("/api/admin/teachers") or path.startswith("/api/admin/classes"):
        return "people_write"
    if path.startswith("/api/admin/roles/"):
        return "permissions_write"
    if path.startswith("/api/admin/timetable/"):
        return "timetable_write"
    if path.startswith("/api/admin/templates") or path == "/api/admin/school-assets":
        return "reports_read"
    if path.startswith("/api/admin/sessions") or path.startswith("/api/admin/terms") or path.startswith("/api/admin/holidays") or path.startswith("/api/admin/calendar"):
        return "settings_write"
    if path == "/api/admin/school-settings":
        return "settings_write"
    if path == "/api/admin/security/force-logout":
        return "settings_write"
    if path.startswith("/api/admin/billing") or path.startswith("/api/admin/integrations"):
        return "settings_write"
    if path.startswith("/api/admin/backups"):
        return "settings_write"
    if path.startswith("/api/admin/subjects") or path.startswith("/api/admin/assessment-components"):
        return "settings_write"
    if path.startswith("/api/portal/admin/resources"):
        return "settings_write"
    if path.startswith("/api/admin/skills"):
        return "marks_write"
    return None


def signed(value: str) -> str:
    sig = hmac.new(SECRET.encode(), value.encode(), hashlib.sha256).digest()
    return value + "." + base64.urlsafe_b64encode(sig).decode().rstrip("=")


def unsign(value: str) -> str | None:
    if "." not in value:
        return None
    raw, sig = value.rsplit(".", 1)
    return raw if hmac.compare_digest(signed(raw), value) else None


def parse_cookie(header: str) -> dict[str, str]:
    out = {}
    for part in str(header or "").split(";"):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def verify_password(password: str, hashed: str) -> bool:
    if not hashed:
        return False
    if hashed.startswith("$2"):
        if bcrypt is None:
            raise RuntimeError("Python package 'bcrypt' is required for existing Daraja passwords. Run: pip install -r requirements.txt")
        return bool(bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8")))
    return hmac.compare_digest(password, hashed)


def hash_password(password: str) -> str:
    if bcrypt is None:
        raise RuntimeError("Python package 'bcrypt' is required to save Daraja passwords. Run: pip install -r requirements.txt")
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=10)).decode("utf-8")


def public_subject_code(value):
    text = clean(value)
    return text if text and not text.upper().startswith("SYSAUTO") else None


CBC_LEVELS = [
    {"code": "EE1", "descriptor": "Exceeding Expectations", "points": 8, "min": 90, "label": "Exceptional"},
    {"code": "EE2", "descriptor": "Exceeding Expectations", "points": 7, "min": 75, "label": "Very Good"},
    {"code": "ME1", "descriptor": "Meeting Expectations", "points": 6, "min": 58, "label": "Good"},
    {"code": "ME2", "descriptor": "Meeting Expectations", "points": 5, "min": 41, "label": "Fair"},
    {"code": "AE1", "descriptor": "Approaching Expectations", "points": 4, "min": 31, "label": "Needs Improvement"},
    {"code": "AE2", "descriptor": "Approaching Expectations", "points": 3, "min": 21, "label": "Below Average"},
    {"code": "BE1", "descriptor": "Below Expectations", "points": 2, "min": 11, "label": "Poor"},
    {"code": "BE2", "descriptor": "Below Expectations", "points": 1, "min": 0, "label": "Very Poor"},
]


DEFAULT_SKILLS = {
    "affective": ["Responsibility", "Cooperation", "Self-control", "Confidence", "Respect"],
    "psychomotor": ["Handwriting", "Drawing", "Sports", "Craft work", "Practical skills"],
    "ratings": [1, 2, 3, 4, 5],
    "rating_labels": ["Needs support", "Developing", "Satisfactory", "Good", "Excellent"],
}


def cbc_level(value):
    if value is None:
        return None
    try:
        score = max(0, min(100, float(value)))
    except (TypeError, ValueError):
        return None
    for level in CBC_LEVELS:
        if score >= level["min"]:
            return level
    return CBC_LEVELS[-1]


def slugify_key(value):
    text = re.sub(r"[^a-z0-9]+", "_", clean(value).lower()).strip("_")
    return text or "item"


def school_settings(conn):
    school_id = current_school_id_from_conn(conn)
    defaults = {
        "school_name": "JOYLAND SCHOOLS",
        "school_motto": "Education Is Treasure",
        "school_logo": "/uploads/school/logo.jpg",
        "school_address": "",
        "school_phone": "",
        "school_email": "",
    }
    for r in rows(conn.execute("SELECT key, value FROM tenant_school_settings WHERE school_id=?", (school_id,))):
        defaults[r["key"]] = r["value"] or ""
    if school_id == 1:
        for r in rows(conn.execute("SELECT key, value FROM school_settings")):
            defaults.setdefault(r["key"], r["value"] or "")
    return defaults


def template_state_for_conn(conn, name):
    school_id = current_school_id_from_conn(conn)
    safe = safe_template_name(name or "Default Template")
    row = one(conn.execute("SELECT state_json FROM report_templates WHERE school_id=? AND name=?", (school_id, safe)))
    if row:
        try:
            return json.loads(row["state_json"])
        except Exception:
            return None
    if school_id == 1:
        return template_state(safe)
    return None


def template_state(name):
    target = template_file_path(name or "Default Template")
    if target.exists():
        try:
            return json.loads(target.read_text(encoding="utf-8"))
        except Exception:
            return None
    return None


def skill_config_for_class(conn, class_id):
    school_id = current_school_id_from_conn(conn)
    cls = one(conn.execute("SELECT template_name FROM classes WHERE id=? AND COALESCE(school_id,?)=?", (class_id, school_id, school_id)))
    state = template_state_for_conn(conn, cls.get("template_name") if cls else None)
    sk = (((state or {}).get("customizations") or {}).get("skills") or {})
    affective = sk.get("affective") if isinstance(sk.get("affective"), list) and sk.get("affective") else DEFAULT_SKILLS["affective"]
    psychomotor = sk.get("psychomotor") if isinstance(sk.get("psychomotor"), list) and sk.get("psychomotor") else DEFAULT_SKILLS["psychomotor"]
    ratings = sk.get("ratings") if isinstance(sk.get("ratings"), list) and sk.get("ratings") else DEFAULT_SKILLS["ratings"]
    labels = sk.get("rating_labels") if isinstance(sk.get("rating_labels"), list) and sk.get("rating_labels") else DEFAULT_SKILLS["rating_labels"]
    return {
        "categories": [
            {"key": "affective", "label": "Affective Traits", "items": [{"key": slugify_key(x), "label": x} for x in affective]},
            {"key": "psychomotor", "label": "Psychomotor Skills", "items": [{"key": slugify_key(x), "label": x} for x in psychomotor]},
        ],
        "ratings": ratings,
        "rating_labels": labels,
        "source": "template" if state else "default",
    }


def valid_assessment(value, fallback="midterm"):
    text = clean(value).lower()
    return text if text in ("midterm", "endterm") else fallback


def term_for_date(conn, date: str):
    school_id = current_school_id_from_conn(conn)
    return one(conn.execute(
        """SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number
           FROM terms
           WHERE COALESCE(school_id,?)=? AND date(start_date) <= date(?) AND date(end_date) >= date(?)
           ORDER BY date(start_date) DESC LIMIT 1""",
        (school_id, school_id, date, date),
    ))


def default_term(conn):
    today = now_kenya_date()
    school_id = current_school_id_from_conn(conn)
    return term_for_date(conn, today) or one(conn.execute(
        """SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number
           FROM terms WHERE COALESCE(school_id,?)=? AND date(end_date) < date(?)
           ORDER BY date(end_date) DESC LIMIT 1""",
        (school_id, school_id, today),
    ))


def resolve_term(conn, term_id=None):
    school_id = current_school_id_from_conn(conn)
    if term_id:
        term = one(conn.execute(
            "SELECT id, term_name AS name, term_name, start_date, end_date, session_id, term_number FROM terms WHERE id=? AND COALESCE(school_id,?)=?",
            (term_id, school_id, school_id),
        ))
        if term:
            return term
    return default_term(conn)


def detect_assessment(term):
    if not term:
        return "midterm"
    today = datetime.fromisoformat(now_kenya_date())
    start = datetime.fromisoformat(term["start_date"])
    end = datetime.fromisoformat(term["end_date"])
    if today < start:
        return "midterm"
    if today > end:
        return "endterm"
    total = max(1, (end - start).days)
    return "midterm" if (today - start).days / total < 0.5 else "endterm"


def class_for_learner(conn, learner):
    if not learner or not learner.get("class_name"):
        return None
    school_id = current_school_id_from_conn(conn)
    return one(conn.execute(
        """SELECT c.id, c.name, c.grade_level, c.template_name, u.name AS class_teacher_name
           FROM classes c LEFT JOIN users u ON u.id=c.class_teacher_id
           WHERE c.name=? AND COALESCE(c.school_id,?)=?""",
        (learner["class_name"], school_id, school_id),
    ))


def attendance_summary(conn, learner_id, class_id, term_id):
    if not class_id or not term_id:
        return None
    school_id = current_school_id_from_conn(conn)
    r = one(conn.execute(
        """SELECT COUNT(DISTINCT ar.id) AS opened,
                  SUM(CASE WHEN ae.status IN ('present','P') THEN 1 ELSE 0 END) AS present,
                  SUM(CASE WHEN ae.status IN ('absent','A') THEN 1 ELSE 0 END) AS absent,
                  SUM(CASE WHEN ae.status IN ('late','L') THEN 1 ELSE 0 END) AS late
           FROM attendance_records ar
           LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=?
           WHERE ar.class_id=? AND ar.term_id=? AND COALESCE(ar.school_id,?)=?""",
        (learner_id, class_id, term_id, school_id, school_id),
    )) or {}
    opened = int(r.get("opened") or 0)
    present = int(r.get("present") or 0)
    absent = int(r.get("absent") or 0)
    late = int(r.get("late") or 0)
    return {"opened": opened, "present": present, "absent": absent, "late": late, "pct": round((present / opened) * 100) if opened else 0}


def assessment_components(conn, class_id, subject_id, assessment):
    school_id = current_school_id_from_conn(conn)
    return rows(conn.execute(
        """SELECT id, component_key, component_name, max_score, sort_order
           FROM assessment_components
           WHERE class_id=? AND subject_id=? AND assessment_type=? AND COALESCE(school_id,?)=?
           ORDER BY sort_order, component_name""",
        (class_id, subject_id, assessment, school_id, school_id),
    ))


def learner_marks(conn, learner, query, published_only=False):
    school_id = current_school_id_from_conn(conn)
    cls = class_for_learner(conn, learner)
    if not cls:
        return {"term": None, "assessment_type": None, "subjects": [], "overall_percent": None}
    term = resolve_term(conn, query.get("term_id", [None])[0] if isinstance(query, dict) else None)
    if not term:
        return {"term": None, "assessment_type": None, "subjects": [], "overall_percent": None}
    assessment = valid_assessment((query.get("assessment_type", [None])[0] if isinstance(query, dict) else None), detect_assessment(term))
    published_subjects = published_subject_ids(conn, cls["id"], term["id"], assessment) if published_only else None
    subs = rows(conn.execute(
        """SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
           FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
           WHERE cs.school_id=? AND cs.class_id=? ORDER BY s.name""",
        (school_id, cls["id"]),
    ))
    out = []
    for sub in subs:
        if published_subjects is not None and int(sub["subject_id"]) not in published_subjects:
            continue
        comps = rows(conn.execute(
            """SELECT component_key AS key, component_name AS name, max_score AS max
               FROM assessment_components
               WHERE school_id=? AND class_id=? AND subject_id=? AND assessment_type=?
               ORDER BY sort_order, component_name""",
            (school_id, cls["id"], sub["subject_id"], assessment),
        ))
        score_map = {r["component_key"]: r["score"] for r in rows(conn.execute(
            """SELECT component_key, score FROM marks
               WHERE school_id=? AND learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=?""",
            (school_id, learner["id"], cls["id"], sub["subject_id"], term["id"], assessment),
        ))}
        populated = []
        for c in comps:
            score = score_map.get(c["key"])
            populated.append({"key": c["key"], "name": c["name"], "max": float(c["max"] or 0), "score": float(score) if score is not None else None})
        max_total = sum(float(c["max"] or 0) for c in populated)
        total = sum(float(c["score"] or 0) for c in populated if c["score"] is not None)
        any_score = any(c["score"] is not None for c in populated)
        percent = round((total / max_total) * 100, 1) if any_score and max_total else None
        out.append({**sub, "subject_code": public_subject_code(sub.get("subject_code")), "components": populated, "total": round(total, 1) if any_score else None, "max_total": max_total or None, "percent": percent})
    pcts = [s["percent"] for s in out if s["percent"] is not None]
    overall = round(sum(pcts) / len(pcts), 1) if pcts else None
    return {"term": {"id": term["id"], "name": term["name"]}, "assessment_type": assessment, "subjects": out, "overall_percent": overall, "published_only": bool(published_only)}


def learner_summary(conn, learner):
    school_id = current_school_id_from_conn(conn)
    cls = class_for_learner(conn, learner)
    active = one(conn.execute("SELECT * FROM academic_sessions WHERE school_id=? AND is_active=1 LIMIT 1", (school_id,)))
    term = default_term(conn)
    subjects = scalar(conn, "SELECT COUNT(*) FROM class_subjects WHERE school_id=? AND class_id=?", (school_id, cls["id"]), 0) if cls else 0
    return {
        "profile": {k: learner.get(k) for k in ("id", "user_id", "name", "email", "phone", "admission_no", "class_name", "sex", "date_of_birth", "address", "portrait_path", "relationship")},
        "class": {"id": cls["id"], "name": cls["name"], "grade_level": cls.get("grade_level"), "class_teacher_name": cls.get("class_teacher_name"), "template_name": cls.get("template_name")} if cls else None,
        "current_session": {"id": active["id"], "name": active["name"]} if active else None,
        "current_term": {"id": term["id"], "name": term["name"], "term_number": term.get("term_number"), "start_date": term["start_date"], "end_date": term["end_date"]} if term else None,
        "current_assessment": detect_assessment(term),
        "attendance_summary": attendance_summary(conn, learner["id"], cls["id"], term["id"]) if cls and term else None,
        "subjects_count": subjects,
    }


def teacher_class_lists(conn, teacher_id):
    school_id = current_school_id_from_conn(conn)
    homeroom = rows(conn.execute(
        """SELECT id, name, grade_level,
             (SELECT COUNT(*) FROM users u WHERE u.school_id=? AND u.role='learner' AND u.class_name=classes.name AND u.status='active') AS enrollment_count
           FROM classes WHERE school_id=? AND class_teacher_id=? ORDER BY name""",
        (school_id, school_id, teacher_id),
    ))
    subjects = rows(conn.execute(
        """SELECT c.id AS class_id, c.name AS class_name, s.id AS subject_id, s.name AS subject_name, s.code AS subject_code,
             (SELECT COUNT(*) FROM users u WHERE u.school_id=? AND u.role='learner' AND u.class_name=c.name AND u.status='active') AS enrollment_count
           FROM class_subjects cs
           JOIN classes c ON c.id=cs.class_id
           JOIN subjects s ON s.id=cs.subject_id
           WHERE cs.school_id=? AND cs.teacher_id=? ORDER BY c.name, s.name""",
        (school_id, school_id, teacher_id),
    ))
    for row in subjects:
        row["subject_code"] = public_subject_code(row.get("subject_code"))
    return homeroom, subjects


def require_owned_class(conn, user, class_id):
    school_id = current_school_id_from_conn(conn)
    return one(conn.execute("SELECT id, name FROM classes WHERE id=? AND school_id=? AND class_teacher_id=?", (class_id, school_id, user["id"])))


def require_owned_subject(conn, user, class_id, subject_id):
    school_id = current_school_id_from_conn(conn)
    cls = one(conn.execute("SELECT id, name FROM classes WHERE id=? AND school_id=?", (class_id, school_id)))
    if not cls:
        return None
    link = one(conn.execute(
        "SELECT 1 FROM class_subjects WHERE school_id=? AND class_id=? AND subject_id=? AND teacher_id=?",
        (school_id, class_id, subject_id, user["id"]),
    ))
    return cls if link else None


def subject_percent_map(conn, class_id, subject_id, term_id, assessment, published_only=False):
    school_id = current_school_id_from_conn(conn)
    if published_only and not subject_is_published(conn, class_id, subject_id, term_id, assessment):
        return {}
    comps = assessment_components(conn, class_id, subject_id, assessment)
    max_total = sum(float(c["max_score"] or 0) for c in comps)
    if not max_total:
        return {}
    raw = rows(conn.execute(
        """SELECT learner_id, component_key, score FROM marks
           WHERE school_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=?""",
        (school_id, class_id, subject_id, term_id, assessment),
    ))
    by_lid = {}
    for r in raw:
        if r["score"] is None:
            continue
        by_lid.setdefault(r["learner_id"], 0.0)
        by_lid[r["learner_id"]] += float(r["score"])
    return {lid: round((score / max_total) * 100, 1) for lid, score in by_lid.items()}


def broadsheet(conn, cls, term_id, published_only=False):
    school_id = current_school_id_from_conn(conn)
    subjects = rows(conn.execute(
        """SELECT s.id, s.name, s.code FROM class_subjects cs
           JOIN subjects s ON s.id=cs.subject_id WHERE cs.school_id=? AND cs.class_id=? ORDER BY s.name""",
        (school_id, cls["id"]),
    ))
    for s in subjects:
        s["code"] = public_subject_code(s.get("code"))
    learners = rows(conn.execute(
        """SELECT id, name, admission_no, user_id, sex FROM users
           WHERE school_id=? AND role='learner' AND status='active' AND class_name=? ORDER BY name""",
        (school_id, cls["name"]),
    ))
    if published_only:
        marks = rows(conn.execute(
            """SELECT m.* FROM marks m
               JOIN marks_publications mp
                 ON mp.class_id=m.class_id AND mp.subject_id=m.subject_id
                AND mp.term_id=m.term_id AND mp.assessment_type=m.assessment_type
               WHERE m.school_id=? AND m.class_id=? AND m.term_id=? AND mp.status='published'""",
            (school_id, cls["id"], term_id),
        ))
    else:
        marks = rows(conn.execute("SELECT * FROM marks WHERE school_id=? AND class_id=? AND term_id=?", (school_id, cls["id"], term_id)))
    agg = {}
    for m in marks:
        if m["score"] is None:
            continue
        agg.setdefault(m["learner_id"], {}).setdefault(m["subject_id"], {}).setdefault(m["assessment_type"], 0.0)
        agg[m["learner_id"]][m["subject_id"]][m["assessment_type"]] += float(m["score"])
    out = []
    for l in learners:
        sub_scores = []
        for s in subjects:
            scores = agg.get(l["id"], {}).get(s["id"], {})
            vals = [scores.get("midterm"), scores.get("endterm")]
            known = [float(v) for v in vals if v is not None]
            avg = round(sum(known) / len(known), 1) if known else None
            sub_scores.append({"subject_id": s["id"], "midterm": scores.get("midterm"), "endterm": scores.get("endterm"), "average": avg, "cbc": cbc_level(avg)})
        entered = [x["average"] for x in sub_scores if x["average"] is not None]
        avg = round(sum(entered) / len(entered), 1) if entered else None
        out.append({**l, "subjects": sub_scores, "total": round(sum(entered), 2) if entered else None, "average": avg, "cbc": cbc_level(avg), "subject_count": len(entered)})
    out.sort(key=lambda r: r["average"] if r["average"] is not None else -1, reverse=True)
    rank = 0
    last = None
    for idx, r in enumerate(out):
        if r["average"] is None:
            r["position"] = None
            continue
        if r["average"] != last:
            rank = idx + 1
            last = r["average"]
        r["position"] = rank
    return subjects, out


def class_name_from_body(conn, body):
    school_id = current_school_id_from_conn(conn)
    class_id = as_int(body_first(body, "class_id", "classId"))
    if class_id:
        cls = one(conn.execute("SELECT name FROM classes WHERE id=? AND school_id=?", (class_id, school_id)))
        if not cls:
            raise ValueError("Class not found")
        return cls["name"]
    value = clean(body_first(body, "class_name", "className"))
    return value or None


def active_learner_ids(conn, class_name):
    school_id = current_school_id_from_conn(conn)
    return {r["id"] for r in rows(conn.execute("SELECT id FROM users WHERE school_id=? AND role='learner' AND status='active' AND class_name=?", (school_id, class_name)))}


def report_payload(conn, cls, term, assessment, selected_ids=None, single_learner_id=None, published_only=False):
    school_id = current_school_id_from_conn(conn)
    class_learners = rows(conn.execute(
        """SELECT id, user_id, name, admission_no, class_name, sex, date_of_birth, portrait_path
           FROM users WHERE school_id=? AND role='learner' AND status='active' AND class_name=? ORDER BY name""",
        (school_id, cls["name"]),
    ))
    allowed = {l["id"] for l in class_learners}
    if single_learner_id:
        learners = [l for l in class_learners if l["id"] == single_learner_id]
    elif selected_ids:
        wanted = {as_int(x) for x in selected_ids if as_int(x)}
        learners = [l for l in class_learners if l["id"] in wanted]
    else:
        learners = class_learners
    subjects = rows(conn.execute(
        """SELECT s.id AS subject_id, s.name AS subject_name, s.code AS subject_code
           FROM class_subjects cs JOIN subjects s ON s.id=cs.subject_id
           WHERE cs.school_id=? AND cs.class_id=? ORDER BY s.name""",
        (school_id, cls["id"]),
    ))
    for sub in subjects:
        sub["subject_code"] = public_subject_code(sub.get("subject_code"))
        comps = rows(conn.execute(
            """SELECT component_key AS key, component_name AS name, max_score AS max
               FROM assessment_components
               WHERE school_id=? AND class_id=? AND subject_id=? AND assessment_type=?
               ORDER BY sort_order, component_name""",
            (school_id, cls["id"], sub["subject_id"], assessment),
        ))
        sub["components"] = [{"key": c["key"], "name": c["name"], "max": float(c["max"] or 0)} for c in comps]
        sub["max_total"] = sum(c["max"] for c in sub["components"]) or None
    if published_only:
        all_marks = rows(conn.execute(
            """SELECT m.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id,
                      s.name AS subject_name, s.code AS subject_code
               FROM marks m
               JOIN users u ON u.id=m.learner_id
               JOIN subjects s ON s.id=m.subject_id
               JOIN marks_publications mp
                 ON mp.class_id=m.class_id AND mp.subject_id=m.subject_id
                AND mp.term_id=m.term_id AND mp.assessment_type=m.assessment_type
               WHERE m.school_id=? AND m.class_id=? AND m.term_id=? AND m.assessment_type=? AND mp.status='published'
               ORDER BY u.name, s.name, m.component_key""",
            (school_id, cls["id"], term["id"], assessment),
        ))
    else:
        all_marks = rows(conn.execute(
            """SELECT m.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id,
                      s.name AS subject_name, s.code AS subject_code
               FROM marks m
               JOIN users u ON u.id=m.learner_id
               JOIN subjects s ON s.id=m.subject_id
               WHERE m.school_id=? AND m.class_id=? AND m.term_id=? AND m.assessment_type=?
               ORDER BY u.name, s.name, m.component_key""",
            (school_id, cls["id"], term["id"], assessment),
        ))
    for m in all_marks:
        m["subject_code"] = public_subject_code(m.get("subject_code"))
    component_defs = rows(conn.execute(
        """SELECT DISTINCT component_key AS key, component_key, component_name AS name, component_name, max_score
           FROM assessment_components WHERE school_id=? AND class_id=? AND assessment_type=?
           ORDER BY sort_order, component_name""",
        (school_id, cls["id"], assessment),
    ))
    opened = scalar(conn, "SELECT COUNT(DISTINCT id) FROM attendance_records WHERE school_id=? AND class_id=? AND term_id=?", (school_id, cls["id"], term["id"]), 0)
    att_rows = rows(conn.execute(
        """SELECT u.id,
                  SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
                  SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
                  SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
           FROM users u
           LEFT JOIN attendance_records ar ON ar.class_id=? AND ar.term_id=?
           LEFT JOIN attendance_entries ae ON ae.record_id=ar.id AND ae.learner_id=u.id
           WHERE u.school_id=? AND u.role='learner' AND u.status='active' AND u.class_name=?
           GROUP BY u.id""",
        (cls["id"], term["id"], school_id, cls["name"]),
    ))
    attendance_summary = {"opened": opened or None, "learners": {}}
    for r in att_rows:
        attendance_summary["learners"][str(r["id"])] = {"opened": opened or None, "present": int(r.get("present") or 0) if opened else None, "absent": int(r.get("absent") or 0) if opened else None, "late": int(r.get("late") or 0) if opened else None}
    skill_rows = rows(conn.execute("SELECT learner_id, category_key, item_key, rating FROM learner_skills WHERE school_id=? AND term_id=? AND assessment_type=?", (school_id, term["id"], assessment)))
    skill_ratings = {}
    for r in skill_rows:
        if r["learner_id"] not in allowed:
            continue
        skill_ratings.setdefault(str(r["learner_id"]), {}).setdefault(r["category_key"], {})[r["item_key"]] = None if r["rating"] is None else str(r["rating"])
    cls_template = cls.get("template_name") or "Default Template"
    data = {
        "school": {k: v for k, v in school_settings(conn).items() if k.startswith("school_")},
        "class": {"id": cls["id"], "name": cls["name"], "template_name": cls.get("template_name")},
        "term": {"id": term["id"], "name": term["name"], "start_date": term.get("start_date"), "end_date": term.get("end_date")},
        "assessment_type": assessment,
        "template": {"name": cls_template, "state": template_state_for_conn(conn, cls_template)},
        "class_learners": class_learners,
        "all_marks": all_marks,
        "component_defs": component_defs,
        "attendance_summary": attendance_summary,
        "skill_ratings": skill_ratings,
        "subjects": subjects,
        "learners": learners,
        "published_only": bool(published_only),
    }
    if single_learner_id and learners:
        learner = learners[0]
        lm = learner_marks(conn, learner, {"term_id": [term["id"]], "assessment_type": [assessment]}, published_only=published_only)
        att = attendance_summary["learners"].get(str(learner["id"]), {})
        comments = rows(conn.execute("SELECT role, comment_text FROM learner_comments WHERE school_id=? AND learner_id=? AND term_id=? AND assessment_type=? ORDER BY role", (school_id, learner["id"], term["id"], assessment)))
        labels = {"class_teacher": "Class Teacher", "headteacher": "Headteacher", "director": "Director"}
        data.update({
            "learner": learner,
            "subjects": lm.get("subjects", subjects),
            "overall_percent": lm.get("overall_percent"),
            "attendance": {"opened": att.get("opened") or 0, "present": att.get("present") or 0, "absent": att.get("absent") or 0, "late": att.get("late") or 0, "pct": round(((att.get("present") or 0) / (att.get("opened") or 1)) * 100) if att.get("opened") else 0},
            "skills": skill_config_for_class(conn, cls["id"])["categories"],
            "comments": [{"role": r["role"], "role_label": labels.get(r["role"], r["role"]), "text": r["comment_text"] or ""} for r in comments],
        })
    return data


class Handler(SimpleHTTPRequestHandler):
    server_version = "DarajaPython/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def no_store(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")

    def send_json(self, data, status=200):
        raw = json.dumps(data, default=json_default).encode("utf-8")
        self.send_response(status)
        self.security_headers()
        self.no_store()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def send_file_path(self, path: Path, no_store=True, tenant_slug: str | None = None):
        if not path.exists() or not path.is_file():
            self.send_error(404)
            return
        raw = path.read_bytes()
        self.send_response(200)
        self.security_headers()
        if no_store:
            self.no_store()
        if tenant_slug:
            self.set_tenant_cookie(tenant_slug)
        self.send_header("Content-Type", mimetypes.guess_type(str(path))[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def set_tenant_cookie(self, slug: str):
        secure = "; Secure" if IS_PRODUCTION else ""
        self.send_header("Set-Cookie", f"{TENANT_COOKIE}={slugify_school(slug)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={30*24*60*60}{secure}")

    def redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

    def tenant_from_request(self, path: str | None = None, body: dict | None = None) -> dict | None:
        path = path if path is not None else unquote(urlparse(self.path).path)
        first = path.strip("/").split("/", 1)[0] if path.strip("/") else ""
        candidates = []
        if body:
            candidates.extend([body.get("school_slug"), body.get("schoolSlug"), body.get("slug")])
        if first and first not in {"api", "admin", "app", "school", "uploads", "vendor", "template-editor", "login"} and "." not in first:
            candidates.append(first)
        candidates.append(self.headers.get("X-School-Slug"))
        referer = self.headers.get("Referer") or ""
        if referer:
            ref_path = urlparse(referer).path.strip("/").split("/", 1)[0]
            if ref_path:
                candidates.append(ref_path)
        candidates.append(parse_cookie(self.headers.get("Cookie")).get(TENANT_COOKIE, ""))
        with db() as conn:
            for cand in candidates:
                slug = slugify_school(cand or "")
                if not slug:
                    continue
                school = get_school_by_slug(conn, slug)
                if school:
                    return school
        return None

    def tenant_prefix(self, school: dict | None = None) -> str:
        school = school or self.tenant_from_request()
        return f"/{school['slug']}" if school else ""

    def tenant_db(self, school: dict | None = None):
        school = school or self.tenant_from_request()
        return db(int(school["id"]) if school else 1)

    def read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        ctype = self.headers.get("Content-Type", "")
        if "application/json" in ctype:
            try:
                return json.loads(raw or "{}")
            except Exception:
                return {}
        return {k: v[0] if len(v) == 1 else v for k, v in parse_qs(raw).items()}

    def get_session(self):
        sid = unsign(parse_cookie(self.headers.get("Cookie")).get(SESSION_COOKIE, ""))
        if not sid:
            return None
        sess = SESSIONS.get(sid)
        if not sess or sess.get("expires", 0) < time.time():
            SESSIONS.pop(sid, None)
            return None
        sess["expires"] = time.time() + SESSION_TTL
        return sess

    def set_session(self, user):
        sid = secrets.token_urlsafe(32)
        SESSIONS[sid] = {"user": user, "role_users": {user["role"]: user}, "expires": time.time() + SESSION_TTL}
        secure = "; Secure" if IS_PRODUCTION else ""
        cookie = f"{SESSION_COOKIE}={signed(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}{secure}"
        self.send_header("Set-Cookie", cookie)
        if user.get("school_slug"):
            self.set_tenant_cookie(user["school_slug"])

    def set_platform_session(self, owner):
        sid = secrets.token_urlsafe(32)
        SESSIONS[f"platform:{sid}"] = {"owner": owner, "expires": time.time() + SESSION_TTL}
        secure = "; Secure" if IS_PRODUCTION else ""
        self.send_header("Set-Cookie", f"{PLATFORM_COOKIE}={signed(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}{secure}")

    def set_resource_admin_session(self, admin):
        sid = secrets.token_urlsafe(32)
        SESSIONS[f"resource_admin:{sid}"] = {"admin": admin, "expires": time.time() + SESSION_TTL}
        secure = "; Secure" if IS_PRODUCTION else ""
        self.send_header("Set-Cookie", f"{RESOURCE_ADMIN_COOKIE}={signed(sid)}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL}{secure}")

    def current_platform_owner(self):
        sid = unsign(parse_cookie(self.headers.get("Cookie")).get(PLATFORM_COOKIE, ""))
        if not sid:
            return None
        sess = SESSIONS.get(f"platform:{sid}")
        if not sess or sess.get("expires", 0) < time.time():
            SESSIONS.pop(f"platform:{sid}", None)
            return None
        sess["expires"] = time.time() + SESSION_TTL
        return sess.get("owner")

    def current_resource_admin(self):
        sid = unsign(parse_cookie(self.headers.get("Cookie")).get(RESOURCE_ADMIN_COOKIE, ""))
        if not sid:
            return None
        sess = SESSIONS.get(f"resource_admin:{sid}")
        if not sess or sess.get("expires", 0) < time.time():
            SESSIONS.pop(f"resource_admin:{sid}", None)
            return None
        sess["expires"] = time.time() + SESSION_TTL
        return sess.get("admin")

    def clear_session(self):
        sid = unsign(parse_cookie(self.headers.get("Cookie")).get(SESSION_COOKIE, ""))
        if sid:
            SESSIONS.pop(sid, None)
        secure = "; Secure" if IS_PRODUCTION else ""
        self.send_header("Set-Cookie", f"{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}")
        self.send_header("Set-Cookie", f"{TENANT_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}")

    def clear_resource_admin_session(self):
        sid = unsign(parse_cookie(self.headers.get("Cookie")).get(RESOURCE_ADMIN_COOKIE, ""))
        if sid:
            SESSIONS.pop(f"resource_admin:{sid}", None)
        secure = "; Secure" if IS_PRODUCTION else ""
        self.send_header("Set-Cookie", f"{RESOURCE_ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}")

    def current_user(self, role=None):
        sess = self.get_session()
        if not sess:
            return None
        user = sess.get("user")
        if role and user and user.get("role") != role:
            user = sess.get("role_users", {}).get(role)
            if user:
                sess["user"] = user
        if role and (not user or user.get("role") != role):
            return None
        tenant = self.tenant_from_request()
        if tenant and user and user.get("school_id") and int(user.get("school_id")) != int(tenant["id"]):
            return None
        if user and user.get("school_id"):
            with db() as conn:
                school = one(conn.execute("SELECT status, registration_status FROM schools WHERE id=?", (user["school_id"],)))
            if not school or school.get("status") not in ("active", "approved") or school.get("registration_status") not in ("approved", None, ""):
                return None
        return user

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def client_ip(self):
        forwarded = self.headers.get("X-Forwarded-For", "")
        if forwarded:
            return forwarded.split(",", 1)[0].strip()
        return self.client_address[0] if self.client_address else "unknown"

    def login_key(self, identifier):
        return f"{self.client_ip()}:{clean(identifier).lower()}"

    def login_limited(self, identifier):
        key = self.login_key(identifier)
        now = time.time()
        LOGIN_ATTEMPTS[key] = [t for t in LOGIN_ATTEMPTS.get(key, []) if now - t < LOGIN_WINDOW]
        return len(LOGIN_ATTEMPTS[key]) >= LOGIN_LIMIT

    def mark_login_failure(self, identifier):
        key = self.login_key(identifier)
        LOGIN_ATTEMPTS.setdefault(key, []).append(time.time())

    def clear_login_failures(self, identifier):
        LOGIN_ATTEMPTS.pop(self.login_key(identifier), None)

    def public_schools(self, query):
        q = clean(query_first(query, "q", "search")).lower()
        code = clean(query_first(query, "code", "school_code"))
        where = ["status='active'"]
        args = []
        if q:
            where.append("(LOWER(name) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(school_code) LIKE ?)")
            args.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
        if code:
            where.append("UPPER(school_code)=UPPER(?)")
            args.append(code)
        with db() as conn:
            data = rows(conn.execute(
                f"""SELECT id,name,slug,school_code,email,phone,address,county,country,logo_url,status,created_at
                    FROM schools WHERE {' AND '.join(where)} ORDER BY name LIMIT 50""",
                args,
            ))
        return self.send_json({"success": True, "data": data})

    def register_school(self):
        body = self.read_body()
        reg_key = f"{self.client_ip()}:register"
        now = time.time()
        REGISTRATION_ATTEMPTS[reg_key] = [t for t in REGISTRATION_ATTEMPTS.get(reg_key, []) if now - t < LOGIN_WINDOW]
        if len(REGISTRATION_ATTEMPTS[reg_key]) >= REGISTRATION_LIMIT:
            return self.send_json({"success": False, "message": "Too many school registration attempts. Try again later."}, 429)
        name = clean(body.get("name") or body.get("school_name"))
        school_code = re.sub(r"[^A-Za-z0-9]+", "", clean(body.get("school_code") or body.get("schoolCode"))).upper()[:12]
        slug = slugify_school(body.get("slug") or name)
        owner_name = clean(body.get("owner_name") or body.get("ownerName"))
        owner_email = clean(body.get("owner_email") or body.get("ownerEmail")).lower()
        owner_phone = clean(body.get("owner_phone") or body.get("ownerPhone"))
        password = clean(body.get("password"))
        if not all([name, school_code, slug, owner_name, password]) or not (owner_email or owner_phone):
            return self.send_json({"success": False, "message": "School name, code, slug, owner contact, and password are required."}, 400)
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])?", slug):
            return self.send_json({"success": False, "message": "Portal slug must use lowercase letters, numbers, and hyphens."}, 400)
        if slug in {"api", "admin", "app", "school", "uploads", "vendor", "login", "platform", "template-editor"}:
            return self.send_json({"success": False, "message": "That portal slug is reserved."}, 400)
        if len(password) < 8:
            return self.send_json({"success": False, "message": "Password must be at least 8 characters."}, 400)
        REGISTRATION_ATTEMPTS.setdefault(reg_key, []).append(now)
        auto_approve = clean(os.environ.get("AUTO_APPROVE_SCHOOLS")).lower() in ("1", "true", "yes")
        status = "active" if auto_approve else "pending"
        registration_status = "approved" if auto_approve else "pending"
        with db() as conn:
            if one(conn.execute("SELECT id FROM schools WHERE slug=? OR UPPER(school_code)=UPPER(?) OR LOWER(name)=LOWER(?)", (slug, school_code, name))):
                return self.send_json({"success": False, "message": "School slug or code is already in use."}, 409)
            cur = conn.execute(
                """INSERT INTO schools(name,slug,school_code,email,phone,address,county,country,logo_url,status,registration_status,curriculum,center_code,website,created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))""",
                (
                    name,
                    slug,
                    school_code,
                    clean(body.get("email")).lower() or owner_email,
                    clean(body.get("phone")) or owner_phone,
                    clean(body.get("address")),
                    clean(body.get("county")),
                    clean(body.get("country")) or "Kenya",
                    clean(body.get("logo_url")),
                    status,
                    registration_status,
                    clean(body.get("curriculum")),
                    clean(body.get("center_code") or body.get("centerCode")),
                    clean(body.get("website")),
                ),
            )
            school_id = cur.lastrowid
            for role, perms in DEFAULT_ROLE_PERMISSIONS.items():
                for perm in perms:
                    conn.execute("INSERT OR IGNORE INTO school_role_permissions(school_id,role,permission) VALUES(?,?,?)", (school_id, role, perm))
            conn.execute(
                """INSERT INTO tenant_school_settings(school_id,key,value,updated_at)
                   VALUES(?,?,?,datetime('now'))""",
                (school_id, "school_name", name),
            )
            conn.execute(
                """INSERT INTO tenant_school_settings(school_id,key,value,updated_at)
                   VALUES(?,?,?,datetime('now'))""",
                (school_id, "school_email", clean(body.get("email")).lower() or owner_email),
            )
            conn.execute(
                """INSERT INTO academic_sessions(school_id,year,name,is_active,created_at)
                   VALUES(?,?,?,?,datetime('now'))""",
                (school_id, str(datetime.now().year), f"{datetime.now().year} Academic Year", 1),
            )
            admin_code = f"{school_code}-ADM-0001"
            conn.execute(
                """INSERT INTO users(school_id,user_id,name,email,phone,password,role,is_admin,status,created_at,updated_at)
                   VALUES(?,?,?,?,?,?, 'admin',1,'active',datetime('now'),datetime('now'))""",
                (school_id, admin_code, owner_name, owner_email or None, owner_phone or None, hash_password(password)),
            )
            school = one(conn.execute("SELECT * FROM schools WHERE id=?", (school_id,)))
            self.audit_log(conn, school_id, "public", None, "school_registered", "school", str(school_id), {"status": registration_status})
        login_path = f"/{slug}/login"
        email_sent = send_school_registration_email(
            owner_email,
            school_name=name,
            school_code=school_code,
            owner_code=admin_code,
            login_path=login_path,
            status=registration_status,
        ) if owner_email else False
        return self.send_json({"success": True, "data": {"school": school, "login": login_path, "owner_user_id": admin_code, "registration_status": registration_status, "email_sent": email_sent}}, 201)

    def audit_log(self, conn, school_id, actor_role, actor_id, action, target_type=None, target_id=None, details=None):
        if not self.table_exists(conn, "tenant_audit_log"):
            return
        conn.execute(
            """INSERT INTO tenant_audit_log(school_id,actor_role,actor_id,action,target_type,target_id,ip,details_json,created_at)
               VALUES(?,?,?,?,?,?,?,?,datetime('now'))""",
            (school_id, actor_role, actor_id, action, target_type, target_id, self.client_ip(), json.dumps(details or {})),
        )

    def platform_login(self):
        body = self.read_body()
        email = clean(body.get("email")).lower()
        password = clean(body.get("password"))
        if not email or not password:
            return self.send_json({"success": False, "message": "Email and password are required."}, 400)
        with db() as conn:
            owner = one(conn.execute("SELECT * FROM platform_owners WHERE email=? AND status='active'", (email,)))
            if not owner or not verify_password(password, owner.get("password", "")):
                return self.send_json({"success": False, "message": "Invalid platform owner credentials."}, 401)
            session_owner = {"id": owner["id"], "email": owner["email"], "name": owner.get("name") or "Platform Owner", "role": "platform_owner"}
            raw = json.dumps({"success": True, "owner": session_owner}).encode()
            self.send_response(200)
            self.security_headers()
            self.no_store()
            self.set_platform_session(session_owner)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def resource_admin_login(self):
        body = self.read_body()
        username = clean(body.get("username") or body.get("user")).lower()
        password = clean(body.get("password"))
        identifier = f"resource-admin:{username or 'blank'}"
        if not username or not password:
            return self.send_json({"success": False, "message": "Username and password are required."}, 400)
        if self.login_limited(identifier):
            return self.send_json({"success": False, "message": "Too many login attempts. Try again later."}, 429)
        valid_user = hmac.compare_digest(username, RESOURCE_ADMIN_USERNAME.lower())
        valid_password = hmac.compare_digest(password, RESOURCE_ADMIN_PASSWORD)
        if not (valid_user and valid_password):
            self.mark_login_failure(identifier)
            return self.send_json({"success": False, "message": "Invalid resource admin credentials."}, 401)
        self.clear_login_failures(identifier)
        admin = {"id": 1, "username": RESOURCE_ADMIN_USERNAME, "name": "Resource Admin", "role": "resource_admin", "school_id": 1}
        raw = json.dumps({"success": True, "data": {"admin": admin}, "admin": admin}).encode("utf-8")
        self.send_response(200)
        self.security_headers()
        self.no_store()
        self.set_resource_admin_session(admin)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def resource_admin_logout(self):
        raw = b'{"success":true}'
        self.send_response(200)
        self.security_headers()
        self.no_store()
        self.clear_resource_admin_session()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def platform_api(self, method, path, query, owner):
        with db() as conn:
            if path == "/api/platform/metrics" and method == "GET":
                data = {
                    "total_schools": scalar(conn, "SELECT COUNT(*) FROM schools", (), 0),
                    "active_schools": scalar(conn, "SELECT COUNT(*) FROM schools WHERE status IN ('active','approved')", (), 0),
                    "pending_schools": scalar(conn, "SELECT COUNT(*) FROM schools WHERE registration_status='pending'", (), 0),
                    "suspended_schools": scalar(conn, "SELECT COUNT(*) FROM schools WHERE status='suspended'", (), 0),
                    "total_learners": scalar(conn, "SELECT COUNT(*) FROM users WHERE role='learner'", (), 0),
                    "total_staff": scalar(conn, "SELECT COUNT(*) FROM users WHERE role IN ('teacher','admin') OR is_admin=1", (), 0),
                    "monthly_registrations": rows(conn.execute("SELECT substr(created_at,1,7) AS month, COUNT(*) AS count FROM schools GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 12")),
                }
                return self.send_json({"success": True, "data": data})
            if path == "/api/platform/schools" and method == "GET":
                q = clean(query_first(query, "q", "search")).lower()
                where, args = ["1=1"], []
                if q:
                    where.append("(LOWER(name) LIKE ? OR LOWER(slug) LIKE ? OR LOWER(school_code) LIKE ?)")
                    args.extend([f"%{q}%", f"%{q}%", f"%{q}%"])
                schools = rows(conn.execute(f"""SELECT s.*,
                    (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND u.role='learner') AS learners,
                    (SELECT COUNT(*) FROM users u WHERE u.school_id=s.id AND (u.role='teacher' OR u.role='admin' OR u.is_admin=1)) AS staff
                    FROM schools s WHERE {' AND '.join(where)} ORDER BY datetime(s.created_at) DESC, s.id DESC LIMIT 200""", args))
                return self.send_json({"success": True, "data": schools})
            if path.startswith("/api/platform/schools/"):
                parts = path.split("/")
                school_id = as_int(parts[4] if len(parts) > 4 else None)
                school = one(conn.execute("SELECT * FROM schools WHERE id=?", (school_id,))) if school_id else None
                if not school:
                    return self.send_json({"success": False, "message": "School not found."}, 404)
                if len(parts) == 5 and method == "GET":
                    stats = {
                        "learners": scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND role='learner'", (school_id,), 0),
                        "staff": scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND (role='teacher' OR role='admin' OR is_admin=1)", (school_id,), 0),
                        "classes": scalar(conn, "SELECT COUNT(*) FROM classes WHERE school_id=?", (school_id,), 0),
                        "marks": scalar(conn, "SELECT COUNT(*) FROM marks WHERE school_id=?", (school_id,), 0),
                    }
                    return self.send_json({"success": True, "data": {"school": school, "stats": stats}})
                action = parts[5] if len(parts) > 5 else ""
                if action in ("approve", "activate") and method == "POST":
                    conn.execute("UPDATE schools SET status='active', registration_status='approved', approved_by=?, approved_at=datetime('now'), updated_at=datetime('now') WHERE id=?", (owner["id"], school_id))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "school_approved", "school", str(school_id))
                    return self.send_json({"success": True, "message": "School approved."})
                if action == "suspend" and method == "POST":
                    conn.execute("UPDATE schools SET status='suspended', registration_status='suspended', updated_at=datetime('now') WHERE id=?", (school_id,))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "school_suspended", "school", str(school_id))
                    return self.send_json({"success": True, "message": "School suspended."})
                if action == "reject" and method == "POST":
                    conn.execute("UPDATE schools SET status='rejected', registration_status='rejected', updated_at=datetime('now') WHERE id=?", (school_id,))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "school_rejected", "school", str(school_id))
                    return self.send_json({"success": True, "message": "School rejected."})
                if action == "reset-owner-password" and method == "POST":
                    body = self.read_body()
                    new_password = clean(body.get("password")) or secrets.token_urlsafe(10)
                    admin = one(conn.execute("SELECT id,user_id FROM users WHERE school_id=? AND role='admin' ORDER BY id LIMIT 1", (school_id,)))
                    if not admin:
                        return self.send_json({"success": False, "message": "No tenant owner/admin found."}, 404)
                    conn.execute("UPDATE users SET password=?, temp_code=NULL, updated_at=datetime('now') WHERE id=? AND school_id=?", (hash_password(new_password), admin["id"], school_id))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "tenant_owner_password_reset", "user", str(admin["id"]))
                    return self.send_json({"success": True, "data": {"user_id": admin["user_id"], "password": new_password}})
                if len(parts) == 5 and method == "PUT":
                    body = self.read_body()
                    allowed = ["name", "email", "phone", "address", "county", "country", "center_code", "curriculum", "website", "logo_url", "logo"]
                    data = {k: clean(body.get(k)) for k in allowed if k in body}
                    if data:
                        assignments = ", ".join(f"{k}=?" for k in data)
                        conn.execute(f"UPDATE schools SET {assignments}, updated_at=datetime('now') WHERE id=?", (*data.values(), school_id))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "school_profile_updated", "school", str(school_id), data)
                    return self.send_json({"success": True, "data": one(conn.execute("SELECT * FROM schools WHERE id=?", (school_id,)))})
                if len(parts) == 5 and method == "DELETE":
                    conn.execute("UPDATE schools SET status='deleted', registration_status='rejected', updated_at=datetime('now') WHERE id=?", (school_id,))
                    self.audit_log(conn, school_id, "platform_owner", owner["id"], "school_deleted_soft", "school", str(school_id))
                    return self.send_json({"success": True, "message": "School disabled."})
        return self.send_json({"success": False, "message": "Platform route not implemented."}, 404)

    def route(self, method):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)
        try:
            if path.startswith("/api/"):
                return self.api(method, path, query)
            if path == "/":
                return self.redirect("/portal/resources/")
            if path == "/index.html":
                return self.redirect("/portal/resources/")
            if path == "/login":
                return self.send_file_path(PUBLIC_DIR / "login.html")
            if path == "/schools" or path == "/schools/":
                # Civicom Schools Portal landing: find your school / create school.
                return self.send_file_path(PUBLIC_DIR / "index.html")
            if path.startswith("/portal/resources"):
                rel = path.removeprefix("/portal/resources").lstrip("/")
                target = (PORTAL_RES_DIR / rel).resolve() if rel else PORTAL_RES_DIR / "index.html"
                if not str(target).startswith(str(PORTAL_RES_DIR.resolve())):
                    return self.send_error(403)
                if rel and Path(rel).suffix:
                    return self.send_file_path(target, no_store=target.suffix in (".html", ".js", ".css"))
                return self.send_file_path(PORTAL_RES_DIR / "index.html")
            tenant = self.tenant_from_request(path)
            if tenant:
                slug = tenant["slug"]
                rest = path.strip("/").split("/", 1)[1] if "/" in path.strip("/") else ""
                if rest in ("", "login"):
                    return self.send_file_path(PUBLIC_DIR / "login.html", tenant_slug=slug)
                if rest == "admin":
                    if not self.current_user("admin"):
                        return self.redirect(f"/{slug}/login")
                    return self.send_file_path(PUBLIC_DIR / "admin" / "overview.html", tenant_slug=slug)
                if rest.startswith("admin/"):
                    if not self.current_user("admin"):
                        return self.redirect(f"/{slug}/login")
                    rel = rest.removeprefix("admin/")
                    target = (PUBLIC_DIR / "admin" / rel).resolve()
                    if str(target).startswith(str((PUBLIC_DIR / "admin").resolve())) and target.exists():
                        return self.send_file_path(target, no_store=target.suffix in (".html", ".js", ".css"), tenant_slug=slug)
                if rest in ("portal", "learner", "parent", "teacher", "school"):
                    if not self.current_user():
                        return self.redirect(f"/{slug}/login")
                    return self.redirect(f"/{slug}/admin")
            if path == "/admin":
                if not self.current_user("admin"):
                    return self.redirect("/login")
                return self.send_file_path(PUBLIC_DIR / "admin" / "overview.html")
            if path == "/template-editor":
                if not self.current_user("admin"):
                    return self.redirect("/login")
                return self.send_file_path(PUBLIC_DIR / "template-editor.html")
            if path in ("/teacher", "/learner", "/parent"):
                return self.redirect("/login")
            if path.startswith("/school"):
                if not self.current_user():
                    return self.redirect("/login")
                rel = path.removeprefix("/school").lstrip("/")
                if rel and Path(rel).suffix:
                    target = (APP_DIR / rel).resolve()
                    if not str(target).startswith(str(APP_DIR.resolve())):
                        return self.send_error(403)
                    return self.send_file_path(target)
                return self.send_file_path(APP_DIR / "school.html")
            if path.startswith("/app"):
                rel = path.removeprefix("/app").lstrip("/")
                target = (APP_DIR / rel).resolve() if rel else APP_DIR / "index.html"
                if not str(target).startswith(str(APP_DIR.resolve())):
                    return self.send_error(403)
                if rel and Path(rel).suffix:
                    return self.send_file_path(target, no_store=target.suffix in (".html", ".js", ".css"))
                return self.send_file_path(APP_DIR / "index.html")
            if path.startswith("/uploads/"):
                parts = path.strip("/").split("/")
                if len(parts) >= 2 and parts[1] == "resources":
                    rel = Path(*parts[2:]) if len(parts) > 2 else Path()
                    base = (PUBLIC_DIR / "uploads" / "resources").resolve()
                    target = (base / rel).resolve()
                    if not str(target).startswith(str(base)) or not target.exists():
                        return self.send_error(404)
                    return self.send_file_path(target, no_store=False)
                if len(parts) < 3:
                    return self.send_error(403)
                slug = slugify_school(parts[1])
                tenant = self.tenant_from_request(path=f"/{slug}/")
                if not tenant or tenant["slug"] != slug:
                    return self.send_error(404)
                current = self.current_user()
                if current and current.get("school_id") and int(current["school_id"]) != int(tenant["id"]):
                    return self.send_error(403)
                rel = Path(*parts[2:])
                base = (PUBLIC_DIR / "uploads" / slug).resolve()
                target = (base / rel).resolve()
                if not str(target).startswith(str(base)) or not target.exists():
                    return self.send_error(404)
                return self.send_file_path(target, no_store=False)
            target = (PUBLIC_DIR / path.lstrip("/")).resolve()
            if str(target).startswith(str(PUBLIC_DIR.resolve())) and target.exists():
                if path.startswith("/admin/") and target.suffix == ".html" and not self.current_user("admin"):
                    return self.redirect("/")
                return self.send_file_path(target, no_store=target.suffix in (".html", ".js", ".css"))
            return self.send_error(404)
        except sqlite3.Error as err:
            self.log_message("Database error: %s", err)
            message = "A server error occurred." if IS_PRODUCTION else f"Database error: {err}"
            return self.send_json({"success": False, "message": message}, 500)
        except Exception as err:
            self.log_message("Unhandled error: %s", err)
            message = "A server error occurred." if IS_PRODUCTION else str(err)
            return self.send_json({"success": False, "message": message}, 500)

    def api(self, method, path, query):
        if not DB_PATH.exists():
            return self.send_json({"success": False, "message": "Database not found. Run the existing setup once to create data/joyland.db."}, 500)
        if path == "/api/public/schools" and method == "GET":
            return self.public_schools(query)
        if path == "/api/public/register-school" and method == "POST":
            return self.register_school()
        if path.startswith("/api/public/schools/") and method == "GET":
            slug = path.rsplit("/", 1)[-1]
            with db() as conn:
                school = get_school_by_slug(conn, slug)
            if not school:
                return self.send_json({"success": False, "message": "School not found"}, 404)
            return self.send_json({"success": True, "data": school})
        if path == "/api/platform/login" and method == "POST":
            return self.platform_login()
        if path.startswith("/api/platform/"):
            owner = self.current_platform_owner()
            if not owner:
                return self.send_json({"success": False, "message": "Platform owner authentication required."}, 401)
            return self.platform_api(method, path, query, owner)
        if path == "/api/auth/login" and method == "POST":
            return self.login()
        if path == "/api/auth/temp-login" and method == "POST":
            return self.temp_login()
        if path == "/api/auth/logout" and method == "POST":
            self.send_response(200)
            self.security_headers()
            self.no_store()
            self.clear_session()
            raw = b'{"success":true}'
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/api/auth/me" and method == "GET":
            user = self.current_user()
            return self.send_json({"authenticated": bool(user), "user": user} if user else {"authenticated": False})
        if path == "/api/resources" or path.startswith("/api/resources/") or path == "/api/admin/resources" or path.startswith("/api/admin/resources/"):
            return self.send_json({"success": False, "message": "Resource APIs have moved to /api/portal/resources."}, 404)
        if path == "/api/portal/resources" and method == "GET":
            return self.resources(query)
        if path == "/api/portal/resources/popular" and method == "GET":
            return self.resource_collection(query, "popular")
        if path == "/api/portal/resources/featured" and method == "GET":
            return self.resource_collection(query, "featured")
        if path.startswith("/api/portal/resources/") and path.endswith("/download") and method == "POST":
            return self.resource_download(path.strip("/").split("/")[-2])
        if path.startswith("/api/portal/resources/") and method == "GET":
            return self.resource(path.rsplit("/", 1)[-1])
        if path == "/api/portal/resource-submissions" and method == "POST":
            return self.save_public_resource_submission()
        if path == "/api/portal/resource-admin/login" and method == "POST":
            return self.resource_admin_login()
        if path == "/api/portal/resource-admin/logout" and method == "POST":
            return self.resource_admin_logout()
        if path == "/api/portal/resource-admin/me" and method == "GET":
            admin = self.current_resource_admin()
            return self.send_json({"success": True, "authenticated": bool(admin), "data": {"admin": admin}, "admin": admin})
        if path.startswith("/api/portal/resource-admin/"):
            admin = self.current_resource_admin()
            if not admin:
                return self.send_json({"success": False, "message": "Resource admin login required."}, 401)
            with resource_db() as conn:
                if path == "/api/portal/resource-admin/resources" and method == "GET":
                    q = clean(query_first(query, "q", "search", default=""))
                    where = []
                    args = []
                    if q:
                        where.append("(title LIKE ? OR subject LIKE ? OR grade LIKE ? OR type LIKE ? OR CAST(COALESCE(year,'') AS TEXT) LIKE ?)")
                        args.extend([f"%{q}%"] * 5)
                    sql = "SELECT * FROM resources"
                    if where:
                        sql += " WHERE " + " AND ".join(where)
                    sql += " ORDER BY datetime(COALESCE(updated_at,created_at)) DESC, id DESC LIMIT 500"
                    data = rows(conn.execute(sql, args))
                    return self.send_json({"success": True, "data": {"resources": data}, "resources": data})
                if path == "/api/portal/resource-admin/resources" and method == "POST":
                    return self.save_admin_resource(conn, admin)
                if path == "/api/portal/resource-admin/resources/analytics" and method == "GET":
                    return self.admin_resource_analytics(conn)
                if path.startswith("/api/portal/resource-admin/resources/"):
                    try:
                        rid = int(path.rsplit("/", 1)[-1])
                    except ValueError:
                        return self.send_json({"success": False, "message": "Invalid resource"}, 400)
                    if method == "GET":
                        resource = one(conn.execute("SELECT * FROM resources WHERE id=?", (rid,)))
                        if not resource:
                            return self.send_json({"success": False, "message": "Resource not found"}, 404)
                        tags = rows(conn.execute("""SELECT t.* FROM resource_tags t JOIN resource_tag_links rtl ON rtl.tag_id=t.id WHERE rtl.resource_id=? ORDER BY t.name""", (rid,)))
                        return self.send_json({"success": True, "data": {**resource, "tags": tags}})
                    if method == "PUT":
                        return self.save_admin_resource(conn, admin, rid)
                    if method == "DELETE":
                        return self.delete_admin_resource(conn, admin, rid)
                if path == "/api/portal/resource-admin/submissions" and method == "GET":
                    data = rows(conn.execute("SELECT * FROM resource_submissions ORDER BY datetime(created_at) DESC, id DESC"))
                    return self.send_json({"success": True, "data": {"submissions": data}, "submissions": data})
                if path.startswith("/api/portal/resource-admin/submissions/") and method == "PUT":
                    try:
                        submission_id = int(path.rsplit("/", 1)[-1])
                    except ValueError:
                        return self.send_json({"success": False, "message": "Invalid submission"}, 400)
                    return self.update_resource_submission_review(conn, admin, submission_id)
            return self.send_json({"success": False, "message": "Resource admin route not implemented."}, 404)
        if path.startswith("/api/portal/admin/resource-submissions"):
            user = self.current_user("admin")
            if not user:
                return self.send_json({"success": False, "message": "Unauthorized"}, 401)
            with self.tenant_db({"id": user.get("school_id") or 1}) as auth_conn:
                if not has_role_permission(auth_conn, user, "settings_write"):
                    return self.send_json({"success": False, "message": "Your role is not allowed to review portal submissions."}, 403)
            with resource_db() as conn:
                if path == "/api/portal/admin/resource-submissions" and method == "GET":
                    data = rows(conn.execute("SELECT * FROM resource_submissions ORDER BY datetime(created_at) DESC, id DESC"))
                    return self.send_json({"success": True, "data": {"submissions": data}})
                if path.startswith("/api/portal/admin/resource-submissions/") and method == "PUT":
                    try:
                        submission_id = int(path.rsplit("/", 1)[-1])
                    except ValueError:
                        return self.send_json({"success": False, "message": "Invalid submission"}, 400)
                    return self.update_resource_submission_review(conn, user, submission_id)
            return self.send_json({"success": False, "message": "Submission review route not implemented"}, 404)
        if path.startswith("/api/portal/admin/resources"):
            user = self.current_user("admin")
            if not user:
                return self.send_json({"success": False, "message": "Unauthorized"}, 401)
            with self.tenant_db({"id": user.get("school_id") or 1}) as auth_conn:
                if not has_role_permission(auth_conn, user, "settings_write"):
                    return self.send_json({"success": False, "message": "Your role is not allowed to manage portal resources."}, 403)
            with resource_db() as conn:
                if path == "/api/portal/admin/resources" and method == "POST":
                    return self.save_admin_resource(conn, user)
                if path == "/api/portal/admin/resources" and method == "GET":
                    data = rows(conn.execute("SELECT * FROM resources ORDER BY datetime(updated_at) DESC, id DESC"))
                    return self.send_json({"success": True, "data": {"resources": data}})
                if path == "/api/portal/admin/resources/analytics" and method == "GET":
                    return self.admin_resource_analytics(conn)
                if path.startswith("/api/portal/admin/resources/"):
                    try:
                        rid = int(path.rsplit("/", 1)[-1])
                    except ValueError:
                        return self.send_json({"success": False, "message": "Invalid resource"}, 400)
                    if method == "PUT":
                        return self.save_admin_resource(conn, user, rid)
                    if method == "DELETE":
                        return self.delete_admin_resource(conn, user, rid)
                    if method == "GET":
                        resource = one(conn.execute("SELECT * FROM resources WHERE id=?", (rid,)))
                        if not resource:
                            return self.send_json({"success": False, "message": "Resource not found"}, 404)
                        tags = rows(conn.execute("""SELECT t.* FROM resource_tags t JOIN resource_tag_links rtl ON rtl.tag_id=t.id WHERE rtl.resource_id=? ORDER BY t.name""", (rid,)))
                        return self.send_json({"success": True, "data": {**resource, "tags": tags}})
            return self.send_json({"success": False, "message": "Portal resource route not implemented"}, 404)
        if path == "/api/school-info" and method == "GET":
            return self.school_info()
        if path.startswith("/api/notifications"):
            user = self.current_user()
            if not user:
                return self.send_json({"success": False, "message": "Unauthorized"}, 401)
            return self.notifications(method, path, query, user)
        if path == "/api/events" and method == "GET":
            if not self.current_user():
                return self.send_json({"success": False, "message": "Unauthorized"}, 401)
            raw = b": connected\n\n"
            self.send_response(200)
            self.security_headers()
            self.no_store()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path.startswith("/api/learner/"):
            user = self.current_user("learner")
            if not user:
                return self.send_json({"success": False, "message": "Learner session expired. Please log in again."}, 401)
            return self.learner(method, path, query, user)
        if path.startswith("/api/parent/"):
            user = self.current_user("parent")
            if not user:
                return self.send_json({"success": False, "message": "Parent session expired. Please log in again."}, 401)
            return self.parent(method, path, query, user)
        if path.startswith("/api/teacher/"):
            user = self.current_user("teacher")
            if not user:
                return self.send_json({"success": False, "message": "Teacher session expired. Please log in again."}, 401)
            return self.teacher(method, path, query, user)
        if path.startswith("/api/admin/"):
            user = self.current_user("admin")
            if not user:
                return self.send_json({"success": False, "message": "Unauthorized"}, 401)
            return self.admin(method, path, query, user)
        return self.send_json({"success": False, "message": "Not implemented in Python backend"}, 404)

    def login(self):
        body = self.read_body()
        identifier = clean(body.get("identifier"))
        password = clean(body.get("password"))
        if not identifier or not password:
            return self.send_json({"success": False, "message": "Please enter your ID and password"})
        if self.login_limited(identifier):
            return self.send_json({"success": False, "message": "Too many failed attempts. Please try again later."}, 429)
        tenant = self.tenant_from_request(body=body)
        if not tenant:
            prefix = identifier.split("-", 1)[0] if "-" in identifier else ""
            if prefix:
                with db() as lookup_conn:
                    tenant = get_school_by_code(lookup_conn, prefix)
        if not tenant:
            return self.send_json({"success": False, "message": "Select a school before signing in."}, 400)
        if tenant.get("status") not in ("active", "approved") or tenant.get("registration_status") not in ("approved", None, ""):
            return self.send_json({"success": False, "message": "This school portal is not approved yet. Contact Civicom support."}, 403)
        with db(int(tenant["id"])) as conn:
            user = one(conn.execute(
                """SELECT * FROM users
                   WHERE school_id=? AND (user_id=? OR public_code=? OR staff_no=? OR email=? OR phone=? OR admission_no=?)
                   LIMIT 1""",
                (tenant["id"], identifier, identifier, identifier, identifier, identifier, identifier),
            ))
            if not user:
                parent = one(conn.execute("SELECT * FROM parent_accounts WHERE school_id=? AND (parent_id=? OR email=? OR phone=?) LIMIT 1", (tenant["id"], identifier, identifier, identifier)))
                if parent:
                    user = {**parent, "user_id": parent["parent_id"], "role": "parent", "is_admin": 0}
            if not user:
                self.mark_login_failure(identifier)
                return self.send_json({"success": False, "message": "User not found. Check your ID, phone, or email."})
            if user.get("status") == "inactive":
                return self.send_json({"success": False, "message": "Your account has been deactivated. Contact admin."})
            if not verify_password(password, user.get("password", "")):
                self.mark_login_failure(identifier)
                return self.send_json({"success": False, "message": "Incorrect password."})
            self.clear_login_failures(identifier)
            role = user["role"]
            session_user = {"id": user["id"], "user_id": user["user_id"], "name": user["name"], "role": role, "original_role": role, "is_admin": user.get("is_admin", 0), "school_id": tenant["id"], "school_slug": tenant["slug"], "school_code": tenant["school_code"]}
            redirect = f"/{tenant['slug']}/admin/overview.html" if role == "admin" else f"/{tenant['slug']}/portal"
            raw = json.dumps({"success": True, "role": role, "name": user["name"], "redirect": redirect}).encode()
            self.send_response(200)
            self.security_headers()
            self.no_store()
            self.set_session(session_user)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def temp_login(self):
        body = self.read_body()
        identifier = clean(body.get("identifier"))
        temp_code = clean(body.get("temp_code")).upper()
        if not identifier or not temp_code:
            return self.send_json({"success": False, "message": "Please enter your ID and temporary code"})
        if self.login_limited(identifier):
            return self.send_json({"success": False, "message": "Too many failed attempts. Please try again later."}, 429)
        tenant = self.tenant_from_request(body=body)
        if not tenant:
            prefix = identifier.split("-", 1)[0] if "-" in identifier else ""
            if prefix:
                with db() as lookup_conn:
                    tenant = get_school_by_code(lookup_conn, prefix)
        if not tenant:
            return self.send_json({"success": False, "message": "Select a school before signing in."}, 400)
        if tenant.get("status") not in ("active", "approved") or tenant.get("registration_status") not in ("approved", None, ""):
            return self.send_json({"success": False, "message": "This school portal is not approved yet. Contact Civicom support."}, 403)
        with db(int(tenant["id"])) as conn:
            user = one(conn.execute(
                """SELECT * FROM users
                   WHERE school_id=? AND (user_id=? OR public_code=? OR staff_no=? OR email=? OR phone=? OR admission_no=?)
                     AND UPPER(COALESCE(temp_code, ''))=?
                     AND (temp_code_expiry IS NULL OR datetime(temp_code_expiry) >= datetime('now'))
                   LIMIT 1""",
                (tenant["id"], identifier, identifier, identifier, identifier, identifier, identifier, temp_code),
            ))
            if not user:
                parent = one(conn.execute(
                    """SELECT * FROM parent_accounts
                       WHERE school_id=? AND (parent_id=? OR email=? OR phone=?)
                         AND UPPER(COALESCE(temp_code, ''))=?
                         AND (temp_code_expiry IS NULL OR datetime(temp_code_expiry) >= datetime('now'))
                       LIMIT 1""",
                    (tenant["id"], identifier, identifier, identifier, temp_code),
                ))
                if parent:
                    user = {**parent, "user_id": parent["parent_id"], "role": "parent", "is_admin": 0}
            if not user:
                self.mark_login_failure(identifier)
                return self.send_json({"success": False, "message": "Invalid or expired temporary code."})
            self.clear_login_failures(identifier)
            if user.get("status") == "inactive":
                return self.send_json({"success": False, "message": "Your account has been deactivated. Contact admin."})
            role = user["role"]
            session_user = {"id": user["id"], "user_id": user["user_id"], "name": user["name"], "role": role, "original_role": role, "is_admin": user.get("is_admin", 0), "school_id": tenant["id"], "school_slug": tenant["slug"], "school_code": tenant["school_code"]}
            redirect = f"/{tenant['slug']}/admin/overview.html" if role == "admin" else f"/{tenant['slug']}/portal"
            raw = json.dumps({"success": True, "role": role, "name": user["name"], "redirect": redirect}).encode()
            self.send_response(200)
            self.security_headers()
            self.no_store()
            self.set_session(session_user)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    def school_info(self):
        defaults = {
            "school_name": "JOYLAND SCHOOLS",
            "school_motto": "Education Is Treasure",
            "school_address": "P.O. Box 123",
            "school_phone": "0700 000 000",
            "school_email": "info@joylandschools.ac.ke",
            "school_logo": "/uploads/school/logo.jpg",
        }
        with self.tenant_db() as conn:
            defaults.update(school_settings(conn))
        fields = ["school_name", "school_motto", "school_logo", "school_address", "school_phone", "school_email"]
        return self.send_json({"success": True, "data": {k: defaults.get(k, "") for k in fields}})

    def resources(self, query):
        where = ["COALESCE(published,0)=1", "COALESCE(status,'published')='published'"]
        args = []
        user = self.current_user()
        typ = normalize_resource_type(query_first(query, "type", default=""))
        if typ and typ != "all":
            where.append("LOWER(REPLACE(type,'-','_'))=?")
            args.append(typ)
        subject = clean(query_first(query, "subject", default=""))
        if subject and subject.lower() != "all":
            # Forgiving match so "Science" finds "Integrated Science"/"Computer Science".
            where.append("(LOWER(subject)=LOWER(?) OR LOWER(COALESCE(subject,'')) LIKE LOWER(?))")
            args.extend([subject, f"%{subject}%"])
        grade = clean(query_first(query, "grade", default=""))
        if grade and grade.lower() != "all":
            where.append("LOWER(grade)=LOWER(?)")
            args.append(grade)
        level = normalize_resource_level(query_first(query, "level", default=""))
        if level and level != "all":
            if level == "teacher":
                where.append("(LOWER(COALESCE(audience,'')) IN ('teacher','everyone') OR LOWER(REPLACE(type,'-','_')) IN ('lesson_plan','scheme','teacher_guide','curriculum_design'))")
            elif level == "cbc":
                where.append("(LOWER(COALESCE(level,'')) IN ('primary','junior_secondary','secondary','cbc') OR LOWER(COALESCE(grade,'')) LIKE 'grade %')")
            elif level == "844":
                where.append("(LOWER(COALESCE(level,''))='844' OR LOWER(COALESCE(grade,'')) LIKE 'form %')")
            elif level == "grade_1_9":
                # Convenience group: CBC Primary (1-6) + Junior School (7-9).
                where.append("LOWER(COALESCE(level,'')) IN ('primary','junior_secondary')")
            else:
                where.append("LOWER(COALESCE(level,''))=?")
                args.append(level)
        audience = clean(query_first(query, "audience", default="")).lower()
        if audience and audience not in ("all", "everyone"):
            where.append("LOWER(COALESCE(audience,'everyone')) IN (?, 'everyone')")
            args.append(audience)
        visibility = clean(query_first(query, "visibility", default="")).lower()
        if visibility and visibility != "all" and (user or visibility == "public"):
            where.append("LOWER(COALESCE(visibility,'public'))=?")
            args.append(visibility)
        elif not user:
            where.append("LOWER(COALESCE(visibility,'public'))='public'")
        if clean(query_first(query, "featured_only", "featured", default="")).lower() in ("1", "true", "yes"):
            where.append("COALESCE(is_featured,0)=1")
        published = clean(query_first(query, "published", default="")).lower()
        if published in ("0", "false", "draft"):
            where = ["COALESCE(published,0)=0 OR COALESCE(status,'published')<>'published'"]
        q = clean(query.get("q", [""])[0])
        if q:
            like = f"%{q}%"
            # Search grade and year too, so "Form 3", "Grade 7" and "2024" clicks resolve.
            where.append("(title LIKE ? OR subject LIKE ? OR body_html LIKE ? OR grade LIKE ? OR CAST(COALESCE(year,'') AS TEXT) LIKE ? OR LOWER(REPLACE(type,'_','-')) LIKE LOWER(?) OR LOWER(REPLACE(type,'-','_')) LIKE LOWER(?))")
            args.extend([like, like, like, like, like, like, like])
        # CBC-only public library: hide TVET/college/diploma resources.
        # Reversible — remove this block to restore TVET listings.
        tvet_terms = ("tvet", "college", "diploma", "certificate", "university")
        tvet_clauses = []
        for term in tvet_terms:
            like = f"%{term}%"
            tvet_clauses.append(
                "(LOWER(COALESCE(grade,'')) NOT LIKE ? AND LOWER(COALESCE(subject,'')) NOT LIKE ? AND LOWER(COALESCE(title,'')) NOT LIKE ?)"
            )
            args.extend([like, like, like])
        where.append("(" + " AND ".join(tvet_clauses) + ")")
        sort = clean(query_first(query, "sort", default="relevance")).lower()
        order = "datetime(updated_at) DESC, id DESC"
        if sort in ("popular", "downloads"):
            order = "COALESCE(downloads_count,0) DESC, COALESCE(views,0) DESC, id DESC"
        elif sort == "newest":
            order = "datetime(COALESCE(updated_at,created_at)) DESC, id DESC"
        with resource_db() as conn:
            data = rows(conn.execute(
                f"""SELECT id, type, title, grade, subject, year, body_html, file_path, views,
                           level, audience, premium, is_featured, is_verified, downloads_count,
                           rating, status, slug, thumbnail, mime_type, file_size, visibility,
                           created_by_school_id, updated_at
                    FROM resources WHERE {' AND '.join(where)}
                    ORDER BY {order} LIMIT 200""",
                args,
            ))
        return self.send_json({"success": True, "data": {"resources": data}, "resources": data})

    def resource_collection(self, query, mode):
        q = dict(query)
        if mode == "featured":
            q["featured_only"] = ["1"]
        if mode == "popular":
            q["sort"] = ["popular"]
        return self.resources(q)

    def resource(self, id_text):
        try:
            rid = int(id_text)
        except ValueError:
            return self.send_json({"success": False, "message": "Invalid resource"}, 400)
        with resource_db() as conn:
            r = one(conn.execute(
                """SELECT * FROM resources
                   WHERE id=? AND COALESCE(published,0)=1 AND COALESCE(status,'published')='published'""",
                (rid,),
            ))
            if not r:
                return self.send_json({"success": False, "message": "Resource not found"}, 404)
            user = self.current_user()
            visibility = clean(r.get("visibility") or "public").lower()
            if visibility != "public" and not user:
                return self.send_json({"success": False, "message": "Login is required for this resource."}, 403)
            if visibility in ("school_only", "tenant", "private") and user and r.get("created_by_school_id") and int(user.get("school_id") or 0) != int(r.get("created_by_school_id") or 0):
                return self.send_json({"success": False, "message": "Resource is not available for this school."}, 403)
            conn.execute("UPDATE resources SET views=COALESCE(views,0)+1 WHERE id=?", (rid,))
            r["views"] = int(r.get("views") or 0) + 1
        return self.send_json({"success": True, "data": r})

    def resource_download(self, id_text):
        try:
            rid = int(id_text)
        except ValueError:
            return self.send_json({"success": False, "message": "Invalid resource"}, 400)
        user = self.current_user()
        with resource_db() as conn:
            r = one(conn.execute(
                """SELECT id,file_path,visibility,created_by_school_id FROM resources
                   WHERE id=? AND COALESCE(published,0)=1 AND COALESCE(status,'published')='published'""",
                (rid,),
            ))
            if not r:
                return self.send_json({"success": False, "message": "Resource not found"}, 404)
            visibility = clean(r.get("visibility") or "public").lower()
            if visibility != "public" and not user:
                return self.send_json({"success": False, "message": "Login is required for this resource."}, 403)
            if visibility in ("school_only", "tenant", "private") and user and r.get("created_by_school_id") and int(user.get("school_id") or 0) != int(r.get("created_by_school_id") or 0):
                return self.send_json({"success": False, "message": "Resource is not available for this school."}, 403)
            conn.execute("UPDATE resources SET downloads_count=COALESCE(downloads_count,0)+1 WHERE id=?", (rid,))
            conn.execute(
                "INSERT INTO resource_downloads(resource_id,user_role,user_id,ip,created_at) VALUES(?,?,?,?,datetime('now'))",
                (rid, user.get("role") if user else None, user.get("id") if user else None, self.client_address[0] if self.client_address else None),
            )
        return self.send_json({"success": True, "data": {"id": rid, "file_path": r.get("file_path")}})

    def notifications(self, method, path, query, user):
        with self.tenant_db({"id": user.get("school_id") or 1}) as conn:
            school_id = current_school_id_from_conn(conn)
            if path == "/api/notifications/unread-count" and method == "GET":
                count = scalar(conn, "SELECT COUNT(*) FROM notification_recipients WHERE school_id=? AND user_role=? AND user_id=? AND NULLIF(read_at, '') IS NULL", (school_id, user["role"], user["id"]), 0) if self.table_exists(conn, "notification_recipients") else 0
                return self.send_json({"success": True, "data": {"unread_count": count}})
            if not self.table_exists(conn, "notifications"):
                empty = {"notifications": []}
                return self.send_json({"success": True, "data": empty if path.endswith(("/history", "/inbox")) else []})
            if path in ("/api/notifications/admin/history", "/api/notifications/") and method == "GET":
                data = rows(conn.execute(
                    """SELECT n.*, u.name AS sender_name, c.name AS class_name,
                              (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.school_id=? AND nr.notification_id=n.id) AS recipients_count,
                              (SELECT COUNT(*) FROM notification_recipients nr WHERE nr.school_id=? AND nr.notification_id=n.id AND NULLIF(nr.read_at, '') IS NOT NULL) AS read_count
                       FROM notifications n
                       LEFT JOIN users u ON u.id=COALESCE(n.created_by_id, 0)
                       LEFT JOIN classes c ON c.id=n.target_class_id
                       WHERE n.school_id=?
                       ORDER BY datetime(n.created_at) DESC, n.id DESC LIMIT 100""",
                    (school_id, school_id, school_id),
                ))
                return self.send_json({"success": True, "data": {"notifications": data}})
            if path == "/api/notifications/inbox" and method == "GET":
                if not self.table_exists(conn, "notification_recipients"):
                    return self.send_json({"success": True, "data": {"notifications": []}})
                data = rows(conn.execute(
                    """SELECT n.*, nr.read_at
                       FROM notification_recipients nr JOIN notifications n ON n.id=nr.notification_id
                       WHERE nr.school_id=? AND n.school_id=? AND nr.user_role=? AND nr.user_id=?
                       ORDER BY datetime(n.created_at) DESC, n.id DESC LIMIT 100""",
                    (school_id, school_id, user["role"], user["id"]),
                ))
                return self.send_json({"success": True, "data": {"notifications": data}})
            if path == "/api/notifications/stats" and method == "GET":
                sent = scalar(conn, "SELECT COUNT(*) FROM notifications WHERE school_id=?", (school_id,), 0)
                recipients = scalar(conn, "SELECT COUNT(*) FROM notification_recipients WHERE school_id=?", (school_id,), 0) if self.table_exists(conn, "notification_recipients") else 0
                read = scalar(conn, "SELECT COUNT(*) FROM notification_recipients WHERE school_id=? AND read_at IS NOT NULL", (school_id,), 0) if self.table_exists(conn, "notification_recipients") else 0
                return self.send_json({"success": True, "data": {"sent": sent, "delivered": 100 if recipients else 0, "readRate": round((read / recipients) * 100) if recipients else 0, "avgResponseMs": 0, "byChannel": {"in-app": 100 if sent else 0, "sms": 0, "email": 0}}})
            if path == "/api/notifications/broadcasts" and method == "POST":
                if user["role"] != "admin":
                    return self.send_json({"success": False, "message": "Unauthorized"}, 403)
                if not has_role_permission(conn, user, "notifications_send"):
                    return self.send_json({"success": False, "message": "Your role is not allowed to send broadcasts."}, 403)
                body = self.read_body()
                title = clean(body.get("subject") or body.get("title"))
                text = clean(body.get("body"))
                if not title or not text:
                    return self.send_json({"success": False, "message": "Subject and message are required"}, 400)
                requested_channels = body.get("channels") if isinstance(body.get("channels"), list) else ["in-app"]
                channels = json.dumps([ch for ch in requested_channels if ch == "in-app"] or ["in-app"])
                audience = clean(body.get("audience")) or "all-parents"
                target_class_id = as_int(body.get("target_class_id"), as_int(audience.split(":")[1] if audience.startswith("class:") and len(audience.split(":")) > 1 else None))
                cols = {r["name"] for r in rows(conn.execute("PRAGMA table_info(notifications)"))}
                payload = {"school_id": school_id, "title": title, "body": text, "audience": audience, "target_class_id": target_class_id, "created_by_role": user["role"], "created_by_id": user["id"], "type": "broadcast", "channels": channels, "sender_id": user["id"]}
                names = [k for k in payload if k in cols]
                cur = conn.execute(f"INSERT INTO notifications ({','.join(names)}) VALUES ({','.join('?' for _ in names)})", [payload[k] for k in names])
                recipients = self.notification_recipients(conn, audience, target_class_id)
                if self.table_exists(conn, "notification_recipients"):
                    for rec in recipients:
                        conn.execute("INSERT INTO notification_recipients (school_id,notification_id,user_role,user_id,read_at,created_at) VALUES (?,?,?,?,?,datetime('now'))", (school_id, cur.lastrowid, rec["role"], rec["id"], None))
                return self.send_json({"success": True, "data": {"id": cur.lastrowid, "recipients": len(recipients)}})
            if path.startswith("/api/notifications/admin/") and method == "DELETE":
                nid = int(path.rsplit("/", 1)[-1])
                conn.execute("DELETE FROM notifications WHERE id=? AND school_id=?", (nid, school_id))
                return self.send_json({"success": True})
            if path.startswith("/api/notifications/read/") and method == "POST":
                nid = int(path.rsplit("/", 1)[-1])
                if self.table_exists(conn, "notification_recipients"):
                    conn.execute("UPDATE notification_recipients SET read_at=datetime('now') WHERE school_id=? AND notification_id=? AND user_role=? AND user_id=?", (school_id, nid, user["role"], user["id"]))
                return self.send_json({"success": True})
        return self.send_json({"success": False, "message": "Notification route not implemented"}, 404)

    def notification_recipients(self, conn, audience, class_id):
        school_id = current_school_id_from_conn(conn)
        audience = clean(audience) or "all-parents"
        if audience == "absent-today":
            today = now_kenya_date()
            if self.table_exists(conn, "attendance_records") and self.table_exists(conn, "attendance_entries") and self.table_exists(conn, "parent_learner_links") and self.table_exists(conn, "parent_accounts"):
                return [{"id": r["id"], "role": "parent"} for r in rows(conn.execute(
                    """SELECT DISTINCT pa.id
                       FROM parent_accounts pa
                       JOIN parent_learner_links pll ON pll.parent_id=pa.id
                       JOIN attendance_entries ae ON ae.learner_id=pll.learner_id
                       JOIN attendance_records ar ON ar.id=ae.record_id
                       WHERE pa.school_id=? AND ar.school_id=? AND pa.status='active' AND ar.date=? AND ae.status IN ('absent','late')""",
                    (school_id, school_id, today),
                ))]
            return []
        direct = []
        for item in [part.strip() for part in audience.split(",") if part.strip()]:
            if ":" not in item:
                continue
            role, raw_id = item.split(":", 1)
            role = role.strip().lower()
            target_id = as_int(raw_id)
            if not target_id:
                continue
            if role in ("learner", "teacher", "admin"):
                rec = one(conn.execute("SELECT id, role FROM users WHERE school_id=? AND id=? AND role=? AND status='active'", (school_id, target_id, role)))
                if rec:
                    direct.append({"id": rec["id"], "role": rec["role"]})
            elif role == "parent" and self.table_exists(conn, "parent_accounts"):
                rec = one(conn.execute("SELECT id FROM parent_accounts WHERE school_id=? AND id=? AND status='active'", (school_id, target_id)))
                if rec:
                    direct.append({"id": rec["id"], "role": "parent"})
        if direct:
            unique = {}
            for rec in direct:
                unique[(rec["role"], rec["id"])] = rec
            return list(unique.values())
        if audience in ("all-teachers", "teachers"):
            return rows(conn.execute("SELECT id, role FROM users WHERE school_id=? AND role='teacher' AND status='active'", (school_id,)))
        if audience in ("all-learners", "learners"):
            return rows(conn.execute("SELECT id, role FROM users WHERE school_id=? AND role='learner' AND status='active'", (school_id,)))
        if audience in ("everyone", "all"):
            return rows(conn.execute("SELECT id, role FROM users WHERE school_id=? AND status='active'", (school_id,)))
        if audience.startswith("class:") and class_id:
            cls = one(conn.execute("SELECT name FROM classes WHERE id=? AND school_id=?", (class_id, school_id)))
            if not cls:
                return []
            target = audience.split(":")[2] if len(audience.split(":")) > 2 else "learners"
            if target in ("parents", "parent", "all-parents") and self.table_exists(conn, "parent_learner_links") and self.table_exists(conn, "parent_accounts"):
                return [{"id": r["id"], "role": "parent"} for r in rows(conn.execute(
                    """SELECT DISTINCT pa.id
                       FROM parent_accounts pa
                       JOIN parent_learner_links pll ON pll.parent_id=pa.id
                       JOIN users u ON u.id=pll.learner_id
                       WHERE pa.school_id=? AND u.school_id=? AND pa.status='active' AND u.role='learner' AND u.status='active' AND u.class_name=?""",
                    (school_id, school_id, cls["name"]),
                ))]
            if target in ("everyone", "all"):
                learners = rows(conn.execute("SELECT id, role FROM users WHERE school_id=? AND role='learner' AND status='active' AND class_name=?", (school_id, cls["name"])))
                parents = [{"id": r["id"], "role": "parent"} for r in rows(conn.execute(
                    """SELECT DISTINCT pa.id
                       FROM parent_accounts pa
                       JOIN parent_learner_links pll ON pll.parent_id=pa.id
                       JOIN users u ON u.id=pll.learner_id
                       WHERE pa.school_id=? AND u.school_id=? AND pa.status='active' AND u.role='learner' AND u.status='active' AND u.class_name=?""",
                    (school_id, school_id, cls["name"]),
                ))] if self.table_exists(conn, "parent_learner_links") and self.table_exists(conn, "parent_accounts") else []
                return learners + parents
            return rows(conn.execute("SELECT id, role FROM users WHERE school_id=? AND role='learner' AND status='active' AND class_name=?", (school_id, cls["name"])))
        if self.table_exists(conn, "parent_accounts"):
            return [{"id": r["id"], "role": "parent"} for r in rows(conn.execute("SELECT id FROM parent_accounts WHERE school_id=? AND status='active'", (school_id,)))]
        return []

    def learner(self, method, path, query, user):
        with self.tenant_db({"id": user.get("school_id") or 1}) as conn:
            learner = one(conn.execute("SELECT * FROM users WHERE id=? AND school_id=?", (user["id"], user.get("school_id") or 1)))
            if path == "/api/learner/summary" and method == "GET":
                return self.send_json({"success": True, "data": learner_summary(conn, learner)})
            if path == "/api/learner/marks" and method == "GET":
                return self.send_json({"success": True, "data": learner_marks(conn, learner, query, published_only=True)})
            if path == "/api/learner/timetable" and method == "GET":
                return self.timetable_for_learner(conn, learner)
            if path == "/api/learner/comments" and method == "GET":
                term = resolve_term(conn, query.get("term_id", [None])[0])
                assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
                comments = rows(conn.execute("SELECT role, comment_text FROM learner_comments WHERE learner_id=? AND term_id=? AND assessment_type=? ORDER BY role", (learner["id"], term["id"] if term else None, assessment))) if term else []
                labels = {"class_teacher": "Class Teacher", "headteacher": "Headteacher", "director": "Director"}
                return self.send_json({"success": True, "data": {"term": {"id": term["id"], "name": term["name"]} if term else None, "assessment_type": assessment, "comments": [{"role": r["role"], "role_label": labels.get(r["role"], r["role"]), "text": r["comment_text"] or ""} for r in comments]}})
            if path == "/api/learner/change-password" and method == "PUT":
                body = self.read_body()
                if not verify_password(body.get("current_password", ""), learner.get("password", "")):
                    return self.send_json({"success": False, "message": "Current password incorrect"})
                conn.execute("UPDATE users SET password=?, temp_code=NULL, updated_at=datetime('now') WHERE id=?", (hash_password(body.get("new_password", "")), learner["id"]))
                return self.send_json({"success": True, "message": "Password changed"})
        return self.send_json({"success": False, "message": "Learner route not implemented"}, 404)

    def timetable_for_learner(self, conn, learner):
        cls = class_for_learner(conn, learner)
        if not cls:
            return self.send_json({"success": False, "message": "Class not found"})
        active = one(conn.execute("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1"))
        if not active:
            return self.send_json({"success": True, "data": {"slots": [], "periods": [], "class_name": learner.get("class_name")}})
        slots = rows(conn.execute(
            """SELECT ts.id, ts.day_of_week, ts.period_no, sub.name AS subject_name, u.name AS teacher_name,
                      COALESCE(r.id, hr.id) AS room_id, COALESCE(r.name, hr.name) AS room_name
               FROM timetable_slots ts
               JOIN classes c ON c.id=ts.class_id
               JOIN subjects sub ON sub.id=ts.subject_id
               LEFT JOIN users u ON u.id=ts.teacher_id
               LEFT JOIN timetable_rooms r ON r.id=ts.room_id
               LEFT JOIN timetable_rooms hr ON hr.home_class_id=c.id AND hr.status='active'
               WHERE ts.generation_id=? AND ts.class_id=?
               ORDER BY ts.day_of_week, ts.period_no""",
            (active["id"], cls["id"]),
        ))
        periods = rows(conn.execute("SELECT * FROM bell_periods WHERE schedule_id=1 ORDER BY period_no"))
        return self.send_json({"success": True, "data": {"slots": slots, "periods": periods, "today": now_kenya_date(), "class_name": learner.get("class_name")}})

    def parent(self, method, path, query, user):
        with self.tenant_db({"id": user.get("school_id") or 1}) as conn:
            if path == "/api/parent/children" and method == "GET":
                children = rows(conn.execute(
                    """SELECT u.*, pll.relationship FROM parent_learner_links pll
                       JOIN users u ON u.id=pll.learner_id
                       WHERE pll.parent_id=? AND u.role='learner' AND u.status='active'
                       ORDER BY u.class_name, u.name""",
                    (user["id"],),
                ))
                out = []
                for child in children:
                    summary = learner_summary(conn, child)
                    marks = learner_marks(conn, child, {"assessment_type": [summary.get("current_assessment") or "midterm"]}, published_only=True)
                    out.append({**summary["profile"], "class": summary["class"], "current_term": summary["current_term"], "current_assessment": summary["current_assessment"], "attendance_summary": summary["attendance_summary"], "subjects_count": summary["subjects_count"], "overall_percent": marks["overall_percent"]})
                return self.send_json({"success": True, "data": {"children": out}})
            if path.startswith("/api/parent/children/") and path.endswith("/marks") and method == "GET":
                child_id = int(path.split("/")[-2])
                child = self.linked_child(conn, user, child_id)
                if not child:
                    return self.send_json({"success": False, "message": "Not your child"}, 403)
                return self.send_json({"success": True, "data": learner_marks(conn, child, query, published_only=True)})
            if path.startswith("/api/parent/children/") and path.endswith("/comments") and method == "GET":
                child_id = int(path.split("/")[-2])
                child = self.linked_child(conn, user, child_id)
                if not child:
                    return self.send_json({"success": False, "message": "Not your child"}, 403)
                term = resolve_term(conn, query.get("term_id", [None])[0])
                assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
                comments = rows(conn.execute("SELECT role, comment_text FROM learner_comments WHERE learner_id=? AND term_id=? AND assessment_type=? ORDER BY role", (child["id"], term["id"] if term else None, assessment))) if term else []
                labels = {"class_teacher": "Class Teacher", "headteacher": "Headteacher", "director": "Director"}
                return self.send_json({"success": True, "data": {"term": {"id": term["id"], "name": term["name"]} if term else None, "assessment_type": assessment, "comments": [{"role": r["role"], "role_label": labels.get(r["role"], r["role"]), "text": r["comment_text"] or ""} for r in comments]}})
            if path == "/api/parent/timetable" and method == "GET":
                child = self.linked_child(conn, user, query.get("child_id", query.get("childId", [None]))[0])
                if not child:
                    return self.send_json({"success": False, "message": "Not your child"}, 403)
                return self.timetable_for_learner(conn, child)
        return self.send_json({"success": False, "message": "Parent route not implemented"}, 404)

    def linked_child(self, conn, user, child_id):
        return one(conn.execute(
            """SELECT u.*, pll.relationship FROM parent_learner_links pll
               JOIN users u ON u.id=pll.learner_id
               WHERE pll.parent_id=? AND pll.learner_id=? AND u.role='learner'""",
            (user["id"], child_id),
        ))

    def teacher(self, method, path, query, user):
        with self.tenant_db({"id": user.get("school_id") or 1}) as conn:
            if path == "/api/teacher/me" and method == "GET":
                u = one(conn.execute("SELECT id,user_id,name,email,phone,subject,status FROM users WHERE id=?", (user["id"],)))
                home, subjects = teacher_class_lists(conn, user["id"])
                u["my_classes"] = home
                u["subject_classes"] = subjects
                return self.send_json({"success": True, "data": u})
            if path == "/api/teacher/teaching" and method == "GET":
                term = default_term(conn)
                _, subjects = teacher_class_lists(conn, user["id"])
                return self.send_json({"success": True, "data": {"teaching": subjects, "current_term": {"id": term["id"], "name": term["name"]} if term else None, "current_assessment": detect_assessment(term)}})
            if path == "/api/teacher/home" and method == "GET":
                term = default_term(conn)
                home, subjects = teacher_class_lists(conn, user["id"])
                if not home and not subjects:
                    return self.send_json({"success": True, "data": {"empty": True, "message": "No classes assigned."}})
                return self.send_json({"success": True, "data": {"context": {"term": {"id": term["id"], "name": term["name"]} if term else None, "assessment": detect_assessment(term), "today": now_kenya_date(), "calendar": {"term_name": term["name"], "week_no": None} if term else None}, "metrics": {}, "insights": [], "marking_progress": {}, "pending_tasks": [], "distribution": {}, "trend": {}, "class_vs_school": [], "champions": [], "watchlist": []}})
            if path == "/api/teacher/timetable" and method == "GET":
                return self.teacher_timetable(conn, user)
            if path == "/api/teacher/attendance/overview" and method == "GET":
                return self.teacher_attendance_overview(conn, user, query)
            if path == "/api/teacher/attendance" and method == "GET":
                class_id = int(query.get("class_id", [0])[0])
                cls = require_owned_class(conn, user, class_id)
                if not cls:
                    return self.send_json({"success": False, "message": "Not your class"}, 403)
                date = clean(query.get("date", [now_kenya_date()])[0])
                record = one(conn.execute("SELECT id FROM attendance_records WHERE class_id=? AND date=? LIMIT 1", (class_id, date)))
                entries = rows(conn.execute("SELECT learner_id, status, note FROM attendance_entries WHERE record_id=?", (record["id"],))) if record else []
                return self.send_json({"success": True, "data": {"date": date, "class": cls, "entries": entries}})
            if path.startswith("/api/teacher/classes/") and path.endswith("/learners") and method == "GET":
                class_id = int(path.split("/")[-2])
                cls = require_owned_class(conn, user, class_id) or one(conn.execute("SELECT c.id, c.name FROM class_subjects cs JOIN classes c ON c.id=cs.class_id WHERE c.id=? AND cs.teacher_id=?", (class_id, user["id"])))
                if not cls:
                    return self.send_json({"success": False, "message": "Not your class"}, 403)
                learners = rows(conn.execute("SELECT id,user_id,name,admission_no,sex,portrait_path AS photo_url FROM users WHERE role='learner' AND class_name=? AND status='active' ORDER BY name", (cls["name"],)))
                return self.send_json({"success": True, "data": {"class": cls, "learners": learners}})
            if path == "/api/teacher/assessment-components" and method == "GET":
                class_id = int(query.get("class_id", [0])[0])
                subject_id = int(query.get("subject_id", [0])[0])
                cls = require_owned_subject(conn, user, class_id, subject_id)
                if not cls:
                    return self.send_json({"success": False, "message": "You do not teach this subject"}, 403)
                assessment = valid_assessment(query.get("assessment_type", [""])[0], "")
                return self.send_json({"success": True, "data": {"components": assessment_components(conn, class_id, subject_id, assessment)}})
            if path == "/api/teacher/marks":
                if method == "GET":
                    return self.teacher_marks(conn, user, query)
                if method == "POST":
                    return self.save_teacher_marks(conn, user)
            if path == "/api/teacher/teaching-analytics" and method == "GET":
                return self.teaching_analytics(conn, user, query)
            if path == "/api/teacher/attendance" and method == "POST":
                return self.save_attendance(conn, user)
            if path == "/api/teacher/broadsheet" and method == "GET":
                class_id = int(query.get("class_id", [0])[0])
                cls = require_owned_class(conn, user, class_id)
                if not cls:
                    return self.send_json({"success": False, "message": "Not your class"}, 403)
                term = resolve_term(conn, query.get("term_id", [None])[0])
                subjects, learners = broadsheet(conn, cls, term["id"])
                return self.send_json({"success": True, "data": {"class": cls, "term": term, "school": school_settings(conn), "subjects": subjects, "learners": learners, "cbc_levels": CBC_LEVELS}})
            if path == "/api/teacher/skills/config" and method == "GET":
                class_id = int(query.get("class_id", [0])[0])
                cls = require_owned_class(conn, user, class_id)
                if not cls:
                    return self.send_json({"success": False, "message": "Not your class"}, 403)
                return self.send_json({"success": True, "data": skill_config_for_class(conn, class_id)})
            if path == "/api/teacher/skills" and method == "GET":
                return self.teacher_skills(conn, user, query)
            if path == "/api/teacher/skills" and method == "POST":
                return self.save_teacher_skills(conn, user)
            if path == "/api/teacher/comments" and method == "GET":
                return self.teacher_comments(conn, user, query)
            if path == "/api/teacher/comments" and method == "POST":
                return self.save_teacher_comments(conn, user)
            if path == "/api/teacher/comments/suggestions" and method == "GET":
                data = rows(conn.execute("SELECT min_score, max_score, comment_text FROM report_comments WHERE role='class_teacher' AND class_id IS NULL ORDER BY max_score DESC")) if self.table_exists(conn, "report_comments") else []
                return self.send_json({"success": True, "data": {"bands": data}})
            if path == "/api/teacher/report-readiness" and method == "GET":
                return self.teacher_report_readiness(conn, user, query)
            if path == "/api/teacher/report-card" and method == "GET":
                return self.teacher_report_card(conn, user, query, batch=False)
            if path == "/api/teacher/report-cards" and method == "GET":
                return self.teacher_report_card(conn, user, query, batch=True)
            if path == "/api/teacher/bookings" and method == "GET":
                if not self.table_exists(conn, "lesson_bookings"):
                    data = []
                else:
                    cols = {r["name"] for r in rows(conn.execute("PRAGMA table_info(lesson_bookings)"))}
                    room_join = "LEFT JOIN timetable_rooms r ON r.id=b.room_id" if "room_id" in cols and self.table_exists(conn, "timetable_rooms") else ""
                    room_select = "r.name AS room_name" if room_join else "NULL AS room_name"
                    data = rows(conn.execute(
                        f"""SELECT b.*, c.name AS class_name, s.name AS subject_name, {room_select}
                            FROM lesson_bookings b
                            JOIN classes c ON c.id=b.class_id
                            JOIN subjects s ON s.id=b.subject_id
                            {room_join}
                            WHERE b.teacher_id=? AND COALESCE(b.status,'pending') <> 'cancelled'
                            ORDER BY date(b.date) DESC, b.period_no""",
                        (user["id"],),
                    ))
                return self.send_json({"success": True, "data": data})
            if path == "/api/teacher/bookings" and method == "POST":
                return self.save_teacher_booking(conn, user)
            if path.startswith("/api/teacher/bookings/") and method == "DELETE":
                bid = int(path.rsplit("/", 1)[-1])
                conn.execute("UPDATE lesson_bookings SET status='cancelled' WHERE id=? AND teacher_id=?", (bid, user["id"]))
                return self.send_json({"success": True, "message": "Booking cancelled"})
            if path == "/api/teacher/timetable/free-slots" and method == "GET":
                home, subjects = teacher_class_lists(conn, user["id"])
                periods = rows(conn.execute("SELECT * FROM bell_periods WHERE schedule_id=1 ORDER BY period_no")) if self.table_exists(conn, "bell_periods") else []
                rooms = rows(conn.execute("SELECT * FROM timetable_rooms WHERE status='active' ORDER BY name")) if self.table_exists(conn, "timetable_rooms") else []
                return self.send_json({"success": True, "data": {"classes": home, "periods": periods, "subjects": subjects, "rooms": rooms, "my_slots": []}})
            if path == "/api/teacher/change-password" and method == "PUT":
                body = self.read_body()
                row = one(conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)))
                if not verify_password(body.get("current_password", ""), row.get("password", "")):
                    return self.send_json({"success": False, "message": "Current password incorrect"})
                conn.execute("UPDATE users SET password=?, temp_code=NULL, updated_at=datetime('now') WHERE id=?", (hash_password(body.get("new_password", "")), user["id"]))
                return self.send_json({"success": True, "message": "Password changed"})
        return self.send_json({"success": False, "message": "Teacher route not implemented"}, 404)

    def admin(self, method, path, query, user):
        with self.tenant_db({"id": user.get("school_id") or 1}) as conn:
            required_permission = admin_permission_for(path, method)
            if required_permission and not has_role_permission(conn, user, required_permission):
                return self.send_json({"success": False, "message": f"Your role is not allowed to perform this action ({required_permission})."}, 403)
            if path.startswith("/api/admin/classes/") and path.endswith("/learners") and method == "GET":
                school_id = current_school_id_from_conn(conn)
                class_id = int(path.split("/")[-2])
                cls = one(conn.execute("SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id)))
                if not cls:
                    return self.send_json({"success": False, "message": "Class not found"}, 404)
                learners = rows(conn.execute("SELECT id,user_id,public_code,name,admission_no,class_name,status,sex,portrait_path FROM users WHERE school_id=? AND role='learner' AND class_name=? ORDER BY admission_no,name", (school_id, cls["name"])))
                return self.send_json({"success": True, "data": {"class": cls, "learners": learners}})
            if path.startswith("/api/admin/learners/") and path.endswith("/profile") and method == "GET":
                school_id = current_school_id_from_conn(conn)
                learner_id = int(path.split("/")[-2])
                learner = one(conn.execute("SELECT * FROM users WHERE id=? AND role='learner' AND school_id=?", (learner_id, school_id)))
                if not learner:
                    return self.send_json({"success": False, "message": "Learner not found"}, 404)
                return self.send_json({"success": True, "data": learner})
            if path == "/api/admin/learners" and method == "POST":
                return self.save_admin_user(conn, "learner")
            if path.startswith("/api/admin/learners/") and method == "PUT":
                return self.save_admin_user(conn, "learner", int(path.rsplit("/", 1)[-1]))
            if path.startswith("/api/admin/learners/") and path.endswith("/status") and method == "PATCH":
                return self.toggle_admin_user(conn, "learner", int(path.split("/")[-2]))
            if path.startswith("/api/admin/learners/") and path.endswith("/temp-code") and method == "POST":
                return self.temp_code_for_user(conn, "learner", int(path.split("/")[-2]))
            if path.startswith("/api/admin/learners/") and method == "DELETE":
                conn.execute("DELETE FROM users WHERE id=? AND role='learner' AND school_id=?", (int(path.rsplit("/", 1)[-1]), current_school_id_from_conn(conn)))
                return self.send_json({"success": True, "message": "Learner deleted"})
            if path == "/api/admin/teachers" and method == "POST":
                return self.save_admin_user(conn, "teacher")
            if path.startswith("/api/admin/teachers/") and method == "PUT":
                return self.save_admin_user(conn, "teacher", int(path.rsplit("/", 1)[-1]))
            if path.startswith("/api/admin/teachers/") and path.endswith("/status") and method == "PATCH":
                return self.toggle_admin_user(conn, "teacher", int(path.split("/")[-2]))
            if path.startswith("/api/admin/teachers/") and path.endswith("/make-admin") and method == "PATCH":
                teacher_id = int(path.split("/")[-2])
                row = one(conn.execute("SELECT is_admin FROM users WHERE id=? AND role='teacher' AND school_id=?", (teacher_id, current_school_id_from_conn(conn))))
                if not row:
                    return self.send_json({"success": False, "message": "Teacher not found"}, 404)
                new_val = 0 if row.get("is_admin") else 1
                conn.execute("UPDATE users SET is_admin=?, updated_at=datetime('now') WHERE id=? AND school_id=?", (new_val, teacher_id, current_school_id_from_conn(conn)))
                return self.send_json({"success": True, "is_admin": new_val})
            if path.startswith("/api/admin/teachers/") and path.endswith("/temp-code") and method == "POST":
                return self.temp_code_for_user(conn, "teacher", int(path.split("/")[-2]))
            if path.startswith("/api/admin/teachers/") and method == "DELETE":
                conn.execute("DELETE FROM users WHERE id=? AND role='teacher' AND school_id=?", (int(path.rsplit("/", 1)[-1]), current_school_id_from_conn(conn)))
                return self.send_json({"success": True, "message": "Teacher deleted"})
            if path == "/api/admin/classes" and method == "POST":
                return self.save_admin_class(conn)
            if path.startswith("/api/admin/classes/") and method == "PUT":
                return self.save_admin_class(conn, int(path.rsplit("/", 1)[-1]))
            if path.startswith("/api/admin/classes/") and method == "DELETE":
                conn.execute("DELETE FROM classes WHERE id=? AND school_id=?", (int(path.rsplit("/", 1)[-1]), current_school_id_from_conn(conn)))
                return self.send_json({"success": True, "message": "Class deleted"})
            if path == "/api/admin/subjects" and method == "POST":
                return self.save_admin_subject(conn)
            if path.startswith("/api/admin/subjects/") and method == "PUT":
                return self.save_admin_subject(conn, int(path.rsplit("/", 1)[-1]))
            if path.startswith("/api/admin/subjects/") and method == "DELETE":
                conn.execute("DELETE FROM subjects WHERE id=? AND school_id=?", (int(path.rsplit("/", 1)[-1]), current_school_id_from_conn(conn)))
                return self.send_json({"success": True, "message": "Subject deleted"})
            if path == "/api/admin/assessment-components" and method == "POST":
                return self.save_assessment_components(conn)
            if path.startswith("/api/admin/assessment-components/") and method == "DELETE":
                conn.execute("DELETE FROM assessment_components WHERE id=? AND school_id=?", (int(path.rsplit("/", 1)[-1]), current_school_id_from_conn(conn)))
                return self.send_json({"success": True})
            if path == "/api/admin/marks" and method == "POST":
                return self.save_admin_marks(conn, user)
            if path == "/api/admin/marks/publish" and method == "POST":
                return self.publish_admin_marks(conn, user)
            if path.startswith("/api/admin/roles/") and path.endswith("/permissions") and method == "PUT":
                return self.save_role_permissions(conn, user, path.split("/")[-2])
            if path == "/api/admin/timetable/settings" and method == "PUT":
                return self.save_timetable_settings(conn)
            if path == "/api/admin/timetable/periods" and method == "POST":
                return self.save_timetable_periods(conn)
            if path == "/api/admin/timetable/lessons" and method == "PUT":
                return self.save_timetable_lessons(conn)
            if path == "/api/admin/timetable/rooms" and method == "POST":
                return self.save_timetable_room(conn)
            if path.startswith("/api/admin/timetable/rooms/") and method in ("PUT", "DELETE"):
                room_id = int(path.rsplit("/", 1)[-1])
                if method == "DELETE":
                    return self.delete_timetable_room(conn, room_id)
                return self.save_timetable_room(conn, room_id)
            if path == "/api/admin/timetable/generate" and method == "POST":
                return self.generate_timetable(conn, user)
            if path.startswith("/api/admin/timetable/generations/") and path.endswith("/publish") and method == "POST":
                return self.publish_timetable_generation(conn, user, int(path.split("/")[-2]))
            if path.startswith("/api/admin/timetable/generations/") and method == "DELETE":
                return self.delete_timetable_generation(conn, int(path.rsplit("/", 1)[-1]))
            if path.startswith("/api/admin/timetable/slots/") and path.endswith("/lock") and method == "POST":
                return self.lock_timetable_slot(conn, int(path.split("/")[-2]))
            if path.startswith("/api/admin/timetable/slots/") and method == "PUT":
                return self.update_timetable_slot(conn, int(path.rsplit("/", 1)[-1]))
            if path == "/api/admin/timetable/slots/swap" and method == "POST":
                return self.swap_timetable_slots(conn)
            if path == "/api/admin/timetable/absences" and method == "POST":
                return self.save_timetable_absence(conn, user)
            if path.startswith("/api/admin/timetable/absences/") and method == "DELETE":
                return self.delete_timetable_absence(conn, int(path.rsplit("/", 1)[-1]))
            if path == "/api/admin/timetable/substitutions" and method == "POST":
                return self.save_timetable_substitution(conn, user)
            if path == "/api/admin/timetable/substitutions/notify" and method == "POST":
                return self.notify_timetable_substitutes(conn, user)
            if path == "/api/admin/timetable/substitutions/notify-parents" and method == "POST":
                return self.notify_timetable_substitution_parents(conn, user)
            if path == "/api/admin/sessions" and method == "POST":
                return self.save_admin_session(conn)
            if path.startswith("/api/admin/sessions/") and path.endswith("/activate") and method == "PATCH":
                return self.activate_admin_session(conn, int(path.split("/")[-2]))
            if path.startswith("/api/admin/sessions/") and path.endswith("/terms") and method == "POST":
                return self.save_admin_term(conn, int(path.split("/")[-2]))
            if path.startswith("/api/admin/sessions/") and method in ("PUT", "DELETE"):
                session_id = int(path.rsplit("/", 1)[-1])
                if method == "PUT":
                    return self.save_admin_session(conn, session_id)
                return self.delete_admin_session(conn, session_id)
            if path.startswith("/api/admin/terms/") and path.endswith("/holidays") and method == "POST":
                return self.save_admin_holiday(conn, int(path.split("/")[-2]))
            if path.startswith("/api/admin/terms/") and method in ("PUT", "DELETE"):
                term_id = int(path.rsplit("/", 1)[-1])
                if method == "PUT":
                    return self.save_admin_term(conn, None, term_id)
                return self.delete_admin_term(conn, term_id)
            if path.startswith("/api/admin/holidays/") and method in ("PUT", "DELETE"):
                holiday_id = int(path.rsplit("/", 1)[-1])
                if method == "PUT":
                    return self.save_admin_holiday(conn, None, holiday_id)
                return self.delete_admin_holiday(conn, holiday_id)
            if path == "/api/admin/calendar/events" and method == "POST":
                return self.save_calendar_event(conn)
            if path.startswith("/api/admin/calendar/events/") and method in ("PUT", "DELETE"):
                event_id = int(path.rsplit("/", 1)[-1])
                if method == "PUT":
                    return self.save_calendar_event(conn, event_id)
                return self.delete_calendar_event(conn, event_id)
            if path == "/api/admin/attendance" and method == "POST":
                return self.save_admin_attendance(conn, user)
            if path == "/api/admin/attendance/bulk" and method == "POST":
                return self.save_admin_attendance(conn, user)
            if path == "/api/admin/skills/ratings" and method == "POST":
                body = self.read_body()
                learner_id = as_int(body_first(body, "learnerId", "learner_id"))
                skill_id = as_int(body_first(body, "skillId", "skill_id"))
                term = resolve_term(conn, body_first(body, "termId", "term_id"))
                rating = as_int(body.get("rating"))
                if not learner_id or not skill_id or not term:
                    return self.send_json({"success": False, "message": "learnerId, skillId and termId are required"}, 400)
                conn.execute("""INSERT INTO skill_ratings (learner_id,skill_id,term_id,rating,rated_by,created_at,updated_at)
                                VALUES (?,?,?,?,?,datetime('now'),datetime('now'))
                                ON CONFLICT(learner_id,skill_id,term_id)
                                DO UPDATE SET rating=excluded.rating, rated_by=excluded.rated_by, updated_at=datetime('now')""", (learner_id, skill_id, term["id"], rating, user["id"]))
                return self.send_json({"success": True, "message": "Skill rating saved"})
            if path == "/api/admin/school-settings" and method == "PUT":
                body = self.read_body()
                saved = {}
                school_id = current_school_id_from_conn(conn)
                for key, value in body.items():
                    k = clean(key)
                    if not k:
                        continue
                    v = "" if value is None else str(value)
                    conn.execute(
                        """INSERT INTO tenant_school_settings (school_id, key, value, updated_at)
                           VALUES (?, ?, ?, datetime('now'))
                           ON CONFLICT(school_id, key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')""",
                        (school_id, k, v),
                    )
                    saved[k] = v
                settings = {r["key"]: r["value"] for r in rows(conn.execute("SELECT key, value FROM tenant_school_settings WHERE school_id=?", (school_id,)))}
                return self.send_json({"success": True, "data": settings, "saved": saved})
            if path == "/api/admin/security/force-logout" and method == "POST":
                current_sid = unsign(parse_cookie(self.headers.get("Cookie")).get(SESSION_COOKIE, ""))
                removed = 0
                for sid, sess in list(SESSIONS.items()):
                    u = sess.get("user") or {}
                    if sid != current_sid and u.get("role") == "admin":
                        SESSIONS.pop(sid, None)
                        removed += 1
                return self.send_json({"success": True, "data": {"logged_out": removed}, "message": f"Logged out {removed} other admin session(s)."})
            if path == "/api/admin/billing/top-up" and method == "POST":
                return self.send_json({"success": False, "message": "Billing top-up is not configured on this server."}, 501)
            if path.startswith("/api/admin/integrations/") and method in ("POST", "PUT", "DELETE"):
                return self.send_json({"success": False, "message": "Integration connect/disconnect is not configured on this server."}, 501)
            if path == "/api/admin/backups" and method == "POST":
                backup_dir = ROOT / "data" / "backups"
                backup_dir.mkdir(parents=True, exist_ok=True)
                stamp = datetime.utcnow().isoformat(timespec="seconds").replace(":", "-")
                target = backup_dir / f"joyland-{stamp}.db"
                with db() as src, sqlite3.connect(target) as dst:
                    src.backup(dst)
                return self.send_json({"success": True, "data": {"filename": target.name, "name": target.name, "size": target.stat().st_size, "date": datetime.fromtimestamp(target.stat().st_mtime).isoformat(), "created_at": datetime.fromtimestamp(target.stat().st_mtime).isoformat()}})
            if path == "/api/admin/school-assets" and method == "POST":
                school_id = current_school_id_from_conn(conn)
                school = one(conn.execute("SELECT slug FROM schools WHERE id=?", (school_id,))) or {"slug": "joyland"}
                body = self.read_body()
                image_data = clean(body.get("image_data"))
                if "," not in image_data:
                    return self.send_json({"success": False, "message": "Invalid image upload."}, 400)
                header, encoded = image_data.split(",", 1)
                match = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64$", header)
                if not match:
                    return self.send_json({"success": False, "message": "Invalid image upload."}, 400)
                try:
                    filename = public_asset_name(body.get("asset_type"), match.group(1).lower())
                    raw = base64.b64decode(encoded, validate=True)
                except Exception as err:
                    return self.send_json({"success": False, "message": str(err)}, 400)
                if len(raw) > 3 * 1024 * 1024:
                    return self.send_json({"success": False, "message": "Image is too large."}, 400)
                asset_dir = tenant_upload_dir(school["slug"], "school")
                target = (asset_dir / filename).resolve()
                if not str(target).startswith(str(asset_dir.resolve())):
                    return self.send_json({"success": False, "message": "Invalid asset path."}, 400)
                target.write_bytes(raw)
                file_path = f"/uploads/{school['slug']}/school/{filename}"
                self.audit_log(conn, school_id, user["role"], user["id"], "school_asset_uploaded", "asset", filename)
                return self.send_json({"success": True, "data": {"file_path": file_path}})
            if path == "/api/admin/templates" and method == "POST":
                school_id = current_school_id_from_conn(conn)
                body = self.read_body()
                state = body.get("state") or {}
                name = safe_template_name(body.get("name") or state.get("template_name") or state.get("name"))
                state["template_name"] = name
                conn.execute(
                    """INSERT INTO report_templates(school_id,name,state_json,created_by,created_at,updated_at)
                       VALUES(?,?,?,?,datetime('now'),datetime('now'))
                       ON CONFLICT(school_id,name) DO UPDATE SET state_json=excluded.state_json, updated_at=datetime('now')""",
                    (school_id, name, json.dumps(state, ensure_ascii=False, indent=2), user["id"]),
                )
                self.audit_log(conn, school_id, user["role"], user["id"], "report_template_saved", "template", name)
                return self.send_json({"success": True, "state": state, "name": name})
            if path.startswith("/api/admin/templates/") and method == "DELETE":
                name = safe_template_name(path.rsplit("/", 1)[-1])
                if name == "Default Template":
                    return self.send_json({"success": False, "message": "Default Template cannot be deleted."}, 400)
                conn.execute("DELETE FROM report_templates WHERE school_id=? AND name=?", (current_school_id_from_conn(conn), name))
                return self.send_json({"success": True})
            if method != "GET":
                return self.send_json({"success": False, "message": "This admin write route has not been ported to Python yet."}, 501)
            if path == "/api/admin/profile":
                return self.send_json({"success": True, "data": user})
            if path == "/api/admin/school-settings":
                return self.send_json({"success": True, "data": school_settings(conn)})
            if path == "/api/admin/stats":
                school_id = current_school_id_from_conn(conn)
                data = {
                    "learners": scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND role='learner'", (school_id,)),
                    "teachers": scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND role='teacher'", (school_id,)),
                    "admins": scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND (role='admin' OR is_admin=1)", (school_id,)),
                    "parents": scalar(conn, "SELECT COUNT(*) FROM parent_accounts WHERE school_id=?", (school_id,)),
                    "classes": scalar(conn, "SELECT COUNT(*) FROM classes WHERE school_id=? AND status='active'", (school_id,)),
                    "subjects": scalar(conn, "SELECT COUNT(*) FROM subjects WHERE school_id=? AND status='active'", (school_id,)),
                }
                data["people"] = data["learners"] + data["teachers"] + data["admins"] + data["parents"]
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/current-period":
                term = default_term(conn)
                return self.send_json({"success": True, "data": {"term": term, "assessment": detect_assessment(term), "today": now_kenya_date()}})
            if path == "/api/admin/learners":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT id,user_id,public_code,name,email,phone,admission_no,class_name,sex,date_of_birth,address,portrait_path,status,created_at,updated_at FROM users WHERE school_id=? AND role='learner' ORDER BY class_name,name", (school_id,)))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/teachers":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT id,user_id,public_code,staff_no,name,email,phone,subject,status,is_admin,created_at,updated_at FROM users WHERE school_id=? AND role='teacher' ORDER BY name", (school_id,)))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/parents":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT id,parent_id,name,email,phone,status,created_at,updated_at FROM parent_accounts WHERE school_id=? ORDER BY name", (school_id,)))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/admins":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute(
                    """SELECT id,user_id,public_code,staff_no,name,email,phone,role,status,is_admin,created_at,updated_at
                       FROM users
                       WHERE school_id=? AND (role='admin' OR is_admin=1)
                       ORDER BY name""",
                    (school_id,),
                ))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/classes":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute(
                    """SELECT c.*, u.name AS class_teacher_name,
                              (SELECT COUNT(*) FROM users l WHERE l.school_id=? AND l.role='learner' AND l.class_name=c.name) AS learner_count
                       FROM classes c LEFT JOIN users u ON u.id=c.class_teacher_id
                       WHERE c.school_id=?
                       ORDER BY c.name""",
                    (school_id, school_id),
                ))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/marks/analysis":
                return self.admin_marks_analysis(conn, query)
            if path == "/api/admin/cohort-tracker":
                return self.admin_cohort_tracker(conn, query)
            if path == "/api/admin/equity-splits":
                return self.admin_equity_splits(conn, query)
            if path == "/api/admin/marks":
                return self.admin_marks(conn, query)
            if path == "/api/admin/marks/broadsheet":
                return self.admin_broadsheet(conn, query)
            if path == "/api/admin/report-card":
                return self.admin_report_card(conn, query, batch=False)
            if path == "/api/admin/report-cards":
                return self.admin_report_card(conn, query, batch=True)
            if path == "/api/admin/attendance":
                return self.admin_attendance(conn, query)
            if path == "/api/admin/attendance/summary":
                return self.admin_attendance_summary(conn, query)
            if path == "/api/admin/roles":
                data = [{"id": role, "name": role.title(), "permissions": role_permissions(conn, role)} for role in ("admin", "teacher", "learner", "parent")]
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/permissions":
                return self.send_json({"success": True, "data": {"permissions": PERMISSION_LABELS, "enforced": ["teacher:marks_write"]}, "permissions": PERMISSION_LABELS})
            if path == "/api/admin/billing/sms-balance":
                return self.send_json({"success": True, "data": {"balance": 0}})
            if path == "/api/admin/integrations":
                return self.send_json({"success": True, "data": []})
            if path == "/api/admin/backups":
                backup_dir = ROOT / "data" / "backups"
                data = [{"filename": p.name, "name": p.name, "size": p.stat().st_size, "date": datetime.fromtimestamp(p.stat().st_mtime).isoformat(), "created_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat()} for p in sorted(backup_dir.glob("*"))] if backup_dir.exists() else []
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/subjects":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT * FROM subjects WHERE school_id=? ORDER BY name", (school_id,)))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/class-subjects":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute(
                    """SELECT cs.*, c.name AS class_name, s.name AS subject_name, u.name AS teacher_name
                       FROM class_subjects cs
                       JOIN classes c ON c.id=cs.class_id
                       JOIN subjects s ON s.id=cs.subject_id
                       LEFT JOIN users u ON u.id=cs.teacher_id
                       WHERE cs.school_id=?
                       ORDER BY c.name, s.name""",
                    (school_id,),
                ))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/sessions":
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT * FROM academic_sessions WHERE school_id=? ORDER BY year DESC, id DESC", (school_id,)))
                terms = rows(conn.execute(
                    """SELECT id, session_id, term_name, term_name AS name, term_number, start_date, end_date
                       FROM terms WHERE school_id=? ORDER BY session_id, term_number, date(start_date)""",
                    (school_id,),
                ))
                by_session = {}
                for term in terms:
                    by_session.setdefault(term.get("session_id"), []).append(term)
                for session in data:
                    session["terms"] = by_session.get(session.get("id"), [])
                return self.send_json({"success": True, "data": data})
            if path.startswith("/api/admin/terms/") and path.endswith("/holidays"):
                term_id = int(path.split("/")[-2])
                data = self.term_holidays(conn, term_id)
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/calendar/events":
                data = self.calendar_events(conn, query)
                return self.send_json({"success": True, "data": data})
            if path.startswith("/api/admin/calendar/events/"):
                self.ensure_calendar_tables(conn)
                event = self.calendar_event(conn, int(path.rsplit("/", 1)[-1]))
                if not event:
                    return self.send_json({"success": False, "message": "Event not found"}, 404)
                return self.send_json({"success": True, "data": event})
            if path == "/api/admin/school-day":
                return self.admin_school_day(conn, query)
            if path == "/api/admin/assessment-components":
                class_id = query_first(query, "class_id", "classId")
                subject_id = query_first(query, "subject_id", "subjectId")
                assessment = query_first(query, "assessment_type", "assessmentType")
                if class_id and subject_id and assessment:
                    data = assessment_components(conn, int(class_id), int(subject_id), valid_assessment(assessment, "midterm"))
                    return self.send_json({"success": True, "data": {"components": data}, "components": data})
                data = rows(conn.execute("SELECT * FROM assessment_components ORDER BY class_id, subject_id, assessment_type, sort_order"))
                school_id = current_school_id_from_conn(conn)
                data = rows(conn.execute("SELECT * FROM assessment_components WHERE school_id=? ORDER BY class_id, subject_id, assessment_type, sort_order", (school_id,)))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/templates":
                school_id = current_school_id_from_conn(conn)
                names = [r["name"] for r in rows(conn.execute("SELECT name FROM report_templates WHERE school_id=? ORDER BY name", (school_id,)))]
                if "Default Template" not in names:
                    names.insert(0, "Default Template")
                data = [{"name": name, "file": f"{name}.json"} for name in names]
                return self.send_json({"success": True, "data": data, "templates": names})
            if path.startswith("/api/admin/templates/"):
                name = safe_template_name(path.rsplit("/", 1)[-1])
                state = template_state_for_conn(conn, name)
                if state:
                    return self.send_json({"success": True, "state": state, "data": state})
                return self.send_json({"success": False, "message": "Template not found"}, 404)
            if path == "/api/admin/timetable/periods":
                data = rows(conn.execute("SELECT * FROM bell_periods WHERE schedule_id=1 ORDER BY period_no"))
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/timetable/settings":
                return self.send_json({"success": True, "data": self.timetable_settings(conn)})
            if path == "/api/admin/timetable/lessons":
                return self.send_json({"success": True, "data": self.timetable_lessons(conn)})
            if path == "/api/admin/timetable/generations":
                return self.send_json({"success": True, "data": self.timetable_generations(conn, include_slots=True)})
            if path == "/api/admin/timetable/grid":
                gen_id = as_int(query_first(query, "generationId", "generation_id"))
                return self.send_json({"success": True, "data": self.timetable_slots(conn, gen_id)})
            if path == "/api/admin/timetable/rooms":
                data = self.timetable_rooms(conn)
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/timetable/rooms/status":
                return self.send_json({"success": True, "data": {"rooms": self.timetable_room_status(conn)}})
            if path == "/api/admin/timetable/workload":
                return self.send_json({"success": True, "data": self.timetable_workload(conn)})
            if path == "/api/admin/timetable/unplaced":
                return self.send_json({"success": True, "data": []})
            if path == "/api/admin/timetable/audit":
                return self.send_json({"success": True, "data": {"issues": [], "message": "No backend timetable audit issues detected."}})
            if path == "/api/admin/timetable/absences":
                return self.send_json({"success": True, "data": self.timetable_absences(conn, query)})
            if path == "/api/admin/timetable/substitutions":
                return self.send_json({"success": True, "data": self.timetable_substitutions(conn, query)})
            if path == "/api/admin/skills":
                data = rows(conn.execute("SELECT id AS skillId, id, name AS label, name, description, level, sort_order FROM skills ORDER BY sort_order, name")) if self.table_exists(conn, "skills") else []
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/skills/ratings":
                learner_id = as_int(query_first(query, "learnerId", "learner_id"))
                term = resolve_term(conn, query_first(query, "termId", "term_id"))
                if not learner_id or not term:
                    return self.send_json({"success": True, "data": []})
                data = rows(conn.execute(
                    """SELECT s.id AS skillId, s.name AS label, s.description, s.level, sr.rating
                       FROM skills s LEFT JOIN skill_ratings sr ON sr.skill_id=s.id AND sr.learner_id=? AND sr.term_id=?
                       ORDER BY s.sort_order, s.name""",
                    (learner_id, term["id"]),
                )) if self.table_exists(conn, "skill_ratings") and self.table_exists(conn, "skills") else []
                return self.send_json({"success": True, "data": data})
            if path == "/api/admin/skills/progress":
                class_id = as_int(query_first(query, "classId", "class_id"))
                term = resolve_term(conn, query_first(query, "termId", "term_id"))
                cls = one(conn.execute("SELECT * FROM classes WHERE id=?", (class_id,))) if class_id else None
                total = scalar(conn, "SELECT COUNT(*) FROM skills", (), 0) if self.table_exists(conn, "skills") else 0
                learners = rows(conn.execute("SELECT id, name FROM users WHERE role='learner' AND status='active' AND class_name=? ORDER BY name", (cls["name"],))) if cls else []
                out = []
                for l in learners:
                    rated = scalar(conn, "SELECT COUNT(*) FROM skill_ratings WHERE learner_id=? AND term_id=? AND rating IS NOT NULL", (l["id"], term["id"]), 0) if term and self.table_exists(conn, "skill_ratings") else 0
                    out.append({"learnerId": l["id"], "id": l["id"], "name": l["name"], "rated": rated, "total": total})
                return self.send_json({"success": True, "data": out})
        return self.send_json({"success": False, "message": "Admin route not implemented in Python backend"}, 404)

    def save_admin_user(self, conn, role, user_id=None):
        school_id = current_school_id_from_conn(conn)
        school = one(conn.execute("SELECT * FROM schools WHERE id=?", (school_id,))) or {"school_code": "JS"}
        school_code = clean(school.get("school_code") or "JS").upper()
        body = self.read_body()
        name = clean(body.get("name"))
        if not name:
            return self.send_json({"success": False, "message": "Name is required"}, 400)
        if role == "learner":
            class_name = class_name_from_body(conn, body)
            fields = {
                "school_id": school_id,
                "name": name,
                "email": clean(body.get("email")) or None,
                "phone": clean(body.get("phone")) or None,
                "admission_no": clean(body.get("admission_no")) or None,
                "class_name": class_name,
                "sex": clean(body.get("sex")) or None,
                "date_of_birth": clean(body.get("date_of_birth")) or None,
                "address": clean(body.get("address")) or None,
            }
            admission = fields["admission_no"] or ""
            if admission and not str(admission).upper().startswith(school_code + "-"):
                fields["public_code"] = f"{school_code}-{admission}"
            prefix = f"{school_code}-"
        else:
            fields = {"school_id": school_id, "name": name, "email": clean(body.get("email")) or None, "phone": clean(body.get("phone")) or None, "subject": clean(body.get("subject")) or None}
            prefix = f"{school_code}-STF-"
        password = clean(body.get("password"))
        if user_id:
            assignments = ", ".join(f"{k}=?" for k in fields)
            conn.execute(f"UPDATE users SET {assignments}, updated_at=datetime('now') WHERE id=? AND role=? AND school_id=?", (*fields.values(), user_id, role, school_id))
            if password:
                conn.execute("UPDATE users SET password=?, temp_code=NULL, updated_at=datetime('now') WHERE id=? AND school_id=?", (hash_password(password), user_id, school_id))
            return self.send_json({"success": True, "message": f"{role.title()} updated"})
        if not password:
            return self.send_json({"success": False, "message": "Password is required"}, 400)
        login_id = gen_login_id(conn, prefix)
        if role != "learner":
            fields["staff_no"] = login_id.replace(f"{school_code}-", "")
            fields["public_code"] = login_id
        elif not fields.get("public_code"):
            fields["public_code"] = login_id
        columns = ["user_id", *fields.keys(), "password", "role", "status"]
        values = [login_id, *fields.values(), hash_password(password), role, "active"]
        placeholders = ",".join("?" for _ in values)
        cur = conn.execute(f"INSERT INTO users ({','.join(columns)}) VALUES ({placeholders})", values)
        return self.send_json({"success": True, "message": f"{role.title()} added", "id": cur.lastrowid, "user_id": login_id})

    def toggle_admin_user(self, conn, role, user_id):
        school_id = current_school_id_from_conn(conn)
        row = one(conn.execute("SELECT status FROM users WHERE id=? AND role=? AND school_id=?", (user_id, role, school_id)))
        if not row:
            return self.send_json({"success": False, "message": "User not found"}, 404)
        status = "inactive" if row.get("status") == "active" else "active"
        conn.execute("UPDATE users SET status=?, updated_at=datetime('now') WHERE id=? AND school_id=?", (status, user_id, school_id))
        return self.send_json({"success": True, "status": status})

    def temp_code_for_user(self, conn, role, user_id):
        school_id = current_school_id_from_conn(conn)
        code = gen_temp_code()
        expiry = (datetime.now(timezone.utc) + timedelta(hours=24)).isoformat()
        conn.execute("UPDATE users SET temp_code=?, temp_code_expiry=?, updated_at=datetime('now') WHERE id=? AND role=? AND school_id=?", (code, expiry, user_id, role, school_id))
        return self.send_json({"success": True, "temp_code": code, "message": "Temporary code generated (valid 24 hours)"})

    def save_admin_class(self, conn, class_id=None):
        school_id = current_school_id_from_conn(conn)
        body = self.read_body()
        name = clean(body.get("name"))
        if not name:
            return self.send_json({"success": False, "message": "Class name is required"}, 400)
        values = (
            name,
            clean(body.get("grade_level")) or name,
            as_int(body.get("class_teacher_id")),
            as_int(body.get("capacity"), 40) or 40,
            clean(body.get("template_name")) or None,
            clean(body.get("status")) or "active",
        )
        if class_id:
            conn.execute("""UPDATE classes SET name=?, grade_level=?, class_teacher_id=?, capacity=?, template_name=?, status=?, updated_at=datetime('now') WHERE id=? AND school_id=?""", (*values, class_id, school_id))
            return self.send_json({"success": True, "message": "Class updated"})
        cur = conn.execute("""INSERT INTO classes (school_id, name, grade_level, class_teacher_id, capacity, template_name, status) VALUES (?,?,?,?,?,?,?)""", (school_id, *values))
        return self.send_json({"success": True, "message": "Class added", "id": cur.lastrowid})

    def save_admin_subject(self, conn, subject_id=None):
        school_id = current_school_id_from_conn(conn)
        body = self.read_body()
        name = clean(body.get("name"))
        if not name:
            return self.send_json({"success": False, "message": "Subject name is required"}, 400)
        values = (name, clean(body.get("code")) or None, clean(body.get("level")) or None, clean(body.get("description")) or None, clean(body.get("status")) or "active")
        if subject_id:
            conn.execute("UPDATE subjects SET name=?, code=?, level=?, description=?, status=?, updated_at=datetime('now') WHERE id=? AND school_id=?", (*values, subject_id, school_id))
            return self.send_json({"success": True, "message": "Subject updated"})
        cur = conn.execute("INSERT INTO subjects (school_id, name, code, level, description, status) VALUES (?,?,?,?,?,?)", (school_id, *values))
        return self.send_json({"success": True, "message": "Subject added", "id": cur.lastrowid})

    def save_public_resource_submission(self):
        body = self.read_body()
        original_filename = safe_upload_filename(body.get("filename") or "", "submitted-resource")
        title = clean(body.get("title")) or Path(original_filename).stem.replace("-", " ").strip() or "Submitted resource"
        title = title[:180]
        typ = normalize_resource_type(body.get("type") or "notes") or "notes"
        grade = clean(body.get("grade"))[:80]
        subject = clean(body.get("subject"))[:80]
        contact = clean(body.get("contact"))[:180]
        note = clean(body.get("note"))[:1200]
        if not body.get("file_data") or not grade or not subject:
            return self.send_json({"success": False, "message": "File, grade/form, and subject are required."}, 400)
        try:
            mime_type, raw = data_url_bytes(body.get("file_data"))
            if mime_type not in ALLOWED_RESOURCE_MIME_TYPES:
                return self.send_json({"success": False, "message": "Unsupported resource file type."}, 400)
            if len(raw) > 25 * 1024 * 1024:
                return self.send_json({"success": False, "message": "Resource file is too large."}, 400)
            filename = original_filename
            if "." not in filename:
                filename += mimetypes.guess_extension(mime_type) or ".bin"
            stem = Path(filename).stem[:80] or slugify_resource(title)
            suffix = Path(filename).suffix or (mimetypes.guess_extension(mime_type) or ".bin")
            stored_name = f"{stem}-{int(time.time())}-{secrets.token_hex(4)}{suffix}"
            target_dir = global_upload_dir("submissions")
            target = (target_dir / stored_name).resolve()
            if not str(target).startswith(str(target_dir.resolve())):
                return self.send_json({"success": False, "message": "Invalid file path."}, 400)
            target.write_bytes(raw)
        except Exception as err:
            return self.send_json({"success": False, "message": str(err)}, 400)

        level = normalize_resource_level(body.get("level")) or infer_resource_level(grade, typ)
        audience = clean(body.get("audience")) or infer_resource_audience(typ)
        file_path = f"/uploads/resources/submissions/{stored_name}"
        with resource_db() as conn:
            cur = conn.execute(
                """INSERT INTO resource_submissions
                   (title,type,grade,subject,level,audience,filename,file_path,file_size,mime_type,contact,note,status,ip,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, datetime('now'), datetime('now'))""",
                (title, typ, grade, subject, level, audience, original_filename, file_path, len(raw), mime_type, contact or None, note or None, self.client_ip()),
            )
            submission = one(conn.execute("SELECT id,title,status,created_at FROM resource_submissions WHERE id=?", (cur.lastrowid,)))
        return self.send_json({"success": True, "data": submission, "message": "Resource received for review."}, 201)

    def update_resource_submission_review(self, conn, user, submission_id):
        body = self.read_body()
        status = clean(body.get("status") or "pending").lower()
        if status not in ("pending", "approved", "rejected", "archived"):
            return self.send_json({"success": False, "message": "Invalid submission status."}, 400)
        submission = one(conn.execute("SELECT * FROM resource_submissions WHERE id=?", (submission_id,)))
        if not submission:
            return self.send_json({"success": False, "message": "Submission not found"}, 404)
        resource_id = submission.get("resource_id")
        if status == "approved" and (body.get("publish") or body.get("publish_resource")) and not resource_id:
            slug = f"{slugify_resource(body.get('slug') or submission.get('title'))}-submission-{submission_id}"
            body_html = _seed_body(
                normalize_resource_type(submission.get("type") or "notes") or "notes",
                clean(submission.get("title")) or "Submitted resource",
            )
            if clean(submission.get("note")):
                body_html += f"<p>{escape_html_text(submission.get('note'))}</p>"
            cur = conn.execute(
                """INSERT INTO resources
                   (type,title,grade,subject,body_html,file_path,published,views,level,audience,
                    status,slug,mime_type,file_size,visibility,is_verified,created_by_user_id,created_at,updated_at)
                   VALUES (?,?,?,?,?,?,1,0,?,?, 'published',?,?,?, 'public',1,?,datetime('now'),datetime('now'))""",
                (
                    normalize_resource_type(submission.get("type") or "notes") or "notes",
                    clean(submission.get("title")) or "Submitted resource",
                    clean(submission.get("grade")),
                    clean(submission.get("subject")) or "General",
                    body_html,
                    clean(submission.get("file_path")) or None,
                    normalize_resource_level(submission.get("level")) or infer_resource_level(submission.get("grade"), submission.get("type")),
                    clean(submission.get("audience")) or infer_resource_audience(submission.get("type")),
                    slug,
                    clean(submission.get("mime_type")) or None,
                    as_int(submission.get("file_size")),
                    user.get("id"),
                ),
            )
            resource_id = cur.lastrowid
        conn.execute(
            """UPDATE resource_submissions
               SET status=?, reviewer_note=?, reviewed_by=?, reviewed_at=datetime('now'), resource_id=?, updated_at=datetime('now')
               WHERE id=?""",
            (status, clean(body.get("reviewer_note"))[:1200] or None, user.get("id"), resource_id, submission_id),
        )
        return self.send_json({"success": True, "data": one(conn.execute("SELECT * FROM resource_submissions WHERE id=?", (submission_id,))), "message": "Submission updated"})

    def save_admin_resource(self, conn, user, resource_id=None):
        ensure_resource_portal_tables(conn)
        body = self.read_body()
        title = clean(body.get("title"))
        typ = normalize_resource_type(body.get("type"))
        if not title or not typ:
            return self.send_json({"success": False, "message": "title and type are required"}, 400)
        visibility = clean(body.get("visibility") or "public").lower()
        if visibility not in ("public", "registered", "premium", "school_only", "tenant", "private"):
            return self.send_json({"success": False, "message": "Invalid resource visibility."}, 400)
        status = clean(body.get("status") or ("published" if body.get("published", 1) else "draft")).lower()
        if status not in ("draft", "published", "archived"):
            return self.send_json({"success": False, "message": "Invalid resource status."}, 400)
        file_path = clean(body.get("file_path"))
        mime_type = clean(body.get("mime_type"))
        file_size = as_int(body.get("file_size"))
        if body.get("file_data"):
            try:
                mime_type, raw = data_url_bytes(body.get("file_data"))
                if mime_type not in ALLOWED_RESOURCE_MIME_TYPES:
                    return self.send_json({"success": False, "message": "Unsupported resource file type."}, 400)
                if len(raw) > 25 * 1024 * 1024:
                    return self.send_json({"success": False, "message": "Resource file is too large."}, 400)
                filename = safe_upload_filename(body.get("filename") or f"{slugify_resource(title)}")
                if "." not in filename:
                    ext = mimetypes.guess_extension(mime_type) or ".bin"
                    filename += ext
                stem = Path(filename).stem[:80] or slugify_resource(title)
                suffix = Path(filename).suffix or (mimetypes.guess_extension(mime_type) or ".bin")
                filename = f"{stem}-{int(time.time())}-{secrets.token_hex(4)}{suffix}"
                target_dir = global_upload_dir()
                target = (target_dir / filename).resolve()
                if not str(target).startswith(str(target_dir.resolve())):
                    return self.send_json({"success": False, "message": "Invalid file path."}, 400)
                target.write_bytes(raw)
                file_path = f"/uploads/resources/{filename}"
                file_size = len(raw)
            except Exception as err:
                return self.send_json({"success": False, "message": str(err)}, 400)
        category_id = as_int(body.get("category_id"))
        category_name = clean(body.get("category"))
        if category_name and not category_id:
            cat_slug = slugify_resource(category_name)
            conn.execute("INSERT OR IGNORE INTO resource_categories(name,slug,created_at) VALUES(?,?,datetime('now'))", (category_name, cat_slug))
            category_id = scalar(conn, "SELECT id FROM resource_categories WHERE slug=?", (cat_slug,), None)
        slug = slugify_resource(body.get("slug") or title)
        if resource_id:
            existing = one(conn.execute("SELECT * FROM resources WHERE id=?", (resource_id,)))
            if not existing:
                return self.send_json({"success": False, "message": "Resource not found"}, 404)
            slug = f"{slug}-{resource_id}" if not clean(body.get("slug")) else slug
            if not file_path:
                file_path = clean(existing.get("file_path"))
            if not mime_type:
                mime_type = clean(existing.get("mime_type"))
            if file_size is None:
                file_size = as_int(existing.get("file_size"))
            created_by_school_id = as_int(body.get("created_by_school_id"), as_int(existing.get("created_by_school_id")) or user.get("school_id"))
            created_by_user_id = as_int(existing.get("created_by_user_id")) or user.get("id")
            fields = {
                "title": title,
                "type": typ,
                "grade": clean(body.get("grade")),
                "subject": clean(body.get("subject")),
                "year": as_int(body.get("year")),
                "body_html": body.get("body_html") or body.get("body") or "",
                "file_path": file_path or None,
                "published": 1 if status == "published" else 0,
                "category_id": category_id,
                "level": normalize_resource_level(body.get("level")) or infer_resource_level(body.get("grade"), typ),
                "audience": clean(body.get("audience")) or infer_resource_audience(typ),
                "premium": 1 if body.get("premium") else 0,
                "is_featured": 1 if body.get("is_featured") or body.get("featured") else 0,
                "is_verified": 1 if body.get("is_verified") or body.get("verified") else 0,
                "status": status,
                "slug": slug,
                "thumbnail": clean(body.get("thumbnail")),
                "mime_type": mime_type,
                "file_size": file_size,
                "visibility": visibility,
                "created_by_school_id": created_by_school_id,
                "created_by_user_id": created_by_user_id,
            }
            assignments = ", ".join(f"{k}=?" for k in fields)
            conn.execute(f"UPDATE resources SET {assignments}, updated_at=datetime('now') WHERE id=?", (*fields.values(), resource_id))
            rid = resource_id
        else:
            fields = {
                "school_id": user.get("school_id") or current_school_id_from_conn(conn),
                "title": title,
                "type": typ,
                "grade": clean(body.get("grade")),
                "subject": clean(body.get("subject")),
                "year": as_int(body.get("year")),
                "body_html": body.get("body_html") or body.get("body") or "",
                "file_path": file_path or None,
                "published": 1 if status == "published" else 0,
                "views": 0,
                "category_id": category_id,
                "level": normalize_resource_level(body.get("level")) or infer_resource_level(body.get("grade"), typ),
                "audience": clean(body.get("audience")) or infer_resource_audience(typ),
                "premium": 1 if body.get("premium") else 0,
                "is_featured": 1 if body.get("is_featured") or body.get("featured") else 0,
                "is_verified": 1 if body.get("is_verified") or body.get("verified") else 0,
                "downloads_count": 0,
                "rating": 0,
                "status": status,
                "slug": slug,
                "thumbnail": clean(body.get("thumbnail")),
                "mime_type": mime_type,
                "file_size": file_size,
                "visibility": visibility,
                "created_by_school_id": as_int(body.get("created_by_school_id")) or user.get("school_id"),
                "created_by_user_id": user.get("id"),
            }
            cols = ",".join(fields)
            cur = conn.execute(f"INSERT INTO resources ({cols},created_at,updated_at) VALUES ({','.join('?' for _ in fields)},datetime('now'),datetime('now'))", list(fields.values()))
            rid = cur.lastrowid
            conn.execute("UPDATE resources SET slug=? WHERE id=? AND (slug IS NULL OR slug='')", (f"{slug}-{rid}", rid))
        self.save_resource_tags(conn, rid, body.get("tags"))
        self.audit_log(conn, user.get("school_id"), user.get("role"), user.get("id"), "resource_saved", "resource", str(rid), {"status": status, "visibility": visibility})
        return self.send_json({"success": True, "data": one(conn.execute("SELECT * FROM resources WHERE id=?", (rid,))), "message": "Resource saved"})

    def save_resource_tags(self, conn, resource_id, tags):
        if not isinstance(tags, list):
            tags = [x.strip() for x in clean(tags).split(",") if x.strip()]
        conn.execute("DELETE FROM resource_tag_links WHERE resource_id=?", (resource_id,))
        for tag in tags or []:
            name = clean(tag)
            if not name:
                continue
            slug = slugify_resource(name)
            conn.execute("INSERT OR IGNORE INTO resource_tags(name,slug,created_at) VALUES(?,?,datetime('now'))", (name, slug))
            tag_id = scalar(conn, "SELECT id FROM resource_tags WHERE slug=?", (slug,), None)
            if tag_id:
                conn.execute("INSERT OR IGNORE INTO resource_tag_links(resource_id,tag_id) VALUES(?,?)", (resource_id, tag_id))

    def delete_admin_resource(self, conn, user, resource_id):
        ensure_resource_portal_tables(conn)
        if not one(conn.execute("SELECT id FROM resources WHERE id=?", (resource_id,))):
            return self.send_json({"success": False, "message": "Resource not found"}, 404)
        conn.execute("UPDATE resources SET status='archived', published=0, updated_at=datetime('now') WHERE id=?", (resource_id,))
        self.audit_log(conn, user.get("school_id"), user.get("role"), user.get("id"), "resource_archived", "resource", str(resource_id))
        return self.send_json({"success": True, "message": "Resource archived"})

    def admin_resource_analytics(self, conn):
        ensure_resource_portal_tables(conn)
        subject_distribution = rows(conn.execute("SELECT COALESCE(subject,'General') AS subject, COUNT(*) AS count FROM resources GROUP BY COALESCE(subject,'General') ORDER BY count DESC"))
        type_distribution = rows(conn.execute("SELECT COALESCE(type,'other') AS type, COUNT(*) AS count FROM resources GROUP BY COALESCE(type,'other') ORDER BY count DESC"))
        top = rows(conn.execute("SELECT id,title,type,subject,views,downloads_count,rating FROM resources ORDER BY COALESCE(downloads_count,0) DESC, COALESCE(views,0) DESC LIMIT 10"))
        trends = rows(conn.execute("SELECT substr(created_at,1,7) AS month, COUNT(*) AS resources FROM resources GROUP BY substr(created_at,1,7) ORDER BY month DESC LIMIT 12"))
        # Engagement time-series from the (timestamped) download log.
        downloads_by_day = rows(conn.execute(
            """WITH RECURSIVE d(day) AS (
                   SELECT date('now','-13 days')
                   UNION ALL SELECT date(day,'+1 day') FROM d WHERE day < date('now')
               )
               SELECT d.day AS day, COUNT(rd.id) AS downloads, COUNT(DISTINCT rd.ip) AS visitors
               FROM d LEFT JOIN resource_downloads rd ON substr(rd.created_at,1,10)=d.day
               GROUP BY d.day ORDER BY d.day"""
        ))
        downloads_by_weekday = rows(conn.execute(
            """SELECT CAST(strftime('%w', created_at) AS INTEGER) AS weekday,
                      COUNT(*) AS downloads, COUNT(DISTINCT ip) AS visitors
               FROM resource_downloads WHERE created_at >= datetime('now','-56 days')
               GROUP BY weekday"""
        ))
        downloads_by_month = rows(conn.execute(
            """SELECT substr(created_at,1,7) AS month, COUNT(*) AS downloads, COUNT(DISTINCT ip) AS visitors
               FROM resource_downloads GROUP BY month ORDER BY month DESC LIMIT 12"""
        ))
        data = {
            "views": scalar(conn, "SELECT COALESCE(SUM(views),0) FROM resources", (), 0),
            "downloads": scalar(conn, "SELECT COALESCE(SUM(downloads_count),0) FROM resources", (), 0),
            "published": scalar(conn, "SELECT COUNT(*) FROM resources WHERE COALESCE(status,'published')='published' AND COALESCE(published,0)=1", (), 0),
            "draft": scalar(conn, "SELECT COUNT(*) FROM resources WHERE COALESCE(status,'published')='draft' OR COALESCE(published,0)=0", (), 0),
            "logged_downloads": scalar(conn, "SELECT COUNT(*) FROM resource_downloads", (), 0),
            "unique_visitors": scalar(conn, "SELECT COUNT(DISTINCT ip) FROM resource_downloads", (), 0),
            "downloads_7d": scalar(conn, "SELECT COUNT(*) FROM resource_downloads WHERE created_at>=datetime('now','-7 days')", (), 0),
            "visitors_7d": scalar(conn, "SELECT COUNT(DISTINCT ip) FROM resource_downloads WHERE created_at>=datetime('now','-7 days')", (), 0),
            "subject_distribution": subject_distribution,
            "type_distribution": type_distribution,
            "top_resources": top,
            "activity_trends": trends,
            "downloads_by_day": downloads_by_day,
            "downloads_by_weekday": downloads_by_weekday,
            "downloads_by_month": downloads_by_month,
        }
        return self.send_json({"success": True, "data": data})

    def save_assessment_components(self, conn):
        school_id = current_school_id_from_conn(conn)
        body = self.read_body()
        class_id = as_int(body_first(body, "class_id", "classId"))
        subject_id = as_int(body_first(body, "subject_id", "subjectId"))
        assessment = valid_assessment(body_first(body, "assessment_type", "assessmentType"), "")
        comps = body.get("components") if isinstance(body.get("components"), list) else []
        if not class_id or not subject_id or not assessment or not comps:
            return self.send_json({"success": False, "message": "class_id, subject_id, assessment_type and components are required"}, 400)
        if not one(conn.execute("SELECT id FROM classes WHERE id=? AND school_id=?", (class_id, school_id))):
            return self.send_json({"success": False, "message": "Class not found"}, 404)
        if not one(conn.execute("SELECT id FROM subjects WHERE id=? AND school_id=?", (subject_id, school_id))):
            return self.send_json({"success": False, "message": "Subject not found"}, 404)
        conn.execute("DELETE FROM assessment_components WHERE school_id=? AND class_id=? AND subject_id=? AND assessment_type=?", (school_id, class_id, subject_id, assessment))
        for i, c in enumerate(comps):
            key = re.sub(r"[^a-z0-9_]+", "_", clean(c.get("component_key") or c.get("key")).lower()).strip("_")
            name = clean(c.get("component_name") or c.get("name")) or key
            max_score = float(c.get("max_score") or c.get("max") or 100)
            if key and max_score > 0:
                conn.execute("""INSERT INTO assessment_components (school_id, class_id, subject_id, assessment_type, component_key, component_name, max_score, sort_order) VALUES (?,?,?,?,?,?,?,?)""", (school_id, class_id, subject_id, assessment, key, name, max_score, as_int(c.get("sort_order"), i) or i))
        return self.send_json({"success": True, "message": f"Saved {len(comps)} component(s)"})

    def admin_marks(self, conn, query):
        school_id = current_school_id_from_conn(conn)
        class_id = as_int(query_first(query, "class_id", "classId"))
        term = resolve_term(conn, query_first(query, "term_id", "termId"))
        if not class_id or not term:
            return self.send_json({"success": False, "message": "class_id and term_id required"}, 400)
        if not one(conn.execute("SELECT id FROM classes WHERE id=? AND school_id=?", (class_id, school_id))):
            return self.send_json({"success": False, "message": "Class not found"}, 404)
        assessment = query_first(query, "assessment_type", "assessmentType")
        subject_id = as_int(query_first(query, "subject_id", "subjectId"))
        sql = """SELECT m.*, u.name AS learner_name, u.admission_no, u.user_id AS learner_user_id, s.name AS subject_name, s.code AS subject_code
                 FROM marks m JOIN users u ON u.id=m.learner_id JOIN subjects s ON s.id=m.subject_id
                 WHERE m.class_id=? AND m.term_id=? AND m.school_id=?"""
        args = [class_id, term["id"], school_id]
        if assessment:
            sql += " AND m.assessment_type=?"
            args.append(valid_assessment(assessment, "midterm"))
        if subject_id:
            sql += " AND m.subject_id=?"
            args.append(subject_id)
        data = rows(conn.execute(sql + " ORDER BY u.name, s.name, m.component_key", args))
        for r in data:
            r["subject_code"] = public_subject_code(r.get("subject_code"))
        return self.send_json({"success": True, "data": data})

    def admin_marks_analysis(self, conn, query):
        school_id = current_school_id_from_conn(conn)
        requested = resolve_term(conn, query_first(query, "term_id", "termId"))
        if not requested:
            return self.send_json({"success": True, "classes": [], "requested_term": None, "display_term": None})
        stage = clean(query_first(query, "stage", "assessment_type", "assessmentType", default="combined")).lower()
        assessment = stage if stage in ("midterm", "endterm") else None
        classes = rows(conn.execute(
            """SELECT c.*, u.name AS class_teacher_name,
                      (SELECT COUNT(*) FROM users l WHERE l.school_id=? AND l.role='learner' AND l.status='active' AND l.class_name=c.name) AS learner_count
               FROM classes c LEFT JOIN users u ON u.id=c.class_teacher_id
               WHERE c.school_id=? AND COALESCE(c.status,'active')='active'
               ORDER BY c.name""",
            (school_id, school_id),
        ))
        out = []
        for cls in classes:
            subjects = rows(conn.execute(
                """SELECT s.id, s.name, s.code FROM class_subjects cs
                   JOIN subjects s ON s.id=cs.subject_id
                   WHERE cs.school_id=? AND cs.class_id=? ORDER BY s.name""",
                (school_id, cls["id"]),
            ))
            learners = rows(conn.execute(
                """SELECT id, name, admission_no, user_id FROM users
                   WHERE school_id=? AND role='learner' AND status='active' AND class_name=? ORDER BY name""",
                (school_id, cls["name"]),
            ))
            subject_scores = {s["id"]: [] for s in subjects}
            learner_rows = []
            if assessment:
                percent_maps = {s["id"]: subject_percent_map(conn, cls["id"], s["id"], requested["id"], assessment) for s in subjects}
                for learner in learners:
                    vals = []
                    for sub in subjects:
                        pct = percent_maps.get(sub["id"], {}).get(learner["id"])
                        if pct is not None:
                            vals.append(float(pct))
                            subject_scores[sub["id"]].append(float(pct))
                    avg = round(sum(vals) / len(vals), 1) if vals else None
                    if avg is not None:
                        learner_rows.append({**learner, "average": avg, "cbc": cbc_level(avg), "subject_count": len(vals)})
            else:
                subjects_for_class, broad_rows = broadsheet(conn, cls, requested["id"])
                subject_by_id = {s["id"]: s for s in subjects_for_class}
                subjects = subjects_for_class
                subject_scores = {s["id"]: [] for s in subjects}
                for learner in broad_rows:
                    avg = learner.get("average")
                    if avg is not None:
                        learner_rows.append({
                            "id": learner["id"],
                            "name": learner["name"],
                            "admission_no": learner.get("admission_no"),
                            "user_id": learner.get("user_id"),
                            "average": avg,
                            "cbc": learner.get("cbc"),
                            "subject_count": learner.get("subject_count", 0),
                        })
                    for score in learner.get("subjects", []):
                        if score.get("average") is not None and score.get("subject_id") in subject_by_id:
                            subject_scores.setdefault(score["subject_id"], []).append(float(score["average"]))
            learner_rows.sort(key=lambda r: r["average"], reverse=True)
            last = None
            rank = 0
            for idx, learner in enumerate(learner_rows):
                if learner["average"] != last:
                    rank = idx + 1
                    last = learner["average"]
                learner["position"] = rank
            subject_averages = []
            for sub in subjects:
                vals = subject_scores.get(sub["id"], [])
                avg = round(sum(vals) / len(vals), 1) if vals else None
                subject_averages.append({
                    "id": sub["id"],
                    "subject_id": sub["id"],
                    "name": sub["name"],
                    "code": public_subject_code(sub.get("code")),
                    "average": avg,
                    "entries": len(vals),
                })
            out.append({
                "class_id": cls["id"],
                "class_name": cls["name"],
                "class_teacher_name": cls.get("class_teacher_name"),
                "learner_count": int(cls.get("learner_count") or len(learners)),
                "has_marks": bool(learner_rows),
                "ranked": learner_rows[:50],
                "top_learners": learner_rows[:10],
                "needing_support": [r for r in learner_rows if float(r.get("average") or 0) < 60][:10],
                "subject_averages": subject_averages,
            })
        display_term = {**requested, "is_fallback": False}
        return self.send_json({
            "success": True,
            "classes": out,
            "requested_term": requested,
            "display_term": display_term,
            "assessment_type": assessment or "combined",
        })

    def admin_cohort_tracker(self, conn, query):
        school_id = current_school_id_from_conn(conn)
        class_id = as_int(query_first(query, "class_id", "classId"))
        cls = one(conn.execute("SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id))) if class_id else None
        if not cls:
            return self.send_json({"success": False, "message": "Class not found."}, 404)
        terms = rows(conn.execute(
            """SELECT id, term_name AS name, term_name, term_number, start_date, end_date
               FROM terms WHERE school_id=? ORDER BY date(start_date), id""",
            (school_id,),
        ))
        points = []
        for term in terms:
            subjects, learners = broadsheet(conn, cls, term["id"], published_only=True)
            vals = [float(l["average"]) for l in learners if l.get("average") is not None]
            if vals:
                points.append({
                    "term_id": term["id"],
                    "label": term.get("term_name") or term.get("name") or f"Term {term.get('term_number')}",
                    "mean": round(sum(vals) / len(vals), 1),
                    "learner_count": len(vals),
                    "subject_count": len(subjects),
                })
        return self.send_json({"success": True, "data": {"class_id": cls["id"], "class_name": cls["name"], "points": points, "published_only": True}})

    def admin_equity_splits(self, conn, query):
        school_id = current_school_id_from_conn(conn)
        term = resolve_term(conn, query_first(query, "term_id", "termId"))
        if not term:
            return self.send_json({"success": True, "data": {"by_sex": [], "by_attendance": [], "by_boarding": [], "learner_count": 0}})
        classes = rows(conn.execute("SELECT * FROM classes WHERE school_id=? AND COALESCE(status,'active')='active' ORDER BY name", (school_id,)))
        learner_rows = []
        for cls in classes:
            _, learners = broadsheet(conn, cls, term["id"], published_only=True)
            for learner in learners:
                if learner.get("average") is None:
                    continue
                att = attendance_summary(conn, learner["id"], cls["id"], term["id"]) or {}
                learner_rows.append({**learner, "class_id": cls["id"], "class_name": cls["name"], "attendance_pct": att.get("pct")})
        def groups_for(key_fn):
            buckets = {}
            for learner in learner_rows:
                label = key_fn(learner)
                buckets.setdefault(label, []).append(float(learner["average"]))
            return [{"label": label, "count": len(vals), "mean": round(sum(vals) / len(vals), 1)} for label, vals in sorted(buckets.items()) if vals]
        by_sex = groups_for(lambda l: {"M": "Male", "F": "Female"}.get(str(l.get("sex") or "").upper()[:1], "Unspecified"))
        def attendance_band(l):
            pct = l.get("attendance_pct")
            if pct is None:
                return "No attendance"
            if pct >= 90:
                return "90%+ attendance"
            if pct >= 75:
                return "75-89% attendance"
            return "Below 75%"
        by_attendance = groups_for(attendance_band)
        return self.send_json({"success": True, "data": {
            "term_id": term["id"],
            "term_name": term.get("term_name") or term.get("name"),
            "learner_count": len(learner_rows),
            "by_sex": by_sex,
            "by_attendance": by_attendance,
            "by_boarding": [],
            "unsupported": ["boarding_status"],
            "published_only": True,
        }})

    def save_admin_marks(self, conn, user):
        school_id = current_school_id_from_conn(conn)
        body = self.read_body()
        class_id = as_int(body_first(body, "class_id", "classId"))
        term = resolve_term(conn, body_first(body, "term_id", "termId"))
        assessment = valid_assessment(body_first(body, "assessment_type", "assessmentType"), "")
        entries = body.get("entries") if isinstance(body.get("entries"), list) else []
        if not class_id or not term or not assessment or not entries:
            return self.send_json({"success": False, "message": "Invalid marks payload"}, 400)
        if not one(conn.execute("SELECT id FROM classes WHERE id=? AND school_id=?", (class_id, school_id))):
            return self.send_json({"success": False, "message": "Class not found"}, 404)
        saved = 0
        for e in entries:
            learner_id = as_int(body_first(e, "learner_id", "learnerId"))
            subject_id = as_int(body_first(e, "subject_id", "subjectId"))
            key = clean(body_first(e, "component_key", "componentKey", default="exam")) or "exam"
            score = e.get("score")
            if not learner_id or not subject_id:
                continue
            if score in ("", None):
                conn.execute("DELETE FROM marks WHERE school_id=? AND learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND component_key=?", (school_id, learner_id, class_id, subject_id, term["id"], assessment, key))
            else:
                conn.execute("""INSERT INTO marks (school_id,learner_id,class_id,subject_id,term_id,assessment_type,component_key,score,created_by,created_at,updated_at)
                                VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
                                ON CONFLICT(learner_id,subject_id,term_id,assessment_type,component_key) DO UPDATE SET score=excluded.score, updated_at=datetime('now')""", (school_id, learner_id, class_id, subject_id, term["id"], assessment, key, float(score), user["id"]))
            conn.execute(
                """INSERT INTO marks_publications (school_id, class_id, subject_id, term_id, assessment_type, status, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'draft', datetime('now'))
                   ON CONFLICT(class_id, subject_id, term_id, assessment_type)
                   DO UPDATE SET status='draft', published_at=NULL, published_by=NULL, updated_at=datetime('now')""",
                (school_id, class_id, subject_id, term["id"], assessment),
            )
            saved += 1
        return self.send_json({"success": True, "message": f"Saved {saved} mark(s)"})

    def publish_admin_marks(self, conn, user):
        school_id = current_school_id_from_conn(conn)
        body = self.read_body()
        class_id = as_int(body_first(body, "class_id", "classId"))
        subject_id = as_int(body_first(body, "subject_id", "subjectId"))
        term = resolve_term(conn, body_first(body, "term_id", "termId"))
        assessment = valid_assessment(body_first(body, "assessment_type", "assessmentType"), "")
        cls = one(conn.execute("SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id))) if class_id else None
        if not cls or not term or not assessment:
            return self.send_json({"success": False, "message": "classId, termId and assessmentType are required for publishing."}, 400)
        subject_rows = rows(conn.execute(
            """SELECT DISTINCT m.subject_id, s.name
               FROM marks m JOIN subjects s ON s.id=m.subject_id
               WHERE m.school_id=? AND m.class_id=? AND m.term_id=? AND m.assessment_type=?
               ORDER BY s.name""",
            (school_id, class_id, term["id"], assessment),
        ))
        if subject_id:
            subject_rows = [s for s in subject_rows if int(s["subject_id"]) == int(subject_id)]
        if not subject_rows:
            return self.send_json({"success": False, "message": "No saved marks found for this publish scope."}, 400)
        learner_count = scalar(conn, "SELECT COUNT(*) FROM users WHERE school_id=? AND role='learner' AND status='active' AND class_name=?", (school_id, cls["name"]), 0)
        published = []
        for sub in subject_rows:
            sid = int(sub["subject_id"])
            mark_count = scalar(conn, "SELECT COUNT(*) FROM marks WHERE school_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND score IS NOT NULL", (school_id, class_id, sid, term["id"], assessment), 0)
            conn.execute(
                """INSERT INTO marks_publications (school_id, class_id, subject_id, term_id, assessment_type, status, mark_count, learner_count, published_by, published_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, datetime('now'), datetime('now'))
                   ON CONFLICT(class_id, subject_id, term_id, assessment_type)
                   DO UPDATE SET status='published', mark_count=excluded.mark_count, learner_count=excluded.learner_count,
                                 published_by=excluded.published_by, published_at=excluded.published_at, updated_at=datetime('now')""",
                (school_id, class_id, sid, term["id"], assessment, mark_count, learner_count, user["id"]),
            )
            published.append({"subject_id": sid, "subject_name": sub["name"], "mark_count": mark_count})
        return self.send_json({"success": True, "data": {"published": published, "published_count": len(published), "term_id": term["id"], "assessment_type": assessment}, "message": f"Published {len(published)} subject(s)."})

    def admin_broadsheet(self, conn, query):
        school_id = current_school_id_from_conn(conn)
        class_id = as_int(query_first(query, "class_id", "classId"))
        term = resolve_term(conn, query_first(query, "term_id", "termId"))
        cls = one(conn.execute("SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id))) if class_id else None
        if not cls or not term:
            return self.send_json({"success": False, "message": "Class or term not found"}, 404)
        subjects, learners = broadsheet(conn, cls, term["id"])
        return self.send_json({"success": True, "data": {"class": cls, "term": term, "assessment_type": query_first(query, "assessment_type", "assessmentType"), "school": school_settings(conn), "subjects": subjects, "learners": learners, "cbc_levels": CBC_LEVELS}})

    def admin_report_card(self, conn, query, batch=False):
        school_id = current_school_id_from_conn(conn)
        class_id = as_int(query_first(query, "class_id", "classId"))
        learner_id = as_int(query_first(query, "learner_id", "learnerId"))
        if not class_id and learner_id:
            learner = one(conn.execute("SELECT class_name FROM users WHERE id=? AND role='learner' AND school_id=?", (learner_id, school_id)))
            cls = one(conn.execute("SELECT * FROM classes WHERE name=? AND school_id=?", (learner.get("class_name"), school_id))) if learner else None
        else:
            cls = one(conn.execute("SELECT * FROM classes WHERE id=? AND school_id=?", (class_id, school_id))) if class_id else None
        term = resolve_term(conn, query_first(query, "term_id", "termId"))
        if not cls or not term:
            return self.send_json({"success": False, "message": "Class or term not found"}, 404)
        assessment = valid_assessment(query_first(query, "assessment_type", "assessmentType"), detect_assessment(term))
        ids_text = clean(query_first(query, "learner_ids", "learnerIds", default=""))
        ids = [] if not ids_text or ids_text.lower() == "all" else ids_text.split(",")
        data = report_payload(conn, cls, term, assessment, selected_ids=ids, single_learner_id=None if batch else learner_id)
        if learner_id and not data.get("learner"):
            return self.send_json({"success": False, "message": "Learner not found"}, 404)
        return self.send_json({"success": True, "data": data})

    def admin_attendance(self, conn, query):
        class_id = as_int(query_first(query, "class_id", "classId"))
        date = clean(query_first(query, "date", default=now_kenya_date()))
        if not class_id:
            return self.send_json({"success": False, "message": "class_id required"}, 400)
        record = one(conn.execute("SELECT * FROM attendance_records WHERE class_id=? AND date=?", (class_id, date)))
        if not record:
            return self.send_json({"success": True, "data": None})
        entries = rows(conn.execute("""SELECT ae.*, u.name AS learner_name, u.admission_no FROM attendance_entries ae JOIN users u ON u.id=ae.learner_id WHERE ae.record_id=? ORDER BY u.name""", (record["id"],)))
        return self.send_json({"success": True, "data": {"record": record, "entries": entries}})

    def save_admin_attendance(self, conn, user):
        body = self.read_body()
        class_id = as_int(body_first(body, "class_id", "classId"))
        term = resolve_term(conn, body_first(body, "term_id", "termId"))
        date = clean(body.get("date")) or now_kenya_date()
        entries = body.get("entries") if isinstance(body.get("entries"), list) else []
        if not class_id or not term or not entries:
            return self.send_json({"success": False, "message": "Invalid attendance payload"}, 400)
        cur = conn.execute("""INSERT INTO attendance_records (class_id, term_id, date, created_by, created_at)
                              VALUES (?, ?, ?, ?, datetime('now'))
                              ON CONFLICT(class_id, date) DO UPDATE SET term_id=excluded.term_id
                              RETURNING id""", (class_id, term["id"], date, user["id"]))
        record_id = cur.fetchone()[0]
        for e in entries:
            lid = as_int(body_first(e, "learner_id", "learnerId"))
            status = clean(e.get("status"))
            status = {"P": "present", "A": "absent", "L": "late"}.get(status, status if status in ("present", "absent", "late") else "present")
            if lid:
                conn.execute("""INSERT INTO attendance_entries (record_id, learner_id, status, note) VALUES (?,?,?,?)
                                ON CONFLICT(record_id, learner_id) DO UPDATE SET status=excluded.status, note=excluded.note""", (record_id, lid, status, clean(e.get("note")) or None))
        return self.send_json({"success": True, "message": "Attendance saved"})

    def admin_attendance_summary(self, conn, query):
        date = clean(query_first(query, "date", default=now_kenya_date()))
        class_id = as_int(query_first(query, "class_id", "classId"))
        args = [date]
        filt = ""
        if class_id:
            filt = " AND ar.class_id=?"
            args.append(class_id)
        data = rows(conn.execute(f"""SELECT ar.class_id, c.name AS class_name, COUNT(ae.id) AS marked,
                                      SUM(CASE WHEN ae.status='present' THEN 1 ELSE 0 END) AS present,
                                      SUM(CASE WHEN ae.status='absent' THEN 1 ELSE 0 END) AS absent,
                                      SUM(CASE WHEN ae.status='late' THEN 1 ELSE 0 END) AS late
                                      FROM attendance_records ar JOIN classes c ON c.id=ar.class_id
                                      LEFT JOIN attendance_entries ae ON ae.record_id=ar.id
                                      WHERE ar.date=?{filt} GROUP BY ar.class_id,c.name ORDER BY c.name""", args))
        total = scalar(conn, "SELECT COUNT(*) FROM users WHERE role='learner' AND status='active'", (), 0)
        present = sum(int(r.get("present") or 0) for r in data)
        absent = sum(int(r.get("absent") or 0) for r in data)
        late = sum(int(r.get("late") or 0) for r in data)
        return self.send_json({"success": True, "data": {"date": date, "total": total, "present": present, "absent": absent, "late": late, "percent": round((present / total) * 100, 1) if total else 0, "classes": data}})

    def save_role_permissions(self, conn, user, role):
        role = clean(role).lower()
        if role not in DEFAULT_ROLE_PERMISSIONS:
            return self.send_json({"success": False, "message": "Unknown role."}, 404)
        body = self.read_body()
        requested = body.get("permissions") if isinstance(body.get("permissions"), list) else []
        allowed = set(PERMISSION_LABELS)
        perms = sorted({clean(p) for p in requested if clean(p) in allowed})
        if role == "admin" and "permissions_write" not in perms:
            perms.append("permissions_write")
        school_id = current_school_id_from_conn(conn)
        conn.execute("DELETE FROM school_role_permissions WHERE school_id=? AND role=?", (school_id, role))
        for perm in perms:
            conn.execute(
                "INSERT INTO school_role_permissions(school_id, role, permission, updated_by, updated_at) VALUES (?,?,?,?,datetime('now'))",
                (school_id, role, perm, user["id"]),
            )
        return self.send_json({"success": True, "data": {"role": role, "permissions": perms}})

    def timetable_settings(self, conn):
        cols = self.table_columns(conn, "timetable_settings")
        if {"key", "value"}.issubset(cols):
            data = {r["key"]: r["value"] for r in rows(conn.execute("SELECT key, value FROM timetable_settings"))}
        else:
            row = one(conn.execute("SELECT * FROM timetable_settings ORDER BY id LIMIT 1")) or {}
            data = dict(row)
        out = {
            "working_days": data.get("working_days", "mon,tue,wed,thu,fri"),
            "visible_to_teachers": as_int(data.get("visible_to_teachers"), 1),
            "visible_to_parents": as_int(data.get("visible_to_parents"), 0),
        }
        soft_rules = data.get("soft_rules") or data.get("soft_rules_json")
        if soft_rules:
            try:
                out["soft_rules"] = json.loads(soft_rules)
            except Exception:
                out["soft_rules"] = soft_rules
        return out

    def save_timetable_settings(self, conn):
        body = self.read_body()
        allowed = {"working_days", "visible_to_teachers", "visible_to_parents", "soft_rules"}
        saved = {}
        cols = self.table_columns(conn, "timetable_settings")
        if {"key", "value"}.issubset(cols):
            for key, value in body.items():
                k = clean(key)
                if k not in allowed:
                    continue
                v = json.dumps(value) if isinstance(value, (dict, list)) else str(value)
                conn.execute(
                    """INSERT INTO timetable_settings(key, value, updated_at) VALUES (?,?,datetime('now'))
                       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')""",
                    (k, v),
                )
                saved[k] = value
            return self.send_json({"success": True, "data": self.timetable_settings(conn), "saved": saved})
        row = one(conn.execute("SELECT id FROM timetable_settings ORDER BY id LIMIT 1"))
        if not row:
            conn.execute("INSERT INTO timetable_settings(id) VALUES (1)")
            row = {"id": 1}
        assignments = []
        args = []
        for key, value in body.items():
            k = clean(key)
            if k not in allowed:
                continue
            col = "soft_rules_json" if k == "soft_rules" else k
            if col not in cols:
                continue
            assignments.append(f"{col}=?")
            args.append(json.dumps(value) if isinstance(value, (dict, list)) else value)
            saved[k] = value
        if assignments:
            conn.execute(f"UPDATE timetable_settings SET {', '.join(assignments)} WHERE id=?", (*args, row["id"]))
        return self.send_json({"success": True, "data": self.timetable_settings(conn), "saved": saved})

    def save_timetable_periods(self, conn):
        body = self.read_body()
        periods = body.get("periods") if isinstance(body.get("periods"), list) else []
        if not periods:
            return self.send_json({"success": False, "message": "At least one period is required."}, 400)
        conn.execute("DELETE FROM bell_periods WHERE schedule_id=1")
        saved = []
        for i, p in enumerate(periods, 1):
            period_no = as_int(p.get("period_no"), i) or i
            start = clean(p.get("start_time"))
            end = clean(p.get("end_time"))
            if not start or not end:
                return self.send_json({"success": False, "message": "Every bell period needs start and end time."}, 400)
            active_days = p.get("active_days") if isinstance(p.get("active_days"), list) else ["mon", "tue", "wed", "thu", "fri"]
            row = {
                "schedule_id": 1,
                "period_no": period_no,
                "label": clean(p.get("label")) or f"Period {period_no}",
                "start_time": start,
                "end_time": end,
                "type": clean(p.get("type")) or "lesson",
                "active_days": json.dumps(active_days),
            }
            conn.execute(
                """INSERT INTO bell_periods(schedule_id, period_no, label, start_time, end_time, type, active_days)
                   VALUES (:schedule_id,:period_no,:label,:start_time,:end_time,:type,:active_days)""",
                row,
            )
            row["active_days"] = active_days
            saved.append(row)
        return self.send_json({"success": True, "data": saved, "message": f"Saved {len(saved)} bell period(s)."})

    def timetable_lessons(self, conn):
        return rows(conn.execute(
            """SELECT cs.class_id, cs.subject_id, cs.lessons_per_week, cs.double_periods,
                      c.name AS class_name, s.name AS subject_name, cs.teacher_id, u.name AS teacher_name
               FROM class_subjects cs
               JOIN classes c ON c.id=cs.class_id
               JOIN subjects s ON s.id=cs.subject_id
               LEFT JOIN users u ON u.id=cs.teacher_id
               ORDER BY c.name, s.name"""
        ))

    def save_timetable_lessons(self, conn):
        body = self.read_body()
        rows_in = body.get("rows") if isinstance(body.get("rows"), list) else []
        saved = 0
        for item in rows_in:
            class_id = as_int(body_first(item, "class_id", "classId"))
            subject_id = as_int(body_first(item, "subject_id", "subjectId"))
            if not class_id or not subject_id:
                continue
            conn.execute(
                """UPDATE class_subjects
                   SET lessons_per_week=?, double_periods=?, updated_at=datetime('now')
                   WHERE class_id=? AND subject_id=?""",
                (max(0, as_int(item.get("lessons_per_week"), 0) or 0), 1 if as_int(item.get("double_periods"), 0) else 0, class_id, subject_id),
            )
            saved += conn.total_changes
        return self.send_json({"success": True, "message": f"Saved lesson load for {len(rows_in)} subject assignment(s)."})

    def timetable_rooms(self, conn):
        data = rows(conn.execute(
            """SELECT r.*, c.name AS home_class_name
               FROM timetable_rooms r LEFT JOIN classes c ON c.id=r.home_class_id
               ORDER BY r.name"""
        ))
        for room in data:
            tags = room.get("subject_tags")
            if isinstance(tags, str) and tags:
                try:
                    room["subject_tags"] = json.loads(tags)
                except Exception:
                    room["subject_tags"] = [x.strip() for x in tags.split(",") if x.strip()]
            else:
                room["subject_tags"] = []
        return data

    def save_timetable_room(self, conn, room_id=None):
        body = self.read_body()
        name = clean(body.get("name"))
        if not name:
            return self.send_json({"success": False, "message": "Room name is required."}, 400)
        payload = {
            "name": name,
            "capacity": as_int(body.get("capacity")),
            "room_type": clean(body.get("room_type")) or "classroom",
            "subject_tags": json.dumps(body.get("subject_tags") if isinstance(body.get("subject_tags"), list) else []),
            "status": clean(body.get("status")) or "active",
            "allow_sharing": 1 if as_int(body.get("allow_sharing"), 0) else 0,
            "home_class_id": as_int(body.get("home_class_id")),
        }
        if room_id:
            if not one(conn.execute("SELECT id FROM timetable_rooms WHERE id=?", (room_id,))):
                return self.send_json({"success": False, "message": "Room not found."}, 404)
            conn.execute(
                """UPDATE timetable_rooms SET name=:name, capacity=:capacity, room_type=:room_type,
                   subject_tags=:subject_tags, status=:status, allow_sharing=:allow_sharing,
                   home_class_id=:home_class_id, updated_at=datetime('now') WHERE id=:id""",
                {**payload, "id": room_id},
            )
            rid = room_id
        else:
            cur = conn.execute(
                """INSERT INTO timetable_rooms(name, capacity, room_type, subject_tags, status, allow_sharing, home_class_id, created_at, updated_at)
                   VALUES (:name,:capacity,:room_type,:subject_tags,:status,:allow_sharing,:home_class_id,datetime('now'),datetime('now'))""",
                payload,
            )
            rid = cur.lastrowid
        room = next((r for r in self.timetable_rooms(conn) if int(r["id"]) == int(rid)), None)
        return self.send_json({"success": True, "data": room})

    def delete_timetable_room(self, conn, room_id):
        if not one(conn.execute("SELECT id FROM timetable_rooms WHERE id=?", (room_id,))):
            return self.send_json({"success": False, "message": "Room not found."}, 404)
        conn.execute("UPDATE timetable_slots SET room_id=NULL WHERE room_id=?", (room_id,))
        conn.execute("DELETE FROM timetable_rooms WHERE id=?", (room_id,))
        return self.send_json({"success": True})

    def timetable_slots(self, conn, generation_id=None):
        if not generation_id:
            active = one(conn.execute("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1"))
            generation_id = active["id"] if active else None
        if not generation_id:
            return []
        data = rows(conn.execute(
            """SELECT ts.*, c.name AS class_name, s.name AS subject_name, u.name AS teacher_name,
                      r.name AS room_name, r.id AS assigned_room_id,
                      CASE WHEN ts.room_id IS NULL AND hr.id IS NOT NULL THEN hr.name ELSE r.name END AS display_room_name,
                      CASE WHEN ts.room_id IS NULL AND hr.id IS NOT NULL THEN 1 ELSE 0 END AS room_is_default
               FROM timetable_slots ts
               JOIN classes c ON c.id=ts.class_id
               JOIN subjects s ON s.id=ts.subject_id
               LEFT JOIN users u ON u.id=ts.teacher_id
               LEFT JOIN timetable_rooms r ON r.id=ts.room_id
               LEFT JOIN timetable_rooms hr ON hr.home_class_id=c.id AND hr.status='active'
               WHERE ts.generation_id=?
               ORDER BY ts.day_of_week, ts.period_no, c.name""",
            (generation_id,),
        ))
        for slot in data:
            if not slot.get("room_name") and slot.get("display_room_name"):
                slot["room_name"] = slot["display_room_name"]
        return data

    def timetable_generations(self, conn, include_slots=False):
        data = rows(conn.execute("SELECT * FROM timetable_generations ORDER BY id DESC"))
        if include_slots:
            for gen in data:
                gen["slots"] = self.timetable_slots(conn, gen["id"]) if gen.get("status") == "active" else []
        return data

    def generate_timetable(self, conn, user):
        term = default_term(conn)
        if not term:
            return self.send_json({"success": False, "message": "No active term is available for timetable generation."}, 400)
        periods = rows(conn.execute("SELECT * FROM bell_periods WHERE schedule_id=1 AND type='lesson' ORDER BY period_no"))
        if not periods:
            return self.send_json({"success": False, "message": "Add lesson periods before generating a timetable."}, 400)
        lessons = [r for r in self.timetable_lessons(conn) if int(r.get("lessons_per_week") or 0) > 0]
        if not lessons:
            return self.send_json({"success": False, "message": "Set lessons per week before generating a timetable."}, 400)
        class_periods = {}
        for cls in rows(conn.execute("SELECT id, active_periods FROM classes")):
            raw = cls.get("active_periods")
            allowed = None
            if raw:
                try:
                    parsed = json.loads(raw) if isinstance(raw, str) else raw
                    allowed = {int(x) for x in parsed if as_int(x)}
                except Exception:
                    allowed = None
            class_periods[int(cls["id"])] = allowed
        cur = conn.execute(
            """INSERT INTO timetable_generations(term_id, status, score, placed, total, conflicts, generated_by, generated_at, notes)
               VALUES (?, 'draft', 0, 0, 0, 0, ?, datetime('now'), ?)""",
            (term["id"], user["id"], "Generated by Python backend deterministic placer"),
        )
        gen_id = cur.lastrowid
        candidates = []
        for p in periods:
            active_days = p.get("active_days")
            if isinstance(active_days, str):
                try:
                    active_days = json.loads(active_days)
                except Exception:
                    active_days = ["mon", "tue", "wed", "thu", "fri"]
            day_nums = [{"mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5}.get(d, 1) for d in (active_days or ["mon", "tue", "wed", "thu", "fri"])]
            for d in day_nums:
                candidates.append((d, int(p["period_no"])))
        occupied_class = set()
        occupied_teacher = set()
        occupied_room = set()
        placed = 0
        unplaced = []
        cursor_by_class = {}
        home_rooms = {
            int(r["home_class_id"]): r
            for r in rows(conn.execute("SELECT * FROM timetable_rooms WHERE home_class_id IS NOT NULL AND status='active'"))
            if r.get("home_class_id") is not None
        }
        for lesson in lessons:
            class_id = int(lesson["class_id"])
            teacher_id = lesson.get("teacher_id")
            needed = int(lesson.get("lessons_per_week") or 0)
            cursor = cursor_by_class.get(class_id, 0)
            for _ in range(needed):
                found = None
                for offset in range(len(candidates)):
                    d, pno = candidates[(cursor + offset) % len(candidates)]
                    allowed_periods = class_periods.get(class_id)
                    if allowed_periods and pno not in allowed_periods:
                        continue
                    if (class_id, d, pno) in occupied_class:
                        continue
                    if teacher_id and (teacher_id, d, pno) in occupied_teacher:
                        continue
                    found = (d, pno, (cursor + offset + 1) % len(candidates))
                    break
                if not found:
                    unplaced.append({"class_id": class_id, "subject_id": lesson["subject_id"], "reason": "No non-conflicting slot available"})
                    continue
                d, pno, cursor = found
                occupied_class.add((class_id, d, pno))
                if teacher_id:
                    occupied_teacher.add((teacher_id, d, pno))
                room = home_rooms.get(class_id)
                room_id = None
                if room and (room.get("allow_sharing") or (room["id"], d, pno) not in occupied_room):
                    room_id = room["id"]
                    occupied_room.add((room["id"], d, pno))
                conn.execute(
                    """INSERT INTO timetable_slots(generation_id,class_id,day_of_week,period_no,subject_id,teacher_id,locked,room_id)
                       VALUES (?,?,?,?,?,?,0,?)""",
                    (gen_id, class_id, d, pno, lesson["subject_id"], teacher_id, room_id),
                )
                placed += 1
            cursor_by_class[class_id] = cursor
        total = sum(int(l.get("lessons_per_week") or 0) for l in lessons)
        score = round((placed / total) * 100) if total else 0
        conn.execute(
            "UPDATE timetable_generations SET score=?, placed=?, total=?, conflicts=?, conflicts_json=? WHERE id=?",
            (score, placed, total, len(unplaced), json.dumps(unplaced), gen_id),
        )
        gen = one(conn.execute("SELECT * FROM timetable_generations WHERE id=?", (gen_id,)))
        gen["slots"] = self.timetable_slots(conn, gen_id)
        gen["unplaced"] = unplaced
        return self.send_json({"success": True, "data": gen})

    def publish_timetable_generation(self, conn, user, generation_id):
        gen = one(conn.execute("SELECT * FROM timetable_generations WHERE id=?", (generation_id,)))
        if not gen:
            return self.send_json({"success": False, "message": "Timetable generation not found."}, 404)
        placed = scalar(conn, "SELECT COUNT(*) FROM timetable_slots WHERE generation_id=?", (generation_id,), 0)
        if not placed:
            return self.send_json({"success": False, "message": "Cannot publish an empty timetable generation."}, 400)
        conn.execute("UPDATE timetable_generations SET status='archived' WHERE status='active' AND id<>?", (generation_id,))
        conn.execute("UPDATE timetable_generations SET status='active', published_at=datetime('now') WHERE id=?", (generation_id,))
        return self.send_json({"success": True, "data": one(conn.execute("SELECT * FROM timetable_generations WHERE id=?", (generation_id,)))})

    def delete_timetable_generation(self, conn, generation_id):
        gen = one(conn.execute("SELECT * FROM timetable_generations WHERE id=?", (generation_id,)))
        if not gen:
            return self.send_json({"success": False, "message": "Timetable generation not found."}, 404)
        if gen.get("status") == "active":
            return self.send_json({"success": False, "message": "Cannot delete the active timetable. Publish another generation first."}, 400)
        conn.execute("DELETE FROM timetable_slots WHERE generation_id=?", (generation_id,))
        conn.execute("DELETE FROM timetable_generations WHERE id=?", (generation_id,))
        return self.send_json({"success": True})

    def update_timetable_slot(self, conn, slot_id):
        body = self.read_body()
        slot = one(conn.execute("SELECT * FROM timetable_slots WHERE id=?", (slot_id,)))
        if not slot:
            return self.send_json({"success": False, "message": "Slot not found."}, 404)
        day = as_int(body.get("day_of_week"), slot["day_of_week"])
        period = as_int(body.get("period_no"), slot["period_no"])
        room_id = as_int(body.get("room_id"))
        conflict = one(conn.execute(
            """SELECT id FROM timetable_slots
               WHERE generation_id=? AND class_id=? AND day_of_week=? AND period_no=? AND id<>?""",
            (slot["generation_id"], slot["class_id"], day, period, slot_id),
        ))
        if conflict:
            return self.send_json({"success": False, "message": "That class already has a lesson in the selected slot."}, 409)
        if room_id:
            room_conflict = one(conn.execute(
                """SELECT id FROM timetable_slots
                   WHERE generation_id=? AND room_id=? AND day_of_week=? AND period_no=? AND id<>?""",
                (slot["generation_id"], room_id, day, period, slot_id),
            ))
            if room_conflict:
                return self.send_json({"success": False, "message": "That room is already assigned at this time."}, 409)
        conn.execute("UPDATE timetable_slots SET day_of_week=?, period_no=?, room_id=? WHERE id=?", (day, period, room_id, slot_id))
        updated = next((s for s in self.timetable_slots(conn, slot["generation_id"]) if int(s["id"]) == int(slot_id)), None)
        return self.send_json({"success": True, "data": updated})

    def lock_timetable_slot(self, conn, slot_id):
        body = self.read_body()
        locked = 1 if body.get("locked", True) else 0
        conn.execute("UPDATE timetable_slots SET locked=? WHERE id=?", (locked, slot_id))
        return self.send_json({"success": True, "data": {"id": slot_id, "locked": locked}})

    def swap_timetable_slots(self, conn):
        body = self.read_body()
        source_id = as_int(body_first(body, "source_id", "sourceId"))
        target_id = as_int(body_first(body, "target_id", "targetId"))
        source = one(conn.execute("SELECT * FROM timetable_slots WHERE id=?", (source_id,))) if source_id else None
        target = one(conn.execute("SELECT * FROM timetable_slots WHERE id=?", (target_id,))) if target_id else None
        if not source or not target or source["generation_id"] != target["generation_id"]:
            return self.send_json({"success": False, "message": "Both slots must exist in the same timetable generation."}, 400)
        conn.execute("UPDATE timetable_slots SET day_of_week=?, period_no=? WHERE id=?", (target["day_of_week"], target["period_no"], source_id))
        conn.execute("UPDATE timetable_slots SET day_of_week=?, period_no=? WHERE id=?", (source["day_of_week"], source["period_no"], target_id))
        return self.send_json({"success": True, "data": self.timetable_slots(conn, source["generation_id"])})

    def timetable_room_status(self, conn):
        rooms_ = self.timetable_rooms(conn)
        active = one(conn.execute("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1"))
        if not active:
            for room in rooms_:
                room["current"] = []
            return rooms_
        for room in rooms_:
            current = rows(conn.execute(
                """SELECT ts.*, c.name AS class_name, s.name AS subject_name
                   FROM timetable_slots ts JOIN classes c ON c.id=ts.class_id JOIN subjects s ON s.id=ts.subject_id
                   WHERE ts.generation_id=? AND ts.room_id=? ORDER BY ts.day_of_week, ts.period_no LIMIT 3""",
                (active["id"], room["id"]),
            ))
            room["current"] = current
        return rooms_

    def timetable_workload(self, conn):
        return rows(conn.execute(
            """SELECT u.id AS teacher_id, u.name AS teacher_name, COUNT(ts.id) AS lessons
               FROM users u LEFT JOIN timetable_slots ts ON ts.teacher_id=u.id
               WHERE u.role='teacher' AND u.status='active'
               GROUP BY u.id, u.name ORDER BY u.name"""
        ))

    def timetable_absences(self, conn, query):
        date = clean(query_first(query, "date", default=now_kenya_date()))
        return rows(conn.execute(
            """SELECT ta.*, u.name AS teacher_name
               FROM teacher_absences ta JOIN users u ON u.id=ta.teacher_id
               WHERE date(ta.date_from) <= date(?) AND date(ta.date_to) >= date(?)
               ORDER BY u.name, date(ta.date_from), ta.id""",
            (date, date),
        ))

    def save_timetable_absence(self, conn, user):
        body = self.read_body()
        teacher_id = as_int(body.get("teacher_id"))
        date_from = clean(body.get("date_from"))
        date_to = clean(body.get("date_to")) or date_from
        reason = clean(body.get("reason")) or "other"
        notes = clean(body.get("notes")) or None
        if not teacher_id or not date_from:
            return self.send_json({"success": False, "message": "teacher_id and date_from are required."}, 400)
        if date_to < date_from:
            return self.send_json({"success": False, "message": "date_to must be on or after date_from."}, 400)
        teacher = one(conn.execute("SELECT id, name FROM users WHERE id=? AND role='teacher' AND status='active'", (teacher_id,)))
        if not teacher:
            return self.send_json({"success": False, "message": "Active teacher not found."}, 404)
        cur = conn.execute(
            """INSERT INTO teacher_absences(teacher_id,date_from,date_to,reason,notes,created_by,created_at)
               VALUES (?,?,?,?,?,?,datetime('now'))""",
            (teacher_id, date_from, date_to, reason, notes, user["id"]),
        )
        row = one(conn.execute(
            """SELECT ta.*, u.name AS teacher_name FROM teacher_absences ta JOIN users u ON u.id=ta.teacher_id WHERE ta.id=?""",
            (cur.lastrowid,),
        ))
        return self.send_json({"success": True, "data": row, "message": "Absence recorded."})

    def delete_timetable_absence(self, conn, absence_id):
        if not one(conn.execute("SELECT id FROM teacher_absences WHERE id=?", (absence_id,))):
            return self.send_json({"success": False, "message": "Absence not found."}, 404)
        conn.execute("DELETE FROM timetable_substitutions WHERE absence_id=?", (absence_id,))
        conn.execute("DELETE FROM teacher_absences WHERE id=?", (absence_id,))
        return self.send_json({"success": True, "message": "Absence deleted."})

    def timetable_substitutions(self, conn, query):
        date = clean(query_first(query, "date", default=now_kenya_date()))
        data = rows(conn.execute(
            """SELECT sub.*, ots.class_id, c.name AS class_name, ots.subject_id, s.name AS subject_name,
                      ou.name AS original_teacher_name, su.name AS substitute_teacher_name,
                      ots.day_of_week, ots.period_no
               FROM timetable_substitutions sub
               JOIN timetable_slots ots ON ots.id=sub.slot_id
               JOIN classes c ON c.id=ots.class_id
               JOIN subjects s ON s.id=ots.subject_id
               JOIN users ou ON ou.id=sub.original_teacher_id
               LEFT JOIN users su ON su.id=sub.substitute_teacher_id
               WHERE sub.date=?
               ORDER BY ots.day_of_week, ots.period_no, c.name""",
            (date,),
        ))
        return data

    def save_timetable_substitution(self, conn, user):
        body = self.read_body()
        slot_id = as_int(body.get("slot_id"))
        date = clean(body.get("date")) or now_kenya_date()
        absence_id = as_int(body.get("absence_id"))
        original_teacher_id = as_int(body.get("original_teacher_id"))
        substitute_teacher_id = as_int(body.get("substitute_teacher_id"))
        slot = one(conn.execute("SELECT * FROM timetable_slots WHERE id=?", (slot_id,))) if slot_id else None
        if not slot:
            return self.send_json({"success": False, "message": "Timetable slot not found."}, 404)
        if not original_teacher_id:
            original_teacher_id = slot.get("teacher_id")
        if int(original_teacher_id or 0) != int(slot.get("teacher_id") or 0):
            return self.send_json({"success": False, "message": "Original teacher does not match the timetable slot."}, 400)
        if absence_id:
            absence = one(conn.execute("SELECT * FROM teacher_absences WHERE id=? AND teacher_id=? AND date(date_from) <= date(?) AND date(date_to) >= date(?)", (absence_id, original_teacher_id, date, date)))
            if not absence:
                return self.send_json({"success": False, "message": "Absence does not cover this teacher and date."}, 400)
        if not substitute_teacher_id:
            conn.execute("DELETE FROM timetable_substitutions WHERE slot_id=? AND date=?", (slot_id, date))
            return self.send_json({"success": True, "data": {"slot_id": slot_id, "date": date, "substitute_teacher_id": None}, "message": "Cover cleared."})
        if substitute_teacher_id == original_teacher_id:
            return self.send_json({"success": False, "message": "Substitute cannot be the absent teacher."}, 400)
        substitute = one(conn.execute("SELECT id, name FROM users WHERE id=? AND role='teacher' AND status='active'", (substitute_teacher_id,)))
        if not substitute:
            return self.send_json({"success": False, "message": "Active substitute teacher not found."}, 404)
        absent = one(conn.execute("SELECT id FROM teacher_absences WHERE teacher_id=? AND date(date_from) <= date(?) AND date(date_to) >= date(?)", (substitute_teacher_id, date, date)))
        if absent:
            return self.send_json({"success": False, "message": "Selected substitute is also absent on this date."}, 409)
        busy = one(conn.execute(
            """SELECT id FROM timetable_slots
               WHERE generation_id=? AND teacher_id=? AND day_of_week=? AND period_no=? AND id<>?""",
            (slot["generation_id"], substitute_teacher_id, slot["day_of_week"], slot["period_no"], slot_id),
        ))
        if busy:
            return self.send_json({"success": False, "message": "Selected substitute already has a lesson in that period."}, 409)
        conn.execute(
            """INSERT INTO timetable_substitutions(absence_id,slot_id,date,original_teacher_id,substitute_teacher_id,created_by,created_at,updated_at)
               VALUES (?,?,?,?,?,?,datetime('now'),datetime('now'))
               ON CONFLICT(slot_id,date) DO UPDATE SET absence_id=excluded.absence_id,
                    original_teacher_id=excluded.original_teacher_id,
                    substitute_teacher_id=excluded.substitute_teacher_id,
                    updated_at=datetime('now')""",
            (absence_id, slot_id, date, original_teacher_id, substitute_teacher_id, user["id"]),
        )
        row = one(conn.execute("SELECT * FROM timetable_substitutions WHERE slot_id=? AND date=?", (slot_id, date)))
        return self.send_json({"success": True, "data": row, "message": "Cover assigned."})

    def insert_notification(self, conn, title, body, audience, recipients, user):
        if not self.table_exists(conn, "notifications"):
            return None
        cols = {r["name"] for r in rows(conn.execute("PRAGMA table_info(notifications)"))}
        payload = {"title": title, "body": body, "audience": audience, "created_by_role": user["role"], "created_by_id": user["id"], "type": "timetable", "channels": json.dumps(["in-app"]), "sender_id": user["id"]}
        names = [k for k in payload if k in cols]
        cur = conn.execute(f"INSERT INTO notifications ({','.join(names)}) VALUES ({','.join('?' for _ in names)})", [payload[k] for k in names])
        if self.table_exists(conn, "notification_recipients"):
            for rec in recipients:
                conn.execute("INSERT INTO notification_recipients(notification_id,user_role,user_id,read_at,created_at) VALUES (?,?,?,?,datetime('now'))", (cur.lastrowid, rec["role"], rec["id"], None))
        return cur.lastrowid

    def notify_timetable_substitutes(self, conn, user):
        body = self.read_body()
        date = clean(body.get("date")) or now_kenya_date()
        slot_ids = [as_int(x) for x in body.get("slot_ids", []) if as_int(x)]
        if not slot_ids:
            return self.send_json({"success": False, "message": "slot_ids are required."}, 400)
        sent = 0
        for slot_id in slot_ids:
            sub = one(conn.execute("SELECT * FROM timetable_substitutions WHERE slot_id=? AND date=? AND substitute_teacher_id IS NOT NULL", (slot_id, date)))
            if not sub:
                continue
            slot = one(conn.execute(
                """SELECT ts.*, c.name AS class_name, s.name AS subject_name
                   FROM timetable_slots ts JOIN classes c ON c.id=ts.class_id JOIN subjects s ON s.id=ts.subject_id
                   WHERE ts.id=?""",
                (slot_id,),
            ))
            title = "Substitution assigned"
            text = f"You have been assigned to cover {slot['subject_name']} for {slot['class_name']} on {date}, period {slot['period_no']}."
            self.insert_notification(conn, title, text, f"teacher:{sub['substitute_teacher_id']}", [{"role": "teacher", "id": sub["substitute_teacher_id"]}], user)
            conn.execute("UPDATE timetable_substitutions SET notified_at=datetime('now'), updated_at=datetime('now') WHERE id=?", (sub["id"],))
            sent += 1
        return self.send_json({"success": True, "data": {"notified": sent}, "message": f"Notified {sent} substitute(s)."})

    def notify_timetable_substitution_parents(self, conn, user):
        body = self.read_body()
        absence_id = as_int(body.get("absence_id"))
        date = clean(body.get("date")) or now_kenya_date()
        absence = one(conn.execute("SELECT ta.*, u.name AS teacher_name FROM teacher_absences ta JOIN users u ON u.id=ta.teacher_id WHERE ta.id=?", (absence_id,))) if absence_id else None
        if not absence:
            return self.send_json({"success": False, "message": "Absence not found."}, 404)
        affected = rows(conn.execute(
            """SELECT DISTINCT ts.class_id, c.name AS class_name
               FROM timetable_substitutions sub JOIN timetable_slots ts ON ts.id=sub.slot_id JOIN classes c ON c.id=ts.class_id
               WHERE sub.absence_id=? AND sub.date=? AND sub.substitute_teacher_id IS NOT NULL""",
            (absence_id, date),
        ))
        notified = 0
        for cls in affected:
            recipients = self.notification_recipients(conn, f"class:{cls['class_id']}:parents", cls["class_id"])
            if not recipients:
                continue
            title = "Timetable cover update"
            text = f"{absence['teacher_name']} is absent on {date}. A substitute teacher has been assigned for affected {cls['class_name']} lessons."
            self.insert_notification(conn, title, text, f"class:{cls['class_id']}:parents", recipients, user)
            notified += len(recipients)
        conn.execute("UPDATE timetable_substitutions SET parent_notified_at=datetime('now'), updated_at=datetime('now') WHERE absence_id=? AND date=?", (absence_id, date))
        return self.send_json({"success": True, "data": {"classes": len(affected), "recipients": notified}, "message": f"Parent notifications queued for {len(affected)} class(es)."})

    @staticmethod
    def table_exists(conn, name):
        return bool(one(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,))))

    @staticmethod
    def table_columns(conn, name):
        return {r["name"] for r in rows(conn.execute(f"PRAGMA table_info({name})"))}

    def ensure_calendar_tables(self, conn):
        conn.execute(
            """CREATE TABLE IF NOT EXISTS term_holidays (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   term_id INTEGER NOT NULL,
                   name TEXT NOT NULL,
                   start_date TEXT NOT NULL,
                   end_date TEXT NOT NULL,
                   created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT DEFAULT CURRENT_TIMESTAMP
               )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS calendar_events (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   title TEXT NOT NULL,
                   date TEXT NOT NULL,
                   end_date TEXT,
                   type TEXT DEFAULT 'event',
                   description TEXT,
                   class_id INTEGER,
                   term_id INTEGER,
                   created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                   updated_at TEXT DEFAULT CURRENT_TIMESTAMP
               )"""
        )
        holiday_cols = self.table_columns(conn, "term_holidays")
        for name, ddl in {
            "term_id": "INTEGER",
            "name": "TEXT",
            "start_date": "TEXT",
            "end_date": "TEXT",
            "created_at": "TEXT",
            "updated_at": "TEXT",
        }.items():
            if name not in holiday_cols:
                conn.execute(f"ALTER TABLE term_holidays ADD COLUMN {name} {ddl}")
        event_cols = self.table_columns(conn, "calendar_events")
        for name, ddl in {
            "title": "TEXT",
            "date": "TEXT",
            "end_date": "TEXT",
            "type": "TEXT",
            "description": "TEXT",
            "class_id": "INTEGER",
            "term_id": "INTEGER",
            "created_at": "TEXT",
            "updated_at": "TEXT",
        }.items():
            if name not in event_cols:
                conn.execute(f"ALTER TABLE calendar_events ADD COLUMN {name} {ddl}")

    def filtered_payload(self, conn, table, payload):
        cols = self.table_columns(conn, table)
        return {k: v for k, v in payload.items() if k in cols}

    def insert_row(self, conn, table, payload):
        data = self.filtered_payload(conn, table, payload)
        if not data:
            raise ValueError(f"No writable columns for {table}")
        names = list(data)
        cur = conn.execute(
            f"INSERT INTO {table} ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
            [data[k] for k in names],
        )
        return cur.lastrowid

    def update_row(self, conn, table, row_id, payload):
        data = self.filtered_payload(conn, table, payload)
        if not data:
            raise ValueError(f"No writable columns for {table}")
        assignments = ", ".join(f"{k}=?" for k in data)
        conn.execute(f"UPDATE {table} SET {assignments} WHERE id=?", [*data.values(), row_id])

    def save_admin_session(self, conn, session_id=None):
        body = self.read_body()
        year = as_int(body.get("year"))
        name = clean(body.get("name")) or (f"{year} Academic Year" if year else "")
        if not year or not name:
            return self.send_json({"success": False, "message": "year and name are required"}, 400)
        if not self.table_exists(conn, "academic_sessions"):
            conn.execute(
                """CREATE TABLE IF NOT EXISTS academic_sessions (
                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                       year INTEGER NOT NULL,
                       name TEXT NOT NULL,
                       is_active INTEGER DEFAULT 0,
                       created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                       updated_at TEXT DEFAULT CURRENT_TIMESTAMP
                   )"""
            )
        payload = {"year": year, "name": name, "updated_at": datetime.utcnow().isoformat(timespec="seconds")}
        if session_id:
            if not one(conn.execute("SELECT id FROM academic_sessions WHERE id=?", (session_id,))):
                return self.send_json({"success": False, "message": "Session not found"}, 404)
            self.update_row(conn, "academic_sessions", session_id, payload)
            return self.send_json({"success": True, "message": "Session updated", "data": {"id": session_id}})
        payload["created_at"] = datetime.utcnow().isoformat(timespec="seconds")
        if "is_active" in self.table_columns(conn, "academic_sessions"):
            payload["is_active"] = 0
        new_id = self.insert_row(conn, "academic_sessions", payload)
        return self.send_json({"success": True, "message": "Session created", "data": {"id": new_id}, "id": new_id})

    def activate_admin_session(self, conn, session_id):
        if not one(conn.execute("SELECT id FROM academic_sessions WHERE id=?", (session_id,))):
            return self.send_json({"success": False, "message": "Session not found"}, 404)
        if "is_active" not in self.table_columns(conn, "academic_sessions"):
            return self.send_json({"success": False, "message": "Sessions table has no is_active column"}, 501)
        conn.execute("UPDATE academic_sessions SET is_active=0")
        if "updated_at" in self.table_columns(conn, "academic_sessions"):
            conn.execute("UPDATE academic_sessions SET is_active=1, updated_at=datetime('now') WHERE id=?", (session_id,))
        else:
            conn.execute("UPDATE academic_sessions SET is_active=1 WHERE id=?", (session_id,))
        return self.send_json({"success": True, "message": "Session activated", "data": {"id": session_id}})

    def delete_admin_session(self, conn, session_id):
        session = one(conn.execute("SELECT * FROM academic_sessions WHERE id=?", (session_id,)))
        if not session:
            return self.send_json({"success": False, "message": "Session not found"}, 404)
        if int(session.get("is_active") or 0):
            return self.send_json({"success": False, "message": "Deactivate this session before deleting it."}, 400)
        term_ids = [r["id"] for r in rows(conn.execute("SELECT id FROM terms WHERE session_id=?", (session_id,)))]
        if term_ids:
            placeholders = ",".join("?" for _ in term_ids)
            marks = scalar(conn, f"SELECT COUNT(*) FROM marks WHERE term_id IN ({placeholders})", term_ids, 0) if self.table_exists(conn, "marks") else 0
            attendance = scalar(conn, f"SELECT COUNT(*) FROM attendance_records WHERE term_id IN ({placeholders})", term_ids, 0) if self.table_exists(conn, "attendance_records") else 0
            if marks or attendance:
                return self.send_json({"success": False, "message": "Cannot delete a session that has marks or attendance."}, 400)
            self.ensure_calendar_tables(conn)
            conn.execute(f"DELETE FROM term_holidays WHERE term_id IN ({placeholders})", term_ids)
            conn.execute(f"DELETE FROM calendar_events WHERE term_id IN ({placeholders})", term_ids)
        conn.execute("DELETE FROM terms WHERE session_id=?", (session_id,))
        conn.execute("DELETE FROM academic_sessions WHERE id=?", (session_id,))
        return self.send_json({"success": True, "message": "Session deleted"})

    def save_admin_term(self, conn, session_id=None, term_id=None):
        body = self.read_body()
        if session_id and not one(conn.execute("SELECT id FROM academic_sessions WHERE id=?", (session_id,))):
            return self.send_json({"success": False, "message": "Session not found"}, 404)
        current = one(conn.execute("SELECT * FROM terms WHERE id=?", (term_id,))) if term_id else None
        if term_id and not current:
            return self.send_json({"success": False, "message": "Term not found"}, 404)
        term_number = as_int(body_first(body, "term_number", "termNumber"), current.get("term_number") if current else None)
        term_name = clean(body_first(body, "term_name", "name", "termName")) or (current.get("term_name") if current else "")
        start_date = clean(body_first(body, "start_date", "startDate")) or (current.get("start_date") if current else "")
        end_date = clean(body_first(body, "end_date", "endDate")) or (current.get("end_date") if current else "")
        if not term_number or not term_name or not start_date or not end_date:
            return self.send_json({"success": False, "message": "term_number, term_name, start_date and end_date are required"}, 400)
        if start_date > end_date:
            return self.send_json({"success": False, "message": "end_date must be on or after start_date"}, 400)
        payload = {
            "session_id": session_id if session_id else current.get("session_id"),
            "term_number": term_number,
            "term_name": term_name,
            "start_date": start_date,
            "end_date": end_date,
            "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
        }
        if term_id:
            self.update_row(conn, "terms", term_id, payload)
            return self.send_json({"success": True, "message": "Term updated", "data": {"id": term_id}})
        payload["created_at"] = datetime.utcnow().isoformat(timespec="seconds")
        new_id = self.insert_row(conn, "terms", payload)
        return self.send_json({"success": True, "message": "Term created", "data": {"id": new_id}, "id": new_id})

    def delete_admin_term(self, conn, term_id):
        if not one(conn.execute("SELECT id FROM terms WHERE id=?", (term_id,))):
            return self.send_json({"success": False, "message": "Term not found"}, 404)
        marks = scalar(conn, "SELECT COUNT(*) FROM marks WHERE term_id=?", (term_id,), 0) if self.table_exists(conn, "marks") else 0
        attendance = scalar(conn, "SELECT COUNT(*) FROM attendance_records WHERE term_id=?", (term_id,), 0) if self.table_exists(conn, "attendance_records") else 0
        if marks or attendance:
            return self.send_json({"success": False, "message": "Cannot delete a term that has marks or attendance."}, 400)
        self.ensure_calendar_tables(conn)
        conn.execute("DELETE FROM term_holidays WHERE term_id=?", (term_id,))
        conn.execute("DELETE FROM calendar_events WHERE term_id=?", (term_id,))
        conn.execute("DELETE FROM terms WHERE id=?", (term_id,))
        return self.send_json({"success": True, "message": "Term deleted"})

    def term_holidays(self, conn, term_id):
        self.ensure_calendar_tables(conn)
        return rows(conn.execute(
            """SELECT id, term_id, name, start_date, end_date, created_at, updated_at
               FROM term_holidays WHERE term_id=? ORDER BY date(start_date), id""",
            (term_id,),
        ))

    def save_admin_holiday(self, conn, term_id=None, holiday_id=None):
        self.ensure_calendar_tables(conn)
        body = self.read_body()
        current = one(conn.execute("SELECT * FROM term_holidays WHERE id=?", (holiday_id,))) if holiday_id else None
        if holiday_id and not current:
            return self.send_json({"success": False, "message": "Holiday not found"}, 404)
        term_id = term_id or current.get("term_id")
        if not one(conn.execute("SELECT id FROM terms WHERE id=?", (term_id,))):
            return self.send_json({"success": False, "message": "Term not found"}, 404)
        name = clean(body.get("name")) or (current.get("name") if current else "")
        start_date = clean(body_first(body, "start_date", "startDate")) or (current.get("start_date") if current else "")
        end_date = clean(body_first(body, "end_date", "endDate")) or start_date
        if not name or not start_date or not end_date:
            return self.send_json({"success": False, "message": "name, start_date and end_date are required"}, 400)
        if start_date > end_date:
            return self.send_json({"success": False, "message": "end_date must be on or after start_date"}, 400)
        payload = {"term_id": term_id, "name": name, "start_date": start_date, "end_date": end_date, "updated_at": datetime.utcnow().isoformat(timespec="seconds")}
        if holiday_id:
            self.update_row(conn, "term_holidays", holiday_id, payload)
            return self.send_json({"success": True, "message": "Holiday updated", "data": {"id": holiday_id}})
        payload["created_at"] = datetime.utcnow().isoformat(timespec="seconds")
        new_id = self.insert_row(conn, "term_holidays", payload)
        return self.send_json({"success": True, "message": "Holiday created", "data": {"id": new_id}, "id": new_id})

    def delete_admin_holiday(self, conn, holiday_id):
        self.ensure_calendar_tables(conn)
        conn.execute("DELETE FROM term_holidays WHERE id=?", (holiday_id,))
        return self.send_json({"success": True, "message": "Holiday deleted"})

    def calendar_event_payload(self, body, current=None):
        date = clean(body.get("date")) or (current.get("date") if current else "")
        end_date = clean(body_first(body, "end_date", "endDate")) or date
        return {
            "title": clean(body.get("title")) or (current.get("title") if current else ""),
            "date": date,
            "end_date": end_date,
            "type": clean(body.get("type")) or (current.get("type") if current else "event"),
            "description": clean(body.get("description")) or None,
            "class_id": as_int(body_first(body, "class_id", "classId"), current.get("class_id") if current else None),
            "term_id": as_int(body_first(body, "term_id", "termId"), current.get("term_id") if current else None),
            "updated_at": datetime.utcnow().isoformat(timespec="seconds"),
        }

    def save_calendar_event(self, conn, event_id=None):
        self.ensure_calendar_tables(conn)
        body = self.read_body()
        current = one(conn.execute("SELECT * FROM calendar_events WHERE id=?", (event_id,))) if event_id else None
        if event_id and not current:
            return self.send_json({"success": False, "message": "Event not found"}, 404)
        payload = self.calendar_event_payload(body, current)
        if not payload["title"] or not payload["date"]:
            return self.send_json({"success": False, "message": "title and date are required"}, 400)
        if payload["end_date"] and payload["date"] > payload["end_date"]:
            return self.send_json({"success": False, "message": "endDate must be on or after date"}, 400)
        if event_id:
            self.update_row(conn, "calendar_events", event_id, payload)
            return self.send_json({"success": True, "message": "Event updated", "data": {"id": event_id}})
        payload["created_at"] = datetime.utcnow().isoformat(timespec="seconds")
        new_id = self.insert_row(conn, "calendar_events", payload)
        return self.send_json({"success": True, "message": "Event created", "data": {"id": new_id}, "id": new_id})

    def delete_calendar_event(self, conn, event_id):
        self.ensure_calendar_tables(conn)
        conn.execute("DELETE FROM calendar_events WHERE id=?", (event_id,))
        return self.send_json({"success": True, "message": "Event deleted"})

    def normalize_calendar_event(self, row):
        end_date = row.get("end_date") or row.get("endDate") or row.get("date")
        class_id = row.get("class_id", row.get("classId"))
        term_id = row.get("term_id", row.get("termId"))
        return {**row, "endDate": end_date, "classId": class_id, "termId": term_id}

    def calendar_event(self, conn, event_id):
        row = one(conn.execute("SELECT * FROM calendar_events WHERE id=?", (event_id,)))
        return self.normalize_calendar_event(row) if row else None

    def calendar_events(self, conn, query):
        self.ensure_calendar_tables(conn)
        args = []
        where = []
        date_from = query_first(query, "from", "date_from", "start")
        date_to = query_first(query, "to", "date_to", "end")
        class_id = query_first(query, "class_id", "classId")
        if date_from:
            where.append("date(COALESCE(end_date, date)) >= date(?)")
            args.append(date_from)
        if date_to:
            where.append("date(date) <= date(?)")
            args.append(date_to)
        if class_id:
            where.append("(class_id IS NULL OR class_id=?)")
            args.append(class_id)
        sql = "SELECT * FROM calendar_events"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY date, id"
        return [self.normalize_calendar_event(r) for r in rows(conn.execute(sql, args))]

    def admin_school_day(self, conn, query):
        date = clean(query_first(query, "date", default=now_kenya_date()))
        try:
            day = datetime.fromisoformat(date).date()
        except ValueError:
            return self.send_json({"success": False, "message": "Invalid date"}, 400)
        weekday = day.strftime("%A")
        if day.weekday() >= 5:
            return self.send_json({"success": True, "data": {"date": date, "status": "non_school_day", "is_school_day": False, "reason": "weekend", "message": "Weekend", "weekday": weekday}})
        term = term_for_date(conn, date)
        if not term:
            return self.send_json({"success": True, "data": {"date": date, "status": "non_school_day", "is_school_day": False, "reason": "out_of_term", "message": "No active term covers this date", "weekday": weekday}})
        self.ensure_calendar_tables(conn)
        holiday = one(conn.execute(
            """SELECT id, name, start_date, end_date FROM term_holidays
               WHERE term_id=? AND date(start_date) <= date(?) AND date(end_date) >= date(?)
               ORDER BY date(start_date), id LIMIT 1""",
            (term["id"], date, date),
        ))
        if not holiday:
            holiday = one(conn.execute(
                """SELECT id, title AS name, date AS start_date, COALESCE(end_date, date) AS end_date
                   FROM calendar_events
                   WHERE type='hol' AND (term_id IS NULL OR term_id=?)
                     AND date(date) <= date(?) AND date(COALESCE(end_date, date)) >= date(?)
                   ORDER BY date(date), id LIMIT 1""",
                (term["id"], date, date),
            ))
        if holiday:
            return self.send_json({"success": True, "data": {"date": date, "status": "non_school_day", "is_school_day": False, "reason": "holiday", "message": "Holiday", "holiday": holiday, "term": term, "weekday": weekday}})
        return self.send_json({"success": True, "data": {"date": date, "status": "school_day", "is_school_day": True, "reason": "school_day", "message": "School day", "term": term, "weekday": weekday}})

    def teacher_timetable(self, conn, user):
        active = one(conn.execute("SELECT id FROM timetable_generations WHERE status='active' ORDER BY id DESC LIMIT 1"))
        if not active:
            return self.send_json({"success": True, "data": {"slots": [], "covers": [], "periods": [], "message": "No timetable published yet"}})
        slots = rows(conn.execute(
            """SELECT ts.id, ts.day_of_week, ts.period_no, ts.subject_id, ts.teacher_id,
                      sub.name AS subject_name, c.id AS class_id, c.name AS class_name,
                      COALESCE(r.id, hr.id) AS room_id, COALESCE(r.name, hr.name) AS room_name
               FROM timetable_slots ts
               JOIN subjects sub ON sub.id=ts.subject_id
               JOIN classes c ON c.id=ts.class_id
               LEFT JOIN timetable_rooms r ON r.id=ts.room_id
               LEFT JOIN timetable_rooms hr ON hr.home_class_id=c.id AND hr.status='active'
               WHERE ts.generation_id=? AND ts.teacher_id=?
               ORDER BY ts.day_of_week, ts.period_no""",
            (active["id"], user["id"]),
        ))
        periods = rows(conn.execute("SELECT * FROM bell_periods WHERE schedule_id=1 ORDER BY period_no"))
        return self.send_json({"success": True, "data": {"slots": slots, "covers": [], "periods": periods, "today": now_kenya_date()}})

    def teacher_attendance_overview(self, conn, user, query):
        date = query.get("date", [now_kenya_date()])[0]
        homerooms, _ = teacher_class_lists(conn, user["id"])
        out = []
        for c in homerooms:
            marked = bool(one(conn.execute("SELECT id FROM attendance_records WHERE class_id=? AND date=? LIMIT 1", (c["id"], date))))
            out.append({"id": c["id"], "name": c["name"], "learner_count": c.get("enrollment_count") or 0, "marked": marked})
        return self.send_json({"success": True, "data": {"date": date, "classes": out, "total_classes": len(out), "marked_count": sum(1 for c in out if c["marked"]), "pending_count": sum(1 for c in out if not c["marked"])}})

    def teacher_marks(self, conn, user, query):
        class_id = int(query.get("class_id", [0])[0])
        subject_id = int(query.get("subject_id", [0])[0])
        assessment = valid_assessment(query.get("assessment_type", [""])[0], "")
        cls = require_owned_subject(conn, user, class_id, subject_id)
        if not cls:
            return self.send_json({"success": False, "message": "You do not teach this subject"}, 403)
        term = resolve_term(conn, query.get("term_id", [None])[0])
        marks = rows(conn.execute("SELECT learner_id, component_key, score FROM marks WHERE class_id=? AND subject_id=? AND term_id=? AND assessment_type=?", (class_id, subject_id, term["id"], assessment)))
        entries = {}
        for r in marks:
            entries.setdefault(str(r["learner_id"]), {})[r["component_key"]] = r["score"]
        learners = rows(conn.execute("SELECT id,name,admission_no FROM users WHERE role='learner' AND status='active' AND class_name=? ORDER BY name", (cls["name"],)))
        return self.send_json({"success": True, "data": {"term": {"id": term["id"], "name": term["name"]}, "entries": entries, "learners": learners}})

    def save_teacher_marks(self, conn, user):
        if not has_role_permission(conn, user, "marks_write"):
            return self.send_json({"success": False, "message": "Your role is not allowed to enter marks."}, 403)
        body = self.read_body()
        class_id = int(body.get("class_id") or 0)
        subject_id = int(body.get("subject_id") or 0)
        assessment = valid_assessment(body.get("assessment_type"), "")
        cls = require_owned_subject(conn, user, class_id, subject_id)
        if not cls:
            return self.send_json({"success": False, "message": "You do not teach this subject"}, 403)
        term = resolve_term(conn, body.get("term_id"))
        comps = {c["component_key"]: float(c["max_score"] or 0) for c in assessment_components(conn, class_id, subject_id, assessment)}
        learner_ids = {r["id"] for r in rows(conn.execute("SELECT id FROM users WHERE role='learner' AND status='active' AND class_name=?", (cls["name"],)))}
        saved = 0
        for e in body.get("entries") or []:
            lid = int(e.get("learner_id") or 0)
            key = clean(e.get("component_key"))
            if lid not in learner_ids or key not in comps:
                continue
            score = e.get("score")
            if score in ("", None):
                conn.execute("DELETE FROM marks WHERE learner_id=? AND class_id=? AND subject_id=? AND term_id=? AND assessment_type=? AND component_key=?", (lid, class_id, subject_id, term["id"], assessment, key))
            else:
                val = max(0, min(float(score), comps[key]))
                conn.execute(
                    """INSERT INTO marks (learner_id,class_id,subject_id,term_id,assessment_type,component_key,score,created_by,created_at,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
                       ON CONFLICT(learner_id,subject_id,term_id,assessment_type,component_key)
                       DO UPDATE SET score=excluded.score, updated_at=datetime('now')""",
                    (lid, class_id, subject_id, term["id"], assessment, key, val, user["id"]),
                )
            conn.execute(
                """INSERT INTO marks_publications (class_id, subject_id, term_id, assessment_type, status, updated_at)
                   VALUES (?, ?, ?, ?, 'draft', datetime('now'))
                   ON CONFLICT(class_id, subject_id, term_id, assessment_type)
                   DO UPDATE SET status='draft', published_at=NULL, published_by=NULL, updated_at=datetime('now')""",
                (class_id, subject_id, term["id"], assessment),
            )
            saved += 1
        return self.send_json({"success": True, "message": f"Saved {saved} entries"})

    def teaching_analytics(self, conn, user, query):
        term = resolve_term(conn, query.get("term_id", [None])[0])
        assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
        _, subjects = teacher_class_lists(conn, user["id"])
        out = []
        for s in subjects:
            comps = assessment_components(conn, s["class_id"], s["subject_id"], assessment)
            pct_map = subject_percent_map(conn, s["class_id"], s["subject_id"], term["id"], assessment) if term else {}
            vals = list(pct_map.values())
            out.append({**s, "components_configured": bool(comps), "learners_marked": len(vals), "mean_percent": round(sum(vals) / len(vals), 1) if vals else None})
        return self.send_json({"success": True, "data": {"subjects": out, "current_term": {"id": term["id"], "name": term["name"]} if term else None, "current_assessment": assessment}})

    def teacher_skills(self, conn, user, query):
        class_id = int(query.get("class_id", [0])[0])
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, query.get("term_id", [None])[0])
        assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
        data = rows(conn.execute("SELECT learner_id, category_key, item_key, rating FROM learner_skills WHERE class_id=? AND term_id=? AND assessment_type=?", (class_id, term["id"], assessment))) if term else []
        entries = {}
        for r in data:
            entries.setdefault(str(r["learner_id"]), {}).setdefault(r["category_key"], {})[r["item_key"]] = r["rating"]
        return self.send_json({"success": True, "data": {"term": {"id": term["id"], "name": term["name"]} if term else None, "entries": entries}})

    def save_teacher_skills(self, conn, user):
        body = self.read_body()
        class_id = as_int(body.get("class_id"))
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, body.get("term_id"))
        assessment = valid_assessment(body.get("assessment_type"), detect_assessment(term))
        learner_ids = active_learner_ids(conn, cls["name"])
        saved = 0
        for e in body.get("entries") or []:
            lid = as_int(e.get("learner_id"))
            cat = clean(e.get("category_key"))
            item = clean(e.get("item_key"))
            if lid not in learner_ids or not cat or not item:
                continue
            rating = e.get("rating")
            if rating in ("", None):
                conn.execute("DELETE FROM learner_skills WHERE learner_id=? AND term_id=? AND assessment_type=? AND category_key=? AND item_key=?", (lid, term["id"], assessment, cat, item))
            else:
                val = max(1, min(5, int(rating)))
                conn.execute("""INSERT INTO learner_skills (learner_id,class_id,term_id,assessment_type,category_key,item_key,rating,created_by,created_at,updated_at)
                                VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
                                ON CONFLICT(learner_id,term_id,assessment_type,category_key,item_key)
                                DO UPDATE SET rating=excluded.rating, updated_at=datetime('now')""", (lid, class_id, term["id"], assessment, cat, item, val, user["id"]))
            saved += 1
        return self.send_json({"success": True, "message": f"Saved {saved} ratings"})

    def teacher_comments(self, conn, user, query):
        class_id = int(query.get("class_id", [0])[0])
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, query.get("term_id", [None])[0])
        assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
        data = rows(conn.execute("SELECT learner_id, comment_text FROM learner_comments WHERE class_id=? AND term_id=? AND assessment_type=? AND role='class_teacher'", (class_id, term["id"], assessment))) if term else []
        return self.send_json({"success": True, "data": {"term": {"id": term["id"], "name": term["name"]} if term else None, "entries": {str(r["learner_id"]): r["comment_text"] or "" for r in data}}})

    def save_teacher_comments(self, conn, user):
        body = self.read_body()
        class_id = as_int(body.get("class_id"))
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, body.get("term_id"))
        assessment = valid_assessment(body.get("assessment_type"), detect_assessment(term))
        learner_ids = active_learner_ids(conn, cls["name"])
        saved = 0
        for e in body.get("entries") or []:
            lid = as_int(e.get("learner_id"))
            if lid not in learner_ids:
                continue
            text = clean(e.get("comment_text"))
            if not text:
                conn.execute("DELETE FROM learner_comments WHERE learner_id=? AND term_id=? AND assessment_type=? AND role='class_teacher'", (lid, term["id"], assessment))
            else:
                conn.execute("""INSERT INTO learner_comments (learner_id,class_id,term_id,assessment_type,role,comment_text,created_by,created_at,updated_at)
                                VALUES (?,?,?,?, 'class_teacher', ?, ?, datetime('now'), datetime('now'))
                                ON CONFLICT(learner_id,term_id,assessment_type,role)
                                DO UPDATE SET comment_text=excluded.comment_text, updated_at=datetime('now')""", (lid, class_id, term["id"], assessment, text[:1000], user["id"]))
            saved += 1
        return self.send_json({"success": True, "message": f"Saved {saved} comments"})

    def teacher_report_readiness(self, conn, user, query):
        class_id = int(query.get("class_id", [0])[0])
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, query.get("term_id", [None])[0])
        assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
        total = scalar(conn, "SELECT COUNT(*) FROM class_subjects WHERE class_id=?", (class_id,), 0)
        learners = rows(conn.execute("SELECT id AS learner_id, name, admission_no FROM users WHERE role='learner' AND status='active' AND class_name=? ORDER BY name", (cls["name"],)))
        done = {r["learner_id"]: r["done"] for r in rows(conn.execute("SELECT learner_id, COUNT(DISTINCT subject_id) AS done FROM marks WHERE class_id=? AND term_id=? AND assessment_type=? GROUP BY learner_id", (class_id, term["id"], assessment)))}
        for l in learners:
            count = min(int(done.get(l["learner_id"], 0) or 0), int(total or 0))
            l.update({"subjects_done": count, "subjects_total": total, "status": "ready" if not total or count >= total else "partial"})
        return self.send_json({"success": True, "data": {"class": cls, "term": {"id": term["id"], "name": term["name"]}, "assessment": assessment, "subjects_total": total, "learners": learners}})

    def teacher_report_card(self, conn, user, query, batch=False):
        class_id = int(query.get("class_id", [0])[0])
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        term = resolve_term(conn, query.get("term_id", [None])[0])
        assessment = valid_assessment(query.get("assessment_type", [None])[0], detect_assessment(term))
        ids_text = clean(query.get("learner_ids", [""])[0])
        ids = [] if not ids_text or ids_text.lower() == "all" else ids_text.split(",")
        learner_id = as_int(query.get("learner_id", [None])[0])
        data = report_payload(conn, cls, term, assessment, selected_ids=ids, single_learner_id=None if batch else learner_id)
        if not batch and not data.get("learner"):
            return self.send_json({"success": False, "message": "Learner not found in your class"}, 404)
        return self.send_json({"success": True, "data": data})

    def save_teacher_booking(self, conn, user):
        if not self.table_exists(conn, "lesson_bookings"):
            return self.send_json({"success": False, "message": "Bookings table not available"}, 501)
        body = self.read_body()
        class_id = as_int(body.get("class_id"))
        subject_id = as_int(body.get("subject_id"))
        day = as_int(body.get("day_of_week"))
        period = as_int(body.get("period_no"))
        date = clean(body.get("date")) or now_kenya_date()
        if not class_id or not subject_id or not day or not period:
            return self.send_json({"success": False, "message": "class_id, subject_id, day_of_week and period_no are required"}, 400)
        room_id = as_int(body.get("room_id"))
        reason = clean(body.get("reason")) or clean(body.get("title")) or "Lesson booking"
        cols = {r["name"] for r in rows(conn.execute("PRAGMA table_info(lesson_bookings)"))}
        payload = {"teacher_id": user["id"], "class_id": class_id, "subject_id": subject_id, "day_of_week": day, "period_no": period, "date": date, "reason": reason, "status": "pending"}
        if "room_id" in cols:
            payload["room_id"] = room_id
        names = [k for k in payload if k in cols]
        cur = conn.execute(f"INSERT INTO lesson_bookings ({','.join(names)}) VALUES ({','.join('?' for _ in names)})", [payload[k] for k in names])
        return self.send_json({"success": True, "message": "Booking requested", "id": cur.lastrowid})

    def save_attendance(self, conn, user):
        body = self.read_body()
        class_id = int(body.get("class_id") or 0)
        cls = require_owned_class(conn, user, class_id)
        if not cls:
            return self.send_json({"success": False, "message": "Not your class"}, 403)
        date = clean(body.get("date")) or now_kenya_date()
        term = term_for_date(conn, date) or default_term(conn)
        cur = conn.execute(
            """INSERT INTO attendance_records (class_id, term_id, date, created_by, created_at)
               VALUES (?, ?, ?, ?, datetime('now'))
               ON CONFLICT(class_id, date) DO UPDATE SET term_id=excluded.term_id
               RETURNING id""",
            (class_id, term["id"], date, user["id"]),
        )
        record_id = cur.fetchone()[0]
        status_map = {"P": "present", "A": "absent", "L": "late", "present": "present", "absent": "absent", "late": "late"}
        for e in body.get("entries") or []:
            lid = int(e.get("learner_id") or 0)
            status = status_map.get(clean(e.get("status")), "present")
            conn.execute(
                """INSERT INTO attendance_entries (record_id, learner_id, status, note)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(record_id, learner_id) DO UPDATE SET status=excluded.status, note=excluded.note""",
                (record_id, lid, status, clean(e.get("note")) or None),
            )
        return self.send_json({"success": True, "message": "Attendance saved"})


def main():
    port = int(os.environ.get("PORT", "3000"))
    host = os.environ.get("HOST", "0.0.0.0")
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Daraja Python backend running on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
