/**
 * analytics.js
 * ------------
 * Pure functions: marks -> averages, grades, comments, rankings and the
 * school / class / teacher / student tables. No file or network access, so
 * everything here can be tested directly.
 *
 * The rules deliberately mirror the formulas in the school's workbook:
 *   - Average Mark  = mean of whichever of Paper 1-3 have been entered
 *   - Percentage    = ROUND(Average Mark / 100, 4)
 *   - Grade         = A >= 80, B >= 70, C >= 60, D >= 50, otherwise E
 *   - Points        = A 9, B 7, C 5, D 3, E 1 (see the points rule below)
 *   - Student Avg % = ROUND(mean of the student's subject percentages, 4)
 *   - Class Avg %   = ROUND(mean of the class's student averages, 4)
 *   - Teacher Avg % = ROUND(mean of that teacher's percentages in a class, 4)
 */
'use strict';

const TERMS = [1, 2, 3];
const TERM_LABELS = { 1: 'Term 1', 2: 'Term 2', 3: 'Term 3 / Final Exam' };
const DEFAULT_TERM = 3; // the workbook's "Students Avg" etc. are based on Term 3 / Final
const PASS_MARK = 0.5; // a percentage of 50% or more (grade D or better) is a pass
const PAPERS = 3;

// ---------------------------------------------------------------- points rule
// A student's overall score is their TOTAL POINTS:
//   points of the core subjects
// + the 2 best of (Social Studies, Agriculture, Moral Education)
// + the 1 best of the optional subjects (every other subject the student takes)
const GRADE_POINTS = { A: 9, B: 7, C: 5, D: 3, E: 1 };
const CORE_SUBJECTS = ['English', 'Setswana', 'Mathematics', 'Science'];
const BEST_TWO_OF = ['Social Studies', 'Agriculture', 'Moral Education'];
const MAX_POINTS = (CORE_SUBJECTS.length + 2 + 1) * GRADE_POINTS.A; // 63

// On the progress report, Term Mark is the average of these papers and Exam Mark is the other(s).
// (Subject grade and points still use the average of all papers, as in the school workbook.)
const TERM_MARK_PAPERS = [0, 1];
const EXAM_MARK_PAPERS = [2];

const round4 = (x) => Math.round((x + Number.EPSILON) * 1e4) / 1e4;
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- grading

function gradeFromPercentage(p) {
  if (p === null || p === undefined) return '';
  if (p >= 0.8) return 'A';
  if (p >= 0.7) return 'B';
  if (p >= 0.6) return 'C';
  if (p >= 0.5) return 'D';
  return 'E';
}

const OPENERS = {
  A: 'Excellent work in ',
  B: 'Very good work in ',
  C: 'Satisfactory work in ',
  D: 'Fair work in ',
  E: 'Below the expected level in ',
};
const CLOSERS = {
  A: '; keep it up.',
  B: '; aim higher.',
  C: '; keep practising.',
  D: '; extra practice is needed.',
  E: '; urgent support is needed.',
};
const SUBJECT_AREAS = {
  English: 'reading and writing',
  Setswana: 'reading, writing and speaking',
  Mathematics: 'problem solving',
  Science: 'concepts and practicals',
  'Social Studies': 'content knowledge',
  Agriculture: 'practical work and knowledge',
  'Moral Education': 'values and participation',
  'Religious Education': 'religious knowledge and participation',
  'Physical Education': 'fitness and participation',
  'Home Economics': 'practical skills',
  'Commerce (Accounting)': 'recording of accounts',
  'Commerce (Office Procedures)': 'office practice',
};

/** Same wording as the workbook's Comment formula (falls back gracefully for new subjects). */
function autoComment(subject, grade) {
  if (!grade) return '';
  const area = SUBJECT_AREAS[subject] || 'this subject';
  return OPENERS[grade] + area + CLOSERS[grade];
}

/**
 * Result of one subject for one term.
 * entry = { terms: { 1: { papers: [n|null x3], comment: '' }, ... } }
 */
function termResult(entry, term, subject) {
  const t = entry && entry.terms && entry.terms[term];
  const papers = [];
  for (let i = 0; i < PAPERS; i++) papers.push(toNum(t && t.papers ? t.papers[i] : null));
  const filled = papers.filter((p) => p !== null);
  const override = (t && t.comment) || '';
  if (!filled.length) {
    return { papers, average: null, percentage: null, grade: '', comment: override, autoComment: '', hasMarks: false };
  }
  const average = mean(filled);
  const percentage = round4(average / 100);
  const grade = gradeFromPercentage(percentage);
  const auto = autoComment(subject, grade);
  return { papers, average, percentage, grade, comment: override || auto, autoComment: auto, hasMarks: true };
}

