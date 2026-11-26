import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

let app; let mongoServer; let User; let AiProposal; let ask; let saved;
const NAMES = ['אישור בטיחות'];
const pdf = (n) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40, n)]);
const mk = async (aiEnabled = true) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `x-${Math.random().toString(36).slice(2)}`, email: `a-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', aiEnabled });
  return jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
};
beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server'); process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js')); ({ default: AiProposal } = await import('../src/models/AiProposal.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js'); const { documentUpload } = await import('../src/middleware/upload.js');
  const { protect } = await import('../src/middleware/authMiddleware.js'); const { licenseProposalGuard } = await import('../src/ai/licenseProposalGuard.js');
  ask = vi.fn(async () => ({ text: '{"licenseType":"אישור בטיחות","issueDate":"2026-01-01","expiryDate":"2027-01-01"}', costUsd: 0 })); saved = 0;
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
  // stand-in for POST /api/licenses: same middleware order as licenseRoutes (protect, upload, guard), then a save
  app.post('/save', protect, documentUpload.single('file'), licenseProposalGuard, (req, res) => { if (req.body.fail) return res.status(500).json({}); saved += 1; res.status(201).json({}); });
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const read = (t, file) => request(app).post('/api/ai/license-extract').set('Authorization', `Bearer ${t}`).field('consentExternal', 'true').field('typeNames', JSON.stringify(NAMES)).attach('file', file, { filename: 'a.pdf', contentType: 'application/pdf' });
const save = (t, file, f = {}) => { let r = request(app).post('/save').set('Authorization', `Bearer ${t}`); for (const [k, v] of Object.entries(f)) r = r.field(k, v); if (file) r = r.attach('file', file, { filename: 'a.pdf', contentType: 'application/pdf' }); return r; };

describe('AI-assisted license save is server-authorized', () => {
  it('manual saves (no proposal id) are untouched', async () => {
    const t = await mk(false); const before = saved;
    await save(t, pdf(1), { issueDate: '2026-01-01' }).expect(201); expect(saved).toBe(before + 1);
  });
  it('accepts the exact file with confirmation once; audit keeps proposed and final values', async () => {
    const t = await mk(); const file = pdf(2);
    const { body } = await read(t, file).expect(200);
    await save(t, file, { aiProposalId: body.proposalId }).expect(400); // not confirmed
    await save(t, file, { aiProposalId: body.proposalId, aiConfirmed: 'true', expiryDate: '2027-06-01', issueDate: '2026-01-01' }).expect(201);
    const d = await AiProposal.findById(body.proposalId);
    expect(d.status).toBe('done'); expect(d.action.expiryDate).toBe('2027-01-01'); expect(d.final.expiryDate).toBe('2027-06-01');
    await save(t, file, { aiProposalId: body.proposalId, aiConfirmed: 'true' }).expect(409); // replay
    await new Promise((r) => setTimeout(r, 80));
    const AiAudit = (await import('../src/models/AiAudit.js')).default; const au = await AiAudit.find({ proposalId: body.proposalId }).lean();
    expect(au).toHaveLength(1); expect(au[0]).toMatchObject({ type: 'license_fill_save', outcome: 'done' });
  });
  it('status is settled before the response is flushed: no executing state is ever visible after the reply, and a failed save can be retried at once', async () => {
    const t = await mk(); const file = pdf(5);
    for (let i = 0; i < 15; i += 1) {
      const f = pdf(20 + i); const { body } = await read(t, f).expect(200);
      await save(t, f, { aiProposalId: body.proposalId, aiConfirmed: 'true', fail: '1' }).expect(500);
      expect((await AiProposal.findById(body.proposalId)).status).toBe('pending'); // no wait
      await save(t, f, { aiProposalId: body.proposalId, aiConfirmed: 'true' }).expect(201);
      expect((await AiProposal.findById(body.proposalId)).status).toBe('done'); // no wait
    }
    expect(file).toBeTruthy();
  });
  it('refuses a different file, another user, a missing file, and an expired proposal', async () => {
    const t = await mk(); const other = await mk(); const file = pdf(3);
    const { body } = await read(t, file).expect(200); const f = { aiProposalId: body.proposalId, aiConfirmed: 'true' };
    await save(t, pdf(9), f).expect(409);
    await save(other, file, f).expect(409);
    await save(t, null, f).expect(400);
    await AiProposal.updateOne({ _id: body.proposalId }, { expiresAt: new Date(Date.now() - 1000) });
    await save(t, file, f).expect(409);
  });
  it('audit label is the account\'s own branch name from the server; a foreign or invalid branch id gives a blank label', async () => {
    const jwt = (await import('jsonwebtoken')).default; const Branch = (await import('../src/models/Branch.js')).default; const AiAudit = (await import('../src/models/AiAudit.js')).default;
    const mkU = async () => User.create({ name: `y-${Math.random().toString(36).slice(2)}`, email: `y-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', aiEnabled: true });
    const a = await mkU(); const o = await mkU(); const mine = await Branch.create({ adminId: a._id, name: 'גן התווית' }); const theirs = await Branch.create({ adminId: o._id, name: 'גן זר' });
    const t = jwt.sign({ id: a._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    for (const [n, bid, want] of [[11, String(mine._id), 'גן התווית'], [12, String(theirs._id), ''], [13, 'not-an-id', '']]) {
      const file = pdf(n); const { body } = await read(t, file).expect(200);
      await save(t, file, { aiProposalId: body.proposalId, aiConfirmed: 'true', branchId: bid }).expect(201); await new Promise((r) => setTimeout(r, 120));
      const au = await AiAudit.findOne({ proposalId: body.proposalId }).lean(); expect(au.label).toBe(want); expect(au.outcome).toBe('done');
    }
  });
  it('the license-extract model call is counted in the per-user usage view', async () => {
    const Usage = (await import('../src/models/AiUserUsage.js')).default; const jwt = (await import('jsonwebtoken')).default;
    const u = await User.create({ name: `z-${Math.random().toString(36).slice(2)}`, email: `z-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin', aiEnabled: true }); const t = jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    await read(t, pdf(21)).expect(200); await new Promise((r) => setTimeout(r, 100)); expect((await Usage.find({ userId: u._id }).lean()).reduce((n, x) => n + x.attempts, 0)).toBe(1);
  });
  it('a failed save releases the proposal so the user can retry', async () => {
    const t = await mk(); const file = pdf(4);
    const { body } = await read(t, file).expect(200); const f = { aiProposalId: body.proposalId, aiConfirmed: 'true' };
    await save(t, file, { ...f, fail: '1' }).expect(500); await new Promise((r) => setTimeout(r, 50));
    const AiAudit = (await import('../src/models/AiAudit.js')).default; expect(await AiAudit.countDocuments({ proposalId: body.proposalId, outcome: 'failed' })).toBe(1);
    await save(t, file, f).expect(201);
  });
  it('a user without AI access cannot use a proposal id', async () => {
    const t = await mk(false);
    await save(t, pdf(5), { aiProposalId: '507f1f77bcf86cd799439011', aiConfirmed: 'true' }).expect(403);
  });
});
