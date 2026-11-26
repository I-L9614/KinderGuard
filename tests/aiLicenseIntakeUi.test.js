// @vitest-environment jsdom
// AI license intake:  with aiEnabled, sends the prompt, shows the reply, and
// shows a friendly error when the server refuses.
import { describe, it, expect, vi } from 'vitest';

let me; let askImpl; let saved = [];
const consentSeen = [];
const stub = (url, options) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: me?._id })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return me;
  if (p === '/api/licenses' && options?.method === 'POST') { saved.push(options); return {}; }
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן א', address: '' }];
  if (p === '/api/license-types') return [{ _id: 't1', name: 'אישור בטיחות', branchId: null, active: true }, { _id: 't2', name: 'כיבוי אש שנתי', branchId: null, active: true }];
  if (['/api/licenses', '/api/notifications', '/api/tasks', '/api/users'].includes(p)) return [];
  if (p === '/api/ai/license-extract') { consentSeen.push(options.body.get('consentExternal')); return askImpl(options); }
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


const open = async (user) => {
  saved = []; await boot(user);
  document.querySelector('[data-branch="b1"]').click(); await flush();
  document.getElementById('addLicense').click(); await flush();
};
const pick = () => { const input = document.querySelector('[name="file"]'); Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.4 0000'], 'a.pdf', { type: 'application/pdf' })], configurable: true }); input.dispatchEvent(new Event('change')); };
describe('AI license intake', () => {
  it('is absent without aiEnabled', async () => {
    await open({ _id: 'u1', name: 'א', role: 'Admin' });
    expect(document.getElementById('aiRead')).toBeNull();
  });
  it('proposes values, flags unclear fields, and requires confirmation before saving', async () => {
    askImpl = () => ({ licenseType: 'כיבוי אש שנתי', issueDate: '2026-02-01', expiryDate: null, documentBranch: 'גן ב', note: '', unclear: ['expiryDate'] });
    await open({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
    expect(document.getElementById('aiRead').disabled).toBe(true);
    pick(); expect(document.getElementById('aiRead').disabled).toBe(false);
    expect(consentSeen).toEqual([]); expect(document.getElementById('aiReadHint').textContent).toContain('יישלח ל-Anthropic');
    document.getElementById('aiRead').click(); await flush();
    expect(consentSeen).toEqual(['true']);
    expect(document.querySelector('[name="licenseTypeId"]').value).toBe('t2');
    expect(document.querySelector('[name="issueDate"]').value).toBe('2026-02-01');
    expect(document.querySelector('[name="expiryDate"]').value).toBe('');
    expect(document.querySelector('[name="expiryDate"]').closest('label').querySelector('.ai-badge.unclear')).not.toBeNull();
    expect(document.getElementById('aiReadHint').textContent).toContain('גן ב');
    expect(saved.length).toBe(0);
    const form = document.getElementById('licenseForm');
    document.querySelector('[name="expiryDate"]').value = '2027-02-01';
    form.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(saved.length).toBe(0); // blocked: not confirmed
    document.getElementById('aiConfirm').checked = true;
    form.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(saved.length).toBe(1);
  });
  it('shows the server error and keeps the form empty', async () => {
    askImpl = () => { const e = new Error('AI budget reached'); e.status = 429; throw e; };
    await open({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
    pick(); document.getElementById('aiRead').click(); await flush();
    expect(document.querySelector('[name="issueDate"]').value).toBe('');
    expect(document.getElementById('aiConfirmRow').hidden).toBe(true);
    expect(document.body.textContent).toContain('AI budget reached');
  });
});
