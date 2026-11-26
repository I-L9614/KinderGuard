// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readDocxFirstTable } from '../src/utils/docxReader.js';
import { buildDocx, W, cell, tbl } from './helpers/docxBuild.js';

const ok = (rows) => buildDocx({ body: W(`<w:p><w:r><w:t>כותרת</w:t></w:r></w:p>${tbl(rows)}${tbl([[cell('שנייה')]])}`) });
describe('docx first table reader', () => {
  it('reads only the first table as text, keeps leading zeros, joins paragraphs, skips empty rows', () => {
    const g = readDocxFirstTable(ok([[cell('שם'), cell('טלפון')], [cell('גן א'), cell('03-1234567')], [cell('גן ב'), cell('0501234567')], [cell(''), cell('')]]));
    expect(g.rows).toEqual([['שם', 'טלפון'], ['גן א', '03-1234567'], ['גן ב', '0501234567']]);
  });
  const err = (buf, re) => { try { readDocxFirstTable(buf); } catch (e) { expect(e.userMessage).toMatch(re); expect(e.statusCode).toBe(400); return; } throw new Error('expected a refusal'); };
  it('refuses merged cells, nested tables, no table, macros, DOCTYPE, legacy doc and non-zip files with a Hebrew message', () => {
    err(ok([[cell('שם', '<w:gridSpan w:val="2"/>')]]), /ממוזגים/);
    err(ok([[cell('שם', '<w:vMerge w:val="restart"/>')]]), /ממוזגים/);
    err(buildDocx({ body: W(`<w:tbl><w:tr><w:tc><w:p/>${tbl([[cell('x')]])}</w:tc></w:tr></w:tbl>`) }), /בתוך טבלה/);
    err(buildDocx({ body: W('<w:p><w:r><w:t>אין טבלה</w:t></w:r></w:p>') }), /לא נמצאה טבלה/);
    err(buildDocx({ body: W(tbl([[cell('a')]])), extra: { 'word/vbaProject.bin': new Uint8Array(4) } }), /מאקרו/);
    err(buildDocx({ body: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]>${W(tbl([[cell('a')]]))}` }), /לא בטוחות/);
    err(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(40)]), /doc/);
    err(Buffer.from('MZ-not-a-zip-file-at-all-xxxxx'), /docx/);
  });
  it('caps rows and reports it', () => {
    const rows = Array.from({ length: 2100 }, (_, i) => [cell(`r${i}`)]); const g = readDocxFirstTable(ok(rows));
    expect(g.rows).toHaveLength(2000); expect(g.problems.join(' ')).toMatch(/2000/);
  });
});