// ---------------------------------------------------------------- helpers

const key = (studentId, subject) => `${studentId}||${subject}`;

function formOf(className) {
  const m = String(className).match(/^\d+/);
  return m ? m[0] : String(className);
}

function byClassThenName(a, b) {
  return String(a.class).localeCompare(String(b.class)) || String(a.name).localeCompare(String(b.name));
}

function subjectOrder(data) {
  const seen = [];
  for (const a of data.assignments) if (!seen.includes(a.subject)) seen.push(a.subject);
  return seen;
}

// students are ranked by total points; equal points are separated by average %
const rankKey = (r) => (r.points === null || r.points === undefined ? null : r.points * 10 + (r.average || 0));

function competitionRanks(rows, groupOf) {
  // rank = 1 + number of students in the same group with a strictly better score
  const groups = {};
  for (const r of rows) {
    if (rankKey(r) === null) continue;
    (groups[groupOf(r)] = groups[groupOf(r)] || []).push(rankKey(r));
  }
  return (r) => {
    if (rankKey(r) === null) return null;
    return 1 + groups[groupOf(r)].filter((x) => x > rankKey(r)).length;
  };
}

function pointsOf(grade) {
  return grade && GRADE_POINTS[grade] !== undefined ? GRADE_POINTS[grade] : null;
}

/**
 * subjects = { [subject]: { grade, percentage } }  ->  { total, counted: [subject names] }
 * total is null when the student has no marks at all.
 */
function totalPoints(subjects) {
  const have = Object.keys(subjects).filter((n) => pointsOf(subjects[n].grade) !== null);
  if (!have.length) return { total: null, counted: [] };
  const best = (names, n) =>
    names
      .sort((a, b) => pointsOf(subjects[b].grade) - pointsOf(subjects[a].grade) || subjects[b].percentage - subjects[a].percentage)
      .slice(0, n);
  const counted = [
    ...have.filter((n) => CORE_SUBJECTS.includes(n)),
    ...best(have.filter((n) => BEST_TWO_OF.includes(n)), 2),
    ...best(have.filter((n) => !CORE_SUBJECTS.includes(n) && !BEST_TWO_OF.includes(n)), 1),
  ];
  return { total: counted.reduce((sum, n) => sum + pointsOf(subjects[n].grade), 0), counted };
}

// ------------------------------------------------------- student-level rows

/**
 * One row per student for the chosen term:
 * { id, name, class, status, subjects: { [subject]: {teacher, percentage, grade, ...} },
 *   average, grade, classRank, formRank, schoolRank }
 */
function studentRows(data, term, { subjects: onlySubjects } = {}) {
  const byStudent = {};
  for (const a of data.assignments) (byStudent[a.studentId] = byStudent[a.studentId] || []).push(a);

  const rows = data.students.map((s) => {
    const subjects = {};
    const pcts = [];
    for (const a of byStudent[s.id] || []) {
      if (onlySubjects && !onlySubjects.includes(a.subject)) continue;
      const r = termResult(data.marks[key(s.id, a.subject)], term, a.subject);
      subjects[a.subject] = { teacher: a.teacher, ...r, points: pointsOf(r.grade) };
      if (r.hasMarks) pcts.push(r.percentage);
    }
    const average = pcts.length ? round4(mean(pcts)) : null;
    const tp = onlySubjects ? { total: null, counted: [] } : totalPoints(subjects);
    return {
      id: s.id,
      name: s.name,
      class: s.class,
      status: s.status,
      subjects,
      average,
      grade: gradeFromPercentage(average),
      points: tp.total,
      counted: tp.counted,
    };
  });

  const classRank = competitionRanks(rows, (r) => r.class);
  const formRank = competitionRanks(rows, (r) => formOf(r.class));
  const schoolRank = competitionRanks(rows, () => 'all');
  for (const r of rows) {
    r.classRank = classRank(r);
    r.formRank = formRank(r);
    r.schoolRank = schoolRank(r);
  }
  return rows.sort(byClassThenName);
}

function rankedStudents(rows) {
  return rows
    .filter((r) => rankKey(r) !== null)
    .sort((a, b) => rankKey(b) - rankKey(a) || String(a.id).localeCompare(String(b.id)));
}

