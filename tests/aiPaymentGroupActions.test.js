import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeGroupActions } from '../src/ai/paymentGroupActions.js';
const deleted = [];
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(async () => 'k'), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn(async (k) => { deleted.push(k); }) }));
let RentPayment; let RentPaymentGroup; let Notification; let RentReminder; let License; let LicenseType; let AiProposal; let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
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
  ({ default: RentPayment } = await import('../src/models/RentPayment.js')); ({ default: RentPaymentGroup } = await import('../src/models/RentPaymentGroup.js'));
  ({ default: Notification } = await import('../src/models/Notification.js')); ({ default: RentReminder } = await import('../src/models/RentReminder.js')); ({ default: License } = await import('../src/models/License.js')); ({ default: LicenseType } = await import('../src/models/LicenseType.js'));
  ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const P = (id, over = {}) => ({ _id: id, authorityId: 'a1', authorityName: 'עירייה', method: 'cheque', branchName: `סניף ${id}`, amount: 100, dueDate: new Date('2027-01-05'), ...over });
const G = (id, over = {}) => ({ _id: id, authorityName: 'עירייה', method: 'cheque', totalAmount: 300, dueDate: new Date('2027-01-05'), status: 'Pending', updatedAt: new Date('2027-01-01'), allocations: [{ branchName: 'א', amount: 300 }], ...over });
describe('sanitizeGroupActions', () => {
  it('validates same authority/method, explicit due date, status preconditions, reasons', () => {
    const ctx = { payments: [P('p1'), P('p2'), P('p3', { authorityId: 'a2' }), P('p4', { method: 'transfer' })], groups: [G('g1'), G('g2', { status: 'Cleared' }), G('g3', { method: 'transfer' })] };
    const r = sanitizeGroupActions(JSON.stringify({ actions: [{ type: 'create_payment_group', paymentIds: ['p1', 'p2'], dueDate: '2027-02-01' }, { type: 'create_payment_group', paymentIds: ['p3', 'p1'], dueDate: '2027-02-01' }, { type: 'create_payment_group', paymentIds: ['p1', 'p4'], dueDate: '2027-02-01' }, { type: 'create_payment_group', paymentIds: ['p2'], dueDate: 'מחר' }, { type: 'group_mark_handed', groupId: 'g1' }, { type: 'group_mark_cleared', groupId: 'g2' }, { type: 'group_mark_handed', groupId: 'g3' }, { type: 'cancel_payment_group', groupId: 'g1' }, { type: 'drop', groupId: 'g1' }] }), ctx);
    expect(r.actions.map((a) => a.type)).toEqual(['create_payment_group', 'group_mark_handed']); expect(r.actions[0].total).toBe(200); expect(r.actions[1].sensitive).toBe(true); expect(r.rejected).toHaveLength(7);
  });
});
describe('payment group actions end to end', () => {
  const prop = (t, acts) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: acts }), costUsd: 0 }); return request(app).post('/api/ai/payment-groups/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const confirm = async (t, id, withGrant = true) => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await AiProposal.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); };
  const seed = async (u, n = 2) => { const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random()}` }); const out = []; for (let k = 0; k < n; k++) { const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random()}` }); out.push(await RentPayment.create({ adminId: u._id, agreementId: new mongoose.Types.ObjectId(), branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, dueDate: new Date('2027-01-05'), amount: 100 + k, method: 'cheque' })); } return { au, ps: out }; };
  it('create is normal and links the payments; a payment already in a group is not proposable', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { ps } = await seed(u);
    const p = await prop(t, [{ type: 'create_payment_group', paymentIds: ps.map((x) => String(x._id)), dueDate: '2027-02-01', note: 'n' }]); expect(p.body.actions).toHaveLength(1);
    const ok = await confirm(t, p.body.actions[0].proposalId, false); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const g = await RentPaymentGroup.findOne({ adminId: u._id }); expect(g.totalAmount).toBe(201); expect((await RentPayment.find({ groupId: g._id })).length).toBe(2);
    const q = await prop(t, [{ type: 'create_payment_group', paymentIds: [String(ps[0]._id)], dueDate: '2027-02-01' }]); expect(q.body.actions).toHaveLength(0);
  });
  it('handed then cleared need step-up and move the payments; stale proposal refused', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { ps } = await seed(u);
    const c = await prop(t, [{ type: 'create_payment_group', paymentIds: ps.map((x) => String(x._id)), dueDate: '2027-02-01' }]); await confirm(t, c.body.actions[0].proposalId, false); const g = await RentPaymentGroup.findOne({ adminId: u._id });
    const p = await prop(t, [{ type: 'group_mark_handed', groupId: String(g._id) }]); const id = p.body.actions[0].proposalId;
    expect((await confirm(t, id, false)).status).toBeGreaterThanOrEqual(400); expect((await RentPaymentGroup.findById(g._id)).status).toBe('Pending');
    await RentPaymentGroup.updateOne({ _id: g._id }, { $set: { note: 'changed' } });
    expect((await confirm(t, id)).status).toBe(409); expect((await RentPaymentGroup.findById(g._id)).status).toBe('Pending');
    const p2 = await prop(t, [{ type: 'group_mark_handed', groupId: String(g._id) }]); expect((await confirm(t, p2.body.actions[0].proposalId)).status).toBe(200);
    expect((await RentPayment.find({ groupId: g._id })).every((x) => x.status === 'Handed')).toBe(true);
    const p3 = await prop(t, [{ type: 'group_mark_cleared', groupId: String(g._id) }]); expect((await confirm(t, p3.body.actions[0].proposalId)).status).toBe(200);
    expect((await RentPayment.find({ groupId: g._id })).every((x) => x.status === 'Cleared')).toBe(true);
  });
  it('cancel needs a reason, returns payments to ungrouped pending; cleared cannot be cancelled; other admin not reachable', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { ps } = await seed(u);
    const c = await prop(t, [{ type: 'create_payment_group', paymentIds: ps.map((x) => String(x._id)), dueDate: '2027-02-01' }]); await confirm(t, c.body.actions[0].proposalId, false); const g = await RentPaymentGroup.findOne({ adminId: u._id });
    expect((await prop(t, [{ type: 'cancel_payment_group', groupId: String(g._id) }])).body.actions).toHaveLength(0);
    const p = await prop(t, [{ type: 'cancel_payment_group', groupId: String(g._id), reason: 'נרשם בטעות' }]); expect((await confirm(t, p.body.actions[0].proposalId)).status).toBe(200);
    expect((await RentPaymentGroup.findById(g._id)).status).toBe('Cancelled'); const back = await RentPayment.find({ _id: { $in: ps.map((x) => x._id) } }); expect(back.every((x) => x.status === 'Pending' && !x.groupId)).toBe(true);
    const o = await mk({ aiEnabled: true }); expect((await prop(o.t, [{ type: 'group_mark_cleared', groupId: String(g._id) }])).body.actions).toHaveLength(0);
  });
});

