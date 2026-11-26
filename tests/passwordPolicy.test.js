import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { passwordPolicyError, maskEmail, PASSWORD_POLICY_MESSAGE } from '../src/utils/passwordPolicy.js';

let app;
let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('password policy', () => {
  it('rejects short and common passwords, accepts a strong one', () => {
    expect(passwordPolicyError('short')).toBe(PASSWORD_POLICY_MESSAGE);
    expect(passwordPolicyError('1234567890')).toBe(PASSWORD_POLICY_MESSAGE);
    expect(passwordPolicyError('password')).toBe(PASSWORD_POLICY_MESSAGE);
    expect(passwordPolicyError('K1nderGuard-2026!')).toBe(null);
  });

  it('registration enforces the policy', async () => {
    const weak = await request(app).post('/api/users/register')
      .send({ name: 'Weak Admin', email: `weak-${Date.now()}@example.com`, password: '12345678' })
      .expect(400);
    expect(JSON.stringify(weak.body)).toContain(PASSWORD_POLICY_MESSAGE);
    await request(app).post('/api/users/register')
      .send({ name: 'Strong Admin', email: `strong-${Date.now()}@example.com`, password: 'K1nderGuard-2026!' })
      .expect(201);
  });

  it('manager-created users enforce the policy too', async () => {
    const login = await request(app).post('/api/users/login')
      .send({ email: (await mongoose.connection.db.collection('users').findOne({ email: /strong-/ })).email, password: 'K1nderGuard-2026!' })
      .expect(200);
    const token = login.body.token;
    await request(app).post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Branch User', email: `branch-${Date.now()}@example.com`, password: 'qwerty123', role: 'Manager' })
      .expect(400);
    await request(app).post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Branch User', email: `branch-${Date.now()}@example.com`, password: 'S3cure-Branch-99', role: 'Manager' })
      .expect(201);
  });

  it('maskEmail keeps the domain but hides the local part', () => {
    expect(maskEmail('anael.my3669@gmail.com')).toBe('a***@gmail.com');
    expect(maskEmail('x@b.co')).toBe('x***@b.co');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
