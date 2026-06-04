import { CONFIG } from '../config.js';

const ADMIN_BASE = `${CONFIG.apiBase}/resource-admin`;

async function adminRequest(path, options = {}) {
  const init = {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    ...options
  };
  if (options.body && typeof options.body !== 'string') {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${ADMIN_BASE}${path}`, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    throw new Error(payload.message || `Resource admin request failed (${response.status})`);
  }
  return payload;
}

export async function adminMe() {
  return adminRequest('/me');
}

export async function adminLogin(username, password) {
  return adminRequest('/login', {
    method: 'POST',
    body: { username, password }
  });
}

export async function adminLogout() {
  return adminRequest('/logout', { method: 'POST' });
}

export async function adminFetchResources(query = '') {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  const suffix = params.toString() ? `?${params}` : '';
  const payload = await adminRequest(`/resources${suffix}`);
  return payload.resources || payload.data?.resources || [];
}

export async function adminFetchAnalytics() {
  const payload = await adminRequest('/resources/analytics');
  return payload.data || {};
}

export async function adminSaveResource(resource, id = null) {
  const path = id ? `/resources/${encodeURIComponent(id)}` : '/resources';
  const method = id ? 'PUT' : 'POST';
  return adminRequest(path, { method, body: resource });
}

export async function adminArchiveResource(id) {
  return adminRequest(`/resources/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function adminFetchSubmissions() {
  const payload = await adminRequest('/submissions');
  return payload.submissions || payload.data?.submissions || [];
}

export async function adminUpdateSubmission(id, body) {
  return adminRequest(`/submissions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body
  });
}