function summarise(rows) {
  const avgs = rows.filter((r) => r.average !== null).map((r) => r.average);
  const pts = rows.filter((r) => r.points !== null && r.points !== undefined).map((r) => r.points);
  return {
    students: rows.length,
    average: avgs.length ? round4(mean(avgs)) : null,
    averagePoints: pts.length ? Math.round(mean(pts) * 10) / 10 : null,
    passRate: avgs.length ? avgs.filter((a) => a >= PASS_MARK).length / avgs.length : null,
    below50: avgs.filter((a) => a < PASS_MARK).length,
  };
}

function trim(r) {
  return { id: r.id, name: r.name, class: r.class, status: r.status, points: r.points, average: r.average, grade: r.grade };
}

// ------------------------------------------------------- school-level tables

function classAverages(data, rows) {
  const classNames = Object.keys(data.classes).sort();
  const out = classNames.map((c) => {
    const inClass = rows.filter((r) => r.class === c);
    return {
      class: c,
      regTeacher: data.classes[c].regTeacher || '',
      ...summarise(inClass),
    };
  });
  return { classes: out, school: { class: 'All Classes', ...summarise(rows) } };
}

function topPerForm(rows, n = 10) {
  const forms = [...new Set(rows.map((r) => formOf(r.class)))].sort();
  const result = {};
  for (const f of forms) {
    const ranked = rankedStudents(rows.filter((r) => formOf(r.class) === f));
    // students are ranked by total points, then average %; exact ties share a rank (1, 2, 2, 4 ...)
    result[f] = ranked
      .slice(0, n)
      .map((r) => ({ ...trim(r), rank: 1 + ranked.filter((x) => rankKey(x) > rankKey(r)).length }));
  }
  return result;
}

function bottomStudents(rows) {
  const low = rankedStudents(rows).filter((r) => r.average !== null && r.average < PASS_MARK).reverse();
  return low.map((r, i) => ({ ...trim(r), rank: i + 1 }));
}

/** Per teacher / subject / class (the workbook's "Teachers Performance" sheet). */
function teacherPerformance(data, term, { subjects: onlySubjects } = {}) {
  const studentById = {};
  for (const s of data.students) studentById[s.id] = s;
  const order = subjectOrder(data);
  const groups = new Map();
  for (const a of data.assignments) {
    if (onlySubjects && !onlySubjects.includes(a.subject)) continue;
    const s = studentById[a.studentId];
    if (!s) continue;
    const k = `${a.teacher}||${a.subject}||${s.class}`;
    if (!groups.has(k)) groups.set(k, { teacher: a.teacher, subject: a.subject, class: s.class, entries: 0, pcts: [] });
    const g = groups.get(k);
    g.entries += 1;
    const r = termResult(data.marks[key(a.studentId, a.subject)], term, a.subject);
    if (r.hasMarks) g.pcts.push(r.percentage);
  }
  const detail = [...groups.values()]
    .map((g) => {
      const average = g.pcts.length ? round4(mean(g.pcts)) : null;
      return {
        teacher: g.teacher,
        subject: g.subject,
        class: g.class,
        entries: g.entries,
        marked: g.pcts.length,
        average,
        grade: gradeFromPercentage(average),
        passRate: g.pcts.length ? g.pcts.filter((p) => p >= PASS_MARK).length / g.pcts.length : null,
        _pcts: g.pcts,
      };
    })
    .sort(
      (a, b) =>
        order.indexOf(a.subject) - order.indexOf(b.subject) ||
        String(a.class).localeCompare(String(b.class)) ||
        a.teacher.localeCompare(b.teacher)
    );

  // one line per teacher across everything they teach
  const perTeacher = new Map();
  for (const d of detail) {
    if (!perTeacher.has(d.teacher)) {
      perTeacher.set(d.teacher, { teacher: d.teacher, subjects: new Set(), classes: new Set(), entries: 0, pcts: [] });
    }
    const t = perTeacher.get(d.teacher);
    t.subjects.add(d.subject);
    t.classes.add(d.class);
    t.entries += d.entries;
    t.pcts.push(...d._pcts);
  }
  const summary = [...perTeacher.values()]
    .map((t) => {
      const average = t.pcts.length ? round4(mean(t.pcts)) : null;
      return {
        teacher: t.teacher,
        subjects: [...t.subjects],
        classes: [...t.classes].sort(),
        entries: t.entries,
        marked: t.pcts.length,
        average,
        grade: gradeFromPercentage(average),
        passRate: t.pcts.length ? t.pcts.filter((p) => p >= PASS_MARK).length / t.pcts.length : null,
      };
    })
    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || a.teacher.localeCompare(b.teacher));
  summary.forEach((t, i) => (t.rank = t.average === null ? null : i + 1));
  detail.forEach((d) => delete d._pcts);
  return { summary, detail };
}

