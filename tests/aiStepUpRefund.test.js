import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let Task; let AiProposal; let StepUpGrant; let ask;
const mk = async (extra) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `x-${Math.random().toString(36).slice(2)}`, email: `a-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
  return { u, t: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};
const grant = async (t, action, scope) => (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action, scope }).expect(200)).body.stepUpToken;
const confirm = (t, id, token) => {
  const r = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`);
  if (token) r.set('X-Step-Up', token);
  return r.send({});
};
const propose = async (t, actions) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions }), costUsd: 0 }); return (await request(app).post('/api/ai/tasks/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }).expect(200)).body.actions; };

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.LOGIN_RATE_LIMIT_MAX = '1000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js'));
  ({ default: Task } = await import('../src/models/Task.js'));
  ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  ({ default: StepUpGrant } = await import('../src/models/StepUpGrant.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"ok","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
  const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('step-up grants bound to one proposal', () => {
  it('a stale-proposal 409 refunds the grant; retrying the same proposal with the same token succeeds, and after success it is spent', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const task = await Task.create({ adminId: u._id, createdBy: u._id, title: 'למחיקה' });
    const [a] = await propose(t, [{ type: 'delete_task', taskId: String(task._id) }]);
    const token = await grant(t, 'ai:delete_task', a.proposalId);
    await Task.updateOne({ _id: task._id }, { title: 'שונה בינתיים' });
    await confirm(t, a.proposalId, token).expect(409);
    expect(await Task.findById(task._id)).toBeTruthy();
    // Refunded: the retry of the SAME proposal does not ask for the password again.
    await Task.updateOne({ _id: task._id }, { title: 'למחיקה' });
    await confirm(t, a.proposalId, token).expect(200);
    expect(await Task.findById(task._id)).toBeNull();
    // Spent for good after the successful run; a re-confirm is the stored duplicate.
    const dup = await confirm(t, a.proposalId, token).expect(200);
    expect(dup.body.duplicate).toBe(true);
  });

  it('a grant for proposal A never opens proposal B, even after a refund', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const t1 = await Task.create({ adminId: u._id, createdBy: u._id, title: 'אחת' });
    const t2 = await Task.create({ adminId: u._id, createdBy: u._id, title: 'שתיים' });
    const [a] = await propose(t, [{ type: 'delete_task', taskId: String(t1._id) }]);
    const [b] = await propose(t, [{ type: 'delete_task', taskId: String(t2._id) }]);
    const token = await grant(t, 'ai:delete_task', a.proposalId);
    await confirm(t, b.proposalId, token).expect(403);
    // Force a refund on A (stale), then try B again: binding still refuses.
    await Task.updateOne({ _id: t1._id }, { title: 'שונה' });
    await confirm(t, a.proposalId, token).expect(409);
    await confirm(t, b.proposalId, token).expect(403);
    expect(await Task.findById(t2._id)).toBeTruthy();
  });

  it('simultaneous confirms with one grant execute exactly once', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const task = await Task.create({ adminId: u._id, createdBy: u._id, title: 'כפולה' });
    const [a] = await propose(t, [{ type: 'delete_task', taskId: String(task._id) }]);
    const token = await grant(t, 'ai:delete_task', a.proposalId);
    const [r1, r2] = await Promise.all([confirm(t, a.proposalId, token), confirm(t, a.proposalId, token)]);
    // Timing decides how the loser is answered: 403 when it hits the grant check while the winner is running, or
    // an idempotent 200 duplicate when the winner already finished. Either way exactly one execution happens.
    const codes = [r1.status, r2.status].sort();
    expect([[200, 403], [200, 200]]).toContainEqual(codes);
    expect([r1, r2].filter((r) => r.status === 200 && r.body.duplicate !== true)).toHaveLength(1);
    expect(await Task.findById(task._id)).toBeNull();
    const doc = await AiProposal.findById(a.proposalId);
    expect(doc.status).toBe('done');
  });

  it('an expired proposal fails 410 without consuming the grant', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const task = await Task.create({ adminId: u._id, createdBy: u._id, title: 'פגה' });
    const [a] = await propose(t, [{ type: 'delete_task', taskId: String(task._id) }]);
    const token = await grant(t, 'ai:delete_task', a.proposalId);
    await AiProposal.updateOne({ _id: a.proposalId }, { expiresAt: new Date(Date.now() - 1000) });
    await confirm(t, a.proposalId, token).expect(410);
    const g = await StepUpGrant.findOne({ action: 'ai:delete_task' }).sort({ createdAt: -1 });
    expect(g.usedAt).toBeNull(); // still unused; it simply cannot help an expired proposal
  });


  it('a rent revert proposal cannot run the status transition twice after a partial failure', async () => {
    const { default: RentPayment } = await import('../src/models/RentPayment.js');
    const { u, t } = await mk({ aiEnabled: true });
    const id = new mongoose.Types.ObjectId();
    const p = await RentPayment.create({ adminId: u._id, agreementId: id, branchId: id, authorityId: id, branchName: 'גן', authorityName: 'רשות', dueDate: new Date(), amount: 1000, method: 'cheque', status: 'Cleared', paidAt: new Date(), clearedAt: new Date() });
    ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [{ type: 'rent_revert_payment', paymentId: String(p._id), reason: 'נרשם בטעות' }] }), costUsd: 0 });
    const r = await request(app).post('/api/ai/rent/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }).expect(200);
    const a = r.body.actions[0];
    expect(a.currentStatus).toBe('Cleared');
    const token = await grant(t, 'ai:rent_revert_payment', a.proposalId);
    await confirm(t, a.proposalId, token).expect(200);
    expect((await RentPayment.findById(p._id)).status).toBe('Handed');
    // Simulate the partial-failure window: the mutation applied but the
    // proposal stayed pending and the grant was refunded. The retry must NOT
    // run the transition again (Handed would revert to Pending with a second
    // audit row); it fails 409 and the payment stays Handed.
    await AiProposal.updateOne({ _id: a.proposalId }, { status: 'pending' });
    const g = await StepUpGrant.findOne({ action: 'ai:rent_revert_payment' }).sort({ createdAt: -1 });
    await StepUpGrant.updateOne({ _id: g._id }, { usedAt: null });
    await confirm(t, a.proposalId, token).expect(409);
    expect((await RentPayment.findById(p._id)).status).toBe('Handed');
  });

  it('two concurrent reverts of one payment apply the transition exactly once (atomic conditional write)', async () => {
    const { default: RentPayment } = await import('../src/models/RentPayment.js');
    const { default: RentAudit } = await import('../src/models/RentAudit.js');
    const { revertPaymentStatus } = await import('../src/controllers/rentController.js');
    const { u } = await mk({ aiEnabled: true });
    const id = new mongoose.Types.ObjectId();
    const p = await RentPayment.create({ adminId: u._id, agreementId: id, branchId: id, authorityId: id, branchName: 'גן', authorityName: 'רשות', dueDate: new Date(), amount: 1000, method: 'transfer', status: 'Cleared', paidAt: new Date(), clearedAt: new Date() });
    const call = () => new Promise((resolve) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, j: null, json(v) { this.j = v; resolve(this); return this; } };
      revertPaymentStatus({ user: u, params: { id: String(p._id) }, body: { reason: 'מירוץ' } }, res);
    });
    const [r1, r2] = await Promise.all([call(), call()]);
    expect([r1.code, r2.code].sort()).toEqual([200, 409]);
    expect((await RentPayment.findById(p._id)).status).toBe('Pending');
    expect(await RentAudit.countDocuments({ paymentId: p._id, action: 'revert_payment' })).toBe(1);
  });

  it('revoking aiEnabled after the grant was issued blocks the confirm and leaves the grant unconsumed', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const task = await Task.create({ adminId: u._id, createdBy: u._id, title: 'הרשאה' });
    const [a] = await propose(t, [{ type: 'delete_task', taskId: String(task._id) }]);
    const token = await grant(t, 'ai:delete_task', a.proposalId);
    await User.updateOne({ _id: u._id }, { aiEnabled: false });
    await confirm(t, a.proposalId, token).expect(403);
    expect(await Task.findById(task._id)).toBeTruthy();
    const g = await StepUpGrant.findOne({ action: 'ai:delete_task' }).sort({ createdAt: -1 });
    expect(g.usedAt).toBeNull();
  });
});
