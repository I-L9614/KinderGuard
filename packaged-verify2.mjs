import { MongoMemoryServer } from 'mongodb-memory-server';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const home = os.homedir();
const userData = path.join(home, '.config', 'KinderGuard');
fs.mkdirSync(userData, { recursive: true });
const mongo = await MongoMemoryServer.create();
fs.writeFileSync(path.join(userData, '.env'), `MONGO_URI=${mongo.getUri()}\nJWT_SECRET=verify-test\n`);

const child = spawn('xvfb-run', ['-a', '/tmp/kinderguard/node_modules/.bin/electron', '/tmp/artx/app-fixed.asar'], {
  cwd: '/tmp/artx', stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 25; i++) {
  await sleep(2000);
  if (fs.existsSync(path.join(userData, '.update-state'))) break;
}
await sleep(3000);
child.kill('SIGKILL');
await mongo.stop();
const interesting = out.split('\n').filter((l) => /electron-updater|MongoDB connected|listening|startup failed|Preload|bridge/i.test(l));
console.log('LOG LINES:', interesting.join(' | ') || '(none)');
for (const m of ['.update-state', '.bridge-ok', '.bridge-missing', '.preload-error']) {
  const p = path.join(userData, m);
  console.log(m, '=>', fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : 'ABSENT');
}
process.exit(0);