// ------------------------------------------------------------- role views

function schoolOverview(data, term) {
  const rows = studentRows(data, term);
  const { classes, school } = classAverages(data, rows);
  const top = topPerForm(rows, 10);
  const topOnes = Object.keys(top).map((f) => ({ form: `Form ${f}`, ...(top[f][0] || {}) }));
  return {
    term,
    termLabel: TERM_LABELS[term],
    school,
    classAverages: classes,
    topTen: top,
    topOnes,
    bottom: bottomStudents(rows),
    teachers: teacherPerformance(data, term),
  };
}

function masterTable(data, term) {
  const rows = studentRows(data, term);
  return {
    term,
    termLabel: TERM_LABELS[term],
    subjects: subjectOrder(data),
    rows: rows.map((r) => ({
      id: r.id,
      name: r.name,
      class: r.class,
      status: r.status,
      subjects: Object.fromEntries(
        Object.entries(r.subjects).map(([s, v]) => [s, { percentage: v.percentage, grade: v.grade, points: v.points }])
      ),
      points: r.points,
      average: r.average,
      grade: r.grade,
      classRank: r.classRank,
      formRank: r.formRank,
      schoolRank: r.schoolRank,
    })),
  };
}

function slimSubjects(row, subjects) {
  const out = {};
  for (const s of subjects) {
    const v = row.subjects[s];
    if (v) out[s] = { teacher: v.teacher, percentage: v.percentage, grade: v.grade, points: v.points };
  }
  return out;
}

/** Head of department: the department's teachers and the students who take its subjects. */
function departmentView(data, department, term) {
  const subjects = department.subjects.filter((s) => subjectOrder(data).includes(s));
  const all = studentRows(data, term, { subjects });
  const rows = all.filter((r) => Object.keys(r.subjects).length > 0);
  const subjectAverages = subjects.map((s) => {
    const pcts = [];
    for (const r of rows) if (r.subjects[s] && r.subjects[s].hasMarks) pcts.push(r.subjects[s].percentage);
    const average = pcts.length ? round4(mean(pcts)) : null;
    return { subject: s, students: rows.filter((r) => r.subjects[s]).length, average, grade: gradeFromPercentage(average) };
  });
  return {
    term,
    termLabel: TERM_LABELS[term],
    department: department.name,
    hod: department.hod || '',
    subjects,
    stats: summarise(rows),
    subjectAverages,
    teachers: teacherPerformance(data, term, { subjects }),
    students: rows.map((r) => ({
      id: r.id,
      name: r.name,
      class: r.class,
      status: r.status,
      subjects: slimSubjects(r, subjects),
      average: r.average, // average across this department's subjects only
      grade: r.grade,
    })),
  };
}

/** Registration (class) teacher: performance of their class. */
function classView(data, className, term) {
  const rows = studentRows(data, term);
  const inClass = rows.filter((r) => r.class === className);
  const subjects = subjectOrder(data).filter((s) => inClass.some((r) => r.subjects[s]));
  const { classes } = classAverages(data, rows);
  const mine = classes.find((c) => c.class === className);
  const teacherRows = teacherPerformance(data, term).detail.filter((d) => d.class === className);
  const ranking = [...classes].filter((c) => c.averagePoints !== null).sort((a, b) => b.averagePoints - a.averagePoints || b.average - a.average);
  return {
    term,
    termLabel: TERM_LABELS[term],
    class: className,
    regTeacher: (data.classes[className] || {}).regTeacher || '',
    stats: { ...summarise(inClass), classPosition: mine && mine.averagePoints !== null ? ranking.findIndex((c) => c.class === className) + 1 : null, classesCount: classes.length },
    subjects,
    subjectPerformance: teacherRows.map((d) => ({
      subject: d.subject,
      teacher: d.teacher,
      average: d.average,
      grade: d.grade,
      passRate: d.passRate,
    })),
    students: inClass.map((r) => ({
      id: r.id,
      name: r.name,
      class: r.class,
      status: r.status,
      subjects: slimSubjects(r, subjects),
      points: r.points,
      average: r.average,
      grade: r.grade,
      classRank: r.classRank,
    })),
  };
}

