import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let Branch; let ask;
const mk = async (extra) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `r-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', ...extra });
  return { u, t: jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }) };
};
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const up = (t, buf, name) => request(app).post('/api/ai/team/file-propose').set('Authorization', `Bearer ${t}`).attach('file', buf, name);
describe('POST /api/ai/team/file-propose', () => {
  it('Admin csv creates sensitive create_user proposals; confirm without a step-up grant is refused and no user exists; no model call', async () => {
    const { u, t } = await mk({ aiEnabled: true }); await Branch.create({ adminId: u._id, name: 'גן שקד' }); ask.mockClear();
    const r = await up(t, Buffer.from('שם,אימייל,סניפים\nדנה,dana-new@e.com,גן שקד\nרות,bad,\n', 'utf8'), 'u.csv').expect(200);
    expect(r.body.actions).toHaveLength(1); expect(r.body.actions[0]).toMatchObject({ type: 'create_user', sensitive: true, email: 'dana-new@e.com' }); expect(r.body.costUsd).toBe(0); expect(ask).not.toHaveBeenCalled();
    const c = await request(app).post(`/api/ai/proposals/${r.body.actions[0].proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ password: 'Password123', role: 'Manager' });
    expect(c.status).toBe(403); expect(c.body.message).toMatch(/אימות נוסף/); expect(await User.countDocuments({ email: 'dana-new@e.com' })).toBe(0);
  });
  it('a Manager, a user without AI access, and pdf/xls files are refused', async () => {
    const jwt = (await import('jsonwebtoken')).default; const { u, t } = await mk({ aiEnabled: true });
    const m = await User.create({ name: 'mg', email: `m-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Manager', adminId: u._id, aiEnabled: true });
    await up(jwt.sign({ id: m._id }, process.env.JWT_SECRET, { algorithm: 'HS256' }), Buffer.from('שם,אימייל\nx,x@e.com', 'utf8'), 'u.csv').expect(403);
    await up((await mk({ aiEnabled: false })).t, Buffer.from('שם,אימייל\nx,x@e.com', 'utf8'), 'u.csv').expect(403);
    ask.mockClear(); for (const n of ['a.pdf', 'a.xls']) await up(t, Buffer.from('%PDF-1.4\n'), n).expect(400); expect(ask).not.toHaveBeenCalled();
  });
});
