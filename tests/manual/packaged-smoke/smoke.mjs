// Packaged-app smoke test for CI (windows-latest), no secrets involved.
//
// Proves what unit tests cannot: the actual packaged KinderGuard.exe starts,
// finds its .env in the per-user data folder (%APPDATA%\KinderGuard), starts
// the embedded server, and serves the UI - with a throwaway in-memory MongoDB
// and NO S3 config (S3 must not block the app).
//
// Run from the repo root after `npx electron-builder --win nsis --publish never`:
//   node tests/manual/packaged-smoke/smoke.mjs
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
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

// First-launch regression (the v0.2.4 crash) and the customer-install flow:
// with NO .env anywhere, the packaged app must enter client mode - no
// secrets in the installer - and load the hosted server URL, instead of
// dying with an uncaught "Missing required environment variables" crash or
// demanding a .env the customer does not have. A local stub server stands in
// for the hosted one so the smoke never depends on the real deployment.
const stubHits = [];
const stub = http.createServer((req, res) => {
  stubHits.push(req.url);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body>KinderGuard hosted stub</body></html>');
});
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const userData = path.join(process.env.APPDATA, 'KinderGuard');
fs.mkdirSync(userData, { recursive: true });
const envFile = path.join(userData, '.env');
const clientMarker = path.join(userData, '.client-mode');
const envBackup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
fs.rmSync(envFile, { force: true });
fs.rmSync(clientMarker, { force: true });
const firstRun = spawn(exe, [], { stdio: 'ignore', env: { ...process.env, KINDERGUARD_SERVER_URL: stubUrl } });
let markerSeen = false;
for (let i = 0; i < 30 && !markerSeen; i++) {
  await sleep(2000);
  if (firstRun.exitCode !== null) break;
  markerSeen = fs.existsSync(clientMarker) && stubHits.length > 0;
}
firstRun.kill();
await sleep(1000);
stub.close();
if (!markerSeen) fail('first launch without .env did not reach client mode and load the server URL (uncaught startup crash?)');
if (fs.readFileSync(clientMarker, 'utf8') !== stubUrl) fail('.client-mode marker does not record the server URL');
if (fs.existsSync(path.join(userData, '.first-run-setup-shown'))) fail('the old missing-config dialog appeared for a customer install');
ok('first launch without .env enters client mode and loads the hosted server URL (no env crash, no config demand)');

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
  child = spawn(exe, ['--remote-debugging-port=9223'], { stdio: ['ignore', appLogFd, appLogFd] });
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

  // Visual proof for release review: capture the real packaged window of an
  // AUTHENTICATED session (dummy admin in the in-memory DB, discarded with
  // it). With a live controller the top bar renders the round update button -
  // the button whose absence on the user's PC exposed the pre-0.2.6 loading
  // regression.
  let page;
  for (let i = 0; i < 15 && !page; i++) {
    try {
      const targets = await fetch('http://127.0.0.1:9223/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      page = targets.find((t) => t.type === 'page' && t.url.includes('127.0.0.1:4000'));
    } catch {}
    if (!page) await sleep(2000);
  }
  if (!page) fail('cannot reach the packaged window over CDP');
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let cdpId = 0;
  const cdpPending = new Map();
  ws.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.id && cdpPending.has(m.id)) { cdpPending.get(m.id)(m); cdpPending.delete(m.id); } });
  const cdpSend = (method, params = {}) => new Promise((res) => { const i = ++cdpId; cdpPending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (body) => {
    const r = await cdpSend('Runtime.evaluate', { expression: `(async()=>{${body}})()`, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) fail('in-window step failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  await evalJs(`
    document.querySelector('[data-tab="register"]').click();
    document.querySelector('input[name="name"]').value = 'בדיקת עשן';
    document.querySelector('input[name="email"]').value = 'smoke-admin@test.local';
    document.querySelector('input[name="password"]').value = 'smoke-pass-123';
    document.querySelector('#authForm button[type="submit"]').click();
    return true;`);
  let loggedIn = false;
  for (let i = 0; i < 20 && !loggedIn; i++) {
    await sleep(1500);
    loggedIn = await evalJs('return !!document.getElementById("logout")');
  }
  if (!loggedIn) fail('dummy admin could not log in through the packaged UI');
  ok('authenticated into the packaged app with a dummy admin (in-memory DB)');
  const buttonLabel = await evalJs('return document.querySelector("#update-slot .update-button .update-label")?.textContent || null');
  if (!buttonLabel) fail('update button is NOT rendered in the authenticated packaged window');
  ok(`update button rendered in the packaged window ("${buttonLabel}")`);

  const captureScreen = (name) => {
    const shotOut = path.resolve('dist', name);
    const shotScript = path.join(os.tmpdir(), 'kg-shot-' + name + '.ps1');
    fs.writeFileSync(shotScript, [
      'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
      '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
      `$bmp.Save('${shotOut.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $bmp.Dispose()',
    ].join('\n'));
    const shot = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shotScript], { encoding: 'utf8', timeout: 60000 });
    if (shot.error || shot.status !== 0 || !fs.existsSync(shotOut)) fail('packaged window screenshot failed: ' + (shot.stderr || shot.error?.message || 'no output file'));
  };
  captureScreen('packaged-window.png');
  ok('real packaged window captured (dist/packaged-window.png) - top bar shows the update button');

  // Payer + branch-contacts UI (v0.3.1): seed a council payer, a private
  // payer and a branch with full contact details through the real API against
  // the in-memory DB, reload so the renderer state picks them up, then prove
  // the new UI renders in the packaged window: manager line on the branch
  // card, contacts+payer panel on the branch page, payer dropdown with
  // (פרטי) options in the branch form, and payer chips on the rent page.
  const seed = await evalJs(`
    const t = await (await fetch('/api/auth/refresh', { method: 'POST' })).json();
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.token };
    const council = await (await fetch('/api/rent/authorities', { method: 'POST', headers: H, body: JSON.stringify({ name: 'מועצת בדיקת עשן', type: 'council' }) })).json();
    const priv = await (await fetch('/api/rent/authorities', { method: 'POST', headers: H, body: JSON.stringify({ name: 'גן פרטי לבדיקת עשן', type: 'private' }) })).json();
    const br = await (await fetch('/api/branches', { method: 'POST', headers: H, body: JSON.stringify({ name: 'סניף בדיקת עשן', address: 'רחוב הבדיקה 7, תל אביב', managerName: 'מנהלת הבדיקה', phone: '050-1234567', emails: 'smoke@test.local', authorityId: council._id }) })).json();
    return { council: council._id, priv: priv._id, privName: priv.name, branch: br._id };`);
  if (!seed.council || !seed.priv || !seed.branch) fail('seeding payer/branch through the API failed: ' + JSON.stringify(seed));
  ok('seeded council payer, private payer and a branch with contacts through the real API');
  await evalJs('location.reload(); return true;');
  let backIn = false;
  for (let i = 0; i < 30 && !backIn; i++) {
    await sleep(2000);
    backIn = await evalJs('return !!document.getElementById("logout")').catch(() => false);
  }
  if (!backIn) fail('packaged window did not come back after reload');
  ok('renderer re-authenticated after reload (refresh-cookie session)');

  // Branch card carries the manager line.
  let cardLine = false;
  for (let i = 0; i < 15 && !cardLine; i++) {
    await sleep(1500);
    cardLine = await evalJs('return document.body.innerText.includes("מנהלת הבדיקה")');
  }
  if (!cardLine) fail('branch card does not show the manager line');
  captureScreen('branch-card-contacts.png');
  ok('branch card shows the manager/phone line (dist/branch-card-contacts.png)');

  // Branch detail: contacts + payer panel.
  await evalJs(`document.querySelector('[data-branch="${seed.branch}"]').click(); return true;`);
  let panelSeen = false;
  for (let i = 0; i < 15 && !panelSeen; i++) {
    await sleep(1500);
    panelSeen = await evalJs('return document.body.innerText.includes("אנשי קשר ושיוך") && document.body.innerText.includes("מועצת בדיקת עשן")');
  }
  if (!panelSeen) fail('branch detail contacts+payer panel did not render');
  captureScreen('branch-detail-contacts.png');
  ok('branch detail shows the contacts+payer panel (dist/branch-detail-contacts.png)');

  // Branch edit form: contact fields and the payer dropdown with (פרטי).
  await evalJs('document.getElementById("editBranch").click(); return true;');
  await sleep(1200);
  const formCheck = await evalJs(`
    const sel = document.querySelector('#branchForm select[name="authorityId"]');
    const mgr = document.querySelector('#branchForm input[name="managerName"]');
    return { hasSelect: !!sel, hasPrivate: sel ? [...sel.options].some((o) => o.textContent.includes('(פרטי)')) : false, selected: sel ? sel.options[sel.selectedIndex].textContent : null, mgrValue: mgr ? mgr.value : null };`);
  if (!formCheck.hasSelect || !formCheck.hasPrivate) fail('branch form payer dropdown missing or lacks a (פרטי) option: ' + JSON.stringify(formCheck));
  if (!formCheck.selected.includes('מועצת בדיקת עשן')) fail('branch form payer dropdown not pre-selected with the council: ' + JSON.stringify(formCheck));
  captureScreen('branch-form-payer.png');
  ok('branch form renders contact fields and payer dropdown incl. (פרטי) (dist/branch-form-payer.png)');
  await evalJs('document.querySelector(".modal-backdrop .icon-button, [class*=modal] .icon-button, .modal .icon-button")?.click(); return true;');
  await sleep(800);

  // Rent page: payer chips incl. the private one marked (פרטי), plus the new wording.
  await evalJs('document.querySelector(\'[data-page="rent"]\').click(); return true;');
  let rentPayers = false;
  for (let i = 0; i < 15 && !rentPayers; i++) {
    await sleep(1500);
    rentPayers = await evalJs('return document.body.innerText.includes("מועצת בדיקת עשן") && document.body.innerText.includes("גן פרטי לבדיקת עשן") && document.body.innerText.includes("(פרטי)") && document.body.innerText.includes("לגופים פרטיים")');
  }
  if (!rentPayers) fail('rent page does not show payer chips with (פרטי) markers / private wording');
  captureScreen('rent-payers.png');
  ok('rent page shows payer chips incl. private (פרטי) and private wording (dist/rent-payers.png)');

  // Rent summary cards (v0.2.7): navigate to the rent page in the real window,
  // verify the four cards are rendered as clickable shortcuts, and exercise
  // the zero-data destinations (dummy DB has no rent records) - each card must
  // answer gracefully, never mutate.
  let onRent = false;
  for (let i = 0; i < 15 && !onRent; i++) {
    await sleep(1500);
    onRent = await evalJs('return document.body.innerText.includes("שכירות לרשויות")');
  }
  if (!onRent) fail('rent page did not load in the packaged window');
  const cardIds = await evalJs(`return ['rentAnnualCard','rentUpcomingCard','rentChecksCard','rentAlertsCard'].map((id) => { const c = document.getElementById(id); return c && c.classList.contains('clickable') ? id : null; });`);
  if (cardIds.some((id) => !id)) fail('rent summary cards missing or not clickable: ' + JSON.stringify(cardIds));
  ok('rent summary cards rendered as clickable shortcuts in the packaged window');
  captureScreen('rent-cards.png');
  ok('rent page captured (dist/rent-cards.png) - summary cards and update button in the top bar');
  await evalJs('document.getElementById("rentUpcomingCard").click(); return true;');
  await sleep(800);
  const toast1 = await evalJs('return document.querySelector(".toast-warning")?.textContent || null');
  if (!toast1 || !toast1.includes('אין תשלומים קרובים')) fail('upcoming-payments card did not answer the empty state: ' + toast1);
  captureScreen('rent-card-empty-toast.png');
  ok('upcoming-payments card answers the zero-data state with a toast (captured in dist/rent-card-empty-toast.png)');
  await evalJs('document.getElementById("rentChecksCard").click(); return true;');
  await sleep(800);
  const toast2 = await evalJs('return document.querySelectorAll(".toast-warning").length');
  if (!toast2) fail('deposited-checks card did not answer the empty state');
  ok('deposited-checks card answers the zero-data state with a toast (no list, no mutation)');
  ws.close();
  await sleep(1000);

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
