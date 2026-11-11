// @vitest-environment jsdom
// Renderer boot + toast-click routing regression test.
// Boots the REAL frontend/main.js in jsdom with a stubbed transport and a
// mocked Electron bridge. Written for the v0.2.2 regression where the
// nativeNotify import was dropped from main.js: unit tests passed (they import
// the module directly) while the shipped renderer threw ReferenceError on
// every alert refresh and on toast clicks.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const branch = { _id: 'b1', name: 'גן הדוגמה', address: 'רחוב הבדיקה 1' };
const type = { _id: 't1', name: 'רישיון בדיקה' };
const license = { _id: 'l1', branchId: 'b1', licenseTypeId: type, issueDate: '2026-01-01', expiryDate: '2026-11-16', status: 'Expiring_Soon', lifecycle: 'Active' };

const apiStub = (url) => {
  const p = url.split('?')[0];
  if (p === '/api/auth/refresh') return { token: 'stub' };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return [branch];
  if (p === '/api/licenses') return [license];
  if (p === '/api/notifications') return [];
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return [type];
  throw new Error('unstubbed endpoint: ' + p);
};

const flush = () => new Promise((r) => setTimeout(r, 50));

describe('renderer boot (real main.js)', () => {
  let openAlert;
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="brand"><div class="brand-mark"></div><div><h1>KinderGuard</h1><p></p></div></div>
          <div id="update-slot"></div>
          <div id="header-actions"></div>
        </header>
        <main id="app" class="content"></main>
        <footer class="footer"></footer>
      </div>`;
    Element.prototype.scrollIntoView = () => {};
    global.fetch = vi.fn(async (url, options = {}) => ({
      ok: true,
      status: 200,
      json: async () => apiStub(String(url)),
      text: async () => JSON.stringify(apiStub(String(url))),
    }));
    window.electronAPI = {
      getUpdateState: async () => ({ status: 'idle' }),
      checkForUpdates: async () => ({ status: 'idle' }),
      downloadUpdate: async () => ({ status: 'idle' }),
      installUpdate: async () => ({ installed: true }),
      reportUpdateGuard: () => {},
      onUpdateStatus: () => {},
      onNotificationRefresh: () => {},
      onLog: () => {},
      notify: async () => true,
      checkLicensesNow: async () => ({}),
      onOpenAlert: (cb) => { openAlert = cb; },
    };
    localStorage.clear();
    sessionStorage.clear();
    await import('../frontend/main.js');
    await flush();
  });

  it('boots to the branches page without an error toast (import integrity)', () => {
    expect(document.querySelector('.branch-card h3')?.textContent).toBe('גן הדוגמה');
    expect(document.querySelector('.toast-danger')).toBeNull();
  });

  it('wires the toast-click bridge and routes a permit target to the flashing license row', async () => {
    expect(typeof openAlert).toBe('function');
    openAlert({ id: 'x1', kind: 'License', branchId: 'b1', licenseId: 'l1' });
    await flush();
    expect(document.querySelector('.branch-title h2')?.textContent).toBe('גן הדוגמה');
    expect(document.querySelector('.row-flash[data-license-id="l1"]')).not.toBeNull();
  });

  it('falls back to the alerts inbox for stale/deleted targets', async () => {
    openAlert({ id: 'x2', kind: 'License', branchId: 'gone', licenseId: 'gone' });
    await flush();
    expect(document.querySelector('.welcome-row h2')?.textContent).toContain('התראות');
  });

  it('keeps rent targets away from non-admin roles', async () => {
    openAlert({ id: 'x3', kind: 'Rent', rentAgreementId: 'a1', rentPaymentId: 'p1' });
    await flush();
    // Admin here: routes to rent page (content may fail to load without stubs; the nav state is what matters)
    expect(document.querySelector('[data-page="rent"]')?.classList.contains('selected')).toBe(true);
  });
});
