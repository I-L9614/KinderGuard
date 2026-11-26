import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
// Real entry (src/app.js), not a test-local mount.
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(async () => 'rent/k'), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn(async () => ({})) }));
let mongoServer; let User; let jwt; let app;
const tok = (u) => jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret'; delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_ENABLED;
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server'); process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  process.env.MONGO_URI = mongoServer.getUri(); await mongoose.connect(mongoServer.getUri());
  User = (await import('../src/models/User.js')).default; jwt = (await import('jsonwebtoken')).default;
  app = (await import('../src/app.js')).default;
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });
const mk = (extra) => User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `e-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
describe('AI router mounted on the real app entry', () => {
  it('requires a login, and an AI-enabled flag, on every AI route', async () => {
    const plain = await mk({});
    for (const [m, p] of [['post', '/api/ai/ask'], ['post', '/api/ai/tasks/propose'], ['post', '/api/ai/agreements/document/propose'], ['post', '/api/ai/agreements/document/delete-propose']]) {
      expect((await request(app)[m](p).send({})).status).toBe(401);
      expect((await request(app)[m](p).set('Authorization', `Bearer ${tok(plain)}`).send({ prompt: 'x' })).status).toBe(403);
    }
  });
  it('without ANTHROPIC_API_KEY an enabled user gets 503 on model calls and no provider request is made', async () => {
    const u = await mk({ aiEnabled: true }); const f = vi.spyOn(globalThis, 'fetch');
    const r = await request(app).post('/api/ai/ask').set('Authorization', `Bearer ${tok(u)}`).send({ prompt: 'שלום' });
    expect(r.status).toBe(503); expect(f).not.toHaveBeenCalled(); f.mockRestore();
  });
  it('model-free routes work without a key for an enabled user (validation reached)', async () => {
    const u = await mk({ aiEnabled: true });
    expect((await request(app).post('/api/ai/agreements/document/delete-propose').set('Authorization', `Bearer ${tok(u)}`).send({ agreementId: 'bad', docId: 'bad' })).status).toBe(400);
  });
});
