import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeAuthorityActions } from '../src/ai/authorityActions.js';
let AiProposal; let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
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
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js')); ({ default: Authority } = await import('../src/models/Authority.js')); ({ default: RentAgreement } = await import('../src/models/RentAgreement.js'));
  ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const AU = [{ _id: 'x1', name: 'עיריית פתח תקווה', type: 'council', activeAgreements: 0, updatedAt: new Date('2026-06-01') }, { _id: 'x2', name: 'עיריית פתח תקווה - מחלקה', type: 'council', activeAgreements: 0, updatedAt: new Date('2026-06-01') }, { _id: 'x3', name: 'חברת גנים', type: 'council', activeAgreements: 2, updatedAt: new Date('2026-06-01') }];
describe('sanitizeAuthorityActions', () => {
  it('refuses exact duplicate, formula names, unknown ids and active agreements; warns on similar; delete with similar names needs a choice', () => {
    const r = sanitizeAuthorityActions(JSON.stringify({ actions: [{ type: 'create_authority', name: 'עיריית  פתח תקווה' }, { type: 'create_authority', name: '=HYPERLINK("x")' }, { type: 'create_authority', name: 'עיריית פתח', kind: 'private' }, { type: 'delete_authority', authorityId: 'zz' }, { type: 'delete_authority', authorityId: 'x3' }, { type: 'delete_authority', authorityId: 'x1' }, { type: 'drop_db' }] }), AU);
    expect(r.actions.map((a) => a.type)).toEqual(['create_authority', 'delete_authority']);
    expect(r.actions[0].warning).toMatch(/דומה/); expect(r.actions[1].needsChoice).toBe(true); expect(r.actions[1].candidates).toHaveLength(2); expect(r.rejected).toHaveLength(5);
  });
});
describe('authority actions end to end', () => {
  const prop = (t, a) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/authorities/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const confirm = async (t, id, withGrant = true, bodyObj = {}) => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await AiProposal.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send(bodyObj); };
  it('create runs through the controller, a duplicate made meanwhile is refused', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const p = await prop(t, { type: 'create_authority', name: 'רשות חדשה', kind: 'private' }); expect(p.status).toBe(200);
    await Authority.create({ adminId: u._id, name: 'רשות  חדשה', type: 'council' });
    const bad = await confirm(t, p.body.actions[0].proposalId, false); expect(bad.status).toBe(409);
    const p2 = await prop(t, { type: 'create_authority', name: 'אחרת', kind: 'private' });
    expect((await confirm(t, p2.body.actions[0].proposalId, false)).status).toBe(200);
    expect((await Authority.findOne({ adminId: u._id, name: 'אחרת' })).type).toBe('private');
  });
  it('concurrent identical creates: the database index lets only one through', async () => {
    const { u } = await mk({ aiEnabled: true }); await Authority.createIndexes();
    const { createAuthority } = await import('../src/controllers/rentController.js');
    const run = () => new Promise((r) => { const res = { status(c) { this.c = c; return this; }, json() { r(this.c || 200); return this; } }; createAuthority({ user: u, checkDuplicateName: true, body: { name: 'מקביל', type: 'council' } }, res); });
    const out = await Promise.all([run(), run(), run()]); expect(out.filter((c) => c === 201).length).toBe(1); expect(await Authority.countDocuments({ adminId: u._id, name: 'מקביל' })).toBe(1);
  });
  it('delete: an agreement create racing the delete unwinds itself - the delete wins and nothing dangles', async () => {
    const { u } = await mk({ aiEnabled: true }); const a = await Authority.create({ adminId: u._id, name: 'מרוץ', type: 'council' }); const b = await Branch.create({ adminId: u._id, name: 'גן מרוץ' });
    const { deleteAuthority, createAgreement } = await import('../src/controllers/rentController.js');
    let release; const gate = new Promise((r) => { release = r; }); let entered; const enteredP = new Promise((r) => { entered = r; });
    const origCreate = RentAgreement.create.bind(RentAgreement);
    RentAgreement.create = async (...x) => { entered(); await gate; return origCreate(...x); };
    const cres = { c: 200, status(c) { this.c = c; return this; }, json() { return this; } };
    const cP = createAgreement({ user: u, body: { branchId: String(b._id), authorityId: String(a._id) } }, cres);
    try {
      await enteredP; // create validated against the pre-delete snapshot and pauses at the insert
      const dres = { c: 200, status(c) { this.c = c; return this; }, json() { return this; } };
      await deleteAuthority({ user: u, params: { id: String(a._id) } }, dres);
      expect(dres.c).toBe(200);
      release();
      await cP;
    } finally { RentAgreement.create = origCreate; }
    expect(cres.c).toBe(409);
    expect(await RentAgreement.countDocuments({ authorityId: a._id })).toBe(0);
    expect(await Authority.findById(a._id)).toBeNull();
  });
  it('delete needs the step-up, is refused for stale version and active agreements, and works otherwise', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const a1 = await Authority.create({ adminId: u._id, name: 'רשות למחיקה', type: 'council' });
    const p = await prop(t, { type: 'delete_authority', authorityId: String(a1._id) }); const id = p.body.actions[0].proposalId;
    expect((await confirm(t, id, false)).status).toBeGreaterThanOrEqual(400); expect(await Authority.findById(a1._id)).toBeTruthy();
    await Authority.updateOne({ _id: a1._id }, { $set: { name: 'רשות למחיקה שונתה' } });
    expect((await confirm(t, id)).status).toBe(409); expect(await Authority.findById(a1._id)).toBeTruthy();
    const p2 = await prop(t, { type: 'delete_authority', authorityId: String(a1._id) });
    expect((await confirm(t, p2.body.actions[0].proposalId)).status).toBe(200); expect(await Authority.findById(a1._id)).toBeNull();
    const a2 = await Authority.create({ adminId: u._id, name: 'עם הסכם', type: 'council' }); const b = await Branch.create({ adminId: u._id, name: 'גן ב' });
    await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: a2._id, direction: 'outgoing', monthlyAmount: 1, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), status: 'Active' });
    const p3 = await prop(t, { type: 'delete_authority', authorityId: String(a2._id) }); expect(p3.body.actions).toHaveLength(0); expect(p3.body.rejected[0]).toMatch(/הסכמים פעילים/);
  });
  it('similar names need an explicit choice; another admin and a non-AI user cannot use it', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const s1 = await Authority.create({ adminId: u._id, name: 'עירייה', type: 'council' }); const s2 = await Authority.create({ adminId: u._id, name: 'עירייה צפון', type: 'council' });
    const p = await prop(t, { type: 'delete_authority', authorityId: String(s1._id) }); const a = p.body.actions[0]; expect(a.needsChoice).toBe(true);
    expect((await confirm(t, a.proposalId)).status).toBe(400); expect(await Authority.countDocuments({ adminId: u._id })).toBe(2);
    const ok = await confirm(t, a.proposalId, true, { branchId: String(s2._id) }); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await Authority.findById(s2._id)).toBeNull(); expect(await Authority.findById(s1._id)).toBeTruthy();
    const o = await mk({ aiEnabled: false }); expect((await request(app).post('/api/ai/authorities/propose').set('Authorization', `Bearer ${o.t}`).send({ prompt: 'x' })).status).toBe(403);
  });
});
