// Packaged-app smoke test for CI (windows-latest), no secrets involved.
//
// Proves what unit tests cannot: the actual packaged KinderGuard.exe starts,
// finds its .env in the per-user data folder (%APPDATA%\KinderGuard), starts
// the embedded server, and serves the UI - with a throwaway in-memory MongoDB
// and NO S3 config (S3 must not block the app).
//
// Run from the repo root after `npx electron-builder --win nsis --publish never`:
//   node tests/manual/packaged-smoke/smoke.mjs
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';

const fail = (msg) => { console.error('SMOKE FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('smoke ok: ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const exe = path.resolve('dist', 'win-unpacked', 'KinderGuard.exe');
if (!fs.existsSync(exe)) fail('packaged exe not found at ' + exe);

// The packaged app's update config must ship inside the build.
const updateCfg = path.resolve('dist', 'win-unpacked', 'resources', 'app-update.yml');
if (!fs.existsSync(updateCfg)) fail('app-update.yml missing from the packaged resources');
const cfgText = fs.readFileSync(updateCfg, 'utf8');
if (!cfgText.includes('I-L9614') || !cfgText.includes('KinderGuard')) fail('app-update.yml does not point at I-L9614/KinderGuard: ' + cfgText);
ok('app-update.yml present and points at I-L9614/KinderGuard');

// productName drives the userData folder name; assert it so the config
// location we tell the user is computed, not assumed.
const appPkg = JSON.parse(fs.readFileSync(path.resolve('dist', 'win-unpacked', 'resources', 'app', 'package.json'), 'utf8'));
if (appPkg.productName !== 'KinderGuard' || appPkg.version !== JSON.parse(fs.readFileSync('package.json', 'utf8')).version) {
  fail(`packaged productName/version mismatch: ${appPkg.productName} ${appPkg.version}`);
}
ok(`packaged productName=${appPkg.productName} version=${appPkg.version} (userData = %APPDATA%\\KinderGuard)`);

const mongo = await MongoMemoryServer.create();
const userData = path.join(process.env.APPDATA, 'KinderGuard');
fs.mkdirSync(userData, { recursive: true });
const envFile = path.join(userData, '.env');
const backup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
fs.writeFileSync(envFile, `MONGO_URI=${mongo.getUri()}\nJWT_SECRET=smoke-secret\n`);
ok('dummy .env written to the real userData folder (no S3 on purpose)');

let child;
try {
  child = spawn(exe, [], { stdio: 'ignore' });
  let healthy = false;
  let uiServed = false;
  for (let i = 0; i < 60 && !healthy; i++) {
    await sleep(2000);
    if (child.exitCode !== null) fail(`packaged app exited early with code ${child.exitCode}`);
    try {
      const res = await fetch('http://localhost:4000/health');
      if (res.ok) healthy = true;
    } catch {}
  }
  if (!healthy) fail('packaged app did not answer /health within 120s');
  ok('packaged app started and its embedded server answers /health');

  const res = await fetch('http://localhost:4000/');
  const html = await res.text();
  uiServed = res.ok && html.includes('KinderGuard');
  if (!uiServed) fail('packaged app is not serving the UI at /');
  ok('packaged app serves the UI');

  console.log('SMOKE_PASSED');
} finally {
  if (child && child.exitCode === null) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
  }
  if (backup) fs.writeFileSync(envFile, backup); else fs.rmSync(envFile, { force: true });
  await mongo.stop();
}
process.exit(0);
