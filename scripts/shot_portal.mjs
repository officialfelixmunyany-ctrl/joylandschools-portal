#!/usr/bin/env node
// Capture full-page screenshots of the learning portal landing (desktop + mobile).
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
const OUT = path.join(os.tmpdir(), 'kcse_frames');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const getJson = (url, m = 'GET') => new Promise((res, rej) => { const r = http.request(url, { method: m }, x => { let b = ''; x.setEncoding('utf8'); x.on('data', c => b += c); x.on('end', () => res(JSON.parse(b))); }); r.on('error', rej); r.end(); });
async function waitFor(fn, label, t = 12000) { const s = Date.now(); let e; while (Date.now() - s < t) { try { const o = await fn(); if (o) return o; } catch (x) { e = x; } await new Promise(r => setTimeout(r, 150)); } throw new Error(`${label} timeout${e ? ': ' + e.message : ''}`); }

function staticServer(port) {
  return new Promise(res => {
    const srv = http.createServer((req, rs) => {
      let rel = decodeURIComponent(req.url.split('?')[0]); if (rel === '/' || rel === '') rel = '/index.html';
      const t = path.join(LIB_DIR, rel);
      if (!t.startsWith(LIB_DIR) || !fs.existsSync(t) || fs.statSync(t).isDirectory()) { rs.writeHead(404); rs.end('nf'); return; }
      rs.writeHead(200, { 'Content-Type': MIME[path.extname(t)] || 'application/octet-stream' });
      fs.createReadStream(t).pipe(rs);
    });
    srv.listen(port, '127.0.0.1', () => res(srv));
  });
}

class Cdp {
  constructor(ws) { this.url = ws; this.next = 1; this.pending = new Map(); }
  async connect() { this.ws = new WebSocket(this.url); await new Promise((r, j) => { this.ws.addEventListener('open', r, { once: true }); this.ws.addEventListener('error', j, { once: true }); }); this.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } }); }
  send(method, params = {}) { const id = this.next++; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; }
  async nav(url) { await this.send('Page.navigate', { url }); await waitFor(() => this.eval(`document.readyState==='complete'`), 'load'); await this.send('Runtime.evaluate', { expression: 'new Promise(r=>setTimeout(r,700))', awaitPromise: true }); }
}

async function shoot(cdp, width, name) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 700 });
  await new Promise(r => setTimeout(r, 250));
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  const file = path.join(OUT, name);
  await fsp.writeFile(file, Buffer.from(data, 'base64'));
  console.log(file);
}

async function main() {
  await fsp.mkdir(OUT, { recursive: true });
  const appPort = await freePort(); const dbgPort = await freePort();
  const dir = path.join(os.tmpdir(), `shot-${Date.now()}`); await fsp.mkdir(dir, { recursive: true });
  const srv = await staticServer(appPort);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${dbgPort}`, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  try {
    await waitFor(() => getJson(`http://127.0.0.1:${dbgPort}/json/version`), 'chrome');
    const tab = await getJson(`http://127.0.0.1:${dbgPort}/json/new?about:blank`, 'PUT').catch(async () => (await getJson(`http://127.0.0.1:${dbgPort}/json/list`)).find(t => t.type === 'page'));
    const cdp = new Cdp(tab.webSocketDebuggerUrl); await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.nav(`http://127.0.0.1:${appPort}/index.html`);
    await shoot(cdp, 1280, 'landing_desktop.png');
    await shoot(cdp, 390, 'landing_mobile.png');
  } finally { chrome.kill(); srv.close(); }
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
