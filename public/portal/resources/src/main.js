import { CONFIG, RESOURCE_TYPES } from './config.js';
import { $, $$, debounce, escapeHtml } from './utils/dom.js';
import { store } from './state/store.js';
import { fetchResources, getResourceById, fetchResourceDetail, trackResourceDownload } from './services/resourceService.js';
import {
  adminArchiveResource,
  adminFetchAnalytics,
  adminFetchResources,
  adminFetchSubmissions,
  adminLogin,
  adminLogout,
  adminMe,
  adminSaveResource,
  adminUpdateSubmission
} from './services/adminService.js';
import { Home, CenterBody } from './components/Home.js';
import { AdminDashboard, AdminLogin } from './components/Admin.js';
import { ResourceCard } from './components/ResourceCard.js';
import { openModal, closeModal } from './components/Modal.js';
import { toast } from './components/Toast.js';

const main = $('#main');
let loadedFilterKey = '';
let activeLoadKey = '';
let mountedView = null;
let pointerMode = false;
let schoolSearch = '';
let schoolResults = '';
const adminState = {
  checked: false,
  authenticated: false,
  admin: null,
  loading: false,
  loaded: false,
  error: '',
  tab: 'resources',
  query: '',
  resources: [],
  submissions: [],
  analytics: {},
  editing: null
};
const CENTER_ROUTES = new Set(['school-login', 'create-school']);

/* ----------------------------------------------------- global wiring --- */

window.addEventListener('hashchange', () => renderRoute(true));

document.addEventListener('pointerdown', () => {
  pointerMode = true;
  document.documentElement.dataset.input = 'pointer';
}, true);

document.addEventListener('keydown', event => {
  if (event.key === 'Tab') {
    pointerMode = false;
    document.documentElement.dataset.input = 'keyboard';
  }
  if (event.key === 'Escape') { closeMenus(); closeModal(); }
  if (event.key === '/' && !isTypingTarget(event.target)) { event.preventDefault(); focusSearch(); }
});

