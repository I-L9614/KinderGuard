import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const up = (t, buf, name) => request(app).post('/api/ai/tasks/file-propose').set('Authorization', `Bearer ${t}`).attach('file', buf, name);
describe('POST /api/ai/tasks/file-propose', () => {
  it('csv rows become server-held create_task proposals, confirm creates the task, no model call', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await Branch.create({ adminId: u._id, name: 'גן שקד' });
    ask.mockClear();
    const r = await up(t, Buffer.from('כותרת,תאריך יעד,סניף\nלחדש אישור,2026-12-31,גן שקד\nעם סניף שגוי,,גן זהב\n', 'utf8'), 't.csv').expect(200);
    expect(r.body.actions).toHaveLength(1); expect(r.body.actions[0]).toMatchObject({ type: 'create_task', title: 'לחדש אישור', branchId: String(b._id) }); expect(r.body.rejected.join(' ')).toMatch(/שורה 3: הסניף "גן זהב" לא נמצא/);
    expect(r.body.costUsd).toBe(0); expect(ask).not.toHaveBeenCalled();
    const Task = (await import('../src/models/Task.js')).default; expect(await Task.countDocuments({ adminId: u._id })).toBe(0);
    await request(app).post(`/api/ai/proposals/${r.body.actions[0].proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({}).expect(200);
    expect(await Task.countDocuments({ adminId: u._id, title: 'לחדש אישור' })).toBe(1);
  });
  it('pdf, image and old formats are refused with no model call; users without AI access are refused', async () => {
    const { t } = await mk({ aiEnabled: true }); ask.mockClear();
    for (const n of ['a.pdf', 'a.png', 'a.xls', 'a.doc']) { const r = await up(t, PDF, n).expect(400); expect(r.body.message).toMatch(/xlsx, docx עם טבלה או CSV|קבצי xls|לא נקראים|Claude/); }
    expect(ask).not.toHaveBeenCalled();
    const n = await mk({ aiEnabled: false }); await up(n.t, Buffer.from('כותרת\nx', 'utf8'), 't.csv').expect(403);
  });
  it('real xlsx and docx buffers are read locally; a formula cell refuses its row; hostile files get a Hebrew 400', async () => {
    const { build, SHEET } = await import('./helpers/xlsxBuild.js'); const { buildDocx, W, cell, tbl } = await import('./helpers/docxBuild.js');
    const { t } = await mk({ aiEnabled: true }); ask.mockClear();
    const is = (r, c, v) => `<c r="${c}${r}" t="inlineStr"><is><t>${v}</t></is></c>`;
    const x = build({ sheetXml: [SHEET(`<row r="1">${is(1, 'A', 'כותרת')}${is(1, 'B', 'הערות')}</row><row r="2">${is(2, 'A', 'משימה מאקסל')}${is(2, 'B', 'פתק')}</row><row r="3">${is(3, 'A', 'משימה נוספת')}<c r="B3"><f>HYPERLINK("http://x")</f><v>0</v></c></row>`)] });
    const rx = (await up(t, x, 'x.xlsx').expect(200)).body; expect(rx.rejected.join(' ')).toMatch(/שורה 3: ערך שמתחיל בתו חשוד.*הערות/); expect(rx.actions.map((a) => a.title)).toEqual(['משימה מאקסל']);
    const d = buildDocx({ body: W(tbl([[cell('כותרת')], [cell('משימה מוורד')]])) });
    const rd = (await up(t, d, 't.docx').expect(200)).body; expect(rd.actions.map((a) => a.title)).toEqual(['משימה מוורד']);
    const mac = build({ extra: { 'xl/vbaProject.bin': new Uint8Array(4) } }); expect((await up(t, mac, 'm.xlsx').expect(400)).body.message).toMatch(/מאקרו/);
    expect(ask).not.toHaveBeenCalled();
  });
  it('a Manager can only reference accessible branches', async () => {
    const { u } = await mk({ aiEnabled: true }); const a = await Branch.create({ adminId: u._id, name: 'גן מותר' }); await Branch.create({ adminId: u._id, name: 'גן אסור' });
    const jwt = (await import('jsonwebtoken')).default;
    const m = await User.create({ name: 'mgr', email: `m-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Manager', adminId: u._id, accessibleBranches: [a._id], aiEnabled: true });
    const t = jwt.sign({ id: m._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const r = await up(t, Buffer.from('כותרת,סניף\nא,גן מותר\nב,גן אסור\n', 'utf8'), 't.csv').expect(200);
    expect(r.body.actions.map((x) => x.title)).toEqual(['א']); expect(r.body.rejected.join(' ')).toMatch(/שורה 3: הסניף "גן אסור" לא נמצא/);
  });
});
