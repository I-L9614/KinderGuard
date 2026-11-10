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

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `tasks-${Date.now()}@example.com`, password: 'Password123' }).expect(201);
  adminToken = admin.body.token;
  branchA = (await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Branch A' }).expect(201)).body;
  branchB = (await request(app).post('/api/branches').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Branch B' }).expect(201)).body;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const createManager = async (branches) => {
  const email = `mgr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Manager', email, password: 'Password123', accessibleBranches: branches }).expect(201);
  const login = await request(app).post('/api/users/login').send({ email, password: 'Password123' }).expect(200);
  return login.body.token;
};

const createTask = (token, body = { title: 'משימה לבדיקה' }) =>
  request(app).post('/api/tasks').set('Authorization', `Bearer ${token}`).send(body).expect(201);

describe('Task visibility and ownership', () => {
  it('a branch user lists only his own tasks, even with scope=all', async () => {
    const managerToken = await createManager([branchA._id]);
    const otherManager = await createManager([branchA._id]);
    await createTask(managerToken, { title: 'משימה של המשתמש' });
    await createTask(otherManager, { title: 'משימה של משתמש אחר' });
    const own = await request(app).get('/api/tasks').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(own.body).toHaveLength(1);
    expect(own.body[0].title).toBe('משימה של המשתמש');
    expect(own.body[0].editable).toBe(true);
    const widened = await request(app).get('/api/tasks?scope=all').set('Authorization', `Bearer ${managerToken}`).expect(200);
    expect(widened.body).toHaveLength(1);
  }, 30000);

  it('the admin sees her own tasks by default and the whole team with scope=all', async () => {
    const managerToken = await createManager([branchA._id]);
    await createTask(managerToken, { title: 'משימת סניף' });
    await createTask(adminToken, { title: 'משימת מנהלת' });
    const own = await request(app).get('/api/tasks').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(own.body.every((task) => task.title === 'משימת מנהלת')).toBe(true);
    const team = await request(app).get('/api/tasks?scope=all').set('Authorization', `Bearer ${adminToken}`).expect(200);
    const titles = team.body.map((task) => task.title);
    expect(titles).toContain('משימת סניף');
    expect(titles).toContain('משימת מנהלת');
    const foreign = team.body.find((task) => task.title === 'משימת סניף');
    expect(foreign.editable).toBe(false);
  }, 30000);

  it('only the creator can update a task, not even the admin', async () => {
    const managerToken = await createManager([branchA._id]);
    const task = (await createTask(managerToken)).body;
    await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'Done' }).expect(403);
    const otherManager = await createManager([branchA._id]);
    await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${otherManager}`).send({ status: 'Done' }).expect(403);
    const updated = await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${managerToken}`).send({ status: 'Done' }).expect(200);
    expect(updated.body.status).toBe('Done');
    expect(updated.body.completedAt).toBeTruthy();
    const reopened = await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${managerToken}`).send({ status: 'To_Do' }).expect(200);
    expect(reopened.body.completedAt).toBeNull();
  }, 30000);

  it('only the creator can delete a task', async () => {
    const managerToken = await createManager([branchA._id]);
    const task = (await createTask(managerToken)).body;
    await request(app).delete(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${adminToken}`).expect(403);
    await request(app).delete(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${managerToken}`).expect(200);
    await request(app).get(`/api/tasks`).set('Authorization', `Bearer ${managerToken}`).expect(200).then((res) => {
      expect(res.body.find((item) => item._id === task._id)).toBeUndefined();
    });
  }, 30000);

  it('a branch user cannot attach a task to a branch outside his access', async () => {
    const managerToken = await createManager([branchA._id]);
    await createTask(managerToken, { title: 'בסניף המותר', branchId: branchA._id });
    await request(app).post('/api/tasks').set('Authorization', `Bearer ${managerToken}`).send({ title: 'בסניף אחר', branchId: branchB._id }).expect(400);
    const task = (await createTask(managerToken)).body;
    await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${managerToken}`).send({ branchId: branchB._id }).expect(400);
  }, 30000);

  it('a task from another tenant is not found at all', async () => {
    const { default: User } = await import('../src/models/User.js');
    const email = `other-${Date.now()}@example.com`;
    const other = await User.create({ name: 'Other', email, password: 'Password123', role: 'Admin' });
    other.adminId = other._id; await other.save();
    const login = await request(app).post('/api/users/login').send({ email, password: 'Password123' }).expect(200);
    const task = (await createTask(login.body.token, { title: 'משימה זרה' })).body;
    await request(app).patch(`/api/tasks/${task._id}`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'Done' }).expect(404);
    const team = await request(app).get('/api/tasks?scope=all').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(team.body.find((item) => item._id === task._id)).toBeUndefined();
  }, 30000);
});
