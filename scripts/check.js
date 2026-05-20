#!/usr/bin/env node
// Static safety net: syntax-checks all server + browser JS and scans for
// encoding corruption. Runs without starting the server. Exit non-zero on failure.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'android', '.tools', 'data', 'docs']);

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

// Build the encoding-corruption matchers from char codes so this source file
// stays pure ASCII and never flags itself.
function chars(...codes) {
  return codes.map((c) => String.fromCharCode(c)).join('');
}
function range(lo, hi) {
  const out = [];
  for (let c = lo; c <= hi; c++) out.push(c);
  return chars(...out);
}
// Lead chars produced when UTF-8 is mis-decoded as CP1252: C2 C3 E2 F0.
const LEADS = chars(0xc2, 0xc3, 0xe2, 0xf0);
// Chars that legitimately follow a lead in real mojibake: Latin-1 supplement
// continuation bytes plus the CP1252 "smart punctuation" block.
const FOLLOW = range(0x80, 0xbf) + chars(0x2013, 0x2014, 0x2022, 0x20ac, 0x2026) + range(0x2018, 0x201f) + range(0x2020, 0x2122);
const REPLACEMENT = new RegExp(chars(0xfffd));
const DOUBLE_ENCODED = new RegExp(`[${LEADS}][${FOLLOW}]`);

let failures = 0;

// 1. Syntax check every JS file we own.
const jsFiles = walk(ROOT, ['.js']).filter((f) => !f.includes('vendor'));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failures++;
    console.error(`SYNTAX FAIL  ${path.relative(ROOT, file)}\n${err.stderr?.toString() || err.message}`);
  }
}

// 2. Mojibake / encoding-corruption scan across shipped JS, CSS, and HTML.
const textFiles = walk(ROOT, ['.js', '.css', '.html']).filter((f) => !f.includes('vendor'));
for (const file of textFiles) {
  const text = fs.readFileSync(file, 'utf8');
  if (REPLACEMENT.test(text) || DOUBLE_ENCODED.test(text)) {
    failures++;
    console.error(`ENCODING FAIL  ${path.relative(ROOT, file)} contains a replacement char or double-encoded bytes`);
  }
}

console.log(`Checked ${jsFiles.length} JS files (syntax) and ${textFiles.length} files (encoding).`);
if (failures) {
  console.error(`\ncheck: ${failures} problem(s) found.`);
  process.exit(1);
}
console.log('check: OK');
