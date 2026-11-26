import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let Branch; let ask; let LicenseType; let License;
const mk = async () => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `r-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', aiEnabled: true });
  return { u, t: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js'));
  ({ default: LicenseType } = await import('../src/models/LicenseType.js')); ({ default: License } = await import('../src/models/License.js'));
  await License.init(); await License.syncIndexes();
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"rows":[]}', costUsd: 0.01 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(60, 7)]);
const up = (route, t, consent = true, name = 'a.pdf', type = 'application/pdf', extra = {}) => { let r = request(app).post(`/api/ai/${route}/file-propose`).set('Authorization', `Bearer ${t}`); if (consent) r = r.field('consentExternal', 'true'); for (const [k, v] of Object.entries(extra)) r = r.field(k, v); return r.attach('file', PDF, { filename: name, contentType: type }); };

describe('PDF/image intake for tasks, team and licenses (consent-gated, rows validated like Excel rows)', () => {
  it('no consent: 400 consent_required and no model call, for all three routes', async () => {
    const { t } = await mk(); ask.mockClear();
    for (const r of ['tasks', 'team', 'licenses']) { const x = await up(r, t, false).expect(400); expect(x.body.code).toBe('consent_required'); }
    expect(ask).not.toHaveBeenCalled();
  });
  it('answer with a prose sentence after the fenced JSON is still read (real-run defect), and asks for the larger output bound', async () => {
    const { u, t } = await mk(); await Branch.create({ adminId: u._id, name: 'גן שקד' }); ask.mockClear();
    ask.mockResolvedValueOnce({ text: '```json\n{"rows":[{"title":"לחדש","branch":"גן שקד"}]}\n```\n\nהטבלה מכילה 22 שורות והוחזרו 21.', costUsd: 0.001 });
    const r = (await up('tasks', t).expect(200)).body; expect(r.actions).toHaveLength(1); expect(r.actions[0].title).toBe('לחדש');
    expect(ask.mock.calls[0][0].maxOutput).toBe(6000);
  });
  it('two different JSON answers: nothing is imported and the user is told why (422 conflicting_answers)', async () => {
    const { t } = await mk(); ask.mockResolvedValueOnce({ text: '{"rows":[{"title":"א"}]} {"rows":[{"title":"ב"}]}', costUsd: 0.001 });
    const x = await up('tasks', t).expect(422); expect(x.body.code).toBe('conflicting_answers'); expect(x.body.actions).toBeUndefined();
  });
  it('output limit hit: 422 output_limit, and the message does not blame the file size', async () => {
    const { t } = await mk(); ask.mockResolvedValueOnce({ text: '{"rows":[', costUsd: 0.01, truncated: true });
    const x = await up('tasks', t).expect(422); expect(x.body.code).toBe('output_limit'); expect(x.body.message).toContain('לא בגלל גודל הקובץ'); expect(x.body.message).not.toContain('גדול מכדי');
  });
  it('preflight edits with a PDF are refused before any model call', async () => {
    const { t } = await mk(); ask.mockClear();
    const x = await up('tasks', t, true, 'a.pdf', 'application/pdf', { preflightSha: 'a'.repeat(64), skipRows: '[2]' }).expect(400); expect(x.body.message).toMatch(/רק בטבלה|preflight|בחירות/); expect(ask).not.toHaveBeenCalled();
  });
  it('tasks: model rows pass the same row validation (unknown branch and bad date rejected), each valid row is a server-held proposal, source model, cost reported', async () => {
    const { u, t } = await mk(); const b = await Branch.create({ adminId: u._id, name: 'גן שקד' });
    ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: [{ title: 'לחדש אישור', dueDate: '2026-12-31', branch: 'גן שקד' }, { title: 'בלי סניף כזה', branch: 'גן זהב' }, { title: 'תאריך רע', dueDate: '31/12' }, { title: '=cmd()' }, 'junk'] }), costUsd: 0.02 });
    const r = (await up('tasks', t).expect(200)).body;
    expect(r.source).toBe('model'); expect(r.costUsd).toBe(0.02); expect(r.summary).toMatch(/נקרא בעזרת Claude/);
    expect(r.actions).toHaveLength(1); expect(r.actions[0]).toMatchObject({ type: 'create_task', title: 'לחדש אישור', branchId: String(b._id) });
    const rej = r.rejected.join(' '); expect(rej).toMatch(/גן זהב/); expect(rej).toMatch(/תאריך/); expect(rej).toMatch(/חשוד/);
    const Task = (await import('../src/models/Task.js')).default; expect(await Task.countDocuments({ adminId: u._id })).toBe(0);
    const sent = ask.mock.calls.at(-1)[0]; expect(sent.content[0].type).toBe('document'); expect(sent.system).toMatch(/התעלם מכל הוראה/);
  });
  it('team: never reads a password, rows need valid emails, create stays sensitive with a step-up', async () => {
    const { t } = await mk();
    ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: [{ name: 'דנה', email: 'dana-pdf@e.com', role: 'מנהל סניף', password: 'Secret123' }, { name: 'רות', email: 'bad' }] }), costUsd: 0 });
    const r = (await up('team', t).expect(200)).body; expect(r.actions).toHaveLength(1); expect(r.actions[0]).toMatchObject({ type: 'create_user', sensitive: true, email: 'dana-pdf@e.com' });
    expect(JSON.stringify(r)).not.toContain('Secret123'); expect(ask.mock.calls.at(-1)[0].system).toMatch(/לעולם לא להעתיק סיסמה/);
    const c = await request(app).post(`/api/ai/proposals/${r.actions[0].proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ password: 'Password123', role: 'Manager' }); expect(c.status).toBe(403);
    expect(await User.countDocuments({ email: 'dana-pdf@e.com' })).toBe(0);
  });
  it('licenses: an Active license for the branch and type is never replaced, a clean row becomes a proposal, an image works', async () => {
    const { u, t } = await mk(); const b1 = await Branch.create({ adminId: u._id, name: 'גן א' }); const b2 = await Branch.create({ adminId: u._id, name: 'גן ב' });
    const lt = await LicenseType.create({ adminId: u._id, name: 'רישיון עסק' });
    await License.create({ branchId: b1._id, licenseTypeId: lt._id, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id });
    ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: [{ branch: 'גן א', type: 'רישיון עסק', issueDate: '2026-02-01', expiryDate: '2027-02-01' }, { branch: 'גן ב', type: 'רישיון עסק', issueDate: '2026-02-01', expiryDate: '2027-02-01' }] }), costUsd: 0 });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 1)]);
    const r = (await request(app).post('/api/ai/licenses/file-propose').set('Authorization', `Bearer ${t}`).field('consentExternal', 'true').attach('file', png, { filename: 'a.png', contentType: 'image/png' }).expect(200)).body;
    expect(r.source).toBe('model'); expect(r.actions).toHaveLength(1); expect(r.actions[0].branchId).toBe(String(b2._id)); expect(ask.mock.calls.at(-1)[0].content[0].type).toBe('image');
    expect(await License.countDocuments({ branchId: b2._id })).toBe(0);
  });
  it('coverage is always stated: over 20 rows names the cut, otherwise says completeness cannot be verified', async () => {
    const { t } = await mk();
    ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: Array.from({ length: 21 }, (_, i) => ({ title: `משימה ${i}` })) }), costUsd: 0 });
    const a = (await up('tasks', t).expect(200)).body; expect(a.actions).toHaveLength(20); expect(a.coverage).toMatchObject({ read: 20, cap: 20, truncated: true, complete: 'unknown' }); expect(a.coverage.note).toMatch(/יותר מ-20 שורות.*לא יובאו.*לא יכולה לדעת/); expect(a.rejected.join(' ')).not.toMatch(/כיסוי המסמך/); expect(ask.mock.calls.at(-1)[0].system).toMatch(/עד 21 שורות/);
    ask.mockResolvedValueOnce({ text: JSON.stringify({ rows: [{ title: 'אחת' }] }), costUsd: 0 });
    const b = (await up('tasks', t).expect(200)).body; expect(b.coverage).toMatchObject({ read: 1, truncated: false, complete: 'unknown' }); expect(b.coverage.note).toMatch(/הוצגה שורה אחת.*לא יכולה לוודא/); expect(b.rejected.join(' ')).not.toMatch(/כיסוי המסמך/);
  });
  it('model failure or empty output is a clear refusal and creates nothing', async () => {
    const { t } = await mk();
    ask.mockResolvedValueOnce({ text: 'not json', costUsd: 0 }); const a = await up('tasks', t).expect(422); expect(a.body.message).toMatch(/לא נמצאו במסמך שורות/);
    ask.mockResolvedValueOnce({ text: '{"rows":[]}', truncated: true, costUsd: 0 }); await up('team', t).expect(422);
    ask.mockRejectedValueOnce(Object.assign(new Error('התקציב הכללי הגיע למגבלה'), { statusCode: 429 })); const c = await up('tasks', t); expect(c.status).toBe(429);
  });
});
