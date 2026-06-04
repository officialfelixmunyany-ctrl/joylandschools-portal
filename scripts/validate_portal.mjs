#!/usr/bin/env node
// Headless smoke test for the Civicom Learning Portal frontend.
// Serves public/app with a bare static server (no /api backend) so the
// API-fail -> mock fallback path is exercised, then drives it via CDP.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIB_DIR = path.join(ROOT, 'public', 'portal', 'resources');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}
function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, res => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', c => (b += c));
      res.on('end', () => (res.statusCode < 200 || res.statusCode >= 300) ? reject(new Error(`${url} -> ${res.statusCode}`)) : resolve(JSON.parse(b)));
    });
    req.on('error', reject); req.end();
  });
}
async function waitFor(fn, label, timeout = 12000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) {
    try { const out = await fn(); if (out) return out; } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ''}`);
}

function staticServer(port) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split('?')[0]);
      if (rel === '/' || rel === '') rel = '/index.html';
      const target = path.join(LIB_DIR, rel);
      if (!target.startsWith(LIB_DIR) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
        res.writeHead(404); res.end('not found'); return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
      fs.createReadStream(target).pipe(res);
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

class Cdp {
  constructor(ws) { this.ws = null; this.url = ws; this.next = 1; this.pending = new Map(); this.events = []; }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
      else if (m.method) this.events.push(m);
    });
  }
  send(method, params = {}) { const id = this.next++; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
  async navigate(url) { this.events.length = 0; await this.send('Page.navigate', { url }); await waitFor(() => this.eval(`document.readyState==='complete'`), `load ${url}`); await this.send('Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,600))', awaitPromise: true }); }
  problems() {
    return this.events.flatMap(e => {
      if (e.method === 'Runtime.exceptionThrown') return [`exception: ${e.params.exceptionDetails?.text || 'runtime'}`];
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        const t = e.params.entry.text || '';
        if (t.includes('/api/portal') || t.includes('Failed to load resource')) return []; // expected: no backend
        return [`error: ${t}`];
      }
      return [];
    });
  }
  close() { this.ws?.close(); }
}

async function startChrome(port) {
  const dir = path.join(os.tmpdir(), `civicom-portal-${Date.now()}`);
  await fsp.mkdir(dir, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  await waitFor(() => getJson(`http://127.0.0.1:${port}/json/version`), 'chrome');
  const tab = await getJson(`http://127.0.0.1:${port}/json/new?about:blank`, 'PUT').catch(async () => {
    const tabs = await getJson(`http://127.0.0.1:${port}/json/list`);
    return tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl) || tabs[0];
  });
  return { proc, tab };
}

function checkSeparation() {
  // Static separation assertions (no browser needed).
  const has = p => fs.existsSync(path.join(ROOT, p));

  // Naming: app stuff under public/app, library under its own portal folder.
  if (!has('public/portal/resources/index.html')) throw new Error('library missing at public/portal/resources/');
  if (!has('public/app/school.html') || !has('public/app/daraja.js')) throw new Error('app body (school.html/daraja.js) not restored in public/app');
  if (has('public/client')) throw new Error('public/client should have been removed');

  // The app must NOT contain the resource library files.
  for (const leak of ['public/app/src/main.js', 'public/app/src/components/Browse.js', 'public/app/assets/styles.css']) {
    if (has(leak)) throw new Error(`library leaked into the app: ${leak}`);
  }

  // Capacitor wraps the app, not the library.
  const cap = JSON.parse(fs.readFileSync(path.join(ROOT, 'capacitor.config.json'), 'utf8'));
  if (cap.webDir !== 'public/app') throw new Error(`capacitor webDir should be public/app, got ${cap.webDir}`);

  console.log('separation: library=public/portal/resources, app=public/app (restored), no public/client, capacitor->public/app');
}

