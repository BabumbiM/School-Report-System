/**
 * dataStore.js
 * ------------
 * All "database" logic. There is no real database - everything lives in memory
 * while the server runs and is mirrored to three small JSON files in /data so a
 * restart mid-term doesn't lose work:
 *
 *   roster.json  classes, students and who teaches what (from the Excel import)
 *   marks.json   Paper 1-3 marks (+ optional comment overrides) per student/subject/term
 *   staff.json   headmaster, heads of department and matrons (managed in the app)
 *
 * The importer reads the school's workbook layout:
 *   "Registration 1A" ...  registration teacher, class, students, subjects + subject teachers
 *   "Assessments 1A" ...   Term 1 / Term 2 / Term 3 marks (Paper 1-3) for each student & subject
 * Everything else in the workbook (Students Avg, Top 10, Class Avg, Teachers Performance,
 * per-teacher sheets, Boarders, Day Scholars) is *derived* data - the app recomputes it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const A = require('./analytics');

const DATA_DIR = process.env.SCHOOL_DATA_DIR || path.join(__dirname, 'data');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const MARKS_FILE = path.join(DATA_DIR, 'marks.json');
const STAFF_FILE = path.join(DATA_DIR, 'staff.json');

// ---- state ----
let roster = emptyRoster();
let marks = {}; // { "STU001||English": { teacher, terms: { 1: { papers:[n|null x3], comment }, ... } } }
let staff = null;

function emptyRoster() {
  return { classes: {}, students: [], assignments: [], importedAt: null };
}

const DEFAULT_DEPARTMENTS = [
  { name: 'Languages', subjects: ['English', 'Setswana'] },
  { name: 'Mathematics & Science', subjects: ['Mathematics', 'Science'] },
  { name: 'Humanities', subjects: ['Social Studies', 'Moral Education', 'Religious Education'] },
  {
    name: 'Practical & Business Studies',
    subjects: ['Agriculture', 'Home Economics', 'Commerce (Accounting)', 'Commerce (Office Procedures)', 'Physical Education'],
  },
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    console.warn(`Could not read ${path.basename(file)}, starting fresh:`, e.message);
  }
  return fallback;
}

function load() {
  ensureDataDir();
  const r = readJson(ROSTER_FILE, null);
  roster = r && Array.isArray(r.students) && Array.isArray(r.assignments) && r.classes ? r : emptyRoster();
  marks = readJson(MARKS_FILE, {}) || {};
  staff = readJson(STAFF_FILE, null);
  reconcileStaff();
}

function persist() {
  ensureDataDir();
  fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster));
  fs.writeFileSync(MARKS_FILE, JSON.stringify(marks));
  fs.writeFileSync(STAFF_FILE, JSON.stringify(staff, null, 2));
}

/** Read-only view the analytics functions work from. */
function snapshot() {
  return { classes: roster.classes, students: roster.students, assignments: roster.assignments, marks };
}

function hasData() {
  return roster.assignments.length > 0;
}

// ------------------------------------------------------------- Excel import

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (v) => clean(v).toLowerCase().replace(/\s+/g, ' ');

function findCol(header, names) {
  for (let i = 0; i < header.length; i++) if (names.includes(norm(header[i]))) return i;
  return -1;
}

function normaliseStatus(v) {
  return /board/i.test(clean(v)) ? 'Boarder' : 'Day Scholar';
}

/** Parse one "Registration 1A" sheet (rows = array of arrays). */
function parseRegistration(rows, sheetClass) {
  let regTeacher = '';
  let className = sheetClass;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const first = norm(rows[i][0]);
    if (first.startsWith('registration teacher')) {
      regTeacher = clean(rows[i].slice(1).find((c) => clean(c)));
    } else if (/^class\b/.test(first)) {
      const v = clean(rows[i][0]).replace(/^class\s*:?\s*/i, '') || clean(rows[i][1]);
      if (v) className = v.toUpperCase();
    } else if (first === 'student id') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('no "Student ID" header row found');
  const h = rows[headerIdx];
  const col = {
    id: findCol(h, ['student id', 'id']),
    name: findCol(h, ['student name', 'name']),
    status: findCol(h, ['school status', 'status']),
    subject: findCol(h, ['subject']),
    teacher: findCol(h, ['subject teacher', 'teacher']),
  };
  for (const [k, v] of Object.entries(col)) if (v < 0) throw new Error(`missing "${k}" column`);

  const students = [];
  const assignments = [];
  let cur = null;
  // Student ID / Name / Status are merged down the student's subject rows,
  // so only the first row of each block has them - carry them forward.
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const id = clean(r[col.id]);
    if (id) {
      cur = { id, name: clean(r[col.name]), class: className, status: normaliseStatus(r[col.status]) };
      students.push(cur);
    }
    const subject = clean(r[col.subject]);
    const teacher = clean(r[col.teacher]);
    if (cur && subject && teacher) assignments.push({ studentId: cur.id, subject, teacher });
  }
  return { className, regTeacher, students, assignments };
}

