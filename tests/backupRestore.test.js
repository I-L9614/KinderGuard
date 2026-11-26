import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { dumpTo, restoreFrom } from '../scripts/backup.mjs';

let mongoServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  const downloadDir = path.resolve(process.cwd(), '.cache', 'mongodb-memory-server');
  process.env.MONGOMS_DOWNLOAD_DIR = downloadDir;
  mongoServer = await MongoMemoryServer.create({ binary: { version: '8.2.6', downloadDir } });
  await mongoose.connect(mongoServer.getUri());
}, 600000);

afterAll(async () => { await mongoose.disconnect(); if (mongoServer) await mongoServer.stop(); });

describe('backup and restore', () => {
  it('a dump restores every collection with ids and dates intact', async () => {
    const db = mongoose.connection.db;
    const branch = await db.collection('branches').insertOne({
      name: 'סניף בדיקה', address: 'רחוב הבדיקה 1', createdAt: new Date('2026-11-01T10:00:00Z'),
    });
    await db.collection('users').insertOne({
      name: 'מנהל בדיקה', email: 'backup-test@example.com', role: 'Admin', createdAt: new Date(),
    });

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-backup-'));
    const dumped = await dumpTo(dir);
    expect(dumped.branches).toBe(1);
    expect(dumped.users).toBe(1);

    // Disaster: both collections are wiped.
    await db.collection('branches').deleteMany({});
    await db.collection('users').deleteMany({});
    expect(await db.collection('branches').countDocuments()).toBe(0);

    const restored = await restoreFrom(dir);
    expect(restored.branches).toBe(1);

    const back = await db.collection('branches').findOne({ name: 'סניף בדיקה' });
    expect(String(back._id)).toBe(String(branch.insertedId));
    expect(back.createdAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    expect(await db.collection('users').countDocuments({ email: 'backup-test@example.com' })).toBe(1);
  });
});
