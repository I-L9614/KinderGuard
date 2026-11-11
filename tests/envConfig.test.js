// The packaged desktop app reads its .env from the per-user data folder
// (KINDERGUARD_CONFIG_DIR), never from inside the install directory, so app
// updates cannot overwrite it.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const created = [];

afterEach(() => {
  delete process.env.KINDERGUARD_CONFIG_DIR;
  delete process.env.MONGO_URI;
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe('desktop config location', () => {
  it('loads .env from KINDERGUARD_CONFIG_DIR when present there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-cfg-'));
    created.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), 'MONGO_URI=mongodb://from-config-dir\nJWT_SECRET=cfg-secret\nS3_BUCKET_NAME=b\nS3_REGION=r\n');
    process.env.KINDERGUARD_CONFIG_DIR = dir;
    await import('../src/config/env.js?case=config-dir');
    expect(process.env.MONGO_URI).toBe('mongodb://from-config-dir');
  });
});
