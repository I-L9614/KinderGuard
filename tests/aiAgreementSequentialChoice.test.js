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

describe('sequential branch then payer choice for create_agreement (own file: step-up route has a per-IP limiter)', () => {
  const prop = (t, a, prompt) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${t}`).send({ prompt }); };
  const setup = async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const o = await mk({ aiEnabled: true });
    const b1 = await Branch.create({ adminId: u._id, name: 'גן בורר' }); const b2 = await Branch.create({ adminId: u._id, name: 'גן בורר צפון' }); const fb = await Branch.create({ adminId: o.u._id, name: 'גן בורר זר' });
    const p1 = await Authority.create({ adminId: u._id, name: 'עיריית נחל' }); const p2 = await Authority.create({ adminId: u._id, name: 'עיריית נחל מזרח' });
    const P = 'צור הסכם שכירות לגן בורר מול עיריית נחל, הרשות משלמת לנו 3000 בחודש בהעברה, פרעון ראשון 1.2.2031';
    const full = { type: 'create_agreement', branchId: String(b1._id), authorityId: String(p1._id), monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' };
    const step = (await prop(t, full, P).expect(200)).body.actions[0];
    return { u, t, o, b1, b2, fb, p1, p2, step };
  };
  const doStep = (t, id, branchId) => request(app).post(`/api/ai/agreements/step/${id}`).set('Authorization', `Bearer ${t}`).send({ branchId });
  it('both ambiguous: a step card first, no write, never confirmable; the branch pick yields the ordinary payer-choice proposal; the final confirm uses the grant and the picked pair', async () => {
    const { u, t, b1, b2, fb, p2, step } = await setup(); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    expect(step).toMatchObject({ type: 'create_agreement_step', needsChoice: true, sensitive: false, authorityId: null, branchId: null }); expect(step.candidates.map((x) => x.name).sort()).toEqual(['גן בורר', 'גן בורר צפון']);
    expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    const gen = await request(app).post(`/api/ai/proposals/${step.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ branchId: String(b1._id) }); expect(gen.status).toBe(400);
    const stored = await AiProposal.findById(step.proposalId); expect(stored.status).toBe('pending'); expect(stored.action.needsChoice).toBe(true); expect(stored.action.branchId).toBeNull();
    expect((await doStep(t, step.proposalId, String(fb._id))).status).toBe(400); expect((await doStep(t, step.proposalId, 'zzz')).status).toBe(400); expect((await AiProposal.findById(step.proposalId)).status).toBe('pending');
    const r = await doStep(t, step.proposalId, String(b2._id)); expect(r.status).toBe(200); const a = r.body.actions[0];
    expect(a).toMatchObject({ type: 'create_agreement', sensitive: true, needsChoice: true, choiceField: 'agreementPayer', branchName: 'גן בורר צפון', authorityId: null }); expect(a.changes.monthlyAmount).toBe(3000); expect(a.candidates.map((x) => x.name).sort()).toEqual(['עיריית נחל', 'עיריית נחל מזרח']);
    expect((await AiProposal.findById(step.proposalId)).status).toBe('done'); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    const again = await doStep(t, step.proposalId, String(b2._id)); expect(again.status).toBe(200); expect(again.body.actions[0].proposalId).toBe(a.proposalId);
    expect((await doStep(t, step.proposalId, String(b1._id))).status).toBe(409);
    expect(await AiProposal.countDocuments({ 'action.type': 'create_agreement', userId: u._id })).toBe(1);
    const nogrant = await request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ branchId: String(p2._id) }); expect(nogrant.status).toBe(403); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    const g = (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: a.proposalId })).body.stepUpToken;
    expect((await request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g).send({ branchId: String(p2._id) })).status).toBe(200);
    const made = await RentAgreement.find({ adminId: u._id }); expect(made).toHaveLength(1); expect(String(made[0].branchId)).toBe(String(b2._id)); expect(String(made[0].authorityId)).toBe(String(p2._id));
  });
  it('a renamed branch refuses the step without consuming it; two parallel picks create one follow-up; a Manager is refused', async () => {
    const { u, t, b1, b2, step } = await setup(); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    await AiProposal.updateOne({ _id: step.proposalId }, { expiresAt: new Date(Date.now() - 1000) }); const exp = await doStep(t, step.proposalId, String(b1._id)); expect(exp.status).toBe(410); expect(await AiProposal.countDocuments({ 'action.type': 'create_agreement', userId: u._id })).toBe(0); await AiProposal.updateOne({ _id: step.proposalId }, { expiresAt: new Date(Date.now() + 600000) });
    await Branch.updateOne({ _id: b2._id }, { name: 'שם חדש' }); const stale = await doStep(t, step.proposalId, String(b2._id)); expect(stale.status).toBe(409); expect((await AiProposal.findById(step.proposalId)).status).toBe('pending');
    const rs = await Promise.all([doStep(t, step.proposalId, String(b1._id)), doStep(t, step.proposalId, String(b1._id))]); expect(rs.some((x) => x.status === 200)).toBe(true);
    expect(await AiProposal.countDocuments({ 'action.type': 'create_agreement', userId: u._id })).toBe(1);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); expect((await doStep(m.t, step.proposalId, String(b1._id))).status).toBe(403);
  });
  it('gated parallel: the first pick is paused after its reads, a second pick finishes, then the first resumes; exactly one follow-up exists and the loser never double-creates', async () => {
    const { u, t, b1, b2, step } = await setup(); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    for (const [firstBranch, secondBranch] of [[b1, b1], [b1, b2]]) {
      await AiProposal.deleteMany({ userId: u._id, 'action.type': 'create_agreement' }); await AiProposal.updateOne({ _id: step.proposalId }, { status: 'pending', result: null });
      let release; const gate = new Promise((r) => { release = r; }); let paused = false; const orig = Branch.findOne.bind(Branch); let first = true;
      const spy = vi.spyOn(Branch, 'findOne').mockImplementation((...a) => { const q = orig(...a); if (first && a[0] && a[0].deleting) { first = false; const sel = q.select.bind(q); q.select = (...x) => { const qq = sel(...x); const th = qq.then.bind(qq); qq.then = (res, rej) => { paused = true; return gate.then(() => th(res, rej)); }; return qq; }; } return q; });
      const p1 = doStep(t, step.proposalId, String(firstBranch._id)).then((r) => r);
      for (let i = 0; i < 100 && !paused; i += 1) await new Promise((r) => setTimeout(r, 20));
      expect(paused).toBe(true); expect((await AiProposal.findById(step.proposalId)).status).toBe('pending');
      const r2 = await doStep(t, step.proposalId, String(secondBranch._id)); expect(r2.status).toBe(200);
      release(); const r1 = await p1; spy.mockRestore();
      expect(await AiProposal.countDocuments({ userId: u._id, 'action.type': 'create_agreement' })).toBe(1);
      const only = await AiProposal.findOne({ userId: u._id, 'action.type': 'create_agreement' }); expect(String(only.action.branchId)).toBe(String(secondBranch._id));
      if (String(firstBranch._id) === String(secondBranch._id)) { expect(r1.status).toBe(200); expect(r1.body.actions[0].proposalId).toBe(r2.body.actions[0].proposalId); } else { expect(r1.status).toBe(409); expect(r1.body.message).toContain('כבר נבחר סניף אחר'); }
    }
  });
  it('a step that is still executing answers still-processing wording, not already-handled', async () => {
    const { t, b1, step } = await setup(); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    await AiProposal.updateOne({ _id: step.proposalId }, { status: 'executing' }); const r = await doStep(t, step.proposalId, String(b1._id)); expect(r.status).toBe(409); expect(r.body.message).toContain('עדיין בעיבוד'); expect(r.body.message).not.toContain('כבר טופל');
    await AiProposal.updateOne({ _id: step.proposalId }, { status: 'pending' }); expect((await doStep(t, step.proposalId, String(b1._id))).status).toBe(200);
  });
});
