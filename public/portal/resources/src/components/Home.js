import { CONFIG, HOME_SECTIONS, FAQS, LEVELS, RESOURCE_TYPES, EXAM_HUB, TEACHER_DOCS, BROWSE_SUBJECTS } from '../config.js';
import { escapeHtml } from '../utils/dom.js';
import { ResourceListItem } from './ResourceCard.js';

// Single-page learning portal: side rails stay put, and the centre column
// swaps between browse, school login, portal creation, and resource results.

const PAPER_YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018'];
const CATALOG_MENUS = [
  {
    label: 'HOME',
    home: true
  },
  {
    label: 'SAVED',
    saved: true
  },
  {
    label: 'KCSE (Form 1-4)',
    items: [
      { label: 'All KCSE Resources', level: 'secondary-844', type: 'all' },
      { label: 'Form 1', level: 'secondary-844', type: 'all', query: 'Form 1' },
      { label: 'Form 2', level: 'secondary-844', type: 'all', query: 'Form 2' },
      { label: 'Form 3', level: 'secondary-844', type: 'all', query: 'Form 3' },
      { label: 'Form 4', level: 'secondary-844', type: 'all', query: 'Form 4' },
      { label: 'Subject Notes', level: 'secondary-844', type: 'notes' },
      { label: 'Setbook Guides', level: 'secondary-844', type: 'setbook-guide' }
    ]
  },
  {
    label: 'Past Papers & Marking Schemes',
    items: [
      { label: 'All KNEC Past Papers', level: 'secondary-844', type: 'past-paper' },
      ...PAPER_YEARS.map(year => ({ label: `${year} KCSE Past Papers`, level: 'secondary-844', type: 'past-paper', query: year })),
      { label: 'Marking Schemes', level: 'secondary-844', type: 'marking-scheme' },
      { label: 'Prediction Papers', level: 'secondary-844', type: 'prediction' },
      { label: 'KNEC / KCSE Reports', level: 'secondary-844', type: 'all', query: 'KCSE report' }
    ]
  },
  {
    label: 'Mocks & Joint Exams',
    items: [
      { label: 'All Mocks & Joint Exams', level: 'secondary-844', type: 'mock' },
      ...PAPER_YEARS.map(year => ({ label: `${year} Mocks`, level: 'secondary-844', type: 'mock', query: year }))
    ]
  },
  {
    label: 'Termly Exams',
    items: [
      { label: 'All Termly Exams', level: 'all', type: 'exam' },
      { label: 'Opener Exams', level: 'all', type: 'exam', query: 'opener' },
      { label: 'Midterm Exams', level: 'all', type: 'exam', query: 'midterm' },
      { label: 'Endterm Exams', level: 'all', type: 'exam', query: 'endterm' },
      { label: 'KCSE Form 3 & 4 Exams', level: 'secondary-844', type: 'exam' },
      { label: 'Holiday Assignments', level: 'all', type: 'assignment' }
    ]
  },
  {
    label: 'Topical & Revision',
    items: [
      { label: 'Topical Questions', level: 'all', type: 'topic-test' },
      { label: 'Revision Booklets', level: 'all', type: 'revision' },
      { label: 'Prediction Papers', level: 'secondary-844', type: 'prediction' }
    ]
  },
  {
    label: 'Teacher Documents',
    items: [
      { label: 'Schemes of Work', level: 'all', type: 'scheme', audience: 'teacher' },
      { label: 'Lesson Plans', level: 'all', type: 'lesson-plan', audience: 'teacher' },
      { label: 'Records of Work', level: 'all', type: 'record-of-work', audience: 'teacher' },
      { label: 'KICD Curriculum Designs', level: 'all', type: 'curriculum-design', audience: 'teacher' },
      { label: 'Assessment Rubrics / CBAs', level: 'all', type: 'assessment', audience: 'teacher' },
      { label: 'Teacher Guides', level: 'all', type: 'teacher-guide', audience: 'teacher' },
      { label: 'TPAD Tools', level: 'all', type: 'tpad', audience: 'teacher' }
    ]
  },
  {
    label: 'CBC by Class',
    items: [
      { label: 'Pre-Primary (PP1-PP2)', level: 'pre-primary', type: 'all' },
      { label: 'Primary (Grade 1-6)', level: 'cbc-primary', type: 'all' },
      { label: 'Junior School (Grade 7-9)', level: 'junior-secondary', type: 'all' },
      { label: 'Senior School (Grade 10-12)', level: 'senior-secondary', type: 'all' },
      ...Array.from({ length: 9 }, (_, index) => ({ label: `Grade ${index + 1}`, level: 'grade-1-9', type: 'all', query: `Grade ${index + 1}` }))
    ]
  },
  {
    label: 'By Subject',
    items: BROWSE_SUBJECTS.map(subject => ({ label: subject, level: 'all', type: 'all', subject }))
  }
];

