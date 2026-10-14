/**
 * reportDocx.js
 * -------------
 * Fills the school's own Word template (templates/Report_Card_Template.docx) with report data -
 * one page per student - and returns the .docx as a Buffer. The template's layout, fonts,
 * logos and wording are left exactly as the school made them; only the blanks are filled:
 *
 *   Admission No / Student Name / Class / Number in Class
 *   each subject row: Term Mark, Exam Mark, Subject Grade, Points, Subject Teacher's Comments, Teacher's Surname
 *   TOTAL POINTS, Class Teacher's Name, School Head's Name
 *
 * Attendance, term dates, co-curricular activities, fees, remarks, signatures and dates are
 * left as blank lines for handwriting, as on the printed form.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, 'templates', 'Report_Card_Template.docx');

const escXml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escRe = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMPTY_T = /<w:t xml:space="preserve"(?:\/>|><\/w:t>)/;

/** Replaces the "______" that follows `label` with `value` (underlined, like a filled-in line). */
function fillAfter(xml, label, value) {
  if (value === null || value === undefined || value === '') return xml;
  const re = new RegExp(`(${escRe(label)}</w:t></w:r><w:r><w:rPr>(?:(?!</w:rPr>).)*)(</w:rPr><w:t xml:space="preserve">)_+(</w:t>)`, 's');
  if (!re.test(xml)) throw new Error(`Report template has no blank after "${label.trim()}"`);
  return xml.replace(re, (m, a, b, c) => `${a}<w:u w:val="single"/>${b}${escXml(value)}${c}`);
}

