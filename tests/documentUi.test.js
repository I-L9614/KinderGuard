// @vitest-environment jsdom
// Document-management UI (v0.3.8 work): boots the REAL frontend/main.js in
// jsdom with a stubbed transport and checks the new license/rent document
// controls render and call the right endpoints.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const inDays = (n) => new Date(Date.now() + n * 86400000).toISOString();

const branches = [{ _id: 'b1', name: 'גן הדוגמה', address: 'רחוב הבדיקה 1' }];
const licenseTypes = [
  { _id: 't1', name: 'אישור בטיחות', branchId: null, active: true },
  { _id: 't2', name: 'כיבוי אש שנתי', branchId: null, active: true },
  { _id: 't3', name: 'בודק חשמל 5 שנתי', branchId: null, active: true },
];
const licenses = [{
  _id: 'l1', branchId: 'b1', licenseTypeId: { _id: 't1', name: 'אישור בטיחות' },
  issueDate: inDays(-100), expiryDate: inDays(265), status: 'Valid',
  fileUrl: 'licenses/1-doc.pdf', fileName: 'permit.pdf',
}];
const rentSummary = {
  authorities: [{ _id: 'auth1', name: 'מועצה אזורית בדיקה' }],
  agreements: [{
    _id: 'ag1', branchId: { _id: 'b1', name: 'גן הדוגמה' }, authorityId: { _id: 'auth1', name: 'מועצה אזורית בדיקה' },
    status: 'Active', frequency: 'monthly', paymentMethod: 'cheque', monthlyAmount: 5000, annualAmount: 60000,
    documents: [{ _id: 'd1', key: 'rent/1-contract.pdf', fileName: 'contract.pdf', uploadedAt: inDays(-3) }],
  }],
  payments: [], groups: [], totals: {},
};

let fetchCalls;
const stub = (url) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: 'u1' })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return { _id: 'u1', name: 'בודק', role: 'Admin' };
  if (p === '/api/branches') return branches;
  if (p === '/api/licenses') return licenses;
  if (p === '/api/licenses/l1/history') return licenses;
  if (p === '/api/notifications') return [];
  if (p === '/api/tasks') return [];
  if (p === '/api/license-types') return licenseTypes;
  if (p === '/api/users') return [];
  if (p === '/api/rent/summary') return rentSummary;
  if (p.endsWith('/file') || p.includes('/documents/') || p.endsWith('/documents')) return {};
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
    fetchCalls.push({ url: String(url), method: options.method || 'GET' });
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
};

const openBranch = async () => {
  document.querySelector('[data-branch="b1"]').click();
  await flush();
};

describe('license document controls', () => {
  beforeEach(boot);

  it('shows a delete-document button on a license row with a file and confirms before deleting', async () => {
    await openBranch();
    const button = document.querySelector('[data-delete-license-file="l1"]');
    expect(button).not.toBeNull();
    expect(button.textContent).toBe('מחיקת מסמך');

    button.click();
    const modal = document.querySelector('.modal-backdrop');
    expect(modal.textContent).toContain('permit.pdf');
    expect(modal.textContent).toContain('האישור עצמו, תאריכיו וההיסטוריה נשארים');

    modal.querySelector('#confirmDeleteFile').click();
    await flush();
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url === '/api/licenses/l1/file')).toBe(true);
  });

  it('license form offers an unchecked delete-old-document checkbox', async () => {
    await openBranch();
    document.getElementById('addLicense').click();
    const checkbox = document.querySelector('#licenseForm input[name="deleteOldFile"]');
    expect(checkbox).not.toBeNull();
    expect(checkbox.type).toBe('checkbox');
    expect(checkbox.checked).toBe(false);
    expect(document.querySelector('#licenseForm').textContent).toContain('מחק גם את המסמך של האישור המוחלף');
  });

  it('history rows keep their own delete-document button', async () => {
    await openBranch();
    document.querySelector('[data-history="l1"]').click();
    await flush();
    const panel = document.getElementById('historyPanel');
    expect(panel.querySelector('[data-delete-license-file="l1"]')).not.toBeNull();
  });
});