/** Parse one "Assessments 1A" sheet: finds the Term groups from the header rows. */
function parseAssessment(rows, sheetClass) {
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if (norm(rows[i][0]) === 'student id') {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('no "Student ID" header row found');
  const h = rows[headerIdx];
  const sub = rows[headerIdx + 1] || [];
  const col = {
    id: findCol(h, ['student id', 'id']),
    name: findCol(h, ['student name', 'name']),
    class: findCol(h, ['class']),
    status: findCol(h, ['school status', 'status']),
    subject: findCol(h, ['subject']),
    teacher: findCol(h, ['teacher', 'subject teacher']),
  };
  for (const k of ['id', 'name', 'subject', 'teacher']) if (col[k] < 0) throw new Error(`missing "${k}" column`);

  // "Term 1" / "Term 2" / "Term 3 / Final Exam" sit on the first column of each term group;
  // the Paper 1-3 columns are the "Paper n" cells beneath it.
  const termCols = {};
  for (let c = 0; c < h.length; c++) {
    const m = norm(h[c]).match(/^term\s*(\d)/);
    if (!m) continue;
    const papers = [];
    for (let k = c; k < Math.min(h.length, c + 12) && papers.length < A.PAPERS; k++) {
      if (k > c && /^term/.test(norm(h[k]))) break;
      if (/^paper\s*\d/.test(norm(sub[k]))) papers.push(k);
    }
    termCols[Number(m[1])] = papers;
  }
  if (!Object.keys(termCols).length) throw new Error('no "Term 1/2/3" columns found');

  const entries = [];
  let cur = null;
  for (let i = headerIdx + 2; i < rows.length; i++) {
    const r = rows[i];
    const id = clean(r[col.id]);
    if (id) {
      cur = {
        id,
        name: clean(r[col.name]),
        class: col.class >= 0 && clean(r[col.class]) ? clean(r[col.class]).toUpperCase() : sheetClass,
        status: col.status >= 0 ? normaliseStatus(r[col.status]) : 'Day Scholar',
      };
    }
    const subject = clean(r[col.subject]);
    const teacher = clean(r[col.teacher]);
    if (!cur || !subject) continue;
    const terms = {};
    for (const [t, cols] of Object.entries(termCols)) {
      terms[t] = cols.map((c) => r[c]);
    }
    entries.push({ student: cur, subject, teacher, terms });
  }
  return entries;
}

function readSheetRows(XLSX, sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true, blankrows: true });
}

function importFromExcel(filePath) {
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(filePath);
  const sheets = {};
  for (const name of wb.SheetNames) sheets[name] = readSheetRows(XLSX, wb.Sheets[name]);
  return importFromSheets(sheets);
}

/**
 * Core importer, working on { sheetName: arrayOfRows }. Separate from the file
 * reading so it can be tested without Excel.
 */
