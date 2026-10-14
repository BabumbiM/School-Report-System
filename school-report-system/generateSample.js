/**
 * Generates data/sample-import.xlsx - a small example in the SAME layout as the
 * school's real workbook, so you can try the whole app (all roles) quickly:
 *
 *   Registration 1A / 1B   registration teacher, students (ID / name / Day Scholar|Boarder),
 *                          each student's subjects and subject teachers
 *   Assessments 1A / 1B    Term 1, Term 2 and Term 3 / Final Exam marks (Paper 1-3)
 *
 * The calculated columns (average, percentage, grade, comment) are left out on
 * purpose - the app works them out itself.
 */
const path = require('path');
const fs = require('fs');

const CLASSES = {
  '1A': { regTeacher: 'Mr. Sebina' },
  '1B': { regTeacher: 'Ms. Balopi' },
};
// subject -> teacher for each class
const TEACHERS = {
  '1A': { English: 'Mr. Sebina', Mathematics: 'Ms. Moeng', Science: 'Mr. Tumagole', 'Physical Education': 'Ms. Keitshokile' },
  '1B': { English: 'Ms. Balopi', Mathematics: 'Mrs. Ramotswe', Science: 'Mr. Radithupa', 'Physical Education': 'Mr. Mmusi' },
};
const STUDENTS = {
  '1A': [['STU001', 'Mmoloki Nthoiwa', 'Day Scholar'], ['STU002', 'Thabo Khumalo', 'Boarder'], ['STU003', 'Tumelo Segwabe', 'Boarder'], ['STU004', 'Neo Phiri', 'Day Scholar']],
  '1B': [['STU005', 'Gomolemo Rakgoathe', 'Day Scholar'], ['STU006', 'Wame Khumalo', 'Boarder'], ['STU007', 'Kago Mothibi', 'Boarder'], ['STU008', 'Lorato Tau', 'Day Scholar']],
};

// small deterministic pseudo-random so the sample is the same every time
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mark = (base) => Math.max(35, Math.min(98, Math.round(base + (rand() - 0.5) * 24)));

function buildSheets() {
  const sheets = {};
  for (const cls of Object.keys(CLASSES)) {
    const subjects = Object.keys(TEACHERS[cls]);

    // ---- Registration sheet ----
    const reg = [['REGISTRATION SHEET'], ['Registration Teacher', null, CLASSES[cls].regTeacher], [`CLASS: ${cls}`], ['Student ID', 'Student Name', 'School Status', 'Subject', 'Subject Teacher']];
    for (const [id, name, status] of STUDENTS[cls]) {
      subjects.forEach((s, i) => reg.push(i === 0 ? [id, name, status, s, TEACHERS[cls][s]] : [null, null, null, s, TEACHERS[cls][s]]));
    }
    sheets[`Registration ${cls}`] = reg;

    // ---- Assessments sheet ----
    const grp = (t) => [t, null, null, null, null, null, null];
    const paperHdr = ['Paper 1', 'Paper 2', 'Paper 3', 'Average Mark', 'Percentage', 'Grade', 'Comment'];
    const assess = [
      [`Assessments ${cls}`], [], [],
      ['Student ID', 'Student Name', 'Class', 'School Status', 'Subject', 'Teacher', ...grp('Term 1'), ...grp('Term 2'), ...grp('Term 3 / Final Exam')],
      [null, null, null, null, null, null, ...paperHdr, ...paperHdr, ...paperHdr],
    ];
    for (const [id, name, status] of STUDENTS[cls]) {
      const ability = 55 + rand() * 30;
      subjects.forEach((s, i) => {
        const papers = [];
        for (let t = 0; t < 3; t++) for (let p = 0; p < 3; p++) papers.push(mark(ability + t * 2));
        const row = i === 0 ? [id, name, cls, status] : [null, null, null, null];
        row.push(s, TEACHERS[cls][s]);
        for (let t = 0; t < 3; t++) row.push(papers[t * 3], papers[t * 3 + 1], papers[t * 3 + 2], null, null, null, null);
        assess.push(row);
      });
    }
    sheets[`Assessments ${cls}`] = assess;
  }
  return sheets;
}

if (require.main === module) {
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(buildSheets())) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const outPath = path.join(__dirname, 'data', 'sample-import.xlsx');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  XLSX.writeFile(wb, outPath);
  console.log(`Sample workbook written to: ${outPath}`);
}

module.exports = { buildSheets };
