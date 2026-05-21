/* 
   Joyland Admin  Shared shell + utilities
   Every /admin/*.html page links this file. It auto-injects:
     - <aside class="side"> sidebar (with active state from data-page)
     - <div class="topbar"> shared chrome
     - Slide-over helpers (Joy.openSlide / Joy.closeSlide)
     - Bulk-bar helpers (Joy.bulk.*)
     - Toast helpers (Joy.toast)
     - Command bar (K)
     - Avatar palette / initials helpers
   Frontend-only. Backend wiring lives in per-page <script> blocks.
    */
(function(){
  const Joy = window.Joy = window.Joy || {};

  /*  Active page from <body data-page="...">  */
  const activePage = document.body.dataset.page || '';

  /*  Nav config (single source of truth)  */
  const nav = [
    { label: 'Overview', items: [
      { key:'overview',      href:'/admin/overview.html',     icon:'fa-chart-pie',   name:'Overview' },
      { key:'people',        href:'/admin/people.html',       icon:'fa-users',       name:'People',     countKey:'people' },
      { key:'classes',       href:'/admin/classes.html',      icon:'fa-chalkboard',  name:'Classes',    countKey:'classes' },
      { key:'subjects',      href:'/admin/subjects.html',     icon:'fa-book',        name:'Learning areas' }
    ]},
    { label: 'Learning records', items: [
      { key:'attendance',    href:'/admin/attendance.html',   icon:'fa-calendar-check', name:'Attendance' },
      { key:'marks',         href:'/admin/marks.html',        icon:'fa-clipboard-list', name:'Assessment results' },
      { key:'skills',        href:'/admin/skills.html',       icon:'fa-star',        name:'Learner development' },
      { key:'assessments',   href:'/admin/assessments.html',  icon:'fa-file-pen',    name:'Assessments' },
      { key:'sessions',      href:'/admin/sessions.html',     icon:'fa-layer-group', name:'School year' },
      { key:'analysis',      href:'/admin/analysis.html',     icon:'fa-chart-area',  name:'Insights' },
      { key:'reports',       href:'/admin/reports.html',      icon:'fa-file-alt',    name:'Reports' }
    ]},
    { label: 'Operations', items: [
      { key:'timetable',     href:'/admin/timetable.html',    icon:'fa-table-cells',  name:'Timetable' },
      { key:'notifications', href:'/admin/notifications.html',icon:'fa-bullhorn',    name:'Messages' },
      { key:'calendar',      href:'/admin/calendar.html',     icon:'fa-calendar',    name:'Calendar' },
      { key:'templates',     href:'/template-editor',         icon:'fa-pen-ruler',   name:'Report templates' },
      { key:'settings',      href:'/admin/settings.html',     icon:'fa-cog',         name:'Settings' }
    ]}
  ];

  /*  Inject sidebar  */
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
          ? `<span class="nav-count is-loading" data-count-key="${it.countKey}">--</span>`
          : (it.count ? `<span class="nav-count">${it.count}</span>` : '');
        html += `<a class="nav-item${active}" href="${it.href}" title="${it.name}" aria-label="${it.name}"><i class="fas ${it.icon}"></i><span>${it.name}</span>${count}</a>`;
      });
      html += `</div>`;
    });
    html += `
      <div class="side-foot">
        <div class="ava" data-admin-ava>--</div>
        <div class="who">
          <div class="nm" data-admin-name>Loading</div>
          <div class="rl" data-admin-role>Admin</div>
        </div>
        <i class="fas fa-ellipsis-v more"></i>
      </div>`;
    el.innerHTML = html;
  }

  /*  Inject topbar  */
  function buildTopbar(){
    const el = document.querySelector('[data-mount="topbar"]');
    if(!el) return;
    const crumb = el.dataset.crumb || (document.body.dataset.title || 'Workspace');
    el.classList.add('topbar');
    el.innerHTML = `
      <div class="crumb"><span class="now">${crumb}</span></div>
      <button class="cmdk" type="button" onclick="Joy.cmd.open()">
        <i class="fas fa-search"></i>
        <span class="placeholder">Search learners, classes, results or actions...</span>
        <span class="kbd">Ctrl K</span>
      </button>
      <a class="tb-btn" href="/admin/notifications.html" aria-label="Open messages" title="Open messages"><i class="far fa-bell"></i><span class="dot"></span></a>
      <a class="tb-btn" href="/admin/settings.html" aria-label="Open settings" title="Open settings"><i class="fas fa-gear"></i></a>
      <div class="tb-ava" data-admin-ava title="Loading">--</div>
    `;
  }

  /*  Load logged-in admin into header/footer slots  */
  async function loadAdminIdentity(){
    try {
      const r = await fetch('/api/admin/profile', { credentials:'include' });
      if(!r.ok) return;
      const j = await r.json().catch(()=>({}));
      const u = j?.data;
      if(!u?.name) return;
      const name = String(u.name);
      const initials = name.trim().split(/\s+/).map(p=>p[0]||'').join('').slice(0,2).toUpperCase() || '--';
      const role = (u.role === 'admin' || u.is_admin) ? 'Admin' : (u.role || 'Staff');
      document.querySelectorAll('[data-admin-name]').forEach(el => { el.textContent = name; });
      document.querySelectorAll('[data-admin-role]').forEach(el => { el.textContent = role; });
      document.querySelectorAll('[data-admin-ava]').forEach(el => { el.textContent = initials; el.title = name; });
    } catch(_){ /* leave fallback in place */ }
  }

  /*  Focus trap — shared by the command menu and slide-overs.
      (Joy.confirm/choice/input dialogs carry their own equivalent trap.)
      Returns release(): detaches the Tab handler and restores prior focus. */
  Joy.trapFocus = (container, opts = {}) => {
    if(!container) return () => {};
    const SEL = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const previous = document.activeElement;
    const focusables = () => Array.from(container.querySelectorAll(SEL)).filter(el => el.offsetParent !== null);
    const onKey = (e) => {
      if(e.key !== 'Tab') return;
      const f = focusables();
      if(!f.length){ e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if(!container.contains(document.activeElement)){ e.preventDefault(); first.focus(); return; }
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    };
    container.addEventListener('keydown', onKey);
    const init = typeof opts.initial === 'string' ? container.querySelector(opts.initial) : opts.initial;
    setTimeout(() => { (init || focusables()[0] || container)?.focus?.(); }, opts.delay ?? 0);
    return () => {
      container.removeEventListener('keydown', onKey);
      if(opts.restoreFocus !== false && previous && typeof previous.focus === 'function') previous.focus();
    };
  };

  /*  Slide-over helpers  */
  Joy.openSlide  = (id) => {
    document.getElementById('shroud')?.classList.add('show');
    const el = document.getElementById(id);
    if(!el) return;
    el.classList.add('show');
    Joy._slideRelease?.();
    Joy._slideRelease = Joy.trapFocus(el, { delay: 60 });
  };
  Joy.closeSlide = () => {
    document.getElementById('shroud')?.classList.remove('show');
    document.querySelectorAll('.slide.show').forEach(s => s.classList.remove('show'));
    Joy._slideRelease?.(); Joy._slideRelease = null;
  };

  /*  Bulk-bar helpers  */
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

  /*  Toasts  */
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

  /*  Command bar (K)  */
  function buildCmdOverlay(){
    if(document.getElementById('cmdOverlay')) return;
    const flat = [];
    nav.forEach(g => g.items.forEach(it => flat.push(it)));
    let html = `
      <div class="cmd-panel" onclick="event.stopPropagation()">
        <div class="cmd-input-wrap">
          <i class="fas fa-search"></i>
          <input class="cmd-input" id="cmdInput" placeholder="Jump to a learner, class, result or action..." autocomplete="off"/>
          <span class="kbd" style="font-family:var(--mono);font-size:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:5px;padding:1.5px 6px;color:var(--ink-2);">Esc</span>
        </div>
        <div class="cmd-list">
          <div class="cmd-group">
            <div class="cmd-group-label">Quick actions</div>
            <a class="cmd-item" href="/admin/people.html?add=1"><i class="fas fa-user-plus"></i><span class="lbl">Add learner</span><span class="meta">Ctrl N</span></a>
            <a class="cmd-item" href="/admin/marks.html"><i class="fas fa-pen"></i><span class="lbl">Enter assessment results</span><span class="meta">Ctrl M</span></a>
            <a class="cmd-item" href="/admin/attendance.html"><i class="fas fa-calendar-check"></i><span class="lbl">Record attendance</span><span class="meta">Ctrl A</span></a>
            <a class="cmd-item" href="/admin/notifications.html?compose=1"><i class="fas fa-bullhorn"></i><span class="lbl">Send message to parents</span><span class="meta">Ctrl B</span></a>
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
      const ov = document.getElementById('cmdOverlay');
      ov?.classList.add('show');
      Joy._cmdRelease?.();
      Joy._cmdRelease = Joy.trapFocus(ov, { initial:'#cmdInput', delay:80 });
    },
    close(){
      document.getElementById('cmdOverlay')?.classList.remove('show');
      Joy._cmdRelease?.(); Joy._cmdRelease = null;
    }
  };

  /*  Avatar helpers  */
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

  /*  Number tick-up  */
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

  function htmlEscape(v){
    return String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  Joy.emptyState = (opts={}) => {
    const icon = opts.icon || 'fa-circle-info';
    const title = opts.title || 'Nothing to show yet';
    const message = opts.message || 'Records will appear here when they are available.';
    const action = opts.actionHref && opts.actionLabel
      ? '<a class="btn btn-primary" href="' + htmlEscape(opts.actionHref) + '"><i class="fas fa-arrow-right"></i>' + htmlEscape(opts.actionLabel) + '</a>'
      : '';
    return '<div class="empty"><div class="ill"><i class="fas ' + htmlEscape(icon) + '"></i></div>' +
      '<div class="et">' + htmlEscape(title) + '</div><div class="ed">' + htmlEscape(message) + '</div>' + action + '</div>';
  };

  Joy.freshnessBadge = (label='Live record', tone='ok') => {
    const icon = tone === 'warn' ? 'fa-triangle-exclamation' : tone === 'danger' ? 'fa-circle-xmark' : 'fa-circle-check';
    return '<span class="freshness ' + htmlEscape(tone) + '"><i class="fas ' + icon + '"></i>' + htmlEscape(label) + '</span>';
  };

  Joy.statusBanner = (opts={}) => {
    const tone = opts.tone || 'info';
    const icon = opts.icon || (tone === 'warn' ? 'fa-circle-info' : tone === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-check');
    const action = opts.actionHref && opts.actionLabel
      ? '<a class="cta" href="' + htmlEscape(opts.actionHref) + '"><i class="fas fa-arrow-right"></i>' + htmlEscape(opts.actionLabel) + '</a>'
      : '';
    return '<div class="op-banner ' + htmlEscape(tone) + '"><i class="fas ' + htmlEscape(icon) + '"></i><span><b>' +
      htmlEscape(opts.title || 'Status') + '</b>' + (opts.message ? ' ' + htmlEscape(opts.message) : '') + '</span>' + action + '</div>';
  };

  Joy.actionQueue = (items=[]) => {
    if(!items.length) return Joy.emptyState({
      icon:'fa-list-check',
      title:'No priority actions',
      message:'Operational follow-ups will appear here when attendance, results or support data need attention.'
    });
    return '<div class="action-queue">' + items.map(item => {
      const tone = item.tone || 'info';
      const icon = item.icon || (tone === 'ok' ? 'fa-circle-check' : tone === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-info');
      const href = item.href || '#';
      return '<a class="action-item ' + htmlEscape(tone) + '" href="' + htmlEscape(href) + '">' +
        '<span class="action-ico"><i class="fas ' + htmlEscape(icon) + '"></i></span>' +
        '<span class="action-copy"><span class="action-title">' + htmlEscape(item.title || 'Review item') + '</span>' +
        '<span class="action-meta">' + htmlEscape(item.meta || '') + '</span></span>' +
        '<span class="action-arrow"><i class="fas fa-arrow-right"></i></span></a>';
    }).join('') + '</div>';
  };

  function openDecisionDialog(opts={}, mode='confirm'){
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const shroud = document.createElement('div');
      shroud.className = 'joy-modal-shroud show';
      shroud.setAttribute('role', 'presentation');
      const tone = opts.tone || 'default';
      const icon = opts.icon || (tone === 'danger' ? 'fa-triangle-exclamation' : 'fa-circle-info');
      const options = Array.isArray(opts.options) ? opts.options : [];
      const selected = opts.value ?? options[0]?.value ?? '';
      const choices = mode === 'choice'
        ? '<div class="joy-choice-list" role="radiogroup">' + options.map((o, i) => {
            const value = o.value ?? o.label ?? String(i);
            return '<label class="joy-choice"><input type="radio" name="joyChoice" value="' + htmlEscape(value) + '"' + (String(value) === String(selected) ? ' checked' : '') + '>' +
              '<span><b>' + htmlEscape(o.label || value) + '</b>' + (o.description ? '<small>' + htmlEscape(o.description) + '</small>' : '') + '</span></label>';
          }).join('') + '</div>'
        : '';
      const input = mode === 'input'
        ? '<div class="joy-input-wrap"><input class="input joy-input" id="joyDialogInput" value="' + htmlEscape(opts.value || '') + '" placeholder="' + htmlEscape(opts.placeholder || '') + '" autocomplete="off"/></div>'
        : '';
      shroud.innerHTML = '<div class="joy-dialog ' + htmlEscape(tone) + '" role="dialog" aria-modal="true" aria-labelledby="joyDialogTitle">' +
        '<div class="joy-dialog-head"><span class="joy-dialog-icon"><i class="fas ' + icon + '"></i></span><div>' +
        '<div class="joy-dialog-title" id="joyDialogTitle">' + htmlEscape(opts.title || 'Confirm action') + '</div>' +
        '<div class="joy-dialog-copy">' + htmlEscape(opts.message || 'Do you want to continue?') + '</div></div></div>' +
        choices + input +
        '<div class="joy-dialog-actions"><button class="btn" type="button" data-dialog="cancel">' + htmlEscape(opts.cancelLabel || 'Cancel') + '</button>' +
        '<button class="btn btn-primary" type="button" data-dialog="confirm">' + htmlEscape(opts.actionLabel || 'Confirm') + '</button></div></div>';

      const close = result => {
        shroud.classList.remove('show');
        Joy._modalClose = null;
        setTimeout(() => shroud.remove(), 180);
        if(previousFocus && previousFocus.focus) previousFocus.focus();
        resolve(result);
      };
      const cancelValue = (mode === 'choice' || mode === 'input') ? null : false;
      Joy._modalClose = () => close(cancelValue);
      shroud.addEventListener('click', e => { if(e.target === shroud) close(cancelValue); });
      shroud.querySelector('[data-dialog="cancel"]').addEventListener('click', () => close(cancelValue));
      shroud.querySelector('[data-dialog="confirm"]').addEventListener('click', () => {
        if(mode === 'choice'){
          const picked = shroud.querySelector('input[name="joyChoice"]:checked');
          close(picked ? picked.value : null);
          return;
        }
        if(mode === 'input'){
          close(shroud.querySelector('#joyDialogInput')?.value ?? '');
          return;
        }
        close(true);
      });
      shroud.addEventListener('keydown', e => {
        if(e.key !== 'Tab') return;
        const focusable = Array.from(shroud.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])'))
          .filter(el => !el.disabled && el.offsetParent !== null);
        if(!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if(e.shiftKey && document.activeElement === first){
          e.preventDefault();
          last.focus();
        } else if(!e.shiftKey && document.activeElement === last){
          e.preventDefault();
          first.focus();
        }
      });
      document.body.appendChild(shroud);
      shroud.querySelector('#joyDialogInput')?.addEventListener('keydown', e => {
        if(e.key === 'Enter') shroud.querySelector('[data-dialog="confirm"]')?.click();
      });
      setTimeout(() => (shroud.querySelector('#joyDialogInput') || shroud.querySelector('[data-dialog="confirm"]'))?.focus(), 40);
    });
  }

  Joy.confirm = opts => openDecisionDialog(opts, 'confirm');
  Joy.choice = opts => openDecisionDialog(opts, 'choice');
  Joy.input = opts => openDecisionDialog(opts, 'input');

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

  /*  Topbar unread indicator — driven by real unread count, not always-on.
      On any failure the dot stays hidden (no misleading indicator). */
  Joy.refreshUnreadBadge = async () => {
    try{
      const data = await Joy.api('/api/notifications/unread-count');
      const n = Number(data?.unread_count || 0);
      document.querySelectorAll('.tb-btn .dot').forEach(d => d.classList.toggle('show', n > 0));
      const bell = document.querySelector('.topbar a[href="/admin/notifications.html"]');
      if(bell){
        const lbl = n > 0 ? `Open messages (${n} unread)` : 'Open messages';
        bell.setAttribute('aria-label', lbl);
        bell.setAttribute('title', lbl);
      }
      return n;
    }catch(err){
      console.warn('Unread count unavailable', err);
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

  /*  Global keybindings  */
  document.addEventListener('keydown', (e) => {
    if((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'){
      e.preventDefault(); Joy.cmd.open();
    }
    if(e.key === 'Escape'){
      if(Joy._modalClose){ Joy._modalClose(); return; }
      Joy.cmd.close();
      Joy.closeSlide();
    }
  });

  /*  Accessibility: give icon-only controls an accessible name.
      Idempotent — safe to re-run after a page renders dynamic content
      (call Joy.enhanceA11y(container) after injecting new buttons). */
  function enhanceA11y(root){
    root = root || document;
    // Slide-over close buttons are icon-only and have no tooltip — name them directly.
    root.querySelectorAll('.slide-close:not([aria-label])').forEach(b => b.setAttribute('aria-label', 'Close panel'));
    // For any other icon-only control, mirror its title into the accessibility tree
    // (title alone is unreliable for screen readers / touch).
    root.querySelectorAll('button:not([aria-label]), a[href]:not([aria-label]), [role="button"]:not([aria-label])').forEach(el => {
      if((el.textContent || '').trim()) return;   // already has a visible text label
      if(!el.querySelector('i, svg')) return;      // not an icon-only control
      const title = el.getAttribute('title');
      if(title) el.setAttribute('aria-label', title);
    });
  }
  Joy.enhanceA11y = enhanceA11y;

  /*  Boot  */
  function boot(){
    buildSidebar();
    buildTopbar();
    loadAdminIdentity();
    Joy.refreshSidebarCounts();
    Joy.refreshUnreadBadge();
    Joy.startLiveRefresh();
    enhanceA11y();
    // Wire up any shroud on the page
    document.getElementById('shroud')?.addEventListener('click', Joy.closeSlide);
  }
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();

