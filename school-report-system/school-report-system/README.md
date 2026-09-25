# Fieldstone — School Report Card System

A lightweight, no-database report card workbench: import a class roster from
Excel, let each teacher enter grades and comments, then generate printable
report cards and a record-keeping export — all in Node.js/Express + plain
HTML/JS, with data held in memory and mirrored to two small JSON files so it
survives a restart during the same term.

## 1. Setup (in VS Code)

```bash
# from the project folder, in the VS Code terminal
npm install
```

That installs three packages: `express`, `multer` (file uploads), and
`xlsx` (Excel read/write).

## 2. (Optional) generate a sample roster to play with

```bash
npm run generate-sample
```

This writes `data/sample-import.xlsx` — a ready-made file with a few
students, subjects, and teachers (including one teacher who teaches more
than one subject/student, and one student who has multiple teachers), so
you can try the whole flow immediately.

## 3. Run the app

```bash
npm start
```

Then open **http://localhost:3000** in your browser.

## 4. Using it

1. **Import roster** — upload an `.xlsx` file with three columns: `Student`,
   `Subject`, `Teacher` (one row per subject assignment — e.g. `Sam | Science
   | Mrs. Cat`, `Sam | Maths | Mrs. Whitfield`). Column names are matched
   case-insensitively. Re-importing replaces the roster but keeps existing
   grades/comments for any assignment that's unchanged.
2. **Teacher login** — pick a teacher from the dropdown (no password — this
   is a simple simulation of "logging in" as different staff).
3. **My gradebook** — the teacher sees only their own students/subjects, and
   can type a grade and a comment per row. Each field autosaves about half a
   second after you stop typing (look for the "Saved" tag on the right).
4. **Report cards** — pick one student to view their report card (pulling
   together every subject, from every teacher, with grades and comments), or
   click "View all report cards" to generate one for the whole roster. Use
   "Print" to print or save as PDF — each report card is its own page. There's
   a signature line placeholder at the bottom for the headmaster.
5. **Export** — downloads `gradebook-export.xlsx`, one row per subject
   assignment with Student, Subject, Teacher, Grade and Comment, for
   record-keeping.

## Data model

- `assignments`: the roster — a flat list of `{ student, subject, teacher }`
  built directly from the imported spreadsheet.
- `gradebook`: keyed by `Student||Subject`, storing `{ teacher, grade,
  comment }`.

Both are kept in memory while the server runs and written to
`data/assignments.json` and `data/gradebook.json` after every change, so a
restart mid-term won't lose work. Delete those two files (or just stop
worrying about them) whenever you want a completely clean slate — the brief
treats a full reset between server runs as perfectly fine.

## Project structure

```
school-report-system/
├── server.js           Express app + all API routes
├── dataStore.js         In-memory data + Excel import/export logic
├── generateSample.js     Creates a sample .xlsx roster for testing
├── package.json
├── data/                 Persisted JSON + sample roster (created at runtime)
├── uploads/              Scratch space for uploaded files (auto-cleaned)
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

## API reference

| Method | Route                          | Purpose                                  |
|--------|---------------------------------|-------------------------------------------|
| GET    | `/api/status`                   | Whether data is loaded, teacher/student lists |
| POST   | `/api/import`                   | Upload & parse an `.xlsx` roster (`multipart/form-data`, field `file`) |
| GET    | `/api/teachers`                 | List of teacher names |
| GET    | `/api/students`                 | List of student names |
| GET    | `/api/teacher/:name/students`   | A teacher's students/subjects with current grade+comment |
| POST   | `/api/grade`                    | Save a grade/comment `{ teacher, student, subject, grade, comment }` |
| GET    | `/api/report/:student`          | Full report card data for one student |
| GET    | `/api/reports`                  | Report card data for every student |
| GET    | `/api/export`                   | Downloads the full gradebook as `.xlsx` |

## Notes / next steps if you outgrow this

- This intentionally has no real auth — anyone can "log in" as any teacher.
  If this ever leaves a trusted local/staff network, add real authentication
  before relying on it.
- No database means data resets if you delete the `data/` folder or deploy
  fresh — swap `dataStore.js` for a real DB-backed module later without
  touching the frontend, since it talks to `dataStore` through the same
  small set of functions.
