#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
function backendCommand() {
  if (process.env.PYTHON) return { command: process.env.PYTHON, args: ['py_backend.py'] };
  if (process.platform === 'win32') {
    const paths = (process.env.PATH || '').split(path.delimiter);
    for (const dir of paths) {
      const candidate = path.join(dir, 'python.exe');
      if (fsSync.existsSync(candidate)) return { command: candidate, args: ['py_backend.py'] };
    }
  }
  return { command: 'python', args: ['py_backend.py'] };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function requestJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) reject(new Error(`${url} -> ${res.statusCode}`));
        else resolve(JSON.parse(body));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function getJson(url) {
  return requestJson(url);
}

async function waitFor(fn, label, timeout = 12000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const out = await fn();
      if (out) return out;
    } catch (err) {
      last = err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime exception');
    return result.result.value;
  }
  async navigate(url) {
    this.events.length = 0;
    await this.send('Page.navigate', { url });
    await waitFor(() => this.eval(`document.readyState === 'complete'`), `load ${url}`);
    await this.send('Runtime.evaluate', { expression: 'new Promise(r => setTimeout(r, 500))', awaitPromise: true });
  }
  problems() {
    return this.events.flatMap(e => {
      if (e.method === 'Runtime.exceptionThrown') return [`exception: ${e.params.exceptionDetails?.text || 'runtime exception'}`];
      if (e.method === 'Log.entryAdded' && ['error', 'warning'].includes(e.params.entry.level)) return [`${e.params.entry.level}: ${e.params.entry.text}`];
      if (e.method === 'Network.responseReceived') {
        const { status, url } = e.params.response;
        if (status >= 400 && !url.includes('favicon')) return [`HTTP ${status}: ${url}`];
      }
      return [];
    });
  }
  close() {
    this.ws?.close();
  }
}

async function startBackend(port) {
  const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', APP_ENV: 'development' };
  const { command, args } = backendCommand();
  const proc = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError;
  proc.once('error', err => { startupError = err; });
  await waitFor(() => {
    if (startupError) throw startupError;
    return getJson(`http://127.0.0.1:${port}/api/school-info`).then(Boolean);
  }, 'backend');
  return proc;
}

async function startChrome(port) {
  const userDataDir = path.join(os.tmpdir(), `portal-phase3-chrome-${Date.now()}`);
  await fs.mkdir(userDataDir, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  await waitFor(() => getJson(`http://127.0.0.1:${port}/json/version`), 'chrome');
  const tab = await requestJson(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT').catch(async () => {
    const tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
    return tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || tabs[0];
  });
  return { proc, tab, userDataDir };
}

async function assertNoProblems(cdp, label) {
  const problems = cdp.problems().filter(p =>
    !p.includes('Failed to load resource: net::ERR_BLOCKED_BY_CLIENT') &&
    !p.includes('Failed to load resource: the server responded with a status of 404')
  );
  if (problems.length) throw new Error(`${label} problems:\n${problems.join('\n')}`);
}

