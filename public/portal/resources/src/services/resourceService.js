import { CONFIG, LEVEL_GROUPS } from '../config.js';
import { MOCK_RESOURCES } from '../data/resources.js';

const CACHE_TTL_MS = 90_000;
const responseCache = new Map();
const inFlight = new Map();
let sessionPromise;

export async function fetchResources(filters = {}) {
  const normalizedFilters = normalizeFilters(filters);
  const params = buildResourceParams(normalizedFilters);
  const cacheKey = params.toString();
  const cached = responseCache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.resources;
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const request = fetch(`${CONFIG.apiBase}/resources?${params}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' }
  })
    .then(async response => {
      if (!response.ok) throw new Error(`Resources API returned ${response.status}`);
      const payload = await response.json();
      const session = await getSessionInfo();
      const resources = extractResources(payload)
        .map(normalizeResource)
        .filter(resource => canDisplayResource(resource, session));
      responseCache.set(cacheKey, { time: Date.now(), resources });
      return resources;
    })
    .catch(error => {
      console.warn('[resources] API request failed', error);
      if (CONFIG.useMockFallback) return filterResources(MOCK_RESOURCES.map(normalizeResource), normalizedFilters);
      return [];
    })
    .finally(() => inFlight.delete(cacheKey));

  inFlight.set(cacheKey, request);
  return request;
}

export async function fetchResourceDetail(id, resources = []) {
  const local = getResourceById(id, resources);
  try {
    const response = await fetch(`${CONFIG.apiBase}/resources/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return local ? { ...local, protected: true, accessLabel: 'Login required' } : null;
      }
      throw new Error(`Resource detail returned ${response.status}`);
    }
    const payload = await response.json();
    return normalizeResource(payload.data || payload.resource || payload);
  } catch (error) {
    console.warn('[resources] detail request failed', error);
    return local;
  }
}

export function getResourceById(id, resources = []) {
  const match = resources.find(resource => Number(resource.id) === Number(id));
  if (match) return match;
  if (CONFIG.useMockFallback) return MOCK_RESOURCES.map(normalizeResource).find(resource => Number(resource.id) === Number(id));
  return null;
}

export async function trackResourceDownload(resource) {
  if (!resource?.id || resource.fileUrl === '#') return;
  try {
    await fetch(`${CONFIG.apiBase}/resources/${encodeURIComponent(resource.id)}/download`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    });
    responseCache.clear();
  } catch (error) {
    console.warn('[resources] download tracking failed', error);
  }
}

export function filterResources(resources, filters = {}) {
  const normalizedFilters = normalizeFilters(filters);
  const query = normalizedFilters.query.trim().toLowerCase();

  let result = resources.filter(resource => {
    const text = [resource.title, resource.summary, resource.grade, resource.subject, resource.year, resource.type, resource.format]
      .join(' ')
      .toLowerCase();
    const matchesQuery = !query || text.includes(query);
    const matchesAudience = normalizedFilters.audience === 'all' || resource.audience.includes(normalizedFilters.audience) || resource.audience.includes('everyone');
    const matchesLevel = levelMatches(normalizedFilters.level, resource);
    const matchesType = normalizedFilters.type === 'all' || resource.type === normalizedFilters.type;
    const matchesSubject = normalizedFilters.subject === 'all' || String(resource.subject).toLowerCase() === normalizedFilters.subject.toLowerCase();
    return matchesQuery && matchesAudience && matchesLevel && matchesType && matchesSubject;
  });

  if (normalizedFilters.sort === 'newest') result = result.sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')));
  if (['popular', 'downloads'].includes(normalizedFilters.sort)) result = result.sort((a, b) => b.downloads - a.downloads);
  return result;
}

export function collectStats(resources = []) {
  return {
    total: resources.length,
    subjects: new Set(resources.map(resource => resource.subject).filter(Boolean)).size,
    teacher: resources.filter(resource => resource.audience.includes('teacher') || resource.audience.includes('everyone')).length,
    learner: resources.filter(resource => resource.audience.includes('learner') || resource.audience.includes('everyone')).length
  };
}

function buildResourceParams(filters) {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (filters.type !== 'all') params.set('type', filters.type);
  if (filters.subject !== 'all') params.set('subject', filters.subject);
  if (filters.level !== 'all') {
    params.set('level', mapLevelForApi(filters.level));
    const grade = mapLevelToGrade(filters.level);
    if (grade) params.set('grade', grade);
  }
  if (filters.audience !== 'all') params.set('audience', filters.audience || 'everyone');
  if (filters.sort && filters.sort !== 'relevance') params.set('sort', filters.sort);
  if (filters.published !== undefined && filters.published !== 'all') params.set('published', filters.published);
  return params;
}

