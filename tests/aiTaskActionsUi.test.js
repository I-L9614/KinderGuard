// @vitest-environment jsdom
// AI task actions:  with aiEnabled, sends the prompt, shows the reply, and
// shows a friendly error when the server refuses.
import { describe, it, expect, vi } from 'vitest';

let me; let askImpl; let saved = []; let calls = []; let tasks = []; let failNext = false; let nextError = ''; let confirmResult = null; let reportImpl = null;
const stub = (url, options) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: me?._id })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return me;
  if (p === '/api/licenses' && options?.method === 'POST') { saved.push(options); return {}; }
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן א', address: '' }];
  if (p === '/api/license-types') return [{ _id: 't1', name: 'אישור בטיחות', branchId: null, active: true }, { _id: 't2', name: 'כיבוי אש שנתי', branchId: null, active: true }];
  if (['/api/licenses', '/api/notifications', '/api/users'].includes(p)) return [];
  if (p === '/api/ai/reports/ask') return reportImpl;
  if (p === '/api/ai/tasks/propose') return askImpl(options);
  if (p === '/api/ai/branches/propose') return askImpl(options);
  if (p === '/api/ai/branches/file-propose') { calls.push(['FILE', options.body instanceof FormData && options.body.get('file')?.name, options.body.get('consentExternal') || '']); return askImpl(options); }
  if (p.startsWith('/api/ai/proposals/')) { calls.push(['CONFIRM', p]); if (failNext) { failNext = false; const e = new Error('שמירה נכשלה'); e.status = 500; throw e; } if (nextError) { const e = new Error(nextError); e.status = 409; nextError = ''; throw e; } if (confirmResult) { const r = confirmResult; confirmResult = null; return { status: 'done', result: r }; } return { status: 'done' }; }
  if (p.startsWith('/api/tasks/') && options?.method === 'PATCH') { calls.push(['PATCH', p, options.body]); return {}; }
  if (p === '/api/tasks') return tasks;
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