describe('payment group creation race', () => {
  it('two concurrent groupings of the same payment: exactly one wins, the loser unwinds with 409', async () => {
    const { createPaymentGroup } = await import('../src/controllers/rentController.js');
    const { u } = await mk({ aiEnabled: true });
    const au = await Authority.create({ adminId: u._id, name: `רשות מרוץ ${Math.random()}` });
    const b1 = await Branch.create({ adminId: u._id, name: `גן א ${Math.random()}` });
    const b2 = await Branch.create({ adminId: u._id, name: `גן ב ${Math.random()}` });
    const mkP = (b, amount) => RentPayment.create({ adminId: u._id, agreementId: new mongoose.Types.ObjectId(), branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, dueDate: new Date('2027-01-05'), amount, method: 'cheque' });
    const shared = await mkP(b1, 100);
    const onlyA = await mkP(b2, 200);
    const call = (paymentIds) => new Promise((resolve) => {
      const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } };
      createPaymentGroup({ user: { role: 'Admin', _id: u._id }, body: { authorityId: String(au._id), method: 'cheque', dueDate: '2027-02-01', note: '', paymentIds } }, res)
        .then((v) => resolve({ code: res.code, v })).catch((e) => resolve({ code: 500, e: String(e) }));
    });
    // A is held just before its group write - after its read checks; B groups
    // the shared payment to completion while A's checks are already stale.
    let release; const gate = new Promise((r) => { release = r; });
    let entered; const enteredP = new Promise((r) => { entered = r; });
    const orig = RentPaymentGroup.create;
    const spy = vi.spyOn(RentPaymentGroup, 'create').mockImplementationOnce(async (...args) => { entered(); await gate; return orig.apply(RentPaymentGroup, args); });
    const a = call([String(shared._id), String(onlyA._id)]);
    await enteredP;
    const b = await call([String(shared._id)]);
    expect(b.code, JSON.stringify(b)).toBe(201);
    release();
    const ra = await a;
    spy.mockRestore();
    expect(ra.code, JSON.stringify(ra)).toBe(409);
    expect(ra.v.message).toBe('חלק מהתשלומים כבר שובצו לתשלום מרוכז אחר');
    // Exactly one group survives; the shared payment belongs to the winner;
    // the loser's exclusive payment is released, never double-linked.
    expect(await RentPaymentGroup.countDocuments({ adminId: u._id })).toBe(1);
    const winner = await RentPaymentGroup.findOne({ adminId: u._id });
    expect(winner.allocations).toHaveLength(1);
    expect(String((await RentPayment.findById(shared._id)).groupId)).toBe(String(winner._id));
    expect((await RentPayment.findById(onlyA._id)).groupId).toBeNull();
  });
});
