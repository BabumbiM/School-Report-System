/**
 * api.js
 * ------
 * Every data operation the app exposes, with the role rules enforced here
 * (not in the browser). server.js is only a thin Express wrapper around this.
 *
 *   Headmaster ........ whole school: class averages, top 10s, top achievers, bottom students,
 *                       teacher performance, the master student table, report cards, staff & roles, export
 *   Head of department  their department's teachers and the students who take its subjects
 *   Subject teacher ... only the students they teach, and only they can enter marks for them
 *   Registration teacher their own class's performance and report cards
 *   Matron ............ boarding students' performance
 *
 * A person can hold several roles at once (e.g. a registration teacher who also teaches English).
 */
'use strict';

const store = require('./dataStore');
const A = require('./analytics');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const forbidden = (msg = 'Your role does not allow this.') => new HttpError(403, msg);

function parseTerm(raw) {
  if (raw === undefined || raw === null || raw === '') return A.DEFAULT_TERM;
  const t = Number(raw);
  if (!A.TERMS.includes(t)) throw new HttpError(400, 'term must be 1, 2 or 3.');
  return t;
}

function requireData() {
  if (!store.hasData()) throw new HttpError(409, 'No roster imported yet.');
}

function can(user, role) {
  return user.roles.includes(role);
}

// ------------------------------------------------------------------ session

function me(user) {
  return {
    name: user.name,
    roles: user.roles,
    labels: user.labels,
    classes: user.classes,
    departments: user.departments,
    teaches: user.teaches,
    subjectsTaught: user.subjectsTaught,
    terms: A.TERM_LABELS,
    defaultTerm: A.DEFAULT_TERM,
  };
}

// --------------------------------------------------------------- headmaster

function overview(user, rawTerm) {
  if (!can(user, 'headmaster')) throw forbidden('Only the headmaster can view whole-school performance.');
  requireData();
  return A.schoolOverview(store.snapshot(), parseTerm(rawTerm));
}

function master(user, rawTerm) {
  if (!can(user, 'headmaster')) throw forbidden('Only the headmaster can view the master table.');
  requireData();
  return A.masterTable(store.snapshot(), parseTerm(rawTerm));
}

function getStaff(user) {
  if (!can(user, 'headmaster')) throw forbidden('Only the headmaster can manage staff roles.');
  return store.getStaffConfig();
}

