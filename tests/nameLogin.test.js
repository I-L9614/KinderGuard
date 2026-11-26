import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User;
let adminToken;
const ADMIN_NAME = 'איתמר לוי';
const ADMIN_EMAIL = `name-admin-${Date.now()}@example.com`;
const PASSWORD = 'Password12345';

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.LOGIN_RATE_LIMIT_MAX = '1000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  ({ default: User } = await import('../src/models/User.js'));
  const reg = await request(app).post('/api/users/register').send({ name: ADMIN_NAME, email: ADMIN_EMAIL, password: PASSWORD }).expect(201);
  adminToken = reg.body.token;
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('name-or-email login', () => {
  it('logs in by exact display name, by name with stray spaces, and by email in both body shapes', async () => {
    const byName = await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: PASSWORD }).expect(200);
    expect(byName.body.name).toBe(ADMIN_NAME);
    const spaced = await request(app).post('/api/users/login').send({ identifier: '  איתמר   לוי ', password: PASSWORD }).expect(200);
    expect(spaced.body.email).toBe(ADMIN_EMAIL);
    const emailAsIdentifier = await request(app).post('/api/users/login').send({ identifier: ADMIN_EMAIL.toUpperCase(), password: PASSWORD }).expect(200);
    expect(emailAsIdentifier.body.name).toBe(ADMIN_NAME);
    // Older installed clients still send `email`.
    const legacy = await request(app).post('/api/users/login').send({ email: ADMIN_EMAIL, password: PASSWORD }).expect(200);
    expect(legacy.body.name).toBe(ADMIN_NAME);
  });

  it('rejects wrong passwords and unknown names with one generic message', async () => {
    const wrong = await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: 'wrong-password' }).expect(401);
    const unknown = await request(app).post('/api/users/login').send({ identifier: 'אין כזה בכלל', password: 'wrong-password' }).expect(401);
    expect(wrong.body.message).toBe('פרטי ההתחברות שגויים');
    expect(unknown.body.message).toBe('פרטי ההתחברות שגויים');
  });

  it('blocks creating a user whose display name is already taken, in any spacing', async () => {
    const dup = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '  איתמר   לוי ', email: `dup-${Date.now()}@example.com`, password: PASSWORD }).expect(400);
    expect(dup.body.message).toBe('השם הזה כבר תפוס. בחרו שם אחר.');
    const fresh = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'אנאל מעונות יום', email: `anel-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
    expect(fresh.body.name).toBe('אנאל מעונות יום');
    const login = await request(app).post('/api/users/login').send({ identifier: 'אנאל מעונות יום', password: PASSWORD }).expect(200);
    expect(login.body.role).toBe('Manager');
  });

  it('enforces uniqueness at the model layer too (direct writes and renames)', async () => {
    await expect(User.create({ name: 'איתמר  לוי', email: `sneaky-${Date.now()}@example.com`, password: PASSWORD })).rejects.toThrow();
    const other = await User.create({ name: 'שם אחר', email: `other-${Date.now()}@example.com`, password: PASSWORD });
    other.name = 'אנאל מעונות יום';
    await expect(other.save()).rejects.toThrow();
  });

  it('blocks a new user whose name matches a pre-migration account that has no nameKey yet', async () => {
    const legacy = await User.create({ name: 'לגסי חלון', email: `win-${Date.now()}@example.com`, password: PASSWORD });
    await User.collection.updateOne({ _id: legacy._id }, { $unset: { nameKey: 1 } });
    const r = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: '  לגסי   חלון ', email: `win2-${Date.now()}@example.com`, password: PASSWORD }).expect(400);
    expect(r.body.message).toBe('השם הזה כבר תפוס. בחרו שם אחר.');
  });

  it('rollback leftovers: old-code writes without nameKey still succeed with the index present, and the index really is enforced', async () => {
    // Simulates a rollback to code that does not know nameKey (direct write,
    // no hooks): creating another account named like an existing one must not
    // hit the unique index, because the sparse index only sees docs that
    // carry the field.
    const raw = await User.collection.insertOne({ name: ADMIN_NAME, email: `oldcode-${Date.now()}@example.com`, password: 'x', role: 'Manager', createdAt: new Date(), updatedAt: new Date() });
    expect(raw.insertedId).toBeTruthy();
    // ...while a write that DOES carry a taken nameKey is rejected (the index
    // exists and is unique+sparse in this database).
    await expect(User.collection.insertOne({ name: 'מי שהוא', nameKey: 'איתמר לוי', email: `clash-${Date.now()}@example.com`, password: 'x', role: 'Manager' })).rejects.toThrow(/E11000/);
  });

  it('fails closed on name creation while the unique index is not ready, and recovers without restart', async () => {
    await User.collection.dropIndex('nameKey_1');
    try {
      const r = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'חלון תחזוקה', email: `maint-${Date.now()}@example.com`, password: PASSWORD }).expect(503);
      expect(r.body.message).toContain('תחזוקה');
      // The model layer refuses too (covers future rename endpoints).
      const orphan = new User({ name: 'חלון תחזוקה אחר', email: `maint2-${Date.now()}@example.com`, password: PASSWORD });
      await expect(orphan.save()).rejects.toThrow();
      // Login is unaffected while the index is down.
      await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: PASSWORD }).expect(200);
    } finally {
      await User.collection.createIndex({ nameKey: 1 }, { unique: true, sparse: true, name: 'nameKey_1' });
    }
    // Self-heals: the next create re-verifies live and succeeds.
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'חלון תחזוקה', email: `maint-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
  });

  it('fails closed while the index exists with the wrong shape (not unique)', async () => {
    await User.collection.dropIndex('nameKey_1');
    try {
      await User.collection.createIndex({ nameKey: 1 }, { sparse: true, name: 'nameKey_1' });
      await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'צורה שגויה', email: `shape-${Date.now()}@example.com`, password: PASSWORD }).expect(503);
    } finally {
      await User.collection.dropIndex('nameKey_1');
      await User.collection.createIndex({ nameKey: 1 }, { unique: true, sparse: true, name: 'nameKey_1' });
    }
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'צורה שגויה', email: `shape-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
  });

  it('fails closed when the readiness check itself errors', async () => {
    const proto = Object.getPrototypeOf(mongoose.connection.db.collection('users'));
    const spy = vi.spyOn(proto, 'indexes').mockRejectedValue(new Error('check failed'));
    try {
      await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'בדיקה נכשלה', email: `err-${Date.now()}@example.com`, password: PASSWORD }).expect(503);
      const orphan = new User({ name: 'בדיקה נכשלה אחרת', email: `err2-${Date.now()}@example.com`, password: PASSWORD });
      await expect(orphan.save()).rejects.toThrow();
      // Login still works: it never consults the index check.
      await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: PASSWORD }).expect(200);
    } finally {
      spy.mockRestore();
    }
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'בדיקה נכשלה', email: `err-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
  });

  it('keeps startup and login alive when the index build itself fails, and name writes follow the shape check', async () => {
    const spy = vi.spyOn(User, 'init').mockRejectedValue(new Error('E11000 duplicate key during index build'));
    try {
      // Startup preserved: connectDB must resolve even though User.init() rejects.
      const { default: connectDB } = await import('../src/config/db.js');
      await expect(connectDB()).resolves.toBeTruthy();
      // Login unaffected.
      await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: PASSWORD }).expect(200);
      // Index actually healthy (mock only breaks the build wait): no raw 500,
      // the write proceeds and the real unique index still closes the race.
      await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'בנייה נכשלה', email: `build-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
      // The realistic failure state - build failed AND no healthy index:
      // name writes refuse with the friendly 503, never a raw 500.
      await User.collection.dropIndex('nameKey_1');
      try {
        const r = await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
          .send({ name: 'בנייה נכשלה שתיים', email: `build2-${Date.now()}@example.com`, password: PASSWORD }).expect(503);
        expect(r.body.message).toContain('תחזוקה');
        const orphan = new User({ name: 'בנייה נכשלה שלוש', email: `build3-${Date.now()}@example.com`, password: PASSWORD });
        await expect(orphan.save()).rejects.toMatchObject({ statusCode: 503 });
        await request(app).post('/api/users/login').send({ identifier: ADMIN_NAME, password: PASSWORD }).expect(200);
      } finally {
        await User.collection.createIndex({ nameKey: 1 }, { unique: true, sparse: true, name: 'nameKey_1' });
      }
    } finally {
      spy.mockRestore();
    }
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'בנייה נכשלה שתיים', email: `build2-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
  });

  it('locks the account, not the identifier: name and email attempts share one counter', async () => {
    const email = `locked-${Date.now()}@example.com`;
    await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'משתמש נעילה', email, password: PASSWORD }).expect(201);
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/users/login').send({ identifier: 'משתמש נעילה', password: 'wrong-password' }).expect(401);
    }
    await request(app).post('/api/users/login').send({ identifier: 'משתמש נעילה', password: PASSWORD }).expect(429);
    await request(app).post('/api/users/login').send({ identifier: email, password: PASSWORD }).expect(429);
  });

  it('logs in a pre-migration account by name and backfills its nameKey; ambiguous legacy names are refused', async () => {
    const legacyEmail = `legacy-${Date.now()}@example.com`;
    const legacy = await User.create({ name: 'משתמש ישן', email: legacyEmail, password: PASSWORD });
    await User.collection.updateOne({ _id: legacy._id }, { $unset: { nameKey: 1 } });
    const login = await request(app).post('/api/users/login').send({ identifier: ' משתמש   ישן ', password: PASSWORD }).expect(200);
    expect(login.body.email).toBe(legacyEmail);
    expect((await User.findById(legacy._id)).nameKey).toBe('משתמש ישן');

    // Two legacy accounts sharing one name: name login refuses, email works.
    const n = `כפול ${Date.now()}`;
    const a = await User.create({ name: n, email: `dupa-${Date.now()}@example.com`, password: PASSWORD });
    const b = await User.create({ name: `zz-${Date.now()}`, email: `dupb-${Date.now()}@example.com`, password: PASSWORD });
    // Direct collection writes simulate pre-migration rows: same name, no nameKey.
    await User.collection.updateOne({ _id: b._id }, { $set: { name: n } });
    await User.collection.updateMany({ _id: { $in: [a._id, b._id] } }, { $unset: { nameKey: 1 } });
    const refused = await request(app).post('/api/users/login').send({ identifier: n, password: PASSWORD }).expect(400);
    expect(refused.body.message).toBe('השם משויך ליותר מחשבון אחד. התחברו עם כתובת הדוא״ל.');
    await request(app).post('/api/users/login').send({ identifier: a.email, password: PASSWORD }).expect(200);
  });
});
