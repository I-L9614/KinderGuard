import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import License from '../src/models/License.js';
import RentAgreement from '../src/models/RentAgreement.js';
import { israelToday } from '../src/utils/israelTime.js';

const s3Mock = mockClient(S3Client);

let app;
let mongoServer;
let token;
let adminId;
let branchId;
let licenseTypeId;

const auth = () => ({ Authorization: `Bearer ${token}` });
const today = () => israelToday().toISOString().slice(0, 10);
const fakePdf = () => Buffer.concat([Buffer.from('%PDF-1.4 fake-body-for-test'), Buffer.alloc(16, 0)]);

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `docs-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
  adminId = admin.body.id;
  const branch = await request(app).post('/api/branches').set(auth()).send({ name: 'Docs Branch' }).expect(201);
  branchId = branch.body._id;
}, 600000);

let typeSeq = 0;
const freshLicenseType = async () => {
  const type = await request(app).post('/api/license-types').set(auth()).send({ name: `אישור מסמכים ${++typeSeq}`, branchId: null }).expect(201);
  return type.body._id;
};

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });
beforeEach(() => { s3Mock.reset(); s3Mock.on(PutObjectCommand).resolves({}); s3Mock.on(DeleteObjectCommand).resolves({}); });

const deleteCalls = () => s3Mock.calls().filter((call) => call.args[0] instanceof DeleteObjectCommand);

describe('License document management', () => {
  it('refuses an unconfirmed renewal before any upload reaches storage', async () => {
    const licenseTypeId = await freshLicenseType();
    const oldLicense = await License.create({
      branchId, licenseTypeId, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/000-old.pdf', fileName: 'old.pdf', status: 'Valid', createdBy: adminId,
    });
    const future = new Date(); future.setDate(future.getDate() + 365);
    const res = await request(app)
      .post('/api/licenses').set(auth())
      .field('branchId', branchId).field('licenseTypeId', licenseTypeId)
      .field('issueDate', today()).field('expiryDate', future.toISOString().slice(0, 10))
      .attach('file', fakePdf(), { filename: 'new.pdf', contentType: 'application/pdf' })
      .expect(409);
    expect(res.body.code).toBe('renewal_required');
    expect(res.body.existing.id).toBe(String(oldLicense._id));
    // No storage write, no mutation: the refusal happens before the upload.
    expect(s3Mock.calls().filter((call) => call.args[0] instanceof PutObjectCommand)).toHaveLength(0);
    expect(await License.findById(oldLicense._id)).toMatchObject({ lifecycle: 'Active' });
  }, 20000);

  it('a creation failure after the replace claim restores the previous approval and drops the orphaned upload', async () => {
    const licenseTypeId = await freshLicenseType();
    const oldLicense = await License.create({
      branchId, licenseTypeId, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/555-old.pdf', fileName: 'old.pdf', status: 'Valid', createdBy: adminId,
    });
    const future = new Date(); future.setDate(future.getDate() + 365);
    const spy = vi.spyOn(License, 'create').mockRejectedValueOnce(new Error('db down'));
    const res = await request(app)
      .post('/api/licenses').set(auth())
      .field('branchId', branchId).field('licenseTypeId', licenseTypeId)
      .field('issueDate', today()).field('expiryDate', future.toISOString().slice(0, 10))
      .field('confirmRenewal', 'true').field('renewalOf', String(oldLicense._id))
      .attach('file', fakePdf(), { filename: 'new.pdf', contentType: 'application/pdf' });
    spy.mockRestore();
    expect(res.status).toBe(500);
    // Recoverable: the previous approval is Active again with its file reference intact,
    // and the uploaded document of the failed creation was dropped from storage.
    const after = await License.findById(oldLicense._id);
    expect(after.lifecycle).toBe('Active');
    expect(after.fileUrl).toBe('licenses/555-old.pdf');
    const dels = deleteCalls().map((call) => call.args[0].input.Key);
    expect(dels).toHaveLength(1);
    expect(dels[0]).not.toBe('licenses/555-old.pdf');
    expect(await License.countDocuments({ branchId, licenseTypeId })).toBe(1);
    // The pair is renewable again at once: the fence left no stuck state.
    await request(app)
      .post('/api/licenses').set(auth())
      .field('branchId', branchId).field('licenseTypeId', licenseTypeId)
      .field('issueDate', today()).field('expiryDate', future.toISOString().slice(0, 10))
      .field('confirmRenewal', 'true').field('renewalOf', String(oldLicense._id))
      .expect(201);
  }, 20000);

  it('keeps the replaced approval file on renewal unless deleteOldFile is set', async () => {
    const licenseTypeId = await freshLicenseType();
    const oldLicense = await License.create({
      branchId, licenseTypeId, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/111-old.pdf', fileName: 'old.pdf', status: 'Valid', createdBy: adminId,
    });
    const future = new Date(); future.setDate(future.getDate() + 365);
    await request(app)
      .post('/api/licenses').set(auth())
      .field('branchId', branchId).field('licenseTypeId', licenseTypeId)
      .field('issueDate', today()).field('expiryDate', future.toISOString().slice(0, 10))
      .field('confirmRenewal', 'true').field('renewalOf', String(oldLicense._id))
      .expect(201);
    const oldAfter = await License.findById(oldLicense._id);
    expect(oldAfter.lifecycle).toBe('Replaced');
    expect(oldAfter.fileUrl).toBe('licenses/111-old.pdf');
    expect(deleteCalls()).toHaveLength(0);
  }, 20000);

  it('deletes only the replaced approval file when deleteOldFile is true', async () => {
    const licenseTypeId = await freshLicenseType();
    const oldLicense = await License.create({
      branchId, licenseTypeId, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/222-old.pdf', fileName: 'old.pdf', status: 'Valid', createdBy: adminId,
    });
    const future = new Date(); future.setDate(future.getDate() + 365);
    await request(app)
      .post('/api/licenses').set(auth())
      .field('branchId', branchId).field('licenseTypeId', licenseTypeId)
      .field('issueDate', today()).field('expiryDate', future.toISOString().slice(0, 10))
      .field('confirmRenewal', 'true').field('renewalOf', String(oldLicense._id))
      .field('deleteOldFile', 'true')
      .expect(201);
    const oldAfter = await License.findById(oldLicense._id);
    expect(oldAfter.lifecycle).toBe('Replaced');
    expect(oldAfter.fileUrl).toBe('');
    expect(deleteCalls().map((call) => call.args[0].input.Key)).toEqual(['licenses/222-old.pdf']);
  }, 20000);

  it('DELETE /:id/file removes only the document and requires auth', async () => {
    const licenseTypeId = await freshLicenseType();
    const license = await License.create({
      branchId, licenseTypeId, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/333-doc.pdf', fileName: 'doc.pdf', status: 'Valid', createdBy: adminId,
    });
    await request(app).delete(`/api/licenses/${license._id}/file`).expect(401);
    const res = await request(app).delete(`/api/licenses/${license._id}/file`).set(auth()).expect(200);
    expect(res.body.message).toContain('נמחק');
    const after = await License.findById(license._id);
    expect(after).not.toBeNull();
    expect(after.fileUrl).toBe('');
    expect(after.fileName).toBe('');
    expect(deleteCalls().map((call) => call.args[0].input.Key)).toEqual(['licenses/333-doc.pdf']);
    // Deleting again reports there is nothing to delete.
    await request(app).delete(`/api/licenses/${license._id}/file`).set(auth()).expect(404);
  }, 20000);
});

describe('Rent agreement documents', () => {
  let agreementId;

  beforeAll(async () => {
    const authority = await request(app).post('/api/rent/authorities').set(auth()).send({ name: 'עיריית מסמכים' }).expect(201);
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId: authority.body._id, monthlyAmount: 5000, frequency: 'monthly',
      paymentMethod: 'cheque', firstDueDate: new Date(Date.now() + 5 * 86400000),
    }).expect(201);
    agreementId = agreement.body._id;
  });

  it('uploads, downloads and deletes a document with a rent storage prefix', async () => {
    await request(app).post(`/api/rent/agreements/${agreementId}/documents`).expect(401);

    const upload = await request(app)
      .post(`/api/rent/agreements/${agreementId}/documents`).set(auth())
      .attach('file', fakePdf(), { filename: 'contract.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(upload.body.key).toMatch(/^rent\/\d+-[0-9a-f-]{36}-contract\.pdf$/);
    expect(upload.body.fileName).toBe('contract.pdf');

    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(['rent-doc-bytes']), ContentType: 'application/pdf', ContentLength: 14,
    });
    const binaryParser = (res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    };
    const download = await request(app)
      .get(`/api/rent/agreements/${agreementId}/documents/${upload.body._id}`)
      .set(auth()).buffer(true).parse(binaryParser).expect(200);
    expect(download.body.toString()).toBe('rent-doc-bytes');

    await request(app)
      .delete(`/api/rent/agreements/${agreementId}/documents/${upload.body._id}`).set(auth()).expect(200);
    const agreement = await RentAgreement.findById(agreementId);
    expect(agreement.documents).toHaveLength(0);
    expect(deleteCalls().some((call) => call.args[0].input.Key === upload.body.key)).toBe(true);
  }, 20000);

  it('rejects a spoofed rent document whose bytes do not match the declared type', async () => {
    const res = await request(app)
      .post(`/api/rent/agreements/${agreementId}/documents`).set(auth())
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'pretend.pdf', contentType: 'application/pdf' })
      .expect(400);
    expect(res.body.message).toContain('אינו תואם');
    const agreement = await RentAgreement.findById(agreementId);
    expect(agreement.documents).toHaveLength(0);
  }, 20000);

  it('returns 404 for an unknown document id', async () => {
    await request(app)
      .delete(`/api/rent/agreements/${agreementId}/documents/${new mongoose.Types.ObjectId()}`)
      .set(auth()).expect(404);
  }, 20000);
});

describe('Document permission isolation', () => {
  let managerToken;
  let ownLicenseId;
  let otherLicenseId;

  const managerAuth = () => ({ Authorization: `Bearer ${managerToken}` });

  beforeAll(async () => {
    const otherBranchId = (await request(app).post('/api/branches').set(auth()).send({ name: 'Docs Other Branch' }).expect(201)).body._id;
    const ownType = await freshLicenseType();
    const otherType = await freshLicenseType();
    ownLicenseId = (await License.create({
      branchId, licenseTypeId: ownType, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/own.pdf', fileName: 'own.pdf', status: 'Valid', createdBy: adminId,
    }))._id;
    otherLicenseId = (await License.create({
      branchId: otherBranchId, licenseTypeId: otherType, issueDate: today(), expiryDate: today(),
      fileUrl: 'licenses/other.pdf', fileName: 'other.pdf', status: 'Valid', createdBy: adminId,
    }))._id;
    const email = `docs-mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await request(app).post('/api/users').set(auth()).send({ name: 'Docs Manager', email, password: 'Password123', accessibleBranches: [branchId] }).expect(201);
    managerToken = (await request(app).post('/api/users/login').send({ email, password: 'Password123' }).expect(200)).body.token;
  }, 600000);

  it('lets a branch user download a document from his assigned branch', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(['own-bytes']), ContentType: 'application/pdf', ContentLength: 9,
    });
    const binaryParser = (res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    };
    const download = await request(app)
      .get(`/api/licenses/${ownLicenseId}/file`).set(managerAuth()).buffer(true).parse(binaryParser).expect(200);
    expect(download.body.toString()).toBe('own-bytes');
  }, 20000);

  it('denies a branch user a document download from another branch without touching storage', async () => {
    await request(app).get(`/api/licenses/${otherLicenseId}/file`).set(managerAuth()).expect(404);
    expect(s3Mock.calls().filter((call) => call.args[0] instanceof GetObjectCommand)).toHaveLength(0);
  }, 20000);

  it('denies a branch user a document delete from another branch without touching storage or the record', async () => {
    await request(app).delete(`/api/licenses/${otherLicenseId}/file`).set(managerAuth()).expect(404);
    expect(deleteCalls()).toHaveLength(0);
    const after = await License.findById(otherLicenseId);
    expect(after.fileUrl).toBe('licenses/other.pdf');
  }, 20000);

  it('denies branch users every rent route, including agreement documents', async () => {
    const authority = await request(app).post('/api/rent/authorities').set(auth()).send({ name: 'רשות הרשאות' }).expect(201);
    const agreement = await request(app).post('/api/rent/agreements').set(auth()).send({
      branchId, authorityId: authority.body._id, monthlyAmount: 1000, frequency: 'monthly',
      paymentMethod: 'cheque', firstDueDate: new Date(Date.now() + 5 * 86400000),
    }).expect(201);
    const agreementId = agreement.body._id;
    await request(app).get('/api/rent/summary').set(managerAuth()).expect(403);
    await request(app).get(`/api/rent/agreements/${agreementId}/documents/${new mongoose.Types.ObjectId()}`).set(managerAuth()).expect(403);
    await request(app)
      .post(`/api/rent/agreements/${agreementId}/documents`).set(managerAuth())
      .attach('file', fakePdf(), { filename: 'contract.pdf', contentType: 'application/pdf' })
      .expect(403);
    await request(app)
      .delete(`/api/rent/agreements/${agreementId}/documents/${new mongoose.Types.ObjectId()}`).set(managerAuth()).expect(403);
    expect(s3Mock.calls().filter((call) => call.args[0] instanceof PutObjectCommand)).toHaveLength(0);
  }, 20000);
});

