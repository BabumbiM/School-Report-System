/**
 * dataStore.js
 * ------------
 * All "database" logic for the app. There is no real database -
 * everything lives in memory while the server runs, and is mirrored
 * to two small JSON files in /data so that a restart during the same
 * session doesn't lose work. Restarting after that is fine to reset
 * (per the project's requirements).
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DATA_DIR = path.join(__dirname, 'data');
const ASSIGNMENTS_FILE = path.join(DATA_DIR, 'assignments.json');
const GRADEBOOK_FILE = path.join(DATA_DIR, 'gradebook.json');

// assignments: [{ student, subject, teacher }, ...]
let assignments = [];

// gradebook: { "Student||Subject": { teacher, grade, comment } }
let gradebook = {};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  try {
    if (fs.existsSync(ASSIGNMENTS_FILE)) {
      assignments = JSON.parse(fs.readFileSync(ASSIGNMENTS_FILE, 'utf-8'));
    }
    if (fs.existsSync(GRADEBOOK_FILE)) {
      gradebook = JSON.parse(fs.readFileSync(GRADEBOOK_FILE, 'utf-8'));
    }
  } catch (e) {
    console.warn('Could not load persisted data, starting fresh:', e.message);
    assignments = [];
    gradebook = {};
  }
}

function persist() {
  ensureDataDir();
  fs.writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
  fs.writeFileSync(GRADEBOOK_FILE, JSON.stringify(gradebook, null, 2));
}

function key(student, subject) {
  return `${student}||${subject}`;
}

/**
 * Reads an uploaded .xlsx file and rebuilds the assignments list.
 * Expected columns (case-insensitive, flexible naming):
 *   Student | Subject | Teacher
 * Existing grades/comments are preserved for any student+subject pair
 * that still exists with the same teacher after re-import.
 */
function importFromExcel(filePath) {
  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  const newAssignments = [];
  for (const row of rows) {
    const norm = {};
    for (const k of Object.keys(row)) {
      norm[k.trim().toLowerCase()] = String(row[k]).trim();
    }
    const student = norm['student'] || norm['student name'] || norm['name'];
    const subject = norm['subject'] || norm['subject name'];
    const teacher = norm['teacher'] || norm['teacher name'] || norm['assigned teacher'];

    if (!student || !subject || !teacher) continue;
    newAssignments.push({ student, subject, teacher });
  }

  if (newAssignments.length === 0) {
    throw new Error(
      'No valid rows found. Make sure the sheet has columns named Student, Subject, and Teacher.'
    );
  }

  assignments = newAssignments;

  // Rebuild the gradebook, keeping existing entries where the
  // student+subject+teacher combination is unchanged.
  const newGradebook = {};
  for (const a of assignments) {
    const k = key(a.student, a.subject);
    const existing = gradebook[k];
    if (existing && existing.teacher === a.teacher) {
      newGradebook[k] = existing;
    } else {
      newGradebook[k] = { teacher: a.teacher, grade: '', comment: '' };
    }
  }
  gradebook = newGradebook;

  persist();
  return assignments;
}

function getTeachers() {
  return [...new Set(assignments.map((a) => a.teacher))].sort();
}

function getStudents() {
  return [...new Set(assignments.map((a) => a.student))].sort();
}

/** Everything one teacher needs to see: their students + subjects + current grade/comment. */
function getTeacherView(teacherName) {
  return assignments
    .filter((a) => a.teacher === teacherName)
    .map((a) => {
      const g = gradebook[key(a.student, a.subject)] || { grade: '', comment: '' };
      return {
        student: a.student,
        subject: a.subject,
        teacher: a.teacher,
        grade: g.grade || '',
        comment: g.comment || '',
      };
    })
    .sort((a, b) => a.student.localeCompare(b.student) || a.subject.localeCompare(b.subject));
}

function setGrade({ teacher, student, subject, grade, comment }) {
  const k = key(student, subject);
  const assignmentExists = assignments.some(
    (a) => a.student === student && a.subject === subject && a.teacher === teacher
  );
  if (!assignmentExists) {
    throw new Error('This teacher is not assigned to that student/subject.');
  }
  if (!gradebook[k]) gradebook[k] = { teacher, grade: '', comment: '' };
  gradebook[k].teacher = teacher;
  if (grade !== undefined) gradebook[k].grade = grade;
  if (comment !== undefined) gradebook[k].comment = comment;
  persist();
  return gradebook[k];
}

/** Full report card data for one student: every subject, its teacher, grade and comment. */
function getReport(studentName) {
  const subjects = assignments
    .filter((a) => a.student === studentName)
    .map((a) => {
      const g = gradebook[key(a.student, a.subject)] || { grade: '', comment: '' };
      return {
        subject: a.subject,
        teacher: a.teacher,
        grade: g.grade || '',
        comment: g.comment || '',
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));

  return { student: studentName, subjects };
}

function getAllReports() {
  return getStudents().map((s) => getReport(s));
}

/** Builds an .xlsx buffer of the full gradebook, for record-keeping. */
function exportGradebookBuffer() {
  const rows = assignments.map((a) => {
    const g = gradebook[key(a.student, a.subject)] || { grade: '', comment: '' };
    return {
      Student: a.student,
      Subject: a.subject,
      Teacher: a.teacher,
      Grade: g.grade,
      Comment: g.comment,
    };
  });
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 20 }, { wch: 10 }, { wch: 40 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Gradebook');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function hasData() {
  return assignments.length > 0;
}

module.exports = {
  load,
  importFromExcel,
  getTeachers,
  getStudents,
  getTeacherView,
  setGrade,
  getReport,
  getAllReports,
  exportGradebookBuffer,
  hasData,
};
