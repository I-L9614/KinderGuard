// @vitest-environment jsdom
// Branches and reports tabs: interaction tests.
import { describe, it, expect, vi } from 'vitest';

let reportReply; let me; let askImpl; let saved = []; let calls = []; let tasks = []; let failNext = false; let nextError = '';
let confirmResult = null;
const stub = (url, options) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: me?._id })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return me;
  if (p === '/api/licenses' && options?.method === 'POST') { saved.push(options); return {}; }
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן א', address: '' }];
  if (p === '/api/license-types') return [{ _id: 't1', name: 'אישור בטיחות', branchId: null, active: true }, { _id: 't2', name: 'כיבוי אש שנתי', branchId: null, active: true }];
  if (['/api/licenses', '/api/notifications', '/api/users'].includes(p)) return [];
  if (p === '/api/ai/tasks/propose') return askImpl(options);
  if (p.startsWith('/api/ai/agreements/step/')) { calls.push(['STEP', p, options.body]); return { summary: '', actions: [{ type: 'create_agreement', domain: 'agreement', proposalId: 'pa2', sensitive: true, branchId: 'b2', currentName: 'גן בורר צפון', branchName: 'גן בורר צפון', authorityId: null, authorityName: null, needsChoice: true, choiceField: 'agreementPayer', candidates: [{ id: 'p1', name: 'עיריית נחל' }, { id: 'p2', name: 'עיריית נחל מזרח' }], changes: { monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' }, warning: 'שלב 2 מתוך 2' }], rejected: [], branches: [] }; }
  if (p === '/api/ai/agreements/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/ai/team/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/ai/branches/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/auth/step-up') { calls.push(['STEPUP', p, options.body]); return { stepUpToken: 'tok1', expiresIn: 300 }; }
  if (p === '/api/ai/reports/export-team' || p === '/api/ai/reports/export-licenses') { calls.push(['EXPORT', p, options.body]); return { rows: [{ name: 'א', role: 'מנהל סניף' }, { name: 'ב', role: 'מנהל סניף' }], count: 2, total: 2, capped: false, cap: 500 }; }
  if (p === '/api/ai/reports/ask') { calls.push(['REPORT', p]); return reportReply; }
  if (p.startsWith('/api/ai/proposals/')) { calls.push(['CONFIRM', p, options.body, options.headers]); if (failNext) { failNext = false; const e = new Error('שמירה נכשלה'); e.status = 500; throw e; } if (nextError) { const e = new Error(nextError); e.status = 409; nextError = ''; throw e; } return confirmResult || { status: 'done' }; }
  if (p === '/api/ai/agreements/document/propose') { const pf = options.body.get('prefer') || ''; calls.push(['DOCPROPOSE', p, pf]); const out = { proposalId: 'pd1', fileName: 'חוזה גן הדוגמה.pdf', size: 20480, candidates: [{ id: 'a1', branchName: 'גן הדוגמה', authorityName: 'עירייה', suggested: true, sameName: true }, { id: 'a2', branchName: 'גן אחר', authorityName: 'מועצה', suggested: false, sameName: false, identicalUnchecked: true }] }; return { ...out, candidates: out.candidates.map((c) => ({ ...c, ...(pf && c.id === pf ? { preferred: true } : {}) })) }; }
  if (p.startsWith('/api/ai/agreements/document/')) { calls.push(['DOCCONFIRM', p, options.body.get('agreementId')]); return { status: 'done' }; }
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




const go = async (mode, prompt, role = 'Admin') => {
  calls = []; failNext = false; nextError = '';
  await boot({ _id: 'u1', name: 'א', role, aiEnabled: true });
  document.querySelector('[data-page="ai"]').click(); await flush();
  document.querySelector(`[data-aimode="${mode}"]`).click(); await flush();
  const f = document.getElementById('aiForm'); f.elements.prompt.value = prompt; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
};
const upd = { summary: 'עדכון', actions: [{ type: 'update_branch', domain: 'branch', proposalId: 'pb1', sensitive: false, branchId: null, currentName: null, needsChoice: true, candidates: [{ id: 'b1', name: 'גן שקד' }, { id: 'b2', name: 'גן שקד צפון' }], fields: { phone: '03-1' }, warning: 'יש סניפים עם שמות דומים. בחרו את הסניף המדויק לפני האישור.' }], branches: [] };
describe('AI branches and reports UI', () => {
  it('reports tab shows the server rows and never offers a confirm', async () => {
    reportReply = { report: 'licenses_expiring', title: 'אישורים שתוקפם עומד לפוג', days: 60, count: 1, rows: [{ branch: 'גן א', type: 'כיבוי אש', expiryDate: '2026-12-20' }] };
    await go('reports', 'מה עומד לפוג');
    expect(calls).toEqual([['REPORT', '/api/ai/reports/ask']]);
    const t = document.getElementById('aiLog').textContent; expect(t).toContain('גן א · כיבוי אש · 2026-12-20'); expect(document.querySelector('[data-confirm]')).toBeNull();
  });
  it('team report beyond the row cap offers the server export with its filters; clicking posts only those filters and reports the outcome', async () => {
    reportReply = { report: 'team_overview', title: 'צוות', count: 1, total: 2, rows: [{ name: 'א', role: 'מנהל סניף' }], exportParams: { role: 'Manager' } };
    await go('reports', 'צוות'); const b = document.querySelector('[data-aiexportall]'); expect(b).toBeTruthy(); expect(b.textContent).toContain('ייצוא כל 2 המשתמשים'); expect(b.textContent).toContain('בלי אימיילים');
    global.URL.createObjectURL = vi.fn(() => 'blob:x'); global.URL.revokeObjectURL = vi.fn(); HTMLAnchorElement.prototype.click = vi.fn();
    b.click(); await flush(); expect(calls.filter((c) => c[0] === 'EXPORT').map((c) => JSON.parse(c[2]))).toEqual([{ role: 'Manager' }]); expect(document.getElementById('aiLog').textContent).toContain('יוצאו כל 2 המשתמשים בסינון');
  });
  it('a Manager never sees the Admin-only export button', async () => {
        reportReply = { report: 'team_overview', title: 'צוות', count: 1, total: 2, rows: [{ name: 'א', role: 'מנהל סניף' }], exportParams: {} };
    await go('reports', 'צוות', 'Manager'); expect(document.querySelector('[data-aiexportall]')).toBeNull();
  });
  it('over the cap the export button says it is truncated to the first 500 of N', async () => {
    reportReply = { report: 'team_overview', title: 'צוות', count: 50, total: 612, rows: [{ name: 'א', role: 'מנהל סניף' }], exportParams: {} };
    await go('reports', 'צוות'); const b = document.querySelector('[data-aiexportall]'); expect(b.textContent).toContain('500 הראשונים מתוך 612'); expect(b.textContent).toContain('קטוע'); expect(b.textContent).not.toContain('ייצוא כל');
  });
  it('reports tab shows the no-report message', async () => {
    reportReply = { report: null, rows: [], message: 'לא מצאתי דוח מתאים לבקשה.' };
    await go('reports', 'שיר'); expect(document.getElementById('aiLog').textContent).toContain('לא מצאתי דוח מתאים');
  });
  it('a similar-named update target needs an explicit choice and sends it', async () => {
    askImpl = () => upd;
    await go('branches', 'עדכן טלפון של גן שקד');
    expect(document.getElementById('aiLog').textContent).toContain('בחרו את הסניף המדויק'); expect(document.getElementById('aiLog').textContent).not.toContain('null');
    document.querySelector('[data-confirm]').click(); await flush();
    expect(calls.filter((c) => c[0] === 'CONFIRM')).toHaveLength(0);
    expect(document.getElementById('aiLog').textContent).toContain('בחרו את הסניף המדויק');
    document.querySelector('input[type=radio][value="b2"]').checked = true;
    document.querySelector('[data-confirm]').click(); await flush();
    const c = calls.find((x) => x[0] === 'CONFIRM'); expect(c[1]).toBe('/api/ai/proposals/pb1/confirm'); expect(JSON.parse(c[2])).toEqual({ branchId: 'b2' });
  });
  it('a create proposal saves nothing until confirmed and shows its warning', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_branch', domain: 'branch', proposalId: 'pb2', sensitive: false, branchId: null, currentName: null, needsChoice: false, candidates: [], fields: { name: 'גן חדש' }, warning: 'שם דומה לסניף קיים: "גן א". ודאו שזה לא אותו סניף.' }], branches: [] });
    await go('branches', 'פתח גן חדש');
    expect(document.getElementById('aiLog').textContent).toContain('שם דומה'); expect(calls.filter((c) => c[0] === 'CONFIRM')).toHaveLength(0);
    document.querySelector('[data-confirm]').click(); await flush();
    expect(JSON.parse(calls.find((x) => x[0] === 'CONFIRM')[2])).toEqual({});
  });
  it('a sensitive action shows a password field, refuses an empty password, then step-up grant goes in the X-Step-Up header', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'delete_task', proposalId: 'ps1', sensitive: true, taskId: 't1', currentTitle: 'למחיקה', currentStatus: 'To_Do' }], branches: [] });
    await go('branches', 'מחק');
    const pw = document.querySelector('input[data-pass]'); expect(pw).toBeTruthy(); expect(pw.type).toBe('password');
    document.querySelector('[data-confirm]').click(); await flush();
    expect(calls.filter((c) => c[0] === 'STEPUP' || c[0] === 'CONFIRM')).toHaveLength(0);
    document.querySelector('input[data-pass]').value = 'Password123';
    document.querySelector('[data-confirm]').click(); await flush();
    const su = calls.find((c) => c[0] === 'STEPUP'); expect(JSON.parse(su[2])).toMatchObject({ password: 'Password123', action: 'ai:delete_task', scope: 'ps1' });
    const cf = calls.find((c) => c[0] === 'CONFIRM'); expect(cf[3]['X-Step-Up']).toBe('tok1'); expect(cf[2]).toBe('{}');
  });
  it('team card: role, AI checkbox (default off) and initial password are typed on the card; password required; sent only in the confirm body', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_user', domain: 'team', proposalId: 'pt1', sensitive: true, needsNewUser: true, name: 'דנה כהן', email: 'dana@example.com', suggestedRole: 'Manager', branchIds: ['b1'], branchNames: ['גן א'] }], branches: [] });
    await go('team', 'הוסף את דנה');
    const log = () => document.getElementById('aiLog').textContent; expect(log()).toContain('הוספת משתמש: דנה כהן'); expect(log()).toContain('dana@example.com');
    expect(document.querySelector('[data-nuai]').checked).toBe(false); expect(document.querySelector('[data-nupass]').type).toBe('password');
    document.querySelector('[data-pass]').value = 'Password123';
    document.querySelector('[data-confirm]').click(); await flush();
    expect(log()).toContain('הקלידו סיסמה ראשונית'); expect(calls.filter((c) => c[0] === 'CONFIRM')).toHaveLength(0);
    document.querySelector('[data-nupass]').value = 'Str0ng-pass-99'; document.querySelector('[data-nuai]').checked = true; document.querySelector('[data-nurole]').value = 'Admin';
    document.querySelector('[data-pass]').value = 'Password123';
    document.querySelector('[data-confirm]').click(); await flush();
    const cf = calls.find((c) => c[0] === 'CONFIRM'); expect(JSON.parse(cf[2])).toEqual({ newUserPassword: 'Str0ng-pass-99', newUserRole: 'Admin', newUserAiEnabled: true });
    expect(JSON.stringify(calls.filter((c) => c[0] === 'STEPUP'))).not.toContain('Str0ng-pass-99');
  });
  it('agreement card shows old to new values, needs the password, then step-up with its own action and scope', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'update_agreement', domain: 'agreement', proposalId: 'pa1', sensitive: true, agreementId: 'a1', branchName: 'גן א', authorityName: 'עירייה', version: 'v', effect: { beforeFrequency: 'monthly', afterFrequency: 'quarterly', before: 1000, after: 4500 }, current: { monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: '2026-01-01' }, changes: { monthlyAmount: 1500, frequency: 'quarterly' } }], branches: [] });
    await go('agreements', 'עדכן הסכם');
    const log = () => document.getElementById('aiLog').textContent;
    expect(log()).toContain('עדכון הסכם שכירות: גן א · עירייה'); expect(log()).toContain('סכום חודשי (גם בתדירות רבעונית או שנתית) נוכחי: \u20681000\u2069'); expect(log()).toContain('סכום חודשי (גם בתדירות רבעונית או שנתית) מוצע: \u20681500\u2069'); expect(log()).toContain('תדירות נוכחי: \u2068חודשי\u2069'); expect(log()).toContain('תדירות מוצע: \u2068רבעוני\u2069'); expect(log()).toContain('סכום כל תשלום מתוזמן לפני (חודשי): 1000'); expect(log()).toContain('סכום כל תשלום מתוזמן אחרי (רבעוני): 4500'); expect(log()).not.toContain('null');
    document.querySelector('[data-confirm]').click(); await flush();
    expect(calls.filter((c) => c[0] === 'STEPUP' || c[0] === 'CONFIRM')).toHaveLength(0);
    document.querySelector('[data-pass]').value = 'Password123'; document.querySelector('[data-confirm]').click(); await flush();
    expect(JSON.parse(calls.find((c) => c[0] === 'STEPUP')[2])).toMatchObject({ action: 'ai:update_agreement', scope: 'pa1' });
    expect(calls.find((c) => c[0] === 'CONFIRM')[3]['X-Step-Up']).toBe('tok1');
  });
  it('cheque series card: whole-series replacement warning, cleared start date and count change are shown, never silent', async () => {
    const base = { type: 'update_agreement', domain: 'agreement', proposalId: 'pc1', sensitive: true, agreementId: 'a1', branchName: 'גן א', authorityName: 'עירייה', version: 'v', current: { monthlyAmount: 1000, frequency: 'monthly', paymentMethod: 'cheque', firstDueDate: '2026-01-01', chequeSeries: { depositedCount: 2, seriesStartDate: '2026-01-01', seriesEndDate: '2026-06-30' } } };
    askImpl = () => ({ summary: '', actions: [{ ...base, changes: { chequeSeries: { depositedCount: 5, seriesStartDate: null, seriesEndDate: '2027-06-30' } } }], branches: [] });
    await go('agreements', 'עדכן הסכם');
    const log = () => document.getElementById('aiLog').textContent;
    expect(log()).toContain('מחליף את כל סדרת הצ׳קים השמורה'); expect(log()).toContain('תאריך ההתחלה הקודם (2026-01-01) יימחק'); expect(log()).toContain('ישתנה מ-2 ל-5'); expect(log()).toContain('הופקדו 2 צ׳קים'); expect(log()).toContain('הופקדו 5 צ׳קים'); expect(log()).not.toContain('[object');
  });
  it('create card lists custom due dates, quarterly figure and cheque series', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_agreement', domain: 'agreement', proposalId: 'pn1', sensitive: true, branchId: 'b1', branchName: 'גן א', authorityName: 'עירייה', needsChoice: false, candidates: [], changes: { monthlyAmount: 2000, frequency: 'custom', paymentMethod: 'cheque', firstDueDate: '2031-02-01', direction: 'incoming', customDueDates: ['2031-02-01', '2031-08-01'], quarterlyAmount: 6100, chequeSeries: { depositedCount: 2, seriesStartDate: null, seriesEndDate: '2031-12-31' } } }], branches: [] });
    await go('agreements', 'צור הסכם');
    const log = document.getElementById('aiLog').textContent;
    expect(log).toContain('מועדי פרעון מותאמים (2): 2031-02-01 · 2031-08-01'); expect(log).toContain('סכום תשלום רבעוני:'); expect(log).toContain('הופקדו 2 צ׳קים'); expect(log).not.toContain('[object');
  });
  it('report card: filter and cap are stated, CSV export contains exactly the shown rows and neutralizes formulas', async () => {
    reportReply = { report: 'licenses_history', title: 'היסטוריית אישורים שהוחלפו', rows: [{ branch: 'גן שקד', type: 'כבאות', issued: 'הונפק 2025‑01‑01', expiryDate: 'עד 2025‑06‑01' }, { branch: '=HYPERLINK("x")', type: 'כבאות "ב"', issued: '', expiryDate: 'עד 2024‑06‑01' }], count: 2, total: 75, branchFilter: 'גן שקד', typeFilter: 'כבאות' };
    await go('reports', 'היסטוריית כבאות בגן שקד');
    const log = document.getElementById('aiLog').textContent;
    expect(log).toContain('סינון לפי סניף: גן שקד'); expect(log).toContain('סינון לפי סוג אישור: כבאות'); expect(log).toContain('מוצגות 2 מתוך 75');
    let blobText = ''; const NativeBlob = globalThis.Blob; globalThis.Blob = class extends NativeBlob { constructor(parts, o) { super(parts, o); blobText = parts.join(''); } };
    URL.createObjectURL = () => 'blob:x'; URL.revokeObjectURL = () => {}; HTMLAnchorElement.prototype.click = () => {};
    document.querySelector('[data-aicsv]').click(); globalThis.Blob = NativeBlob;
    const lines = blobText.replace('\ufeff', '').split('\r\n'); expect(lines).toHaveLength(3); expect(lines[0]).toBe('"סניף","סוג אישור","הנפקה","תוקף"'); expect(lines[2]).toContain('"\'=HYPERLINK(""x"")"'); expect(lines[2]).toContain('"כבאות ""ב"""');
  });
  it('after an agreement is created in this chat, the document picker preselects that agreement (the user still confirms the destination)', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_agreement', domain: 'agreement', proposalId: 'pa9', sensitive: true, branchId: 'b2', currentName: 'גן אחר', authorityName: 'עירייה', changes: {}, needsChoice: false, candidates: [] }], rejected: [], branches: [] });
    await go('agreements', 'צור הסכם'); confirmResult = { status: 'done', result: { agreementId: 'a2', created: true } };
    document.querySelector('input[data-pass]').value = 'Password123'; document.querySelector('[data-confirm]').click(); await flush();
    const input = document.getElementById('aiDocFile'); Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.4'], 'x.pdf', { type: 'application/pdf' })] });
    input.dispatchEvent(new Event('change')); await flush(); confirmResult = null;
    expect(calls.find((c) => c[0] === 'DOCPROPOSE')[2]).toBe('a2');
    expect(document.querySelector('input[name="docdest"]:checked').value).toBe('a2'); expect(document.getElementById('aiDocPanel').textContent).toContain('ההסכם שנוצר עכשיו בשיחה');
    expect(calls.filter((c) => c[0] === 'DOCCONFIRM')).toHaveLength(0);
    document.getElementById('aiDocConfirm').click(); await flush(); expect(calls.filter((c) => c[0] === 'DOCCONFIRM')).toHaveLength(1);
    expect(document.getElementById('aiDocPanel').textContent).toContain('המסמך נשמר'); document.getElementById('aiDocNext').click(); await flush();
    const input2 = document.getElementById('aiDocFile'); Object.defineProperty(input2, 'files', { value: [new File(['%PDF-1.4'], 'y.pdf', { type: 'application/pdf' })] });
    input2.dispatchEvent(new Event('change')); await flush(); const props = calls.filter((c) => c[0] === 'DOCPROPOSE'); expect(props).toHaveLength(2); expect(props[1][2]).toBe(''); expect(document.querySelector('input[name="docdest"]:checked')).toBeNull();
  });
  it('sequential choice: the step card has no confirm and no password, needs a branch, then shows the payer card; nothing is confirmed in between', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_agreement_step', domain: 'agreement', proposalId: 'ps1', sensitive: false, needsChoice: true, choiceField: 'step', branchId: null, branchName: null, authorityId: null, candidates: [{ id: 'b1', name: 'גן בורר' }, { id: 'b2', name: 'גן בורר צפון' }], payerCandidates: [], changes: { monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' }, warning: 'שלב 1 מתוך 2: בחרו את הסניף המדויק.' }], rejected: [], branches: [] });
    await go('agreements', 'צור הסכם');
    const t0 = document.getElementById('aiLog').textContent; expect(t0).toContain('שלב 1 מתוך 2'); expect(document.querySelector('[data-confirm]')).toBeNull(); expect(document.querySelector('input[data-pass]')).toBeNull();
    document.querySelector('[data-aistep]').click(); await flush(); expect(calls.filter((c) => c[0] === 'STEP')).toHaveLength(0); expect(document.getElementById('aiLog').textContent).toContain('בחרו את הסניף המדויק');
    document.querySelector('input[type=radio][value="b2"]').checked = true; document.querySelector('[data-aistep]').click(); await flush();
    expect(JSON.parse(calls.find((c) => c[0] === 'STEP')[2])).toEqual({ branchId: 'b2' }); expect(calls.filter((c) => c[0] === 'CONFIRM' || c[0] === 'STEPUP')).toHaveLength(0);
    const t1 = document.getElementById('aiLog').textContent; expect(t1).toContain('שלב 2 מתוך 2'); expect(t1).toContain('עיריית נחל מזרח'); expect(document.querySelector('input[data-pass]')).not.toBeNull();
  });
  it('colliding candidate names: the detail line renders under each candidate (step card), and a raw id is never the label', async () => {
    askImpl = () => ({ summary: '', actions: [{ type: 'create_agreement_step', domain: 'agreement', proposalId: 'ps2', sensitive: false, needsChoice: true, choiceField: 'step', branchId: null, branchName: null, authorityId: null, candidates: [{ id: 'bb1', name: 'גן בורר', detail: 'הרצל 1 · סטטוס: פעיל' }, { id: 'bb2', name: 'גן בורר', detail: 'ביאליק 5 · מנהל/ת: דנה · סטטוס: פעיל' }], payerCandidates: [], changes: { monthlyAmount: 3000, frequency: 'monthly', paymentMethod: 'transfer', firstDueDate: '2031-02-01', direction: 'incoming' }, warning: 'שלב 1 מתוך 2' }], rejected: [], branches: [] });
    await go('agreements', 'צור הסכם');
    const cands = [...document.querySelectorAll('.ai-cand')]; expect(cands).toHaveLength(2);
    expect(cands[0].textContent).toContain('הרצל 1'); expect(cands[1].textContent).toContain('ביאליק 5'); expect(cands[1].textContent).toContain('מנהל/ת: דנה');
    expect(document.getElementById('aiLog').textContent).not.toMatch(/bb1|bb2/);
  });
  it('document intake: nothing preselected, destination required, saved only after confirm to the chosen agreement', async () => {
    await go('agreements', '');
    const input = document.getElementById('aiDocFile'); expect(input).not.toBeNull();
    Object.defineProperty(input, 'files', { value: [new File(['%PDF-1.4'], 'חוזה גן הדוגמה.pdf', { type: 'application/pdf' })] });
    input.dispatchEvent(new Event('change')); await flush();
    expect(calls.filter((c) => c[0] === 'DOCCONFIRM')).toHaveLength(0);
    const panel = document.getElementById('aiDocPanel').textContent;
    expect(panel).toContain('חוזה גן הדוגמה.pdf'); expect(panel).toContain('גן הדוגמה · עירייה'); expect(panel).toContain('כבר קיים מסמך בשם הזה'); expect(panel).toContain('ודאו בעצמכם');
    expect(document.getElementById('aiDocPanel').textContent).toContain('חלק מהקבצים הקיימים בהסכם לא נבדקו להשוואת תוכן, ייתכן שקובץ זהה כבר מצורף'); expect(document.getElementById('aiDocPanel').textContent.match(/לא נבדקו להשוואת תוכן/g)).toHaveLength(1);
    expect(document.querySelector('input[name="docdest"]:checked')).toBeNull();
    document.getElementById('aiDocConfirm').click(); await flush();
    expect(calls.filter((c) => c[0] === 'DOCCONFIRM')).toHaveLength(0); expect(document.getElementById('aiDocPanel').textContent).toContain('בחרו את ההסכם');
    document.querySelector('input[name="docdest"][value="a2"]').checked = true; document.getElementById('aiDocConfirm').click(); await flush();
    expect(calls.find((c) => c[0] === 'DOCCONFIRM')[2]).toBe('a2'); expect(document.getElementById('aiDocPanel').textContent).toContain('המסמך נשמר'); expect(document.getElementById('aiDocPanel').textContent).toContain('גן אחר · מועצה');
  });
});
