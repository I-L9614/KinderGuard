import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeBranchActions, normName, PAYER_PENDING } from '../src/ai/branchActions.js';

const B = [{ _id: 'b1', name: 'גן שקד', address: 'הרצל 1', managerName: 'דנה', phone: '', maxChildren: 40 }, { _id: 'b2', name: 'גן ורד' }];
describe('sanitizeBranchActions extras: status and emails', () => {
  it('accepts a closed-enum status and validated, deduplicated, lower-cased emails; rejects the rest with a Hebrew note', () => {
    const run = (x) => sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: 'b1', ...x }] }), B);
    const ok = run({ status: 'Suspended', emails: 'A@x.co; a@x.co, b@y.org' }); expect(ok.actions[0].fields).toEqual({ status: 'Suspended', emails: ['a@x.co', 'b@y.org'] });
    const bad = run({ status: 'Weird', emails: 'not-an-email' }); expect(bad.actions).toHaveLength(0); expect(bad.rejected.join(' ')).toMatch(/סטטוס/); expect(bad.rejected.join(' ')).toMatch(/מיילים/);
    expect(run({ emails: Array.from({ length: 11 }, (_, i) => `u${i}@x.co`) }).actions).toHaveLength(0);
  });
});
describe('sanitizeBranchActions unlink payer', () => {
  const A = [{ _id: 'a1', name: 'עיריית חולון' }];
  const BL = [{ _id: 'b1', name: 'גן שקד', authorityId: 'a1' }, { _id: 'b2', name: 'גן ורד' }];
  const run = (x, prompt, id = 'b1') => sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: id, ...x }] }), BL, new Map(), A, prompt);
  it('unlinks only on an existing linked branch, only when the request says to remove the link, never together with a new payer', () => {
    const ok = run({ unlinkPayer: true }, 'הסר את הקישור של גן שקד לגוף המשלם'); expect(ok.actions[0].fields).toEqual({ authorityId: '' }); expect(ok.actions[0].before).toEqual({ authorityId: 'a1' }); expect(ok.actions[0].authorityNames).toEqual({ a1: 'עיריית חולון' });
    expect(run({ unlinkPayer: true }, 'תעדכן את גן שקד').actions).toHaveLength(0); expect(run({ unlinkPayer: true }, 'תעדכן את גן שקד').rejected.join(' ')).toMatch(/ניתוק גוף המשלם לא הופיע/);
    expect(run({ unlinkPayer: true }, 'הסר את הקישור לגוף המשלם של גן ורד', 'b2').rejected.join(' ')).toMatch(/אין שינוי/);
    expect(run({ unlinkPayer: true, authorityId: 'a1' }, 'הסר קישור לגוף משלם ולעיריית חולון').rejected.join(' ')).toMatch(/גם לקשר גוף משלם וגם לנתק/);
    const create = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'create_branch', name: 'גן חדש', unlinkPayer: true }] }), BL, new Map(), A, 'הסר קישור לגוף משלם');
    expect(create.rejected.join(' ')).toMatch(/רק מסניף קיים/);
  });
});
describe('sanitizeBranchActions kind change', () => {
  const BL = [{ _id: 'b1', name: 'גן שקד' }, { _id: 'b2', name: 'גן ורד', kind: 'daycare' }]; const PB = [{ _id: 'p1', name: 'משרד הנהלה', kind: 'property' }];
  const D = new Map([['b1', { licenses: 0, files: 0, alerts: 0, activeAgreements: 1, closedAgreements: 0 }], ['b2', { licenses: 3, files: 1, alerts: 2, activeAgreements: 0, closedAgreements: 0 }]]);
  const run = (x, prompt, id = 'b1') => sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: id, ...x }] }), BL, D, [], prompt, PB);
  it('needs explicit words, refuses a daycare with licenses/files/alerts, refuses unknown kind, same kind and non-existing branches; property to daycare works from the property list', () => {
    const ok = run({ kind: 'property' }, 'הפוך את גן שקד לנכס'); expect(ok.actions).toHaveLength(0); expect(ok.rejected.join(' ')).toMatch(/אינה נתמכת/);
    expect(run({ kind: 'property' }, 'תעדכן את גן שקד').rejected.join(' ')).toMatch(/לא הופיע במפורש/);
    const blocked = run({ kind: 'property' }, 'הפוך את גן ורד לנכס', 'b2'); expect(blocked.actions).toHaveLength(0); expect(blocked.rejected.join(' ')).toMatch(/אינה נתמכת/);
    expect(run({ kind: 'weird' }, 'הפוך לנכס').rejected.join(' ')).toMatch(/לא מוכר/);
    expect(run({ kind: 'daycare' }, 'הפוך את גן שקד למעון').rejected.join(' ')).toMatch(/כבר מסוג מעון/);
    const back = run({ kind: 'daycare' }, 'הפוך את משרד הנהלה למעון', 'p1'); expect(back.actions[0].fields).toEqual({ kind: 'daycare' }); expect(back.actions[0].before).toEqual({ kind: 'property' }); expect(back.actions[0].warning).toMatch(/יופיע/);
    expect(run({ name: 'שם חדש' }, 'שנה שם', 'p1').actions).toHaveLength(0);
    const create = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'create_branch', name: 'חדש', kind: 'property' }] }), BL, D, [], 'הפוך לנכס', PB); expect(create.rejected.join(' ')).toMatch(/רק בעדכון/);
  });
});
describe('sanitizeBranchActions payer link', () => {
  const A = [{ _id: 'a1', name: 'עיריית חולון' }, { _id: 'a2', name: 'עיריית רמלה' }, { _id: 'a3', name: 'עיריית רמלה צפון' }];
  const run = (x, prompt) => sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: 'b2', ...x }] }), B, new Map(), A, prompt);
  it('sets the payer only when its exact name is in the request, it exists, and no similar-named sibling exists', () => {
    const ok = run({ authorityId: 'a1' }, 'קשר את גן ורד לעיריית חולון');
    expect(ok.actions[0].fields).toEqual({ authorityId: 'a1' }); expect(ok.actions[0].authorityNames).toEqual({ a1: 'עיריית חולון' });
    expect(run({ authorityId: 'a1' }, 'קשר את גן ורד לעירייה').actions).toHaveLength(0);
    expect(run({ authorityId: 'zzz' }, 'עיריית חולון').rejected.join(' ')).toMatch(/לא מוכר/);
    const sib = run({ authorityId: 'a2' }, 'קשר את גן ורד לעיריית רמלה'); expect(sib.rejected).toHaveLength(0);
    expect(sib.actions[0]).toMatchObject({ needsChoice: true, choiceField: 'branchPayer' }); expect(sib.actions[0].candidates.map((x) => x.id).sort()).toEqual(['a2', 'a3']);
    expect(sib.actions[0].fields.authorityId).toBe(PAYER_PENDING); expect(sib.actions[0].authorityNames).toMatchObject({ a2: 'עיריית רמלה', a3: 'עיריית רמלה צפון' });
  });
});
describe('sanitizeBranchActions', () => {
  it('keeps allowed fields, drops no-op fields, rejects unknown types and unknown branches', () => {
    const r = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: 'b1', address: 'הרצל 1', phone: '03-1234567', kind: 'property' }, { type: 'delete_branch', branchId: 'b1' }, { type: 'update_branch', branchId: 'zz', phone: '1' }] }), B);
    expect(r.actions).toHaveLength(1); expect(r.actions[0].fields).toEqual({ phone: '03-1234567' }); expect(r.rejected).toHaveLength(3); expect(r.rejected.join(' ')).toMatch(/שינוי סוג הסניף לא הופיע במפורש/);
  });
  it('blocks an exact duplicate name (spaces, quotes, case) and warns on a similar one', () => {
    expect(normName('  גן  שקד ')).toBe(normName('גן שקד'));
    const dup = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'create_branch', name: 'גן  שקד' }] }), B);
    expect(dup.actions).toHaveLength(0); expect(dup.rejected[0]).toContain('כבר קיים');
    const near = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'create_branch', name: 'גן שקד צפון' }] }), B);
    expect(near.actions[0].warning).toContain('דומה');
  });
  it('create needs a name', () => { expect(sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'create_branch', address: 'x' }] }), B).actions).toHaveLength(0); });
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
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('branch actions end to end', () => {
  const prop = (t, actions) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions }), costUsd: 0 }); return request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'x' }); };
  const conf = (t, id) => request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`).send({});
  it('proposal changes nothing; confirm creates once; a duplicate name is refused at execution', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const r = (await prop(t, [{ type: 'create_branch', name: 'גן חדש', address: 'ירושלים 5' }]).expect(200)).body;
    expect(await Branch.countDocuments({ adminId: u._id })).toBe(0);
    await conf(t, r.actions[0].proposalId).expect(200); await conf(t, r.actions[0].proposalId).expect(200);
    expect(await Branch.countDocuments({ adminId: u._id, name: 'גן חדש' })).toBe(1);
    const r2 = (await prop(t, [{ type: 'create_branch', name: 'גן חדש 2' }]).expect(200)).body;
    await Branch.create({ adminId: u._id, name: 'גן חדש 2' });
    await conf(t, r2.actions[0].proposalId).expect(409);
    expect(await Branch.countDocuments({ adminId: u._id, name: 'גן חדש 2' })).toBe(1);
  });
  it('update applies only the proposed fields and is refused if the branch changed', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await Branch.create({ adminId: u._id, name: 'גן עדכון', address: 'ישן' });
    const r = (await prop(t, [{ type: 'update_branch', branchId: String(b._id), phone: '050-1112222' }]).expect(200)).body;
    await Branch.updateOne({ _id: b._id }, { name: 'גן עדכון חדש' });
    await conf(t, r.actions[0].proposalId).expect(409);
    const r2 = (await prop(t, [{ type: 'update_branch', branchId: String(b._id), phone: '050-1112222' }]).expect(200)).body;
    await conf(t, r2.actions[0].proposalId).expect(200);
    const after = await Branch.findById(b._id); expect(after.phone).toBe('050-1112222'); expect(after.address).toBe('ישן');
  });
  it('status and emails apply through the real controller and are guarded by the before value', async () => {
    const { u, t } = await mk({ aiEnabled: true }); const b = await Branch.create({ adminId: u._id, name: 'גן קשר', emails: ['old@x.co'] });
    const r = (await prop(t, [{ type: 'update_branch', branchId: String(b._id), status: 'Suspended', emails: ['new@x.co', 'two@x.co'] }]).expect(200)).body;
    expect(r.actions[0].before).toEqual({ status: 'Active', emails: ['old@x.co'] });
    await Branch.updateOne({ _id: b._id }, { emails: ['changed@x.co'] }); await conf(t, r.actions[0].proposalId).expect(409);
    const r2 = (await prop(t, [{ type: 'update_branch', branchId: String(b._id), status: 'Suspended', emails: ['new@x.co', 'two@x.co'] }]).expect(200)).body;
    await conf(t, r2.actions[0].proposalId).expect(200); const after = await Branch.findById(b._id); expect(after.status).toBe('Suspended'); expect(after.emails).toEqual(['new@x.co', 'two@x.co']);
  });
  it('managers and users without AI cannot propose', async () => {
    const { u } = await mk({ aiEnabled: true }); const m = await mk({ aiEnabled: true, role: 'Manager', adminId: u._id }); const n = await mk({ aiEnabled: false });
    ask.mockClear();
    await request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${m.t}`).send({ prompt: 'x' }).expect(403);
    await request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${n.t}`).send({ prompt: 'x' }).expect(403);
    expect(ask).not.toHaveBeenCalled();
  });
  it('a similar-named target is not auto-selected: confirm needs a choice from the candidate list', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const a = await Branch.create({ adminId: u._id, name: 'גן שקד' }); const b = await Branch.create({ adminId: u._id, name: 'גן שקד צפון' }); const other = await Branch.create({ adminId: u._id, name: 'גן אחר לגמרי' });
    const r = (await prop(t, [{ type: 'update_branch', branchId: String(a._id), phone: '03-9999999' }]).expect(200)).body;
    expect(r.actions[0].needsChoice).toBe(true); expect(r.actions[0].branchId).toBeNull(); expect(r.actions[0].candidates.map((c) => c.name).sort()).toEqual(['גן שקד', 'גן שקד צפון']);
    await conf(t, r.actions[0].proposalId).expect(400);
    await request(app).post(`/api/ai/proposals/${r.actions[0].proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ branchId: String(other._id) }).expect(400);
    expect((await Branch.findById(a._id)).phone).toBeFalsy(); expect((await Branch.findById(b._id)).phone).toBeFalsy();
    await request(app).post(`/api/ai/proposals/${r.actions[0].proposalId}/confirm`).set('Authorization', `Bearer ${t}`).send({ branchId: String(b._id) }).expect(200);
    expect((await Branch.findById(b._id)).phone).toBe('03-9999999'); expect((await Branch.findById(a._id)).phone).toBeFalsy();
  });
  it('multi-branch: one action per branch with its own before/after, confirmed independently; a value changed behind one card refuses only that card', async () => {
    const { u, t } = await mk({ aiEnabled: true });
    const bs = []; for (let i = 0; i < 5; i += 1) bs.push(await Branch.create({ adminId: u._id, name: `סניף-${i}-${Math.random().toString(36).slice(2, 5)}`, phone: i % 2 ? `03-000000${i}` : '', managerName: `מנהל ${i}` }));
    const r = (await prop(t, bs.map((b) => ({ type: 'update_branch', branchId: String(b._id), phone: '09-7777777' }))).expect(200)).body;
    expect(r.actions).toHaveLength(5);
    r.actions.forEach((a, i) => { expect(a.before).toEqual({ phone: bs[i].phone || '' }); expect(a.fields).toEqual({ phone: '09-7777777' }); });
    await Branch.updateOne({ _id: bs[2]._id }, { phone: '052-0000000' });
    await conf(t, r.actions[2].proposalId).expect(409);
    for (const i of [0, 1, 3, 4]) await conf(t, r.actions[i].proposalId).expect(200);
    const after = await Branch.find({ _id: { $in: bs.map((b) => b._id) } }).sort({ name: 1 }).lean();
    expect(after.map((b) => b.phone).sort()).toEqual(['052-0000000', '09-7777777', '09-7777777', '09-7777777', '09-7777777']);
    expect(after.every((b) => b.managerName)).toBe(true);
  });
  it('multi-branch: duplicates are dropped, more than 20 are capped with a note, and a similar-name candidate carries its own before', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ _id: `m${i}`, name: `סניף ייחודי ${String.fromCharCode(1488 + i)}${String.fromCharCode(1488 + ((i * 7) % 26))}`, phone: String(i) }));
    const out = sanitizeBranchActions(JSON.stringify({ actions: [...many.map((b) => ({ type: 'update_branch', branchId: b._id, phone: 'X1' })), { type: 'update_branch', branchId: 'm0', phone: 'X2' }] }), many);
    expect(out.actions.length).toBeLessThanOrEqual(20); expect(out.rejected.some((x) => x.includes('20'))).toBe(true);
    const dup = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: 'b1', phone: 'P1' }, { type: 'update_branch', branchId: 'b1', phone: 'P2' }] }), B);
    expect(dup.actions).toHaveLength(1); expect(dup.actions[0].fields.phone).toBe('P1'); expect(dup.rejected).toHaveLength(1);
    const sim = sanitizeBranchActions(JSON.stringify({ actions: [{ type: 'update_branch', branchId: 'x1', phone: 'N' }] }), [{ _id: 'x1', name: 'גן שקד', phone: 'A' }, { _id: 'x2', name: 'גן שקד צפון', phone: 'B' }]);
    expect(sim.actions[0].needsChoice).toBe(true); expect(sim.actions[0].candidates.map((c) => c.before.phone).sort()).toEqual(['A', 'B']);
  });
  it('the stale guard is conditional at the atomic write: a change landing after the confirm pre-read still blocks the write', async () => {
    const { u } = await mk({ aiEnabled: true }); const b = await Branch.create({ adminId: u._id, name: 'גן מרוץ', phone: '01-111', address: 'א' });
    const { runBranchAction } = await import('../src/ai/branchActions.js');
    const action = { type: 'update_branch', branchId: String(b._id), currentName: 'גן מרוץ', before: { phone: '01-111' }, fields: { phone: '09-999' } };
    const realFind = Branch.find.bind(Branch);
    const spy = vi.spyOn(Branch, 'find').mockImplementationOnce((...args) => { const q = realFind(...args); const origLean = q.lean.bind(q); q.lean = async () => { const rows = await origLean(); await Branch.updateOne({ _id: b._id }, { phone: '05-RACE' }); return rows; }; return q; });
    await expect(runBranchAction(u, action)).rejects.toMatchObject({ statusCode: 409 });
    spy.mockRestore();
    expect((await Branch.findById(b._id)).phone).toBe('05-RACE');
    await expect(runBranchAction(u, { ...action, before: { phone: '05-RACE' } })).resolves.toBeTruthy();
    expect((await Branch.findById(b._id)).phone).toBe('09-999');
  });
  it('payer link end to end: unrelated-admin payer is never proposable, a renamed payer is refused at confirm, the exact one is linked', async () => {
    const { default: Authority } = await import('../src/models/Authority.js');
    const { u, t } = await mk({ aiEnabled: true }); const other = await mk({});
    const b = await Branch.create({ adminId: u._id, name: 'גן קישור' });
    const au = await Authority.create({ adminId: u._id, name: 'עיריית לוד', type: 'council' }); const foreign = await Authority.create({ adminId: other.u._id, name: 'עיריית זרה', type: 'council' });
    const pr = (id, text) => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [{ type: 'update_branch', branchId: String(b._id), authorityId: String(id) }] }), costUsd: 0 }); return request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${t}`).send({ prompt: text }); };
    const f = await pr(foreign._id, 'קשר את גן קישור לעיריית זרה').expect(200); expect(f.body.actions).toHaveLength(0);
    const r1 = await pr(au._id, 'קשר את גן קישור לעיריית לוד').expect(200); expect(r1.body.actions[0].fields.authorityId).toBe(String(au._id));
    await Authority.updateOne({ _id: au._id }, { name: 'עיריית לוד החדשה' });
    await conf(t, r1.body.actions[0].proposalId).expect(409); expect((await Branch.findById(b._id)).authorityId).toBeNull();
    await Authority.updateOne({ _id: au._id }, { name: 'עיריית לוד' });
    const r2 = await pr(au._id, 'קשר את גן קישור לעיריית לוד').expect(200); await conf(t, r2.body.actions[0].proposalId).expect(200);
    expect(String((await Branch.findById(b._id)).authorityId)).toBe(String(au._id));
  });
  it('similar-named payers: the card needs a pick from its own candidates; a foreign or unlisted id is refused; the pick is linked and re-checked', async () => {
    const { default: Authority } = await import('../src/models/Authority.js');
    const { u, t } = await mk({ aiEnabled: true }); const other = await mk({});
    const b = await Branch.create({ adminId: u._id, name: 'גן בחירה' });
    const p1 = await Authority.create({ adminId: u._id, name: 'מועצת עמק', type: 'council' }); const p2 = await Authority.create({ adminId: u._id, name: 'מועצת עמק צפון', type: 'council' }); const fo = await Authority.create({ adminId: other.u._id, name: 'מועצת עמק זרה', type: 'council' });
    const pr = () => { ask.mockResolvedValueOnce({ text: JSON.stringify({ actions: [{ type: 'update_branch', branchId: String(b._id), authorityId: String(p1._id) }] }), costUsd: 0 }); return request(app).post('/api/ai/branches/propose').set('Authorization', `Bearer ${t}`).send({ prompt: 'קשר את גן בחירה למועצת עמק' }); };
    const r = (await pr().expect(200)).body; const a = r.actions[0]; expect(a.needsChoice).toBe(true); expect(a.candidates.map((x) => x.name).sort()).toEqual(['מועצת עמק', 'מועצת עמק צפון']);
    const cf = (id, body) => request(app).post(`/api/ai/proposals/${id}/confirm`).set('Authorization', `Bearer ${t}`).send(body);
    await cf(a.proposalId, {}).expect(400); await cf(a.proposalId, { branchId: String(fo._id) }).expect(400); await cf(a.proposalId, { branchId: String(b._id) }).expect(400);
    expect((await Branch.findById(b._id)).authorityId).toBeNull();
    await cf(a.proposalId, { branchId: String(p2._id) }).expect(200);
    expect(String((await Branch.findById(b._id)).authorityId)).toBe(String(p2._id));
  });
  it('the branch route asks with the 3500 output cap that the budget reservation is computed from', async () => {
    const { u, t } = await mk({ aiEnabled: true }); await Branch.create({ adminId: u._id, name: 'גן קאפ' });
    ask.mockClear(); await prop(t, []).expect(200);
    expect(ask.mock.calls[0][0].maxOutput).toBe(3500);
  });
});

// Payer-link vs payer-delete race: the fences on both sides (deleting filter
// at pre-check and AI commit, post-write verify with unwind in the
// controllers, link cleanup under the delete claim) must leave no dangling
// branch.authorityId in any interleaving.
describe('payer-link/delete race fence', () => {
  const mkAuthority = async (adminId, extra = {}) => {
    const Authority = (await import('../src/models/Authority.js')).default;
    return Authority.create({ adminId, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(mongoose.model('Authority').schema.path('type') ? { type: 'council' } : {}), ...extra });
  };
  const call = (fn, req) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } };
    fn(req, res).then(() => resolve({ code: res.code })).catch((e) => resolve({ code: e.status || e.statusCode || 500, e }));
  });

  it('the AI commit recheck refuses a payer claimed for deletion', async () => {
    const { u } = await mk({ aiEnabled: true });
    const au = await mkAuthority(u._id, { deleting: true });
    const { runBranchAction } = await import('../src/ai/branchActions.js');
    const err = await runBranchAction(u, { type: 'create_branch', fields: { name: 'גן גדר', authorityId: String(au._id) }, authorityNames: { [String(au._id)]: au.name } }).then(() => null, (e) => e);
    expect(err?.statusCode).toBe(409);
  });

  it('the controller pre-check refuses a payer already claimed for deletion', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id, { deleting: true });
    const { createBranch } = await import('../src/controllers/branchController.js');
    expect((await call(createBranch, { user: u, body: { name: 'גן נעילה', authorityId: String(au._id) } })).code).toBe(400);
    expect(await Branch.countDocuments({ adminId: u._id, name: 'גן נעילה' })).toBe(0);
  });

  it('a payer vanishing between check and write leaves the branch created, unlinked, and reported truthfully', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id);
    const Authority = (await import('../src/models/Authority.js')).default;
    const { createBranch } = await import('../src/controllers/branchController.js');
    // Deterministic interleaving: pre-check passes, post-write verify loses.
    const spy = vi.spyOn(Authority, 'exists').mockImplementationOnce(async () => true).mockImplementationOnce(async () => null);
    const r = await call(createBranch, { user: u, body: { name: 'גן מירוץ', authorityId: String(au._id) } });
    spy.mockRestore();
    expect(r.code).toBe(201); // the create itself succeeded
    expect(r.v.payerLinkFailed).toBe(true); // the link failure is reported, not hidden
    expect(r.v.authorityId).toBeNull();
    const b = await Branch.findOne({ adminId: u._id, name: 'גן מירוץ' });
    expect(b).not.toBeNull(); // never a destructive unwind
    expect(b.authorityId).toBeNull();
  });

  it('updateBranch restores the previous link when the payer vanished mid-write', async () => {
    const { u } = await mk({});
    const oldAu = await mkAuthority(u._id); const newAu = await mkAuthority(u._id);
    const b = await Branch.create({ adminId: u._id, name: 'גן קשר', authorityId: oldAu._id });
    const Authority = (await import('../src/models/Authority.js')).default;
    const { updateBranch } = await import('../src/controllers/branchController.js');
    const spy = vi.spyOn(Authority, 'exists').mockImplementationOnce(async () => true).mockImplementationOnce(async () => null);
    const r = await call(updateBranch, { user: u, params: { id: String(b._id) }, body: { authorityId: String(newAu._id) } });
    spy.mockRestore();
    expect(r.code).toBe(409);
    expect(String((await Branch.findById(b._id)).authorityId)).toBe(String(oldAu._id)); // previous link restored
  });

  it('deleteAuthority unlinks live branches under its claim instead of leaving dangling refs', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id);
    const b = await Branch.create({ adminId: u._id, name: 'גן מקושר', authorityId: au._id });
    const { deleteAuthority } = await import('../src/controllers/rentController.js');
    expect((await call(deleteAuthority, { user: u, params: { id: String(au._id) } })).code).toBe(200);
    expect((await Branch.findById(b._id)).authorityId).toBeNull();
    expect(await mongoose.model('Authority').findById(au._id)).toBeNull();
  });
});

// Bounded failure interleavings of the payer-link unwind: the restore must
// never overwrite a later legitimate edit, the create unwind must never
// delete a branch that gained a concurrent edit or dependent, and a crashed
// delete must recover through the guard reconcile.
describe('payer-link unwind interleavings', () => {
  const mkAuthority = async (adminId, extra = {}) => {
    const Authority = (await import('../src/models/Authority.js')).default;
    return Authority.create({ adminId, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, ...(mongoose.model('Authority').schema.path('type') ? { type: 'council' } : {}), ...extra });
  };
  const call = (fn, req) => new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } };
    fn(req, res).then(() => resolve({ code: res.code })).catch((e) => resolve({ code: e.status || e.statusCode || 500, e }));
  });
  // Arms the exact interleaving: pre-check passes, the payer is gone at the
  // post-write verify.
  const payerVanishesAfterCheck = async () => {
    const Authority = (await import('../src/models/Authority.js')).default;
    return vi.spyOn(Authority, 'exists').mockImplementationOnce(async () => true).mockImplementationOnce(async () => null);
  };

  it('a restore never overwrites a later legitimate link edit', async () => {
    const { u } = await mk({});
    const oldAu = await mkAuthority(u._id); const deadAu = await mkAuthority(u._id); const thirdAu = await mkAuthority(u._id);
    const b = await Branch.create({ adminId: u._id, name: 'גן שחזור', authorityId: oldAu._id });
    const spy = await payerVanishesAfterCheck();
    // A concurrent legitimate edit lands between this attempt's write and its restore.
    const realUpdateOne = Branch.updateOne.bind(Branch);
    const interleave = vi.spyOn(Branch, 'updateOne').mockImplementationOnce(async (filter, update) => {
      await realUpdateOne({ _id: b._id }, { $set: { authorityId: thirdAu._id } });
      return realUpdateOne(filter, update);
    });
    const { updateBranch } = await import('../src/controllers/branchController.js');
    const r = await call(updateBranch, { user: u, params: { id: String(b._id) }, body: { authorityId: String(deadAu._id) } });
    spy.mockRestore(); interleave.mockRestore();
    expect(r.code).toBe(409);
    expect(String((await Branch.findById(b._id)).authorityId)).toBe(String(thirdAu._id)); // the later edit won
  });

  it('a concurrent edit in the verify window survives, and a concurrent re-link wins over the unlink', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id); const thirdAu = await mkAuthority(u._id);
    const spy = await payerVanishesAfterCheck();
    // Interleave at the unlink (the only updateOne in this path): a concurrent
    // legitimate re-link to a live payer lands first.
    const realUpdateOne = Branch.updateOne.bind(Branch);
    const interleave = vi.spyOn(Branch, 'updateOne').mockImplementationOnce(async (filter, update) => {
      await realUpdateOne({ _id: filter._id }, { $set: { managerName: 'עריכה מקבילה', authorityId: thirdAu._id } });
      return realUpdateOne(filter, update); // matches nothing: the link already moved
    });
    const { createBranch } = await import('../src/controllers/branchController.js');
    const r = await call(createBranch, { user: u, body: { name: 'גן נערך', authorityId: String(au._id) } });
    spy.mockRestore(); interleave.mockRestore();
    expect(r.code).toBe(201);
    expect(r.v.payerLinkFailed).toBe(true);
    const b = await Branch.findOne({ adminId: u._id, name: 'גן נערך' });
    expect(b.managerName).toBe('עריכה מקבילה'); // the concurrent edit survives
    expect(String(b.authorityId)).toBe(String(thirdAu._id)); // the later legitimate link is never clobbered
    expect(String(r.v.authorityId)).toBe(String(thirdAu._id)); // and the response is the fresh truth
  });

  it('unlink payer: controller clears the link, expectedBefore guards a concurrent change', async () => {
    const { u } = await mk({ aiEnabled: true });
    const au = await mkAuthority(u._id); const b = await Branch.create({ adminId: u._id, name: 'גן ניתוק', authorityId: au._id });
    const { runBranchAction } = await import('../src/ai/branchActions.js');
    const act = { type: 'update_branch', branchId: String(b._id), currentName: 'גן ניתוק', before: { authorityId: String(au._id) }, fields: { authorityId: '' }, authorityNames: { [String(au._id)]: au.name } };
    const other = await mkAuthority(u._id, { name: 'גוף אחר חי' });
    await Branch.updateOne({ _id: b._id }, { $set: { authorityId: other._id } });
    await expect(runBranchAction(u, act)).rejects.toMatchObject({ statusCode: 409 });
    expect(String((await Branch.findById(b._id)).authorityId)).toBe(String(other._id));
    await Branch.updateOne({ _id: b._id }, { $set: { authorityId: au._id } });
    await runBranchAction(u, act); expect((await Branch.findById(b._id)).authorityId ?? null).toBeNull();
  });

  it('kind change: applies through the controller only while the branch has no licenses/files/alerts; a late license blocks it at confirm', async () => {
    const { u } = await mk({ aiEnabled: true });
    const License = (await import('../src/models/License.js')).default; const LicenseType = (await import('../src/models/LicenseType.js')).default;
    const b = await Branch.create({ adminId: u._id, name: 'גן להסבה' });
    const { runBranchAction } = await import('../src/ai/branchActions.js');
    const act = { type: 'update_branch', branchId: String(b._id), currentName: 'גן להסבה', before: { kind: 'daycare' }, fields: { kind: 'property' } };
    const lt = await LicenseType.create({ adminId: u._id, name: 'סוג' });
    await License.create({ branchId: b._id, licenseTypeId: lt._id, issueDate: new Date(), expiryDate: new Date(Date.now() + 1e9), createdBy: u._id });
    await expect(runBranchAction(u, act)).rejects.toMatchObject({ statusCode: 409 }); expect((await Branch.findById(b._id)).kind).toBe('daycare');
    await License.deleteMany({ branchId: b._id });
    await expect(runBranchAction(u, act)).rejects.toMatchObject({ statusCode: 409 }); expect((await Branch.findById(b._id)).kind).toBe('daycare'); await Branch.updateOne({ _id: b._id }, { kind: 'property' });
    await runBranchAction(u, { type: 'update_branch', branchId: String(b._id), currentName: 'גן להסבה', before: { kind: 'property' }, fields: { kind: 'daycare' } }); expect((await Branch.findById(b._id)).kind).toBe('daycare');
  });

  it('the AI result names the actual persisted payer when a concurrent edit linked a different live one', async () => {
    const { u } = await mk({ aiEnabled: true });
    const au = await mkAuthority(u._id);
    const thirdAu = await mkAuthority(u._id, { name: 'גוף שלישי חי' });
    const Authority = (await import('../src/models/Authority.js')).default;
    const spy = vi.spyOn(Authority, 'exists').mockImplementationOnce(async () => true).mockImplementationOnce(async () => null);
    const realUpdateOne = Branch.updateOne.bind(Branch);
    const interleave = vi.spyOn(Branch, 'updateOne').mockImplementationOnce(async (filter, update) => {
      await realUpdateOne({ _id: filter._id }, { $set: { authorityId: thirdAu._id } });
      return realUpdateOne(filter, update);
    });
    const { runBranchAction } = await import('../src/ai/branchActions.js');
    const r = await runBranchAction(u, { type: 'create_branch', fields: { name: 'גן שלישי', authorityId: String(au._id) }, authorityNames: { [String(au._id)]: au.name } });
    spy.mockRestore(); interleave.mockRestore();
    expect(r.payerLinkFailed).toBe(true);
    expect(r.persistedPayerName).toBe('גוף שלישי חי');
  });

  it('a branch that gained a dependent in the window is kept whole, only unlinked', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id);
    const Authority = (await import('../src/models/Authority.js')).default;
    const License = mongoose.model('License');
    // Pre-check passes; at the post-write verify a license already references the branch AND the payer is gone.
    const spy = vi.spyOn(Authority, 'exists').mockImplementationOnce(async () => true).mockImplementationOnce(async () => {
      const b = await Branch.findOne({ adminId: u._id, name: 'גן תלות' });
      await License.create({ branchId: b._id, licenseTypeId: new mongoose.Types.ObjectId(), issueDate: new Date(), expiryDate: new Date(), fileUrl: 'licenses/x.pdf', status: 'Valid', createdBy: u._id });
      return null;
    });
    const { createBranch } = await import('../src/controllers/branchController.js');
    const r = await call(createBranch, { user: u, body: { name: 'גן תלות', authorityId: String(au._id) } });
    spy.mockRestore();
    expect(r.code).toBe(201);
    expect(r.v.payerLinkFailed).toBe(true);
    const b = await Branch.findOne({ adminId: u._id, name: 'גן תלות' });
    expect(b).not.toBeNull(); // a branch with a dependent is never deleted
    expect(b.authorityId).toBeNull();
    expect(await License.countDocuments({ branchId: b._id })).toBe(1);
  });

  it('a crashed delete (claimed, links removed, authority left) recovers via the guard reconcile and a retried delete succeeds', async () => {
    const { u } = await mk({});
    const au = await mkAuthority(u._id, { deleting: true }); // crash after the claim
    const b = await Branch.create({ adminId: u._id, name: 'גן התאוששות', authorityId: au._id });
    // Crash window simulated: the unlink already ran, the deleteOne never did.
    await Branch.updateMany({ adminId: u._id, authorityId: au._id }, { $set: { authorityId: null } });
    const Authority = (await import('../src/models/Authority.js')).default;
    await Authority.collection.updateOne({ _id: au._id }, { $set: { updatedAt: new Date(Date.now() - 15 * 60 * 1000) } });
    const { reconcileAuthorityDeleteGuards, deleteAuthority } = await import('../src/controllers/rentController.js');
    await reconcileAuthorityDeleteGuards();
    expect((await Authority.findById(au._id)).deleting).toBe(false); // claim released: usable again
    expect((await Branch.findById(b._id)).authorityId).toBeNull(); // links stay truthful, nothing dangles
    expect((await call(deleteAuthority, { user: u, params: { id: String(au._id) } })).code).toBe(200); // retried delete succeeds
    expect(await Authority.findById(au._id)).toBeNull();
  });
});
