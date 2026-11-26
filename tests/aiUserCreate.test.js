import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let adminToken;

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket'; process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  adminToken = (await request(app).post('/api/users/register').send({ name: 'Admin', email: `ai-${Date.now()}@example.com`, password: 'Password123' }).expect(201)).body.token;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const create = (extra) => request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
  .send({ name: `U-${Math.random().toString(36).slice(2)}`, email: `u-${Math.random().toString(36).slice(2)}@example.com`, password: 'Password123', ...extra });

describe('AI access on user creation', () => {
  it('is off by default and on only when the admin ticks it', async () => {
    await create({}).expect(201);
    await create({ aiEnabled: true }).expect(201);
    await create({ role: 'Admin', aiEnabled: true }).expect(201);
    const list = (await request(app).get('/api/users').set('Authorization', `Bearer ${adminToken}`).expect(200)).body;
    expect(list.filter((u) => u.aiEnabled).length).toBe(2);
    expect(list.filter((u) => !u.aiEnabled).length).toBe(1);
  });
  it('rejects a non-boolean aiEnabled value', async () => { await create({ aiEnabled: 'yes please' }).expect(400); });
  it('the registering admin does not get AI by default', async () => {
    const me = await request(app).get('/api/users/me').set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(me.body.aiEnabled).not.toBe(true);
  });
});
