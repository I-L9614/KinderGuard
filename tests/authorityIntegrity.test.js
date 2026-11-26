import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer; let User; let Branch; let Authority; let RentAgreement;
let createAuthority; let deleteAuthority; let createAgreement; let reconcileAuthorityDeleteGuards;

const mk = async () => User.create({ name: `u${Math.random().toString(36).slice(2)}`, email: `ai-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Admin' });
const mkBranch = (u) => Branch.create({ adminId: u._id, name: `גן ${Math.random().toString(36).slice(2, 6)}` });
const mkAuthority = (u, extra = {}) => Authority.create({ adminId: u._id, name: `רשות ${Math.random().toString(36).slice(2, 6)}`, type: 'council', ...extra });

const call = (fn, req) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(v) { resolve({ code: this.code, v }); return this; } };
  fn(req, res).then((v) => resolve({ code: res.code, v })).catch((e) => resolve({ code: 500, e }));
});

// Gates the NEXT create() on the model: the caller is armed, something else
// runs to completion, and the release forces the exact crash/race ordering.
const pauseNextCreate = (model, { before = false } = {}) => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = model.create;
  const spy = vi.spyOn(model, 'create').mockImplementationOnce(async (...args) => {
    if (before) { entered(); await gate; return orig.apply(model, args); }
    const doc = await orig.apply(model, args); entered(); await gate; return doc;
  });
  return { release, enteredP, spy };
};

const pauseAfterNextFindOne = (model) => {
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const enteredP = new Promise((r) => { entered = r; });
  const orig = model.findOne;
  const spy = vi.spyOn(model, 'findOne').mockImplementationOnce((...args) => {
    const result = orig.apply(model, args);
    return Promise.resolve(result).then(async (doc) => { entered(); await gate; return doc; });
  });
  return { release, enteredP, spy };
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js'));
  ({ default: Branch } = await import('../src/models/Branch.js'));
  ({ default: Authority } = await import('../src/models/Authority.js'));
  ({ default: RentAgreement } = await import('../src/models/RentAgreement.js'));
  ({ createAuthority, deleteAuthority, createAgreement, reconcileAuthorityDeleteGuards } = await import('../src/controllers/rentController.js'));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('authority delete vs concurrent agreement creation (forced interleavings)', () => {
  it('an agreement insert racing a delete unwinds itself: 409, no agreement, authority gone', async () => {
    const u = await mk(); const b = await mkBranch(u); const auth = await mkAuthority(u);
    const g = pauseNextCreate(RentAgreement, { before: true });
    const cP = call(createAgreement, { user: u, body: { branchId: String(b._id), authorityId: String(auth._id) } });
    await g.enteredP; // validation passed, insert is about to run...
    const d = await call(deleteAuthority, { user: u, params: { id: String(auth._id) } }); // ...while the delete commits fully
    expect(d.code).toBe(200);
    g.release();
    const c = await cP;
    g.spy.mockRestore();
    expect(c.code).toBe(409);
    expect(String(c.v?.message || '')).toContain('נמחקה בינתיים');
    expect(await RentAgreement.countDocuments({ authorityId: auth._id })).toBe(0);
    expect(await Authority.findById(auth._id)).toBeNull();
  });

  it('a validation racing a delete that commits first also unwinds: no dangling agreement', async () => {
    const u = await mk(); const b = await mkBranch(u); const auth = await mkAuthority(u);
    const g = pauseAfterNextFindOne(Authority); // validateAgreementInput holds the pre-delete snapshot
    const cP = call(createAgreement, { user: u, body: { branchId: String(b._id), authorityId: String(auth._id) } });
    await g.enteredP;
    const d = await call(deleteAuthority, { user: u, params: { id: String(auth._id) } });
    expect(d.code).toBe(200);
    g.release();
    const c = await cP;
    g.spy.mockRestore();
    expect(c.code).toBe(409);
    expect(await RentAgreement.countDocuments({ authorityId: auth._id })).toBe(0);
  });

  it('an authority flagged for deletion refuses new agreements at validation', async () => {
    const u = await mk(); const b = await mkBranch(u); const auth = await mkAuthority(u, { deleting: true });
    const c = await call(createAgreement, { user: u, body: { branchId: String(b._id), authorityId: String(auth._id) } });
    expect(c.code).toBe(409);
    expect(String(c.v?.message || '')).toContain('בתהליך מחיקה');
    expect(await RentAgreement.countDocuments({ authorityId: auth._id })).toBe(0);
  });

  it('a refused delete (active agreement) releases the guard: authority not stuck deleting', async () => {
    const u = await mk(); const b = await mkBranch(u); const auth = await mkAuthority(u);
    const created = await call(createAgreement, { user: u, body: { branchId: String(b._id), authorityId: String(auth._id) } });
    expect(created.code).toBe(201);
    const d = await call(deleteAuthority, { user: u, params: { id: String(auth._id) } });
    expect(d.code).toBe(409);
    expect(String(d.v?.message || '')).toContain('הסכמי שכירות פעילים');
    const after = await Authority.findById(auth._id);
    expect(after.deleting).toBe(false);
    // A retry after closing is not blocked by a leftover guard.
    await RentAgreement.updateOne({ _id: created.v._id }, { $set: { status: 'Closed' } });
    const d2 = await call(deleteAuthority, { user: u, params: { id: String(auth._id) } });
    expect(d2.code).toBe(200);
  });

  it('a stale AI version pin fails closed through the claim, and the guard is not left behind', async () => {
    const u = await mk(); const auth = await mkAuthority(u);
    const d = await call(deleteAuthority, { user: u, params: { id: String(auth._id) }, expectedUpdatedAt: new Date(0) });
    expect(d.code).toBe(409);
    expect(String(d.v?.message || '')).toContain('הגוף השתנה');
    const after = await Authority.findById(auth._id);
    expect(after).not.toBeNull();
    expect(after.deleting).toBe(false);
  });

  it('a second delete while the guard is held is refused, and a stale guard from a crashed delete is released by the sweep', async () => {
    const u = await mk(); const auth = await mkAuthority(u, { deleting: true });
    const d = await call(deleteAuthority, { user: u, params: { id: String(auth._id) } });
    expect(d.code).toBe(409);
    expect(String(d.v?.message || '')).toContain('כבר מתבצעת');
    // Fresh guard survives the sweep; an old one (crashed delete) is released.
    await reconcileAuthorityDeleteGuards();
    expect((await Authority.findById(auth._id)).deleting).toBe(true);
    await Authority.updateOne({ _id: auth._id }, { $set: { updatedAt: new Date(Date.now() - 11 * 60 * 1000) } }, { timestamps: false });
    await reconcileAuthorityDeleteGuards();
    expect((await Authority.findById(auth._id)).deleting).toBe(false);
  });

  it('a created agreement stores denormalized branch and authority names for history', async () => {
    const u = await mk(); const b = await mkBranch(u); const auth = await mkAuthority(u);
    const created = await call(createAgreement, { user: u, body: { branchId: String(b._id), authorityId: String(auth._id) } });
    expect(created.code).toBe(201);
    const db = await RentAgreement.findById(created.v._id);
    expect(db.branchName).toBe(b.name);
    expect(db.authorityName).toBe(auth.name);
  });
});

describe('duplicate authority creation (forced concurrency)', () => {
  it('two concurrent identical creates: exactly one survives, the loser removes itself with 409', async () => {
    const u = await mk();
    const name = `עיריית ${Math.random().toString(36).slice(2, 6)}`;
    const g = pauseNextCreate(Authority); // B inserted, paused before its reconciliation
    const bP = call(createAuthority, { user: u, body: { name } });
    await g.enteredP;
    const a = await call(createAuthority, { user: u, body: { name } });
    g.release();
    const b = await bP;
    g.spy.mockRestore();
    const codes = [a.code, b.code].sort();
    expect(codes).toEqual([201, 409]);
    const all = await Authority.find({ adminId: u._id, name });
    expect(all).toHaveLength(1);
  });

  it('a sequential duplicate (manual route) is refused and nothing doubles', async () => {
    const u = await mk();
    const name = `מועצה ${Math.random().toString(36).slice(2, 6)}`;
    const first = await call(createAuthority, { user: u, body: { name } });
    expect(first.code).toBe(201);
    const second = await call(createAuthority, { user: u, body: { name: ` ${name} ` } }); // normalized match
    expect(second.code).toBe(409);
    expect(await Authority.countDocuments({ adminId: u._id })).toBe(1);
  });

  it('with the unique index built (post-migration mode), a concurrent duplicate is rejected by the index itself', async () => {
    await Authority.syncIndexes(); // simulates the approved migration having run
    const u = await mk();
    const name = `עיריית ${Math.random().toString(36).slice(2, 6)}`;
    const [a, b] = await Promise.all([
      call(createAuthority, { user: u, body: { name } }),
      call(createAuthority, { user: u, body: { name } }),
    ]);
    expect([a.code, b.code].sort()).toEqual([201, 409]);
    expect(await Authority.countDocuments({ adminId: u._id, name })).toBe(1);
    const survivor = await Authority.findOne({ adminId: u._id, name });
    expect(survivor.nameKey).toBeTruthy();
  });
});
