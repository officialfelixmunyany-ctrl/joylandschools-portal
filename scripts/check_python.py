#!/usr/bin/env python3
"""Python-only project check for Daraja."""

from __future__ import annotations

import ast
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", "android", ".tools", "data", "docs"}
TEXT_SUFFIXES = {".py", ".html", ".css", ".js", ".json", ".md", ".bat"}


def walk():
    for path in ROOT.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.is_file():
            yield path


def main() -> int:
    failures = 0

    py_files = [p for p in walk() if p.suffix == ".py"]
    for path in py_files:
        try:
            ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        except Exception as err:
            failures += 1
            print(f"PYTHON FAIL  {path.relative_to(ROOT)}\n{err}", file=sys.stderr)

    bad_re = re.compile("[\ufffd]")
    text_files = [p for p in walk() if p.suffix.lower() in TEXT_SUFFIXES]
    for path in text_files:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as err:
            failures += 1
            print(f"ENCODING FAIL  {path.relative_to(ROOT)}\n{err}", file=sys.stderr)
            continue
        if bad_re.search(text):
            failures += 1
            print(f"ENCODING FAIL  {path.relative_to(ROOT)} contains replacement characters", file=sys.stderr)

    print(f"Checked {len(py_files)} Python files and {len(text_files)} text files.")
    if failures:
        print(f"check_python: {failures} problem(s) found.", file=sys.stderr)
        return 1
    print("check_python: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
