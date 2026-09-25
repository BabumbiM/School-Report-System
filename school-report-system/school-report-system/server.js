const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const store = require('./dataStore');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

store.load();

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Status: does the app already have imported data? ----
app.get('/api/status', (req, res) => {
  res.json({
    hasData: store.hasData(),
    teachers: store.getTeachers(),
    students: store.getStudents(),
  });
});

// ---- Import an .xlsx of Student / Subject / Teacher ----
app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const assignments = store.importFromExcel(req.file.path);
    res.json({
      success: true,
      count: assignments.length,
      teachers: store.getTeachers(),
      students: store.getStudents(),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---- Simple "log in as" a teacher (no password) ----
app.get('/api/teachers', (req, res) => res.json(store.getTeachers()));
app.get('/api/students', (req, res) => res.json(store.getStudents()));

// ---- Teacher dashboard data ----
app.get('/api/teacher/:name/students', (req, res) => {
  res.json(store.getTeacherView(req.params.name));
});

// ---- Save/update a grade + comment ----
app.post('/api/grade', (req, res) => {
  const { teacher, student, subject, grade, comment } = req.body || {};
  if (!teacher || !student || !subject) {
    return res.status(400).json({ error: 'teacher, student and subject are required.' });
  }
  try {
    const result = store.setGrade({ teacher, student, subject, grade, comment });
    res.json({ success: true, result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---- Report cards ----
app.get('/api/report/:student', (req, res) => {
  const report = store.getReport(req.params.student);
  if (report.subjects.length === 0) {
    return res.status(404).json({ error: 'No such student, or student has no assigned subjects.' });
  }
  res.json(report);
});

app.get('/api/reports', (req, res) => {
  res.json(store.getAllReports());
});

// ---- Export the full gradebook as .xlsx ----
app.get('/api/export', (req, res) => {
  if (!store.hasData()) return res.status(400).json({ error: 'No data to export yet.' });
  const buffer = store.exportGradebookBuffer();
  res.setHeader('Content-Disposition', 'attachment; filename="gradebook-export.xlsx"');
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.send(buffer);
});

app.listen(PORT, () => {
  console.log(`\n  School Report System running at http://localhost:${PORT}\n`);
});
