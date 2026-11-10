import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import License from '../src/models/License.js';
import Branch from '../src/models/Branch.js';
import Notification from '../src/models/Notification.js';

const s3Mock = mockClient(S3Client);

let app;
let mongoServer;
let token;
let adminId;
let branchId;
let licenseTypeId;

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `branch-del-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
  adminId = admin.body.id;
  const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף למחיקה' }).expect(201);
  branchId = branch.body._id;
  const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'אישור בטיחות', branchId: null }).expect(201);
  licenseTypeId = type.body._id;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Branch deletion', () => {
  it('cascades: deletes the branch, its permits, alerts and stored documents', async () => {
    const license = await License.create({
      branchId, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      fileUrl: 'licenses/cascade-permit.pdf', fileName: 'permit.pdf', status: 'Valid', createdBy: adminId,
    });
    await Notification.create({ branchId, licenseId: license._id, adminId, triggerDays: 30 });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const res = await request(app).delete(`/api/branches/${branchId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.deletedLicenses).toBe(1);
    expect(s3Mock.calls().filter((c) => c.args[0] instanceof DeleteObjectCommand)).toHaveLength(1);
    expect(await License.countDocuments({ branchId })).toBe(0);
    expect(await Notification.countDocuments({ branchId })).toBe(0);
    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${token}`).expect(200);
    expect(branches.body.some((b) => b._id === branchId)).toBe(false);
  });

  it('keeps the branch and the failing permit intact when its storage delete fails', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף עם קובץ' }).expect(201);
    const license = await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      fileUrl: 'licenses/failing-permit.pdf', fileName: 'permit.pdf', status: 'Valid', createdBy: adminId,
    });
    s3Mock.on(DeleteObjectCommand).rejects(new Error('storage down'));
    const res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(502);
    expect(res.body.message).toContain('לא הושלמה');
    const kept = await License.findById(license._id);
    expect(kept.fileUrl).toBe('licenses/failing-permit.pdf');
    expect(kept.pendingFileDeletion).toBe('');
    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${token}`).expect(200);
    expect(branches.body.some((b) => b._id === branch.body._id)).toBe(true);
    // retry converges once storage recovers
    s3Mock.on(DeleteObjectCommand).resolves({});
    await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(await License.countDocuments({ branchId: branch.body._id })).toBe(0);
  });

  it('partial storage failure: cleaned permits are deleted, the failing one keeps its document link', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף שני קבצים' }).expect(201);
    const okLicense = await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      fileUrl: 'licenses/ok-permit.pdf', fileName: 'ok.pdf', status: 'Valid', lifecycle: 'Replaced', createdBy: adminId,
    });
    const failLicense = await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-02-01', expiryDate: '2027-02-01',
      fileUrl: 'licenses/fail-permit.pdf', fileName: 'fail.pdf', status: 'Valid', createdBy: adminId,
    });
    s3Mock.on(DeleteObjectCommand, { Key: 'licenses/ok-permit.pdf' }).resolves({});
    s3Mock.on(DeleteObjectCommand, { Key: 'licenses/fail-permit.pdf' }).rejects(new Error('storage down'));
    const res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(502);
    expect(res.body.message).toContain('נותרו 1');
    expect(await License.findById(okLicense._id)).toBeNull();
    const kept = await License.findById(failLicense._id);
    expect(kept.fileUrl).toBe('licenses/fail-permit.pdf');
    // retry converges once storage recovers
    s3Mock.on(DeleteObjectCommand).resolves({});
    await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(await License.countDocuments({ branchId: branch.body._id })).toBe(0);
  });

  it('clears the file reference when the database delete fails after storage success', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף כשל מסד' }).expect(201);
    const license = await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      fileUrl: 'licenses/db-fail-permit.pdf', fileName: 'permit.pdf', status: 'Valid', createdBy: adminId,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const original = License.prototype.deleteOne;
    License.prototype.deleteOne = async function () { throw new Error('db down'); };
    const res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(502);
    License.prototype.deleteOne = original;
    expect(res.body.message).toContain('לא הושלמה');
    const kept = await License.findById(license._id);
    expect(kept).not.toBeNull();
    expect(kept.fileUrl).toBe('');
    expect(kept.fileName).toBe('');
    expect(kept.pendingFileDeletion).toBe('');
  });

  it('refuses to finish while new permits keep appearing mid-delete', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף משתנה' }).expect(201);
    await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      status: 'Valid', createdBy: adminId,
    });
    // Simulate a concurrent upload: every permit deletion spawns one more permit,
    // past the server's bounded retry rounds, so the delete must refuse to finish.
    const originalDeleteOne = License.prototype.deleteOne;
    let injections = 0;
    License.prototype.deleteOne = async function patchedDeleteOne(...args) {
      if (injections < 5) {
        injections += 1;
        await License.create({
          branchId: branch.body._id, licenseTypeId, issueDate: '2026-03-01', expiryDate: '2027-03-01',
          status: 'Valid', lifecycle: 'Replaced', createdBy: adminId,
        });
      }
      return originalDeleteOne.apply(this, args);
    };
    let res;
    try {
      res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(502);
    } finally {
      License.prototype.deleteOne = originalDeleteOne;
    }
    expect(res.body.message).toContain('השתנה');
    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${token}`).expect(200);
    expect(branches.body.some((b) => b._id === branch.body._id)).toBe(true);
  }, 20000);

  it('keeps a durable intent key when clearing the reference fails, and self-heals on retry', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף כשל כפול' }).expect(201);
    const license = await License.create({
      branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01',
      fileUrl: 'licenses/double-fail.pdf', fileName: 'permit.pdf', status: 'Valid', createdBy: adminId,
    });
    s3Mock.on(DeleteObjectCommand).resolves({});
    const originalSave = License.prototype.save;
    let saveCalls = 0;
    License.prototype.save = async function patchedSave(...args) {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error('db down mid-clear');
      return originalSave.apply(this, args);
    };
    const res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(502);
    License.prototype.save = originalSave;
    expect(res.body.message).toContain('לא הושלמה');
    const kept = await License.findById(license._id);
    // the object is gone from storage, the key survived durably, and nothing links falsely
    expect(kept.pendingFileDeletion).toBe('licenses/double-fail.pdf');
    // retry self-heals from the durable intent and completes
    await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(await License.countDocuments({ branchId: branch.body._id })).toBe(0);
  });

  it('rejects a second delete while one is already running', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף במחיקה' }).expect(201);
    await Branch.updateOne({ _id: branch.body._id }, { $set: { deleting: true } });
    const res = await request(app).delete(`/api/branches/${branch.body._id}`).set('Authorization', `Bearer ${token}`).expect(409);
    expect(res.body.message).toContain('כבר מתבצעת');
  });

  it('blocks adding a permit to a branch that is being deleted', async () => {
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף נעול' }).expect(201);
    await Branch.updateOne({ _id: branch.body._id }, { $set: { deleting: true } });
    const res = await request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`)
      .send({ branchId: branch.body._id, licenseTypeId, issueDate: '2026-01-01', expiryDate: '2027-01-01' }).expect(409);
    expect(res.body.message).toContain('בתהליך מחיקה');
  });

  it('deletes an empty branch and removes it from the list', async () => {
    const empty = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'סניף ריק' }).expect(201);
    await request(app).delete(`/api/branches/${empty.body._id}`).set('Authorization', `Bearer ${token}`).expect(200);
    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${token}`).expect(200);
    expect(branches.body.some((b) => b._id === empty.body._id)).toBe(false);
  });

  it('returns 404 for an unknown branch id', async () => {
    await request(app).delete(`/api/branches/${new mongoose.Types.ObjectId()}`).set('Authorization', `Bearer ${token}`).expect(404);
  });
});
