// @vitest-environment jsdom
// Session races around the silent token renewal: a refresh in flight must never leak one account's
// session, data or cookie into another after logout/login, and overlapping triggers share one refresh.
import { describe, it, expect, vi } from 'vitest';

const flush = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const respond = (status, data) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) });
let offline = false; let holdLogout = null; let opaque = false; let cookieUser; let log; let gate; let gateOn; let tokens; let refreshN; let validFor;
const jwt = (owner, n) => `h.${btoa(JSON.stringify({ id: owner, n })).replace(/=+$/, '')}.s`;
const ownerOf = (auth) => tokens.get(String(auth || '').replace('Bearer ', ''));
const onlineListeners = [];
const realAdd = window.addEventListener.bind(window);
window.addEventListener = (type, fn, opts) => { if (type === 'online') onlineListeners.push(fn); return realAdd(type, fn, opts); };
const boot = async () => {
  onlineListeners.splice(0).forEach((fn) => window.removeEventListener('online', fn));
  vi.resetModules(); offline = false; holdLogout = null; opaque = false; cookieUser = 'u1'; log = []; gateOn = false; tokens = new Map(); refreshN = 0; validFor = new Map(); validFor.set('u1', 'tok-u1-0'); tokens.set('tok-u1-0', 'u1');
  gate = null;
  document.body.innerHTML = '<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark"></div><div><h1>KinderGuard</h1><p></p></div></div><div id="update-slot"></div><div id="header-actions"></div></header><main id="app" class="content"></main><footer class="footer"></footer></div>';
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  global.fetch = vi.fn(async (url, options = {}) => {
    const p = String(url).split('?')[0]; const auth = options.headers?.Authorization;
    if (offline && p !== '/api/auth/refresh') throw new TypeError('Failed to fetch');
    if (p === '/api/auth/refresh') {
      const owner = cookieUser; refreshN++; log.push(`refresh-sent:${owner}`);
      if (gateOn) await gate.promise;
      const tok = opaque ? `opaque-${refreshN}` : jwt(owner, refreshN); tokens.set(tok, owner); validFor.set(owner, tok); cookieUser = owner; // Set-Cookie lands with the response
      log.push(`refresh-landed:${owner}`); return respond(200, { token: tok });
    }
    if (p === '/api/auth/logout') { log.push('logout-sent'); if (holdLogout) await holdLogout.promise; cookieUser = null; return respond(200, {}); }
    if (p === '/api/users/login') { log.push('login-sent'); cookieUser = 'u2'; const tok = jwt('u2', 'login'); tokens.set(tok, 'u2'); validFor.set('u2', tok); return respond(200, { id: 'u2', name: 'ב', token: tok }); }
    const owner = ownerOf(auth);
    if (p === '/api/users/me') return owner ? respond(200, { _id: owner, name: owner === 'u1' ? 'אלפא' : 'בטא', role: 'Admin', aiEnabled: false }) : respond(401, { message: 'לא מורשה' });
    if (p === '/api/tasks') { if (!owner || validFor.get(owner) !== String(auth).replace('Bearer ', '')) return respond(401, { message: 'לא מורשה' }); return respond(200, [{ _id: 't-' + owner, title: 'משימה של ' + owner, status: 'To_Do', notes: '', editable: true }]); }
    if (['/api/branches', '/api/licenses', '/api/notifications', '/api/license-types'].includes(p)) return respond(200, []);
    return respond(200, {});
  });
  window.electronAPI = { getUpdateState: async () => ({ status: 'idle' }), checkForUpdates: async () => ({}), downloadUpdate: async () => ({}), installUpdate: async () => ({}), reportUpdateGuard: () => {}, onUpdateStatus: () => {}, onNotificationRefresh: () => {}, onLog: () => {}, notify: vi.fn(async () => true), checkLicensesNow: async () => ({}), onOpenAlert: () => {} };
  localStorage.clear(); sessionStorage.clear();
  await import('../frontend/main.js'); await flush();
};
// A token the client holds that the server no longer accepts: the next data call gets a 401 and starts a renewal.
const expireClientToken = () => { validFor.set('u1', 'tok-u1-server-side'); tokens.set('tok-u1-server-side', 'u1'); };
const holdRefresh = () => { let release; gate = { promise: new Promise((r) => { release = r; }), release }; gateOn = true; };
describe('session races', () => {
  it('the 10-minute timer and a 401 recovery share one refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      await boot();
      const base = refreshN; expireClientToken(); holdRefresh();
      document.querySelector('[data-page="tasks"]').click(); await flush(); // 401 -> renewal in flight
      vi.advanceTimersByTime(10 * 60 * 1000); await flush(); // timer fires loadApp while it is in flight
      gate.release(); await flush(); await flush(); await flush();
      expect(refreshN - base).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it('logout then login as another account while a refresh is delayed: ordered, never adopted, no wrong-user UI', async () => {
    await boot();
    expireClientToken(); holdRefresh();
    document.querySelector('[data-page="tasks"]').click(); await flush(); // u1 refresh in flight (gated)
    expect(log.filter((e) => e.startsWith('refresh-sent')).length).toBeGreaterThan(0);
    document.getElementById('logout').click(); await flush();
    expect(log).not.toContain('logout-sent'); // logout waits for the in-flight refresh to settle first
    gate.release(); gateOn = false; await flush(); await flush(); await flush();
    expect(log.lastIndexOf('refresh-landed:u1')).toBeGreaterThan(-1);
    expect(log.indexOf('logout-sent')).toBeGreaterThan(log.lastIndexOf('refresh-landed:u1'));
    expect(document.getElementById('authForm')).not.toBeNull(); // logged out; the late u1 token was not adopted
    expect(document.getElementById('app').textContent).not.toContain('משימה של u1');
    const f = document.getElementById('authForm'); f.querySelector('[name=identifier]').value = 'b@x.y'; f.querySelector('[name=password]').value = 'Password123';
    f.dispatchEvent(new Event('submit', { cancelable: true })); await flush(); await flush(); await flush();
    expect(log.indexOf('login-sent')).toBeGreaterThan(log.indexOf('logout-sent'));
    expect(cookieUser).toBe('u2');
    expect(document.getElementById('header-actions').textContent).toContain('בטא');
    expect(document.body.textContent).not.toContain('אלפא');
    expect(document.body.textContent).not.toContain('משימה של u1');
  });
  it('fails closed: while a refresh is still pending past the bounded wait, neither logout nor login is sent', async () => {
    await boot();
    expireClientToken(); holdRefresh();
    document.querySelector('[data-page="tasks"]').click(); await flush(); // refresh in flight, stuck
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      document.getElementById('logout').click();
      await vi.advanceTimersByTimeAsync(5100); await vi.advanceTimersByTimeAsync(10);
    } finally { vi.useRealTimers(); }
    expect(log).not.toContain('logout-sent'); // fail closed: no logout request while the stale refresh could still set the cookie
    expect(document.getElementById('header-actions').textContent).toContain('אלפא'); // still the same session, nothing half-done
    expect(document.querySelector('.toast')?.textContent).toContain('פעולה קודמת עדיין מסתיימת');
    gate.release(); gateOn = false; await flush(); await flush();
    document.getElementById('logout').click(); await flush(); await flush(); // once it settles, logout goes through
    expect(log).toContain('logout-sent'); expect(document.getElementById('authForm')).not.toBeNull();
  });
  it('every renewal is pinned to the signed-in account: a token for another account is never adopted or replayed', async () => {
    await boot();
    expireClientToken(); cookieUser = 'u2'; // the jar now belongs to another account
    document.querySelector('[data-page="tasks"]').click(); await flush(); await flush(); await flush();
    expect(document.getElementById('authForm')).not.toBeNull(); // session ended, login screen
    expect(document.body.textContent).not.toContain('משימה של u2'); expect(document.body.textContent).not.toContain('אלפא');
    expect(log.filter((e) => e.startsWith('login-sent')).length).toBe(0);
  });
  it('if the cookie jar belongs to another account after login, the load is rejected instead of showing it', async () => {
    await boot();
    document.getElementById('logout').click(); await flush(); await flush();
    // simulate a late foreign Set-Cookie: after the login response the jar holds u1 again
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (url, options) => { const r = await realFetch(url, options); if (String(url) === '/api/users/login') cookieUser = 'u1'; return r; });
    const f = document.getElementById('authForm'); f.querySelector('[name=identifier]').value = 'b'; f.querySelector('[name=password]').value = 'Password123';
    f.dispatchEvent(new Event('submit', { cancelable: true })); await flush(); await flush(); await flush();
    expect(document.getElementById('authForm')).not.toBeNull();
    expect(document.body.textContent).not.toContain('אלפא');
    expect(document.getElementById('header-actions').textContent).not.toContain('אלפא');
  });
  it('the pin fails closed: a renewal token without a readable account id is not adopted', async () => {
    await boot();
    expireClientToken(); opaque = true;
    document.querySelector('[data-page="tasks"]').click(); await flush(); await flush(); await flush();
    expect(document.getElementById('authForm')).not.toBeNull();
    expect(document.body.textContent).not.toContain('משימה של u1');
  });
  it('no new refresh (online event or timer) can start while the logout request is in flight', async () => {
    vi.useFakeTimers({ toFake: ['setInterval'] });
    try {
      await boot();
      expireClientToken(); holdRefresh();
      let rel; holdLogout = { promise: new Promise((r) => { rel = r; }) };
      document.querySelector('[data-page="tasks"]').click(); await flush(); // refresh #1 in flight
      document.getElementById('logout').click(); await flush(); // logout waits for #1
      const sentBefore = log.filter((e) => e.startsWith('refresh-sent')).length;
      window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(10 * 60 * 1000); await flush(); // new triggers while it waits
      gate.release(); gateOn = false; await flush(); await flush(); // #1 settles, logout request goes out and is held
      expect(log).toContain('logout-sent');
      window.dispatchEvent(new Event('online')); vi.advanceTimersByTime(10 * 60 * 1000); await flush(); // new triggers while the logout request is in flight
      rel(); await flush(); await flush();
      expect(log.filter((e) => e.startsWith('refresh-sent')).length).toBe(sentBefore); // none were ever sent
      expect(document.getElementById('authForm')).not.toBeNull();
    } finally { vi.useRealTimers(); }
  });
  it('online event: a renewal that is rejected for another account does not click the retry or draw over the login screen', async () => {
    await boot();
    offline = true;
    document.querySelector('[data-page="tasks"]').click(); await flush();
    expect(document.getElementById('retryTasks')).not.toBeNull(); // offline error panel with its retry button
    offline = false; expireClientToken(); cookieUser = 'u2'; // back online, the jar belongs to another account
    window.dispatchEvent(new Event('online')); await flush(); await flush(); await flush();
    expect(document.getElementById('authForm')).not.toBeNull();
    expect(document.getElementById('retryTasks')).toBeNull();
    expect(document.getElementById('app').textContent).not.toContain('לא ניתן לטעון');
    expect(document.body.textContent).not.toContain('משימה של u2');
  });
  it('online event: when the renewal itself fails, the retry is not clicked either (no error panel redrawn)', async () => {
    await boot();
    offline = true;
    document.querySelector('[data-page="tasks"]').click(); await flush();
    const btn = document.getElementById('retryTasks'); let clicked = 0; btn.addEventListener('click', () => { clicked++; });
    const realFetch = global.fetch;
    global.fetch = vi.fn(async (url, options) => { if (String(url) === '/api/auth/refresh') return respond(500, { message: 'x' }); return realFetch(url, options); });
    offline = false; window.dispatchEvent(new Event('online')); await flush(); await flush();
    expect(clicked).toBe(0);
  });
  it('online event: if the user navigated away while the renewal ran, the stale retry button is not clicked over the new page', async () => {
    await boot();
    offline = true;
    document.querySelector('[data-page="tasks"]').click(); await flush();
    expect(document.getElementById('retryTasks')).not.toBeNull();
    offline = false; holdRefresh();
    window.dispatchEvent(new Event('online')); await flush(); // renewal in flight, the retry button is still the captured one
    document.querySelector('[data-page="alerts"]').click(); await flush(); // the user moves on; the old button is detached
    expect(document.getElementById('retryTasks')).toBeNull();
    gate.release(); gateOn = false; await flush(); await flush(); await flush();
    expect(document.getElementById('app').textContent).not.toContain('משימה של u1'); // the tasks page was not drawn over the alerts page
    expect(document.querySelector('[data-page="alerts"]').getAttribute('aria-current')).toBe('page');
  });
});
