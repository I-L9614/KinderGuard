import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeAgreementActions } from '../src/ai/agreementActions.js';

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

describe('agreement actions end to end', () => {
  const mkAgr = async (u, extra = {}) => { const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` }); const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) }).catch(async () => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}` })); return RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra }); };
  const prop = (t, a, prompt = 'x') => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${t}`).send({ prompt }); };
  const confirm = (t, id, withGrant = true) => { const pr = (async () => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await (await import('../src/models/AiProposal.js')).default.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); })(); return { result: pr, expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
  it('cheque series: needs the grant, traced to the request, replaces the series through the controller', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u, { paymentMethod: 'cheque' });
    const cp = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), chequeSeries: { depositedCount: 3, seriesEndDate: '2031-06-30' } }, 'הופקדו 3 צ׳קים וסיום הסדרה 30.6.2031').expect(200)).body.actions[0];
    await confirm(t, cp.proposalId, false).expect(403); expect((await RentAgreement.findById(ag._id)).chequeSeries?.seriesEndDate).toBeFalsy();
    await confirm(t, cp.proposalId).expect(200); const cs = (await RentAgreement.findById(ag._id)).chequeSeries; expect(cs.depositedCount).toBe(3); expect(cs.seriesEndDate.toISOString().slice(0, 10)).toBe('2031-06-30');
  });
  it('create with custom dates and cheque series: needs the grant, stores exactly the traced schedule', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' });
    const b = await Branch.create({ adminId: u._id, name: 'גן מותאם' }); const au = await Authority.create({ adminId: u._id, name: 'עירית מותאם' });
    const P = 'צור הסכם שכירות חדש, הרשות משלמת לנו 2000 בחודש בצ׳קים במועדים מותאמים: 1.2.2031 ו-1.8.2031, פרעון ראשון 1.2.2031, הופקדו 2 צ׳קים וסיום הסדרה 31.12.2031';
    const act = { type: 'create_agreement', branchId: String(b._id), authorityId: String(au._id), monthlyAmount: 2000, frequency: 'custom', paymentMethod: 'cheque', firstDueDate: '2031-02-01', direction: 'incoming', customDueDates: ['2031-02-01', '2031-08-01'], chequeSeries: { depositedCount: 2, seriesEndDate: '2031-12-31' } };
    const a = (await prop(t, act, P).expect(200)).body.actions[0]; expect(a.changes.customDueDates).toHaveLength(2);
    await confirm(t, a.proposalId, false).expect(403); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    await confirm(t, a.proposalId).expect(200);
    const made = await RentAgreement.findOne({ adminId: u._id }).lean(); expect(made.frequency).toBe('custom'); expect(made.customDueDates.map((d) => d.toISOString().slice(0, 10))).toEqual(['2031-02-01', '2031-08-01']); expect(made.chequeSeries.depositedCount).toBe(2);
  });
});
