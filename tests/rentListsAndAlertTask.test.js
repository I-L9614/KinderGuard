// @vitest-environment jsdom
// Rent open-payment lists split (past-due vs today..+30 days, each capped at 7
// with a show-all toggle) and the "open task" button on alert rows.
// Boots the REAL frontend/main.js in jsdom with a stubbed transport.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const upcomingPayment = (i) => ({ _id: `up${i}`, agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'transfer', amount: 1000 + i, dueDate: inDays(i + 1), status: 'Pending' });

const rentSummary = {
  authorities: [{ _id: 'auth1', name: 'מועצה אזורית בדיקה' }],
  agreements: [{ _id: 'ag1', branchId: { _id: 'b1', name: 'גן הדוגמה' }, authorityId: { _id: 'auth1', name: 'מועצה אזורית בדיקה' }, status: 'Active', frequency: 'monthly', paymentMethod: 'cheque', monthlyAmount: 5000, annualAmount: 60000 }],
  payments: [
    { _id: 'o1', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'cheque', amount: 1111, dueDate: inDays(-40), status: 'Pending' },
    { _id: 'o2', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'transfer', amount: 2222, dueDate: inDays(-3), status: 'Handed' },
    ...Array.from({ length: 9 }, (_, i) => upcomingPayment(i)),
    { _id: 'c1', agreementId: 'ag1', branchName: 'גן הדוגמה', authorityName: 'מועצה אזורית בדיקה', method: 'transfer', amount: 5000, dueDate: inDays(-10), status: 'Cleared', clearedAt: inDays(-9) },
  ],
  groups: [],
  totals: { auth1: { monthly: 5000, annual: 60000 } },
};

const notifications = [
  { _id: 'n1', kind: 'License', status: 'Open', triggerDays: 7, branchId: { _id: 'b1' }, licenseId: { licenseTypeId: 'lt1', expiryDate: inDays(7) } },
  { _id: 'n2', kind: 'Rent', status: 'Open', rentTrigger: 'week_before', branchName: 'גן הדוגמה', amount: 5000, dueDate: inDays(5), branchId: { _id: 'b1' } },
];

let fetchCalls;

const makeApiStub = () => (url) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: 'u1' })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן הדוגמה' }];
  if (p === '/api/licenses') return [];
  if (p === '/api/notifications') return notifications;
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return [{ _id: 'lt1', name: 'רישיון גן' }];
  if (p === '/api/users') return [];
  if (p === '/api/rent/summary') return rentSummary;
  return {};
};

const flush = () => new Promise((r) => setTimeout(r, 50));

const boot = async (page) => {
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
  window.scrollTo = vi.fn();
  const stub = makeApiStub();
  fetchCalls = [];
  global.fetch = vi.fn(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), method: options.method || 'GET', body: options.body });
    return { ok: true, status: 200, json: async () => stub(url), text: async () => JSON.stringify(stub(url)) };
  });
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
  document.querySelector(`[data-page="${page}"]`).click();
  await flush();
};

describe('rent open-payment lists split', () => {
  beforeEach(() => boot('rent'));

  it('past-due open payments sit in their own panel, oldest first', () => {
    const panel = document.getElementById('rentOverduePanel');
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain('עבר מועד הפרעון');
    const rows = panel.querySelectorAll('[data-payment-id]');
    expect(rows.length).toBe(2); // o1 Pending + o2 Handed, not c1 Cleared
    expect(rows[0].dataset.paymentId).toBe('o1'); // oldest first
    expect(rows[1].dataset.paymentId).toBe('o2');
  });

  it('upcoming panel holds only today..+30 days and is capped at 7 with show-all', async () => {
    const panel = document.getElementById('rentUpcomingPanel');
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('[data-payment-id]').length).toBe(7);
    const more = document.querySelector('[data-rent-more="rentShowAllUpcoming"]');
    expect(more).not.toBeNull();
    expect(more.textContent).toBe('הצג הכול (עוד 2)');
    more.click();
    await flush();
    expect(document.querySelectorAll('#rentUpcomingPanel [data-payment-id]').length).toBe(9);
    expect(document.querySelector('[data-rent-more="rentShowAllUpcoming"]').textContent).toBe('הצג פחות');
  });

  it('overdue list of 2 shows no show-all button, and the upcoming card counts only true upcoming', () => {
    expect(document.querySelector('[data-rent-more="rentShowAllOverdue"]')).toBeNull();
    expect(document.querySelector('#rentUpcomingCard .stat-icon').textContent).toBe('9');
  });
});

describe('open task from an alert', () => {
  beforeEach(() => boot('alerts'));

  it('every open alert row offers the task button alongside treatment controls', () => {
    const rows = document.querySelectorAll('#app .alert-card');
    expect(rows.length).toBe(2);
    rows.forEach((row) => {
      expect(row.querySelector('[data-alert-task]')).not.toBeNull();
      expect(row.querySelector('[data-alert-action="In_Progress"]')).not.toBeNull();
      expect(row.querySelector('[data-alert-action="Resolved"]')).not.toBeNull();
    });
  });

  it('license alert prefills the task form and saves through the tasks API', async () => {
    document.querySelector('[data-alert-task="n1"]').click();
    const form = document.getElementById('taskForm');
    expect(form).not.toBeNull();
    expect(form.querySelector('[name="title"]').value).toBe('חידוש רישיון גן - גן הדוגמה');
    expect(form.querySelector('[name="dueDate"]').value).toBe(inDays(7).slice(0, 10));
    expect(form.querySelector('[name="branchId"]').value).toBe('b1');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const create = fetchCalls.find((c) => c.url === '/api/tasks' && c.method === 'POST');
    expect(create).toBeTruthy();
    expect(JSON.parse(create.body).title).toBe('חידוש רישיון גן - גן הדוגמה');
    await flush();
    expect(document.getElementById('taskForm')).toBeNull(); // modal closed
    expect(document.querySelector('#app h2').textContent).toContain('התראות'); // stayed on alerts
  });

  it('rent alert prefills a payment task', () => {
    document.querySelector('[data-alert-task="n2"]').click();
    const form = document.getElementById('taskForm');
    expect(form.querySelector('[name="title"]').value).toBe('תשלום שכירות - גן הדוגמה');
    expect(form.querySelector('[name="dueDate"]').value).toBe(inDays(5).slice(0, 10));
  });
});