function importFromSheets(sheets) {
  const regSheets = [];
  const assessSheets = [];
  for (const name of Object.keys(sheets)) {
    let m = name.trim().match(/^registration\s+(.+)$/i);
    if (m) regSheets.push({ name, cls: m[1].trim().toUpperCase() });
    m = name.trim().match(/^assessments?\s+(.+)$/i);
    if (m) assessSheets.push({ name, cls: m[1].trim().toUpperCase() });
  }
  if (!regSheets.length && !assessSheets.length) {
    throw new Error(
      'No class sheets found. The workbook needs sheets named like "Registration 1A" (students, subjects and subject teachers) and "Assessments 1A" (marks).'
    );
  }

  const warnings = [];
  const warn = (msg) => warnings.push(msg);

  const classes = {};
  const students = new Map(); // id -> student
  const assignments = new Map(); // key -> assignment
  const fileMarks = {}; // key -> { 1: [..], 2: [..], 3: [..] }
  const ignoredMarks = [];

  for (const s of regSheets) {
    let parsed;
    try {
      parsed = parseRegistration(sheets[s.name], s.cls);
    } catch (e) {
      throw new Error(`Sheet "${s.name}": ${e.message}.`);
    }
    classes[parsed.className] = { name: parsed.className, regTeacher: parsed.regTeacher };
    if (!parsed.regTeacher) warn(`Class ${parsed.className} has no registration teacher on its Registration sheet.`);
    for (const st of parsed.students) {
      if (students.has(st.id)) warn(`Student ${st.id} appears more than once (kept the first, in class ${students.get(st.id).class}).`);
      else students.set(st.id, st);
    }
    for (const a of parsed.assignments) {
      const k = A.key(a.studentId, a.subject);
      if (assignments.has(k)) warn(`${a.studentId} has ${a.subject} listed twice; kept the last teacher.`);
      assignments.set(k, a);
    }
  }

  for (const s of assessSheets) {
    let entries;
    try {
      entries = parseAssessment(sheets[s.name], s.cls);
    } catch (e) {
      throw new Error(`Sheet "${s.name}": ${e.message}.`);
    }
    for (const e of entries) {
      const st = e.student;
      if (!classes[st.class]) classes[st.class] = { name: st.class, regTeacher: '' };
      if (!students.has(st.id)) {
        students.set(st.id, st);
        warn(`${st.id} ${st.name} is on an Assessments sheet but not on a Registration sheet; added from the Assessments sheet.`);
      } else if (students.get(st.id).class !== st.class) {
        warn(`${st.id} ${st.name} is in class ${students.get(st.id).class} on Registration but ${st.class} on Assessments; using Registration.`);
      }
      const k = A.key(st.id, e.subject);
      if (!assignments.has(k)) {
        if (!e.teacher) continue;
        assignments.set(k, { studentId: st.id, subject: e.subject, teacher: e.teacher });
        warn(`${st.id} ${e.subject} is on an Assessments sheet but not on Registration; added with teacher ${e.teacher}.`);
      } else if (e.teacher && assignments.get(k).teacher !== e.teacher) {
        warn(`${st.id} ${e.subject}: teacher is ${assignments.get(k).teacher} on Registration but ${e.teacher} on Assessments; using Registration.`);
      }
      const perTerm = {};
      for (const [t, vals] of Object.entries(e.terms)) {
        perTerm[t] = vals.map((v) => {
          if (v === null || v === undefined || clean(v) === '') return null;
          const n = Number(v);
          if (!Number.isFinite(n) || n < 0 || n > 100) {
            ignoredMarks.push(`${st.id} ${e.subject} Term ${t}: "${v}"`);
            return null;
          }
          return n;
        });
      }
      fileMarks[k] = perTerm;
    }
  }
  if (ignoredMarks.length) {
    warn(`Ignored ${ignoredMarks.length} mark(s) that were not numbers between 0 and 100 (e.g. ${ignoredMarks.slice(0, 3).join('; ')}).`);
  }

  const newStudents = [...students.values()];
  const newAssignments = [...assignments.values()].filter((a) => students.has(a.studentId));
  if (!newAssignments.length) {
    throw new Error('No student/subject/teacher rows found. Check the Registration sheets have Student ID, Subject and Subject Teacher columns.');
  }
  newStudents.sort(A.byClassThenName);

  // Students in a class share the same subject teacher. If the workbook lists two teachers for the
  // same subject in one class, keep the one who teaches most of the class and say so.
  {
    const classOf = Object.fromEntries(newStudents.map((st) => [st.id, st.class]));
    const groups = {};
    for (const a of newAssignments) (groups[`${classOf[a.studentId]}||${a.subject}`] = groups[`${classOf[a.studentId]}||${a.subject}`] || []).push(a);
    for (const [k, list] of Object.entries(groups)) {
      const counts = {};
      for (const a of list) counts[a.teacher] = (counts[a.teacher] || 0) + 1;
      const teachers = Object.keys(counts);
      if (teachers.length < 2) continue;
      const keep = teachers.sort((x, y) => counts[y] - counts[x])[0];
      const [cls, subject] = k.split('||');
      warn(`Class ${cls} has more than one ${subject} teacher (${Object.keys(counts).join(', ')}); students in a class share a subject teacher, so ${keep} was used for the whole class.`);
      for (const a of list) a.teacher = keep;
    }
  }

  // Rebuild marks. Marks in the file win; blank cells keep what's already in the
  // app (as long as the same teacher still teaches that student/subject).
  const newMarks = {};
  let marksLoaded = 0;
  for (const a of newAssignments) {
    const k = A.key(a.studentId, a.subject);
    const existing = marks[k] && marks[k].teacher === a.teacher ? marks[k] : null;
    const fromFile = fileMarks[k] || {};
    const entry = { teacher: a.teacher, terms: {} };
    let any = false;
    for (const t of A.TERMS) {
      const papers = [];
      for (let i = 0; i < A.PAPERS; i++) {
        const f = fromFile[t] ? fromFile[t][i] : null;
        const e = existing && existing.terms[t] && existing.terms[t].papers ? existing.terms[t].papers[i] : null;
        const v = f !== null && f !== undefined ? f : e !== undefined ? e : null;
        papers.push(v);
        if (v !== null) {
          any = true;
          if (f !== null && f !== undefined) marksLoaded++;
        }
      }
      const comment = existing && existing.terms[t] ? existing.terms[t].comment || '' : '';
      if (papers.some((p) => p !== null) || comment) entry.terms[t] = { papers, comment };
    }
    if (any || Object.keys(entry.terms).length) newMarks[k] = entry;
  }

  roster = {
    classes,
    students: newStudents,
    assignments: newAssignments,
    importedAt: new Date().toISOString(),
  };
  marks = newMarks;
  reconcileStaff();
  persist();

  return {
    students: newStudents.length,
    classes: Object.keys(classes).sort(),
    teachers: getTeachers(),
    assignments: newAssignments.length,
    marksLoaded,
    warnings,
    ignoredSheets: Object.keys(sheets).filter(
      (n) => !regSheets.some((s) => s.name === n) && !assessSheets.some((s) => s.name === n)
    ),
  };
}

