import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';

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
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } })); const { default: authRoutes } = await import('../src/routes/authRoutes.js'); app.use('/api/auth', authRoutes);
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('colliding candidate names: grounded metadata, refusal when identical, and drift at commit (own file: step-up limiter)', () => {
  const prop = (t, a, prompt) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${t}`).send({ prompt }); };
  const P = 'צור הסכם שכירות לגן בורר מול עיריית נחל, הרשות משלמת לנו 3000 בחודש בהעברה, פרעון ראשון 1.2.2031';
  const mkFull = (b, p1) => ({ type: 'create_agreement', branchId: String(b._id), authorityId: String(p1._id), monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' });
  const setup = async (b2extra, b1extra = { address: 'הרצל 1' }) => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' });
    const b1 = await Branch.create({ adminId: u._id, name: 'גן בורר', ...b1extra }); const b2 = await Branch.create({ adminId: u._id, name: 'גן בורר', ...b2extra });
    const p1 = await Authority.create({ adminId: u._id, name: 'עיריית נחל' }); const p2 = await Authority.create({ adminId: u._id, name: 'עיריית נחל מזרח' });
    return { u, t, b1, b2, p1, p2 };
  };
  const doStep = (t, id, branchId) => request(app).post(`/api/ai/agreements/step/${id}`).set('Authorization', `Bearer ${t}`).send({ branchId });
  it('identical names with different addresses: the candidates carry the address and status, never a raw id as the label', async () => {
    const { t, b1, b2, p1 } = await setup({ address: 'ביאליק 5', managerName: 'דנה' });
    const r = (await prop(t, mkFull(b1, p1), P).expect(200)).body; const a = r.actions[0];
    expect(a.type).toBe('create_agreement_step'); const d = a.candidates.map((c) => c.detail);
    expect(d.some((x) => x.includes('הרצל 1'))).toBe(true); expect(d.some((x) => x.includes('ביאליק 5') && x.includes('מנהל/ת: דנה'))).toBe(true); expect(d.every((x) => x.includes('סטטוס: פעיל'))).toBe(true);
    expect(a.candidates.every((c) => !c.detail.includes(String(b1._id)) && !c.detail.includes(String(b2._id)))).toBe(true);
  });
  it('identical names and identical metadata: refused with a rename message, no proposal stored', async () => {
    const { u, t, b1, p1 } = await setup({ address: 'הרצל 1' }); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    const r = (await prop(t, mkFull(b1, p1), P).expect(200)).body; expect(r.actions).toHaveLength(0); expect(r.rejected.join(' ')).toContain('יש כמה סניפים בשם "גן בורר"'); expect(r.rejected.join(' ')).toContain('שנו שם');
    expect(await AiProposal.countDocuments({ userId: u._id })).toBe(0);
  });
  it('the chosen branch changing before the step or before the final confirm regenerates the choice instead of honouring the name', async () => {
    const { u, t, b1, b2, p2 } = await setup({ address: 'ביאליק 5' }); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    const mkStep = async () => (await prop(t, mkFull(b1, (await Authority.findOne({ adminId: u._id, name: 'עיריית נחל' }))), P).expect(200)).body.actions[0];
    let step = await mkStep(); await Branch.updateOne({ _id: b2._id }, { address: 'שינוי 9' });
    const s1 = await doStep(t, step.proposalId, String(b2._id)); expect(s1.status).toBe(409); expect(s1.body.message).toContain('השתנו מאז ההצעה'); expect((await AiProposal.findById(step.proposalId)).status).toBe('pending');
    step = await mkStep(); const s2 = await doStep(t, step.proposalId, String(b2._id)); expect(s2.status).toBe(200); const a = s2.body.actions[0]; expect(a.branchDetail).toContain('שינוי 9');
    await Branch.updateOne({ _id: b2._id }, { managerName: 'חדשה' });
    const g = (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: a.proposalId })).body.stepUpToken;
    const c = await request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g).send({ branchId: String(p2._id) });
    expect(c.status).toBe(409); expect(c.body.message).toContain('השתנו מאז ההצעה'); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
  });
  it('license candidates that read identically are separated by file presence, and refused when still identical', async () => {
    const { disambiguateActions } = await import('../src/ai/candidateDetails.js'); const aid = new mongoose.Types.ObjectId();
    const mkA = (f1, f2) => ({ type: 'archive_license', needsChoice: true, choiceField: 'licenseId', candidates: [{ id: 'l1', name: 'גן א · כבאות · עד 2027-01-01', fields: { fileName: f1 } }, { id: 'l2', name: 'גן א · כבאות · עד 2027-01-01', fields: { fileName: f2 } }] });
    const rej = []; const ok = await disambiguateActions(aid, [mkA('', 'x.pdf')], rej); expect(ok).toHaveLength(1); expect(ok[0].candidates.map((c) => c.detail).sort()).toEqual(['אין קובץ מצורף', 'קובץ: x.pdf']); expect(rej).toHaveLength(0);
    const rej2 = []; const none = await disambiguateActions(aid, [mkA('', '')], rej2); expect(none).toHaveLength(0); expect(rej2[0]).toContain('אישורים זהים');
  });

  it('payer collision (same name, legacy rows without nameKey): kind separates them in the sequential step 2 card; same kind is refused', async () => {
    const { u, t, b1, b2, p1 } = await setup({ address: 'ביאליק 5' }); const AiProposal = (await import('../src/models/AiProposal.js')).default;
    await Authority.collection.insertOne({ adminId: u._id, name: 'עיריית נחל', type: 'private', createdAt: new Date(), updatedAt: new Date() });
    const mkStep = async () => (await prop(t, mkFull(b1, p1), P).expect(200)).body.actions[0];
    const step = await mkStep(); expect(step.type).toBe('create_agreement_step');
    const pd = step.payerCandidates.filter((c) => c.name === 'עיריית נחל').map((c) => c.detail).sort(); expect(pd).toEqual(['בעל נכס פרטי', 'רשות']);
    const s2 = await doStep(t, step.proposalId, String(b2._id)); expect(s2.status).toBe(200); const a = s2.body.actions[0]; expect(a.choiceField).toBe('agreementPayer');
    const priv = a.candidates.find((c) => c.detail === 'בעל נכס פרטי'); expect(priv).toBeTruthy();
    await Authority.collection.updateOne({ _id: new mongoose.Types.ObjectId(priv.id) }, { $set: { type: 'council' } });
    const g = (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: a.proposalId })).body.stepUpToken;
    const c = await request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g).send({ branchId: priv.id });
    expect(c.status).toBe(409); expect(c.body.message).toContain('השתנו מאז ההצעה'); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    // both payers are now the same kind: a fresh proposal is refused, nothing stored
    const before = await AiProposal.countDocuments({ userId: u._id });
    const r = (await prop(t, mkFull(b1, p1), P).expect(200)).body; expect(r.actions).toHaveLength(0); expect(r.rejected.join(' ')).toContain('גופי תשלום בשם "עיריית נחל"'); expect(await AiProposal.countDocuments({ userId: u._id })).toBe(before);
  });
  it('document destination: same human branch and payer names on different branch ids get separated, refused when identical, and drift is a 409', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' });
    const au = await Authority.create({ adminId: u._id, name: 'עירייה ד' });
    const b1 = await Branch.create({ adminId: u._id, name: 'גן ד', address: 'א 1' }); const b2 = await Branch.create({ adminId: u._id, name: 'גן ד', address: 'ב 2' });
    const mkAg = (b, extra = {}) => RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, branchName: 'גן ד', authorityName: 'עירייה ד', direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', firstDueDate: new Date('2031-01-01'), paymentMethod: 'transfer', status: 'Active', ...extra });
    const a1 = await mkAg(b1); const a2 = await mkAg(b2);
    const PDF = Buffer.from('%PDF-1.4 test');
    const propose = () => request(app).post('/api/ai/agreements/document/propose').set('Authorization', `Bearer ${t}`).attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    const confirm = (id, ag) => request(app).post(`/api/ai/agreements/document/${id}/confirm`).set('Authorization', `Bearer ${t}`).field('agreementId', ag).attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' });
    const ok = await propose(); expect(ok.status).toBe(200); const ds = ok.body.candidates.filter((c) => c.branchName === 'גן ד').map((c) => c.detail);
    expect(ds.some((x) => x.includes('א 1'))).toBe(true); expect(ds.some((x) => x.includes('ב 2'))).toBe(true); expect(JSON.stringify(ds)).not.toContain(String(b1._id));
    await Branch.updateOne({ _id: b2._id }, { address: 'ג 3' });
    const dr = await confirm(ok.body.proposalId, String(a2._id)); expect(dr.status).toBe(409); expect(dr.body.message).toContain('השתנו מאז ההצעה');
    await Branch.updateOne({ _id: b2._id }, { address: 'א 1' });
    const bad = await propose(); expect(bad.status).toBe(422); expect(bad.body.message).toContain('אין ביניהם פרט מבדיל');
  });
  it('license choice through the real propose route: same branch name and type split by branch address, refused when identical, drift at confirm is a 409', async () => {
    const { default: License } = await import('../src/models/License.js'); const { default: LicenseType } = await import('../src/models/LicenseType.js');
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' });
    const b1 = await Branch.create({ adminId: u._id, name: 'גן רישוי', address: 'דרך 1' }); const b2 = await Branch.create({ adminId: u._id, name: 'גן רישוי', address: 'דרך 2' });
    const ty = await LicenseType.create({ adminId: u._id, name: 'כבאות רישוי' });
    const mkL = (b) => License.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id, fileUrl: 'k', fileName: 'a.pdf' });
    const l1 = await mkL(b1); const l2 = await mkL(b2);
    const lp = async (l) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [{ type: 'archive_license', licenseId: String(l._id) }] }), costUsd: 0 }); return (await request(app).post('/api/ai/licenses/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }).expect(200)).body; };
    const r = await lp(l1); const a = r.actions[0]; expect(a.needsChoice).toBe(true); const ds = a.candidates.map((c) => c.detail); expect(ds.some((x) => x.includes('דרך 1'))).toBe(true); expect(ds.some((x) => x.includes('דרך 2'))).toBe(true);
    await Branch.updateOne({ _id: b2._id }, { address: 'דרך 9' });
    const g = (await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:archive_license', scope: a.proposalId })).body.stepUpToken;
    const c = await request(app).post(`/api/ai/proposals/${a.proposalId}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g).send({ branchId: a.candidates.find((x) => x.fields.licenseId === String(l2._id)).id });
    expect(c.status).toBe(409); expect(c.body.message).toContain('השתנו מאז ההצעה'); expect((await License.findById(l2._id)).lifecycle).toBe('Active');
    await Branch.updateOne({ _id: b2._id }, { address: 'דרך 1' });
    const r2 = await lp(l1); expect(r2.actions).toHaveLength(0); expect(r2.rejected.join(' ')).toContain('אין ביניהם פרט מבדיל');
  });
});
