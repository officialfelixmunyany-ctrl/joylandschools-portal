/* Shared Class Broadsheet renderer for the teacher app.
   Extracted verbatim from public/admin.html so the mobile broadsheet renders
   identically to the admin one - same aggregation already done server-side,
   same competition ranking, same CBC remark scale, same A4-landscape sheet. */
(function(){
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function averageList(values) {
  const nums = values.filter(v => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  if (!nums.length) return null;
  return Math.round((nums.reduce((sum, v) => sum + v, 0) / nums.length) * 100) / 100;
}

function prepareBroadsheetData(data, type) {
  // Per-learner: compute selected score, subject_count (only counted if score present), total, average
  const learners = (data.learners || []).map(learner => {
    const subjects = (learner.subjects||[]).map(subject => {
      const score = type === 'term' ? (subject.average ?? null) : (subject[type] ?? null);
      return { ...subject, selected_score:score };
    });
    const scores = subjects.map(s=>s.selected_score).filter(v => v !== null && v !== undefined);
    const total = scores.length ? Math.round(scores.reduce((a,b)=>a+Number(b),0) * 100) / 100 : null;
    const average = averageList(scores);
    return { ...learner, subjects, total, average, subject_count:scores.length };
  });
  // Sort by average (descending); learners with no average go to the end
  learners.sort((a,b) => {
    const av = a.average === null || a.average === undefined ? -Infinity : Number(a.average);
    const bv = b.average === null || b.average === undefined ? -Infinity : Number(b.average);
    return bv - av;
  });
  // Competition ranking (1, 1, 3, ...) - ties share the rank, gaps follow
  let rank = 0;
  let lastValue = null;
  learners.forEach((learner, index) => {
    if (learner.average === null || learner.average === undefined) { learner.position = null; return; }
    const value = Number(learner.average);
    if (value !== lastValue) { rank = index + 1; lastValue = value; }
    learner.position = rank;
  });
  return learners;
}

// CBC remark from a percentage (Kenya CBC scale)
function cbcRemark(percent) {
  if (percent === null || percent === undefined || percent === '') return '';
  const n = Number(percent);
  if (Number.isNaN(n)) return '';
  if (n >= 75) return 'EXCEEDING EXPECTATION';
  if (n >= 50) return 'MEETING EXPECTATION';
  if (n >= 30) return 'APPROACHING EXPECTATION';
  return 'BELOW EXPECTATION';
}

function broadsheetRemarkSummary(learners) {
  const counts = { exceeding:0, meeting:0, approaching:0, below:0, total:0 };
  learners.forEach(l => {
    counts.total += 1;
    const r = cbcRemark(l.average);
    if (r === 'EXCEEDING EXPECTATION') counts.exceeding += 1;
    else if (r === 'MEETING EXPECTATION') counts.meeting += 1;
    else if (r === 'APPROACHING EXPECTATION') counts.approaching += 1;
    else if (r === 'BELOW EXPECTATION') counts.below += 1;
  });
  return counts;
}

// "Term 1" -> "FIRST TERM", etc.
function termOrdinalLabel(termName) {
  const t = String(termName||'').toLowerCase();
  if (t.includes('1') || t.includes('one') || t.includes('first')) return 'FIRST TERM';
  if (t.includes('2') || t.includes('two') || t.includes('second')) return 'SECOND TERM';
  if (t.includes('3') || t.includes('three') || t.includes('third')) return 'THIRD TERM';
  return String(termName||'').toUpperCase();
}

function buildBroadsheetHtml(data, type = 'term') {
  const esc = escapeHtml;
  const { subjects } = data;
  const cls = data.class || {};
  const term = data.term || {};
  const school = data.school || {};
  const schoolName = (school.school_name || 'JOYLAND SCHOOLS').toUpperCase();
  const logo = school.school_logo ? `<img class="bs-logo" src="${esc(school.school_logo)}" alt="">` : '';
  const displayLearners = prepareBroadsheetData(data, type);
  const summary = broadsheetRemarkSummary(displayLearners);
  const yearMatch = String(term.session_name || '').match(/\d{4}/);
  const year = yearMatch ? yearMatch[0] : '';
  const termWord = termOrdinalLabel(term.term_name);
  const className = String(cls.name || '').toUpperCase();
  const subjectHeaderCells = subjects.map(s => `<th>${esc(String(s.name||'').toUpperCase())}</th>`).join('');
  const rows = displayLearners.map((l, i) => {
    const subjectCells = subjects.map(s => {
      const lsub = (l.subjects||[]).find(ls => String(ls.subject_id) === String(s.id) || ls.name === s.name);
      const score = lsub ? lsub.selected_score : null;
      const display = (score === null || score === undefined || score === '') ? '' : Math.round(Number(score) * 10) / 10;
      return `<td>${display === '' ? '' : display}</td>`;
    }).join('');
    const avgDisplay = (l.average === null || l.average === undefined) ? '' : Number(l.average).toFixed(1);
    const remark = cbcRemark(l.average);
    return `<tr>
      <td>${i+1}</td>
      <td>${esc(l.admission_no || '')}</td>
      <td class="bs-name">${esc(String(l.name||'').toUpperCase())}</td>
      <td>${esc(String(l.sex||'').toUpperCase())}</td>
      ${subjectCells}
      <td>${l.subject_count || ''}</td>
      <td>${avgDisplay}</td>
      <td>${l.position == null ? '' : l.position}</td>
      <td class="bs-remark">${esc(remark)}</td>
    </tr>`;
  }).join('');
  const yearTermLine = year && termWord ? `(${esc(year)} - ${esc(termWord)})` : esc(termWord || term.term_name || '');
  // Column widths designed to fit A4 landscape (~1091px usable inside the page).
  const FIXED_PRE_WIDTH  = 30 + 70 + 170 + 42;
  const FIXED_POST_WIDTH = 56 + 50 + 46 + 96;
  const USABLE_WIDTH     = 1091;
  const subjectsCount    = Math.max(1, subjects.length);
  const subjectColWidth  = Math.max(48, Math.floor((USABLE_WIDTH - FIXED_PRE_WIDTH - FIXED_POST_WIDTH) / subjectsCount));
  const subjectColsHtml  = subjects.map(()=>`<col style="width:${subjectColWidth}px">`).join('');
  const colgroup = `<colgroup>
    <col style="width:30px">
    <col style="width:70px">
    <col style="width:170px">
    <col style="width:42px">
    ${subjectColsHtml}
    <col style="width:56px">
    <col style="width:50px">
    <col style="width:46px">
    <col style="width:96px">
  </colgroup>`;
  return `
    <div class="broadsheet-sheet broadsheet-simple">
      <div class="bs-header">
        ${logo}
        <h2 class="bs-school-name">${esc(schoolName)}</h2>
        <p class="bs-report-title">${esc(className)} BROADSHEET REPORT</p>
        <p class="bs-report-sub">${yearTermLine}</p>
      </div>
      <table class="broadsheet-table-simple">
        ${colgroup}
        <thead>
          <tr>
            <th>S/N</th>
            <th>ADMISSION NO.</th>
            <th>NAME</th>
            <th>SEX</th>
            ${subjectHeaderCells}
            <th>TOTAL NO. OF SUBJECTS</th>
            <th>AVERAGE (%)</th>
            <th>POSITION</th>
            <th>REMARKS</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="bs-summary">
        <span><strong>EXCEEDING EXPECTATION:</strong> ${summary.exceeding}</span>
        <span><strong>MEETING EXPECTATION:</strong> ${summary.meeting}</span>
        <span><strong>APPROACHING EXPECTATION:</strong> ${summary.approaching}</span>
        <span><strong>BELOW EXPECTATION:</strong> ${summary.below}</span>
        <span><strong>TOTAL:</strong> ${summary.total}</span>
      </div>
    </div>`;
}

let stylesInjected = false;
function ensureBroadsheetStyles(){
  if (stylesInjected || document.getElementById('daraja-broadsheet-styles')) { stylesInjected = true; return; }
  stylesInjected = true;
  const css = `
.broadsheet-sheet{display:inline-block;background:#fff;box-shadow:0 12px 34px rgba(0,0,0,0.12);}
.broadsheet-simple{background:#fff;color:#000;padding:14px 16px 18px;font-family:'Poppins',sans-serif;box-sizing:border-box;width:1123px;min-width:1123px;}
.broadsheet-simple .bs-header{text-align:center;margin-bottom:12px;}
.broadsheet-simple .bs-logo{width:68px;height:68px;border-radius:50%;object-fit:contain;display:block;margin:0 auto 6px;}
.broadsheet-simple .bs-school-name{font-size:20px;font-weight:800;color:#000;text-transform:uppercase;letter-spacing:.5px;margin:0;}
.broadsheet-simple .bs-report-title{font-size:13px;font-weight:700;color:#000;text-transform:uppercase;margin:5px 0 0;}
.broadsheet-simple .bs-report-sub{font-size:10.5px;font-weight:600;color:#000;margin:2px 0 0;}
.broadsheet-table-simple{width:100%;border-collapse:collapse;font-size:9.5px;color:#000;table-layout:fixed;}
.broadsheet-table-simple thead{display:table-header-group;}
.broadsheet-table-simple tr{page-break-inside:avoid;break-inside:avoid;}
.broadsheet-table-simple th,.broadsheet-table-simple td{border:1px solid #000;padding:4px 3px;text-align:center;vertical-align:middle;line-height:1.18;overflow:hidden;}
.broadsheet-table-simple th{font-weight:700;font-size:8.5px;text-transform:uppercase;background:#fff;letter-spacing:.2px;white-space:normal;word-wrap:break-word;overflow-wrap:break-word;hyphens:none;}
.broadsheet-table-simple td{white-space:normal;word-wrap:break-word;overflow-wrap:break-word;}
.broadsheet-table-simple td.bs-name{text-align:left;font-weight:500;font-size:9px;line-height:1.15;}
.broadsheet-table-simple td.bs-remark{font-size:8px;line-height:1.1;text-transform:uppercase;}
.broadsheet-simple .bs-summary{margin-top:12px;font-size:9.5px;color:#000;display:flex;flex-wrap:wrap;justify-content:space-around;gap:10px;text-align:center;}
.broadsheet-simple .bs-summary span{white-space:nowrap;}
.broadsheet-simple .bs-summary strong{font-weight:700;}
/* Mobile fit shell: scale the 1123px A4 sheet down to the phone width */
.bs-fit-shell{width:100%;overflow:hidden;}
.bs-fit-scale{width:1123px;transform-origin:top left;}
`;
  const el = document.createElement('style');
  el.id = 'daraja-broadsheet-styles';
  el.textContent = css;
  document.head.appendChild(el);
}

// Scale a rendered .broadsheet-sheet inside a .bs-fit-shell to fit the container width.
function fitBroadsheet(root){
  (root || document).querySelectorAll('.bs-fit-shell').forEach(shell => {
    const scale = shell.querySelector('.bs-fit-scale');
    if (!scale) return;
    const avail = shell.clientWidth || shell.offsetWidth || 0;
    if (!avail) return;
    const factor = Math.min(1, avail / 1123);
    scale.style.transform = `scale(${factor.toFixed(4)})`;
    const sheet = scale.querySelector('.broadsheet-sheet');
    const h = sheet ? sheet.offsetHeight : 0;
    if (h) shell.style.height = Math.ceil(h * factor) + 'px';
  });
}

window.DarajaBroadsheet = {
  buildHtml: buildBroadsheetHtml,
  ensureStyles: ensureBroadsheetStyles,
  fit: fitBroadsheet
};
})();