describe('license expiry auto-fill', () => {
  beforeEach(boot);

  const openForm = async () => {
    await openBranch();
    document.getElementById('addLicense').click();
    const form = document.getElementById('licenseForm');
    return {
      form,
      type: form.querySelector('[name="licenseTypeId"]'),
      issue: form.querySelector('[name="issueDate"]'),
      expiry: form.querySelector('[name="expiryDate"]'),
    };
  };
  const setValue = (input, value, eventName = 'input') => {
    input.value = value;
    input.dispatchEvent(new Event(eventName, { bubbles: true }));
  };
  const selectType = (select, value) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('fills the expiry from the issue date by the type period (1 year and 5 years)', async () => {
    const { type, issue, expiry } = await openForm();
    selectType(type, 't2'); // כיבוי אש שנתי
    setValue(issue, '2026-11-17');
    expect(expiry.value).toBe('2027-11-17');
    selectType(type, 't3'); // בודק חשמל 5 שנתי
    expect(expiry.value).toBe('2031-11-17');
  });

  it('keeps a manual expiry edit when the type or issue date changes', async () => {
    const { type, issue, expiry } = await openForm();
    selectType(type, 't2');
    setValue(issue, '2026-11-17');
    expect(expiry.value).toBe('2027-11-17');
    setValue(expiry, '2028-05-01'); // user corrects per the actual document
    selectType(type, 't3');
    expect(expiry.value).toBe('2028-05-01');
    setValue(issue, '2026-01-01');
    expect(expiry.value).toBe('2028-05-01');
  });

  it('re-enables auto-fill after the user clears the field', async () => {
    const { type, issue, expiry } = await openForm();
    selectType(type, 't2');
    setValue(issue, '2026-11-17');
    setValue(expiry, '2028-05-01');
    setValue(expiry, ''); // cleared -> auto-fill resumes
    expect(expiry.value).toBe('2027-11-17');
  });

  it('leaves the field empty for a type with no clear period - no guessing', async () => {
    const { type, issue, expiry } = await openForm();
    selectType(type, 't1'); // אישור בטיחות - no period in the name
    setValue(issue, '2026-11-17');
    expect(expiry.value).toBe('');
  });

  it('clears an auto-filled value when switching to a period-less type', async () => {
    const { type, issue, expiry } = await openForm();
    selectType(type, 't2');
    setValue(issue, '2026-11-17');
    expect(expiry.value).toBe('2027-11-17');
    selectType(type, 't1');
    expect(expiry.value).toBe('');
  });
});

describe('rent agreement documents modal', () => {
  beforeEach(boot);

  it('lists documents with open/delete controls and an upload form, separate from licenses', async () => {
    document.querySelector('[data-page="rent"]').click();
    await flush();
    const docsButton = document.querySelector('[data-rent-docs="ag1"]');
    expect(docsButton).not.toBeNull();
    expect(docsButton.textContent).toBe('מסמכים (1)');

    docsButton.click();
    const modal = document.querySelector('.modal-backdrop');
    expect(modal.querySelector('h3').textContent).toBe('מסמכי שכירות · גן הדוגמה');
    expect(modal.querySelector('[data-rent-open-doc="d1"]').textContent).toBe('contract.pdf');
    expect(modal.querySelector('[data-rent-del-doc="d1"]')).not.toBeNull();
    const form = modal.querySelector('#rentDocForm');
    expect(form).not.toBeNull();
    expect(form.textContent).toContain('מסמכי שכירות נשמרים בנפרד ממסמכי האישורים');
    expect(form.querySelector('input[type="file"]').getAttribute('accept')).toBe('.pdf,image/*');
  });

  it('confirms before deleting a rent document and calls the rent document route', async () => {
    document.querySelector('[data-page="rent"]').click();
    await flush();
    document.querySelector('[data-rent-docs="ag1"]').click();
    document.querySelector('[data-rent-del-doc="d1"]').click();
    const confirmModal = [...document.querySelectorAll('.modal-backdrop')].pop();
    expect(confirmModal.textContent).toContain('contract.pdf');
    expect(confirmModal.textContent).toContain('הסכם השכירות והתשלומים נשארים');

    confirmModal.querySelector('#confirmDeleteRentDoc').click();
    await flush();
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url === '/api/rent/agreements/ag1/documents/d1')).toBe(true);
  });
});

describe('rent document delete refresh', () => {
  beforeEach(boot);

  it('removes the deleted document from the open modal instead of leaving a stale entry', async () => {
    document.querySelector('[data-page="rent"]').click();
    await flush();
    document.querySelector('[data-rent-docs="ag1"]').click();
    const docsModal = document.querySelector('.modal-backdrop');
    document.querySelector('[data-rent-del-doc="d1"]').click();
    const confirmModal = [...document.querySelectorAll('.modal-backdrop')].pop();
    confirmModal.querySelector('#confirmDeleteRentDoc').click();
    await flush();
    expect(fetchCalls.some((c) => c.method === 'DELETE' && c.url === '/api/rent/agreements/ag1/documents/d1')).toBe(true);
    // The documents modal is still open and now shows the empty state, not
    // the deleted file.
    expect(docsModal.isConnected).toBe(true);
    expect(docsModal.querySelector('[data-rent-del-doc]')).toBeNull();
    expect(docsModal.textContent).not.toContain('contract.pdf');
    expect(docsModal.textContent).toContain('אין עדיין מסמכים להסכם זה');
  });
});
