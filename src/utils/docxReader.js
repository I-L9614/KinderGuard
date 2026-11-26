import { unzipSync } from 'fflate';
import { Parser } from 'saxen';

// Reads the FIRST table of a .docx as a grid of strings. No model, no macros, no network, no field evaluation.
// Same safety posture as the xlsx reader: limits are checked from the zip directory BEFORE anything is inflated, only
// word/document.xml is ever inflated, and XML with a DOCTYPE or ENTITY declaration is refused outright.
// Merged cells and nested tables are refused rather than guessed, so a row can never silently shift columns.
export const DOCX_LIMITS = { entries: 300, docBytes: 20 * 1024 * 1024, rows: 2000, cols: 50, cell: 500 };
export class DocxError extends Error { constructor(message) { super(message); this.userMessage = message; this.statusCode = 400; } }
const bad = (m) => { throw new DocxError(m); };
const local = (n) => String(n).split(':').pop();

export const readDocxFirstTable = (buf) => {
  const L = DOCX_LIMITS;
  if (!Buffer.isBuffer(buf) || buf.length < 22) bad('הקובץ ריק או פגום.');
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) bad('קובץ Word ישן (doc) או מוגן בסיסמה אינו נתמך. שמרו אותו כ-docx רגיל בלי סיסמה.');
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) bad('הקובץ אינו קובץ docx תקין.');
  const names = []; let docEntry = false;
  let parts;
  try {
    parts = unzipSync(new Uint8Array(buf), { filter: (f) => {
      names.push(f.name); if (names.length > L.entries) bad('בקובץ יותר מדי רכיבים.');
      if (f.name === '[Content_Types].xml') { if (f.originalSize > 1024 * 1024) bad('אחד מרכיבי הקובץ גדול מדי.'); return true; }
      if (f.name !== 'word/document.xml') return false;
      if (f.originalSize > L.docBytes) bad('המסמך גדול מדי.');
      docEntry = true; return true;
    } });
  } catch (e) { if (e instanceof DocxError) throw e; bad('הקובץ פגום או אינו docx.'); }
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) bad('קובץ עם מאקרו אינו נתמך. שמרו אותו כ-docx בלי מאקרו.');
  const ct = parts['[Content_Types].xml'] ? new TextDecoder('utf-8').decode(parts['[Content_Types].xml']) : '';
  if (/macroEnabled/i.test(ct)) bad('קובץ עם מאקרו אינו נתמך. שמרו אותו כ-docx בלי מאקרו.');
  if (!docEntry || !parts['word/document.xml']) bad('הקובץ אינו קובץ docx תקין.');
  const xml = new TextDecoder('utf-8').decode(parts['word/document.xml']).replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) bad('הקובץ מכיל הגדרות XML לא בטוחות ולכן לא נקרא.');
  const rows = []; const problems = []; let depth = 0; let done = false; let row = null; let cell = null; let inT = false; let truncated = false; let failed = false;
  const p = new Parser();
  p.on('openTag', (n0) => {
    const n = local(n0); if (done) return;
    if (n === 'tbl') { depth += 1; if (depth > 1) bad('טבלה בתוך טבלה אינה נתמכת.'); return; }
    if (!depth) return;
    if (n === 'gridSpan' || n === 'hMerge' || n === 'vMerge') bad('בטבלה יש תאים ממוזגים, ולכן לא ניתן לקרוא אותה בבטחה. בטלו את המיזוג או שמרו כ-xlsx.');
    if (n === 'tr') { if (rows.length >= L.rows) { truncated = true; row = null; return; } row = []; rows.push(row); } else if (n === 'tc' && row) cell = ''; else if (n === 't' && cell !== null) inT = true;
    else if ((n === 'br' || n === 'tab') && cell !== null) cell += ' ';
  });
  p.on('closeTag', (n0) => {
    const n = local(n0); if (done || !depth) return;
    if (n === 't') inT = false;
    else if (n === 'p' && cell !== null && cell && !cell.endsWith(' ')) cell += ' ';
    else if (n === 'tc' && row && cell !== null) { if (row.length < L.cols) row.push(cell.replace(/\s+/g, ' ').trim().slice(0, L.cell)); cell = null; }
    else if (n === 'tbl') { depth -= 1; if (!depth) done = true; }
  });
  p.on('text', (t, dec) => { if (inT && cell !== null && !done) cell += dec(t); });
  p.on('error', () => { failed = true; });
  p.parse(xml);
  if (failed) bad('מבנה הקובץ אינו תקין.');
  if (!rows.length) bad('לא נמצאה טבלה במסמך. הדביקו את הנתונים בטבלה או העלו xlsx או CSV.');
  if (truncated) problems.push(`נקראו ${L.rows} השורות הראשונות בלבד`);
  return { rows: rows.filter((r) => r.some((c) => c !== '')), problems };
};