/** Returns the new config, plus the signed-in person's updated name if they renamed themselves. */
function putStaff(user, body) {
  if (!can(user, 'headmaster')) throw forbidden('Only the headmaster can manage staff roles.');
  const b = body || {};
  let cfg;
  try {
    cfg = store.setStaffConfig({ headmaster: b.headmaster, matrons: b.matrons, hods: b.hods });
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  return { config: cfg, sessionName: user.isHeadmaster ? cfg.headmaster : undefined };
}

// ----------------------------------------------------- Senior teacher

function department(user, deptName, rawTerm) {
  requireData();
  const mine = store.getDepartments().filter((d) => can(user, 'headmaster') || d.hod === user.name);
  if (!mine.length) throw forbidden('You are not a senior teacher.');
  const dept = deptName ? mine.find((d) => d.name === deptName) : mine[0];
  if (!dept) throw forbidden('That is not your department.');
  const view = A.departmentView(store.snapshot(), dept, parseTerm(rawTerm));
  view.available = mine.map((d) => d.name);
  return view;
}

// -------------------------------------------------- registration (class) teacher

function classPerformance(user, className, rawTerm) {
  requireData();
  const cls = className || user.classes[0];
  if (!cls) throw forbidden('You are not a registration teacher.');
  if (!can(user, 'headmaster') && !user.classes.includes(cls)) throw forbidden('You can only view the class you register.');
  if (!store.getRoster().classes[cls]) throw new HttpError(404, 'No such class.');
  const view = A.classView(store.snapshot(), cls, parseTerm(rawTerm));
  view.available = can(user, 'headmaster') ? Object.keys(store.getRoster().classes).sort() : user.classes;
  return view;
}

// ------------------------------------------------------------------ matron

function boarders(user, rawTerm) {
  if (!can(user, 'matron') && !can(user, 'headmaster')) throw forbidden('Only matrons can view boarding students.');
  requireData();
  return A.boardersView(store.snapshot(), parseTerm(rawTerm));
}

// ---------------------------------------------------------- subject teacher

function gradebook(user) {
  if (!user.teaches) throw forbidden('You have no subject assignments.');
  requireData();
  const rows = store.getTeacherGradebook(user.name); // only this teacher's rows, by construction
  return { teacher: user.name, terms: A.TERM_LABELS, defaultTerm: A.DEFAULT_TERM, rows };
}

function saveMarks(user, body) {
  if (!user.teaches) throw forbidden('You have no subject assignments.');
  const { studentId, subject, term, papers, comment } = body || {};
  if (!studentId || !subject) throw new HttpError(400, 'studentId and subject are required.');
  let result;
  try {
    result = store.setMarks({ teacher: user.name, studentId, subject, term: parseTerm(term), papers, comment });
  } catch (e) {
    throw new HttpError(e.message.startsWith('You are not assigned') ? 403 : 400, e.message);
  }
  return { success: true, result };
}


// ---------------------------------------------------- register new students

function canRegisterIn(user, cls) {
  return can(user, 'headmaster') || user.classes.includes(cls);
}

function registerInfo(user, className) {
  if (!can(user, 'headmaster') && !user.classes.length) throw forbidden('Only registration teachers can register students.');
  requireData();
  const r = store.getRoster();
  const classes = can(user, 'headmaster') ? Object.keys(r.classes).sort() : user.classes;
  const cls = className || classes[0];
  if (!r.classes[cls]) throw new HttpError(404, 'No such class.');
  if (!canRegisterIn(user, cls)) throw forbidden('You can only register students into your own class.');
  return {
    classes,
    class: cls,
    subjects: store.getRegistrationInfo(cls),
    compulsory: [...A.CORE_SUBJECTS, ...A.BEST_TWO_OF],
    students: r.students.filter((s) => s.class === cls).map((s) => ({ id: s.id, name: s.name, status: s.status })),
  };
}

function registerStudent(user, body) {
  const b = body || {};
  if (!canRegisterIn(user, b.class)) throw forbidden('You can only register students into your own class.');
  requireData();
  try {
    return { success: true, student: store.addStudent({ name: b.name, className: b.class, status: b.status, subjects: b.subjects }) };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
}

// ------------------------------------------------------------ report cards

function canSeeStudentReport(user, student) {
  return can(user, 'headmaster') || user.classes.includes(student.class);
}

function reportStudents(user) {
  if (!can(user, 'headmaster') && !user.classes.length) throw forbidden('Report cards are for the headmaster and registration teachers.');
  requireData();
  const r = store.getRoster();
  return {
    classes: can(user, 'headmaster') ? Object.keys(r.classes).sort() : user.classes,
    students: r.students.filter((s) => canSeeStudentReport(user, s)).map((s) => ({ id: s.id, name: s.name, class: s.class })),
  };
}

// the template prints the head's name; skip the built-in placeholder account name
function headName() {
  const n = store.getStaffConfig().headmaster;
  return n && n !== 'Headmaster' ? n : '';
}

/** Student Progress Report data for one student and one term. */
function report(user, studentId, rawTerm) {
  requireData();
  const s = store.getRoster().students.find((x) => x.id === studentId);
  if (!s) throw new HttpError(404, 'No such student.');
  if (!canSeeStudentReport(user, s)) throw forbidden('You can only view report cards for your own class.');
  return A.progressReport(store.snapshot(), studentId, parseTerm(rawTerm), { headmaster: headName() });
}

function classReports(user, className, rawTerm) {
  requireData();
  if (!store.getRoster().classes[className]) throw new HttpError(404, 'No such class.');
  if (!can(user, 'headmaster') && !user.classes.includes(className)) throw forbidden('You can only view report cards for your own class.');
  const term = parseTerm(rawTerm);
  return store
    .getRoster()
    .students.filter((s) => s.class === className)
    .map((s) => A.progressReport(store.snapshot(), s.id, term, { headmaster: headName() }));
}

/** The same reports as a Word file built from the school's template (one page per student). */
async function reportsDocx(user, { student, class: className, term }) {
  const reports = student ? [report(user, student, term)] : classReports(user, className, term);
  if (!reports.length) throw new HttpError(404, 'No students to report on.');
  const buffer = await require('./reportDocx').buildReportsDocx(reports);
  const who = student ? reports[0].studentName.replace(/[^\w]+/g, '_') : `Class_${className}`;
  return { buffer, filename: `Progress_Report_${who}_Term${reports[0].term}.docx` };
}

// ------------------------------------------------------------------ export

const pct100 = (p) => (p === null || p === undefined ? '' : Math.round(p * 10000) / 100);

function exportWorkbook(user) {
  // everyone except a matron (who has no other role) can export - but only what their role lets them see
  if (!user.roles.some((r) => r !== 'matron')) throw forbidden('Matrons cannot export.');
  requireData();
  const XLSX = require('xlsx');
  const data = store.snapshot();
  const studentById = Object.fromEntries(data.students.map((s) => [s.id, s]));
  const isHead = can(user, 'headmaster');
  const deptSubjects = store.getDepartments().filter((d) => user.departments.includes(d.name)).flatMap((d) => d.subjects);

  const visible = (a) =>
    isHead ||
    (user.teaches && a.teacher === user.name) ||
    deptSubjects.includes(a.subject) ||
    (studentById[a.studentId] && user.classes.includes(studentById[a.studentId].class));

  const gradebook = data.assignments.filter(visible).map((a) => {
    const s = studentById[a.studentId];
    const row = { 'Student ID': s.id, 'Student Name': s.name, Class: s.class, 'School Status': s.status, Subject: a.subject, Teacher: a.teacher };
    for (const t of A.TERMS) {
      const r = A.termResult(data.marks[A.key(s.id, a.subject)], t, a.subject);
      const label = `T${t}`;
      row[`${label} Paper 1`] = r.papers[0] ?? '';
      row[`${label} Paper 2`] = r.papers[1] ?? '';
      row[`${label} Paper 3`] = r.papers[2] ?? '';
      row[`${label} Average Mark`] = r.average === null ? '' : Math.round(r.average * 100) / 100;
      row[`${label} %`] = pct100(r.percentage);
      row[`${label} Grade`] = r.grade;
      row[`${label} Comment`] = r.comment;
    }
    return row;
  });

  const masterRows = (filter) => {
    const m = A.masterTable(data, A.DEFAULT_TERM);
    return m.rows.filter(filter).map((r) => {
      const row = { 'Student ID': r.id, 'Student Name': r.name, Class: r.class, 'School Status': r.status };
      for (const s of m.subjects) row[s] = r.subjects[s] ? pct100(r.subjects[s].percentage) : '';
      row['Average %'] = pct100(r.average);
      row.Grade = r.grade;
      row['Class Rank'] = r.classRank ?? '';
      row['Form Rank'] = r.formRank ?? '';
      return row;
    });
  };
  const teacherRows = (detail) =>
    detail.map((d) => ({ Teacher: d.teacher, Subject: d.subject, Class: d.class, 'Assessment Entries': d.entries, 'Average %': pct100(d.average) }));

  const wb = XLSX.utils.book_new();
  const add = (rows, name) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name);
  add(gradebook, 'Gradebook');

  if (isHead) {
    const overview = A.schoolOverview(data, A.DEFAULT_TERM);
    add(masterRows(() => true), 'Master (Term 3)');
    add(
      [...overview.classAverages, overview.school].map((c) => ({
        Class: c.class,
        'Registration Teacher': c.regTeacher || '',
        'Number of Students': c.students,
        'Average %': pct100(c.average),
        'Pass Rate %': c.passRate === null ? '' : Math.round(c.passRate * 1000) / 10,
      })),
      'Class Averages'
    );
    add(teacherRows(overview.teachers.detail), 'Teacher Performance');
  } else {
    if (user.classes.length) add(masterRows((r) => user.classes.includes(r.class)), `Class ${user.classes.join('+')} (Term 3)`.slice(0, 31));
    if (deptSubjects.length) add(teacherRows(A.teacherPerformance(data, A.DEFAULT_TERM, { subjects: deptSubjects }).detail), 'Department Teachers');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = {
  HttpError,
  me,
  overview,
  master,
  getStaff,
  putStaff,
  department,
  classPerformance,
  boarders,
  gradebook,
  saveMarks,
  registerInfo,
  registerStudent,
  reportStudents,
  report,
  classReports,
  reportsDocx,
  exportWorkbook,
};
