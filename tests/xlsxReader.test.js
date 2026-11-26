import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { readXlsxFirstSheet, XlsxError, XLSX_LIMITS } from '../src/utils/xlsxReader.js';

const CT = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const WB = (sheets) => `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name || `S${i + 1}`}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
const RELS = (n) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
const SHEET = (rows) => `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
export const build = ({ sheets = [{}], sheetXml = [SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>שם</t></is></c><c r="B1" t="inlineStr"><is><t>טלפון</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>גן אלון</t></is></c><c r="B2"><v>5551234</v></c></row>')], extra = {}, ct = CT, sst } = {}) => {
  const files = { '[Content_Types].xml': strToU8(ct), 'xl/workbook.xml': strToU8(WB(sheets)), 'xl/_rels/workbook.xml.rels': strToU8(RELS(sheets.length)), ...extra };
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(x); });
  if (sst) files['xl/sharedStrings.xml'] = strToU8(sst);
  return Buffer.from(zipSync(files, { level: 9 }));
};
const err = (buf) => { try { readXlsxFirstSheet(buf); } catch (e) { return e; } return null; };

describe('xlsx reader', () => {
  it('reads the first sheet, inline and shared strings (phonetic runs skipped), numbers and booleans', () => {
    const sst = '<sst xmlns="x"><si><t>שם</t></si><si><r><t>גן </t></r><r><t>ברוש</t></r><rPh><t>IGNORED</t></rPh></si></sst>';
    const r = readXlsxFirstSheet(build({ sst, sheetXml: [SHEET('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="b"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="C2"><v>30</v></c></row>')] }));
    expect(r.rows.map((x) => [...x])).toEqual([['שם', '', 'TRUE'], ['גן ברוש', '', '30']]);
  });
  it('skips hidden first sheet, reads only the first visible one', () => {
    const r = readXlsxFirstSheet(build({ sheets: [{ state: 'hidden' }, {}], sheetXml: [SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>HIDDEN</t></is></c></row>'), SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>VISIBLE</t></is></c></row>')] }));
    expect(r.rows).toEqual([['VISIBLE']]);
  });
  it('surfaces formulas with a marker and never evaluates or follows them', () => {
    const r = readXlsxFirstSheet(build({ sheetXml: [SHEET('<row r="1"><c r="A1"><f>HYPERLINK("http://x")</f><v>0</v></c></row>')] }));
    expect(r.rows[0][0].startsWith('=')).toBe(true);
  });
  it('caps rows, columns and cell length', () => {
    const rows = Array.from({ length: XLSX_LIMITS.rows + 50 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>${'x'.repeat(i === 0 ? 5000 : 1)}</t></is></c><c r="ZZ${i + 1}"><v>1</v></c></row>`).join('');
    const r = readXlsxFirstSheet(build({ sheetXml: [SHEET(rows)] }));
    expect(r.rows.length).toBe(XLSX_LIMITS.rows); expect(r.rows[0][0].length).toBe(XLSX_LIMITS.cell); expect(r.rows[0].length).toBe(1); expect(r.problems.join()).toMatch(/השורות הראשונות/);
  });
  it('refuses non-xlsx input: empty, text, OLE (xls/encrypted), garbage zip, missing workbook', () => {
    expect(err(Buffer.alloc(0))).toBeInstanceOf(XlsxError);
    expect(err(Buffer.from('שם,טלפון\nא,1\n'.repeat(5)))).toBeInstanceOf(XlsxError);
    expect(err(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)])).message).toMatch(/xls/);
    expect(err(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(100, 7)]))).toBeInstanceOf(XlsxError);
    expect(err(Buffer.from(zipSync({ 'a.txt': strToU8('hi') })))).toBeInstanceOf(XlsxError);
  });
  it('refuses macros and binary workbooks', () => {
    expect(err(build({ extra: { 'xl/vbaProject.bin': new Uint8Array(10) } })).message).toMatch(/מאקרו/);
    expect(err(build({ ct: CT.replace('application/xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml') })).message).toMatch(/מאקרו/);
    expect(err(build({ extra: { 'xl/workbook.bin': new Uint8Array(10) } })).message).toMatch(/xlsb/);
  });
  it('refuses XML with DOCTYPE or entities (no expansion)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&b;</t></is></c></row></sheetData></worksheet>';
    expect(err(build({ sheetXml: [bomb] })).message).toMatch(/לא בטוחות/);
    expect(err(build({ sst: '<!DOCTYPE x [<!ENTITY a "b">]><sst/>' })).message).toMatch(/לא בטוחות/);
  });
  it('refuses a zip bomb sheet before inflating it, quickly', () => {
    const big = SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'a'.repeat(XLSX_LIMITS.sheetBytes + 1000)}</t></is></c></row>`);
    const buf = build({ sheetXml: [big] }); expect(buf.length).toBeLessThan(100000);
    const t0 = Date.now(); const e = err(buf); expect(e).toBeInstanceOf(XlsxError); expect(e.message).toMatch(/גדול/); expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('refuses too many entries', () => {
    const extra = {}; for (let i = 0; i < XLSX_LIMITS.entries + 5; i++) extra[`xl/media/f${i}.bin`] = new Uint8Array(1);
    expect(err(build({ extra })).message).toMatch(/יותר מדי/);
  });
  it('a lying directory size cannot make it read more than the declared (capped) size and never crashes', () => {
    const buf = build({ sheetXml: [SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'b'.repeat(200000)}</t></is></c></row>`)] });
    // set the declared uncompressed size of the sheet to 50 bytes in both the central and the local header
    const sig = (n, a, b, c, d) => { for (let i = 0; i + 3 < n.length; i++) if (n[i] === a && n[i + 1] === b && n[i + 2] === c && n[i + 3] === d) return i; return -1; };
    for (let i = 0; i + 46 < buf.length; i++) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x01 && buf[i + 3] === 0x02) { const nameLen = buf.readUInt16LE(i + 28); if (buf.subarray(i + 46, i + 46 + nameLen).toString() === 'xl/worksheets/sheet1.xml') { buf.writeUInt32LE(50, i + 24); const lh = buf.readUInt32LE(i + 42); buf.writeUInt32LE(50, lh + 22); } }
    }
    expect(sig(buf, 0x50, 0x4b, 3, 4)).toBeGreaterThanOrEqual(0);
    let out; try { out = readXlsxFirstSheet(buf); } catch (e) { expect(e).toBeInstanceOf(XlsxError); }
    if (out) expect(JSON.stringify(out.rows).length).toBeLessThan(5000);
  });
});
