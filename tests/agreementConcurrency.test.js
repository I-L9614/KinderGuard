import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// The document routes talk to S3; these tests only assert controller/DB
// behavior, so the storage layer is mocked (calls are still observable).
vi.mock('../src/services/s3Service.js', () => ({
  uploadFileToS3: vi.fn(async () => 'rent/test-key.pdf'),
  downloadFileFromS3: vi.fn(),
  deleteFileFromS3: vi.fn(async () => ({})),
}));

let mongoServer; let User; let Branch; let Authority; let RentAgreement; let RentPayment; let RentPaymentGroup; let RentAudit; let RentReminder;
let updateAgreement; let closeAgreement; let editPayment; let createAgreement; let reconcileGuardedAgreementCreates; let uploadAgreementDocument; let deleteAgreementDocument; let markGroupHanded; let markGroupCleared; let cancelPaymentGroup; let reconcileRentPaymentGroups; let revertGroupStatus;
let s3;

const mk = async (extra) => User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `rc-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
const mkAgr = async (u, extra = {}) => {
  const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` });
  const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) }).catch(async () => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}` }));
  return RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra });
};

const call = (fn, req) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } };
  fn(req, res).then((v) => { if (!res.headersSentFlag) resolve({ code: res.code, v }); }).catch((e) => resolve({ code: 500, e }));
});

// Arms a one-shot gate on the NEXT save() of the model: the first writer
// pauses exactly between its load/validation and its atomic write, a
// competitor runs to completion, and releasing the gate forces the exact
// interleaving a production race would hit - deterministically.
const pauseNextSave = (model) => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = model.prototype.save;
  const spy = vi.spyOn(model.prototype, 'save').mockImplementationOnce(function (...args) {
    entered();
    return gate.then(() => orig.apply(this, args));
  });
  return { release, enteredP, spy };
};

// Same gate for the NEXT findOne(): the writer holds a fully loaded document
// while a competitor mutates the row underneath it.
const pauseAfterNextFindOne = (model) => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = model.findOne;
  const spy = vi.spyOn(model, 'findOne').mockImplementationOnce((...args) => {
    const result = orig.apply(model, args);
    return Promise.resolve(result).then(async (doc) => { entered(); await gate; return doc; });
  });
  return { release, enteredP, spy };
};

// Same gate for the NEXT find(): the writer holds its loaded result set while
// a competitor mutates a row underneath it.
const pauseAfterNextFind = (model) => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = model.find;
  const spy = vi.spyOn(model, 'find').mockImplementationOnce((...args) => {
    const result = orig.apply(model, args);
    return Promise.resolve(result).then(async (docs) => { entered(); await gate; return docs; });
  });
  return { release, enteredP, spy };
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js'));
  ({ default: Branch } = await import('../src/models/Branch.js'));
  ({ default: Authority } = await import('../src/models/Authority.js'));
  ({ default: RentAgreement } = await import('../src/models/RentAgreement.js'));
  ({ default: RentPayment } = await import('../src/models/RentPayment.js'));
  ({ default: RentPaymentGroup } = await import('../src/models/RentPaymentGroup.js'));
  ({ default: RentAudit } = await import('../src/models/RentAudit.js'));
  ({ updateAgreement, closeAgreement, editPayment, createAgreement, reconcileGuardedAgreementCreates, uploadAgreementDocument, deleteAgreementDocument, markGroupHanded, markGroupCleared, cancelPaymentGroup, reconcileRentPaymentGroups, revertGroupStatus } = await import('../src/controllers/rentController.js'));
  ({ default: RentReminder } = await import('../src/models/RentReminder.js'));
  s3 = await import('../src/services/s3Service.js');
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('agreement write races (forced interleavings)', () => {
  it('two updates loading the same version: exactly one commits, the loser gets 409, and only the winner reconciles payments', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 1000, method: 'transfer' });
    const g = pauseNextSave(RentAgreement);
    const aP = call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { monthlyAmount: 3000 } });
    await g.enteredP; // writer A loaded the agreement and is about to save
    const b = await call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { monthlyAmount: 4000 } });
    expect(b.code).toBe(200);
    g.release();
    const a = await aP;
    g.spy.mockRestore();
    expect(a.code).toBe(409);
    expect(String(a.v?.message || '')).toContain('ההסכם השתנה');
    expect((await RentAgreement.findById(ag._id)).monthlyAmount).toBe(4000);
    // The loser must never reach its post-save side effects: the pending
    // payment carries the winner's amount, not the loser's.
    expect((await RentPayment.findById(pay._id)).amount).toBe(4000);
  });

  it('an update racing a close: the close commits, the update gets 409, the agreement stays closed', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const g = pauseNextSave(RentAgreement);
    const aP = call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { monthlyAmount: 3000 } });
    await g.enteredP;
    const b = await call(closeAgreement, { user: u, params: { id: String(ag._id) }, body: { reason: 'הסכם הסתיים' } });
    expect(b.code).toBe(200);
    g.release();
    const a = await aP;
    g.spy.mockRestore();
    expect(a.code).toBe(409);
    const db = await RentAgreement.findById(ag._id);
    expect(db.status).toBe('Closed');
    expect(db.monthlyAmount).toBe(1000);
  });

  it('a payment edit racing a handover: the conditional write misses, the edit gets 409 and the handover is not resurrected to Pending', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 500, method: 'cheque' });
    const g = pauseAfterNextFindOne(RentPayment);
    const eP = call(editPayment, { user: u, params: { id: String(pay._id) }, body: { amount: 700, reason: 'תיקון' } });
    await g.enteredP; // editPayment holds a Pending copy...
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', handedAt: new Date() } }); // ...while the handover commits
    g.release();
    const e = await eP;
    g.spy.mockRestore();
    expect(e.code).toBe(409);
    expect(String(e.v?.message || '')).toContain('התשלום השתנה');
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Handed');
    expect(db.amount).toBe(500);
  });

  it('a document delete racing another write: 409, the reference survives and the S3 object is never touched', async () => {
    const u = await mk();
    const ag = await mkAgr(u, { documents: [{ key: 'rent/k1.pdf', fileName: 'k1.pdf', uploadedAt: new Date(), uploadedBy: u._id }] });
    const docId = ag.documents[0]._id;
    s3.deleteFileFromS3.mockClear();
    const g = pauseNextSave(RentAgreement);
    const dP = call(deleteAgreementDocument, { user: u, params: { id: String(ag._id), docId: String(docId) } });
    await g.enteredP;
    await RentAgreement.updateOne({ _id: ag._id }, { $inc: { __v: 1 } }); // a concurrent save bumps the version
    g.release();
    const d = await dP;
    g.spy.mockRestore();
    expect(d.code).toBe(409);
    expect(String(d.v?.message || '')).toContain('ההסכם השתנה');
    expect((await RentAgreement.findById(ag._id)).documents).toHaveLength(1);
    expect(s3.deleteFileFromS3).not.toHaveBeenCalled();
  });

  it('a document upload racing another write: 409 and no document is appended', async () => {
    const u = await mk(); const ag = await mkAgr(u, { documents: [{ key: 'rent/k0.pdf', fileName: 'k0.pdf' }] });
    const g = pauseNextSave(RentAgreement);
    const upP = call(uploadAgreementDocument, { user: u, params: { id: String(ag._id) }, file: { buffer: Buffer.from('%PDF-1.4 test'), originalname: 'new.pdf', mimetype: 'application/pdf' } });
    await g.enteredP;
    await RentAgreement.updateOne({ _id: ag._id }, { $inc: { __v: 1 } });
    g.release();
    const up = await upP;
    g.spy.mockRestore();
    expect(up.code).toBe(409);
    expect((await RentAgreement.findById(ag._id)).documents).toHaveLength(1);
  });

  it('document delete happy path: reference removed first, then the S3 object is deleted', async () => {
    const u = await mk();
    const ag = await mkAgr(u, { documents: [{ key: 'rent/k2.pdf', fileName: 'k2.pdf', uploadedAt: new Date(), uploadedBy: u._id }] });
    s3.deleteFileFromS3.mockClear();
    const d = await call(deleteAgreementDocument, { user: u, params: { id: String(ag._id), docId: String(ag.documents[0]._id) } });
    expect(d.code).toBe(200);
    expect((await RentAgreement.findById(ag._id)).documents).toHaveLength(0);
    expect(s3.deleteFileFromS3).toHaveBeenCalledWith('rent/k2.pdf');
  });
});

describe('payment and schedule stale-write windows (forced interleavings)', () => {
  it('amount sync racing a handover: the handed payment keeps its status and amount, and no sync audit is written for it', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 1000, method: 'cheque' });
    const g = pauseAfterNextFind(RentPayment);
    const upP = call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { monthlyAmount: 2000 } });
    await g.enteredP; // syncPendingPaymentAmounts holds the untouched pending payment...
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', paidAt: new Date() } }); // ...while the handover commits
    g.release();
    const up = await upP;
    g.spy.mockRestore();
    expect(up.code).toBe(200);
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Handed');
    expect(db.amount).toBe(1000);
    expect(await RentAudit.countDocuments({ paymentId: pay._id, action: 'sync_agreement_amounts' })).toBe(0);
  });

  it('schedule reconcile racing a handover: the handed payment is not deleted as stale', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 1000, method: 'cheque' });
    const g = pauseAfterNextFind(RentPayment);
    const upP = call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { firstDueDate: '2030-03-01' } });
    await g.enteredP; // reconcileScheduleChange holds the payment as a stale-date candidate
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', paidAt: new Date() } });
    g.release();
    const up = await upP;
    g.spy.mockRestore();
    expect(up.code).toBe(200);
    const db = await RentPayment.findById(pay._id);
    expect(db).not.toBeNull();
    expect(db.status).toBe('Handed');
    expect(await RentAudit.countDocuments({ paymentId: pay._id, action: 'sync_agreement_schedule' })).toBe(0);
  });

  it('close racing a handover: the handed payment is not cancelled, the rest of the schedule is', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const p1 = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 1000, method: 'cheque' });
    const p2 = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-03-01'), amount: 1000, method: 'transfer' });
    const g = pauseAfterNextFind(RentPayment);
    const cP = call(closeAgreement, { user: u, params: { id: String(ag._id) }, body: { reason: 'הסכם הסתיים' } });
    await g.enteredP; // cancelScheduledPayments holds both pending payments
    await RentPayment.updateOne({ _id: p1._id }, { $set: { status: 'Handed', paidAt: new Date() } });
    g.release();
    const c = await cP;
    g.spy.mockRestore();
    expect(c.code).toBe(200);
    expect((await RentPayment.findById(p1._id)).status).toBe('Handed');
    expect((await RentPayment.findById(p2._id)).status).toBe('Cancelled');
  });

  it('group handover racing a clearing: the clearing commits, the handover gets 409, and the payments follow the winner', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 800, method: 'cheque' });
    const grp = await RentPaymentGroup.create({ adminId: u._id, authorityId: ag.authorityId, authorityName: 'רשות', method: 'cheque', totalAmount: 800, dueDate: new Date('2030-02-01'), allocations: [{ paymentId: pay._id, agreementId: ag._id, branchId: ag.branchId, branchName: 'גן', amount: 800 }] });
    await RentPayment.updateOne({ _id: pay._id }, { $set: { groupId: grp._id } });
    const g = pauseAfterNextFindOne(RentPaymentGroup);
    const hP = call(markGroupHanded, { user: u, params: { id: String(grp._id) }, body: {} });
    await g.enteredP; // markGroupHanded holds a Pending copy of the group
    const cleared = await call(markGroupCleared, { user: u, params: { id: String(grp._id) }, body: {} });
    expect(cleared.code).toBe(200);
    g.release();
    const h = await hP;
    g.spy.mockRestore();
    expect(h.code).toBe(409);
    expect((await RentPaymentGroup.findById(grp._id)).status).toBe('Cleared');
    expect((await RentPayment.findById(pay._id)).status).toBe('Cleared');
  });
});

describe('crash-window convergence (group committed, child updates lost)', () => {
  const mkGroup = async (u, ag, extra = {}) => {
    const pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: ag.branchId, authorityId: ag.authorityId, dueDate: new Date('2030-02-01'), amount: 800, method: 'cheque' });
    const grp = await RentPaymentGroup.create({ adminId: u._id, authorityId: ag.authorityId, authorityName: 'רשות', method: 'cheque', totalAmount: 800, dueDate: new Date('2030-02-01'), allocations: [{ paymentId: pay._id, agreementId: ag._id, branchId: ag.branchId, branchName: 'גן', amount: 800 }], ...extra });
    await RentPayment.updateOne({ _id: pay._id }, { $set: { groupId: grp._id } });
    return { pay, grp };
  };

  it('a retried group cancel finishes the payment unlink lost to a crash', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Cancelled', cancelledAt: new Date() } }); // committed, then "crashed"
    const retry = await call(cancelPaymentGroup, { user: u, params: { id: String(grp._id) }, body: { reason: 'ביטול' } });
    expect(retry.code).toBe(200);
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Pending');
    expect(db.groupId).toBeNull();
  });

  it('the hourly reconcile returns payments stuck on a cancelled group to Pending', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Cancelled', cancelledAt: new Date() } });
    await reconcileRentPaymentGroups();
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Pending');
    expect(db.groupId).toBeNull();
  });

  it('the hourly reconcile propagates a committed clearing to payments that missed it', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Cleared', clearedAt: new Date() } }); // committed, propagate "lost"
    await reconcileRentPaymentGroups();
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Cleared');
    expect(db.clearedAt).not.toBeNull();
  });

  it('a revert crashing after the group commit heals on the hourly reconcile (group back to Pending)', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    const handedAt = new Date();
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Handed', handedAt } });
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', paidAt: handedAt } });
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Pending', handedAt: null } }); // revert committed, then "crashed"
    await reconcileRentPaymentGroups();
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Pending');
    expect(db.paidAt).toBeNull();
    expect(db.clearedAt).toBeNull();
  });

  it('a retried revert heals the crashed payment states inline and still refuses the second revert', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    const handedAt = new Date();
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Handed', handedAt } });
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', paidAt: handedAt } });
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Pending', handedAt: null } }); // crashed mid-revert
    const retry = await call(revertGroupStatus, { user: u, params: { id: String(grp._id) }, body: { reason: 'טעות' } });
    expect(retry.code).toBe(409);
    expect(String(retry.v?.message || '')).toContain('אפשר לבטל סימון');
    expect((await RentPayment.findById(pay._id)).status).toBe('Pending');
  });

  it('a revert crashing on the way to Handed heals Cleared payments back to Handed', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    const handedAt = new Date(Date.now() - 86400000);
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Cleared', paidAt: handedAt, clearedAt: new Date() } });
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Handed', handedAt, clearedAt: null } }); // Cleared->Handed revert committed, then "crashed"
    await reconcileRentPaymentGroups();
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Handed');
    expect(db.clearedAt).toBeNull();
    expect(db.paidAt.getTime()).toBe(handedAt.getTime());
  });

  it('a normal group revert still converges payments through propagation', async () => {
    const u = await mk(); const ag = await mkAgr(u);
    const { pay, grp } = await mkGroup(u, ag);
    const handedAt = new Date();
    await RentPaymentGroup.updateOne({ _id: grp._id }, { $set: { status: 'Handed', handedAt } });
    await RentPayment.updateOne({ _id: pay._id }, { $set: { status: 'Handed', paidAt: handedAt } });
    const r = await call(revertGroupStatus, { user: u, params: { id: String(grp._id) }, body: { reason: 'טעות' } });
    expect(r.code).toBe(200);
    expect((await RentPaymentGroup.findById(grp._id)).status).toBe('Pending');
    const db = await RentPayment.findById(pay._id);
    expect(db.status).toBe('Pending');
    expect(db.paidAt).toBeNull();
  });
});

// The AI create path asks the controller to refuse a second Active agreement
// for the same branch+authority (req.rejectActiveDuplicate). Without a unique
// index the insert is the claim and the loser unwinds itself; these tests
// prove the interleavings deterministically. The plain-UI path (no flag)
// keeps its existing contract.
describe('createAgreement duplicate-Active guard (AI path opt-in)', () => {
  const mkPair = async (u) => {
    const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` });
    const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    return { b, au, body: { branchId: String(b._id), authorityId: String(au._id), monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2027-01-01', direction: 'outgoing' } };
  };

  // Same one-shot gate for the NEXT create(): the first writer pauses just
  // before its insert lands, a competitor completes, and releasing forces the
  // exact create-create interleaving deterministically.
  const pauseNextCreate = (model) => {
    let release; const gate = new Promise((r) => { release = r; });
    let entered; const enteredP = new Promise((r) => { entered = r; });
    const orig = model.create;
    const spy = vi.spyOn(model, 'create').mockImplementationOnce((...args) => { entered(); return gate.then(() => orig.apply(model, args)); });
    return { release, enteredP, spy };
  };

  it('a simultaneous guarded create loses deterministically: the gated writer is unwound, exactly one Active agreement and one schedule survive', async () => {
    const u = await mk(); const { b, au, body } = await mkPair(u);
    const gate = pauseNextCreate(RentAgreement); // writer A pauses just before its insert lands
    const pA = call(createAgreement, { user: u, body, rejectActiveDuplicate: true });
    await gate.enteredP;
    const rB = await call(createAgreement, { user: u, body, rejectActiveDuplicate: true }); // B runs to completion while A is parked
    expect(rB.code).toBe(201);
    gate.release();
    const rA = await pA;
    gate.spy.mockRestore();
    expect(rA.code).toBe(409);
    const active = await RentAgreement.find({ adminId: u._id, branchId: b._id, authorityId: au._id, status: 'Active' });
    expect(active).toHaveLength(1);
    expect(String(active[0]._id)).toBe(String(rB.v._id));
    expect(await RentPayment.countDocuments({ adminId: u._id, agreementId: { $ne: active[0]._id } })).toBe(0);
  });

  it('a sequential second guarded create is refused and unwinds itself', async () => {
    const u = await mk(); const { b, au, body } = await mkPair(u);
    expect((await call(createAgreement, { user: u, body, rejectActiveDuplicate: true })).code).toBe(201);
    expect((await call(createAgreement, { user: u, body, rejectActiveDuplicate: true })).code).toBe(409);
    expect(await RentAgreement.countDocuments({ adminId: u._id, branchId: b._id, authorityId: au._id })).toBe(1);
  });

  it('the plain-UI contract is unchanged without the flag: two Active agreements for the same pair are still accepted', async () => {
    const u = await mk(); const { b, au, body } = await mkPair(u);
    expect((await call(createAgreement, { user: u, body })).code).toBe(201);
    expect((await call(createAgreement, { user: u, body })).code).toBe(201);
    expect(await RentAgreement.countDocuments({ adminId: u._id, branchId: b._id, authorityId: au._id, status: 'Active' })).toBe(2);
  });

  it('a Closed agreement on the same pair does not block a guarded create', async () => {
    const u = await mk(); const { b, au, body } = await mkPair(u);
    const r1 = await call(createAgreement, { user: u, body, rejectActiveDuplicate: true });
    expect(r1.code).toBe(201);
    await RentAgreement.updateOne({ _id: r1.v._id }, { $set: { status: 'Closed' } });
    expect((await call(createAgreement, { user: u, body, rejectActiveDuplicate: true })).code).toBe(201);
    expect(await RentAgreement.countDocuments({ adminId: u._id, branchId: b._id, authorityId: au._id, status: 'Active' })).toBe(1);
  });
});

