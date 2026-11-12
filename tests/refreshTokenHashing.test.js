import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import crypto from 'crypto';
import RefreshToken from '../src/models/RefreshToken.js';

let app;
let mongoServer;
let cookieFor = async (email) => {};

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Refresh token hashing', () => {
  it('stores only a hash for new sessions, never the raw token', async () => {
    const email = `hash-${Date.now()}@example.com`;
    const res = await request(app).post('/api/users/register').send({ name: 'Hash Admin', email, password: 'Password123' }).expect(201);
    const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('refreshToken='));
    expect(cookie).toBeTruthy();
    const raw = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
    const docs = await RefreshToken.find({});
    expect(docs.length).toBe(1);
    expect(docs[0].token).toBeUndefined();
    expect(docs[0].tokenHash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
  });

  it('still honours a legacy plaintext token until it ages out, then rotates to hashed-only', async () => {
    const email = `legacy-${Date.now()}@example.com`;
    await request(app).post('/api/users/register').send({ name: 'Legacy Admin', email, password: 'Password123' }).expect(403); // registration closed after first admin
    const admin = await mongoose.connection.db.collection('users').findOne({ email: /hash-/ });
    // Simulate a pre-change session document: plaintext token, no hash.
    const legacyRaw = 'legacy-' + crypto.randomBytes(24).toString('hex');
    await RefreshToken.create({
      jti: crypto.randomBytes(12).toString('hex'),
      token: legacyRaw,
      user: admin._id,
      expiresAt: new Date(Date.now() + 86400000),
    });
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${legacyRaw}`]).expect(200);
    expect(refreshed.body.token).toBeTruthy();
    // The legacy doc is revoked untouched, and its replacement is hash-only.
    const legacyDoc = await RefreshToken.findOne({ token: legacyRaw });
    expect(legacyDoc.revoked).toBe(true);
    expect(legacyDoc.replacedByToken).toBeTruthy();
    const replacement = await RefreshToken.findOne({ tokenHash: legacyDoc.replacedByToken });
    expect(replacement).toBeTruthy();
    expect(replacement.token).toBeUndefined();
    // Logout works against the hashed token too.
    const newCookie = (refreshed.headers['set-cookie'] || []).find((c) => c.startsWith('refreshToken='));
    await request(app).post('/api/auth/logout').set('Cookie', [newCookie]).expect(204);
    const after = await RefreshToken.findById(replacement._id);
    expect(after.revoked).toBe(true);
  });
});
