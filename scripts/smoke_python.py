#!/usr/bin/env python3
"""Authenticated smoke tests for py_backend.py."""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
SMOKE_PASSWORD = "smoke123"
SMOKE_CODE = "SMOKE1"


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Client:
    def __init__(self, port: int):
        self.port = port
        self.cookie = ""

    def request(self, method: str, path: str, body=None, ok=(200,)):
        raw = None
        headers = {}
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if self.cookie:
            headers["Cookie"] = self.cookie
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, raw, headers)
        resp = conn.getresponse()
        data = resp.read()
        set_cookie = resp.getheader("Set-Cookie")
        if set_cookie:
            self.cookie = set_cookie.split(";", 1)[0]
        if resp.status not in ok:
            raise AssertionError(f"{method} {path} -> {resp.status}: {data[:300]!r}")
        ctype = resp.getheader("Content-Type") or ""
        if "application/json" in ctype:
            return resp.status, json.loads(data.decode("utf-8"))
        return resp.status, data.decode("utf-8", "replace")


def pick_report_context():
    conn = sqlite3.connect(ROOT / "data" / "joyland.db")
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        """SELECT c.id AS class_id, u.id AS learner_id
           FROM classes c JOIN users u ON u.class_name=c.name AND u.role='learner'
           WHERE c.status='active' AND u.status='active'
           ORDER BY c.id, u.id LIMIT 1"""
    ).fetchone()
    term = conn.execute(
        """SELECT id FROM terms
           WHERE date(start_date) <= date('now') AND date(end_date) >= date('now')
           ORDER BY id DESC LIMIT 1"""
    ).fetchone() or conn.execute("SELECT id FROM terms ORDER BY id DESC LIMIT 1").fetchone()
    if not row or not term:
        raise AssertionError("Need at least one active class, learner, and term for report smoke tests")
    return int(row["class_id"]), int(row["learner_id"]), int(term["id"])


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return bool(conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone())


def columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def ensure_notification_fixture():
    conn = sqlite3.connect(ROOT / "data" / "joyland.db")
    conn.row_factory = sqlite3.Row
    try:
        for required in ("notifications", "notification_recipients", "parent_accounts"):
            if not table_exists(conn, required):
                raise AssertionError(f"Need {required} table for notification smoke tests")
        learner = conn.execute(
            """SELECT u.id, u.user_id, c.id AS class_id
               FROM users u JOIN classes c ON c.name=u.class_name
               WHERE u.role='learner' AND u.status='active' AND c.status='active'
               ORDER BY u.id LIMIT 1"""
        ).fetchone()
        teacher = conn.execute(
            "SELECT id, user_id FROM users WHERE role='teacher' AND status='active' ORDER BY id LIMIT 1"
        ).fetchone()
        parent = conn.execute(
            "SELECT id, parent_id FROM parent_accounts WHERE status='active' ORDER BY id LIMIT 1"
        ).fetchone()
        if not learner or not teacher:
            raise AssertionError("Need at least one active learner and teacher for notification smoke tests")
        if not parent:
            parent_cols = columns(conn, "parent_accounts")
            payload = {
                "parent_id": "SMOKEPARENT",
                "name": "Smoke Parent",
                "password": SMOKE_PASSWORD,
                "status": "active",
                "created_at": "datetime('now')",
                "updated_at": "datetime('now')",
            }
            names = [k for k in payload if k in parent_cols]
            values = [payload[k] for k in names]
            sql_values = ["datetime('now')" if v == "datetime('now')" else "?" for v in values]
            bind = [v for v in values if v != "datetime('now')"]
            cur = conn.execute(f"INSERT INTO parent_accounts ({','.join(names)}) VALUES ({','.join(sql_values)})", bind)
            parent = {"id": cur.lastrowid, "parent_id": "SMOKEPARENT"}
        originals = {
            "users": {
                int(learner["id"]): conn.execute("SELECT temp_code, temp_code_expiry FROM users WHERE id=?", (learner["id"],)).fetchone(),
                int(teacher["id"]): conn.execute("SELECT temp_code, temp_code_expiry FROM users WHERE id=?", (teacher["id"],)).fetchone(),
            },
            "parents": {
                int(parent["id"]): conn.execute("SELECT temp_code, temp_code_expiry FROM parent_accounts WHERE id=?", (parent["id"],)).fetchone(),
            },
        }
        expiry = "2999-01-01T00:00:00+00:00"
        conn.execute("UPDATE users SET temp_code=?, temp_code_expiry=?, status='active' WHERE id=?", (SMOKE_CODE, expiry, learner["id"]))
        conn.execute("UPDATE users SET temp_code=?, temp_code_expiry=?, status='active' WHERE id=?", (SMOKE_CODE, expiry, teacher["id"]))
        conn.execute("UPDATE parent_accounts SET temp_code=?, temp_code_expiry=?, status='active' WHERE id=?", (SMOKE_CODE, expiry, parent["id"]))
        conn.commit()
        return {
            "class_id": int(learner["class_id"]),
            "learner_id": int(learner["id"]),
            "learner_user_id": learner["user_id"],
            "teacher_user_id": teacher["user_id"],
            "parent_id": int(parent["id"]),
            "parent_user_id": parent["parent_id"],
            "originals": originals,
        }
    finally:
        conn.close()


