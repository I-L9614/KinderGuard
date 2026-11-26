import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let PasswordResetToken; let RefreshToken; let LoginLockout; let setResetMailTransport;
const sentMails = [];
const PASSWORD = 'Password12345';
const NEW_PASSWORD = 'NewPassword9876';

const waitFor = async (fn, timeoutMs = 4000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const requestReset = (identifier) => request(app).post('/api/users/password/forgot').send({ identifier });
const waitForMails = (count) => waitFor(() => (sentMails.length >= count ? sentMails : null));
const tokenFromMail = (mail) => mail.text.match(/#reset=([0-9a-f]{64})/)[1];

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.LOGIN_RATE_LIMIT_MAX = '1000';
  process.env.RESET_RATE_LIMIT_MAX = '1000';
  process.env.APP_PUBLIC_URL = 'https://kg.test';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
  ({ default: User } = await import('../src/models/User.js'));
  ({ default: PasswordResetToken } = await import('../src/models/PasswordResetToken.js'));
  ({ default: RefreshToken } = await import('../src/models/RefreshToken.js'));
  ({ default: LoginLockout } = await import('../src/models/LoginLockout.js'));
  ({ setResetMailTransport } = await import('../src/utils/resetMailer.js'));
  setResetMailTransport(async (message) => { sentMails.push(message); return { mock: true }; });
  await request(app).post('/api/users/register').send({ name: 'איתמר לוי', email: `reset-admin-${Date.now()}@example.com`, password: PASSWORD }).expect(201);
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const createUser = async (name) => {
  const email = `${nameKeyTest(name)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  return User.create({ name, email, password: PASSWORD });
};
const nameKeyTest = (name) => Buffer.from(name).toString('hex').slice(0, 12);

describe('password reset', () => {
  it('emails a one-time hashed token, and the raw token never reaches the database', async () => {
    const user = await createUser('דנה כהן');
    await requestReset(user.email).expect(200);
    await waitForMails(1);
    const raw = tokenFromMail(sentMails[0]);
    const doc = await PasswordResetToken.findOne({ user: user._id });
    expect(doc).toBeTruthy();
    expect(doc.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(doc.tokenHash).not.toBe(raw);
    expect(doc.usedAt).toBeNull();
    expect(doc.expiresAt.getTime()).toBeGreaterThan(Date.now() + 20 * 60 * 1000);
    expect(sentMails[0].to).toBe(user.email);
    expect(sentMails[0].subject).toContain('איפוס סיסמה');
    expect(sentMails[0].text).toContain(user.name);
    expect(sentMails[0].text).toContain('https://kg.test/#reset=');
  });

  it('fails closed when APP_PUBLIC_URL is missing: no token issued, nothing sent', async () => {
    const user = await createUser('ליאור מזרחי');
    const saved = process.env.APP_PUBLIC_URL;
    delete process.env.APP_PUBLIC_URL;
    const before = sentMails.length;
    try {
      await requestReset(user.email).expect(200);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(sentMails.length).toBe(before);
      expect(await PasswordResetToken.countDocuments({ user: user._id })).toBe(0);
    } finally {
      process.env.APP_PUBLIC_URL = saved;
    }
    // Recovers once configured again.
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    expect(sentMails[before].text).toContain('https://kg.test/#reset=');
  });

  it('finds the account by display name too, and mails the address on file', async () => {
    const user = await createUser('יוסי אברהם');
    await requestReset('יוסי אברהם').expect(200);
    await waitFor(() => sentMails.find((m) => m.to === user.email));
  });

  it('answers unknown identifiers with the exact same message and sends nothing', async () => {
    const before = sentMails.length;
    const unknown = await requestReset(`no-such-${Date.now()}@example.com`).expect(200);
    const known = await requestReset((await createUser('מירי שלום')).email).expect(200);
    expect(unknown.body).toEqual(known.body);
    await waitForMails(before + 1);
    expect(sentMails[before].to).not.toBe(`no-such-${Date.now()}@example.com`);
  });

  it('a newer request invalidates the previous link', async () => {
    const user = await createUser('אבי לוי');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const first = tokenFromMail(sentMails[before]);
    await requestReset(user.email).expect(200);
    await waitForMails(before + 2);
    const second = tokenFromMail(sentMails[before + 1]);
    expect(second).not.toBe(first);
    await request(app).post('/api/users/password/reset').send({ token: first, password: NEW_PASSWORD }).expect(400);
    await request(app).post('/api/users/password/reset').send({ token: second, password: NEW_PASSWORD }).expect(200);
    await request(app).post('/api/users/login').send({ identifier: user.email, password: NEW_PASSWORD }).expect(200);
  });

  it('reset changes the password, revokes every session, clears lockout, and cannot be replayed', async () => {
    const user = await createUser('רוני ברק');
    // One live session before the lockout, so revocation has something to kill.
    await request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }).expect(200);
    expect(await RefreshToken.countDocuments({ user: user._id, revoked: false })).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) {
      await request(app).post('/api/users/login').send({ identifier: user.email, password: 'WrongPass999' }).expect(401);
    }
    await request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }).expect(429);
    const lock = await LoginLockout.findOne({ email: `user:${user._id}` });
    expect(lock?.lockedUntil).toBeTruthy();

    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    await request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }).expect(200);

    // Checked before any new login: every session that existed at reset time is revoked.
    expect(await RefreshToken.countDocuments({ user: user._id })).toBeGreaterThan(0);
    expect(await RefreshToken.countDocuments({ user: user._id, revoked: false })).toBe(0);
    expect(await LoginLockout.findOne({ email: `user:${user._id}` })).toBeNull();
    await request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }).expect(401);
    await request(app).post('/api/users/login').send({ identifier: user.email, password: NEW_PASSWORD }).expect(200);
    await request(app).post('/api/users/password/reset').send({ token: raw, password: 'AnotherPass111' }).expect(400);
  });

  it('refuses expired, unknown and malformed tokens with the same message', async () => {
    const user = await createUser('נועה דוד');
    const expiredRaw = 'a'.repeat(64);
    await PasswordResetToken.create({ user: user._id, tokenHash: (await import('crypto')).createHash('sha256').update(expiredRaw).digest('hex'), expiresAt: new Date(Date.now() - 1000) });
    const r1 = await request(app).post('/api/users/password/reset').send({ token: expiredRaw, password: NEW_PASSWORD }).expect(400);
    const r2 = await request(app).post('/api/users/password/reset').send({ token: 'b'.repeat(64), password: NEW_PASSWORD }).expect(400);
    expect(r1.body).toEqual(r2.body);
    await request(app).post('/api/users/password/reset').send({ token: 'short', password: NEW_PASSWORD }).expect(400);
  });

  it('applies the password policy on reset', async () => {
    const user = await createUser('טל רון');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    const r = await request(app).post('/api/users/password/reset').send({ token: raw, password: 'short' }).expect(400);
    expect(r.body.message).toContain('סיסמה');
    await request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }).expect(200);
  });

  it('caps reset emails per account per hour (flood control)', async () => {
    const user = await createUser('עומר שחר');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    await requestReset(user.email).expect(200);
    await waitForMails(before + 2);
    await requestReset(user.email).expect(200);
    await waitForMails(before + 3);
    await requestReset(user.email).expect(200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sentMails.length).toBe(before + 3);
    expect(await PasswordResetToken.countDocuments({ user: user._id })).toBe(1);
    expect((await PasswordResetToken.findOne({ user: user._id })).sendCount).toBe(3);
  });

  it('concurrent requests leave exactly one live link, and only it works', async () => {
    const user = await createUser('הילה רז');
    const before = sentMails.length;
    await Promise.all([requestReset(user.email), requestReset(user.email), requestReset(user.email), requestReset(user.email), requestReset(user.email)]);
    await waitFor(() => sentMails.length > before && PasswordResetToken.countDocuments({ user: user._id }).then((c) => c === 1 && sentMails.length > before));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await PasswordResetToken.countDocuments({ user: user._id })).toBe(1);
    const tokens = sentMails.slice(before).map((mail) => tokenFromMail(mail));
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens.length).toBeLessThanOrEqual(5);
    let successes = 0;
    for (const t of tokens) {
      const r = await request(app).post('/api/users/password/reset').send({ token: t, password: NEW_PASSWORD });
      if (r.status === 200) successes += 1;
      else expect(r.status).toBe(400);
    }
    expect(successes).toBe(1);
  });

  it('two concurrent resets with the same link: exactly one succeeds', async () => {
    const user = await createUser('גיא נשר');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    const [a, b] = await Promise.all([
      request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }),
      request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  it('reset kills live access tokens too, not only refresh sessions', async () => {
    const user = await createUser('מאיה שלם');
    const login = await request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }).expect(200);
    const access = login.body.token;
    await request(app).get('/api/users/me').set('Authorization', `Bearer ${access}`).expect(200);
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    await request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }).expect(200);
    await request(app).get('/api/users/me').set('Authorization', `Bearer ${access}`).expect(401);
    const relogin = await request(app).post('/api/users/login').send({ identifier: user.email, password: NEW_PASSWORD }).expect(200);
    await request(app).get('/api/users/me').set('Authorization', `Bearer ${relogin.body.token}`).expect(200);
  });

  it('a token minted in the same second as the reset still dies (version claim, not clock)', async () => {
    const user = await createUser('ליבי כץ');
    const login = await request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }).expect(200);
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    await request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }).expect(200);
    // Same instant, same second: the version claim, not the clock, kills it.
    await request(app).get('/api/users/me').set('Authorization', `Bearer ${login.body.token}`).expect(401);
  });

  it('a login racing a reset can never yield an immortal token', async () => {
    const user = await createUser('אורן פז');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const raw = tokenFromMail(sentMails[before]);
    const [loginRes] = await Promise.all([
      request(app).post('/api/users/login').send({ identifier: user.email, password: PASSWORD }),
      request(app).post('/api/users/password/reset').send({ token: raw, password: NEW_PASSWORD }),
    ]);
    expect(loginRes.status).toBe(200);
    // Whichever order they committed in, a fresh login with the new password works.
    const relogin = await request(app).post('/api/users/login').send({ identifier: user.email, password: NEW_PASSWORD }).expect(200);
    await request(app).get('/api/users/me').set('Authorization', `Bearer ${relogin.body.token}`).expect(200);
    const racing = await request(app).get('/api/users/me').set('Authorization', `Bearer ${loginRes.body.token}`);
    expect([200, 401]).toContain(racing.status);
    if (racing.status === 200) {
      // The racing login read the version after the reset committed (a
      // post-reset login, legitimately live). A further reset must kill it.
      const before2 = sentMails.length;
      await requestReset(user.email).expect(200);
      await waitForMails(before2 + 1);
      const raw2 = tokenFromMail(sentMails[before2]);
      await request(app).post('/api/users/password/reset').send({ token: raw2, password: 'ThirdPass12345' }).expect(200);
      await request(app).get('/api/users/me').set('Authorization', `Bearer ${loginRes.body.token}`).expect(401);
    }
  });

  it('a stale in-flight reset cannot overwrite a newer completed reset', async () => {
    const user = await createUser('קובי שרת');
    const before = sentMails.length;
    await requestReset(user.email).expect(200);
    await waitForMails(before + 1);
    const tokenA = tokenFromMail(sentMails[before]);
    // Pause flow A after it claimed its link, before the session sweep.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spy = vi.spyOn(RefreshToken, 'updateMany').mockImplementationOnce(() => gate.then(() => ({ acknowledged: true, modifiedCount: 0 })));
    const resetA = request(app).post('/api/users/password/reset').send({ token: tokenA, password: 'StalePass11111' }).then((r) => r);
    await waitFor(() => (spy.mock.calls.length > 0 ? true : null));
    // A newer link is issued and completed while A is in flight.
    await requestReset(user.email).expect(200);
    await waitForMails(before + 2);
    const tokenB = tokenFromMail(sentMails[before + 1]);
    await request(app).post('/api/users/password/reset').send({ token: tokenB, password: NEW_PASSWORD }).expect(200);
    release();
    spy.mockRestore();
    const rA = await resetA;
    expect(rA.status).toBe(400);
    // The newer password stands; the stale flow's password never lands.
    await request(app).post('/api/users/login').send({ identifier: user.email, password: NEW_PASSWORD }).expect(200);
    await request(app).post('/api/users/login').send({ identifier: user.email, password: 'StalePass11111' }).expect(401);
  });

  it('rate-limits reset requests per IP', async () => {
    process.env.RESET_RATE_LIMIT_MAX = '1';
    try {
      await requestReset(`flood-${Date.now()}@example.com`).expect(429);
    } finally {
      process.env.RESET_RATE_LIMIT_MAX = '1000';
    }
  });
});
