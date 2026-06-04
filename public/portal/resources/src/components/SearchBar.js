import { escapeHtml } from '../utils/dom.js';

/**
 * Instant-search input row used at the top of the resource library.
 * Emits standard `input` events on `#search-input`; main.js binds the handler.
 */
export function SearchBar(query = '') {
  return `
    <div class="search-row">
      <label class="search-box">
        <span>Search resources</span>
        <span class="search-field">
          <span class="search-icon" aria-hidden="true">&#9906;</span>
          <input
            id="search-input"
            type="search"
            value="${escapeHtml(query)}"
            placeholder="Search by subject, grade, topic, or exam (e.g. KCSE Biology)"
            autocomplete="off"
            enterkeyhint="search"
            aria-label="Search learning resources"
          />
        </span>
      </label>
      <button class="filter-reset" type="button" data-action="reset-filters">Reset</button>
    </div>
  `;
}
