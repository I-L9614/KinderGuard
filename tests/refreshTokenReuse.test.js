import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import crypto from 'crypto';
import RefreshToken from '../src/models/RefreshToken.js';

let app;
let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.REFRESH_REUSE_GRACE_MS = '30000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const cookieToken = (res) => {
  const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('refreshToken='));
  return cookie ? decodeURIComponent(cookie.split(';')[0].split('=')[1]) : null;
};

const activeCount = (userId) => RefreshToken.countDocuments({ user: userId, revoked: false });

describe('Refresh token reuse detection', () => {
  it('rotates normally, and a replay within the grace window only rejects without revoking other sessions', async () => {
    const email = `reuse-${Date.now()}@example.com`;
    const reg = await request(app).post('/api/users/register').send({ name: 'Reuse Admin', email, password: 'Password123' }).expect(201);
    const raw1 = cookieToken(reg);
    expect(raw1).toBeTruthy();

    // Legitimate rotation: raw1 -> raw2.
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${raw1}`]).expect(200);
    const raw2 = cookieToken(refreshed);
    expect(raw2).toBeTruthy();

    // A second active session (same user, another device).
    const login = await request(app).post('/api/users/login').send({ email, password: 'Password123' }).expect(200);
    const raw3 = cookieToken(login);
    expect(raw3).toBeTruthy();

    const userId = (await RefreshToken.findOne({ tokenHash: crypto.createHash('sha256').update(raw1).digest('hex') })).user;

    // Immediate replay of raw1: treated as a race, 401 but no family revocation.
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${raw1}`]).expect(401);
    expect(await activeCount(userId)).toBe(2);

    // Both live sessions still refresh fine.
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${raw2}`]).expect(200);
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${raw3}`]).expect(200);
  });

  it('a replay after the grace window revokes every active session of the user', async () => {
    const email = `theft-${Date.now()}@example.com`;
    const reg = await request(app).post('/api/users/register').send({ name: 'Theft Admin', email, password: 'Password123' }).expect(403); // only first admin self-registers
    const admin = await mongoose.connection.db.collection('users').findOne({ email: /reuse-/ });
    const userId = admin._id;

    // Two fresh sessions for the user.
    const loginA = await request(app).post('/api/users/login').send({ email: admin.email, password: 'Password123' }).expect(200);
    const rawA = cookieToken(loginA);
    const loginB = await request(app).post('/api/users/login').send({ email: admin.email, password: 'Password123' }).expect(200);
    const rawB = cookieToken(loginB);
    expect(rawA && rawB).toBeTruthy();

    // Rotate rawA (the legitimate holder), then pretend the rotated-out rawA
    // is replayed by an attacker well after the grace window: backdate the
    // revocation timestamp instead of waiting 30s.
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${rawA}`]).expect(200);
    const rawA2 = cookieToken(refreshed);
    const rotatedDoc = await RefreshToken.findOne({ tokenHash: crypto.createHash('sha256').update(rawA).digest('hex') });
    expect(rotatedDoc.revoked).toBe(true);
    await RefreshToken.updateOne({ _id: rotatedDoc._id }, { $set: { updatedAt: new Date(Date.now() - 60000) } }, { timestamps: false });

    const before = await activeCount(userId);
    expect(before).toBeGreaterThanOrEqual(2);

    // The replay: 401, and every remaining active session of the user dies.
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${rawA}`]).expect(401);
    expect(await activeCount(userId)).toBe(0);

    // Neither the replacement nor the second device can refresh any more.
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${rawA2}`]).expect(401);
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${rawB}`]).expect(401);
  });

  it('an unknown or expired token is a plain 401, never a family revocation', async () => {
    const admin = await mongoose.connection.db.collection('users').findOne({ email: /reuse-/ });
    // Unknown token: no matching document at all.
    await request(app).post('/api/auth/refresh').set('Cookie', ['refreshToken=nope-' + crypto.randomBytes(24).toString('hex')]).expect(401);
    // Expired but never revoked document: also just a 401.
    const expiredRaw = 'expired-' + crypto.randomBytes(24).toString('hex');
    await RefreshToken.create({
      jti: crypto.randomBytes(12).toString('hex'),
      tokenHash: crypto.createHash('sha256').update(expiredRaw).digest('hex'),
      user: admin._id,
      expiresAt: new Date(Date.now() - 1000),
    });
    await request(app).post('/api/auth/refresh').set('Cookie', [`refreshToken=${expiredRaw}`]).expect(401);
  });
});