// ------------------------------------------------------------------ marks

function setMarks({ teacher, studentId, subject, term, papers, comment }) {
  const a = roster.assignments.find((x) => x.studentId === studentId && x.subject === subject && x.teacher === teacher);
  if (!a) throw new Error('You are not assigned to teach that student/subject.');
  if (!A.TERMS.includes(term)) throw new Error('Unknown term.');
  const k = A.key(studentId, subject);
  if (!marks[k]) marks[k] = { teacher, terms: {} };
  marks[k].teacher = teacher;
  if (!marks[k].terms[term]) marks[k].terms[term] = { papers: [null, null, null], comment: '' };
  const t = marks[k].terms[term];

  if (papers !== undefined) {
    if (!Array.isArray(papers) || papers.length > A.PAPERS) throw new Error(`Provide up to ${A.PAPERS} paper marks.`);
    const clean3 = [];
    for (let i = 0; i < A.PAPERS; i++) {
      const v = papers[i];
      if (v === undefined || v === null || String(v).trim() === '') {
        clean3.push(null);
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`Paper ${i + 1}: enter a mark between 0 and 100.`);
      clean3.push(n);
    }
    t.papers = clean3;
  }
  if (comment !== undefined) t.comment = String(comment).trim().slice(0, 300);
  persist();
  return A.termResult(marks[k], term, subject);
}

// ---------------------------------------------------------- staff & roles

