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
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const up = (t, buf, name) => request(app).post('/api/ai/licenses/file-propose').set('Authorization', `Bearer ${t}`).attach('file', buf, name);
  const confirm = (t, id, withGrant = true) => { const pr = (async () => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await (await import('../src/models/AiProposal.js')).default.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); })(); return { result: pr, expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
const setup = async () => {
  const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const Branch2 = Branch; const LicenseType = (await import('../src/models/LicenseType.js')).default; const License = (await import('../src/models/License.js')).default;
  const b = await Branch2.create({ adminId: u._id, name: 'גן שקד' }); const ty = await LicenseType.create({ adminId: u._id, name: 'אישור בטיחות' }); return { u, t, b, ty, License, LicenseType };
};
const CSV = 'סניף,סוג אישור,תאריך הנפקה,תאריך תפוגה\nגן שקד,אישור בטיחות,2026-01-01,2027-01-01\n';
describe('POST /api/ai/licenses/file-propose and create_license', () => {
  it('creates one Active license without a file only after step-up confirm; no model; replaying fails', async () => {
    const { u, t, b, License } = await setup(); ask.mockClear(); await License.init();
    const r = await up(t, Buffer.from(CSV, 'utf8'), 'l.csv').expect(200); expect(r.body.actions).toHaveLength(1); expect(r.body.actions[0]).toMatchObject({ type: 'create_license', sensitive: true, branchName: 'גן שקד', typeName: 'אישור בטיחות', expiryDate: '2027-01-01' }); expect(ask).not.toHaveBeenCalled();
    const id = r.body.actions[0].proposalId; await confirm(t, id, false).expect(403); expect(await License.countDocuments({ branchId: b._id })).toBe(0);
    await confirm(t, id).expect(200); const l = await License.find({ branchId: b._id }).lean(); expect(l).toHaveLength(1); expect(l[0]).toMatchObject({ lifecycle: 'Active', fileUrl: '', replacedBy: null }); expect(String(l[0].createdBy)).toBe(String(u._id));
    await confirm(t, id).result; expect(await License.countDocuments({ branchId: b._id })).toBe(1);
  });
  it('an existing Active license refuses the row at propose and the card at confirm; nothing is replaced or renewed', async () => {
    const { u, t, b, ty, License } = await setup(); await License.init();
    const r = await up(t, Buffer.from(CSV, 'utf8'), 'l.csv').expect(200); const id = r.body.actions[0].proposalId;
    const old = await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2025-01-01'), expiryDate: new Date('2026-06-01'), createdBy: u._id });
    await confirm(t, id).expect(409);
    const again = await up(t, Buffer.from(CSV, 'utf8'), 'l.csv').expect(200); expect(again.body.actions).toHaveLength(0); expect(again.body.rejected.join(' ')).toMatch(/כבר קיים אישור פעיל/);
    const after = await License.find({ branchId: b._id }).lean(); expect(after).toHaveLength(1); expect(String(after[0]._id)).toBe(String(old._id)); expect(after[0].lifecycle).toBe('Active');
  });
  it('two concurrent confirms of the same branch and type: exactly one Active license exists', async () => {
    const { t, b, License } = await setup(); await License.init();
    const csv2 = CSV + 'גן שקד,אישור בטיחות,2026-02-01,2027-02-01\n'; const r = await up(t, Buffer.from(csv2, 'utf8'), 'l.csv').expect(200); expect(r.body.actions).toHaveLength(1); expect(r.body.rejected.join(' ')).toMatch(/כבר מופיעים בשורה קודמת/);
    const p2 = await AiProposalClone(r.body.actions[0].proposalId);
    const [a, b2] = await Promise.all([confirm(t, r.body.actions[0].proposalId).result, confirm(t, p2).result]);
    expect([a.status, b2.status].sort()).toEqual([200, 409]); expect(await License.countDocuments({ branchId: b._id, lifecycle: 'Active' })).toBe(1);
  });
  it('fails closed when the live partial unique index is absent: no proposal and no create', async () => {
    const { t, b, License } = await setup(); await License.init();
    const r = await up(t, Buffer.from(CSV, 'utf8'), 'l.csv').expect(200); const id = r.body.actions[0].proposalId;
    await License.collection.dropIndex('branchId_1_licenseTypeId_1');
    try {
      const n = await up(t, Buffer.from(CSV, 'utf8'), 'l.csv').expect(503); expect(n.body.message).toMatch(/חסרה הגנה במסד הנתונים/);
      const c = await confirm(t, id).result; expect(c.status).toBe(503); expect(await License.countDocuments({ branchId: b._id })).toBe(0);
    } finally { await License.syncIndexes(); await License.init(); }
  });
  it('rows are refused by number: unknown branch, unknown type, bad dates, expiry before issue, formula cell; Manager and pdf refused', async () => {
    const { t } = await setup();
    const g = 'סניף,סוג אישור,תאריך הנפקה,תאריך תפוגה\nגן זהב,אישור בטיחות,2026-01-01,2027-01-01\nגן שקד,סוג אחר,2026-01-01,2027-01-01\nגן שקד,אישור בטיחות,2026-02-30,2027-01-01\nגן שקד,אישור בטיחות,2027-01-01,2026-01-01\n=x,אישור בטיחות,2026-01-01,2027-01-01\n';
    const r = await up(t, Buffer.from(g, 'utf8'), 'l.csv').expect(200); expect(r.body.actions).toHaveLength(0); const m = r.body.rejected.join('|');
    expect(m).toMatch(/שורה 2: הסניף "גן זהב" לא נמצא/); expect(m).toMatch(/שורה 3: סוג האישור "סוג אחר"/); expect(m).toMatch(/שורה 4: תאריך/); expect(m).toMatch(/שורה 5: תאריך התפוגה חייב/); expect(m).toMatch(/שורה 6: ערך שמתחיל בתו חשוד/);
    await up(t, Buffer.from('%PDF-1.4\n'), 'a.pdf').expect(400);
    const jwt = (await import('jsonwebtoken')).default; const mg = await User.create({ name: 'mg', email: `m-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Manager', aiEnabled: true });
    await up(jwt.sign({ id: mg._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }), Buffer.from(CSV, 'utf8'), 'l.csv').expect(403);
  });
});
const AiProposalClone = async (id) => { const AiProposal = (await import('../src/models/AiProposal.js')).default; const d = await AiProposal.findById(id).lean(); const { _id, ...rest } = d; return String((await AiProposal.create(rest))._id); };
