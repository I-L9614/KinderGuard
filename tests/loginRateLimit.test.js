import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// The login limiter trips before validation or any DB work, so this suite
// needs no database: invalid-email bodies fail fast (400) while still
// counting against the limit, and the request after the cap gets a 429.
let app;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/not-used';
  process.env.LOGIN_RATE_LIMIT_MAX = '3';
  ({ default: app } = await import('../src/app.js'));
});

describe('Login rate limiting', () => {
  it('returns 429 after the configured number of login attempts', async () => {
    const attempt = () => request(app).post('/api/users/login').send({ email: 'not-an-email', password: 'x' });
    await attempt().expect(400);
    await attempt().expect(400);
    await attempt().expect(400);
    const blocked = await attempt().expect(429);
    expect(blocked.body.message).toContain('יותר מדי ניסיונות');
  });
});
