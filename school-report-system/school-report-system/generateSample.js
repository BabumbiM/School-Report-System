/**
 * Generates data/sample-import.xlsx - a ready-made example file with the
 * Student / Subject / Teacher columns the app expects, so you can try the
 * import step immediately without building your own spreadsheet first.
 */
const path = require('path');
const XLSX = require('xlsx');

const rows = [
  { Student: 'Sam Ndlovu', Subject: 'Science', Teacher: 'Mrs. Cat' },
  { Student: 'Sam Ndlovu', Subject: 'Maths', Teacher: 'Mrs. Whitfield' },
  { Student: 'Sam Ndlovu', Subject: 'English', Teacher: 'Mr. Jones' },

  { Student: 'Priya Patel', Subject: 'Science', Teacher: 'Mrs. Cat' },
  { Student: 'Priya Patel', Subject: 'Maths', Teacher: 'Mrs. Whitfield' },
  { Student: 'Priya Patel', Subject: 'History', Teacher: 'Mrs. Cat' },

  { Student: 'Leo Marsh', Subject: 'English', Teacher: 'Mr. Jones' },
  { Student: 'Leo Marsh', Subject: 'Maths', Teacher: 'Mrs. Whitfield' },
  { Student: 'Leo Marsh', Subject: 'Science', Teacher: 'Mrs. Cat' },

  { Student: 'Mia Alvarez', Subject: 'History', Teacher: 'Mrs. Cat' },
  { Student: 'Mia Alvarez', Subject: 'English', Teacher: 'Mr. Jones' },
  { Student: 'Mia Alvarez', Subject: 'Maths', Teacher: 'Mrs. Whitfield' },
];

const worksheet = XLSX.utils.json_to_sheet(rows);
worksheet['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 20 }];
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, 'Assignments');

const outPath = path.join(__dirname, 'data', 'sample-import.xlsx');
require('fs').mkdirSync(path.join(__dirname, 'data'), { recursive: true });
XLSX.writeFile(workbook, outPath);

console.log(`Sample import file written to: ${outPath}`);
