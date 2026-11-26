import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
vi.mock('../src/services/s3Service.js', () => ({ uploadFileToS3: vi.fn(async () => 'rent/test-key.pdf'), downloadFileFromS3: vi.fn(), deleteFileFromS3: vi.fn(async () => ({})) }));
import { buildDocumentCandidates, markIdenticalDocuments } from '../src/ai/documentActions.js';

let app; let mongoServer; let User; let Branch; let Authority; let RentAgreement; let ask;
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
  ({ default: User } = await import('../src/models/User.js')); ({ default: Branch } = await import('../src/models/Branch.js')); ({ default: Authority } = await import('../src/models/Authority.js')); ({ default: RentAgreement } = await import('../src/models/RentAgreement.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"summary":"","actions":[]}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes); const { errorHandler } = await import('../src/middleware/errorMiddleware.js'); app.use(errorHandler);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const PDF2 = Buffer.from('%PDF-1.4\n2 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
describe('document candidates', () => {
  it('a filename match is only a hint, never a selection; same-name document is flagged', () => {
    const c = buildDocumentCandidates('חוזה גן הדוגמה.pdf', [{ _id: 'a1', branchName: 'גן הדוגמה', authorityName: 'עיר', updatedAt: new Date(), documents: [{ fileName: 'חוזה גן הדוגמה.pdf' }] }, { _id: 'a2', branchName: 'גן אחר', authorityName: 'עיר', updatedAt: new Date(), documents: [] }]);
    expect(c[0]).toMatchObject({ suggested: true, sameName: true }); expect(c[1]).toMatchObject({ suggested: false, sameName: false });
  });
});
describe('content-hash duplicate detection', () => {
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  it('a stored hash settles it, a same-named unhashed file is hashed from storage, a different-named unhashed file is now hashed too', async () => {
    const same = Buffer.from('AAA'); const other = Buffer.from('BBB'); const s = sha(same);
    const ag = [{ _id: 'a1', documents: [{ fileName: 'x.pdf', sha256: s, key: 'k1' }] }, { _id: 'a2', documents: [{ fileName: 'חוזה.pdf', key: 'k2' }] }, { _id: 'a3', documents: [{ fileName: 'חוזה.pdf', key: 'k3' }] }, { _id: 'a4', documents: [{ fileName: 'אחר.pdf', key: 'k2' }] }, { _id: 'a5', documents: [{ fileName: 'חוזה.pdf', key: 'bad' }] }];
    const cands = ag.map((a) => ({ id: a._id, __f: 'חוזה pdf' }));
    const reader = async (k) => { if (k === 'k2') return same; if (k === 'k3') return other; throw new Error('missing'); };
    const r = await markIdenticalDocuments(s, ag, cands, reader);
    expect(r.map((c) => [c.id, c.identical, c.identicalUnchecked])).toEqual([['a1', true, false], ['a2', true, false], ['a3', false, false], ['a4', true, false], ['a5', false, true]]);
    expect(r.every((c) => c.__f === undefined)).toBe(true);
  });
  it('a stored file with neither hash nor storage key is reported as unchecked, not as different', async () => {
    const r = await markIdenticalDocuments(sha(Buffer.from('AAA')), [{ _id: 'a1', documents: [{ fileName: 'ישן.pdf' }] }, { _id: 'a2', documents: [] }], [{ id: 'a1', __f: 'x' }, { id: 'a2', __f: 'x' }], async () => Buffer.from('x'));
    expect(r.map((c) => [c.id, c.identical, c.identicalUnchecked])).toEqual([['a1', false, true], ['a2', false, false]]);
  });
  it('beyond the read budget the leftover unhashed files are reported as unchecked, never as different', async () => {
    const s = sha(Buffer.from('AAA')); let reads = 0;
    const ag = [{ _id: 'a1', documents: Array.from({ length: 9 }, (_, i) => ({ fileName: `f${i}.pdf`, key: `k${i}` })) }];
    const r = await markIdenticalDocuments(s, ag, [{ id: 'a1', __f: 'zzz' }], async () => { reads += 1; return Buffer.from('BBB'); });
    expect(reads).toBe(6); expect(r[0]).toMatchObject({ identical: false, identicalUnchecked: true });
  });
});
describe('agreement document intake', () => {
  it('the AI upload records the content hash, so the same bytes are flagged next time', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a = await mkAgr(u);
    const p1 = (await propose(t, PDF2, 'z.pdf').expect(200)).body; expect(p1.candidates.find((c) => c.id === String(a._id)).identical).toBe(false);
    await confirm(t, p1.proposalId, PDF2, String(a._id)).expect(200);
    const saved = await RentAgreement.findById(a._id); expect(saved.documents[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    const p2 = (await propose(t, PDF2, 'renamed.pdf').expect(200)).body; expect(p2.candidates.find((c) => c.id === String(a._id)).identical).toBe(true);
    const p3 = (await propose(t, PDF, 'z.pdf').expect(200)).body; expect(p3.candidates.find((c) => c.id === String(a._id)).identical).toBe(false);
  });
  const mkAgr = async (u, extra = {}) => { const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` }); const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) }).catch(async () => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}` })); return RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra }); };
  const propose = (t, buf = PDF, name = 'חוזה.pdf') => request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).attach('file', buf, { filename: name, contentType: 'application/pdf' });
  const confirm = (t, id, buf, agreementId) => { const r = request(app).post(`/api/ai/agreements/document/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (agreementId) r.field('agreementId', agreementId); return r.attach('file', buf, { filename: 'חוזה.pdf', contentType: 'application/pdf' }); };
  it('prefer only preselects an own active agreement; nothing is saved and a foreign or bogus id marks nothing', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a1 = await mkAgr(u); const a2 = await mkAgr(u); const o = await mk({ aiEnabled: true }); const foreign = await mkAgr(o.u);
    const pr = (id) => request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).field('prefer', id).attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    const p = (await pr(String(a2._id)).expect(200)).body; expect(p.candidates.filter((c) => c.preferred).map((c) => c.id)).toEqual([String(a2._id)]);
    expect((await pr(String(foreign._id)).expect(200)).body.candidates.some((c) => c.preferred)).toBe(false);
    expect((await pr('zzz').expect(200)).body.candidates.some((c) => c.preferred)).toBe(false);
    expect((await RentAgreement.findById(a2._id)).documents).toHaveLength(0); expect((await RentAgreement.findById(a1._id)).documents).toHaveLength(0);
  });
  it('proposes without any model call and saves nothing; needs an explicit destination; saves to exactly that agreement', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a1 = await mkAgr(u); const a2 = await mkAgr(u);
    ask.mockClear();
    const p = (await propose(t).expect(200)).body;
    expect(ask).not.toHaveBeenCalled(); expect(p.candidates.length).toBeGreaterThanOrEqual(2);
    expect((await RentAgreement.findById(a1._id)).documents).toHaveLength(0);
    await confirm(t, p.proposalId, PDF).expect(400);
    await confirm(t, p.proposalId, PDF, String(new mongoose.Types.ObjectId())).expect(400);
    const ok = (await confirm(t, p.proposalId, PDF, String(a2._id)).expect(200)).body;
    expect(ok.status).toBe('done');
    expect((await RentAgreement.findById(a2._id)).documents).toHaveLength(1); expect((await RentAgreement.findById(a1._id)).documents).toHaveLength(0);
    const again = (await confirm(t, p.proposalId, PDF, String(a2._id)).expect(200)).body; expect(again.duplicate).toBe(true);
    await new Promise((r) => setTimeout(r, 80)); const AiAudit = (await import('../src/models/AiAudit.js')).default; const au = await AiAudit.find({ proposalId: p.proposalId }).lean();
    expect(au).toHaveLength(1); expect(au[0]).toMatchObject({ type: 'upload_agreement_document', outcome: 'done' }); expect(au[0].label).toBe(ok.result.fileName);
    expect((await RentAgreement.findById(a2._id)).documents).toHaveLength(1);
  });
  it('a different file, a changed agreement, and parallel confirms never save twice or to the wrong place', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a = await mkAgr(u);
    const p = (await propose(t).expect(200)).body;
    await confirm(t, p.proposalId, PDF2, String(a._id)).expect(400);
    await RentAgreement.updateOne({ _id: a._id }, { $set: { paymentMethod: 'cheque' } }, { timestamps: true });
    await confirm(t, p.proposalId, PDF, String(a._id)).expect(409);
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(0);
    const p2 = (await propose(t).expect(200)).body;
    const rs = await Promise.all([confirm(t, p2.proposalId, PDF, String(a._id)), confirm(t, p2.proposalId, PDF, String(a._id))]);
    expect(rs.filter((r) => r.status === 200 && r.body.duplicate === false)).toHaveLength(1);
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(1);
  });
  it('managers, non-AI users, bad files and other accounts are refused', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); await mkAgr(u);
    const other = await mk({ aiEnabled: true, password: 'Password123' }); const p = (await propose(t).expect(200)).body;
    await confirm(other.t, p.proposalId, PDF, '').expect(404);
    await propose((await mk({ aiEnabled: false })).t).expect(403);
    await propose((await mk({ aiEnabled: true, role: 'Manager' })).t).expect(403);
    await request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).attach('file', Buffer.from('not a pdf'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(400);
  });
  it('upload validation parity with the manual route: 15MB limit (413), only PDF/images, content must match the declared type, nothing stored', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a = await mkAgr(u);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(15 * 1024 * 1024 + 10)]);
    await propose(t, big).expect(413);
    await request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).attach('file', Buffer.from('MZ'), { filename: 'a.exe', contentType: 'application/x-msdownload' }).expect(400);
    await request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).attach('file', Buffer.from('<script>'), { filename: 'a.png', contentType: 'image/png' }).expect(400);
    const p = (await propose(t).expect(200)).body;
    await request(app).post(`/api/ai/agreements/document/${p.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).field('agreementId', String(a._id)).attach('file', Buffer.from('<script>'), { filename: 'a.png', contentType: 'image/png' }).expect(400);
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(0);
  });
  it('never replaces: each saved file is added as its own document record (existing documents are never replaced or removed)', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a = await mkAgr(u);
    for (let i = 0; i < 2; i += 1) { const p = (await propose(t, PDF, 'same.pdf').expect(200)).body; await confirm(t, p.proposalId, PDF, String(a._id)).expect(200); }
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(2);
  });
  const sconfirm = (t, id, withGrant = true) => { const pr = (async () => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await (await import('../src/models/AiProposal.js')).default.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); })(); return { result: pr, expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
  const delPropose = (t, agreementId, docId) => request(app).post('/api/ai/agreements/document/delete-propose').set('Authorization', `Bearer ${t}`).send({ agreementId, docId });
  it('delete: built from the explicit pick, sensitive (needs the step-up grant), deletes once, stale version refused, wrong ids refused', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const a = await mkAgr(u);
    for (const n of ['one.pdf', 'two.pdf']) { const p = (await propose(t, PDF, n).expect(200)).body; await confirm(t, p.proposalId, PDF, String(a._id)).expect(200); }
    let cur = await RentAgreement.findById(a._id); expect(cur.documents).toHaveLength(2);
    const target = cur.documents[0];
    await delPropose(t, String(a._id), String(new mongoose.Types.ObjectId())).expect(404);
    await delPropose(t, 'bad', 'bad').expect(400);
    ask.mockClear();
    const r = (await delPropose(t, String(a._id), String(target._id)).expect(200)).body; const act = r.actions[0];
    expect(ask).not.toHaveBeenCalled(); expect(act).toMatchObject({ type: 'delete_agreement_document', sensitive: true, fileName: target.fileName });
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(2);
    await sconfirm(t, act.proposalId, false).expect(403);
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(2);
    await sconfirm(t, act.proposalId).expect(200);
    cur = await RentAgreement.findById(a._id); expect(cur.documents).toHaveLength(1); expect(String(cur.documents[0]._id)).not.toBe(String(target._id));
    const keep = cur.documents[0];
    const r2 = (await delPropose(t, String(a._id), String(keep._id)).expect(200)).body;
    await RentAgreement.updateOne({ _id: a._id }, { $set: { paymentMethod: 'cheque' } }, { timestamps: true });
    await sconfirm(t, r2.actions[0].proposalId).expect(409);
    expect((await RentAgreement.findById(a._id)).documents).toHaveLength(1);
    const other = await mk({ aiEnabled: true, password: 'Password123' });
    await delPropose(other.t, String(a._id), String(keep._id)).expect(404);
  });
  it('the model can never propose a document deletion', async () => {
    const { sanitizeAgreementActions } = await import('../src/ai/agreementActions.js');
    const r = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'delete_agreement_document', agreementId: 'x', docId: 'y' }] }), [{ _id: 'x', branchName: 'b', authorityName: 'a', updatedAt: new Date() }]);
    expect(r.actions).toHaveLength(0);
  });
});
