// @vitest-environment node
// Bind-host regression for the desktop app: in desktop context
// (KINDERGUARD_CONFIG_DIR set by electron/main.js) the embedded server must
// listen on IPv4 loopback only, so Windows shows no inbound-firewall prompt
// and the LAN cannot reach the API. resolveBindHost owns the policy; this
// file proves the policy and the real desktop bind. The port-conflict case
// lives in serverPortConflict.test.js (one server import per file).
import { describe, it, expect, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import os from 'os';

const TEST_PORT = 4123;

// server.js resolves its bind host and env.js validates required vars at
// import time, so the desktop context must be in place before the first
// import in this file. The integration test swaps in the real MongoMemoryServer
// URI later - db.js reads MONGO_URI when connectDB runs, not at import.
process.env.KINDERGUARD_CONFIG_DIR = os.tmpdir();
process.env.PORT = String(TEST_PORT);
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/kg-bind-unused';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const lanAddress = () => {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return null;
};

const reachable = async (host) => {
  try {
    const res = await fetch(`http://${host}:${TEST_PORT}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
};

describe('resolveBindHost policy', () => {
  it('defaults to 127.0.0.1 in desktop context', async () => {
    const { resolveBindHost } = await import('../src/server.js');
    expect(resolveBindHost({ KINDERGUARD_CONFIG_DIR: '/x' })).toBe('127.0.0.1');
  });
  it('keeps all interfaces (undefined host) for standalone/web runs', async () => {
    const { resolveBindHost } = await import('../src/server.js');
    expect(resolveBindHost({})).toBeUndefined();
  });
  it('explicit HOST wins everywhere', async () => {
    const { resolveBindHost } = await import('../src/server.js');
    expect(resolveBindHost({ KINDERGUARD_CONFIG_DIR: '/x', HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('desktop-context server bind (real listen)', () => {
  let mongo;
  let mod;

  afterAll(async () => {
    if (mod) await mod.stopServer();
    if (mongo) await mongo.stop();
  });

  it('is reachable on 127.0.0.1 but not on the LAN address', async () => {
    mongo = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongo.getUri();
    mod = await import('../src/server.js');
    await mod.startServer();
    expect(await reachable('127.0.0.1')).toBe(true);
    const lan = lanAddress();
    if (lan) expect(await reachable(lan)).toBe(false);
  }, 30000);
});