export function CenterBody(state) {
  if (state.centerMode === 'school-login') return schoolFinderPanel(state);
  if (state.centerMode === 'create-school') return createSchoolPanel();
  return state.active ? resultsPanel(state) : defaultCenter();
}

export function Home(state) {
  const { filters } = state;
  return `
    ${state.centerMode ? '' : catalogStrip()}
    <div class="kcse-grid">
      <aside class="rail rail-left" aria-label="Browse by year">
        ${yearRail('KCSE Past Papers by year', 'secondary-844', 'past-paper', 'KCSE Past Papers')}
        ${yearRail('Mocks & Joint Exams by year', 'secondary-844', 'mock', 'Mocks')}
      </aside>

      <section class="col-center" id="center">
        ${state.centerMode
          ? `<div id="center-body">${CenterBody(state)}</div>`
          : `${searchBox(filters.query)}<div id="center-body">${CenterBody(state)}</div>`}
      </section>

      <aside class="rail rail-right" aria-label="Account, subjects and exams">
        ${subjectRail()}
        ${termlyRail()}
        ${contributeRail()}
        ${loginRail()}
      </aside>
    </div>
    ${footer()}
  `;
}

/* -------------------------------------------------------------- links --- */

function catAttrs({ level = 'all', type = 'all', audience = 'all', subject, query } = {}) {
  return `data-cat-level="${escapeHtml(level)}" data-cat-type="${escapeHtml(type)}" data-cat-audience="${escapeHtml(audience)}"${subject !== undefined ? ` data-cat-subject="${escapeHtml(subject)}"` : ''}${query !== undefined ? ` data-cat-query="${escapeHtml(query)}"` : ''}`;
}

