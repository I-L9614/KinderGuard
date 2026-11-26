import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeLicenseActions } from '../src/ai/licenseActions.js';
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

const D = new Date('2027-01-01');
const ctx = { branches: [{ _id: 'b1', name: 'גן שקד' }, { _id: 'b2', name: 'גן שקד צפון' }], types: [{ _id: 't1', name: 'כיבוי אש', branchId: null, activeLicenses: 2, branchName: '' }], licenses: [{ _id: 'l1', branchName: 'גן שקד', typeName: 'כיבוי אש', expiryDate: D, updatedAt: D, fileUrl: 'k1' }, { _id: 'l2', branchName: 'גן שקד צפון', typeName: 'כיבוי אש', expiryDate: D, updatedAt: D, fileUrl: '' }, { _id: 'l3', branchName: 'גן רימון', typeName: 'בריאות', expiryDate: D, updatedAt: D, fileUrl: '' }] };
describe('sanitizeLicenseActions', () => {
  it('validates ids, duplicates, formula names, missing file; similar branches need a choice', () => {
    const r = sanitizeLicenseActions(JSON.stringify({ actions: [{ type: 'create_license_type', name: 'כיבוי אש' }, { type: 'create_license_type', name: '=cmd' }, { type: 'create_license_type', name: 'בטיחות', branchId: 'zz' }, { type: 'deactivate_license_type', licenseTypeId: 't1' }, { type: 'archive_license', licenseId: 'l1' }, { type: 'delete_license_file', licenseId: 'l3' }, { type: 'delete_license_file', licenseId: 'nope' }, { type: 'edit_license', licenseId: 'l1' }] }), ctx);
    expect(r.actions.map((a) => a.type)).toEqual(['deactivate_license_type', 'archive_license']);
    expect(r.actions[0].warning).toMatch(/2 אישורים/); expect(r.actions[1].needsChoice).toBe(true); expect(r.actions[1].candidates).toHaveLength(2); expect(r.rejected).toHaveLength(6);
  });
});
describe('license actions end to end', () => {
  const prop = (t, a) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/licenses/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const confirm = async (t, id, withGrant = true, bodyObj = {}) => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await AiProposal.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send(bodyObj); };
  const seed = async (u, bname = 'גן א', tname = 'כיבוי') => { const b = await Branch.create({ adminId: u._id, name: bname }); const ty = await LicenseType.create({ adminId: u._id, name: tname }); const l = await License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id, fileUrl: 'rent/none', fileName: 'a.pdf' }); return { b, ty, l }; };
  it('create type is normal; duplicate in scope refused', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const p = await prop(t, { type: 'create_license_type', name: 'סוג חדש' }); expect((await confirm(t, p.body.actions[0].proposalId, false)).status).toBe(200); expect(await LicenseType.countDocuments({ adminId: u._id, name: 'סוג חדש' })).toBe(1);
    const p2 = await prop(t, { type: 'create_license_type', name: 'סוג  חדש' }); expect(p2.body.actions).toHaveLength(0);
  });
  it('archive needs step-up, stale is 409 at the database, then archives and closes notifications path', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { l } = await seed(u);
    const p = await prop(t, { type: 'archive_license', licenseId: String(l._id) }); const id = p.body.actions[0].proposalId;
    expect((await confirm(t, id, false)).status).toBeGreaterThanOrEqual(400); expect((await License.findById(l._id)).lifecycle).toBe('Active');
    await License.updateOne({ _id: l._id }, { $set: { fileName: 'b.pdf' } });
    expect((await confirm(t, id)).status).toBe(409); expect((await License.findById(l._id)).lifecycle).toBe('Active');
    const p2 = await prop(t, { type: 'archive_license', licenseId: String(l._id) }); expect((await confirm(t, p2.body.actions[0].proposalId)).status).toBe(200); expect((await License.findById(l._id)).lifecycle).toBe('Replaced');
  });
  it('delete file only removes the file reference after step-up and refuses stale', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { l } = await seed(u, 'גן ב', 'בריאות');
    const p = await prop(t, { type: 'delete_license_file', licenseId: String(l._id) }); const id = p.body.actions[0].proposalId;
    await License.updateOne({ _id: l._id }, { $set: { fileName: 'c.pdf' } }); expect((await confirm(t, id)).status).toBe(409); expect((await License.findById(l._id)).fileUrl).toBe('rent/none');
    const p2 = await prop(t, { type: 'delete_license_file', licenseId: String(l._id) }); const r = await confirm(t, p2.body.actions[0].proposalId); expect(r.status, JSON.stringify(r.body)).toBe(200); const after = await License.findById(l._id); expect(after.fileUrl).toBe(''); expect(after.lifecycle).toBe('Active'); expect(deleted).toEqual(['rent/none']);
  });
  it('storage failure after the reference is removed is reported as pending, never as fully erased', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { l } = await seed(u, 'גן ג', 'מזון');
    const s3 = await import('../src/services/s3Service.js'); s3.deleteFileFromS3.mockRejectedValueOnce(new Error('storage down'));
    const p = await prop(t, { type: 'delete_license_file', licenseId: String(l._id) }); const r = await confirm(t, p.body.actions[0].proposalId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result.referenceRemoved).toBe(true); expect(r.body.result.storagePending).toBe(true); expect(r.body.result.fileDeleted).toBe(false);
    const after = await License.findById(l._id); expect(after.fileUrl).toBe(''); expect(after.pendingFileDeletion).toBe('rent/none');
  });
  it('deactivate type after step-up; non-AI and other-admin targets are refused', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const { ty } = await seed(u, 'גן ג', 'סוג למחיקה');
    const p = await prop(t, { type: 'deactivate_license_type', licenseTypeId: String(ty._id) }); expect((await confirm(t, p.body.actions[0].proposalId, false)).status).toBeGreaterThanOrEqual(400); expect((await LicenseType.findById(ty._id)).active).toBe(true);
    expect((await confirm(t, p.body.actions[0].proposalId)).status).toBe(200); expect((await LicenseType.findById(ty._id)).active).toBe(false);
    const o = await mk({ aiEnabled: true }); const other = await seed(o.u, 'גן זר', 'סוג זר');
    const q = await prop(t, { type: 'archive_license', licenseId: String(other.l._id) }); expect(q.body.actions).toHaveLength(0);
    const n = await mk({ aiEnabled: false }); expect((await request(app).post('/api/ai/licenses/propose').set('Authorization', `Bearer ${n.t}`).send({ prompt: 'x' })).status).toBe(403);
  });
  it('similar branch names need an explicit choice and the chosen license is the one archived', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const a = await seed(u, 'גן שקד', 'כיבוי'); const b2 = await Branch.create({ adminId: u._id, name: 'גן שקד צפון' }); const l2 = await License.create({ branchId: b2._id, licenseTypeId: a.ty._id, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-02-01'), createdBy: u._id });
    const p = await prop(t, { type: 'archive_license', licenseId: String(a.l._id) }); const act = p.body.actions[0]; expect(act.needsChoice).toBe(true);
    expect((await confirm(t, act.proposalId)).status).toBe(400);
    const ok = await confirm(t, act.proposalId, true, { branchId: String(l2._id) }); expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await License.findById(l2._id)).lifecycle).toBe('Replaced'); expect((await License.findById(a.l._id)).lifecycle).toBe('Active');
  });
});