async function main() {
  checkSeparation();
  const appPort = await freePort();
  const chromePort = await freePort();
  let srv, chrome, cdp;
  try {
    srv = await staticServer(appPort);
    chrome = await startChrome(chromePort);
    cdp = new Cdp(chrome.tab.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
    // Desktop viewport so the three-column landing layout is exercised.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

    const base = `http://127.0.0.1:${appPort}`;
    await cdp.navigate(`${base}/index.html`);

    const title = await cdp.eval(`document.title`);
    if (!/Civicom/.test(title)) throw new Error(`title not rebranded: ${title}`);

    // HOME: dense 3-column exam-portal landing (strip + rails + centre blocks + FAQ).
    const home = JSON.parse(await waitFor(() => cdp.eval(`(() => {
      const strip = document.querySelectorAll('.cat-strip a').length;
      const rails = document.querySelectorAll('.rail-box').length;
      const railLinks = document.querySelectorAll('.rail-list a').length;
      const blocks = document.querySelectorAll('.center-block').length;
      const links = document.querySelectorAll('.link-list a').length;
      const faq = document.querySelectorAll('.faq-item').length;
      const search = !!document.querySelector('#home-search-input');
      const cols = getComputedStyle(document.querySelector('.kcse-grid')).gridTemplateColumns.split(' ').length;
      return blocks ? JSON.stringify({strip, rails, railLinks, blocks, links, faq, search, cols}) : '';
    })()`), 'home landing'));
    if (home.strip < 8 || home.rails < 4 || home.blocks < 4 || !home.links || home.faq !== 3 || !home.search) throw new Error(`home landing incomplete: ${JSON.stringify(home)}`);
    if (home.cols !== 3) throw new Error(`landing is not 3-column (got ${home.cols})`);
    console.log(`home: 3-column; ${home.strip} strip links, ${home.rails} rail boxes (${home.railLinks} links), ${home.blocks} centre blocks (${home.links} category links), ${home.faq} FAQ, search`);

    // Header buttons present.
    const hdr = JSON.parse(await cdp.eval(`JSON.stringify({login: !!document.querySelector('#school-login'), create: !!document.querySelector('#create-school'), search: !!document.querySelector('#search-shortcut'), brand: document.querySelector('.brand strong')?.textContent})`));
    if (!hdr.login || !hdr.create || !hdr.search) throw new Error(`header missing buttons: ${JSON.stringify(hdr)}`);
    if (hdr.brand !== 'Civicom') throw new Error(`brand wrong: ${hdr.brand}`);
    console.log('header: School Login + Create School + search shortcut present');

    // Drill-in: click a KCSE category link (Form 3-4 -> KNEC Past Papers) -> filtered results.
    await cdp.eval(`document.querySelector('.link-list a[data-cat-level="secondary-844"][data-cat-type="past-paper"]').click();`);
    const drill = await waitFor(() => cdp.eval(`(() => {
      const onBrowse = location.hash === '#/browse';
      const cards = document.querySelectorAll('.resource-card').length;
      const crumb = document.querySelector('.crumbs')?.textContent || '';
      return (onBrowse && cards > 0 && /Past Papers/.test(crumb)) ? cards : 0;
    })()`), 'category drill-in');
    console.log(`drill-in KCSE > Past Papers -> ${drill} card(s) (breadcrumb shows category)`);

    // Year-indexed rail link (left rail) drills in with a year query.
    await cdp.navigate(`${base}/index.html#/`);
    await waitFor(() => cdp.eval(`!!document.querySelector('.rail-list a[data-cat-query="2024"]')`), 'home rails');
    await cdp.eval(`document.querySelector('.rail-list a[data-cat-query="2024"]').click();`);
    const yearDrill = await waitFor(() => cdp.eval(`(() => {
      const crumb = document.querySelector('.crumbs')?.textContent || '';
      const n = document.querySelectorAll('.resource-card').length;
      return (location.hash === '#/browse' && /2024/.test(crumb) && n > 0) ? n : 0;
    })()`), 'year rail drill-in');
    console.log(`rail drill-in 2024 -> ${yearDrill} card(s)`);

    // Level-group drill-in via header nav (Grade 1-9 = Primary + Junior).
    await cdp.eval(`document.querySelector('.topnav a[data-cat-level="grade-1-9"]').click();`);
    const group = await waitFor(() => cdp.eval(`(() => { const n=document.querySelectorAll('.resource-card').length; return n>0 ? n : 0; })()`), 'grade-1-9 group');
    console.log(`nav Grade 1-9 (group) -> ${group} card(s)`);

    // Instant search within results: reset to all, then confirm a term reduces the set.
    await cdp.eval(`document.querySelector('[data-action="reset-filters"]').click();`);
    const allCount = await waitFor(() => cdp.eval(`(() => { const n=document.querySelectorAll('.resource-card').length; return n>=20 ? n : 0; })()`), 'reset to all');
    await cdp.eval(`const i=document.querySelector('#search-input'); i.value='past paper'; i.dispatchEvent(new Event('input',{bubbles:true}));`);
    const searched = await waitFor(() => cdp.eval(`(() => { const n=document.querySelectorAll('.resource-card').length; return (n>0 && n<${allCount}) ? n : 0; })()`), 'results search reduces');
    console.log(`results search "past paper" -> ${searched} card(s) (from ${allCount})`);

    // Home search drills into results.
    await cdp.navigate(`${base}/index.html#/`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#home-search-input')`), 'back home');
    await cdp.eval(`const f=document.querySelector('#home-search-input'); f.value='biology'; document.querySelector('#home-search').dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));`);
    const homeSearch = await waitFor(() => cdp.eval(`(() => { const n=document.querySelectorAll('.resource-card').length; return (location.hash==='#/browse' && n>0) ? n : 0; })()`), 'home search drill');
    console.log(`home search "biology" -> ${homeSearch} card(s)`);

    // Open a resource modal.
    await cdp.eval(`document.querySelector('.resource-card [data-action="open"]').click();`);
    await waitFor(() => cdp.eval(`!!document.querySelector('#modal-root .modal')`), 'modal open');
    console.log('resource modal opens: ok');

    const problems = cdp.problems();
    if (problems.length) throw new Error(`console problems:\n${problems.join('\n')}`);
    console.log('no unexpected console errors');

    console.log('\nCivicom Learning Portal validation: OK');
  } finally {
    cdp?.close();
    chrome?.proc?.kill();
    srv?.close();
  }
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
