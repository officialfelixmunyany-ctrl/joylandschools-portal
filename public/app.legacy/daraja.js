'use strict';
/* ═══════════════════════════════════════════════════════════════════════
   DARAJA — app engine (framework-free). Router, bootstrap, role nav,
   shared components, and the Learner experience.
   ═══════════════════════════════════════════════════════════════════════ */

/* ── tiny helpers ───────────────────────────────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
const num = (v, d = 0) => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(d);
const pct = v => v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(Number(v) % 1 ? 1 : 0) + '%';
const firstName = n => String(n || '').trim().split(/\s+/)[0] || '';
function bandFor(p){ return p >= 75 ? ['ee','EE','Exceeding'] : p >= 50 ? ['me','ME','Meeting'] : p >= 30 ? ['ae','AE','Approaching'] : ['be','BE','Below']; }
function avaColor(name){ /* deterministic hue from name */
  let h = 0; const s = String(name || '?'); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `background:linear-gradient(135deg,hsl(${h} 52% 42%),hsl(${(h + 28) % 360} 56% 32%));`;
}

/* ── API ────────────────────────────────────────────────────────────── */
const api = {
  async req(method, path, body){
    const opt = { method, credentials:'include', headers:{} };
    if (body){ opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    let r, j;
    try { r = await fetch(path, opt); } catch(e){ throw Object.assign(new Error('No connection'), { offline:true }); }
    try { j = await r.json(); } catch(e){ j = {}; }
    if (j && j.authenticated === false) throw Object.assign(new Error('Signed out'), { auth:false });
    if (!r.ok || j.success === false) throw new Error(j.message || 'Something went wrong');
    return j.data !== undefined ? j.data : j;
  },
  get(p){ return this.req('GET', p); },
  post(p, b){ return this.req('POST', p, b); },
  put(p, b){ return this.req('PUT', p, b); }
};

/* ── global state ───────────────────────────────────────────────────── */
const state = { me:null, school:null, cache:{}, publicResources:[] };
const PUBLIC_RESOURCE_TYPES = [
  ['notes', 'Revision notes'],
  ['trivia', 'Trivia questions'],
  ['past_paper', 'Past papers'],
  ['scheme', 'Schemes'],
  ['lesson_plan', 'Lesson plans'],
  ['exam', 'Exams'],
  ['curriculum_design', 'Curriculum designs']
];
const PUBLIC_LEVELS = [
  ['all',     'All grades', []],
  ['daycare', 'Daycare',    ['daycare', 'day care']],
  ['pp1',     'PP1',        ['pp1', 'pp 1', 'pre-primary 1']],
  ['pp2',     'PP2',        ['pp2', 'pp 2', 'pre-primary 2']],
  ['g1',      'Grade 1',    ['grade 1']],
  ['g2',      'Grade 2',    ['grade 2']],
  ['g3',      'Grade 3',    ['grade 3']],
  ['g4',      'Grade 4',    ['grade 4']],
  ['g5',      'Grade 5',    ['grade 5']],
  ['g6',      'Grade 6',    ['grade 6']],
  ['g7',      'Grade 7',    ['grade 7']],
  ['g8',      'Grade 8',    ['grade 8']],
  ['g9',      'Grade 9',    ['grade 9']],
  ['g10',     'Grade 10',   ['grade 10']],
  ['g11',     'Grade 11',   ['grade 11']],
  ['g12',     'Grade 12',   ['grade 12']],
  ['f1',      'Form 1',     ['form 1', 'f1']],
  ['f2',      'Form 2',     ['form 2', 'f2']],
  ['f3',      'Form 3',     ['form 3', 'f3']],
  ['f4',      'Form 4',     ['form 4', 'f4']]
];

const CURRICULUM_TIERS = [
  ['cbc_primary', 'CBC Primary',       ['daycare','pp1','pp2','g1','g2','g3','g4','g5','g6']],
  ['jss',         'Junior Secondary',  ['g7','g8','g9']],
  ['sss',         'Senior Secondary',  ['g10','g11','g12']],
  ['sec_844',     'Secondary (8-4-4)', ['f1','f2','f3','f4']]
];
const PUBLIC_SUBJECTS = ['English', 'Kiswahili', 'Mathematics', 'Science & Technology', 'Social Studies', 'Religious Education', 'Agriculture', 'Pre-Technical Studies', 'Creative Arts', 'Home Science'];
const PUBLIC_FREE_LIMIT = 5;
const PUBLIC_READ_KEY = 'daraja.public.read.ids';
const PUBLIC_GOOGLE_KEY = 'daraja.public.google.user';
const PUBLIC_CACHE_KEY = 'daraja.public.cached.resources';

function resourceTypeLabel(type){
  return (PUBLIC_RESOURCE_TYPES.find(t => t[0] === type)?.[1] || String(type || 'Resource').replace(/_/g, ' '));
}
function publicLevelLabel(level){
  return (PUBLIC_LEVELS.find(l => l[0] === level)?.[1] || 'All levels');
}
function resourceMatchesLevel(resource, level){
  if (!level || level === 'all') return true;
  const entry = PUBLIC_LEVELS.find(l => l[0] === level);
  if (!entry) return true;
  const haystack = [resource.grade, resource.subject, resource.title].map(v => String(v || '').toLowerCase()).join(' ');
  return entry[2].some(term => {
    const escaped = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\s+/g, '\\s*');
    const re = new RegExp('(?:^|[^a-z0-9])' + escaped + '(?![a-z0-9])', 'i');
    return re.test(haystack);
  });
}
function publicReadIds(){
  try { return JSON.parse(localStorage.getItem(PUBLIC_READ_KEY) || '[]').map(Number).filter(Boolean); } catch { return []; }
}
function publicGoogleUser(){
  try { return JSON.parse(localStorage.getItem(PUBLIC_GOOGLE_KEY) || 'null'); } catch { return null; }
}
function isPublicUnlocked(){ return !!publicGoogleUser(); }
function cachePublicResource(resource){
  try {
    const cached = JSON.parse(localStorage.getItem(PUBLIC_CACHE_KEY) || '{}');
    cached[resource.id] = { ...resource, cached_at: new Date().toISOString() };
    localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify(cached));
  } catch {}
}
function cachedPublicResources(){
  try { return Object.values(JSON.parse(localStorage.getItem(PUBLIC_CACHE_KEY) || '{}')); } catch { return []; }
}
function publicReadCount(){
  return publicReadIds().length;
}
function publicResourceStats(resources = []){
  const types = new Set(resources.map(r => r.type).filter(Boolean));
  const subjects = new Set(resources.map(r => String(r.subject || '').trim()).filter(Boolean));
  const grades = new Set(resources.map(r => String(r.grade || '').trim()).filter(Boolean));
  return { total:resources.length, types:types.size, subjects:subjects.size, grades:grades.size };
}
function markPublicRead(id){
  const ids = publicReadIds();
  if (!ids.includes(Number(id))) {
    ids.push(Number(id));
    localStorage.setItem(PUBLIC_READ_KEY, JSON.stringify(ids.slice(-200)));
  }
}
function googleClientId(){
  return document.querySelector('meta[name="google-client-id"]')?.content?.trim() || '';
}
function decodeJwtPayload(token){
  const body = String(token || '').split('.')[1] || '';
  const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decodeURIComponent(Array.from(json).map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
}
function loadGoogleIdentity(){
  if (window.google?.accounts?.id) return Promise.resolve(true);
  if (window.__darajaGoogleIdentityLoading) return window.__darajaGoogleIdentityLoading;
  window.__darajaGoogleIdentityLoading = new Promise(resolve => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve(!!window.google?.accounts?.id);
    script.onerror = () => resolve(false);
    document.head.appendChild(script);
  });
  return window.__darajaGoogleIdentityLoading;
}

/* ═══════════════════════════════════════════════════════════════════════
   UI primitives — toast, sheet, skeleton, appbar
   ═══════════════════════════════════════════════════════════════════════ */
const UI = {
  toast(msg, type = ''){
    const wrap = $('#toast-wrap');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = (type === 'ok' ? '<i data-lucide="check"></i>' : type === 'danger' ? '<i data-lucide="triangle-alert"></i>' : '') + '<span>' + esc(msg) + '</span>';
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('on'));
    setTimeout(() => { t.classList.remove('on'); setTimeout(() => t.remove(), 320); }, 2600);
  },
  openSheet(html){
    let sheet = $('#sheet');
    if (!sheet){ sheet = document.createElement('div'); sheet.id = 'sheet'; sheet.className = 'sheet'; $('#app').appendChild(sheet); }
    sheet.innerHTML = '<div class="sheet-grip"></div>' + html;
    $('#shroud').classList.add('on');
    requestAnimationFrame(() => sheet.classList.add('on'));
  },
  closeSheet(){
    const sheet = $('#sheet'); $('#shroud').classList.remove('on');
    if (sheet) sheet.classList.remove('on');
  }
};