/** Fills one table cell (the template's empty run) with text. */
function fillCell(cellXml, text, { center = false, bold = false, size = null } = {}) {
  let c = cellXml;
  if (center) c = c.replace('<w:spacing w:after="0" w:before="0"/>', '<w:spacing w:after="0" w:before="0"/><w:jc w:val="center"/>');
  if (bold) c = c.replace(/(<w:rFonts [^>]*\/>)/, '$1<w:b/><w:bCs/>');
  if (size) c = c.replace('<w:sz w:val="20"/><w:szCs w:val="20"/>', `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  if (text === null || text === undefined || text === '') return c;
  return c.replace(EMPTY_T, () => `<w:t xml:space="preserve">${escXml(text)}</w:t>`);
}

function fillRow(rowXml, cells) {
  const parts = rowXml.match(/<w:tc>.*?<\/w:tc>/gs);
  if (!parts || parts.length !== 7) throw new Error('Report template table does not have 7 columns');
  let i = 0;
  return rowXml.replace(/<w:tc>.*?<\/w:tc>/gs, () => {
    const spec = cells[i];
    const original = parts[i++];
    return spec ? fillCell(original, spec.text, spec) : original;
  });
}

function fillMarksTable(tableXml, report) {
  const rows = tableXml.match(/<w:tr>.*?<\/w:tr>/gs);
  const header = rows[0];
  const subjectRows = rows.slice(1, -1);
  const totalRow = rows[rows.length - 1];
  if (subjectRows.length !== 11) throw new Error('Report template should have 11 subject rows');

  const labelOf = (rowXml) => (rowXml.match(/<w:t xml:space="preserve">([^<]*)<\/w:t>/) || [])[1];
  const byLabel = new Map(subjectRows.map((r) => [labelOf(r), r]));
  const spare = subjectRows[subjectRows.length - 1];

  const body = report.rows.map((r) => {
    // a subject that is not printed on the form gets a row of its own, styled like the others
    const base = byLabel.get(r.label) || spare.replace(`>${escXml(labelOf(spare))}<`, `>${escXml(r.label)}<`);
    if (r.blank) return base;
    const pts = r.points === null || r.points === undefined ? '' : r.counted ? String(r.points) : `(${r.points})`;
    return fillRow(base, [
      null,
      { text: r.termMark ?? '', center: true },
      { text: r.examMark ?? '', center: true },
      { text: r.grade || '', center: true },
      { text: pts, center: true },
      { text: r.comment || '', size: 18 },
      { text: r.teacherSurname || '' },
    ]);
  });
  const total = fillRow(totalRow, [
    { text: undefined, bold: true },
    null, null, null,
    { text: report.totalPoints ?? '', center: true, bold: true },
    null, null,
  ]);
  const tableOpen = tableXml.slice(0, tableXml.indexOf(rows[0]));
  let table = tableOpen + header + body.join('') + total + '</w:tbl>';
  // a student with extra subject rows (e.g. Religious Education) gets slightly shorter rows
  // so the report still fits on one page
  const extra = report.rows.length - subjectRows.length;
  if (extra > 0) {
    const h = Math.max(440, 600 - 70 * extra);
    table = table.replace(/<w:trHeight w:val="600"/g, `<w:trHeight w:val="${h}"`);
  }
  return table;
}

function fillBody(body, report) {
  let x = body;
  x = fillAfter(x, 'Admission No: ', report.admissionNo);
  x = fillAfter(x, 'Student Name: ', report.studentName);
  x = fillAfter(x, '     Class: ', report.class);
  x = fillAfter(x, 'Number in Class: ', report.classSize);
  x = fillAfter(x, "Class Teacher&apos;s Name: ", report.classTeacher);
  x = fillAfter(x, "School Head&apos;s Name: ", report.headName);

  // the marks table is the one whose first row says "Subject"
  const tables = [...x.matchAll(/<w:tbl>.*?<\/w:tbl>/gs)];
  const marks = tables.find((t) => t[0].includes('>Subject<'));
  if (!marks) throw new Error('Report template has no marks table');
  let replaced = fillMarksTable(marks[0], report);

  // footnote in the template's spacer paragraph under the table
  if (report.rows.some((r) => !r.blank && r.points !== null && r.points !== undefined && !r.counted)) {
    const note = `<w:p><w:pPr><w:spacing w:after="120" w:before="40"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:cs="Times New Roman" w:eastAsia="Times New Roman" w:hAnsi="Times New Roman"/><w:i/><w:iCs/><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr><w:t xml:space="preserve">Total points = core subjects + best 2 of Social Education, Agriculture and Moral Education + best 1 option. Points in ( ) are not counted.</w:t></w:r></w:p>`;
    const after = x.indexOf(marks[0]) + marks[0].length;
    const spacer = /<w:p><w:pPr><w:spacing w:after="120" w:before="0"\/><\/w:pPr><w:r>(?:(?!<\/w:r>).)*<w:t xml:space="preserve"><\/w:t><\/w:r><\/w:p>/s;
    const rest = x.slice(after).replace(spacer, note);
    return x.slice(0, x.indexOf(marks[0])) + replaced + rest;
  }
  return x.slice(0, x.indexOf(marks[0])) + replaced + x.slice(x.indexOf(marks[0]) + marks[0].length);
}

/** reports = array of A.progressReport(...) results. Returns a Buffer (.docx). */
async function buildReportsDocx(reports) {
  if (!reports.length) throw new Error('No reports to build.');
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE_PATH));
  const xml = await zip.file('word/document.xml').async('string');

  const bodyStart = xml.indexOf('<w:body>') + '<w:body>'.length;
  const sectStart = xml.lastIndexOf('<w:sectPr');
  const head = xml.slice(0, bodyStart);
  const body = xml.slice(bodyStart, sectStart);
  const tail = xml.slice(sectStart);

  const pages = reports.map((r, i) => {
    let page = fillBody(body, r);
    if (i < reports.length - 1) {
      // page break at the end of the last paragraph (avoids an empty line at the top of the next page)
      const end = page.lastIndexOf('</w:p>');
      page = page.slice(0, end) + '<w:r><w:br w:type="page"/></w:r>' + page.slice(end);
    }
    return page;
  });

  let id = 0;
  const composed = (head + pages.join('') + tail).replace(/<wp:docPr id="\d+"/g, () => `<wp:docPr id="${++id}"`);
  zip.file('word/document.xml', composed);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { buildReportsDocx };
