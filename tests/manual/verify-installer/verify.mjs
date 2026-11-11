// Clean-install verification for the PUBLISHED installer (windows-latest).
//
// Runs after the real NSIS installer from the GitHub release was silently
// installed on a pristine runner - the closest thing to a customer PC we can
// automate. Asserts what the log-only smoke could not show visually:
//   - no .env anywhere (the installer carries no secrets)
//   - first launch enters client mode and records the hosted URL
//   - the packaged window actually loads the hosted HTTPS login page
//   - the real preload bridge works on the hosted page
//   - the update controller is live in the packaged app
//   - a real screenshot of the window is captured for release review
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const fail = (msg) => { console.error('VERIFY FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('verify ok: ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOSTED = 'https://kinderguard-server.onrender.com';

const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'KinderGuard', 'KinderGuard.exe');
if (!fs.existsSync(exe)) fail('installed exe not found at ' + exe);
ok('installed by the real NSIS installer at ' + exe);

const userData = path.join(process.env.APPDATA, 'KinderGuard');
const envFile = path.join(userData, '.env');
if (fs.existsSync(envFile)) fail('.env present on a pristine machine - the installer must not carry config');
ok('no .env in userData on the clean machine (no secrets in the installer)');

const child = spawn(exe, ['--remote-debugging-port=9224'], { stdio: 'ignore' });
try {
  // Client-mode marker: written only when the startup reaches client mode.
  let marker = null;
  for (let i = 0; i < 60 && marker !== HOSTED; i++) {
    await sleep(2000);
    if (child.exitCode !== null) fail('app exited early with code ' + child.exitCode);
    try { marker = fs.readFileSync(path.join(userData, '.client-mode'), 'utf8'); } catch {}
  }
  if (marker !== HOSTED) fail('.client-mode marker missing or wrong URL: ' + marker);
  ok('first launch without .env entered client mode pointing at ' + HOSTED);

  // The packaged window over CDP: it must really load the hosted HTTPS page.
  let page;
  for (let i = 0; i < 90 && !page; i++) {
    try {
      const targets = await fetch('http://127.0.0.1:9224/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
      page = targets.find((t) => t.type === 'page' && t.url.startsWith(HOSTED));
    } catch {}
    if (!page) await sleep(2000);
  }
  if (!page) fail('packaged window never loaded ' + HOSTED + ' (cold start should still resolve within 3 minutes)');
  ok('packaged window is showing ' + page.url);

  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  let cdpId = 0;
  const cdpPending = new Map();
  ws.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.id && cdpPending.has(m.id)) { cdpPending.get(m.id)(m); cdpPending.delete(m.id); } });
  const cdpSend = (method, params = {}) => new Promise((res) => { const i = ++cdpId; cdpPending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result?.result?.value;
  };

  let loginSeen = false;
  for (let i = 0; i < 30 && !loginSeen; i++) {
    await sleep(2000);
    loginSeen = await evalJs(`Boolean(document.body && document.body.innerText.includes('התחברות'))`);
  }
  if (!loginSeen) fail('hosted login page did not render inside the packaged window');
  ok('Hebrew login page rendered inside the packaged window over HTTPS');

  // Preload bridge on the hosted page (main.js writes the marker after
  // probing the real renderer on did-finish-load).
  let bridgeSeen = false;
  for (let i = 0; i < 30 && !bridgeSeen; i++) {
    if (fs.existsSync(path.join(userData, '.preload-error'))) fail('preload failed: ' + fs.readFileSync(path.join(userData, '.preload-error'), 'utf8'));
    if (fs.existsSync(path.join(userData, '.bridge-missing'))) fail('window.electronAPI missing in the packaged renderer');
    bridgeSeen = fs.existsSync(path.join(userData, '.bridge-ok'));
    if (!bridgeSeen) await sleep(2000);
  }
  if (!bridgeSeen) fail('bridge self-check never reported .bridge-ok');
  ok('preload bridge live on the hosted page (window.electronAPI present)');

  const updateStatePath = path.join(userData, '.update-state');
  let updateState = null;
  for (let i = 0; i < 30 && !updateState; i++) {
    try { updateState = fs.readFileSync(updateStatePath, 'utf8').trim(); } catch {}
    if (!updateState) await sleep(2000);
  }
  if (!updateState) fail('update state marker missing (setupUpdates never ran?)');
  if (updateState === 'disabled') fail('update controller disabled in the packaged app');
  ok('update controller live in client mode (state: ' + updateState + ')');

  // Real window screenshot for release review.
  const shotOut = path.resolve('client-mode-window.png');
  const shotScript = path.join(os.tmpdir(), 'kg-client-shot.ps1');
  fs.writeFileSync(shotScript, [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
    '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)',
    `$bmp.Save('${shotOut.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()',
  ].join('\n'));
  const shot = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shotScript], { encoding: 'utf8', timeout: 60000 });
  if (shot.error || shot.status !== 0 || !fs.existsSync(shotOut)) fail('screenshot failed: ' + (shot.stderr || shot.error?.message || 'no output'));
  ok('packaged client-mode window captured (client-mode-window.png)');

  ws.close();
  console.log('VERIFY_PASSED');
} finally {
  if (child.exitCode === null) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
}
process.exit(0);
