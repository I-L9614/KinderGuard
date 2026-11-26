import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { sanitizeProposal } from '../src/ai/licenseExtract.js';

const NAMES = ['אישור בטיחות', 'כיבוי אש שנתי'];
describe('sanitizeProposal', () => {
  it('accepts a clean reply', () => {
    const r = sanitizeProposal('{"licenseType":"אישור בטיחות","issueDate":"2026-01-05","expiryDate":"2027-01-05","documentBranch":"גן א","note":""}', NAMES);
    expect(r).toMatchObject({ licenseType: 'אישור בטיחות', issueDate: '2026-01-05', expiryDate: '2027-01-05', unclear: [] });
  });
  it('strips code fences and flags missing or invalid values instead of guessing', () => {
    const r = sanitizeProposal('```json\n{"licenseType":"סוג אחר","issueDate":"2026-13-40","expiryDate":null}\n```', NAMES);
    expect(r.licenseType).toBeNull(); expect(r.issueDate).toBeNull(); expect(r.expiryDate).toBeNull();
    expect(r.unclear).toEqual(['licenseType', 'issueDate', 'expiryDate', 'documentBranch']);
  });
  it('drops both dates when expiry precedes issue', () => {
    const r = sanitizeProposal('{"licenseType":"כיבוי אש שנתי","issueDate":"2026-05-01","expiryDate":"2025-05-01"}', NAMES);
    expect(r.unclear).toEqual(['issueDate', 'expiryDate', 'documentBranch']);
  });
  it('document branch is extracted text only: kept when present, flagged unclear when missing, never assigned', () => {
    const miss = sanitizeProposal('{"licenseType":"אישור בטיחות","issueDate":"2026-01-05","expiryDate":"2027-01-05","documentBranch":null,"note":""}', NAMES);
    expect(miss.unclear).toEqual(['documentBranch']); expect(miss).not.toHaveProperty('branchId');
    const hit = sanitizeProposal('{"licenseType":"אישור בטיחות","issueDate":"2026-01-05","expiryDate":"2027-01-05","documentBranch":"גן הדוגמה","note":""}', NAMES);
    expect(hit.unclear).toEqual([]); expect(hit.documentBranch).toBe('גן הדוגמה'); expect(hit).not.toHaveProperty('branchId');
  });
  it('garbage becomes an all-unclear proposal', () => {
    expect(sanitizeProposal('not json', NAMES).unclear.length).toBe(4);
  });
});

let app; let mongoServer; let User; let ask;
const tokenFor = async (aiEnabled) => {
  const jwt = (await import('jsonwebtoken')).default;
  const u = await User.create({ name: `x-${Math.random().toString(36).slice(2)}`, email: `a-${Math.random().toString(36).slice(2)}@e.com`, password: 'Password123', role: 'Manager', aiEnabled });
  return jwt.sign({ id: u._id }, process.env.JWT_SECRET, { algorithm: 'HS256' });
};
const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(40, 1)]);

beforeAll(async () => {
  process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'test-secret';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ default: User } = await import('../src/models/User.js'));
  const { createAiRouter } = await import('../src/ai/aiRoutes.js');
  ask = vi.fn(async () => ({ text: '{"licenseType":"אישור בטיחות","issueDate":"2026-01-05","expiryDate":null}', costUsd: 0.001 }));
  app = express(); app.use(express.json()); app.use('/api/ai', createAiRouter({ client: { ask } }));
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('POST /api/ai/license-extract', () => {
  const post = (t, consent = true) => { const r = request(app).post('/api/ai/license-extract').set('Authorization', `Bearer ${t}`); return consent ? r.field('consentExternal', 'true') : r; };
  it('401 without login and 403 without aiEnabled, model never called', async () => {
    await request(app).post('/api/ai/license-extract').expect(401);
    const t = await tokenFor(false);
    await post(t).field('typeNames', JSON.stringify(NAMES)).attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(403);
    expect(ask).not.toHaveBeenCalled();
  });
  it('returns a proposal with unclear fields and sends the file as a document block', async () => {
    const t = await tokenFor(true);
    const r = await post(t).field('typeNames', JSON.stringify(NAMES)).attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(200);
    expect(r.body).toMatchObject({ licenseType: 'אישור בטיחות', issueDate: '2026-01-05', expiryDate: null });
    const arg = ask.mock.calls[0][0];
    expect(arg.content[0].type).toBe('document'); expect(arg.maxOutput).toBe(1500);
  });
  it('rejects a spoofed file type, missing file and bad type list without calling the model', async () => {
    const t = await tokenFor(true); ask.mockClear();
    await post(t).field('typeNames', JSON.stringify(NAMES)).attach('file', Buffer.from('MZ not a pdf at all......'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(400);
    await post(t).field('typeNames', JSON.stringify(NAMES)).expect(400);
    await post(t).field('typeNames', 'nope').attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(400);
    expect(ask).not.toHaveBeenCalled();
  });
  it('model failure surfaces as an error, nothing proposed', async () => {
    const t = await tokenFor(true); ask.mockRejectedValueOnce(Object.assign(new Error('AI budget reached'), { statusCode: 429 }));
    const r = await post(t).field('typeNames', JSON.stringify(NAMES)).attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(429);
    expect(r.body.message).toBe('AI budget reached');
  });
  it('without explicit send consent the model is never called', async () => {
    const t = await tokenFor(true); ask.mockClear();
    const r = await post(t, false).field('typeNames', JSON.stringify(NAMES)).attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' }).expect(400);
    expect(r.body.code).toBe('consent_required'); expect(ask).not.toHaveBeenCalled();
  });
});