// Crash and failure recovery for the guarded create: a pendingGuard row is a
// create that never returned success, so the reconcile deletes it with its
// payments and reminders - never an unflagged row, never a live create.
describe('guarded-create crash recovery (reconcileGuardedAgreementCreates)', () => {
  const mkFlagged = async (u, b, au, { ageMin = 15, withChildren = true } = {}) => {
    const ag = await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2027-01-01'), status: 'Pending_Setup', pendingGuard: true });
    let pay = null; let rem = null;
    if (withChildren) {
      pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: b._id, authorityId: au._id, dueDate: new Date('2030-01-01'), amount: 1000, method: 'transfer' });
      rem = await RentReminder.create({ adminId: u._id, branchId: b._id, rentAgreementId: ag._id, rentPaymentId: pay._id, rentTrigger: 'week_before_due', dueDate: pay.dueDate, amount: 1000, method: 'transfer', status: 'Open' });
    }
    await RentAgreement.collection.updateOne({ _id: ag._id }, { $set: { createdAt: new Date(Date.now() - ageMin * 60 * 1000) } });
    return { ag, pay, rem };
  };
  const mkBA = async (u) => {
    const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` });
    const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    return { b, au };
  };

  it('the reconcile also removes children defensively, whatever a pending row holds (crash mid-flight in any future reorder)', async () => {
    const u = await mk(); const { b, au } = await mkBA(u);
    const { ag, pay } = await mkFlagged(u, b, au);
    expect(await reconcileGuardedAgreementCreates()).toBe(1);
    expect(await RentAgreement.findById(ag._id)).toBeNull();
    expect(await RentPayment.findById(pay._id)).toBeNull();
    expect(await RentReminder.countDocuments({ rentAgreementId: ag._id })).toBe(0);
  });

  it('a freshly flagged row (a live create in flight) is never swept, and an unflagged same-pair agreement is never swept', async () => {
    const u = await mk(); const { b, au } = await mkBA(u);
    const live = await mkFlagged(u, b, au, { ageMin: 0 }); // in-flight create: flagged but not stale
    const plain = await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 500, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-02-01') });
    await RentAgreement.collection.updateOne({ _id: plain._id }, { $set: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } }); // old but NOT flagged: plain-UI contract
    expect(await reconcileGuardedAgreementCreates()).toBe(0);
    expect(await RentAgreement.findById(live.ag._id)).not.toBeNull();
    expect(await RentAgreement.findById(plain._id)).not.toBeNull();
  });

  it('a failed unwind leaves the loser flagged, and the reconcile removes it - the survivor and its schedule stay', async () => {
    const u = await mk(); const { b, au } = await mkBA(u);
    const body = { branchId: String(b._id), authorityId: String(au._id), monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2027-01-01', direction: 'outgoing' };
    const winner = await call(createAgreement, { user: u, body, rejectActiveDuplicate: true });
    expect(winner.code).toBe(201);
    const spy = vi.spyOn(RentAgreement, 'deleteOne').mockImplementationOnce(() => { throw new Error('db gone'); });
    const loser = await call(createAgreement, { user: u, body, rejectActiveDuplicate: true });
    spy.mockRestore();
    expect(loser.code).toBe(500); // the unwind blew up mid-flight: no success, no clean refusal
    const orphaned = await RentAgreement.findOne({ adminId: u._id, branchId: b._id, authorityId: au._id, _id: { $ne: winner.v._id } });
    expect(orphaned?.pendingGuard).toBe(true); // durable evidence for the sweep
    await RentAgreement.collection.updateOne({ _id: orphaned._id }, { $set: { createdAt: new Date(Date.now() - 15 * 60 * 1000) } });
    expect(await reconcileGuardedAgreementCreates()).toBe(1);
    const remaining = await RentAgreement.find({ adminId: u._id, branchId: b._id, authorityId: au._id });
    expect(remaining).toHaveLength(1);
    expect(String(remaining[0]._id)).toBe(String(winner.v._id));
    expect(await RentPayment.countDocuments({ agreementId: orphaned._id })).toBe(0);
    expect(await RentPayment.countDocuments({ agreementId: winner.v._id })).toBeGreaterThan(0);
  });

  it('a stale flagged row blocks a guarded retry with 409 until the reconcile runs; the retry then succeeds with its flag cleared', async () => {
    const u = await mk(); const { b, au } = await mkBA(u);
    await mkFlagged(u, b, au);
    const body = { branchId: String(b._id), authorityId: String(au._id), monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2027-01-01', direction: 'outgoing' };
    expect((await call(createAgreement, { user: u, body, rejectActiveDuplicate: true })).code).toBe(409); // fail-closed while the crash is unrecovered
    expect(await reconcileGuardedAgreementCreates()).toBe(1);
    const retry = await call(createAgreement, { user: u, body, rejectActiveDuplicate: true });
    expect(retry.code).toBe(201);
    const final = await RentAgreement.find({ adminId: u._id, branchId: b._id, authorityId: au._id, status: 'Active' });
    expect(final).toHaveLength(1);
    expect(final[0].pendingGuard).toBeFalsy(); // commit cleared the flag before success returned
  });
});

// A pending row must be invisible to consumers, and a post-commit crash must
// converge through the regular materializers - not through the sweep.
describe('guarded-create visibility and convergence', () => {
  it('a Pending_Setup row is excluded from the rent summary list, the totals and the branch dependent counts', async () => {
    const u = await mk();
    const b = await Branch.create({ adminId: u._id, name: 'גן בדיקה' });
    const au = await Authority.create({ adminId: u._id, name: 'רשות בדיקה', ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, direction: 'outgoing', monthlyAmount: 4000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2027-01-01'), status: 'Pending_Setup', pendingGuard: true });
    let payload; const res = { status() { return res; }, json(v) { payload = v; return res; } };
    const { rentSummary } = await import('../src/controllers/rentController.js');
    await rentSummary({ user: u }, res);
    expect(payload.agreements).toHaveLength(0); // not rendered as a real agreement
    expect(Object.keys(payload.totals)).toHaveLength(0); // not in the money totals
    const { countBranchDependents } = await import('../src/utils/branchDependents.js');
    const counts = await countBranchDependents(b._id);
    expect(counts.activeAgreements).toBe(0); // does not block branch deletion as an active agreement
    expect(counts.closedAgreements).toBe(0); // and is not financial history either
    // And no payments exist for anyone to act on while it is pending.
    expect(await RentPayment.countDocuments({ adminId: u._id })).toBe(0);
  });

  it('a crash AFTER the commit (Active, no flag, schedule missing) converges through the regular materializers', async () => {
    const u = await mk();
    const b = await Branch.create({ adminId: u._id, name: 'גן התכנסות' });
    const au = await Authority.create({ adminId: u._id, name: 'רשות התכנסות', ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    const ag = await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2027-01-05') });
    expect(await RentPayment.countDocuments({ agreementId: ag._id })).toBe(0);
    const { scheduleAllRentPayments } = await import('../src/controllers/rentController.js');
    await scheduleAllRentPayments();
    expect(await RentPayment.countDocuments({ agreementId: ag._id })).toBeGreaterThan(0); // schedule completed idempotently
    await scheduleAllRentPayments();
    const n = await RentPayment.countDocuments({ agreementId: ag._id });
    await scheduleAllRentPayments();
    expect(await RentPayment.countDocuments({ agreementId: ag._id })).toBe(n); // re-runs add nothing (11000-tolerant upserts)
    // The sweep leaves this legitimate post-commit row and its schedule alone.
    expect(await reconcileGuardedAgreementCreates()).toBe(0);
    expect(await RentAgreement.findById(ag._id)).not.toBeNull();
  });
});

// The commit and the sweep race over the SAME atomic field: exactly one of
// them can own a stale pending row. These tests force each order
// deterministically and pin the direct-route fence.
describe('guarded-create commit/sweep fence and direct routes', () => {
  const mkBA2 = async (u) => {
    const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` });
    const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    return { b, au };
  };
  const mkPending = async (u, b, au, { ageMin = 15, withChildren = true } = {}) => {
    const ag = await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, branchName: b.name, authorityName: au.name, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2027-01-01'), status: 'Pending_Setup', pendingGuard: true });
    let pay = null; let rem = null;
    if (withChildren) {
      pay = await RentPayment.create({ adminId: u._id, agreementId: ag._id, branchId: b._id, authorityId: au._id, dueDate: new Date('2030-01-01'), amount: 1000, method: 'transfer' });
      rem = await RentReminder.create({ adminId: u._id, branchId: b._id, rentAgreementId: ag._id, rentPaymentId: pay._id, rentTrigger: 'week_before_due', dueDate: pay.dueDate, amount: 1000, method: 'transfer', status: 'Open' });
    }
    await RentAgreement.collection.updateOne({ _id: ag._id }, { $set: { createdAt: new Date(Date.now() - ageMin * 60 * 1000) } });
    return { ag, pay, rem };
  };
  // The exact commit write the controller performs.
  const commitWrite = (id) => RentAgreement.updateOne({ _id: id, pendingGuard: true }, { $set: { status: 'Active' }, $unset: { pendingGuard: 1 } });

  it('a writer resuming after the age threshold cannot commit under the sweep: the claim wins the flag and the commit matches nothing', async () => {
    const u = await mk(); const { b, au } = await mkBA2(u);
    const { ag } = await mkPending(u, b, au);
    // The sweeper claims first: pendingGuard is unset atomically.
    const claim = await RentAgreement.updateOne({ _id: ag._id, pendingGuard: true }, { $set: { sweepClaim: true }, $unset: { pendingGuard: 1 } });
    expect(claim.matchedCount).toBe(1);
    // The paused writer resumes and issues its commit: fenced out, no activation under the sweep.
    expect((await commitWrite(ag._id)).matchedCount).toBe(0);
    // The next pass resumes the claimed row and removes it with its children.
    expect(await reconcileGuardedAgreementCreates()).toBe(1);
    expect(await RentAgreement.findById(ag._id)).toBeNull();
    expect(await RentPayment.countDocuments({ agreementId: ag._id })).toBe(0);
    expect(await RentReminder.countDocuments({ rentAgreementId: ag._id })).toBe(0);
  });

  it('a commit that lands before the claim wins: the sweep skips the Active row and its materialized schedule', async () => {
    const u = await mk(); const { b, au } = await mkBA2(u);
    const { ag } = await mkPending(u, b, au, { withChildren: false });
    expect((await commitWrite(ag._id)).matchedCount).toBe(1); // commit first: the row is Active
    expect(await reconcileGuardedAgreementCreates()).toBe(0); // the sweep never touches it
    const { scheduleAllRentPayments } = await import('../src/controllers/rentController.js');
    await scheduleAllRentPayments();
    const n = await RentPayment.countDocuments({ agreementId: ag._id });
    expect(n).toBeGreaterThan(0); // schedule materialized post-commit
    expect(await reconcileGuardedAgreementCreates()).toBe(0); // and survives later sweeps
    expect(await RentPayment.countDocuments({ agreementId: ag._id })).toBe(n);
    expect((await RentAgreement.findById(ag._id)).status).toBe('Active');
  });

  it('a sweep crashing after the claim resumes cleanup on the next pass: claimed rows stay sweepable', async () => {
    const u = await mk(); const { b, au } = await mkBA2(u);
    const { ag, pay, rem } = await mkPending(u, b, au);
    // Crash point: claim landed, children and agreement not yet deleted.
    await RentAgreement.updateOne({ _id: ag._id, pendingGuard: true }, { $set: { sweepClaim: true }, $unset: { pendingGuard: 1 } });
    expect(await reconcileGuardedAgreementCreates()).toBe(1);
    expect(await RentAgreement.findById(ag._id)).toBeNull();
    expect(await RentPayment.findById(pay._id)).toBeNull();
    expect(await RentReminder.findById(rem._id)).toBeNull();
  });

  it('update, close and document routes answer 404 for a Pending_Setup row, including a version probe', async () => {
    const u = await mk(); const { b, au } = await mkBA2(u);
    const { ag } = await mkPending(u, b, au, { ageMin: 0, withChildren: false }); // fresh: the fence must not depend on the sweep
    expect((await call(updateAgreement, { user: u, params: { id: String(ag._id) }, body: { monthlyAmount: 2000 } })).code).toBe(404);
    expect((await call(closeAgreement, { user: u, params: { id: String(ag._id) }, body: {} })).code).toBe(404);
    expect((await call(uploadAgreementDocument, { user: u, params: { id: String(ag._id) }, body: {}, file: { buffer: Buffer.from('x'), mimetype: 'application/pdf', originalname: 'a.pdf' } })).code).toBe(404);
    // A version probe must not leak the row as 409-stale: it is 404 like anything else invisible.
    expect((await call(closeAgreement, { user: u, params: { id: String(ag._id) }, body: {}, expectedUpdatedAt: new Date().toISOString() })).code).toBe(404);
    const row = await RentAgreement.findById(ag._id); // untouched by all four attempts
    expect(row.status).toBe('Pending_Setup');
    expect(row.monthlyAmount).toBe(1000);
  });
});
