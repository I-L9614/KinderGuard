// @vitest-environment node
// Port-conflict regression: when the app's port is already taken, startServer
// must reject with EADDRINUSE so the Electron startup flow can show the Hebrew
// startup-error dialog, instead of an unhandled server 'error' event crashing
// the main process. One server import per file (mongoose models register once).
import { describe, it, expect, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import net from 'net';
import os from 'os';

const TEST_PORT = 4124;

describe('port already in use', () => {
  let mongo;
  let blocker;

  afterAll(async () => {
    if (blocker) blocker.close();
    if (mongo) await mongo.stop();
  });

  it('startServer rejects with EADDRINUSE instead of crashing', async () => {
    process.env.KINDERGUARD_CONFIG_DIR = os.tmpdir();
    process.env.PORT = String(TEST_PORT);
    mongo = await MongoMemoryServer.create();
    process.env.MONGO_URI = mongo.getUri();
    process.env.JWT_SECRET = 'test-secret';
    blocker = net.createServer();
    await new Promise((r) => blocker.listen(TEST_PORT, '127.0.0.1', r));
    const mod = await import('../src/server.js');
    await expect(mod.startServer()).rejects.toMatchObject({ code: 'EADDRINUSE' });
  }, 30000);
});
