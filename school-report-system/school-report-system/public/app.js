(() => {
  'use strict';

  // ---------------- State ----------------
  let currentTeacher = null;
  let saveTimers = {}; // debounce per row key

  // ---------------- Helpers ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function showToast(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2200);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, options);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json (e.g. blob endpoints) */ }
    if (!res.ok) {
      const message = (data && data.error) || `Request failed (${res.status})`;
      throw new Error(message);
    }
    return data;
  }

  // ---------------- Tabs ----------------
  function setActiveTab(tabName) {
    $$('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    $$('.panel').forEach((panel) => {
      panel.hidden = panel.id !== `panel-${tabName}`;
    });

    if (tabName === 'dashboard' && currentTeacher) loadTeacherDashboard(currentTeacher);
    if (tabName === 'reports') loadStudentOptions();
  }

  function enableTab(tabName) {
    const btn = $$('.tab-btn').find((b) => b.dataset.tab === tabName);
    if (btn) btn.disabled = false;
  }

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn || btn.disabled) return;
    setActiveTab(btn.dataset.tab);
  });

  // ---------------- Import ----------------
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const dropzoneText = $('#dropzoneText');

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) dropzoneText.textContent = fileInput.files[0].name;
  });

  ['dragover', 'dragenter'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    })
  );
  ['dragleave', 'drop'].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
    })
  );
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) {
      fileInput.files = e.dataTransfer.files;
      dropzoneText.textContent = file.name;
    }
  });

  $('#importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = fileInput.files[0];
    const statusBox = $('#importStatus');
    statusBox.hidden = true;

    if (!file) {
      statusBox.hidden = false;
      statusBox.className = 'status-msg error';
      statusBox.textContent = 'Please choose a .xlsx file first.';
      return;
    }

    const btn = $('#importBtn');
    btn.disabled = true;
    btn.textContent = 'Importing…';

    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await api('/api/import', { method: 'POST', body: formData });

      statusBox.hidden = false;
      statusBox.className = 'status-msg success';
      statusBox.textContent = `Imported ${data.count} subject assignment${data.count === 1 ? '' : 's'} successfully.`;

      $('#summaryStudents').textContent = data.students.length;
      $('#summaryTeachers').textContent = data.teachers.length;
      $('#summaryAssignments').textContent = data.count;
      $('#importSummary').hidden = false;

      populateTeacherSelect(data.teachers);
      ['login', 'dashboard', 'reports', 'export'].forEach(enableTab);
      showToast('Roster imported');
    } catch (err) {
      statusBox.hidden = false;
      statusBox.className = 'status-msg error';
      statusBox.textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import roster';
    }
  });

  // ---------------- Login ----------------
  function populateTeacherSelect(teachers) {
    const select = $('#teacherSelect');
    select.innerHTML = teachers.map((t) => `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`).join('');
  }

  $('#loginBtn').addEventListener('click', () => {
    const select = $('#teacherSelect');
    const teacher = select.value;
    if (!teacher) return;
    currentTeacher = teacher;

    $('#sessionPill').hidden = false;
    $('#sessionTeacherName').textContent = teacher;

    setActiveTab('dashboard');
    showToast(`Logged in as ${teacher}`);
  });

  $('#switchTeacherBtn').addEventListener('click', () => {
    currentTeacher = null;
    $('#sessionPill').hidden = true;
    setActiveTab('login');
  });

  // ---------------- Teacher dashboard ----------------
  async function loadTeacherDashboard(teacher) {
    $('#dashboardSub').textContent = `Enter a grade and a short comment for each of ${teacher}'s students. Changes save automatically.`;
    const rows = await api(`/api/teacher/${encodeURIComponent(teacher)}/students`);
    const tbody = $('#gradeTableBody');
    const emptyNote = $('#dashboardEmpty');

    if (rows.length === 0) {
      tbody.innerHTML = '';
      emptyNote.hidden = false;
      return;
    }
    emptyNote.hidden = true;

    tbody.innerHTML = rows
      .map((row, i) => {
        const rowKey = rowKeyFor(row.student, row.subject);
        return `
        <tr data-row-key="${escapeAttr(rowKey)}" data-student="${escapeAttr(row.student)}" data-subject="${escapeAttr(row.subject)}">
          <td class="student-name">${escapeHtml(row.student)}</td>
          <td><span class="subject-pill">${escapeHtml(row.subject)}</span></td>
          <td>
            <input class="grade-input" type="text" maxlength="6" value="${escapeAttr(row.grade)}" placeholder="—" data-field="grade" />
          </td>
          <td>
            <input class="comment-input" type="text" value="${escapeAttr(row.comment)}" placeholder="Add a comment…" data-field="comment" />
          </td>
          <td><span class="row-status">Saved</span></td>
        </tr>`;
      })
      .join('');
  }

  function rowKeyFor(student, subject) {
    return `${student}||${subject}`;
  }

  $('#gradeTableBody').addEventListener('input', (e) => {
    const input = e.target.closest('input');
    if (!input) return;
    const tr = input.closest('tr');
    const student = tr.dataset.student;
    const subject = tr.dataset.subject;
    const rowKey = tr.dataset.rowKey;

    clearTimeout(saveTimers[rowKey]);
    saveTimers[rowKey] = setTimeout(() => saveGradeRow(tr, student, subject), 500);
  });

  async function saveGradeRow(tr, student, subject) {
    const grade = tr.querySelector('[data-field="grade"]').value.trim();
    const comment = tr.querySelector('[data-field="comment"]').value.trim();
    const statusEl = tr.querySelector('.row-status');

    try {
      await api('/api/grade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teacher: currentTeacher, student, subject, grade, comment }),
      });
      statusEl.textContent = 'Saved';
      statusEl.classList.add('show');
      setTimeout(() => statusEl.classList.remove('show'), 1200);
    } catch (err) {
      statusEl.textContent = 'Error';
      statusEl.classList.add('show');
      showToast(err.message);
    }
  }

  // ---------------- Reports ----------------
  async function loadStudentOptions() {
    const students = await api('/api/students');
    const select = $('#studentSelect');
    select.innerHTML = students.map((s) => `<option value="${escapeAttr(s)}">${escapeHtml(s)}</option>`).join('');
  }

  $('#viewReportBtn').addEventListener('click', async () => {
    const student = $('#studentSelect').value;
    if (!student) return;
    try {
      const report = await api(`/api/report/${encodeURIComponent(student)}`);
      renderReports([report]);
    } catch (err) {
      showToast(err.message);
    }
  });

  $('#viewAllBtn').addEventListener('click', async () => {
    try {
      const reports = await api('/api/reports');
      renderReports(reports);
    } catch (err) {
      showToast(err.message);
    }
  });

  $('#printBtn').addEventListener('click', () => window.print());

  function renderReports(reports) {
    const area = $('#reportArea');
    if (reports.length === 0) {
      area.innerHTML = '<p class="empty-note">No report data yet.</p>';
      return;
    }

    const today = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

    area.innerHTML = reports
      .map((report) => {
        const subjectRows = report.subjects
          .map((s) => {
            const gradeDisplay = s.grade ? escapeHtml(s.grade) : '—';
            const commentClass = s.comment ? '' : ' empty';
            const commentText = s.comment ? escapeHtml(s.comment) : 'No comment entered yet.';
            return `
            <div class="report-subject-row">
              <div>
                <div class="subj-name">${escapeHtml(s.subject)}</div>
                <div class="subj-teacher">${escapeHtml(s.teacher)}</div>
              </div>
              <div class="subj-grade">${gradeDisplay}</div>
              <div class="subj-comment${commentClass}">${commentText}</div>
            </div>`;
          })
          .join('');

        return `
        <article class="report-card">
          <div class="report-head">
            <div>
              <h3>${escapeHtml(report.student)}</h3>
              <p class="term-label">Generated ${today}</p>
            </div>
            <span class="report-badge">Report card</span>
          </div>
          <div class="report-subjects">
            ${subjectRows || '<p class="empty-note">No subjects assigned.</p>'}
          </div>
          <div class="signature-block">
            <div class="signature-line">
              <div class="line"></div>
              <p class="caption">Headmaster&rsquo;s signature</p>
            </div>
          </div>
        </article>`;
      })
      .join('');
  }

  // ---------------- Export ----------------
  $('#exportBtn').addEventListener('click', async () => {
    const statusBox = $('#exportStatus');
    statusBox.hidden = true;
    try {
      const res = await fetch('/api/export');
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not export.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gradebook-export.xlsx';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Export downloaded');
    } catch (err) {
      statusBox.hidden = false;
      statusBox.className = 'status-msg error';
      statusBox.textContent = err.message;
    }
  });

  // ---------------- Escaping ----------------
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  // ---------------- Boot ----------------
  async function boot() {
    try {
      const status = await api('/api/status');
      if (status.hasData) {
        $('#importSummary').hidden = false;
        $('#summaryStudents').textContent = status.students.length;
        $('#summaryTeachers').textContent = status.teachers.length;
        // assignments count isn't in status; infer via teacher endpoint sum isn't needed here
        $('#summaryAssignments').textContent = '—';
        populateTeacherSelect(status.teachers);
        ['login', 'dashboard', 'reports', 'export'].forEach(enableTab);

        const statusBox = $('#importStatus');
        statusBox.hidden = false;
        statusBox.className = 'status-msg success';
        statusBox.textContent = `A roster is already loaded (${status.students.length} students, ${status.teachers.length} teachers). Import again to replace it.`;
      }
    } catch (err) {
      console.error(err);
    }
  }

  boot();
})();