def restore_notification_fixture(fixture):
    if not fixture:
        return
    conn = sqlite3.connect(ROOT / "data" / "joyland.db")
    try:
        for user_id, row in fixture.get("originals", {}).get("users", {}).items():
            conn.execute("UPDATE users SET temp_code=?, temp_code_expiry=? WHERE id=?", (row["temp_code"], row["temp_code_expiry"], user_id))
        for parent_id, row in fixture.get("originals", {}).get("parents", {}).items():
            conn.execute("UPDATE parent_accounts SET temp_code=?, temp_code_expiry=? WHERE id=?", (row["temp_code"], row["temp_code_expiry"], parent_id))
        conn.commit()
    finally:
        conn.close()


def static_references():
    files = list((PUBLIC / "admin").glob("*.html")) + list((PUBLIC / "app").glob("*.html")) + list((PUBLIC / "app").glob("*.js")) + [PUBLIC / "login.html", PUBLIC / "template-editor.html"]
    attr = re.compile(r"""(?:href|src|action)=["']([^"']+)["']""", re.I)
    css = re.compile(r"url\(([^)]+)\)", re.I)
    refs = []
    for path in files:
        text = path.read_text(encoding="utf-8")
        for m in attr.finditer(text):
            refs.append((path, m.group(1).strip()))
        for m in css.finditer(text):
            refs.append((path, m.group(1).strip().strip("'\"")))
    return refs


def assert_static_refs():
    missing = []
    for path, ref in static_references():
        if not ref or ref.startswith(("#", "http://", "https://", "mailto:", "data:")):
            continue
        if "${" in ref or "+" in ref or ref.startswith("`"):
            continue
        clean = ref.split("?", 1)[0].split("#", 1)[0]
        if not clean.startswith("/"):
            continue
        if clean in ("/", "/admin", "/template-editor", "/teacher", "/learner", "/parent") or clean.startswith("/api/") or clean.startswith("/school"):
            continue
        target = PUBLIC / clean.lstrip("/")
        if not target.exists():
            missing.append(f"{path.relative_to(ROOT)} -> {ref}")
    if missing:
        raise AssertionError("Missing static references:\n" + "\n".join(missing[:50]))


def login_as(client: Client, identifier: str):
    _, payload = client.request("POST", "/api/auth/temp-login", {"identifier": identifier, "temp_code": SMOKE_CODE, "school_slug": "joyland"})
    assert payload.get("success") is True


def unread_count(client: Client) -> int:
    _, payload = client.request("GET", "/api/notifications/unread-count")
    return int(payload.get("data", {}).get("unread_count") or 0)


def inbox_ids(client: Client) -> set[int]:
    _, payload = client.request("GET", "/api/notifications/inbox")
    notifications = payload.get("data", {}).get("notifications") or []
    return {int(n["id"]) for n in notifications if n.get("id") is not None}


def send_broadcast(client: Client, audience: str, subject: str, body: str, **extra) -> int:
    _, payload = client.request("POST", "/api/notifications/broadcasts", {
        "audience": audience,
        "subject": subject,
        "body": body,
        "channels": ["in-app", "sms", "email"],
        **extra,
    })
    assert payload.get("success") is True
    data = payload.get("data", {})
    assert int(data.get("recipients") or 0) > 0
    return int(data["id"])


