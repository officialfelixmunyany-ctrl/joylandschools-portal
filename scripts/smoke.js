#!/usr/bin/env node
// Route smoke test: boots the server on a throwaway port, logs in as admin,
// and GETs one representative read endpoint per admin domain plus the public
// and auth surfaces. Asserts HTTP 200 and that the JSON body is not an error.
// This is the regression net for refactors such as splitting routes/admin.js.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.SMOKE_PORT || 3599);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_ID = process.env.SMOKE_ADMIN_ID || 'ADM001';
const ADMIN_PW = process.env.SMOKE_ADMIN_PW || 'admin123';

// Read-only endpoints, grouped by the domain modules we plan to split into.
const CHECKS = [
  ['public', 'GET', '/api/school-info', false],
  ['settings', 'GET', '/api/admin/school-settings', true],
  ['settings', 'GET', '/api/admin/stats', true],
  ['settings', 'GET', '/api/admin/current-period', true],
  ['resources', 'GET', '/api/admin/resources', true],
  ['people', 'GET', '/api/admin/learners', true],
  ['people', 'GET', '/api/admin/teachers', true],
  ['people', 'GET', '/api/admin/parents', true],
  ['academics', 'GET', '/api/admin/classes', true],
  ['academics', 'GET', '/api/admin/subjects', true],
  ['academics', 'GET', '/api/admin/class-subjects', true],
  ['academics', 'GET', '/api/admin/sessions', true],
  ['calendar', 'GET', '/api/admin/calendar/events?from=2026-01-01&to=2026-12-31', true],
  ['attendance', 'GET', '/api/admin/school-day', true],
  ['marks', 'GET', '/api/admin/assessment-components', true],
  ['reports', 'GET', '/api/admin/templates', true],
  ['timetable', 'GET', '/api/admin/timetable/periods', true],
  ['skills', 'GET', '/api/admin/skills', true],
];

function request(method, urlPath, { cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + urlPath, {
      method,
      headers: {
        Accept: 'application/json',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await request('GET', '/api/school-info');
      return true;
    } catch (_) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development' },
    stdio: ['ignore', 'ignore', 'inherit']
  });

  let exitCode = 0;
  try {
    if (!(await waitForServer())) throw new Error('server did not start in time');

    const login = await request('POST', '/api/auth/login', { body: { identifier: ADMIN_ID, password: ADMIN_PW } });
    const loginBody = JSON.parse(login.raw || '{}');
    if (login.status !== 200 || loginBody.success !== true) {
      throw new Error(`admin login failed (status ${login.status}): ${login.raw}`);
    }
    const cookie = (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

    const results = [];
    for (const [domain, method, urlPath, auth] of CHECKS) {
      let ok = false;
      let detail = '';
      try {
        const res = await request(method, urlPath, { cookie: auth ? cookie : undefined });
        let parsed = {};
        try { parsed = JSON.parse(res.raw || '{}'); } catch (_) {}
        ok = res.status === 200 && parsed.success !== false;
        detail = `${res.status}`;
        if (!ok && parsed.message) detail += ` ${parsed.message}`;
      } catch (err) {
        detail = err.message;
      }
      results.push({ domain, urlPath, ok, detail });
      if (!ok) exitCode = 1;
      console.log(`${ok ? 'PASS' : 'FAIL'}  [${domain}] ${method} ${urlPath}  (${detail})`);
    }

    const passed = results.filter((r) => r.ok).length;
    console.log(`\nsmoke: ${passed}/${results.length} endpoints OK`);
  } catch (err) {
    exitCode = 1;
    console.error('smoke: ERROR', err.message);
  } finally {
    server.kill();
    process.exit(exitCode);
  }
})();
