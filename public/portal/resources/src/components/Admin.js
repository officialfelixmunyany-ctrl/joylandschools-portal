import { AUDIENCES, LEVELS, RESOURCE_TYPES, SUBJECTS } from '../config.js';
import { escapeHtml } from '../utils/dom.js';

const VISIBILITIES = [
  ['public', 'Public'],
  ['registered', 'Registered users'],
  ['premium', 'Premium'],
  ['school_only', 'School only'],
  ['private', 'Private']
];

const ADMIN_AUDIENCES = [
  { id: 'everyone', label: 'Everyone' },
  ...AUDIENCES.filter(item => item.id !== 'all')
];

const STAT_LABELS = {
  views: 'Views',
  downloads: 'Downloads',
  published: 'Published',
  draft: 'Draft'
};

export function AdminLogin({ error = '', checking = false } = {}) {
  const disabled = checking ? 'disabled' : '';
  return `
    <div class="admin-auth">
      <div class="admin-auth-bg" aria-hidden="true">
        <span class="aa-aurora aa-aurora-1"></span>
        <span class="aa-aurora aa-aurora-2"></span>
        <span class="aa-grid"></span>
        <span class="aa-scan"></span>
      </div>
      <div class="admin-auth-center">
        <a class="admin-auth-back" href="#/">&larr; Back to resources</a>
        <form class="admin-auth-card" id="resource-admin-login" autocomplete="on">
          <div class="admin-auth-badge"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i></div>
          <span class="admin-auth-eyebrow">Civicom &middot; Secure area</span>
          <h1>Admin sign in</h1>
          <p>Restricted console for managing the learning library.</p>
          <label class="admin-auth-field">
            <span>Username</span>
            <input name="username" type="text" value="admin" autocomplete="username" ${disabled} required />
          </label>
          <label class="admin-auth-field">
            <span>Password</span>
            <input name="password" type="password" autocomplete="current-password" placeholder="Enter password" ${disabled} required />
          </label>
          ${error ? `<div class="admin-auth-alert">${escapeHtml(error)}</div>` : ''}
          <button class="admin-auth-btn" type="submit" ${disabled}>${checking ? 'Verifying...' : 'Enter console'}</button>
          <p class="admin-auth-foot"><i class="fa-solid fa-lock" aria-hidden="true"></i> Encrypted session &middot; authorized personnel only</p>
        </form>
      </div>
    </div>
  `;
}

export function AdminDashboard(state = {}) {
  const tab = state.tab || 'resources';
  return `
    <section class="admin-page admin-dashboard">
      <div class="admin-top">
        <div>
          <a class="back-link" href="#/">&larr; Back to resources</a>
          <span class="eyebrow">Resource database</span>
          <h1>Resource admin dashboard</h1>
          <p>Uploads and reviews are saved in <b>resource_database.db</b>.</p>
        </div>
        <div class="admin-top-actions">
          <button class="secondary-btn" type="button" data-admin-action="refresh">Refresh</button>
          <button class="secondary-btn" type="button" data-admin-action="logout">Logout</button>
        </div>
      </div>

      ${state.error ? `<div class="admin-alert error">${escapeHtml(state.error)}</div>` : ''}
      ${state.loading ? `<div class="admin-alert">Loading admin data...</div>` : ''}

      <div class="admin-stats">
        ${['published', 'draft', 'downloads', 'views'].map(key => `
          <article>
            <span>${STAT_LABELS[key]}</span>
            <strong>${Number(state.analytics?.[key] || 0).toLocaleString()}</strong>
          </article>
        `).join('')}
      </div>

      <nav class="admin-tabs" aria-label="Resource admin sections">
        ${adminTabButton('resources', 'Resources', tab)}
        ${adminTabButton('upload', state.editing ? 'Edit resource' : 'Upload resource', tab)}
        ${adminTabButton('submissions', `Submissions (${(state.submissions || []).length})`, tab)}
        ${adminTabButton('analytics', 'Analytics', tab)}
      </nav>

      <div class="admin-panel">
        ${tab === 'upload'
          ? resourceForm(state.editing)
          : tab === 'submissions'
            ? submissionsPanel(state.submissions || [])
            : tab === 'analytics'
              ? analyticsPanel(state.analytics || {})
              : resourcesPanel(state)}
      </div>
    </section>
  `;
}