const start = async (proposal) => {
  calls = []; failNext = false; tasks = [{ _id: 't1', title: 'תשלום לספק', status: 'To_Do', notes: '', editable: true }];
  askImpl = () => proposal;
  await boot({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
  document.querySelector('[data-page="ai"]').click(); await flush();
  document.querySelector('[data-aimode="tasks"]').click(); await flush();
  const f = document.getElementById('aiForm'); f.elements.prompt.value = 'סגור'; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
};
const close = { summary: 'סוגר', actions: [{ type: 'close_task', taskId: 't1', proposalId: 'p1', currentTitle: 'תשלום לספק', currentStatus: 'To_Do', status: 'Done' }, { type: 'create_task', proposalId: 'p2', title: 'בדיקה', notes: '', dueDate: null, branchId: null }], unclear: '', rejected: [], branches: [] };
describe('AI task actions UI', () => {
  it('shows exact changes and saves nothing until each is confirmed', async () => {
    await start(close);
    expect(document.getElementById('aiLog').textContent).toContain('סגירת משימה: תשלום לספק');
    expect(calls).toHaveLength(0);
    document.querySelector('[data-confirm="1:1"]') || null;
    const btns = [...document.querySelectorAll('[data-confirm]')];
    btns[0].click(); await flush();
    expect(calls).toEqual([['CONFIRM', '/api/ai/proposals/p1/confirm']]);
  });
  it('a second click on a confirmed action does not repeat it', async () => {
    await start({ ...close, actions: [close.actions[1]] });
    const b = document.querySelector('[data-confirm]'); b.click(); b.click(); await flush();
    expect(calls).toEqual([['CONFIRM', '/api/ai/proposals/p2/confirm']]);
    expect(document.querySelector('[data-confirm]')).toBeNull();
  });
  it('shows the server refusal when the task changed after the proposal', async () => {
    await start({ ...close, actions: [close.actions[0]] });
    nextError = 'המשימה השתנתה מאז ההצעה. בקשו הצעה חדשה.';
    document.querySelector('[data-confirm]').click(); await flush(); expect(document.getElementById('aiLog').textContent).toContain('המשימה השתנתה');
  });
  it('a failed save is shown and stays retryable; others unaffected', async () => {
    await start(close); failNext = true;
    const btns = [...document.querySelectorAll('[data-confirm]')];
    btns[1].click(); await flush();
    expect(document.getElementById('aiLog').textContent).toContain('שמירה נכשלה');
    expect(document.querySelectorAll('[data-confirm]').length).toBe(2);
  });
  it('empty proposal explains and offers nothing to confirm', async () => {
    await start({ summary: '', actions: [], unclear: 'לא נמצאה משימה כזו', rejected: [], branches: [] });
    expect(document.querySelectorAll('[data-confirm]').length).toBe(0);
    expect(document.getElementById('aiLog').textContent).toContain('לא נמצאה משימה כזו');
  });
  it('cancel dismisses one card without any request, leaves the other card, and cannot be confirmed afterwards', async () => {
    await start(close);
    document.querySelector('[data-dismiss="1:0"]').click(); await flush();
    expect(calls).toHaveLength(0);
    expect(document.getElementById('aiLog').textContent).toContain('בוטל, לא נשמר דבר');
    expect(document.querySelector('[data-confirm="1:0"]')).toBeNull();
    expect(document.querySelector('[data-confirm="1:1"]')).not.toBeNull();
    document.querySelector('[data-confirm="1:1"]').click(); await flush();
    expect(calls).toEqual([['CONFIRM', '/api/ai/proposals/p2/confirm']]);
  });
  it('a document-delete card isolates the Hebrew/Latin filename direction and needs the password', async () => {
    await start({ summary: '', actions: [{ type: 'delete_agreement_document', domain: 'agreement', sensitive: true, proposalId: 'p9', agreementId: 'a', docId: 'd', fileName: 'חוזה-2026.pdf', branchName: 'גן', authorityName: 'עיר', version: 'x' }], unclear: '', rejected: [], branches: [] });
    expect(document.getElementById('aiLog').textContent).toContain('\u2066חוזה-2026.pdf\u2069');
    expect(document.querySelector('[data-pass]')).not.toBeNull();
  });
  it('a multi-branch proposal shows before and after per branch, one confirm each', async () => {
    const mkA = (i, before) => ({ type: 'update_branch', domain: 'branch', sensitive: false, proposalId: `pb${i}`, branchId: `b${i}`, currentName: `סניף ${i}`, before: { phone: before }, needsChoice: false, candidates: [], fields: { phone: '09-7777777' }, warning: '' });
    await start({ summary: '', actions: [mkA(1, '03-1111111'), mkA(2, '')], unclear: '', rejected: [], branches: [] });
    const t = document.getElementById('aiLog').textContent;
    expect(t).toContain('טלפון נוכחי: \u206803-1111111\u2069'); expect(t).toContain('טלפון מוצע: \u206809-7777777\u2069'); expect(t).toContain('טלפון נוכחי: \u2068ריק\u2069'); expect(t).toContain('טלפון מוצע: \u206809-7777777\u2069');
    expect(document.querySelectorAll('[data-confirm]')).toHaveLength(2);
  });
  it('branch file: picking a file posts it once, shows per-branch cards, unmatched notes, and saves nothing', async () => {
    const mkA = (i, before, needsChoice = false) => ({ type: 'update_branch', domain: 'branch', sensitive: false, proposalId: `pf${i}`, branchId: needsChoice ? null : `b${i}`, currentName: needsChoice ? null : `סניף ${i}`, before: needsChoice ? null : { phone: before }, needsChoice, candidates: needsChoice ? [{ id: 'x1', name: 'גן שקד', before: { phone: 'A' } }, { id: 'x2', name: 'גן שקד צפון', before: { phone: 'B' } }] : [], fields: { phone: '09-1' }, warning: needsChoice ? 'בקובץ כתוב "שקד" ואין סניף בשם זהה. בחרו את הסניף המדויק או בטלו.' : '' });
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="branches"]').click(); await flush();
    askImpl = () => ({ summary: 'נמצאו 3 שורות בקובץ, 2 הצעות עדכון. בדקו לפני אישור:', actions: [mkA(1, '03-1'), mkA(2, '', true)], rejected: ['לא נמצא סניף בשם "גן לא קיים". לא נוצר סניף ולא בוצע שינוי'], source: 'csv', branches: [] });
    const fin = document.getElementById('aiBranchFile'); const file = new File(['שם,טלפון\nגן,1'], 'מעונות.csv', { type: 'text/csv' });
    Object.defineProperty(fin, 'files', { value: [file] }); fin.dispatchEvent(new Event('change')); await flush();
    expect(calls).toEqual([]); document.getElementById('aiPreLocal').click(); await flush(); expect(calls).toEqual([['FILE', 'מעונות.csv', '']]);
    const t = document.getElementById('aiLog').textContent;
    expect(t).toContain('טלפון נוכחי: \u206803-1\u2069'); expect(t).toContain('טלפון מוצע: \u206809-1\u2069'); expect(t).toContain('בחרו את הסניף המדויק'); expect(t).toContain('לא נוצר סניף'); expect(t).toContain('גן שקד צפון'); expect(t).toContain('טלפון נוכחי: \u2068B\u2069'); expect(t).toContain('טלפון נוכחי: \u2068A\u2069');
    expect(document.querySelectorAll('[data-confirm]')).toHaveLength(2);
  });
  it('branch file: docx offers the optional pre-check card, and the local-read choice goes to the server with no send-approval step; an unsupported type is refused in Hebrew with nothing sent', async () => {
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="branches"]').click(); await flush();
    askImpl = () => ({ summary: 's', actions: [], rejected: [], source: 'docx', branches: [] });
    const fin = () => document.getElementById('aiBranchFile');
    Object.defineProperty(fin(), 'files', { value: [new File(['x'], 'טבלה.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })], configurable: true }); fin().dispatchEvent(new Event('change')); await flush();
    expect(calls).toEqual([]); expect(document.getElementById('aiPreCard')).not.toBeNull(); document.getElementById('aiPreLocal').click(); await flush();
    expect(calls).toEqual([['FILE', 'טבלה.docx', '']]);
    Object.defineProperty(fin(), 'files', { value: [new File(['x'], 'ארכיון.zip', { type: 'application/zip' })], configurable: true }); fin().dispatchEvent(new Event('change')); await flush();
    expect(calls).toHaveLength(1); expect(document.getElementById('aiLog').textContent).toContain('סוג הקובץ הזה לא נתמך'); expect(document.body.textContent).not.toContain('שליחה ל-Claude');
  });
  it('branch create with a failed payer link says the branch WAS created, not to create it again, and is not shown as a clean success', async () => {
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="branches"]').click(); await flush();
    askImpl = () => ({ summary: 's', actions: [{ type: 'create_branch', domain: 'branch', sensitive: false, proposalId: 'pc1', branchId: null, currentName: null, before: null, needsChoice: false, candidates: [], fields: { name: 'גן חדש', authorityId: 'p1' }, authorityNames: { p1: 'עיריית דוגמה' }, warning: '' }], rejected: [], branches: [] });
    const f = document.getElementById('aiForm'); f.elements.prompt.value = 'פתח סניף'; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(document.getElementById('aiLog').textContent).toContain('גוף משלם: עיריית דוגמה');
    confirmResult = { branchId: 'nb1', payerLinkFailed: true };
    document.querySelector('[data-confirm]').click(); await flush(); await flush();
    const t = document.getElementById('aiLog').textContent;
    expect(t).toContain('הסניף נוצר, אבל גוף המשלם לא נקשר'); expect(t).toContain('אל תיצרו את הסניף שוב'); expect(document.querySelector('.ai-state.err')).not.toBeNull(); expect(t).not.toContain('יש לבחור למטה'); expect(t).not.toContain('שום דבר לא נשמר עד שתאשרו'); expect(t).toContain('גוף משלם: לא נקשר'); expect(document.querySelector('.ai-choice')).toBeNull();
  });
  it('a failed payer link with a different live payer persisted shows that actual payer, not unlinked', async () => {
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="branches"]').click(); await flush();
    askImpl = () => ({ summary: 's', actions: [{ type: 'create_branch', domain: 'branch', sensitive: false, proposalId: 'pc1', branchId: null, currentName: null, before: null, needsChoice: false, candidates: [], fields: { name: 'גן חדש', authorityId: 'p1' }, authorityNames: { p1: 'עיריית דוגמה' }, warning: '' }], rejected: [], branches: [] });
    const f = document.getElementById('aiForm'); f.elements.prompt.value = 'פתח סניף'; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(document.getElementById('aiLog').textContent).toContain('גוף משלם: עיריית דוגמה');
    confirmResult = { branchId: 'nb1', payerLinkFailed: true, persistedPayerName: 'עיריית שלישית' };
    document.querySelector('[data-confirm]').click(); await flush(); await flush();
    const t = document.getElementById('aiLog').textContent;
    expect(t).toContain('גוף משלם: עיריית שלישית'); expect(t).toContain('הקישור לגוף המשלם שנבחר נכשל'); expect(t).toContain('אל תיצרו את הסניף שוב'); expect(t).not.toContain('גוף משלם: לא נקשר'); expect(t).not.toContain('לא נקשר אליו');
  });
  it('a licenses report row with a file gets an open button that uses the existing authorized file endpoint; the id never shows as text', async () => {
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="reports"]').click(); await flush();
    const id = 'a'.repeat(24);
    reportImpl = { report: 'licenses_all', title: 'כל האישורים', count: 2, rows: [{ branch: 'גן א', type: 'כבאות', expiryDate: 'בתוקף עד 2027', file: 'יש קובץ', fileLicenseId: id }, { branch: 'גן ב', type: 'כבאות', expiryDate: 'בתוקף עד 2027', file: 'אין קובץ' }] };
    const f = document.getElementById('aiForm'); f.elements.prompt.value = 'כל האישורים'; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    const t = document.getElementById('aiLog').textContent;
    expect(t).not.toContain(id);
    const btns = document.querySelectorAll('[data-openlic]');
    expect(btns.length).toBe(1); expect(btns[0].dataset.openlic).toBe(id); expect(btns[0].textContent).toContain('גן א');
    const seen = []; const realFetch = globalThis.fetch; const realOpen = window.open;
    globalThis.fetch = async (u) => { seen.push(String(u)); return { ok: true, blob: async () => new Blob(['x']) }; }; window.open = () => null; URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {};
    btns[0].click(); await flush();
    globalThis.fetch = realFetch; window.open = realOpen;
    expect(seen).toEqual([`/api/licenses/${id}/file`]);
  });
  it('branch file: a PDF is held behind an explicit send approval; cancel sends nothing; approve sends with consent; html in values stays text', async () => {
    await start({ summary: 'x', actions: [], unclear: '', rejected: [], branches: [] });
    document.querySelector('[data-aimode="branches"]').click(); await flush();
    askImpl = () => ({ summary: 's', actions: [{ type: 'update_branch', domain: 'branch', sensitive: false, proposalId: 'pf1', branchId: 'b1', currentName: 'סניף 1', before: { address: '' }, needsChoice: false, candidates: [], fields: { address: '<img src=x onerror=alert(1)>' }, warning: '' }], rejected: [], source: 'model', branches: [] });
    const pick = () => { const fin = document.getElementById('aiBranchFile'); Object.defineProperty(fin, 'files', { value: [new File(['%PDF-1.4 x'], 'טבלה.pdf', { type: 'application/pdf' })], configurable: true }); fin.dispatchEvent(new Event('change')); return flush(); };
    await pick();
    expect(calls).toEqual([]); expect(document.getElementById('aiBranchConsent').textContent).toContain('יישלח ל-Claude');
    document.getElementById('aiBranchConsentNo').click(); await flush();
    expect(calls).toEqual([]); expect(document.getElementById('aiBranchConsent')).toBeNull();
    await pick(); document.getElementById('aiBranchConsentYes').click(); await flush();
    expect(calls).toEqual([['FILE', 'טבלה.pdf', 'true']]);
    expect(document.getElementById('aiLog').querySelector('img')).toBeNull(); expect(document.getElementById('aiLog').textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
