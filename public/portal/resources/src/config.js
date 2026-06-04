export const CONFIG = {
  appName: 'Civicom Learning Portal',
  org: 'Civicom',
  tagline: 'Revision & Learning Materials',
  domain: 'schools.civicom.org',
  apiBase: '/api/portal',
  authBase: '/api',
  loginUrl: '#/school-login',
  schoolLoginUrl: '#/school-login',
  createSchoolUrl: '#/create-school',
  supportEmail: 'schools@civicom.org',
  publicSchoolsApi: '/api/public/schools',
  registerSchoolApi: '/api/public/register-school',
  // Fall back to the bundled sample dataset when the API is unavailable so the
  // discovery experience keeps working offline / in demo mode.
  useMockFallback: true
};

// Levels. `grade-1-9` is a convenience group (Primary + Junior) used by the
// homepage section that mirrors kcseonline's "Grade 1-9" grouping.
export const LEVELS = [
  { id: 'all', label: 'All levels', helper: 'Everything' },
  { id: 'pre-primary', label: 'Pre-Primary (PP1-PP2)', helper: 'PP1-PP2' },
  { id: 'cbc-primary', label: 'Primary', helper: 'Grades 1-6' },
  { id: 'junior-secondary', label: 'Junior School', helper: 'Grades 7-9' },
  { id: 'grade-1-9', label: 'Grade 1-9', helper: 'Primary & Junior' },
  { id: 'senior-secondary', label: 'Senior Secondary', helper: 'Grades 10-12' },
  { id: 'secondary-844', label: 'KCSE (Form 1-4)', helper: 'Forms 1-4' },
  { id: 'tvet', label: 'TVET', helper: 'Skills training' }
];

// Level groups expand to several concrete levels during filtering.
export const LEVEL_GROUPS = {
  'grade-1-9': ['cbc-primary', 'junior-secondary']
};

export const AUDIENCES = [
  { id: 'all', label: 'Everyone' },
  { id: 'learner', label: 'Learner' },
  { id: 'teacher', label: 'Teacher' },
  { id: 'school', label: 'School' }
];

// Resource categories in the language Kenyan teachers and learners actually use.
// Exam-workflow types (paper + marking scheme + mock + prediction) come first;
// teacher professional documents follow.
export const RESOURCE_TYPES = [
  { id: 'all', label: 'All types' },
  { id: 'notes', label: 'Notes' },
  { id: 'past-paper', label: 'KNEC Past Papers' },
  { id: 'marking-scheme', label: 'Marking Schemes' },
  { id: 'mock', label: 'Mocks & Joint Exams' },
  { id: 'prediction', label: 'Prediction Papers' },
  { id: 'exam', label: 'Termly Exams' },
  { id: 'topic-test', label: 'Topical Questions' },
  { id: 'revision', label: 'Revision Booklets' },
  { id: 'setbook-guide', label: 'Setbook Guides' },
  { id: 'assignment', label: 'Holiday Assignments' },
  // Teacher professional documents
  { id: 'scheme', label: 'Schemes of Work' },
  { id: 'lesson-plan', label: 'Lesson Plans' },
  { id: 'record-of-work', label: 'Records of Work' },
  { id: 'curriculum-design', label: 'KICD Curriculum Designs' },
  { id: 'teacher-guide', label: 'Teacher Guides' },
  { id: 'assessment', label: 'Assessment Rubrics / CBAs' },
  { id: 'tpad', label: 'TPAD Tools' },
  { id: 'worksheet', label: 'Worksheets' },
  { id: 'activity', label: 'Learning Activities' },
  { id: 'quiz', label: 'Quizzes' },
  { id: 'video', label: 'Video Lessons' }
];

// Subjects / learning areas offered as a first-class browse axis (chips + rail).
// Kept in the same spelling the dataset uses so exact-match filtering works.
export const BROWSE_SUBJECTS = [
  'Mathematics', 'English', 'Kiswahili', 'Biology', 'Chemistry', 'Physics',
  'Integrated Science', 'Agriculture', 'Geography', 'History', 'Business Studies',
  'Computer Studies', 'CRE'
];

// Lane 1 — KCSE & CBC exam workflow (learners, candidates, parents).
export const EXAM_HUB = [
  { label: 'KNEC Past Papers', type: 'past-paper', level: 'secondary-844', tag: '1996 - 2026' },
  { label: 'Marking Schemes', type: 'marking-scheme', level: 'secondary-844', tag: 'Paired with papers' },
  { label: 'Mocks & Joint Exams', type: 'mock', level: 'secondary-844', tag: 'By county & year' },
  { label: 'Prediction Papers', type: 'prediction', level: 'secondary-844', tag: 'Per exam season' },
  { label: 'Topical Questions', type: 'topic-test', level: 'secondary-844', tag: 'Per topic' },
  { label: 'Revision Booklets', type: 'revision', level: 'secondary-844', tag: 'Topical' },
  { label: 'Setbook Guides', type: 'setbook-guide', level: 'secondary-844', tag: 'Eng & Kisw' },
  { label: 'KNEC / KCSE Reports', type: 'all', level: 'secondary-844', query: 'KCSE report', tag: 'Examiner reports' }
];

