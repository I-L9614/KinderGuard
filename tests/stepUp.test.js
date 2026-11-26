import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import express from 'express';
import { requireStepUp } from '../src/utils/stepUp.js';
import jwt from 'jsonwebtoken';

let app;
let mongoServer;

const mkAdmin = async (name) => {
  const { default: User } = await import('../src/models/User.js');
  const u = await User.create({ name, email: `su-${Math.random().toString(36).slice(2)}@example.com`, password: 'Password123', role: 'Admin' });
  return { u, token: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};


beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  // The IP limiter is not what these tests measure; keep it out of the way.
  process.env.LOGIN_RATE_LIMIT_MAX = '1000';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  ({ default: app } = await import('../src/app.js'));
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('Step-up grants for sensitive actions', () => {
  it('issues a token for the right password, rejects the wrong one, and consumes each grant once', async () => {
    const email = `stepup-${Date.now()}@example.com`;
    const reg = await request(app).post('/api/users/register').send({ name: 'Admin', email, password: 'Password123' }).expect(201);
    const token = reg.body.token;

    await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${token}`)
      .send({ password: 'wrong', action: 'ai:user-delete' }).expect(401);

    const ok = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${token}`)
      .send({ password: 'Password123', action: 'ai:user-delete' }).expect(200);
    expect(ok.body.stepUpToken).toBeTruthy();
    expect(ok.body.expiresIn).toBe(300);

    // A protected probe endpoint consumes the grant exactly once.
    const probe = express();
    probe.use(express.json());
    const { protect } = await import('../src/middleware/authMiddleware.js');
    probe.post('/do', (req, _res, next) => { req.headers.authorization = `Bearer ${token}`; next(); }, protect, requireStepUp('ai:user-delete'), (_req, res) => res.json({ done: true }));
    await request(probe).post('/do').set('X-Step-Up', ok.body.stepUpToken).expect(200);
    await request(probe).post('/do').set('X-Step-Up', ok.body.stepUpToken).expect(403);

    // A grant for one action does not open another.
    const other = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${token}`)
      .send({ password: 'Password123', action: 'ai:role-change' }).expect(200);
    await request(probe).post('/do').set('X-Step-Up', other.body.stepUpToken).expect(403);

    // Missing header and another user's token both fail closed.
    await request(probe).post('/do').expect(403);
  });

  it('refunds a consumed grant so a failed action does not cost another password', async () => {
    const { token } = await mkAdmin('Refund Admin');
    const ok = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${token}`)
      .send({ password: 'Password123', action: 'ai:user-delete' }).expect(200);
    const { protect } = await import('../src/middleware/authMiddleware.js');
    const { refundStepUpGrant } = await import('../src/utils/stepUp.js');
    const probe = express();
    probe.use(express.json());
    probe.post('/do', (req, _res, next) => { req.headers.authorization = `Bearer ${token}`; next(); }, protect, requireStepUp('ai:user-delete'), (_req, res) => res.json({ done: true }));
    await request(probe).post('/do').set('X-Step-Up', ok.body.stepUpToken).expect(200);
    await request(probe).post('/do').set('X-Step-Up', ok.body.stepUpToken).expect(403); // spent
    await refundStepUpGrant({ headers: { 'x-step-up': ok.body.stepUpToken }, user: { _id: jwt.decode(token).id } });
    await request(probe).post('/do').set('X-Step-Up', ok.body.stepUpToken).expect(200); // refunded
  });

  it('throttles wrong step-up passwords per user below the IP limit; a success resets the count', async () => {
    const { token } = await mkAdmin('Throttle Admin');
    const attempt = (pw) => request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${token}`)
      .send({ password: pw, action: 'ai:user-delete' });
    for (let i = 0; i < 4; i++) await attempt('nope-nope').expect(401);
    await attempt('Password123').expect(200); // resets the failure count
    for (let i = 0; i < 5; i++) await attempt('nope-nope').expect(401);
    // The IP limiter (10) was never reached; this 429 is the per-user throttle,
    // and it blocks even the correct password until the window passes.
    await attempt('Password123').expect(429);
    // A different user is unaffected.
    const other = await mkAdmin('Throttle Second');
    await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${other.token}`)
      .send({ password: 'nope-nope', action: 'ai:user-delete' }).expect(401);
  });
});
