// @vitest-environment jsdom
// AI page: visible only with aiEnabled, sends the prompt, shows the reply, and
// shows a friendly error when the server refuses.
import { describe, it, expect, vi } from 'vitest';

let me; let askImpl;
const stub = (url, options) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: me?._id })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return me;
  if (['/api/branches', '/api/licenses', '/api/notifications', '/api/tasks', '/api/license-types', '/api/users'].includes(p)) return [];
  if (p === '/api/ai/ask') return askImpl(options);
  throw new Error('unstubbed endpoint: ' + p);
};
const flush = () => new Promise((r) => setTimeout(r, 50));
const boot = async (user) => {
  me = user; vi.resetModules();
  document.body.innerHTML = '<div class="app-shell"><header class="topbar"><div class="brand"><div class="brand-mark"></div><div><h1>KinderGuard</h1><p></p></div></div><div id="update-slot"></div><div id="header-actions"></div></header><main id="app" class="content"></main><footer class="footer"></footer></div>';
  Element.prototype.scrollIntoView = vi.fn(); window.scrollTo = vi.fn();
  global.fetch = vi.fn(async (url, options = {}) => {
    try { const d = stub(url, options); return { ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) }; }
    catch (e) { if (e.status) { return { ok: false, status: e.status, text: async () => JSON.stringify({ message: e.message }) }; } throw e; }
  });
  window.electronAPI = { getUpdateState: async () => ({ status: 'idle' }), checkForUpdates: async () => ({}), downloadUpdate: async () => ({}), installUpdate: async () => ({}), reportUpdateGuard: () => {}, onUpdateStatus: () => {}, onNotificationRefresh: () => {}, onLog: () => {}, notify: vi.fn(async () => true), checkLicensesNow: async () => ({}), onOpenAlert: () => {} };
  localStorage.clear(); sessionStorage.clear();
  await import('../frontend/main.js'); await flush();
};

describe('AI page', () => {
  it('has no AI nav item without aiEnabled', async () => {
    await boot({ _id: 'u1', name: 'א', role: 'Manager' });
    expect(document.querySelector('[data-page="ai"]')).toBeNull();
  });
  it('sends the prompt and shows the reply for an enabled user', async () => {
    askImpl = () => ({ text: 'תשובה לדוגמה' });
    await boot({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
    document.querySelector('[data-page="ai"]').click(); await flush();
    expect(document.querySelectorAll('.ai-idea').length).toBe(3);
    expect(document.querySelector('.ai-note').textContent).toContain('לא רואה את נתוני המערכת');
    document.querySelector('#aiForm textarea').value = 'שלום';
    document.getElementById('aiForm').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(document.getElementById('aiLog').textContent).toContain('שלום');
    expect(document.getElementById('aiLog').textContent).toContain('תשובה לדוגמה');
    const call = global.fetch.mock.calls.find((c) => String(c[0]) === '/api/ai/ask');
    expect(JSON.parse(call[1].body)).toEqual({ prompt: 'שלום' });
  });
  it('shows the server error', async () => {
    askImpl = () => { const e = new Error('Daily AI call limit reached'); e.status = 429; throw e; };
    await boot({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
    document.querySelector('[data-page="ai"]').click(); await flush();
    document.querySelector('.ai-idea').click();
    expect(document.querySelector('#aiForm textarea').value.length).toBeGreaterThan(5);
    document.querySelector('#aiForm textarea').value = 'x';
    document.getElementById('aiForm').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(document.getElementById('aiLog').textContent).toContain('Daily AI call limit reached');
  });
});