function catalogStrip() {
  return `
    <section class="resource-catalog" aria-label="Available learning resources">
      <div class="resource-catalog-copy">
        <span>Daraja library</span>
        <strong>Public school resources</strong>
        <small>KCSE, CBC, teacher documents and revision files.</small>
      </div>
      <div class="catalog-menus" role="list">
        ${CATALOG_MENUS.map((group, index) => `
          <div class="menu-item catalog-menu${index >= CATALOG_MENUS.length - 3 ? ' catalog-edge' : ''}" role="listitem">
            ${group.home
              ? `<a class="catalog-menu-top catalog-home" href="#/" data-action="reset-filters">${escapeHtml(group.label)}</a>`
              : group.saved
                ? `<a class="catalog-menu-top catalog-home" href="#/saved">${escapeHtml(group.label)}</a>`
                : `<button class="catalog-menu-top" type="button" data-menu aria-haspopup="true" aria-expanded="false">
              ${escapeHtml(group.label)}<span class="caret" aria-hidden="true">&#9662;</span>
            </button>
            <div class="catalog-drop" role="menu">
              ${group.items.map(item => `<a href="#" role="menuitem" ${catAttrs(item)}>${escapeHtml(item.label)}</a>`).join('')}
            </div>`}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

/* ------------------------------------------------------------ search --- */

function searchBox(query = '') {
  return `
    <form class="kcse-search" id="home-search" role="search">
      <label for="home-search-input">Search resources</label>
      <div class="kcse-search-row">
        <input id="home-search-input" type="search" value="${escapeHtml(query)}" placeholder="Search by class, subject, exam or file type e.g. Form 4 Biology, Grade 7 opener" autocomplete="off" enterkeyhint="search" />
        <button class="primary-btn" type="submit">Search</button>
      </div>
    </form>
  `;
}

/* ------------------------------------------------- centre: default --- */

function defaultCenter() {
  return `
    <section class="intro">
      <span class="eyebrow">Public school digital library</span>
      <h1>Find Kenyan school resources without needing a login.</h1>
      <p>Daraja brings together KCSE past papers, marking schemes, CBC notes, schemes of work, lesson plans and revision materials - organised by class, subject and term.</p>
      <div class="role-guide" aria-label="Choose a starting point">
        <a href="#" ${catAttrs({ level: 'secondary-844', type: 'past-paper', audience: 'learner' })}>
          <strong>Learners</strong>
          <span>Open past papers, notes and revision.</span>
        </a>
        <a href="#" ${catAttrs({ level: 'all', type: 'scheme', audience: 'teacher' })}>
          <strong>Teachers</strong>
          <span>Find schemes, lesson plans and assessment tools.</span>
        </a>
        <a href="#" ${catAttrs({ level: 'all', type: 'exam', audience: 'learner' })}>
          <strong>Parents</strong>
          <span>Help a learner practise by class or subject.</span>
        </a>
        <a href="${CONFIG.schoolLoginUrl}">
          <strong>Schools</strong>
          <span>Use login only for private school records.</span>
        </a>
      </div>
    </section>
    ${subjectStrip()}
    <div class="center-blocks">
      <h2 class="lane-heading">For learners &amp; candidates</h2>
      ${laneBlock('KCSE &amp; CBC Exam Hub', 'Past papers, marking schemes, mocks, prediction and revision', EXAM_HUB)}
      <h2 class="lane-heading">For teachers</h2>
      ${laneBlock('Teacher Professional Documents', 'Schemes, lesson plans, records of work, KICD designs and CBC assessment tools', TEACHER_DOCS)}
      <h2 class="lane-heading">Browse by class</h2>
      ${HOME_SECTIONS.map(sectionBlock).join('')}
    </div>
    ${faq()}
  `;
}

function subjectStrip() {
  return `
    <section class="subject-strip" aria-label="Browse by subject">
      <span class="subject-strip-label">Browse by subject</span>
      <div class="subject-chips">
        ${BROWSE_SUBJECTS.map(subject => `<a class="subject-chip" href="#" ${catAttrs({ level: 'all', type: 'all', subject })}>${escapeHtml(subject)}</a>`).join('')}
      </div>
    </section>
  `;
}

function laneBlock(title, subtitle, items) {
  return `
    <section class="center-block">
      <h2 class="block-head">${title}</h2>
      <p class="block-sub">${escapeHtml(subtitle)}</p>
      <ul class="link-list">
        ${items.map(item => `
          <li><a href="#" ${catAttrs(item)}>${escapeHtml(item.label)}</a><span class="ll-tag">${escapeHtml(item.tag || '')}</span></li>
        `).join('')}
      </ul>
    </section>
  `;
}

function schoolFinderPanel(state) {
  const results = state.schoolResults || '<div class="school-empty">Search by school name or code. Results will appear here.</div>';
  return `
    <section class="school-panel school-find-panel" aria-label="Find your school">
      <div class="school-panel-top">
        <span class="eyebrow">School login</span>
        <a class="results-reset" href="#/">&larr; Resources</a>
      </div>
      <h1>Find your school</h1>
      <p>Enter the school name or code, then open its login page.</p>
      <form class="school-search-form" id="school-search-form" role="search">
        <label for="school-search-input">School name or code</label>
        <div class="school-search-row">
          <input id="school-search-input" name="q" type="search" value="${escapeHtml(state.schoolSearch || '')}" placeholder="e.g. Joyland or JS" autocomplete="off" required />
          <button class="primary-btn" type="submit">Search</button>
        </div>
      </form>
      <div id="school-search-results" class="school-results" aria-live="polite">${results}</div>
    </section>
  `;
}

function createSchoolPanel() {
  return `
    <section class="school-panel create-school-panel" aria-label="Create a school portal">
      <div class="school-panel-top">
        <span class="eyebrow">New school portal</span>
        <a class="results-reset" href="#/">&larr; Resources</a>
      </div>
      <h1>Create a school portal</h1>
      <p>Use a real authentication email. Confirmation and school codes are handled through ${escapeHtml(CONFIG.supportEmail)}.</p>
      <form class="school-create-form" id="school-register-form">
        <div class="school-form-grid">
          <label class="field">
            <span>School name</span>
            <input name="name" type="text" placeholder="Green Valley School" autocomplete="organization" required />
          </label>
          <label class="field">
            <span>School code</span>
            <input name="school_code" type="text" placeholder="GVS" autocomplete="off" maxlength="12" required />
          </label>
          <label class="field">
            <span>Admin name</span>
            <input name="owner_name" type="text" placeholder="Principal / Director" autocomplete="name" required />
          </label>
          <label class="field">
            <span>Authentication email</span>
            <input name="owner_email" type="email" placeholder="owner@school.ac.ke" autocomplete="email" required />
          </label>
          <label class="field">
            <span>Phone optional</span>
            <input name="owner_phone" type="tel" placeholder="+254..." autocomplete="tel" />
          </label>
          <label class="field">
            <span>County optional</span>
            <input name="county" type="text" placeholder="Nairobi" autocomplete="address-level1" />
          </label>
          <label class="field school-form-wide">
            <span>Owner password</span>
            <input name="password" type="password" minlength="8" autocomplete="new-password" required />
          </label>
        </div>
        <p class="school-mail-note">After submission, the owner code and next steps are sent to the authentication email from ${escapeHtml(CONFIG.supportEmail)}.</p>
        <button class="primary-btn" type="submit">Create school portal</button>
        <div id="school-register-status" class="school-status" aria-live="polite"></div>
      </form>
    </section>
  `;
}

function sectionBlock(item) {
  return `
    <section class="center-block">
      <h2 class="block-head"><a href="#" ${catAttrs({ level: item.level, audience: item.audience || 'all' })}>${escapeHtml(item.title)}</a></h2>
      <p class="block-sub">${escapeHtml(item.subtitle || '')}</p>
      <ul class="link-list">
        ${item.categories.map(c => `
          <li><a href="#" ${catAttrs({ level: item.level, type: c.type, audience: item.audience || 'all' })}>${escapeHtml(c.label)}</a><span class="ll-tag">${escapeHtml(c.tag)}</span></li>
        `).join('')}
      </ul>
    </section>
  `;
}

/* ------------------------------------------------- centre: results --- */

function resultsPanel(state) {
  const { filters, resources, loading, error } = state;
  let body;
  if (loading) body = `<ul class="resource-list skeleton-list" aria-label="Loading resources">${Array.from({ length: 6 }, () => '<li class="skeleton-row"></li>').join('')}</ul>`;
  else if (error) body = `<div class="empty"><h2>Could not load</h2><p>${escapeHtml(error)}</p></div>`;
  else if (!resources.length) body = `<div class="empty"><h2>Nothing here yet</h2><p>We may still be adding this category. Try another subject, class or term - or share what you have so other teachers and learners can use it.</p><div class="empty-actions"><button class="primary-btn" type="button" data-action="reset-filters">Show all resources</button><button class="secondary-btn" type="button" data-action="contribute-resource">Share a resource</button></div></div>`;
  else body = groupedResourceList(resources, state.savedIds, state.readIds);

  return `
    <section class="results-panel">
      <div class="resource-display">
        <div class="results-bar">
          <div>
            <span class="eyebrow">Showing</span>
            <h2>${escapeHtml(activeLabel(filters))}${loading ? '' : ` <small>(${resources.length})</small>`}</h2>
          </div>
          <button class="results-reset" type="button" data-action="reset-filters">&larr; Show all</button>
        </div>
        ${body}
      </div>
    </section>
  `;
}

function groupedResourceList(resources, savedIds = [], readIds = []) {
  const groups = new Map();
  resources.forEach(resource => {
    const label = gradeLabel(resource);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(resource);
  });

  const orderedGroups = Array.from(groups.entries())
    .sort(([a], [b]) => gradeRank(a) - gradeRank(b) || a.localeCompare(b));

  return `
    <div class="resource-groups" aria-label="Matching resources grouped by grade">
      ${orderedGroups.map(([label, items]) => `
        <section class="resource-group" aria-label="${escapeHtml(label)}">
          <h3 class="resource-group-title">${escapeHtml(label)}</h3>
          <ul class="resource-list">
            ${items.map(resource => ResourceListItem(resource, {
              saved: savedIds.includes(Number(resource.id)),
              read: readIds.includes(Number(resource.id))
            })).join('')}
          </ul>
        </section>
      `).join('')}
    </div>
  `;
}

function gradeLabel(resource) {
  const grade = String(resource.grade || '').trim();
  if (grade && grade.toLowerCase() !== 'general') return grade;
  if (resource.level && resource.level !== 'all') return labelOf(LEVELS, resource.level);
  return 'General resources';
}

function gradeRank(label) {
  const value = String(label || '').toLowerCase();
  const pp = value.match(/\bpp\s*([12])\b/);
  if (pp) return Number(pp[1]) - 3;
  const grade = value.match(/\bgrade\s*(\d{1,2})\b/);
  if (grade) return Number(grade[1]);
  const form = value.match(/\bform\s*(\d)\b/);
  if (form) return 20 + Number(form[1]);
  return 100;
}

function activeLabel(filters) {
  if (filters.query) return `"${filters.query}"`;
  const parts = [];
  if (filters.level && filters.level !== 'all') parts.push(labelOf(LEVELS, filters.level));
  if (filters.subject && filters.subject !== 'all') parts.push(filters.subject);
  if (filters.type && filters.type !== 'all') parts.push(labelOf(RESOURCE_TYPES, filters.type));
  if (filters.audience && filters.audience !== 'all') parts.push(`${filters.audience[0].toUpperCase()}${filters.audience.slice(1)}`);
  return parts.join(' - ') || 'All resources';
}

function labelOf(list, id) {
  return list.find(x => x.id === id)?.label || id;
}

/* --------------------------------------------------------- rails --- */

function yearRail(title, level, type, noun) {
  return `
    <div class="rail-box">
      <h3 class="rail-head">${escapeHtml(title)}</h3>
      <ul class="rail-list">
        ${PAPER_YEARS.map(year => `<li><a href="#" ${catAttrs({ level, type, query: year })}>${year} ${escapeHtml(noun)}</a></li>`).join('')}
      </ul>
    </div>
  `;
}

function loginRail() {
  return `
    <div class="rail-box login-box">
      <h3 class="rail-head">School portals</h3>
      <p>For registered schools only: records, dashboards, assignments and results. The library above stays open without login.</p>
      <a class="primary-btn" href="${CONFIG.schoolLoginUrl}">Find school portal</a>
      <a class="secondary-btn" href="${CONFIG.createSchoolUrl}">Create a school portal</a>
    </div>
  `;
}

function termlyRail() {
  const items = [
    { label: 'Opener Exams', type: 'exam', level: 'all', query: 'opener' },
    { label: 'Midterm Exams', type: 'exam', level: 'all', query: 'midterm' },
    { label: 'Endterm Exams', type: 'exam', level: 'all', query: 'endterm' }
  ];
  return rail('Termly Exams', items);
}

function subjectRail() {
  const items = BROWSE_SUBJECTS.slice(0, 9).map(subject => ({ label: subject, type: 'all', level: 'all', subject }));
  return rail('Browse by subject', items);
}

function contributeRail() {
  return `
    <div class="rail-box contribute-box">
      <h3 class="rail-head">Share a resource</h3>
      <p>Have a useful scheme, note, past paper or marking scheme? Submit it for review so other teachers and learners can use it.</p>
      <button class="secondary-btn contribute-open" type="button" data-action="contribute-resource">Submit a resource</button>
    </div>
  `;
}

function rail(title, items) {
  return `
    <div class="rail-box">
      <h3 class="rail-head">${escapeHtml(title)}</h3>
      <ul class="rail-list">
        ${items.map(i => `<li><a href="#" ${catAttrs(i)}>${escapeHtml(i.label)}</a></li>`).join('')}
      </ul>
    </div>
  `;
}

/* ---------------------------------------------------------- faq + footer --- */

function faq() {
  return `
    <section class="faq" aria-label="Frequently asked questions">
      <h2 class="block-head">Frequently asked questions</h2>
      <div class="faq-list">
        ${FAQS.map(item => `
          <details class="faq-item">
            <summary>${escapeHtml(item.q)}</summary>
            <p>${escapeHtml(item.a)}</p>
          </details>
        `).join('')}
      </div>
    </section>
  `;
}

function footer() {
  return `
    <footer class="home-footer">
      <div class="home-footer-main">
        <span>Daraja Digital Library: free CBC &amp; KCSE learning materials.</span>
        <a class="footer-contact" href="mailto:${escapeHtml(CONFIG.supportEmail)}">Contact support: ${escapeHtml(CONFIG.supportEmail)}</a>
      </div>
      <small>&copy; ${new Date().getFullYear()} ${escapeHtml(CONFIG.org)} &middot; ${escapeHtml(CONFIG.domain)}</small>
    </footer>
  `;
}
