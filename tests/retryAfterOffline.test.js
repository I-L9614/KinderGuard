// @vitest-environment jsdom
// Startup/offline recovery: a data panel's "ניסיון חוזר" must work once the connection is back,
// even when the one-hour access token expired meanwhile (the renewal timer does not run offline).
import { describe, it, expect, vi } from 'vitest';

const flush = () => new Promise((r) => setTimeout(r, 50));
const jwtFor = (id, n) => `h.${btoa(JSON.stringify({ id, n })).replace(/=+$/, '')}.s`;
let net; let validToken; let refreshCalls; let taskCalls; let refreshOk;
const respond = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
const onlineListeners = [];
const realAdd = window.addEventListener.bind(window);
window.addEventListener = (type, fn, opts) => { if (type === 'online') onlineListeners.push(fn); return realAdd(type, fn, opts); };
const boot = async () => {
  // each boot re-imports the app and registers a new 'online' listener: drop the old instances' listeners
  onlineListeners.splice(0).forEach((fn) => window.removeEventListener('online', fn));
  vi.resetModules(); net = true; validToken = jwtFor('u1', 1); refreshCalls = 0; taskCalls = 0; refreshOk = true;
  document.body.innerHTML = '<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark"></div><div><h1>KinderGuard</h1><p></p></div></div><div id="update-slot"></div><div id="header-actions"></div></header><main id="app" class="content"></main><footer class="footer"></footer></div>';
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  global.fetch = vi.fn(async (url, options = {}) => {
    const p = String(url).split('?')[0];
    if (!net) throw new TypeError('Failed to fetch');
    if (p === '/api/auth/refresh') { refreshCalls++; if (!refreshOk) return respond(401, { message: 'פג תוקף' }); validToken = jwtFor('u1', refreshCalls + 1); return respond(200, { token: validToken }); }
    const auth = options.headers?.Authorization;
    if (p === '/api/users/me') return respond(200, { _id: 'u1', name: 'א', role: 'Admin', aiEnabled: false });
    if (p === '/api/tasks') { taskCalls++;  if (auth !== `Bearer ${validToken}`) return respond(401, { message: 'לא מורשה, נא להתחבר מחדש' }); return respond(200, [{ _id: 't1', title: 'משימה אחרי חיבור', status: 'To_Do', notes: '', editable: true }]); }
    if (['/api/branches', '/api/licenses', '/api/notifications', '/api/license-types'].includes(p)) return respond(200, []);
    return respond(200, {});
  });
  window.electronAPI = { getUpdateState: async () => ({ status: 'idle' }), checkForUpdates: async () => ({}), downloadUpdate: async () => ({}), installUpdate: async () => ({}), reportUpdateGuard: () => {}, onUpdateStatus: () => {}, onNotificationRefresh: () => {}, onLog: () => {}, notify: vi.fn(async () => true), checkLicensesNow: async () => ({}), onOpenAlert: () => {} };
  localStorage.clear(); sessionStorage.clear();
  await import('../frontend/main.js'); await flush();
};
const openTasksOffline = async () => {
  await boot();
  const base = refreshCalls; globalThis.__base = base;
  net = false; validToken = 'rotated'; // offline, and the token the client holds is no longer valid
  document.querySelector('[data-page="tasks"]').click(); await flush();
  expect(document.getElementById('app').textContent).toContain('לא ניתן לטעון את המשימות');
};
describe('retry after offline', () => {
  it('retry with the connection back renews the expired token and loads the page', async () => {
    await openTasksOffline();
    net = true;
    document.getElementById('retryTasks').click(); await flush(); await flush();
    expect(document.getElementById('app').textContent).toContain('משימה אחרי חיבור');
    expect(document.getElementById('app').textContent).not.toContain('לא ניתן לטעון את המשימות');
    expect(refreshCalls - globalThis.__base).toBe(1);
  });
  it('a retry that fails again shows when it ran, so it is not mistaken for nothing happening', async () => {
    await openTasksOffline();
    document.getElementById('retryTasks').click(); await flush();
    expect(document.querySelector('[data-retry-note]')?.textContent).toContain('ניסיון אחרון');
    expect(document.getElementById('app').textContent).toContain('לא ניתן לטעון את המשימות');
  });
  it('the online event re-runs the visible retry by itself', async () => {
    await openTasksOffline();
    net = true; window.dispatchEvent(new Event('online')); await flush(); await flush(); await flush();
    expect(document.getElementById('app').textContent).toContain('משימה אחרי חיבור');
  });
  it('when renewal is refused the original error stays and nothing loops', async () => {
    await openTasksOffline();
    net = true; refreshOk = false;
    document.getElementById('retryTasks').click(); await flush(); await flush();
    expect(document.getElementById('app').textContent).toContain('לא ניתן לטעון את המשימות');
    expect(refreshCalls - globalThis.__base).toBe(1); expect(taskCalls).toBeLessThan(5);
  });
  it('the scheduled refresh and a 401 recovery share one refresh call', async () => {
    await openTasksOffline();
    net = true; const base = refreshCalls; let release; const gate = new Promise((r) => { release = r; });
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (url, options) => { if (String(url) === '/api/auth/refresh') await gate; return realFetch(url, options); });
    document.getElementById('retryTasks').click(); // 401 -> renewal starts and waits on the gate
    await flush();
    window.dispatchEvent(new Event('online')); // a second trigger while the first is in flight
    await flush();
    release(); await flush(); await flush(); await flush();
    expect(refreshCalls - base).toBe(1);
    expect(document.getElementById('app').textContent).toContain('משימה אחרי חיבור');
  });
});
