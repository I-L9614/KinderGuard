import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app;
let mongoServer;
let adminToken;
let adminCookie;
let branchId;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.REFRESH_TOKEN_LIMIT = '5';
  process.env.S3_BUCKET_NAME = 'test-bucket';
  process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Account and branch access', () => {
  it('creates the first administrator and prevents public role escalation', async () => {
    const email = `admin-${Date.now()}@example.com`;
    const response = await request(app).post('/api/users/register').send({ name: 'Account Admin', email, password: 'Password123' }).expect(201);
    adminToken = response.body.token;
    adminCookie = response.headers['set-cookie'];
    expect(response.body.role).toBe('Admin');
    expect(response.headers['set-cookie']).toBeDefined();
    await request(app).post('/api/users/register').send({ name: 'Other', email: `other-${Date.now()}@example.com`, password: 'Password123' }).expect(403);
  });

  it('creates branches and limits a manager to assigned branches', async () => {
    const branchA = await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'North Branch' }).expect(201);
    const branchB = await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'South Branch' }).expect(201);
    branchId = branchA.body._id;
    const managerEmail = `manager-${Date.now()}@example.com`;
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Branch Manager', email: managerEmail, password: 'Password123', accessibleBranches: [branchA.body._id] }).expect(201);
    const login = await request(app).post('/api/users/login').send({ email: managerEmail, password: 'Password123' }).expect(200);
    const ownBranches = await request(app).get('/api/branches').set('Authorization', `Bearer ${login.body.token}`).expect(200);
    expect(ownBranches.body.map((branch) => branch._id)).toEqual([branchA.body._id]);
    await request(app).get(`/api/license-types?branchId=${branchB.body._id}`).set('Authorization', `Bearer ${login.body.token}`).expect(404);
  });

  it('adds a co-admin who shares the same data and full permissions', async () => {
    const coAdminEmail = `coadmin-${Date.now()}@example.com`;
    const created = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Co Admin', email: coAdminEmail, password: 'Password123', role: 'Admin', accessibleBranches: [] }).expect(201);
    expect(created.body.role).toBe('Admin');

    const login = await request(app).post('/api/users/login').send({ email: coAdminEmail, password: 'Password123' }).expect(200);
    expect(login.body.role).toBe('Admin');
    const coAdminToken = login.body.token;

    // Same tenant: sees all existing branches without any branch assignment
    const branches = await request(app).get('/api/branches').set('Authorization', `Bearer ${coAdminToken}`).expect(200);
    expect(branches.body.length).toBeGreaterThanOrEqual(2);

    // /me resolves to the primary admin's tenant id
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${coAdminToken}`).expect(200);
    const primaryMe = await request(app).get('/api/users/me').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(String(me.body.adminId)).toBe(String(primaryMe.body.adminId));

    // Full permissions: can create branches and manage users like the primary admin
    await request(app).post('/api/branches').set('Authorization', `Bearer ${coAdminToken}`).send({ name: 'Co Admin Branch' }).expect(201);
    const mgrEmail = `mgr-by-coadmin-${Date.now()}@example.com`;
    await request(app).post('/api/users').set('Authorization', `Bearer ${coAdminToken}`).send({ name: 'Manager By CoAdmin', email: mgrEmail, password: 'Password123', accessibleBranches: [] }).expect(201);

    // Team list shows the co-admin with its role, and the new branch is visible to the primary admin
    const users = await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(users.body.find((u) => u.email === coAdminEmail)?.role).toBe('Admin');
    const primaryBranches = await request(app).get('/api/branches').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(primaryBranches.body.map((b) => b.name)).toContain('Co Admin Branch');

    // Managers still cannot add users
    const mgrLogin = await request(app).post('/api/users/login').send({ email: mgrEmail, password: 'Password123' }).expect(200);
    await request(app).post('/api/users').set('Authorization', `Bearer ${mgrLogin.body.token}`).send({ name: 'Nope', email: `nope-${Date.now()}@example.com`, password: 'Password123', accessibleBranches: [] }).expect(403);
  });

  it('refreshes access token and lists sessions', async () => {
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', adminCookie).expect(200);
    const sessions = await request(app).get('/api/auth/sessions').set('Authorization', `Bearer ${refreshed.body.token}`).expect(200);
    expect(sessions.body.length).toBeGreaterThan(0);
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${refreshed.body.token}`).expect(200);
    expect(me.body.role).toBe('Admin');
    expect(branchId).toBeTruthy();
  });
});
