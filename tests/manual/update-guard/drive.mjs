// Real-renderer integration test for the update install guard.
// Drives headless Chrome over CDP against the real frontend served by the real
// backend, with the Electron bridge injected as a mock before page scripts run.
import { writeFileSync } from 'fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
const ok = (msg) => console.log('ok: ' + msg);

const bridgeMock = `
window.__installCalls = [];
window.__guardReports = [];
window.electronAPI = {
  getUpdateState: async () => ({ status: 'downloaded', version: '0.3.0', percent: 100 }),
  checkForUpdates: async () => ({ status: 'downloaded' }),
  downloadUpdate: async () => ({ status: 'downloaded' }),
  installUpdate: async (opts) => { window.__installCalls.push(opts || null); return { installed: true }; },
  reportUpdateGuard: (s) => { window.__guardReports.push(s); },
  onUpdateStatus: () => {}, onNotificationRefresh: () => {},
  notify: async () => true, checkLicensesNow: async () => ({}), onLog: () => {},
};`;

const list = await fetch('http://localhost:9223/json').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (event) => { const msg = JSON.parse(event.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression: `(()=>{${expression}})()`, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) fail('page exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
  return r.result?.result?.value;
};
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync('/tmp/shots/' + name + '.png', Buffer.from(r.result.data, 'base64')); };

await send('Page.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: bridgeMock });
await send('Page.navigate', { url: 'http://localhost:4199/' });
await sleep(2500);

// Register a real admin through the real auth form.
await evaluate(`
  document.querySelector('[data-tab="register"]').click();
  const set = (name, value) => { const i = document.querySelector('#authForm [name="' + name + '"]'); i.value = value; i.dispatchEvent(new Event('input', { bubbles: true })); };
  set('name', 'בודק'); set('email', 'tester@itest.kg'); set('password', 'Password123');
  document.getElementById('authForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;`);
await sleep(3000);
if (!(await evaluate(`return !!document.getElementById('newBranch');`))) fail('login/register did not reach the branches page');
ok('registered and logged in through the real form');

// Scenario A: pending write blocks the install with no discard offered.
await evaluate(`
  const realFetch = window.fetch;
  window.fetch = (url, opts) => (String(url).includes('/api/branches') && opts && opts.method === 'POST')
    ? new Promise((res) => setTimeout(() => realFetch(url, opts).then(res), 3000))
    : realFetch(url, opts);
  document.getElementById('newBranch').click();
  return true;`);
await sleep(600);
await evaluate(`
  const i = document.querySelector('.modal-backdrop form [name="name"]');
  i.value = 'סניף בדיקה'; i.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('.modal-backdrop form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;`);
await sleep(500); // POST is pending for ~2.5 more seconds
if (!(await evaluate(`return window.__updateGuard.state().blocked === true && window.__updateGuard.state().pendingWrites === 1;`))) fail('pending write not tracked as blocking');
ok('pending branch-save write is tracked as blocking');

await evaluate(`document.getElementById('updateButton').click(); return true;`);
await sleep(400);
await evaluate(`document.getElementById('approveInstall').click(); return true;`);
await sleep(400);
const blockedText = await evaluate(`
  const modals = [...document.querySelectorAll('.modal-backdrop')];
  const m = modals[modals.length - 1];
  return { text: m ? m.textContent : '', hasDiscard: !!document.getElementById('discardAndInstall'), installs: window.__installCalls.length };`);
if (!blockedText.text.includes('שמירות עדיין מתבצעות')) fail('pending-writes dialog missing, got: ' + blockedText.text.slice(0, 120));
if (blockedText.hasDiscard) fail('discard button offered while a write is pending');
if (blockedText.installs !== 0) fail('install ran while a write was pending');
ok('pending write blocks install, no discard offered, install not called');
await shot('itest-pending-writes');

await sleep(3200); // let the branch POST settle; modal closes on success
if (!(await evaluate(`return window.__updateGuard.state().pendingWrites === 0 && window.__updateGuard.state().blocked === false;`))) fail('guard did not settle after the write finished');
ok('guard settled after the write finished');
await evaluate(`[...document.querySelectorAll('.modal-backdrop')].forEach((m) => m.querySelector('[data-close]')?.click()); return true;`);
await sleep(400);

// Scenario B: dirty form needs an explicit discard before install.
await evaluate(`document.getElementById('newBranch').click(); return true;`);
await sleep(600);
await evaluate(`
  const i = document.querySelector('.modal-backdrop form [name="name"]');
  i.value = 'טיוטה'; i.dispatchEvent(new Event('input', { bubbles: true }));
  return true;`);
await evaluate(`document.getElementById('updateButton').click(); return true;`);
await sleep(400);
await evaluate(`document.getElementById('approveInstall').click(); return true;`);
await sleep(400);
const dirtyText = await evaluate(`
  const modals = [...document.querySelectorAll('.modal-backdrop')];
  const m = modals[modals.length - 1];
  return { text: m ? m.textContent : '', hasDiscard: !!document.getElementById('discardAndInstall'), installs: window.__installCalls.length };`);
if (!dirtyText.text.includes('יש שינויים שלא נשמרו')) fail('dirty-form dialog missing, got: ' + dirtyText.text.slice(0, 120));
if (!dirtyText.hasDiscard) fail('discard option missing for dirty form');
if (dirtyText.installs !== 0) fail('install ran before the discard decision');
ok('dirty form requires explicit decision before install');
await shot('itest-dirty-decision');

await evaluate(`document.getElementById('discardAndInstall').click(); return true;`);
await sleep(500);
const calls = await evaluate(`return window.__installCalls;`);
if (!calls || calls.length !== 1 || calls[0]?.discardUnsaved !== true) fail('install not called with explicit discard, got: ' + JSON.stringify(calls));
ok('discard choice installs with {discardUnsaved: true}');

// The desktop process was kept in sync the whole time.
const reports = await evaluate(`return window.__guardReports.length > 0 && window.__guardReports.some((s) => s.pendingWrites === 1) && window.__guardReports.some((s) => s.dirtyForms >= 1);`);
if (!reports) fail('guard state was not reported to the desktop process');
ok('guard state reported to the desktop process on every change');

console.log('ITEST_ALL_PASSED');
process.exit(0);
