const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const store = require('./dataStore');
const api = require('./api');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

store.load();

const upload = multer({ dest: UPLOAD_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Sessions -------------------------------------------------------------
// There are no passwords (a deliberate simplification - see README). Signing in
// issues a token; every request after that is checked against the signed-in
// person's roles on the server, so a teacher can't fetch someone else's data
// just by editing the page.
const sessions = new Map(); // token -> staff name

function currentUser(req) {
  const token = req.get('x-session');
  const name = token && sessions.get(token);
  const user = name && store.getProfile(name);
  if (!user) throw new api.HttpError(401, 'Please sign in.');
  return user;
}

// wrap a handler: resolve the user, run, send JSON, turn errors into status codes
const route = (fn) => (req, res) => {
  try {
    res.json(fn(currentUser(req), req));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

// ---- Status & sign-in (public) ---------------------------------------------
app.get('/api/status', (req, res) => {
  const r = store.getRoster();
  res.json({
    hasData: store.hasData(),
    students: r.students.length,
    classes: Object.keys(r.classes).length,
    teachers: store.getTeachers().length,
    importedAt: r.importedAt,
    staff: store.hasData() ? store.listStaff() : [],
  });
});

app.post('/api/login', (req, res) => {
  const name = req.body && req.body.name;
  const user = store.hasData() && store.getProfile(name);
  if (!user) return res.status(401).json({ error: 'Unknown staff member.' });
  const token = crypto.randomUUID();
  sessions.set(token, user.name);
  res.json({ token, user: api.me(user) });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(req.get('x-session'));
  res.json({ success: true });
});

app.get('/api/me', route((user) => api.me(user)));

// ---- Import: open on first run, headmaster-only once a roster exists ------
app.post('/api/import', upload.single('file'), (req, res) => {
  const done = () => req.file && fs.unlink(req.file.path, () => {});
  try {
    if (store.hasData()) {
      const token = req.get('x-session');
      const user = token && sessions.get(token) && store.getProfile(sessions.get(token));
      if (!user || !user.isHeadmaster) {
        return res.status(403).json({ error: 'Only the headmaster can replace the imported roster.' });
      }
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
    const summary = store.importFromExcel(req.file.path);
    // roles are re-derived from the data, so drop sessions that no longer map to anyone
    for (const [t, n] of sessions) if (!store.getProfile(n)) sessions.delete(t);
    res.json({ success: true, ...summary, staff: store.listStaff() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    done();
  }
});

// ---- Headmaster -------------------------------------------------------------
app.get('/api/overview', route((u, req) => api.overview(u, req.query.term)));
app.get('/api/master', route((u, req) => api.master(u, req.query.term)));
app.get('/api/staff-config', route((u) => api.getStaff(u)));
app.put('/api/staff-config', (req, res) => {
  try {
    const user = currentUser(req);
    const { config, sessionName } = api.putStaff(user, req.body);
    if (sessionName) sessions.set(req.get('x-session'), sessionName); // keep them signed in if they renamed themselves
    res.json({ ...config, staff: store.listStaff() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Head of department ----------------------------------------------------
app.get('/api/department', route((u, req) => api.department(u, req.query.name, req.query.term)));

// ---- Registration (class) teacher ------------------------------------------
app.get('/api/class', route((u, req) => api.classPerformance(u, req.query.name, req.query.term)));

// ---- Register new students (registration teacher, for their own class) ----
app.get('/api/register-info', route((u, req) => api.registerInfo(u, req.query.class)));
app.post('/api/students', route((u, req) => api.registerStudent(u, req.body)));

// ---- Matron ----------------------------------------------------------------
app.get('/api/boarders', route((u, req) => api.boarders(u, req.query.term)));

// ---- Subject teacher: own students only ------------------------------------
app.get('/api/gradebook', route((u) => api.gradebook(u)));
app.post('/api/marks', route((u, req) => api.saveMarks(u, req.body)));

// ---- Report cards: Student Progress Report, one term at a time ------------
// (headmaster: everyone; registration teacher: own class)
app.get('/api/report-students', route((u) => api.reportStudents(u)));
app.get('/api/report/:id', route((u, req) => api.report(u, req.params.id, req.query.term)));
app.get('/api/reports/class/:cls', route((u, req) => api.classReports(u, req.params.cls, req.query.term)));
// the same report(s) as a Word file made from the school's template
app.get('/api/report-docx', async (req, res) => {
  try {
    const { buffer, filename } = await api.reportsDocx(currentUser(req), { student: req.query.student, class: req.query.class, term: req.query.term });
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Export (everyone but matrons; scoped to what the role can see) -----------------------------------------------------
app.get('/api/export', (req, res) => {
  try {
    const buffer = api.exportWorkbook(currentUser(req));
    res.setHeader('Content-Disposition', 'attachment; filename="school-gradebook-export.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  School Report System running at http://localhost:${PORT}\n`);
});
