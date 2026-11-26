import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { parseBranchCsv, matchRows, parseModelRows } from '../src/ai/branchFile.js';

let app; let mongoServer; let User; let Branch; let ask;
const mk = async (extra) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `r-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
  return { u, t: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const csv = (s) => Buffer.from(s, 'utf8');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
describe('parseBranchCsv / matchRows (pure)', () => {
  it('reads Hebrew headers, BOM, semicolons and quoted commas', () => {
    const p = parseBranchCsv('\uFEFFשם הגן;טלפון;כתובת;מספר ילדים\nגן א;03-1;"הרצל 1, חיפה";30\nגן ב;;;');
    expect(p.rows).toEqual([{ name: 'גן א', phone: '03-1', address: 'הרצל 1, חיפה', maxChildren: '30' }, { name: 'גן ב' }]);
  });
  it('needs a name column and at least one data column', () => {
    expect(parseBranchCsv('טלפון\n1\n2').problems[0]).toContain('עמודת שם');
    expect(parseBranchCsv('שם\nגן א').problems.join()).toContain('עמודות לעדכון');
  });
  it('model rows are cleaned and capped, and matching is exact / near / none', () => {
    expect(parseModelRows('{"rows":[{"name":" גן א ","phone":"1","x":"y"},{"phone":"2"}]}')).toEqual([{ name: 'גן א', phone: '1' }]);
    const B = [{ _id: 'a', name: 'גן שקד' }, { _id: 'b', name: 'גן שקד צפון' }, { _id: 'c', name: 'גן ורד' }];
    const m = matchRows([{ name: 'גן  ורד' }, { name: 'שקד' }, { name: 'גן חדש' }, { name: 'גן ורד' }], B);
    expect(m.resolved.map((r) => r.branchId)).toEqual(['c']); expect(m.fuzzy[0].candidates.map((c) => c.name)).toEqual(['גן שקד', 'גן שקד צפון']);
    expect(m.unmatched).toEqual(['גן חדש']); expect(m.notes).toHaveLength(1);
  });
});
describe('POST /api/ai/branches/file-propose', () => {
  const up = (t, buf, name, type = 'text/csv', consent = true) => { const r = request(app).post('/api/ai/branches/file-propose').set('Authorization', `Bearer ${t}`); if (consent) r.field('consentExternal', 'true'); return r.attach('file', buf, { filename: name, contentType: type }); };
  const conf = (t, id, body = {}) => request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`).send(body);
  it('CSV: no model call; per-branch cards with before/after; unknown name reported and never created; each confirmed alone; stale refused', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const a = await Branch.create({ adminId: u._id, name: 'גן אלון', phone: '03-0000001', address: 'ישן' }); const b = await Branch.create({ adminId: u._id, name: 'גן ברוש', phone: '' }); const c = await Branch.create({ adminId: u._id, name: 'גן רימון', phone: '04-5' });
    ask.mockClear();
    const r = (await up(t, csv('שם,טלפון,כתובת\nגן אלון,09-1111111,הרצל 5\nגן ברוש,09-2222222,\nגן רימון,04-5,\nגן לא קיים,1,2'), 'מעונות.csv').expect(200)).body;
    expect(ask).not.toHaveBeenCalled(); expect(r.source).toBe('csv');
    expect(r.actions).toHaveLength(2); expect(r.rejected.join('|')).toContain('גן לא קיים'); expect(r.rejected.join('|')).toContain('גן רימון": הנתונים בקובץ זהים');
    expect(await Branch.countDocuments({ adminId: u._id })).toBe(3);
    const byName = Object.fromEntries(r.actions.map((x) => [x.currentName, x]));
    expect(byName['גן אלון'].before).toEqual({ phone: '03-0000001', address: 'ישן' }); expect(byName['גן אלון'].fields).toEqual({ phone: '09-1111111', address: 'הרצל 5' }); expect(byName['גן ברוש'].fields).toEqual({ phone: '09-2222222' });
    expect((await Branch.findById(a._id)).phone).toBe('03-0000001');
    await Branch.updateOne({ _id: b._id }, { phone: '052-9' });
    await conf(t, byName['גן ברוש'].proposalId).expect(409);
    await conf(t, byName['גן אלון'].proposalId).expect(200);
    const after = await Branch.findById(a._id); expect(after.phone).toBe('09-1111111'); expect(after.address).toBe('הרצל 5'); expect(after.name).toBe('גן אלון');
    expect((await Branch.findById(b._id)).phone).toBe('052-9'); expect((await Branch.findById(c._id)).phone).toBe('04-5');
  });
  it('a near name stops at the user choice, the choice must come from the list, and the name is never changed from a file', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const a = await Branch.create({ adminId: u._id, name: 'גן שקד', phone: 'A' }); const b = await Branch.create({ adminId: u._id, name: 'גן שקד צפון', phone: 'B' }); const o = await Branch.create({ adminId: u._id, name: 'גן אחר' });
    const r = (await up(t, csv('שם,טלפון\nשקד,03-7'), 'x.csv').expect(200)).body;
    expect(r.actions[0].needsChoice).toBe(true); expect(r.actions[0].candidates.map((x) => x.before.phone).sort()).toEqual(['A', 'B']); expect(r.actions[0].fields.name).toBeUndefined();
    await conf(t, r.actions[0].proposalId).expect(400);
    await conf(t, r.actions[0].proposalId, { branchId: String(o._id) }).expect(400);
    await conf(t, r.actions[0].proposalId, { branchId: String(b._id) }).expect(200);
    const nb = await Branch.findById(b._id); expect(nb.phone).toBe('03-7'); expect(nb.name).toBe('גן שקד צפון'); expect((await Branch.findById(a._id)).phone).toBe('A');
  });
  it('PDF goes to the model path only for AI-enabled admins; the server, not the model, picks the branch; instructions in the file are ignored', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const a = await Branch.create({ adminId: u._id, name: 'גן תאנה', phone: '1' }); const other = await Branch.create({ adminId: u._id, name: 'גן אחר', phone: '2' });
    ask.mockClear(); ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: [{ name: 'גן תאנה', phone: '09-3', branchId: String(other._id) }] }), costUsd: 0.001 });
    const r = (await up(t, PDF, 'tabela.pdf', 'application/pdf').expect(200)).body;
    expect(ask).toHaveBeenCalledTimes(1); expect(ask.mock.calls[0][0].maxOutput).toBe(3500); expect(r.actions[0].branchId).toBe(String(a._id));
    ask.mockClear(); ask.mockResolvedValueOnce({ text: '{"rows":[', truncated: true, costUsd: 0 });
    await up(t, PDF, 'tabela.pdf', 'application/pdf').expect(422);
  });
  it('xlsx: reads the first sheet through the same matching path with no model call; formulas refused; hostile files get a Hebrew 400', async () => {
    const { build, SHEET } = await import('./helpers/xlsxBuild.js');
    const { u, t } = await mk({ aiEnabled: true }); const a = await Branch.create({ adminId: u._id, name: 'גן אקסל', phone: '02-1' }); ask.mockClear();
    const ok = build({ sheetXml: [SHEET('<row r="1"><c r="A1" t="inlineStr"><is><t>שם</t></is></c><c r="B1" t="inlineStr"><is><t>טלפון</t></is></c><c r="C1" t="inlineStr"><is><t>כתובת</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>גן אקסל</t></is></c><c r="B2" t="inlineStr"><is><t>03-7777777</t></is></c><c r="C2"><f>HYPERLINK("http://x")</f><v>0</v></c></row>')] });
    const r = (await up(t, ok, 'x.xlsx').expect(200)).body;
    expect(ask).not.toHaveBeenCalled(); expect(r.source).toBe('xlsx'); expect(r.actions).toHaveLength(1); expect(r.actions[0].branchId).toBe(String(a._id)); expect(r.actions[0].fields.phone).toBe('03-7777777'); expect(r.actions[0].fields.address).toBeUndefined(); expect(r.rejected.join(' ')).toMatch(/חשוד/);
    const mac = build({ extra: { 'xl/vbaProject.bin': new Uint8Array(4) } }); const e1 = await up(t, mac, 'm.xlsx').expect(400); expect(e1.body.message).toMatch(/מאקרו/);
    expect((await up(t, Buffer.from('MZ\u0000\u0000notzip-notzip'), 'f.xlsx').expect(400)).body.message).toMatch(/xlsx|פגום/);
    expect((await up(t, Buffer.from('x'.repeat(50)), 'old.xls').expect(400)).body.message).toMatch(/xls/);
    expect(ask).not.toHaveBeenCalled(); expect((await Branch.findById(a._id)).phone).toBe('02-1');
  });
  it('docx: first table goes through the same matching path with no model call; merged or macro files get a Hebrew 400', async () => {
    const { buildDocx, W, cell, tbl } = await import('./helpers/docxBuild.js');
    const { u, t } = await mk({ aiEnabled: true }); const a = await Branch.create({ adminId: u._id, name: 'גן וורד', phone: '02-1' }); ask.mockClear();
    const ok = buildDocx({ body: W(tbl([[cell('שם'), cell('טלפון')], [cell('גן וורד'), cell('03-5555555')]])) });
    const r = (await up(t, ok, 't.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').expect(200)).body;
    expect(ask).not.toHaveBeenCalled(); expect(r.source).toBe('docx'); expect(r.actions).toHaveLength(1); expect(r.actions[0].branchId).toBe(String(a._id)); expect(r.actions[0].fields.phone).toBe('03-5555555');
    const merged = buildDocx({ body: W(tbl([[cell('שם', '<w:gridSpan w:val="2"/>')]])) });
    expect((await up(t, merged, 'm.docx').expect(400)).body.message).toMatch(/ממוזגים/);
    expect(ask).not.toHaveBeenCalled(); expect((await Branch.findById(a._id)).phone).toBe('02-1');
  });
  it('refuses Excel, binary or fake PDFs, and non-AI, manager and logged-out callers, with no model call', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const n = await mk({}); const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id });
    ask.mockClear();
    await up(t, csv('x'), 'a.xlsx').expect(400); await up(t, Buffer.from('MZ\u0000\u0000notpdfnotpdf'), 'a.pdf', 'application/pdf').expect(400); await up(t, csv('שם,טלפון\nא,1'), 'a.csv').expect(200);
    await up(n.t, csv('שם,טלפון\nא,1'), 'a.csv').expect(403); await up(m.t, csv('שם,טלפון\nא,1'), 'a.csv').expect(403);
    await request(app).post('/api/ai/branches/file-propose').attach('file', csv('a'), 'a.csv').expect(401);
    expect(ask).not.toHaveBeenCalled();
  });
  it('PDF/image needs explicit consent before anything is sent; without it there is no model call', async () => {
    const { u, t } = await mk({ aiEnabled: true }); await Branch.create({ adminId: u._id, name: 'גן תאנה', phone: '1' });
    ask.mockClear();
    const r = await up(t, PDF, 'a.pdf', 'application/pdf', false).expect(400); expect(r.body.code).toBe('consent_required'); expect(ask).not.toHaveBeenCalled();
    await up(t, csv('שם,טלפון\nגן תאנה,2'), 'a.csv', 'text/csv', false).expect(200); expect(ask).not.toHaveBeenCalled();
  });
  it('conflicting rows for one branch block that branch (no card, no write); identical rows merge; a near-name row that may mean an exact-row branch is held', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const a = await Branch.create({ adminId: u._id, name: 'גן אלה', phone: '1' }); const b = await Branch.create({ adminId: u._id, name: 'גן ברוש', phone: '2' }); const c = await Branch.create({ adminId: u._id, name: 'גן גל', phone: '3' });
    const r = (await up(t, csv('שם,טלפון\nגן אלה,05-1\nגן אלה,05-2\nגן ברוש,06-1\nגן  ברוש,06-1\nברוש,07-7\nגן גל,08-1'), 'd.csv').expect(200)).body;
    expect(r.actions.map((x) => x.currentName).sort()).toEqual(['גן ברוש', 'גן גל']);
    const notes = r.rejected.join('|'); expect(notes).toContain('"גן אלה" מופיע בקובץ עם ערכים סותרים'); expect(notes).toContain('כמה פעמים עם אותם ערכים'); expect(notes).toContain('"ברוש" עלול להתייחס');
    for (const x of r.actions) await conf(t, x.proposalId).expect(200);
    expect((await Branch.findById(a._id)).phone).toBe('1'); expect((await Branch.findById(b._id)).phone).toBe('06-1'); expect((await Branch.findById(c._id)).phone).toBe('08-1');
    const r2 = (await up(t, csv('שם,טלפון\nגן אלה,05-1\nגן אלה,05-2'), 'd2.csv').expect(200)).body; expect(r2.actions).toHaveLength(0);
  });
  it('formula-like cells are refused, a real phone with + is kept, and HTML text stays plain data', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const a = await Branch.create({ adminId: u._id, name: 'גן נוסחה' }); const b = await Branch.create({ adminId: u._id, name: 'גן פלוס' }); const c = await Branch.create({ adminId: u._id, name: 'גן תג' });
    const r = (await up(t, csv('שם,טלפון,כתובת,מנהל\nגן נוסחה,"=HYPERLINK(""http://x"")",@SUM(A1),+cmd|calc\nגן פלוס,+972-50-1234567,,\nגן תג,,<img src=x onerror=alert(1)>,'), 'f.csv').expect(200)).body;
    const by = Object.fromEntries(r.actions.map((x) => [x.currentName, x]));
    expect(by['גן נוסחה']).toBeUndefined(); expect(r.rejected.join('|')).toContain('גן נוסחה');
    expect(by['גן פלוס'].fields).toEqual({ phone: '+972-50-1234567' }); expect(by['גן תג'].fields).toEqual({ address: '<img src=x onerror=alert(1)>' });
    await conf(t, by['גן תג'].proposalId).expect(200); expect((await Branch.findById(c._id)).address).toBe('<img src=x onerror=alert(1)>');
    expect((await Branch.findById(a._id)).phone).toBeFalsy();
  });
});