function appbar({ title = 'Daraja', back = false, action = '' } = {}){
  return `<div class="appbar">
    ${back ? `<button class="appbar-btn" onclick="Router.pop()"><i data-lucide="arrow-left"></i></button>` : ''}
    <div class="appbar-title">${esc(title)}</div>
    ${action}
  </div>`;
}
const skelBlock = (h, mt = 0) => `<div class="skel" style="height:${h}px;${mt ? 'margin-top:' + mt + 'px;' : ''}"></div>`;
function loadingScroll(){ return `<div class="scroll pad stack-gap">${skelBlock(120)}${skelBlock(70)}${skelBlock(150)}</div>`; }
function emptyState(icon, title, msg){
  return `<div class="empty"><div class="ic"><i data-lucide="${icon}"></i></div><h3>${esc(title)}</h3><p>${esc(msg)}</p></div>`;
}
function errorState(msg, retryFn){
  return `<div class="empty"><div class="ic"><i data-lucide="cloud-off"></i></div><h3>Couldn't load</h3>
    <p>${esc(msg || 'Please try again.')}</p>${retryFn ? `<button class="btn ghost sm mt5" onclick="${retryFn}"><i data-lucide="rotate-cw"></i> Retry</button>` : ''}</div>`;
}
function notificationDate(value){
  if (!value) return '';
  const d = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
}
function notificationCard(n){
  const unread = !n.read_at;
  return `<button class="row" style="width:100%;text-align:left;align-items:flex-start;" onclick="openNotification(${Number(n.id) || 0})">
    <div class="ava ava-sm ${unread ? 'lead' : ''}"><i data-lucide="${unread ? 'bell' : 'mail-open'}"></i></div>
    <div class="body">
      <div class="title">${esc(n.title || n.subject || 'School announcement')}</div>
      <div class="meta">${esc(notificationDate(n.created_at))}${n.sender_name ? ' - ' + esc(n.sender_name) : ''}</div>
      <div style="font-size:var(--t-sm);color:var(--ink-2);line-height:1.45;margin-top:4px;">${esc(n.body || n.message || '')}</div>
    </div>
    ${unread ? '<span class="badge ok">New</span>' : ''}
  </button>`;
}
async function refreshUnreadBadge(){
  let count = 0;
  try {
    const data = await api.get('/api/notifications/unread-count');
    count = Number(data.unread_count || 0);
  } catch(e) {}
  $$('.js-unread-badge, .bell .dot').forEach(el => {
    el.hidden = count <= 0;
    el.style.display = count > 0 ? '' : 'none';
  });
}
async function markNotificationRead(id){
  if (!id) return;
  try { await api.post('/api/notifications/read/' + id, {}); } catch(e){}
  const n = (state.notifications || []).find(x => Number(x.id) === Number(id));
  if (n) n.read_at = n.read_at || new Date().toISOString();
  refreshUnreadBadge();
}
function openNotification(id){
  markNotificationRead(id);
  const n = (state.notifications || []).find(x => Number(x.id) === Number(id));
  if (!n) return;
  UI.openSheet(`<div class="stack-gap">
    <div class="section-label">${esc(notificationDate(n.created_at))}</div>
    <h2 style="margin:0;font-size:var(--t-xl);">${esc(n.title || n.subject || 'School announcement')}</h2>
    <p style="margin:0;color:var(--ink-2);line-height:1.55;">${esc(n.body || n.message || '')}</p>
    <button class="btn primary block" onclick="UI.closeSheet()"><i data-lucide="check"></i> Done</button>
  </div>`);
  Icons.paint();
}
function renderNotificationsScreen(){
  Router.push(async (s) => {
    s.innerHTML = appbar({ title:'Notifications', back:true }) + loadingScroll();
    try {
      const data = await api.get('/api/notifications/inbox');
      const list = data.notifications || [];
      state.notifications = list;
      s.innerHTML = appbar({ title:'Notifications', back:true }) + `<div class="scroll pad">
        ${list.length ? `<div class="card" style="padding:6px 12px;"><div class="rows">${list.map(notificationCard).join('')}</div></div>` : emptyState('bell', 'No notifications', 'School announcements will appear here.')}
      </div>`;
      refreshUnreadBadge();
    } catch(e) {
      s.innerHTML = appbar({ title:'Notifications', back:true }) + `<div class="scroll">${errorState(e.message, 'renderNotificationsScreen()')}</div>`;
    }
    Icons.paint();
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   ROUTER — tab views + stack push/pop, framework-free
   ═══════════════════════════════════════════════════════════════════════ */
const Router = {
  tabs: [],
  activeTab: null,
  stack: [],

  setTabs(tabs){
    this.tabs = tabs;
    this.stack = [];
    const inner = $('#tabbar-inner');
    inner.innerHTML = `<div class="tab-pill" id="tab-pill"></div>` +
      tabs.map((t, i) => `<button class="tab" data-i="${i}" onclick="Router.go('${t.id}')">
        <i data-lucide="${t.icon}"></i><span>${esc(t.label)}</span></button>`).join('');
    $('#tabbar').classList.toggle('hide', tabs.length === 0);
    if (tabs.length) this.go(tabs[0].id);
  },

  hideTabs(){ $('#tabbar').classList.add('hide'); this.tabs = []; },

  _ensureTabScreen(){
    let s = $('#screen-tab');
    if (!s){ s = document.createElement('div'); s.id = 'screen-tab'; s.className = 'screen tab-screen'; $('#screens').prepend(s); }
    return s;
  },

  async go(tabId){
    // popping any stack first
    while (this.stack.length) this._removeTop(true);
    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx < 0) return;
    this.activeTab = tabId;
    const screen = this._ensureTabScreen();
    screen.classList.add('active');
    // tabbar visual state
    $$('#tabbar-inner .tab').forEach(b => b.classList.toggle('on', Number(b.dataset.i) === idx));
    const pill = $('#tab-pill');
    if (pill && this.tabs.length){ pill.style.width = (100 / this.tabs.length) + '%'; pill.style.transform = `translateX(${idx * 100}%)`; }
    screen.classList.remove('tab-enter'); void screen.offsetWidth; screen.classList.add('tab-enter');
    await this.tabs[idx].render(screen);
  },

  async push(render, { title } = {}){
    const screen = document.createElement('div');
    screen.className = 'screen stack active push-enter';
    $('#screens').appendChild(screen);
    this.stack.push(screen);
    await render(screen);
  },

  pop(){
    if (!this.stack.length) return;
    const top = this.stack[this.stack.length - 1];
    top.classList.remove('push-enter'); void top.offsetWidth; top.classList.add('push-exit');
    setTimeout(() => this._removeTop(false), 260);
  },
  _removeTop(immediate){ const top = this.stack.pop(); if (top){ top.remove(); } }
};

/* ═══════════════════════════════════════════════════════════════════════
   BOOTSTRAP
   ═══════════════════════════════════════════════════════════════════════ */
async function loadBrand(){
  try {
    const s = await api.get('/api/school-info');
    state.school = s;
    if (s.school_logo){
      const img = `<img src="${esc(s.school_logo)}" alt="">`;
      $('#splash-logo').innerHTML = img;
    }
    if (s.school_motto) $('.splash-tag').textContent = s.school_motto;
  } catch(e){ /* keep defaults — offline-safe */ }
}

function hideSplash(){
  $('#app').hidden = false;
  setTimeout(() => { $('#splash').classList.add('gone'); }, 360);
}

function revealAndHide(){
  const splash = $('#splash');
  if (!splash || splash.classList.contains('gone')) return hideSplash();
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const seen = (() => { try { return sessionStorage.getItem('daraja_reveal_seen') === '1'; } catch(e){ return false; } })();
  if (reduced || seen){ hideSplash(); return; }

  const bar = $('#splash-progress-bar');
  const skipBtn = $('#splash-skip');
  const scenes = splash.querySelectorAll('.scene');
  const dots = $('#splash-dots');
  if (dots) dots.style.display = 'none';

  const dur = [1500, 1800, 1500];
  const total = dur.reduce((a,b) => a + b, 0);
  let done = false;
  const timers = [];

  function activate(i){
    scenes.forEach((s, idx) => {
      s.classList.toggle('active', idx === i);
      s.classList.toggle('leaving', idx < i);
    });
    Icons.paint();
  }

  function finish(){
    if (done) return; done = true;
    timers.forEach(clearTimeout);
    try { sessionStorage.setItem('daraja_reveal_seen', '1'); } catch(e){}
    hideSplash();
  }

  Icons.paint();
  if (bar){
    bar.style.transition = `width ${total}ms linear`;
    requestAnimationFrame(() => { bar.style.width = '100%'; });
  }
  if (skipBtn){
    skipBtn.hidden = false;
    timers.push(setTimeout(() => skipBtn.classList.add('show'), 700));
    skipBtn.addEventListener('click', finish, { once: true });
  }
  timers.push(setTimeout(() => activate(1), dur[0]));
  timers.push(setTimeout(() => activate(2), dur[0] + dur[1]));
  timers.push(setTimeout(finish, total));
}

/* ── Icons — Lucide, self-hosted (offline-safe). Auto-paints icons in any
   dynamically rendered screen. Sized via 1em so font-size/color still apply. ── */
const Icons = {
  paint(){ if (window.lucide){ try { lucide.createIcons({ icons: lucide.icons, attrs:{ width:'1em', height:'1em', 'stroke-width':2 } }); } catch(e){} } },
  start(){
    this.paint();
    if (this._mo) return;
    this._mo = new MutationObserver(() => {
      this._mo.disconnect();           // ignore our own <i>→<svg> swaps
      this.paint();
      this._mo.observe(document.body, { childList:true, subtree:true });
    });
    this._mo.observe(document.body, { childList:true, subtree:true });
  }
};

async function boot(){
  await loadBrand();
  let me = null;
  try { const r = await api.get('/api/auth/me'); if (r.authenticated) me = r.user; } catch(e){}
  state.me = me;
  revealAndHide();
  if (location.pathname.startsWith('/school')) {
    if (!me) {
      window.location.replace('/app/?signin=1');
      return;
    }
    return routeByRole(me.role);
  }
  if (new URLSearchParams(location.search).get('signin') === '1') return renderLogin();
  return GuestApp.start();
}

function routeByRole(role){
  setGuestMode(false);
  if (role === 'learner') return LearnerApp.start();
  if (role === 'parent')  return ParentApp.start();
  if (role === 'teacher') return TeacherApp.start();
  // admin or unknown → admin uses the desktop dashboard
  window.location.href = '/admin';
}

function setGuestMode(on){
  const app = $('#app');
  if (app) app.classList.toggle('guest-mode', !!on);
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC HOME (no login required) + LOGIN
   ═══════════════════════════════════════════════════════════════════════ */
function renderPublicHome(){
  Router.hideTabs();

  const screen = Router._ensureTabScreen();
  screen.classList.add('active');

  screen.innerHTML = `
    <div class="scroll no-nav public-home public-home-pro" id="public-home-scroll">

      <header class="public-topbar">
        <div class="brand-lockup">
          <div class="brand-logo"><i data-lucide="book-open-check"></i></div>
          <div>
            <div class="hero-eyebrow">DARAJA RESOURCES</div>
            <div class="trust-note"><i data-lucide="shield-check"></i> Public learning library</div>
          </div>
        </div>

        <button class="login-link" onclick="renderLogin()">
          School login <i data-lucide="chevron-right"></i>
        </button>
      </header>

      <section class="resource-hero">
        <div class="hero-copy">
          <span class="hero-pill"><i data-lucide="sparkles"></i> Guest access open</span>
          <h1>Find notes, exams and past papers in seconds.</h1>
          <p>
            Browse CBC, Junior Secondary, Secondary and TVET resources for learners,
            teachers and parents. No school login needed to start.
          </p>
        </div>

        <div class="hero-search pro-search">
          <i data-lucide="search"></i>
          <input id="hero-res-q" placeholder="Search Grade 7 exams, KCSE Biology, CBC notes...">
          <button type="button" onclick="loadPublicResources(document)" aria-label="Search">
            <i data-lucide="arrow-right"></i>
          </button>
        </div>

        <div class="popular-searches" aria-label="Popular searches">
          <button type="button" onclick="publicQuickSearch('Grade 7 Exams')">Grade 7 Exams</button>
          <button type="button" onclick="publicQuickSearch('KCSE Past Papers')">KCSE Past Papers</button>
          <button type="button" onclick="publicQuickSearch('CBC Notes')">CBC Notes</button>
          <button type="button" onclick="publicQuickSearch('Schemes of Work')">Schemes</button>
          <button type="button" onclick="publicQuickSearch('Lesson Plans')">Lesson Plans</button>
        </div>

        <div class="guest-access-card">
          <div class="guest-icon"><i data-lucide="user-round-check"></i></div>
          <div>
            <b>You are browsing as a guest</b>
            <span>
              Open ${PUBLIC_FREE_LIMIT} free resources. Sign in with Google to access more public
              notes, exams and past papers. School login is only for learners, teachers and parents.
            </span>
          </div>
        </div>

        <div class="public-stats pro-stats" id="public-stats">
          <span><b>0</b><small>resources</small></span>
          <span><b>0</b><small>subjects</small></span>
          <span><b>${PUBLIC_FREE_LIMIT}</b><small>free reads</small></span>
        </div>
      </section>

      <section class="public-panel public-library pro-library" id="public-library">
        <div class="library-head">
          <div>
            <div class="section-label"><i data-lucide="layers"></i> Resource library</div>
            <h2>Browse by level, subject or type</h2>
          </div>
        </div>

        <div class="level-rail" id="level-rail" aria-label="School levels">
          ${PUBLIC_LEVELS.map(([value, label], index) => `
            <button class="level-chip ${index === 0 ? 'on' : ''}" type="button" data-level="${value}">
              ${esc(label)}
            </button>
          `).join('')}
        </div>

        <div class="subject-rail" id="subject-rail" aria-label="Popular subjects">
          ${PUBLIC_SUBJECTS.map(label => `
            <button class="subject-chip" type="button" data-subject="${esc(label)}">
              ${esc(label)}
            </button>
          `).join('')}
        </div>

        <div class="type-rail" id="type-rail" aria-label="Resource types">
          ${PUBLIC_RESOURCE_TYPES.map(([value, label], index) => `
            <button class="type-chip ${index === 0 ? 'on' : ''}" type="button" data-type="${value}">
              ${esc(label)}
            </button>
          `).join('')}
        </div>

        <div class="library-count" id="library-count"></div>

        <div id="resource-list" class="resource-list pro-resource-list">
          ${skelBlock(110)}${skelBlock(110, 10)}${skelBlock(110, 10)}
        </div>

        <div id="google-block"></div>
      </section>

      <section class="public-panel school-gate-note">
        <div class="signal-row">
          <span class="signal-icon green"><i data-lucide="lock-keyhole"></i></span>
          <div>
            <b>Need private school records?</b>
            <span>
              Use School login for teacher, learner and parent dashboards.
              Public resources stay separate from private school data.
            </span>
          </div>
        </div>

        <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
      </section>
    </div>

    <nav class="guest-bottom-nav" aria-label="Guest navigation">
      <button class="on" type="button" data-guest-tab="home" onclick="scrollToPublic('top','home')">
        <i data-lucide="home"></i><span>Home</span>
      </button>
      <button type="button" data-guest-tab="library" onclick="scrollToPublic('public-library','library')">
        <i data-lucide="search"></i><span>Library</span>
      </button>
      <button type="button" data-guest-tab="saved" onclick="renderSavedPublicResources()">
        <i data-lucide="bookmark"></i><span>Saved</span>
      </button>
      <button type="button" data-guest-tab="signin" onclick="guestSignInPrompt()">
        <i data-lucide="log-in"></i><span>Sign in</span>
      </button>
    </nav>
  `;

  initPublicLibrary(screen);
  Icons.paint();
}

function initPublicLibrary(root){
  const refresh = () => loadPublicResources(root);
  const search = $('#hero-res-q', root);
  // Typing in the one search box clears any active subject chip and re-queries.
  search?.addEventListener('input', debounce(() => {
    $$('.subject-chip', root).forEach(item => item.classList.remove('on'));
    refresh();
  }, 260));
  $$('.level-chip', root).forEach(btn => btn.addEventListener('click', () => {
    $$('.level-chip', root).forEach(item => item.classList.toggle('on', item === btn));
    refresh();
  }));
  $$('.type-chip', root).forEach(btn => btn.addEventListener('click', () => {
    $$('.type-chip', root).forEach(item => item.classList.toggle('on', item === btn));
    refresh();
  }));
  // Subject chips populate the single search box (and toggle off on second tap).
  $$('.subject-chip', root).forEach(btn => btn.addEventListener('click', () => {
    const active = btn.classList.contains('on');
    if (search) search.value = active ? '' : (btn.dataset.subject || '');
    $$('.subject-chip', root).forEach(item => item.classList.toggle('on', item === btn && !active));
    refresh();
  }));
  renderGoogleBlock(root);
  refresh();
}

function debounce(fn, ms){
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

async function loadPublicResources(root){
  const list = $('#resource-list', root);
  const q = $('#hero-res-q', root)?.value.trim() || '';
  const type = $('.type-chip.on', root)?.dataset.type || 'all';
  const level = $('.level-chip.on', root)?.dataset.level || 'all';
  list.innerHTML = `${skelBlock(86)}${skelBlock(86, 10)}${skelBlock(86, 10)}`;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (type && type !== 'all') params.set('type', type);
  try {
    const data = await api.get('/api/resources' + (params.toString() ? '?' + params.toString() : ''));
    state.publicResources = (data.resources || []).filter(resource => resourceMatchesLevel(resource, level));
    renderPublicResources(root, state.publicResources);
  } catch (e) {
    const cached = cachedPublicResources().filter(resource => {
      const typeOk = type === 'all' || resource.type === type;
      const queryOk = !q || [resource.title, resource.subject, resource.grade].join(' ').toLowerCase().includes(q.toLowerCase());
      return typeOk && queryOk && resourceMatchesLevel(resource, level);
    });
    state.publicResources = cached;
    list.innerHTML = cached.length
      ? `<div class="offline-banner"><i data-lucide="wifi-off"></i> Offline mode: showing resources opened on this phone.</div>` + cached.map(resourceCard).join('')
      : errorState('No connection and no saved resources on this phone.', 'renderPublicHome()');
    Icons.paint();
  }
}

function renderPublicResources(root, resources){
  const list = $('#resource-list', root);
  const read = publicReadCount();
  const unlocked = isPublicUnlocked();
  const level = $('.level-chip.on', root)?.dataset.level || 'all';
  const stats = publicResourceStats(resources);
  const statHost = $('#public-stats', root);
  if (statHost) {
    statHost.innerHTML = `
      <span><b>${stats.total}</b><small>resources</small></span>
      <span><b>${stats.subjects || stats.types}</b><small>${stats.subjects ? 'subjects' : 'types'}</small></span>
      <span><b>${unlocked ? 'Open' : Math.max(0, PUBLIC_FREE_LIMIT - read)}</b><small>${unlocked ? 'access' : 'free reads'}</small></span>`;
  }
  $('#library-count', root).innerHTML = unlocked
    ? `<i data-lucide="badge-check"></i> Google access active for ${esc(publicLevelLabel(level))}. Open as many public resources as you need.`
    : `<i data-lucide="book-open"></i> ${esc(publicLevelLabel(level))}: ${Math.max(0, PUBLIC_FREE_LIMIT - read)} free reads left before Google access.`;
  if (!resources.length) {
    list.innerHTML = emptyState('search', 'No resources found', 'Try another search term or resource type.');
    renderGoogleBlock(root);
    Icons.paint();
    return;
  }
  list.innerHTML = resources.map(resourceCard).join('');
  renderGoogleBlock(root);
  Icons.paint();
}

function resourceCard(resource){
  const meta = [resource.grade, resource.subject, resource.year].filter(Boolean).join(' • ') || 'General resource';
  const type = resourceTypeLabel(resource.type);
  const hasFile = !!resource.file_path;
  const isSaved = cachedPublicResources().some(r => Number(r.id) === Number(resource.id));

  return `
    <button class="resource-card pro-resource-card" type="button" onclick="openPublicResource(${Number(resource.id)})">
      <span class="resource-type">${esc(type)}</span>

      <b>${esc(resource.title)}</b>

      <span class="resource-meta">${esc(meta)}</span>

      <div class="resource-badges">
        <em>${hasFile ? 'PDF / File' : 'Read online'}</em>
        <em>Free</em>
        ${isSaved ? '<em>Saved offline</em>' : '<em>Saves after opening</em>'}
      </div>

      <span class="resource-action">
        ${hasFile ? 'Open / Download' : 'Open resource'}
        <i data-lucide="${hasFile ? 'download' : 'arrow-right'}"></i>
      </span>
    </button>
  `;
}

function renderGoogleBlock(root = document){
  const host = $('#google-block', root);
  if (!host) return;

  const user = publicGoogleUser();

  if (user) {
    host.innerHTML = `
      <div class="google-unlocked pro-google">
        <i data-lucide="badge-check"></i>
        <span>
          Google access active as <b>${esc(user.name || user.email || 'reader')}</b>.
          You can open more public resources.
        </span>
      </div>
    `;
    Icons.paint();
    return;
  }

  const used = publicReadCount();
  const remaining = Math.max(0, PUBLIC_FREE_LIMIT - used);

  host.innerHTML = `
    <div class="google-block show pro-google-card">
      <div class="google-icon"><i data-lucide="sparkles"></i></div>

      <div>
        <b>${remaining > 0 ? `${remaining} free resource${remaining === 1 ? '' : 's'} left` : 'Continue with Google to access more'}</b>
        <span>
          Sign in with Google to unlock more public notes, exams, past papers and saved reading.
          School dashboards still use the separate School login.
        </span>
      </div>

      <button class="btn primary block" type="button" onclick="startGoogleReaderAccess()">
        <i data-lucide="mail"></i> Continue with Google
      </button>
    </div>
  `;

  Icons.paint();
}

function publicQuickSearch(query){
  const root = $('#screen-tab') || document;
  const search = $('#hero-res-q', root);

  if (search) search.value = query;

  $$('.subject-chip', root).forEach(item => item.classList.remove('on'));

  scrollToPublic('public-library', 'library');
  loadPublicResources(root);
}

function scrollToPublic(target, tab = ''){
  const root = $('#screen-tab') || document;
  const scroller = $('#public-home-scroll', root);

  if (target === 'top') {
    scroller?.scrollTo({ top:0, behavior:'smooth' });
  } else {
    const el = $('#' + target, root);
    el?.scrollIntoView({ behavior:'smooth', block:'start' });
  }

  if (tab) setGuestNavActive(tab);
}

function setGuestNavActive(tab){
  $$('.guest-bottom-nav button').forEach(btn => {
    btn.classList.toggle('on', btn.dataset.guestTab === tab);
  });
}

function renderSavedPublicResources(){
  const root = $('#screen-tab') || document;
  const list = $('#resource-list', root);
  const count = $('#library-count', root);
  const saved = cachedPublicResources();

  scrollToPublic('public-library', 'saved');

  if (count) {
    count.innerHTML = saved.length
      ? `<i data-lucide="bookmark-check"></i> Showing resources opened and saved on this phone.`
      : `<i data-lucide="bookmark"></i> No saved resources yet. Open a resource first to save it for offline reading.`;
  }

  if (list) {
    list.innerHTML = saved.length
      ? saved.map(resourceCard).join('')
      : emptyState('bookmark', 'No saved resources yet', 'Open a resource first. Opened resources can be saved on this phone for offline reading.');
  }

  Icons.paint();
}

function guestSignInPrompt(){
  setGuestNavActive('signin');

  const root = $('#screen-tab') || document;
  renderGoogleBlock(root);

  const block = $('#google-block', root);
  block?.scrollIntoView({ behavior:'smooth', block:'center' });
}

async function openPublicResource(id){
  const existing = state.publicResources.find(r => Number(r.id) === Number(id)) || cachedPublicResources().find(r => Number(r.id) === Number(id));
  if (!existing) return UI.toast('Resource not found', 'danger');
  if (!isPublicUnlocked() && !publicReadIds().includes(Number(id)) && publicReadCount() >= PUBLIC_FREE_LIMIT) {
    renderGoogleBlock(document);
    document.getElementById('google-block')?.scrollIntoView({ behavior:'smooth', block:'center' });
    return UI.toast('Sign in with Google to open more resources', 'warn');
  }
  let resource = existing;
  try {
    resource = await api.get('/api/resources/' + id);
    cachePublicResource(resource);
  } catch {
    if (!resource.body_html && !resource.file_path) return UI.toast('This resource is not saved offline yet', 'danger');
  }
  markPublicRead(id);
  renderGoogleBlock(document);
  const file = resource.file_path ? `<a class="btn primary block mt4" href="${esc(resource.file_path)}" target="_blank" rel="noopener"><i data-lucide="download"></i> Open file</a>` : '';
  UI.openSheet(`<div class="resource-sheet">
    <div class="resource-type">${esc(resourceTypeLabel(resource.type))}</div>
    <h2>${esc(resource.title)}</h2>
    <p class="muted">${esc([resource.grade, resource.subject, resource.year].filter(Boolean).join(' - ') || 'General')}</p>
    <div class="resource-body">${resource.body_html || '<p>This resource is available as a file.</p>'}</div>
    ${file}
    <button class="btn ghost block mt3" onclick="UI.closeSheet()"><i data-lucide="x"></i> Close</button>
  </div>`);
  Icons.paint();
}

async function startGoogleReaderAccess(){
  const clientId = googleClientId();
  if (!clientId) {
    return UI.toast('Add the Google OAuth client ID to app/index.html first.', 'danger');
  }
  const loaded = await loadGoogleIdentity();
  if (!loaded || !window.google?.accounts?.id) {
    return UI.toast('Google sign-in is unavailable. Check your connection and try again.', 'warn');
  }
  UI.openSheet(`<div class="resource-sheet">
    <div class="resource-type">Google access</div>
    <h2>Continue to the public library</h2>
    <p class="muted">Use a Google account to unlock more public resources on this phone. This is separate from School login.</p>
    <div id="google-reader-button" class="mt4"></div>
    <button class="btn ghost block mt3" onclick="UI.closeSheet()"><i data-lucide="x"></i> Cancel</button>
  </div>`);
  Icons.paint();
  google.accounts.id.initialize({
    client_id: clientId,
    callback: ({ credential }) => {
      try {
        const profile = decodeJwtPayload(credential);
        localStorage.setItem(PUBLIC_GOOGLE_KEY, JSON.stringify({
          email: profile.email,
          name: profile.name,
          picture: profile.picture,
          at: new Date().toISOString()
        }));
        UI.toast('Google access enabled', 'ok');
        UI.closeSheet();
        GuestApp.start();
      } catch {
        UI.toast('Google sign-in could not be completed', 'danger');
      }
    }
  });
  google.accounts.id.renderButton($('#google-reader-button'), {
    theme:'outline',
    size:'large',
    width: Math.min(340, window.innerWidth - 72)
  });
}

function renderLogin(){
  setGuestMode(false);
  Router.hideTabs();
  const screen = Router._ensureTabScreen();
  screen.classList.add('active');
  const school = state.school || {};
  screen.innerHTML = `
    <div class="scroll no-nav login-screen">
      <div class="appbar login-appbar"><button class="appbar-btn" onclick="GuestApp.start()"><i data-lucide="arrow-left"></i></button>
        <div class="appbar-title">Sign in</div></div>
      <div class="login-wrap">
        <div class="login-intro">
          <div class="login-mark" style="${school.school_logo ? 'background:#fff;' : ''}">
            ${school.school_logo ? `<img src="${esc(school.school_logo)}" alt="">` : '<i data-lucide="graduation-cap"></i>'}</div>
          <div>
            <div class="section-label">Official school access</div>
            <h2>${esc(school.school_name || 'Daraja')}</h2>
            <p>${esc(school.school_motto || 'Welcome back. Your school record is protected.')}</p>
          </div>
        </div>
        <form id="login-form" class="login-card">
          <div class="field"><label>Username</label>
            <input class="input" id="li-id" autocomplete="username" placeholder="Admission no, staff ID, email or phone" required></div>
          <div class="field"><label>Password</label>
            <input class="input" id="li-secret" type="password" autocomplete="current-password" placeholder="Your password" required></div>
          <button class="btn primary block mt2" id="li-btn" type="submit"><i data-lucide="log-in"></i> Sign in securely</button>
        </form>
        <div class="login-assurance">
          <span><i data-lucide="shield-check"></i> Role-based access</span>
          <span><i data-lucide="history"></i> Session protected</span>
        </div>
        <p class="center muted mt5" style="font-size:var(--t-xs);">Forgot your password? Ask the school office.</p>
      </div>
    </div>`;
  $('#login-form', screen).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#li-btn', screen); btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Signing in...';
    try {
      const identifier = $('#li-id', screen).value.trim();
      const password = $('#li-secret', screen).value.trim();
      const r = await api.post('/api/auth/login', { identifier, password });
      window.location.href = r.redirect || '/school/';
    } catch(err){
      UI.toast(err.message || 'Sign-in failed', 'danger');
      btn.disabled = false; btn.innerHTML = '<i data-lucide="log-in"></i> Sign in securely';
    }
  });
}

async function doLogout(){
  try { await api.post('/api/auth/logout', {}); } catch(e){}
  state.me = null;
  window.location.replace('/app/');
}

/* ═══════════════════════════════════════════════════════════════════════
   GUEST APP — public education resource library (no login)
   Library · Saved · You, plus a full-screen reader.
   ═══════════════════════════════════════════════════════════════════════ */
const GUEST_TYPE_ICON = { notes:'file-text', past_paper:'file-check', exam:'clipboard-check', scheme:'calendar-range', lesson_plan:'presentation', curriculum_design:'layers', other:'file' };
const GUEST_TYPE_TINT = { notes:'g', past_paper:'gold', exam:'rose', scheme:'blue', lesson_plan:'teal', curriculum_design:'violet', other:'ink' };
const GUEST_TABS = [
  { id:'library', label:'Library', icon:'library',     render:m => GuestApp.library(m) },
  { id:'saved',   label:'Saved',   icon:'bookmark',    render:m => GuestApp.saved(m) },
  { id:'you',     label:'You',     icon:'user-round',  render:m => GuestApp.you(m) }
];

const LIB_KEYS = {
  tier:     'daraja.lib.tier',
  grade:    'daraja.lib.grade',
  subject:  'daraja.lib.subject',
  type:     'daraja.lib.type',
  audience: 'daraja.lib.audience',
  sort:     'daraja.lib.sort',
  heroSeen: 'daraja.lib.hero.seen',
  recents:  'daraja.lib.recents'
};

const LIB_AUDIENCES = [
  ['all',     'Everyone', 'users-round'],
  ['teacher', 'Teacher',  'graduation-cap'],
  ['learner', 'Learner',  'backpack']
];

const LIB_SORTS = [
  ['relevance', 'Best match'],
  ['newest',    'Newest'],
  ['popular',   'Most used']
];

function inferResourceAudience(r){
  if (Array.isArray(r.audience) && r.audience.length) return r.audience;
  const t = String(r.type || '').toLowerCase();
  if (t === 'lesson_plan' || t === 'scheme' || t === 'curriculum_design') return ['teacher'];
  if (t === 'trivia') return ['learner'];
  return ['teacher', 'learner'];
}
function resourceMatchesAudience(r, a){
  if (!a || a === 'all') return true;
  return inferResourceAudience(r).includes(a);
}
function estimateMinutes(r){
  if (Number(r.minutes) > 0) return Number(r.minutes);
  const t = String(r.type || '').toLowerCase();
  return ({ past_paper:60, exam:90, notes:15, scheme:30, lesson_plan:40, trivia:8, curriculum_design:45 })[t] || 15;
}
function inferSummary(r){
  if (r.summary) return r.summary;
  if (r.description) return r.description;
  const t = resourceTypeLabel(r.type);
  const tail = [r.grade, r.subject].filter(Boolean).join(' · ');
  return tail ? `${t} for ${tail}.` : `${t}.`;
}
function libHeroSeen(){
  try { return localStorage.getItem(LIB_KEYS.heroSeen) === '1'; } catch { return false; }
}
function libSetHeroSeen(v){
  try { localStorage.setItem(LIB_KEYS.heroSeen, v ? '1' : '0'); } catch {}
}

function libReadRecents(){
  try { return JSON.parse(localStorage.getItem(LIB_KEYS.recents) || '[]').map(Number).filter(Boolean); }
  catch { return []; }
}
function libPushRecent(id){
  const n = Number(id);
  if (!n) return;
  const list = libReadRecents().filter(x => x !== n);
  list.unshift(n);
  try { localStorage.setItem(LIB_KEYS.recents, JSON.stringify(list.slice(0, 20))); } catch {}
}
function libRemoveCached(id){
  try {
    const cached = JSON.parse(localStorage.getItem(PUBLIC_CACHE_KEY) || '{}');
    delete cached[Number(id)];
    localStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify(cached));
  } catch {}
}
function libHydrateCtx(){
  try {
    return {
      q:        '',
      tier:     localStorage.getItem(LIB_KEYS.tier)     || '',
      grade:    localStorage.getItem(LIB_KEYS.grade)    || '',
      subject:  localStorage.getItem(LIB_KEYS.subject)  || '',
      type:     localStorage.getItem(LIB_KEYS.type)     || '',
      audience: localStorage.getItem(LIB_KEYS.audience) || 'all',
      sort:     localStorage.getItem(LIB_KEYS.sort)     || 'relevance'
    };
  } catch {
    return { q:'', tier:'', grade:'', subject:'', type:'', audience:'all', sort:'relevance' };
  }
}
function libPersist(key, val){
  try {
    if (val) localStorage.setItem(LIB_KEYS[key], val);
    else localStorage.removeItem(LIB_KEYS[key]);
  } catch {}
}

const GuestApp = {
  all: [],
  ctx: libHydrateCtx(),

  start(){
    setGuestMode(true);
    this.ctx = libHydrateCtx();
    Router.setTabs(GUEST_TABS);
  },

  async fetchAll(){
    if (this.all.length) return this.all;
    try { this.all = (await api.get('/api/resources')).resources || []; }
    catch { this.all = cachedPublicResources(); }
    return this.all;
  },

  topbar(){
    return `<div class="lib-topbar">
      <div class="lib-brand"><span class="lib-mark"><i data-lucide="book-open-check"></i></span>
        <div><div class="lib-name">Daraja</div><div class="lib-tag">Learning library</div></div></div>
      <button class="login-link" onclick="renderLogin()">School login <i data-lucide="chevron-right"></i></button>
    </div>`;
  },

  readerTopbar(title){
    return `<div class="lib-reader-topbar">
      <button type="button" onclick="Router.pop()" aria-label="Back"><i data-lucide="arrow-left"></i></button>
      <div>${esc(title || 'Reading')}</div>
    </div>`;
  },

  menuRow(icon, label, onclick, meta = ''){
    return `<button class="lib-menu-row" type="button" onclick="${onclick}">
      <span class="lib-menu-ic"><i data-lucide="${icon}"></i></span>
      <span class="lib-menu-text"><b>${esc(label)}</b>${meta ? `<small>${esc(meta)}</small>` : ''}</span>
      <i data-lucide="chevron-right" class="lib-menu-go"></i>
    </button>`;
  },

  cover(r, cls = ''){
    const tint = GUEST_TYPE_TINT[r.type] || 'g';
    const icon = GUEST_TYPE_ICON[r.type] || 'file';
    return `<span class="lib-cover tint-${tint} ${cls}"><i data-lucide="${icon}"></i><b>${esc(resourceTypeLabel(r.type))}</b></span>`;
  },

  shelfCard(r){
    return `<button class="lib-shelf-card" type="button" onclick="GuestApp.read(${Number(r.id)})">
      ${this.cover(r)}
      <span class="lib-card-title">${esc(r.title)}</span>
      <span class="lib-card-meta">${esc([r.grade, r.subject].filter(Boolean).join(' · ') || 'General')}</span>
    </button>`;
  },

  listCard(r){
    const saved = cachedPublicResources().some(x => Number(x.id) === Number(r.id));
    const hasFile = !!r.file_path;
    return `<button class="lib-list-card" type="button" onclick="GuestApp.read(${Number(r.id)})">
      ${this.cover(r, 'sm')}
      <span class="lib-list-body">
        <span class="lib-card-title">${esc(r.title)}</span>
        <span class="lib-card-meta">${esc([r.grade, r.subject, r.year].filter(Boolean).join(' · ') || 'General')}</span>
        <span class="lib-card-badges"><em>${hasFile ? 'PDF' : 'Read'}</em><em>Free</em>${saved ? '<em>Saved</em>' : ''}</span>
      </span>
      <i data-lucide="chevron-right" class="lib-list-chev"></i>
    </button>`;
  },

  shelf(title, items, seeAll){
    if (!items.length) return '';
    return `<section class="lib-shelf">
      <div class="lib-shelf-head"><h3>${esc(title)}</h3>${seeAll ? `<button class="lib-see" onclick="${seeAll}">See all <i data-lucide="chevron-right"></i></button>` : ''}</div>
      <div class="lib-shelf-row">${items.map(r => this.shelfCard(r)).join('')}</div>
    </section>`;
  },

  linkRow(r){
    const hasFile = !!r.file_path;
    const sub = [resourceTypeLabel(r.type), r.grade, r.subject].filter(Boolean).join(' · ') || 'General';
    return `<button class="lib-link-row" type="button" onclick="GuestApp.read(${Number(r.id)})">
      <i data-lucide="${GUEST_TYPE_ICON[r.type] || 'file'}" class="lib-link-ic tint-${GUEST_TYPE_TINT[r.type] || 'g'}"></i>
      <span class="lib-link-main"><span class="lib-link-title">${esc(r.title)}</span><span class="lib-link-sub">${esc(sub)}</span></span>
      <i data-lucide="${hasFile ? 'download' : 'chevron-right'}" class="lib-link-go"></i>
    </button>`;
  },

  resourceCard(r){
    const id = Number(r.id);
    const hasFile = !!r.file_path;
    const saved = cachedPublicResources().some(x => Number(x.id) === id);
    const aud = inferResourceAudience(r);
    const audLabel = aud.length === 2 ? 'Teacher + Learner' : (aud[0] === 'teacher' ? 'Teacher' : 'Learner');
    const format = hasFile ? 'PDF' : 'Read online';
    const minutes = estimateMinutes(r);
    return `<article class="lib-card" data-card-id="${id}">
      <div class="lib-card-top">
        <span class="lib-card-badge tint-${GUEST_TYPE_TINT[r.type] || 'g'}">
          <i data-lucide="${GUEST_TYPE_ICON[r.type] || 'file'}"></i>${esc(resourceTypeLabel(r.type))}
        </span>
        <button class="lib-card-save ${saved ? 'on' : ''}" type="button" aria-pressed="${saved}" data-save-id="${id}" aria-label="${saved ? 'Remove from saved' : 'Save for later'}">
          <i data-lucide="${saved ? 'bookmark-check' : 'bookmark'}"></i>
        </button>
      </div>
      <h3 class="lib-card-title">${esc(r.title)}</h3>
      <p class="lib-card-summary">${esc(inferSummary(r))}</p>
      <dl class="lib-card-meta">
        <div><dt>Level</dt><dd>${esc(r.grade || 'General')}</dd></div>
        <div><dt>Subject</dt><dd>${esc(r.subject || 'General')}</dd></div>
        <div><dt>For</dt><dd>${esc(audLabel)}</dd></div>
      </dl>
      <div class="lib-card-bottom">
        <span class="lib-card-format"><i data-lucide="${hasFile ? 'file-text' : 'book-open'}"></i> ${esc(format)} &middot; ${minutes} min</span>
        <button class="lib-card-open" type="button" data-open-id="${id}">Open resource <i data-lucide="arrow-right"></i></button>
      </div>
    </article>`;
  },

  toggleSave(id){
    const n = Number(id);
    const cached = cachedPublicResources();
    if (cached.some(x => Number(x.id) === n)){
      libRemoveCached(n);
    } else {
      const r = (this.all || []).find(x => Number(x.id) === n) || cached.find(x => Number(x.id) === n);
      if (r && typeof cachePublicResource === 'function') cachePublicResource(r);
    }
    const screen = $('#screen-tab');
    if (screen) this.runBrowse(screen);
  },

  libraryGrade(level){ this.ctx.grade = level; libPersist('grade', level); this.ctx.q = ''; this.ctx.subject = ''; libPersist('subject', ''); Router.go('library'); },

  tierGrades(tier){
    const entry = CURRICULUM_TIERS.find(t => t[0] === tier);
    if (!entry) return [];
    return entry[2].map(g => PUBLIC_LEVELS.find(l => l[0] === g)).filter(Boolean);
  },

  recentCards(){
    const ids = libReadRecents().slice(0, 5);
    if (!ids.length) return '';
    const pool = (this.all && this.all.length) ? this.all : cachedPublicResources();
    const byId = new Map(pool.map(r => [Number(r.id), r]));
    const items = ids.map(id => byId.get(id)).filter(Boolean);
    if (!items.length) return '';
    return `<section class="lib-recent">
      <div class="lib-shelf-head"><h3>Recent</h3></div>
      <div class="lib-recent-row">${items.map(r => `
        <button class="lib-recent-card" type="button" onclick="GuestApp.read(${Number(r.id)})">
          <i data-lucide="${GUEST_TYPE_ICON[r.type] || 'file'}"></i>
          <span class="lib-recent-title">${esc(r.title)}</span>
          <span class="lib-recent-meta">${esc([r.grade, r.subject].filter(Boolean).join(' · ') || resourceTypeLabel(r.type))}</span>
        </button>`).join('')}</div>
    </section>`;
  },

  library(m){
    const c = this.ctx;
    const heroSeen = libHeroSeen();

    if (!heroSeen){
      m.innerHTML = this.topbar() + `<div class="scroll lib-scroll" id="lib-browse">
        <section class="lib-hero-pick">
          <span class="lib-hero-pick-eyebrow">Welcome to Daraja</span>
          <h2 class="lib-hero-pick-title">Who is looking for resources?</h2>
          <p class="lib-hero-pick-sub">We will tailor the library to your role. You can change this any time.</p>
          <div class="lib-hero-pick-row">
            <button class="lib-hero-pick-btn" type="button" data-hero-pick="teacher">
              <i data-lucide="graduation-cap"></i>
              <span><b>I am a teacher</b><small>Schemes, lesson plans, marking aids</small></span>
            </button>
            <button class="lib-hero-pick-btn" type="button" data-hero-pick="learner">
              <i data-lucide="backpack"></i>
              <span><b>I am a learner</b><small>Notes, past papers, revision</small></span>
            </button>
          </div>
          <button class="lib-hero-pick-skip" type="button" data-hero-pick="all">Skip &mdash; show everything</button>
        </section>
        <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
      </div>`;
      $$('.lib-hero-pick-btn, .lib-hero-pick-skip', m).forEach(btn => btn.addEventListener('click', () => {
        const a = btn.dataset.heroPick;
        c.audience = a;
        libPersist('audience', a);
        libSetHeroSeen(true);
        this.library(m);
      }));
      Icons.paint();
      return;
    }

    const tierGrades = c.tier ? this.tierGrades(c.tier) : [];
    const hasActiveFilter = !!(c.grade || c.subject || c.type || c.q);
    const audienceActive = c.audience && c.audience !== 'all';
    const showRecent = !c.tier && !c.q && !hasActiveFilter && libReadRecents().length > 0;

    m.innerHTML = this.topbar() + `<div class="scroll lib-scroll" id="lib-browse">
      <div class="hero-search lib-browse-search">
        <i data-lucide="search"></i>
        <input id="lib-q" placeholder="Search" value="${esc(c.q)}">
      </div>

      <section class="lib-chip-section">
        <div class="lib-row-head"><span class="lib-row-step">1</span><span>I am a&hellip;</span><span class="lib-row-hint">tap one</span></div>
        <div class="lib-chip-row-wrap"><div class="lib-audience-row" aria-label="Audience">
          ${LIB_AUDIENCES.map(([val, label, icon]) => `
            <button class="lib-chip ${c.audience === val ? 'on' : ''}" type="button" data-audience="${val}">
              <i data-lucide="${icon}"></i> ${esc(label)}
            </button>
          `).join('')}
        </div></div>
      </section>

      <section class="lib-chip-section">
        <div class="lib-row-head"><span class="lib-row-step">2</span><span>Curriculum tier</span><span class="lib-row-hint">tap one &middot; swipe for more</span></div>
        <div class="lib-chip-row-wrap"><div class="lib-tier-row" role="tablist" aria-label="Curriculum tier">
          ${CURRICULUM_TIERS.map(([val, label]) => `
            <button class="lib-chip ${c.tier === val ? 'on' : ''}" type="button" data-tier="${val}">${esc(label)}</button>
          `).join('')}
        </div></div>
      </section>

      ${c.tier ? `<section class="lib-chip-section">
        <div class="lib-row-head"><span class="lib-row-step">3</span><span>Grade</span><span class="lib-row-hint">tap one &middot; swipe for more</span></div>
        <div class="lib-chip-row-wrap"><div class="lib-grade-row" aria-label="Grade">
          ${tierGrades.map(([val, label]) => `
            <button class="lib-chip ${c.grade === val ? 'on' : ''}" type="button" data-grade="${val}">${esc(label)}</button>
          `).join('')}
        </div></div>
      </section>` : ''}

      <section class="lib-chip-section">
        <div class="lib-row-head"><span class="lib-row-step">${c.tier ? '4' : '·'}</span><span>Subject</span><span class="lib-row-hint">tap one &middot; swipe for more</span></div>
        <div class="lib-chip-row-wrap"><div class="lib-subject-row" aria-label="Subject">
          ${PUBLIC_SUBJECTS.map(s => `
            <button class="lib-chip ${c.subject === s ? 'on' : ''}" type="button" data-subject="${esc(s)}">${esc(s)}</button>
          `).join('')}
        </div></div>
      </section>

      <section class="lib-chip-section">
        <div class="lib-row-head"><span class="lib-row-step">${c.tier ? '5' : '·'}</span><span>Type</span><span class="lib-row-hint">tap one &middot; swipe for more</span></div>
        <div class="lib-chip-row-wrap"><div class="lib-type-row" aria-label="Type">
          ${PUBLIC_RESOURCE_TYPES.map(([val, label]) => `
            <button class="lib-chip ${c.type === val ? 'on' : ''}" type="button" data-type="${val}">${esc(label)}</button>
          `).join('')}
        </div></div>
      </section>

      <section class="lib-sort-section">
        <span class="lib-sort-label">Sort</span>
        <div class="lib-sort-row" role="group" aria-label="Sort">
          ${LIB_SORTS.map(([val, label]) => `
            <button class="lib-sort-chip ${c.sort === val ? 'on' : ''}" type="button" data-sort="${val}">${esc(label)}</button>
          `).join('')}
        </div>
      </section>

      ${(c.tier || hasActiveFilter || audienceActive) ? `<button class="lib-clear-pill" type="button" id="lib-clear"><i data-lucide="x"></i> Clear all filters</button>` : ''}

      <div id="lib-recent-host">${showRecent ? this.recentCards() : ''}</div>

      <div class="lib-count" id="lib-count"></div>
      <div id="lib-results" class="lib-cards">${skelBlock(120)}${skelBlock(120,8)}${skelBlock(120,8)}</div>
      <div id="google-block"></div>
      <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
    </div>`;

    const run = debounce(() => this.runBrowse(m), 220);
    $('#lib-q', m).addEventListener('input', e => { c.q = e.target.value.trim(); run(); });
    $$('.lib-audience-row .lib-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.audience;
      c.audience = c.audience === val ? 'all' : val;
      libPersist('audience', c.audience);
      this.library(m);
    }));
    $$('.lib-tier-row .lib-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.tier;
      const same = c.tier === val;
      c.tier = same ? '' : val;
      libPersist('tier', c.tier);
      c.grade = '';
      libPersist('grade', '');
      this.library(m);
    }));
    $$('.lib-grade-row .lib-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.grade;
      c.grade = c.grade === val ? '' : val;
      libPersist('grade', c.grade);
      this.library(m);
    }));
    $$('.lib-subject-row .lib-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.subject;
      c.subject = c.subject === val ? '' : val;
      libPersist('subject', c.subject);
      this.library(m);
    }));
    $$('.lib-type-row .lib-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.type;
      c.type = c.type === val ? '' : val;
      libPersist('type', c.type);
      this.library(m);
    }));
    $$('.lib-sort-chip', m).forEach(btn => btn.addEventListener('click', () => {
      const val = btn.dataset.sort;
      c.sort = val;
      libPersist('sort', c.sort);
      this.library(m);
    }));
    $('#lib-results', m).addEventListener('click', (e) => {
      const saveBtn = e.target.closest('[data-save-id]');
      if (saveBtn){ e.stopPropagation(); this.toggleSave(saveBtn.dataset.saveId); return; }
      const openBtn = e.target.closest('[data-open-id]');
      if (openBtn){ this.read(Number(openBtn.dataset.openId)); return; }
      const card = e.target.closest('.lib-card');
      if (card){ this.read(Number(card.dataset.cardId)); }
    });
    const clear = $('#lib-clear', m);
    clear?.addEventListener('click', () => {
      c.q = ''; c.tier = ''; c.grade = ''; c.subject = ''; c.type = '';
      c.audience = 'all'; c.sort = 'relevance';
      libPersist('tier', ''); libPersist('grade', ''); libPersist('subject', ''); libPersist('type', '');
      libPersist('audience', ''); libPersist('sort', '');
      libSetHeroSeen(false);
      this.library(m);
    });

    this.runBrowse(m);
    Icons.paint();
  },

  async runBrowse(m){
    const c = this.ctx;
    const host = $('#lib-results', m); if (!host) return;
    const count = $('#lib-count', m);
    const audienceActive = c.audience && c.audience !== 'all';
    const hasFilter = !!(c.tier || c.grade || c.subject || c.type || c.q || audienceActive);
    if (!hasFilter){
      if (count) count.innerHTML = '';
      host.innerHTML = `<div class="lib-pick-cta">
        <div class="lib-pick-cta-ic"><i data-lucide="arrow-up"></i></div>
        <h3>Tap a pill above to begin</h3>
        <p>Pick an audience, tier, grade, subject or type &mdash; or type a title in search &mdash; and matching resources will appear here.</p>
      </div>`;
      const gb = $('#google-block', m); if (gb) gb.innerHTML = '';
      Icons.paint();
      return;
    }
    const params = new URLSearchParams();
    if (c.q) params.set('q', c.q);
    if (c.type) params.set('type', c.type);
    if (c.subject) params.set('subject', c.subject);
    const tierGradeKeys = (!c.grade && c.tier) ? this.tierGrades(c.tier).map(([v]) => v) : null;
    const tierMatch = r => !tierGradeKeys || tierGradeKeys.some(g => resourceMatchesLevel(r, g));
    let resources = [];
    try {
      const data = await api.get('/api/resources' + (params.toString() ? '?' + params.toString() : ''));
      resources = (data.resources || []).filter(r => resourceMatchesLevel(r, c.grade || 'all') && tierMatch(r) && resourceMatchesAudience(r, c.audience));
      this.all = data.resources || this.all;
    } catch {
      const ql = c.q.toLowerCase();
      resources = cachedPublicResources().filter(r => resourceMatchesLevel(r, c.grade || 'all')
        && tierMatch(r)
        && resourceMatchesAudience(r, c.audience)
        && (!c.type || r.type === c.type)
        && (!c.subject || String(r.subject||'').toLowerCase() === c.subject.toLowerCase())
        && (!ql || [r.title, r.subject, r.grade].join(' ').toLowerCase().includes(ql)));
    }

    if (c.sort === 'newest'){
      resources = resources.slice().sort((a,b) => {
        const ay = Number(a.year) || 0, by = Number(b.year) || 0;
        if (by !== ay) return by - ay;
        return String(b.created_at || '').localeCompare(String(a.created_at || ''));
      });
    } else if (c.sort === 'popular'){
      resources = resources.slice().sort((a,b) => {
        const ad = Number(a.downloads || a.read_count || a.views || 0);
        const bd = Number(b.downloads || b.read_count || b.views || 0);
        if (bd !== ad) return bd - ad;
        return Number(b.id) - Number(a.id);
      });
    }

    const remaining = isPublicUnlocked() ? null : Math.max(0, PUBLIC_FREE_LIMIT - publicReadCount());
    if (count) count.innerHTML = `<i data-lucide="library"></i> ${resources.length} resource${resources.length===1?'':'s'}${remaining===null?'':` &middot; ${remaining} free read${remaining===1?'':'s'} left`}`;
    if (!resources.length){
      host.innerHTML = c.q
        ? emptyState('search-x', 'No matches', `Couldn't find that on the shelf. Try another title or clear a filter.`)
        : emptyState('search-x', 'No resources yet', 'Nothing stocked here yet.');
    } else {
      host.innerHTML = resources.map(r => this.resourceCard(r)).join('');
    }
    this.googleBlock(m);
    Icons.paint();
  },

  /* ════ SAVED ════ */
  savedRow(r){
    const hasFile = !!r.file_path;
    const sub = [resourceTypeLabel(r.type), r.grade, r.subject].filter(Boolean).join(' · ') || 'General';
    return `<div class="lib-link-row lib-saved-row">
      <button class="lib-link-row-main" type="button" onclick="GuestApp.read(${Number(r.id)})">
        <i data-lucide="${GUEST_TYPE_ICON[r.type] || 'file'}" class="lib-link-ic tint-${GUEST_TYPE_TINT[r.type] || 'g'}"></i>
        <span class="lib-link-main"><span class="lib-link-title">${esc(r.title)}</span><span class="lib-link-sub">${esc(sub)}</span></span>
        <i data-lucide="${hasFile ? 'download' : 'chevron-right'}" class="lib-link-go"></i>
      </button>
      <button class="lib-saved-remove" type="button" aria-label="Remove" onclick="GuestApp.removeSaved(${Number(r.id)})">&times;</button>
    </div>`;
  },

  removeSaved(id){
    libRemoveCached(id);
    const screen = $('#screen-tab');
    if (screen) this.saved(screen);
  },

  saved(m){
    const items = cachedPublicResources().slice().sort((a,b) => String(b.cached_at||'').localeCompare(String(a.cached_at||'')));
    m.innerHTML = this.topbar() + `<div class="scroll lib-scroll">
      <section class="lib-hero compact"><h1>Saved &amp; offline</h1><p class="lib-sub">Resources you open are kept on this phone so you can read without data.</p></section>
      <div class="lib-list pad-x">${items.length ? items.map(r => this.savedRow(r)).join('') : emptyState('bookmark', 'Nothing saved yet', 'Open a resource and it is kept here for offline reading.')}</div>
      <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
    </div>`;
    Icons.paint();
  },

  /* ════ YOU / SIGN IN ════ */
  you(m){
    const user = publicGoogleUser();
    const remaining = Math.max(0, PUBLIC_FREE_LIMIT - publicReadCount());
    m.innerHTML = this.topbar() + `<div class="scroll lib-scroll pad stack-gap">
      <section class="lib-hero compact"><h1>${user ? 'Your library access' : 'Browsing as a guest'}</h1></section>
      ${user
        ? `<div class="lib-account-card">
            <span class="lib-account-avatar">${initials(user.name || user.email || 'Reader')}</span>
            <span><b>${esc(user.name || 'Reader')}</b><small>${esc(user.email || 'Google access active')}</small></span>
          </div>`
        : `<div class="lib-upgrade">
            <div class="google-icon"><i data-lucide="sparkles"></i></div>
            <b>${remaining} free read${remaining===1?'':'s'} left</b>
            <span>Continue with Google to open more public notes, exams and past papers, and keep your saved reading on this phone.</span>
            <button class="btn primary block" type="button" onclick="startGoogleReaderAccess()"><i data-lucide="mail"></i> Continue with Google</button>
          </div>`}
      <div class="lib-menu-list">
        ${this.menuRow('lock-keyhole', 'School login', "renderLogin()", 'For school records, staff, learners and parents')}
        ${this.menuRow('book-open-check', 'About Daraja', "GuestApp.about()", 'Public notes, exams and learning resources')}
      </div>
      <div class="center muted" style="font-size:var(--t-xs);line-height:1.5;">Public resources are open to everyone and stay separate from private school dashboards.</div>
      <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
    </div>`;
    Icons.paint();
  },

  about(){
    Router.push(async (s) => {
      s.innerHTML = this.readerTopbar('About Daraja') + `<div class="scroll lib-scroll pad">
        <section class="lib-about">
          <span class="lib-about-mark"><i data-lucide="book-open-check"></i></span>
          <h1>Daraja</h1>
          <p>A public learning library for African classrooms, built around notes, exams, past papers, lesson plans, schemes and curriculum resources.</p>
        </section>
        <div class="lib-menu-list">
          ${this.menuRow('search', 'Browse resources', "Router.pop(); Router.go('library')", 'Find resources by grade, subject and type')}
          ${this.menuRow('bookmark', 'Saved reading', "Router.pop(); Router.go('saved')", 'Opened resources stay available on this phone')}
        </div>
        <footer class="public-footer">Built with love by Joyland Prime Academy.</footer>
      </div>`;
      Icons.paint();
    });
  },

  googleBlock(m){
    const host = $('#google-block', m); if (!host) return;
    const remaining = isPublicUnlocked() ? 1 : Math.max(0, PUBLIC_FREE_LIMIT - publicReadCount());
    if (remaining > 0){ host.innerHTML = ''; return; }
    host.innerHTML = `<div class="lib-upgrade inline">
      <div class="google-icon"><i data-lucide="sparkles"></i></div>
      <b>Continue with Google to read more</b>
      <span>You have used your free reads. Sign in to keep opening public resources.</span>
      <button class="btn primary block" type="button" onclick="startGoogleReaderAccess()"><i data-lucide="mail"></i> Continue with Google</button>
    </div>`;
    Icons.paint();
  },

  /* ════ READER (full-screen) ════ */
  async read(id){
    if (!isPublicUnlocked() && !publicReadIds().includes(Number(id)) && publicReadCount() >= PUBLIC_FREE_LIMIT){
      UI.toast('Sign in with Google to open more resources', 'warn');
      Router.go('you');
      return;
    }
    Router.push(async (s) => {
      s.innerHTML = this.readerTopbar('Reading') + loadingScroll();
      let r;
      try { r = await api.get('/api/resources/' + id); cachePublicResource(r); }
      catch { r = cachedPublicResources().find(x => Number(x.id) === Number(id)); }
      if (!r){ s.innerHTML = this.readerTopbar('Reading') + `<div class="scroll">${errorState('This resource is not available offline yet.')}</div>`; return; }
      markPublicRead(id);
      libPushRecent(id);
      const meta = [r.grade, r.subject, r.year].filter(Boolean).join(' · ') || 'General';
      const file = r.file_path ? `<a class="btn primary block mt4" href="${esc(r.file_path)}" target="_blank" rel="noopener"><i data-lucide="download"></i> Open / download file</a>` : '';
      const pool = this.all.length ? this.all : cachedPublicResources();
      const related = pool.filter(x => Number(x.id) !== Number(id) && (x.subject === r.subject || x.type === r.type)).slice(0,6);
      s.innerHTML = this.readerTopbar(resourceTypeLabel(r.type)) + `<div class="scroll lib-reader">
        <div class="reader-head">${this.cover(r,'lg')}<div><h1>${esc(r.title)}</h1><div class="reader-meta">${esc(meta)}</div></div></div>
        ${file}
        <article class="reader-body">${r.body_html || '<p class="muted">This resource is available as a downloadable file above.</p>'}</article>
        ${related.length ? `<div class="lib-shelf-head reader-related"><h3>More like this</h3></div><div class="lib-shelf-row">${related.map(x => this.shelfCard(x)).join('')}</div>` : ''}
      </div>`;
      Icons.paint();
    });
  }
};

