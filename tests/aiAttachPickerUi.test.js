// @vitest-environment jsdom
// Attachment picker outside the branches/agreements tabs: routing only, no upload and no model call.
import { describe, it, expect, vi } from 'vitest';

let reportReply; let me; let askImpl; let saved = []; let calls = []; let tasks = []; let failNext = false; let nextError = '';
const stub = (url, options) => {
  const p = String(url).split('?')[0];
  if (p === '/api/auth/refresh') return { token: `h.${btoa(JSON.stringify({ id: me?._id })).replace(/=+$/, '')}.s` };
  if (p === '/api/users/me') return me;
  if (p === '/api/licenses' && options?.method === 'POST') { saved.push(options); return {}; }
  if (p === '/api/branches') return [{ _id: 'b1', name: 'גן א', address: '' }];
  if (p === '/api/license-types') return [{ _id: 't1', name: 'אישור בטיחות', branchId: null, active: true }, { _id: 't2', name: 'כיבוי אש שנתי', branchId: null, active: true }];
  if (['/api/licenses', '/api/notifications', '/api/users'].includes(p)) return [];
  if (p === '/api/auth/step-up') { calls.push(['STEPUP', p, options.body]); return { stepUpToken: 'tok1', expiresIn: 300 }; }
  if (p.startsWith('/api/ai/proposals/')) { calls.push(['CONFIRM', p, options.body, options.headers]); return { status: 'done' }; }
  if (p === '/api/ai/licenses/file-propose') return { summary: 'נמצא 1', actions: [{ type: 'create_license', domain: 'license', sensitive: true, proposalId: 'pl1', branchName: 'גן שקד', typeName: 'אישור בטיחות', issueDate: '2026-01-01', expiryDate: '2027-01-01' }], rejected: ['שורה 3: x'] };
  if (p === '/api/ai/files/preflight') { calls.push(['PREFLIGHT', p, options.body.get('consentExternal'), options.body.get('mode')]); return { advisory: true, summary: 'שלוש שורות', flags: [{ row: 3, issue: 'טלפון חשוד' }], questions: [{ rows: [2, 4], question: 'האם גן ורד בשורות 2 ו-4 הוא אותו מעון?', compare: { rows: [2, 4], cols: [{ col: 0, header: 'שם', a: 'גן ורד', b: 'גן ורד', conflict: false }, { col: 1, header: 'טלפון', a: '03-1', b: '03-2', conflict: true }, { col: 2, header: 'כתובת', a: '', b: 'הרצל 1', conflict: false }] } }], fileSha256: 'abc', rowsSent: 4, totalRows: 4, minimisation: ['עמודות רגישות (סיסמה) לא נשלחו'], note: 'המלצה בלבד.' }; }
  if (p === '/api/ai/team/file-propose') { calls.push(['TEAMFILE', p, options.body.get('skipRows'), options.body.get('rowMerges'), options.body.get('preflightSha'), options.body.get('rowLinks')]); return { summary: 'נמצאו 0 משתמשים', actions: [], rejected: [], fileReview: options.body.get('rowMerges') ? { merged: [{ keep: 2, drop: 4, cols: [{ header: 'טלפון', value: '03-2', source: 'chosen', row: 4 }] }], omitted: [3], links: [] } : null }; }
  if (p === '/api/ai/tasks/file-propose') return { summary: 'נמצאו 0 משימות', actions: [], rejected: [] };
  if (p === '/api/ai/tasks/propose') return askImpl(options);
  if (p === '/api/ai/agreements/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/ai/team/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/ai/branches/propose') { calls.push(['PROPOSE', p]); return askImpl(options); }
  if (p === '/api/auth/step-up') { calls.push(['STEPUP', p, options.body]); return { stepUpToken: 'tok1', expiresIn: 300 }; }
  if (p === '/api/ai/reports/ask') { calls.push(['REPORT', p]); return reportReply; }
  if (p.startsWith('/api/ai/proposals/')) { calls.push(['CONFIRM', p, options.body, options.headers]); if (failNext) { failNext = false; const e = new Error('שמירה נכשלה'); e.status = 500; throw e; } if (nextError) { const e = new Error(nextError); e.status = 409; nextError = ''; throw e; } return { status: 'done' }; }
  if (p === '/api/ai/agreements/document/propose') { calls.push(['DOCPROPOSE', p]); return { proposalId: 'pd1', fileName: 'חוזה גן הדוגמה.pdf', size: 20480, candidates: [{ id: 'a1', branchName: 'גן הדוגמה', authorityName: 'עירייה', suggested: true, sameName: true }, { id: 'a2', branchName: 'גן אחר', authorityName: 'מועצה', suggested: false, sameName: false }] }; }
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




const go = async (mode, prompt) => {
  calls = []; failNext = false; nextError = '';
  await boot({ _id: 'u1', name: 'א', role: 'Admin', aiEnabled: true });
  document.querySelector('[data-page="ai"]').click(); await flush();
  document.querySelector(`[data-aimode="${mode}"]`).click(); await flush();
  const f = document.getElementById('aiForm'); f.elements.prompt.value = prompt; f.dispatchEvent(new Event('submit', { cancelable: true })); await flush();
};
const pick = async (name) => { const i = document.getElementById('aiAttachFile'); Object.defineProperty(i, 'files', { value: [new File(['x'], name)], configurable: true }); i.dispatchEvent(new Event('change')); await flush(); };
describe('AI attachment picker outside the file tabs', () => {
  it('team tab (Admin): xlsx/docx/csv go to the local team-file endpoint only', async () => {
    await go('team', ''); const urls = () => global.fetch.mock.calls.map((c) => String(c[0])); const before = urls().length;
    await pick('t.pdf'); expect(urls().length).toBe(before); await pick('t.xlsx'); expect(urls().slice(before)).toEqual([]); expect(document.getElementById('aiPreCard')).not.toBeNull();
    document.getElementById('aiPreLocal').click(); await new Promise((r) => setTimeout(r, 50)); expect(urls().slice(before)).toEqual(['/api/ai/team/file-propose']); expect(calls.filter((c) => c[0] === 'PREFLIGHT')).toHaveLength(0); expect(calls.find((c) => c[0] === 'TEAMFILE')[2]).toBeNull();
  });
  it('team tab: Claude pre-check needs the ticked consent, shows summary/flags/questions as advisory, requires every question answered, and sends only skipRows afterwards', async () => {
    await go('team', ''); await pick('t.xlsx'); const btn = document.getElementById('aiPreClaude'); expect(btn.disabled).toBe(true); btn.click(); await flush(); expect(calls.filter((c) => c[0] === 'PREFLIGHT')).toHaveLength(0);
    const cb = document.getElementById('aiPreConsent'); cb.checked = true; cb.dispatchEvent(new Event('change')); expect(btn.disabled).toBe(false); expect(document.getElementById('aiPreCard').textContent).toContain('עד 200 שורות');
    btn.click(); await flush(); expect(calls.find((c) => c[0] === 'PREFLIGHT')[2]).toBe('true'); expect(calls.find((c) => c[0] === 'PREFLIGHT')[3]).toBe('team');
    const t = document.getElementById('aiPreCard').textContent; expect(t).toContain('שלוש שורות'); expect(t).toContain('שורה 3: טלפון חשוד'); expect(t).toContain('האם גן ורד'); expect(t).toContain('המלצה בלבד'); expect(calls.filter((c) => c[0] === 'TEAMFILE')).toHaveLength(0);
    document.getElementById('aiPreContinue').click(); await flush(); expect(calls.filter((c) => c[0] === 'TEAMFILE')).toHaveLength(0); expect(document.getElementById('aiPreCard').textContent).toContain('ענו על כל השאלות');
    const card = document.getElementById('aiPreCard'); expect(card.textContent).toContain('03-1'); expect(card.textContent).toContain('03-2'); expect(card.textContent).toContain('הרצל 1'); expect(card.textContent).toContain('לא בטוח'); expect(card.textContent).toContain('אותו סניף, משתמשים שונים'); expect(card.textContent).toContain('אותו משתמש בדיוק נכתב פעמיים'); expect(card.textContent).toContain('לרוב רשומות נפרדות'); expect(card.textContent).toContain('כפילות'); expect(card.querySelector('tr.ai-cmp-diff')).not.toBeNull();
    const same = document.querySelector('input[name="preq0"][value="dup"]'); same.checked = true; same.dispatchEvent(new Event('change')); expect(document.querySelector('[data-prepicks="0"]').hidden).toBe(false);
    document.getElementById('aiPreContinue').click(); await flush(); expect(calls.filter((c) => c[0] === 'TEAMFILE')).toHaveLength(0); expect(document.getElementById('aiPreCard').textContent).toContain('בחרו ערך אחד בעמודה "טלפון"');
    document.querySelector('input[name="prepick0_1"][value="drop"]').checked = true; document.querySelector('[data-preskip="3"]').checked = true; document.getElementById('aiPreContinue').click(); await flush();
    const tf = calls.find((c) => c[0] === 'TEAMFILE'); expect(JSON.parse(tf[2])).toEqual([3]); expect(JSON.parse(tf[3])).toEqual([{ keep: 2, drop: 4, pick: { 1: 'drop' } }]); expect(tf[4]).toBe('abc'); expect(tf[5]).toBeNull(); expect(document.getElementById('aiPreCard')).toBeNull(); const rv = document.getElementById('aiFileReview'); expect(rv.textContent).toContain('שורות 2 ו-4 אוחדו'); expect(rv.textContent).toContain('טלפון: 03-2 (נבחר על ידכם משורה 4)'); expect(rv.textContent).toContain('שורות שהושמטו: 3'); expect(document.getElementById('aiLog').textContent).not.toContain('לא נכלל');
  });
  it('same-place answer keeps both rows and is only recorded as a link; the review section is its own block, not the rejected list', async () => {
    await go('team', ''); await pick('t.xlsx'); const cb = document.getElementById('aiPreConsent'); cb.checked = true; cb.dispatchEvent(new Event('change')); document.getElementById('aiPreClaude').click(); await flush();
    document.querySelector('input[name="preq0"][value="sameplace"]').checked = true; document.getElementById('aiPreContinue').click(); await flush();
    const tf = calls.find((c) => c[0] === 'TEAMFILE'); expect(tf[2]).toBeNull(); expect(tf[3]).toBeNull(); expect(JSON.parse(tf[5])).toEqual([{ rows: [2, 4], relation: 'same_place' }]);
  });
  it('pre-check card is bound to the tab and the account: switching tab or user drops it, and csv/tasks/licenses get the same card', async () => {
    await go('team', ''); await pick('t.csv'); expect(document.getElementById('aiPreCard')).not.toBeNull(); document.querySelector('[data-aimode="tasks"]').click(); await flush(); expect(document.getElementById('aiPreCard')).toBeNull(); document.querySelector('[data-aimode="team"]').click(); await flush(); expect(document.getElementById('aiPreCard')).toBeNull();
    await go('tasks', ''); await pick('t.xlsx'); expect(document.getElementById('aiPreCard')).not.toBeNull(); await go('licenses', ''); await pick('l.csv'); expect(document.getElementById('aiPreCard')).not.toBeNull(); expect(calls.filter((c) => c[0] === 'PREFLIGHT')).toHaveLength(0);
  });
  it('licenses tab: a csv goes to the local license endpoint; the create_license card shows its fields, needs the password, and confirm sends only the id with the step-up header', async () => {
    await go('licenses', ''); const before = global.fetch.mock.calls.length; await pick('t.pdf'); expect(global.fetch.mock.calls.length).toBe(before);
    await pick('l.csv'); document.getElementById('aiPreLocal').click(); await new Promise((r) => setTimeout(r, 80));
    const t = document.getElementById('aiLog').textContent; expect(t).toContain('יצירת אישור חדש (בלי קובץ מצורף)'); expect(t).toContain('סניף: גן שקד'); expect(t).toContain('תפוגה: 2027-01-01'); expect(t).toContain('לא מחליף ולא מחדש');
    expect(document.querySelector('input[data-pass]')?.type).toBe('password');
    document.querySelector('[data-confirm]').click(); await flush(); expect(calls.filter((c) => c[0] === 'STEPUP' || c[0] === 'CONFIRM')).toHaveLength(0);
    document.querySelector('input[data-pass]').value = 'Password123'; document.querySelector('[data-confirm]').click(); await flush();
    expect(JSON.parse(calls.find((c) => c[0] === 'STEPUP')[2])).toMatchObject({ password: 'Password123', action: 'ai:create_license', scope: 'pl1' }); const cf = calls.find((c) => c[0] === 'CONFIRM'); expect(cf[3]['X-Step-Up']).toBe('tok1'); expect(cf[2]).toBe('{}');
  });
  it('tasks tab: xlsx/docx/csv go to the local task-file endpoint only; pdf/image/old formats never leave the page', async () => {
    await go('tasks', ''); const urls = () => global.fetch.mock.calls.map((c) => String(c[0]));
    const before = urls().length; await pick('t.pdf'); await pick('t.png'); await pick('t.xls'); expect(urls().length).toBe(before);
    expect(document.getElementById('aiLog').textContent).toContain('בלשונית הזו אין קריאת קבצים'); expect(document.getElementById('aiLog').textContent).toContain('לא נתמך');
    await pick('t.csv'); expect(urls().slice(before)).toEqual([]); document.getElementById('aiPreLocal').click(); await new Promise((r) => setTimeout(r, 50)); expect(urls().slice(before)).toEqual(['/api/ai/tasks/file-propose']); expect(calls).toEqual([]);
  });
  it.each(['reports', 'chat', 'rent'])('tab %s: a supported file is redirected, nothing is uploaded or sent', async (mode) => {
    await go(mode, '');
    expect(document.getElementById('aiAttachFile')).not.toBeNull();
    const before = global.fetch.mock.calls.length;
    for (const n of ['a.xlsx', 'a.docx', 'a.csv', 'a.pdf', 'a.PNG']) await pick(n);
    const t = document.getElementById('aiLog').textContent;
    expect(t).toContain('בלשונית הזו אין קריאת קבצים'); expect(t).not.toContain('לא נתמך');
    expect(global.fetch.mock.calls.length).toBe(before); expect(calls).toEqual([]);
  });
  it('unsupported types get the unsupported-format message and nothing is sent', async () => {
    await go('reports', ''); const before = global.fetch.mock.calls.length;
    await pick('old.xls'); await pick('old.doc'); await pick('movie.mp4');
    const t = document.getElementById('aiLog').textContent; expect((t.match(/סוג הקובץ הזה לא נתמך/g) || []).length).toBe(3); expect(t).not.toContain('בלשונית הזו אין קריאת קבצים');
    expect(global.fetch.mock.calls.length).toBe(before);
  });
  it('a picked PDF is bound to its tab and account: switching tab clears it, the gate uses the ORIGINAL endpoint, and an old file never uploads to another kind', async () => {
    await go('tasks', ''); const urls = () => global.fetch.mock.calls.map((c) => String(c[0]));
    const pickPdf = async (name) => { const i = document.getElementById('aiAttachFile'); Object.defineProperty(i, 'files', { value: [new File(['%PDF'], name, { type: 'application/pdf' })], configurable: true }); i.dispatchEvent(new Event('change')); await flush(); };
    await pickPdf('t.pdf'); expect(document.getElementById('aiModelConsent')).not.toBeNull(); const before = urls().length;
    document.querySelector('[data-aimode="team"]').click(); await flush(); expect(document.getElementById('aiModelConsent')).toBeNull();
    document.querySelector('[data-aimode="licenses"]').click(); await flush(); expect(document.getElementById('aiModelConsent')).toBeNull();
    document.querySelector('[data-aimode="tasks"]').click(); await flush(); expect(document.getElementById('aiModelConsent')).toBeNull(); // cleared, not restored
    expect(urls().slice(before).filter((u) => u.includes('file-propose'))).toEqual([]);
    await pickPdf('l.pdf'); const chk = document.getElementById('aiModelConsentChk'); expect(document.getElementById('aiModelConsentYes').disabled).toBe(true); chk.checked = true; chk.dispatchEvent(new Event('change'));
    const b2 = urls().length; document.getElementById('aiModelConsentYes').click(); await flush(); expect(urls().slice(b2)).toEqual(['/api/ai/tasks/file-propose']);
    await go('licenses', ''); await pickPdf('x.pdf'); document.querySelector('[data-aimode="team"]').click(); await flush(); await pickPdf('y.pdf'); const c2 = document.getElementById('aiModelConsentChk'); c2.checked = true; c2.dispatchEvent(new Event('change'));
    const b3 = urls().length; document.getElementById('aiModelConsentYes').click(); await flush(); expect(urls().slice(b3)).toEqual(['/api/ai/team/file-propose']);
  });
  it('the branches and agreements tabs keep their own file flows (no redirect button there)', async () => {
    await go('branches', ''); expect(document.getElementById('aiAttachFile')).toBeNull(); expect(document.getElementById('aiBranchFile')).not.toBeNull();
    document.querySelector('[data-aimode="agreements"]').click(); await flush(); expect(document.getElementById('aiAttachFile')).toBeNull();
  });
});