function normalizeFilters(filters) {
  return {
    query: String(filters.query || '').trim(),
    audience: filters.audience || 'all',
    level: filters.level || 'all',
    type: normalizeType(filters.type || 'all'),
    subject: filters.subject || 'all',
    sort: filters.sort || 'relevance',
    published: filters.published
  };
}

function extractResources(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.resources)) return payload.resources;
  if (Array.isArray(payload?.data?.resources)) return payload.data.resources;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function normalizeResource(resource = {}) {
  const type = normalizeType(resource.type || 'notes');
  const visibility = String(resource.visibility || (resource.protected ? 'registered' : 'public')).toLowerCase();
  const audience = normalizeAudience(resource.audience || inferAudience({ ...resource, type }));
  const downloads = Number(resource.downloads_count ?? resource.downloads ?? 0);
  const premium = Boolean(resource.premium) || visibility === 'premium';
  const fileUrl = resolveResourceUrl(resource.fileUrl || resource.file_url || resource.file_path);

  return {
    id: resource.id,
    title: resource.title || 'Untitled resource',
    type,
    audience,
    level: normalizeLevel(resource.level || inferLevel(resource.grade)),
    grade: resource.grade || levelToGradeLabel(resource.level) || 'General',
    subject: resource.subject || 'General',
    year: resource.year || '',
    format: resource.format || formatFromMime(resource.mime_type, fileUrl),
    minutes: Number(resource.minutes) || 10,
    downloads,
    downloads_count: downloads,
    rating: Number(resource.rating || 0),
    summary: resource.summary || resource.description || summaryFromBody(resource.body_html || resource.body),
    body: resource.body || resource.body_html || '<p>This resource is available for reading.</p>',
    fileUrl,
    thumbnail: resolveResourceUrl(resource.thumbnail),
    slug: resource.slug || '',
    file_size: Number(resource.file_size || 0),
    mime_type: resource.mime_type || '',
    visibility,
    premium,
    featured: Boolean(resource.is_featured || resource.featured),
    verified: Boolean(resource.is_verified || resource.verified),
    protected: isProtectedVisibility(visibility) || premium || Boolean(resource.protected || resource.requires_login),
    accessLabel: accessLabelFor(visibility, premium)
  };
}

// Group levels (e.g. grade-1-9) expand to several concrete levels.
function levelMatches(filterLevel, resource) {
  if (!filterLevel || filterLevel === 'all') return true;
  const group = LEVEL_GROUPS[filterLevel];
  if (group) return group.some(level => resource.level === level || levelMatchesGrade(level, resource.grade));
  return resource.level === filterLevel || levelMatchesGrade(filterLevel, resource.grade);
}

function normalizeType(type) {
  const value = String(type || '').trim().toLowerCase().replaceAll('_', '-');
  const aliases = {
    pastpaper: 'past-paper',
    'past-papers': 'past-paper',
    'knec-past-papers': 'past-paper',
    'county-mock': 'mock',
    'county-mocks': 'mock',
    mocks: 'mock',
    'termly-exam': 'exam',
    'termly-exams': 'exam',
    'end-term-exam': 'exam',
    exams: 'exam',
    'revision-booklet': 'revision',
    'revision-booklets': 'revision',
    booklet: 'revision',
    'topic-tests': 'topic-test',
    topical: 'topic-test',
    'topical-questions': 'topic-test',
    'topical-question': 'topic-test',
    'marking-schemes': 'marking-scheme',
    markingscheme: 'marking-scheme',
    'marking-key': 'marking-scheme',
    'answer-key': 'marking-scheme',
    predictions: 'prediction',
    'prediction-paper': 'prediction',
    'prediction-papers': 'prediction',
    'joint-exam': 'mock',
    'joint-exams': 'mock',
    'joint-mock': 'mock',
    'records-of-work': 'record-of-work',
    'record-of-work-covered': 'record-of-work',
    'records-of-work-covered': 'record-of-work',
    'tpad-tools': 'tpad',
    appraisal: 'tpad',
    'setbook-guides': 'setbook-guide',
    setbook: 'setbook-guide',
    'holiday-assignment': 'assignment',
    'holiday-assignments': 'assignment',
    assignments: 'assignment',
    lessonplan: 'lesson-plan',
    'lesson-plans': 'lesson-plan',
    curriculumdesign: 'curriculum-design',
    syllabus: 'curriculum-design',
    teacher_guide: 'teacher-guide',
    teacherguide: 'teacher-guide'
  };
  return aliases[value] || value || 'notes';
}

