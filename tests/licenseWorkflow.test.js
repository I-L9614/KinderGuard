import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { generateDueNotifications } from '../src/controllers/notificationController.js';
import License from '../src/models/License.js';

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
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `license-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  token = admin.body.token;
  adminId = admin.body.id;
  const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'Main Branch' }).expect(201);
  branchId = branch.body._id;
  const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'אישור בטיחות', branchId: null }).expect(201);
  licenseTypeId = type.body._id;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Branch permit workflow', () => {
  it('creates a permit, generates a persistent expiry reminder, and keeps renewal history', async () => {
    const today = new Date(); const issueDate = today.toISOString().slice(0, 10);
    const create = (expiry) => request(app).post('/api/licenses').set('Authorization', `Bearer ${token}`).field('branchId', branchId).field('licenseTypeId', licenseTypeId).field('issueDate', issueDate).field('expiryDate', expiry);
    const first = await create(issueDate).expect(201);
    await generateDueNotifications();
    const alerts = await request(app).get('/api/notifications').set('Authorization', `Bearer ${token}`).expect(200);
    expect(alerts.body.some((alert) => alert.licenseId._id === first.body._id && alert.triggerDays === 0)).toBe(true);
    await request(app).patch(`/api/notifications/${alerts.body[0]._id}`).set('Authorization', `Bearer ${token}`).send({ status: 'In_Progress' }).expect(200);
    const future = new Date(today); future.setDate(future.getDate() + 365);
    const renewal = await create(future.toISOString().slice(0, 10)).expect(201);
    const history = await request(app).get(`/api/licenses/${renewal.body._id}/history`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(history.body).toHaveLength(2);
    expect(history.body.some((license) => license.lifecycle === 'Replaced')).toBe(true);
    const active = await request(app).get(`/api/licenses?branchId=${branchId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(active.body).toHaveLength(1);
    expect(active.body[0]._id).toBe(renewal.body._id);
  }, 20000);

  it('serves attached files only through the authenticated download route', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'Files Branch' }).expect(201);
    const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'אישור עם קובץ', branchId: null }).expect(201);
    const license = await License.create({
      branchId: branch.body._id, licenseTypeId: type.body._id, issueDate: today, expiryDate: today,
      fileUrl: 'licenses/123-permit.pdf', fileName: 'אישור-כיבוי-אש.pdf',
      status: 'Valid', createdBy: adminId,
    });
    s3Mock.on(GetObjectCommand).resolves({
      Body: Readable.from(['permit-pdf-bytes']),
      ContentType: 'application/pdf',
      ContentLength: 16,
    });

    await request(app).get(`/api/licenses/${license._id}/file`).expect(401);

    const binaryParser = (res, callback) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => callback(null, Buffer.concat(chunks)));
    };
    const response = await request(app)
      .get(`/api/licenses/${license._id}/file`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
      .expect(200)
      .expect('Content-Type', /application\/pdf/);
    expect(response.headers['content-disposition']).toContain('inline');
    expect(response.headers['content-disposition']).toContain(encodeURIComponent('אישור-כיבוי-אש.pdf'));
    expect(response.body.toString()).toBe('permit-pdf-bytes');

    const calls = s3Mock.calls();
    expect(calls.some((call) => call.args[0].input.Key === 'licenses/123-permit.pdf')).toBe(true);

    await License.deleteOne({ _id: license._id });
  }, 20000);

  it('returns 404 for a license without an attached file', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const branch = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'No File Branch' }).expect(201);
    const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'אישור בלי קובץ', branchId: null }).expect(201);
    const license = await License.create({
      branchId: branch.body._id, licenseTypeId: type.body._id, issueDate: today, expiryDate: today,
      status: 'Valid', createdBy: adminId,
    });
    await request(app)
      .get(`/api/licenses/${license._id}/file`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
    await License.deleteOne({ _id: license._id });
  }, 20000);

  it('supports branch-specific permit types and rejects types from another branch', async () => {
    const other = await request(app).post('/api/branches').set('Authorization', `Bearer ${token}`).send({ name: 'Other Branch' }).expect(201);
    const type = await request(app).post('/api/license-types').set('Authorization', `Bearer ${token}`).send({ name: 'סוג ייחודי', branchId: other.body._id }).expect(201);
    const types = await request(app).get(`/api/license-types?branchId=${branchId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(types.body.some((item) => item._id === type.body._id)).toBe(false);
  });
});