/** Matron: boarding students' performance. */
function boardersView(data, term) {
  const all = studentRows(data, term);
  const boarders = all.filter((r) => r.status === 'Boarder');
  const day = all.filter((r) => r.status !== 'Boarder');
  const subjects = subjectOrder(data);
  const rank = competitionRanks(boarders, () => 'b');
  const classNames = [...new Set(boarders.map((r) => r.class))].sort();
  return {
    term,
    termLabel: TERM_LABELS[term],
    subjects,
    stats: {
      ...summarise(boarders),
      dayScholarAverage: summarise(day).average,
      schoolAverage: summarise(all).average,
    },
    byClass: classNames.map((c) => ({ class: c, ...summarise(boarders.filter((r) => r.class === c)) })),
    students: boarders.map((r) => ({
      id: r.id,
      name: r.name,
      class: r.class,
      status: r.status,
      subjects: slimSubjects(r, subjects),
      points: r.points,
      average: r.average,
      grade: r.grade,
      boardingRank: rank(r),
      classRank: r.classRank,
    })),
  };
}

// ------------------------------------------------------- progress report

// Row order and wording exactly as printed on the school's report template
// (label on the form -> subject name used in the workbook).
const TEMPLATE_ROWS = [
  ['Science', 'Science'],
  ['Mathematics', 'Mathematics'],
  ['Setswana', 'Setswana'],
  ['English', 'English'],
  ['Home Economics', 'Home Economics'],
  ['Moral Education', 'Moral Education'],
  ['Social Education', 'Social Studies'],
  ['Agriculture', 'Agriculture'],
  ['Physical Education', 'Physical Education'],
  ['Com/Office Procedure', 'Commerce (Office Procedures)'],
  ['Com/Accounting', 'Commerce (Accounting)'],
];

/** "Mr. Mmusi" -> "Mmusi" */
function surname(name) {
  return String(name || '').replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '').trim();
}

/**
 * Everything the Student Progress Report template needs for one student and one term.
 * Subjects the student doesn't take come back as blank rows (the form is printed with all
 * subjects); a subject that isn't on the template (e.g. Religious Education) gets its own extra row.
 */
function progressReport(data, studentId, term, { headmaster = '' } = {}) {
  const student = data.students.find((x) => x.id === studentId);
  if (!student) return null;
  const row = studentRows(data, term).find((r) => r.id === studentId);
  const part = (r, idx) => {
    const v = idx.map((i) => r.papers[i]).filter((x) => x !== null);
    return v.length ? Math.round(mean(v)) : null;
  };
  const make = (label, subject) => {
    const r = row.subjects[subject];
    if (!r) return { label, subject, blank: true };
    return {
      label,
      subject,
      blank: false,
      termMark: part(r, TERM_MARK_PAPERS),
      examMark: part(r, EXAM_MARK_PAPERS),
      grade: r.grade,
      points: r.points,
      counted: row.counted.includes(subject),
      comment: r.comment,
      teacher: r.teacher,
      teacherSurname: surname(r.teacher),
    };
  };
  const onForm = new Set(TEMPLATE_ROWS.map((x) => x[1]));
  const rows = TEMPLATE_ROWS.map(([label, subject]) => make(label, subject));
  for (const subject of Object.keys(row.subjects)) if (!onForm.has(subject)) rows.push(make(subject, subject));
  const regTeacher = (data.classes[student.class] || {}).regTeacher || '';
  return {
    term,
    termLabel: TERM_LABELS[term],
    admissionNo: student.id,
    studentName: student.name,
    class: student.class,
    status: student.status,
    classSize: data.students.filter((x) => x.class === student.class).length,
    rows,
    totalPoints: row.points,
    maxPoints: MAX_POINTS,
    classTeacher: regTeacher,
    headName: headmaster,
  };
}

module.exports = {
  TERMS,
  TERM_LABELS,
  DEFAULT_TERM,
  PASS_MARK,
  PAPERS,
  key,
  formOf,
  round4,
  gradeFromPercentage,
  autoComment,
  termResult,
  studentRows,
  schoolOverview,
  masterTable,
  departmentView,
  classView,
  boardersView,
  progressReport,
  surname,
  totalPoints,
  GRADE_POINTS,
  CORE_SUBJECTS,
  BEST_TWO_OF,
  MAX_POINTS,
  TEMPLATE_ROWS,
  teacherPerformance,
  subjectOrder,
  byClassThenName,
};