// A Pending_Setup row (uncommitted guarded create) must not be addressable
// through the AI document routes either: the delete-propose read fences it
// exactly like the direct controllers do.
describe('AI agreement-document delete-propose fence', () => {
  it('refuses a Pending_Setup agreement with 404 while an Active one still proposes', async () => {
    await mongoose.model('User').updateOne({ _id: adminId }, { aiEnabled: true });
    const Authority = mongoose.model('Authority');
    const au = await Authority.create({ adminId, name: `רשות גדר ${Date.now()}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) });
    const base = { adminId, branchId, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2027-01-01') };
    const pending = await RentAgreement.create({ ...base, status: 'Pending_Setup', pendingGuard: true });
    const active = await RentAgreement.create({ ...base });
    active.documents.push({ key: 'rent/fence.pdf', fileName: 'fence.pdf', uploadedAt: new Date() });
    await active.save();
    const docId = String(active.documents[0]._id);
    await request(app).post('/api/ai/agreements/document/delete-propose').set(auth()).send({ agreementId: String(pending._id), docId }).expect(404);
    await request(app).post('/api/ai/agreements/document/delete-propose').set(auth()).send({ agreementId: String(active._id), docId }).expect(200);
    await mongoose.model('User').updateOne({ _id: adminId }, { aiEnabled: false });
  });
});
