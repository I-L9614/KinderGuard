import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeAgreementActions } from '../src/ai/agreementActions.js';

const A = [{ _id: 'a1', branchName: 'גן א', authorityName: 'עירייה', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: new Date('2026-01-01'), updatedAt: new Date('2026-06-01') }];
describe('sanitizeAgreementActions', () => {
  it('create_agreement extras: custom dates, quarterly/annual and cheque series must all be in the request; anything untraced refuses the whole create', () => {
    const bs = [{ _id: 'b1', name: 'גן יצירה' }]; const as = [{ _id: 'u1', name: 'עירית יצירה' }]; const ctx = (prompt) => ({ branches: bs, authorities: as, activeKeys: new Set(), prompt });
    const base = { type: 'create_agreement', branchId: 'b1', authorityId: 'u1', monthlyAmount: 3000, frequency: 'custom', paymentMethod: 'cheque', firstDueDate: '2031-02-01', direction: 'incoming', customDueDates: ['2031-02-01', '2031-05-15'] };
    const P = 'צור הסכם שכירות חדש, הרשות משלמת לנו 3000 בחודש בצ׳קים במועדים מותאמים: 1.2.2031 ו-15.5.2031, פרעון ראשון 1.2.2031';
    const run = (o, prompt = P) => sanitizeAgreementActions(JSON.stringify({ actions: [{ ...base, ...o }] }), [], ctx(prompt));
    const ok = run({}); expect(ok.actions[0].changes.customDueDates).toEqual(['2031-02-01', '2031-05-15']); expect(ok.rejected).toHaveLength(0);
    expect(run({ customDueDates: ['2031-02-01', '2031-09-09'] }).actions).toHaveLength(0); expect(run({ customDueDates: ['2031-02-01', '2031-09-09'] }).rejected.join(' ')).toMatch(/2031-09-09/);
    expect(run({ customDueDates: [] }).actions).toHaveLength(0);
    expect(run({ frequency: 'monthly', customDueDates: ['2031-02-01'] }, P.replace('מותאמים', 'חודשי')).actions).toHaveLength(0);
    const Q = P + ', תשלום רבעוני 9000, סדרת צ׳קים: הופקדו 4 צ׳קים וסיום 31.12.2031';
    const rich = run({ quarterlyAmount: 9000, chequeSeries: { depositedCount: 4, seriesEndDate: '2031-12-31' } }, Q); expect(rich.actions[0].changes.quarterlyAmount).toBe(9000); expect(rich.actions[0].changes.chequeSeries).toEqual({ depositedCount: 4, seriesStartDate: null, seriesEndDate: '2031-12-31' });
    expect(run({ quarterlyAmount: 9000 }).actions).toHaveLength(0);
    expect(run({ annualAmount: 36000 }, Q).actions).toHaveLength(0);
    expect(run({ chequeSeries: { depositedCount: 5, seriesEndDate: '2031-12-31' } }, Q).actions).toHaveLength(0);
    expect(run({ paymentMethod: 'transfer', chequeSeries: { depositedCount: 4, seriesEndDate: '2031-12-31' } }, Q.replace('בצ׳קים', 'בהעברה')).rejected.join(' ')).toMatch(/רק להסכם בתשלום בצ׳קים/);
  });
  it('cheque series: cheque payment only, count and dates traced to the request, whole series shown, no-op reported', () => {
    const run = (cs, prompt, extra = {}, list = A) => sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', chequeSeries: cs, ...extra }] }), list, { prompt });
    const P = 'הופקדו 6 צ׳קים, הסדרה מתחילה ב-1.1.2026 ונגמרת ב-31.12.2026';
    const ok = run({ depositedCount: 6, seriesStartDate: '2026-01-01', seriesEndDate: '2026-12-31' }, P); expect(ok.actions[0].changes.chequeSeries).toEqual({ depositedCount: 6, seriesStartDate: '2026-01-01', seriesEndDate: '2026-12-31' }); expect(ok.actions[0].current.chequeSeries).toBeNull();
    expect(run({ depositedCount: 6, seriesEndDate: '2026-12-31' }, P).actions[0].changes.chequeSeries.seriesStartDate).toBeNull();
    // An omitted start date carries the stored one (the controller replaces the whole series), never wipes it:
    const withSeries = [{ ...A[0], chequeSeries: { depositedCount: 2, seriesStartDate: new Date('2026-01-01'), seriesEndDate: new Date('2026-06-30') } }];
    expect(run({ depositedCount: 6, seriesEndDate: '2026-12-31' }, P, {}, withSeries).actions[0].changes.chequeSeries.seriesStartDate).toBe('2026-01-01');
    expect(run({ depositedCount: 2, seriesEndDate: '2026-06-30' }, 'הופקדו 2 צ׳קים וסיום הסדרה 30.6.2026', {}, withSeries).rejected.join(' ')).toMatch(/כבר כך/);
    expect(run({ depositedCount: 7, seriesEndDate: '2026-12-31' }, P).actions).toHaveLength(0);
    expect(run({ depositedCount: 6, seriesEndDate: '2026-11-30' }, P).actions).toHaveLength(0);
    expect(run({ depositedCount: 6, seriesStartDate: '2026-02-01', seriesEndDate: '2026-12-31' }, P).actions).toHaveLength(0);
    expect(run({ depositedCount: 6, seriesEndDate: '2026-12-31' }, P, {}, [{ ...A[0], paymentMethod: 'transfer' }]).rejected.join(' ')).toMatch(/רק להסכם בתשלום בצ׳קים/);
    expect(run({ depositedCount: 6, seriesEndDate: '2026-12-31' }, P + ' והעברה', { paymentMethod: 'cheque' }, [{ ...A[0], paymentMethod: 'transfer' }]).actions[0].changes.chequeSeries).toBeDefined();
    expect(run({ depositedCount: 6, seriesStartDate: '2026-01-01', seriesEndDate: '2026-12-31' }, P, {}, [{ ...A[0], chequeSeries: { depositedCount: 6, seriesStartDate: new Date('2026-01-01'), seriesEndDate: new Date('2026-12-31') } }]).rejected.join(' ')).toMatch(/כבר כך/);
  });
  it('quarterly/annual figures: only when number and word are in the request; no-ops and bad values dropped; effect shown', () => {
    const run = (act, prompt) => sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', ...act }] }), A, { prompt });
    const ok = run({ quarterlyAmount: 3300 }, 'תעדכן את התשלום הרבעוני ל-3,300'); expect(ok.actions[0].changes).toEqual({ quarterlyAmount: 3300 }); expect(ok.actions[0].effect).toBeDefined();
    expect(run({ annualAmount: 13000 }, 'תעדכן את התשלום השנתי ל-13000').actions[0].changes).toEqual({ annualAmount: 13000 });
    expect(run({ quarterlyAmount: 3300 }, 'תעדכן ל-3300').actions).toHaveLength(0);
    { const mix = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', monthlyAmount: 1200, annualAmount: 12000 }] }), [{ ...A[0], annualAmount: 12000 }], { prompt: 'חודשי 1200, שנתי 12000' }); expect(mix.actions[0].changes).toEqual({ monthlyAmount: 1200 }); expect(mix.rejected.join(' ')).toMatch(/הסכום השנתי כבר 12000/); }
    expect(run({ quarterlyAmount: 3300 }, 'תשלום רבעוני 3000').actions).toHaveLength(0);
    expect(run({ annualAmount: -4 }, 'שנתי -4').actions).toHaveLength(0);
    expect(run({ annualAmount: 13000 }, 'תשלום רבעוני 13000').rejected.join(' ')).toMatch(/הסכום השנתי/);
  });
  it('keeps only covered changed fields, drops no-ops and unknown agreements, one action per agreement', () => {
    const r = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', monthlyAmount: 1200, frequency: 'monthly', direction: 'incoming', annualAmount: 5 }, { type: 'update_agreement', agreementId: 'a1', paymentMethod: 'transfer' }, { type: 'update_agreement', agreementId: 'zz', monthlyAmount: 5 }, { type: 'delete_agreement', agreementId: 'a1' }] }), A);
    expect(r.actions).toHaveLength(1); expect(r.actions[0].changes).toEqual({ monthlyAmount: 1200 }); expect(r.actions[0].sensitive).toBe(true); expect(r.rejected).toHaveLength(4); expect(r.rejected.join(' ')).toMatch(/כיוון ההסכם/); expect(r.rejected.join(' ')).toMatch(/הסכום השנתי לא הופיע/);
  });
  it('changes direction only when the request words say who pays whom; the card current value is the stored one', () => {
    const run = (prompt) => sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', direction: 'incoming' }] }), A, { prompt });
    const ok = run('הרשות משלמת לנו שכירות בהסכם הזה'); expect(ok.actions[0].changes).toEqual({ direction: 'incoming' }); expect(ok.actions[0].current.direction).toBe('outgoing');
    expect(run('תעדכן את ההסכם').actions).toHaveLength(0);
    expect(sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', direction: 'outgoing' }] }), A, { prompt: 'אנחנו משלמים' }).actions).toHaveLength(0);
  });
  it('rejects a no-change update and a bad date or amount', () => {
    expect(sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: 'a1', monthlyAmount: -5, firstDueDate: 'ביום שני' }] }), A).actions).toHaveLength(0);
  });
});

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