function normalizeLevel(level) {
  const value = String(level || '').trim().toLowerCase().replaceAll('_', '-');
  const aliases = {
    primary: 'cbc-primary',
    cbc: 'cbc-primary',
    'pre-primary': 'pre-primary',
    preprimary: 'pre-primary',
    pp: 'pre-primary',
    pp1: 'pre-primary',
    pp2: 'pre-primary',
    'junior-secondary': 'junior-secondary',
    juniorsecondary: 'junior-secondary',
    'grade-10': 'senior-secondary',
    grade10: 'senior-secondary',
    secondary: 'senior-secondary',
    '844': 'secondary-844',
    '8-4-4': 'secondary-844',
    teacher: 'teacher'
  };
  return aliases[value] || value || 'all';
}

function mapLevelForApi(level) {
  return {
    'pre-primary': 'pre_primary',
    'cbc-primary': 'primary',
    'junior-secondary': 'junior_secondary',
    'grade-1-9': 'grade_1_9',
    'senior-secondary': 'secondary',
    'secondary-844': '844',
    teacher: 'teacher',
    cbc: 'cbc'
  }[level] || level;
}

function mapLevelToGrade(level) {
  return {
    'cbc-primary': '',
    'junior-secondary': '',
    'senior-secondary': '',
    'secondary-844': ''
  }[level] || '';
}

function normalizeAudience(audience) {
  const values = Array.isArray(audience) ? audience : String(audience || 'everyone').split(/[,+]/);
  const normalized = values
    .map(item => String(item).trim().toLowerCase())
    .filter(Boolean)
    .map(item => item === 'all' ? 'everyone' : item);
  return normalized.length ? [...new Set(normalized)] : ['everyone'];
}

function canDisplayResource(resource, session) {
  if (resource.visibility === 'private') return session.authenticated && session.user?.role === 'admin';
  if (resource.visibility === 'registered') return session.authenticated;
  if (['school_only', 'school-only', 'tenant'].includes(resource.visibility)) return session.authenticated && Boolean(session.user?.school_id);
  return true;
}

function isProtectedVisibility(visibility) {
  return ['registered', 'school_only', 'school-only', 'tenant', 'private'].includes(visibility);
}

function accessLabelFor(visibility, premium) {
  if (premium) return 'Premium';
  if (visibility === 'registered') return 'Login required';
  if (['school_only', 'school-only', 'tenant'].includes(visibility)) return 'School login';
  if (visibility === 'private') return 'Admin only';
  return 'Free';
}

function resolveResourceUrl(path) {
  const value = String(path || '').trim();
  if (!value) return '#';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/uploads/')) return value;
  if (value.startsWith('uploads/')) return `/${value}`;
  if (value.startsWith('/')) return value;
  return `/uploads/resources/${encodeURIComponent(value)}`;
}

function inferAudience(resource) {
  const type = String(resource.type || '').toLowerCase();
  if (type.includes('lesson') || type.includes('scheme') || type.includes('teacher-guide')) return ['teacher'];
  return ['learner', 'teacher'];
}

function inferLevel(grade = '') {
  const value = String(grade).toLowerCase();
  if (value.includes('grade 1') || value.includes('grade 2') || value.includes('grade 3')) return 'cbc-primary';
  if (value.includes('grade 4') || value.includes('grade 5') || value.includes('grade 6')) return 'cbc-primary';
  if (value.includes('grade 7') || value.includes('grade 8') || value.includes('grade 9')) return 'junior-secondary';
  if (value.includes('grade 10') || value.includes('grade 11') || value.includes('grade 12')) return 'senior-secondary';
  if (value.includes('form')) return 'secondary-844';
  return 'all';
}

function levelMatchesGrade(level, grade = '') {
  return inferLevel(grade) === level;
}

function levelToGradeLabel(level) {
  return {
    primary: 'CBC Primary',
    junior_secondary: 'Junior School',
    secondary: 'Senior Secondary',
    cbc: 'CBC',
    844: 'Secondary 8-4-4'
  }[String(level || '')] || '';
}

function formatFromMime(mime, fileUrl) {
  const value = String(mime || '').toLowerCase();
  if (value.includes('pdf')) return 'PDF';
  if (value.includes('word') || fileUrl.endsWith('.docx') || fileUrl.endsWith('.doc')) return 'DOCX';
  if (value.includes('spreadsheet') || fileUrl.endsWith('.xlsx')) return 'Excel';
  if (value.startsWith('image/')) return 'Image';
  return fileUrl !== '#' ? 'Download' : 'Read online';
}

function summaryFromBody(body = '') {
  const text = String(body).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? `${text.slice(0, 150)}${text.length > 150 ? '...' : ''}` : 'Open this resource to read more.';
}

async function getSessionInfo() {
  if (!sessionPromise) {
    sessionPromise = fetch(`${CONFIG.authBase || '/api'}/auth/me`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    })
      .then(response => response.ok ? response.json() : { authenticated: false })
      .catch(() => ({ authenticated: false }));
  }
  return sessionPromise;
}
