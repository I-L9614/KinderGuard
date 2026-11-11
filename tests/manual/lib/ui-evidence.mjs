// Shared packaged-UI evidence harness (windows runners, no secrets).
//
// Launches a given KinderGuard.exe in EMBEDDED mode against a throwaway
// in-memory MongoDB - never the user's production data - then proves the
// payers / branch-contacts UI renders in the real packaged window:
//   - seeds a council payer, a private payer and a contact-full branch
//     through the real HTTP API
//   - logs in through the real window
//   - captures: branch-card manager line, branch-detail contacts+payer
//     panel, branch edit form with the payer dropdown incl. (פרטי), and
//     rent-page payer chips with the private wording
//
// Used by the release smoke (dist build) and by verify-installer (the exact
// PUBLISHED installer, silently installed) so both verify the same UI.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { MongoMemoryServer } from 'mongodb-memory-server';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function captureUiEvidence({ exe, outDir, cdpPort, fail, ok }) {
  if (!fs.existsSync(exe)) fail('exe not found at ' + exe);
  fs.mkdirSync(outDir, { recursive: true });

  const userData = path.join(process.env.APPDATA, 'KinderGuard');
  fs.mkdirSync(userData, { recursive: true });
  const envFile = path.join(userData, '.env');
  const envBackup = fs.existsSync(envFile) ? fs.readFileSync(envFile) : null;
  fs.rmSync(envFile, { force: true });
  fs.rmSync(path.join(userData, '.client-mode'), { force: true });

  const captureScreen = (name) => {
    const shotOut = path.join(outDir, name);
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
    if (shot.error || shot.status !== 0 || !fs.existsSync(shotOut)) fail('screenshot failed for ' + name + ': ' + (shot.stderr || shot.error?.message || 'no output file'));
  };

  const mongo = await MongoMemoryServer.create();
  let child;
  try {
    fs.writeFileSync(envFile, `MONGO_URI=${mongo.getUri()}\nJWT_SECRET=smoke-secret\n`);
    const appLog = path.join(os.tmpdir(), 'kg-ui-evidence.log');
    fs.rmSync(appLog, { force: true });
    const appLogFd = fs.openSync(appLog, 'w');
    child = spawn(exe, ['--remote-debugging-port=' + cdpPort], { stdio: ['ignore', appLogFd, appLogFd] });

    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      await sleep(2000);
      if (child.exitCode !== null) fail(`packaged app exited early with code ${child.exitCode}`);
      try { if ((await fetch('http://127.0.0.1:4000/health')).ok) healthy = true; } catch {}
    }
    if (!healthy) fail('packaged app did not answer /health within 120s');
    ok('packaged app up against a throwaway in-memory DB (embedded mode)');

    // First account registers as Admin and returns a token - real API, dummy
    // data, in-memory DB only.
    const reg = await fetch('http://127.0.0.1:4000/api/users/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'בדיקת עשן', email: 'smoke-admin@test.local', password: 'smoke-pass-123' }),
    });
    const regJ = await reg.json();
    if (!reg.ok || !regJ.token) fail('dummy admin registration failed: ' + JSON.stringify(regJ));
    const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + regJ.token };
    const post = async (url, body) => {
      const r = await fetch('http://127.0.0.1:4000' + url, { method: 'POST', headers: H, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) fail('seeding ' + url + ' failed: ' + JSON.stringify(j));
      return j;
    };
    const council = await post('/api/rent/authorities', { name: 'מועצת בדיקת עשן', type: 'council' });
    const priv = await post('/api/rent/authorities', { name: 'גן פרטי לבדיקת עשן', type: 'private' });
    const branch = await post('/api/branches', {
      name: 'סניף בדיקת עשן', address: 'רחוב הבדיקה 7, תל אביב',
      managerName: 'מנהלת הבדיקה', phone: '050-1234567', emails: 'smoke@test.local', authorityId: council._id,
    });
    ok('seeded council payer, private payer and contact-full branch through the real API');

    // Real window over CDP.
    let page;
    for (let i = 0; i < 45 && !page; i++) {
      try {
        const targets = await fetch('http://127.0.0.1:' + cdpPort + '/json', { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
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

    // Login through the real window (default tab is התחברות).
    await evalJs(`
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
    ok('logged in through the packaged window');

    // Branch card carries the manager line.
    let cardLine = false;
    for (let i = 0; i < 15 && !cardLine; i++) {
      await sleep(1500);
      cardLine = await evalJs('return document.body.innerText.includes("מנהלת הבדיקה")');
    }
    if (!cardLine) fail('branch card does not show the manager line');
    captureScreen('branch-card-contacts.png');
    ok('branch card shows the manager/phone line (branch-card-contacts.png)');

    // Branch detail: contacts + payer panel.
    await evalJs(`document.querySelector('[data-branch="${branch._id}"]').click(); return true;`);
    let panelSeen = false;
    for (let i = 0; i < 15 && !panelSeen; i++) {
      await sleep(1500);
      panelSeen = await evalJs('return document.body.innerText.includes("אנשי קשר ושיוך") && document.body.innerText.includes("מועצת בדיקת עשן")');
    }
    if (!panelSeen) fail('branch detail contacts+payer panel did not render');
    captureScreen('branch-detail-contacts.png');
    ok('branch detail shows the contacts+payer panel (branch-detail-contacts.png)');

    // Branch edit form: contact fields and the payer dropdown with (פרטי).
    await evalJs('document.getElementById("editBranch").click(); return true;');
    await sleep(1200);
    const formCheck = await evalJs(`
      const sel = document.querySelector('#branchForm select[name="authorityId"]');
      const mgr = document.querySelector('#branchForm input[name="managerName"]');
      return { hasSelect: !!sel, hasPrivate: sel ? [...sel.options].some((o) => o.textContent.includes('(פרטי)')) : false, selected: sel ? sel.options[sel.selectedIndex].textContent : null, mgrValue: mgr ? mgr.value : null };`);
    if (!formCheck.hasSelect || !formCheck.hasPrivate) fail('branch form payer dropdown missing or lacks a (פרטי) option: ' + JSON.stringify(formCheck));
    if (!formCheck.selected.includes('מועצת בדיקת עשן')) fail('branch form payer dropdown not pre-selected with the council: ' + JSON.stringify(formCheck));
    if (formCheck.mgrValue !== 'מנהלת הבדיקה') fail('branch form manager field not populated: ' + JSON.stringify(formCheck));
    captureScreen('branch-form-payer.png');
    ok('branch form renders contact fields and payer dropdown incl. (פרטי) (branch-form-payer.png)');
    await evalJs('document.querySelector(".modal-backdrop .icon-button, [class*=modal] .icon-button, .modal .icon-button")?.click(); return true;');
    await sleep(800);

    // Rent page: payer chips incl. the private one marked (פרטי), plus wording.
    await evalJs('document.querySelector(\'[data-page="rent"]\').click(); return true;');
    let rentPayers = false;
    for (let i = 0; i < 15 && !rentPayers; i++) {
      await sleep(1500);
      rentPayers = await evalJs('return document.body.innerText.includes("מועצת בדיקת עשן") && document.body.innerText.includes("גן פרטי לבדיקת עשן") && document.body.innerText.includes("(פרטי)") && document.body.innerText.includes("לגופים פרטיים")');
    }
    if (!rentPayers) fail('rent page does not show payer chips with (פרטי) markers / private wording');
    captureScreen('rent-payers.png');
    ok('rent page shows payer chips incl. private (פרטי) and private wording (rent-payers.png)');

    // Amount-less office rental (v0.3.2): a property branch (kept out of the
    // daycare/permits list) plus an outgoing agreement with NO amounts must
    // render as "not entered yet" - never as ₪0 and never as a scheduled
    // payment. This is the exact misreading the user said to avoid.
    const office = await post('/api/branches', { name: 'משרד בדיקת עשן', kind: 'property' });
    const landlord = await post('/api/rent/authorities', { name: 'משכיר בדיקת עשן', type: 'private' });
    await post('/api/rent/agreements', { branchId: office._id, authorityId: landlord._id, direction: 'outgoing' });
    ok('seeded a property branch and an amount-less outgoing agreement through the real API');

    // The property must not appear on the daycare branches page.
    await evalJs('document.querySelector(\'[data-page="branches"]\').click(); return true;');
    await sleep(1500);
    const officeLeaked = await evalJs('return document.body.innerText.includes("משרד בדיקת עשן")');
    if (officeLeaked) fail('property branch leaked into the daycare branches page');
    ok('property branch stays out of the daycare/permits branch list');

    // The rent page shows the record with placeholder wording and no ₪0.
    await evalJs('document.querySelector(\'[data-page="rent"]\').click(); return true;');
    let officeRow = false;
    for (let i = 0; i < 15 && !officeRow; i++) {
      await sleep(1500);
      officeRow = await evalJs('return document.body.innerText.includes("משרד בדיקת עשן") && document.body.innerText.includes("טרם הוזן")');
    }
    if (!officeRow) fail('amount-less office agreement does not render with the "טרם הוזן" placeholder');
    const wording = await evalJs(`return {
      marker: document.body.innerText.includes('(משרד)'),
      later: document.body.innerText.includes('הסכום והמועדים יוזנו בהמשך'),
      zero: /₪\\s*0(?!\\d)/.test(document.body.innerText),
    };`);
    if (!wording.marker || !wording.later) fail('amount-less office agreement missing (משרד) marker or later-entry wording: ' + JSON.stringify(wording));
    if (wording.zero) fail('amount-less office agreement renders a ₪0 amount - the exact misreading to avoid');
    captureScreen('rent-amountless-office.png');
    ok('amount-less outgoing office record renders "טרם הוזן" with no ₪0 (rent-amountless-office.png)');

    ws.close();
    await sleep(500);
  } finally {
    if (child && child.exitCode === null) spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)]);
    if (envBackup) fs.writeFileSync(envFile, envBackup); else fs.rmSync(envFile, { force: true });
    await mongo.stop();
  }
}
