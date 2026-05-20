/* ═══════════════════════════════════════════════════════════════════════
   Joyland Admin · Shared shell + utilities
   Every /admin/*.html page links this file. It auto-injects:
     - <aside class="side"> sidebar (with active state from data-page)
     - <div class="topbar"> shared chrome
     - Slide-over helpers (Joy.openSlide / Joy.closeSlide)
     - Bulk-bar helpers (Joy.bulk.*)
     - Toast helpers (Joy.toast)
     - Command bar (⌘K)
     - Avatar palette / initials helpers
   Frontend-only. Backend wiring lives in per-page <script> blocks.
   ═══════════════════════════════════════════════════════════════════════ */
(function(){
  const Joy = window.Joy = window.Joy || {};

  /* ── Active page from <body data-page="..."> ──────────────────────── */
  const activePage = document.body.dataset.page || '';

  /* ── Nav config (single source of truth) ──────────────────────────── */
  const nav = [
    { label: 'Workspace', items: [
      { key:'overview',      href:'/admin/overview.html',     icon:'fa-chart-pie',   name:'Overview' },
      { key:'people',        href:'/admin/people.html',       icon:'fa-users',       name:'People',     countKey:'people' },
      { key:'classes',       href:'/admin/classes.html',      icon:'fa-chalkboard',  name:'Classes',    countKey:'classes' },
      { key:'subjects',      href:'/admin/subjects.html',     icon:'fa-book',        name:'Subjects' }
    ]},
    { label: 'Academic', items: [
      { key:'attendance',    href:'/admin/attendance.html',   icon:'fa-calendar-check', name:'Attendance' },
      { key:'marks',         href:'/admin/marks.html',        icon:'fa-clipboard-list', name:'Marks' },
      { key:'skills',        href:'/admin/skills.html',       icon:'fa-star',        name:'Skills' },
      { key:'assessments',   href:'/admin/assessments.html',  icon:'fa-file-pen',    name:'Assessments' },
      { key:'sessions',      href:'/admin/sessions.html',     icon:'fa-layer-group', name:'Sessions' },
      { key:'analysis',      href:'/admin/analysis.html',     icon:'fa-chart-area',  name:'Analysis' },
      { key:'reports',       href:'/admin/reports.html',      icon:'fa-file-alt',    name:'Reports' }
    ]},
    { label: 'School', items: [
      { key:'timetable',     href:'/admin/timetable.html',    icon:'fa-table-cells',  name:'Timetable' },
      { key:'notifications', href:'/admin/notifications.html',icon:'fa-bullhorn',    name:'Comms' },
      { key:'calendar',      href:'/admin/calendar.html',     icon:'fa-calendar',    name:'Calendar' },
      { key:'templates',     href:'/template-editor',         icon:'fa-pen-ruler',   name:'Templates' },
      { key:'settings',      href:'/admin/settings.html',     icon:'fa-cog',         name:'Settings' }
    ]}
  ];

  /* ── Inject sidebar ───────────────────────────────────────────────── */
  function buildSidebar(){
    const el = document.querySelector('[data-mount="side"]');
    if(!el) return;
    let html = `
      <div class="brand">
        <div class="brand-mark"><i class="fas fa-school"></i></div>
        <div class="brand-text">
          <div class="brand-name">Joyland</div>
          <div class="brand-sub">Operations</div>
        </div>
      </div>`;
    nav.forEach(group=>{
      html += `<div class="nav-section"><div class="nav-label">${group.label}</div>`;
      group.items.forEach(it=>{
        const active = it.key === activePage ? ' active' : '';
        const count = it.countKey
          ? `<span class="nav-count is-loading" data-count-key="${it.countKey}">—</span>`
          : (it.count ? `<span class="nav-count">${it.count}</span>` : '');
        html += `<a class="nav-item${active}" href="${it.href}"><i class="fas ${it.icon}"></i><span>${it.name}</span>${count}</a>`;
      });
      html += `</div>`;
    });
    html += `
      <div class="side-foot">
        <div class="ava" data-admin-ava>··</div>
        <div class="who">
          <div class="nm" data-admin-name>Loading…</div>
          <div class="rl" data-admin-role>Admin</div>
        </div>
        <i class="fas fa-ellipsis-v more"></i>
      </div>`;
    el.innerHTML = html;
  }

  /* ── Inject topbar ────────────────────────────────────────────────── */
  function buildTopbar(){
    const el = document.querySelector('[data-mount="topbar"]');
    if(!el) return;
    const crumb = el.dataset.crumb || (document.body.dataset.title || 'Workspace');
    el.classList.add('topbar');
    el.innerHTML = `
      <div class="crumb"><span class="now">${crumb}</span></div>
      <button class="cmdk" type="button" onclick="Joy.cmd.open()">
        <i class="fas fa-search"></i>
        <span class="placeholder">Search learners, classes, marks…</span>
        <span class="kbd">⌘K</span>
      </button>
      <button class="tb-btn" title="Notifications"><i class="far fa-bell"></i><span class="dot"></span></button>
      <button class="tb-btn" title="Help"><i class="far fa-circle-question"></i></button>
      <div class="tb-ava" data-admin-ava title="Loading…">··</div>
    `;
  }

  /* ── Load logged-in admin into header/footer slots ────────────────── */
  async function loadAdminIdentity(){
    try {
      const r = await fetch('/api/admin/profile', { credentials:'include' });
      if(!r.ok) return;
      const j = await r.json().catch(()=>({}));
      const u = j?.data;
      if(!u?.name) return;
      const name = String(u.name);
      const initials = name.trim().split(/\s+/).map(p=>p[0]||'').join('').slice(0,2).toUpperCase() || '··';
      const role = (u.role === 'admin' || u.is_admin) ? 'Admin' : (u.role || 'Staff');
      document.querySelectorAll('[data-admin-name]').forEach(el => { el.textContent = name; });
      document.querySelectorAll('[data-admin-role]').forEach(el => { el.textContent = role; });
      document.querySelectorAll('[data-admin-ava]').forEach(el => { el.textContent = initials; el.title = name; });
    } catch(_){ /* leave fallback in place */ }
  }

  /* ── Slide-over helpers ───────────────────────────────────────────── */
  Joy.openSlide  = (id) => { document.getElementById('shroud')?.classList.add('show'); document.getElementById(id)?.classList.add('show'); };
  Joy.closeSlide = ()   => { document.getElementById('shroud')?.classList.remove('show'); document.querySelectorAll('.slide.show').forEach(s=>s.classList.remove('show')); };

  /* ── Bulk-bar helpers ─────────────────────────────────────────────── */
  Joy.bulk = {
    show(count){
      const bar = document.getElementById('bulkBar');
      if(!bar) return;
      bar.classList.add('show');
      const cEl = bar.querySelector('.bulk-count span');
      if(cEl) cEl.textContent = count;
    },
    hide(){ document.getElementById('bulkBar')?.classList.remove('show'); },
    update(count){
      if(count > 0) this.show(count);
      else this.hide();
    }
  };

  /* ── Toasts ───────────────────────────────────────────────────────── */
  function ensureToastStack(){
    let s = document.getElementById('toastStack');
    if(!s){ s = document.createElement('div'); s.id = 'toastStack'; s.className = 'toast-stack'; document.body.appendChild(s); }
    return s;
  }
  Joy.toast = (msg, opts={}) => {
    const stack = ensureToastStack();
    const t = document.createElement('div');
    t.className = `toast ${opts.type || ''}`;
    const icon = opts.type === 'warn' ? 'fa-triangle-exclamation'
              : opts.type === 'danger' ? 'fa-circle-xmark'
              : 'fa-circle-check';
    t.innerHTML = `<i class="fas ${icon} lead"></i><span>${msg}</span>`;
    stack.appendChild(t);
    requestAnimationFrame(()=>t.classList.add('show'));
    setTimeout(()=>{
      t.classList.remove('show');
      setTimeout(()=>t.remove(), 250);
    }, opts.duration || 3500);
  };

  /* ── Command bar (⌘K) ─────────────────────────────────────────────── */
  function buildCmdOverlay(){
    if(document.getElementById('cmdOverlay')) return;
    const flat = [];
    nav.forEach(g => g.items.forEach(it => flat.push(it)));
    let html = `
      <div class="cmd-panel" onclick="event.stopPropagation()">
        <div class="cmd-input-wrap">
          <i class="fas fa-search"></i>
          <input class="cmd-input" id="cmdInput" placeholder="Jump to learner, class, mark, action…" autocomplete="off"/>
          <span class="kbd" style="font-family:var(--mono);font-size:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:1.5px 6px;color:var(--ink-2);">ESC</span>
        </div>
        <div class="cmd-list">
          <div class="cmd-group">
            <div class="cmd-group-label">Quick actions</div>
            <a class="cmd-item" href="/admin/people.html?add=1"><i class="fas fa-user-plus"></i><span class="lbl">Add learner</span><span class="meta">⌘+N</span></a>
            <a class="cmd-item" href="/admin/marks.html"><i class="fas fa-pen"></i><span class="lbl">Enter marks</span><span class="meta">⌘+M</span></a>
            <a class="cmd-item" href="/admin/attendance.html"><i class="fas fa-calendar-check"></i><span class="lbl">Mark attendance</span><span class="meta">⌘+A</span></a>
            <a class="cmd-item" href="/admin/notifications.html?compose=1"><i class="fas fa-bullhorn"></i><span class="lbl">Broadcast to parents</span><span class="meta">⌘+B</span></a>
          </div>
          <div class="cmd-group">
            <div class="cmd-group-label">Jump to</div>
            ${flat.map(it=>`<a class="cmd-item" href="${it.href}"><i class="fas ${it.icon}"></i><span class="lbl">${it.name}</span></a>`).join('')}
          </div>
        </div>
      </div>`;
    const ov = document.createElement('div');
    ov.id = 'cmdOverlay';
    ov.className = 'cmd-overlay';
    ov.innerHTML = html;
    ov.addEventListener('click', () => Joy.cmd.close());
    document.body.appendChild(ov);

    // simple filter
    const input = ov.querySelector('#cmdInput');
    input.addEventListener('input', () => {
      const q = input.value.toLowerCase().trim();
      ov.querySelectorAll('.cmd-item').forEach(item => {
        const txt = item.querySelector('.lbl').textContent.toLowerCase();
        item.style.display = !q || txt.includes(q) ? '' : 'none';
      });
    });
  }
  Joy.cmd = {
    open(){
      buildCmdOverlay();
      document.getElementById('cmdOverlay')?.classList.add('show');
      setTimeout(()=>document.getElementById('cmdInput')?.focus(), 80);
    },
    close(){ document.getElementById('cmdOverlay')?.classList.remove('show'); }
  };

  /* ── Avatar helpers ───────────────────────────────────────────────── */
  const palettes = [
    ['#3b82f6','#2563eb'], ['#8b5cf6','#7c3aed'], ['#10b981','#059669'],
    ['#f59e0b','#d97706'], ['#ec4899','#be185d'], ['#14b8a6','#0f766e'],
    ['#06b6d4','#0e7490'], ['#f43f5e','#dc2626']
  ];
  Joy.initials = (name='') => {
    const parts = name.trim().split(/\s+/);
    if(parts.length === 1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0] + parts[parts.length-1][0]).toUpperCase();
  };
  Joy.hashIdx = (s='') => {
    let h = 0;
    for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
    return h % palettes.length;
  };
  Joy.avaStyle = (name='') => {
    const [a,b] = palettes[Joy.hashIdx(name)];
    return `background:linear-gradient(135deg,${a},${b});`;
  };

  /* ── Number tick-up ───────────────────────────────────────────────── */
  Joy.tickUp = (el, to, opts={}) => {
    if(!el) return;
    const dur = opts.duration || 900;
    const start = performance.now();
    const from = opts.from ?? 0;
    const suffix = opts.suffix || '';
    const decimals = opts.decimals ?? 0;
    function step(t){
      const p = Math.min(1, (t - start)/dur);
      const eased = 1 - Math.pow(1-p, 3);
      const v = from + (to - from) * eased;
      el.textContent = v.toFixed(decimals) + suffix;
      if(p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };

  Joy.api = async (url, opts={}) => {
    const r = await fetch(url, { credentials:'include', ...opts });
    const j = await r.json().catch(() => ({}));
    if(!r.ok || j.success === false) throw new Error(j.message || j.error || `HTTP ${r.status}`);
    return j.data !== undefined ? j.data : j;
  };

  Joy.refreshSidebarCounts = async () => {
    try{
      const stats = await Joy.api('/api/admin/stats');
      const people = Number(stats.people ?? (
        Number(stats.learners || 0) + Number(stats.teachers || 0) + Number(stats.parents || 0) + Number(stats.admins || 0)
      ));
      const values = { people, classes:Number(stats.classes || 0) };
      Object.entries(values).forEach(([key,value]) => {
        document.querySelectorAll(`.nav-count[data-count-key="${key}"]`).forEach(el => {
          el.textContent = value;
          el.classList.remove('is-loading');
        });
      });
      return values;
    }catch(err){
      console.warn('Sidebar counts unavailable', err);
      return null;
    }
  };

  Joy.hasActiveFloatingWork = () => {
    const active = document.activeElement;
    if(active && (
      ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)
      || active.isContentEditable
    )) return true;
    return !!document.querySelector([
      '.slide.show',
      '.cmd-overlay.show',
      '.bulk-bar.show',
      '.ch-popover',
      '.popover.show',
      '.modal.show',
      '[data-floating="true"]',
      '[aria-modal="true"]'
    ].join(','));
  };

  Joy.startLiveRefresh = () => {
    if(!window.EventSource || Joy._liveRefreshSource) return;
    const source = new EventSource('/api/events');
    source.addEventListener('portal-update', (event) => {
      let payload = {};
      try { payload = JSON.parse(event.data || '{}'); } catch(_){}
      if(payload.kind !== 'dev-refresh') return;
      if(Joy.hasActiveFloatingWork()){
        Joy.toast('Page update ready. Finish this edit, then refresh.', { type:'warn', duration:5000 });
        return;
      }
      Joy.toast('Refreshing this page...', { type:'', duration:1200 });
      setTimeout(() => window.location.reload(), 650);
    });
    source.onerror = () => {
      // EventSource reconnects automatically after server restarts.
    };
    Joy._liveRefreshSource = source;
  };

  /* ── Global keybindings ───────────────────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
      e.preventDefault(); Joy.cmd.open();
    }
    if(e.key === 'Escape'){
      Joy.cmd.close();
      Joy.closeSlide();
    }
  });

  /* ── Boot ─────────────────────────────────────────────────────────── */
  function boot(){
    buildSidebar();
    buildTopbar();
    loadAdminIdentity();
    Joy.refreshSidebarCounts();
    Joy.startLiveRefresh();
    // Wire up any shroud on the page
    document.getElementById('shroud')?.addEventListener('click', Joy.closeSlide);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
