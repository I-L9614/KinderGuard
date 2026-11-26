import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
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
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });


describe('agreement payer choice and direction (own file: step-up route has a per-IP limiter)', () => {
  const mkAgr = async (u, extra = {}) => { const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` }); const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) }).catch(async () => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}` })); return RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra }); };
  const prop = (t, a, prompt = 'x') => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${t}`).send({ prompt }); };
  const confirm = (t, id, withGrant = true) => { const pr = (async () => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await (await import('../src/models/AiProposal.js')).default.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); })(); return { result: pr, expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
  it('update direction end to end: needs the grant and the user words, flips only the direction, payments untouched', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u);
    expect((await RentAgreement.findById(ag._id)).direction).toBe('outgoing');
    const none = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), direction: 'incoming' }, 'שנה את ההסכם').expect(200)).body; expect(none.actions).toHaveLength(0);
    const r = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), direction: 'incoming' }, 'ההסכם הזה הפוך: הרשות משלמת לנו').expect(200)).body; const a = r.actions[0];
    expect(a.changes).toEqual({ direction: 'incoming' });
    await confirm(t, a.proposalId, false).expect(403); expect((await RentAgreement.findById(ag._id)).direction).toBe('outgoing');
    await confirm(t, a.proposalId).expect(200);
    const after = await RentAgreement.findById(ag._id); expect(after.direction).toBe('incoming'); expect(after.monthlyAmount).toBe(1000);
  });
  it('create_agreement with similar-named payers: pick from the card candidates only; unlisted or foreign ids refused; name must be in the request; duplicate still refused', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const o = await mk({ aiEnabled: true });
    const b = await Branch.create({ adminId: u._id, name: 'גן בורר' }); const p1 = await Authority.create({ adminId: u._id, name: 'עיריית נחל' }); const p2 = await Authority.create({ adminId: u._id, name: 'עיריית נחל מזרח' });
    const fo = await Authority.create({ adminId: o.u._id, name: 'עיריית נחל זרה' });
    const P = 'צור הסכם שכירות לגן בורר מול עיריית נחל, הרשות משלמת לנו 3000 בחודש בהעברה, פרעון ראשון 1.2.2031';
    const full = { type: 'create_agreement', branchId: String(b._id), authorityId: String(p1._id), monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' };
    expect((await prop(t, full, P.replace('מול עיריית נחל', 'מול רשות')).expect(200)).body.actions).toHaveLength(0);
    const a = (await prop(t, full, P).expect(200)).body.actions[0]; expect(a).toMatchObject({ needsChoice: true, choiceField: 'agreementPayer', branchName: 'גן בורר', authorityId: null }); expect(a.candidates.map((x) => x.name).sort()).toEqual(['עיריית נחל', 'עיריית נחל מזרח']);
    const grant = async () => (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: a.proposalId })).body.stepUpToken;
    const cf = async (body) => request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', await grant()).send(body);
    expect((await cf({ branchId: String(fo._id) })).status).toBe(400);
    expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    expect((await cf({ branchId: String(p2._id) })).status).toBe(200);
    const made = await RentAgreement.findOne({ adminId: u._id }); expect(made.authorityName).toBe('עיריית נחל מזרח'); expect(String(made.authorityId)).toBe(String(p2._id)); expect(made.monthlyAmount).toBe(3000);
  });
});