def assert_unread_flow(admin: Client, recipient: Client, audience: str, label: str, **extra):
    before = unread_count(recipient)
    nid = send_broadcast(admin, audience, f"Smoke {label} {int(time.time())}", "Notification smoke test", **extra)
    after = unread_count(recipient)
    assert after >= before + 1, f"{label} unread count did not increase: before={before}, after={after}"
    assert nid in inbox_ids(recipient), f"{label} inbox did not include notification {nid}"
    _, read = recipient.request("POST", f"/api/notifications/read/{nid}", {})
    assert read.get("success") is True
    final = unread_count(recipient)
    assert final < after, f"{label} unread count did not decrease after read: after={after}, final={final}"
    return nid


def active_session_id():
    conn = sqlite3.connect(ROOT / "data" / "joyland.db")
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT id FROM academic_sessions WHERE is_active=1 LIMIT 1").fetchone()
        return int(row["id"]) if row else None
    finally:
        conn.close()


def cleanup_session_calendar_smoke(ids, previous_active):
    conn = sqlite3.connect(ROOT / "data" / "joyland.db")
    try:
        if ids.get("event_id"):
            conn.execute("DELETE FROM calendar_events WHERE id=?", (ids["event_id"],))
        if ids.get("holiday_id"):
            conn.execute("DELETE FROM term_holidays WHERE id=?", (ids["holiday_id"],))
        if ids.get("term_id"):
            conn.execute("DELETE FROM term_holidays WHERE term_id=?", (ids["term_id"],))
            conn.execute("DELETE FROM calendar_events WHERE term_id=?", (ids["term_id"],))
            conn.execute("DELETE FROM terms WHERE id=?", (ids["term_id"],))
        if ids.get("session_id"):
            if previous_active:
                conn.execute("UPDATE academic_sessions SET is_active=0")
                conn.execute("UPDATE academic_sessions SET is_active=1 WHERE id=?", (previous_active,))
            else:
                conn.execute("UPDATE academic_sessions SET is_active=0 WHERE id=?", (ids["session_id"],))
            conn.execute("DELETE FROM terms WHERE session_id=?", (ids["session_id"],))
            conn.execute("DELETE FROM academic_sessions WHERE id=?", (ids["session_id"],))
        conn.commit()
    finally:
        conn.close()


def session_calendar_smoke(client: Client):
    previous_active = active_session_id()
    ids = {}
    try:
        year = 2098
        _, created = client.request("POST", "/api/admin/sessions", {"year": year, "name": "Smoke Academic Year"})
        ids["session_id"] = int(created.get("data", {}).get("id") or created.get("id"))
        _, activated = client.request("PATCH", f"/api/admin/sessions/{ids['session_id']}/activate")
        assert activated.get("success") is True
        _, term = client.request("POST", f"/api/admin/sessions/{ids['session_id']}/terms", {
            "term_number": 1,
            "term_name": "Smoke Term",
            "start_date": "2098-02-01",
            "end_date": "2098-02-28",
        })
        ids["term_id"] = int(term.get("data", {}).get("id") or term.get("id"))
        _, holiday = client.request("POST", f"/api/admin/terms/{ids['term_id']}/holidays", {
            "name": "Smoke Midterm",
            "start_date": "2098-02-05",
            "end_date": "2098-02-05",
        })
        ids["holiday_id"] = int(holiday.get("data", {}).get("id") or holiday.get("id"))
        _, school_day = client.request("GET", "/api/admin/school-day?date=2098-02-05")
        assert school_day.get("data", {}).get("is_school_day") is False
        assert school_day.get("data", {}).get("reason") == "holiday"
        _, event = client.request("POST", "/api/admin/calendar/events", {
            "title": "Smoke Calendar Event",
            "date": "2098-03-01",
            "endDate": "2098-03-02",
            "type": "event",
            "description": "created by smoke test",
        })
        ids["event_id"] = int(event.get("data", {}).get("id") or event.get("id"))
        _, filtered_in = client.request("GET", "/api/admin/calendar/events?from=2098-03-02&to=2098-03-02")
        assert ids["event_id"] in {int(e["id"]) for e in filtered_in.get("data", [])}
        _, filtered_out = client.request("GET", "/api/admin/calendar/events?from=2098-03-03&to=2098-03-03")
        assert ids["event_id"] not in {int(e["id"]) for e in filtered_out.get("data", [])}
        _, updated = client.request("PUT", f"/api/admin/calendar/events/{ids['event_id']}", {
            "title": "Smoke Calendar Event Updated",
            "date": "2098-03-01",
            "endDate": "2098-03-02",
            "type": "meet",
            "description": "updated by smoke test",
        })
        assert updated.get("success") is True
        _, deleted_event = client.request("DELETE", f"/api/admin/calendar/events/{ids['event_id']}")
        assert deleted_event.get("success") is True
        ids["event_id"] = None
        _, deleted_holiday = client.request("DELETE", f"/api/admin/holidays/{ids['holiday_id']}")
        assert deleted_holiday.get("success") is True
        ids["holiday_id"] = None
        cleanup_session_calendar_smoke(ids, previous_active)
        ids.clear()
        print("sessions/terms/holidays/calendar writes: ok")
    finally:
        cleanup_session_calendar_smoke(ids, previous_active)