async function main() {
  const appPort = await freePort();
  const chromePort = await freePort();
  let backend, chrome, cdp;
  try {
    backend = await startBackend(appPort);
    chrome = await startChrome(chromePort);
    cdp = new Cdp(chrome.tab.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
      cdp.send('Log.enable'),
    ]);

    const base = `http://127.0.0.1:${appPort}`;
    await cdp.navigate(`${base}/`);
    const hubOk = await cdp.eval(`(() => {
      const text = document.body?.innerText || '';
      const links = [...document.querySelectorAll('a')].map(a => a.getAttribute('href'));
      return document.title.includes('Joyland')
        && text.includes('Joyland Schools')
        && text.toLowerCase().includes('joyland prime academy')
        && links.includes('/admin')
        && links.includes('/app/index.html?signin=1')
        && !/library|resources|find school|create portal|multi-school/i.test(text);
    })()`);
    if (!hubOk) {
      const pageState = await cdp.eval(`JSON.stringify({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 240) || '' })`);
      throw new Error(`Joyland access hub did not render: ${pageState}`);
    }
    console.log('Joyland access hub: ok');

    await cdp.navigate(`${base}/app/`);
    const appLoginOk = await waitFor(() => cdp.eval(`Boolean(document.querySelector('#li-id') && document.querySelector('#li-secret') && !/library|resources|guest|find school|create portal|multi-school/i.test(document.body?.innerText || ''))`), 'role app login');
    if (!appLoginOk) throw new Error('role app login did not render cleanly');
    await assertNoProblems(cdp, 'role app login');
    console.log('role app login: ok');

    await cdp.navigate(`${base}/login`);
    const loginOk = await waitFor(() => cdp.eval(`Boolean(document.querySelector('#p-identifier') && document.querySelector('#p-password'))`), 'admin login form');
    if (!loginOk) throw new Error('admin login form did not render');
    await cdp.eval(`document.querySelector('#p-identifier').value='JS-ADM-0001'; document.querySelector('#p-password').value='admin123'; doLogin();`);
    await waitFor(() => cdp.eval(`location.pathname.includes('/admin/')`), 'admin redirect');
    await assertNoProblems(cdp, 'login');

    const pages = [
      ['/admin/overview.html', 'dashboardStatCards', `document.querySelectorAll('.stat-card,.dash-card').length > 0`],
      ['/admin/reports.html', 'reportsReady', `document.querySelector('#reportGrid')?.children.length > 0`],
      ['/admin/settings.html', 'settingsPanel', `document.querySelectorAll('.save-section').length > 0`],
      ['/admin/attendance.html', 'attendanceShell', `Boolean(document.querySelector('#classSelect') && document.querySelector('#attGrid'))`],
    ];
    for (const [url, label, expr] of pages) {
      await cdp.navigate(`${base}${url}`);
      await waitFor(() => cdp.eval(expr), label);
      await assertNoProblems(cdp, url);
      console.log(`${url}: ok`);
    }

    await cdp.navigate(`${base}/admin/settings.html`);
    await waitFor(() => cdp.eval(`document.querySelectorAll('.save-section').length > 0`), 'settings ready');
    const marker = `Phase3 ${Date.now()}`;
    await cdp.eval(`document.querySelector('[data-key="school_motto"]').value=${JSON.stringify(marker)}; document.querySelector('.save-section[data-save="profile"]').click();`);
    await new Promise(r => setTimeout(r, 800));
    await cdp.navigate(`${base}/admin/settings.html`);
    const persisted = await waitFor(() => cdp.eval(`document.querySelector('[data-key="school_motto"]')?.value === ${JSON.stringify(marker)}`), 'settings persisted');
    if (!persisted) throw new Error('settings save did not persist');
    console.log('settings save persists: ok');

    const term = await cdp.eval(`fetch('/api/admin/current-period',{credentials:'include'}).then(r=>r.json()).then(j=>j.data?.term?.id)`);
    const ctx = await cdp.eval(`fetch('/api/admin/marks/analysis?stage=midterm',{credentials:'include'}).then(r=>r.json()).then(j=>(j.classes||[]).find(c=>c.has_marks)?.class_id || (j.classes||[])[0]?.class_id)`);
    if (ctx && term) {
      await cdp.navigate(`${base}/admin/broadsheet.html?class_id=${ctx}&term_id=${term}&assessment_type=midterm`);
      try {
        await waitFor(() => cdp.eval(`(document.querySelectorAll('table, .bs-tbl').length > 0 || (document.body.innerText || '').includes('marks have been entered')) && !(document.body.innerText || '').includes('Request failed')`), 'broadsheet render');
      } catch (err) {
        const pageState = await cdp.eval(`JSON.stringify({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 320) || '' })`);
        throw new Error(`${err.message}: ${pageState}`);
      }
      await assertNoProblems(cdp, 'broadsheet');
      console.log('broadsheet render: ok');

      const learner = await cdp.eval(`fetch('/api/admin/classes/${ctx}/learners',{credentials:'include'}).then(r=>r.json()).then(j=>j.data?.learners?.[0]?.id)`);
      const hasBroadsheetRows = await cdp.eval(`document.querySelectorAll('table, .bs-tbl').length > 0`);
      if (learner && hasBroadsheetRows) {
        await cdp.navigate(`${base}/admin/report-card.html?class_id=${ctx}&learner_id=${learner}&term_id=${term}&assessment_type=midterm`);
        await waitFor(() => cdp.eval(`document.querySelector('#reportRoot')?.textContent.length > 100 && !document.body.textContent.includes('Request failed')`), 'report render');
        await assertNoProblems(cdp, 'report card');
        console.log('report card render: ok');
      } else {
        console.log('report card render: skipped (no marked broadsheet rows)');
      }
    }

    console.log('browser validation: OK');
  } finally {
    cdp?.close();
    chrome?.proc?.kill();
    backend?.kill();
  }
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
