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
const state = { me:null, school:null, cache:{} };

/* ═══════════════════════════════════════════════════════════════════════
   UI primitives — toast, sheet, skeleton, appbar
   ═══════════════════════════════════════════════════════════════════════ */
const UI = {
  toast(msg, type = ''){
    const wrap = $('#toast-wrap');
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.innerHTML = (type === 'ok' ? '<i class="fas fa-check"></i>' : type === 'danger' ? '<i class="fas fa-triangle-exclamation"></i>' : '') + '<span>' + esc(msg) + '</span>';
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
    ${back ? `<button class="appbar-btn" onclick="Router.pop()"><i class="fas fa-arrow-left"></i></button>` : ''}
    <div class="appbar-title">${esc(title)}</div>
    ${action}
  </div>`;
}
const skelBlock = (h, mt = 0) => `<div class="skel" style="height:${h}px;${mt ? 'margin-top:' + mt + 'px;' : ''}"></div>`;
function loadingScroll(){ return `<div class="scroll pad stack-gap">${skelBlock(120)}${skelBlock(70)}${skelBlock(150)}</div>`; }
function emptyState(icon, title, msg){
  return `<div class="empty"><div class="ic"><i class="fas ${icon}"></i></div><h3>${esc(title)}</h3><p>${esc(msg)}</p></div>`;
}
function errorState(msg, retryFn){
  return `<div class="empty"><div class="ic"><i class="fas fa-cloud-exclamation"></i></div><h3>Couldn't load</h3>
    <p>${esc(msg || 'Please try again.')}</p>${retryFn ? `<button class="btn ghost sm mt5" onclick="${retryFn}"><i class="fas fa-rotate"></i> Retry</button>` : ''}</div>`;
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
        <i class="fas ${t.icon}"></i><span>${esc(t.label)}</span></button>`).join('');
    $('#tabbar').classList.toggle('hide', tabs.length === 0);
    if (tabs.length) this.go(tabs[0].id);
  },

  hideTabs(){ $('#tabbar').classList.add('hide'); this.tabs = []; },

  _ensureTabScreen(){
    let s = $('#screen-tab');
    if (!s){ s = document.createElement('div'); s.id = 'screen-tab'; s.className = 'screen tab'; $('#screens').prepend(s); }
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

async function boot(){
  await loadBrand();
  let me = null;
  try { const r = await api.get('/api/auth/me'); if (r.authenticated) me = r.user; } catch(e){}
  state.me = me;
  hideSplash();
  if (!me) return renderPublicHome();
  routeByRole(me.role);
}

function routeByRole(role){
  if (role === 'learner') return LearnerApp.start();
  if (role === 'parent')  return ParentApp.start();
  if (role === 'teacher') return TeacherApp.start();
  // admin or unknown → admin uses the desktop dashboard
  window.location.href = '/admin';
}

/* ═══════════════════════════════════════════════════════════════════════
   PUBLIC HOME (no login required) + LOGIN
   ═══════════════════════════════════════════════════════════════════════ */
function renderPublicHome(){
  Router.hideTabs();
  const screen = Router._ensureTabScreen();
  screen.classList.add('active');
  const school = state.school || {};
  screen.innerHTML = `
    <div class="hero" style="border-radius:0 0 var(--r-2xl) var(--r-2xl);">
      <div class="row-between">
        <div class="hero-eyebrow">${esc((school.school_name || 'Daraja School').toUpperCase())}</div>
        <button class="btn sm" style="background:rgba(255,255,255,.16);color:#fff;box-shadow:none;" onclick="renderLogin()">
          <i class="fas fa-right-to-bracket"></i> Sign in</button>
      </div>
      <div class="hero-greet">Knowledge for<br><em>every classroom.</em></div>
      <div class="hero-sub">A free library of notes, past papers and schemes of work — for learners revising, teachers planning and parents helping. Works offline, anywhere.</div>
    </div>
    <div class="scroll no-nav pad">
      <div class="lift stack-gap">
        <div class="metrics">
          <button class="metric" onclick="UI.toast('Resources coming soon')">
            <span class="ic green"><i class="fas fa-book-open"></i></span>
            <span class="val" style="font-size:var(--t-md)">Notes</span><span class="lbl">Read offline</span></button>
          <button class="metric" onclick="UI.toast('Past papers coming soon')">
            <span class="ic gold"><i class="fas fa-file-lines"></i></span>
            <span class="val" style="font-size:var(--t-md)">Past papers</span><span class="lbl">KCPE · KCSE</span></button>
          <button class="metric" onclick="UI.toast('Schemes coming soon')">
            <span class="ic blue"><i class="fas fa-list-check"></i></span>
            <span class="val" style="font-size:var(--t-md)">Schemes</span><span class="lbl">Of work</span></button>
          <button class="metric" onclick="UI.toast('Games coming soon')">
            <span class="ic rose"><i class="fas fa-gamepad"></i></span>
            <span class="val" style="font-size:var(--t-md)">Games</span><span class="lbl">Learn & play</span></button>
        </div>
        <div class="card" style="background:var(--grad-gold);color:#3a2a06;">
          <div class="card-hd" style="margin-bottom:8px;"><h3 style="color:#3a2a06;">Are you a learner, parent or teacher?</h3></div>
          <p style="font-size:var(--t-sm);margin-bottom:14px;">Sign in to see results, attendance, timetable and report cards for your school.</p>
          <button class="btn block" style="background:#3a2a06;color:#fff;box-shadow:none;" onclick="renderLogin()">
            <i class="fas fa-right-to-bracket"></i> Go to my dashboard</button>
        </div>
        <div class="center muted" style="font-size:var(--t-xs);padding:10px 0;">${esc(school.school_motto || 'Education is Treasure')}</div>
      </div>
    </div>`;
}

function renderLogin(){
  Router.hideTabs();
  const screen = Router._ensureTabScreen();
  screen.classList.add('active');
  const school = state.school || {};
  let loginMode = 'password';
  screen.innerHTML = `
    <div class="scroll no-nav" style="display:flex;flex-direction:column;">
      <div class="appbar"><button class="appbar-btn" onclick="renderPublicHome()"><i class="fas fa-arrow-left"></i></button>
        <div class="appbar-title">Sign in</div></div>
      <div class="pad" style="flex:1;display:flex;flex-direction:column;justify-content:center;">
        <div class="center" style="margin-bottom:26px;">
          <div class="ava ava-lg" style="margin:0 auto 14px;${school.school_logo ? 'background:#fff;' : ''}">
            ${school.school_logo ? `<img src="${esc(school.school_logo)}" alt="">` : '<i class="fas fa-graduation-cap"></i>'}</div>
          <h2 style="font-size:var(--t-2xl);font-weight:800;letter-spacing:-.02em;">${esc(school.school_name || 'Daraja')}</h2>
          <p class="muted" style="font-size:var(--t-sm);margin-top:4px;">${esc(school.school_motto || 'Welcome back')}</p>
        </div>
        <form id="login-form">
          <div class="seg" style="margin-bottom:var(--s4);">
            <button type="button" class="on" data-login-mode="password"><i class="fas fa-lock"></i> Password</button>
            <button type="button" data-login-mode="temp"><i class="fas fa-key"></i> Temporary Code</button>
          </div>
          <div class="field"><label>Admission / ID / Phone</label>
            <input class="input" id="li-id" autocomplete="username" placeholder="e.g. JS110" required></div>
          <div class="field"><label id="li-secret-label">Password</label>
            <input class="input" id="li-secret" type="password" autocomplete="current-password" placeholder="Your password" required></div>
          <button class="btn primary block mt2" id="li-btn" type="submit"><i class="fas fa-arrow-right-to-bracket"></i> Sign In</button>
        </form>
        <p class="center muted mt5" id="li-help" style="font-size:var(--t-xs);">Forgot your password? Ask the school office.</p>
      </div>
    </div>`;
  const setLoginMode = (mode) => {
    loginMode = mode;
    $$('#login-form [data-login-mode]', screen).forEach(btn => btn.classList.toggle('on', btn.dataset.loginMode === mode));
    const label = $('#li-secret-label', screen);
    const input = $('#li-secret', screen);
    const help = $('#li-help', screen);
    if (mode === 'temp') {
      label.textContent = 'Temporary Code';
      input.type = 'text';
      input.autocomplete = 'one-time-code';
      input.placeholder = 'Enter temporary code';
      help.textContent = 'Use the code given by the school office. You can change your password after signing in.';
    } else {
      label.textContent = 'Password';
      input.type = 'password';
      input.autocomplete = 'current-password';
      input.placeholder = 'Your password';
      help.textContent = 'Forgot your password? Ask the school office.';
    }
    input.value = '';
    input.focus();
  };
  $$('#login-form [data-login-mode]', screen).forEach(btn => {
    btn.addEventListener('click', () => setLoginMode(btn.dataset.loginMode));
  });
  $('#login-form', screen).addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#li-btn', screen); btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner spin"></i> Signing in...';
    try {
      const identifier = $('#li-id', screen).value.trim();
      const secret = $('#li-secret', screen).value.trim();
      const r = loginMode === 'temp'
        ? await api.post('/api/auth/temp-login', { identifier, temp_code: secret })
        : await api.post('/api/auth/login', { identifier, password: secret });
      const me = (await api.get('/api/auth/me')).user || { role: r.role, name: r.name };
      state.me = me;
      routeByRole(me.role);
    } catch(err){
      UI.toast(err.message || 'Sign-in failed', 'danger');
      btn.disabled = false; btn.innerHTML = '<i class="fas fa-arrow-right-to-bracket"></i> Sign In';
    }
  });
}