/* ═══════════════════════════════════════════════════════════════════════
   LEARNER APP
   ═══════════════════════════════════════════════════════════════════════ */
const LearnerApp = {
  ctx: { termId:null, assessment:null, terms:[] },

  start(){
    Router.setTabs([
      { id:'home',     label:'Home',      icon:'home',          render:m => LearnerApp.home(m) },
      { id:'results',  label:'Results',   icon:'bar-chart-3',   render:m => LearnerApp.results(m) },
      { id:'timetable',label:'Timetable', icon:'calendar-days',   render:m => LearnerApp.timetable(m) },
      { id:'more',     label:'More',      icon:'ellipsis',       render:m => LearnerApp.more(m) }
    ]);
  },

  /* ── Home ── */
  async home(m){
    m.innerHTML = loadingScroll();
    let s;
    try { s = await api.get('/api/learner/summary'); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'Home' }) + `<div class="scroll">${errorState(e.message, 'Router.go(\'home\')')}</div>`; return; }
    const p = s.profile || {};
    const att = s.attendance_summary;
    LearnerApp.ctx.termId = s.current_term?.id || null;
    LearnerApp.ctx.assessment = s.current_assessment || 'midterm';
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

    m.innerHTML = `
      <div class="hero">
        <div class="row-between">
          <div class="hero-eyebrow">${esc(s.current_session?.name || 'This year')} · ${esc(s.current_term?.name || 'Term')}</div>
          <button class="appbar-btn" style="background:rgba(255,255,255,.16);color:#fff;box-shadow:none;" onclick="LearnerApp.notifications()"><i data-lucide="bell"></i><span class="badge-dot js-unread-badge" hidden></span></button>
        </div>
        <div class="hero-greet">${greet},<br><em>${esc(firstName(p.name) || 'Learner')}.</em></div>
        <div class="hero-sub">${esc(p.class_name || 'Your class')} · Adm ${esc(p.admission_no || '—')}</div>
      </div>
      <div class="scroll pad">
        <div class="lift stack-gap">
          <div class="metrics">
            <div class="metric"><span class="ic green"><i data-lucide="user-check"></i></span>
              <span class="val">${att ? att.pct + '%' : '—'}</span><span class="lbl">Attendance</span></div>
            <div class="metric"><span class="ic gold"><i data-lucide="book"></i></span>
              <span class="val">${num(s.subjects_count)}</span><span class="lbl">Subjects</span></div>
            <div class="metric"><span class="ic blue"><i data-lucide="calendar-check"></i></span>
              <span class="val">${att ? num(att.present) : '—'}</span><span class="lbl">Days present</span></div>
            <div class="metric"><span class="ic rose"><i data-lucide="calendar-x"></i></span>
              <span class="val">${att ? num(att.absent) : '—'}</span><span class="lbl">Days absent</span></div>
          </div>

          <div class="card">
            <div class="card-hd"><h3>My results</h3>
              <a class="link" onclick="Router.go('results')">View all <i data-lucide="chevron-right" style="font-size:10px;"></i></a></div>
            <div id="home-results" class="muted" style="font-size:var(--t-sm);">Loading…</div>
          </div>

          <div class="card">
            <div class="card-hd"><h3>Class teacher</h3></div>
            <div class="row" style="border:none;padding:0;">
              <div class="ava ava-md lead" style="${avaColor(s.class?.class_teacher_name)}">${initials(s.class?.class_teacher_name || '?')}</div>
              <div class="body"><div class="title">${esc(s.class?.class_teacher_name || 'Not assigned')}</div>
                <div class="meta">${esc(s.class?.name || p.class_name || '')}</div></div>
            </div>
          </div>

          ${s.next_term_begins ? `<div class="card flat center"><div class="muted" style="font-size:var(--t-sm);">Next term begins</div>
            <div style="font-weight:800;font-size:var(--t-lg);margin-top:4px;">${esc(fmtDate(s.next_term_begins))}</div></div>` : ''}
        </div>
      </div>`;

    // lazy-load results preview
    try {
      const r = await api.get('/api/learner/marks?term_id=' + (LearnerApp.ctx.termId || '') + '&assessment_type=' + LearnerApp.ctx.assessment);
      const host = $('#home-results', m); if (!host) return;
      const scored = (r.subjects || []).filter(x => x.percent != null);
      if (!scored.length){ host.innerHTML = 'No marks published yet for this term.'; return; }
      const [bc, , bl] = bandFor(r.overall_percent || 0);
      host.innerHTML = `<div class="row-between" style="margin-bottom:12px;">
          <div><div style="font-size:var(--t-3xl);font-weight:800;letter-spacing:-.03em;line-height:.9;">${pct(r.overall_percent)}</div>
            <div class="muted" style="font-size:var(--t-xs);margin-top:4px;">Overall average · ${esc(r.assessment_type)}</div></div>
          <span class="badge ${bc}" style="font-size:var(--t-sm);padding:6px 12px;">${esc(bl)}</span></div>
        ${scored.slice(0, 3).map(sub => {
          const [c] = bandFor(sub.percent);
          return `<div class="row" style="padding:8px 2px;"><div class="body"><div class="title">${esc(sub.subject_name)}</div></div>
            <div class="trail"><span class="badge ${c}">${pct(sub.percent)}</span></div></div>`;
        }).join('')}`;
    } catch(e){ const host = $('#home-results', m); if (host) host.innerHTML = 'Results unavailable.'; }
  },

  /* ── Results ── */
  async results(m){
    m.innerHTML = appbar({ title:'My Results' }) + loadingScroll();
    let r;
    const q = '?term_id=' + (LearnerApp.ctx.termId || '') + '&assessment_type=' + (LearnerApp.ctx.assessment || 'midterm');
    try { r = await api.get('/api/learner/marks' + q); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'My Results' }) + `<div class="scroll">${errorState(e.message, 'Router.go(\'results\')')}</div>`; return; }
    const scored = (r.subjects || []).filter(x => x.percent != null);
    m.innerHTML = appbar({ title:'My Results' }) + `<div class="scroll pad stack-gap">
      <div class="seg" id="assess-seg">
        <button data-a="midterm" class="${r.assessment_type === 'midterm' ? 'on' : ''}">Midterm</button>
        <button data-a="endterm" class="${r.assessment_type === 'endterm' ? 'on' : ''}">End term</button>
      </div>
      ${resultsBodyHTML(r)}
      ${scored.length ? `<button class="btn ghost block" onclick="LearnerApp.comments()"><i data-lucide="message-circle"></i> Teacher comments</button>` : ''}
    </div>`;
    $$('#assess-seg button', m).forEach(b => b.addEventListener('click', () => {
      LearnerApp.ctx.assessment = b.dataset.a; Router.go('results');
    }));
  },

  async comments(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + loadingScroll();
      try {
        const c = await api.get('/api/learner/comments?term_id=' + (LearnerApp.ctx.termId || '') + '&assessment_type=' + (LearnerApp.ctx.assessment || 'midterm'));
        const list = c.comments || [];
        s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + `<div class="scroll pad stack-gap">
          ${list.length ? list.map(x => `<div class="card"><div class="card-hd" style="margin-bottom:8px;">
            <h3>${esc(x.role_label)}</h3></div><p style="font-size:var(--t-base);line-height:1.6;color:var(--ink-2);font-style:italic;">"${esc(x.text || 'No comment')}"</p></div>`).join('')
          : emptyState('message-circle-off', 'No comments yet', 'Comments appear after teachers complete your report.')}
        </div>`;
      } catch(e){ s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; }
    });
  },

  /* ── Timetable ── */
  async timetable(m){
    m.innerHTML = appbar({ title:'Timetable' }) + loadingScroll();
    let t;
    try { t = await api.get('/api/learner/timetable'); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'Timetable' }) + `<div class="scroll">${errorState(e.message, 'Router.go(\'timetable\')')}</div>`; return; }
    mountTimetable(m, 'Timetable', t);
  },

  notifications(){
    renderNotificationsScreen();
  },

  /* ── More ── */
  async more(m){
    const me = state.me || {};
    let p = {};
    try { p = (await api.get('/api/learner/summary')).profile || {}; } catch(e){}
    const school = state.school || {};
    m.innerHTML = appbar({ title:'More' }) + `<div class="scroll pad stack-gap">
      <div class="card" style="display:flex;align-items:center;gap:14px;">
        <div class="ava ava-lg lead" style="${p.portrait_path ? 'background:#fff;' : avaColor(p.name || me.name)}">
          ${p.portrait_path ? `<img src="${esc(p.portrait_path)}" alt="">` : initials(p.name || me.name)}</div>
        <div class="body"><div style="font-weight:800;font-size:var(--t-lg);letter-spacing:-.01em;">${esc(p.name || me.name || 'Learner')}</div>
          <div class="muted" style="font-size:var(--t-sm);">${esc(p.class_name || '')} · Adm ${esc(p.admission_no || me.user_id || '—')}</div></div>
      </div>
      <div class="card" style="padding:6px 16px;"><div class="rows">
        ${moreRow('key', 'Change password', "LearnerApp.changePassword()")}
        ${moreRow('info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('log-out', 'Sign out', "doLogout()", 'var(--danger)')}
      </div></div>
      <div class="center muted" style="font-size:var(--t-xs);">${esc(school.school_name || 'Daraja')} · v3.0</div>
    </div>`;
  },

  changePassword(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Change Password', back:true }) + `<div class="scroll pad">
        <form id="cp-form" class="stack-gap">
          <div class="field"><label>Current password</label><input class="input" id="cp-cur" type="password" required></div>
          <div class="field"><label>New password</label><input class="input" id="cp-new" type="password" minlength="4" required></div>
          <div class="field"><label>Confirm new password</label><input class="input" id="cp-conf" type="password" minlength="4" required></div>
          <button class="btn primary block" id="cp-btn" type="submit">Update password</button>
        </form></div>`;
      $('#cp-form', s).addEventListener('submit', async (e) => {
        e.preventDefault();
        if ($('#cp-new', s).value !== $('#cp-conf', s).value) return UI.toast('Passwords do not match', 'danger');
        const btn = $('#cp-btn', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        try {
          await api.put('/api/learner/change-password', { current_password: $('#cp-cur', s).value, new_password: $('#cp-new', s).value });
          UI.toast('Password updated', 'ok'); Router.pop();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = 'Update password'; }
      });
    });
  },

  about(){
    const school = state.school || {};
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'About', back:true }) + `<div class="scroll pad center">
        <div class="ava ava-lg" style="margin:24px auto 16px;${school.school_logo ? 'background:#fff;' : ''}">
          ${school.school_logo ? `<img src="${esc(school.school_logo)}">` : '<i data-lucide="graduation-cap"></i>'}</div>
        <h2 style="font-weight:800;font-size:var(--t-2xl);">${esc(school.school_name || 'Daraja')}</h2>
        <p class="muted mt2">${esc(school.school_motto || 'Education is Treasure')}</p>
        <div class="card flat mt6" style="text-align:left;">
          ${[['phone', school.school_phone], ['mail', school.school_email], ['map-pin', school.school_address]].filter(x => x[1]).map(x =>
            `<div class="row"><i data-lucide="${x[0]}" class="lead muted" style="width:24px;"></i><div class="body title" style="font-weight:500;">${esc(x[1])}</div></div>`).join('')}
        </div>
        <p class="muted mt6" style="font-size:var(--t-xs);">Daraja v3.0 · Built for learners</p>
      </div>`;
    });
  }
};

function moreRow(icon, label, onclick, color){
  return `<button class="row" style="width:100%;text-align:left;" onclick="${onclick}">
    <i data-lucide="${icon}" class="lead" style="width:26px;color:${color || 'var(--ink-3)'};font-size:16px;"></i>
    <div class="body title" style="font-weight:600;${color ? 'color:' + color + ';' : ''}">${esc(label)}</div>
    <i data-lucide="chevron-right" class="chev"></i></button>`;
}

function fmtDate(d){
  if (!d) return '—';
  const dt = new Date(String(d).includes('T') ? d : d + 'T00:00:00');
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' });
}

/* ── Shared screen renderers (used by Learner + Parent) ── */
function resultsBodyHTML(r){
  const scored = (r.subjects || []).filter(x => x.percent != null);
  if (!scored.length) return emptyState('bar-chart-3', 'No results yet', 'Marks for this term will appear here once teachers publish them.');
  const overall = r.overall_percent; const [oc, , ol] = bandFor(overall || 0);
  return `<div class="card" style="background:var(--grad-brand);color:#fff;text-align:center;box-shadow:var(--sh-brand);">
      <div style="font-size:var(--t-xs);letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7);">Overall average</div>
      <div style="font-size:var(--t-3xl);font-weight:800;letter-spacing:-.03em;margin:6px 0;">${pct(overall)}</div>
      <span class="badge ${oc}">${esc(ol)} expectations</span></div>
    <div class="card"><div class="card-hd"><h3>Subjects</h3><span class="muted" style="font-size:var(--t-xs);">${scored.length} scored</span></div>
      <div class="rows">${(r.subjects || []).map(sub => { const has = sub.percent != null; const [c, ab] = bandFor(sub.percent || 0);
        return `<div class="row"><div class="body"><div class="title">${esc(sub.subject_name)}</div>
          <div class="meta">${has ? num(sub.total, 1) + ' / ' + num(sub.max_total) : 'Not marked yet'}</div></div>
          <div class="trail">${has ? `<span class="mono" style="font-weight:700;">${pct(sub.percent)}</span><span class="badge ${c}">${ab}</span>` : '<span class="muted">—</span>'}</div></div>`; }).join('')}</div></div>`;
}

function mountTimetable(mount, title, t, { back = false } = {}){
  const slots = t.slots || [];
  if (!slots.length){ mount.innerHTML = appbar({ title, back }) + `<div class="scroll">${emptyState('calendar-days', 'No timetable yet', 'The class timetable will show here once the school publishes it.')}</div>`; return; }
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const periods = {};
  (t.periods || []).forEach(p => { periods[p.period_no] = p; });
  const todayDow = new Date().getDay();
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = value => {
    const [h, m] = String(value || '').split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
  };
  const byDay = {}; slots.forEach(s => { (byDay[s.day_of_week] = byDay[s.day_of_week] || []).push(s); });
  const order = [1,2,3,4,5,6,0].filter(d => byDay[d]);
  let cur = order.includes(todayDow) ? todayDow : order[0];
  const draw = (day) => {
    const list = (byDay[day] || []).sort((a, b) => a.period_no - b.period_no);
    const nextIdx = list.findIndex(s => {
      const end = toMinutes(periods[s.period_no]?.end_time);
      return day === todayDow && end != null && end >= nowMinutes;
    });
    $('#tt-body', mount).innerHTML = list.length ? `<div class="rows">${list.map((s, idx) => {
      const p = periods[s.period_no] || {};
      const start = p.start_time || ('P' + s.period_no);
      const end = p.end_time || 'period';
      const next = idx === nextIdx;
      return `<div class="row ${next ? 'active' : ''}"><div class="lead" style="width:58px;text-align:center;">
        <div class="mono" style="font-weight:800;font-size:var(--t-sm);color:var(--brand-600);">${esc(start)}</div>
        <div class="muted" style="font-size:9px;">${esc(end)}</div></div>
        <div class="body"><div class="title">${esc(s.subject_name || 'Lesson')}</div>
        <div class="meta">${esc(s.teacher_name || s.class_name || '')}${s.room_name ? ' - ' + esc(s.room_name) : ''}${next ? ' - next' : ''}</div></div>
        ${s.is_substitution ? '<span class="badge warn">Cover</span>' : ''}</div>`;
    }).join('')}</div>` : emptyState('coffee', 'No lessons', 'Nothing scheduled for this day.');
  };
  mount.innerHTML = appbar({ title, back }) + `<div class="scroll pad stack-gap">
    <div class="card flat"><div class="row"><i data-lucide="circle-check" class="lead ok"></i><div class="body"><div class="title">Official timetable</div><div class="meta">${esc(t.message || 'Published by the school')}</div></div></div></div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;" id="tt-days">
      ${order.map(d => `<button class="chip ${d === cur ? 'on' : ''}" data-d="${d}">${DAYS[d].slice(0, 3)}${d === todayDow ? ' *' : ''}</button>`).join('')}
    </div>
    <div class="card"><div id="tt-body"></div></div></div>`;
  draw(cur);
  $$('#tt-days .chip', mount).forEach(b => b.addEventListener('click', () => {
    cur = Number(b.dataset.d);
    $$('#tt-days .chip', mount).forEach(x => x.classList.toggle('on', x === b));
    draw(cur);
  }));
}
/* ═══════════════════════════════════════════════════════════════════════
   PARENT APP — child selector + per-child views (reuses shared renderers)
   ═══════════════════════════════════════════════════════════════════════ */
const ParentApp = {
  ctx: { children:[], childId:null, assessment:'midterm' },

  async start(){
    Router.hideTabs();
    const s = Router._ensureTabScreen(); s.classList.add('active');
    s.innerHTML = loadingScroll();
    try {
      const d = await api.get('/api/parent/children');
      ParentApp.ctx.children = d.children || [];
      ParentApp.ctx.childId = ParentApp.ctx.children[0]?.id || null;
      const first = ParentApp.ctx.children[0];
      if (first) ParentApp.ctx.assessment = first.current_assessment || 'midterm';
    } catch(e){ if (e.auth) return doLogout(); }
    Router.setTabs([
      { id:'home',     label:'Home',      icon:'home',        render:m => ParentApp.home(m) },
      { id:'results',  label:'Results',   icon:'bar-chart-3', render:m => ParentApp.results(m) },
      { id:'timetable',label:'Timetable', icon:'calendar-days', render:m => ParentApp.timetable(m) },
      { id:'more',     label:'More',      icon:'ellipsis',     render:m => ParentApp.more(m) }
    ]);
  },

  child(){ return ParentApp.ctx.children.find(c => c.id === ParentApp.ctx.childId) || ParentApp.ctx.children[0] || null; },

  switcherHTML(){
    const cs = ParentApp.ctx.children;
    if (cs.length < 2) return '';
    return `<div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;" id="kid-switch">
      ${cs.map(c => `<button class="chip ${c.id === ParentApp.ctx.childId ? 'on' : ''}" data-id="${c.id}">
        ${esc(firstName(c.name))}</button>`).join('')}</div>`;
  },
  wireSwitcher(m){
    $$('#kid-switch .chip', m).forEach(b => b.addEventListener('click', () => {
      ParentApp.ctx.childId = Number(b.dataset.id); Router.go(Router.activeTab);
    }));
  },

  /* ── Home ── */
  async home(m){
    const parentName = state.me?.name || 'Parent';
    const cs = ParentApp.ctx.children;
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    if (!cs.length){
      m.innerHTML = appbar({ title:'Home' }) + `<div class="scroll">${emptyState('baby', 'No children linked', 'Ask the school office to link your child to your account.')}</div>`;
      return;
    }
    m.innerHTML = `
      <div class="hero">
        <div class="row-between"><div class="hero-eyebrow">Parent</div>
          <button class="appbar-btn" style="background:rgba(255,255,255,.16);color:#fff;box-shadow:none;" onclick="ParentApp.notifications()"><i data-lucide="bell"></i><span class="badge-dot js-unread-badge" hidden></span></button></div>
        <div class="hero-greet">${greet},<br><em>${esc(firstName(parentName))}.</em></div>
        <div class="hero-sub">${cs.length} child${cs.length === 1 ? '' : 'ren'} at ${esc(state.school?.school_name || 'school')}</div>
      </div>
      <div class="scroll pad"><div class="lift stack-gap">
        ${cs.map(c => ParentApp.childCard(c)).join('')}
      </div></div>`;
  },

  childCard(c){
    const att = c.attendance_summary;
    const [oc, , ol] = bandFor(c.overall_percent || 0);
    const has = c.overall_percent != null;
    return `<button class="card" style="width:100%;text-align:left;display:block;" onclick="ParentApp.openChild(${c.id})">
      <div class="row" style="border:none;padding:0;margin-bottom:14px;">
        <div class="ava ava-md lead" style="${c.portrait_path ? 'background:#fff;' : avaColor(c.name)}">
          ${c.portrait_path ? `<img src="${esc(c.portrait_path)}">` : initials(c.name)}</div>
        <div class="body"><div class="title">${esc(c.name)}</div>
          <div class="meta">${esc(c.class_name || '')} · Adm ${esc(c.admission_no || '—')}</div></div>
        <i data-lucide="chevron-right" class="chev"></i>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:10px 12px;">
          <div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Attendance</div>
          <div style="font-weight:800;font-size:var(--t-lg);">${att ? att.pct + '%' : '—'}</div></div>
        <div style="background:var(--surface-2);border-radius:var(--r-sm);padding:10px 12px;">
          <div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;">Average</div>
          <div style="display:flex;align-items:center;gap:8px;"><span style="font-weight:800;font-size:var(--t-lg);">${has ? pct(c.overall_percent) : '—'}</span>
            ${has ? `<span class="badge ${oc}">${ol[0]}${ol[1] || ''}</span>` : ''}</div></div>
      </div>
    </button>`;
  },

  openChild(id){ ParentApp.ctx.childId = id; Router.go('results'); },

  /* ── Results ── */
  async results(m){
    const c = ParentApp.child();
    if (!c){ m.innerHTML = appbar({ title:'Results' }) + `<div class="scroll">${emptyState('baby', 'No child selected', 'Link a child to view results.')}</div>`; return; }
    m.innerHTML = appbar({ title:'Results' }) + loadingScroll();
    let r;
    try { r = await api.get(`/api/parent/children/${c.id}/marks?assessment_type=${ParentApp.ctx.assessment}`); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'Results' }) + `<div class="scroll">${errorState(e.message, 'Router.go(\'results\')')}</div>`; return; }
    const scored = (r.subjects || []).filter(x => x.percent != null);
    m.innerHTML = appbar({ title:'Results' }) + `<div class="scroll pad stack-gap">
      ${ParentApp.switcherHTML()}
      <div class="muted" style="font-size:var(--t-sm);font-weight:600;">${esc(c.name)} · ${esc(c.class_name || '')}</div>
      <div class="seg" id="assess-seg">
        <button data-a="midterm" class="${r.assessment_type === 'midterm' ? 'on' : ''}">Midterm</button>
        <button data-a="endterm" class="${r.assessment_type === 'endterm' ? 'on' : ''}">End term</button>
      </div>
      ${resultsBodyHTML(r)}
      ${scored.length ? `<button class="btn ghost block" onclick="ParentApp.comments()"><i data-lucide="message-circle"></i> Teacher comments</button>` : ''}
    </div>`;
    ParentApp.wireSwitcher(m);
    $$('#assess-seg button', m).forEach(b => b.addEventListener('click', () => { ParentApp.ctx.assessment = b.dataset.a; Router.go('results'); }));
  },

  async comments(){
    const c = ParentApp.child(); if (!c) return;
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + loadingScroll();
      try {
        const d = await api.get(`/api/parent/children/${c.id}/comments?assessment_type=${ParentApp.ctx.assessment}`);
        const list = d.comments || [];
        s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + `<div class="scroll pad stack-gap">
          ${list.length ? list.map(x => `<div class="card"><div class="card-hd" style="margin-bottom:8px;"><h3>${esc(x.role_label)}</h3></div>
            <p style="font-size:var(--t-base);line-height:1.6;color:var(--ink-2);font-style:italic;">"${esc(x.text || 'No comment')}"</p></div>`).join('')
          : emptyState('message-circle-off', 'No comments yet', 'Comments appear after teachers complete the report.')}</div>`;
      } catch(e){ s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; }
    });
  },

  /* ── Timetable ── */
  async timetable(m){
    const c = ParentApp.child();
    if (!c){ m.innerHTML = appbar({ title:'Timetable' }) + `<div class="scroll">${emptyState('baby', 'No child selected', '')}</div>`; return; }
    m.innerHTML = appbar({ title:'Timetable' }) + loadingScroll();
    let t;
    try { t = await api.get('/api/parent/timetable?child_id=' + c.id); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'Timetable' }) + `<div class="scroll">${e.message && /not yet shared/i.test(e.message) ? emptyState('calendar-days', 'Not shared yet', 'The school has not shared the timetable with parents.') : errorState(e.message, 'Router.go(\'timetable\')')}</div>`; return; }
    mountTimetable(m, esc(firstName(c.name)) + "'s Timetable", t);
    // inject switcher above
    const sw = ParentApp.switcherHTML();
    if (sw){ const scroll = $('.scroll', m); scroll.insertAdjacentHTML('afterbegin', sw); ParentApp.wireSwitcher(m); }
  },

  notifications(){ renderNotificationsScreen(); },

  /* ── More ── */
  async more(m){
    const me = state.me || {};
    const school = state.school || {};
    const cs = ParentApp.ctx.children;
    m.innerHTML = appbar({ title:'More' }) + `<div class="scroll pad stack-gap">
      <div class="card" style="display:flex;align-items:center;gap:14px;">
        <div class="ava ava-lg lead" style="${avaColor(me.name)}">${initials(me.name)}</div>
        <div class="body"><div style="font-weight:800;font-size:var(--t-lg);">${esc(me.name || 'Parent')}</div>
          <div class="muted" style="font-size:var(--t-sm);">${esc(me.user_id || '')} · Parent</div></div>
      </div>
      <div class="card"><div class="card-hd"><h3>My children</h3></div><div class="rows">
        ${cs.map(c => `<div class="row"><div class="ava ava-sm lead" style="${avaColor(c.name)}">${initials(c.name)}</div>
          <div class="body"><div class="title">${esc(c.name)}</div><div class="meta">${esc(c.class_name || '')}</div></div></div>`).join('') || '<div class="muted" style="font-size:var(--t-sm);padding:6px 2px;">No children linked.</div>'}
      </div></div>
      <div class="card" style="padding:6px 16px;"><div class="rows">
        ${moreRow('info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('log-out', 'Sign out', "doLogout()", 'var(--danger)')}
      </div></div>
      <div class="center muted" style="font-size:var(--t-xs);">${esc(school.school_name || 'Daraja')} · v3.0</div>
    </div>`;
  }
};
/* ═══════════════════════════════════════════════════════════════════════
   TEACHER APP — "command center": Today · Classes · Gradebook · More
   ═══════════════════════════════════════════════════════════════════════ */
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function tmin(t){ if (t == null) return null; const p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1] || 0); }
function tlabel(t){ if (!t) return ''; const [h, mi] = String(t).split(':').map(Number); const ap = h < 12 ? 'am' : 'pm'; const hh = h % 12 || 12; return hh + ':' + String(mi || 0).padStart(2, '0') + ap; }

const TeacherApp = {
  _ctx: { assessment:'midterm', termId:null },

  start(){
    Router.setTabs([
      { id:'today',     label:'Today',     icon:'zap',           render:m => TeacherApp.today(m) },
      { id:'classes',   label:'Classes',   icon:'users', render:m => TeacherApp.classes(m) },
      { id:'gradebook', label:'Gradebook', icon:'grid-3x3',    render:m => TeacherApp.gradebook(m) },
      { id:'more',      label:'More',      icon:'ellipsis',       render:m => TeacherApp.more(m) }
    ]);
  },

  thead(ctxLine, title){
    const me = state.me || {};
    return `<div class="tbar"><div class="top">
        <div><div class="ctx">${esc(ctxLine)}</div><h1>${esc(title)}</h1></div>
        <button class="bell" onclick="TeacherApp.notifications()"><i data-lucide="bell"></i><span class="dot js-unread-badge" hidden></span></button>
      </div><div id="thead-extra"></div></div>`;
  },

  /* ════ TODAY ════ */
  async today(m){
    m.innerHTML = `<div class="tbar"><div class="top"><div><div class="ctx skel" style="width:120px;height:12px;"></div><div class="skel" style="width:170px;height:22px;margin-top:8px;"></div></div></div></div>${loadingScroll()}`;
    const todayISO = new Date().toISOString().slice(0, 10);
    let home, tt, ov, analytics;
    try {
      [home, tt, ov, analytics] = await Promise.all([
        api.get('/api/teacher/home'),
        api.get('/api/teacher/timetable').catch(() => ({ slots:[], periods:[] })),
        api.get('/api/teacher/attendance/overview?date=' + todayISO).catch(() => ({ classes:[] })),
        api.get('/api/teacher/teaching-analytics').catch(() => ({ subjects:[] }))
      ]);
    } catch(e){ if (e.auth) return doLogout(); m.innerHTML = TeacherApp.thead('Today', 'Daraja') + `<div class="scroll">${errorState(e.message, 'Router.go(\'today\')')}</div>`; return; }
    if (home.empty){ m.innerHTML = TeacherApp.thead('Today', 'Daraja') + `<div class="scroll">${emptyState('school', 'No classes yet', home.message || 'No classes assigned to you.')}</div>`; return; }

    const ctx = home.context || {};
    TeacherApp._ctx = { assessment: analytics.current_assessment || ctx.assessment || 'midterm', termId: (analytics.current_term || ctx.term || {}).id || null };
    const now = new Date();
    const dateLine = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
    const weekStr = ctx.calendar?.week_no ? `Week ${ctx.calendar.week_no}` : '';
    // Header describes where we are in time → use the calendar term (matches week_no and the
    // Gradebook). ctx.term is the data-fallback window (last term with marks) and can differ.
    const ctxLine = [dateLine, weekStr, ctx.calendar?.term_name || ctx.term?.name].filter(Boolean).join(' · ');

    // today's lessons
    const dow = now.getDay();
    const periods = tt.periods || [];
    const pById = {}; periods.forEach(p => { pById[Number(p.period_no)] = p; });
    const todaySlots = (tt.slots || []).filter(s => Number(s.day_of_week) === dow)
      .map(s => { const p = pById[Number(s.period_no)] || {}; return { ...s, start:p.start_time || p.start, end:p.end_time || p.end }; })
      .sort((a, b) => (tmin(a.start) ?? a.period_no * 100) - (tmin(b.start) ?? b.period_no * 100));
    const nowMin = now.getHours() * 60 + now.getMinutes();
    let nowSlot = null, nextSlot = null;
    todaySlots.forEach(s => {
      const st = tmin(s.start), en = tmin(s.end);
      if (st != null && en != null && nowMin >= st && nowMin < en) nowSlot = s;
    });
    nextSlot = todaySlots.find(s => { const st = tmin(s.start); return st != null && st > nowMin; }) || null;

    // work queue
    const queue = [];
    (ov.classes || []).filter(c => !c.marked).forEach(c => queue.push({ ic:'user-check', title:`Mark ${c.name} attendance`, meta:`${c.learner_count} learners · today`, onclick:`TeacherApp.roll(${c.id},'${esc(c.name)}','${todayISO}')` }));
    (analytics.subjects || []).forEach(sj => {
      if (sj.components_configured && sj.learners_marked < (sj.enrollment_count || 0)) {
        queue.push({ ic:'pencil', title:`${sj.subject_name} · ${sj.class_name} marks`, meta:`${sj.learners_marked}/${sj.enrollment_count} entered`, onclick:`TeacherApp.marksGrid(${sj.class_id},${sj.subject_id},'${esc(sj.class_name)}','${esc(sj.subject_name)}')` });
      }
    });

    m.innerHTML = TeacherApp.thead(ctxLine, 'Good ' + (now.getHours() < 12 ? 'morning' : now.getHours() < 17 ? 'afternoon' : 'evening') + ', ' + esc(firstName(state.me?.name) || 'Teacher'))
      .replace('<div id="thead-extra"></div>', `<div class="nownext">
        <div class="nn is-now"><div class="k">NOW</div>
          <div class="v">${nowSlot ? esc(nowSlot.subject_name) : 'Free'}</div>
          <div class="m">${nowSlot ? esc(nowSlot.class_name) + ' · ' + tlabel(nowSlot.start) : 'No lesson now'}</div></div>
        <div class="nn is-next"><div class="k">NEXT</div>
          <div class="v">${nextSlot ? esc(nextSlot.subject_name) : '—'}</div>
          <div class="m">${nextSlot ? esc(nextSlot.class_name) + ' · ' + tlabel(nextSlot.start) : 'Nothing later today'}</div></div>
      </div>`)
      + `<div class="scroll pad stack-gap">
        ${queue.length ? `<div class="section-label">Work queue · ${queue.length}</div>
          <div class="stack-gap" style="gap:8px;">${queue.slice(0, 6).map(q => `
            <button class="queue-item" onclick="${q.onclick}"><span class="qic"><i data-lucide="${q.ic}"></i></span>
              <div class="body"><div class="title">${q.title}</div><div class="meta">${q.meta}</div></div>
              <i data-lucide="chevron-right" class="chev"></i></button>`).join('')}</div>`
          : `<div class="queue-item ok"><span class="qic"><i data-lucide="check"></i></span><div class="body"><div class="title">All caught up</div><div class="meta">No attendance or marks pending right now.</div></div></div>`}

        <div class="section-label">Today's lessons</div>
        ${todaySlots.length ? `<div class="card">${todaySlots.map(s => `
          <div class="tl-item ${s === nowSlot ? 'now' : ''}"><div class="tl-time">${s.start ? tlabel(s.start) : 'P' + s.period_no}</div>
            <div class="tl-body"><div class="tl-card"><div class="s">${esc(s.subject_name)}</div><div class="c">${esc(s.class_name)}${s.is_substitution ? ' · cover' : ''}</div></div></div></div>`).join('')}</div>`
          : (dow === 0 || dow === 6) ? emptyState('coffee', 'Weekend', 'No lessons scheduled today.') : emptyState('calendar-days', 'No lessons today', 'Nothing on your timetable for today.')}
      </div>`;
  },

  /* ════ CLASSES ════ */
  async classes(m){
    m.innerHTML = TeacherApp.thead('Your classes', 'Classes') + loadingScroll();
    let teach, ov;
    try { [teach, ov] = await Promise.all([api.get('/api/teacher/teaching'), api.get('/api/teacher/attendance/overview?date=' + new Date().toISOString().slice(0, 10)).catch(() => ({ classes:[] }))]); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = TeacherApp.thead('Your classes', 'Classes') + `<div class="scroll">${errorState(e.message, 'Router.go(\'classes\')')}</div>`; return; }
    TeacherApp._ctx.assessment = teach.current_assessment || TeacherApp._ctx.assessment;
    TeacherApp._ctx.termId = teach.current_term?.id || TeacherApp._ctx.termId;
    const homerooms = new Set((ov.classes || []).map(c => c.id));
    // distinct classes from teaching, mark homeroom
    const seen = {}; const list = [];
    (teach.teaching || []).forEach(t => {
      if (!seen[t.class_id]){ seen[t.class_id] = { id:t.class_id, name:t.class_name, count:t.enrollment_count, subjects:[], homeroom:homerooms.has(t.class_id) }; list.push(seen[t.class_id]); }
      seen[t.class_id].subjects.push({ id:t.subject_id, name:t.subject_name });
    });
    (ov.classes || []).forEach(c => { if (!seen[c.id]){ seen[c.id] = { id:c.id, name:c.name, count:c.learner_count, subjects:[], homeroom:true }; list.push(seen[c.id]); } });

    m.innerHTML = TeacherApp.thead('Your classes', 'Classes') + `<div class="scroll pad stack-gap">
      ${list.length ? list.map(c => `<button class="card" style="width:100%;text-align:left;display:block;" onclick="TeacherApp.classDetail(${c.id},'${esc(c.name)}',${c.homeroom},${c.subjects[0] ? c.subjects[0].id : 'null'})">
        <div class="row" style="border:none;padding:0;">
          <div class="ava ava-md lead" style="${avaColor(c.name)}">${esc(c.name.replace(/[^0-9]/g, '') || initials(c.name))}</div>
          <div class="body"><div class="title">${esc(c.name)} ${c.homeroom ? '<span class="badge ok" style="margin-left:4px;">Class teacher</span>' : ''}</div>
            <div class="meta">${num(c.count)} learners${c.subjects.length ? ' · ' + c.subjects.map(s => esc(s.name)).join(', ') : ''}</div></div>
          <i data-lucide="chevron-right" class="chev"></i></div></button>`).join('')
        : emptyState('users', 'No classes', 'You have no classes assigned.')}
    </div>`;
  },

  async _roster(classId, subjectId){
    try { const r = await api.get('/api/teacher/classes/' + classId + '/learners'); if (r.learners) return r.learners; } catch(e){}
    if (subjectId){ try { const mk = await api.get(`/api/teacher/marks?class_id=${classId}&subject_id=${subjectId}&assessment_type=${TeacherApp._ctx.assessment}`); if (Array.isArray(mk.learners)) return mk.learners; } catch(e){} }
    return null;
  },

  classDetail(classId, className, homeroom, subjectId){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:className, back:true }) + loadingScroll();
      const roster = await TeacherApp._roster(classId, subjectId);
      const actions = homeroom ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:4px;">
          <button class="btn ghost sm" onclick="TeacherApp.roll(${classId},'${esc(className)}','${new Date().toISOString().slice(0, 10)}')"><i data-lucide="user-check"></i> Attendance</button>
          <button class="btn ghost sm" onclick="TeacherApp.rateSkills(${classId},'${esc(className)}')"><i data-lucide="star"></i> Skills</button>
          <button class="btn ghost sm" onclick="TeacherApp.writeComments(${classId},'${esc(className)}')"><i data-lucide="message-circle"></i> Comments</button>
          <button class="btn ghost sm" onclick="TeacherApp.classReport(${classId},'${esc(className)}')"><i data-lucide="file-text"></i> Reports</button>
        </div>` : '';
      s.innerHTML = appbar({ title:className, back:true }) + `<div class="scroll pad stack-gap">
        ${actions}
        <div class="section-label">${roster ? roster.length + ' learners' : 'Learners'}</div>
        ${roster && roster.length ? `<div class="stud-grid">${roster.map(l => `
          <button class="stud" onclick="TeacherApp.studentProfile(${classId},'${esc(className)}',${l.id},'${esc(l.name)}','${esc(l.admission_no || '')}',${homeroom})">
            <div class="ava ava-md" style="${avaColor(l.name)}">${initials(l.name)}</div>
            <div class="nm">${esc(l.name)}</div></button>`).join('')}</div>`
          : emptyState('users', 'Roster unavailable', homeroom ? 'No active learners in this class.' : 'The class roster is managed by the class teacher.')}
      </div>`;
    });
  },

  studentProfile(classId, className, learnerId, name, adm, homeroom){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:name, back:true }) + loadingScroll();
      const head = `<div class="card" style="display:flex;align-items:center;gap:14px;">
        <div class="ava ava-lg lead" style="${avaColor(name)}">${initials(name)}</div>
        <div class="body"><div style="font-weight:800;font-size:var(--t-lg);">${esc(name)}</div>
          <div class="muted" style="font-size:var(--t-sm);">${esc(className)} · Adm ${esc(adm || '—')}</div></div></div>`;
      if (!homeroom){
        s.innerHTML = appbar({ title:name, back:true }) + `<div class="scroll pad stack-gap">${head}
          ${emptyState('lock', 'Class-teacher view', 'Full performance, skills and comments for a learner are available to their class teacher.')}</div>`;
        return;
      }
      const a = TeacherApp._ctx.assessment;
      let bs, comments, skills, skillsCfg;
      try { [bs, comments, skills, skillsCfg] = await Promise.all([
        api.get('/api/teacher/broadsheet?class_id=' + classId).catch(() => null),
        api.get(`/api/teacher/comments?class_id=${classId}&assessment_type=${a}`).catch(() => null),
        api.get(`/api/teacher/skills?class_id=${classId}&assessment_type=${a}`).catch(() => null),
        api.get(`/api/teacher/skills/config?class_id=${classId}&assessment_type=${a}`).catch(() => null)
      ]); } catch(e){}
      const row = bs ? (bs.learners || []).find(r => r.id === learnerId) : null;
      const subjects = bs ? bs.subjects || [] : [];
      const comment = comments ? (comments.entries || {})[learnerId] || '' : '';
      const sk = skills ? (skills.entries || {})[learnerId] || {} : {};

      let perfHTML = emptyState('bar-chart-3', 'No marks yet', 'No marks recorded for this learner this term.');
      if (row && row.subject_count > 0){
        const [oc, , ol] = bandFor(row.average || 0);
        perfHTML = `<div class="card"><div class="card-hd"><h3>Performance</h3>
            <span class="badge ${oc}">${row.average == null ? '—' : Number(row.average).toFixed(1) + '% · ' + ol}</span></div>
          <div class="rows">${subjects.map((sub, i) => { const v = row.subjects?.[i]?.average; const [c, ab] = bandFor(v || 0);
            return `<div class="row"><div class="body title" style="font-weight:500;">${esc(sub.name)}</div>
              <div class="trail">${v == null ? '<span class="muted">—</span>' : `<span class="mono" style="font-weight:700;">${Math.round(v)}%</span><span class="badge ${c}">${ab}</span>`}</div></div>`; }).join('')}</div>
          ${row.position ? `<div class="muted center" style="font-size:var(--t-sm);margin-top:10px;">Class position <b style="color:var(--ink);">${row.position}</b></div>` : ''}</div>`;
      }

      const cats = skillsCfg ? skillsCfg.categories || [] : [];
      const skillsHTML = cats.length ? `<div class="card"><div class="card-hd"><h3>Skills</h3>
          <a class="link" onclick="TeacherApp.rateSkills(${classId},'${esc(className)}')">Rate</a></div>
        ${cats.map(cat => `<div style="margin-bottom:10px;"><div class="muted" style="font-size:var(--t-xs);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">${esc(cat.label)}</div>
          <div class="rows">${cat.items.map(it => { const rv = sk[cat.key]?.[it.key];
            return `<div class="row" style="padding:6px 2px;"><div class="body title" style="font-weight:500;font-size:var(--t-sm);">${esc(it.label)}</div>
              <div class="trail">${rv ? '<span class="mono" style="font-weight:700;color:var(--brand-600);">' + rv + '/' + (skillsCfg.ratings?.[0] || 5) + '</span>' : '<span class="muted">—</span>'}</div></div>`; }).join('')}</div></div>`).join('')}</div>` : '';

      s.innerHTML = appbar({ title:name, back:true }) + `<div class="scroll pad stack-gap">
        ${head}${perfHTML}${skillsHTML}
        <div class="card"><div class="card-hd"><h3>Class teacher comment</h3></div>
          <textarea class="input" id="sp-comment" placeholder="Write a comment for ${esc(firstName(name))}…" maxlength="1000">${esc(comment)}</textarea>
          <button class="btn primary block mt3" id="sp-save"><i data-lucide="save"></i> Save comment</button></div>
      </div>`;
      $('#sp-save', s).addEventListener('click', async () => {
        const btn = $('#sp-save', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        try {
          await api.post('/api/teacher/comments', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:[{ learner_id:learnerId, comment_text:$('#sp-comment', s).value }] });
          UI.toast('Comment saved', 'ok'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save comment';
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save comment'; }
      });
    });
  },

  /* ── Skills rating (class teacher) ── */
  rateSkills(classId, className){
    const a = TeacherApp._ctx.assessment;
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Skills · ' + className, back:true }) + loadingScroll();
      let cfg, skills, roster;
      try { [cfg, skills, roster] = await Promise.all([
        api.get(`/api/teacher/skills/config?class_id=${classId}&assessment_type=${a}`),
        api.get(`/api/teacher/skills?class_id=${classId}&assessment_type=${a}`),
        TeacherApp._roster(classId, null)
      ]); } catch(e){ s.innerHTML = appbar({ title:'Skills', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const cats = cfg.categories || []; const ratings = cfg.ratings || [5,4,3,2,1];
      const entries = skills.entries || {};
      const items = cats.flatMap(c => c.items.map(it => ({ catKey:c.key, catLabel:c.label, itemKey:it.key, itemLabel:it.label })));
      const sel = {}; (roster || []).forEach(l => { items.forEach(it => { sel[l.id + '|' + it.catKey + '|' + it.itemKey] = entries[l.id]?.[it.catKey]?.[it.itemKey] ?? null; }); });
      TeacherApp._skillSel = sel;
      s.innerHTML = appbar({ title:'Skills · ' + className, back:true }) + `<div class="scroll pad" style="padding-bottom:88px;">
        <div class="muted" style="font-size:var(--t-sm);margin-bottom:12px;">Tap a rating for each learner. ${ratings[0]} = best.</div>
        ${(roster || []).map(l => `<div class="card" style="margin-bottom:12px;"><div class="row" style="border:none;padding:0 0 8px;">
          <div class="ava ava-sm lead" style="${avaColor(l.name)}">${initials(l.name)}</div>
          <div class="body title">${esc(l.name)}</div></div>
          ${items.map(it => `<div style="margin-bottom:8px;"><div class="muted" style="font-size:var(--t-xs);margin-bottom:4px;">${esc(it.itemLabel)}</div>
            <div class="rate-row" data-key="${l.id}|${it.catKey}|${it.itemKey}">
              ${ratings.map(r => `<button data-r="${r}" class="${sel[l.id + '|' + it.catKey + '|' + it.itemKey] == r ? 'on' : ''}">${r}</button>`).join('')}
            </div></div>`).join('')}</div>`).join('') || emptyState('users', 'No learners', '')}
      </div>
      <button class="btn primary" id="sk-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i data-lucide="save"></i> Save skills</button>`;
      $$('.rate-row', s).forEach(rr => rr.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-r]'); if (!b) return;
        TeacherApp._skillSel[rr.dataset.key] = Number(b.dataset.r);
        $$('button', rr).forEach(x => x.classList.toggle('on', x === b));
      }));
      $('#sk-save', s).addEventListener('click', async () => {
        const btn = $('#sk-save', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        const ent = Object.entries(TeacherApp._skillSel).filter(([, v]) => v != null).map(([k, v]) => { const [lid, ck, ik] = k.split('|'); return { learner_id:Number(lid), category_key:ck, item_key:ik, rating:v }; });
        try { await api.post('/api/teacher/skills', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:ent }); UI.toast('Skills saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save skills'; }
      });
    });
  },

  /* ── Comments (class teacher) with suggestion bank ── */
  writeComments(classId, className){
    const a = TeacherApp._ctx.assessment;
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Comments · ' + className, back:true }) + loadingScroll();
      let cm, sug, roster, bs;
      try { [cm, sug, roster, bs] = await Promise.all([
        api.get(`/api/teacher/comments?class_id=${classId}&assessment_type=${a}`),
        api.get('/api/teacher/comments/suggestions').catch(() => ({ bands:[] })),
        TeacherApp._roster(classId, null),
        api.get('/api/teacher/broadsheet?class_id=' + classId).catch(() => null)
      ]); } catch(e){ s.innerHTML = appbar({ title:'Comments', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const entries = cm.entries || {};
      const bands = sug.bands || [];
      const avgBy = {}; if (bs) (bs.learners || []).forEach(r => { avgBy[r.id] = r.average; });
      TeacherApp._sugBands = bands; TeacherApp._avgBy = avgBy;
      s.innerHTML = appbar({ title:'Comments · ' + className, back:true }) + `<div class="scroll pad" style="padding-bottom:88px;">
        <div class="muted" style="font-size:var(--t-sm);margin-bottom:12px;">Class-teacher remark for each learner. Tap <i data-lucide="wand-sparkles"></i> to suggest from the bank.</div>
        ${(roster || []).map(l => `<div class="card" style="margin-bottom:12px;"><div class="row" style="border:none;padding:0 0 8px;">
          <div class="ava ava-sm lead" style="${avaColor(l.name)}">${initials(l.name)}</div>
          <div class="body title">${esc(l.name)}</div>
          ${bands.length ? `<button class="appbar-btn" style="width:34px;height:34px;font-size:13px;" onclick="TeacherApp.suggestComment(${l.id})"><i data-lucide="wand-sparkles"></i></button>` : ''}</div>
          <textarea class="input cm-in" data-lid="${l.id}" maxlength="1000" placeholder="Comment…">${esc(entries[l.id] || '')}</textarea></div>`).join('') || emptyState('users', 'No learners', '')}
      </div>
      <button class="btn primary" id="cm-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i data-lucide="save"></i> Save comments</button>`;
      $('#cm-save', s).addEventListener('click', async () => {
        const btn = $('#cm-save', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        const ent = $$('.cm-in', s).map(t => ({ learner_id:Number(t.dataset.lid), comment_text:t.value }));
        try { await api.post('/api/teacher/comments', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:ent }); UI.toast('Comments saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save comments'; }
      });
    });
  },
  suggestComment(lid){
    const s = Router.stack[Router.stack.length - 1]; if (!s) return;
    const avg = TeacherApp._avgBy[lid];
    const band = (TeacherApp._sugBands || []).find(b => avg != null && avg <= b.max_score && avg >= b.min_score) || (TeacherApp._sugBands || [])[0];
    if (!band){ UI.toast('No suggestions available', 'warn'); return; }
    const ta = $(`.cm-in[data-lid="${lid}"]`, s); if (ta){ ta.value = band.comment_text; ta.focus(); }
  },

  /* ════ GRADEBOOK ════ */
  async gradebook(m){
    m.innerHTML = TeacherApp.thead('Marks & analytics', 'Gradebook') + loadingScroll();
    let an;
    try { an = await api.get('/api/teacher/teaching-analytics?assessment_type=' + TeacherApp._ctx.assessment); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = TeacherApp.thead('Marks & analytics', 'Gradebook') + `<div class="scroll">${errorState(e.message, 'Router.go(\'gradebook\')')}</div>`; return; }
    if (an.current_assessment) TeacherApp._ctx.assessment = an.current_assessment;
    if (an.current_term) TeacherApp._ctx.termId = an.current_term.id;
    const subs = an.subjects || [];
    m.innerHTML = TeacherApp.thead((an.current_term?.name || '') + ' · ' + (an.current_assessment === 'endterm' ? 'End term' : 'Midterm'), 'Gradebook')
      .replace('<div id="thead-extra"></div>', '')
      + `<div class="scroll pad stack-gap">
      ${subs.length ? subs.map(sj => {
        const marked = sj.enrollment_count ? Math.round((sj.learners_marked / sj.enrollment_count) * 100) : 0;
        const [bc] = bandFor(sj.mean_percent || 0);
        return `<button class="card" style="width:100%;text-align:left;display:block;" onclick="TeacherApp.subjectDetail(${sj.class_id},${sj.subject_id},'${esc(sj.class_name)}','${esc(sj.subject_name)}')">
          <div class="row-between" style="margin-bottom:10px;"><div><div class="title" style="font-weight:700;">${esc(sj.subject_name)}</div>
            <div class="meta muted" style="font-size:var(--t-sm);">${esc(sj.class_name)}</div></div>
            <div class="center">${sj.mean_percent != null ? `<span class="badge ${bc}" style="font-size:var(--t-sm);">${pct(sj.mean_percent)}</span>` : '<span class="muted" style="font-size:var(--t-sm);">no marks</span>'}</div></div>
          <div class="bar"><span style="width:${marked}%;"></span></div>
          <div class="muted" style="font-size:var(--t-xs);margin-top:6px;">${sj.learners_marked}/${num(sj.enrollment_count)} learners entered${sj.components_configured ? '' : ' · components not set up'}</div>
        </button>`;
      }).join('') : emptyState('grid-3x3', 'No subjects', 'You have no subjects to grade.')}
    </div>`;
  },

  subjectDetail(classId, subjectId, className, subjectName){
    const a = TeacherApp._ctx.assessment;
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:subjectName, back:true }) + loadingScroll();
      let comps, marks;
      const q = `class_id=${classId}&subject_id=${subjectId}&assessment_type=${a}`;
      try { [comps, marks] = await Promise.all([api.get('/api/teacher/assessment-components?' + q), api.get('/api/teacher/marks?' + q)]); }
      catch(e){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const components = comps.components || [];
      const maxTotal = components.reduce((sum, c) => sum + Number(c.max_score || 0), 0);
      const entries = marks.entries || {};
      // compute percents + distribution
      const percents = [];
      Object.values(entries).forEach(byKey => {
        const tot = components.reduce((sum, c) => sum + (byKey[c.component_key] != null ? Number(byKey[c.component_key]) : 0), 0);
        const any = components.some(c => byKey[c.component_key] != null);
        if (any && maxTotal) percents.push((tot / maxTotal) * 100);
      });
      const dist = { ee:0, me:0, ae:0, be:0 };
      percents.forEach(p => { dist[bandFor(p)[0]]++; });
      const n = percents.length || 1;
      const mean = percents.length ? percents.reduce((x, y) => x + y, 0) / percents.length : null;
      const sorted = [...percents].sort((x, y) => y - x);
      s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll pad stack-gap">
        <div class="card"><div class="row-between"><div><div class="muted" style="font-size:var(--t-xs);text-transform:uppercase;letter-spacing:.05em;">${esc(className)} · class mean</div>
          <div style="font-size:var(--t-2xl);font-weight:800;letter-spacing:-.02em;">${mean == null ? '—' : pct(mean)}</div></div>
          <div class="center"><div class="muted" style="font-size:var(--t-xs);">marked</div><div style="font-weight:700;font-size:var(--t-lg);">${percents.length}</div></div></div>
          ${percents.length ? `<div class="dist-bar"><span class="ee" style="width:${dist.ee / n * 100}%"></span><span class="me" style="width:${dist.me / n * 100}%"></span><span class="ae" style="width:${dist.ae / n * 100}%"></span><span class="be" style="width:${dist.be / n * 100}%"></span></div>
          <div class="dist-legend"><span><i style="background:var(--ee)"></i>EE ${dist.ee}</span><span><i style="background:var(--me)"></i>ME ${dist.me}</span><span><i style="background:var(--ae)"></i>AE ${dist.ae}</span><span><i style="background:var(--be)"></i>BE ${dist.be}</span></div>` : ''}</div>
        ${percents.length ? `<div class="card" style="display:flex;gap:10px;text-align:center;">
          <div style="flex:1;"><div class="muted" style="font-size:var(--t-xs);">Highest</div><div style="font-weight:800;font-size:var(--t-lg);color:var(--brand-600);">${pct(sorted[0])}</div></div>
          <div style="flex:1;border-left:1px solid var(--line);border-right:1px solid var(--line);"><div class="muted" style="font-size:var(--t-xs);">Lowest</div><div style="font-weight:800;font-size:var(--t-lg);color:var(--danger);">${pct(sorted[sorted.length - 1])}</div></div>
          <div style="flex:1;"><div class="muted" style="font-size:var(--t-xs);">At risk</div><div style="font-weight:800;font-size:var(--t-lg);">${dist.be + dist.ae}</div></div></div>` : ''}
        <button class="btn primary block" onclick="TeacherApp.marksGrid(${classId},${subjectId},'${esc(className)}','${esc(subjectName)}')"><i data-lucide="square-pen"></i> ${percents.length ? 'Edit' : 'Enter'} marks</button>
      </div>`;
    });
  },

  /* ── Marks grid (entry) ── */
  marksGrid(classId, subjectId, className, subjectName){
    const assessment = TeacherApp._ctx.assessment || 'midterm';
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:subjectName, back:true }) + loadingScroll();
      let comps, marks;
      const q = `class_id=${classId}&subject_id=${subjectId}&assessment_type=${assessment}`;
      try { [comps, marks] = await Promise.all([api.get('/api/teacher/assessment-components?' + q), api.get('/api/teacher/marks?' + q)]); }
      catch(e){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const components = comps.components || [];
      const entries = marks.entries || {};
      const termId = marks.term?.id || TeacherApp._ctx.termId;
      if (!components.length){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${emptyState('sliders-horizontal', 'No components set up', 'Ask the admin to configure assessment components for this subject before entering marks.')}</div>`; return; }
      let list = Array.isArray(marks.learners) ? marks.learners : null;
      if (!list){ try { list = (await api.get('/api/teacher/classes/' + classId + '/learners')).learners; } catch(e){ list = null; } }
      if (!list){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${emptyState('shield-check', 'Roster unavailable', 'The class roster needs a backend update for subject teachers.')}</div>`; return; }
      const colW = components.length > 2 ? 64 : 84;
      s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll pad" style="padding-bottom:90px;">
        <div class="seg" id="mk-assess" style="margin-bottom:14px;">
          <button data-a="midterm" class="${assessment === 'midterm' ? 'on' : ''}">Midterm</button>
          <button data-a="endterm" class="${assessment === 'endterm' ? 'on' : ''}">End term</button></div>
        <div class="muted" style="font-size:var(--t-sm);margin-bottom:10px;">${esc(className)} · ${list.length} learners</div>
        <div class="card" style="padding:10px 12px;overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:var(--t-sm);min-width:${180 + components.length * (colW + 8)}px;">
            <thead><tr><th style="text-align:left;padding:6px 4px;font-size:var(--t-xs);color:var(--ink-3);text-transform:uppercase;">Learner</th>
              ${components.map(c => `<th style="padding:6px 2px;font-size:10px;color:var(--ink-3);text-align:center;">${esc(c.component_name)}<br><span class="muted" style="font-weight:400;">/${num(c.max_score)}</span></th>`).join('')}</tr></thead>
            <tbody>${list.map(l => `<tr style="border-top:1px solid var(--line-2);">
              <td style="padding:8px 4px;font-weight:600;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(l.name)}</td>
              ${components.map(c => `<td style="padding:5px 2px;text-align:center;"><input class="mk-in" data-lid="${l.id}" data-key="${esc(c.component_key)}" data-max="${c.max_score}" inputmode="numeric"
                value="${entries[l.id]?.[c.component_key] != null ? entries[l.id][c.component_key] : ''}"
                style="width:${colW}px;height:40px;text-align:center;border:1.5px solid var(--line);border-radius:10px;font-size:var(--t-md);font-weight:600;background:var(--surface);"></td>`).join('')}
            </tr>`).join('')}</tbody></table></div></div>
        <button class="btn primary" id="mk-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i data-lucide="save"></i> Save marks</button>`;
      $$('#mk-assess button', s).forEach(b => b.addEventListener('click', () => { TeacherApp._ctx.assessment = b.dataset.a; Router.pop(); TeacherApp.marksGrid(classId, subjectId, className, subjectName); }));
      $$('.mk-in', s).forEach(inp => inp.addEventListener('input', () => { const max = Number(inp.dataset.max); if (inp.value !== '' && Number(inp.value) > max) inp.value = max; if (Number(inp.value) < 0) inp.value = 0; }));
      $('#mk-save', s).addEventListener('click', async () => {
        const btn = $('#mk-save', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        const ent = $$('.mk-in', s).map(inp => ({ learner_id:Number(inp.dataset.lid), component_key:inp.dataset.key, score:inp.value === '' ? '' : Number(inp.value) }));
        try { await api.post('/api/teacher/marks', { class_id:classId, subject_id:subjectId, assessment_type:TeacherApp._ctx.assessment, term_id:termId, entries:ent }); UI.toast('Marks saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save marks'; }
      });
    });
  },

  /* ── Attendance roll (reached from Today queue & class detail) ── */
  async roll(classId, className, date){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Mark · ' + className, back:true }) + loadingScroll();
      let learners, att;
      try {
        [learners, att] = await Promise.all([
          api.get('/api/teacher/classes/' + classId + '/learners'),
          api.get('/api/teacher/attendance?class_id=' + classId + '&date=' + date)
        ]);
      } catch(e){ s.innerHTML = appbar({ title:'Mark · ' + className, back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const list = learners.learners || [];
      const entries = att.entries || {};
      const sel = {}; list.forEach(l => { sel[l.id] = entries[l.id]?.status || 'P'; });
      TeacherApp._roll = { classId, date, sel };
      const drawCounts = () => {
        const vals = Object.values(TeacherApp._roll.sel);
        $('#roll-counts', s).textContent = `${vals.filter(v => v === 'P').length} present · ${vals.filter(v => v === 'A').length} absent · ${vals.filter(v => v === 'L').length} late`;
      };
      s.innerHTML = appbar({ title:className, back:true, action:`<button class="appbar-btn" onclick="TeacherApp.markAll('P')" title="All present"><i data-lucide="check-check"></i></button>` })
        + `<div class="scroll pad" style="padding-bottom:90px;">
          <div class="muted center" id="roll-counts" style="font-size:var(--t-sm);margin-bottom:12px;"></div>
          <div class="card" style="padding:6px 12px;"><div class="rows" id="roll-rows">
            ${list.map(l => `<div class="row" data-lid="${l.id}">
              <div class="ava ava-sm lead" style="${avaColor(l.name)}">${initials(l.name)}</div>
              <div class="body"><div class="title">${esc(l.name)}</div><div class="meta">${esc(l.admission_no || '')}</div></div>
              <div class="seg" style="width:150px;flex-shrink:0;" data-roll="${l.id}">
                ${['P','A','L'].map(k => `<button data-s="${k}" class="${sel[l.id] === k ? 'on' : ''}">${k}</button>`).join('')}
              </div></div>`).join('') || '<div class="muted pad">No learners.</div>'}
          </div></div></div>
          <button class="btn primary" id="roll-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i data-lucide="save"></i> Save attendance</button>`;
      drawCounts();
      $$('#roll-rows .seg', s).forEach(seg => seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-s]'); if (!btn) return;
        const lid = seg.dataset.roll;
        TeacherApp._roll.sel[lid] = btn.dataset.s;
        $$('button', seg).forEach(b => b.classList.toggle('on', b === btn));
        drawCounts();
      }));
      $('#roll-save', s).addEventListener('click', async () => {
        const btn = $('#roll-save', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        try {
          const payload = { class_id: classId, date, entries: Object.entries(TeacherApp._roll.sel).map(([learner_id, status]) => ({ learner_id: Number(learner_id), status })) };
          await api.post('/api/teacher/attendance', payload);
          UI.toast('Attendance saved', 'ok'); Router.pop(); Router.go('today');
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="save"></i> Save attendance'; }
      });
    });
  },
  markAll(status){
    if (!TeacherApp._roll) return;
    Object.keys(TeacherApp._roll.sel).forEach(k => { TeacherApp._roll.sel[k] = status; });
    const s = Router.stack[Router.stack.length - 1]; if (!s) return;
    $$('#roll-rows .seg', s).forEach(seg => $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.s === status)));
    const vals = Object.values(TeacherApp._roll.sel);
    $('#roll-counts', s).textContent = `${vals.filter(v => v === 'P').length} present · ${vals.filter(v => v === 'A').length} absent · ${vals.filter(v => v === 'L').length} late`;
  },

  classReport(classId, className){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:className, back:true }) + loadingScroll();
      let rd;
      try { rd = await api.get('/api/teacher/report-readiness?class_id=' + classId); }
      catch(e){ s.innerHTML = appbar({ title:className, back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const learners = rd.learners || [];
      const ready = learners.filter(l => l.status === 'ready').length;
      s.innerHTML = appbar({ title:className, back:true }) + `<div class="scroll pad stack-gap">
        <div class="card" style="background:var(--grad-brand);color:#fff;text-align:center;box-shadow:var(--sh-brand);">
          <div style="font-size:var(--t-xs);letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7);">Report readiness · ${esc(rd.assessment)}</div>
          <div style="font-size:var(--t-3xl);font-weight:800;margin:6px 0;">${ready}/${learners.length}</div>
          <div style="font-size:var(--t-sm);color:rgba(255,255,255,.8);">learners fully marked (${rd.subjects_total} subjects)</div></div>
        <button class="btn gold block" onclick="TeacherApp.broadsheet(${classId},'${esc(className)}')"><i data-lucide="table"></i> View broadsheet</button>
        <div class="card"><div class="card-hd"><h3>Learners</h3></div><div class="rows">
          ${learners.map(l => `<div class="row"><div class="body"><div class="title">${esc(l.name)}</div>
            <div class="meta">${esc(l.admission_no || '')}</div></div>
            <span class="badge ${l.status === 'ready' ? 'ok' : 'warn'}">${l.subjects_done}/${l.subjects_total}</span></div>`).join('') || '<div class="muted pad">No learners.</div>'}
        </div></div></div>`;
    });
  },

  broadsheet(classId, className){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Broadsheet', back:true }) + loadingScroll();
      let b;
      try { b = await api.get('/api/teacher/broadsheet?class_id=' + classId); }
      catch(e){ s.innerHTML = appbar({ title:'Broadsheet', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const subjects = b.subjects || [];
      const rows = (b.learners || []).filter(r => r.subject_count > 0);
      s.innerHTML = appbar({ title:className + ' · Broadsheet', back:true }) + `<div class="scroll pad">
        ${rows.length ? `<div class="card" style="padding:10px;overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:var(--t-sm);min-width:${140 + subjects.length * 46 + 90}px;">
            <thead><tr><th style="text-align:left;padding:6px 4px;font-size:10px;color:var(--ink-3);">#</th>
              <th style="text-align:left;padding:6px 4px;font-size:10px;color:var(--ink-3);">Learner</th>
              ${subjects.map(sub => `<th style="padding:6px 2px;font-size:9px;color:var(--ink-3);text-align:center;" title="${esc(sub.name)}">${esc(sub.code || sub.name.slice(0, 3).toUpperCase())}</th>`).join('')}
              <th style="padding:6px 2px;font-size:10px;color:var(--ink-3);text-align:center;">Avg</th>
              <th style="padding:6px 2px;font-size:10px;color:var(--ink-3);text-align:center;">Pos</th></tr></thead>
            <tbody>${rows.map((r, i) => `<tr style="border-top:1px solid var(--line-2);">
              <td style="padding:7px 4px;color:var(--ink-3);">${i + 1}</td>
              <td style="padding:7px 4px;font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(r.name)}</td>
              ${subjects.map((sub, si) => { const v = r.subjects?.[si]?.average; return `<td class="mono" style="padding:7px 2px;text-align:center;">${v == null ? '—' : Math.round(v)}</td>`; }).join('')}
              <td class="mono" style="padding:7px 2px;text-align:center;font-weight:700;">${r.average == null ? '—' : Number(r.average).toFixed(1)}</td>
              <td class="mono" style="padding:7px 2px;text-align:center;color:var(--brand-600);font-weight:700;">${r.position ?? '—'}</td></tr>`).join('')}</tbody>
          </table></div>` : emptyState('table', 'No marks yet', 'No marks have been entered for this class this term.')}
      </div>`;
    });
  },

  notifications(){ renderNotificationsScreen(); },

  /* ════ MORE ════ */
  async more(m){
    const me = state.me || {};
    let prof = {};
    try { prof = await api.get('/api/teacher/me'); } catch(e){}
    const school = state.school || {};
    m.innerHTML = TeacherApp.thead('Settings & tools', 'More')
      .replace('<div id="thead-extra"></div>', '')
      + `<div class="scroll pad stack-gap">
      <div class="card" style="display:flex;align-items:center;gap:14px;">
        <div class="ava ava-lg lead" style="${avaColor(prof.name || me.name)}">${initials(prof.name || me.name)}</div>
        <div class="body"><div style="font-weight:800;font-size:var(--t-lg);">${esc(prof.name || me.name || 'Teacher')}</div>
          <div class="muted" style="font-size:var(--t-sm);">${esc(prof.user_id || me.user_id || '')} · Teacher</div></div>
      </div>
      <div class="card" style="padding:6px 16px;"><div class="rows">
        ${moreRow('calendar-days', 'My timetable', "TeacherApp.timetable()")}
        ${moreRow('calendar-plus', 'Book a lesson slot', "TeacherApp.booking()")}
        ${moreRow('arrow-right-left', 'My cover duties', "TeacherApp.cover()")}
        ${moreRow('file-text', 'Reports & broadsheets', "TeacherApp.reportsList()")}
        ${moreRow('bell', 'Notifications', "TeacherApp.notifications()")}
      </div></div>
      <div class="card" style="padding:6px 16px;"><div class="rows">
        ${moreRow('key', 'Change password', "TeacherApp.changePassword()")}
        ${moreRow('info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('log-out', 'Sign out', "doLogout()", 'var(--danger)')}
      </div></div>
      <div class="center muted" style="font-size:var(--t-xs);">${esc(school.school_name || 'Daraja')} · v3.0</div>
    </div>`;
  },

  reportsList(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Reports', back:true }) + loadingScroll();
      let ov;
      try { ov = await api.get('/api/teacher/attendance/overview?date=' + new Date().toISOString().slice(0, 10)); }
      catch(e){ s.innerHTML = appbar({ title:'Reports', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const classes = (ov.classes || []).map(c => ({ id:c.id, name:c.name }));
      s.innerHTML = appbar({ title:'Reports', back:true }) + `<div class="scroll pad stack-gap">
        <div class="muted" style="font-size:var(--t-sm);">Report readiness & broadsheet for your class.</div>
        ${classes.length ? `<div class="card" style="padding:6px 12px;"><div class="rows">${classes.map(c => `
          <button class="row" style="width:100%;text-align:left;" onclick="TeacherApp.classReport(${c.id},'${esc(c.name)}')">
            <div class="ava ava-sm lead" style="${avaColor(c.name)}">${esc(c.name.replace(/[^0-9]/g, '') || initials(c.name))}</div>
            <div class="body"><div class="title">${esc(c.name)}</div><div class="meta">Readiness · broadsheet</div></div>
            <i data-lucide="chevron-right" class="chev"></i></button>`).join('')}</div></div>`
          : emptyState('file-text', 'For class teachers', 'Reports are available to class teachers.')}
      </div>`;
    });
  },

  async cover(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Cover duties', back:true }) + loadingScroll();
      let t;
      try { t = await api.get('/api/teacher/timetable'); }
      catch(e){ s.innerHTML = appbar({ title:'Cover duties', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const covers = t.covers || [];
      s.innerHTML = appbar({ title:'Cover duties', back:true }) + `<div class="scroll pad stack-gap">
        ${covers.length ? `<div class="muted" style="font-size:var(--t-sm);">You are covering these lessons today.</div>
          <div class="card" style="padding:6px 12px;"><div class="rows">${covers.map(c => `
            <div class="row"><div class="ava ava-sm lead" style="${avaColor(c.subject_name)}"><i data-lucide="arrow-right-left" style="font-size:12px;"></i></div>
              <div class="body"><div class="title">${esc(c.subject_name)} · ${esc(c.class_name)}</div>
                <div class="meta">Period ${c.period_no}${c.original_teacher_name ? ' · for ' + esc(c.original_teacher_name) : ''}</div></div></div>`).join('')}</div></div>`
          : emptyState('coffee', 'No cover today', 'You have no substitution duties scheduled for today.')}
      </div>`;
    });
  },

  booking(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Book a slot', back:true }) + loadingScroll();
      let fs, mine;
      try { [fs, mine] = await Promise.all([api.get('/api/teacher/timetable/free-slots'), api.get('/api/teacher/bookings').catch(() => [])]); }
      catch(e){ s.innerHTML = appbar({ title:'Book a slot', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; return; }
      const myBookings = Array.isArray(mine) ? mine : (mine.data || []);
      const classes = (fs.classes || []).filter(c => (c.free_slots || []).length);
      const subjects = fs.subjects || [];
      const rooms = fs.rooms || [];
      const mySlots = fs.my_slots || [];
      const lessonPeriods = (fs.periods || []).filter(p => p.type === 'lesson');
      const todayISO = new Date().toISOString().slice(0, 10);
      const stBadge = st => st === 'approved' ? 'ok' : st === 'rejected' || st === 'cancelled' ? 'be' : 'warn';
      const dayFromDate = value => new Date((value || todayISO) + 'T12:00:00').getDay();
      const recurrenceFrom = (scope, date) => scope === 'full_week' ? [1,2,3,4,5] : [dayFromDate(date)];
      s.innerHTML = appbar({ title:'Book a slot', back:true }) + `<div class="scroll pad stack-gap">
        ${myBookings.length ? `<div class="section-label">My requests</div>
          <div class="card" style="padding:6px 12px;"><div class="rows">${myBookings.map(b => `
            <div class="row"><div class="body"><div class="title">${esc(b.subject_name)} · ${esc(b.class_name)}</div>
              <div class="meta">${esc(b.date)} · period ${b.period_no}</div></div>
              <div class="trail"><span class="badge ${stBadge(b.status)}">${esc(b.status)}</span>
                ${b.status === 'pending' ? `<button class="appbar-btn" style="width:32px;height:32px;font-size:12px;" onclick="TeacherApp.cancelBooking(${b.id})"><i data-lucide="x"></i></button>` : ''}</div></div>`).join('')}</div></div>` : ''}
        <div class="section-label">Request a free slot</div>
        ${rooms.length && mySlots.length ? `<div class="card stack-gap">
          <div class="field"><label>Move scheduled lesson to room</label><select class="input" id="bk-existing">
            ${mySlots.map(sl => `<option value="${sl.id}">${DOW[sl.day_of_week]} - P${sl.period_no} - ${esc(sl.subject_name)} - ${esc(sl.class_name)}${sl.room_name ? ' (' + esc(sl.room_name) + ')' : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Target room</label><select class="input" id="bk-existing-room">
            ${rooms.map(r => `<option value="${r.id}">${esc(r.name)}${r.room_type ? ' - ' + esc(r.room_type) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Target period</label><select class="input" id="bk-existing-period">
            ${lessonPeriods.map(p => `<option value="${p.period_no}">P${p.period_no} - ${esc(p.start_time || '')}${p.end_time ? ' to ' + esc(p.end_time) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Lesson date</label><input class="input" id="bk-existing-date" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="field"><label>Repeat</label><select class="input" id="bk-existing-scope">
            <option value="once">Single day only</option>
            <option value="weekly">Every matching weekday until end date</option>
            <option value="full_week">Every school day until end date</option>
          </select></div>
          <div class="field"><label>End date</label><input class="input" id="bk-existing-date-to" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="muted" style="font-size:var(--t-xs);line-height:1.45;">Room moves must be requested at least 20 minutes before the lesson starts.</div>
          <button class="btn block" id="bk-room-submit"><i data-lucide="door-open"></i> Request room move</button>
        </div>` : ''}
        ${rooms.length ? `<div class="section-label">Meeting or venue booking</div>
        <div class="card stack-gap">
          <div class="field"><label>Title</label><input class="input" id="bk-meet-title" placeholder="e.g. Parents meeting"></div>
          <div class="field"><label>Room / venue</label><select class="input" id="bk-meet-room">
            ${rooms.map(r => `<option value="${r.id}">${esc(r.name)}${r.room_type ? ' - ' + esc(r.room_type) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Period</label><select class="input" id="bk-meet-period">
            ${lessonPeriods.map(p => `<option value="${p.period_no}">P${p.period_no} - ${esc(p.start_time || '')}${p.end_time ? ' to ' + esc(p.end_time) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Start date</label><input class="input" id="bk-meet-date" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="field"><label>Repeat</label><select class="input" id="bk-meet-scope">
            <option value="once">Single day only</option>
            <option value="weekly">Every matching weekday until end date</option>
            <option value="full_week">Every school day until end date</option>
          </select></div>
          <div class="field"><label>End date</label><input class="input" id="bk-meet-date-to" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="field"><label>Expected people</label><input class="input" id="bk-meet-count" type="number" min="1" placeholder="Optional"></div>
          <button class="btn block" id="bk-meet-submit"><i data-lucide="users"></i> Request venue</button>
        </div>` : ''}
        ${classes.length ? `<div class="card stack-gap">
          <div class="field"><label>Class</label><select class="input" id="bk-class"><option value="">— pick a class —</option>
            ${classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Free slot</label><select class="input" id="bk-slot" disabled><option value="">— pick a class first —</option></select></div>
          <div class="field"><label>Subject</label><select class="input" id="bk-subject">
            ${subjects.map(sub => `<option value="${sub.id}">${esc(sub.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Room</label><select class="input" id="bk-room">
            <option value="">Use class room</option>
            ${rooms.map(r => `<option value="${r.id}">${esc(r.name)}${r.room_type ? ' - ' + esc(r.room_type) : ''}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input class="input" id="bk-date" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="field"><label>Reason (optional)</label><input class="input" id="bk-reason" placeholder="e.g. extra revision lesson"></div>
          <button class="btn primary block" id="bk-submit"><i data-lucide="send"></i> Request slot</button>
        </div>` : emptyState('calendar-x', 'No free slots', 'There are no free slots available to book right now.')}
      </div>`;
      const slotsByClass = {}; classes.forEach(c => { slotsByClass[c.id] = c.free_slots || []; });
      const clsSel = $('#bk-class', s), slotSel = $('#bk-slot', s);
      if (clsSel) clsSel.addEventListener('change', () => {
        const list = slotsByClass[clsSel.value] || [];
        slotSel.disabled = !list.length;
        slotSel.innerHTML = list.length ? list.map((sl, i) => `<option value="${i}">${DOW[sl.day_of_week]} · Period ${sl.period_no}</option>`).join('') : '<option value="">No free slots</option>';
      });
      const syncExistingPeriod = () => {
        const src = mySlots.find(sl => String(sl.id) === String($('#bk-existing', s)?.value));
        const pick = $('#bk-existing-period', s);
        if (src && pick) pick.value = String(src.period_no);
      };
      if ($('#bk-existing', s)) { $('#bk-existing', s).addEventListener('change', syncExistingPeriod); syncExistingPeriod(); }
      if ($('#bk-submit', s)) $('#bk-submit', s).addEventListener('click', async () => {
        const cid = clsSel.value; const list = slotsByClass[cid] || []; const sl = list[Number(slotSel.value)];
        if (!cid || !sl) return UI.toast('Pick a class and free slot', 'warn');
        const btn = $('#bk-submit', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Requesting…';
        try {
          await api.post('/api/teacher/bookings', { class_id:Number(cid), subject_id:Number($('#bk-subject', s).value), room_id:$('#bk-room', s).value || null, day_of_week:sl.day_of_week, period_no:sl.period_no, date:$('#bk-date', s).value, reason:$('#bk-reason', s).value });
          UI.toast('Booking requested', 'ok'); Router.pop(); TeacherApp.booking();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="send"></i> Request slot'; }
      });
      if ($('#bk-room-submit', s)) $('#bk-room-submit', s).addEventListener('click', async () => {
        const src = mySlots.find(sl => String(sl.id) === String($('#bk-existing', s).value));
        if (!src) return UI.toast('Pick a timetable lesson', 'warn');
        const btn = $('#bk-room-submit', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Requesting...';
        try {
          const date = $('#bk-existing-date', s)?.value || todayISO;
          const scope = $('#bk-existing-scope', s)?.value || 'once';
          await api.post('/api/teacher/bookings', { source_slot_id:src.id, class_id:src.class_id, subject_id:src.subject_id, room_id:$('#bk-existing-room', s).value, day_of_week:dayFromDate(date), period_no:Number($('#bk-existing-period', s).value || src.period_no), date, date_to:$('#bk-existing-date-to', s)?.value || date, recurrence_days:recurrenceFrom(scope, date), reason:'Room move request' });
          UI.toast('Room move requested', 'ok'); Router.pop(); TeacherApp.booking();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="door-open"></i> Request room move'; }
      });
      if ($('#bk-meet-submit', s)) $('#bk-meet-submit', s).addEventListener('click', async () => {
        const title = $('#bk-meet-title', s).value.trim();
        const date = $('#bk-meet-date', s).value || todayISO;
        const scope = $('#bk-meet-scope', s).value || 'once';
        if (!title) return UI.toast('Enter a meeting title', 'warn');
        const btn = $('#bk-meet-submit', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Requesting...';
        try {
          await api.post('/api/teacher/bookings', { booking_type:'meeting', title, room_id:$('#bk-meet-room', s).value, day_of_week:dayFromDate(date), period_no:Number($('#bk-meet-period', s).value), date, date_to:$('#bk-meet-date-to', s).value || date, recurrence_days:recurrenceFrom(scope, date), attendee_count:$('#bk-meet-count', s).value || null, reason:'Meeting / venue booking' });
          UI.toast('Venue requested', 'ok'); Router.pop(); TeacherApp.booking();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i data-lucide="users"></i> Request venue'; }
      });
    });
  },
  async cancelBooking(id){
    try { await api.req('DELETE', '/api/teacher/bookings/' + id); UI.toast('Booking cancelled', 'ok'); Router.pop(); TeacherApp.booking(); }
    catch(e){ UI.toast(e.message, 'danger'); }
  },

  async timetable(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'My Timetable', back:true }) + loadingScroll();
      try { const t = await api.get('/api/teacher/timetable'); mountTimetable(s, 'My Timetable', t, { back:true }); }
      catch(e){ s.innerHTML = appbar({ title:'My Timetable', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; }
    });
  },

  changePassword(){
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Change Password', back:true }) + `<div class="scroll pad">
        <form id="cp-form" class="stack-gap">
          <div class="field"><label>Current password</label><input class="input" id="cp-cur" type="password" required></div>
          <div class="field"><label>New password</label><input class="input" id="cp-new" type="password" minlength="4" required></div>
          <div class="field"><label>Confirm new password</label><input class="input" id="cp-conf" type="password" minlength="4" required></div>
          <button class="btn primary block" id="cp-btn" type="submit">Update password</button></form></div>`;
      $('#cp-form', s).addEventListener('submit', async (e) => {
        e.preventDefault();
        if ($('#cp-new', s).value !== $('#cp-conf', s).value) return UI.toast('Passwords do not match', 'danger');
        const btn = $('#cp-btn', s); btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle" class="spin"></i> Saving…';
        try { await api.put('/api/teacher/change-password', { current_password: $('#cp-cur', s).value, new_password: $('#cp-new', s).value });
          UI.toast('Password updated', 'ok'); Router.pop();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = 'Update password'; }
      });
    });
  }
};

/* ── go ── */
Icons.start();
boot();
