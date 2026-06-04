const STORAGE_KEYS = {
  filters: 'civicom.library.filters',
  saved: 'civicom.library.saved',
  reads: 'civicom.library.reads'
};

const DEFAULT_FILTERS = {
  query: '',
  audience: 'all',
  level: 'all',
  type: 'all',
  subject: 'all',
  sort: 'relevance'
};

const listeners = new Set();

export const store = {
  state: {
    filters: loadJson(STORAGE_KEYS.filters, DEFAULT_FILTERS),
    resources: [],
    savedIds: loadJson(STORAGE_KEYS.saved, []),
    readIds: loadJson(STORAGE_KEYS.reads, []),
    loading: false,
    error: ''
  },

  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  set(partial) {
    this.state = { ...this.state, ...partial };
    persist(this.state);
    listeners.forEach(listener => listener(this.state));
  },

  updateFilters(partial) {
    this.set({ filters: { ...this.state.filters, ...partial } });
  },

  resetFilters() {
    this.set({ filters: DEFAULT_FILTERS });
  },

  toggleSaved(id) {
    const exists = this.state.savedIds.includes(id);
    const savedIds = exists ? this.state.savedIds.filter(item => item !== id) : [...this.state.savedIds, id];
    this.set({ savedIds });
    return !exists;
  },

  markRead(id) {
    if (!this.state.readIds.includes(id)) this.set({ readIds: [...this.state.readIds, id] });
  }
};

function persist(state) {
  localStorage.setItem(STORAGE_KEYS.filters, JSON.stringify(state.filters));
  localStorage.setItem(STORAGE_KEYS.saved, JSON.stringify(state.savedIds));
  localStorage.setItem(STORAGE_KEYS.reads, JSON.stringify(state.readIds));
}

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
