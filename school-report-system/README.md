# Fieldstone — School Report Card System

A lightweight, no-database school performance and report-card system
(Node.js/Express + plain HTML/JS). It reads the school's Excel workbook, lets
subject teachers enter marks, and gives each kind of staff member the view they
need. Data is held in memory and mirrored to small JSON files in `data/`.

## Setup

```bash
npm install        # installs express, multer, xlsx and jszip (for the Word reports)
npm start          # then open http://localhost:3000
```

Optional: `npm run generate-sample` writes `data/sample-import.xlsx`, a small
example in the same layout as the real workbook.

## The workbook layout the importer reads

| Sheet | What the app takes from it |
|---|---|
| `Registration 1A`, `Registration 1B` … | Registration teacher, class, each student (ID, name, Day Scholar / Boarder) and their subjects + subject teachers. ID/name/status may be merged down the student's rows — that's handled. |
| `Assessments 1A`, `Assessment 1B` … | Paper 1–3 marks for **Term 1, Term 2, Term 3 / Final Exam**. Term columns are found from the header rows, so extra/blank calculated columns don't matter. |

Everything else in the workbook (Students Avg, Top 10, Top Ones, Bottom Students, Class Avg,
Teachers Performance, the per-teacher sheets, Boarders, Day Scholars) is **calculated by the app**
and ignored on import. Sheet names are matched loosely (`Assessment` / `Assessments`).

Calculation rules (same as the workbook's formulas): average mark = mean of the papers entered;
percentage = average / 100; grade A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, else F; student average = mean
of subject percentages; the comment is generated from grade + subject (a teacher can overwrite it).
Tables and rankings default to **Term 3 / Final Exam** (as in the workbook); every view has a term picker.

Re-importing: marks present in the file replace those in the app; blank cells keep marks already
entered in the app (if the same teacher still teaches that student/subject). Problems found
(e.g. a teacher that differs between sheets, marks outside 0–100) are listed after import.

## Roles — who sees what

Sign in by choosing a name (no passwords). Roles are worked out from the data, and a person can
hold several (e.g. Mr. Sebina is registration teacher of 1A *and* teaches English).
Permissions are enforced on the server (`api.js`), not just hidden in the page.

| Role | How they're identified | What they can do |
|---|---|---|
| **Headmaster** | `staff.json` | Whole school: class averages, top achiever per form, top 10 per form, students below 50%, teacher performance (by teacher and by class), master table of every student (all subjects, average, grade, class/form rank), all report cards, register students into any class, staff & roles, import, full export |
| **Head of department** | Set in *Staff & roles* | Their department's teachers and the students who take its subjects (per-subject marks and department average); export their department |
| **Subject teacher** | A teacher on the Registration sheets | Only the students they teach (e.g. Mr. Mmusi: Physical Education in 1B, 2B, 3B); enter Paper 1–3 marks per term; export their own gradebook |
| **Registration teacher** | Named on a Registration sheet | Their own class: class average, position among classes, subject performance, every student's marks and rank, class report cards, **register new students** into their class, export their class |
| **Matron** | Set in *Staff & roles* | Boarding students' performance (table + by class, compared with day scholars). Matrons cannot export |

**First-run defaults to review:** the workbook doesn't say who the headmaster, heads of department or
matrons are. The app creates a placeholder `Headmaster` and `Matron` account, groups the 12 subjects into
4 departments (Languages; Mathematics & Science; Humanities; Practical & Business Studies) and picks a
teacher of each department as its head. Sign in as Headmaster → **Staff & roles** to set the real people.
Department groupings can be edited in `data/staff.json`.

## Points, grades and the progress report

**Grades & points:** A = 9, B = 7, C = 5, D = 3, E = 1 (A ≥ 80%, B ≥ 70%, C ≥ 60%, D ≥ 50%, below 50% = E).

**Total points** (a student's overall score, out of 63) =
points for the **core subjects** (English, Setswana, Mathematics, Science)
+ the **2 best of** Social Studies, Agriculture and Moral Education
+ the **1 best of** the student's optional subjects (everything else they take).
Students are ranked by total points (equal points are separated by average %). This is used for class/form ranks,
Top 10, top achiever, class and boarder tables. The rule lives at the top of `analytics.js` if it ever changes.

**Student Progress Report** uses the school's own template (`templates/Report_Card_Template.docx`), one term at a time
(Term filter: Term 1 / Term 2 / Term 3 / Final Exam):
- *View* on screen (same layout), *Print*, or *Word* — a real `.docx` filled from the template, for one student or a whole
  class (one page per student). Only the blanks are filled: Admission No, name, class, number in class, each subject's
  Term Mark / Exam Mark / Grade / Points / comment / teacher's surname, TOTAL POINTS, class teacher's name and (if set) the head's name.
  Attendance, dates, co-curricular, fees, remarks, signatures and the stamp stay blank for handwriting.
- **Term Mark** = average of Paper 1 and Paper 2; **Exam Mark** = Paper 3 (the subject grade/points use the average of all
  three papers, as in the school workbook). Change `TERM_MARK_PAPERS` / `EXAM_MARK_PAPERS` in `analytics.js` if the school splits them differently.
- Points shown in ( ) are subjects not counted in the total. Religious Education isn't on the template, so students who take it
  get an extra row. The template's label "Social Education" is kept as printed (it is "Social Studies" in the workbook).

## Subject teachers are per class

Students in the same class always have the same teacher for a subject. On import, if the workbook lists two teachers for the same
subject in one class, the one teaching most of the class is used for everyone and a warning is shown. When registering a student, the
class's teachers are fixed (a teacher can only be chosen for a subject nobody in the class takes yet).

## Export, registering students

- **Export to Excel**: every role except the matron, scoped to what that role may see — a subject teacher gets their own students; a
  registration teacher their class (+ a class performance sheet); a head of department their department (+ a department teachers
  sheet); the headmaster everything.
- **Register students** (registration teachers, and the headmaster): name, boarder/day scholar and subjects. The 7 compulsory subjects
  are fixed; choose the optional subjects (at least one). The new student gets the next ID (e.g. STU181) and the class's subject
  teachers, and appears in those teachers' gradebooks, the class views, the matron's boarder list (if boarding) and reports at once.
  A student's name must be unique within a class.

## Notes

- Exact ties (same points and same average %) share a rank (the workbook's Top 10 broke ties by row order).
- "Pass" means 50% or more (grade D or better).
- No real authentication: anyone can sign in as anyone. Add passwords/SSO before using outside a trusted network.
- Import is open only while no roster exists; afterwards only the headmaster can import.

## Project structure

```
server.js        Express routes, sessions
api.js           Role rules for every view/action
analytics.js     Grades, averages, rankings, all the tables (pure functions)
dataStore.js     Excel import, marks, staff/roles, JSON persistence
reportDocx.js    Fills the Word report template (one page per student)
templates/       Report_Card_Template.docx (the school's own template)
generateSample.js
public/          index.html, app.js, styles.css
data/            roster.json, marks.json, staff.json (created at runtime)
```