// One delegated click handler for menus, category drill-ins, and card actions.
document.addEventListener('click', event => {
  if (pointerMode) event.target.closest('.resource-display button, .resource-display a')?.blur?.();

  const menuTop = event.target.closest('[data-menu]');
  if (menuTop) {
    event.preventDefault();
    const item = menuTop.parentElement;
    const wasOpen = item.classList.contains('open');
    closeMenus();
    if (!wasOpen) { item.classList.add('open'); menuTop.setAttribute('aria-expanded', 'true'); }
    return;
  }

  const catEl = event.target.closest('[data-cat-level]');
  if (catEl) {
    event.preventDefault();
    applyCategory({
      level: catEl.dataset.catLevel,
      type: catEl.dataset.catType || 'all',
      audience: catEl.dataset.catAudience || 'all',
      subject: catEl.dataset.catSubject || 'all',
      query: catEl.dataset.catQuery || ''
    });
    return;
  }

  if (event.target.closest('[data-action="reset-filters"]')) {
    store.resetFilters();
    const si = $('#home-search-input'); if (si) si.value = '';
    $('#center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  if (event.target.closest('[data-action="contribute-resource"]')) {
    openContributionModal();
    return;
  }

  const saveBtn = event.target.closest('[data-action="save"]');
  if (saveBtn) {
    event.stopPropagation();
    const saved = store.toggleSaved(Number(saveBtn.dataset.id));
    toast(saved ? 'Saved for later' : 'Removed from saved', saved ? 'success' : 'info');
    return;
  }

  // Direct file links: count the download, then let the anchor open the file in a new tab.
  const trackBtn = event.target.closest('[data-action="track"]');
  if (trackBtn) {
    const tracked = getResourceById(Number(trackBtn.dataset.id), store.state.resources);
    if (tracked) trackResourceDownload(tracked);
    return; // no preventDefault: the anchor opens the file directly
  }

  const openBtn = event.target.closest('[data-action="open"]');
  if (openBtn) { openResource(Number(openBtn.dataset.id)); return; }

  if (!event.target.closest('.menu, .resource-catalog')) closeMenus();
});

document.addEventListener('input', event => {
  if (event.target.id === 'home-search-input') queueSearch(event.target.value);
});
document.addEventListener('submit', event => {
  if (event.target.id === 'home-search') { event.preventDefault(); applySearch($('#home-search-input')?.value || ''); }
});

$('#search-shortcut')?.addEventListener('click', () => focusSearch());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

store.subscribe(() => renderRoute(false));
renderRoute(true);

/* --------------------------------------------------------- routing --- */

function currentRoute() {
  const hash = location.hash || '#/';
  const route = hash.startsWith('#/')
    ? hash.slice(2)
    : hash.startsWith('#')
      ? hash.slice(1)
      : hash;
  return (route || 'home').split('?')[0] || 'home';
}

function centerModeFor(route) {
  if (route === 'login') return 'school-login';
  return CENTER_ROUTES.has(route) ? route : '';
}

function isActive(filters) {
  return Boolean(filters.query) || filters.level !== 'all' || filters.type !== 'all' || filters.audience !== 'all' || filters.subject !== 'all';
}

async function renderRoute(full = true) {
  const route = currentRoute();
  if (route === 'saved') { mountedView = 'saved'; return renderSavedPage(full); }
  if (route === 'admin') { mountedView = 'admin'; return renderAdminPage(full); }
  const centerMode = centerModeFor(route);

  // Home. Kick a load if a filter is active and not yet loaded.
  if (!centerMode) maybeLoad();
  if (!full && mountedView === 'home' && $('#center-body') && !centerMode) {
    return updateCenter();
  }
  mountedView = 'home';
  main.innerHTML = Home(homeState(centerMode));
  setActiveNavCaret();
  bindCenterWorkflow(centerMode);
}

function homeState(centerMode = '') {
  const { filters, resources, savedIds, readIds, loading, error } = store.state;
  return {
    filters,
    resources,
    savedIds,
    readIds,
    loading,
    error,
    active: centerMode ? false : isActive(filters),
    centerMode,
    schoolSearch,
    schoolResults
  };
}

function updateCenter() {
  const body = $('#center-body');
  if (body) body.innerHTML = CenterBody(homeState());
}

function maybeLoad() {
  if (!isActive(store.state.filters)) return;
  const key = filterKey();
  if (loadedFilterKey === key || activeLoadKey === key) return;
  loadResources();
}

async function loadResources() {
  const key = filterKey();
  if (activeLoadKey === key) return;
  activeLoadKey = key;
  store.set({ loading: true, error: '' });
  try {
    const resources = await fetchResources(store.state.filters);
    loadedFilterKey = key;
    activeLoadKey = '';
    store.set({ resources, loading: false });
  } catch (error) {
    activeLoadKey = '';
    store.set({ error: 'Resources could not load. Check your connection and try again.', loading: false });
  }
}

/* ---------------------------------------------------- interactions --- */

// Apply a category/level selection - updates the centre in place (no nav).
function applyCategory({ level = 'all', type = 'all', audience = 'all', subject = 'all', query = '' } = {}) {
  closeMenus();
  if (location.hash && location.hash !== '#/' && location.hash !== '#') location.hash = '#/';
  store.updateFilters({ level, type, audience, subject, query, sort: 'relevance' });
  const si = $('#home-search-input'); if (si) si.value = query;
  $('#center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const queueSearch = debounce(value => applySearch(value, true), 260);

// Free-text search is global - it clears the category filters.
function applySearch(value, keepFocus = false) {
  store.updateFilters({ query: String(value || ''), level: 'all', type: 'all', audience: 'all', subject: 'all', sort: 'relevance' });
  if (!keepFocus) $('#center')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeMenus() {
  $$('.menu-item.open').forEach(el => {
    el.classList.remove('open');
    el.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false');
  });
}

/* ------------------------------------------------------------ modal --- */

async function openResource(id) {
  const resource = await fetchResourceDetail(id, store.state.resources);
  if (!resource) return toast('Resource not found', 'error');

  if (resource.protected) {
    openModal(`
      <button class="modal-close" type="button" data-close aria-label="Close">x</button>
      <span class="badge">${escapeHtml(resource.accessLabel || 'Login required')}</span>
      <h2 id="modal-title">${resource.premium ? 'This is a premium resource.' : 'This resource needs the right access.'}</h2>
      <p>Public resources open immediately. This item is marked ${escapeHtml(resource.visibility || 'restricted')}, so it opens after the backend confirms access.</p>
      <div class="modal-actions">
        <a class="primary-btn" href="${CONFIG.schoolLoginUrl}">Continue to login</a>
        <button class="secondary-btn" type="button" data-close>Keep browsing</button>
      </div>
    `);
    bindModalClose();
    return;
  }

  store.markRead(id);
  openModal(`
    <button class="modal-close" type="button" data-close aria-label="Close">x</button>
    <span class="badge">${escapeHtml(resource.format)}</span>
    <h2 id="modal-title">${escapeHtml(resource.title)}</h2>
    <p class="muted">${escapeHtml(resource.grade)} - ${escapeHtml(resource.subject)} - ${escapeHtml(resource.year)}</p>
    <div class="reader-body">${resource.body}</div>
    <div class="modal-actions">
      ${resource.fileUrl && resource.fileUrl !== '#'
        ? `<a class="primary-btn" href="${resource.fileUrl}" target="_blank" rel="noopener" data-download-open="${resource.id}">Open file</a>`
        : ''}
      <button class="secondary-btn" type="button" data-save-open="${resource.id}">${store.state.savedIds.includes(id) ? 'Saved' : 'Save resource'}</button>
    </div>
  `);
  bindModalClose();
  $('[data-download-open]')?.addEventListener('click', () => trackResourceDownload(resource));
  $('[data-save-open]')?.addEventListener('click', () => {
    const saved = store.toggleSaved(id);
    toast(saved ? 'Saved for later' : 'Removed from saved', saved ? 'success' : 'info');
    closeModal();
  });
}

/* --------------------------------------------------------- school centre --- */

function bindCenterWorkflow(mode) {
  if (mode === 'school-login') bindSchoolFinder();
  if (mode === 'create-school') bindSchoolCreate();
}

function bindSchoolFinder() {
  const form = $('#school-search-form');
  const input = $('#school-search-input');
  form?.addEventListener('submit', event => {
    event.preventDefault();
    searchSchools(input?.value || '');
  });
  input?.focus();
  input?.select?.();
}

async function searchSchools(value) {
  const query = String(value || '').trim();
  const results = $('#school-search-results');
  schoolSearch = query;
  if (!results) return;
  if (!query) {
    schoolResults = '<div class="school-empty">Type a school name or code to search.</div>';
    results.innerHTML = schoolResults;
    return;
  }

  results.innerHTML = '<div class="school-empty">Searching schools...</div>';
  try {
    const response = await fetch(`${CONFIG.publicSchoolsApi}?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' }
    });
    const payload = await response.json().catch(() => ({}));
    const schools = Array.isArray(payload.data) ? payload.data : [];
    schoolResults = schools.length ? schoolResultList(schools) : '<div class="school-empty">No matching school found.</div>';
    results.innerHTML = schoolResults;
  } catch (error) {
    schoolResults = '<div class="school-empty">School search is unavailable. Try again shortly.</div>';
    results.innerHTML = schoolResults;
  }
}

function schoolResultList(schools) {
  return `
    <ul class="school-result-list">
      ${schools.map(school => `
        <li>
          <div>
            <strong>${escapeHtml(school.name)}</strong>
            <span>${escapeHtml(school.school_code || 'No code')}${school.county ? ` - ${escapeHtml(school.county)}` : ''}</span>
          </div>
          <a class="secondary-btn" href="/${encodeURIComponent(school.slug)}/login">Login</a>
        </li>
      `).join('')}
    </ul>
  `;
}

function bindSchoolCreate() {
  const form = $('#school-register-form');
  const codeInput = form?.querySelector('[name="school_code"]');
  codeInput?.addEventListener('input', () => { codeInput.value = codeInput.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); });

  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = $('#school-register-status');
    const button = form.querySelector('[type="submit"]');
    const body = Object.fromEntries(new FormData(form).entries());
    const ownerEmail = String(body.owner_email || '').trim().toLowerCase();
    body.name = String(body.name || '').trim();
    body.school_code = String(body.school_code || '').trim().toUpperCase();
    body.owner_name = String(body.owner_name || '').trim();
    body.owner_email = ownerEmail;
    body.email = ownerEmail;
    body.slug = slugify(body.name);

    if (status) {
      status.className = 'school-status';
      status.textContent = 'Creating school portal...';
    }
    button.disabled = true;

    try {
      const response = await fetch(CONFIG.registerSchoolApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.message || 'Registration failed.');

      const data = payload.data || {};
      const approved = data.registration_status === 'approved';
      const ownerId = escapeHtml(data.owner_user_id || '');
      const loginUrl = escapeHtml(data.login || '#/school-login');
      const emailSent = Boolean(data.email_sent);
      if (status) {
        status.className = 'school-status success';
        status.innerHTML = approved
          ? `Portal created. Owner code: <b>${ownerId}</b>. ${emailSent ? `Confirmation has been sent to <b>${escapeHtml(ownerEmail)}</b> from ${escapeHtml(CONFIG.supportEmail)}.` : `Confirmation will be sent to <b>${escapeHtml(ownerEmail)}</b> from ${escapeHtml(CONFIG.supportEmail)}.`} <a href="${loginUrl}">Open login</a>.`
          : `Portal request received. Owner code: <b>${ownerId}</b>. ${emailSent ? `Confirmation has been sent to <b>${escapeHtml(ownerEmail)}</b> from ${escapeHtml(CONFIG.supportEmail)}.` : `Confirmation will be sent to <b>${escapeHtml(ownerEmail)}</b> from ${escapeHtml(CONFIG.supportEmail)} after review.`}`;
      }
      form.reset();
    } catch (error) {
      if (status) {
        status.className = 'school-status error';
        status.textContent = error.message || 'Could not submit the school portal request.';
      }
    } finally {
      button.disabled = false;
    }
  });
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || `school-${Date.now()}`;
}

/* --------------------------------------------------------- resource admin --- */

async function renderAdminPage() {
  if (!adminState.checked) {
    main.innerHTML = AdminLogin({ checking: true });
    await refreshAdminSession();
  }

  if (!adminState.authenticated) {
    main.innerHTML = AdminLogin(adminState);
    bindAdminLogin();
    return;
  }

  if (!adminState.loaded && !adminState.loading) loadAdminData();
  main.innerHTML = AdminDashboard(adminState);
  bindAdminDashboard();
}

function setAdminState(patch, rerender = true) {
  Object.assign(adminState, patch);
  if (rerender && currentRoute() === 'admin') renderAdminPage(false);
}

async function refreshAdminSession() {
  try {
    const payload = await adminMe();
    const admin = payload.admin || payload.data?.admin || null;
    Object.assign(adminState, {
      checked: true,
      authenticated: Boolean(payload.authenticated && admin),
      admin,
      error: ''
    });
  } catch (error) {
    Object.assign(adminState, { checked: true, authenticated: false, admin: null, error: '' });
  }
}

async function loadAdminData(force = false) {
  if (adminState.loading && !force) return;
  setAdminState({ loading: true, error: '' });
  try {
    const [resources, submissions, analytics] = await Promise.all([
      adminFetchResources(adminState.query),
      adminFetchSubmissions(),
      adminFetchAnalytics()
    ]);
    setAdminState({
      resources,
      submissions,
      analytics,
      loaded: true,
      loading: false,
      error: ''
    });
  } catch (error) {
    const needsLogin = /login|required|unauthorized/i.test(error.message || '');
    setAdminState({
      loading: false,
      loaded: false,
      authenticated: needsLogin ? false : adminState.authenticated,
      error: needsLogin ? 'Admin session expired. Sign in again.' : (error.message || 'Admin data could not load.')
    });
  }
}

function bindAdminLogin() {
  const form = $('#resource-admin-login');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    button.disabled = true;
    button.textContent = 'Verifying...';
    try {
      const payload = await adminLogin(String(data.get('username') || ''), String(data.get('password') || ''));
      setAdminState({
        authenticated: true,
        checked: true,
        admin: payload.admin || payload.data?.admin || null,
        loaded: false,
        error: ''
      });
      loadAdminData(true);
    } catch (error) {
      setAdminState({ error: error.message || 'Could not sign in.' });
    } finally {
      button.disabled = false;
      button.textContent = 'Enter console';
    }
  });
}

function bindAdminDashboard() {
  $$('[data-admin-tab]').forEach(button => {
    button.addEventListener('click', () => {
      const next = button.dataset.adminTab;
      setAdminState({ tab: next, editing: next === 'upload' ? adminState.editing : null });
    });
  });

  $('[data-admin-action="logout"]')?.addEventListener('click', async () => {
    await adminLogout().catch(() => {});
    setAdminState({
      checked: true,
      authenticated: false,
      admin: null,
      loaded: false,
      resources: [],
      submissions: [],
      analytics: {},
      editing: null,
      error: ''
    });
  });

  $('[data-admin-action="refresh"]')?.addEventListener('click', () => loadAdminData(true));

  $$('[data-admin-action="new-resource"]').forEach(button => {
    button.addEventListener('click', () => setAdminState({ tab: 'upload', editing: null }));
  });

  $('#admin-resource-search')?.addEventListener('submit', event => {
    event.preventDefault();
    const query = String(new FormData(event.currentTarget).get('q') || '').trim();
    setAdminState({ query, loaded: false }, false);
    loadAdminData(true);
  });

  $$('[data-admin-edit]').forEach(button => {
    button.addEventListener('click', () => {
      const id = Number(button.dataset.adminEdit);
      const resource = adminState.resources.find(item => Number(item.id) === id);
      if (!resource) return toast('Resource not found in this list', 'error');
      setAdminState({ tab: 'upload', editing: resource });
    });
  });

  $$('[data-admin-archive]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.adminArchive);
      const resource = adminState.resources.find(item => Number(item.id) === id);
      if (!window.confirm(`Archive "${resource?.title || 'this resource'}"?`)) return;
      button.disabled = true;
      try {
        await adminArchiveResource(id);
        toast('Resource archived', 'success');
        setAdminState({ loaded: false }, false);
        loadAdminData(true);
      } catch (error) {
        toast(error.message || 'Could not archive resource', 'error');
        button.disabled = false;
      }
    });
  });

  $$('[data-admin-submission]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = Number(button.dataset.adminSubmission);
      const status = button.dataset.status;
      button.disabled = true;
      try {
        await adminUpdateSubmission(id, {
          status,
          publish: button.dataset.publish === '1',
          reviewer_note: status === 'approved' ? 'Approved from resource admin dashboard.' : 'Reviewed from resource admin dashboard.'
        });
        toast(status === 'approved' ? 'Submission approved and published' : 'Submission updated', 'success');
        setAdminState({ loaded: false }, false);
        loadAdminData(true);
      } catch (error) {
        toast(error.message || 'Could not update submission', 'error');
        button.disabled = false;
      }
    });
  });

  $('#admin-resource-form')?.addEventListener('submit', saveAdminForm);
}

async function saveAdminForm(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type="submit"]');
  const data = new FormData(form);
  const file = data.get('file');
  const id = form.dataset.resourceId ? Number(form.dataset.resourceId) : null;
  const payload = {
    title: String(data.get('title') || '').trim(),
    type: data.get('type'),
    subject: String(data.get('subject') || '').trim(),
    grade: String(data.get('grade') || '').trim(),
    year: String(data.get('year') || '').trim(),
    level: data.get('level'),
    audience: data.get('audience'),
    status: data.get('status'),
    visibility: data.get('visibility'),
    body_html: String(data.get('body_html') || '').trim(),
    tags: String(data.get('tags') || '').trim(),
    is_featured: Boolean(data.get('is_featured')),
    is_verified: Boolean(data.get('is_verified')),
    premium: Boolean(data.get('premium'))
  };

  if (!payload.title || !payload.type || !payload.subject || !payload.grade) {
    toast('Title, type, subject and grade are required', 'error');
    return;
  }

  if (file instanceof File && file.name) {
    if (file.size > 25 * 1024 * 1024) {
      toast('Keep files under 25 MB', 'error');
      return;
    }
    payload.filename = file.name;
    payload.file_data = await fileToDataUrl(file);
  }

  button.disabled = true;
  button.textContent = id ? 'Saving...' : 'Uploading...';
  try {
    await adminSaveResource(payload, id);
    toast(id ? 'Resource updated' : 'Resource uploaded', 'success');
    loadedFilterKey = '';
    setAdminState({ tab: 'resources', editing: null, loaded: false }, false);
    loadAdminData(true);
  } catch (error) {
    toast(error.message || 'Could not save resource', 'error');
    button.disabled = false;
    button.textContent = id ? 'Save changes' : 'Upload resource';
  }
}

/* ------------------------------------------------------------ pages --- */

async function renderSavedPage(full = true) {
  if (!store.state.resources.length) await loadResources();
  const saved = store.state.savedIds.map(id => getResourceById(id, store.state.resources)).filter(Boolean);
  main.innerHTML = `
    <section class="simple-page">
      <a class="back-link" href="#/">&larr; Back to resources</a>
      <span class="eyebrow">Saved resources</span>
      <h1>Your saved reading list</h1>
      <p>Saved resources are stored on this device, so you can return to useful material without signing in.</p>
      <div class="center-results">
        ${saved.length ? saved.map(r => ResourceCard(r, { saved: true, read: store.state.readIds.includes(r.id) })).join('') : '<div class="empty"><h2>No saved resources yet</h2><p>Tap the star on any resource to save it here.</p><a class="primary-btn" href="#/">Browse resources</a></div>'}
      </div>
    </section>
  `;
}

function renderLoginGate() {
  main.innerHTML = `
    <section class="login-gate">
      <a class="back-link" href="#/">&larr; Back to resources</a>
      <div>
        <span class="eyebrow">Two separate doors</span>
        <h1>Browsing is open. Login is only for schools.</h1>
        <p>The Civicom Learning Portal is free to browse. School login is a separate, private door for school records and dashboards.</p>
      </div>
      <div class="access-cards">
        <article>
          <h2>Keep browsing resources</h2>
          <p>Search and open notes, past papers, mocks, schemes, and more - no sign in.</p>
          <a class="primary-btn" href="#/">Continue to library</a>
        </article>
        <article>
          <h2>School login</h2>
          <p>For school records, assignments, and teacher, learner, and parent dashboards.</p>
          <a class="primary-btn" href="${CONFIG.schoolLoginUrl}">Open school login</a>
          <a class="secondary-btn" href="${CONFIG.createSchoolUrl}">Create a school portal</a>
        </article>
      </div>
    </section>
  `;
}

function openContributionModal() {
  openModal(`
    <button class="modal-close" type="button" data-close aria-label="Close">x</button>
    <span class="eyebrow">Share resources</span>
    <h2 id="modal-title">Submit a resource for review</h2>
    <p class="muted">Share schemes, notes, past papers or marking schemes. Approved files are added for other teachers and learners.</p>
    <form class="contribute-form" id="contribute-form">
      <label class="contribute-drop">
        <span>Choose file</span>
        <strong>PDF, Word, Excel, PowerPoint, image, text, or CSV</strong>
        <input name="file" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png,.webp" required data-autofocus />
      </label>
      <div class="contribute-grid">
        <label class="field">
          <span>Grade/Form</span>
          <input name="grade" type="text" placeholder="Grade 9 or Form 2" autocomplete="off" required />
        </label>
        <label class="field">
          <span>Subject</span>
          <input name="subject" type="text" placeholder="Agriculture" autocomplete="off" required />
        </label>
        <label class="field">
          <span>Type</span>
          <select name="type" required>${contributionTypeOptions()}</select>
        </label>
        <label class="field">
          <span>Contact optional</span>
          <input name="contact" type="text" placeholder="Email or phone" autocomplete="off" />
        </label>
      </div>
      <label class="field">
        <span>Note optional</span>
        <textarea name="note" rows="3" placeholder="Term, source, or anything reviewers should know"></textarea>
      </label>
      <p class="contribute-note">Files are reviewed before publishing.</p>
      <div class="modal-actions">
        <button class="primary-btn" type="submit">Submit for review</button>
        <button class="secondary-btn" type="button" data-close>Cancel</button>
      </div>
    </form>
  `);
  bindModalClose();
  bindContributionForm();
}

function contributionTypeOptions() {
  return RESOURCE_TYPES
    .filter(type => type.id !== 'all')
    .map(type => `<option value="${escapeHtml(type.id)}">${escapeHtml(type.label)}</option>`)
    .join('');
}

function bindContributionForm() {
  const form = $('#contribute-form');
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = form.querySelector('[type="submit"]');
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || !file.name) {
      toast('Choose a file first', 'error');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast('Keep files under 25 MB', 'error');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Sending...';
    try {
      const response = await fetch(`${CONFIG.apiBase}/resource-submissions`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          title: file.name.replace(/\.[^.]+$/, ''),
          type: data.get('type'),
          grade: String(data.get('grade') || '').trim(),
          subject: String(data.get('subject') || '').trim(),
          contact: String(data.get('contact') || '').trim(),
          note: String(data.get('note') || '').trim(),
          file_data: await fileToDataUrl(file)
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.success === false) throw new Error(payload.message || 'Submission failed');
      toast('Resource received for review', 'success');
      openModal(`
        <button class="modal-close" type="button" data-close aria-label="Close">x</button>
        <span class="eyebrow">Received</span>
        <h2 id="modal-title">Thanks for passing it forward.</h2>
        <p class="muted">Your resource is in the review queue. Approved files may appear in the library after checking.</p>
        <div class="modal-actions">
          <button class="primary-btn" type="button" data-close>Done</button>
        </div>
      `);
      bindModalClose();
    } catch (error) {
      toast(error.message || 'Could not submit resource', 'error');
      submit.disabled = false;
      submit.textContent = 'Submit for review';
    }
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('Could not read this file')));
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------ utils --- */

function bindModalClose() {
  $$('[data-close]').forEach(item => item.addEventListener('click', closeModal));
}

function focusSearch() {
  if (currentRoute() !== 'home') { location.hash = '#/'; setTimeout(focusSearch, 120); return; }
  const input = $('#home-search-input');
  if (input) { input.focus(); input.select?.(); input.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function isTypingTarget(target) {
  const tag = target?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable;
}

function setActiveNavCaret() { /* no global nav to highlight */ }

function filterKey() {
  return JSON.stringify(store.state.filters);
}
