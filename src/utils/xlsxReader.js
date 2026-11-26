import { unzipSync } from 'fflate';
import { Parser } from 'saxen';

// Reads the FIRST visible sheet of an .xlsx as a grid of strings. No model, no formulas evaluated, no macros, no network.
// Safety limits are enforced BEFORE anything is inflated (fflate reads sizes from the zip directory and we cap them; the
// output buffer is allocated at the declared size, so a lying directory cannot make us write more than the cap).
// XML with a DOCTYPE or ENTITY declaration is refused outright (no entity expansion, no external entities).
export const XLSX_LIMITS = { entries: 300, sheetBytes: 20 * 1024 * 1024, smallBytes: 10 * 1024 * 1024, totalBytes: 30 * 1024 * 1024, rows: 2000, cols: 50, cell: 500, strings: 100000 };
export class XlsxError extends Error { constructor(message) { super(message); this.userMessage = message; this.statusCode = 400; } }
const bad = (m) => { throw new XlsxError(m); };
const local = (n) => String(n).split(':').pop();
const decodeUtf8 = (u8) => new TextDecoder('utf-8').decode(u8).replace(/^\uFEFF/, '');
const parseXml = (xml, handlers) => {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) bad('הקובץ מכיל הגדרות XML לא בטוחות ולכן לא נקרא.');
  const p = new Parser(); let failed = false;
  p.on('openTag', (n, attrs, dec) => handlers.open?.(local(n), attrs(), dec));
  p.on('closeTag', (n) => handlers.close?.(local(n)));
  p.on('text', (t, dec) => handlers.text?.(dec(t)));
  p.on('error', () => { failed = true; });
  p.parse(xml);
  if (failed) bad('מבנה הקובץ אינו תקין.');
};
export const colIndex = (ref) => { const m = /^([A-Z]{1,3})(\d+)$/i.exec(String(ref || '')); if (!m) return null; let n = 0; for (const ch of m[1].toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return { col: n - 1, row: Number(m[2]) }; };

export const readXlsxFirstSheet = (buf) => {
  const L = XLSX_LIMITS;
  if (!Buffer.isBuffer(buf) || buf.length < 22) bad('הקובץ ריק או פגום.');
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) bad('קובץ Excel ישן (xls) או מוגן בסיסמה אינו נתמך. שמרו אותו כ-xlsx רגיל בלי סיסמה.');
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) bad('הקובץ אינו קובץ xlsx תקין.');
  // Pass 1: directory scan plus the small parts. Nothing else is inflated.
  const names = []; let total = 0;
  const small = new Set(['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']);
  let p1;
  try {
    p1 = unzipSync(new Uint8Array(buf), { filter: (f) => {
      names.push(f.name); if (names.length > L.entries) bad('בקובץ יותר מדי רכיבים.');
      if (!small.has(f.name)) return false;
      if (f.originalSize > L.smallBytes) bad('אחד מרכיבי הקובץ גדול מדי.');
      total += f.originalSize; if (total > L.totalBytes) bad('הקובץ גדול מדי.'); return true;
    } });
  } catch (e) { if (e instanceof XlsxError) throw e; bad('הקובץ פגום או אינו xlsx.'); }
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) bad('קובץ עם מאקרו אינו נתמך. שמרו אותו כ-xlsx בלי מאקרו.');
  if (names.some((n) => n === 'xl/workbook.bin')) bad('קובץ xlsb אינו נתמך. שמרו אותו כ-xlsx.');
  if (!p1['xl/workbook.xml'] || !p1['[Content_Types].xml']) bad('הקובץ אינו קובץ xlsx תקין.');
  if (/macroEnabled/i.test(decodeUtf8(p1['[Content_Types].xml']))) bad('קובץ עם מאקרו אינו נתמך. שמרו אותו כ-xlsx בלי מאקרו.');
  // First visible sheet in workbook order, resolved through the relationships part.
  const sheets = []; parseXml(decodeUtf8(p1['xl/workbook.xml']), { open: (n, a) => { if (n === 'sheet') sheets.push({ name: a.name, state: a.state, rid: a['r:id'] || a.id || Object.entries(a).find(([k]) => /(^|:)id$/.test(k))?.[1] }); } });
  const first = sheets.find((s) => s.state !== 'hidden' && s.state !== 'veryHidden'); if (!first) bad('לא נמצא גיליון בקובץ.');
  const rels = {}; if (p1['xl/_rels/workbook.xml.rels']) parseXml(decodeUtf8(p1['xl/_rels/workbook.xml.rels']), { open: (n, a) => { if (n === 'Relationship') rels[a.Id] = a.Target; } });
  const target = rels[first.rid]; if (!target) bad('לא נמצא גיליון בקובץ.');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  if (!names.includes(sheetPath) || /\.\./.test(sheetPath)) bad('לא נמצא גיליון בקובץ.');
  // Shared strings (text of <si>, phonetic runs skipped).
  const strings = [];
  if (p1['xl/sharedStrings.xml']) {
    let cur = null; let inT = false; let inPh = 0; let chars = 0;
    parseXml(decodeUtf8(p1['xl/sharedStrings.xml']), {
      open: (n) => { if (n === 'si') cur = ''; else if (n === 'rPh') inPh += 1; else if (n === 't' && cur !== null && !inPh) inT = true; },
      text: (t) => { if (inT) { chars += t.length; if (chars > 5e6) bad('הקובץ מכיל יותר מדי טקסט.'); cur += t; } },
      close: (n) => { if (n === 't') inT = false; else if (n === 'rPh') inPh -= 1; else if (n === 'si') { strings.push(cur.slice(0, L.cell)); cur = null; if (strings.length > L.strings) bad('הקובץ מכיל יותר מדי תאים.'); } },
    });
  }
  // Pass 2: only the chosen sheet.
  let p2;
  try { p2 = unzipSync(new Uint8Array(buf), { filter: (f) => { if (f.name !== sheetPath) return false; if (f.originalSize > L.sheetBytes || total + f.originalSize > L.totalBytes) bad('הגיליון גדול מדי.'); return true; } }); } catch (e) { if (e instanceof XlsxError) throw e; bad('הקובץ פגום או אינו xlsx.'); }
  const xml = p2[sheetPath]; if (!xml) bad('לא נמצא גיליון בקובץ.');
  const rows = []; const problems = []; let cell = null; let row = null; let inV = false; let inT = false; let inF = false; let truncatedRows = false;
  parseXml(decodeUtf8(xml), {
    open: (n, a) => {
      if (n === 'row') { if (rows.length >= L.rows) { truncatedRows = true; row = null; return; } row = []; rows.push(row); return; }
      if (n === 'c' && row) { const pos = colIndex(a.r); cell = { t: a.t || 'n', col: pos ? pos.col : row.length, v: '', f: false }; return; }
      if (!cell) return;
      if (n === 'v') inV = true; else if (n === 't') inT = true; else if (n === 'f') { cell.f = true; inF = true; }
    },
    text: (t) => { if (!cell) return; if (inV || inT) cell.v += t; if (cell.v.length > L.cell * 4) cell.v = cell.v.slice(0, L.cell * 4); },
    close: (n) => {
      if (n === 'v') inV = false; else if (n === 't') inT = false; else if (n === 'f') inF = false;
      else if (n === 'c' && cell && row) {
        let v = cell.v;
        if (cell.t === 's') v = strings[Number(v)] ?? '';
        else if (cell.t === 'b') v = v === '1' ? 'TRUE' : 'FALSE';
        else if (cell.t === 'e') v = '';
        if (cell.f) v = `=${v}`; // any formula cell is surfaced with a formula marker so the caller refuses it as data
        if (cell.col < L.cols && v !== '') { while (row.length < cell.col) row.push(''); row[cell.col] = v.slice(0, L.cell); if (cell.t === 'n' && !cell.f) (row.numeric ||= new Set()).add(cell.col); }
        cell = null;
      }
    },
  });
  if (inF) bad('מבנה הקובץ אינו תקין.');
  if (truncatedRows) problems.push(`נקראו ${L.rows} השורות הראשונות בלבד`);
  return { rows: rows.filter((r) => r.some((c) => c !== '')), problems, sheetName: first.name };
};
