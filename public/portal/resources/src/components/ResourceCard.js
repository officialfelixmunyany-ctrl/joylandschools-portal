import { escapeHtml } from '../utils/dom.js';

// A public resource with a real file opens directly in a new tab (no reader dialog).
// Protected items and read-online items (no file) fall back to the button handler.
function directFileUrl(resource) {
  const url = resource && resource.fileUrl;
  return url && url !== '#' && !resource.protected ? url : '';
}

export function ResourceCard(resource, { saved = false, read = false } = {}) {
  const audienceData = resource.audience;
  const audienceValues = Array.isArray(audienceData) ? audienceData : (audienceData ? [audienceData] : ['everyone']);
  const audience = audienceValues.map(audienceLabel).join(' + ');
  const accessLabel = resource.accessLabel || (resource.protected ? 'Login required' : 'Free');
  const downloads = Number(resource.downloads_count ?? resource.downloads ?? 0);
  const rating = Number(resource.rating || 0);

  return `
    <article class="resource-card" data-resource-id="${resource.id}">
      <div class="resource-card-top">
        <span class="badge">${escapeHtml(typeLabel(resource.type))}${resource.featured ? ' - Featured' : ''}</span>
        <button class="save-btn ${saved ? 'saved' : ''}" type="button" data-action="save" data-id="${resource.id}" aria-label="${saved ? 'Remove saved resource' : 'Save resource'}">
          <span aria-hidden="true">${saved ? '&#9733;' : '&#9734;'}</span>
          <span>${saved ? 'Saved' : 'Save'}</span>
        </button>
      </div>

      <h3>${escapeHtml(resource.title || 'Untitled Resource')}</h3>
      <p>${escapeHtml(resource.summary || '')}</p>

      <dl class="resource-meta">
        <div><dt>Audience</dt><dd>${escapeHtml(audience)}</dd></div>
        <div><dt>Level</dt><dd>${escapeHtml(resource.grade || 'N/A')}</dd></div>
        <div><dt>Subject</dt><dd>${escapeHtml(resource.subject || 'General')}</dd></div>
        <div><dt>Type</dt><dd>${escapeHtml(typeLabel(resource.type))}</dd></div>
        <div><dt>Downloads</dt><dd>${downloads.toLocaleString()}</dd></div>
        <div><dt>Rating</dt><dd>${rating ? `${rating.toFixed(1)}/5` : 'Not rated'}</dd></div>
        <div><dt>Access</dt><dd>${escapeHtml(accessLabel)}</dd></div>
      </dl>

      <div class="resource-card-bottom">
        <span>${escapeHtml(resource.format || '')}${resource.file_size ? ` - ${fileSize(resource.file_size)}` : ''}${read ? ' - opened' : ''}</span>
        ${directFileUrl(resource)
          ? `<a class="open-resource" href="${escapeHtml(directFileUrl(resource))}" target="_blank" rel="noopener" data-action="track" data-id="${resource.id}">${read ? 'Open again' : 'Open file'}</a>`
          : `<button class="open-resource" type="button" data-action="open" data-id="${resource.id}">${resource.protected ? 'View access' : 'Open Resource'}</button>`}
      </div>
    </article>
  `;
}

export function ResourceListItem(resource) {
  const inner = `
    <span class="file-icon-wrap ${escapeHtml(fileIconTone(resource))}" aria-hidden="true">
      <i class="${escapeHtml(fileIconClass(resource))} file-icon"></i>
    </span>
    <span class="resource-row-title">${escapeHtml(displayName(resource))}</span>`;
  const url = directFileUrl(resource);
  const control = url
    ? `<a class="resource-file-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" data-action="track" data-id="${resource.id}">${inner}</a>`
    : `<button class="resource-file-link" type="button" data-action="open" data-id="${resource.id}">${inner}</button>`;
  return `
    <li class="resource-row" data-resource-id="${resource.id}">
      <div class="resource-row-main">${control}</div>
    </li>
  `;
}

export function typeLabel(type) {
  if (!type) return 'Resource';
  return String(type)
    .replace(/_/g, '-')
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function displayName(resource) {
  const title = String(resource.title || 'Untitled resource').trim();
  if (/\.(pdf|docx?|xlsx?|pptx?|zip)$/i.test(title)) return title;
  const format = String(resource.format || '').toLowerCase();
  if (format.includes('doc')) return `${title}.docx`;
  if (format.includes('pdf')) return `${title}.pdf`;
  return title;
}

function fileIconClass(resource) {
  const text = `${resource.format || ''} ${resource.fileUrl || ''} ${resource.title || ''}`.toLowerCase();
  if (text.includes('pdf')) return 'fa-regular fa-file-pdf';
  if (text.includes('doc')) return 'fa-regular fa-file-word';
  if (text.includes('xls')) return 'fa-regular fa-file-excel';
  if (text.includes('ppt')) return 'fa-regular fa-file-powerpoint';
  return 'fa-regular fa-file-lines';
}

function fileIconTone(resource) {
  const text = `${resource.format || ''} ${resource.fileUrl || ''} ${resource.title || ''}`.toLowerCase();
  if (text.includes('pdf')) return 'file-pdf';
  if (text.includes('doc')) return 'file-doc';
  if (text.includes('xls')) return 'file-xls';
  if (text.includes('ppt')) return 'file-ppt';
  return 'file-generic';
}

function audienceLabel(value) {
  const key = String(value || '').toLowerCase();
  if (key === 'teacher') return 'Teacher';
  if (key === 'learner') return 'Learner';
  if (key === 'school') return 'School';
  return 'Everyone';
}

function fileSize(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
