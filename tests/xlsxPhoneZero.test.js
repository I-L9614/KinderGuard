import { describe, it, expect } from 'vitest';
import { readXlsxFirstSheet, XLSX_LIMITS } from '../src/utils/xlsxReader.js';
import { parseBranchGrid } from '../src/ai/branchFile.js';
import { build, SHEET, CT } from './helpers/xlsxBuild.js';

const sheet = (phoneCell) => SHEET(`<row r="1"><c r="A1" t="inlineStr"><is><t>שם</t></is></c><c r="B1" t="inlineStr"><is><t>טלפון</t></is></c><c r="C1" t="inlineStr"><is><t>כתובת</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>גן אלון</t></is></c>${phoneCell}<c r="C2" t="inlineStr"><is><t>הרצל 1</t></is></c></row>`);
describe('xlsx phone cells and the lost leading zero', () => {
  it('numeric phone cell is not offered as an update; the other fields still are, with a flag', () => {
    const g = readXlsxFirstSheet(build({ sheetXml: [sheet('<c r="B2"><v>501234567</v></c>')] }));
    const p = parseBranchGrid(g.rows, g.problems);
    expect(p.rows).toEqual([{ name: 'גן אלון', address: 'הרצל 1' }]);
    expect(p.problems.join(' ')).toMatch(/האפס המוביל/);
    expect(p.problems.join(' ')).toMatch(/גן אלון/);
  });
  it('text phone cell keeps its leading zero', () => {
    const g = readXlsxFirstSheet(build({ sheetXml: [sheet('<c r="B2" t="inlineStr"><is><t>0501234567</t></is></c>')] }));
    const p = parseBranchGrid(g.rows, g.problems);
    expect(p.rows[0].phone).toBe('0501234567');
    expect(p.problems).toEqual([]);
  });
  it('pass 1 enforces the total size across small parts, not only per part', () => {
    const pad = (n) => `<!--${'a'.repeat(n)}-->`;
    const sst = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>x</t></si></sst>${pad(3000)}`;
    const buf = build({ sst });
    expect(() => readXlsxFirstSheet(buf)).not.toThrow();
    const saved = XLSX_LIMITS.totalBytes;
    XLSX_LIMITS.totalBytes = 2000;
    try { expect(() => readXlsxFirstSheet(buf)).toThrow('הקובץ גדול מדי.'); } finally { XLSX_LIMITS.totalBytes = saved; }
  });
});
