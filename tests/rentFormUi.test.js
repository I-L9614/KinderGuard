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
  agreements: [],
  payments: [], groups: [], totals: {},
};

let fetchCalls;
const stub = (url) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: 'stub' };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן הדוגמה' }];
  if (p === '/api/licenses') return [];
  if (p === '/api/notifications') return [];
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return [];
  if (p === '/api/users') return [];
  if (p === '/api/rent/summary') return rentSummary;
  if (p === '/api/rent/agreements') return { _id: 'new-ag' };
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
  document.getElementById('newAgreement').click();
  await flush();
};

const form = () => document.getElementById('rentAgreementForm');
const visible = (id) => !document.getElementById(id).hidden;
const setFrequency = (value) => {
  const select = form().elements.frequency;
  select.value = value;
  select.dispatchEvent(new Event('change'));
};

describe('rent agreement form: one amount input per frequency', () => {
  beforeEach(boot);

  it('shows only the monthly amount field by default', () => {
    expect(visible('monthlyWrap')).toBe(true);
    expect(visible('quarterlyWrap')).toBe(false);
    expect(visible('annualWrap')).toBe(false);
  });

  it.each(['quarterly', 'annual'])('shows only the %s amount field when %s is chosen', (freq) => {
    setFrequency(freq);
    expect(visible('monthlyWrap')).toBe(false);
    expect(visible('quarterlyWrap')).toBe(freq === 'quarterly');
    expect(visible('annualWrap')).toBe(freq === 'annual');
  });

  it('explains that the monthly equivalent is display-only, payment stays quarterly/annual', () => {
    setFrequency('quarterly');
    expect(document.getElementById('quarterlyWrap').textContent).toContain('התשלום בפועל רבעוני');
    expect(document.getElementById('quarterlyWrap').textContent).toContain('לתצוגה בלבד');
    setFrequency('annual');
    expect(document.getElementById('annualWrap').textContent).toContain('התשלום בפועל שנתי');
    expect(document.getElementById('annualWrap').textContent).toContain('לתצוגה בלבד');
  });

  it('submits only the amount field of the chosen frequency', async () => {
    setFrequency('quarterly');
    form().elements.quarterlyAmount.value = '7500';
    form().elements.firstDueDate.value = '2027-02-01';
    form().dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    const create = fetchCalls.find((c) => c.method === 'POST' && c.url === '/api/rent/agreements');
    expect(create).toBeTruthy();
    const body = JSON.parse(create.body);
    expect(body.quarterlyAmount).toBe('7500');
    expect(body.monthlyAmount).toBeUndefined();
    expect(body.annualAmount).toBeUndefined();
    expect(body.frequency).toBe('quarterly');
  });
});

describe('rent agreement form: upfront cheque series follows the cadence', () => {
  beforeEach(boot);

  const openSeries = () => {
    const toggle = form().elements.hasSeries;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
  };

  it.each([['monthly', '12'], ['quarterly', '4'], ['annual', '1']])('prefills %s series to %s cheques a year', (freq, count) => {
    setFrequency(freq);
    openSeries();
    expect(form().elements.depositedCount.value).toBe(count);
  });

  it('suggests the series end on the due date of the year\'s last cheque', () => {
    form().elements.firstDueDate.value = '2027-01-31';
    form().elements.firstDueDate.dispatchEvent(new Event('change'));
    setFrequency('quarterly');
    openSeries();
    // 4 quarterly cheques from Jan 31: Jan 31, Apr 30, Jul 31, Oct 31.
    expect(form().elements.seriesEndDate.value).toBe('2027-10-31');
    setFrequency('annual');
    // A single annual cheque: the series ends on its own due date.
    expect(form().elements.seriesEndDate.value).toBe('2027-01-31');
    setFrequency('monthly');
    // 12 monthly cheques clamped to month ends: Jan 31 ... Dec 31.
    expect(form().elements.seriesEndDate.value).toBe('2027-12-31');
  });

  it('never overwrites a manually entered series count or end date', () => {
    setFrequency('quarterly');
    openSeries();
    form().elements.depositedCount.value = '2';
    form().elements.depositedCount.dispatchEvent(new Event('input'));
    form().elements.seriesEndDate.value = '2027-05-15';
    form().elements.seriesEndDate.dispatchEvent(new Event('input'));
    setFrequency('monthly');
    expect(form().elements.depositedCount.value).toBe('2');
    expect(form().elements.seriesEndDate.value).toBe('2027-05-15');
  });

  it('states that depositing a series does not mark any payment as cleared', () => {
    openSeries();
    expect(document.getElementById('seriesWrap').textContent).toContain('לא מסמנת תשלום כנפרע');
  });
});
