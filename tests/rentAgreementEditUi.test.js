// @vitest-environment jsdom
// Rent agreement form (v0.3.18 work): boots the REAL frontend/main.js in jsdom
// with a stubbed transport and checks the frequency-driven form behavior: the
// chosen cadence shows exactly one amount input (monthly/quarterly/annual),
// only that field is submitted, and an upfront cheque series prefills to one
// year of the cadence (12 monthly / 4 quarterly / 1 annual) with the end date
// on the year's last cheque.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const rentSummary = {
  authorities: [{ _id: 'auth1', name: 'מועצה אזורית בדיקה' }],
  agreements: [{ _id: 'ag1', branchId: { _id: 'b1', name: 'גן הדוגמה' }, authorityId: 'auth1', authorityName: 'מועצה אזורית בדיקה', direction: 'outgoing', frequency: 'monthly', paymentMethod: 'cheque', monthlyAmount: 1000, firstDueDate: '2026-01-01T00:00:00.000Z', status: 'Active', documents: [] }],
  payments: [
    { _id: 'p1', agreementId: 'ag1', status: 'Pending', groupId: null, lastEditedAt: null, amount: 1000, dueDate: '2026-12-01T00:00:00.000Z', branchName: 'גן הדוגמה' },
    { _id: 'p2', agreementId: 'ag1', status: 'Pending', groupId: null, lastEditedAt: null, amount: 1000, dueDate: '2027-01-01T00:00:00.000Z', branchName: 'גן הדוגמה' },
    { _id: 'p3', agreementId: 'ag1', status: 'Handed', groupId: null, lastEditedAt: null, amount: 1000, dueDate: '2026-11-01T00:00:00.000Z', branchName: 'גן הדוגמה' },
    { _id: 'p4', agreementId: 'ag1', status: 'Pending', groupId: null, lastEditedAt: '2026-11-02T00:00:00.000Z', amount: 900, dueDate: '2027-02-01T00:00:00.000Z', branchName: 'גן הדוגמה' },
  ], groups: [], totals: {},
};
let fetchCalls;
const stub = (url) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: 'u1' })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן הדוגמה' }];
  if (p === '/api/licenses') return [];
  if (p === '/api/notifications') return [];
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return [];
  if (p === '/api/users') return [];
  if (p === '/api/rent/summary') return rentSummary;
  if (p === '/api/rent/agreements/ag1') return { _id: 'ag1' };
  throw new Error('unstubbed endpoint: ' + p);
};

const flush = () => new Promise((r) => setTimeout(r, 50));

const boot = async () => {
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
  document.querySelector('[data-page="rent"]').click();
  await flush();
};


describe('rent agreement edit from the screen', () => {
  beforeEach(boot);
  it('opens an edit form that states which payments follow and which stay', async () => {
    document.querySelector('[data-rent-edit="ag1"]').click(); await flush();
    const f = document.getElementById('rentAgreementEditForm');
    expect(f).toBeTruthy(); expect(f.elements.amount.value).toBe('1000');
    const note = document.getElementById('editImpact').textContent;
    expect(note).toContain('רק תשלומים ממתינים שלא נגעו בהם'); expect(note).toContain('2 תשלומים שנמסרו, נפרעו, קובצו או תוקנו ידנית נשארים');
  });
  it('an amount change requires choosing retroactive or from-date (no default); then PATCH carries it', async () => {
    document.querySelector('[data-rent-edit="ag1"]').click(); await flush();
    const f = document.getElementById('rentAgreementEditForm');
    expect(document.getElementById('editScope').hidden).toBe(true);
    f.requestSubmit(); await flush();
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0); // no change: nothing sent
    f.elements.amount.value = '1200'; f.elements.amount.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    expect(document.getElementById('editScope').hidden).toBe(false);
    expect(f.elements.amountScope.value).toBe(''); expect(f.querySelector('button.primary').disabled).toBe(true);
    f.requestSubmit(); await flush();
    expect(fetchCalls.filter((c) => c.method === 'PATCH')).toHaveLength(0); // still no choice: nothing sent
    f.querySelector('input[name=amountScope][value=future]').checked = true; f.querySelector('input[name=amountScope][value=future]').dispatchEvent(new Event('change', { bubbles: true })); await flush();
    expect(document.getElementById('editFromWrap').hidden).toBe(false);
    expect(f.elements.amountEffectiveFrom.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    f.requestSubmit(); await flush();
    const patch = fetchCalls.filter((c) => c.method === 'PATCH');
    expect(patch).toHaveLength(1); expect(patch[0].url).toBe('/api/rent/agreements/ag1');
    expect(JSON.parse(patch[0].body)).toEqual({ monthlyAmount: '1200', amountScope: 'future', amountEffectiveFrom: f.elements.amountEffectiveFrom.value });
  });
});
