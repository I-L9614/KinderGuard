import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import License from '../src/models/License.js';
import LicenseType from '../src/models/LicenseType.js';
import { deleteLicenseFile } from '../src/controllers/licenseController.js';
import { reconcilePendingFileDeletions } from '../src/services/licenseCleanup.js';

const s3Mock = mockClient(S3Client);

let app;
let mongoServer;
let token;
let adminId;
let branchId;
let licenseTypeId;

const deleteCalls = () => s3Mock.calls().filter((c) => c.args[0] instanceof DeleteObjectCommand);

const mkType = () => LicenseType.create({ adminId, name: `סוג ${Math.random().toString(36).slice(2, 8)}`, branchId: null });

const mkLicense = async (extra = {}) => License.create({
  branchId,
  licenseTypeId: extra.licenseTypeId || (await mkType())._id,
  issueDate: new Date('2026-01-01'),
  expiryDate: new Date('2027-01-01'),
  fileUrl: `licenses/doc-${Math.random().toString(36).slice(2)}.pdf`,
  fileName: 'doc.pdf',
  status: 'Valid',
  lifecycle: 'Active',
  createdBy: adminId,
  ...extra,
});

// Arms a one-shot pause on the NEXT License.updateOne call: the caller is
// held mid-flow, something else runs to completion, and the release forces
// the exact interleaving being proven.
const pauseNextLicenseUpdate = () => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = License.updateOne;
  const spy = vi.spyOn(License, 'updateOne').mockImplementationOnce(async (...args) => {
    entered(); await gate; return orig.apply(License, args);
  });
  return { release, enteredP, spy };
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  // Index builds can lag on slow runners (Windows CI): wait, bounded, for the live unique index the production 503 gate requires. The gate itself is unchanged.
  const { default: LicenseModel } = await import('../src/models/License.js'); const { activeUniqueIndexPresent } = await import('../src/utils/licenseIndex.js');
  await LicenseModel.init(); await (await import('../src/models/LicenseType.js')).default.init();
  for (let i = 0; i < 100 && !(await activeUniqueIndexPresent()); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!(await activeUniqueIndexPresent())) throw new Error('license unique index not built within 10s');
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `licdel-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
  adminId = admin.body.id;
  const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'Main Branch' }).expect(201);
  branchId = branch.body._id;
  const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'אישור בטיחות', branchId: null }).expect(201);
  licenseTypeId = type.body._id;
}, 600000);

beforeEach(() => { s3Mock.reset(); s3Mock.on(DeleteObjectCommand).resolves({}); });

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('deleteLicenseFile', () => {
  it('clears the reference, deletes the object and leaves no pending intent', async () => {
    const license = await mkLicense();
    const res = await request(app).delete(`/api/licenses/${license._id}/file`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body).toMatchObject({ message: 'המסמך נמחק', referenceRemoved: true, storagePending: false });
    const after = await License.findById(license._id);
    expect(after.fileUrl).toBe('');
    expect(after.fileName).toBe('');
    expect(after.pendingFileDeletion).toBe('');
    expect(deleteCalls()).toHaveLength(1);
    // The approval itself stays: dates and lifecycle untouched.
    expect(after.lifecycle).toBe('Active');
  });

  it('race: a renewal landing mid-delete keeps the file the renewal chose to keep', async () => {
    const license = await mkLicense();
    const gate = pauseNextLicenseUpdate();
    const deleteReq = (async () => request(app).delete(`/api/licenses/${license._id}/file`).set('Authorization', `Bearer ${token}`))();
    await gate.enteredP;
    // Renewal of the SAME type, without deleteOldFile: the replaced approval's document must stay.
    await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`)
      .send({ branchId, licenseTypeId: String(license.licenseTypeId), issueDate: '2026-02-01', expiryDate: '2028-02-01', confirmRenewal: 'true', renewalOf: String(license._id) }).expect(201);
    gate.release();
    const res = await deleteReq;
    gate.spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('האישור השתנה בינתיים. רעננו ונסו שוב.');
    // The file the renewal decided to keep is neither deleted nor dereferenced.
    const after = await License.findById(license._id);
    expect(after.fileUrl).not.toBe('');
    expect(after.pendingFileDeletion).toBe('');
    expect(deleteCalls()).toHaveLength(0);
  });

  it('race: two deletes of the same file - exactly one commits, the other gets 404, one storage delete', async () => {
    const license = await mkLicense();
    const gate = pauseNextLicenseUpdate();
    const first = (async () => request(app).delete(`/api/licenses/${license._id}/file`).set('Authorization', `Bearer ${token}`))();
    await gate.enteredP;
    await request(app).delete(`/api/licenses/${license._id}/file`).set('Authorization', `Bearer ${token}`).expect(200);
    gate.release();
    const res = await first;
    gate.spy.mockRestore();
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('לא נמצא קובץ מצורף לאישור זה');
    const after = await License.findById(license._id);
    expect(after.fileUrl).toBe('');
    expect(deleteCalls()).toHaveLength(1);
  });

  it('storage failure: reference is removed, durable intent remains, sweep completes the deletion', async () => {
    const license = await mkLicense();
    s3Mock.on(DeleteObjectCommand).rejects(new Error('storage down'));
    const res = await request(app).delete(`/api/licenses/${license._id}/file`).set('Authorization', `Bearer ${token}`).expect(200);
    // Evidence contract: reference removed is never presented as storage erased.
    expect(res.body.referenceRemoved).toBe(true);
    expect(res.body.storagePending).toBe(true);
    expect(res.body.message).toBe('הקישור לקובץ הוסר. מחיקת הקובץ מהאחסון תושלם ברקע.');
    const mid = await License.findById(license._id);
    // Reference removed; physical deletion pending - never a dangling link.
    expect(mid.fileUrl).toBe('');
    expect(mid.pendingFileDeletion).toBe(license.fileUrl);
    s3Mock.on(DeleteObjectCommand).resolves({});
    await reconcilePendingFileDeletions();
    const after = await License.findById(license._id);
    expect(after.pendingFileDeletion).toBe('');
    expect(deleteCalls().length).toBeGreaterThanOrEqual(2);
  });

  it('AI path: a version stale since the proposal is refused without touching storage', async () => {
    const license = await mkLicense();
    const stale = license.updatedAt;
    // A later write bumped the version after the proposal was made. Set it
    // explicitly (timestamps off) so the proof never depends on ms resolution.
    license.status = 'Expiring_Soon';
    await license.save();
    await License.updateOne({ _id: license._id }, { $set: { updatedAt: new Date(+stale + 60000) } }, { timestamps: false });
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
    await deleteLicenseFile({ user: { role: 'Admin', _id: adminId, accessibleBranches: [] }, params: { id: String(license._id) }, expectedUpdatedAt: stale }, res);
    expect(res.code).toBe(409);
    expect(res.body.message).toBe('האישור השתנה מאז ההצעה. בקשו הצעה חדשה.');
    const after = await License.findById(license._id);
    expect(after.fileUrl).toBe(license.fileUrl);
    expect(deleteCalls()).toHaveLength(0);
  });
});

