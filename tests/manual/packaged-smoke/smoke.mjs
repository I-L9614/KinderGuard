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
import os from 'os';

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

// productName drives the userData folder name; assert the asar exists and the
// name/version match the source package.json, so the config location we tell
// the user is computed, not assumed. (Electron resolves the app name from
// productName in both dev and packaged runs - verified with a real launch.)
const resources = path.resolve('dist', 'win-unpacked', 'resources');
const packed = fs.existsSync(path.join(resources, 'app.asar')) ? 'app.asar' : (fs.existsSync(path.join(resources, 'app')) ? 'app' : null);
if (!packed) fail('no app.asar or app/ in the packaged resources');
// electron-builder reads the app name from build.productName (falling back to
// the top-level productName), and Electron uses it for the userData folder.
const srcPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const productName = srcPkg.build?.productName || srcPkg.productName || srcPkg.name;
if (productName !== 'KinderGuard') fail(`unexpected productName: ${productName}`);
ok(`packaged ${packed}, productName=${productName} version=${srcPkg.version} (userData = %APPDATA%\\KinderGuard)`);

// First-launch regression (the v0.2.4 crash): with NO .env anywhere, the
// packaged app must reach the Hebrew setup dialog instead of dying with an
// uncaught "Missing required environment variables" in the main process. The
// dialog path writes a marker file; the old crash never produced one.
const userData = path.join(process.env.APPDATA, 'KinderGuard');
fs.mkdirSync(userData, { recursive: true });
const envFile = path.join(userData, '.env');
const firstRunMarker = path.join(userData, '.first-run-setup-shown');
const envBackup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
fs.rmSync(envFile, { force: true });
fs.rmSync(firstRunMarker, { force: true });
const firstRun = spawn(exe, [], { stdio: 'ignore' });
let markerSeen = false;
for (let i = 0; i < 15 && !markerSeen; i++) {
  await sleep(2000);
  if (firstRun.exitCode !== null) break;
  markerSeen = fs.existsSync(firstRunMarker);
}
firstRun.kill();
await sleep(1000);
if (!markerSeen) fail('first launch without .env did not reach the setup dialog (uncaught startup crash?)');
ok('first launch without .env reaches the Hebrew setup dialog (no uncaught env crash)');

// Bad-config regression: a .env that IS present but points at an unreachable
// MongoDB must land in the Hebrew startup-error dialog (marker file), not in
// an uncaught crash. Port 9 (discard) refuses fast, but mongoose still waits
// out its server-selection timeout, so allow up to 90s.
const badMarker = path.join(userData, '.startup-error-shown');
fs.rmSync(badMarker, { force: true });
fs.writeFileSync(envFile, 'MONGO_URI=mongodb://127.0.0.1:9/kg-smoke\nJWT_SECRET=smoke-secret\n');
const badRun = spawn(exe, [], { stdio: 'ignore' });
let badMarkerSeen = false;
for (let i = 0; i < 45 && !badMarkerSeen; i++) {
  await sleep(2000);
  if (badRun.exitCode !== null) break;
  badMarkerSeen = fs.existsSync(badMarker);
}
badRun.kill();
await sleep(1000);
if (!badMarkerSeen) fail('bad .env did not reach the Hebrew startup-error dialog');
ok('present-but-bad .env reaches the Hebrew startup-error dialog (graceful failure)');
fs.rmSync(badMarker, { force: true });

const mongo = await MongoMemoryServer.create();
const backup = envBackup;
for (const m of ['.bridge-ok', '.bridge-missing', '.preload-error', '.update-state']) fs.rmSync(path.join(userData, m), { force: true });
fs.writeFileSync(envFile, `MONGO_URI=${mongo.getUri()}\nJWT_SECRET=smoke-secret\n`);
ok('dummy .env written to the real userData folder (no S3 on purpose)');

let child;
try {
  // Capture the app's own console so a smoke failure can show the cause
  // (e.g. an electron-updater load error) instead of a bare marker absence.
  const appLog = path.join(os.tmpdir(), 'kg-smoke-app.log');
  fs.rmSync(appLog, { force: true });
  // A numeric fd works cross-platform; a WriteStream is rejected on Windows.
  const appLogFd = fs.openSync(appLog, 'w');
  child = spawn(exe, [], { stdio: ['ignore', appLogFd, appLogFd] });
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

  // Real Electron preload bridge (the v0.2.4 installed-app regression: an ESM
  // preload silently never loaded, so window.electronAPI was missing and the
  // notification self-test button refused to run). main.js writes a marker
  // after probing the real renderer window.
  // The window load (and therefore the bridge marker) can legitimately lag
  // the HTTP probes while the main process does startup work, so poll for the
  // marker instead of checking once.
  let bridgeSeen = false;
  for (let i = 0; i < 30 && !bridgeSeen; i++) {
    if (fs.existsSync(path.join(userData, '.preload-error'))) fail('preload script failed to load: ' + fs.readFileSync(path.join(userData, '.preload-error'), 'utf8'));
    if (fs.existsSync(path.join(userData, '.bridge-missing'))) fail('window.electronAPI missing in the packaged renderer');
    bridgeSeen = fs.existsSync(path.join(userData, '.bridge-ok'));
    if (!bridgeSeen) await sleep(2000);
  }
  if (!bridgeSeen) {
    const appLogTail = fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8').split('\n').filter((l) => /electron-updater|[Pp]reload|bridge/i.test(l)).slice(-10).join('\n') : '(no app log)';
    fail('bridge self-check never reported within 60s. App log hints:\n' + appLogTail);
  }
  ok('real Electron preload bridge verified in the packaged renderer (window.electronAPI present)');

  // Updater actually loaded in the packaged runtime: the controller writes
  // its initial state to .update-state, and 'disabled' in a packaged build
  // means the update button is hidden (the pre-0.2.6 ESM-import regression).
  if (!fs.existsSync(path.join(userData, '.update-state'))) fail('update state marker missing (setupUpdates never ran?)');
  const updateState = fs.readFileSync(path.join(userData, '.update-state'), 'utf8').trim();
  if (updateState === 'disabled') fail('update controller is disabled in the packaged app - updater failed to load');
  ok(`update controller live in the packaged app (initial state: ${updateState})`);

  // Loopback-only bind (desktop context): the server must answer on IPv4
  // loopback (what the renderer uses) and refuse the machine's LAN address -
  // no inbound listener for the Windows firewall to prompt about.
  try {
    const v4 = await fetch('http://127.0.0.1:4000/health', { signal: AbortSignal.timeout(5000) });
    if (!v4.ok) fail('server answered 127.0.0.1 with a non-OK status');
  } catch { fail('server is not reachable on 127.0.0.1'); }
  const lan = (() => { for (const list of Object.values(os.networkInterfaces())) { for (const item of list || []) { if (item.family === 'IPv4' && !item.internal) return item.address; } } return null; })();
  if (lan) {
    let lanAnswered = false;
    try { await fetch(`http://${lan}:4000/health`, { signal: AbortSignal.timeout(5000) }); lanAnswered = true; } catch {}
    if (lanAnswered) fail(`server is reachable on the LAN address ${lan} - expected loopback-only in desktop context`);
    ok('server bound to loopback only (LAN address refused, no inbound-firewall listener)');
  } else {
    ok('server answers on 127.0.0.1 (no LAN interface found to test refusal)');
  }

  console.log('SMOKE_PASSED');
} finally {
  if (child && child.exitCode === null) {
    spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
  }
  if (backup) fs.writeFileSync(envFile, backup); else fs.rmSync(envFile, { force: true });
  await mongo.stop();
}
process.exit(0);
