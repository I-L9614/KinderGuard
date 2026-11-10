import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app;
let mongoServer;
let adminToken;
let branchA;
let branchB;
let licenseTypeId;

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `scope-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  adminToken = admin.body.token;
  branchA = (await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Branch A' }).expect(201)).body;
  branchB = (await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Branch B' }).expect(201)).body;
  licenseTypeId = (await request(app).post('/api/license-types').set('Authorization', `Bearer ${adminToken}`).send({ name: 'אישור בטיחות', branchId: null }).expect(201)).body._id;
  const today = new Date().toISOString().slice(0, 10);
  await request(app).post('/api/licenses').set('Authorization', `Bearer ${adminToken}`).field('branchId', branchA._id).field('licenseTypeId', licenseTypeId).field('issueDate', today).field('expiryDate', today).expect(201);
  await request(app).post('/api/licenses').set('Authorization', `Bearer ${adminToken}`).field('branchId', branchB._id).field('licenseTypeId', licenseTypeId).field('issueDate', today).field('expiryDate', today).expect(201);
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const createManager = async (branches) => {
  const email = `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Manager', email, password: 'Password123', accessibleBranches: branches }).expect(201);
  const login = await request(app).post('/api/users/login').send({ email, password: 'Password123' }).expect(200);
  return login.body.token;
};

describe('Branch user license-list scope', () => {
  it('lists only the assigned branch permits by default', async () => {
    const managerToken = await createManager([branchA._id]);
    const list = await request(app).get('/api/licenses').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(String(list.body[0].branchId._id || list.body[0].branchId)).toBe(String(branchA._id));
  }, 20000);

  it('cannot widen scope with a branchId query for another branch', async () => {
    const managerToken = await createManager([branchA._id]);
    const list = await request(app).get(`/api/licenses?branchId=${branchB._id}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(list.body).toHaveLength(0);
  }, 20000);

  it('still narrows to an assigned branch when asked', async () => {
    const managerToken = await createManager([branchA._id, branchB._id]);
    const list = await request(app).get(`/api/licenses?branchId=${branchB._id}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(String(list.body[0].branchId._id || list.body[0].branchId)).toBe(String(branchB._id));
  }, 20000);

  it('keeps the history listing under the same scope', async () => {
    const managerToken = await createManager([branchA._id]);
    const history = await request(app).get(`/api/licenses?branchId=${branchB._id}&history=true`).set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(history.body).toHaveLength(0);
  }, 20000);

  it('admin still filters any branch by branchId', async () => {
    const list = await request(app).get(`/api/licenses?branchId=${branchB._id}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(list.body).toHaveLength(1);
  }, 20000);
});
