import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

// Exact acceptance semantics for per-account lockout:
// - the 5th consecutive failed login establishes a lock that lasts a FULL hour
//   from that 5th failure;
// - while locked, even the correct password is refused with 429;
// - a successful login before the threshold resets the consecutive count;
// - failures older than an hour no longer count;
// - other accounts are unaffected.
let app;
let mongoServer;
let adminToken;
const PASSWORD = 'Password123';
const WRONG = 'WrongPass1';

const makeUser = async (email) => {
  await request(app).post('/api/users').set('Authorization', `Bearer ${adminToken}`).send({ name: 'Lockout User', email, password: PASSWORD }).expect(201);
};
const fail = (email) => request(app).post('/api/users/login').send({ email, password: WRONG });
const succeed = (email) => request(app).post('/api/users/login').send({ email, password: PASSWORD });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_TOKEN_TTL_MS = '2592000000';
  process.env.S3_BUCKET_NAME = 'test-bucket';
  process.env.S3_REGION = 'us-east-1';
  // The per-IP limiter is covered in loginRateLimit.test.js; keep it out of
  // the way so the shared localhost bucket cannot trip these tests.
  process.env.LOGIN_RATE_LIMIT_MAX = '1000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  const admin = await request(app).post('/api/users/register').send({ name: 'Admin', email: `lockout-admin-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
  adminToken = admin.body.token;
}, 600000);

afterAll(async () => {
  vi.useRealTimers();
  await mongoose.disconnect();
  if (mongoServer) await mongoServer.stop();
});

describe('Per-account login lockout', () => {
  it('locks after the 5th failure and blocks even the correct password for a full hour', async () => {
    const email = `victim-${Date.now()}@example.com`;
    await makeUser(email);
    // Failures 1-4: ordinary 401, no lock yet.
    for (let i = 0; i < 4; i++) await fail(email).expect(401);
    await succeed(email).expect(200); // not locked before the threshold
    // A success resets the count, so it takes 5 NEW failures to lock.
    for (let i = 0; i < 4; i++) await fail(email).expect(401);
    await fail(email).expect(401); // 5th consecutive failure establishes the lock
    // While locked, the correct password is refused too.
    const locked = await succeed(email).expect(429);
    expect(locked.body.message).toContain('נחסם לשעה');
    await fail(email).expect(429);
    // 59 minutes later: still locked.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    await succeed(email).expect(429);
    // 61 minutes after the 5th failure: the full hour has passed, login works.
    // (Keep the fake clock on for this check - real time is still inside the hour.)
    vi.setSystemTime(Date.now() + 2 * 60 * 1000 + 1000);
    await succeed(email).expect(200);
    vi.useRealTimers();
  });

  it('does not lock on failures older than an hour', async () => {
    const email = `stale-${Date.now()}@example.com`;
    await makeUser(email);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 4; i++) await fail(email).expect(401);
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    // The 4 old failures expired; a single new failure must not lock. Keep the
    // fake clock on - real time is still inside the same minute as the old ones.
    await fail(email).expect(401);
    await succeed(email).expect(200);
    vi.useRealTimers();
  });

  it('locks accounts independently', async () => {
    const lockedEmail = `locked-${Date.now()}@example.com`;
    const otherEmail = `other-${Date.now()}@example.com`;
    await makeUser(lockedEmail);
    await makeUser(otherEmail);
    for (let i = 0; i < 5; i++) await fail(lockedEmail).expect(401);
    await fail(lockedEmail).expect(429);
    await fail(otherEmail).expect(401);
    await succeed(otherEmail).expect(200);
  });

  it('stays consistent under concurrent attempts', async () => {
    const email = `concurrent-${Date.now()}@example.com`;
    await makeUser(email);
    // Exact threshold under parallelism: 4 parallel failures must NOT lock...
    const below = await Promise.all(Array.from({ length: 4 }, () => fail(email)));
    expect(below.every((res) => res.status === 401)).toBe(true);
    await succeed(email).expect(200); // success resets the count
    // ...and 5 parallel failures after the reset lock exactly at the threshold:
    // every failure itself gets 401, and only the NEXT attempt sees the lock.
    const atThreshold = await Promise.all(Array.from({ length: 5 }, () => fail(email)));
    expect(atThreshold.every((res) => res.status === 401)).toBe(true);
    await succeed(email).expect(429); // locked: correct password refused too
    // Parallel attempts while locked: every one refused, none extends the lock.
    const lockedCodes = await Promise.all([
      ...Array.from({ length: 4 }, () => fail(email)),
      ...Array.from({ length: 4 }, () => succeed(email)),
    ]);
    expect(lockedCodes.every((res) => res.status === 429)).toBe(true);
    // The lock still expires a full hour after the 5th failure, not later:
    // attempts during the lock did not postpone it.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61 * 60 * 1000);
    await succeed(email).expect(200);
    vi.useRealTimers();
  });
});
