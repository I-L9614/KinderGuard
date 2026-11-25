import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';

// /health is exempt from the global limiter so the hosting probe never gets
// a 429, while other routes stay limited.
let app;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-secret';
  process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/not-used';
  ({ default: app } = await import('../src/app.js'));
});

describe('Global rate limiter and /health', () => {
  it('keeps /health at 200 even after other paths hit the global cap', async () => {
    for (let i = 0; i < 205; i += 1) {
      await request(app).get('/health').expect(200);
    }
    let last;
    for (let i = 0; i < 201; i += 1) last = await request(app).get('/api/nope');
    expect(last.status).toBe(429);
    await request(app).get('/health').expect(200);
  });
});