def main() -> int:
    fixture = None
    fixture = ensure_notification_fixture()
    port = free_port()
    env = os.environ.copy()
    env.update({"PORT": str(port), "HOST": "127.0.0.1", "APP_ENV": "development"})
    proc = subprocess.Popen([sys.executable, "py_backend.py"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        client = Client(port)
        deadline = time.time() + 12
        while True:
            try:
                client.request("GET", "/api/school-info")
                break
            except Exception:
                if time.time() > deadline:
                    raise
                time.sleep(0.2)

        status, _ = client.request("GET", "/admin/overview.html", ok=(302,))
        print(f"logged-out admin redirects: {status}")
        _, login = client.request("POST", "/api/auth/login", {"identifier": "JS-ADM-0001", "password": "admin123", "school_slug": "joyland"})
        assert login.get("success") is True
        print("admin login: ok")
        _, me = client.request("GET", "/api/auth/me")
        assert me.get("authenticated") is True
        for path in ("/api/admin/learners", "/api/admin/teachers", "/api/admin/classes"):
            _, payload = client.request("GET", path)
            assert payload.get("success") is True and isinstance(payload.get("data"), list)
            print(f"{path}: ok")
        _, saved = client.request("PUT", "/api/admin/school-settings", {"phase2_smoke_test": str(int(time.time()))})
        assert saved.get("success") is True
        print("school settings save: ok")
        for path in ("/api/notifications/admin/history", "/api/notifications/inbox", "/api/notifications/stats?range=30days"):
            _, payload = client.request("GET", path)
            assert payload.get("success") is True
            print(f"{path}: ok")
        learner_client = Client(port)
        teacher_client = Client(port)
        parent_client = Client(port)
        login_as(learner_client, fixture["learner_user_id"])
        login_as(teacher_client, fixture["teacher_user_id"])
        login_as(parent_client, fixture["parent_user_id"])
        assert_unread_flow(client, learner_client, "all-learners", "learner")
        assert_unread_flow(client, teacher_client, "all-teachers", "teacher")
        assert_unread_flow(client, parent_client, "all-parents", "parent")
        assert_unread_flow(
            client,
            learner_client,
            f"class:{fixture['class_id']}:learners",
            "class learner",
            target_class_id=fixture["class_id"],
        )
        print("notification create/inbox/unread/read: ok")
        _, publish = client.request("POST", "/api/admin/marks/publish", {"classId": fixture["class_id"]}, ok=(400,))
        assert publish.get("success") is False
        print("marks publish validation guard: ok")
        session_calendar_smoke(client)
        class_id, learner_id, term_id = pick_report_context()
        _, report = client.request("GET", f"/api/admin/report-card?class_id={class_id}&learner_id={learner_id}&term_id={term_id}&assessment_type=midterm")
        assert report.get("success") is True and report.get("data", {}).get("learner")
        print("report preview: ok")
        _, broad = client.request("GET", f"/api/admin/marks/broadsheet?class_id={class_id}&term_id={term_id}&assessment_type=midterm")
        assert broad.get("success") is True and "learners" in broad.get("data", {})
        print("broadsheet: ok")
        assert_static_refs()
        print("static references: ok")
        return 0
    finally:
        restore_notification_fixture(fixture)
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