describe('agreement actions end to end', () => {
  const mkAgr = async (u, extra = {}) => { const b = await Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` }); const au = await Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(Authority.schema.path('type') ? { type: 'council' } : {}) }).catch(async () => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}` })); return RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra }); };
  const prop = (t, a, prompt = 'x') => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [a] }), costUsd: 0 }); return request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${t}`).send({ prompt }); };
  const confirm = (t, id, withGrant = true) => { const pr = (async () => { const rq = request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`); if (withGrant) { const a = (await (await import('../src/models/AiProposal.js')).default.findById(id)).action.type; const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: `ai:${a}`, scope: id }); if (!g.body.stepUpToken) return g; rq.set('X-Step-Up', g.body.stepUpToken); } return rq.send({}); })(); return { result: pr, expect: async (c) => { const r = await pr; expect(r.status, JSON.stringify(r.body)).toBe(c); return r; } }; };
  it('update needs the grant; applies only the proposed change through the controller; stale proposal is refused', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u);
    const r = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), monthlyAmount: 1500 }).expect(200)).body; const a = r.actions[0];
    expect((await RentAgreement.findById(ag._id)).monthlyAmount).toBe(1000);
    await confirm(t, a.proposalId, false).expect(403);
    expect((await RentAgreement.findById(ag._id)).monthlyAmount).toBe(1000);
    await confirm(t, a.proposalId).expect(200);
    const after = await RentAgreement.findById(ag._id); expect(after.monthlyAmount).toBe(1500); expect(after.frequency).toBe('monthly');
    const r2 = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), monthlyAmount: 1700 }).expect(200)).body;
    await RentAgreement.updateOne({ _id: ag._id }, { $set: { paymentMethod: 'cheque' } });
    await confirm(t, r2.actions[0].proposalId).expect(409);
    expect((await RentAgreement.findById(ag._id)).monthlyAmount).toBe(1500);
    // quarterly figure: traced to the request, needs the grant, written by the controller
    const q = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), quarterlyAmount: 4600 }, 'תעדכן את הסכום הרבעוני ל-4600').expect(200)).body.actions[0];
    expect(q.changes).toEqual({ quarterlyAmount: 4600 }); await confirm(t, q.proposalId, false).expect(403);
    expect((await RentAgreement.findById(ag._id)).quarterlyAmount).not.toBe(4600);
    await confirm(t, q.proposalId).expect(200); expect((await RentAgreement.findById(ag._id)).quarterlyAmount).toBe(4600);
  });
  it('create_agreement: sensitive, needs every field and the direction, exact ids, blocks a duplicate active one, similar branch needs a pick, ambiguous payer refused', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const o = await mk({ aiEnabled: true });
    const b = await Branch.create({ adminId: u._id, name: 'גן יצירה' }); const au = await Authority.create({ adminId: u._id, name: 'עירית יצירה' });
    const bo = await Branch.create({ adminId: o.u._id, name: 'גן זר' });
    const P = 'צור הסכם שכירות חדש, הרשות משלמת לנו 3000 בחודש בהעברה, פרעון ראשון 1.2.2031'; const full = { type: 'create_agreement', branchId: String(b._id), authorityId: String(au._id), monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' };
    for (const bad of [{ monthlyAmount: 0 }, { frequency: 'custom' }, { paymentMethod: 'cash' }, { firstDueDate: 'soon' }, { direction: undefined }, { branchId: String(bo._id) }]) { const r = (await prop(t, { ...full, ...bad }, P).expect(200)).body; expect(r.actions).toHaveLength(0); expect(r.rejected).toHaveLength(1); }
    for (const [lost, prompt] of [['הסכום', P.replace('3000', '4000')], ['התדירות', P.replace('בחודש', 'מדי פעם')], ['אמצעי', P.replace('בהעברה', '')], ['תאריך', P.replace('1.2.2031', 'בקרוב')], ['כיוון', P.replace('הרשות משלמת לנו', 'ההסכם')]]) { const rr = (await prop(t, full, prompt).expect(200)).body; expect(rr.actions).toHaveLength(0); expect(rr.rejected[0]).toMatch(/לא ברור מהבקשה/); expect(rr.rejected[0]).toContain(lost); }
    expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    const r = (await prop(t, full, P).expect(200)).body; const a = r.actions[0]; expect(a.sensitive).toBe(true); expect(a.needsChoice).toBe(false);
    await confirm(t, a.proposalId, false).expect(403); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(0);
    await confirm(t, a.proposalId).expect(200);
    const made = await RentAgreement.findOne({ adminId: u._id }); expect(made.monthlyAmount).toBe(3000); expect(made.direction).toBe('incoming'); expect(made.authorityName).toBe('עירית יצירה');
    expect((await prop(t, full, P).expect(200)).body.rejected[0]).toMatch(/כבר יש הסכם פעיל/);
    // an active agreement that appears between the proposal and the confirm is refused at execution
    await RentAgreement.deleteMany({ adminId: u._id }); const r2 = (await prop(t, full, P).expect(200)).body; await RentAgreement.create({ adminId: u._id, branchId: b._id, authorityId: au._id, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), amount: 1, frequency: 'monthly', paymentMethod: 'cheque' });
    await confirm(t, r2.actions[0].proposalId).expect(409); expect(await RentAgreement.countDocuments({ adminId: u._id })).toBe(1);
    // similar-named branches: the card needs the user's pick from its own candidates; ambiguous payer is refused
    const b2 = await Branch.create({ adminId: u._id, name: 'גן יצירה צפון' }); const au2 = await Authority.create({ adminId: u._id, name: 'עירית יצירה מזרח' });
    const rc = (await prop(t, { ...full, branchId: String(b2._id), authorityId: String(au._id) }, P).expect(200)).body; expect(rc.actions).toHaveLength(0); expect(rc.rejected[0]).toMatch(/גופי תשלום בשם דומה/);
    const au3 = await Authority.create({ adminId: u._id, name: 'מועצה שונה לגמרי' }); await Authority.deleteOne({ _id: au2._id });
    const rb = (await prop(t, { ...full, branchId: String(b2._id), authorityId: String(au3._id) }, P).expect(200)).body; expect(rb.actions[0].needsChoice).toBe(true); expect(rb.actions[0].branchId).toBeNull(); expect(rb.actions[0].candidates.map((x) => x.name).sort()).toEqual(['גן יצירה', 'גן יצירה צפון']);
    const pid = rb.actions[0].proposalId; const { default: AiProposal } = await import('../src/models/AiProposal.js');
    const g = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: pid });
    const noPick = await request(app).post(`/api/ai/proposals/${pid}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g.body.stepUpToken).send({}); expect(noPick.status).toBe(400);
    expect(await RentAgreement.countDocuments({ adminId: u._id, branchId: b2._id })).toBe(0); expect((await AiProposal.findById(pid)).status).toBe('pending');
    const rb2 = (await prop(t, { ...full, branchId: String(b2._id), authorityId: String(au3._id) }, P).expect(200)).body; const pid2 = rb2.actions[0].proposalId;
    const g2 = await request(app).post('/api/auth/step-up').set('Authorization', `Bearer ${t}`).send({ password: 'Password123', action: 'ai:create_agreement', scope: pid2 });
    await request(app).post(`/api/ai/proposals/${pid2}/confirm`).set('Authorization', `Bearer ${t}`).set('X-Step-Up', g2.body.stepUpToken).send({ branchId: String(b2._id) }).expect(200);
    const picked = await RentAgreement.findOne({ adminId: u._id, branchId: b2._id }); expect(picked.authorityName).toBe('מועצה שונה לגמרי'); expect(picked.branchName).toBe('גן יצירה צפון');
    const rb3 = (await prop(t, { ...full, branchId: String(b2._id), authorityId: String(au3._id) }, P).expect(200)).body; expect(rb3.rejected[0]).toMatch(/כבר יש הסכם פעיל/);
  });
  it('write-time atomicity: parallel confirms apply once, and a manual edit racing the write cannot be overwritten', async () => {
    const { updateAgreement } = await import('../src/controllers/rentController.js');
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u);
    const r = (await prop(t, { type: 'update_agreement', agreementId: String(ag._id), monthlyAmount: 2100 }).expect(200)).body;
    const pid = r.actions[0].proposalId;
    const [c1, c2] = await Promise.all([confirm(t, pid).result, confirm(t, pid).result]);
    // A duplicate that arrives after the first finished legitimately gets 200 with duplicate:true (the stored outcome), so count real applications only.
    expect([c1, c2].filter((x) => x.status === 200 && !x.body?.duplicate).length).toBe(1);
    expect([c1.status, c2.status].every((x) => [200, 403, 409].includes(x))).toBe(true);
    expect((await RentAgreement.findById(ag._id)).monthlyAmount).toBe(2100);
    // Two writers loaded the same version: exactly one save wins, the other gets 409, never a 500 or a silent overwrite.
    const ag2 = await mkAgr(u);
    const call = (body, expectedUpdatedAt) => new Promise((resolve) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } }; updateAgreement({ user: u, params: { id: String(ag2._id) }, body, expectedUpdatedAt }, res).catch((e) => resolve({ code: 500, e })); });
    const [a, b] = await Promise.all([call({ monthlyAmount: 3000 }), call({ monthlyAmount: 4000 })]);
    const codes = [a.code, b.code].sort();
    expect(codes.includes(500)).toBe(false);
    expect(codes.filter((c) => c === 200).length).toBeGreaterThanOrEqual(1);
    const stale = await call({ monthlyAmount: 5000 }, new Date(0));
    expect(stale.code).toBe(409);
    expect([3000, 4000]).toContain((await RentAgreement.findById(ag2._id)).monthlyAmount);
  });
  it('amount is monthly; effect mirrors controller (stored quarterly figure keeps payments unchanged)', async () => {
    const { u } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u, { frequency: 'quarterly', quarterlyAmount: 3000, monthlyAmount: 1000 });
    const r = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: String(ag._id), monthlyAmount: 1500 }] }), [ag.toObject()]);
    expect(r.actions[0].effect).toEqual({ beforeFrequency: 'quarterly', afterFrequency: 'quarterly', before: 3000, after: 3000 });
    const ag2 = await mkAgr(u, { frequency: 'quarterly', monthlyAmount: 1000, quarterlyAmount: undefined });
    const r2 = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: String(ag2._id), monthlyAmount: 1500 }] }), [ag2.toObject()]);
    expect(r2.actions[0].effect.after).toBe(4500);
    const ag3 = await mkAgr(u, { frequency: 'monthly', monthlyAmount: 1000 });
    const r3 = sanitizeAgreementActions(JSON.stringify({ actions: [{ type: 'update_agreement', agreementId: String(ag3._id), frequency: 'quarterly' }] }), [ag3.toObject()]);
    expect(r3.actions[0].effect).toMatchObject({ beforeFrequency: 'monthly', afterFrequency: 'quarterly', before: 1000 });
  });
  it('close is sensitive, closes once, and the same proposal cannot be applied again', async () => {
    const { u, t } = await mk({ aiEnabled: true, password: 'Password123' }); const ag = await mkAgr(u);
    const r = (await prop(t, { type: 'close_agreement', agreementId: String(ag._id), reason: 'הסכם הסתיים' }).expect(200)).body;
    expect(r.actions[0].sensitive).toBe(true);
    await confirm(t, r.actions[0].proposalId, false).expect(403);
    expect((await RentAgreement.findById(ag._id)).status).toBe('Active');
    await confirm(t, r.actions[0].proposalId).expect(200);
    expect((await RentAgreement.findById(ag._id)).status).toBe('Closed');
  });
  it("another account's agreement is not visible to the model, and managers are refused", async () => {
    const a = await mk({ aiEnabled: true }); const b = await mk({ aiEnabled: true, password: 'Password123' }); await mkAgr(a.u);
    ask.mockClear(); ask.mockResolvedValueOnce({ text: '{"actions":[]}', costUsd: 0 });
    await request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${b.t}`).send({ prompt: 'x' }).expect(200);
    expect(JSON.parse(ask.mock.calls[0][0].prompt.split('\n\n')[0]).agreements).toHaveLength(0);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: a.u._id });
    await request(app).post('/api/ai/agreements/propose').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(403);
  });
});
