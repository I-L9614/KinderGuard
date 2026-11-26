import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoServer; let createMongoLedger; let AiUsage;
beforeAll(async () => {
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
  ({ createMongoLedger } = await import('../src/ai/aiLedger.js'));
  ({ default: AiUsage } = await import('../src/models/AiUsage.js'));
  await AiUsage.init();
}, 600000);
afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('persistent AI ledger', () => {
  it('concurrent reservations never exceed the budget', async () => {
    await AiUsage.deleteMany({});
    const ledger = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 1000 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => ledger.reserve(0.1)));
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(10);
    expect(await ledger.spent()).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('settle corrects to actual cost and the total survives a new ledger instance (restart)', async () => {
    await AiUsage.deleteMany({});
    const a = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 10 });
    const r = await a.reserve(0.5); await a.settle(r, 0.01);
    const b = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 10 });
    expect(await b.spent()).toBeCloseTo(0.01);
  });
  it('enforceBudget=false drops only the dollar cap: spend is still tracked and the daily call limit still holds', async () => {
    await AiUsage.deleteMany({});
    const l = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 15, enforceBudget: false });
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => l.reserve(0.1)));
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(15);
    expect(res.find((r) => r.status === 'rejected').reason.message).toMatch(/מכסת הקריאות היומית/);
    expect(await l.spent()).toBeCloseTo(1.5);
    const strict = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 1000 });
    await expect(strict.reserve(0.1)).rejects.toMatchObject({ statusCode: 429 });
  });
  it('enforceDaily=false drops only the daily call quota: calls are still counted and the dollar cap still holds', async () => {
    await AiUsage.deleteMany({});
    const l = createMongoLedger({ budgetUsd: 100, dailyCallLimit: 3, enforceDaily: false });
    const res = await Promise.allSettled(Array.from({ length: 10 }, () => l.reserve(0.1)));
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await AiUsage.findOne({ key: 'ledger' })).calls).toBe(10);
    const both = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 3, enforceBudget: false, enforceDaily: false });
    await expect(both.reserve(50)).resolves.toBeTruthy();
    const capped = createMongoLedger({ budgetUsd: 1, dailyCallLimit: 3, enforceDaily: false });
    await expect(capped.reserve(0.1)).rejects.toMatchObject({ statusCode: 429 });
  });
  it('daily limit holds under concurrency and a refusal changes nothing (single atomic update)', async () => {
    await AiUsage.deleteMany({});
    const l = createMongoLedger({ budgetUsd: 100, dailyCallLimit: 5 });
    const res = await Promise.allSettled(Array.from({ length: 30 }, () => l.reserve(0.1)));
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(5);
    expect(res.find((r) => r.status === 'rejected').reason.message).toMatch(/מכסת הקריאות היומית/);
    const doc = await AiUsage.findOne({ key: 'ledger' });
    expect(doc.calls).toBe(5); expect(doc.spentUsd).toBeCloseTo(0.5);
    await AiUsage.deleteMany({});
    const l2 = createMongoLedger({ budgetUsd: 0.05, dailyCallLimit: 2 });
    await expect(l2.reserve(0.1)).rejects.toThrow(/תקציב השימוש/);
    const d2 = await AiUsage.findOne({ key: 'ledger' });
    expect(d2.calls).toBe(0); expect(d2.spentUsd).toBe(0); // refusal took no slot and no spend
  });
  it('rolls the daily counter over at midnight inside the same update, keeping lifetime spend', async () => {
    await AiUsage.deleteMany({});
    let d = new Date('2026-11-26T10:00:00Z');
    const l = createMongoLedger({ budgetUsd: 10, dailyCallLimit: 1, now: () => d });
    await l.reserve(0.5);
    await expect(l.reserve(0.5)).rejects.toThrow(/מכסת הקריאות היומית/);
    d = new Date('2026-11-27T10:00:00Z');
    await l.reserve(0.5);
    const doc = await AiUsage.findOne({ key: 'ledger' });
    expect(doc.calls).toBe(1); expect(doc.day).toBe('2026-11-27'); expect(doc.spentUsd).toBeCloseTo(1);
  });
  it('settle is idempotent in Mongo too: a second settle changes nothing', async () => {
    await AiUsage.deleteMany({});
    const l = createMongoLedger({ budgetUsd: 10, dailyCallLimit: 10 });
    const r = await l.reserve(1);
    const [a, b] = await Promise.all([l.settle(r, 0.2), l.settle(r, 0.2)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(await l.spent()).toBeCloseTo(0.2);
  });
});
