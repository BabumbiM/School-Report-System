(() => {
  'use strict';

  // ---------------- State ----------------
  const state = {
    token: sessionStorage.getItem('fs-token'),
    user: null,
    hasData: false,
    staff: [],
    term: 3,
    active: null,
    ovForm: null,
    ovTeacherView: 'summary',
    deptTeacherView: 'summary',
    master: null,
    gb: null, // gradebook rows
    rep: null, // report students
  };
  const saveTimers = {};

  // ---------------- Helpers ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const pct = (v) => (v === null || v === undefined ? '&mdash;' : (v * 100).toFixed(1) + '%');
  const rate = (v) => (v === null || v === undefined ? '&mdash;' : Math.round(v * 100) + '%');
  const pts = (v) => (v === null || v === undefined ? '&mdash;' : v);
  const gradeChip = (g) => (g ? `<span class="grade g-${esc(g)}">${esc(g)}</span>` : '');

  function showToast(msg) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (state.token) headers['x-session'] = state.token;
    const res = await fetch(path, { ...options, headers });
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-json */ }
    if (!res.ok) {
      if (res.status === 401 && state.token) localSignOut('Your session ended - please sign in again.');
      throw new Error((data && data.error) || `Request failed (${res.status})`);
    }
    return data;
  }

  const has = (role) => state.user && state.user.roles.includes(role);

  // ---------------- Generic sortable table ----------------
  // cols: [{ key, label, html(row), sort(row)?, num? }]
  function renderTable(el, cols, rows, opts = {}) {
    if (!rows.length) {
      el.innerHTML = `<p class="empty-note inside">${esc(opts.empty || 'Nothing to show yet.')}</p>`;
      return;
    }
    const st = el._st || (el._st = { key: opts.sortKey || null, dir: opts.sortDir || 1 });
    const draw = () => {
      let list = rows;
      if (st.key) {
        const c = cols.find((x) => x.key === st.key);
        const val = (r) => (c.sort ? c.sort(r) : r[c.key]);
        list = [...rows].sort((a, b) => {
          const x = val(a), y = val(b);
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          if (a._total) return 1;
          if (b._total) return -1;
          return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir;
        });
      }
      const head = cols.map((c, i) => {
        const arrow = st.key === c.key ? (st.dir > 0 ? ' &uarr;' : ' &darr;') : '';
        return `<th data-key="${escAttr(c.key)}" class="sortable${c.num ? ' num' : ''}${i === 0 && opts.stickyFirst ? ' sticky-first' : ''}">${c.label}${arrow}</th>`;
      }).join('');
      const body = list.map((r) =>
        `<tr class="${r._total ? 'total-row' : ''}">${cols.map((c, i) =>
          `<td class="${c.num ? 'num' : ''}${i === 0 && opts.stickyFirst ? ' sticky-first' : ''}">${c.html(r)}</td>`).join('')}</tr>`
      ).join('');
      el.innerHTML = `<table class="grade-table data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };
    el.onclick = (e) => {
      const th = e.target.closest('th[data-key]');
      if (!th) return;
      const k = th.dataset.key;
      if (st.key === k) st.dir *= -1;
      else { st.key = k; st.dir = cols.find((c) => c.key === k).num ? -1 : 1; }
      draw();
    };
    draw();
  }

  function subjectCols(subjects, getter) {
    return subjects.map((s) => ({
      key: 's:' + s,
      label: esc(s),
      num: true,
      sort: (r) => { const v = getter(r, s); return v ? v.percentage : null; },
      html: (r) => { const v = getter(r, s); return v && v.percentage !== null ? `${(v.percentage * 100).toFixed(0)}% ${gradeChip(v.grade)}` : '&mdash;'; },
    }));
  }

  const statCards = (items) => items.map(([num, label, tone]) =>
    `<div class="summary-card ${tone}"><span class="summary-num">${num}</span><span class="summary-label">${esc(label)}</span></div>`).join('');

  function pillTabs(el, options, current, onPick) {
    el.innerHTML = options.map(([v, l]) => `<button type="button" class="pill-btn${v === current ? ' active' : ''}" data-v="${escAttr(v)}">${esc(l)}</button>`).join('');
    el.onclick = (e) => {
      const b = e.target.closest('.pill-btn');
      if (b) onPick(b.dataset.v);
    };
  }

  // ---------------- Tabs ----------------
  const TABS = [
    { id: 'overview', label: 'School performance', show: () => has('headmaster'), load: loadOverview },
    { id: 'students', label: 'Students', show: () => has('headmaster'), load: loadMaster },
    { id: 'department', label: 'My department', show: () => has('hod'), load: loadDepartment },
    { id: 'class', label: 'My class', show: () => has('class_teacher'), load: loadClass },
    { id: 'boarders', label: 'Boarders', show: () => has('matron') || has('headmaster'), load: loadBoarders },
    { id: 'gradebook', label: 'My gradebook', show: () => state.user && state.user.teaches, load: loadGradebook },
    { id: 'reports', label: 'Report cards', show: () => has('headmaster') || has('class_teacher'), load: loadReportOptions },
    { id: 'import', label: 'Import', show: () => has('headmaster'), load: () => {} },
    { id: 'export', label: 'Export', show: () => state.user.roles.some((r) => r !== 'matron'), load: describeExport },
  ];

  function visibleTabs() {
    if (!state.user) {
      return state.hasData ? [{ id: 'login', label: 'Sign in' }] : [{ id: 'import', label: 'Import workbook' }, { id: 'login', label: 'Sign in', disabled: true }];
    }
    return TABS.filter((t) => t.show());
  }

  function renderTabs() {
    $('#tabs').innerHTML = visibleTabs().map((t) =>
      `<button class="tab-btn${t.id === state.active ? ' active' : ''}" data-tab="${t.id}"${t.disabled ? ' disabled' : ''}>${esc(t.label)}</button>`).join('');
    const pill = $('#sessionPill');
    pill.hidden = !state.user;
    if (state.user) {
      $('#sessionName').textContent = state.user.name;
      $('#sessionRoles').textContent = state.user.labels.filter((l) => l !== state.user.name).join(' · ');
    }
  }

  function setActiveTab(id) {
    const tabs = visibleTabs();
    if (!tabs.some((t) => t.id === id)) id = tabs[0] && tabs[0].id;
    state.active = id;
    $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${id}`; });
    renderTabs();
    const t = TABS.find((x) => x.id === id);
    if (t && state.user) Promise.resolve(t.load()).catch((e) => showToast(e.message));
  }

  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab-btn');
    if (btn && !btn.disabled) setActiveTab(btn.dataset.tab);
  });

  // term selector (one per analytic panel, kept in sync)
  function fillTermSelects() {
    const terms = (state.user && state.user.terms) || { 1: 'Term 1', 2: 'Term 2', 3: 'Term 3 / Final Exam' };
    $$('.term-select').forEach((sel) => {
      sel.innerHTML = Object.entries(terms).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('');
      sel.value = String(state.term);
    });
  }
  document.addEventListener('change', (e) => {
    if (!e.target.classList.contains('term-select')) return;
    state.term = Number(e.target.value);
    $$('.term-select').forEach((s) => { s.value = String(state.term); });
    const t = TABS.find((x) => x.id === state.active);
    if (t) Promise.resolve(t.load()).catch((err) => showToast(err.message));
  });

  // ---------------- Sign in / out ----------------
  function populateStaffSelect() {
    $('#staffSelect').innerHTML = state.staff.map((p) =>
      `<option value="${escAttr(p.name)}">${esc(p.name)} — ${esc(p.labels.join(', '))}</option>`).join('');
  }

  $('#loginBtn').addEventListener('click', async () => {
    const name = $('#staffSelect').value;
    if (!name) return;
    try {
      const data = await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      state.token = data.token;
      sessionStorage.setItem('fs-token', data.token);
      state.user = data.user;
      state.term = data.user.defaultTerm || 3;
      fillTermSelects();
      setActiveTab(firstTabFor(state.user));
      showToast(`Signed in as ${name}`);
    } catch (e) { showToast(e.message); }
  });

  function firstTabFor() { const t = visibleTabs()[0]; return t && t.id; }

  function localSignOut(msg) {
    state.token = null;
    state.user = null;
    state.gb = null;
    state.master = null;
    sessionStorage.removeItem('fs-token');
    state.active = null;
    renderTabs();
    setActiveTab(state.hasData ? 'login' : 'import');
    if (msg) showToast(msg);
  }

  $('#signOutBtn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
    localSignOut();
  });

  // ---------------- Import ----------------
  const dropzone = $('#dropzone');
  const fileInput = $('#fileInput');
  const dropzoneText = $('#dropzoneText');
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) dropzoneText.textContent = fileInput.files[0].name; });
  ['dragover', 'dragenter'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); }));
  ['dragleave', 'drop'].forEach((evt) => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); }));
  dropzone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files[0];
    if (file) { fileInput.files = e.dataTransfer.files; dropzoneText.textContent = file.name; }
  });

  $('#importForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = fileInput.files[0];
    const box = $('#importStatus');
    box.hidden = true;
    if (!file) {
      box.hidden = false; box.className = 'status-msg error'; box.textContent = 'Please choose a .xlsx file first.';
      return;
    }
    const btn = $('#importBtn');
    btn.disabled = true; btn.textContent = 'Importing…';
    try {
      const fd = new FormData();
      fd.append('file', file);
      const d = await api('/api/import', { method: 'POST', body: fd });
      box.hidden = false; box.className = 'status-msg success';
      box.textContent = `Imported ${d.students} students in ${d.classes.length} classes (${d.classes.join(', ')}), with ${d.marksLoaded.toLocaleString()} marks.`;
      $('#sumStudents').textContent = d.students;
      $('#sumClasses').textContent = d.classes.length;
      $('#sumTeachers').textContent = d.teachers.length;
      $('#sumAssignments').textContent = d.assignments;
      $('#importSummary').hidden = false;
      const w = $('#importWarnings');
      if (d.warnings.length) {
        w.hidden = false;
        w.innerHTML = `<strong>${d.warnings.length} thing${d.warnings.length === 1 ? '' : 's'} to check:</strong><ul>${d.warnings.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${d.warnings.length > 8 ? `<p>…and ${d.warnings.length - 8} more.</p>` : ''}`;
      } else w.hidden = true;
      state.hasData = true;
      state.staff = d.staff;
      state.master = null; state.gb = null; state.rep = null;
      populateStaffSelect();
      if (state.user) {
        state.user = await api('/api/me');
        fillTermSelects();
        renderTabs();
      } else {
        renderTabs();
        showToast('Imported - now sign in');
        setActiveTab('login');
      }
      showToast('Workbook imported');
    } catch (err) {
      box.hidden = false; box.className = 'status-msg error'; box.textContent = err.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Import workbook';
    }
  });

  // ---------------- Headmaster: school overview ----------------
  async function loadOverview() {
    const d = await api(`/api/overview?term=${state.term}`);
    state.ov = d;
    const s = d.school;
    $('#ovStats').innerHTML = statCards([
      [s.students, 'Students', 'sage'],
      [rate(s.passRate), 'Pass rate (50%+)', 'sky'],
      [s.below50, 'Students below 50%', 'sun'],
    ]);

    // class averages (+ position)
    const ranked = [...d.classAverages].filter((c) => c.averagePoints !== null).sort((a, b) => b.averagePoints - a.averagePoints || b.average - a.average);
    const classRows = d.classAverages.map((c) => ({ ...c, position: ranked.findIndex((x) => x.class === c.class) + 1 || null }));
    classRows.push({ ...s, class: 'All Classes', regTeacher: '', position: null, _total: true });
    renderTable($('#ovClasses'), [
      { key: 'class', label: 'Class', html: (r) => `<strong>${esc(r.class)}</strong>` },
      { key: 'regTeacher', label: 'Registration teacher', html: (r) => esc(r.regTeacher) || '&mdash;' },
      { key: 'students', label: 'Students', num: true, html: (r) => r.students },
      { key: 'averagePoints', label: 'Average points', num: true, html: (r) => pts(r.averagePoints) },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'position', label: 'Position', num: true, html: (r) => r.position ?? '' },
      { key: 'passRate', label: 'Pass rate', num: true, html: (r) => rate(r.passRate) },
      { key: 'below50', label: 'Below 50%', num: true, html: (r) => r.below50 },
    ], classRows, { sortKey: 'class' });

    renderTable($('#ovTopOnes'), [
      { key: 'form', label: 'Form', html: (r) => `<strong>${esc(r.form)}</strong>` },
      { key: 'name', label: 'Student', html: (r) => esc(r.name) || '&mdash;' },
      { key: 'class', label: 'Class', html: (r) => esc(r.class) },
      { key: 'points', label: 'Total points', num: true, html: (r) => pts(r.points) },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
    ], d.topOnes.map((r) => ({ ...r })));

    const forms = Object.keys(d.topTen);
    if (!state.ovForm || !forms.includes(state.ovForm)) state.ovForm = forms[0];
    const drawTop = () => {
      pillTabs($('#ovTopTabs'), forms.map((f) => [f, `Form ${f}`]), state.ovForm, (v) => { state.ovForm = v; $('#ovTopTen')._st = null; drawTop(); });
      renderTable($('#ovTopTen'), [
        { key: 'rank', label: 'Rank', num: true, html: (r) => `<span class="rank">${r.rank}</span>` },
        { key: 'id', label: 'ID', html: (r) => esc(r.id) },
        { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong>` },
        { key: 'class', label: 'Class', html: (r) => esc(r.class) },
        { key: 'points', label: 'Total points', num: true, html: (r) => `<strong>${pts(r.points)}</strong>` },
        { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
        { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
      ], d.topTen[state.ovForm] || [], { sortKey: 'rank' });
    };
    drawTop();

    renderTable($('#ovBottom'), [
      { key: 'rank', label: '#', num: true, html: (r) => r.rank },
      { key: 'id', label: 'ID', html: (r) => esc(r.id) },
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong>` },
      { key: 'class', label: 'Class', html: (r) => esc(r.class) },
      { key: 'points', label: 'Total points', num: true, html: (r) => pts(r.points) },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
    ], d.bottom, { empty: 'No student is below 50% this term.', sortKey: 'rank' });

    const drawTeachers = () => {
      pillTabs($('#ovTeacherTabs'), [['summary', 'By teacher'], ['detail', 'By class']], state.ovTeacherView, (v) => { state.ovTeacherView = v; $('#ovTeachers')._st = null; drawTeachers(); });
      drawTeacherTable($('#ovTeachers'), d.teachers, state.ovTeacherView);
    };
    drawTeachers();
  }

  function drawTeacherTable(el, teachers, view) {
    if (view === 'summary') {
      renderTable(el, [
        { key: 'rank', label: 'Rank', num: true, html: (r) => r.rank ?? '&mdash;' },
        { key: 'teacher', label: 'Teacher', html: (r) => `<strong>${esc(r.teacher)}</strong>` },
        { key: 'subjects', label: 'Subjects', sort: (r) => r.subjects.join(), html: (r) => esc(r.subjects.join(', ')) },
        { key: 'classes', label: 'Classes', sort: (r) => r.classes.join(), html: (r) => esc(r.classes.join(', ')) },
        { key: 'entries', label: 'Students', num: true, html: (r) => r.entries },
        { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
        { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
        { key: 'passRate', label: 'Pass rate', num: true, html: (r) => rate(r.passRate) },
      ], teachers.summary, { sortKey: 'rank' });
    } else {
      renderTable(el, [
        { key: 'teacher', label: 'Teacher', html: (r) => `<strong>${esc(r.teacher)}</strong>` },
        { key: 'subject', label: 'Subject', html: (r) => esc(r.subject) },
        { key: 'class', label: 'Class', html: (r) => esc(r.class) },
        { key: 'entries', label: 'Students', num: true, html: (r) => r.entries },
        { key: 'marked', label: 'Marked', num: true, html: (r) => r.marked },
        { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
        { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
        { key: 'passRate', label: 'Pass rate', num: true, html: (r) => rate(r.passRate) },
      ], teachers.detail);
    }
  }

  // ---------------- Headmaster: master table ----------------
  async function loadMaster() {
    state.master = await api(`/api/master?term=${state.term}`);
    const classes = [...new Set(state.master.rows.map((r) => r.class))].sort();
    const sel = $('#msClass');
    const prev = sel.value;
    sel.innerHTML = `<option value="">All</option>` + classes.map((c) => `<option>${esc(c)}</option>`).join('');
    sel.value = classes.includes(prev) ? prev : '';
    drawMaster();
  }

  function drawMaster() {
    const m = state.master;
    if (!m) return;
    const cls = $('#msClass').value, status = $('#msStatus').value, q = $('#msSearch').value.trim().toLowerCase();
    const rows = m.rows.filter((r) => (!cls || r.class === cls) && (!status || r.status === status) &&
      (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)));
    $('#msCount').textContent = `${rows.length} of ${m.rows.length} students · ${m.termLabel}`;
    const cols = [
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong><div class="sub">${esc(r.id)}</div>` },
      { key: 'class', label: 'Class', html: (r) => esc(r.class) },
      { key: 'status', label: 'Status', html: (r) => esc(r.status) },
      ...subjectCols(m.subjects, (r, s) => r.subjects[s]),
      { key: 'points', label: 'Total points', num: true, html: (r) => `<strong>${pts(r.points)}</strong>` },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
      { key: 'classRank', label: 'Class rank', num: true, html: (r) => r.classRank ?? '&mdash;' },
      { key: 'formRank', label: 'Form rank', num: true, html: (r) => r.formRank ?? '&mdash;' },
    ];
    const el = $('#msTable');
    renderTable(el, cols, rows, { stickyFirst: true, sortKey: el._st ? undefined : 'class' });
  }
  ['#msClass', '#msStatus'].forEach((s) => $(s).addEventListener('change', drawMaster));
  $('#msSearch').addEventListener('input', drawMaster);

  // ---------------- Head of department ----------------
  async function loadDepartment() {
    const name = $('#deptSelect').value;
    const d = await api(`/api/department?term=${state.term}${name ? '&name=' + encodeURIComponent(name) : ''}`);
    $('#deptPick').hidden = d.available.length < 2;
    $('#deptSelect').innerHTML = d.available.map((n) => `<option>${esc(n)}</option>`).join('');
    $('#deptSelect').value = d.department;
    $('#deptTitle').textContent = `${d.department} department`;
    $('#deptSub').textContent = `Senior Teacher: ${d.hod || '—'} · subjects: ${d.subjects.join(', ')}`;
    $('#deptStats').innerHTML = statCards([
      [d.teachers.summary.length, 'Teachers', 'sage'],
      [d.stats.students, 'Students', 'blush'],
      [pct(d.stats.average), 'Department average', 'sky'],
      [rate(d.stats.passRate), 'Pass rate (50%+)', 'sun'],
    ]);
    renderTable($('#deptSubjects'), [
      { key: 'subject', label: 'Subject', html: (r) => `<strong>${esc(r.subject)}</strong>` },
      { key: 'students', label: 'Students', num: true, html: (r) => r.students },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
    ], d.subjectAverages);
    const draw = () => {
      pillTabs($('#deptTeacherTabs'), [['summary', 'By teacher'], ['detail', 'By class']], state.deptTeacherView, (v) => { state.deptTeacherView = v; $('#deptTeachers')._st = null; draw(); });
      drawTeacherTable($('#deptTeachers'), d.teachers, state.deptTeacherView);
    };
    draw();
    $('#deptStudents')._st = null;
    renderTable($('#deptStudents'), [
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong><div class="sub">${esc(r.id)}</div>` },
      { key: 'class', label: 'Class', html: (r) => esc(r.class) },
      ...subjectCols(d.subjects, (r, s) => r.subjects[s]),
      { key: 'average', label: 'Dept average', num: true, html: (r) => `<strong>${pct(r.average)}</strong>` },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
    ], d.students, { stickyFirst: true, sortKey: 'class' });
  }
  $('#deptSelect').addEventListener('change', () => loadDepartment().catch((e) => showToast(e.message)));

  // ---------------- Registration teacher: my class ----------------
  async function loadClass() {
    const name = $('#classSelect').value;
    const d = await api(`/api/class?term=${state.term}${name ? '&name=' + encodeURIComponent(name) : ''}`);
    $('#classPick').hidden = d.available.length < 2;
    $('#classSelect').innerHTML = d.available.map((n) => `<option>${esc(n)}</option>`).join('');
    $('#classSelect').value = d.class;
    $('#classTitle').textContent = `Class ${d.class}`;
    $('#classSub').textContent = `Registration teacher: ${d.regTeacher || '—'} · ${d.termLabel}`;
    $('#classStats').innerHTML = statCards([
      [d.stats.students, 'Students', 'sage'],
      [d.stats.classPosition ? `${d.stats.classPosition} of ${d.stats.classesCount}` : '—', 'Position among classes', 'sky'],
      [d.stats.below50, 'Students below 50%', 'sun'],
    ]);
    renderTable($('#classSubjects'), [
      { key: 'subject', label: 'Subject', html: (r) => `<strong>${esc(r.subject)}</strong>` },
      { key: 'teacher', label: 'Subject teacher', html: (r) => esc(r.teacher) },
      { key: 'average', label: 'Class average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
      { key: 'passRate', label: 'Pass rate', num: true, html: (r) => rate(r.passRate) },
    ], d.subjectPerformance);
    $('#classStudents')._st = null;
    renderTable($('#classStudents'), [
      { key: 'classRank', label: 'Rank', num: true, html: (r) => `<span class="rank">${r.classRank ?? '—'}</span>` },
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong><div class="sub">${esc(r.id)} · ${esc(r.status)}</div>` },
      ...subjectCols(d.subjects, (r, s) => r.subjects[s]),
      { key: 'points', label: 'Total points', num: true, html: (r) => `<strong>${pts(r.points)}</strong>` },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
    ], d.students, { sortKey: 'classRank' });
  }
  $('#classSelect').addEventListener('change', () => loadClass().catch((e) => showToast(e.message)));

  // ---------------- Matron: boarders ----------------
  async function loadBoarders() {
    const d = await api(`/api/boarders?term=${state.term}`);
    $('#boStats').innerHTML = statCards([
      [d.stats.students, 'Boarders', 'sage'],
      [pct(d.stats.average), 'Boarders’ average %', 'sky'],
      [d.stats.below50, 'Boarders below 50%', 'sun'],
    ]);
    renderTable($('#boClasses'), [
      { key: 'class', label: 'Class', html: (r) => `<strong>${esc(r.class)}</strong>` },
      { key: 'students', label: 'Boarders', num: true, html: (r) => r.students },
      { key: 'averagePoints', label: 'Average points', num: true, html: (r) => pts(r.averagePoints) },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'passRate', label: 'Pass rate', num: true, html: (r) => rate(r.passRate) },
      { key: 'below50', label: 'Below 50%', num: true, html: (r) => r.below50 },
    ], d.byClass, { sortKey: 'class' });
    $('#boStudents')._st = null;
    renderTable($('#boStudents'), [
      { key: 'boardingRank', label: 'Rank', num: true, html: (r) => `<span class="rank">${r.boardingRank ?? '—'}</span>` },
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong><div class="sub">${esc(r.id)}</div>` },
      { key: 'class', label: 'Class', html: (r) => esc(r.class) },
      ...subjectCols(d.subjects, (r, s) => r.subjects[s]),
      { key: 'points', label: 'Total points', num: true, html: (r) => `<strong>${pts(r.points)}</strong>` },
      { key: 'average', label: 'Average %', num: true, html: (r) => pct(r.average) },
      { key: 'grade', label: 'Grade', html: (r) => gradeChip(r.grade) },
      { key: 'classRank', label: 'Class rank', num: true, html: (r) => r.classRank ?? '&mdash;' },
    ], d.students, { stickyFirst: false, sortKey: 'boardingRank' });
  }

  // ---------------- Subject teacher: gradebook ----------------
  async function loadGradebook() {
    if (!state.gb) {
      const d = await api('/api/gradebook');
      state.gb = d.rows;
      const classes = [...new Set(d.rows.map((r) => r.class))].sort();
      const subjects = [...new Set(d.rows.map((r) => r.subject))].sort();
      $('#gbClass').innerHTML = `<option value="">All</option>` + classes.map((c) => `<option>${esc(c)}</option>`).join('');
      $('#gbSubject').innerHTML = `<option value="">All</option>` + subjects.map((c) => `<option>${esc(c)}</option>`).join('');
      $('#gbSub').textContent = `Teaching ${subjects.join(', ')} to classes ${classes.join(', ')}. Enter Paper 1–3 marks; average, percentage, grade and comment are worked out for you and changes save automatically.`;
    }
    drawGradebook();
  }

  function rowKey(r) { return `${r.studentId}||${r.subject}`; }

  function drawGradebook() {
    if (!state.gb) return;
    const cls = $('#gbClass').value, subj = $('#gbSubject').value, t = state.term;
    const rows = state.gb.filter((r) => (!cls || r.class === cls) && (!subj || r.subject === subj));
    $('#gbCount').textContent = `${rows.length} student${rows.length === 1 ? '' : 's'} · ${$$('.term-select')[0].selectedOptions[0].textContent}`;
    $('#gbEmpty').hidden = rows.length > 0;
    $('#gbBody').innerHTML = rows.map((r) => {
      const x = r.terms[t];
      const mark = (i) => `<td><input class="grade-input mark" inputmode="decimal" maxlength="5" data-i="${i}" value="${x.papers[i] ?? ''}" placeholder="—" /></td>`;
      return `<tr data-key="${escAttr(rowKey(r))}">
        <td class="student-name">${esc(r.name)}<div class="sub">${esc(r.studentId)}</div></td>
        <td>${esc(r.class)}</td>
        <td><span class="subject-pill">${esc(r.subject)}</span></td>
        ${mark(0)}${mark(1)}${mark(2)}
        <td class="calc avg">${x.average === null ? '—' : x.average.toFixed(1)}</td>
        <td class="calc pc">${pct(x.percentage)}</td>
        <td class="calc gr">${gradeChip(x.grade)}</td>
        <td><input class="comment-input" type="text" value="${escAttr(x.comment)}" placeholder="${escAttr(x.autoComment || 'Comment')}" /></td>
        <td><span class="row-status"></span></td>
      </tr>`;
    }).join('');
  }
  ['#gbClass', '#gbSubject'].forEach((s) => $(s).addEventListener('change', drawGradebook));

  $('#gbBody').addEventListener('input', (e) => {
    const input = e.target.closest('input');
    if (!input) return;
    const tr = input.closest('tr');
    if (input.classList.contains('mark')) {
      const v = input.value.trim();
      const bad = v !== '' && (isNaN(Number(v)) || Number(v) < 0 || Number(v) > 100);
      input.classList.toggle('invalid', bad);
      if (bad) return;
    }
    const k = tr.dataset.key;
    clearTimeout(saveTimers[k]);
    saveTimers[k] = setTimeout(() => saveRow(tr), 500);
  });

  async function saveRow(tr) {
    const row = state.gb.find((r) => rowKey(r) === tr.dataset.key);
    const t = state.term;
    const papers = Array.from(tr.querySelectorAll('.mark')).map((i) => i.value.trim());
    const comment = tr.querySelector('.comment-input').value.trim();
    const status = tr.querySelector('.row-status');
    try {
      const d = await api('/api/marks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: row.studentId, subject: row.subject, term: t, papers, comment }),
      });
      const r = d.result;
      row.terms[t] = { papers: r.papers, average: r.average, percentage: r.percentage, grade: r.grade, comment, autoComment: r.autoComment };
      tr.querySelector('.avg').textContent = r.average === null ? '—' : r.average.toFixed(1);
      tr.querySelector('.pc').innerHTML = pct(r.percentage);
      tr.querySelector('.gr').innerHTML = gradeChip(r.grade);
      tr.querySelector('.comment-input').placeholder = r.autoComment || 'Comment';
      status.textContent = 'Saved';
      status.classList.add('show');
      setTimeout(() => status.classList.remove('show'), 1200);
    } catch (err) {
      status.textContent = 'Error';
      status.classList.add('show');
      showToast(err.message);
    }
  }

  // ---------------- Report cards (Student Progress Report) ----------------
  let lastRequest = null; // { kind: 'student' | 'class', id }

  async function loadReportOptions() {
    state.rep = await api('/api/report-students');
    const hm = has('headmaster');
    $('#repSub').textContent = hm
      ? 'The Student Progress Report for any student or class, one term at a time. View it here, print it, or download a Word file made from the school template.'
      : `The Student Progress Report for your class (${state.rep.classes.join(', ')}), one term at a time. View it here, print it, or download a Word file made from the school template.`;
    $('#repClass').innerHTML = (hm ? '<option value="">All classes</option>' : '') + state.rep.classes.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#repTerm').value = String(state.term);
    fillRepStudents();
  }
  function fillRepStudents() {
    const c = $('#repClass').value;
    $('#repStudent').innerHTML = state.rep.students.filter((s) => !c || s.class === c)
      .map((s) => `<option value="${escAttr(s.id)}">${esc(s.name)} (${esc(s.class)})</option>`).join('');
  }
  $('#repClass').addEventListener('change', fillRepStudents);

  async function showReports(request) {
    lastRequest = request;
    const term = $('#repTerm').value;
    const list = request.kind === 'student'
      ? [await api(`/api/report/${encodeURIComponent(request.id)}?term=${term}`)]
      : await api(`/api/reports/class/${encodeURIComponent(request.id)}?term=${term}`);
    renderReports(list);
  }

  $('#viewReportBtn').addEventListener('click', () => {
    const id = $('#repStudent').value;
    if (id) showReports({ kind: 'student', id }).catch((e) => showToast(e.message));
  });
  $('#viewClassBtn').addEventListener('click', () => {
    const c = $('#repClass').value;
    if (!c) { showToast('Choose a class first.'); return; }
    showReports({ kind: 'class', id: c }).catch((e) => showToast(e.message));
  });
  // changing the term re-loads whatever is on screen for that term
  $('#repTerm').addEventListener('change', () => { if (lastRequest) showReports(lastRequest).catch((e) => showToast(e.message)); });
  $('#printBtn').addEventListener('click', () => window.print());

  async function downloadWord(query, label) {
    try {
      const res = await fetch(`/api/report-docx?${query}&term=${$('#repTerm').value}`, { headers: { 'x-session': state.token || '' } });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Could not build the Word file.'); }
      const cd = res.headers.get('Content-Disposition') || '';
      const name = (cd.match(/filename="([^"]+)"/) || [])[1] || 'Progress_Report.docx';
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast(label + ' downloaded');
    } catch (e) { showToast(e.message); }
  }
  $('#docxStudentBtn').addEventListener('click', () => {
    const id = $('#repStudent').value;
    if (id) downloadWord(`student=${encodeURIComponent(id)}`, 'Report');
  });
  $('#docxClassBtn').addEventListener('click', () => {
    const c = $('#repClass').value;
    if (!c) { showToast('Choose a class first.'); return; }
    downloadWord(`class=${encodeURIComponent(c)}`, 'Class reports');
  });

  // On-screen version of the school's template (same layout and wording as the Word file)
  function renderReports(reports) {
    const area = $('#reportArea');
    if (!reports.length) { area.innerHTML = '<p class="empty-note">No students to show.</p>'; return; }
    const blank = (n) => '_'.repeat(n);
    const line = (v, n) => (v === '' || v === null || v === undefined ? `<span class="fill">${blank(n)}</span>` : `<span class="fill filled">${esc(v)}</span>`);
    area.innerHTML = reports.map((r) => {
      const rows = r.rows.map((x) => x.blank
        ? `<tr><td class="subj">${esc(x.label)}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
        : `<tr><td class="subj">${esc(x.label)}</td>
            <td class="c">${x.termMark ?? ''}</td><td class="c">${x.examMark ?? ''}</td>
            <td class="c">${esc(x.grade)}</td><td class="c">${x.points === null || x.points === undefined ? '' : x.counted ? x.points : `(${x.points})`}</td>
            <td class="cm">${esc(x.comment)}</td><td>${esc(x.teacherSurname)}</td></tr>`).join('');
      const hasUncounted = r.rows.some((x) => !x.blank && x.points !== null && x.points !== undefined && !x.counted);
      return `<article class="progress-report">
        <div class="pr-head">
          <div class="pr-left"><img src="img/crest.png" alt="" /><b>REPUBLIC OF BOTSWANA<br>MINISTRY OF BASIC EDUCATION</b></div>
          <div class="pr-school"><b>RAKOPS JUNIOR SECONDARY SCHOOL</b><br>PRIVATE BAG 002<br>RAKOPS, BOTSWANA<br>TEL: 2975117 &nbsp; FAX: 2975118</div>
          <div class="pr-right"><img src="img/school-badge.png" alt="" /></div>
        </div>
        <h3 class="pr-title">STUDENT PROGRESS REPORT <span>&middot; ${esc(r.termLabel)}</span></h3>
        <p><b>Name of School:</b> RAKOPS JUNIOR SECONDARY SCHOOL &nbsp;&nbsp;&nbsp;&nbsp; <b>Admission No:</b> ${line(r.admissionNo, 12)}</p>
        <p><b>Student Name:</b> ${line(r.studentName, 30)} &nbsp; <b>Class:</b> ${line(r.class, 6)} &nbsp; <b>Attendance:</b> ${blank(8)}</p>
        <p><b>Number in Class:</b> ${line(r.classSize, 6)} &nbsp; <b>Term Ending:</b> __ / __ / ____ &nbsp; <b>Schools Re-Opens:</b> __ / __ / ____</p>
        <table class="pr-table">
          <thead><tr><th>Subject</th><th>Term<br>Mark</th><th>Exam<br>Mark</th><th>Subject<br>Grade</th><th>Points</th><th>Subject Teacher&rsquo;s Comments</th><th>Teacher&rsquo;s<br>Surname</th></tr></thead>
          <tbody>${rows}
            <tr class="pr-total"><td class="subj"><b>TOTAL POINTS</b></td><td></td><td></td><td></td><td class="c"><b>${r.totalPoints ?? ''}</b></td><td></td><td></td></tr>
          </tbody>
        </table>
        ${hasUncounted ? '<p class="pr-note">Total points = core subjects + best 2 of Social Education, Agriculture and Moral Education + best 1 option. Points in ( ) are not counted.</p>' : ''}
        <p><b>Co-Curricular Activities:</b> ${blank(32)}</p>
        <p><b>Owing School Fees:</b> ${blank(32)}</p>
        <p><b>Class Teacher&rsquo;s Remarks:</b> ${blank(32)}</p>
        <p>${blank(70)}</p>
        <p><b>Class Teacher&rsquo;s Name:</b> ${line(r.classTeacher, 20)} &nbsp; <b>Signature:</b> ${blank(14)} &nbsp; <b>Date:</b> ${blank(10)}</p>
        <p><b>Head of House / Senior Teacher Remarks:</b> ${blank(32)}</p>
        <p>${blank(70)}</p>
        <p><b>School Head&rsquo;s Name:</b> ${line(r.headName, 20)} &nbsp; <b>Signature:</b> ${blank(14)} &nbsp; <b>Date:</b> ${blank(10)}</p>
        <p class="pr-stamp">[ School stamp ]</p>
      </article>`;
    }).join('');
  }

  // ---------------- Staff & roles ----------------
  async function loadStaff() {
    const c = await api('/api/staff-config');
    $('#staffForm').innerHTML = `
      <div class="staff-row"><label for="stHead">Headmaster</label><input id="stHead" type="text" value="${escAttr(c.headmaster)}" /></div>
      <div class="staff-row"><label for="stMatrons">Matrons <span class="hint">one name per line</span></label><textarea id="stMatrons" rows="3">${esc(c.matrons.join('\n'))}</textarea></div>
      <h3>Senior Teachers</h3>
      ${c.departments.map((d) => `<div class="staff-row"><label>${esc(d.name)} <span class="hint">${esc(d.subjects.join(', '))}</span></label>
        <select data-dept="${escAttr(d.name)}">${c.teachers.map((t) => `<option${t === d.hod ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`).join('')}
      <button type="submit" class="btn btn-primary">Save roles</button>`;
  }

  $('#staffForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#staffStatus');
    const hods = {};
    $$('#staffForm select[data-dept]').forEach((s) => { hods[s.dataset.dept] = s.value; });
    try {
      const c = await api('/api/staff-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headmaster: $('#stHead').value, matrons: $('#stMatrons').value.split('\n'), hods }),
      });
      state.staff = c.staff;
      populateStaffSelect();
      state.user = await api('/api/me');
      renderTabs();
      box.hidden = false; box.className = 'status-msg success'; box.textContent = 'Roles saved.';
    } catch (err) {
      box.hidden = false; box.className = 'status-msg error'; box.textContent = err.message;
    }
  });

  // ---------------- Export scope text ----------------
  function describeExport() {
    const parts = [];
    if (has('headmaster')) parts.push('everything: the full gradebook (all papers, grades and comments per term), master table, class averages and teacher performance');
    else {
      if (state.user.teaches) parts.push(`the gradebook for your own students (${state.user.subjectsTaught ? state.user.subjectsTaught.join(', ') : 'your subjects'})`);
      if (has('class_teacher')) parts.push(`your class (${state.user.classes.join(', ')}): every subject plus a class performance sheet`);
      if (has('hod')) parts.push(`your department (${state.user.departments.join(', ')}): its students’ marks plus a department teachers sheet`);
    }
    $('#exportWhat').textContent = 'Includes ' + parts.join('; and ') + '.';
  }

  // ---------------- Register students ----------------
  async function loadRegister() {
    const cls = $('#regClass').value;
    const d = await api('/api/register-info' + (cls ? `?class=${encodeURIComponent(cls)}` : ''));
    $('#regClass').innerHTML = d.classes.map((c) => `<option>${esc(c)}</option>`).join('');
    $('#regClass').value = d.class;
    // students in a class share a subject teacher: where the class already has one it is fixed
    $('#regSubjects').innerHTML = d.subjects.map((s, i) => `
      <label class="reg-subject-row"><input type="checkbox" data-i="${i}" ${d.compulsory.includes(s.subject) ? 'checked disabled' : ''} />
        <span class="reg-subj">${esc(s.subject)}</span>
        ${s.classTeacher
          ? `<span class="fixed-teacher" data-subject="${escAttr(s.subject)}" data-teacher="${escAttr(s.classTeacher)}">${esc(s.classTeacher)} <em>(class teacher)</em></span>`
          : `<select data-subject="${escAttr(s.subject)}"><option value="">Choose a teacher…</option>${s.teachers.map((t) => `<option>${esc(t)}</option>`).join('')}</select>`}
      </label>`).join('');
    $('#regSubjectsHint').textContent = `Compulsory subjects are fixed. Choose the student's optional subjects (usually 2).`;
    $('#regListTitle').textContent = `Students in class ${d.class} (${d.students.length})`;
    $('#regList')._st = null;
    renderTable($('#regList'), [
      { key: 'id', label: 'ID', html: (r) => esc(r.id) },
      { key: 'name', label: 'Student', html: (r) => `<strong>${esc(r.name)}</strong>` },
      { key: 'status', label: 'Status', html: (r) => esc(r.status) },
    ], d.students, { sortKey: 'id' });
  }
  $('#regClass').addEventListener('change', () => loadRegister().catch((e) => showToast(e.message)));

  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const box = $('#regStatusMsg');
    const subjects = $$('#regSubjects .reg-subject-row').filter((r) => r.querySelector('input').checked)
      .map((r) => {
        const fixed = r.querySelector('.fixed-teacher');
        if (fixed) return { subject: fixed.dataset.subject, teacher: fixed.dataset.teacher };
        const sel = r.querySelector('select');
        return { subject: sel.dataset.subject, teacher: sel.value };
      });
    const btn = $('#regBtn');
    btn.disabled = true;
    try {
      const d = await api('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ class: $('#regClass').value, name: $('#regName').value, status: $('#regStatus').value, subjects }),
      });
      box.hidden = false; box.className = 'status-msg success';
      box.textContent = `Registered ${d.student.name} in class ${d.student.class} with student ID ${d.student.id} (${subjects.length} subjects).`;
      $('#regName').value = '';
      state.master = null; state.gb = null; state.rep = null;
      await loadRegister();
    } catch (err) {
      box.hidden = false; box.className = 'status-msg error'; box.textContent = err.message;
    } finally { btn.disabled = false; }
  });

  // ---------------- Export ----------------
  $('#exportBtn').addEventListener('click', async () => {
    const box = $('#exportStatus');
    box.hidden = true;
    try {
      const res = await fetch('/api/export', { headers: { 'x-session': state.token || '' } });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Could not export.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'school-gradebook-export.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      showToast('Export downloaded');
    } catch (err) {
      box.hidden = false; box.className = 'status-msg error'; box.textContent = err.message;
    }
  });

  // ---------------- Boot ----------------
  async function boot() {
    fillTermSelects();
    try {
      const s = await fetch('/api/status').then((r) => r.json());
      state.hasData = s.hasData;
      state.staff = s.staff;
      populateStaffSelect();
      if (s.hasData) {
        const box = $('#importStatus');
        box.hidden = false; box.className = 'status-msg success';
        box.textContent = `A workbook is already loaded (${s.students} students, ${s.classes} classes, ${s.teachers} teachers). Importing again replaces the roster.`;
        $('#sumStudents').textContent = s.students;
        $('#sumClasses').textContent = s.classes;
        $('#sumTeachers').textContent = s.teachers;
        $('#sumAssignments').textContent = '—';
        $('#importSummary').hidden = false;
      }
      if (state.token) {
        try {
          state.user = await api('/api/me');
          state.term = state.user.defaultTerm || 3;
          fillTermSelects();
        } catch (_) { state.token = null; sessionStorage.removeItem('fs-token'); }
      }
    } catch (err) { console.error(err); }
    setActiveTab(state.user ? firstTabFor() : state.hasData ? 'login' : 'import');
  }

  boot();
})();
