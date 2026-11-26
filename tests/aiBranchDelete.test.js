import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeBranchActions } from '../src/ai/branchActions.js';
const deleted = [];
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(async () => 'k'), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn(async (k) => { deleted.push(k); }) }));
let License; let LicenseType; let AiProposal; let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
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
  ({ default: License } = await import('../src/models/License.js')); ({ default: LicenseType } = await import('../src/models/LicenseType.js'));
  ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });
let Notification;
const prop = (t, a) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const confirm = async (t, id, withGrant = true, bodyObj = {}) => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await AiProposal.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send(bodyObj); };
const seedBranch = async (u, name, { files = 1, alerts = 1 } = {}) => {
  Notification = (await import('../src/models/Notification.js')).default;
  const b = await Branch.create({ adminId: u._id, name }); const ty = await LicenseType.create({ adminId: u._id, name: `t${Math.random()}` });
  for (let i = 0; i < files; i += 1) { const l = await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-01-0' + (i + 1)), expiryDate: new Date('2027-01-01'), createdBy: u._id, lifecycle: i === 0 ? 'Active' : 'Replaced', fileUrl: `rent/f${i}`, fileName: `f${i}.pdf` }); if (i < alerts) await Notification.create({ adminId: u._id, branchId: b._id, licenseId: l._id, triggerDays: 30 }); }
  return b;
};
describe('delete_branch via the AI worker', () => {
  it('card carries the live dependents snapshot and is sensitive', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן בודד', { files: 2, alerts: 1 });
    const p = await prop(t, { type: 'delete_branch', branchId: String(b._id) }); const a = p.body.actions[0];
    expect(a.sensitive).toBe(true); expect(a.before).toMatchObject({ licenses: 2, files: 2, alerts: 1 });
    expect((await confirm(t, a.proposalId, false)).status).toBeGreaterThanOrEqual(400); expect(await Branch.exists({ _id: b._id })).toBeTruthy();
  });
  it('deletes after step-up, cascades dependents, keeps closed agreement history', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן למחיקה', { files: 2, alerts: 2 });
    const au = await Authority.create({ adminId: u._id, name: 'רשות' }); 
    const ag = await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), amount: 1000, frequency: 'monthly', paymentMethod: 'cheque', status: 'Closed' });
    const p = await prop(t, { type: 'delete_branch', branchId: String(b._id) }); expect(p.body.actions[0].before.closedAgreements).toBe(1);
    const r = await confirm(t, p.body.actions[0].proposalId); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ branchDeleted: true, deletedLicenses: 2, pendingCleanup: 0 });
    expect(await Branch.exists({ _id: b._id })).toBeNull(); expect(await License.countDocuments({ branchId: b._id })).toBe(0); expect(await Notification.countDocuments({ branchId: b._id })).toBe(0);
    expect(await RentAgreement.exists({ _id: ag._id })).toBeTruthy();
  });
  it('a permit added after the card was shown is refused by the authoritative check, nothing deleted, guard released', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן נסחף', { files: 1, alerts: 1 });
    const p = await prop(t, { type: 'delete_branch', branchId: String(b._id) });
    const ty = await LicenseType.create({ adminId: u._id, name: `n${Math.random()}` }); await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-02-01'), expiryDate: new Date('2027-02-01'), createdBy: u._id });
    const r = await confirm(t, p.body.actions[0].proposalId); expect(r.status).toBe(409);
    expect(await License.countDocuments({ branchId: b._id })).toBe(2); const live = await Branch.findById(b._id); expect(live).toBeTruthy(); expect(live.deleting).not.toBe(true);
  });
  it('the controller itself binds the snapshot after claiming the branch (race between a pre-check and the claim)', async () => {
    const { u } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן מרוץ', { files: 1, alerts: 1 });
    const { deleteBranch } = await import('../src/controllers/branchController.js');
    const ty = await LicenseType.create({ adminId: u._id, name: `r${Math.random()}` }); await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-03-01'), expiryDate: new Date('2027-03-01'), createdBy: u._id });
    let code = 200; let body; const res = { status(c) { code = c; return res; }, json(v) { body = v; return res; } };
    await deleteBranch({ user: u, params: { id: String(b._id) }, expectedDependents: { licenses: 1, files: 1, alerts: 1 } }, res);
    expect(code).toBe(409); expect(body.message).toMatch(/לא נמחק דבר/); expect(await License.countDocuments({ branchId: b._id })).toBe(2); expect((await Branch.findById(b._id)).deleting).not.toBe(true);
  });
  it('a straggler permit whose storage delete fails in the sweep: 200 with pendingCleanup 1, durable key kept, reconcile finishes it', async () => {
    const { u } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן שאריות', { files: 1, alerts: 1 });
    const s3 = await import('../src/services/s3Service.js'); const { deleteBranch } = await import('../src/controllers/branchController.js'); const { reconcilePendingFileDeletions } = await import('../src/services/licenseCleanup.js');
    const ty = await LicenseType.create({ adminId: u._id, name: `s${Math.random()}` }); let calls = 0; const orig = License.find.bind(License);
    const spy = vi.spyOn(License, 'find').mockImplementation((...args) => { calls += 1; if (calls === 3) { return License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-05-01'), expiryDate: new Date('2027-05-01'), createdBy: u._id, fileUrl: 'rent/straggler', fileName: 's.pdf' }).then(() => orig(...args)); } return orig(...args); });
    s3.deleteFileFromS3.mockImplementation(async (k) => { if (k === 'rent/straggler') throw new Error('storage down'); });
    let code = 200; let body; const res = { status(c) { code = c; return res; }, json(v) { body = v; return res; } };
    await deleteBranch({ user: u, params: { id: String(b._id) }, expectedDependents: { licenses: 1, files: 1, alerts: 1, activeAgreements: 0 } }, res);
    spy.mockRestore();
    expect(code).toBe(200); expect(body.pendingCleanup).toBe(1); expect(await Branch.exists({ _id: b._id })).toBeNull();
    const kept = await License.findOne({ branchId: b._id }); expect(kept).toBeTruthy(); expect(kept.pendingFileDeletion).toBe('rent/straggler');
    s3.deleteFileFromS3.mockImplementation(async () => {});
    await reconcilePendingFileDeletions(); expect((await License.findOne({ _id: kept._id })).pendingFileDeletion).toBe('');
  });
  it('the claim is pinned to the approved name and version: a branch edited after the card is refused, nothing deleted', async () => {
    const { u } = await mk({ aiEnabled: true }); const b = await seedBranch(u, 'גן מוצמד', { files: 1, alerts: 1 }); const { deleteBranch } = await import('../src/controllers/branchController.js');
    const approved = { name: b.name, updatedAt: b.updatedAt }; await Branch.updateOne({ _id: b._id }, { $set: { address: 'שונה', updatedAt: new Date(b.updatedAt.getTime() + 60000) } }, { timestamps: false });
    let code = 200; let body; const res = { status(c) { code = c; return res; }, json(v) { body = v; return res; } };
    await deleteBranch({ user: u, params: { id: String(b._id) }, expectedBranch: approved, expectedDependents: { licenses: 1, files: 1, alerts: 1, activeAgreements: 0 } }, res);
    expect(code).toBe(409); expect(body.message).toMatch(/השתנו מאז ההצעה/); expect(await Branch.exists({ _id: b._id })).toBeTruthy(); expect(await License.countDocuments({ branchId: b._id })).toBe(1);
  });
  it('active agreement blocks the proposal; similar names need an explicit choice; other admin branch is unknown', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const a1 = await seedBranch(u, 'גן ורד'); await seedBranch(u, 'גן ורד צפון');
    const p = await prop(t, { type: 'delete_branch', branchId: String(a1._id) }); const a = p.body.actions[0];
    expect(a.needsChoice).toBe(true); expect(a.branchId).toBeNull(); expect(a.candidates).toHaveLength(2); expect((await confirm(t, a.proposalId)).status).toBe(400);
    const r = await confirm(t, a.proposalId, true, { branchId: a.candidates[1].id }); expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await Branch.exists({ _id: a1._id })).toBeTruthy();
    const au = await Authority.create({ adminId: u._id, name: 'ר2' }); const b3 = await seedBranch(u, 'גן עם הסכם');
    await RentAgreement.create({ adminId: u._id, branchId: b3._id, authorityId: au._id, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), amount: 1000, frequency: 'monthly', paymentMethod: 'cheque' });
    const p3 = await prop(t, { type: 'delete_branch', branchId: String(b3._id) }); expect(p3.body.actions).toHaveLength(0); expect(p3.body.rejected.join(' ')).toMatch(/הסכמי שכירות פעילים/);
    const other = await mk({ aiEnabled: true }); const ob = await seedBranch(other.u, 'גן זר');
    const p4 = await prop(t, { type: 'delete_branch', branchId: String(ob._id) }); expect(p4.body.actions).toHaveLength(0);
  });
});
