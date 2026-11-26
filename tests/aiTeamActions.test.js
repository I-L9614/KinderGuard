import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeTeamActions } from '../src/ai/teamActions.js';

const B = [{ _id: 'b1', name: 'גן א' }];
describe('sanitizeTeamActions', () => {
  it('keeps only name, email, suggested role and own branches; no password or aiEnabled', () => {
    const r = sanitizeTeamActions(JSON.stringify({ actions: [{ type: 'create_user', name: ' דנה ', email: 'Dana@Example.com', role: 'Admin', branchIds: ['b1', 'zz'], password: 'x', aiEnabled: true }, { type: 'create_user', name: 'שניה', email: 'y@e.com' }] }), B);
    expect(r.actions).toHaveLength(1); expect(r.actions[0]).toMatchObject({ name: 'דנה', email: 'dana@example.com', suggestedRole: 'Admin', branchIds: ['b1'] });
    expect(JSON.stringify(r.actions[0])).not.toContain('"password"'); expect(r.actions[0].aiEnabled).toBeUndefined();
  });
  it('rejects bad email, missing name and other types', () => {
    expect(sanitizeTeamActions(JSON.stringify({ actions: [{ type: 'create_user', name: 'א', email: 'nope' }, { type: 'delete_user', name: 'א', email: 'a@b.co' }] }), B).actions).toHaveLength(0);
  });
});

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
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('create_user end to end', () => {
  const prop = (t, a) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/team/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'הוסף את דנה dana@example.com' }); };
  const confirm = (t, id, extra, withGrant = true) => { const pr = confirmRaw(t, id, extra, withGrant); return { expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
  const confirmRaw = async (t, id, extra, withGrant = true) => {
    const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`);
    if (withGrant) { const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_user', scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); }
    return rq.send(extra);
  };
  it('proposal creates nothing and never contains a password; confirm needs the step-up grant and the card choices', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const b = await Branch.create({ adminId: u._id, name: 'גן א' });
    const r = (await prop(t, { type: 'create_user', name: 'דנה כהן', email: `d-${Date.now()}@example.com`, role: 'Manager', branchIds: [String(b._id)] }).expect(200)).body;
    const a = r.actions[0]; expect(await User.countDocuments({ adminId: u._id })).toBe(0);
    expect(ask.mock.calls.at(-1)[0].prompt).not.toMatch(/password|סיסמה ראשונית/i);
    await confirm(t, a.proposalId, { newUserPassword: 'Str0ng-pass-99', newUserRole: 'Manager' }, false).expect(403);
    expect(await User.countDocuments({ adminId: u._id })).toBe(0);
    await confirm(t, a.proposalId, { newUserRole: 'Manager' }).expect(400); // no password
    await confirm(t, a.proposalId, { newUserPassword: 'short', newUserRole: 'Manager' }).expect(400);
    await confirm(t, a.proposalId, { newUserPassword: 'Str0ng-pass-99', newUserRole: 'Manager' }).expect(200);
    const nu = await User.findOne({ email: a.email });
    expect(nu.role).toBe('Manager'); expect(nu.aiEnabled).toBe(false); expect(String(nu.adminId)).toBe(String(u._id)); expect(nu.accessibleBranches.map(String)).toEqual([String(b._id)]);
    const AiProposal = (await import('../src/models/AiProposal.js')).default; const stored = JSON.stringify(await AiProposal.findById(a.proposalId).lean());
    expect(stored).not.toContain('Str0ng-pass-99');
  });
  it('the Admin explicit AI checkbox and role choice are honored, defaults are off', async () => {
    const { t } = await mk({ aiEnabled: true, password: 'Password123' });
    const r = (await prop(t, { type: 'create_user', name: 'יוסי לוי', email: `y-${Date.now()}@example.com`, role: 'Manager', branchIds: [] }).expect(200)).body;
    await confirm(t, r.actions[0].proposalId, { newUserPassword: 'Str0ng-pass-99', newUserRole: 'Admin', newUserAiEnabled: true }).expect(200);
    const nu = await User.findOne({ email: r.actions[0].email }); expect(nu.role).toBe('Admin'); expect(nu.aiEnabled).toBe(true);
  });
  it('a duplicate email is refused and nothing is created; managers cannot propose', async () => {
    const { t } = await mk({ aiEnabled: true, password: 'Password123' }); const e = `dup-${Date.now()}@example.com`;
    await mk({ email: e });
    const r = (await prop(t, { type: 'create_user', name: 'כפול כפול', email: e, role: 'Manager', branchIds: [] }).expect(200)).body;
    await confirm(t, r.actions[0].proposalId, { newUserPassword: 'Str0ng-pass-99', newUserRole: 'Manager' }).expect(400);
    const m = await mk({ aiEnabled: true, role: 'Manager' });
    await request(app).post('/api/ai/team/propose').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(403);
  });
});