function adminTabButton(id, label, active) {
  return `<button type="button" class="${active === id ? 'active' : ''}" data-admin-tab="${id}">${escapeHtml(label)}</button>`;
}

function resourcesPanel(state) {
  const resources = state.resources || [];
  return `
    <div class="admin-panel-head">
      <div>
        <h2>Resources</h2>
        <p>${resources.length.toLocaleString()} items loaded.</p>
      </div>
      <button class="primary-btn" type="button" data-admin-action="new-resource">Add resource</button>
    </div>
    <form class="admin-search" id="admin-resource-search">
      <input name="q" type="search" value="${escapeHtml(state.query || '')}" placeholder="Search title, subject, grade, type or year" />
      <button class="secondary-btn" type="submit">Search</button>
    </form>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Class</th>
            <th>Type</th>
            <th>Status</th>
            <th>File</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${resources.length ? resources.map(resourceRow).join('') : `<tr><td colspan="6" class="admin-empty">No resources found.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function resourceRow(resource) {
  const id = Number(resource.id || 0);
  const fileUrl = resource.file_path || resource.fileUrl || '';
  return `
    <tr>
      <td>
        <strong>${escapeHtml(resource.title || 'Untitled resource')}</strong>
        <span>${escapeHtml(resource.subject || 'General')}${resource.year ? ` - ${escapeHtml(resource.year)}` : ''}</span>
      </td>
      <td>${escapeHtml(resource.grade || resource.level || 'General')}</td>
      <td>${typeLabel(resource.type)}</td>
      <td><span class="admin-status ${escapeHtml(resource.status || 'published')}">${escapeHtml(resource.status || 'published')}</span></td>
      <td>${fileUrl ? `<a href="${escapeHtml(fileUrl)}" target="_blank" rel="noopener">Open</a>` : '<span class="muted">Read online</span>'}</td>
      <td>
        <button class="link-btn" type="button" data-admin-edit="${id}">Edit</button>
        <button class="link-btn danger" type="button" data-admin-archive="${id}">Archive</button>
      </td>
    </tr>
  `;
}

function resourceForm(resource = null) {
  const editing = Boolean(resource?.id);
  return `
    <form class="admin-form" id="admin-resource-form" data-resource-id="${editing ? Number(resource.id) : ''}">
      <div class="admin-panel-head">
        <div>
          <h2>${editing ? 'Edit resource' : 'Upload resource'}</h2>
          <p>${editing ? 'Update details or replace the file.' : 'Create a new public library item.'}</p>
        </div>
        ${editing ? '<button class="secondary-btn" type="button" data-admin-action="new-resource">New instead</button>' : ''}
      </div>

      <div class="admin-form-grid">
        <label class="field wide">
          <span>Title</span>
          <input name="title" type="text" value="${escapeHtml(resource?.title || '')}" placeholder="Grade 9 Agriculture Paper 1" required />
        </label>
        <label class="field">
          <span>Type</span>
          <select name="type" required>${optionsFrom(RESOURCE_TYPES.filter(item => item.id !== 'all'), resource?.type)}</select>
        </label>
        <label class="field">
          <span>Subject</span>
          <input name="subject" list="admin-subjects" value="${escapeHtml(resource?.subject || '')}" placeholder="Agriculture" required />
        </label>
        <label class="field">
          <span>Grade/Form</span>
          <input name="grade" type="text" value="${escapeHtml(resource?.grade || '')}" placeholder="Grade 9 or Form 4" required />
        </label>
        <label class="field">
          <span>Year</span>
          <input name="year" type="number" min="1990" max="2035" value="${escapeHtml(resource?.year || '')}" placeholder="2026" />
        </label>
        <label class="field">
          <span>Level</span>
          <select name="level">${optionsFrom(LEVELS.filter(item => item.id !== 'all'), resource?.level)}</select>
        </label>
        <label class="field">
          <span>Audience</span>
          <select name="audience">${optionsFrom(ADMIN_AUDIENCES, resource?.audience || 'everyone')}</select>
        </label>
        <label class="field">
          <span>Status</span>
          <select name="status">${basicOptions([['published', 'Published'], ['draft', 'Draft'], ['archived', 'Archived']], resource?.status || 'published')}</select>
        </label>
        <label class="field">
          <span>Visibility</span>
          <select name="visibility">${basicOptions(VISIBILITIES, resource?.visibility || 'public')}</select>
        </label>
        <label class="field">
          <span>Tags</span>
          <input name="tags" type="text" value="${escapeHtml(tagsValue(resource))}" placeholder="KCSE, Term 2, Agriculture" />
        </label>
        <label class="field wide">
          <span>File ${editing ? 'optional' : ''}</span>
          <input name="file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.webp" ${editing ? '' : 'required'} />
          ${resource?.file_path ? `<small>Current file: ${escapeHtml(resource.file_path)}</small>` : ''}
        </label>
        <label class="field wide">
          <span>Read-online body</span>
          <textarea name="body_html" rows="5" placeholder="Short description or HTML shown before opening the file">${escapeHtml(resource?.body_html || resource?.body || '')}</textarea>
        </label>
      </div>

      <datalist id="admin-subjects">${SUBJECTS.map(subject => `<option value="${escapeHtml(subject)}"></option>`).join('')}</datalist>

      <div class="admin-checks">
        <label><input name="is_featured" type="checkbox" ${resource?.is_featured ? 'checked' : ''} /> Featured</label>
        <label><input name="is_verified" type="checkbox" ${resource?.is_verified ?? true ? 'checked' : ''} /> Verified</label>
        <label><input name="premium" type="checkbox" ${resource?.premium ? 'checked' : ''} /> Premium</label>
      </div>

      <div class="admin-form-actions">
        <button class="primary-btn" type="submit">${editing ? 'Save changes' : 'Upload resource'}</button>
        <button class="secondary-btn" type="button" data-admin-tab="resources">Cancel</button>
      </div>
    </form>
  `;
}

function submissionsPanel(submissions) {
  return `
    <div class="admin-panel-head">
      <div>
        <h2>Submissions</h2>
        <p>Files shared from the public portal for review.</p>
      </div>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Submission</th>
            <th>Class</th>
            <th>Status</th>
            <th>File</th>
            <th>Review</th>
          </tr>
        </thead>
        <tbody>
          ${submissions.length ? submissions.map(submissionRow).join('') : `<tr><td colspan="5" class="admin-empty">No submissions yet.</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
}

function submissionRow(item) {
  return `
    <tr>
      <td>
        <strong>${escapeHtml(item.title || item.filename || 'Submitted resource')}</strong>
        <span>${escapeHtml(item.subject || 'General')} - ${typeLabel(item.type)}</span>
      </td>
      <td>${escapeHtml(item.grade || item.level || 'General')}</td>
      <td><span class="admin-status ${escapeHtml(item.status || 'pending')}">${escapeHtml(item.status || 'pending')}</span></td>
      <td>${item.file_path ? `<a href="${escapeHtml(item.file_path)}" target="_blank" rel="noopener">Open</a>` : '<span class="muted">No file</span>'}</td>
      <td>
        <button class="link-btn" type="button" data-admin-submission="${Number(item.id)}" data-status="approved" data-publish="1">Approve & publish</button>
        <button class="link-btn danger" type="button" data-admin-submission="${Number(item.id)}" data-status="rejected">Reject</button>
      </td>
    </tr>
  `;
}

function analyticsPanel(analytics) {
  const a = analytics || {};
  const byDay = (a.downloads_by_day || []).map(d => ({ label: dayLabel(d.day), value: d.downloads }));
  const visitorsByDay = (a.downloads_by_day || []).map(d => ({ label: dayLabel(d.day), value: d.visitors }));
  const byWeekday = weekdaySeries(a.downloads_by_weekday);
  const byMonth = (a.downloads_by_month || []).slice().reverse().map(m => ({ label: monthLabel(m.month), value: m.downloads }));
  const subjects = (a.subject_distribution || []).slice(0, 10).map(s => ({ label: s.subject || 'General', value: s.count }));
  const types = (a.type_distribution || []).slice(0, 10).map(t => ({ label: typeLabel(t.type), value: t.count }));
  return `
    <div class="ch-dash">
      <div class="ch-kpis">
        ${kpi('Downloads logged', a.logged_downloads)}
        ${kpi('Unique visitors', a.unique_visitors)}
        ${kpi('Downloads - 7 days', a.downloads_7d)}
        ${kpi('Visitors - 7 days', a.visitors_7d)}
      </div>
      <article class="ch-card ch-wide">
        <header><h2>Downloads - last 14 days</h2><span>Daily file opens across the library</span></header>
        ${chartLine(byDay)}
      </article>
      <div class="ch-grid2">
        <article class="ch-card">
          <header><h2>Activity by weekday</h2><span>Downloads, last 8 weeks</span></header>
          ${chartBars(byWeekday)}
        </article>
        <article class="ch-card">
          <header><h2>Unique visitors - 14 days</h2><span>Distinct devices per day</span></header>
          ${chartLine(visitorsByDay, { color: '#0f766e', fill: 'rgba(15,118,110,0.12)' })}
        </article>
      </div>
      <div class="ch-grid2">
        <article class="ch-card">
          <header><h2>Trending resources</h2><span>Most downloaded</span></header>
          ${trendingList(a.top_resources)}
        </article>
        <article class="ch-card">
          <header><h2>Top subjects</h2><span>Library coverage</span></header>
          ${hbars(subjects)}
        </article>
      </div>
      <div class="ch-grid2">
        <article class="ch-card">
          <header><h2>Downloads by month</h2><span>Last 12 months</span></header>
          ${chartBars(byMonth, { color: '#174b82' })}
        </article>
        <article class="ch-card">
          <header><h2>Resource types</h2><span>Library distribution</span></header>
          ${hbars(types)}
        </article>
      </div>
    </div>
  `;
}

const CH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(iso) {
  const [, m, d] = String(iso || '').split('-').map(Number);
  return m ? `${d} ${CH_MONTHS[(m - 1) % 12]}` : String(iso || '');
}

function monthLabel(iso) {
  const [y, m] = String(iso || '').split('-').map(Number);
  return m ? `${CH_MONTHS[(m - 1) % 12]} ${String(y).slice(2)}` : String(iso || '');
}

function weekdaySeries(arr) {
  const map = {};
  (arr || []).forEach(r => { map[Number(r.weekday)] = Number(r.downloads) || 0; });
  const order = [1, 2, 3, 4, 5, 6, 0];
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return order.map((wd, i) => ({ label: names[i], value: map[wd] || 0 }));
}

function emptyChart(message) {
  return `<div class="chart-empty">${escapeHtml(message)}</div>`;
}

function kpi(label, value) {
  return `<article class="ch-kpi"><span>${escapeHtml(label)}</span><strong>${Number(value || 0).toLocaleString()}</strong></article>`;
}

function chartLine(series, { color = '#1f5f9f', fill = 'rgba(31,95,159,0.14)' } = {}) {
  const data = (series || []).map(s => ({ label: s.label, value: Number(s.value) || 0 }));
  if (!data.length || data.every(d => d.value === 0)) return emptyChart('No activity in this period yet.');
  const w = 680, h = 180, padL = 12, padR = 12, padT = 16, padB = 26;
  const n = data.length, max = Math.max(1, ...data.map(d => d.value));
  const iw = w - padL - padR, ih = h - padT - padB;
  const X = i => (n <= 1 ? padL + iw / 2 : padL + i * (iw / (n - 1)));
  const Y = v => padT + ih - (v / max) * ih;
  const pts = data.map((d, i) => [X(i), Y(d.value)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const area = `M${X(0).toFixed(1)},${(padT + ih).toFixed(1)}` + pts.map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('') + `L${X(n - 1).toFixed(1)},${(padT + ih).toFixed(1)}Z`;
  const every = Math.ceil(n / 7);
  const labels = data.map((d, i) => ((i % every === 0 || i === n - 1) ? `<text x="${X(i).toFixed(1)}" y="${h - 7}" class="ch-x" text-anchor="middle">${escapeHtml(d.label)}</text>` : '')).join('');
  const dots = pts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4"></circle>`).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Trend chart">
    <path d="${area}" fill="${fill}" stroke="none"></path>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"></path>
    <g fill="${color}">${dots}</g>
    ${labels}
  </svg>`;
}

function chartBars(series, { color = '#1f5f9f' } = {}) {
  const data = (series || []).map(s => ({ label: s.label, value: Number(s.value) || 0 }));
  if (!data.length || data.every(d => d.value === 0)) return emptyChart('No data in this period yet.');
  const w = 680, h = 180, padL = 12, padR = 12, padT = 16, padB = 26;
  const n = data.length, max = Math.max(1, ...data.map(d => d.value));
  const iw = w - padL - padR, ih = h - padT - padB;
  const slot = iw / n, bw = Math.min(46, slot * 0.62);
  const bars = data.map((d, i) => {
    const bh = (d.value / max) * ih;
    const x = padL + i * slot + (slot - bw) / 2;
    const y = padT + ih - bh;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" rx="4" fill="${color}"><title>${escapeHtml(d.label)}: ${d.value.toLocaleString()}</title></rect>
      <text x="${(x + bw / 2).toFixed(1)}" y="${h - 7}" class="ch-x" text-anchor="middle">${escapeHtml(d.label)}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart">${bars}</svg>`;
}

function hbars(items) {
  const data = (items || []).filter(Boolean);
  if (!data.length) return emptyChart('No data yet.');
  const max = Math.max(1, ...data.map(d => Number(d.value) || 0));
  return `<ul class="ch-hbars">${data.map(d => `
    <li>
      <span class="ch-hbar-label" title="${escapeHtml(d.label)}">${escapeHtml(d.label)}</span>
      <span class="ch-hbar-track"><span class="ch-hbar-fill" style="width:${((Number(d.value) || 0) / max * 100).toFixed(1)}%"></span></span>
      <span class="ch-hbar-val">${(Number(d.value) || 0).toLocaleString()}</span>
    </li>`).join('')}</ul>`;
}

function trendingList(items) {
  const data = (items || []).map(r => ({
    title: r.title || 'Untitled resource',
    sub: `${escapeHtml(r.subject || 'General')} - ${typeLabel(r.type)}`,
    value: Number(r.downloads_count ?? r.downloads ?? 0)
  }));
  if (!data.length) return emptyChart('No resources yet.');
  const max = Math.max(1, ...data.map(d => d.value));
  return `<ol class="ch-trending">${data.slice(0, 8).map((d, i) => `
    <li>
      <span class="ch-rank">${i + 1}</span>
      <span class="ch-trend-main">
        <span class="ch-trend-title" title="${escapeHtml(d.title)}">${escapeHtml(d.title)}</span>
        <span class="ch-trend-sub">${d.sub}</span>
        <span class="ch-hbar-track"><span class="ch-hbar-fill" style="width:${(d.value / max * 100).toFixed(1)}%"></span></span>
      </span>
      <span class="ch-trend-val">${d.value.toLocaleString()}<small>downloads</small></span>
    </li>`).join('')}</ol>`;
}

function optionsFrom(items, selected) {
  const normalized = normalizeChoice(selected);
  return items.map(item => {
    const value = item.id;
    return `<option value="${escapeHtml(value)}" ${normalizeChoice(value) === normalized ? 'selected' : ''}>${escapeHtml(item.label)}</option>`;
  }).join('');
}

function basicOptions(items, selected) {
  const normalized = normalizeChoice(selected);
  return items.map(([value, label]) => `<option value="${escapeHtml(value)}" ${normalizeChoice(value) === normalized ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('');
}

function normalizeChoice(value) {
  const normalized = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  const aliases = {
    '844': 'secondary-844',
    primary: 'cbc-primary',
    'junior-secondary': 'junior-secondary',
    secondary: 'senior-secondary',
    'pre-primary': 'pre-primary'
  };
  return aliases[normalized] || normalized;
}

function typeLabel(value) {
  const normalized = normalizeChoice(value);
  const item = RESOURCE_TYPES.find(type => normalizeChoice(type.id) === normalized);
  return escapeHtml(item?.label || String(value || 'Resource').replaceAll('_', ' '));
}

function tagsValue(resource) {
  const tags = resource?.tags || [];
  if (Array.isArray(tags)) return tags.map(tag => tag.name || tag).filter(Boolean).join(', ');
  return '';
}