function getTeachers() {
  const set = new Set(roster.assignments.map((a) => a.teacher));
  for (const c of Object.values(roster.classes)) if (c.regTeacher) set.add(c.regTeacher);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function subjectsPresent() {
  return A.subjectOrder({ assignments: roster.assignments });
}

function teachersOfSubjects(subjects) {
  return [...new Set(roster.assignments.filter((a) => subjects.includes(a.subject)).map((a) => a.teacher))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * Keeps staff.json consistent with the roster: every subject belongs to a
 * department, every department has a head (defaulting to a teacher of that
 * department - change it in "Staff & roles"), and the headmaster / matron
 * accounts exist.
 */
function reconcileStaff() {
  if (!staff || typeof staff !== 'object') {
    staff = { headmaster: 'Headmaster', matrons: ['Matron'], departments: DEFAULT_DEPARTMENTS.map((d) => ({ ...d, hod: null })) };
  }
  if (!staff.headmaster) staff.headmaster = 'Headmaster';
  if (!Array.isArray(staff.matrons)) staff.matrons = ['Matron'];
  if (!Array.isArray(staff.departments)) staff.departments = DEFAULT_DEPARTMENTS.map((d) => ({ ...d, hod: null }));

  if (!hasData()) return;
  const present = subjectsPresent();
  const covered = new Set(staff.departments.flatMap((d) => d.subjects));
  const orphans = present.filter((s) => !covered.has(s));
  if (orphans.length) {
    let other = staff.departments.find((d) => d.name === 'Other Subjects');
    if (!other) staff.departments.push((other = { name: 'Other Subjects', subjects: [], hod: null }));
    other.subjects.push(...orphans);
  }
  const teachers = getTeachers();
  for (const d of staff.departments) {
    const active = d.subjects.filter((s) => present.includes(s));
    if (!active.length) continue;
    if (!d.hod || !teachers.includes(d.hod)) d.hod = teachersOfSubjects(active)[0] || null;
  }
}

/** Departments that actually have subjects in the current roster. */
function getDepartments() {
  const present = subjectsPresent();
  return staff.departments
    .map((d) => ({ name: d.name, subjects: d.subjects.filter((s) => present.includes(s)), hod: d.hod }))
    .filter((d) => d.subjects.length);
}

function getStaffConfig() {
  return {
    headmaster: staff.headmaster,
    matrons: [...staff.matrons],
    departments: getDepartments(),
    teachers: getTeachers(),
  };
}

function setStaffConfig({ headmaster, matrons, hods }) {
  const teachers = getTeachers();
  if (headmaster !== undefined) {
    const h = clean(headmaster);
    if (!h) throw new Error('The headmaster needs a name.');
    staff.headmaster = h;
  }
  if (matrons !== undefined) {
    if (!Array.isArray(matrons)) throw new Error('matrons must be a list of names.');
    staff.matrons = [...new Set(matrons.map(clean).filter(Boolean))];
  }
  if (hods !== undefined) {
    for (const [dept, person] of Object.entries(hods || {})) {
      const d = staff.departments.find((x) => x.name === dept);
      if (!d) throw new Error(`Unknown department "${dept}".`);
      if (person && !teachers.includes(person)) throw new Error(`${person} is not a teacher in the imported roster.`);
      d.hod = person || null;
    }
  }
  reconcileStaff();
  persist();
  return getStaffConfig();
}

/**
 * Everything a signed-in person is allowed to do, derived from the data:
 *   headmaster          - the name in staff.json
 *   head of department  - named as a department's head
 *   matron              - listed in staff.json
 *   registration teacher- named on a Registration sheet (their class)
 *   subject teacher     - has at least one subject assignment
 */
function getProfile(name) {
  const n = clean(name);
  if (!n) return null;
  const isHeadmaster = n === staff.headmaster;
  const isMatron = staff.matrons.includes(n);
  const departments = getDepartments().filter((d) => d.hod === n).map((d) => d.name);
  const classes = Object.values(roster.classes).filter((c) => c.regTeacher === n).map((c) => c.name).sort();
  const subjectsTaught = [...new Set(roster.assignments.filter((a) => a.teacher === n).map((a) => a.subject))];
  const teaches = subjectsTaught.length > 0;
  if (!isHeadmaster && !isMatron && !departments.length && !classes.length && !teaches) return null;

  const roles = [];
  const labels = [];
  if (isHeadmaster) { roles.push('headmaster'); labels.push('Headmaster'); }
  if (departments.length) { roles.push('hod'); labels.push(`Senior Teacher ${departments.join(' & ')}`); }
  if (isMatron) { roles.push('matron'); labels.push('Matron'); }
  if (classes.length) { roles.push('class_teacher'); labels.push(`Registration teacher ${classes.join(', ')}`); }
  if (teaches) { roles.push('teacher'); labels.push(`${subjectsTaught.join(', ')} teacher`); }
  return { name: n, roles, labels, isHeadmaster, isMatron, departments, classes, teaches, subjectsTaught };
}

function listStaff() {
  const names = new Set([staff.headmaster, ...staff.matrons, ...getTeachers()]);
  const people = [...names].map(getProfile).filter(Boolean);
  const rank = (p) => (p.isHeadmaster ? 0 : p.isMatron ? 1 : p.departments.length ? 2 : 3);
  return people
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map((p) => ({ name: p.name, roles: p.roles, labels: p.labels }));
}


// ------------------------------------------------------ registering students

/**
 * Subjects offered at the school and, for the given class, who teaches each one.
 * Students in a class share a subject teacher, so where the class already has a teacher for a
 * subject it is fixed (classTeacher). Only a subject nobody in the class takes yet lets you choose
 * from the teachers who teach it elsewhere in the school.
 */
function getRegistrationInfo(className) {
  const subjects = subjectsPresent();
  const studentById = Object.fromEntries(roster.students.map((s) => [s.id, s]));
  return subjects.map((subject) => {
    const all = roster.assignments.filter((a) => a.subject === subject);
    const inClass = all.find((a) => studentById[a.studentId] && studentById[a.studentId].class === className);
    return {
      subject,
      teachers: [...new Set(all.map((a) => a.teacher))].sort((a, b) => a.localeCompare(b)),
      classTeacher: inClass ? inClass.teacher : null,
    };
  });
}

function nextStudentId() {
  let best = null;
  for (const s of roster.students) {
    const m = String(s.id).match(/^(\D*)(\d+)$/);
    if (m && (!best || Number(m[2]) > best.n)) best = { prefix: m[1], n: Number(m[2]), width: m[2].length };
  }
  if (!best) return 'STU001';
  return best.prefix + String(best.n + 1).padStart(best.width, '0');
}

/**
 * Adds a student to a class with their subjects and subject teachers.
 * subjects = [{ subject, teacher }]. The subject must already be offered at
 * the school and the teacher must already teach it.
 */
function addStudent({ name, className, status, subjects }) {
  const n = clean(name).replace(/\s+/g, ' ');
  if (!n) throw new Error('Enter the student\'s full name.');
  if (!roster.classes[className]) throw new Error('Unknown class.');
  if (!['Boarder', 'Day Scholar'].includes(status)) throw new Error('Choose Boarder or Day Scholar.');
  if (roster.students.some((s) => s.class === className && s.name.toLowerCase() === n.toLowerCase())) {
    throw new Error(`${n} is already registered in class ${className}.`);
  }
  if (!Array.isArray(subjects) || !subjects.length) throw new Error('Choose at least one subject.');
  const offered = getRegistrationInfo(className);
  const compulsory = [...A.CORE_SUBJECTS, ...A.BEST_TWO_OF].filter((c) => offered.some((o) => o.subject === c));
  const picked = new Set(subjects.map((x) => x.subject));
  const missing = compulsory.filter((c) => !picked.has(c));
  if (missing.length) throw new Error(`Every student takes ${missing.join(', ')}.`);
  if (![...picked].some((x) => !compulsory.includes(x))) throw new Error('Choose at least one optional subject.');
  const chosen = new Map();
  for (const x of subjects) {
    const info = offered.find((o) => o.subject === x.subject);
    if (!info) throw new Error(`"${x.subject}" is not a subject offered at the school.`);
    if (info.classTeacher) {
      if (x.teacher && x.teacher !== info.classTeacher) {
        throw new Error(`Students in ${className} are taught ${x.subject} by ${info.classTeacher}.`);
      }
      chosen.set(x.subject, info.classTeacher);
      continue;
    }
    if (!info.teachers.includes(x.teacher)) throw new Error(`Choose a teacher for ${x.subject}.`);
    chosen.set(x.subject, x.teacher);
  }
  const id = nextStudentId();
  const student = { id, name: n, class: className, status };
  roster.students.push(student);
  roster.students.sort(A.byClassThenName);
  for (const [subject, teacher] of chosen) roster.assignments.push({ studentId: id, subject, teacher });
  persist();
  return student;
}

// -------------------------------------------------------------- gradebook

/** A subject teacher's own students only, with all three terms. */
function getTeacherGradebook(teacher) {
  const studentById = Object.fromEntries(roster.students.map((s) => [s.id, s]));
  return roster.assignments
    .filter((a) => a.teacher === teacher)
    .map((a) => {
      const s = studentById[a.studentId];
      const terms = {};
      for (const t of A.TERMS) {
        const r = A.termResult(marks[A.key(a.studentId, a.subject)], t, a.subject);
        terms[t] = { papers: r.papers, average: r.average, percentage: r.percentage, grade: r.grade, comment: marks[A.key(a.studentId, a.subject)] && marks[A.key(a.studentId, a.subject)].terms[t] ? marks[A.key(a.studentId, a.subject)].terms[t].comment || '' : '', autoComment: r.autoComment };
      }
      return { studentId: s.id, name: s.name, class: s.class, status: s.status, subject: a.subject, terms };
    })
    .sort((a, b) => A.byClassThenName(a, b) || a.subject.localeCompare(b.subject));
}

function getRoster() {
  return roster;
}

module.exports = {
  load,
  importFromExcel,
  importFromSheets,
  parseRegistration,
  parseAssessment,
  snapshot,
  hasData,
  getRoster,
  getTeachers,
  setMarks,
  getTeacherGradebook,
  getRegistrationInfo,
  addStudent,
  getStaffConfig,
  setStaffConfig,
  getDepartments,
  getProfile,
  listStaff,
};
