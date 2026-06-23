#!/usr/bin/env python3
"""Build a frontend route/static reference audit for the Python backend."""

from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"
OUT = ROOT / "docs" / "phase2-route-map.md"
SCAN = [
    *sorted((PUBLIC / "admin").glob("*.html")),
    *sorted((PUBLIC / "admin" / "_shared").glob("*.js")),
    *sorted((PUBLIC / "app").glob("*.html")),
    *sorted((PUBLIC / "app").glob("*.js")),
    PUBLIC / "template-editor.html",
    PUBLIC / "login.html",
]

FETCH_RE = re.compile(r"fetch\(([^)\n]+)", re.I)
API_RE = re.compile(r"api\.(?:get|post|put|req)\(([^)\n]+)|api\('([A-Z]+)'\s*,\s*([^)\n]+)", re.I)
ATTR_RE = re.compile(r"""(?:href|src|action)=["']([^"']+)["']""", re.I)
CSS_RE = re.compile(r"url\(([^)]+)\)", re.I)
PY_TEXT = (ROOT / "py_backend.py").read_text(encoding="utf-8")


def clean_ref(value: str) -> str:
    value = value.strip().strip("`'\"")
    m = re.match(r"([^'\"`,)]+)", value)
    if m and value.startswith("/"):
        value = m.group(1)
    if "+" in value or "${" in value:
        return value
    return value.split("?")[0].split("#")[0]


def status_for(method: str, route: str) -> str:
    if route.startswith("http") or route.startswith("data:") or route.startswith("#") or route.startswith("mailto:"):
        return "working"
    base = route.split("?")[0]
    if base.startswith("/api/"):
        dynamic_prefixes = [
            "/api/parent/children/", "/api/teacher/classes/",
            "/api/admin/templates/", "/api/admin/learners/", "/api/admin/teachers/",
        ]
        if any(base.startswith(p) for p in dynamic_prefixes):
            return "working"
        if base in PY_TEXT and f'method == "{method}"' in PY_TEXT:
            return "working"
        if base in PY_TEXT:
            return "stub" if "not implemented" in PY_TEXT.lower() else "working"
        prefix = re.sub(r"/\$\{[^}]+\}|/\d+|/[^/]*\+", "/", base).rstrip("/")
        return "missing" if prefix not in PY_TEXT else "stub"
    if base.startswith("/"):
        target = (PUBLIC / base.lstrip("/")).resolve()
        if base in ("/", "/admin", "/template-editor", "/teacher", "/learner", "/parent") or base.startswith("/school"):
            return "working"
        return "working" if str(target).startswith(str(PUBLIC.resolve())) and target.exists() else "broken"
    return "working"


def infer_method(snippet: str) -> str:
    m = re.search(r"method\s*:\s*['\"]([A-Z]+)['\"]", snippet)
    if m:
        return m.group(1)
    if ".post(" in snippet or "api('POST'" in snippet:
        return "POST"
    if ".put(" in snippet or "api('PUT'" in snippet:
        return "PUT"
    if "DELETE" in snippet:
        return "DELETE"
    if "PATCH" in snippet:
        return "PATCH"
    return "GET"


def expected_shape(route: str) -> str:
    if route.startswith("/api/auth/login"):
        return "{success, role, name, redirect}"
    if route.startswith("/api/auth/me"):
        return "{authenticated, user}"
    if "broadsheet" in route:
        return "{success,data:{class,term,school,subjects,learners}}"
    if "report-card" in route:
        return "{success,data:{school,class,term,subjects,learners/all_marks}}"
    if route.startswith("/api/"):
        return "{success,data|message}"
    return "static/navigation"


def body_shape(snippet: str) -> str:
    if "body:" not in snippet:
        return "-"
    if "JSON.stringify" in snippet:
        return "JSON body"
    if "FormData" in snippet:
        return "form data"
    return "request body"


def main() -> int:
    rows = []
    static_refs = []
    for path in SCAN:
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(ROOT).as_posix()
        for m in FETCH_RE.finditer(text):
            snippet = text[m.start() : min(len(text), m.start() + 240)]
            route = clean_ref(m.group(1).split(",", 1)[0])
            rows.append((rel, infer_method(snippet), route, body_shape(snippet), expected_shape(route), status_for(infer_method(snippet), route)))
        for m in API_RE.finditer(text):
            snippet = text[m.start() : min(len(text), m.start() + 240)]
            method = (m.group(2) or infer_method(snippet) or "GET").upper()
            route = clean_ref(m.group(1) or m.group(3) or "")
            rows.append((rel, method, route, body_shape(snippet), expected_shape(route), status_for(method, route)))
        for m in ATTR_RE.finditer(text):
            route = clean_ref(m.group(1))
            static_refs.append((rel, "GET", route, "-", expected_shape(route), status_for("GET", route)))
        for m in CSS_RE.finditer(text):
            route = clean_ref(m.group(1))
            static_refs.append((rel, "GET", route, "-", "CSS asset", status_for("GET", route)))

    dedup = []
    seen = set()
    for row in rows + static_refs:
        key = (row[0], row[1], row[2])
        if row[2] and key not in seen:
            seen.add(key)
            dedup.append(row)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Phase 2 Route Map",
        "",
        "| Frontend file | Method | Route/reference | Request body | Expected response | Status |",
        "|---|---:|---|---|---|---|",
    ]
    for rel, method, route, body, shape, status in sorted(dedup):
        route = route.replace("|", "\\|")
        lines.append(f"| `{rel}` | `{method}` | `{route}` | {body} | {shape} | **{status}** |")
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    counts = {}
    for *_, status in dedup:
        counts[status] = counts.get(status, 0) + 1
    print(f"Wrote {OUT.relative_to(ROOT)}")
    print("Statuses:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
