import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let ask;
const tokenFor = async (aiEnabled) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `x-${Math.random().toString(36).slice(2)}`, email: `a-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Manager', aiEnabled });
  return jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: 'ok', usage: {}, costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('POST /api/ai/ask', () => {
  it('401 without login, 403 without aiEnabled, model never called', async () => {
    await request(app).post('/api/ai/ask').send({ prompt: 'hi' }).expect(401);
    const t = await tokenFor(false);
    await request(app).post('/api/ai/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'hi' }).expect(403);
    expect(ask).not.toHaveBeenCalled();
  });
  it('works for an enabled user and validates input', async () => {
    const t = await tokenFor(true);
    const r = await request(app).post('/api/ai/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'hi' }).expect(200);
    expect(r.body.text).toBe('ok');
    await request(app).post('/api/ai/ask').set('Authorization', `Bearer ${t}`).send({ prompt: '' }).expect(400);
  });
});
