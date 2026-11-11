// @vitest-environment jsdom
// Rent summary cards as navigation shortcuts (v0.2.7 feature).
// Boots the REAL frontend/main.js in jsdom with a stubbed transport, opens the
// rent page with fixture data, and verifies each summary card leads to its
// matching place: authorities list, upcoming panel, deposited-checks list
// (view-only - no financial actions), and the alerts inbox.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const rentSummary = {
  authorities: [{ _id: 'auth1', name: 'מועצה אזורית בדיקה' }],
  agreements: [{ _id: 'ag1', branchId: { _id: 'b1', name: 'גן הדוגמה' }, authorityId: { _id: 'auth1', name: 'מועצה אזורית בדיקה' }, status: 'Active', frequency: 'monthly', paymentMethod: 'cheque', monthlyAmount: 5000, annualAmount: 60000 }],
  payments: [
    { _id: 'p1', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'cheque', amount: 5000, dueDate: inDays(10), status: 'Pending' },
    { _id: 'p2', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'cheque', amount: 5000, dueDate: inDays(5), status: 'Handed' },
    { _id: 'p3', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'transfer', amount: 5000, dueDate: '2026-01-01', status: 'Cleared', clearedAt: '2026-01-02' },
  ],
  groups: [],
  totals: { auth1: { monthly: 5000, annual: 60000 } },
};

const emptyRentSummary = { authorities: [], agreements: [], payments: [], groups: [], totals: {} };

const makeApiStub = (summary) => (url) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: 'stub' };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return [];
  if (p === '/api/licenses') return [];
  if (p === '/api/notifications') return [];
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return [];
  if (p === '/api/users') return [];
  if (p === '/api/rent/summary') return summary;
  throw new Error('unstubbed endpoint: ' + p);
};

const flush = () => new Promise((r) => setTimeout(r, 50));

const boot = async (summary) => {
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
  Element.prototype.scrollIntoView = vi.fn();
  const stub = makeApiStub(summary);
  global.fetch = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => stub(url),
    text: async () => JSON.stringify(stub(url)),
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
    notify: vi.fn(async () => true),
    checkLicensesNow: async () => ({}),
    onOpenAlert: () => {},
  };
  localStorage.clear();
  sessionStorage.clear();
  await import('../frontend/main.js');
  await flush();
  document.querySelector('[data-page="rent"]').click();
  await flush();
};

describe('rent summary cards as shortcuts', () => {
  beforeEach(() => boot(rentSummary));

  it('renders all four cards as clickable buttons with matching ids', () => {
    for (const id of ['rentAnnualCard', 'rentUpcomingCard', 'rentChecksCard', 'rentAlertsCard']) {
      const card = document.getElementById(id);
      expect(card, id).not.toBeNull();
      expect(card.classList.contains('clickable')).toBe(true);
      expect(card.getAttribute('role')).toBe('button');
    }
  });

  it('upcoming-payments card scrolls to the upcoming panel', () => {
    document.getElementById('rentUpcomingCard').click();
    const panel = document.getElementById('rentUpcomingPanel');
    expect(panel).not.toBeNull();
    expect(panel.scrollIntoView).toHaveBeenCalled();
  });

  it('deposited-checks card lists exactly the handed payments, view-only', () => {
    document.getElementById('rentChecksCard').click();
    const panel = document.getElementById('rentHistoryPanel');
    expect(panel.textContent).toContain("צ'קים מופקדים");
    const rows = panel.querySelectorAll('.history-row');
    expect(rows.length).toBe(1); // p2 Handed only - not p1 Pending, not p3 Cleared
    expect(rows[0].textContent).toContain('גן הדוגמה');
    expect(rows[0].textContent).toContain("צ'ק נמסר · טרם נפרע");
    // navigation only: no payment state mutations from this list
    expect(panel.querySelector('[data-rent-cleared]')).toBeNull();
    expect(panel.querySelector('[data-rent-handed]')).toBeNull();
    expect(panel.querySelector('[data-rent-edit]')).toBeNull();
    expect(panel.querySelector('[data-rent-revert]')).toBeNull();
  });

  it('annual-total card clears the authority filter and scrolls to the authorities', async () => {
    document.querySelector('.rent-filter[data-authority="auth1"]').click();
    await flush();
    // active filter chip is highlighted with the plain-hex background
    expect(document.querySelector('.rent-filter[data-authority="auth1"]').style.backgroundColor).toBe('rgb(234, 245, 242)');
    expect(document.querySelector('.rent-filter[data-authority=""]').style.backgroundColor).toBe('');
    document.getElementById('rentAnnualCard').click();
    await flush();
    // filter cleared: "all authorities" is highlighted again and we scrolled there
    expect(document.querySelector('.rent-filter[data-authority=""]').style.backgroundColor).toBe('rgb(234, 245, 242)');
    expect(document.getElementById('rentAuthoritiesTop').scrollIntoView).toHaveBeenCalled();
  });

  it('active-reminders card navigates to the alerts inbox', async () => {
    document.getElementById('rentAlertsCard').click();
    await flush();
    expect(document.querySelector('[data-page="alerts"]').classList.contains('selected')).toBe(true);
  });

  it('cards respond to keyboard activation like the branch cards', () => {
    const card = document.getElementById('rentUpcomingCard');
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.getElementById('rentUpcomingPanel').scrollIntoView).toHaveBeenCalled();
  });
});

describe('rent summary cards with empty data (zero-state)', () => {
  beforeEach(() => boot(emptyRentSummary));

  it('upcoming card answers with a toast instead of a broken scroll target', () => {
    document.getElementById('rentUpcomingCard').click();
    expect(document.getElementById('rentUpcomingPanel')).toBeNull();
    expect(document.querySelector('.toast-warning')?.textContent).toContain('אין תשלומים קרובים');
  });

  it('deposited-checks card answers with a toast instead of an empty list', () => {
    document.getElementById('rentChecksCard').click();
    expect(document.querySelector('.toast-warning')?.textContent).toContain("אין צ'קים שהופקדו");
    expect(document.getElementById('rentHistoryPanel').innerHTML).toBe('');
  });

  it('annual card still scrolls to the authorities anchor', () => {
    document.getElementById('rentAnnualCard').click();
    expect(document.getElementById('rentAuthoritiesTop')).not.toBeNull();
  });
});
