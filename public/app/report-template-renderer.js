/* Shared admin report-card preview renderer for the teacher app.
   Extracted from public/admin.html so mobile reports match the admin Preview button. */
(function(){
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
const CBC_LEVELS = [
  { code:'EE1', descriptor:'Exceeding Expectations', points:8, min:90, label:'Exceptional' },
  { code:'EE2', descriptor:'Exceeding Expectations', points:7, min:75, label:'Very Good' },
  { code:'ME1', descriptor:'Meeting Expectations', points:6, min:58, label:'Good' },
  { code:'ME2', descriptor:'Meeting Expectations', points:5, min:41, label:'Fair' },
  { code:'AE1', descriptor:'Approaching Expectations', points:4, min:31, label:'Needs Improvement' },
  { code:'AE2', descriptor:'Approaching Expectations', points:3, min:21, label:'Below Average' },
  { code:'BE1', descriptor:'Below Expectations', points:2, min:11, label:'Poor' },
  { code:'BE2', descriptor:'Below Expectations', points:1, min:0, label:'Very Poor' }
];
function getGrade(total) {
  if (total === null || total === undefined || Number.isNaN(Number(total))) return null;
  const score = Math.max(0, Math.min(100, Number(total)));
  return CBC_LEVELS.find(level => score >= level.min) || CBC_LEVELS[CBC_LEVELS.length - 1];
}
function reportParseTermWeekdays(value) {
  if (Array.isArray(value)) return value;
  if (!value) return ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length ? parsed : ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  } catch(e) {
    return ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  }
}
function calcSchoolDays(startDate, endDate, weekdays, holidays) {
  const dayMap={Sunday:0,Monday:1,Tuesday:2,Wednesday:3,Thursday:4,Friday:5,Saturday:6};
  const selectedNums=new Set((weekdays || []).map(d=>dayMap[d]));
  const start=new Date(startDate+'T00:00:00'), end=new Date(endDate+'T00:00:00');
  if(Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  const hDates=new Set();
  (holidays || []).forEach(h=>{
    const hs=new Date(h.start_date+'T00:00:00'), he=new Date(h.end_date+'T00:00:00'), c=new Date(hs);
    while(c<=he){ hDates.add(c.toISOString().split('T')[0]); c.setDate(c.getDate()+1); }
  });
  let count=0; const cur=new Date(start);
  while(cur<=end){ if(selectedNums.has(cur.getDay()) && !hDates.has(cur.toISOString().split('T')[0])) count++; cur.setDate(cur.getDate()+1); }
  return count;
}
function reportRendererGlobals(){
  window.allClasses = window.allClasses || [];
  window.allLearners = window.allLearners || [];
  window.allClassSubjects = window.allClassSubjects || [];
  window.cachedTerms = window.cachedTerms || [];
  window.commentBankCache = window.commentBankCache || { class_teacher:[], headteacher:[], director:[] };
  window.signaturesCache = window.signaturesCache || { class_teacher:'', headteacher:'', director:'' };
  window.ASSESSMENT_OPTIONS = window.ASSESSMENT_OPTIONS || [
    { value:'opener', label:'Opener' },
    { value:'midterm', label:'Midterm' },
    { value:'endterm', label:'Endterm' }
  ];
}
reportRendererGlobals();
const reportComponentCache = {};

function reportClassById(classId){
  return (allClasses||[]).find(c=>String(c.id)===String(classId));
}
function reportTermById(termId){
  return (cachedTerms||[]).find(t=>String(t.id)===String(termId));
}
function reportClassName(classId){
  return reportClassById(classId)?.name || '';
}
function reportTermLabel(termId){
  return reportTermById(termId)?.label || '';
}
function reportAssessmentLabel(value){
  return (ASSESSMENT_OPTIONS.find(a=>a.value===value)||{}).label || value || '';
}
function reportLearnersForClass(classId){
  const cls = reportClassById(classId);
  if(!cls) return [];
  const className = String(cls.name||'').toLowerCase();
  return (allLearners||[])
    .filter(l=>String(l.status||'active')!=='inactive')
    .filter(l=>String(l.class_name||'').toLowerCase()===className)
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||'')));
}
function reportSubjectsForClass(classId){
  return (allClassSubjects||[])
    .filter(cs=>String(cs.class_id)===String(classId))
    .sort((a,b)=>String(a.subject_name||'').localeCompare(String(b.subject_name||'')));
}
function reportCanvasEmpty(icon, title, body){
  return `<div class="report-canvas-empty"><i class="fas ${icon}"></i><h4>${escapeHtml(title)}</h4><p>${escapeHtml(body)}</p></div>`;
}
function fitReportTemplateSheets(root=document){
  (root || document).querySelectorAll('.report-template-sheet').forEach(sheet=>{
    const page = sheet.querySelector('.template-preview-report');
    if(!page) return;
    page.style.setProperty('--report-content-scale', '1');
    const needed = page.scrollHeight || 0;
    const available = sheet.clientHeight || 0;
    if(needed > available && available > 0){
      const scale = Math.max(0.86, Math.min(1, (available - 8) / needed));
      page.style.setProperty('--report-content-scale', scale.toFixed(4));
    }
  });
}
function resetReportTemplatePrintScale(root=document){
  (root || document).querySelectorAll('.report-template-sheet .template-preview-report').forEach(page=>{
    page.style.setProperty('--report-content-scale', '1');
    page.style.transform = 'none';
    page.style.width = '100%';
    page.style.height = '100%';
  });
}
function setReportCanvas(id, html, hasOutput=true){
  const el = document.getElementById(id);
  if(!el) return;
  el.classList.toggle('has-output', !!hasOutput);
  el.innerHTML = html;
  if(hasOutput) requestAnimationFrame(()=>fitReportTemplateSheets(el));
}
function reportHeader(title, classId, termId, assessment, extra=''){
  const meta = [reportClassName(classId), reportTermLabel(termId), reportAssessmentLabel(assessment), extra].filter(Boolean).join(' &middot; ');
  return `<div class="report-output-header"><div><h3>${escapeHtml(title)}</h3><p>${meta}</p></div></div>`;
}
function fillReportTermSelect(id){
  const el = document.getElementById(id);
  if(!el) return;
  const current = el.value;
  populateTermSelect(id);
  if(current && (cachedTerms||[]).some(t=>String(t.id)===String(current))) el.value = current;
}
function fillReportClassSelect(id){
  const el = document.getElementById(id);
  if(!el) return;
  const current = el.value;
  el.innerHTML = '<option value="">Select Class</option>' +
    (allClasses||[]).map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  if(current && (allClasses||[]).some(c=>String(c.id)===String(current))) el.value = current;
}
function fillReportAssessmentSelect(id){
  const el = document.getElementById(id);
  if(!el) return;
  const current = el.value || 'endterm';
  el.innerHTML = ASSESSMENT_OPTIONS.map(a=>`<option value="${a.value}">${a.label}</option>`).join('');
  if(current) el.value = current;
}
function fillReportSubjectSelect(id, withAll){
  const el = document.getElementById(id);
  if(!el) return;
  const current = el.value;
  const opts = (allSubjects||[]).map(s=>`<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  el.innerHTML = (withAll?'<option value="">All Subjects</option>':'') + opts;
  if(current && (allSubjects||[]).some(s=>String(s.id)===String(current))) el.value = current;
}
function componentChip(c, selected=true){
  const key = c.component_key || c.key || c.component_name || c.name;
  const name = c.component_name || c.name || key;
  const max = c.max_score!=null ? ` / ${c.max_score}` : '';
  return `<span class="cmp-chip ${selected?'on':'off'}" data-ckey="${escapeHtml(key)}" data-cname="${escapeHtml(name)}" data-cmax="${escapeHtml(c.max_score ?? '')}" onclick="this.classList.toggle('on');this.classList.toggle('off');">${escapeHtml(name)}${max?` <span style="font-size:9px;opacity:.75;">${escapeHtml(max)}</span>`:''}</span>`;
}
async function reportComponentsForSubject(classId, subjectId, assessment){
  if(!classId || !subjectId || !assessment) return [];
  const cacheKey = `${classId}_${subjectId}_${assessment}`;
  if(reportComponentCache[cacheKey]) return reportComponentCache[cacheKey];
  const d = await api('GET',`/api/admin/assessment-components?class_id=${encodeURIComponent(classId)}&subject_id=${encodeURIComponent(subjectId)}&assessment_type=${encodeURIComponent(assessment)}`);
  if(!d.success) return [];
  const components = (d.data?.components||[]).map(c=>({
    component_key:c.component_key,
    component_name:c.component_name,
    max_score:c.max_score,
    sort_order:c.sort_order
  }));
  reportComponentCache[cacheKey] = components;
  return components;
}
async function reportComponentsForClass(classId, assessment){
  const subjects = reportSubjectsForClass(classId);
  const lists = await Promise.all(subjects.map(s=>reportComponentsForSubject(classId, s.subject_id, assessment).catch(()=>[])));
  const byKey = new Map();
  lists.flat().forEach(c=>{
    if(!c.component_key) return;
    if(!byKey.has(c.component_key)) byKey.set(c.component_key, c);
  });
  return Array.from(byKey.values()).sort((a,b)=>
    Number(a.sort_order||0)-Number(b.sort_order||0) || String(a.component_name||'').localeCompare(String(b.component_name||'')));
}
function groupedReportMarks(rows){
  const grouped = {};
  (rows||[]).forEach(m=>{
    const lid = String(m.learner_id);
    const sid = String(m.subject_id);
    const ass = String(m.assessment_type||'');
    const key = String(m.component_key||'');
    if(!lid || !sid || !ass || !key) return;
    if(!grouped[lid]) grouped[lid] = {};
    if(!grouped[lid][sid]) grouped[lid][sid] = {};
    if(!grouped[lid][sid][ass]) grouped[lid][sid][ass] = {};
    grouped[lid][sid][ass][key] = m.score===null || m.score===undefined || m.score==='' ? null : Number(m.score);
  });
  return grouped;
}
function firstReportScore(subjectGroup, assessment, componentKey, strict){
  const preferred = subjectGroup?.[assessment] || {};
  if(preferred[componentKey]!==undefined && preferred[componentKey]!==null) return Number(preferred[componentKey]);
  if(strict) return null;
  for(const ass of Object.keys(subjectGroup||{})){
    if(ass===assessment) continue;
    const scores = subjectGroup[ass] || {};
    if(scores[componentKey]!==undefined && scores[componentKey]!==null) return Number(scores[componentKey]);
  }
  return null;
}
function sumReportComponents(subjectGroup, assessment, componentKeys, strict){
  let total = 0;
  let hasScore = false;
  componentKeys.forEach(key=>{
    const score = firstReportScore(subjectGroup, assessment, key, strict);
    if(score!==null){
      total += score;
      hasScore = true;
    }
  });
  return hasScore ? Math.round(total * 100) / 100 : null;
}
function sumAllMarkedComponents(subjectGroup, assessment, strict){
  const keys = new Set();
  Object.keys(subjectGroup?.[assessment]||{}).forEach(k=>keys.add(k));
  if(!strict){
    Object.values(subjectGroup||{}).forEach(scores=>Object.keys(scores||{}).forEach(k=>keys.add(k)));
  }
  return sumReportComponents(subjectGroup, assessment, Array.from(keys), strict);
}
function reportAverage(values){
  const clean = values.filter(v=>v!==null && v!==undefined && !Number.isNaN(Number(v))).map(Number);
  if(!clean.length) return null;
  return Math.round((clean.reduce((a,b)=>a+b,0)/clean.length) * 100) / 100;
}
function reportTemplateIsMissing(value){
  return value === null || value === undefined || value === '' || Number.isNaN(Number(value));
}
function scoreText(value){
  return reportTemplateIsMissing(value) ? '—' : String(Math.round(Number(value)*100)/100);
}
function percentText(value){
  return reportTemplateIsMissing(value) ? '—' : `${scoreText(value)}%`;
}
function reportTemplateComponentToken(value){
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function reportTemplateComponentEntry(def, score=null, index=0){
  const key = def.key || def.component_key || '';
  const name = def.name || def.component_name || key;
  return Object.assign({}, def, {
    key,
    name,
    score,
    index,
    token:`${reportTemplateComponentToken(key)} ${reportTemplateComponentToken(name)}`.trim()
  });
}
function reportTemplateIsExamEntry(entry){
  return /(exam|exams|endterm|endofterm|final)/.test(entry.token || '');
}
function reportTemplateIsCaEntry(entry){
  const token = entry.token || '';
  return /(ca|cat|test|continuousassessment|assessment)/.test(token) && !reportTemplateIsExamEntry(entry);
}
function reportTemplateNthCaEntry(entries, n){
  return entries.filter(reportTemplateIsCaEntry)[n] || null;
}
function reportTemplateExamEntry(entries){
  return entries.find(reportTemplateIsExamEntry) || null;
}
function reportTemplateEntryByAlias(entries, aliases){
  const tokens = aliases.map(reportTemplateComponentToken).filter(Boolean);
  return entries.find(entry => tokens.some(token => {
    const hay = entry.token || '';
    return hay.split(/\s+/).includes(token) || hay.includes(token);
  })) || null;
}
function reportTemplateComponentForHeader(headerKey, entries){
  const key = String(headerKey || '').toLowerCase();
  if(key === 'ca' || key === 'ca1' || key === 'bot_exams' || key === 'test') {
    return reportTemplateEntryByAlias(entries, ['ca1','cat1','cat_1','test1','test_1']) || reportTemplateNthCaEntry(entries, 0);
  }
  if(key === 'ca2' || key === 'midterm_exams') {
    return reportTemplateEntryByAlias(entries, ['ca2','cat2','cat_2','test2','test_2']) || reportTemplateNthCaEntry(entries, 1);
  }
  if(key === 'ca3') {
    return reportTemplateEntryByAlias(entries, ['ca3','cat3','cat_3','test3','test_3']) || reportTemplateNthCaEntry(entries, 2);
  }
  if(key === 'exam' || key === 'end_of_term_exams') {
    return reportTemplateEntryByAlias(entries, ['exam','exams','endterm','end_term','endofterm','final']) || reportTemplateExamEntry(entries);
  }
  return reportTemplateEntryByAlias(entries, [key]);
}
function reportTemplateScoreForHeader(headerKey, row){
  const entry = reportTemplateComponentForHeader(headerKey, row.componentEntries || []);
  return entry ? entry.score : null;
}
function reportTemplateHeaderMax(header, data){
  if(header.key === 'max') return header.score || data.componentMax || '';
  if(['total','total_score','cum_total_score','average','marks_average','mean'].includes(header.key)) return data.componentMax || header.score || '';
  const entry = reportTemplateComponentForHeader(header.key, data.componentDefs || []);
  if(entry && entry.max_score !== null && entry.max_score !== undefined && entry.max_score !== '') return entry.max_score;
  return '';
}
const REPORT_TEMPLATE_SCORE_KEYS = new Set(['ca','ca1','ca2','ca3','test','exam','bot_exams','midterm_exams','end_of_term_exams']);
function reportTemplateIsComponentHeader(header){
  return !!header && (header.component_key || REPORT_TEMPLATE_SCORE_KEYS.has(String(header.key || '').toLowerCase()));
}
function reportTemplateActualScoreHeaders(data){
  return (data.componentDefs || []).map((component, index)=>({
    key:component.key || component.component_key || `component_${index+1}`,
    label:component.name || component.component_name || component.key || `Component ${index+1}`,
    score:component.max_score ?? '',
    component_key:component.key || component.component_key || '',
    max_score:component.max_score,
    index
  }));
}
function ordinal(n){
  const num = Number(n);
  if(!Number.isFinite(num)) return '-';
  const whole = Math.trunc(num);
  const v = whole % 100;
  if(v >= 11 && v <= 13) return `${whole}th`;
  return `${whole}${['th','st','nd','rd'][Math.min(whole % 10, 4)] || 'th'}`;
}
async function fetchReportMarks({classId, termId, assessment, strict=true, subjectId=''}) {
  const params = new URLSearchParams({ class_id:classId, term_id:termId });
  if(strict && assessment) params.set('assessment_type', assessment);
  if(subjectId) params.set('subject_id', subjectId);
  const d = await api('GET',`/api/admin/marks?${params.toString()}`);
  return d.success ? (d.data||[]) : [];
}
const reportAttendanceSummaryCache = {};
async function fetchReportAttendanceSummary({classId, termId}) {
  const cacheKey = `${classId}_${termId}`;
  if(reportAttendanceSummaryCache[cacheKey]) return reportAttendanceSummaryCache[cacheKey];
  const params = new URLSearchParams({ class_id:classId, term_id:termId });
  try{
    const d = await api('GET',`/api/admin/attendance/summary?${params.toString()}`);
    if(!d.success) throw new Error(d.message || 'Attendance unavailable');
    const opened = Number(d.data?.total_days);
    const data = { opened:Number.isFinite(opened) && opened > 0 ? opened : null, learners:{} };
    (d.data?.learners || []).forEach(l=>{
      data.learners[String(l.id)] = data.opened ? {
        opened:data.opened,
        present:Number(l.present_days || 0),
        absent:Number(l.absent_days || 0)
      } : { opened:null, present:null, absent:null };
    });
    reportAttendanceSummaryCache[cacheKey] = data;
    return data;
  }catch(e){
    return { opened:null, learners:{} };
  }
}
const reportSkillsRatingCache = {};
function reportSkillItemKey(item){
  return String(item || '').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'');
}
async function fetchReportSkillRatings({classId, termId, assessment}) {
  const cacheKey = `${classId}_${termId}_${assessment || ''}`;
  if(reportSkillsRatingCache[cacheKey]) return reportSkillsRatingCache[cacheKey];
  const params = new URLSearchParams({ class_id:classId, term_id:termId });
  if(assessment) params.set('assessment_type', assessment);
  try{
    const d = await api('GET',`/api/admin/skills?${params.toString()}`);
    if(!d.success) throw new Error(d.message || 'Skills unavailable');
    const grouped = {};
    (d.data || []).forEach(row=>{
      const learnerId = String(row.learner_id || '');
      const categoryKey = String(row.category_key || '');
      const itemKey = String(row.item_key || '');
      if(!learnerId || !categoryKey || !itemKey) return;
      if(!grouped[learnerId]) grouped[learnerId] = {};
      if(!grouped[learnerId][categoryKey]) grouped[learnerId][categoryKey] = {};
      grouped[learnerId][categoryKey][itemKey] = reportTemplateIsMissing(row.rating) ? null : String(row.rating);
    });
    reportSkillsRatingCache[cacheKey] = grouped;
    return grouped;
  }catch(e){
    return {};
  }
}
function reportSectionStrict(sectionId){
  return !!document.querySelector(`#${sectionId} .toggle-row.on`);
}
function selectedChipKeys(selector){
  return Array.from(document.querySelectorAll(`${selector} .cmp-chip.on`)).map(c=>c.dataset.ckey || c.textContent.trim());
}
function currentReportPrintSource(){
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal');

  const modalPreviewOpen =
    overlay?.classList.contains('show') &&
    modal?.classList.contains('modal-report-preview');

  if(modalPreviewOpen){
    const modalBody = document.getElementById('modal-body');
    if(modalBody?.querySelector('.report-template-page-stack')){
      return modalBody;
    }
  }

  return document.querySelector('#rpt-canvas.has-output') ||
         document.querySelector('.section.active .report-canvas.has-output') ||
         document.querySelector('.report-canvas.has-output');
}

function reportPrintMarkup(source){
  if(!source) return '';

  const stack = source.matches?.('.report-template-page-stack')
    ? source
    : source.querySelector?.('.report-template-page-stack');

  if(stack){
    return stack.outerHTML;
  }

  const frames = source.matches?.('.report-template-sheet-frame')
    ? [source]
    : Array.from(source.querySelectorAll?.('.report-template-sheet-frame') || []);

  if(frames.length){
    return `<div class="report-template-page-stack">${frames.map(frame=>frame.outerHTML).join('')}</div>`;
  }

  return source.innerHTML;
}

function printReportCanvas(previewPromise){
  return Promise.resolve(previewPromise).then(ok=>{
    if(!ok) return;

    const source = currentReportPrintSource();

    if(!source){
      toast('Click Preview first, then Print.','error');
      return;
    }

    document.getElementById('report-print-root')?.remove();

    const printRoot = document.createElement('div');
    printRoot.id = 'report-print-root';
    printRoot.innerHTML = reportPrintMarkup(source);
    document.body.appendChild(printRoot);
    document.body.classList.add('report-print-open');
    resetReportTemplatePrintScale(document);

    const cleanup = () => {
      document.body.classList.remove('report-print-open');
      document.getElementById('report-print-root')?.remove();
    };

    window.addEventListener('afterprint', cleanup, { once:true });

    setTimeout(()=>{
      window.focus();
      window.print();
      setTimeout(cleanup, 1500);
    }, 250);
  });
}
let reportTemplateStyleReady = false;
let reportTemplateSchoolSettings = null;

async function ensureReportTemplateStyles(){
  if(reportTemplateStyleReady) return;
  try{
    const html = await fetch('/template-editor.html', { cache:'no-store' }).then(r=>r.text());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const styleText = doc.querySelector('style')?.textContent || '';
    const start = styleText.indexOf('.te-preview-shell');
    const end = styleText.indexOf('/* S1: Header */');
    const css = start >= 0 ? styleText.slice(start, end > start ? end : undefined) : '';
    if(css && !document.getElementById('report-template-editor-preview-style')){
      const style = document.createElement('style');
      style.id = 'report-template-editor-preview-style';
      style.textContent = `${css}
.report-template-sheet .template-preview-table{border-collapse:collapse!important;border:var(--table-border-width,2px) solid var(--template-theme-color)!important;}
.report-template-sheet .template-preview-table th,
.report-template-sheet .template-preview-table td,
.report-template-sheet .template-preview-table tr:last-child>td{border:var(--table-border-width,2px) solid var(--template-theme-color)!important;white-space:normal!important;}
:where(.report-template-sheet) .template-preview-table th,
:where(.report-template-sheet) .template-preview-table td{font-size:inherit;line-height:inherit;}
.report-template-sheet .template-preview-table tr:hover>td{background:inherit!important;}
.report-template-sheet .template-preview-report{transform:scale(var(--report-content-scale,1));transform-origin:top left;width:calc(100% / var(--report-content-scale,1));}
.report-template-sheet .template-preview-personal th,
.report-template-sheet .template-preview-personal td,
.report-template-sheet .template-preview-attendance th,
.report-template-sheet .template-preview-attendance td,
.report-template-sheet .template-preview-scorecard th,
.report-template-sheet .template-preview-scorecard td,
.report-template-sheet .template-preview-scorecard-bottom th,
.report-template-sheet .template-preview-scorecard-bottom td{overflow:hidden;text-overflow:clip;}`;
      document.head.appendChild(style);
    }
  }catch(e){ /* fallback CSS above still keeps the preview usable */ }
  reportTemplateStyleReady = true;
}

async function loadReportTemplateSchoolSettings(){
  if(reportTemplateSchoolSettings) return reportTemplateSchoolSettings;
  try{
    const r = await api('GET','/api/admin/school-settings');
    reportTemplateSchoolSettings = r && r.success && r.data ? r.data : {};
  }catch(e){
    reportTemplateSchoolSettings = {};
  }
  return reportTemplateSchoolSettings;
}

function reportTemplateBool(value, fallback=true){
  if(value === undefined || value === null || value === '') return fallback;
  if(typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if(['1','true','yes','on','enabled'].includes(s)) return true;
  if(['0','false','no','off','disabled'].includes(s)) return false;
  return fallback;
}

function reportTemplateModel(value, fallback='model_1'){
  const raw = String(value || '').trim().toLowerCase();
  if(raw === 'none') return 'none';
  const m = raw.match(/(?:model[_\s-]*)?(\d+)/);
  if(m){
    const n = Math.max(1, Math.min(10, Number(m[1])));
    return `model_${n}`;
  }
  return fallback;
}

function reportTemplateSchoolDefaults(settings={}, previous={}){
  return {
    name: settings.school_name || previous.name || 'JOYLAND SCHOOLS',
    motto: settings.school_motto || previous.motto || 'Education Is Treasure',
    address: settings.school_address || previous.address || 'P.O. Box 123',
    phone: settings.school_phone || previous.phone || '0700 000 000',
    email: settings.school_email || previous.email || 'info@joylandschools.ac.ke',
    logo: settings.school_logo || previous.logo || '/uploads/school/logo.jpg',
    type: previous.type || 'PRIMARY'
  };
}

function reportTemplateDefaultState(settings={}){
  const theme = settings.theme_color || '#d4147a';
  return {
    template_name:'Default Template',
    selected_models:{section_1:'model_2',section_2:'model_1',section_3:'model_4',section_4:'model_1',section_5:'model_1',section_6:'model_2'},
    theme_color:theme,
    school:reportTemplateSchoolDefaults(settings),
    settings:{
      result_title:settings.result_title || 'END OF TERM REPORT CARD',
      footer_text:settings.footer_text || '',
      grade_label:'Grade',
      remarks_label:'Remarks',
      promotion_status:'PROMOTED TO: ________________',
      student_position:'-',
      score_color:theme,
      teacher_comment:'A dedicated and hardworking student who shows great potential.',
      head_comment:'Keep up the excellent work. We are proud of your progress.',
      director_comment:'',
      teacher_role_label:'Class Teacher',
      head_role_label:'Headteacher',
      director_role_label:'Director',
      show_remarks:true, show_position:true, show_attendance:true, show_promotion:true,
      show_class_average:true, show_grade_keys:true, show_score_colors:true, show_stamp:true,
      jumbotron_header_bg:true, autofill_skills:true,
      show_cum_total:true, show_percentage:true, show_sign_column:false,
      show_dob:true, show_sex:true, show_admission_no:true, show_class:true, show_photo:true,
      show_term_duration:true, show_score_summary:true,
      show_teacher_comment:true, show_head_comment:true, show_director_comment:false,
      stamp_image:settings.school_stamp || '',
      bg_image:settings.background_image || ''
    },
    customizations:{
      student_fields:[
        {key:'name',label:'Name',visible:true},
        {key:'dob',label:'Date Of Birth',visible:true},
        {key:'sex',label:'Sex',visible:true},
        {key:'class',label:'Class',visible:true},
        {key:'admission_no',label:'Admission No.',visible:true}
      ],
      grade_key:[
        {range:'100-90',code:'EE1',label:'EXCEEDING EXPECTATIONS'},
        {range:'89-75',code:'EE2',label:'EXCEEDING EXPECTATIONS'},
        {range:'74-58',code:'ME1',label:'MEETING EXPECTATIONS'},
        {range:'57-41',code:'ME2',label:'MEETING EXPECTATIONS'},
        {range:'40-31',code:'AE1',label:'APPROACHING EXPECTATIONS'},
        {range:'30-21',code:'AE2',label:'APPROACHING EXPECTATIONS'},
        {range:'20-11',code:'BE1',label:'BELOW EXPECTATIONS'},
        {range:'10-0',code:'BE2',label:'BELOW EXPECTATIONS'}
      ],
      remarks_table:[
        {min:90,max:100,text:'Excellent'},
        {min:75,max:89,text:'Very Good'},
        {min:58,max:74,text:'Good'},
        {min:41,max:57,text:'Satisfactory'},
        {min:31,max:40,text:'Fair'},
        {min:21,max:30,text:'Needs Improvement'},
        {min:11,max:20,text:'Weak'},
        {min:0,max:10,text:'Very Weak'}
      ],
      skills:{
        affective:['Punctuality','Attentiveness','Neatness','Honesty','Politeness'],
        psychomotor:['Handwriting','Drawing','Sports','Crafts','Verbal Fluency'],
        ratings:[5,4,3,2,1],
        rating_labels:['Excellent','Very Good','Good','Fair','Poor']
      },
      academic_columns:{}
    }
  };
}

function normalizeReportTemplateState(raw, schoolSettings={}, templateName='Default Template'){
  const base = reportTemplateDefaultState(schoolSettings);
  const src = raw || {};
  const state = Object.assign({}, base, src);
  state.template_name = src.template_name || templateName || base.template_name;
  state.selected_models = Object.assign({}, base.selected_models, src.selected_models || {});
  Object.keys(state.selected_models).forEach(section=>{
    const fallback = base.selected_models[section] || 'model_1';
    state.selected_models[section] = reportTemplateModel(state.selected_models[section], fallback);
  });
  state.school = reportTemplateSchoolDefaults(schoolSettings, Object.assign({}, base.school, src.school || {}));
  state.settings = Object.assign({}, base.settings, src.settings || {});
  state.customizations = Object.assign({}, base.customizations, src.customizations || {});
  state.customizations.student_fields = (src.customizations && src.customizations.student_fields) || base.customizations.student_fields;
  state.customizations.grade_key = (src.customizations && src.customizations.grade_key && src.customizations.grade_key.length) ? src.customizations.grade_key : base.customizations.grade_key;
  state.customizations.remarks_table = (src.customizations && src.customizations.remarks_table && src.customizations.remarks_table.length) ? src.customizations.remarks_table : base.customizations.remarks_table;
  state.customizations.skills = Object.assign({}, base.customizations.skills, (src.customizations && src.customizations.skills) || {});
  state.customizations.academic_columns = (src.customizations && src.customizations.academic_columns) || {};
  state.theme_color = schoolSettings.theme_color || state.theme_color || base.theme_color;
  state.settings.result_title = schoolSettings.result_title || state.settings.result_title;
  state.settings.footer_text = schoolSettings.footer_text || state.settings.footer_text;
  state.settings.stamp_image = schoolSettings.school_stamp || state.settings.stamp_image;
  state.settings.bg_image = schoolSettings.background_image || state.settings.bg_image;
  state.settings.score_color = state.settings.score_color || state.theme_color;
  state.settings.jumbotron_header_bg = reportTemplateBool(state.settings.jumbotron_header_bg ?? state.settings.jumbotron_header_bg_enabled, true);
  state.settings.autofill_skills = reportTemplateBool(state.settings.autofill_skills ?? state.settings.autofill_attributes_enabled, true);
  [
    'show_remarks','show_position','show_attendance','show_promotion','show_class_average','show_grade_keys','show_score_colors',
    'show_stamp','show_cum_total','show_percentage','show_sign_column','show_dob','show_sex','show_admission_no','show_class',
    'show_photo','show_term_duration','show_score_summary','show_teacher_comment','show_head_comment','show_director_comment'
  ].forEach(key=>{ state.settings[key] = reportTemplateBool(state.settings[key], base.settings[key]); });
  return state;
}

async function loadReportTemplateState(templateName){
  await ensureReportTemplateStyles();
  const schoolSettings = await loadReportTemplateSchoolSettings();
  const name = templateName || 'Default Template';
  let raw = null;
  try{
    const r = await api('GET',`/api/admin/templates/${encodeURIComponent(name)}`);
    raw = r && r.success ? r.state : null;
  }catch(e){ raw = null; }
  return normalizeReportTemplateState(raw, schoolSettings, name);
}

function reportTemplateNameForClass(classId){
  const cls = reportClassById(classId);
  return cls?.template_name || 'Default Template';
}

function reportTemplateHexToRgba(hex, alpha){
  let value = String(hex || '#d4147a').replace('#','').trim();
  if(value.length === 3) value = value.split('').map(c=>c+c).join('');
  const n = parseInt(value, 16);
  if(Number.isNaN(n)) return `rgba(212,20,122,${alpha})`;
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${alpha})`;
}

const REPORT_TEMPLATE_PAGE_WIDTH = 1500;
const REPORT_TEMPLATE_PAGE_HEIGHT = 2121;
const REPORT_TEMPLATE_PX_PER_CM = REPORT_TEMPLATE_PAGE_WIDTH / 21;
const REPORT_TEMPLATE_MEASURE = {
  sectionHeight: REPORT_TEMPLATE_PX_PER_CM * 3,
  logoInset: REPORT_TEMPLATE_PX_PER_CM * .1,
  nameCapHeight: REPORT_TEMPLATE_PX_PER_CM * .4,
  metaCapHeight: REPORT_TEMPLATE_PX_PER_CM * .2,
  nameToMetaGap: REPORT_TEMPLATE_PX_PER_CM * .2,
  metaRowGap: REPORT_TEMPLATE_PX_PER_CM * .2,
  headerBottomGap: REPORT_TEMPLATE_PX_PER_CM * .5,
  titleTopGap: REPORT_TEMPLATE_PX_PER_CM * .4,
  titleCapHeight: REPORT_TEMPLATE_PX_PER_CM * .3,
  titleBottomGap: REPORT_TEMPLATE_PX_PER_CM * .5,
  capRatio: .715,
  tableCapHeight: REPORT_TEMPLATE_PX_PER_CM * .237,
  smallCapHeight: REPORT_TEMPLATE_PX_PER_CM * .218,
  normalRow: REPORT_TEMPLATE_PX_PER_CM * .526,
  wrappedRow: REPORT_TEMPLATE_PX_PER_CM * .94,
  skillsRow: REPORT_TEMPLATE_PX_PER_CM * .415,
  academicTitleRow: REPORT_TEMPLATE_PX_PER_CM * .526,
  academicHeaderMainRow: REPORT_TEMPLATE_PX_PER_CM * 1.30,
  academicMarkRow: REPORT_TEMPLATE_PX_PER_CM * .526,
  commentRow: REPORT_TEMPLATE_PX_PER_CM * 1.19,
  sectionGap: REPORT_TEMPLATE_PX_PER_CM * .18,
  skillsGridGap: REPORT_TEMPLATE_PX_PER_CM * .14,
  skillsTableGap: REPORT_TEMPLATE_PX_PER_CM * .08,
  skillsMarginTop: REPORT_TEMPLATE_PX_PER_CM * .13,
  commentMarginTop: REPORT_TEMPLATE_PX_PER_CM * .25,
  commentRowPadY: REPORT_TEMPLATE_PX_PER_CM * .015,
  commentLabelCol: REPORT_TEMPLATE_PX_PER_CM * 3.95,
  commentSignCol: REPORT_TEMPLATE_PX_PER_CM * .86,
  commentSignLineCol: REPORT_TEMPLATE_PX_PER_CM * 1.82,
  commentDateCol: REPORT_TEMPLATE_PX_PER_CM * .78,
  commentDateValueCol: REPORT_TEMPLATE_PX_PER_CM * 1.82,
  commentGap: REPORT_TEMPLATE_PX_PER_CM * .12,
  lineHeight: 1.08,
  skillsLineHeight: .96,
  borderWidth: REPORT_TEMPLATE_PX_PER_CM * .028,
  cellPadX: REPORT_TEMPLATE_PX_PER_CM * .07,
  cellPadY: REPORT_TEMPLATE_PX_PER_CM * .015,
  personalLabelWidth: REPORT_TEMPLATE_PX_PER_CM * 2.074,
  personalCol: REPORT_TEMPLATE_PX_PER_CM * 6.887,
  avatarCol: REPORT_TEMPLATE_PX_PER_CM * 2.987,
  avatarHeight: REPORT_TEMPLATE_PX_PER_CM * 3.976,
  attendanceCol: REPORT_TEMPLATE_PX_PER_CM * 6.306,
  scoreCol: REPORT_TEMPLATE_PX_PER_CM * 3.457,
  section2Gap: REPORT_TEMPLATE_PX_PER_CM * .04,
  scoreLabelWidthPct: 69.6,
  ratingCol: REPORT_TEMPLATE_PX_PER_CM * .553
};
function reportTemplatePx(value){ return `${Number(value).toFixed(3)}px`; }

function reportTemplateStyleAttr(state){
  const tc = state.theme_color || '#d4147a';
  const m = REPORT_TEMPLATE_MEASURE;
  const borderedLogoSize = m.sectionHeight - (m.logoInset * 2) - 4;
  const unborderedLogoSize = m.sectionHeight - (m.logoInset * 2);
  const nameFont = m.nameCapHeight / m.capRatio;
  const metaFont = m.metaCapHeight / m.capRatio;
  const titleFont = m.titleCapHeight / m.capRatio;
  const tableFont = m.tableCapHeight / m.capRatio;
  const smallFont = m.smallCapHeight / m.capRatio;
  return [
    `--tc:${tc}`,
    `--template-theme-color:${tc}`,
    `--template-theme-soft:${reportTemplateHexToRgba(tc,.11)}`,
    `--template-theme-soft-strong:${reportTemplateHexToRgba(tc,.2)}`,
    `--s1-section-height:${reportTemplatePx(m.sectionHeight)}`,
    `--s1-pad-y:${reportTemplatePx(m.logoInset)}`,
    `--s1-pad-x:${reportTemplatePx(m.logoInset)}`,
    `--s1-pad-y-model2:${reportTemplatePx(m.logoInset)}`,
    `--s1-pad-x-model2:${reportTemplatePx(m.logoInset)}`,
    `--s1-logo-size:${reportTemplatePx(borderedLogoSize)}`,
    `--s1-logo-size-model2:${reportTemplatePx(unborderedLogoSize)}`,
    `--s1m3-logo-size:${reportTemplatePx(borderedLogoSize)}`,
    `--s1-grid-logo-col:${reportTemplatePx(borderedLogoSize + m.logoInset + 4)}`,
    `--s1-school-text-pad:${reportTemplatePx(borderedLogoSize + m.logoInset + 18)}`,
    `--s1-school-name-size:${reportTemplatePx(nameFont)}`,
    `--s1m3-name-size:${reportTemplatePx(nameFont)}`,
    '--s1-school-name-line-height:.715',
    `--s1-school-meta-size:${reportTemplatePx(metaFont)}`,
    `--s1m3-meta-size:${reportTemplatePx(metaFont)}`,
    '--s1-school-meta-line-height:.715',
    `--s1-name-meta-gap:${reportTemplatePx(m.nameToMetaGap)}`,
    `--s1-meta-row-gap:${reportTemplatePx(m.metaRowGap)}`,
    `--s1-text-top-pad:${reportTemplatePx(m.headerBottomGap)}`,
    `--s1-text-bottom-pad:${reportTemplatePx(m.headerBottomGap)}`,
    '--s1-text-inset:-2px',
    `--s1m3-side-pad-x:${reportTemplatePx(m.logoInset * 2)}`,
    `--s1m3-gap:${reportTemplatePx(m.logoInset)}`,
    `--result-title-margin:${reportTemplatePx(m.titleTopGap)} 0 ${reportTemplatePx(m.titleBottomGap)}`,
    `--result-title-size:${reportTemplatePx(titleFont)}`,
    '--result-title-line-height:.715',
    `--table-border-width:${reportTemplatePx(Math.max(1.25, m.borderWidth))}`,
    `--table-font-size:${reportTemplatePx(tableFont)}`,
    `--table-small-font-size:${reportTemplatePx(smallFont)}`,
    `--table-line-height:${m.lineHeight.toFixed(2)}`,
    `--table-row-height:${reportTemplatePx(m.normalRow)}`,
    `--table-wrap-row-height:${reportTemplatePx(m.wrappedRow)}`,
    `--table-cell-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY))}`,
    `--table-cell-pad-x:${reportTemplatePx(m.cellPadX)}`,
    `--section-gap:${reportTemplatePx(Math.max(2, m.sectionGap))}`,
    `--s2-font-size:${reportTemplatePx(tableFont)}`,
    `--s2-cell-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY))}`,
    `--s2-cell-pad-x:${reportTemplatePx(m.cellPadX)}`,
    `--s2-subhead-font-size:${reportTemplatePx(smallFont)}`,
    `--s2-score-label-size:${reportTemplatePx(smallFont)}`,
    `--s2-score-value-size:${reportTemplatePx(tableFont)}`,
    `--s2-score-label-width:${m.scoreLabelWidthPct}%`,
    `--s2-personal-label-width:${reportTemplatePx(m.personalLabelWidth)}`,
    `--s2-personal-col:${reportTemplatePx(m.personalCol)}`,
    `--s2-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2m3-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2m5-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2m7-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2m9-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2m10-avatar-col:${reportTemplatePx(m.avatarCol)}`,
    `--s2-avatar-w:${reportTemplatePx(m.avatarCol)}`,
    `--s2-avatar-h:${reportTemplatePx(m.avatarHeight)}`,
    `--s2m5-avatar-w:${reportTemplatePx(m.avatarCol)}`,
    `--s2m5-avatar-h:${reportTemplatePx(m.avatarHeight)}`,
    `--s2m7-avatar-w:${reportTemplatePx(m.avatarCol)}`,
    `--s2m7-avatar-h:${reportTemplatePx(m.avatarHeight)}`,
    `--s2m9-avatar-w:${reportTemplatePx(m.avatarCol)}`,
    `--s2m9-avatar-h:${reportTemplatePx(m.avatarHeight)}`,
    `--s2-attendance-col:${reportTemplatePx(m.attendanceCol)}`,
    `--s2-score-col:${reportTemplatePx(m.scoreCol)}`,
    `--s2-grid-gap:${reportTemplatePx(m.section2Gap)}`,
    `--s2-mini-gap:${reportTemplatePx(m.section2Gap)}`,
    `--s2-row-gap:${reportTemplatePx(m.section2Gap)}`,
    `--s2-row-label-gap:${reportTemplatePx(REPORT_TEMPLATE_PX_PER_CM * .12)}`,
    `--s2-inline-label-size:${reportTemplatePx(tableFont)}`,
    `--s2-inline-value-size:${reportTemplatePx(tableFont)}`,
    `--academic-font-size:${reportTemplatePx(tableFont)}`,
    `--academic-line-height:${m.lineHeight.toFixed(2)}`,
    `--academic-cell-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY))}`,
    `--academic-header-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY))}`,
    `--academic-title-row-height:${reportTemplatePx(m.academicTitleRow)}`,
    `--academic-header-main-row-height:${reportTemplatePx(m.academicHeaderMainRow)}`,
    `--academic-mark-row-height:${reportTemplatePx(m.academicMarkRow)}`,
    `--academic-body-row-height:${reportTemplatePx(m.normalRow)}`,
    `--academic-total-row-height:${reportTemplatePx(m.normalRow)}`,
    `--academic-title-font-size:${reportTemplatePx(tableFont)}`,
    `--academic-subject-header-font-size:${reportTemplatePx(tableFont)}`,
    `--academic-main-font-size:${reportTemplatePx(smallFont)}`,
    `--academic-mark-font-size:${reportTemplatePx(tableFont)}`,
    `--academic-remarks-font-size:${reportTemplatePx(smallFont)}`,
    `--skills-margin-top:${reportTemplatePx(Math.max(2, m.skillsMarginTop))}`,
    `--skills-grid-gap:${reportTemplatePx(Math.max(2, m.skillsGridGap))}`,
    `--skills-table-gap:${reportTemplatePx(Math.max(1, m.skillsTableGap))}`,
    `--skills-row-height:${reportTemplatePx(m.skillsRow)}`,
    `--skills-font-size:${reportTemplatePx(tableFont)}`,
    `--skills-rating-font-size:${reportTemplatePx(tableFont)}`,
    `--skills-category-font-size:${reportTemplatePx(tableFont)}`,
    `--skills-line-height:${m.skillsLineHeight.toFixed(2)}`,
    `--skills-cell-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY * .7))}`,
    `--skills-cell-pad-x:${reportTemplatePx(m.cellPadX)}`,
    `--skills-rating-col-width:${reportTemplatePx(m.ratingCol)}`,
    `--skills-rating-key-margin:${reportTemplatePx(Math.max(1, m.skillsTableGap))}`,
    `--skills-key-pad-y:${reportTemplatePx(Math.max(.5, m.cellPadY))}`,
    `--skills-key-head-size:${reportTemplatePx(tableFont)}`,
    `--skills-key-font-size:${reportTemplatePx(smallFont)}`,
    `--comment-margin-top:${reportTemplatePx(Math.max(2, m.commentMarginTop))}`,
    `--comment-row-height:${reportTemplatePx(m.commentRow)}`,
    `--comment-row-pad-y:${reportTemplatePx(Math.max(.5, m.commentRowPadY))}`,
    `--comment-font-size:${reportTemplatePx(tableFont)}`,
    `--comment-grid:${reportTemplatePx(m.commentLabelCol)} minmax(0,1fr) ${reportTemplatePx(m.commentSignCol)} ${reportTemplatePx(m.commentSignLineCol)} ${reportTemplatePx(m.commentDateCol)} ${reportTemplatePx(m.commentDateValueCol)}`,
    `--comment-gap:${reportTemplatePx(m.commentGap)}`,
    '--skills-line-clamp:2',
    '--comment-line-clamp:2'
  ].join(';');
}

function reportTemplateSectionWrap(section, model, inner){
  return `<section class="template-preview-section template-preview-section--${escapeHtml(section)}" data-preview-section="${escapeHtml(section)}" data-selected-model="${escapeHtml(model)}"><div class="template-preview-model template-preview-model--${escapeHtml(model)} is-active" data-preview-model="${escapeHtml(model)}">${inner}</div></section>`;
}

function reportTemplateLogoHtml(school){
  if(school.logo) return `<img src="${escapeHtml(school.logo)}" alt="${escapeHtml(school.name || 'School')} logo">`;
  const abbr = String(school.name || 'SCH').split(/\s+/).map(w=>w[0]).join('').slice(0,4).toUpperCase();
  return `<div class="template-preview-logo-fallback">${escapeHtml(abbr || 'SCH')}</div>`;
}

function renderReportTemplateS1(model, school, settings){
  const logo = reportTemplateLogoHtml(school);
  const contact = [school.phone, school.email].filter(Boolean).join(' - ');
  const meta = ['(PRIMARY)', school.address, school.motto ? `Motto: ${school.motto}` : '', contact]
    .filter(Boolean).map(escapeHtml).map(t=>`<div>${t}</div>`).join('');
  if(model === 'model_3'){
    const bg = settings.jumbotron_header_bg ? 'var(--template-theme-soft-strong)' : '#fff';
    return `<div class="template-preview-box template-preview-s1m3-header" style="background:${bg};">
      <div class="template-preview-s1m3-side"><div class="template-preview-s1m3-school-name">${escapeHtml(school.name)}</div><div class="template-preview-s1m3-meta">${meta}</div></div>
      <div class="template-preview-s1m3-logo">${logo}</div>
      <div class="template-preview-s1m3-side"><div class="template-preview-s1m3-school-name">${escapeHtml(school.name)}</div><div class="template-preview-s1m3-meta">${meta}</div></div>
    </div>`;
  }
  const bg = settings.jumbotron_header_bg ? '' : ' style="background:#fff;"';
  return `<div class="template-preview-box template-preview-header"${bg}>
    <div class="template-preview-logo">${logo}</div>
    <div class="template-preview-school">
      <div class="template-preview-school-name">${escapeHtml(school.name)}</div>
      <div class="template-preview-school-meta">${meta}</div>
    </div>
  </div>`;
}

function reportTemplateVisibleStudentFields(state){
  const s = state.settings;
  const toggles = { dob:'show_dob', sex:'show_sex', admission_no:'show_admission_no', class:'show_class' };
  return (state.customizations.student_fields || []).filter(f=>f.visible !== false && (!toggles[f.key] || s[toggles[f.key]] !== false));
}

function reportTemplateDate(value){
  const d = reportTemplateDateObject(value);
  if(!d) return value ? String(value) : '-';
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

function reportTemplateDateNumeric(value){
  const d = reportTemplateDateObject(value);
  if(!d) return value ? String(value) : '—';
  return d.toLocaleDateString('en-GB');
}

function reportTemplateDateObject(value){
  if(!value) return null;
  if(value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if(!raw) return null;
  const ymd = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if(ymd) return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if(dmy) return new Date(Number(dmy[3]), Number(dmy[2]) - 1, Number(dmy[1]));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function reportTemplateTermDays(term){
  if(!term?.start_date || !term?.end_date) return '—';
  if(term.school_days !== null && term.school_days !== undefined && term.school_days !== '') return Number(term.school_days) || '—';
  const weekdays = reportParseTermWeekdays(term.weekdays);
  return calcSchoolDays(term.start_date, term.end_date, weekdays, []) || '—';
}

function reportTemplateNextTerm(term){
  if(!term) return null;
  const sameSession = (cachedTerms || []).filter(t=>String(t.session_id)===String(term.session_id) && String(t.id)!==String(term.id));
  const currentNumber = Number(term.term_number);
  let next = null;
  if(Number.isFinite(currentNumber)){
    next = sameSession
      .filter(t=>Number(t.term_number) > currentNumber)
      .sort((a,b)=>Number(a.term_number)-Number(b.term_number))[0] || null;
  }
  if(!next && term.start_date){
    next = sameSession
      .filter(t=>String(t.start_date || '') > String(term.start_date))
      .sort((a,b)=>String(a.start_date || '').localeCompare(String(b.start_date || '')))[0] || null;
  }
  return next;
}

function reportTemplateTermText(termId){
  const term = reportTermById(termId);
  return term ? term.term_name || term.label || '-' : '-';
}

function reportTemplateStudentPhoto(learner){
  const src = learner.photo_url || learner.portrait_path || '';
  if(src) return `<img src="${escapeHtml(src)}" alt="${escapeHtml(learner.name || 'Learner')}">`;
  return '<i class="fas fa-user"></i>';
}

function renderReportTemplateS2(model, state, data){
  const s = state.settings;
  const student = data.student;
  const fields = reportTemplateVisibleStudentFields(state);
  const personalTable = `<table class="template-preview-table template-preview-personal">
    <colgroup><col style="width:30.2%"><col style="width:69.8%"></colgroup>
    <tr><th colspan="2">Student's Personal Data</th></tr>
    ${fields.map(f=>`<tr data-s2-row="${escapeHtml(f.key)}"><td>${escapeHtml(f.label)}</td><td data-s2-value="${escapeHtml(f.key)}">${escapeHtml(student[f.key] || '-')}</td></tr>`).join('')}
  </table>`;
  const attendance = s.show_attendance ? renderReportTemplateAttendance(data) : '';
  const duration = s.show_term_duration ? renderReportTemplateDuration(data) : '';
  const score = s.show_score_summary ? renderReportTemplateScorecard(data, state) : '';
  const avatar = (cls='', reserve=false) => s.show_photo ? `<div class="template-preview-avatar ${cls}">${reportTemplateStudentPhoto(data.learner)}</div>` : (reserve ? `<div class="template-preview-avatar template-preview-avatar--placeholder ${cls}"></div>` : '');
  const row = (prefix,label,value,key='') => `<div class="${prefix}-row" ${key?`data-s2-row="${escapeHtml(key)}"`:''}><div class="${prefix}-label">${escapeHtml(label)}</div><div class="${prefix}-value" ${key?`data-s2-value="${escapeHtml(key)}"`:''}>${escapeHtml(value || '-')}</div></div>`;
  const fieldMap = Object.fromEntries(fields.map(f=>[f.key, f]));
  const personalRow = (prefix,key) => fieldMap[key] ? row(prefix, fieldMap[key].label, student[key], key) : '';
  const personalRowsForKeys = (prefix,keys) => keys.map(key=>personalRow(prefix,key)).filter(Boolean);
  const fullRows = prefix => [
    ...personalRowsForKeys(prefix, ['name','dob','sex','class','admission_no']),
    ...(s.show_score_summary ? [row(prefix,'No. in Class',data.classCount)] : [])
  ];
  const termRows = prefix => s.show_term_duration ? [
    row(prefix,'Terminal Duration',data.termDuration), row(prefix,'Term Begins',data.termBegins), row(prefix,'Term End',data.termEnds),
    row(prefix,'Next Term Begins',data.nextTermBegins), row(prefix,'No. of Times Sch. Opened',data.opened)
  ] : [];
  const scoreRows = prefix => [
    ...(s.show_attendance ? [row(prefix,'No. of Times Present',data.present), row(prefix,'No. of Times Absent',data.absent)] : []),
    ...(s.show_score_summary ? [
      row(prefix,'Total Score Obtainable',data.totalObtainable), row(prefix,'Total Score Obtained',data.totalObtained),
      row(prefix,'Average Percentage',data.averagePercent), ...(s.show_position ? [row(prefix,'Position',data.position)] : [])
    ] : [])
  ];
  const splitRows = (prefix,items) => `<div class="${prefix}-column">${items.join('')}</div>`;
  if(model === 'model_1') return `${personalTable}${avatar('',true)}<div class="template-preview-s2m1-attendance-stack">${attendance}${duration}</div><div class="template-preview-s2m1-score-stack">${score}</div>`;
  if(model === 'model_2'){
    const p = 'template-preview-s2m2';
    return `<div class="${p}-grid">${splitRows(p,fullRows(p))}${splitRows(p,termRows(p))}<div class="${p}-column ${p}-column--score">${scoreRows(p).join('')}</div></div>`;
  }
  if(model === 'model_3') return `${personalTable}<div class="template-preview-s2m3-attendance-stack">${attendance}${duration}</div><div class="template-preview-s2m3-score-stack">${score}</div>${avatar('',true)}`;
  if(model === 'model_4') return `${personalTable}<div class="template-preview-s2m4-attendance-stack">${attendance}${duration}</div><div class="template-preview-s2m4-score-stack">${score}</div>`;
  if(model === 'model_5'){
    const p = 'template-preview-s2m5';
    return `<div class="${p}-grid">${splitRows(p,fullRows(p))}${splitRows(p,termRows(p))}<div class="${p}-column ${p}-column--score">${scoreRows(p).join('')}</div>${avatar(`${p}-avatar`,true)}</div>`;
  }
  if(model === 'model_6'){
    const p = 'template-preview-s2m6';
    return `<div class="${p}-grid">${splitRows(p,personalRowsForKeys(p,['name','sex','admission_no']))}${splitRows(p,personalRowsForKeys(p,['dob','class']))}</div>`;
  }
  if(model === 'model_7'){
    const p = 'template-preview-s2m7';
    return `<div class="${p}-grid">${splitRows(p,personalRowsForKeys(p,['name','sex','admission_no']))}${splitRows(p,[...personalRowsForKeys(p,['dob','class']), ...(s.show_score_summary ? [row(p,'No. in Class',data.classCount)] : [])])}${avatar(`${p}-avatar`,true)}</div>`;
  }
  if(model === 'model_8'){
    const p = 'template-preview-s2m8';
    return `<div class="${p}-grid">${splitRows(p,[...personalRowsForKeys(p,['name','sex','admission_no']), ...(s.show_term_duration ? [row(p,'Term Begins',data.termBegins),row(p,'Next Term Begins',data.nextTermBegins)] : [])])}${splitRows(p,[...personalRowsForKeys(p,['dob','class']), ...(s.show_term_duration ? [row(p,'Terminal Duration',data.termDuration),row(p,'Term End',data.termEnds),row(p,'No. of Times Sch. Opened',data.opened)] : []), ...(s.show_score_summary ? [row(p,'No. in Class',data.classCount)] : [])])}</div>`;
  }
  if(model === 'model_9'){
    const p = 'template-preview-s2m9';
    return `<div class="${p}-grid">${splitRows(p,[...personalRowsForKeys(p,['name','sex','admission_no']), ...(s.show_term_duration ? [row(p,'Term Begins',data.termBegins),row(p,'Next Term Begins',data.nextTermBegins)] : [])])}${splitRows(p,[...personalRowsForKeys(p,['dob','class']), ...(s.show_term_duration ? [row(p,'Terminal Duration',data.termDuration),row(p,'Term End',data.termEnds),row(p,'No. of Times Sch. Opened',data.opened)] : []), ...(s.show_score_summary ? [row(p,'No. in Class',data.classCount)] : [])])}${avatar(`${p}-avatar`,true)}</div>`;
  }
  if(model === 'model_10'){
    const p = 'template-preview-s2m10';
    return `<div class="${p}-grid">${splitRows(p,[...personalRowsForKeys(p,['name','sex','admission_no']), ...(s.show_score_summary ? [row(p,'Total Score Obtained',data.totalObtained), ...(s.show_position ? [row(p,'Position',data.position)] : [])] : [])])}${splitRows(p,[...personalRowsForKeys(p,['dob','class']), ...(s.show_score_summary ? [row(p,'Total Score Obtainable',data.totalObtainable),row(p,'Average Percentage',data.averagePercent),row(p,'No. in Class',data.classCount)] : [])])}${avatar(`${p}-avatar`,true)}</div>`;
  }
  return `${personalTable}${avatar('',true)}<div class="template-preview-s2m1-attendance-stack">${attendance}${duration}</div><div class="template-preview-s2m1-score-stack">${score}</div>`;
}

function renderReportTemplateAttendance(data){
  return `<table class="template-preview-table template-preview-attendance">
    <colgroup><col style="width:41.7%"><col style="width:28.1%"><col style="width:30.2%"></colgroup>
    <tr><th colspan="3">Attendance</th></tr>
    <tr><th class="template-preview-subhead">No. of Times School Opened</th><th class="template-preview-subhead">No. of Times Present</th><th class="template-preview-subhead">No. of Times Absent</th></tr>
    <tr><td>${escapeHtml(data.opened)}</td><td>${escapeHtml(data.present)}</td><td>${escapeHtml(data.absent)}</td></tr>
  </table>`;
}

function renderReportTemplateDuration(data){
  return `<table class="template-preview-table template-preview-attendance template-preview-s2m1-duration">
    <colgroup><col style="width:30.3%"><col style="width:28.5%"><col style="width:41.2%"></colgroup>
    <tr><th colspan="3">Terminal Duration (${escapeHtml(data.termDuration)})</th></tr>
    <tr><th class="template-preview-subhead">Term Begins</th><th class="template-preview-subhead">Term Ends</th><th class="template-preview-subhead">Next Term Begins</th></tr>
    <tr><td>${escapeHtml(data.termBegins)}</td><td>${escapeHtml(data.termEnds)}</td><td>${escapeHtml(data.nextTermBegins)}</td></tr>
  </table>`;
}

function renderReportTemplateScorecard(data, state){
  const showPosition = state.settings.show_position !== false;
  const bottom = showPosition ? `<table class="template-preview-table template-preview-scorecard-bottom">
    <colgroup><col style="width:58%"><col style="width:42%"></colgroup>
    <tr><td>No. in Class</td><td>Position</td></tr>
    <tr><td>${escapeHtml(data.classCount)}</td><td>${escapeHtml(data.position)}</td></tr>
  </table>` : `<table class="template-preview-table template-preview-scorecard-bottom">
    <colgroup><col style="width:100%"></colgroup>
    <tr><td>No. in Class</td></tr>
    <tr><td>${escapeHtml(data.classCount)}</td></tr>
  </table>`;
  return `<table class="template-preview-table template-preview-scorecard">
    <colgroup><col style="width:69.6%"><col style="width:30.4%"></colgroup>
    <tr><td>Total Score Obtainable</td><td>${escapeHtml(data.totalObtainable)}</td></tr>
    <tr><td>Total Score Obtained</td><td>${escapeHtml(data.totalObtained)}</td></tr>
    <tr><td>Average Percentage</td><td>${escapeHtml(data.averagePercent)}</td></tr>
  </table>${bottom}`;
}

function reportTemplateAcademicColumns(model, state){
  const s = state.settings;
  const standard = [
    {key:'ca',label:'CA',score:30},{key:'exam',label:'EXAM',score:100},{key:'total_score',label:'TOTAL SCORE',score:100},
    {key:'cum_total_score',label:'CUM. TOTAL SCORE'},{key:'percentage',label:'PERCENTAGE'},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
    {key:'class_average',label:'CLASS AVERAGE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},{key:'sign',label:'SIGN.'},{key:'subject_teacher',label:'SUBJECT TEACHER'},
    {key:'grade',label:s.grade_label || 'GRADE'},{key:'class_highest',label:'CLASS HIGHEST'},{key:'class_lowest',label:'CLASS LOWEST'}
  ];
  const models = {
    model_2:[
      {key:'ca',label:'CA',score:20},{key:'coef',label:'COEF.',score:1},{key:'marks_average',label:'MARKS AVERAGE',score:20},
      {key:'exam',label:'EXAM',score:80},{key:'total_score',label:'TOTAL SCORE',score:100},{key:'percentage',label:'PERCENTAGE'},
      {key:'position_in_subject',label:'POSITION IN SUBJECT'},{key:'class_average',label:'CLASS AVERAGE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},
      {key:'sign',label:'SIGN.'},{key:'subject_teacher',label:'SUBJECT TEACHER'},{key:'grade',label:s.grade_label || 'GRADE'}
    ],
    model_3:[
      {key:'max',label:'MAX',score:100},{key:'test',label:'TEST 1',score:100},{key:'total_score',label:'TOTAL',score:100},
      {key:'percentage',label:'PERCENTAGE'},{key:'position_in_subject',label:'POSITION IN SUBJECT'},{key:'class_average',label:'CLASS AVERAGE'},
      {key:'remarks',label:s.remarks_label || 'REMARKS'},{key:'sign',label:'SIGN.'},{key:'grade',label:s.grade_label || 'GRADE'}
    ],
    model_4:[
      {key:'ca',label:'CA',score:20},{key:'ca2',label:'CA',score:20},{key:'exam',label:'EXAM',score:60},
      {key:'total_score',label:'TOTAL SCORE',score:100},{key:'cum_total_score',label:'CUM. TOTAL SCORE'},
      {key:'percentage',label:'PERCENTAGE'},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
      {key:'class_average',label:'CLASS AVERAGE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},{key:'sign',label:'SIGN.'}
    ],
    model_5:[
      {key:'ca',label:'C1',score:100},{key:'average',label:'AVERAGE'},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
      {key:'class_average',label:'CLASS AVERAGE'},{key:'descriptor',label:'DESCRIPTOR'},{key:'sign',label:'SIGN.'},{key:'grade',label:s.grade_label || 'GRADE'}
    ],
    model_6:[
      {key:'ca',label:'CA',score:20},{key:'exam',label:'EXAM',score:80},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
      {key:'total_score',label:'TOTAL SCORE',score:100},{key:'class_average',label:'CLASS AVERAGE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},
      {key:'cum_total_score',label:'CUM. TOTAL SCORE'},{key:'sign',label:'SIGN.'},{key:'grade',label:s.grade_label || 'GRADE'}
    ],
    model_7:[
      {key:'bot_exams',label:'B. O. T. EXAMS',score:100},{key:'midterm_exams',label:'MID-TERM EXAMS',score:100},{key:'average',label:'AVERAGE'},
      {key:'end_of_term_exams',label:'END OF TERM EXAMS',score:100},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
      {key:'total_score',label:'TOTAL SCORE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},{key:'sign',label:'SIGN.'},{key:'grade',label:s.grade_label || 'GRADE'}
    ],
    model_8:[
      {key:'ca',label:'CA',score:20},{key:'unit',label:'UNIT'},{key:'exam',label:'EXAM',score:80},{key:'total_score',label:'TOTAL SCORE',score:100},
      {key:'cum_total_score',label:'CUM. TOTAL SCORE'},{key:'percentage',label:'PERCENTAGE'},{key:'position_in_subject',label:'POSITION IN SUBJECT'},
      {key:'class_average',label:'CLASS AVERAGE'},{key:'remarks',label:s.remarks_label || 'REMARKS'},{key:'point',label:'POINT'},{key:'sign',label:'SIGN.'},{key:'grade',label:s.grade_label || 'GRADE'}
    ]
  };
  const custom = (state.customizations.academic_columns || {})[model] || {};
  const hidden = {
    remarks:s.show_remarks === false,
    position_in_subject:s.show_position === false,
    class_average:s.show_class_average === false,
    cum_total_score:s.show_cum_total === false,
    percentage:s.show_percentage === false,
    sign:s.show_sign_column === false
  };
  return (models[model] || standard).map(col=>Object.assign({}, col, custom[col.key] || {})).filter(col=>col.visible !== false && !hidden[col.key]);
}

function reportTemplateColumnWidths(headers){
  const reference = {
    subject:6.638, ca:.774, ca1:.774, ca2:.774, ca3:.774, test:.774,
    exam:1.272, end_of_term_exams:1.272, total:1.162, total_score:1.162,
    cum_total:1.355, cum_total_score:1.355, percentage:1.549,
    position:1.632, position_in_subject:1.632, class_average:1.632,
    class_avg:1.632, remarks:1.66, descriptor:1.66, sign:1.272,
    subject_teacher:1.66, grade:1.0, average:1.549, marks_average:1.549,
    max:.9, coef:.7, point:.7
  };
  const weights = headers.map(h=>reference[h.key] || (h.score ? reference.ca : 1.25));
  const totalColumns = weights.reduce((sum,w)=>sum+w,0) || 1;
  const subject = reference.subject;
  const total = subject + totalColumns;
  return {
    subject:Number(((subject / total) * 100).toFixed(2)),
    columns:weights.map(w=>Number(((w / total) * 100).toFixed(2)))
  };
}

function reportTemplateFormatHeader(label){
  return escapeHtml(label || '').replace(/\s+/g,'<br>');
}

function reportTemplateGradeCode(score){
  if(reportTemplateIsMissing(score)) return '—';
  const g = getGrade(score);
  return g ? g.code : '—';
}

function reportTemplateGradeColor(code){
  if(!code || code === '-' || code === '—') return '#333';
  if(code.startsWith('EE')) return '#276749';
  if(code.startsWith('ME')) return '#2b6cb0';
  if(code.startsWith('AE')) return '#b7791f';
  return '#c53030';
}

function reportTemplateRemark(state, score){
  if(reportTemplateIsMissing(score)) return '—';
  const n = Number(score);
  const rows = state.customizations.remarks_table || [];
  const row = rows.find(r=>n >= Number(r.min) && n <= Number(r.max));
  return row ? row.text || '—' : '—';
}

function reportTemplateAcademicCell(header, row, state, scoreIndex){
  const attrs = `data-s3-col="${escapeHtml(header.key)}"`;
  const scoreCell = value => `<td ${attrs}>${scoreText(value)}</td>`;
  if(header.key === 'max') return scoreCell(header.score || row.componentMax || 100);
  if(reportTemplateIsComponentHeader(header)) {
    const direct = header.component_key ? (row.componentEntries || []).find(entry=>String(entry.key)===String(header.component_key)) : null;
    return scoreCell(direct ? direct.score : reportTemplateScoreForHeader(header.key, row));
  }
  if(['total','total_score','cum_total_score'].includes(header.key)) return scoreCell(row.rawTotal);
  if(['percentage','average','marks_average','mean'].includes(header.key)) return `<td ${attrs}>${escapeHtml(percentText(row.percent))}</td>`;
  if(['position','position_in_subject'].includes(header.key)) return `<td ${attrs}>${escapeHtml(row.rank || '-')}</td>`;
  if(header.key === 'class_average') return scoreCell(row.stats?.avg);
  if(header.key === 'remarks' || header.key === 'descriptor') return `<td ${attrs}>${escapeHtml(reportTemplateRemark(state, row.percent).toUpperCase())}</td>`;
  if(header.key === 'grade' || header.key === 'identifier') return `<td ${attrs}><span style="color:${reportTemplateGradeColor(row.grade)};font-weight:800;">${escapeHtml(row.grade || '—')}</span></td>`;
  if(header.key === 'class_highest') return scoreCell(row.stats?.highest);
  if(header.key === 'class_lowest') return scoreCell(row.stats?.lowest);
  if(header.key === 'coef') return `<td ${attrs}>1</td>`;
  if(header.key === 'point') return `<td ${attrs}>${row.percent == null ? '—' : Math.max(1, Math.round(Number(row.percent)/20))}</td>`;
  if(header.key === 'unit') return `<td ${attrs}>${escapeHtml(reportAssessmentLabel(row.assessment))}</td>`;
  if(header.key === 'subject_teacher') return `<td ${attrs}>${escapeHtml(row.subject.teacher_name || '')}</td>`;
  return `<td ${attrs}></td>`;
}

function renderReportTemplateS3(model, state, data){
  const templateHeaders = reportTemplateAcademicColumns(model, state);
  const hasTemplateScoreHeaders = templateHeaders.some(reportTemplateIsComponentHeader);
  const scoreHeaders = hasTemplateScoreHeaders ? reportTemplateActualScoreHeaders(data) : [];
  const metaHeaders = templateHeaders.filter(h=>!reportTemplateIsComponentHeader(h));
  const headers = [...scoreHeaders, ...metaHeaders];
  const colspan = 1 + headers.length;
  const widths = reportTemplateColumnWidths(headers);
  const colgroup = `<colgroup><col data-s3-role="subject-col" style="width:${widths.subject}%">${headers.map((h,i)=>`<col class="${reportTemplateIsComponentHeader(h)?'template-preview-academic-col-score':'template-preview-academic-col-meta'}" data-s3-col="${escapeHtml(h.key)}" style="width:${widths.columns[i]}%">`).join('')}</colgroup>`;
  const header1 = `<tr><th colspan="${colspan}" class="template-preview-academic-title">Academic Performance</th></tr>`;
  const header2 = `<tr><th rowspan="2" class="template-preview-academic-subject">SUBJECT</th>${scoreHeaders.map(h=>`<th class="template-preview-academic-main" data-s3-col="${escapeHtml(h.key)}">${reportTemplateFormatHeader(h.label)}</th>`).join('')}${metaHeaders.map(h=>`<th rowspan="2" class="template-preview-academic-main" data-s3-col="${escapeHtml(h.key)}">${reportTemplateFormatHeader(h.label)}</th>`).join('')}</tr>`;
  const header3 = `<tr>${scoreHeaders.map(h=>`<th class="template-preview-academic-mark" data-s3-col="${escapeHtml(h.key)}">${escapeHtml(reportTemplateHeaderMax(h, data))}</th>`).join('')}</tr>`;
  const rows = data.subjectRows.map((row,i)=>{
    let scoreIndex = -1;
    const cells = headers.map(h=>{
      if(reportTemplateIsComponentHeader(h)) scoreIndex += 1;
      return reportTemplateAcademicCell(h, row, state, scoreIndex);
    }).join('');
    return `<tr class="template-preview-academic-subject-row"><td>${escapeHtml((row.subject.subject_name || '').toUpperCase())}</td>${cells}</tr>`;
  }).join('');
  const total = `<tr class="template-preview-total-row"><td><strong>OVERALL</strong></td>${headers.map(h=>{
    if(['total','total_score','cum_total_score'].includes(h.key)) return `<td><strong>${scoreText(data.totalObtained)}</strong></td>`;
    if(['percentage','average','marks_average','mean'].includes(h.key)) return `<td><strong>${escapeHtml(data.averagePercent)}</strong></td>`;
    if(h.key === 'grade') return `<td><strong>${escapeHtml(reportTemplateGradeCode(data.averagePercentRaw))}</strong></td>`;
    return '<td></td>';
  }).join('')}</tr>`;
  const modelClass = model === 'model_1' ? '' : ` template-preview-academic-${escapeHtml(model.replace('_',''))}`;
  return `<div class="template-preview-academic${modelClass}" data-subjects="${data.subjectRows.length}" data-columns="${colspan}"><table class="template-preview-table">${colgroup}${header1}${header2}${header3}${rows}${total}</table></div>`;
}

function renderReportTemplateS4(model, state){
  if(model === 'none') return '';
  const grades = state.customizations.grade_key || [];
  let content = '';
  if(model === 'model_2') content = `<tr><th colspan="${grades.length}">Keys To Rating</th></tr><tr>${grades.map(g=>`<td>${escapeHtml(g.code)} ${escapeHtml(g.range)}</td>`).join('')}</tr>`;
  else if(model === 'model_3') content = `<tr><th colspan="${grades.length}">Keys To Rating</th></tr><tr>${grades.map(g=>`<td>[${escapeHtml(g.range)}] = ${escapeHtml(g.code)}</td>`).join('')}</tr>`;
  else if(model === 'model_4') content = `<tr><th colspan="${grades.length}">Keys To Rating</th></tr><tr>${grades.map(g=>`<td>${escapeHtml(g.range)}<br>${escapeHtml(g.code)}</td>`).join('')}</tr>`;
  else content = `<tr><th colspan="${grades.length}">Keys To Rating</th></tr><tr>${grades.map(g=>`<td>${escapeHtml(g.range)} (${escapeHtml(g.code)})</td>`).join('')}</tr>`;
  return reportTemplateSectionWrap('section_4', model, `<div class="template-preview-grade"><table class="template-preview-table">${content}</table></div>`);
}

function renderReportTemplateS5(model, state, data){
  if(model === 'none') return '';
  const sk = state.customizations.skills || {};
  const ratings = sk.ratings && sk.ratings.length ? sk.ratings : [5,4,3,2,1];
  const thR = ratings.map(r=>`<th>${escapeHtml(r)}</th>`).join('');
  const skillRatings = data?.skills || {};
  const ratingCells = (categoryKey, item) => {
    if(!state.settings.autofill_skills) return ratings.map(()=>'<td></td>').join('');
    const itemKey = reportSkillItemKey(item);
    const selected = skillRatings[categoryKey]?.[itemKey];
    if(selected === null || selected === undefined || selected === '') return ratings.map(()=>'<td>—</td>').join('');
    return ratings.map(r=>`<td>${String(r) === String(selected) ? '&check;' : ''}</td>`).join('');
  };
  const categories = [
    { key:'affective_traits', title:'AFFECTIVE TRAITS', side:'left', items:sk.affective || [] },
    { key:'psychomotor_skills', title:'PSYCHOMOTOR SKILLS', side:'right', items:sk.psychomotor || [] }
  ];
  const tableFor = category => `<table class="template-preview-table template-preview-skills-table">
    <tr><th class="template-preview-skills-category">${escapeHtml(category.title)}</th>${thR}</tr>
    ${(category.items || []).map(item=>`<tr><td><span class="template-preview-skills-text">${escapeHtml(item)}</span></td>${ratingCells(category.key, item)}</tr>`).join('')}
  </table>`;
  if(model === 'model_2'){
    return `<div class="template-preview-skills" style="grid-template-columns:1fr;"><div class="template-preview-skills-side">${categories.map(c=>tableFor(c)).join('')}${renderReportTemplateRatingKey(sk)}</div></div>`;
  }
  return `<div class="template-preview-skills">
    <div class="template-preview-skills-side">${categories.filter(c=>c.side !== 'right').map(c=>tableFor(c)).join('')}${model === 'model_3' ? renderReportTemplateRatingKey(sk) : ''}</div>
    <div class="template-preview-skills-side">${categories.filter(c=>c.side === 'right').map(c=>tableFor(c)).join('')}</div>
  </div>`;
}

function renderReportTemplateRatingKey(sk){
  const ratings = sk.ratings && sk.ratings.length ? sk.ratings : [5,4,3,2,1];
  const labels = sk.rating_labels || [];
  const cells = ratings.map((r,i)=>`<td><span class="rating-key-score">${escapeHtml(r)}</span>${escapeHtml(labels[i] || '')}</td>`).join('');
  return `<table class="template-preview-table template-preview-rating-key template-preview-rating-key--blank"><tr><th colspan="${ratings.length || 1}">Keys To Rating</th></tr><tr>${cells}</tr></table>`;
}

function renderReportTemplateStamp(state){
  const s = state.settings;
  const school = state.school;
  if(!s.show_stamp) return '<div class="template-preview-stamp" hidden></div>';
  if(s.stamp_image) return `<div class="template-preview-stamp"><img src="${escapeHtml(s.stamp_image)}" alt="Stamp"></div>`;
  return `<div class="template-preview-stamp"><div class="template-preview-stamp-oval">
    <span class="stamp-name">${escapeHtml(school.name || 'JOYLAND SCHOOLS')}</span>
    <div class="stamp-line"></div>
    <span class="stamp-sub">${escapeHtml(school.type || 'PRIMARY')}</span>
    <span class="stamp-sub">Official Stamp</span>
  </div></div>`;
}

// Pick a bank comment for {role} at {percent}, preferring per-class entry over global.
// Returns the comment text, or null if no match (caller falls back to template's static comment).
function pickBankComment(role, percent, classId){
  const bank = (typeof commentBankCache !== 'undefined' ? commentBankCache : {})[role] || [];
  const p = Number(percent);
  if(!Number.isFinite(p)) return null;
  if(classId){
    const classMatch = bank.find(r => Number(r.class_id) === Number(classId) && p >= Number(r.min_score) && p <= Number(r.max_score));
    if(classMatch) return classMatch.comment_text;
  }
  const globalMatch = bank.find(r => !r.class_id && p >= Number(r.min_score) && p <= Number(r.max_score));
  return globalMatch ? globalMatch.comment_text : null;
}

function renderReportTemplateS6(model, state, data, classId){
  if(model === 'none') return '';
  const s = state.settings;
  const sigs = (typeof signaturesCache !== 'undefined') ? signaturesCache : { class_teacher:'', headteacher:'', director:'' };
  // averagePercent in data may be '—' (string) when no marks — coerce to null
  const rawAvg = data && data.averagePercent;
  const avg = (rawAvg === '—' || rawAvg === '' || rawAvg == null) ? null : Number(rawAvg);
  const comments = [];
  if(s.show_teacher_comment){
    const banked = pickBankComment('class_teacher', avg, classId);
    comments.push({
      role: s.teacher_role_label || 'Class Teacher',
      text: banked || s.teacher_comment || '',
      sig:  sigs.class_teacher || ''
    });
  }
  if(s.show_head_comment){
    const banked = pickBankComment('headteacher', avg, classId);
    comments.push({
      role: s.head_role_label || 'Headteacher',
      text: banked || s.head_comment || '',
      sig:  sigs.headteacher || ''
    });
  }
  if(s.show_director_comment){
    const banked = pickBankComment('director', avg, classId);
    comments.push({
      role: s.director_role_label || 'Director',
      text: banked || s.director_comment || '',
      sig:  sigs.director || ''
    });
  }
  const stampPanel = s.show_stamp ? `<aside class="template-preview-stamp-panel"><div class="template-preview-stamp-title">School Stamp</div>${renderReportTemplateStamp(state)}</aside>` : '';
  const layoutClass = stampPanel ? '' : ' template-preview-comments--no-stamp';
  const date = new Date().toLocaleDateString('en-GB');
  const rows = comments.map(c=>{
    const signImg = c.sig
      ? `<img src="${escapeHtml(c.sig)}" alt="signature" style="max-height:100%;max-width:100%;object-fit:contain;display:block;margin:auto;">`
      : '';
    return `<div class="template-preview-comment-row" data-comment-row="${escapeHtml(c.role.toLowerCase().replace(/\s+/g,'_'))}">
      <div class="template-preview-comment-label">${escapeHtml(c.role)}'s Comments:</div><div class="template-preview-comment-text">${escapeHtml(c.text || '________________________________________')}</div><div class="template-preview-comment-sign">Sign:</div><div class="template-preview-sign-line">${signImg}</div><div class="template-preview-comment-date">Date:</div><div class="template-preview-comment-date-value">${escapeHtml(date)}</div>
    </div>`;
  }).join('');
  const promotion = s.show_promotion ? `<div class="template-preview-promotion-status">${escapeHtml(s.promotion_status || 'PROMOTED TO: ________________')}</div>` : '';
  return `<div class="template-preview-comments${layoutClass}"><div class="template-preview-comments-box">${rows}</div>${stampPanel}</div>${promotion}`;
}

function reportTemplateResultTitle(state, assessment){
  const raw = String(state?.settings?.result_title || '').trim();
  const generic = !raw || /^end\s+of\s+term\s+report\s+card$/i.test(raw);
  if(!generic) return raw;
  if(assessment === 'opener') return 'OPENER REPORT CARD';
  if(assessment === 'midterm') return 'MIDTERM REPORT CARD';
  return 'END OF TERM REPORT CARD';
}

function buildReportTemplateLearnerData({state, classId, termId, assessment, learner, subjects, grouped, componentKeys, componentDefs, strict, classLearners, attendanceSummary, skillRatings}){
  const cls = reportClassById(classId);
  const term = reportTermById(termId);
  const nextTerm = reportTemplateNextTerm(term);
  const termDays = reportTemplateTermDays(term);
  const attendance = attendanceSummary?.learners?.[String(learner.id)] || null;
  const componentMax = componentDefs.reduce((sum,c)=>sum + (Number(c.max_score) || 0), 0) || (componentKeys.length ? componentKeys.length * 100 : 100);
  const normalizedComponentDefs = componentDefs.map((def,i)=>reportTemplateComponentEntry(def, null, i));
  const statsBySubject = {};
  subjects.forEach(subject=>{
    const ranked = (classLearners || []).map(l=>{
      const subjectGroup = grouped[String(l.id)]?.[String(subject.subject_id)] || {};
      const raw = sumReportComponents(subjectGroup, assessment, componentKeys, strict);
      return { learnerId:String(l.id), raw };
    }).filter(r=>r.raw !== null).sort((a,b)=>Number(b.raw)-Number(a.raw));
    const vals = ranked.map(r=>r.raw);
    statsBySubject[String(subject.subject_id)] = {
      avg: reportAverage(vals),
      highest: vals.length ? Math.max(...vals) : null,
      lowest: vals.length ? Math.min(...vals) : null,
      rankMap: Object.fromEntries(ranked.map((r,i)=>[r.learnerId, ordinal(i+1)]))
    };
  });
  const subjectRows = subjects.map(subject=>{
    const subjectGroup = grouped[String(learner.id)]?.[String(subject.subject_id)] || {};
    const componentScores = componentKeys.map(key=>firstReportScore(subjectGroup, assessment, key, strict));
    const componentEntries = componentDefs.map((def,i)=>reportTemplateComponentEntry(def, componentScores[i] ?? null, i));
    const rawTotal = sumReportComponents(subjectGroup, assessment, componentKeys, strict);
    const percent = rawTotal === null ? null : Math.round((Number(rawTotal) / componentMax) * 10000) / 100;
    const stats = statsBySubject[String(subject.subject_id)] || {};
    return {
      subject,
      assessment,
      componentScores,
      componentEntries,
      componentMax,
      rawTotal,
      percent,
      grade: reportTemplateGradeCode(percent),
      stats,
      rank: stats.rankMap ? stats.rankMap[String(learner.id)] : '-'
    };
  });
  const rawTotals = subjectRows.map(r=>r.rawTotal).filter(v=>v !== null);
  const totalObtained = Math.round(rawTotals.reduce((a,b)=>a + Number(b), 0) * 100) / 100;
  const averagePercent = reportAverage(subjectRows.map(r=>r.percent));
  const overallRanked = (classLearners || []).map(l=>{
    const subjectPercents = subjects.map(subject=>{
      const subjectGroup = grouped[String(l.id)]?.[String(subject.subject_id)] || {};
      const raw = sumReportComponents(subjectGroup, assessment, componentKeys, strict);
      return raw === null ? null : Math.round((Number(raw) / componentMax) * 10000) / 100;
    });
    return { learnerId:String(l.id), average:reportAverage(subjectPercents) };
  }).filter(r=>r.average !== null).sort((a,b)=>Number(b.average)-Number(a.average));
  const overallPositionMap = Object.fromEntries(overallRanked.map((r,i)=>[r.learnerId, ordinal(i+1)]));
  return {
    learner,
    componentDefs:normalizedComponentDefs,
    componentMax,
    student:{
      name: learner.name || '-',
      dob: reportTemplateDate(learner.date_of_birth),
      sex: learner.sex || '-',
      class: cls?.name || learner.class_name || '-',
      admission_no: learner.admission_no || learner.user_id || '-'
    },
    classCount:(classLearners || []).length || '-',
    termDuration: termDays === '—' ? '—' : `${termDays} days`,
    termBegins: reportTemplateDateNumeric(term?.start_date),
    termEnds: reportTemplateDateNumeric(term?.end_date),
    nextTermBegins: reportTemplateDateNumeric(nextTerm?.start_date),
    opened: attendance?.opened ?? attendanceSummary?.opened ?? '—',
    present: attendance?.present ?? '—',
    absent: attendance?.absent ?? '—',
    totalObtainable: componentMax && subjects.length ? Math.round(componentMax * subjects.length * 100) / 100 : '—',
    totalObtained: rawTotals.length ? totalObtained : '—',
    averagePercent: percentText(averagePercent),
    averagePercentRaw: averagePercent,
    position: overallPositionMap[String(learner.id)] || '—',
    skills: skillRatings?.[String(learner.id)] || {},
    subjectRows
  };
}

function renderReportTemplatePage(context){
  const state = context.state;
  const m = state.selected_models;
  const s = state.settings;
  const data = buildReportTemplateLearnerData(context);
  let html = '';
  html += s.bg_image ? `<div class="template-preview-background"><img src="${escapeHtml(s.bg_image)}" alt=""></div>` : '<div class="template-preview-background" hidden></div>';
  html += reportTemplateSectionWrap('section_1', m.section_1, renderReportTemplateS1(m.section_1, state.school, s));
  html += `<div class="template-preview-title" data-preview-result-title>${escapeHtml(reportTemplateResultTitle(state, context.assessment))}</div>`;
  if(m.section_3 === 'model_3'){
    html += `<div class="template-preview-combined template-preview-combined--s3m3">
      <div class="template-preview-combined-s2" data-combined-preview="section_2"><div class="template-preview-model template-preview-model--${escapeHtml(m.section_2)} is-active" data-preview-model="${escapeHtml(m.section_2)}">${renderReportTemplateS2(m.section_2, state, data)}</div></div>
      <div class="template-preview-combined-s3" data-combined-preview="section_3"><div class="template-preview-model template-preview-model--${escapeHtml(m.section_3)} is-active" data-preview-model="${escapeHtml(m.section_3)}">${renderReportTemplateS3(m.section_3, state, data)}</div></div>
    </div>`;
  }else{
    html += reportTemplateSectionWrap('section_2', m.section_2, renderReportTemplateS2(m.section_2, state, data));
    html += reportTemplateSectionWrap('section_3', m.section_3, renderReportTemplateS3(m.section_3, state, data));
  }
  if(m.section_4 !== 'none' && s.show_grade_keys) html += renderReportTemplateS4(m.section_4, state);
  if(m.section_5 !== 'none') html += reportTemplateSectionWrap('section_5', m.section_5, renderReportTemplateS5(m.section_5, state, data));
  if(m.section_6 !== 'none') html += reportTemplateSectionWrap('section_6', m.section_6, renderReportTemplateS6(m.section_6, state, data, context.classId));
  if(s.footer_text) html += `<div class="template-preview-footer-note" data-preview-footer-text>${escapeHtml(s.footer_text)}</div>`;
  return `<div class="report-template-sheet-frame"><div class="te-preview-shell report-template-sheet" style="${reportTemplateStyleAttr(state)}"><div class="tp-page template-preview-report report-layout-compact" data-layout-mode="compact" data-lock-print-measurements="true" data-measurement-scale="1.000">${html}</div></div></div>`;
}

function renderLearnerReportTemplatePages(context){
  const pages = context.learners.map(learner=>renderReportTemplatePage(Object.assign({}, context, { learner }))).join('');
  const className = reportClassName(context.classId) || 'Selected class';
  const componentLine = context.componentNames.length ? `Components: ${context.componentNames.join(', ')}` : 'Selected components';
  return `<div class="report-template-summary">
    <div><h4>${escapeHtml(context.state.template_name || 'Default Template')}</h4><p>${escapeHtml(className)} - ${escapeHtml(reportTermLabel(context.termId))} - ${escapeHtml(reportAssessmentLabel(context.assessment))}<br>${escapeHtml(componentLine)}</p></div>
    <p>${context.learners.length} learner${context.learners.length === 1 ? '' : 's'}</p>
  </div><div class="report-template-page-stack">${pages}</div>`;
}


window.DarajaReportPreview = {
  ensureStyles: ensureReportTemplateStyles,
  normalizeState: normalizeReportTemplateState,
  renderPages: renderLearnerReportTemplatePages,
  fitSheets: fitReportTemplateSheets,
  setGlobals(data={}){
    window.allClasses = data.classes || window.allClasses || [];
    window.allLearners = data.learners || window.allLearners || [];
    window.allClassSubjects = data.classSubjects || window.allClassSubjects || [];
    window.cachedTerms = data.terms || window.cachedTerms || [];
    window.commentBankCache = data.commentBank || window.commentBankCache || { class_teacher:[], headteacher:[], director:[] };
    window.signaturesCache = data.signatures || window.signaturesCache || { class_teacher:'', headteacher:'', director:'' };
    window.ASSESSMENT_OPTIONS = data.assessments || window.ASSESSMENT_OPTIONS || [
      { value:'opener', label:'Opener' },
      { value:'midterm', label:'Midterm' },
      { value:'endterm', label:'Endterm' }
    ];
  }
};
})();