// Lane 2 — Teacher professional documents (the staffroom toolkit).
export const TEACHER_DOCS = [
  { label: 'Schemes of Work', type: 'scheme', level: 'all', audience: 'teacher', tag: 'All terms' },
  { label: 'Lesson Plans', type: 'lesson-plan', level: 'all', audience: 'teacher', tag: 'Ready to use' },
  { label: 'Lesson Notes', type: 'notes', level: 'all', audience: 'teacher', tag: 'Teaching notes' },
  { label: 'Records of Work', type: 'record-of-work', level: 'all', audience: 'teacher', tag: 'Coverage' },
  { label: 'KICD Curriculum Designs', type: 'curriculum-design', level: 'all', audience: 'teacher', tag: 'KICD' },
  { label: 'Assessment Rubrics / CBAs', type: 'assessment', level: 'all', audience: 'teacher', tag: 'CBC' },
  { label: 'Teacher Guides', type: 'teacher-guide', level: 'all', audience: 'teacher', tag: 'Per subject' },
  { label: 'TPAD Tools', type: 'tpad', level: 'all', audience: 'teacher', tag: 'TSC appraisal' }
];

export const SUBJECTS = [
  'Mathematics',
  'English',
  'Kiswahili',
  'Science',
  'Integrated Science',
  'Agriculture',
  'Social Studies',
  'Creative Arts',
  'Biology',
  'Chemistry',
  'Physics',
  'Geography',
  'History',
  'Business Studies',
  'Computer Studies',
  'Computer Science',
  'CRE',
  'IRE',
  'Life Skills'
];

// Homepage layout - level-grouped sections, each listing its KCSE categories.
// Each category drills into the filtered results view (level + type [+ audience]).
// `tag` is a descriptive quantity/range label in the kcseonline style.
export const HOME_SECTIONS = [
  {
    id: 'kcse',
    title: 'KCSE - Form 1 to 4',
    subtitle: '8-4-4 secondary (Form 1-4)',
    level: 'secondary-844',
    categories: [
      { label: 'Subject Notes', type: 'notes', tag: 'All subjects' },
      { label: 'KNEC Past Papers', type: 'past-paper', tag: '1996 - 2026' },
      { label: 'Marking Schemes', type: 'marking-scheme', tag: 'Paired' },
      { label: 'Mocks & Joint Exams', type: 'mock', tag: 'By county & year' },
      { label: 'Termly Exams', type: 'exam', tag: 'Opener-Endterm' },
      { label: 'Topical Questions', type: 'topic-test', tag: 'Per topic' },
      { label: 'Setbook Guides', type: 'setbook-guide', tag: 'Eng & Kisw' },
      { label: 'Holiday Assignments', type: 'assignment', tag: 'Every term' }
    ]
  },
  {
    id: 'grade-10',
    title: 'Senior School - Grade 10 to 12',
    subtitle: 'CBC Senior School (STEM, Social Sciences, Arts & Sports)',
    level: 'senior-secondary',
    categories: [
      { label: 'Learning Notes', type: 'notes', tag: 'All pathways' },
      { label: 'End-Term Exams', type: 'exam', tag: 'Term 1 - 3' },
      { label: 'Topical Questions', type: 'topic-test', tag: 'Per strand' },
      { label: 'Revision Materials', type: 'revision', tag: 'Topical' },
      { label: 'Assessment Rubrics / CBAs', type: 'assessment', tag: 'CBC' }
    ]
  },
  {
    id: 'grade-1-9',
    title: 'Primary & Junior School - Grade 1 to 9',
    subtitle: 'CBC Primary (1-6) and Junior School (7-9)',
    level: 'grade-1-9',
    categories: [
      { label: 'Learning Notes', type: 'notes', tag: 'All learning areas' },
      { label: 'End-Term Exams', type: 'exam', tag: 'Term 1 - 3' },
      { label: 'Revision Papers', type: 'revision', tag: 'Topical' },
      { label: 'Worksheets', type: 'worksheet', tag: 'Printable' },
      { label: 'Assessment Rubrics / CBAs', type: 'assessment', tag: 'CBC' },
      { label: 'Learning Activities', type: 'activity', tag: 'Practical' }
    ]
  },
  {
    id: 'pre-primary',
    title: 'Pre-Primary - PP1 & PP2',
    subtitle: 'Early Years Education',
    level: 'pre-primary',
    categories: [
      { label: 'Learning Activities', type: 'activity', tag: 'Play-based' },
      { label: 'Worksheets', type: 'worksheet', tag: 'Printable' },
      { label: 'Assessment Rubrics / CBAs', type: 'assessment', tag: 'Observation' }
    ]
  }
];

export const FAQS = [
  {
    q: 'Are the resources free to access?',
    a: 'Yes. Browsing, searching, and opening public learning resources is free and needs no account. Saving items is stored on your device. School login is separate, for school records and dashboards.'
  },
  {
    q: 'Do past papers come with marking schemes?',
    a: 'Where available, marking schemes are paired with their papers. We are still adding schemes - if one is missing you can request it, or share yours through "Share Resources".'
  },
  {
    q: 'Do you have CBC and 8-4-4 materials?',
    a: 'Both. You will find CBC materials for Pre-Primary, Primary, Junior School and Senior School (Grade 10-12), plus KCSE (8-4-4) past papers, mocks and revision for Form 1-4.'
  },
  {
    q: 'What is here for teachers?',
    a: 'Professional documents: schemes of work, lesson plans, records of work, KICD curriculum designs, CBC assessment rubrics, teacher guides and TPAD tools - browsable by subject and class.'
  }
];
