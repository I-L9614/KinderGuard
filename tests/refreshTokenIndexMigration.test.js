import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

// Upgrade-path regression guard: a database created before v0.3.5 carries a
// unique, NON-sparse index on refreshtokens.token. With 0.3.5+ storing only
// tokenHash (token absent on new docs), that stale shape makes every login
// after the first fail with E11000 -> 409 'רשומה עם הפרטים האלה כבר קיימת.'.
// The boot migration must repair exactly that shape - without touching
// documents, without loosening uniqueness of real token strings, and without
// acting on an already-correct index.

let app;
let mongoServer;
let migrate;
const email = 'admin@example.com';
const password = 'Password123';

const tokenIndex = () => mongoose.connection.db
  .collection('refreshtokens')
  .indexes()
  .then((list) => list.find((i) => i.name === 'token_1'));

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.S3_BUCKET_NAME = 'test-bucket';
  process.env.S3_REGION = 'us-east-1';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);

  // Simulate the pre-0.3.5 production index shape before any model autoIndex.
  await mongoose.connection.db.collection('refreshtokens').createIndex({ token: 1 }, { unique: true });

  ({ default: app } = await import('../src/app.js'));
  ({ ensureRefreshTokenIndexShape: migrate } = await import('../src/config/db.js'));
  const { default: User } = await import('../src/models/User.js');
  await User.create({ name: 'Admin', email, password, role: 'Admin' });
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('stale refreshtokens.token_1 index (pre-0.3.5 databases)', () => {
  it('reproduces the production failure: second login hits E11000 with the stale index', async () => {
    expect((await tokenIndex())?.sparse).toBeUndefined();
    const first = await request(app).post('/api/users/login').send({ email, password });
    expect(first.status).toBe(200);
    const second = await request(app).post('/api/users/login').send({ email, password });
    expect(second.status).toBe(409);
    expect(second.body.message).toBe('רשומה עם הפרטים האלה כבר קיימת.');
  });

  it('repairs the stale index, touches no documents, and logins keep succeeding', async () => {
    const docsBefore = await mongoose.connection.db.collection('refreshtokens').countDocuments();
    expect(await migrate()).toBe(true);
    const fixed = await tokenIndex();
    expect(fixed?.unique).toBe(true);
    expect(fixed?.sparse).toBe(true);
    expect(await mongoose.connection.db.collection('refreshtokens').countDocuments()).toBe(docsBefore);

    for (let i = 0; i < 3; i += 1) {
      const res = await request(app).post('/api/users/login').send({ email, password });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeTruthy();
    }
  });

  it('still enforces uniqueness of real (legacy plaintext) token strings', async () => {
    const col = mongoose.connection.db.collection('refreshtokens');
    const doc = { jti: `j-${Date.now()}`, token: `t-${Date.now()}`, user: new mongoose.Types.ObjectId(), expiresAt: new Date(Date.now() + 1000) };
    await col.insertOne(doc);
    await expect(col.insertOne({ ...doc, jti: 'other' })).rejects.toMatchObject({ code: 11000 });
  });

  it('is idempotent and never drops an already-correct index', async () => {
    expect(await migrate()).toBe(false);
    const idx = await tokenIndex();
    expect(idx?.unique).toBe(true);
    expect(idx?.sparse).toBe(true);
  });
});