async function doLogout(){
  try { await api.post('/api/auth/logout', {}); } catch(e){}
  state.me = null;
  renderPublicHome();
}

/* ═══════════════════════════════════════════════════════════════════════
   LEARNER APP
   ═══════════════════════════════════════════════════════════════════════ */
const LearnerApp = {
  ctx: { termId:null, assessment:null, terms:[] },

  start(){
    Router.setTabs([
      { id:'home',     label:'Home',      icon:'fa-house',          render:m => LearnerApp.home(m) },
      { id:'results',  label:'Results',   icon:'fa-chart-simple',   render:m => LearnerApp.results(m) },
      { id:'timetable',label:'Timetable', icon:'fa-calendar-day',   render:m => LearnerApp.timetable(m) },
      { id:'more',     label:'More',      icon:'fa-ellipsis',       render:m => LearnerApp.more(m) }
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
          <button class="appbar-btn" style="background:rgba(255,255,255,.16);color:#fff;box-shadow:none;" onclick="LearnerApp.notifications()"><i class="fas fa-bell"></i></button>
        </div>
        <div class="hero-greet">${greet},<br><em>${esc(firstName(p.name) || 'Learner')}.</em></div>
        <div class="hero-sub">${esc(p.class_name || 'Your class')} · Adm ${esc(p.admission_no || '—')}</div>
      </div>
      <div class="scroll pad">
        <div class="lift stack-gap">
          <div class="metrics">
            <div class="metric"><span class="ic green"><i class="fas fa-user-check"></i></span>
              <span class="val">${att ? att.pct + '%' : '—'}</span><span class="lbl">Attendance</span></div>
            <div class="metric"><span class="ic gold"><i class="fas fa-book"></i></span>
              <span class="val">${num(s.subjects_count)}</span><span class="lbl">Subjects</span></div>
            <div class="metric"><span class="ic blue"><i class="fas fa-calendar-check"></i></span>
              <span class="val">${att ? num(att.present) : '—'}</span><span class="lbl">Days present</span></div>
            <div class="metric"><span class="ic rose"><i class="fas fa-calendar-xmark"></i></span>
              <span class="val">${att ? num(att.absent) : '—'}</span><span class="lbl">Days absent</span></div>
          </div>

          <div class="card">
            <div class="card-hd"><h3>My results</h3>
              <a class="link" onclick="Router.go('results')">View all <i class="fas fa-chevron-right" style="font-size:10px;"></i></a></div>
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
      ${scored.length ? `<button class="btn ghost block" onclick="LearnerApp.comments()"><i class="fas fa-comment-dots"></i> Teacher comments</button>` : ''}
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
          : emptyState('fa-comment-slash', 'No comments yet', 'Comments appear after teachers complete your report.')}
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
    Router.push(async (s) => {
      s.innerHTML = appbar({ title:'Notifications', back:true }) + `<div class="scroll">${emptyState('fa-bell', 'No notifications', 'School announcements will appear here.')}</div>`;
    });
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
        ${moreRow('fa-key', 'Change password', "LearnerApp.changePassword()")}
        ${moreRow('fa-circle-info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('fa-arrow-right-from-bracket', 'Sign out', "doLogout()", 'var(--danger)')}
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
        const btn = $('#cp-btn', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
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
          ${school.school_logo ? `<img src="${esc(school.school_logo)}">` : '<i class="fas fa-graduation-cap"></i>'}</div>
        <h2 style="font-weight:800;font-size:var(--t-2xl);">${esc(school.school_name || 'Daraja')}</h2>
        <p class="muted mt2">${esc(school.school_motto || 'Education is Treasure')}</p>
        <div class="card flat mt6" style="text-align:left;">
          ${[['fa-phone', school.school_phone], ['fa-envelope', school.school_email], ['fa-location-dot', school.school_address]].filter(x => x[1]).map(x =>
            `<div class="row"><i class="fas ${x[0]} lead muted" style="width:24px;"></i><div class="body title" style="font-weight:500;">${esc(x[1])}</div></div>`).join('')}
        </div>
        <p class="muted mt6" style="font-size:var(--t-xs);">Daraja v3.0 · Built for learners</p>
      </div>`;
    });
  }
};

function moreRow(icon, label, onclick, color){
  return `<button class="row" style="width:100%;text-align:left;" onclick="${onclick}">
    <i class="fas ${icon} lead" style="width:26px;color:${color || 'var(--ink-3)'};font-size:16px;"></i>
    <div class="body title" style="font-weight:600;${color ? 'color:' + color + ';' : ''}">${esc(label)}</div>
    <i class="fas fa-chevron-right chev"></i></button>`;
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
  if (!scored.length) return emptyState('fa-chart-simple', 'No results yet', 'Marks for this term will appear here once teachers publish them.');
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
  if (!slots.length){ mount.innerHTML = appbar({ title, back }) + `<div class="scroll">${emptyState('fa-calendar-day', 'No timetable yet', 'The class timetable will show here once the school publishes it.')}</div>`; return; }
  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayDow = new Date().getDay();
  const byDay = {}; slots.forEach(s => { (byDay[s.day_of_week] = byDay[s.day_of_week] || []).push(s); });
  const order = [1,2,3,4,5,6,0].filter(d => byDay[d]);
  let cur = order.includes(todayDow) ? todayDow : order[0];
  const draw = (day) => {
    const list = (byDay[day] || []).sort((a, b) => a.period_no - b.period_no);
    $('#tt-body', mount).innerHTML = list.length ? `<div class="rows">${list.map(s => `
      <div class="row"><div class="lead" style="width:42px;text-align:center;">
        <div class="mono" style="font-weight:800;font-size:var(--t-md);color:var(--brand-600);">${s.period_no}</div>
        <div class="muted" style="font-size:9px;">PERIOD</div></div>
        <div class="body"><div class="title">${esc(s.subject_name || 'Lesson')}</div>
        <div class="meta">${esc(s.teacher_name || '')}</div></div>
        ${s.is_substitution ? '<span class="badge warn">Cover</span>' : ''}</div>`).join('')}</div>`
      : emptyState('fa-mug-hot', 'No lessons', 'Nothing scheduled for this day.');
  };
  mount.innerHTML = appbar({ title, back }) + `<div class="scroll pad stack-gap">
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;" id="tt-days">
      ${order.map(d => `<button class="chip ${d === cur ? 'on' : ''}" data-d="${d}">${DAYS[d].slice(0, 3)}${d === todayDow ? ' ·' : ''}</button>`).join('')}
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
      { id:'home',     label:'Home',      icon:'fa-house',        render:m => ParentApp.home(m) },
      { id:'results',  label:'Results',   icon:'fa-chart-simple', render:m => ParentApp.results(m) },
      { id:'timetable',label:'Timetable', icon:'fa-calendar-day', render:m => ParentApp.timetable(m) },
      { id:'more',     label:'More',      icon:'fa-ellipsis',     render:m => ParentApp.more(m) }
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
      m.innerHTML = appbar({ title:'Home' }) + `<div class="scroll">${emptyState('fa-child', 'No children linked', 'Ask the school office to link your child to your account.')}</div>`;
      return;
    }
    m.innerHTML = `
      <div class="hero">
        <div class="row-between"><div class="hero-eyebrow">Parent</div>
          <button class="appbar-btn" style="background:rgba(255,255,255,.16);color:#fff;box-shadow:none;" onclick="ParentApp.notifications()"><i class="fas fa-bell"></i></button></div>
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
        <i class="fas fa-chevron-right chev"></i>
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
    if (!c){ m.innerHTML = appbar({ title:'Results' }) + `<div class="scroll">${emptyState('fa-child', 'No child selected', 'Link a child to view results.')}</div>`; return; }
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
      ${scored.length ? `<button class="btn ghost block" onclick="ParentApp.comments()"><i class="fas fa-comment-dots"></i> Teacher comments</button>` : ''}
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
          : emptyState('fa-comment-slash', 'No comments yet', 'Comments appear after teachers complete the report.')}</div>`;
      } catch(e){ s.innerHTML = appbar({ title:'Teacher Comments', back:true }) + `<div class="scroll">${errorState(e.message)}</div>`; }
    });
  },

  /* ── Timetable ── */
  async timetable(m){
    const c = ParentApp.child();
    if (!c){ m.innerHTML = appbar({ title:'Timetable' }) + `<div class="scroll">${emptyState('fa-child', 'No child selected', '')}</div>`; return; }
    m.innerHTML = appbar({ title:'Timetable' }) + loadingScroll();
    let t;
    try { t = await api.get('/api/parent/timetable?child_id=' + c.id); }
    catch(e){ if (e.auth) return doLogout(); m.innerHTML = appbar({ title:'Timetable' }) + `<div class="scroll">${e.message && /not yet shared/i.test(e.message) ? emptyState('fa-calendar-day', 'Not shared yet', 'The school has not shared the timetable with parents.') : errorState(e.message, 'Router.go(\'timetable\')')}</div>`; return; }
    mountTimetable(m, esc(firstName(c.name)) + "'s Timetable", t);
    // inject switcher above
    const sw = ParentApp.switcherHTML();
    if (sw){ const scroll = $('.scroll', m); scroll.insertAdjacentHTML('afterbegin', sw); ParentApp.wireSwitcher(m); }
  },

  notifications(){ Router.push(async (s) => { s.innerHTML = appbar({ title:'Notifications', back:true }) + `<div class="scroll">${emptyState('fa-bell', 'No notifications', 'School announcements will appear here.')}</div>`; }); },

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
        ${moreRow('fa-circle-info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('fa-arrow-right-from-bracket', 'Sign out', "doLogout()", 'var(--danger)')}
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
      { id:'today',     label:'Today',     icon:'fa-bolt',           render:m => TeacherApp.today(m) },
      { id:'classes',   label:'Classes',   icon:'fa-users-rectangle', render:m => TeacherApp.classes(m) },
      { id:'gradebook', label:'Gradebook', icon:'fa-table-cells',    render:m => TeacherApp.gradebook(m) },
      { id:'more',      label:'More',      icon:'fa-ellipsis',       render:m => TeacherApp.more(m) }
    ]);
  },

  thead(ctxLine, title){
    const me = state.me || {};
    return `<div class="tbar"><div class="top">
        <div><div class="ctx">${esc(ctxLine)}</div><h1>${esc(title)}</h1></div>
        <button class="bell" onclick="TeacherApp.notifications()"><i class="fas fa-bell"></i><span class="dot"></span></button>
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
    if (home.empty){ m.innerHTML = TeacherApp.thead('Today', 'Daraja') + `<div class="scroll">${emptyState('fa-chalkboard-user', 'No classes yet', home.message || 'No classes assigned to you.')}</div>`; return; }

    const ctx = home.context || {};
    TeacherApp._ctx = { assessment: analytics.current_assessment || ctx.assessment || 'midterm', termId: (analytics.current_term || ctx.term || {}).id || null };
    const now = new Date();
    const dateLine = now.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' });
    const weekStr = ctx.calendar?.week_no ? `Week ${ctx.calendar.week_no}` : '';
    const ctxLine = [dateLine, weekStr, ctx.term?.name].filter(Boolean).join(' · ');

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
    (ov.classes || []).filter(c => !c.marked).forEach(c => queue.push({ ic:'fa-user-check', title:`Mark ${c.name} attendance`, meta:`${c.learner_count} learners · today`, onclick:`TeacherApp.roll(${c.id},'${esc(c.name)}','${todayISO}')` }));
    (analytics.subjects || []).forEach(sj => {
      if (sj.components_configured && sj.learners_marked < (sj.enrollment_count || 0)) {
        queue.push({ ic:'fa-pen', title:`${sj.subject_name} · ${sj.class_name} marks`, meta:`${sj.learners_marked}/${sj.enrollment_count} entered`, onclick:`TeacherApp.marksGrid(${sj.class_id},${sj.subject_id},'${esc(sj.class_name)}','${esc(sj.subject_name)}')` });
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
            <button class="queue-item" onclick="${q.onclick}"><span class="qic"><i class="fas ${q.ic}"></i></span>
              <div class="body"><div class="title">${q.title}</div><div class="meta">${q.meta}</div></div>
              <i class="fas fa-chevron-right chev"></i></button>`).join('')}</div>`
          : `<div class="queue-item ok"><span class="qic"><i class="fas fa-check"></i></span><div class="body"><div class="title">All caught up</div><div class="meta">No attendance or marks pending right now.</div></div></div>`}

        <div class="section-label">Today's lessons</div>
        ${todaySlots.length ? `<div class="card">${todaySlots.map(s => `
          <div class="tl-item ${s === nowSlot ? 'now' : ''}"><div class="tl-time">${s.start ? tlabel(s.start) : 'P' + s.period_no}</div>
            <div class="tl-body"><div class="tl-card"><div class="s">${esc(s.subject_name)}</div><div class="c">${esc(s.class_name)}${s.is_substitution ? ' · cover' : ''}</div></div></div></div>`).join('')}</div>`
          : (dow === 0 || dow === 6) ? emptyState('fa-mug-hot', 'Weekend', 'No lessons scheduled today.') : emptyState('fa-calendar-day', 'No lessons today', 'Nothing on your timetable for today.')}
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
          <i class="fas fa-chevron-right chev"></i></div></button>`).join('')
        : emptyState('fa-users-rectangle', 'No classes', 'You have no classes assigned.')}
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
          <button class="btn ghost sm" onclick="TeacherApp.roll(${classId},'${esc(className)}','${new Date().toISOString().slice(0, 10)}')"><i class="fas fa-user-check"></i> Attendance</button>
          <button class="btn ghost sm" onclick="TeacherApp.rateSkills(${classId},'${esc(className)}')"><i class="fas fa-star"></i> Skills</button>
          <button class="btn ghost sm" onclick="TeacherApp.writeComments(${classId},'${esc(className)}')"><i class="fas fa-comment-dots"></i> Comments</button>
          <button class="btn ghost sm" onclick="TeacherApp.classReport(${classId},'${esc(className)}')"><i class="fas fa-file-lines"></i> Reports</button>
        </div>` : '';
      s.innerHTML = appbar({ title:className, back:true }) + `<div class="scroll pad stack-gap">
        ${actions}
        <div class="section-label">${roster ? roster.length + ' learners' : 'Learners'}</div>
        ${roster && roster.length ? `<div class="stud-grid">${roster.map(l => `
          <button class="stud" onclick="TeacherApp.studentProfile(${classId},'${esc(className)}',${l.id},'${esc(l.name)}','${esc(l.admission_no || '')}',${homeroom})">
            <div class="ava ava-md" style="${avaColor(l.name)}">${initials(l.name)}</div>
            <div class="nm">${esc(l.name)}</div></button>`).join('')}</div>`
          : emptyState('fa-users', 'Roster unavailable', homeroom ? 'No active learners in this class.' : 'The class roster is managed by the class teacher.')}
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
          ${emptyState('fa-lock', 'Class-teacher view', 'Full performance, skills and comments for a learner are available to their class teacher.')}</div>`;
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

      let perfHTML = emptyState('fa-chart-simple', 'No marks yet', 'No marks recorded for this learner this term.');
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
          <button class="btn primary block mt3" id="sp-save"><i class="fas fa-floppy-disk"></i> Save comment</button></div>
      </div>`;
      $('#sp-save', s).addEventListener('click', async () => {
        const btn = $('#sp-save', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        try {
          await api.post('/api/teacher/comments', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:[{ learner_id:learnerId, comment_text:$('#sp-comment', s).value }] });
          UI.toast('Comment saved', 'ok'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save comment';
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save comment'; }
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
            </div></div>`).join('')}</div>`).join('') || emptyState('fa-users', 'No learners', '')}
      </div>
      <button class="btn primary" id="sk-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i class="fas fa-floppy-disk"></i> Save skills</button>`;
      $$('.rate-row', s).forEach(rr => rr.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-r]'); if (!b) return;
        TeacherApp._skillSel[rr.dataset.key] = Number(b.dataset.r);
        $$('button', rr).forEach(x => x.classList.toggle('on', x === b));
      }));
      $('#sk-save', s).addEventListener('click', async () => {
        const btn = $('#sk-save', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        const ent = Object.entries(TeacherApp._skillSel).filter(([, v]) => v != null).map(([k, v]) => { const [lid, ck, ik] = k.split('|'); return { learner_id:Number(lid), category_key:ck, item_key:ik, rating:v }; });
        try { await api.post('/api/teacher/skills', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:ent }); UI.toast('Skills saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save skills'; }
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
        <div class="muted" style="font-size:var(--t-sm);margin-bottom:12px;">Class-teacher remark for each learner. Tap <i class="fas fa-wand-magic-sparkles"></i> to suggest from the bank.</div>
        ${(roster || []).map(l => `<div class="card" style="margin-bottom:12px;"><div class="row" style="border:none;padding:0 0 8px;">
          <div class="ava ava-sm lead" style="${avaColor(l.name)}">${initials(l.name)}</div>
          <div class="body title">${esc(l.name)}</div>
          ${bands.length ? `<button class="appbar-btn" style="width:34px;height:34px;font-size:13px;" onclick="TeacherApp.suggestComment(${l.id})"><i class="fas fa-wand-magic-sparkles"></i></button>` : ''}</div>
          <textarea class="input cm-in" data-lid="${l.id}" maxlength="1000" placeholder="Comment…">${esc(entries[l.id] || '')}</textarea></div>`).join('') || emptyState('fa-users', 'No learners', '')}
      </div>
      <button class="btn primary" id="cm-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i class="fas fa-floppy-disk"></i> Save comments</button>`;
      $('#cm-save', s).addEventListener('click', async () => {
        const btn = $('#cm-save', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        const ent = $$('.cm-in', s).map(t => ({ learner_id:Number(t.dataset.lid), comment_text:t.value }));
        try { await api.post('/api/teacher/comments', { class_id:classId, assessment_type:a, term_id:TeacherApp._ctx.termId, entries:ent }); UI.toast('Comments saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save comments'; }
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
      }).join('') : emptyState('fa-table-cells', 'No subjects', 'You have no subjects to grade.')}
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
          <div class="dist-legend"><span><i style="background:#22c55e"></i>EE ${dist.ee}</span><span><i style="background:#3b82f6"></i>ME ${dist.me}</span><span><i style="background:var(--gold-500)"></i>AE ${dist.ae}</span><span><i style="background:#ef4444"></i>BE ${dist.be}</span></div>` : ''}</div>
        ${percents.length ? `<div class="card" style="display:flex;gap:10px;text-align:center;">
          <div style="flex:1;"><div class="muted" style="font-size:var(--t-xs);">Highest</div><div style="font-weight:800;font-size:var(--t-lg);color:var(--brand-600);">${pct(sorted[0])}</div></div>
          <div style="flex:1;border-left:1px solid var(--line);border-right:1px solid var(--line);"><div class="muted" style="font-size:var(--t-xs);">Lowest</div><div style="font-weight:800;font-size:var(--t-lg);color:var(--danger);">${pct(sorted[sorted.length - 1])}</div></div>
          <div style="flex:1;"><div class="muted" style="font-size:var(--t-xs);">At risk</div><div style="font-weight:800;font-size:var(--t-lg);">${dist.be + dist.ae}</div></div></div>` : ''}
        <button class="btn primary block" onclick="TeacherApp.marksGrid(${classId},${subjectId},'${esc(className)}','${esc(subjectName)}')"><i class="fas fa-pen-to-square"></i> ${percents.length ? 'Edit' : 'Enter'} marks</button>
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
      if (!components.length){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${emptyState('fa-sliders', 'No components set up', 'Ask the admin to configure assessment components for this subject before entering marks.')}</div>`; return; }
      let list = Array.isArray(marks.learners) ? marks.learners : null;
      if (!list){ try { list = (await api.get('/api/teacher/classes/' + classId + '/learners')).learners; } catch(e){ list = null; } }
      if (!list){ s.innerHTML = appbar({ title:subjectName, back:true }) + `<div class="scroll">${emptyState('fa-user-lock', 'Roster unavailable', 'The class roster needs a backend update for subject teachers.')}</div>`; return; }
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
        <button class="btn primary" id="mk-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i class="fas fa-floppy-disk"></i> Save marks</button>`;
      $$('#mk-assess button', s).forEach(b => b.addEventListener('click', () => { TeacherApp._ctx.assessment = b.dataset.a; Router.pop(); TeacherApp.marksGrid(classId, subjectId, className, subjectName); }));
      $$('.mk-in', s).forEach(inp => inp.addEventListener('input', () => { const max = Number(inp.dataset.max); if (inp.value !== '' && Number(inp.value) > max) inp.value = max; if (Number(inp.value) < 0) inp.value = 0; }));
      $('#mk-save', s).addEventListener('click', async () => {
        const btn = $('#mk-save', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        const ent = $$('.mk-in', s).map(inp => ({ learner_id:Number(inp.dataset.lid), component_key:inp.dataset.key, score:inp.value === '' ? '' : Number(inp.value) }));
        try { await api.post('/api/teacher/marks', { class_id:classId, subject_id:subjectId, assessment_type:TeacherApp._ctx.assessment, term_id:termId, entries:ent }); UI.toast('Marks saved', 'ok'); Router.pop(); }
        catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save marks'; }
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
      s.innerHTML = appbar({ title:className, back:true, action:`<button class="appbar-btn" onclick="TeacherApp.markAll('P')" title="All present"><i class="fas fa-check-double"></i></button>` })
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
          <button class="btn primary" id="roll-save" style="position:absolute;left:18px;right:18px;bottom:calc(var(--safe-bottom) + 16px);width:auto;"><i class="fas fa-floppy-disk"></i> Save attendance</button>`;
      drawCounts();
      $$('#roll-rows .seg', s).forEach(seg => seg.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-s]'); if (!btn) return;
        const lid = seg.dataset.roll;
        TeacherApp._roll.sel[lid] = btn.dataset.s;
        $$('button', seg).forEach(b => b.classList.toggle('on', b === btn));
        drawCounts();
      }));
      $('#roll-save', s).addEventListener('click', async () => {
        const btn = $('#roll-save', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        try {
          const payload = { class_id: classId, date, entries: Object.entries(TeacherApp._roll.sel).map(([learner_id, status]) => ({ learner_id: Number(learner_id), status })) };
          await api.post('/api/teacher/attendance', payload);
          UI.toast('Attendance saved', 'ok'); Router.pop(); Router.go('today');
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-floppy-disk"></i> Save attendance'; }
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
        <button class="btn gold block" onclick="TeacherApp.broadsheet(${classId},'${esc(className)}')"><i class="fas fa-table"></i> View broadsheet</button>
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
          </table></div>` : emptyState('fa-table', 'No marks yet', 'No marks have been entered for this class this term.')}
      </div>`;
    });
  },

  notifications(){ Router.push(async (s) => { s.innerHTML = appbar({ title:'Notifications', back:true }) + `<div class="scroll">${emptyState('fa-bell', 'No notifications', 'School announcements will appear here.')}</div>`; }); },

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
        ${moreRow('fa-calendar-day', 'My timetable', "TeacherApp.timetable()")}
        ${moreRow('fa-calendar-plus', 'Book a lesson slot', "TeacherApp.booking()")}
        ${moreRow('fa-right-left', 'My cover duties', "TeacherApp.cover()")}
        ${moreRow('fa-file-lines', 'Reports & broadsheets', "TeacherApp.reportsList()")}
        ${moreRow('fa-bell', 'Notifications', "TeacherApp.notifications()")}
      </div></div>
      <div class="card" style="padding:6px 16px;"><div class="rows">
        ${moreRow('fa-key', 'Change password', "TeacherApp.changePassword()")}
        ${moreRow('fa-circle-info', 'About Daraja', "LearnerApp.about()")}
        ${moreRow('fa-arrow-right-from-bracket', 'Sign out', "doLogout()", 'var(--danger)')}
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
            <i class="fas fa-chevron-right chev"></i></button>`).join('')}</div></div>`
          : emptyState('fa-file-lines', 'For class teachers', 'Reports are available to class teachers.')}
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
            <div class="row"><div class="ava ava-sm lead" style="${avaColor(c.subject_name)}"><i class="fas fa-right-left" style="font-size:12px;"></i></div>
              <div class="body"><div class="title">${esc(c.subject_name)} · ${esc(c.class_name)}</div>
                <div class="meta">Period ${c.period_no}${c.original_teacher_name ? ' · for ' + esc(c.original_teacher_name) : ''}</div></div></div>`).join('')}</div></div>`
          : emptyState('fa-mug-hot', 'No cover today', 'You have no substitution duties scheduled for today.')}
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
      const todayISO = new Date().toISOString().slice(0, 10);
      const stBadge = st => st === 'approved' ? 'ok' : st === 'rejected' || st === 'cancelled' ? 'be' : 'warn';
      s.innerHTML = appbar({ title:'Book a slot', back:true }) + `<div class="scroll pad stack-gap">
        ${myBookings.length ? `<div class="section-label">My requests</div>
          <div class="card" style="padding:6px 12px;"><div class="rows">${myBookings.map(b => `
            <div class="row"><div class="body"><div class="title">${esc(b.subject_name)} · ${esc(b.class_name)}</div>
              <div class="meta">${esc(b.date)} · period ${b.period_no}</div></div>
              <div class="trail"><span class="badge ${stBadge(b.status)}">${esc(b.status)}</span>
                ${b.status === 'pending' ? `<button class="appbar-btn" style="width:32px;height:32px;font-size:12px;" onclick="TeacherApp.cancelBooking(${b.id})"><i class="fas fa-xmark"></i></button>` : ''}</div></div>`).join('')}</div></div>` : ''}
        <div class="section-label">Request a free slot</div>
        ${classes.length ? `<div class="card stack-gap">
          <div class="field"><label>Class</label><select class="input" id="bk-class"><option value="">— pick a class —</option>
            ${classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Free slot</label><select class="input" id="bk-slot" disabled><option value="">— pick a class first —</option></select></div>
          <div class="field"><label>Subject</label><select class="input" id="bk-subject">
            ${subjects.map(sub => `<option value="${sub.id}">${esc(sub.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input class="input" id="bk-date" type="date" value="${todayISO}" min="${todayISO}"></div>
          <div class="field"><label>Reason (optional)</label><input class="input" id="bk-reason" placeholder="e.g. extra revision lesson"></div>
          <button class="btn primary block" id="bk-submit"><i class="fas fa-paper-plane"></i> Request slot</button>
        </div>` : emptyState('fa-calendar-xmark', 'No free slots', 'There are no free slots available to book right now.')}
      </div>`;
      const slotsByClass = {}; classes.forEach(c => { slotsByClass[c.id] = c.free_slots || []; });
      const clsSel = $('#bk-class', s), slotSel = $('#bk-slot', s);
      if (clsSel) clsSel.addEventListener('change', () => {
        const list = slotsByClass[clsSel.value] || [];
        slotSel.disabled = !list.length;
        slotSel.innerHTML = list.length ? list.map((sl, i) => `<option value="${i}">${DOW[sl.day_of_week]} · Period ${sl.period_no}</option>`).join('') : '<option value="">No free slots</option>';
      });
      if ($('#bk-submit', s)) $('#bk-submit', s).addEventListener('click', async () => {
        const cid = clsSel.value; const list = slotsByClass[cid] || []; const sl = list[Number(slotSel.value)];
        if (!cid || !sl) return UI.toast('Pick a class and free slot', 'warn');
        const btn = $('#bk-submit', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Requesting…';
        try {
          await api.post('/api/teacher/bookings', { class_id:Number(cid), subject_id:Number($('#bk-subject', s).value), day_of_week:sl.day_of_week, period_no:sl.period_no, date:$('#bk-date', s).value, reason:$('#bk-reason', s).value });
          UI.toast('Booking requested', 'ok'); Router.pop(); TeacherApp.booking();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = '<i class="fas fa-paper-plane"></i> Request slot'; }
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
        const btn = $('#cp-btn', s); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner spin"></i> Saving…';
        try { await api.put('/api/teacher/change-password', { current_password: $('#cp-cur', s).value, new_password: $('#cp-new', s).value });
          UI.toast('Password updated', 'ok'); Router.pop();
        } catch(err){ UI.toast(err.message, 'danger'); btn.disabled = false; btn.innerHTML = 'Update password'; }
      });
    });
  }
};

/* ── go ── */
boot();
