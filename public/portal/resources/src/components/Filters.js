import { AUDIENCES, LEVELS, RESOURCE_TYPES, SUBJECTS } from '../config.js';
import { escapeHtml } from '../utils/dom.js';
import { SearchBar } from './SearchBar.js';

export function FilterBar(filters) {
  return `
    <section class="filter-panel" aria-label="Resource filters">
      ${SearchBar(filters.query)}

      <div class="quick-tabs" role="group" aria-label="Who are you finding resources for?">
        <span class="filter-label">Audience</span>
        ${AUDIENCES.map(item => chip('audience', item.id, item.label, filters.audience)).join('')}
      </div>

      <div class="filter-grid">
        ${select('level', 'Level', LEVELS, filters.level)}
        ${select('type', 'Resource type', RESOURCE_TYPES, filters.type)}
        ${subjectSelect(filters.subject)}
        ${select('sort', 'Sort by', [
          { id: 'relevance', label: 'Best match' },
          { id: 'newest', label: 'Newest' },
          { id: 'popular', label: 'Most used' },
          { id: 'downloads', label: 'Most downloaded' }
        ], filters.sort)}
      </div>
    </section>
  `;
}

function chip(name, value, label, active) {
  return `<button class="choice-chip ${active === value ? 'active' : ''}" type="button" data-filter-name="${name}" data-filter-value="${value}">${escapeHtml(label)}</button>`;
}

function select(name, label, options, current) {
  return `
    <label class="field">
      <span>${label}</span>
      <select data-filter-select="${name}">
        ${options.map(option => `<option value="${option.id}" ${current === option.id ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    </label>
  `;
}

function subjectSelect(current) {
  return `
    <label class="field">
      <span>Subject</span>
      <select data-filter-select="subject">
        <option value="all" ${current === 'all' ? 'selected' : ''}>All subjects</option>
        ${SUBJECTS.map(subject => `<option value="${escapeHtml(subject)}" ${current === subject ? 'selected' : ''}>${escapeHtml(subject)}</option>`).join('')}
      </select>
    </label>
  `;
}