describe('license creation integrity', () => {
  it('race: two creations of the same type name - the index picks one winner, the loser gets 409', async () => {
    let release; const gateP = new Promise((r) => { release = r; });
    let entered; const enteredP = new Promise((r) => { entered = r; });
    const orig = LicenseType.exists;
    const spy = vi.spyOn(LicenseType, 'exists').mockImplementationOnce(async (...args) => {
      entered(); await gateP; return orig.apply(LicenseType, args);
    });
    const name = `סוג מרוץ ${Math.random().toString(36).slice(2, 6)}`;
    const first = (async () => request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name, branchId: null }))();
    await enteredP;
    await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name, branchId: null }).expect(201);
    release();
    const res = await first;
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('סוג אישור בשם זה כבר קיים בהיקף שנבחר');
    expect(await LicenseType.countDocuments({ name: name.trim() })).toBe(1);
  });

  it('race: type deactivated mid-creation - the new approval is unwound and the replaced one restored', async () => {
    const type = await LicenseType.create({ adminId, name: `סוג מושבת ${Math.random().toString(36).slice(2, 6)}`, branchId: null });
    const previous = await mkLicense({ licenseTypeId: type._id, fileUrl: '', fileName: '' });
    const orig = LicenseType.findOne;
    const spy = vi.spyOn(LicenseType, 'findOne').mockImplementationOnce(async (...args) => {
      const found = await orig.apply(LicenseType, args);
      // The deactivation lands after the check but before the creation commits.
      await LicenseType.updateOne({ _id: type._id }, { $set: { active: false } });
      return found;
    });
    const res = await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`)
      .send({ branchId, licenseTypeId: String(type._id), issueDate: '2026-03-01', expiryDate: '2028-03-01', confirmRenewal: 'true', renewalOf: String(previous._id) });
    spy.mockRestore();
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('סוג האישור הושבת בינתיים. האישור לא נוצר.');
    const restored = await License.findById(previous._id);
    expect(restored.lifecycle).toBe('Active');
    expect(restored.replacedBy).toBeNull();
    expect(await License.countDocuments({ licenseTypeId: type._id, lifecycle: 'Active' })).toBe(1);
  });

  // Two creations for the same branch+type have two coherent interleavings;
  // each is proven deterministically with a gate (an ungated Promise.all only
  // samples one and flakes on the other).
  it('race: creation gated before its create loses to the unique index with a clean 409', async () => {
    const type = await LicenseType.create({ adminId, name: `סוג זוג ${Math.random().toString(36).slice(2, 6)}`, branchId: null });
    const body = { branchId, licenseTypeId: String(type._id), issueDate: '2026-01-01', expiryDate: '2027-01-01' };
    let release; const gate = new Promise((r) => { release = r; });
    let entered; const enteredP = new Promise((r) => { entered = r; });
    const orig = License.create;
    const spy = vi.spyOn(License, 'create').mockImplementationOnce(async (...args) => { entered(); await gate; return orig.apply(License, args); });
    const a = (async () => request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`).send(body))();
    await enteredP;
    await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    release();
    const res = await a;
    spy.mockRestore();
    expect(res.status).toBe(409);
    // The loser of the first-creation race converges to the same explicit-approval
    // path as a sequential renewal, with the winner's details for the confirmation.
    expect(res.body.code).toBe('renewal_required');
    expect(res.body.existing.id).toBeTruthy();
    expect(await License.countDocuments({ licenseTypeId: type._id, lifecycle: 'Active' })).toBe(1);
  });

  it('race: two confirmed renewals of the same record - the pinned claim picks one winner, the loser refuses without replacing anything', async () => {
    const type = await LicenseType.create({ adminId, name: `סוג שליש ${Math.random().toString(36).slice(2, 6)}`, branchId: null });
    const previous = await mkLicense({ licenseTypeId: type._id, fileUrl: '', fileName: '' });
    const body = { branchId, licenseTypeId: String(type._id), issueDate: '2026-01-01', expiryDate: '2027-01-01', confirmRenewal: 'true', renewalOf: String(previous._id) };
    let release; const gate = new Promise((r) => { release = r; });
    let entered; const enteredP = new Promise((r) => { entered = r; });
    const orig = License.findOneAndUpdate;
    const spy = vi.spyOn(License, 'findOneAndUpdate').mockImplementationOnce(async (...args) => { entered(); await gate; return orig.apply(License, args); });
    const a = (async () => request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`).send(body))();
    await enteredP;
    await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`).send(body).expect(201);
    release();
    const res = await a;
    spy.mockRestore();
    // Both requests reviewed and confirmed the SAME record. The gated one's pinned
    // claim lands after the winner already replaced it, so it refuses: it must not
    // replace the winner's new approval, which the user never reviewed.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('renewal_conflict');
    const all = await License.find({ licenseTypeId: type._id });
    expect(all).toHaveLength(2);
    const active = all.filter((l) => l.lifecycle === 'Active');
    const replaced = all.filter((l) => l.lifecycle === 'Replaced');
    expect(active).toHaveLength(1);
    expect(replaced).toHaveLength(1);
    expect(String(replaced[0]._id)).toBe(String(previous._id));
    expect(String(replaced[0].replacedBy)).toBe(String(active[0]._id));
  });

  it('renewal deleteOldFile: storage failure leaves durable intent, not a dangling reference', async () => {
    const type = await LicenseType.create({ adminId, name: `סוג חידוש ${Math.random().toString(36).slice(2, 6)}`, branchId: null });
    const previous = await mkLicense({ licenseTypeId: type._id });
    s3Mock.on(DeleteObjectCommand).rejects(new Error('storage down'));
    await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`)
      .send({ branchId, licenseTypeId: String(type._id), issueDate: '2026-04-01', expiryDate: '2028-04-01', deleteOldFile: true, confirmRenewal: 'true', renewalOf: String(previous._id) }).expect(201);
    const mid = await License.findById(previous._id);
    expect(mid.lifecycle).toBe('Replaced');
    expect(mid.fileUrl).toBe('');
    expect(mid.pendingFileDeletion).toBe(previous.fileUrl);
    s3Mock.on(DeleteObjectCommand).resolves({});
    await reconcilePendingFileDeletions();
    expect((await License.findById(previous._id)).pendingFileDeletion).toBe('');
  });
});
