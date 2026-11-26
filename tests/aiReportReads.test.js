import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { parseReportChoice } from '../src/ai/reportReads.js';

describe('parseReportChoice', () => {
  const admin = { role: 'Admin' }; const mgr = { role: 'Manager' };
  it('accepts allowlisted reports and clamps days', () => {
    expect(parseReportChoice('{"report":"licenses_expiring","days":9999}', admin)).toEqual({ report: 'licenses_expiring', days: 365 });
    expect(parseReportChoice('```json\n{"report":"branches_overview"}\n```', mgr)).toEqual({ report: 'branches_overview', days: 60 });
  });
  it('rejects unknown reports, garbage, and admin-only reports for managers', () => {
    expect(parseReportChoice('{"report":"drop_all"}', admin)).toBeNull();
    expect(parseReportChoice('nope', admin)).toBeNull();
    expect(parseReportChoice('{"report":"rent_overdue"}', mgr)).toBeNull();
    expect(parseReportChoice('{"report":"rent_overdue"}', admin)).toMatchObject({ report: 'rent_overdue' });
  });
});

let app; let mongoServer; let User; let Branch; let License; let LicenseType; let ask;
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
  ({ default: License } = await import('../src/models/License.js')); ({ default: LicenseType } = await import('../src/models/LicenseType.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"report":"licenses_expiring","days":90}', costUsd: 0 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('POST /api/ai/reports/ask', () => {
  it('refuses without AI access and never calls the model', async () => {
    const { t } = await mk({ aiEnabled: false }); ask.mockClear();
    await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }).expect(403);
    expect(ask).not.toHaveBeenCalled();
  });
  it('runs a fixed scoped query: a manager sees only accessible branches, the model never sees data', async () => {
    const { u: admin } = await mk({ aiEnabled: true });
    const b1 = await Branch.create({ adminId: admin._id, name: 'גן נגיש' }); const b2 = await Branch.create({ adminId: admin._id, name: 'גן סגור' });
    const lt = await LicenseType.create({ adminId: admin._id, branchId: b1._id, name: 'רישיון עסק' }).catch(async () => LicenseType.create({ adminId: admin._id, name: 'רישיון עסק' }));
    const soon = new Date(Date.now() + 30 * 86400000);
    for (const b of [b1, b2]) await License.create({ branchId: b._id, licenseTypeId: lt._id, issueDate: new Date(), expiryDate: soon, createdBy: admin._id });
    const { t } = await mk({ aiEnabled: true, role: 'Manager', adminId: admin._id, accessibleBranches: [b1._id] });
    ask.mockClear();
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'מה עומד לפוג?' }).expect(200);
    expect(r.body.rows).toHaveLength(1); expect(r.body.rows[0]).toMatchObject({ branch: 'גן נגיש', type: 'רישיון עסק' });
    expect(ask.mock.calls[0][0].prompt).toBe('מה עומד לפוג?');
    expect(JSON.stringify(ask.mock.calls[0][0])).not.toContain('גן סגור');
  });
  it('an unsuitable or admin-only choice by a manager returns a no-report message, no rows', async () => {
    const { t } = await mk({ aiEnabled: true, role: 'Manager' });
    ask.mockResolvedValueOnce({ text: '{"report":"rent_overdue"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'שכירות' }).expect(200);
    expect(r.body.report).toBeNull(); expect(r.body.rows).toEqual([]);
  });
  it('team overview is Admin only and shows no emails or password data', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const m = await mk({ role: 'Manager', adminId: u._id, aiEnabled: true });
    ask.mockResolvedValueOnce({ text: '{"report":"team_overview"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'מי בצוות' }).expect(200);
    expect(r.body.count).toBe(2); expect(JSON.stringify(r.body.rows)).not.toMatch(/@|password/i);
    ask.mockResolvedValueOnce({ text: '{"report":"team_overview"}', costUsd: 0 });
    const r2 = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'מי בצוות' }).expect(200);
    expect(r2.body.report).toBeNull();
  });
  it('rent_paid_summary: Admin only, per authority, cleared vs outstanding, cancelled and other years excluded, other admin invisible', async () => {
    const RentPayment = (await import('../src/models/RentPayment.js')).default; const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true });
    const year = new Date().getUTCFullYear(); const oid = new mongoose.Types.ObjectId();
    const row = (adminId, over) => RentPayment.create({ adminId, agreementId: new mongoose.Types.ObjectId(), branchId: new mongoose.Types.ObjectId(), authorityId: oid, branchName: 'ב', authorityName: 'עירייה א', dueDate: new Date(Date.UTC(year, 5, 1)), amount: 1000, method: 'cheque', ...over });
    await row(u._id, { status: 'Cleared' }); await row(u._id, { status: 'Handed', dueDate: new Date(Date.UTC(year, 5, 2)) }); await row(u._id, { status: 'Pending', amount: 500, dueDate: new Date(Date.UTC(year, 5, 3)) });
    await row(u._id, { status: 'Cancelled', amount: 9999, dueDate: new Date(Date.UTC(year, 5, 4)) }); await row(u._id, { status: 'Cleared', amount: 7777, dueDate: new Date(Date.UTC(year - 1, 5, 1)) }); await row(other.u._id, { status: 'Cleared', amount: 4242 });
    ask.mockResolvedValueOnce({ text: '{"report":"rent_paid_summary"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'כמה שולם השנה' }).expect(200);
    expect(r.body.count).toBe(1); expect(r.body.rows[0].authority).toBe('עירייה א'); expect(r.body.rows[0].summary).toMatch(/שולם בפועל: 1,000/); expect(r.body.rows[0].summary).toMatch(/פתוח: 1,500/); expect(r.body.rows[0].summary).toMatch(/תשלומים: 3/);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); ask.mockResolvedValueOnce({ text: '{"report":"rent_paid_summary"}', costUsd: 0 });
    expect((await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(200)).body.report).toBeNull();
  });
  it('rent_active_totals: Admin only, uses the rent summary computation for active agreements only, isolated per admin', async () => {
    const RentAgreement = (await import('../src/models/RentAgreement.js')).default; const Authority = (await import('../src/models/Authority.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true });
    const au = await Authority.create({ adminId: u._id, name: 'עירייה ג' }); const ao = await Authority.create({ adminId: other.u._id, name: 'זרה' });
    const mkA = (adminId, authorityId, over) => RentAgreement.create({ adminId, branchId: new mongoose.Types.ObjectId(), authorityId, startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31'), amount: 1, frequency: 'monthly', paymentMethod: 'cheque', ...over });
    await mkA(u._id, au._id, { monthlyAmount: 1000 }); await mkA(u._id, au._id, { monthlyAmount: 500, status: 'Closed' }); await mkA(other.u._id, ao._id, { monthlyAmount: 777 });
    ask.mockResolvedValueOnce({ text: '{"report":"rent_active_totals"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'מה סך השכירות החודשית' }).expect(200);
    expect(r.body.count).toBe(1); expect(r.body.rows[0].authority).toBe('עירייה ג'); expect(r.body.rows[0].summary).toMatch(/חודשי: 1,000/); expect(r.body.rows[0].summary).toMatch(/שנתי: 12,000/); expect(r.body.rows[0].summary).toMatch(/פעילים: 1/);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); ask.mockResolvedValueOnce({ text: '{"report":"rent_active_totals"}', costUsd: 0 });
    expect((await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(200)).body.report).toBeNull();
  });
  it('my_profile: the caller only, no secrets, managers get their own branches only', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true });
    ask.mockResolvedValueOnce({ text: '{"report":"my_profile"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'מי אני' }).expect(200);
    expect(r.body.count).toBe(1); expect(r.body.rows[0].email).toBe(u.email); expect(JSON.stringify(r.body)).not.toMatch(/password|token|hash/i); expect(JSON.stringify(r.body)).not.toContain(other.u.email);
    const B = (await import('../src/models/Branch.js')).default; const b1 = await B.create({ adminId: u._id, name: 'שלי' }); await B.create({ adminId: u._id, name: 'לא שלי' });
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id, accessibleBranches: [b1._id] }); ask.mockResolvedValueOnce({ text: '{"report":"my_profile"}', costUsd: 0 });
    const rm = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'מי אני' }).expect(200);
    expect(rm.body.rows[0].branches).toBe('שלי'); expect(rm.body.rows[0].email).toBe(m.u.email);
  });
  it('ai_audit: Admin only, this account only, last 30 days, names the actor and outcome', async () => {
    const AiAudit = (await import('../src/models/AiAudit.js')).default; const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true });
    const base = { adminId: u._id, userId: u._id, type: 'rent_edit_payment', label: 'גן ב' };
    await AiAudit.create([{ ...base, outcome: 'done' }, { ...base, outcome: 'failed', reason: 'x' }, { ...base, outcome: 'done', at: new Date(Date.now() - 40 * 86400000) }, { adminId: other.u._id, userId: other.u._id, type: 'delete_branch', label: 'FOREIGN99', outcome: 'done' }]);
    ask.mockResolvedValueOnce({ text: '{"report":"ai_audit"}', costUsd: 0 });
    const r = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'מה העוזר עשה' }).expect(200);
    expect(r.body.count).toBe(2); expect(r.body.rows.map((x) => x.outcome).sort()).toEqual(['בוצע', 'נדחה בביצוע']); expect(r.body.rows[0].user).toBe(u.name); expect(JSON.stringify(r.body)).not.toContain('FOREIGN99');
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); ask.mockResolvedValueOnce({ text: '{"report":"ai_audit"}', costUsd: 0 });
    expect((await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(200)).body.report).toBeNull();
  });
  it('ai_usage: every model-client attempt is attributed to the calling user (including a cap refusal that still returns its own error); report is Admin only, own account only, labelled as an estimate', async () => {
    const Usage = (await import('../src/models/AiUserUsage.js')).default; const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true });
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id });
    const askAs = async (tok, text) => { ask.mockResolvedValueOnce({ text, costUsd: 0 }); return request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt: 'מה העוזר עשה' }); };
    await askAs(t, '{"report":"my_profile"}').then((r) => expect(r.status).toBe(200)); await askAs(t, '{"report":"my_profile"}'); await askAs(m.t, '{"report":"my_profile"}'); await askAs(other.t, '{"report":"my_profile"}');
    ask.mockRejectedValueOnce(Object.assign(new Error('Daily AI call limit reached'), { statusCode: 429 }));
    const refused = await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); expect(refused.status).toBe(429);
    await new Promise((r) => setTimeout(r, 150));
    const sum = async (id) => (await Usage.find({ userId: id }).lean()).reduce((n, x) => n + x.attempts, 0);
    expect(await sum(u._id)).toBe(3); expect(await sum(m.u._id)).toBe(1); expect(await sum(other.u._id)).toBe(1);
    const r = await askAs(t, '{"report":"ai_usage"}'); expect(r.status).toBe(200); expect(r.body.report).toBe('ai_usage');
    const mine = r.body.rows.find((x) => x.user === u.name); expect(mine.attempts).toBe(4); expect(r.body.rows.find((x) => x.user === m.u.name).attempts).toBe(1);
    expect(JSON.stringify(r.body)).not.toContain(other.u.name); expect(r.body.note).toMatch(/לא חיוב ולא מגבלה/); expect(r.body.note).toMatch(/כולל קריאת מסמכי אישור/); expect(r.body.rows.every((x) => typeof x.attempts === 'number')).toBe(true); expect(r.body.total).toBe(r.body.count);
    expect((await askAs(m.t, '{"report":"ai_usage"}')).body.report).toBeNull();
  });
  it('export-licenses: whole filtered license list beyond 50, manager scope kept, no model call, cap stated, ask returns exportParams', async () => {
    const { u: admin, t: at } = await mk({ aiEnabled: true });
    const lt = await LicenseType.create({ adminId: admin._id, name: 'רישיון ייצוא' }); const soon = new Date(Date.now() + 30 * 86400000);
    const bs = await Branch.insertMany(Array.from({ length: 55 }, (_, i) => ({ adminId: admin._id, name: `גן ייצוא ${i}` })));
    await License.insertMany(bs.map((b) => ({ branchId: b._id, licenseTypeId: lt._id, issueDate: new Date(), expiryDate: soon, createdBy: admin._id })));
    const mgr = await mk({ aiEnabled: true, role: 'Manager', adminId: admin._id, accessibleBranches: [bs[0]._id, bs[1]._id] });
    ask.mockClear();
    const all = (await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${at}`).send({ report: 'licenses_all' }).expect(200)).body;
    expect(all.total).toBe(55); expect(all.count).toBe(55); expect(all.capped).toBe(false); expect(all.cap).toBe(500);
    const mine = (await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${mgr.t}`).send({ report: 'licenses_all' }).expect(200)).body; expect(mine.count).toBe(2);
    const byType = (await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${at}`).send({ report: 'licenses_expiring', days: 60, type: 'רישיון ייצוא' }).expect(200)).body; expect(byType.count).toBe(55);
    const bad = await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${at}`).send({ report: 'licenses_all', type: 'סוג שלא קיים' }); expect(bad.status).toBe(422); expect(bad.body.message).toContain('לא נמצא סוג אישור');
    expect((await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${at}`).send({ report: 'team_overview' })).status).toBe(400);
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce({ text: '{"report":"licenses_all"}', costUsd: 0 });
    const r = (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${at}`).send({ prompt: 'כל האישורים' }).expect(200)).body; expect(r.count).toBe(50); expect(r.total).toBe(55); expect(r.exportParams).toEqual({ report: 'licenses_all' });
  });
  it('license free-text name filter: several branches may match, must be traced to the request, nothing found is a refusal, export carries it', async () => {
    const { u: admin, t: at } = await mk({ aiEnabled: true });
    const lt = await LicenseType.create({ adminId: admin._id, name: 'רישיון טקסט' }); const soon = new Date(Date.now() + 30 * 86400000);
    const bs = await Branch.insertMany(['גן שקד א', 'גן שקד ב', 'גן ברוש'].map((name) => ({ adminId: admin._id, name })));
    await License.insertMany(bs.map((b) => ({ branchId: b._id, licenseTypeId: lt._id, issueDate: new Date(), expiryDate: soon, createdBy: admin._id })));
    const go = async (text, prompt) => { ask.mockResolvedValueOnce({ text, costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${at}`).send({ prompt }).expect(200)).body; };
    const ok = await go('{"report":"licenses_all","name":"שקד"}', 'אישורים של גני שקד'); expect(ok.count).toBe(2); expect(ok.rows.every((x) => x.branch.includes('שקד'))).toBe(true); expect(ok.filters).toEqual(['שם סניף מכיל: שקד']); expect(ok.exportParams).toEqual({ report: 'licenses_all', name: 'שקד' });
    const inv = await go('{"report":"licenses_all","name":"ברוש"}', 'כל האישורים'); expect(inv.report).toBeNull(); expect(inv.message).toContain('לא הופיע במפורש');
    const none = await go('{"report":"licenses_all","name":"זית"}', 'אישורים של גן זית'); expect(none.report).toBeNull(); expect(none.message).toContain('לא נמצא סניף ששמו מכיל "זית"');
    const ex = (await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${at}`).send({ report: 'licenses_all', name: 'שקד' }).expect(200)).body; expect(ex.count).toBe(2);
    const mgr = await mk({ aiEnabled: true, role: 'Manager', adminId: admin._id, accessibleBranches: [bs[0]._id] });
    const mx = (await request(app).post('/api/ai/reports/export-licenses').set('Authorization', `Bearer ${mgr.t}`).send({ report: 'licenses_all', name: 'שקד' }).expect(200)).body; expect(mx.count).toBe(1);
  });
  it('export-team: Admin only, whole filtered list beyond 50, own account only, no emails, no model call, filters honoured', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const other = await mk({ aiEnabled: true }); const User2 = (await import('../src/models/User.js')).default;
    await User2.insertMany(Array.from({ length: 60 }, (_, i) => ({ name: `עובד ${i}`, email: `emp${i}-${u._id}@e.com`, password: 'Password123', role: 'Manager', adminId: u._id, aiEnabled: i < 5 })));
    ask.mockClear();
    const all = (await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${t}`).send({}).expect(200)).body;
    expect(all.total).toBe(61); expect(all.count).toBe(61); expect(all.capped).toBe(false); expect(JSON.stringify(all)).not.toMatch(/@e\.com/); expect(JSON.stringify(all)).not.toContain(other.u.name);
    const aiOnly = (await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${t}`).send({ ai: true }).expect(200)).body; expect(aiOnly.count).toBe(aiOnly.total); expect(aiOnly.total).toBeGreaterThanOrEqual(5);
    const nb = await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${t}`).send({ branch: 'סניף שלא קיים' }); expect(nb.status).toBe(422); expect(nb.body.message).toContain('לא נמצא סניף בשם "סניף שלא קיים"');
    expect((await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${t}`).send({ role: 'Bogus' })).status).toBe(400);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${m.t}`).send({}).expect(403);
    await User2.insertMany(Array.from({ length: 450 }, (_, i) => ({ name: `נוסף ${i}`, email: `x${i}-${u._id}@e.com`, password: 'Password123', role: 'Manager', adminId: u._id })));
    const big = (await request(app).post('/api/ai/reports/export-team').set('Authorization', `Bearer ${t}`).send({}).expect(200)).body; expect(big.total).toBe(512); expect(big.count).toBe(500); expect(big.capped).toBe(true); expect(big.cap).toBe(500);
    expect(ask).not.toHaveBeenCalled();
    ask.mockResolvedValueOnce({ text: '{"report":"team_overview"}', costUsd: 0 });
    const r = (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'צוות' }).expect(200)).body; expect(r.count).toBe(50); expect(r.total).toBeGreaterThan(50); expect(r.exportParams).toEqual({});
  });
  it('licenses_all includes current licenses whose date has passed, and its title does not claim they are all valid', async () => {
    const L = (await import('../src/models/License.js')).default; const LT = (await import('../src/models/LicenseType.js')).default; const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true });
    const b = await B.create({ adminId: u._id, name: 'גן פג' }); const ty = await LT.create({ adminId: u._id, name: 'כבאות' });
    await L.create({ branchId: b._id, licenseTypeId: ty._id, issueDate: new Date('2019-01-01'), expiryDate: new Date('2020-01-01'), createdBy: u._id });
    ask.mockResolvedValueOnce({ text: JSON.stringify({ report: 'licenses_all' }), costUsd: 0 });
    const r = (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }).expect(200)).body;
    expect(r.count).toBe(1); expect(r.rows[0].expiryDate).toContain('2020');
    expect(r.title).not.toContain('התקפים'); expect(r.title).toContain('פג');
  });

  it('licenses_all / licenses_no_file / licenses_history: branch-scoped, lifecycle-correct, manager sees assigned branches only', async () => {
    const L = (await import('../src/models/License.js')).default; const LT = (await import('../src/models/LicenseType.js')).default; const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true });
    const b1 = await B.create({ adminId: u._id, name: 'א1' }); const b2 = await B.create({ adminId: u._id, name: 'ב2' }); const bo = await B.create({ adminId: o.u._id, name: 'FOREIGN77' });
    const ty = await LT.create({ adminId: u._id, name: 'כבאות' }); const tyo = await LT.create({ adminId: o.u._id, name: 'x' });
    const mkL = (branchId, typeId, over) => L.create({ branchId, licenseTypeId: typeId, issueDate: new Date('2026-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id, ...over });
    await mkL(b1._id, ty._id, { fileUrl: 'k1' }); await mkL(b2._id, ty._id, {}); await mkL(b1._id, ty._id, { lifecycle: 'Replaced' }); await mkL(bo._id, tyo._id, {});
    const ask1 = async (rep, tok) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ report: rep }), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt: 'x' }).expect(200)).body; };
    const all = await ask1('licenses_all', t); expect(all.count).toBe(2); expect(all.rows.map((r) => r.file).sort()).toEqual(['אין קובץ', 'יש קובץ']); expect(JSON.stringify(all)).not.toContain('FOREIGN77'); const withFile = all.rows.filter((r) => r.file === 'יש קובץ'); expect(withFile.length).toBe(1); expect(withFile[0].fileLicenseId).toMatch(/^[a-f0-9]{24}$/); expect(all.rows.filter((r) => r.file === 'אין קובץ')[0].fileLicenseId).toBeUndefined();
    const nf = await ask1('licenses_no_file', t); expect(nf.count).toBe(1); expect(nf.rows[0].branch).toBe('ב2');
    const h = await ask1('licenses_history', t); expect(h.count).toBe(1); expect(h.rows[0].branch).toBe('א1'); expect(h.rows[0].fileLicenseId).toBeUndefined();
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id, accessibleBranches: [b2._id] });
    expect((await ask1('licenses_all', m.t)).rows.map((r) => r.branch)).toEqual(['ב2']); expect((await ask1('licenses_all', m.t)).rows.some((r) => r.fileLicenseId)).toBe(false); expect((await ask1('licenses_history', m.t)).count).toBe(0);
  });

  it('licenses_chain: follows replacedBy from the current license, labels unlinked rows apart, needs one branch and one type in the request, own account only', async () => {
    const L = (await import('../src/models/License.js')).default; const LT = (await import('../src/models/LicenseType.js')).default; const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true });
    const b = await B.create({ adminId: u._id, name: 'גן שרשרת' }); const bo = await B.create({ adminId: o.u._id, name: 'גן שרשרת' }); const fire = await LT.create({ adminId: u._id, name: 'כבאות' });
    const mkL = (over) => L.create({ branchId: b._id, licenseTypeId: fire._id, issueDate: new Date('2024-01-01'), createdBy: u._id, expiryDate: new Date('2027-01-01'), ...over });
    const cur = await mkL({}); const p1 = await mkL({ lifecycle: 'Replaced', expiryDate: new Date('2026-01-01'), replacedBy: cur._id }); const p2 = await mkL({ lifecycle: 'Replaced', expiryDate: new Date('2025-01-01'), replacedBy: p1._id }); await mkL({ lifecycle: 'Replaced', expiryDate: new Date('2023-01-01'), replacedBy: null });
    await L.create({ branchId: bo._id, licenseTypeId: fire._id, issueDate: new Date('2024-01-01'), expiryDate: new Date('2030-01-01'), createdBy: o.u._id });
    const go = async (choice, prompt) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt }).expect(200)).body; };
    const r = await go({ report: 'licenses_chain', branch: 'גן שרשרת', type: 'כבאות' }, 'שרשרת כבאות בגן שרשרת');
    expect(r.rows.map((x) => x.position)).toEqual(['נוכחי', 'קודם 1', 'קודם 2', 'לא מקושר לשרשרת']); expect(r.rows[0].expiryDate).toContain('2027'); expect(r.rows[1].expiryDate).toContain('2026'); expect(r.rows[2].expiryDate).toContain('2025'); expect(r.rows[3].expiryDate).toContain('2023'); expect(JSON.stringify(r)).not.toContain('2030');
    const noType = await go({ report: 'licenses_chain', branch: 'גן שרשרת' }, 'שרשרת בגן שרשרת'); expect(noType.rows).toHaveLength(0); expect(noType.message).toContain('סוג האישור');
    const unwritten = await go({ report: 'licenses_chain', branch: 'גן שרשרת', type: 'כבאות' }, 'שרשרת אישורים'); expect(unwritten.rows).toHaveLength(0);
  });
  it('rent_payments: one branch written in the request, optional payer and status only when written; own account only; Admin only; total stated', async () => {
    const RP = (await import('../src/models/RentPayment.js')).default; const B = (await import('../src/models/Branch.js')).default; const A = (await import('../src/models/Authority.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true }); const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id });
    const b = await B.create({ adminId: u._id, name: 'גן תשלומים' }); const bo = await B.create({ adminId: o.u._id, name: 'גן תשלומים' }); const a1 = await A.create({ adminId: u._id, name: 'עיריית אור', ...(A.schema.path('type') ? { type: 'council' } : {}) }); const ao = await A.create({ adminId: o.u._id, name: 'עיריית אור', ...(A.schema.path('type') ? { type: 'council' } : {}) });
    const ag = new mongoose.Types.ObjectId(); const mkP = (over) => RP.create({ adminId: u._id, agreementId: ag, branchId: b._id, authorityId: a1._id, branchName: 'גן תשלומים', authorityName: 'עיריית אור', dueDate: new Date('2027-01-01'), amount: 1000, method: 'transfer', ...over });
    await mkP({ dueDate: new Date('2027-01-01'), status: 'Cleared' }); await mkP({ dueDate: new Date('2027-02-01'), status: 'Pending', amount: 1200, method: 'cheque' }); await mkP({ dueDate: new Date('2027-03-01'), status: 'Pending', groupId: new mongoose.Types.ObjectId() });
    await RP.create({ adminId: o.u._id, agreementId: new mongoose.Types.ObjectId(), branchId: bo._id, authorityId: ao._id, branchName: 'גן תשלומים', authorityName: 'עיריית אור', dueDate: new Date('2027-04-01'), amount: 9999, method: 'transfer' });
    const go = async (choice, prompt, tok = t) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt }).expect(200)).body; };
    const all = await go({ report: 'rent_payments', branch: 'גן תשלומים' }, 'תשלומי שכירות של גן תשלומים'); expect(all.rows.map((r) => r.dueDate)).toEqual(['2027-01-01', '2027-02-01', '2027-03-01']); expect(all.total).toBe(3); expect(JSON.stringify(all)).not.toContain('9999'); expect(all.rows[1]).toMatchObject({ amount: 1200, method: 'צ׳ק', status: 'ממתין' }); expect(all.rows[2].grouped).toBeTruthy();
    const pend = await go({ report: 'rent_payments', branch: 'גן תשלומים', pstatus: 'Pending' }, 'תשלומים ממתינים של גן תשלומים'); expect(pend.rows).toHaveLength(2);
    const bogus = await go({ report: 'rent_payments', branch: 'גן תשלומים', pstatus: 'Cleared' }, 'תשלומי שכירות של גן תשלומים'); expect(bogus.report).toBeNull(); expect(bogus.rows).toHaveLength(0); expect(bogus.message).toContain('סטטוס תשלום');
    const nb = await go({ report: 'rent_payments' }, 'תשלומי שכירות'); expect(nb.rows).toHaveLength(0); expect(nb.message).toContain('שם הסניף');
    const mg = await go({ report: 'rent_payments', branch: 'גן תשלומים' }, 'תשלומי שכירות של גן תשלומים', m.t); expect(mg.report).toBeNull(); expect(mg.rows || []).toHaveLength(0);
    const au = await go({ report: 'rent_payments', branch: 'גן תשלומים', authority: 'עיריית אור' }, 'תשלומי עיריית אור של גן תשלומים'); expect(au.rows).toHaveLength(3);
  });
  it('licenses_chain with more than 60 records: total is the real count, and an explicit incomplete-history row replaces any implied origin', async () => {
    const L = (await import('../src/models/License.js')).default; const LT = (await import('../src/models/LicenseType.js')).default; const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const b = await B.create({ adminId: u._id, name: 'גן ארוך' }); const fire = await LT.create({ adminId: u._id, name: 'כבאות' });
    const mkL = (over) => ({ branchId: b._id, licenseTypeId: fire._id, issueDate: new Date('2010-01-01'), createdBy: u._id, expiryDate: new Date('2027-01-01'), ...over });
    const cur = await L.create(mkL({})); const p1 = await L.create(mkL({ lifecycle: 'Replaced', expiryDate: new Date('2020-01-01'), replacedBy: cur._id })); await L.create(mkL({ lifecycle: 'Replaced', expiryDate: new Date('2019-01-01'), replacedBy: p1._id }));
    await L.insertMany(Array.from({ length: 62 }, (_, i) => mkL({ lifecycle: 'Replaced', expiryDate: new Date(Date.UTC(2021 + (i % 5), i % 12, 1)) })));
    ask.mockResolvedValueOnce({ text: JSON.stringify({ report: 'licenses_chain', branch: 'גן ארוך', type: 'כבאות' }), costUsd: 0 });
    const r = (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt: 'שרשרת כבאות בגן ארוך' }).expect(200)).body;
    expect(r.total).toBe(65); expect(r.rows[0].position).toBe('נוכחי'); expect(r.rows.some((x) => /לא הוצגה במלואה: נטענו 60 מתוך 65/.test(x.position))).toBe(true);
    expect(r.rows.filter((x) => x.position === 'לא מקושר לשרשרת')).toHaveLength(0); expect(r.rows.filter((x) => x.position === 'לא מקושר לשרשרת בין הרשומות שנטענו').length).toBeGreaterThan(0);
    expect(r.rows.some((x) => x.position === 'קודם 1')).toBe(false); // p1 (2020) fell outside the window: it must not be shown as a verified link, and the marker says why
  });
  it('license filters: branch and type must be written in the request; exact/unique names only; per-license history chain; total reported when capped', async () => {
    const L = (await import('../src/models/License.js')).default; const LT = (await import('../src/models/LicenseType.js')).default; const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true });
    const b1 = await B.create({ adminId: u._id, name: 'גן ורד' }); const b2 = await B.create({ adminId: u._id, name: 'גן ורדים' }); const b3 = await B.create({ adminId: u._id, name: 'גן שקד' }); const bo = await B.create({ adminId: o.u._id, name: 'גן ורד' });
    const fire = await LT.create({ adminId: u._id, name: 'כבאות' }); const hyg = await LT.create({ adminId: u._id, name: 'תברואה' });
    const mkL = (branchId, typeId, over) => L.create({ branchId, licenseTypeId: typeId, issueDate: new Date('2025-01-01'), expiryDate: new Date('2027-01-01'), createdBy: u._id, ...over });
    await mkL(b3._id, fire._id, {}); await mkL(b3._id, hyg._id, {}); await mkL(b3._id, fire._id, { lifecycle: 'Replaced', expiryDate: new Date('2025-06-01') }); await mkL(b3._id, fire._id, { lifecycle: 'Replaced', expiryDate: new Date('2024-06-01') }); await mkL(b2._id, fire._id, {});
    const go = async (choice, prompt) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${t}`).send({ prompt }).expect(200)).body; };
    const r1 = await go({ report: 'licenses_all', branch: 'גן שקד', type: 'כבאות' }, 'אישורי כבאות בגן שקד'); expect(r1.count).toBe(1); expect(r1.rows[0].branch).toBe('גן שקד'); expect(r1.rows[0].type).toBe('כבאות'); expect(r1.total).toBe(1); expect(r1.branchFilter).toBe('גן שקד');
    const chain = await go({ report: 'licenses_history', branch: 'גן שקד', type: 'כבאות' }, 'היסטוריית כבאות בגן שקד'); expect(chain.count).toBe(2); expect(chain.rows.every((r) => r.branch === 'גן שקד' && r.type === 'כבאות')).toBe(true);
    const typed = await go({ report: 'licenses_all', type: 'תברואה' }, 'כל אישורי תברואה'); expect(typed.rows.map((r) => r.type)).toEqual(['תברואה']);
    const amb = await go({ report: 'licenses_all', branch: 'ורד' }, 'אישורי גן ורד'); expect(amb.rows).toHaveLength(0); expect(amb.message).toMatch(/גן ורד/);
    const exact = await go({ report: 'licenses_all', branch: 'גן ורד' }, 'אישורי גן ורד'); expect(exact.rows.map((r) => r.branch)).toEqual([]); expect(exact.report).toBe('licenses_all'); expect(exact.count).toBe(0);
    const none = await go({ report: 'licenses_all', branch: 'גן זר' }, 'אישורי גן זר'); expect(none.message).toMatch(/לא נמצא סניף/);
    const invented = await go({ report: 'licenses_all', branch: 'גן שקד' }, 'כל האישורים'); expect(invented.report).toBeNull(); expect(invented.message).toMatch(/לא הצגתי דוח/);
    expect(JSON.stringify([r1, chain, typed, amb, exact])).not.toContain(String(bo._id));
  });

  it('branches_overview: status/payer/no-payer/name filters must be in the request, nothing silently broadens, managers never get payer data, other admin invisible', async () => {
    const B = (await import('../src/models/Branch.js')).default; const AU = (await import('../src/models/Authority.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true });
    const au = await AU.create({ adminId: u._id, name: 'עיריית חולון' }); const au2 = await AU.create({ adminId: u._id, name: 'עיריית חולונית' });
    const b1 = await B.create({ adminId: u._id, name: 'גן א', status: 'Active', authorityId: au._id, managerName: 'דנה' }); const b2 = await B.create({ adminId: u._id, name: 'גן ב', status: 'Suspended' }); const b3 = await B.create({ adminId: u._id, name: 'גן ג', status: 'Active', authorityId: au2._id }); await B.create({ adminId: o.u._id, name: 'גן זר', status: 'Suspended' });
    const go = async (choice, prompt, tok = t) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt }).expect(200)).body; };
    const susp = await go({ report: 'branches_overview', status: 'Suspended' }, 'הסניפים המושעים'); expect(susp.rows.map((r) => r.branch)).toEqual(['גן ב']); expect(susp.rows[0].payer).toBe('ללא'); expect(susp.filters).toEqual(['סטטוס: מושעה']); expect(JSON.stringify(susp)).not.toContain('גן זר');
    expect((await go({ report: 'branches_overview', status: 'Suspended' }, 'הסניפים שלי')).report).toBeNull();
    const np = await go({ report: 'branches_overview', noPayer: true }, 'סניפים ללא גוף משלם'); expect(np.rows.map((r) => r.branch)).toEqual(['גן ב']);
    expect((await go({ report: 'branches_overview', noPayer: true }, 'הסניפים שלי')).report).toBeNull();
    const pay = await go({ report: 'branches_overview', payer: 'עיריית חולון' }, 'הסניפים של עיריית חולון'); expect(pay.rows.map((r) => r.branch)).toEqual(['גן א']); expect(pay.rows[0].payer).toBe('עיריית חולון');
    expect((await go({ report: 'branches_overview', payer: 'חול' }, 'סניפים של חול')).message).toMatch(/עיריית חולון/);
    expect((await go({ report: 'branches_overview', payer: 'עיריית אילת' }, 'סניפים של עיריית אילת')).message).toMatch(/לא נמצא גוף משלם/);
    const nm = await go({ report: 'branches_overview', name: 'ב' }, 'סניפים ששמם מכיל ב'); expect(nm.rows.map((r) => r.branch)).toEqual(['גן ב']);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id, accessibleBranches: [b1._id, b2._id] });
    const mr = await go({ report: 'branches_overview', status: 'Suspended' }, 'הסניפים המושעים', m.t); expect(mr.rows.map((r) => r.branch)).toEqual(['גן ב']); expect(JSON.stringify(mr)).not.toContain('payer'); expect(JSON.stringify(mr)).not.toContain('עיריית');
    expect((await go({ report: 'branches_overview', payer: 'עיריית חולון' }, 'הסניפים של עיריית חולון', m.t)).message).toMatch(/מנהל החשבון/);
    expect((await go({ report: 'branches_overview' }, 'הסניפים שלי', m.t)).rows).toEqual([{ branch: 'גן א' }, { branch: 'גן ב' }]);
    expect(String(b3._id)).toBeTruthy();
  });

  it('team_overview filters: role, AI, branch and name must be in the request; total vs cap; nothing broadens; managers refused; other admin invisible; no emails', async () => {
    const B = (await import('../src/models/Branch.js')).default;
    const { u, t } = await mk({ aiEnabled: true, name: 'מנהל ראשי' }); const o = await mk({ aiEnabled: true, name: 'דנה זרה' });
    const b1 = await B.create({ adminId: u._id, name: 'גן א' }); const b2 = await B.create({ adminId: u._id, name: 'גן ב' });
    await mk({ role: 'Manager', adminId: u._id, name: 'דנה כהן', accessibleBranches: [b1._id], aiEnabled: true }); await mk({ role: 'Manager', adminId: u._id, name: 'יוסי לוי', accessibleBranches: [b2._id] });
    const go = async (choice, prompt, tok = t) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt }).expect(200)).body; };
    const mg = await go({ report: 'team_overview', role: 'Manager' }, 'מנהלי הסניפים'); expect(mg.rows.map((r) => r.name).sort()).toEqual(['דנה כהן', 'יוסי לוי']); expect(mg.total).toBe(2); expect(mg.filters).toEqual(['תפקיד: מנהל סניף']);
    expect((await go({ report: 'team_overview', role: 'Manager' }, 'הצוות שלי')).report).toBeNull();
    const ai = await go({ report: 'team_overview', ai: false }, 'מי בלי עוזר AI'); expect(ai.rows.map((r) => r.name)).toEqual(['יוסי לוי']);
    const br = await go({ report: 'team_overview', branch: 'גן א' }, 'מי עובד בגן א'); expect(br.rows.map((r) => r.name).sort()).toEqual(['דנה כהן', 'מנהל ראשי']);
    expect((await go({ report: 'team_overview', branch: 'גן זר' }, 'מי עובד בגן זר')).message).toMatch(/לא נמצא סניף/);
    const nm = await go({ report: 'team_overview', name: 'דנה' }, 'משתמשים ששמם דנה'); expect(nm.rows.map((r) => r.name)).toEqual(['דנה כהן']);
    expect(JSON.stringify([mg, ai, br, nm])).not.toContain('@'); expect(JSON.stringify([mg, ai, br, nm])).not.toContain('דנה זרה');
    const m = await mk({ role: 'Manager', adminId: u._id, aiEnabled: true, accessibleBranches: [b1._id] });
    expect((await go({ report: 'team_overview' }, 'הצוות', m.t)).report).toBeNull();
  });

  it('rent_agreements: Admin only, active only, scheduled amount, filters traced to the request, nothing broadens, other admin invisible', async () => {
    const B = (await import('../src/models/Branch.js')).default; const AU = (await import('../src/models/Authority.js')).default; const RA = (await import('../src/models/RentAgreement.js')).default;
    const { u, t } = await mk({ aiEnabled: true }); const o = await mk({ aiEnabled: true });
    const b1 = await B.create({ adminId: u._id, name: 'גן א' }); const b2 = await B.create({ adminId: u._id, name: 'גן ב' }); const bo = await B.create({ adminId: o.u._id, name: 'גן זר' });
    const a1 = await AU.create({ adminId: u._id, name: 'עיריית חולון' }); const a2 = await AU.create({ adminId: u._id, name: 'עיריית רמלה' }); const ao = await AU.create({ adminId: o.u._id, name: 'עיריית זרה' });
    const mk2 = (adm, b, a, extra) => RA.create({ adminId: adm, branchId: b._id, authorityId: a._id, direction: 'outgoing', monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: new Date('2030-01-01'), ...extra });
    await mk2(u._id, b1, a1, { direction: 'incoming', monthlyAmount: 2000 }); await mk2(u._id, b2, a2, { paymentMethod: 'cheque', chequeSeries: { depositedCount: 2, seriesEndDate: new Date('2031-06-30') } }); await mk2(u._id, b2, a1, { status: 'Closed' }); await mk2(o.u._id, bo, ao, {});
    const go = async (choice, prompt, tok = t) => { ask.mockResolvedValueOnce({ text: JSON.stringify(choice), costUsd: 0 }); return (await request(app).post('/api/ai/reports/ask').set('Authorization', `Bearer ${tok}`).send({ prompt }).expect(200)).body; };
    const all = await go({ report: 'rent_agreements' }, 'הסכמי שכירות פעילים'); expect(all.count).toBe(2); expect(all.total).toBe(2); expect(JSON.stringify(all)).not.toContain('זר'); expect(all.rows.find((r) => r.branch === 'גן ב').series).toMatch(/2031/); expect(all.rows.find((r) => r.branch === 'גן א').amount).toContain('2,000');
    expect((await go({ report: 'rent_agreements', authority: 'עיריית חולון' }, 'הסכמים מול עיריית חולון')).rows.map((r) => r.branch)).toEqual(['גן א']);
    expect((await go({ report: 'rent_agreements', direction: 'incoming' }, 'הסכמים שהרשות משלמת לנו')).rows.map((r) => r.branch)).toEqual(['גן א']);
    expect((await go({ report: 'rent_agreements', direction: 'outgoing' }, 'הסכמים שאנחנו משלמים')).rows.map((r) => r.branch)).toEqual(['גן ב']);
    expect((await go({ report: 'rent_agreements', authority: 'עיריית חולון' }, 'הסכמים פעילים')).report).toBeNull();
    expect((await go({ report: 'rent_agreements', branch: 'גן זר' }, 'הסכמים בגן זר')).message).toMatch(/לא נמצא סניף/);
    const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id, accessibleBranches: [b1._id] });
    expect((await go({ report: 'rent_agreements' }, 'הסכמי שכירות פעילים', m.t)).report).toBeNull();
  });
});
