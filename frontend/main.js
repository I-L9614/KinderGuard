import { computeCompleteness, expiryAllClear } from './completeness.js';
import { collapseList, collapseLabel, resetCollapsed, LIST_LIMITS } from './collapsibleList.js';
import { renderLicenseCard, installApprovalMenus } from './licenseCards.js';
import { createUpdateGuard } from './updateGuard.js';
import { parseTypePeriod, addPeriod } from './expiryAutofill.js';
import { israelToday, israelParts, calendarDay } from './israelTime.js';
import { SEEN_KEY, SESSION_KEY, popupWindowOpen, planNativeToasts, dueTaskAlertItems, taskDeadlineArrived, resolveAlertTarget, alertToastPayload, summaryToastPayload, testToastPayloads } from './nativeNotify.js';

const app = document.getElementById('app');
installApprovalMenus();
// Show where this UI is actually served from (embedded loopback on the
// developer's PC, or the hosted server for the website/client mode).
{ const el = document.getElementById('server-origin'); if (el) el.textContent = 'שרת: ' + location.host; }

const headerActions = document.getElementById('header-actions');
// Tracks unsaved form input and in-flight uploads so the self-closing update
// install can demand an explicit save/discard decision first.
const updateGuard = createUpdateGuard();
window.__updateGuard = updateGuard;
const state = { user: null, branches: [], licenses: [], types: [], alerts: [], tasks: [], taskFilter: 'all', taskScope: 'mine', page: 'branches', branchId: null, token: null, cardFilter: null, rent: null, rentAuthorityFilter: null, rentShowAllOverdue: false, rentShowAllUpcoming: false, reportTab: 'branch', reportScope: 'all', reportSelection: '', reportGenerated: false };
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (value) => value ? new Date(value).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '—';
// Month arithmetic that clamps to the month end instead of overflowing
// (Jan 31 + 1 month -> Feb 28, never Mar 3). Mirrors the server scheduler.
const addMonthsClamped = (d, months) => { const out = new Date(d); const day = out.getDate(); out.setMonth(out.getMonth() + months); if (out.getDate() < day) out.setDate(0); return out; };
// Session generation: bumped at every auth transition (login, logout, a 401 that ends the session).
// Work started under an older generation is discarded: its token is never adopted, its response never
// reaches the UI, and a read is never replayed under a different session.
let sessionGen = 0;
const staleError = () => { const e = new Error('הסשן הוחלף'); e.stale = true; e.status = 0; return e; };
const endSession = () => { sessionGen++; renewing = null; state.user = null; state.token = null; };
// One refresh at a time, shared by the 10-minute timer, loadApp, the online event and the 401 recovery in api():
// refresh tokens rotate, so two overlapping refreshes must never race.
let renewing = null;
// Held from before a login/logout waits for the refresh until its request is finished: no NEW refresh (timer, online
// event, 401 recovery) may start in between, or it could reopen the cookie race that the wait just closed.
let authTransition = false;
const refreshSession = () => {
  if (authTransition) { const e = staleError(); return Promise.reject(e); }
  if (!renewing) {
    const gen = sessionGen;
    const p = apiRequest('/api/auth/refresh', { method: 'POST' }, {}).then((r) => {
      if (gen !== sessionGen) throw staleError();
      if (!r || !r.token) throw new Error('no token');
      const pinned = String(state.user?._id || state.user?.id || state.expectUserId || ''); const got = tokenUserId(r.token);
      if (pinned && got !== pinned) { const e = new Error('חשבון אחר'); e.mismatch = true; e.status = 0; throw e; } // never adopt another account's token
      state.token = r.token; return r.token;
    }).finally(() => { if (renewing === p) renewing = null; });
    renewing = p;
  }
  return renewing;
};
const accountChanged = () => { endSession(); renderAuth(); toast('החשבון בסשן השתנה. היכנסו מחדש.', 'danger'); };
const renewToken = () => refreshSession().catch((e) => { if (e.mismatch) accountChanged(); return null; });
// Before a login or logout request goes out, let any in-flight refresh land first so its Set-Cookie cannot arrive
// after the new session's cookie. Bounded, and it FAILS CLOSED: false means a refresh is still pending, and the
// caller must not send the request (a stale response could still overwrite the cookie jar).
const settleRefresh = async (ms = 5000) => {
  const p = renewing; if (!p) return true;
  let timer; await Promise.race([p.catch(() => {}), new Promise((r) => { timer = setTimeout(r, ms); })]); clearTimeout(timer);
  return !renewing;
};
// Every renewal is pinned to the signed-in account: the access token's id claim must match before it is adopted.
const tokenUserId = (t) => { try { const b = String(t).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); return String(JSON.parse(atob(b + '='.repeat((4 - (b.length % 4)) % 4))).id || ''); } catch { return ''; } };
const api = async (url, options = {}) => {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  const method = (options.method || 'GET').toUpperCase();
  const isMutating = !['GET', 'HEAD'].includes(method);
  const isUpload = options.body instanceof FormData;
  if (isMutating) updateGuard.mutationStarted({ upload: isUpload });
  try {
    const gen = sessionGen;
    try {
      const out = await apiRequest(url, options, headers);
      if (gen !== sessionGen) throw staleError();
      return out;
    } catch (error) {
      if (error.stale) throw error;
      if (gen !== sessionGen) throw staleError();
      // The access token lasts an hour and is renewed by a 10-minute timer that does not
      // run while the PC sleeps or is offline. On the first 401 of a data call, renew it
      // once from the refresh cookie and, for reads only, repeat the call. A failed renewal
      // surfaces the original error. Auth calls are excluded so a wrong password stays a
      // wrong password.
      if (error.status !== 401 || !state.token || String(url).startsWith('/api/auth/')) throw error;
      const fresh = await renewToken();
      if (gen !== sessionGen) throw staleError();
      if (!fresh || isMutating) throw error;
      const again = await apiRequest(url, options, { ...headers, Authorization: `Bearer ${fresh}` });
      if (gen !== sessionGen) throw staleError();
      return again;
    }
  } finally {
    if (isMutating) updateGuard.mutationFinished({ upload: isUpload });
  }
};
const apiRequest = async (url, options, headers) => {
  let response;
  try { response = await fetch(url, { credentials: 'include', ...options, headers }); }
  catch { const error = new Error('לא ניתן להתחבר לשרת. בדקו שהאפליקציה פועלת ושיש חיבור לרשת.'); error.status = 0; throw error; }
  const raw = await response.text();
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) { const error = new Error(data.message || 'הפעולה לא הושלמה. נסו שוב.'); error.status = response.status; error.fields = data.errors || []; error.data = data; throw error; }
  return data;
};
// A retry that fails again must visibly differ from "nothing happened": the panel shows when the last attempt ran.
let lastRetryAt = null;
const retryNote = () => (lastRetryAt ? `<small class="muted" data-retry-note style="display:block;margin-top:8px">ניסיון אחרון: ${esc(lastRetryAt)}</small>` : '');
const markRetry = (fn) => () => { lastRetryAt = new Date().toLocaleTimeString('he-IL', { timeZone: 'Asia/Jerusalem' }); return fn(); };
const toast = (text, kind = 'info') => { const node = document.createElement('div'); node.className = `toast toast-${kind}`; node.textContent = text; document.body.append(node); setTimeout(() => node.remove(), 3600); };

// Two-tone chime played alongside the native desktop notification. WebAudio needs
// no asset file, and the Electron window allows autoplay (set in main.js).
const playNotificationSound = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = playNotificationSound.ctx || (playNotificationSound.ctx = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const now = ctx.currentTime;
    [880, 1174.66].forEach((freq, index) => {
      const start = now + index * 0.18;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.18);
    });
  } catch {}
};

// Renewal of an existing approval is never silent: the server refuses the first save
// with the current record's details, and the save only proceeds after the user
// approves replacing THAT exact record (renewalOf pins it server-side).
const confirmLicenseRenewal = (formModal, form, existing) => {
  const r = modal('חידוש אישור קיים', `<div class="form-grid"><p>כבר קיים אישור פעיל מסוג זה לסניף שנבחר${existing.expiryDate ? ` (בתוקף עד ${esc(date(existing.expiryDate))})` : ''}.</p><p class="muted">באישור, האישור הקיים יועבר להיסטוריה והאישור החדש יהיה הפעיל. הבחירה בשדה "מחק גם את המסמך של האישור המוחלף" נשמרת כפי שסימנתם.</p><div class="button-row"><button class="primary" id="confirmRenewal">אישור החלפה וחידוש</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
  r.wrap.querySelector('[data-cancel]').onclick = r.close;
  r.wrap.querySelector('#confirmRenewal').onclick = async () => {
    const f = new FormData(form); f.set('confirmRenewal', 'true'); f.set('renewalOf', existing.id);
    try { await api('/api/licenses', { method: 'POST', body: f }); r.close(); formModal.close(); toast('האישור חודש והקודם הועבר להיסטוריה.', 'success'); await loadApp(); if (state.branchId) await renderBranch(); }
    catch (error) { r.close(); toast(error.message, 'danger'); }
  };
};

const confirmDeleteLicenseFile = (licenseId, fileName) => {
  const m = modal('מחיקת מסמך', `<div class="form-grid"><p>למחוק את המסמך <strong><bdi dir="ltr">${esc(fileName || '')}</bdi></strong>?</p><p class="muted">האישור עצמו, תאריכיו וההיסטוריה נשארים. לא ניתן לשחזר את הקובץ אחרי המחיקה.</p><div class="button-row"><button class="danger" id="confirmDeleteFile">מחיקת המסמך</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('#confirmDeleteFile').onclick = async () => { try { const r = await api(`/api/licenses/${licenseId}/file`, { method: 'DELETE' }); m.close(); toast((r && r.message) || 'המסמך נמחק', 'success'); await loadApp(); if (state.branchId) await renderBranch(); } catch (error) { toast(error.message, 'danger'); } };
};

const openLicenseFile = async (licenseId) => {
  try {
    const response = await fetch(`/api/licenses/${licenseId}/file`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
    if (!response.ok) {
      let message = 'לא ניתן לפתוח את הקובץ. נסו שוב.';
      try { message = (await response.json()).message || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message, 'danger'); }
};

const renderAuth = () => {
  removeMobileNav();
  headerActions.innerHTML = '';
  app.innerHTML = `<section class="auth-layout"><div class="auth-intro"><div class="eyebrow">ניהול אישורים למעונות יום</div><h2>כל הסניפים.<br>כל האישורים.<br><span>בלי לפספס חידוש.</span></h2><p>מקום אחד לעקוב אחרי אישורים, מועדי פקיעה ומשימות חידוש.</p><div class="auth-decoration"><span>✓</span><span>30 יום</span><span>7 ימים</span><span>יום הפקיעה</span></div></div><div class="panel auth-panel"><h3 class="auth-title">התחברות</h3><form id="authForm"><label>שם או דוא״ל<input name="identifier" type="text" autocomplete="username" required></label><label>סיסמה<input name="password" type="password" autocomplete="current-password" minlength="8" required></label><button class="primary full" type="submit">התחברות</button><p id="authHint" class="muted">התחברו עם השם שלכם כפי שהוא מופיע במערכת, או עם כתובת הדוא״ל.</p><button type="button" id="forgotLink" class="text-button">שכחתי סיסמה</button></form></div></section>`;
  document.getElementById('forgotLink').onclick = () => renderForgot();
  document.getElementById('authForm').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const endpoint = '/api/users/login';
      if (authTransition) return;
      authTransition = true;
      let result;
      try {
        sessionGen++; state.user = null; state.token = null; // new session: older work is now stale
        if (!(await settleRefresh())) { toast('פעולה קודמת עדיין מסתיימת. נסו להיכנס שוב בעוד רגע.', 'danger'); return; }
        renewing = null;
        result = await api(endpoint, { method: 'POST', body: JSON.stringify({ identifier: form.get('identifier'), password: form.get('password') }) });
        state.token = result.token; state.expectUserId = String(result.id || '');
      } finally { authTransition = false; }
      await loadApp();
    } catch (error) { toast(error.message, 'danger'); }
  };
};

const renderForgot = () => {
  removeMobileNav();
  headerActions.innerHTML = '';
  app.innerHTML = `<section class="auth-layout"><div class="auth-intro"><div class="eyebrow">ניהול אישורים למעונות יום</div><h2>כל הסניפים.<br>כל האישורים.<br><span>בלי לפספס חידוש.</span></h2><p>מקום אחד לעקוב אחרי אישורים, מועדי פקיעה ומשימות חידוש.</p><div class="auth-decoration"><span>✓</span><span>30 יום</span><span>7 ימים</span><span>יום הפקיעה</span></div></div><div class="panel auth-panel"><h3 class="auth-title">איפוס סיסמה</h3><form id="forgotForm"><label>שם או דוא״ל<input name="identifier" type="text" autocomplete="username" required></label><button class="primary full" type="submit">שליחת קישור איפוס</button><p id="forgotHint" class="muted">הקישור נשלח לכתובת הדוא״ל שמקושרת לחשבון ותקף ל־30 דקות.</p><p id="forgotSpam" class="forgot-spam" hidden><strong>לא מצאתם את המייל?</strong> בדקו גם בתיקיית הספאם או דואר הזבל.</p></form><button type="button" id="backToLogin" class="text-button">חזרה להתחברות</button></div></section>`;
  document.getElementById('backToLogin').onclick = () => renderAuth();
  document.getElementById('forgotForm').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const result = await api('/api/users/password/forgot', { method: 'POST', body: JSON.stringify({ identifier: form.get('identifier') }) });
      document.getElementById('forgotHint').textContent = `${result.message} בדקו את תיבת הדוא״ל.`;
      document.getElementById('forgotSpam').hidden = false;
    } catch (error) { toast(error.message, 'danger'); }
  };
};

const renderReset = (token) => {
  removeMobileNav();
  headerActions.innerHTML = '';
  app.innerHTML = `<section class="auth-layout"><div class="auth-intro"><div class="eyebrow">ניהול אישורים למעונות יום</div><h2>כל הסניפים.<br>כל האישורים.<br><span>בלי לפספס חידוש.</span></h2><p>מקום אחד לעקוב אחרי אישורים, מועדי פקיעה ומשימות חידוש.</p><div class="auth-decoration"><span>✓</span><span>30 יום</span><span>7 ימים</span><span>יום הפקיעה</span></div></div><div class="panel auth-panel"><h3 class="auth-title">בחירת סיסמה חדשה</h3><form id="resetForm"><label>סיסמה חדשה<input name="password" type="password" autocomplete="new-password" minlength="10" required></label><label>אימות סיסמה<input name="confirm" type="password" autocomplete="new-password" minlength="10" required></label><button class="primary full" type="submit">עדכון הסיסמה</button><p class="muted">הסיסמה חייבת להכיל לפחות 10 תווים.</p></form><button type="button" id="resetToLogin" class="text-button">חזרה להתחברות</button></div></section>`;
  document.getElementById('resetToLogin').onclick = () => { history.replaceState(null, '', location.pathname + location.search); renderAuth(); };
  document.getElementById('resetForm').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    if (form.get('password') !== form.get('confirm')) { toast('הסיסמאות לא תואמות', 'danger'); return; }
    try {
      const result = await api('/api/users/password/reset', { method: 'POST', body: JSON.stringify({ token, password: form.get('password') }) });
      history.replaceState(null, '', location.pathname + location.search);
      renderAuth();
      toast(result.message, 'success');
    } catch (error) { toast(error.message, 'danger'); }
  };
};

let isLoading = false;
// Native toast planning. Runs after every data refresh and every minute on the cached lists (no extra server polling),
// so timed task reminders land close to their minute while the app is open or in the tray.
const runToasts = () => {
  if (!state.user) return;
  try {
    // Native Windows toasts: one summary on the first refresh of the session
    // (no burst after the app was closed), individual typed toasts afterwards.
    // Works while the window is hidden to the tray; nothing runs once quit.
    // Held until 11:00 Israel time; before that nothing is marked seen or primed.
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    const popupsOpen = popupWindowOpen();
    const firstOfSession = !sessionStorage.getItem(SESSION_KEY);
    if (popupsOpen) sessionStorage.setItem(SESSION_KEY, '1');
    const toastSource = state.user.role === 'Manager' ? dueTaskAlertItems(state.tasks) : state.alerts;
    // Items with a set time of day (task reminders and timed deadlines) are not held to the 11:00 rule; everything else is.
    const plan = popupsOpen ? planNativeToasts(toastSource, { seenIds: seen, firstOfSession }) : planNativeToasts(toastSource.filter((x) => x.timed), { seenIds: seen, firstOfSession: false });
    if (plan.mode === 'summary') {
      window.electronAPI?.notify(summaryToastPayload(plan.count));
      playNotificationSound();
    } else if (plan.mode === 'individual') {
      const helpers = { typeName, branchName, date, money };
      plan.items.forEach((item) => window.electronAPI?.notify(alertToastPayload(item, helpers)));
      playNotificationSound();
    }
    if (plan.seen.length) {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, ...plan.seen].slice(-1000)));
    }
  } catch { /* a toast problem must never break the app */ }
};
const loadApp = async () => {
  if (isLoading) return;
  isLoading = true;
  try {
    await refreshSession();
    const me = await api('/api/users/me');
    // After a login the cookie jar must belong to the account that just signed in; a stale refresh from a previous account must not win.
    if (state.expectUserId && String(me._id || me.id) !== state.expectUserId) { endSession(); state.expectUserId = null; renderAuth(); toast('הכניסה לא הושלמה. נסו להיכנס שוב.', 'danger'); return; }
    state.expectUserId = null;
    state.user = me;
    [state.branches, state.licenses, state.alerts, state.tasks] = await Promise.all([api('/api/branches'), api('/api/licenses'), api('/api/notifications'), api('/api/tasks')]);
    state.types = await api('/api/license-types');
    if (state.branchId && !state.branches.some((b) => b._id === state.branchId)) state.branchId = null;
    render();
    runToasts();
  } catch (error) {
    if (error.stale) return;
    if (error.mismatch) { accountChanged(); return; }
    if (error.status === 401) { endSession(); renderAuth(); }
    else { if (!state.user) renderAuth(); toast(error.message, 'danger'); }
  }
  finally { isLoading = false; }
};
const statusText = (status) => ({ Valid: 'בתוקף', Expiring_Soon: 'לקראת פקיעה', Expired: 'פג תוקף' }[status] || status);
const statusClass = (status) => ({ Valid: 'good', Expiring_Soon: 'warning', Expired: 'danger' }[status] || 'neutral');
const branchName = (id) => state.branches.find((b) => b._id === (id?._id || id))?.name || id?.name || 'סניף';
const typeName = (id) => state.types.find((t) => t._id === (id?._id || id))?.name || id?.name || 'אישור';
// A branch user (role Manager) is alerted only about tasks he created himself whose due day has arrived.
// License and rent reminders belong to the system admin. The task deadline is a calendar day (Israel time).
const dueTaskAlerts = () => state.tasks.filter((t) => taskDeadlineArrived(t));
const currentAlerts = () => (state.user?.role === 'Manager' ? dueTaskAlerts().map((t) => ({ _id: `task-${t._id}`, kind: 'Task', status: 'Open' })) : state.alerts.filter((a) => ['Open', 'In_Progress'].includes(a.status)));
const renderHeader = () => {
  const navItem = (page, label, icon, count) => `<button data-page="${page}" class="${state.page === page ? 'selected' : ''}"${state.page === page ? ' aria-current="page"' : ''}><svg class="nav-ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg><span>${label}</span>${count ? `<b class="nav-count" aria-label="${count} ממתינים">${count}</b>` : ''}</button>`;
  const isAdminUser = state.user.role === 'Admin';
  const openTasks = state.tasks.filter((task) => task.status !== 'Done').length;
  headerActions.innerHTML = `<nav class="nav" aria-label="ניווט ראשי">${navItem('branches', 'הסניפים שלי', NAV_ICONS.branches)}${navItem('alerts', 'התראות', NAV_ICONS.alerts, currentAlerts().length)}${navItem('tasks', 'משימות', NAV_ICONS.tasks, openTasks)}${state.user.aiEnabled ? navItem('ai', 'עוזר AI', NAV_ICONS.ai) : ''}${isAdminUser ? `${navItem('rent', 'שכירות', NAV_ICONS.rent)}${navItem('report', 'דוחות', NAV_ICONS.report)}${navItem('settings', 'הגדרות וצוות', NAV_ICONS.settings)}` : ''}</nav><div class="user-menu"><span class="user-avatar">${esc(state.user.name.slice(0, 1))}</span><span class="user-name">${esc(state.user.name)}<small>${isAdminUser ? 'מנהל חשבון' : 'משתמש'}</small></span><button class="icon-button" id="logout" title="התנתקות" aria-label="התנתקות"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4H5v16h5"/><path d="M15 8l4 4-4 4M19 12H9"/></svg></button></div>`;
  headerActions.querySelectorAll('[data-page]').forEach((button) => button.onclick = () => { state.page = button.dataset.page; state.branchId = null; render(); });
  document.getElementById('logout').onclick = async () => { if (authTransition) return; authTransition = true; try { if (!(await settleRefresh())) { toast('פעולה קודמת עדיין מסתיימת. נסו להתנתק שוב בעוד רגע.', 'danger'); return; } sessionGen++; renewing = null; try { await api('/api/auth/logout', { method: 'POST' }); } catch {} endSession(); renderAuth(); } finally { authTransition = false; } };
  renderMobileNav();
};
// Phone-width bottom navigation (shown by CSS only at <=620px; desktop keeps the top nav).
// Same destinations and role rules as the top nav; "עוד" holds the rarely used pages.
const NAV_ICONS = {
  branches: '<path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/>',
  alerts: '<path d="M6 9a6 6 0 0112 0c0 6 2 7 2 7H4s2-1 2-7"/><path d="M10 20a2 2 0 004 0"/>',
  tasks: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
  rent: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
  report: '<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v4h4M10 12h6M10 16h6"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  ai: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
};
const navIcon = (key) => `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NAV_ICONS[key]}</svg>`;
const removeMobileNav = () => { document.getElementById('mobile-nav')?.remove(); document.body.classList.remove('has-mobile-nav'); };
const renderMobileNav = () => {
  let host = document.getElementById('mobile-nav');
  if (!host) { host = document.createElement('div'); host.id = 'mobile-nav'; document.body.appendChild(host); }
  document.body.classList.add('has-mobile-nav');
  const isAdmin = state.user.role === 'Admin';
  const alertCount = currentAlerts().length;
  const taskCount = state.tasks.filter((task) => task.status !== 'Done').length;
  const tab = (page, label, count) => `<button data-mpage="${page}" class="${state.page === page ? 'selected' : ''}" ${state.page === page ? 'aria-current="page"' : ''}><i>${navIcon(page)}</i><span>${label}</span>${count ? `<em aria-label="${count} ממתינים">${count}</em>` : ''}</button>`;
  const moreItems = [['rent', 'שכירות'], ['report', 'דוחות'], ['settings', 'הגדרות וצוות']];
  const moreActive = moreItems.some(([page]) => state.page === page);
  host.innerHTML = `<nav class="mobile-tabbar" aria-label="ניווט ראשי">${tab('branches', 'סניפים')}${tab('alerts', 'התראות', alertCount)}${tab('tasks', 'משימות', taskCount)}${state.user.aiEnabled ? tab('ai', 'עוזר AI') : ''}${isAdmin ? `<button id="mobileMore" class="${moreActive ? 'selected' : ''}" aria-haspopup="true" aria-expanded="false"><i>${navIcon('more')}</i><span>עוד</span></button>` : ''}</nav>${isAdmin ? `<div class="mobile-more" id="mobileMoreSheet" hidden>${moreItems.map(([page, label]) => `<button data-mpage="${page}" class="${state.page === page ? 'selected' : ''}"><i>${navIcon(page)}</i>${label}</button>`).join('')}</div>` : ''}`;
  const sheet = document.getElementById('mobileMoreSheet');
  const moreButton = document.getElementById('mobileMore');
  const closeSheet = () => { if (sheet) sheet.hidden = true; moreButton?.setAttribute('aria-expanded', 'false'); };
  moreButton?.addEventListener('click', () => { sheet.hidden = !sheet.hidden; moreButton.setAttribute('aria-expanded', String(!sheet.hidden)); });
  host.querySelectorAll('[data-mpage]').forEach((button) => button.addEventListener('click', () => { closeSheet(); state.page = button.dataset.mpage; state.branchId = null; render(); window.scrollTo(0, 0); }));
};
// A new screen (another page, or another branch) always opens at its top. Refreshes of the same screen keep the scroll position.
let lastViewKey = null;
const resetScrollOnViewChange = () => { const key = `${state.page}|${state.branchId || ''}`; if (lastViewKey !== null && key !== lastViewKey) { window.scrollTo(0, 0); resetCollapsed(); state.rentShowAllOverdue = false; state.rentShowAllUpcoming = false; } lastViewKey = key; };
// Collapses every plain row list inside a screen or panel (history lists and agreement lists). Lists with their own show-all (rent payments) and lists already handled by id are skipped.
const autoCollapse = (root, prefix) => root.querySelectorAll('.history-list, .license-list').forEach((el, n) => {
  if (el.id || el.dataset.collapseDone || el.closest('#rentOverduePanel, #rentUpcomingPanel')) return;
  el.dataset.collapseDone = '1';
  collapseList(el, { itemSelector: ':scope > *', limit: LIST_LIMITS.row, key: `${prefix}-${n}` });
});

// AI assistant page. Proposal-only: the server returns text, nothing is saved.
// Visible only to users with aiEnabled; the server enforces the same rule.
// The assistant does not see system data or read documents yet; the page says so.
const aiChat = [];
let aiMode = 'chat'; let aiPreferAgreement = '';
const TASK_STATUS_HE = { To_Do: 'לביצוע', In_Progress: 'בטיפול', Done: 'הושלם' };
const RENT_LABEL = { rent_edit_payment: 'עריכת תשלום ממתין', rent_mark_handed: 'סימון צ׳ק כנמסר', rent_mark_cleared: 'סימון תשלום כנפרע', rent_revert_payment: 'ביטול סימון תשלום' };
const BRANCH_FIELD = { name: 'שם', address: 'כתובת', managerName: 'מנהל/ת', phone: 'טלפון', maxChildren: 'מספר ילדים מרבי', status: 'סטטוס', emails: 'מיילים', authorityId: 'גוף משלם', kind: 'סוג הסניף' };
const iso = (x) => `\u2068${x}\u2069`;
const cmpLines = (label, cur, next) => [`${label} נוכחי: ${iso(cur)}`, `${label} מוצע: ${iso(next)}`];
const bval = (k, v) => (v === '' || v == null || (Array.isArray(v) && !v.length) ? 'ריק' : k === 'kind' ? ({ daycare: 'מעון', property: 'נכס / משרד' }[v] || v) : k === 'status' ? (BRANCH_STATUS[v] || v) : Array.isArray(v) ? v.join(', ') : v);
const BRANCH_STATUS = { Active: 'פעיל', Pending_License: 'ממתין לרישיון', Suspended: 'מושעה' };
const AGR_FIELD = { monthlyAmount: 'סכום חודשי (גם בתדירות רבעונית או שנתית)', quarterlyAmount: 'סכום תשלום רבעוני', chequeSeries: 'סדרת צ׳קים מופקדת', annualAmount: 'סכום תשלום שנתי', frequency: 'תדירות', paymentMethod: 'אמצעי תשלום', firstDueDate: 'תאריך פרעון ראשון', direction: 'כיוון' };
const AGR_VAL = { monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מותאם', cheque: 'צ׳ק', transfer: 'העברה', incoming: 'הרשות משלמת לכם', outgoing: 'אתם משלמים לגוף התשלום' };
const csTxt = (v) => (v && typeof v === 'object' ? `הופקדו ${v.depositedCount} צ׳קים · התחלה: ${v.seriesStartDate || 'לא הוגדר'} · סיום: ${v.seriesEndDate}` : v);
const AR = (v) => (v && typeof v === 'object' ? csTxt(v) : v === null || v === undefined || v === '' ? 'לא הוגדר' : (AGR_VAL[v] || v));
const CSV_HEAD = { branch: 'סניף', type: 'סוג אישור', issued: 'הנפקה', expiryDate: 'תוקף', file: 'קובץ', authority: 'גוף תשלום', dueDate: 'מועד', amount: 'סכום', summary: 'סיכום', when: 'מתי', user: 'משתמש', action: 'פעולה', target: 'יעד', outcome: 'תוצאה' };
// Exports exactly the rows the report returned (nothing more is fetched). Cells that start like a formula are neutralized.
const csvCell = (v) => { let t = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`; return `"${t.replace(/"/g, '""')}"`; };
const exportRowsCsv = (csv) => {
  if (!csv || !csv.rows.length) return;
  const keys = [...new Set(csv.rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'fileLicenseId');
  const lines = [keys.map((k) => csvCell(CSV_HEAD[k] || k)).join(','), ...csv.rows.map((r) => keys.map((k) => csvCell(r[k])).join(','))];
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'kinderguard-report.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
const deleteBranchCounts = (b) => b ? `אישורים (כולל היסטוריה): ${b.licenses} · קבצים מצורפים: ${b.files} · התראות: ${b.alerts}` : '';
const describeAction = (a, branches) => { if (a.domain === 'license' && a.type === 'create_license') return { head: 'יצירת אישור חדש (בלי קובץ מצורף)', lines: [`סניף: ${a.branchName}`, `סוג אישור: ${a.typeName}`, `הנפקה: ${a.issueDate}`, `תפוגה: ${a.expiryDate}`, 'לא קיים אישור פעיל כזה. העוזר לא מחליף ולא מחדש אישורים.'] }; if (a.domain === 'branch' && a.type === 'delete_branch') return { head: `מחיקת סניף${a.currentName ? `: ${a.currentName}` : ' (יש לבחור איזה)'}`, lines: [a.before ? `יימחקו יחד איתו. ${deleteBranchCounts(a.before)}` : '', a.before ? `היסטוריה כספית נשמרת (הסכמי שכירות סגורים: ${a.before.closedAgreements}). התשלומים שלהם לא יימחקו.` : '', 'המחיקה אינה הפיכה. סניף עם הסכם שכירות פעיל לא יימחק.', 'אם נוצר הסכם חדש בזמן המחיקה, הוא עלול להיסגר ותשלומיו העתידיים יבוטלו. לפני המחיקה המערכת בודקת שוב את האישורים, הקבצים וההתראות. אם הם שונים ממה שמוצג כאן, המחיקה נעצרת. אישור או קובץ שנוסף בדיוק בזמן המחיקה עלול להימחק גם הוא או להיות מנוקה אחר כך ברקע.', 'נדרשת הסיסמה הנוכחית.', a.warning || ''].filter(Boolean) }; if (a.domain === 'payment_group') { const money = (n) => `${Number(n).toLocaleString('he-IL')} ₪`; const allocs = (a.allocations || []).map((x) => `${x.branchName}: ${money(x.amount)}`); const HEAD = { create_payment_group: 'תשלום מרוכז חדש', group_mark_handed: 'סימון תשלום מרוכז כנמסר', group_mark_cleared: 'סימון תשלום מרוכז כנפרע', cancel_payment_group: 'ביטול רישום תשלום מרוכז', revert_payment_group: 'ביטול סימון של תשלום מרוכז' }; return { head: `${HEAD[a.type]}: ${a.authorityName}`, lines: [`אמצעי: ${a.methodLabel} · סך הכל ${money(a.total)} · מועד ${a.dueDate}`, ...(a.currentStatus ? [`מצב נוכחי: ${a.currentStatus}`] : []), ...allocs, a.reason ? `סיבה: ${a.reason}` : '', 'זה עדכון רישום במערכת בלבד. לא מתבצע תשלום.', a.sensitive ? 'נדרשת הסיסמה הנוכחית.' : ''].filter(Boolean) }; } if (a.domain === 'notification') return { head: `התראה: ${a.subject}`, lines: [a.branchName ? `סניף: ${a.branchName}` : '', ...cmpLines('מצב טיפול', a.fromLabel, a.toLabel), 'אפשר לשנות בחזרה.'].filter(Boolean) }; if (a.domain === 'license') { const tgt = a.needsChoice ? '' : `${a.typeName ? a.typeName : ''}${a.branchName ? ` · ${a.branchName}` : ''}${a.expiry ? ` · בתוקף עד ${a.expiry}` : ''}`; if (a.type === 'create_license_type') return { head: `סוג אישור חדש: ${a.name}`, lines: [a.branchName ? `לסניף: ${a.branchName}` : 'לכל הסניפים', a.description || '', a.warning || ''].filter(Boolean) }; if (a.type === 'deactivate_license_type') return { head: `הסרת סוג אישור: ${a.name}`, lines: [a.branchName ? `סניף: ${a.branchName}` : 'לכל הסניפים', 'נדרשת הסיסמה הנוכחית.', a.warning || ''].filter(Boolean) }; return { head: a.type === 'archive_license' ? `העברת אישור לארכיון${a.needsChoice ? ' (יש לבחור איזה)' : ''}` : `מחיקת הקובץ המצורף לאישור${a.needsChoice ? ' (יש לבחור איזה)' : ''}`, lines: [tgt, a.type === 'delete_license_file' && a.fileName ? `קובץ: ${a.fileName}. המחיקה אינה הפיכה. האישור והתאריכים נשארים.` : (a.type === 'archive_license' ? 'האישור יעבור לארכיון והתראות פתוחות עליו ייסגרו.' : ''), 'נדרשת הסיסמה הנוכחית.', a.warning || ''].filter(Boolean) }; } if (a.domain === 'authority') return a.type === 'create_authority' ? { head: `גוף תשלום חדש: ${a.name}`, lines: [`סוג: ${a.kind === 'private' ? 'בעל נכס פרטי' : 'רשות או חברה עירונית'}`, a.warning || ''].filter(Boolean) } : { head: a.needsChoice ? 'מחיקת גוף תשלום (יש לבחור איזה)' : `מחיקת גוף תשלום: ${a.name}`, lines: [a.needsChoice ? '' : `סוג: ${a.kind === 'private' ? 'בעל נכס פרטי' : 'רשות או חברה עירונית'}`, 'הגוף יימחק. הסכמים סגורים והיסטוריית התשלומים נשארים.', 'נדרשת הסיסמה הנוכחית.', a.warning || ''].filter(Boolean) }; if (a.type === 'delete_agreement_document') return { head: `מחיקת מסמך: \u2066${a.fileName || 'ללא שם'}\u2069`, lines: [`מההסכם: ${a.branchName} · ${a.authorityName}`, 'המסמך יוסר מההסכם ולא ניתן לשחזר אותו.', 'נדרשת הסיסמה הנוכחית.'] }; if (a.type === 'create_agreement_step') return { head: 'הסכם שכירות חדש, שלב 1 מתוך 2: בחירת סניף', lines: [`סכום חודשי: ${iso(a.changes.monthlyAmount)} ₪`, a.warning || ''].filter(Boolean) }; if (a.domain === 'agreement' && a.type === 'create_agreement') return { head: `הסכם שכירות חדש: ${a.branchName || 'יש לבחור סניף'} · ${a.authorityName || 'יש לבחור גוף תשלום'}`, lines: [`סכום חודשי: ${iso(a.changes.monthlyAmount)} ₪`, `תדירות: ${AR(a.changes.frequency)}`, `אמצעי תשלום: ${AR(a.changes.paymentMethod)}`, `תאריך פרעון ראשון: ${iso(date(a.changes.firstDueDate))}`, `כיוון: ${a.changes.direction === 'incoming' ? 'הרשות משלמת לכם שכירות על המעון' : 'אתם משלמים שכירות לגוף התשלום'}`, ...(a.changes.customDueDates ? [`מועדי פרעון מותאמים (${a.changes.customDueDates.length}): ${a.changes.customDueDates.join(' · ')}`] : []), ...(a.changes.quarterlyAmount !== undefined ? [`סכום תשלום רבעוני: ${iso(a.changes.quarterlyAmount)} ₪`] : []), ...(a.changes.annualAmount !== undefined ? [`סכום תשלום שנתי: ${iso(a.changes.annualAmount)} ₪`] : []), ...(a.changes.chequeSeries ? [`סדרת צ׳קים מופקדת: ${csTxt(a.changes.chequeSeries)}`] : []), 'ייווצרו תשלומים מתוזמנים לפי ההסכם. רישום במערכת בלבד, לא ביצוע תשלום.', 'נדרשת הסיסמה הנוכחית.', a.warning || ''].filter(Boolean) }; if (a.domain === 'agreement') return { head: `${a.type === 'close_agreement' ? 'סגירת הסכם שכירות' : 'עדכון הסכם שכירות'}: ${a.branchName} · ${a.authorityName}`, lines: [...(a.type === 'close_agreement' ? ['ההסכם יסומן כסגור והתשלומים העתידיים שממתינים יבוטלו.', a.reason ? `סיבה: ${a.reason}` : ''] : [...Object.entries(a.changes).flatMap(([k, v]) => cmpLines(AGR_FIELD[k], AR(a.current[k]), AR(v))), ...(a.effect ? ((FQ) => [`סכום כל תשלום מתוזמן לפני (${FQ[a.effect.beforeFrequency] || a.effect.beforeFrequency}): ${AR(a.effect.before)}`, `סכום כל תשלום מתוזמן אחרי (${FQ[a.effect.afterFrequency] || a.effect.afterFrequency}): ${AR(a.effect.after)}`, ...(a.effect.before === a.effect.after && a.changes.monthlyAmount !== undefined ? ['הסכום החודשי משתנה אבל סכום התשלום המתוזמן לא, כי נקבע לפי הסכום הרבעוני/השנתי השמור בהסכם.'] : []),
 ...(((a.changes.quarterlyAmount !== undefined && a.effect.afterFrequency !== 'quarterly') || (a.changes.annualAmount !== undefined && a.effect.afterFrequency !== 'annual')) ? ['הסכום הרבעוני/השנתי נשמר בהסכם אבל לא משפיע על התשלומים המתוזמנים כל עוד התדירות לא רבעונית/שנתית בהתאמה.'] : [])])({ monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מותאם' }) : []),
 ...(a.changes.chequeSeries ? ((o, n) => ['שימו לב: השינוי מחליף את כל סדרת הצ׳קים השמורה בהסכם, לא רק שדה אחד.', ...(o && o.seriesStartDate && !n.seriesStartDate ? [`תאריך ההתחלה הקודם (${o.seriesStartDate}) יימחק, כי לא צוין תאריך התחלה חדש.`] : []), ...(o && o.depositedCount !== n.depositedCount ? [`מספר הצ׳קים שהופקדו ישתנה מ-${o.depositedCount} ל-${n.depositedCount}.`] : [])])(a.current.chequeSeries, a.changes.chequeSeries) : []), ...(a.changes.direction !== undefined ? ['אזהרה: החלפת הכיוון משנה את הפירוש של כל התשלומים שכבר נרשמו בהסכם הזה, גם של העבר, לא רק של תשלומים חדשים. בדקו שזה הכיוון הנכון לפני האישור.'] : []), ...(a.changes.monthlyAmount !== undefined || a.changes.frequency !== undefined || a.changes.paymentMethod !== undefined || a.changes.firstDueDate !== undefined ? ['שינוי תדירות או סכום יעדכן את לוח התשלומים הממתינים.'] : []), 'רישום במערכת בלבד, לא ביצוע תשלום.']), 'נדרשת הסיסמה הנוכחית.'].filter(Boolean) }; if (a.domain === 'team') return { head: `הוספת משתמש: ${a.name}`, lines: [`דוא״ל: ${a.email}`, a.branchNames?.length ? `סניפים: ${a.branchNames.join(', ')}` : 'ללא סניפים שנבחרו (רלוונטי למנהל סניף)'] }; if (a.domain === 'branch') { const bv = (k, v) => (k === 'authorityId' ? (v === '__payer_choice__' ? 'יש לבחור למטה' : v ? (a.authorityNames?.[String(v)] || 'גוף משלם לא מוכר') : 'ללא') : bval(k, v)); return { head: a.type === 'create_branch' ? `פתיחת סניף: ${a.fields.name}` : (a.needsChoice ? 'עדכון סניף (יש לבחור איזה)' : `עדכון סניף: ${a.currentName}`), lines: [...Object.entries(a.fields).flatMap(([k, v]) => (a.before && a.type === 'update_branch' ? cmpLines(BRANCH_FIELD[k] || k, bv(k, a.before[k]), bv(k, v)) : [`${BRANCH_FIELD[k] || k}: ${bv(k, v)}`])), a.warning || ''].filter(Boolean) }; } if (a.domain === 'rent') return { head: `${RENT_LABEL[a.type]}: ${a.branchName} · ${a.authorityName}`, lines: [...(a.changes ? [`סכום נוכחי: \u2068${a.before.amount} ₪\u2069`, a.changes.amount !== undefined ? `סכום מוצע: \u2068${a.changes.amount} ₪\u2069` : 'סכום מוצע: ללא שינוי', `יעד פרעון נוכחי: \u2068${date(a.before.dueDate)}\u2069`, a.changes.dueDate ? `יעד פרעון מוצע: \u2068${date(a.changes.dueDate)}\u2069` : 'יעד פרעון מוצע: ללא שינוי'] : [`סכום: ${a.amount} ₪ · יעד: ${a.dueDate}`]), `סטטוס נוכחי: ${({ Pending: 'ממתין', Handed: 'נמסר', Cleared: 'נפרע' })[a.currentStatus] || a.currentStatus}`, a.reason ? `סיבה: ${a.reason}` : '', 'רישום במערכת בלבד, לא ביצוע תשלום בפועל.', a.sensitive ? 'נדרשת הסיסמה הנוכחית.' : ''].filter(Boolean) }; const bn = (id) => (branches.find((b) => b.id === id) || {}).name; if (a.type === 'create_task') return { head: 'משימה חדשה', lines: [`כותרת: ${a.title}`, a.notes ? `הערות: ${a.notes}` : '', a.dueDate ? `יעד: ${a.dueDate}${a.dueTime ? ` ${a.dueTime}` : ''}` : '', a.branchId ? `סניף: ${bn(a.branchId) || ''}` : ''].filter(Boolean) }; if (a.type === 'delete_task') return { head: `מחיקת משימה: ${a.currentTitle}`, lines: ['המשימה תימחק לצמיתות. נדרשת הסיסמה הנוכחית.'] }; if (a.type === 'close_task') return { head: `סגירת משימה: ${a.currentTitle}`, lines: cmpLines('סטטוס', TASK_STATUS_HE[a.currentStatus] || a.currentStatus, TASK_STATUS_HE.Done) }; return { head: `עדכון משימה: ${a.currentTitle}`, lines: [a.title ? `כותרת חדשה: ${a.title}` : '', a.notes !== undefined ? `הערות חדשות: ${a.notes || '(ריק)'}` : '', a.dueDate || a.dueTime ? `יעד חדש: ${a.dueDate || ''}${a.dueTime ? ` ${a.dueTime}` : ''}`.trim() : ''].filter(Boolean) }; };
// Confirming sends only the proposal id: the server holds the proposal, applies it with the caller's own permissions, and ignores duplicates.
const runAction = async (a, password, choice, extra) => { let headers; if (a.sensitive) { const g = await api('/api/auth/step-up', { method: 'POST', body: JSON.stringify({ password, action: `ai:${a.type}`, scope: a.proposalId }) }); headers = { 'X-Step-Up': g.stepUpToken }; } return api(`/api/ai/proposals/${a.proposalId}/confirm`, { method: 'POST', body: JSON.stringify({ ...(choice ? { branchId: choice } : {}), ...(extra || {}) }), headers }); };
const AI_IDEAS = ['נסחו לי הודעה קצרה למנהלת סניף על אישור שפג תוקפו', 'הסבירו לי במילים פשוטות איך מחדשים רישיון עסק', 'עזרו לי לנסח תזכורת לתשלום שכירות'];
const AI_SPARK = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z"/></svg>';
let aiDoc = null; let aiDocList = null; let aiBranchPending = null; let aiModelPending = null; let aiPre = null;
// Optional Claude pre-check of an Excel/Word table before any card is prepared. Advisory only: the answers only choose rows to leave out
// (sent as skipRows); the server parser, matching, per-card confirm and step-up still decide everything. Nothing leaves the system without the ticked consent.
const coverageHtml = (c) => (c && c.note ? `<div class="ai-action" id="aiCoverage"><strong>כיסוי המסמך</strong><div>הוצגו ${esc(c.read)} ${c.read === 1 ? 'שורה' : 'שורות'} מהמסמך (המגבלה ${esc(c.cap)}).</div><div>${c.truncated ? 'הקריאה החזירה יותר מ-20 שורות. רק 20 הראשונות עובדו והוצגו, והשאר לא יובאו.' : 'לא ניתן לדעת אם המסמך כולל שורות נוספות שלא עובדו.'}</div><div class="muted">${esc(c.note)}</div></div>` : '');
const fileReviewHtml = (fr) => { if (!fr || (!(fr.merged || []).length && !(fr.omitted || []).length && !(fr.links || []).length)) return ''; const src = { filled: 'הושלם משורה', chosen: 'נבחר על ידכם משורה' };
  return `<div class="ai-review" id="aiFileReview"><strong>שינויים בקובץ לפי בחירתכם בבדיקה המקדימה</strong>${(fr.merged || []).map((m) => `<div>שורות ${m.keep} ו-${m.drop} אוחדו לשורה אחת (כפילות)${m.cols.length ? `: ${m.cols.map((c) => `${esc(c.header)}: ${esc(c.value)} (${src[c.source]} ${c.row})`).join('; ')}` : ' (בלי שינוי בערכים)'}</div>`).join('')}${(fr.omitted || []).length ? `<div>שורות שהושמטו: ${fr.omitted.join(', ')}</div>` : ''}${(fr.links || []).map((l) => `<div>שורות ${l.rows[0]} ו-${l.rows[1]}: ${l.relation === 'same_place' ? 'רשומות נפרדות לאותו סניף או מקום, נשארו כשורות נפרדות' : 'שונים, נשארו כשורות נפרדות'}</div>`).join('')}<small class="muted">שורה 1 היא הכותרת. כל הצעה למטה נבדקת ודורשת אישור.</small></div>`; };
const aiPreOwner = () => String(state.user?._id || state.user?.id || '');
const aiPreHash = async (file) => { try { const h = await crypto.subtle.digest('SHA-256', await file.arrayBuffer()); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join(''); } catch { return ''; } };
// The card is bound to the tab, the signed-in account and the exact file bytes (sha256). Switching tab, account or file drops it.
const aiPreStart = async (file, endpoint, mode) => { aiPre = { file, endpoint, mode, owner: aiPreOwner(), stage: 'choose', sha: await aiPreHash(file) }; renderAi(); };
const AI_PRE_DUP = { branches: 'אותו מעון בדיוק נכתב פעמיים', team: 'אותו משתמש בדיוק נכתב פעמיים', tasks: 'אותה משימה בדיוק נכתבה פעמיים', licenses: 'אותו אישור בדיוק נכתב פעמיים' };
const AI_PRE_SAME = { branches: 'אותו מעון בשתי שורות עם נתונים שונים או משלימים: להשאיר את שתי השורות כפי שהן', team: 'אותו סניף, משתמשים שונים: להשאיר את שתי השורות', tasks: 'אותו סניף, משימות נפרדות: להשאיר את שתי השורות', licenses: 'אותו סניף, אישורים נפרדים: להשאיר את שתי השורות' };
const aiPreCard = (parent, endpoint) => {
  if (!aiPre) return; const d = aiPre; const box = document.createElement('div'); box.className = 'ai-action'; box.id = 'aiPreCard';
  const nm = `<bdi dir="ltr">${esc(d.file.name)}</bdi>`;
  const goLocal = async (edits) => { aiPre = null; aiChat.push({ role: 'user', text: `קובץ: ${d.file.name}` }); try { const fd = new FormData(); fd.append('file', d.file); if (edits) { if (edits.skip.length) fd.append('skipRows', JSON.stringify(edits.skip)); if (edits.merges.length) fd.append('rowMerges', JSON.stringify(edits.merges)); if (edits.links.length) fd.append('rowLinks', JSON.stringify(edits.links)); fd.append('preflightSha', d.result.fileSha256); } const r = await api(endpoint, { method: 'POST', body: fd }); aiChat.push({ role: 'assistant', text: r.summary || '', proposal: r, done: {} }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } renderAi(); };
  if (d.stage === 'choose' || d.stage === 'busy') {
    box.innerHTML = `<strong>בדיקה מקדימה של הקובץ עם Claude</strong><div>${nm}</div><div>הקובץ עובר קודם בדיקה של Claude: סיכום, סימון נתונים חשודים ושאלה כששורות דומות. הבדיקה היא המלצה בלבד, ולא מכינה ולא משנה כלום. שום שורה לא מושמטת או מאוחדת בלי בחירה שלכם.</div><label class="check-row"><input type="checkbox" id="aiPreConsent"${d.stage === 'busy' ? ' checked disabled' : ''}><span>אני מאשר/ת לשלוח ל-<bdi dir="ltr">Claude</bdi> (<bdi dir="ltr">Anthropic</bdi>) עותק מצומצם של תוכן הקובץ: עד 200 שורות ו-15 עמודות, בלי עמודות סיסמה, בלי תאים שמתחילים בתו חשוד, ועם כתובות אימייל מוחלפות בסימון. הקובץ לא נשמר.</span></label>${d.err ? `<div class="form-error">${esc(d.err)}</div>` : ''}<button type="button" class="primary small-btn" id="aiPreClaude" disabled>${d.stage === 'busy' ? 'בודק...' : 'בדיקה עם Claude'}</button> <button type="button" class="secondary small-btn" id="aiPreLocal"${d.stage === 'busy' ? ' disabled' : ''}>המשך בלי בדיקת Claude (קריאה מקומית בלבד)</button> <button type="button" class="secondary small-btn" id="aiPreCancel"${d.stage === 'busy' ? ' disabled' : ''}>ביטול</button>`;
    parent.appendChild(box); const c = box.querySelector('#aiPreConsent'); const b = box.querySelector('#aiPreClaude');
    if (d.stage === 'choose') { c.onchange = () => { b.disabled = !c.checked; };
      b.onclick = async () => { if (!c.checked) return; d.stage = 'busy'; d.err = ''; renderAi(); try { const fd = new FormData(); fd.append('file', d.file); fd.append('consentExternal', 'true'); fd.append('mode', d.mode); const res = await api('/api/ai/files/preflight', { method: 'POST', body: fd }); if (d.sha && res.fileSha256 !== d.sha) throw new Error('הקובץ שנבדק שונה מהקובץ שנבחר. בחרו את הקובץ מחדש.'); d.result = res; d.stage = 'result'; } catch (error) { d.stage = 'choose'; d.err = `${error.message} אפשר לנסות שוב, או להמשיך בקריאה מקומית בלי Claude בבחירה מפורשת.`; } renderAi(); };
      box.querySelector('#aiPreLocal').onclick = () => goLocal(); box.querySelector('#aiPreCancel').onclick = () => { aiPre = null; renderAi(); }; }
    return;
  }
  const r = d.result; const qs = r.questions || []; const fl = r.flags || [];
  const cmp = (q, i) => `<table class="ai-cmp"><thead><tr><th>עמודה</th><th>שורה ${q.rows[0]}</th><th>שורה ${q.rows[1]}</th></tr></thead><tbody>${q.compare.cols.map((c) => `<tr${c.conflict ? ' class="ai-cmp-diff"' : ''}><td>${esc(c.header)}</td><td>${esc(c.a) || '<em>ריק</em>'}</td><td>${esc(c.b) || '<em>ריק</em>'}</td></tr>`).join('')}</tbody></table>`;
  const pickHtml = (q, i) => { const cf = q.compare.cols.filter((c) => c.conflict); return `<div class="ai-pick" data-prepicks="${i}" hidden>${cf.length ? `<small>בשורות יש ערכים שונים. בחרו ערך אחד לכל עמודה:</small>${cf.map((c) => `<div class="ai-pick-col"><strong>${esc(c.header)}</strong><label class="check-row"><input type="radio" name="prepick${i}_${c.col}" value="keep"><span>${esc(c.a)} (שורה ${q.rows[0]})</span></label><label class="check-row"><input type="radio" name="prepick${i}_${c.col}" value="drop"><span>${esc(c.b)} (שורה ${q.rows[1]})</span></label></div>`).join('')}` : '<small>אין ערכים סותרים. ערכים חסרים באחת השורות יושלמו מהשורה השנייה, ותראו את התוצאה אחרי ההכנה.</small>'}</div>`; };
  box.innerHTML = `<strong>תוצאת הבדיקה המקדימה</strong><div>${nm}</div><p>${esc(r.summary || '')}</p><small class="muted">${esc(r.note || '')} נבדקו ${r.rowsSent} מתוך ${r.totalRows} שורות (שורה 1 היא הכותרת). ${(r.minimisation || []).map(esc).join('. ')}</small>${fl.length ? `<fieldset class="ai-choice"><legend>נתונים שסומנו</legend>${fl.map((f) => `<label class="check-row"><input type="checkbox" data-preskip="${f.row}"><span>שורה ${f.row}: ${esc(f.issue)} (סמנו כדי להשמיט את השורה)</span></label>`).join('')}</fieldset>` : ''}${qs.map((q, i) => `<fieldset class="ai-choice" data-preq="${i}"><legend>${esc(q.question)}</legend>${cmp(q, i)}<small class="muted">בחרו כפילות רק אם שתי השורות הן אותה רשומה בדיוק. שורות של אותו סניף הן לרוב רשומות נפרדות.</small><label class="check-row"><input type="radio" name="preq${i}" value="sameplace"><span>${AI_PRE_SAME[d.mode] || 'רשומות נפרדות: להשאיר את שתי השורות'}</span></label><label class="check-row"><input type="radio" name="preq${i}" value="diff"><span>שונים: להשאיר את שתי השורות</span></label><label class="check-row"><input type="radio" name="preq${i}" value="dup"><span>כפילות: ${AI_PRE_DUP[d.mode] || 'אותה רשומה בדיוק נכתבה פעמיים'}. לאחד את שורה ${q.rows[0]} ושורה ${q.rows[1]} לשורה אחת (שום נתון לא נמחק בלי בחירה שלכם)</span></label>${pickHtml(q, i)}<label class="check-row"><input type="radio" name="preq${i}" value="omit"><span>לא בטוח: להשמיט את שתי השורות, בלי הצעה עבורן</span></label></fieldset>`).join('')}<button type="button" class="primary small-btn" id="aiPreContinue">המשך להכנת הצעות</button> <button type="button" class="secondary small-btn" id="aiPreCancel">ביטול</button><small class="muted">גם אחרי הבדיקה, כל שורה עוברת בדיקות והרשאות בתוכנה וכל כרטיס דורש אישור.</small>`;
  parent.appendChild(box);
  qs.forEach((q, i) => box.querySelectorAll(`input[name="preq${i}"]`).forEach((x) => { x.onchange = () => { box.querySelector(`[data-prepicks="${i}"]`).hidden = x.value !== 'dup' || !x.checked; }; }));
  const err = (m) => { box.querySelector('.form-error')?.remove(); box.querySelector('#aiPreContinue').insertAdjacentHTML('beforebegin', `<div class="form-error">${esc(m)}</div>`); };
  box.querySelector('#aiPreContinue').onclick = () => {
    const skip = new Set(); const merges = []; const links = []; box.querySelectorAll('[data-preskip]:checked').forEach((x) => skip.add(Number(x.dataset.preskip)));
    for (let i = 0; i < qs.length; i += 1) { const q = qs[i]; const v = box.querySelector(`input[name="preq${i}"]:checked`); if (!v) return err('ענו על כל השאלות לפני ההמשך.');
      if (v.value === 'omit') { skip.add(q.rows[0]); skip.add(q.rows[1]); } else if (v.value === 'dup') { const pick = {}; for (const c of q.compare.cols.filter((x) => x.conflict)) { const pv = box.querySelector(`input[name="prepick${i}_${c.col}"]:checked`); if (!pv) return err(`בחרו ערך אחד בעמודה "${c.header}" לפני ההמשך.`); pick[c.col] = pv.value; } merges.push({ keep: q.rows[0], drop: q.rows[1], pick }); } else links.push({ rows: [q.rows[0], q.rows[1]], relation: v.value === 'sameplace' ? 'same_place' : 'different' }); }
    for (const m of merges) if (skip.has(m.keep) || skip.has(m.drop)) return err('אותה שורה נבחרה לכמה פעולות. בדקו את הבחירות.');
    goLocal({ skip: [...skip].sort((a, b) => a - b), merges, links });
  };
  box.querySelector('#aiPreCancel').onclick = () => { aiPre = null; renderAi(); };
};
const renderAi = (pending = false) => {
  if (aiModelPending && (aiModelPending.mode !== aiMode || aiModelPending.owner !== aiPreOwner() || !state.user)) aiModelPending = null;
  if (aiPre && (aiPre.mode !== aiMode || aiPre.owner !== aiPreOwner() || !state.user)) aiPre = null;
  const first = String(state.user.name || '').split(' ')[0];
  const empty = `<div class="ai-empty"><span class="ai-spark">${AI_SPARK}</span><h2>שלום ${esc(first)}, במה לעזור?</h2><p>כתבו בחופשיות, בעברית. אפשר גם להתחיל מאחד הרעיונות:</p><div class="ai-ideas">${AI_IDEAS.map((t) => `<button type="button" class="ai-idea" data-idea="${esc(t)}">${esc(t)}</button>`).join('')}</div></div>`;
  const proposalHtml = (m) => `${m.text ? `<p>${esc(m.text)}</p>` : ''}${coverageHtml(m.proposal.coverage)}${fileReviewHtml(m.proposal.fileReview)}${m.proposal.actions.map((a, i) => { const d = describeAction(a, m.proposal.branches); const st = m.done?.[i]; if (st?.ok && st.payerFail) { d.head = 'הסניף נוצר'; d.lines = [`שם: ${a.fields?.name || ''}`, `גוף משלם: ${st.payerNow || 'לא נקשר'}`]; } return `<div class="ai-action ${st?.ok ? 'done' : ''}"><strong>${esc(d.head)}</strong>${d.lines.map((l) => `<div>${esc(l)}</div>`).join('')}${a.needsChoice && !st?.ok ? `<fieldset class="ai-choice"><legend>${a.domain === 'license' ? 'בחרו אישור' : a.domain === 'authority' ? 'בחרו גוף תשלום' : a.choiceField === 'agreementPayer' ? 'בחרו גוף תשלום' : a.choiceField === 'branchPayer' ? 'בחרו גוף משלם' : a.choiceField === 'amountScope' ? 'שינוי הסכום חל:' : 'בחרו סניף'}</legend>${a.candidates.map((c) => `<label class="check-row ai-cand"><input type="radio" name="bc-${aiChat.indexOf(m)}-${i}" value="${esc(c.id)}"> <span>${esc(c.name)}${c.detail ? `<small class="ai-diff">${esc(c.detail)}</small>` : ''}${a.type === 'delete_branch' && c.before ? `<small class="ai-diff">${esc(deleteBranchCounts(c.before))}</small>` : ''}${c.before && a.fields ? Object.entries(a.fields).map(([k, v]) => `<small class="ai-diff">${esc(BRANCH_FIELD[k] || k)} נוכחי: ${esc(iso(bval(k, c.before[k])))}</small><small class="ai-diff">${esc(BRANCH_FIELD[k] || k)} מוצע: ${esc(iso(bval(k, v)))}</small>`).join('') : ''}</span></label>`).join('')}</fieldset>${a.choiceField === 'amountScope' ? `<div class="ai-from" data-fromwrap="${aiChat.indexOf(m)}:${i}" hidden><label class="ai-pw">תאריך תחולה<input type="date" data-from="${aiChat.indexOf(m)}:${i}" value="${esc(a.effectiveFrom || '')}"></label></div>` : ''}` : ''}${a.needsNewUser && !st?.ok ? `<div class="ai-newuser"><label class="ai-pw">תפקיד<select data-nurole="${aiChat.indexOf(m)}:${i}"><option value="Manager" ${a.suggestedRole === 'Manager' ? 'selected' : ''}>מנהל סניף</option><option value="Admin" ${a.suggestedRole === 'Admin' ? 'selected' : ''}>מנהל חשבון</option></select></label><label class="ai-pw">סיסמה ראשונית למשתמש החדש<input type="password" autocomplete="new-password" data-nupass="${aiChat.indexOf(m)}:${i}"></label><label class="check-row"><input type="checkbox" data-nuai="${aiChat.indexOf(m)}:${i}"> לאפשר למשתמש להשתמש בעוזר ה-AI</label></div>` : ''}${a.sensitive && !st?.ok && !st?.dismissed ? `<label class="ai-pw">הסיסמה הנוכחית שלכם<input type="password" autocomplete="current-password" data-pass="${aiChat.indexOf(m)}:${i}"></label>` : ''}${st?.ok ? (st.stepDone ? '<span class="ai-state ok">הסניף נבחר. בחירת גוף התשלום בכרטיס הבא. לא נשמר דבר</span>' : st.payerFail ? (st.payerNow ? `<span class="ai-state err">הסניף נוצר, אבל הקישור לגוף המשלם שנבחר נכשל (הוא השתנה או נמחק מאז ההצעה). כרגע מקושר גוף משלם אחר: ${esc(st.payerNow)}. אל תיצרו את הסניף שוב. בדקו שזה הגוף הנכון.</span>` : '<span class="ai-state err">הסניף נוצר, אבל גוף המשלם לא נקשר אליו (הוא השתנה או נמחק מאז ההצעה). אל תיצרו את הסניף שוב. פתחו את הסניף וקשרו גוף משלם ידנית.</span>') : st.cleanup ? '<span class="ai-state ok">הסניף נמחק. ניקוי של אישורים או קבצים שנוצרו בזמן המחיקה ממתין ויושלם אוטומטית ברקע</span>' : st.pending ? '<span class="ai-state ok">הקישור לקובץ הוסר. מחיקת הקובץ מהאחסון עדיין ממתינה ולא הושלמה</span>' : '<span class="ai-state ok">בוצע</span>') : st?.dismissed ? '<span class="ai-state">בוטל, לא נשמר דבר</span>' : `${st?.error ? `<span class="ai-state err">${esc(st.error)}</span>` : ''}${a.type === 'create_agreement_step' ? `<button type="button" class="primary small-btn" data-aistep="${aiChat.indexOf(m)}:${i}">המשך לבחירת גוף התשלום (לא נשמר דבר)</button>` : `<button type="button" class="primary small-btn" data-confirm="${aiChat.indexOf(m)}:${i}">אישור ושמירה</button>`} <button type="button" class="secondary small-btn" data-dismiss="${aiChat.indexOf(m)}:${i}">ביטול</button>`}</div>`; }).join('')}${m.proposal.unclear ? `<p class="ai-unclear">לא ברור: ${esc(m.proposal.unclear)}</p>` : ''}${(m.proposal.rejected || []).length ? `<p class="ai-unclear">לא נכלל: ${esc(m.proposal.rejected.join(' · '))}</p>` : ''}${m.proposal.actions.length ? (m.proposal.actions.every((_, i) => m.done?.[i]?.ok) ? '' : m.proposal.actions.some((_, i) => m.done?.[i]?.ok) ? '<small>מה שאושר כבר נשמר. שינוי אחר לא נשמר עד שתאשרו אותו בנפרד.</small>' : '<small>שום דבר לא נשמר עד שתאשרו כל שינוי בנפרד.</small>') : ''}`;
  const msgs = aiChat.map((m) => `<div class="ai-row ${m.role}">${m.role === 'user' ? '' : `<span class="ai-avatar">${m.role === 'error' ? '!' : '✦'}</span>`}<div class="ai-msg ${m.role}">${m.proposal ? proposalHtml(m) : esc(m.text)}${(m.files || []).length ? `<div class="ai-files">${m.files.map((f) => `<button type="button" class="secondary small-btn" data-openlic="${esc(f.id)}">פתיחת הקובץ: ${esc(f.label)}</button>`).join('')}</div>` : ''}${m.csv ? `<div class="ai-files"><button type="button" class="secondary small-btn" data-aicsv="${aiChat.indexOf(m)}">ייצוא הרשימה המוצגת ל-CSV (${m.csv.rows.length} שורות)</button></div>` : ''}${m.exportAll ? `<div class="ai-files"><button type="button" class="secondary small-btn" data-aiexportall="${aiChat.indexOf(m)}">${m.exportAll.noun === 'אישורים' ? (m.exportAll.total > 500 ? `ייצוא 500 הראשונים מתוך ${m.exportAll.total} אישורים ל-CSV (קטוע)` : `ייצוא כל ${m.exportAll.total} האישורים בסינון ל-CSV`) : (m.exportAll.total > 500 ? `ייצוא 500 הראשונים מתוך ${m.exportAll.total} משתמשים ל-CSV (קטוע, בלי אימיילים)` : `ייצוא כל ${m.exportAll.total} המשתמשים ל-CSV (בלי אימיילים)`)}</button></div>` : ''}</div></div>`).join('');
  const typing = pending ? '<div class="ai-row assistant"><span class="ai-avatar">✦</span><div class="ai-msg assistant ai-typing" aria-label="העוזר כותב"><i></i><i></i><i></i></div></div>' : '';
  app.innerHTML = `<section class="ai-page"><div class="ai-log" id="aiLog" aria-live="polite">${aiChat.length || pending ? msgs + typing : empty}</div><div class="ai-modes" role="tablist"><button type="button" data-aimode="chat" class="${aiMode === 'chat' ? 'on' : ''}">שיחה</button><button type="button" data-aimode="tasks" class="${aiMode === 'tasks' ? 'on' : ''}">משימות</button><button type="button" data-aimode="reports" class="${aiMode === 'reports' ? 'on' : ''}">דוחות</button>${state.user && state.user.role === 'Admin' ? `<button type="button" data-aimode="rent" class="${aiMode === 'rent' ? 'on' : ''}">שכירות</button><button type="button" data-aimode="agreements" class="${aiMode === 'agreements' ? 'on' : ''}">הסכמים</button><button type="button" data-aimode="branches" class="${aiMode === 'branches' ? 'on' : ''}">סניפים</button><button type="button" data-aimode="groups" class="${aiMode === 'groups' ? 'on' : ''}">תשלום מרוכז</button><button type="button" data-aimode="notifications" class="${aiMode === 'notifications' ? 'on' : ''}">התראות</button><button type="button" data-aimode="licenses" class="${aiMode === 'licenses' ? 'on' : ''}">אישורים</button><button type="button" data-aimode="authorities" class="${aiMode === 'authorities' ? 'on' : ''}">רשויות</button><button type="button" data-aimode="team" class="${aiMode === 'team' ? 'on' : ''}">צוות</button>` : ''}</div><form id="aiForm" class="ai-composer"><textarea name="prompt" rows="1" maxlength="20000" placeholder="${aiMode === 'tasks' ? 'לדוגמה: סגור את משימת התשלום לספק' : 'כתבו כאן...'}" aria-label="הודעה לעוזר" required ${pending ? 'disabled' : ''}></textarea><button class="ai-send" id="aiSend" aria-label="שליחה" ${pending ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button></form><p class="ai-note">${aiMode === 'agreements' ? 'במצב הסכמים העוזר מציע עדכון סכום, תדירות, אמצעי תשלום או תאריך ראשון, או סגירת הסכם. זה רישום במערכת בלבד, לא תשלום. כל שינוי דורש את הסיסמה שלכם.' : aiMode === 'groups' ? 'במצב תשלום מרוכז העוזר מציע איגוד תשלומים ממתינים של אותה רשות לתשלום אחד, או שינוי מצב שלו. זה רישום במערכת בלבד. שינוי מצב דורש את הסיסמה שלכם.' : aiMode === 'notifications' ? 'במצב התראות העוזר מציע שינוי מצב טיפול בהתראות קיימות (פתוחה, בטיפול, טופלה, נדחתה). אפשר לשנות בחזרה.' : aiMode === 'licenses' ? 'במצב אישורים העוזר מציע הוספת סוג אישור, הסרת סוג, העברת אישור לארכיון או מחיקת הקובץ המצורף בלבד. כל פעולה מחיקה דורשת את הסיסמה שלכם.' : aiMode === 'authorities' ? 'במצב רשויות העוזר מציע הוספת גוף תשלום או מחיקתו. מחיקה דורשת את הסיסמה שלכם, ולא ניתן למחוק גוף עם הסכם פעיל.' : aiMode === 'team' ? 'במצב צוות העוזר מציע הוספת משתמש (שם, דוא״ל, סניפים). התפקיד, הרשאת ה-AI והסיסמה הראשונית נקבעים על ידכם בכרטיס, העוזר לא רואה אותם, והאישור דורש את הסיסמה שלכם.' : aiMode === 'branches' ? 'במצב סניפים העוזר מציע פתיחה או עדכון של פרטי סניף (שם, כתובת, מנהל, טלפון). אין מחיקה. שם שכבר קיים נחסם, ואתם מאשרים כל שינוי.' : aiMode === 'reports' ? 'במצב דוחות העוזר רק בוחר דוח קריאה מרשימה קבועה. השרת מריץ אותו על מה שמותר לכם לראות. העוזר לא רואה את הנתונים ולא משנה דבר.' : aiMode === 'rent' ? 'במצב שכירות העוזר רואה רק תשלומי שכירות שלא שובצו לתשלום מרוכז. הוא מציע רישום סטטוס בלבד, ואתם מאשרים. אין כאן ביצוע תשלום.' : aiMode === 'tasks' ? 'במצב משימות העוזר רואה רק את המשימות הפתוחות שלכם ואת הסניפים שלכם. הוא מציע שינוי, ואתם מאשרים אותו לפני שמירה.' : 'במצב שיחה העוזר לא רואה את נתוני המערכת, והוא לא משנה שום דבר בעצמו.'}</p></section>`;
  const form = document.getElementById('aiForm'); const box = form.elements.prompt;
  const log = document.getElementById('aiLog'); log.scrollTop = log.scrollHeight;
  if (aiMode === 'branches') {
    // File update: CSV is read by the server with no AI; a PDF or image is read by Claude. Branch matching is done by the server.
    const panel = document.createElement('div'); panel.className = 'ai-doc'; panel.id = 'aiBranchFilePanel';
    panel.innerHTML = '<strong>עדכון סניפים מקובץ</strong><label class="secondary ai-doc-pick" for="aiBranchFile"><span>בחירת קובץ: <bdi dir="ltr">Excel, Word, CSV, PDF</bdi> או תמונה</span></label><input type="file" id="aiBranchFile" class="ai-doc-input" accept=".xlsx,.docx,.csv,.tsv,.txt,application/pdf,image/jpeg,image/png,image/webp"><small class="muted">קובץ <bdi dir="ltr">Excel</bdi>, <bdi dir="ltr">Word</bdi> (הטבלה הראשונה, בלי תאים ממוזגים) או <bdi dir="ltr">CSV</bdi> נקרא בשרת בלי AI. מ-Excel נקרא הגיליון הראשון בלבד, בלי מאקרו. <bdi dir="ltr">PDF</bdi> או תמונה נשלחים ל-<bdi dir="ltr">Claude</bdi> לקריאה. הקובץ עצמו לא נשמר. לכל סניף יוצג כרטיס עם לפני ואחרי, ושום דבר לא נשמר בלי אישור.</small>';
    form.parentElement.insertBefore(panel, form);
    const fin = panel.querySelector('#aiBranchFile');
    const sendFile = async (file, consent) => { aiBranchPending = null; aiChat.push({ role: 'user', text: `קובץ: ${file.name}` }); try { const fd = new FormData(); fd.append('file', file); if (consent) fd.append('consentExternal', 'true'); const r = await api('/api/ai/branches/file-propose', { method: 'POST', body: fd }); aiChat.push({ role: 'assistant', text: r.summary || '', proposal: r, done: {} }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } renderAi(); };
    // CSV/text is read by our server only. PDF/image leaves the system, so it needs an explicit send approval BEFORE upload.
    fin.onchange = () => { const file = fin.files[0]; if (!file) return; if (/\.(xlsx|docx|csv|tsv|txt)$/i.test(file.name)) return aiPreStart(file, '/api/ai/branches/file-propose', 'branches'); if (!(['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type))) { aiChat.push({ role: 'user', text: `קובץ: ${file.name}` }, { role: 'assistant', text: 'סוג הקובץ הזה לא נתמך. אפשר להעלות Excel (xlsx), Word (docx) עם טבלה, CSV, PDF או תמונה. קבצי xls או doc ישנים: שמרו כ-xlsx או docx והעלו שוב.' }); return renderAi(); } aiBranchPending = file; renderAi(); };
    if (aiPre && aiPre.mode === 'branches') aiPreCard(panel, aiPre.endpoint);
    if (aiBranchPending) {
      const gate = document.createElement('div'); gate.className = 'ai-action'; gate.id = 'aiBranchConsent';
      gate.innerHTML = `<strong>שליחת הקובץ לקריאה חיצונית</strong><div><bdi dir="ltr">${esc(aiBranchPending.name)}</bdi></div><div>תוכן הקובץ יישלח ל-Claude (Anthropic) כדי לקרוא ממנו את הטבלה. שלחו רק קובץ שמותר לשלוח. הקובץ לא נשמר במערכת, ושום דבר לא ישונה בלי אישור לכל כרטיס.</div><button type="button" class="primary small-btn" id="aiBranchConsentYes">שליחה לקריאה</button> <button type="button" class="secondary small-btn" id="aiBranchConsentNo">ביטול</button>`;
      panel.appendChild(gate);
      gate.querySelector('#aiBranchConsentYes').onclick = () => sendFile(aiBranchPending, true);
      gate.querySelector('#aiBranchConsentNo').onclick = () => { aiBranchPending = null; renderAi(); };
    }
  }
  if (aiMode !== 'branches' && aiMode !== 'agreements') {
    // Attachments outside the branch-file and agreement-document flows: nothing is uploaded or read here. The user gets a clear answer instead of silence.
    const ap = document.createElement('div'); ap.className = 'ai-doc'; ap.id = 'aiAttachPanel';
    ap.innerHTML = `<label class="secondary ai-doc-pick" for="aiAttachFile"><span>צירוף קובץ</span></label><input type="file" id="aiAttachFile" class="ai-doc-input" accept=".xlsx,.docx,.csv,.tsv,.txt,application/pdf,image/jpeg,image/png,image/webp"><small class="muted">${aiMode === 'tasks' || aiMode === 'team' || aiMode === 'licenses' ? `בלשונית ${aiMode === 'team' ? 'צוות' : aiMode === 'licenses' ? 'אישורים (יצירת אישורים בלי קובץ מצורף)' : 'משימות'} נקראים קבצי אקסל, וורד עם טבלה או CSV בשרת בלי AI, וכל שורה דורשת אישור. PDF או תמונה נשלחים ל-Claude רק אחרי אישור מפורש (עד 20 שורות), וכל שורה עוברת בדיקה בשרת.` : 'הקובץ לא נשלח ולא נקרא בלשונית הזו.'}</small>`;
    form.parentElement.insertBefore(ap, form);
    if (aiPre && aiPre.mode === aiMode) aiPreCard(ap, aiPre.endpoint);
    if (aiModelPending && (aiMode === 'tasks' || aiMode === 'team' || aiMode === 'licenses')) {
      const gate = document.createElement('div'); gate.className = 'ai-action'; gate.id = 'aiModelConsent'; const ep = aiModelPending.endpoint;
      gate.innerHTML = `<strong>שליחת הקובץ לקריאה חיצונית</strong><div><bdi dir="ltr">${esc(aiModelPending.file.name)}</bdi></div><div>תוכן ה-PDF או התמונה יישלח ל-Claude (Anthropic) כדי לקרוא ממנו שורות. שלחו רק קובץ שמותר לשלוח. הקובץ לא נשמר. מעובדות ומוצגות עד 20 שורות מהמסמך. שורות נוספות לא יובאו, וההודעה אחרי הקריאה תציין את הכיסוי. כל שורה עוברת בדיקה בשרת ודורשת אישור בנפרד.</div><label><input type="checkbox" id="aiModelConsentChk"> אני מאשר/ת את שליחת הקובץ</label> <button type="button" class="primary small-btn" id="aiModelConsentYes" disabled>שליחה לקריאה</button> <button type="button" class="secondary small-btn" id="aiModelConsentNo">ביטול</button>`;
      ap.appendChild(gate); const chk = gate.querySelector('#aiModelConsentChk'); const yes = gate.querySelector('#aiModelConsentYes'); chk.onchange = () => { yes.disabled = !chk.checked; };
      yes.onclick = async () => { if (!chk.checked) return; const pend = aiModelPending; const file = pend.file; aiModelPending = null; aiChat.push({ role: 'user', text: `קובץ: ${file.name}` }); try { const fd = new FormData(); fd.append('file', file); fd.append('consentExternal', 'true'); const r = await api(ep, { method: 'POST', body: fd }); aiChat.push({ role: 'assistant', text: r.summary || '', proposal: r, done: {} }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } renderAi(); };
      gate.querySelector('#aiModelConsentNo').onclick = () => { aiModelPending = null; renderAi(); };
    }
    ap.querySelector('#aiAttachFile').onchange = async (ev) => { const file = ev.target.files[0]; if (!file) return; if ((aiMode === 'tasks' || aiMode === 'team' || aiMode === 'licenses') && ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { aiModelPending = { file, mode: aiMode, owner: aiPreOwner(), endpoint: aiMode === 'team' ? '/api/ai/team/file-propose' : aiMode === 'licenses' ? '/api/ai/licenses/file-propose' : '/api/ai/tasks/file-propose' }; return renderAi(); } if ((aiMode === 'tasks' || aiMode === 'team' || aiMode === 'licenses') && /\.(xlsx|docx|csv|tsv|txt)$/i.test(file.name)) return aiPreStart(file, aiMode === 'team' ? '/api/ai/team/file-propose' : aiMode === 'licenses' ? '/api/ai/licenses/file-propose' : '/api/ai/tasks/file-propose', aiMode); if ((aiMode === 'tasks' || aiMode === 'team' || aiMode === 'licenses') && /\.(xlsx|docx|csv|tsv|txt)$/i.test(file.name)) { aiChat.push({ role: 'user', text: `קובץ: ${file.name}` }); try { const fd = new FormData(); fd.append('file', file); const r = await api(aiMode === 'team' ? '/api/ai/team/file-propose' : aiMode === 'licenses' ? '/api/ai/licenses/file-propose' : '/api/ai/tasks/file-propose', { method: 'POST', body: fd }); aiChat.push({ role: 'assistant', text: r.summary || '', proposal: r, done: {} }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } return renderAi(); } const ok = /\.(xlsx|docx|csv|tsv|txt|pdf|jpe?g|png|webp)$/i.test(file.name); aiChat.push({ role: 'user', text: `קובץ: ${file.name}` }, { role: 'assistant', text: ok ? 'הקובץ לא נשלח ולא נקרא. בלשונית הזו אין קריאת קבצים. עדכון סניפים מקובץ אקסל, קובץ וורד עם טבלה, קובץ CSV, PDF או תמונה אפשרי בלשונית סניפים. העלאת מסמך להסכם שכירות אפשרית בלשונית הסכמים. כתבו את הבקשה כטקסט, או עברו ללשונית המתאימה.' : 'סוג הקובץ הזה לא נתמך, והוא לא נשלח ולא נקרא. קבצים נתמכים בלשוניות סניפים והסכמים: אקסל חדש, וורד חדש עם טבלה, CSV, PDF או תמונה. קבצי אקסל או וורד ישנים: שמרו בפורמט החדש והעלו שוב שם.' }); renderAi(); };
  }
  if (aiMode === 'agreements') {
    // Document intake: no AI reading. The user picks the destination agreement explicitly; the file is saved only after confirm.
    const panel = document.createElement('div'); panel.className = 'ai-doc'; panel.id = 'aiDocPanel';
    const d = aiDoc;
    const sizeKb = (n) => `${Math.max(1, Math.round(n / 1024))}KB`;
    panel.innerHTML = !d ? `<strong>העלאת מסמך להסכם שכירות</strong><label class="secondary ai-doc-pick" for="aiDocFile">בחירת קובץ (PDF או תמונה)</label><input type="file" id="aiDocFile" class="ai-doc-input" accept="application/pdf,image/jpeg,image/png,image/webp"><small class="muted">המסמך לא נשלח ל-AI. תבחרו בעצמכם לאיזה הסכם לשמור אותו, והוא נשמר רק אחרי אישור.</small>`
      : d.done ? `<div class="ai-action done"><strong>המסמך נשמר</strong><div><bdi dir="ltr">${esc(d.p.fileName)}</bdi> · ${esc(d.doneTo || '')}</div><button type="button" class="secondary small-btn" id="aiDocNext">העלאת מסמך נוסף</button></div>`
      : `<div class="ai-action"><strong>שמירת מסמך: <bdi dir="ltr">${esc(d.p.fileName)}</bdi> (${sizeKb(d.p.size)})</strong><fieldset class="ai-choice"><legend>בחרו הסכם שאליו לשמור</legend>${d.p.candidates.map((c) => `<label class="check-row"><input type="radio" name="docdest" value="${esc(c.id)}"${c.preferred ? ' checked' : ''}> ${esc(c.branchName)} · ${esc(c.authorityName)}${c.detail ? `<small class="muted" style="display:block">${esc(c.detail)}</small>` : ''}${c.preferred ? ' (ההסכם שנוצר עכשיו בשיחה)' : ''}${c.suggested ? ' (שם הקובץ מתאים, ודאו בעצמכם)' : ''}${c.sameName ? ' · כבר קיים מסמך בשם הזה' : ''}${c.identical ? ' · כבר מצורף קובץ זהה בתוכן' : ''}${!c.identical && c.identicalUnchecked ? ' · חלק מהקבצים הקיימים בהסכם לא נבדקו להשוואת תוכן, ייתכן שקובץ זהה כבר מצורף' : ''}</label>`).join('')}</fieldset>${d.err ? `<div class="form-error">${esc(d.err)}</div>` : ''}<button type="button" class="primary" id="aiDocConfirm" ${d.busy ? 'disabled' : ''}>אישור ושמירה</button> <button type="button" class="secondary" id="aiDocCancel">ביטול</button><small class="muted">שום דבר לא נשמר עד שתאשרו. המסמך נשמר רק בהסכם שבחרתם.</small></div>`;
    const existing = document.createElement('div'); existing.className = 'ai-doc'; existing.id = 'aiDocExisting';
    existing.innerHTML = aiDocList ? (aiDocList.length ? aiDocList.map((ag) => `<div class="ai-action"><strong>${esc(ag.branchId?.name || 'סניף')} · ${esc(ag.authorityId?.name || '')}</strong>${(ag.documents || []).length ? ag.documents.map((dc) => `<div class="ai-doc-row"><bdi dir="ltr">${esc(dc.fileName || 'ללא שם')}</bdi> <button type="button" class="secondary small-btn" data-docopen="${esc(ag._id)}:${esc(dc._id)}">הורדה</button> <button type="button" class="secondary small-btn" data-docdel="${esc(ag._id)}:${esc(dc._id)}">מחיקה</button></div>`).join('') : '<small class="muted">אין מסמכים</small>'}</div>`).join('') : '<small class="muted">אין הסכמים</small>') : '<button type="button" class="secondary" id="aiDocShow">מסמכים קיימים (הורדה או מחיקה)</button>';
    panel.appendChild(existing);
    form.parentElement.insertBefore(panel, form);
    const fileIn = panel.querySelector('#aiDocFile');
    if (fileIn) fileIn.onchange = async () => { const file = fileIn.files[0]; if (!file) return; try { const fd = new FormData(); fd.append('file', file); if (aiPreferAgreement) fd.append('prefer', aiPreferAgreement); const r = await api('/api/ai/agreements/document/propose', { method: 'POST', body: fd }); aiDoc = { file, p: r }; } catch (error) { toast(error.message); } renderAi(); };
    const show = panel.querySelector('#aiDocShow'); if (show) show.onclick = async () => { try { const r = await api('/api/rent/summary'); aiDocList = (r.agreements || []).filter((x) => x.status !== 'Closed' || (x.documents || []).length); } catch (error) { toast(error.message); } renderAi(); };
    panel.querySelectorAll('[data-docopen]').forEach((b2) => b2.onclick = () => { const [x, y] = b2.dataset.docopen.split(':'); openRentDoc(x, y); });
    panel.querySelectorAll('[data-docdel]').forEach((b2) => b2.onclick = async () => { const [x, y] = b2.dataset.docdel.split(':'); try { const r = await api('/api/ai/agreements/document/delete-propose', { method: 'POST', body: JSON.stringify({ agreementId: x, docId: y }) }); aiChat.push({ role: 'assistant', text: 'בדקו לפני אישור:', proposal: r, done: {} }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } renderAi(); });
    const nextDoc = panel.querySelector('#aiDocNext'); if (nextDoc) nextDoc.onclick = () => { aiDoc = null; renderAi(); };
    const cancel = panel.querySelector('#aiDocCancel'); if (cancel) cancel.onclick = () => { aiDoc = null; renderAi(); };
    const ok = panel.querySelector('#aiDocConfirm');
    if (ok) ok.onclick = async () => {
      const choice = panel.querySelector('input[name="docdest"]:checked')?.value; if (!choice) { aiDoc.err = 'בחרו את ההסכם שאליו לשמור את המסמך'; return renderAi(); }
      aiDoc.busy = true; aiDoc.err = ''; renderAi();
      try { const fd = new FormData(); fd.append('file', aiDoc.file); fd.append('agreementId', choice); await api(`/api/ai/agreements/document/${aiDoc.p.proposalId}/confirm`, { method: 'POST', body: fd }); aiPreferAgreement = ''; const c = aiDoc.p.candidates.find((x) => x.id === choice); aiDoc.done = true; aiDoc.doneTo = c ? `${c.branchName} · ${c.authorityName}` : ''; }
      catch (error) { aiDoc.err = error.message; } aiDoc.busy = false; renderAi();
    };
  }
  const send = async (text) => {
    const prompt = text.trim(); if (!prompt) return;
    aiChat.push({ role: 'user', text: prompt }); renderAi(true);
    try {
      if (aiMode === 'tasks' || aiMode === 'rent' || aiMode === 'branches' || aiMode === 'team' || aiMode === 'agreements' || aiMode === 'authorities' || aiMode === 'licenses' || aiMode === 'notifications' || aiMode === 'groups') { const r = await api(aiMode === 'groups' ? '/api/ai/payment-groups/propose' : aiMode === 'notifications' ? '/api/ai/notifications/propose' : aiMode === 'licenses' ? '/api/ai/licenses/propose' : aiMode === 'authorities' ? '/api/ai/authorities/propose' : aiMode === 'rent' ? '/api/ai/rent/propose' : aiMode === 'agreements' ? '/api/ai/agreements/propose' : aiMode === 'team' ? '/api/ai/team/propose' : aiMode === 'branches' ? '/api/ai/branches/propose' : '/api/ai/tasks/propose', { method: 'POST', body: JSON.stringify({ prompt }) }); aiChat.push({ role: 'assistant', text: r.summary || (r.actions.length ? '' : 'לא נמצאה פעולה מתאימה.'), proposal: r, done: {} }); }
      else if (aiMode === 'reports') { const r = await api('/api/ai/reports/ask', { method: 'POST', body: JSON.stringify({ prompt }) }); const line = (x) => Object.entries(x).filter(([k, v]) => k !== 'fileLicenseId' && v).map(([, v]) => v).join(' · '); aiChat.push({ role: 'assistant', files: (r.rows || []).filter((x) => x.fileLicenseId).map((x) => ({ id: x.fileLicenseId, label: [x.branch, x.type].filter(Boolean).join(' · ') })), csv: r.report && r.count ? { rows: r.rows, title: r.title } : null, exportAll: r.report === 'team_overview' && state.user?.role === 'Admin' && r.total > r.count ? { params: r.exportParams || {}, total: r.total, endpoint: '/api/ai/reports/export-team', noun: 'משתמשים' } : (['licenses_all', 'licenses_history', 'licenses_no_file', 'licenses_expiring', 'licenses_expired'].includes(r.report) && r.total > r.count && r.exportParams ? { params: r.exportParams, total: r.total, endpoint: '/api/ai/reports/export-licenses', noun: 'אישורים' } : null), text: r.report ? `${r.title}${r.days ? ` (${r.days} ימים)` : ''}${r.note ? `\nהערה: ${r.note}` : ''}${(r.filters || []).length ? `\nסינון: ${r.filters.join(' · ')}` : ''}${r.branchFilter ? `\nסינון לפי סניף: ${r.branchFilter}` : ''}${r.typeFilter ? `\nסינון לפי סוג אישור: ${r.typeFilter}` : ''}${r.count ? `\nמספר שורות בדוח: ${r.count}${r.total > r.count ? ` (מוצגות ${r.count} מתוך ${r.total}, הדוח מוגבל ל-${r.count} שורות)` : ''}\n` + r.rows.map((x) => '• ' + line(x)).join('\n') : '\nלא נמצאו נתונים בדוח הזה.'}` : r.message }); }
      else { const r = await api('/api/ai/ask', { method: 'POST', body: JSON.stringify({ prompt }) }); aiChat.push({ role: 'assistant', text: r.text + (r.truncated ? '\n\n(התשובה נקטעה)' : '') }); }
    }
    catch (error) { aiChat.push({ role: 'error', text: error.message }); }
    renderAi();
  };
  form.onsubmit = (e) => { e.preventDefault(); send(box.value); };
  box.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true })); } };
  box.oninput = () => { box.style.height = 'auto'; box.style.height = Math.min(box.scrollHeight, 140) + 'px'; };
  app.querySelectorAll('[data-aimode]').forEach((b2) => b2.onclick = () => { aiMode = b2.dataset.aimode; renderAi(); });
  app.querySelectorAll('[data-dismiss]').forEach((b2) => b2.onclick = () => { const [mi, ai] = b2.dataset.dismiss.split(':').map(Number); const m = aiChat[mi]; if (!m.done[ai]?.ok && !m.done[ai]?.busy) { m.done[ai] = { dismissed: true }; renderAi(); } });
  app.querySelectorAll('[data-openlic]').forEach((b2) => b2.onclick = () => openLicenseFile(b2.dataset.openlic));
  app.querySelectorAll('[data-aiexportall]').forEach((b3) => b3.onclick = async () => { const m = aiChat[Number(b3.dataset.aiexportall)]; if (!m?.exportAll) return; try { const r = await api(m.exportAll.endpoint, { method: 'POST', body: JSON.stringify(m.exportAll.params) }); exportRowsCsv({ rows: r.rows, title: m.csv?.title || (m.exportAll.noun === 'אישורים' ? 'אישורים' : 'צוות') }); aiChat.push({ role: 'assistant', text: r.capped ? `יוצאו ${r.count} ${m.exportAll.noun} מתוך ${r.total} (המגבלה ${r.cap}). צמצמו את הסינון כדי לייצא את השאר.` : `יוצאו כל ${r.count} ה${m.exportAll.noun === 'אישורים' ? 'אישורים' : 'משתמשים'} בסינון.` }); } catch (error) { aiChat.push({ role: 'error', text: error.message }); } renderAi(); });
  app.querySelectorAll('[data-aicsv]').forEach((b2) => b2.onclick = () => exportRowsCsv(aiChat[Number(b2.dataset.aicsv)]?.csv));
  app.querySelectorAll('[data-aistep]').forEach((b2) => b2.onclick = async () => { const [mi, ai] = b2.dataset.aistep.split(':').map(Number); const m = aiChat[mi]; if (m.done[ai]?.ok || m.done[ai]?.busy) return; const choice = app.querySelector(`input[name="bc-${mi}-${ai}"]:checked`)?.value || ''; if (!choice) { m.done[ai] = { error: 'בחרו את הסניף המדויק' }; renderAi(); return; } m.done[ai] = { busy: true }; b2.disabled = true; try { const r = await api(`/api/ai/agreements/step/${m.proposal.actions[ai].proposalId}`, { method: 'POST', body: JSON.stringify({ branchId: choice }) }); m.done[ai] = { ok: true, stepDone: true }; aiChat.push({ role: 'assistant', text: 'שלב 2 מתוך 2:', proposal: r, done: {} }); } catch (error) { m.done[ai] = { error: error.message }; } renderAi(); });
  app.querySelectorAll('[data-confirm]').forEach((b2) => b2.onclick = async () => { const [mi, ai] = b2.dataset.confirm.split(':').map(Number); const m = aiChat[mi]; if (m.done[ai]?.ok || m.done[ai]?.busy) return; m.done[ai] = { busy: true }; b2.disabled = true; try { const act = m.proposal.actions[ai]; const pw = act.sensitive ? (app.querySelector(`[data-pass="${mi}:${ai}"]`)?.value || '') : ''; if (act.sensitive && !pw) throw new Error('הקלידו את הסיסמה הנוכחית'); const choice = act.needsChoice ? (app.querySelector(`input[name="bc-${mi}-${ai}"]:checked`)?.value || '') : ''; if (act.needsChoice && !choice) throw new Error(act.choiceField === 'branchPayer' || act.choiceField === 'agreementPayer' ? 'בחרו את גוף המשלם המדויק' : act.choiceField === 'amountScope' ? 'בחרו אם השינוי חל למפרע או מכאן ולהבא' : 'בחרו את הסניף המדויק'); let extra; if (act.choiceField === 'amountScope' && choice === 'future') { const fv = app.querySelector(`[data-from="${mi}:${ai}"]`)?.value || ''; if (!fv) throw new Error('בחרו תאריך תחולה'); extra = { amountEffectiveFrom: fv }; } if (act.needsNewUser) { const q = (k) => app.querySelector(`[data-${k}="${mi}:${ai}"]`); const npw = q('nupass')?.value || ''; if (!npw) throw new Error('הקלידו סיסמה ראשונית למשתמש החדש'); extra = { newUserPassword: npw, newUserRole: q('nurole')?.value || 'Manager', newUserAiEnabled: Boolean(q('nuai')?.checked) }; } const rr = await runAction(act, pw, choice, extra); if (act.type === 'create_agreement' && rr?.result?.agreementId) aiPreferAgreement = String(rr.result.agreementId); m.done[ai] = { ok: true, payerFail: Boolean(rr?.result?.payerLinkFailed), payerNow: rr?.result?.persistedPayerName || '', pending: Boolean(rr?.result?.storagePending), cleanup: Number(rr?.result?.pendingCleanup || 0) }; await loadApp(); } catch (error) { m.done[ai] = { error: error.message }; } renderAi(); });
  app.querySelectorAll('input[type=radio][name^="bc-"]').forEach((r) => r.onchange = () => { const k = r.name.slice(3); const w = app.querySelector(`[data-fromwrap="${k.replace('-', ':')}"]`); if (w) w.hidden = r.value !== 'future'; });
  app.querySelectorAll('[data-idea]').forEach((b2) => b2.onclick = () => { box.value = b2.dataset.idea; box.focus(); });
  if (!pending) box.focus();
};
const render = () => { resetScrollOnViewChange(); renderHeader(); if (state.page === 'alerts') return renderAlerts(); if (state.page === 'tasks') return renderTasks(); if (state.page === 'rent') return renderRent(); if (state.page === 'ai' && state.user.aiEnabled) return renderAi(); if (state.page === 'settings') return renderSettings(); if (state.page === 'report') return renderReport(); if (state.branchId) return renderBranch(); return renderBranches(); };

// Completeness of a daycare branch = the approvals it should hold (every
// active type defined for all branches plus types defined for this branch)
// versus what is actually uploaded. An approval within 30 days of expiry
// still counts as present; an expired approval counts as needing action and
// is called out separately from one that was never uploaded.
const expectedTypesFor = (branchId) => state.types.filter((t) => !t.branchId || String(t.branchId?._id || t.branchId) === String(branchId));
const branchLicenseFor = (branchId, typeId) => state.licenses.find((l) => String(l.branchId?._id || l.branchId) === String(branchId) && String(l.licenseTypeId?._id || l.licenseTypeId) === String(typeId));
const branchCompleteness = (branch) => {
  const c = computeCompleteness(expectedTypesFor(branch._id), state.licenses.filter((l) => String(l.branchId?._id || l.branchId) === String(branch._id)));
  return { total: c.total, missing: c.missing, expired: c.expired };
};
const completenessPill = ({ total, missing, expired }) => {
  if (!total) return '';
  if (!missing && !expired) return '<span class="complete-pill good">✓ כל האישורים קיימים</span>';
  const parts = [];
  if (missing) parts.push(missing === 1 ? 'חסר אישור 1' : `חסרים ${missing} אישורים`);
  if (expired) parts.push(expired === 1 ? 'אישור 1 פג תוקף' : `${expired} אישורים פגו תוקף`);
  return `<span class="complete-pill danger">! ${parts.join(' · ')}</span>`;
};
const contactLine = (branch) => [branch.managerName, branch.phone, (branch.emails || []).join(', ')].filter(Boolean).join(' · ');

const renderBranches = () => {
  // Only daycare branches carry permits; rented properties (offices) live in
  // the rent module and never appear here.
  const daycares = state.branches.filter((b) => b.kind !== 'property');
  const alerts = currentAlerts();
  const overdue = state.licenses.filter((l) => l.status === 'Expired').length;
  const soon = state.licenses.filter((l) => l.status === 'Expiring_Soon').length;
  const needCare = soon + overdue + alerts.length;
  const openTaskList = state.tasks.filter((task) => task.status !== 'Done').sort((a, b) => new Date(a.dueDate || '2999-01-01') - new Date(b.dueDate || '2999-01-01')).slice(0, 4);
  const taskPanel = `<section class="panel dash-tasks"><div class="section-heading"><div><h3>משימות</h3></div><button class="go go-fwd" id="dashTasksAll" type="button"><span>לכל המשימות</span><i class="go-chip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></i></button></div>${openTaskList.length ? openTaskList.map((task) => `<div class="dash-task" data-go-tasks role="button" tabindex="0"><i class="dash-check" aria-hidden="true"></i><div><b>${esc(task.title)}</b>${task.dueDate ? `<small>עד ${esc(new Date(task.dueDate).toLocaleDateString('he-IL'))}</small>` : ''}</div></div>`).join('') : '<p class="muted">אין משימות פתוחות.</p>'}</section>`;
  app.innerHTML = `<div class="dash"><section class="welcome-row dash-hero"><div><div class="eyebrow">שלום ${esc(state.user.name)}</div><h2>${needCare ? 'הכל תחת שליטה.<br>כמעט.' : 'הכל תחת שליטה.'}</h2><p>${needCare ? `${[soon ? `${soon} אישורים לקראת פקיעה` : '', overdue ? `${overdue} אישורים פגי תוקף` : '', alerts.length ? `${alerts.length} התראות לטיפול` : ''].filter(Boolean).join(' · ')}. השאר מסודר ומעודכן.` : 'כל האישורים מסודרים ומעודכנים.'}</p><div class="hero-actions">${alerts.length ? '<button id="heroAlerts" class="primary">טיפול בהתראות</button>' : ''}${state.user.role === 'Admin' ? '<button id="newBranch" class="secondary">＋ הוספת סניף</button>' : ''}</div></div></section><section class="stats-grid dash-stats"><article class="stat-card clickable" data-card-filter="" role="button" tabindex="0" aria-pressed="${state.cardFilter === null}" title="הצגת כל הסניפים"><span class="stat-icon teal">⌂</span><div><strong>${daycares.length}</strong><small>סניפים</small></div></article><article class="stat-card clickable" id="alertsSummary"><span class="stat-icon blue">♧</span><div><strong>${alerts.length}</strong><small>התראות לטיפול</small></div></article><article class="stat-card clickable${state.cardFilter === 'expired' ? ' selected' : ''}" data-card-filter="expired" role="button" tabindex="0" aria-pressed="${state.cardFilter === 'expired'}" title="הצגת סניפים עם אישורים שפג תוקפם"><span class="stat-icon coral">!</span><div><strong>${overdue}</strong><small>אישורים שפג תוקפם</small></div></article><article class="stat-card clickable${state.cardFilter === 'expiring' ? ' selected' : ''}" data-card-filter="expiring" role="button" tabindex="0" aria-pressed="${state.cardFilter === 'expiring'}" title="הצגת סניפים עם אישורים לקראת פקיעה"><span class="stat-icon amber">◷</span><div><strong>${soon}</strong><small>אישורים לקראת פקיעה</small></div></article></section><section class="panel dash-branches"><section class="section-heading"><div><h3>הסניפים שלך</h3><p>בחרו סניף כדי לראות את כל האישורים וההיסטוריה שלו · אישור לקראת פקיעה נספר כקיים בסימון השלמות</p></div><span class="muted">${daycares.length} סניפים</span></section>${daycares.length ? '<div class="search-row"><input type="search" class="search-input" id="branchSearch" placeholder="חיפוש סניף לפי שם או כתובת" aria-label="חיפוש סניף"></div>' : ''}<section class="branch-grid" id="branchGrid">${daycares.length ? daycares.map((branch) => { const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id); const expiring = licenses.filter((l) => l.status === 'Expiring_Soon').length; const expiredCount = licenses.filter((l) => l.status === 'Expired').length; return `<article class="branch-card" data-branch="${branch._id}" data-search="${esc((branch.name || '') + ' ' + (branch.address || ''))}" role="button" tabindex="0" aria-label="${esc(branch.name)}"><div class="branch-card-top"><span class="branch-symbol">${esc([...(branch.name || '⌂')][0])}</span><span class="branch-card-actions">${state.user.role === 'Admin' ? `<button class="icon-button branch-delete" data-delete-branch="${branch._id}" title="מחיקת סניף" aria-label="מחיקת ${esc(branch.name)}">🗑</button>` : ''}<span class="arrow go-chip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></span></span></div><h3>${esc(branch.name)}</h3><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p>${branch.managerName ? `<p class="muted small-text">מנהלת: ${esc(branch.managerName)}${branch.phone ? ` · ${esc(branch.phone)}` : ''}</p>` : ''}<div class="branch-card-bottom"><span>${licenses.length} אישורים</span><span class="branch-signals">${expiredCount ? `<i class="dot danger"></i>${expiredCount} פגו` : ''}${expiring ? `<i class="dot warning"></i>${expiring} לקראת פקיעה` : ''}${(() => { const k = expiryAllClear({ expiredCount, expiring, completeness: branchCompleteness(branch) }); return k === 'good' ? '<i class="dot good"></i>הכול תקין' : k === 'neutral' ? '<i class="dot neutral"></i>אין פקיעות קרובות' : ''; })()}</span></div>${branchCompleteness(branch).total ? `<div class="complete-row">${completenessPill(branchCompleteness(branch))}</div>` : ''}</article>`; }).join('') : `<div class="empty-state"><span>⌂</span><h3>עוד אין סניפים</h3><p>הוסיפו את הסניף הראשון כדי להתחיל לנהל את האישורים שלו.</p></div>`}</section><div class="empty-state" id="noBranchMatches" hidden><span>⌂</span><h3>לא נמצאו סניפים תואמים</h3><p>נסו לשנות את מילות החיפוש.</p></div></section>${taskPanel}</div>`;
  document.getElementById('alertsSummary').onclick = () => { state.page = 'alerts'; render(); };
  const heroAlerts = document.getElementById('heroAlerts'); if (heroAlerts) heroAlerts.onclick = () => { state.page = 'alerts'; render(); };
  const goTasks = () => { state.page = 'tasks'; render(); };
  document.getElementById('dashTasksAll')?.addEventListener('click', goTasks);
  app.querySelectorAll('[data-go-tasks]').forEach((n) => { n.onclick = goTasks; n.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTasks(); } }; });
  app.querySelectorAll('[data-branch]').forEach((node) => {
    const openBranch = () => { state.branchId = node.dataset.branch; state.cardFilter = null; render(); };
    node.onclick = openBranch;
    node.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openBranch(); } };
  });
  app.querySelectorAll('[data-delete-branch]').forEach((button) => button.onclick = (event) => {
    event.stopPropagation();
    const branch = daycares.find((b) => b._id === button.dataset.deleteBranch);
    if (branch) confirmDeleteBranch(branch);
  });
  document.getElementById('newBranch')?.addEventListener('click', createBranchForm);
  const branchSearch = document.getElementById('branchSearch');
  if (branchSearch) branchSearch.oninput = applyBranchCardVisibility;
  app.querySelectorAll('[data-card-filter]').forEach((card) => {
    const activate = () => { state.cardFilter = card.dataset.cardFilter || null; render(); };
    card.onclick = activate;
    card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } };
  });
  applyBranchCardVisibility();
};

// Combines the active stat-card filter (expiring/expired/all) with the search box.
const applyBranchCardVisibility = () => {
  const query = (document.getElementById('branchSearch')?.value || '').trim().toLowerCase();
  let visible = 0;
  app.querySelectorAll('#branchGrid .branch-card').forEach((card) => {
    const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === card.dataset.branch);
    const filterMatch = !state.cardFilter
      || (state.cardFilter === 'expiring' && licenses.some((l) => l.status === 'Expiring_Soon'))
      || (state.cardFilter === 'expired' && licenses.some((l) => l.status === 'Expired'));
    const searchMatch = !query || (card.dataset.search || '').toLowerCase().includes(query);
    const match = filterMatch && searchMatch;
    card.style.display = match ? '' : 'none';
    if (match) visible += 1;
  });
  const noMatches = document.getElementById('noBranchMatches');
  if (noMatches) noMatches.hidden = visible !== 0 || !document.querySelector('.branch-card');
  collapseList(document.getElementById('branchGrid'), { itemSelector: '.branch-card', limit: LIST_LIMITS.card, key: 'branches', searching: !!query });
};

const renderBranch = async () => {
  const branch = state.branches.find((b) => b._id === state.branchId); if (!branch) { state.branchId = null; return renderBranches(); }
  const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id);
  let types;
  try { types = await api(`/api/license-types?branchId=${branch._id}`); }
  catch (error) { if (error.stale) return; app.innerHTML = `<button class="go go-back" id="back" type="button"><i class="go-chip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></i><span>כל הסניפים</span></button><section class="panel"><h3>לא ניתן לטעון את פרטי הסניף</h3><p>${esc(error.message)}</p><button class="secondary" id="retryBranch">ניסיון חוזר</button>${retryNote()}</section>`; document.getElementById('back').onclick = () => { state.branchId = null; render(); }; document.getElementById('retryBranch').onclick = markRetry(renderBranch); return; }
    const comp = computeCompleteness(types, licenses); const doneTypes = comp.present;
  const careItems = [...types.filter((t) => !licenses.some((l) => String(l.licenseTypeId?._id || l.licenseTypeId) === String(t._id))).map((t) => `חסר: ${t.name}`), ...licenses.filter((l) => l.status === 'Expired' || l.status === 'Expiring_Soon').map((l) => `${typeName(l.licenseTypeId)} ${l.status === 'Expired' ? 'פג תוקף' : 'לקראת פקיעה'}`)];
app.innerHTML = `<button class="go go-back" id="back" type="button"><i class="go-chip"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></i><span>כל הסניפים</span></button><section class="branch-title"><div><div class="eyebrow">פרטי סניף</div><h2>${esc(branch.name)}</h2><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p></div><div class="button-row">${state.user.role === 'Admin' ? '<button class="secondary" id="editBranch">✎ עריכת פרטים</button><button class="secondary" id="addType">＋ סוג אישור</button><button class="secondary" id="branchReport">▤ הפק דוח</button>' : ''}<button class="primary" id="addLicense">＋ העלאת אישור</button></div></section><div class="branch-top"><section class="branch-card-score ${comp.total && doneTypes === comp.total ? '' : 'incomplete'}"><small>שלמות אישורים</small><strong>${doneTypes}/${types.length}</strong><div class="score-bar"><i style="width:${types.length ? Math.round(doneTypes / types.length * 100) : 0}%"></i></div><div class="score-meta"><span>${comp.valid} בתוקף</span><span>${comp.expiring} לקראת פקיעה</span><span>${comp.expired} פגו</span><span>${comp.missing} חסרים</span></div></section>${branch.managerName || branch.phone || (branch.emails || []).length || branch.authorityId ? `<section class="panel branch-contact"><div class="section-heading"><div><h3>אנשי קשר ושיוך</h3></div></div><div class="contact-grid">${branch.managerName ? `<div><span class="muted">מנהלת</span><strong>${esc(branch.managerName)}</strong></div>` : ''}${branch.phone ? `<div><span class="muted">טלפון</span><strong dir="ltr">${esc(branch.phone)}</strong></div>` : ''}${(branch.emails || []).length ? `<div><span class="muted">מיילים</span><strong>${branch.emails.map((em) => esc(em)).join(', ')}</strong></div>` : ''}${branch.authorityId ? `<div><span class="muted">מקבל התשלום (שכירות)</span><strong>${esc(branch.authorityId.name || '')}${branch.authorityId.type === 'private' ? ' · פרטי' : ''}</strong></div>` : ''}</div></section>` : ''}<section class="branch-card-care ${careItems.length ? '' : 'ok'}"><h3>${careItems.length ? 'דורש טיפול' : 'הכל תקין'}</h3><p>${careItems.length ? esc(careItems.join(' · ')) : 'כל סוגי האישורים קיימים ובתוקף.'}</p>${state.user.role === 'Admin' && careItems.length ? '<button class="primary" id="careUpload">העלאת אישור</button>' : ''}</section></div><section class="panel"><div class="section-heading"><div><h3>אישורי הסניף</h3><p>האישור החדש ביותר מכל סוג מוצג כאן</p></div><span class="muted">${licenses.length} פעילים</span></div>${licenses.length ? `<input type="search" class="search-input" id="licenseSearch" placeholder="חיפוש אישור לפי סוג או שם קובץ" aria-label="חיפוש אישור"><div class="license-list" id="licenseList">${licenses.map((license) => renderLicenseCard(license, { name: typeName(license.licenseTypeId), statusClass: statusClass(license.status), statusText: statusText(license.status), date })).join('')}</div><div class="empty-state small" id="noLicenseMatches" hidden><span>▤</span><h3>לא נמצאו אישורים תואמים</h3><p>נסו לשנות את מילות החיפוש.</p></div>` : `<div class="empty-state small"><span>▤</span><h3>אין עדיין אישורים בסניף</h3><p>הגדירו סוג אישור והעלו את המסמך הראשון.</p></div>`}</section><section class="panel"><div class="section-heading"><div><h3>סוגי האישורים לסניף</h3><p>סוגים כלליים וגם סוגים שהוגדרו רק לסניף זה</p></div></div><div class="type-chips" id="branchTypeChips">${types.map((t) => { const have = licenses.find((l) => String(l.licenseTypeId?._id || l.licenseTypeId) === String(t._id)); const st = !have ? ['missing', 'חסר'] : have.status === 'Expired' ? ['expired', 'קיים · פג תוקף'] : ['present', 'קיים']; return `<span class="type-chip">${esc(t.name)}${t.branchId ? '<small>סניף זה</small>' : '<small>כל הסניפים</small>'}<small class="type-state ${st[0]}">${st[1]}</small></span>`; }).join('') || '<span class="muted">לא הוגדרו עדיין סוגי אישור</span>'}</div></section><section id="historyPanel"></section>`;
  document.getElementById('back').onclick = () => { state.branchId = null; render(); };
  document.getElementById('addLicense').onclick = () => licenseForm(branch, types);
  document.getElementById('careUpload')?.addEventListener('click', () => licenseForm(branch, types));
  document.getElementById('addType')?.addEventListener('click', () => licenseTypeForm(branch));
  document.getElementById('editBranch')?.addEventListener('click', () => branchForm(branch));
  document.getElementById('branchReport')?.addEventListener('click', () => { state.reportTab = 'branch'; state.reportSelection = branch._id; state.reportScope = 'all'; state.reportGenerated = true; state.page = 'report'; state.branchId = null; render(); window.scrollTo(0, 0); });
  app.querySelectorAll('[data-open-file]').forEach((button) => button.onclick = () => openLicenseFile(button.dataset.openFile));
  app.querySelectorAll('[data-delete-license-file]').forEach((button) => button.onclick = () => confirmDeleteLicenseFile(button.dataset.deleteLicenseFile, button.dataset.fileName));
  const licenseSearch = document.getElementById('licenseSearch');
  if (licenseSearch) licenseSearch.oninput = () => {
    const query = licenseSearch.value.trim().toLowerCase();
    let visible = 0;
    app.querySelectorAll('#licenseList .license-row').forEach((row) => {
      const match = !query || (row.dataset.search || '').toLowerCase().includes(query);
      row.style.display = match ? '' : 'none';
      if (match) visible += 1;
    });
    const noMatches = document.getElementById('noLicenseMatches');
    if (noMatches) noMatches.hidden = visible !== 0;
    collapseList(document.getElementById('licenseList'), { itemSelector: '.license-row', limit: LIST_LIMITS.row, key: 'licenses', searching: !!query });
  };
  collapseList(document.getElementById('licenseList'), { itemSelector: '.license-row', limit: LIST_LIMITS.row, key: 'licenses' });
  collapseList(document.getElementById('branchTypeChips'), { itemSelector: '.type-chip', limit: LIST_LIMITS.row, key: 'branch-types' });
  app.querySelectorAll('[data-history]').forEach((button) => button.onclick = async () => {
    let rows;
    try { rows = await api(`/api/licenses/${button.dataset.history}/history`); } catch (error) { toast(error.message, 'danger'); return; }
    const panel = document.getElementById('historyPanel');
    panel.innerHTML = `<section class="panel"><div class="section-heading"><div><h3>היסטוריית חידושים · ${esc(typeName(rows[0]?.licenseTypeId))}</h3><p>הגרסאות הקודמות נשמרות לעיון</p></div><button class="icon-button" id="closeHistory">×</button></div><div class="history-list">${rows.map((row) => `<div class="lic-hist-row"><div class="lic-hist-head"><span class="history-mark">${row.lifecycle === 'Active' ? 'פעיל' : 'הוחלף'}</span><span class="muted">הועלה <bdi dir="ltr">${date(row.createdAt)}</bdi></span></div><dl class="lic-hist-dates"><div><dt>הונפק</dt><dd><bdi dir="ltr">${date(row.issueDate)}</bdi></dd></div><div><dt>בתוקף עד</dt><dd><bdi dir="ltr">${date(row.expiryDate)}</bdi></dd></div></dl><div class="lic-hist-file">${row.fileName && row.fileUrl ? `<button class="file-link link-button" data-open-file="${row._id}"><bdi dir="auto">${esc(row.fileName)}</bdi></button><button class="text-button danger-text" data-delete-license-file="${row._id}" data-file-name="${esc(row.fileName)}">מחיקת מסמך</button>` : (row.pendingFileDeletion ? '<span class="lic-hist-pending">הקישור לקובץ הוסר. מחיקת הקובץ עצמו מהאחסון עדיין ממתינה ולא הושלמה</span>' : '<span class="muted">ללא קובץ מצורף</span>')}</div></div>`).join('')}</div></section>`;
    autoCollapse(panel, 'lic-hist');
    document.getElementById('closeHistory').onclick = () => panel.innerHTML = '';
    panel.querySelectorAll('[data-open-file]').forEach((button) => button.onclick = () => openLicenseFile(button.dataset.openFile));
    panel.querySelectorAll('[data-delete-license-file]').forEach((button) => button.onclick = () => confirmDeleteLicenseFile(button.dataset.deleteLicenseFile, button.dataset.fileName));
  });
  if (state.highlightLicenseId) {
    flashRow(`[data-license-id="${state.highlightLicenseId}"]`);
    state.highlightLicenseId = null;
  }
};

const modal = (title, content, onClose) => {
  const wrap = document.createElement('div'); wrap.className = 'modal-backdrop'; wrap.innerHTML = `<section class="modal panel"><div class="section-heading"><h3>${title}</h3><button class="icon-button" data-close>×</button></div>${content}</section>`; document.body.append(wrap);
  let wasDirty = false;
  wrap.addEventListener('input', () => { if (!wasDirty) { wasDirty = true; updateGuard.formBecameDirty(); } });
  const close = () => { wrap.remove(); updateGuard.formClosed(wasDirty); onClose?.(); }; wrap.querySelector('[data-close]').onclick = close; wrap.onclick = (e) => { if (e.target === wrap) close(); }; return { wrap, close };
};
// Branch deletion cascades ONLY after an explicit confirmation that names what
// will be lost: the branch, its permits (including history), attached documents
// and related alerts.
const confirmDeleteBranch = (branch) => {
  const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id);
  const warning = licenses.length > 0
    ? `<p>למחוק את הסניף <strong>${esc(branch.name)}</strong> לצמיתות?</p><p class="danger-text"><strong>שימו לב:</strong> לסניף יש ${licenses.length} אישורים. כולם יימחקו, כולל ההיסטוריה, המסמכים המצורפים וההתראות הקשורות אליהם.</p><p class="muted">אי אפשר לשחזר את הפעולה.</p>`
    : `<p>למחוק את הסניף <strong>${esc(branch.name)}</strong> לצמיתות? אי אפשר לשחזר את הפעולה.</p>`;
  const m = modal('מחיקת סניף', `<div class="form-grid">${warning}<div class="button-row"><button class="danger" id="confirmBranchDelete">מחיקה לצמיתות</button><button class="secondary" data-cancel-delete>ביטול</button></div></div>`);
  m.wrap.querySelector('[data-cancel-delete]').onclick = m.close;
  m.wrap.querySelector('#confirmBranchDelete').onclick = async () => {
    try {
      const r = await api(`/api/branches/${branch._id}`, { method: 'DELETE' });
      m.close();
      toast(Number(r?.pendingCleanup) > 0 ? 'הסניף נמחק. ניקוי של אישורים או קבצים שנוצרו בזמן המחיקה ממתין ויושלם אוטומטית ברקע' : 'הסניף נמחק', 'success');
      await loadApp();
      render();
    } catch (error) { toast(error.message, 'danger'); }
  };
};

const branchForm = async (branch = null) => {
  let authorities = [];
  try { authorities = await api('/api/rent/authorities'); } catch {}
  const payerOptions = ['<option value="">ללא שיוך</option>'].concat(authorities.map((a) => `<option value="${a._id}"${branch && String(branch.authorityId?._id || branch.authorityId || '') === a._id ? ' selected' : ''}>${esc(a.name)}${a.type === 'private' ? ' (פרטי)' : ''}</option>`)).join('');
  const m = modal(branch ? 'עריכת סניף' : 'הוספת סניף', `<form id="branchForm" class="form-grid"><label>שם הסניף<input name="name" required maxlength="120" value="${esc(branch?.name || '')}"></label><label>כתובת<input name="address" maxlength="240" value="${esc(branch?.address || '')}"></label><label>מספר ילדים מרבי<input name="maxChildren" type="number" min="0" value="${branch?.maxChildren ?? ''}"></label><label>מנהלת<input name="managerName" maxlength="120" value="${esc(branch?.managerName || '')}"></label><label>טלפון<input name="phone" maxlength="40" value="${esc(branch?.phone || '')}"></label><label>מיילים (מופרדים בפסיק)<input name="emails" maxlength="400" value="${esc((branch?.emails || []).join(', '))}"></label><label>מקבל התשלום (שכירות)<select name="authorityId">${payerOptions}</select></label><button class="primary">שמירת סניף</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const body = { name: f.get('name'), address: f.get('address'), maxChildren: f.get('maxChildren') || undefined, managerName: f.get('managerName'), phone: f.get('phone'), emails: f.get('emails'), authorityId: f.get('authorityId') || null };
    try {
      if (branch) { await api(`/api/branches/${branch._id}`, { method: 'PATCH', body: JSON.stringify(body) }); toast('הסניף עודכן', 'success'); }
      else { await api('/api/branches', { method: 'POST', body: JSON.stringify(body) }); toast('הסניף נוסף', 'success'); }
      m.close(); await loadApp(); if (state.branchId) await renderBranch();
    } catch (error) { toast(error.message, 'danger'); }
  };
};
const createBranchForm = () => { branchForm(); };
const licenseTypeForm = (branch = null) => {
  const scope = branch ? `<label>תחולה<select name="scope"><option value="branch">לסניף ${esc(branch.name)} בלבד</option><option value="all">לכל הסניפים</option></select></label>` : `<label>תחולה<select name="scope"><option value="all">לכל הסניפים</option>${state.branches.map((b) => `<option value="${b._id}">לסניף ${esc(b.name)} בלבד</option>`).join('')}</select></label>`;
  const m = modal('סוג אישור חדש', `<form id="typeForm" class="form-grid"><p class="muted">הסוג יוצג ברשימת האישורים של הסניפים שבחרתם.</p><label>שם סוג האישור<input name="name" required maxlength="100" placeholder="לדוגמה: אישור כיבוי אש"></label><label>הערה (לא חובה)<input name="description" maxlength="300"></label>${scope}<button class="primary">שמירת סוג אישור</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const value = f.get('scope'); try { await api('/api/license-types', { method: 'POST', body: JSON.stringify({ name: f.get('name'), description: f.get('description'), branchId: value === 'all' ? null : (value === 'branch' ? branch._id : value) }) }); m.close(); toast('סוג האישור נוסף', 'success'); await loadApp(); if (state.branchId) await renderBranch(); } catch (error) { toast(error.message, 'danger'); } };
};
const licenseForm = (selectedBranch = null, availableTypes = state.types) => {
  const branchOptions = selectedBranch ? `<option value="${selectedBranch._id}">${esc(selectedBranch.name)}</option>` : state.branches.map((b) => `<option value="${b._id}">${esc(b.name)}</option>`).join('');
  const initialTypes = selectedBranch ? availableTypes : availableTypes.filter((t) => !t.branchId);
  const m = modal('העלאת אישור שהתקבל', `<form id="licenseForm" class="form-grid"><label>סניף<select name="branchId" required>${branchOptions}</select></label><label>סוג אישור<select name="licenseTypeId" required>${initialTypes.map((t) => `<option value="${t._id}">${esc(t.name)}</option>`).join('')}</select></label><div class="two-col"><label>תאריך תחילת תוקף<input name="issueDate" type="date" required></label><label>תאריך פקיעה<input name="expiryDate" type="date" required></label></div><p class="inline-hint">תאריך הפקיעה ממולא אוטומטית לפי תקופת האישור שבשם הסוג - אפשר לשנות אותו ידנית לפי המסמך.</p><label class="file-field">מסמך (PDF או תמונה)<input name="file" type="file" accept=".pdf,image/*"><small>עד 15MB. בהעלאת חידוש, האישור הקודם יישמר בהיסטוריה.</small></label>${state.user.aiEnabled ? '<div class="ai-intake" id="aiIntake"><button type="button" class="secondary" id="aiRead" disabled>קרא את המסמך עם AI</button><small id="aiReadHint">בחרו מסמך (PDF או תמונה עד 5MB). הוא יישלח ל-Anthropic לקריאה, והפרטים יוצעו לבדיקה בלבד.</small></div><label class="check-row" id="aiConfirmRow" hidden><input type="checkbox" id="aiConfirm"> בדקתי את הפרטים מול המסמך</label>' : ''}<label class="check-field"><input type="checkbox" name="deleteOldFile" value="true"> מחק גם את המסמך של האישור המוחלף, אם קיים (ללא סימון הוא נשמר בהיסטוריה)</label><button class="primary" ${initialTypes.length ? '' : 'disabled'}>שמירת אישור</button>${initialTypes.length ? '' : '<p class="inline-hint">קודם הגדירו סוג אישור לסניף הזה.</p>'}</form>`);
  // Expiry auto-fill from the validity period encoded in the type name
  // ("5 שנתי" = five years, "שנתי" = one year). A manual edit always wins;
  // clearing the field re-enables auto-fill. Types without a clear period
  // leave the field manual - no guessing.
  const issueInput = m.wrap.querySelector('[name="issueDate"]');
  const expiryInput = m.wrap.querySelector('[name="expiryDate"]');
  const typeSelect = m.wrap.querySelector('[name="licenseTypeId"]');
  const autofillExpiry = () => {
    if (expiryTouched) return;
    const period = parseTypePeriod(typeSelect.selectedOptions[0]?.textContent);
    expiryInput.value = (period && issueInput.value) ? addPeriod(issueInput.value, period) : '';
  };
  let expiryTouched = false;
  expiryInput.addEventListener('input', () => {
    expiryTouched = expiryInput.value !== '';
    if (!expiryTouched) autofillExpiry();
  });
  issueInput.addEventListener('input', autofillExpiry);
  typeSelect.addEventListener('change', autofillExpiry);
  if (!selectedBranch) m.wrap.querySelector('[name="branchId"]').onchange = async (event) => {
    let types;
    try { types = await api(`/api/license-types?branchId=${event.target.value}`); } catch (error) { toast(error.message, 'danger'); return; }
    const select = m.wrap.querySelector('[name="licenseTypeId"]'); select.innerHTML = types.map((t) => `<option value="${t._id}">${esc(t.name)}</option>`).join('');
    const submit = m.wrap.querySelector('button.primary'); submit.disabled = !types.length;
    autofillExpiry();
  };
  // AI intake (aiEnabled only): proposes values from the document. Nothing is saved
  // until the user reviews the fields, ticks the confirmation and saves normally.
  let aiProposalId = '';
  const aiBtn = m.wrap.querySelector('#aiRead');
  if (aiBtn) {
    const fileInput = m.wrap.querySelector('[name="file"]'); const hint = m.wrap.querySelector('#aiReadHint'); const confirmRow = m.wrap.querySelector('#aiConfirmRow'); const confirmBox = m.wrap.querySelector('#aiConfirm');
    const badge = (input, text, kind) => { input.closest('label')?.querySelector('.ai-badge')?.remove(); const b = document.createElement('small'); b.className = `ai-badge ${kind}`; b.textContent = text; input.closest('label')?.appendChild(b); };
    fileInput.addEventListener('change', () => { aiBtn.disabled = !fileInput.files[0]; });
    aiBtn.onclick = async () => {
      const file = fileInput.files[0]; if (!file) return;
      const names = [...typeSelect.options].map((o) => o.textContent);
      const fd = new FormData(); fd.append('file', file); fd.append('typeNames', JSON.stringify(names)); fd.append('consentExternal', 'true'); // the button and its visible disclosure are the send approval
      aiBtn.disabled = true; aiBtn.textContent = 'קורא את המסמך…';
      try {
        const r = await api('/api/ai/license-extract', { method: 'POST', body: fd }); aiProposalId = r.proposalId || '';
        const unclear = new Set(r.unclear || []);
        const opt = [...typeSelect.options].find((o) => o.textContent === r.licenseType);
        if (opt) { typeSelect.value = opt.value; badge(typeSelect, 'הוצע על ידי AI · לבדיקה', 'proposed'); } else badge(typeSelect, 'לא ברור במסמך · לבחירה ידנית', 'unclear');
        for (const [input, key] of [[issueInput, 'issueDate'], [expiryInput, 'expiryDate']]) {
          if (!unclear.has(key) && r[key]) { input.value = r[key]; if (key === 'expiryDate') expiryTouched = true; badge(input, 'הוצע על ידי AI · לבדיקה', 'proposed'); }
          else badge(input, 'לא ברור במסמך · למילוי ידני', 'unclear');
        }
        hint.textContent = [r.documentBranch ? `במסמך מופיע: ${r.documentBranch}. זה טקסט מהמסמך בלבד, ודאו בעצמכם שזה הסניף שנבחר.` : 'במסמך לא זוהה שם מעון או סניף. בחרו את הסניף ידנית.', r.note || '', 'השדות המסומנים הם הצעה בלבד. שום דבר לא נשמר עד שתאשרו ותשמרו.'].filter(Boolean).join(' ');
        confirmRow.hidden = false; confirmBox.checked = false;
      } catch (error) { toast(error.message, 'danger'); }
      aiBtn.textContent = 'קרא את המסמך עם AI'; aiBtn.disabled = !fileInput.files[0];
    };
    m.wrap.querySelector('form').addEventListener('submit', (e) => { if (!confirmRow.hidden && !confirmBox.checked) { e.preventDefault(); e.stopImmediatePropagation(); toast('סמנו שבדקתם את הפרטים מול המסמך לפני השמירה', 'warning'); return; } if (aiProposalId && !confirmRow.hidden) { const hf = (n, v) => { let i = m.wrap.querySelector(`input[name="${n}"][type="hidden"]`); if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = n; m.wrap.querySelector('form').appendChild(i); } i.value = v; }; hf('aiProposalId', aiProposalId); hf('aiConfirmed', 'true'); } }, true);
  }
  if (!selectedBranch && state.branches.length) m.wrap.querySelector('[name="branchId"]').dispatchEvent(new Event('change'));
  m.wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const form = e.currentTarget; const f = new FormData(form);
    if (new Date(f.get('expiryDate')) < new Date(f.get('issueDate'))) return toast('תאריך הפקיעה חייב להיות אחרי תאריך ההתחלה', 'warning');
    try { await api('/api/licenses', { method: 'POST', body: f }); m.close(); toast('האישור נשמר.', 'success'); await loadApp(); if (state.branchId) await renderBranch(); }
    catch (error) {
      if (error.status === 409 && error.data?.code === 'renewal_required' && error.data.existing?.id) { confirmLicenseRenewal(m, form, error.data.existing); return; }
      toast(error.message, 'danger');
    }
  };
};


// ---- Reports (manager-only) ----
const reportScopeLabel = () => ({ all: 'הכול - קיימים ודורשים טיפול', existing: 'רק אישורים קיימים', action: 'רק דורשים טיפול (פגו / חסרים)' }[state.reportScope] || '');
const statusPillFor = (license) => !license
  ? '<span class="status-pill danger">חסר - לא קיים</span>'
  : license.status === 'Expired'
    ? '<span class="status-pill danger">פג תוקף</span>'
    : '<span class="status-pill good">קיים</span>';
const existingPillFor = (license) => license.status === 'Expired'
  ? '<span class="status-pill warning">קיים - פג תוקף</span>'
  : '<span class="status-pill good">קיים</span>';
const typeScopeChip = (type) => `<span class="scope-chip">${type.branchId ? 'סניף זה' : 'כל הסניפים'}</span>`;

const buildBranchReportBlock = (branch) => {
  const expected = expectedTypesFor(branch._id);
  const existing = expected.map((type) => ({ type, license: branchLicenseFor(branch._id, type._id) })).filter((row) => row.license);
  const action = expected.map((type) => ({ type, license: branchLicenseFor(branch._id, type._id) })).filter((row) => !row.license || row.license.status === 'Expired');
  const expiredCount = existing.filter((row) => row.license.status === 'Expired').length;
  const contact = contactLine(branch);
  const showExisting = state.reportScope !== 'action';
  const showAction = state.reportScope !== 'existing';
  return `<section class="report-block"><div class="section-heading"><div><h3>${esc(branch.name)}</h3><p>${esc(contact || 'אין פרטי קשר לסניף')}</p></div></div><div class="report-summary"><span class="good">קיימים: ${existing.length}${expiredCount ? ` (מתוכם ${expiredCount} פג תוקף)` : ''}</span><span class="bad">דורשים טיפול: ${action.length}</span></div>${!expected.length ? '<p class="muted">לא הוגדרו סוגי אישורים החלים על הסניף.</p>' : ''}${showExisting && existing.length ? `<div class="section-heading"><div><h3 class="report-sub">אישורים קיימים בסניף</h3><p>כולל אישורים שפג תוקפם - מסומנים במפורש</p></div></div><table class="report-table"><thead><tr><th>סוג אישור</th><th>סטטוס</th><th>בתוקף עד</th></tr></thead><tbody>${existing.map((row) => `<tr><td>${esc(row.type.name)} ${typeScopeChip(row.type)}</td><td>${existingPillFor(row.license)}</td><td>${row.license.status === 'Expired' ? `פג ב־${date(row.license.expiryDate)}` : date(row.license.expiryDate)}</td></tr>`).join('')}</tbody></table>` : ''}${showAction && action.length ? `<div class="section-heading report-gap"><div><h3 class="report-sub">אישורים דורשים טיפול</h3><p>פגו תוקף או לא הוזנו כלל - כולל פרטי קשר של הסניף</p></div></div><table class="report-table"><thead><tr><th>סוג אישור</th><th>סטטוס</th><th>פרטי קשר לטיפול</th></tr></thead><tbody>${action.map((row) => `<tr class="missing"><td>${esc(row.type.name)} ${typeScopeChip(row.type)}</td><td>${statusPillFor(row.license)}</td><td><strong>${esc(contact || '—')}</strong></td></tr>`).join('')}</tbody></table>` : ''}${showExisting && !existing.length && expected.length ? '<p class="muted">אין אישורים קיימים בסניף.</p>' : ''}${showAction && !action.length && expected.length ? '<p class="muted">כל האישורים קיימים ובתוקף - אין מה לטפל.</p>' : ''}</section>`;
};

const buildTypeReportBlock = (type) => {
  const daycares = state.branches.filter((b) => b.kind !== 'property');
  const applicable = type.branchId ? daycares.filter((b) => String(b._id) === String(type.branchId?._id || type.branchId)) : daycares;
  const rows = applicable.map((branch) => ({ branch, license: branchLicenseFor(branch._id, type._id) }));
  const existing = rows.filter((row) => row.license);
  const action = rows.filter((row) => !row.license || row.license.status === 'Expired');
  const expiredCount = existing.filter((row) => row.license.status === 'Expired').length;
  const showExisting = state.reportScope !== 'action';
  const showAction = state.reportScope !== 'existing';
  return `<section class="report-block"><div class="report-summary"><span>${applicable.length} סניפים</span><span class="good">קיים: ${existing.length}${expiredCount ? ` (מתוכם ${expiredCount} פג תוקף)` : ''}</span><span class="bad">דורש טיפול: ${action.length}</span></div>${showExisting && existing.length ? `<div class="section-heading"><div><h3 class="report-sub">סניפים עם האישור</h3><p>כולל סניפים שהאישור שלהם פג תוקף - מסומנים במפורש</p></div></div><table class="report-table"><thead><tr><th>סניף</th><th>סטטוס</th><th>בתוקף עד</th><th>פרטי קשר</th></tr></thead><tbody>${existing.map((row) => `<tr><td>${esc(row.branch.name)}</td><td>${existingPillFor(row.license)}</td><td>${row.license.status === 'Expired' ? `פג ב־${date(row.license.expiryDate)}` : date(row.license.expiryDate)}</td><td class="muted">${esc(contactLine(row.branch) || '—')}</td></tr>`).join('')}</tbody></table>` : ''}${showAction && action.length ? `<div class="section-heading report-gap"><div><h3 class="report-sub">סניפים דורשי טיפול</h3><p>האישור פג תוקף או לא קיים - עם פרטי הקשר להעברה לטיפול</p></div></div><table class="report-table"><thead><tr><th>סניף</th><th>סטטוס</th><th>פרטי קשר לטיפול</th></tr></thead><tbody>${action.map((row) => `<tr class="missing"><td>${esc(row.branch.name)}</td><td>${statusPillFor(row.license)}</td><td><strong>${esc(contactLine(row.branch) || '—')}</strong></td></tr>`).join('')}</tbody></table>` : ''}${showExisting && !existing.length ? '<p class="muted">אין סניפים עם האישור.</p>' : ''}${showAction && !action.length ? '<p class="muted">כל הסניפים מסודרים באישור זה.</p>' : ''}</section>`;
};

const renderReport = () => {
  // Manager-only surface: a branch user is bounced back to his branches.
  if (state.user.role !== 'Admin') { state.page = 'branches'; return renderBranches(); }
  const daycares = state.branches.filter((b) => b.kind !== 'property');
  const isBranchTab = state.reportTab === 'branch';
  const options = isBranchTab
    ? '<option value="all">כל הסניפים</option>' + daycares.map((b) => `<option value="${b._id}">${esc(b.name)}</option>`).join('')
    : state.types.map((t) => `<option value="${t._id}">${esc(t.name)}${t.branchId ? ` (רק ${esc(branchName(t.branchId))})` : ''}</option>`).join('');
  const selectLabel = isBranchTab ? 'בחירת סניף' : 'בחירת סוג אישור';
  let results = '';
  let printHead = '';
  if (state.reportGenerated) {
    const generated = date(new Date().toISOString());
    if (isBranchTab) {
      const targets = state.reportSelection === 'all' ? daycares : daycares.filter((b) => b._id === state.reportSelection);
      const names = state.reportSelection === 'all' ? 'כל הסניפים' : (targets[0]?.name || '');
      printHead = `דוח שלמות אישורים · לפי סניף · ${esc(names)}`;
      results = targets.length ? targets.map(buildBranchReportBlock).join('') : '<p class="muted">לא נמצאו סניפים.</p>';
    } else {
      const type = state.types.find((t) => t._id === state.reportSelection);
      printHead = `דוח שלמות אישורים · לפי סוג אישור · ${esc(type?.name || '')}`;
      results = type ? buildTypeReportBlock(type) : '<p class="muted">לא נמצא סוג האישור.</p>';
    }
    results = `<div class="print-only report-print-head"><div><h2>${printHead}</h2><p>הופק ב־${generated} · היקף: ${reportScopeLabel()}</p></div><strong>KinderGuard</strong></div><p class="report-meta">הופק ב־${generated} · היקף: ${reportScopeLabel()}</p>` + results;
  }
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">דוחות למנהל</div><h2>דוח שלמות אישורים</h2><p>מה קיים, מה פג תוקף ומה חסר - לכל סניף או לכל סוג אישור. אפשר לבחור מה יוצג ויודפס.</p></div><button class="secondary" id="printReport" ${state.reportGenerated ? '' : 'disabled'}>הדפסה / שמירה כ־PDF</button></section><div class="report-tabs"><button class="tab ${isBranchTab ? 'active' : ''}" data-report-tab="branch">לפי סניף</button><button class="tab ${!isBranchTab ? 'active' : ''}" data-report-tab="type">לפי סוג אישור</button></div><section class="panel"><div class="section-heading report-ui"><div><h3>הפקת דוח</h3><p>בחרו סוג דוח, ${isBranchTab ? 'סניף' : 'סוג אישור'} ומה לכלול - ואז לחצו "הפקת דוח"</p></div></div><div class="report-controls"><label>${selectLabel}<select id="reportSelect">${options}</select></label><div class="report-scope"><span>מה להציג ולהדפיס:</span><label class="check-row"><input type="radio" name="reportScope" value="all" ${state.reportScope === 'all' ? 'checked' : ''}>הכול - קיימים ודורשים טיפול</label><label class="check-row"><input type="radio" name="reportScope" value="existing" ${state.reportScope === 'existing' ? 'checked' : ''}>רק אישורים קיימים</label><label class="check-row"><input type="radio" name="reportScope" value="action" ${state.reportScope === 'action' ? 'checked' : ''}>רק דורשים טיפול (פגו / חסרים)</label></div><button class="primary report-go" id="generateReport">הפקת דוח</button></div><div id="reportResults">${results || '<div class="empty-state report-empty"><span>▤</span><h3>הדוח יוצג כאן</h3><p>אחרי ההפקה אפשר יהיה להדפיס אותו או לשמור כ־PDF ולשלוח למי שצריך.</p></div>'}</div></section>`;
  const select = document.getElementById('reportSelect');
  if (state.reportSelection && [...select.options].some((o) => o.value === state.reportSelection)) select.value = state.reportSelection;
  app.querySelectorAll('[data-report-tab]').forEach((button) => button.onclick = () => { state.reportTab = button.dataset.reportTab; state.reportSelection = ''; state.reportGenerated = false; render(); });
  document.getElementById('generateReport').onclick = () => {
    state.reportSelection = select.value;
    state.reportScope = document.querySelector('[name="reportScope"]:checked')?.value || 'all';
    state.reportGenerated = true;
    render();
  };
  document.getElementById('printReport').onclick = () => window.print();
};

const renderManagerAlerts = () => {
  const due = dueTaskAlerts().sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז טיפול</div><h2>התראות</h2><p>כאן מופיעות משימות שיצרתם בעצמכם והגיע מועד היעד שלהן. התראות על אישורים ושכירות מטופלות על ידי מנהל המערכת.</p></div><span class="inbox-total">${due.length} ממתינות לטיפול</span></section><section class="panel"><div class="alert-list">${due.length ? due.map((t) => `<article class="alert-card" style="display:block"><div style="width:100%"><strong>${esc(t.title)}</strong><div class="muted">מועד יעד: ${esc(date(t.dueDate))}${t.dueTime ? ` ${esc(t.dueTime)}` : ''}${t.branchId?.name ? ` · ${esc(t.branchId.name)}` : ''}</div></div></article>`).join('') : '<div class="empty-state"><strong>אין משימות שהגיע מועדן</strong><div class="muted">משימות שיצרתם יופיעו כאן כשיגיע מועד היעד שהגדרתם.</div></div>'}</div><button class="secondary" id="mgrGoTasks" type="button">למשימות שלי</button></section>`;
  document.getElementById('mgrGoTasks').onclick = () => { state.page = 'tasks'; render(); };
};
const renderAlerts = () => {
  if (state.user?.role === 'Manager') return renderManagerAlerts();
  const open = state.alerts.filter((a) => ['Open', 'In_Progress'].includes(a.status)); const done = state.alerts.filter((a) => ['Resolved', 'Dismissed'].includes(a.status));
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז טיפול</div><h2>התראות</h2><p>תזכורות חידוש אישורים ותזכורות תשלומי שכירות נשמרות כאן עד לסגירת הטיפול.</p></div><span class="inbox-total">${open.length} ממתינות לטיפול</span></section><section class="panel"><div class="section-heading"><div><h3>ממתינות לטיפול</h3><p>אישורים: 30 יום, 7 ימים וביום הפקיעה · שכירות: שבוע לפני פרעון וחודש לפני סיום סדרת צ'קים</p></div></div>${open.length ? `<div class="alert-list">${open.map((item) => alertCard(item)).join('')}</div>` : `<div class="empty-state small"><span>✓</span><h3>אין התראות פתוחות</h3><p>כל ההתראות טופלו. נעדכן אתכם כשיגיע מועד חידוש.</p></div>`}</section><section class="panel"><details><summary>התראות שטופלו (${done.length})</summary><div class="alert-list archived">${done.map((item) => alertCard(item, true)).join('') || '<p class="muted">אין עדיין התראות שטופלו.</p>'}</div></details></section>`;
  collapseList(app.querySelector('.alert-list:not(.archived)'), { itemSelector: '.alert-card', limit: LIST_LIMITS.card, key: 'alerts-open' });
  collapseList(app.querySelector('.alert-list.archived'), { itemSelector: '.alert-card', limit: LIST_LIMITS.card, key: 'alerts-done' });
  app.querySelectorAll('[data-alert-action]').forEach((button) => button.onclick = async () => { try { await api(`/api/notifications/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.alertAction }) }); await loadApp(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-alert-task]').forEach((button) => button.onclick = () => {
    const item = state.alerts.find((a) => String(a._id) === String(button.dataset.alertTask));
    if (item) taskForm(null, alertTaskPrefill(item), async () => { await loadApp(); render(); });
  });
  app.querySelectorAll('[data-alert-branch]').forEach((button) => button.onclick = () => { state.branchId = button.dataset.alertBranch; state.page = 'branches'; render(); });
  app.querySelectorAll('[data-alert-rent]').forEach((button) => button.onclick = () => { state.page = 'rent'; render(); });
};
const alertActionsHtml = (item) => `<div class="alert-actions"><button class="secondary small-btn" data-id="${item._id}" data-alert-action="In_Progress">${item.status === 'In_Progress' ? 'בטיפול ✓' : 'התחל טיפול'}</button><button class="secondary small-btn" data-alert-task="${item._id}" title="פתיחת משימה לטיפול בהתראה">＋ משימה</button><button class="primary small-btn" data-id="${item._id}" data-alert-action="Resolved">סימון כטופל</button></div>`;

// Builds the task form prefill for "＋ משימה" on an alert: title, due date and
// branch come from the alert so the task is ready to save as-is.
const alertTaskPrefill = (item) => {
  const branchId = item.branchId?._id || item.branchId || '';
  if (item.kind === 'Rent') {
    const isSeries = item.rentTrigger === 'month_before_series_end';
    const name = item.branchName || branchName(item.branchId);
    return isSeries
      ? { title: `הנפקת סדרת צ'קים חדשה - ${name}`, notes: `נוצר מהתראה: הסדרה מסתיימת ב־${date(item.seriesEndDate)}`, dueDate: item.seriesEndDate || null, branchId }
      : { title: `תשלום שכירות - ${name}`, notes: `נוצר מהתראה: ${money(item.amount)} · מועד פרעון ${date(item.dueDate)}`, dueDate: item.dueDate || null, branchId };
  }
  const license = item.licenseId || {};
  return { title: `חידוש ${typeName(license.licenseTypeId)} - ${branchName(item.branchId)}`, notes: `נוצר מהתראה: פקיעת האישור ב־${date(license.expiryDate)}`, dueDate: license.expiryDate || null, branchId };
};

const alertCard = (item, archived = false) => {
  const stateLabel = { Open: 'חדש', In_Progress: 'בטיפול', Resolved: 'טופל', Dismissed: 'הושתק' }[item.status];
  if (item.kind === 'Rent') {
    const isSeries = item.rentTrigger === 'month_before_series_end';
    const title = isSeries ? 'סדרת צ\'קים מסתיימת' : 'תשלום שכירות קרוב';
    const name = esc(item.branchName || branchName(item.branchId));
    const detail = isSeries
      ? `${name} · הסדרה מסתיימת ב־${date(item.seriesEndDate)} - מומלץ להנפיק סדרה חדשה`
      : `${name} · ${money(item.amount)} · מועד פרעון ${date(item.dueDate)}`;
    return `<article class="alert-card ${isSeries ? 'urgent' : ''}"><div class="alert-marker ${isSeries ? 'warning' : 'blue'}">₪</div><div class="alert-copy"><div class="alert-heading"><strong>${title}</strong><span class="status-pill ${isSeries ? 'warning' : 'neutral'}">${isSeries ? 'חודש מראש' : 'שבוע מראש'}</span><span class="muted">${stateLabel}</span></div><p><button class="inline-link" data-alert-rent="1">${detail}</button></p></div>${archived ? '' : alertActionsHtml(item)}</article>`;
  }
  const license = item.licenseId || {}; const kind = item.triggerDays === 30 ? '30 יום מראש' : item.triggerDays === 7 ? 'שבוע מראש' : 'היום';
  return `<article class="alert-card ${item.triggerDays === 0 ? 'urgent' : ''}"><div class="alert-marker ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'blue'}">${item.triggerDays === 0 ? '!' : '◷'}</div><div class="alert-copy"><div class="alert-heading"><strong>${esc(typeName(license.licenseTypeId))}</strong><span class="status-pill ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'neutral'}">${kind}</span><span class="muted">${stateLabel}</span></div><p><button class="inline-link" data-alert-branch="${item.branchId?._id || item.branchId}">${esc(branchName(item.branchId))}</button> · פקיעה ${date(license.expiryDate)}</p></div>${archived ? '' : alertActionsHtml(item)}</article>`;
};

// ----- משימות כלליות -----
const taskStatusText = (status) => ({ To_Do: 'לביצוע', In_Progress: 'בטיפול', Done: 'בוצע' }[status] || status);
const taskStatusClass = (status) => ({ To_Do: 'neutral', In_Progress: 'warning', Done: 'good' }[status] || 'neutral');
const taskFilters = [['all', 'הכל'], ['To_Do', 'לביצוע'], ['In_Progress', 'בטיפול'], ['Done', 'בוצע']];

const renderTasks = async () => {
  const isTeam = state.user.role === 'Admin' && state.taskScope === 'team';
  let tasks;
  try { tasks = await api(`/api/tasks${isTeam ? '?scope=all' : ''}`); } catch (error) { if (error.stale) return; app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את המשימות</h3><p>${esc(error.message)}</p><button class="secondary" id="retryTasks">ניסיון חוזר</button>${retryNote()}</section>`; document.getElementById('retryTasks').onclick = markRetry(renderTasks); return; }
  if (!isTeam) state.tasks = tasks;
  renderHeader();
  const filtered = state.taskFilter === 'all' ? tasks : tasks.filter((task) => task.status === state.taskFilter);
  const ordered = [...filtered].sort((a, b) => {
    const rank = (task) => task.status === 'Done' ? 1 : 0;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.status === 'Done') return new Date(b.completedAt || b.updatedAt) - new Date(a.completedAt || a.updatedAt);
    if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  const countFor = (filter) => filter === 'all' ? tasks.length : tasks.filter((task) => task.status === filter).length;
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">לוח משימות</div><h2>משימות כלליות לביצוע</h2><p>כל מה שצריך לעשות במעונות, במקום אחד - עם סטטוס טיפול.</p></div><button class="primary" id="newTask">＋ משימה חדשה</button></section><section class="panel">${state.user.role === 'Admin' ? `<div class="tabs" style="margin-bottom:16px"><button class="tab${isTeam ? '' : ' active'}" data-task-scope="mine">המשימות שלי</button><button class="tab${isTeam ? ' active' : ''}" data-task-scope="team">של כל הצוות</button></div>${isTeam ? '<p class="muted" style="margin:0 0 12px">תצוגת צוות לצפייה בלבד - משימה מעדכנים רק על ידי מי שפתח אותה.</p>' : ''}` : ''}<div class="task-filters">${taskFilters.map(([filter, label]) => `<button class="${state.taskFilter === filter ? 'primary' : 'secondary'} small-btn" data-task-filter="${filter}">${label} · ${countFor(filter)}</button>`).join('')}</div><div id="taskList" style="margin-top:10px">${ordered.length ? ordered.map((task) => taskRow(task)).join('') : `<div class="empty-state small"><span>✓</span><h3>${tasks.length ? 'אין משימות בסינון הזה' : 'אין עדיין משימות'}</h3><p>${tasks.length ? 'נסו סינון אחר.' : 'הוסיפו משימה ראשונה כדי לעקוב אחרי מה שצריך לעשות.'}</p></div>`}</div></section>`;
  collapseList(document.getElementById('taskList'), { itemSelector: '.task-row', limit: LIST_LIMITS.row, key: 'tasks' });
  document.getElementById('newTask').onclick = () => taskForm();
  app.querySelectorAll('[data-task-scope]').forEach((button) => button.onclick = () => { state.taskScope = button.dataset.taskScope; renderTasks(); });
  app.querySelectorAll('[data-task-filter]').forEach((button) => button.onclick = () => { state.taskFilter = button.dataset.taskFilter; renderTasks(); });
  app.querySelectorAll('[data-task-toggle]').forEach((button) => button.onclick = async () => { try { await api(`/api/tasks/${button.dataset.taskToggle}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.done === '1' ? 'To_Do' : 'Done' }) }); await renderTasks(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-task-edit]').forEach((button) => button.onclick = () => { const task = tasks.find((item) => item._id === button.dataset.taskEdit); if (task) taskForm(task); });
  app.querySelectorAll('[data-task-delete]').forEach((button) => button.onclick = async () => { if (!confirm('למחוק את המשימה?')) return; try { await api(`/api/tasks/${button.dataset.taskDelete}`, { method: 'DELETE' }); toast('המשימה נמחקה', 'success'); await renderTasks(); } catch (error) { toast(error.message, 'danger'); } });
};

const taskRow = (task) => {
  const done = task.status === 'Done';
  const overdue = task.dueDate && !done && new Date(task.dueDate) < israelToday();
  const branch = task.branchId ? branchName(task.branchId) : 'כל הסניפים';
  const creator = task.createdBy?.name || '';
  const meta = done
    ? `${creator ? `נוצר על ידי ${esc(creator)} · ` : ''}בוצע ${date(task.completedAt)}`
    : `${creator ? `נוצר על ידי ${esc(creator)} · ` : ''}${esc(branch)}${task.dueDate ? ` · עד ${date(task.dueDate)}` : ''}`;
  return `<article class="task-row"><button class="task-check${done ? ' done' : ''}${task.editable ? '' : ' readonly'}" ${task.editable ? `data-task-toggle="${task._id}" data-done="${done ? 1 : 0}"` : 'disabled'} title="${task.editable ? (done ? 'סימון כלביצוע' : 'סימון כבוצע') : 'צפייה בלבד - רק מי שפתח את המשימה מעדכן אותה'}" aria-label="${done ? 'סמנו כלביצוע' : 'סמנו כבוצע'}">${done ? '✓' : ''}</button><div class="task-main"><strong>${esc(task.title)}</strong><small class="${overdue ? 'task-overdue' : ''}">${meta}${overdue ? ' · באיחור' : ''}${task.notes ? ` · ${esc(task.notes)}` : ''}</small></div><span class="status-pill ${taskStatusClass(task.status)}">${taskStatusText(task.status)}</span>${task.editable ? `<span class="task-actions"><button class="icon-button" data-task-edit="${task._id}" title="עריכת משימה" aria-label="עריכה">✎</button><button class="icon-button branch-delete" data-task-delete="${task._id}" title="מחיקת משימה" aria-label="מחיקה">🗑</button></span>` : ''}</article>`;
};

const taskForm = (task = null, prefill = null, onSaved = null) => {
  const initialDue = task?.dueDate || prefill?.dueDate;
  const initialBranch = String(task?.branchId?._id || task?.branchId || prefill?.branchId || '');
  const m = modal(task ? 'עריכת משימה' : 'משימה חדשה', `<form id="taskForm" class="form-grid"><label>כותרת המשימה<input name="title" required maxlength="200" value="${esc(task?.title ?? prefill?.title ?? '')}"></label><label>הערות (לא חובה)<input name="notes" maxlength="2000" value="${esc(task?.notes ?? prefill?.notes ?? '')}"></label><div class="two-col"><label>תאריך יעד (לא חובה)<input name="dueDate" type="date" value="${initialDue ? new Date(initialDue).toISOString().slice(0, 10) : ''}"></label><label>שעת יעד (לא חובה)<input name="dueTime" type="time" value="${esc(task?.dueTime || '')}"></label><label>סניף<select name="branchId"><option value="">כל הסניפים</option>${state.branches.map((branch) => `<option value="${branch._id}"${initialBranch === String(branch._id) ? ' selected' : ''}>${esc(branch.name)}</option>`).join('')}</select></label></div>${task ? `<label>סטטוס<select name="status">${taskFilters.slice(1).map(([value, label]) => `<option value="${value}"${task.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}<button class="primary">${task ? 'שמירת שינויים' : 'יצירת משימה'}</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const payload = { title: form.get('title'), notes: form.get('notes') || '', dueDate: form.get('dueDate') || null, dueTime: form.get('dueDate') ? (form.get('dueTime') || '') : '', branchId: form.get('branchId') || null };
    if (task) payload.status = form.get('status');
    try {
      await api(task ? `/api/tasks/${task._id}` : '/api/tasks', { method: task ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      m.close(); toast(task ? 'המשימה עודכנה' : 'המשימה נוצרה', 'success'); if (onSaved) await onSaved(); else await renderTasks();
    } catch (error) { toast(error.message, 'danger'); }
  };
};

// ----- שכירות: מעקב תשלומים לרשויות (תיעוד בלבד, ללא העברת כסף) -----
const money = (value) => `₪${Number(value || 0).toLocaleString('he-IL', { maximumFractionDigits: 2 })}`;
const rentFrequencyText = (value) => ({ monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מועדים מותאמים' }[value] || value);
const rentMethodText = (value) => ({ cheque: "צ'ק", transfer: 'העברה בנקאית' }[value] || value);
const rentStatusPill = (status) => ({ Pending: ['neutral', 'ממתין'], Handed: ['warning', "צ'ק נמסר · טרם נפרע"], Cleared: ['good', 'נפרע'], Cancelled: ['neutral', 'בוטל'] }[status] || ['neutral', status]);
// Amount shown on an agreement row follows its frequency: the actual payment
// sum per cadence (yearly for annual, quarterly for quarterly, monthly
// otherwise). For non-monthly cadences a monthly equivalent is shown below,
// explicitly labeled as display-only - the actual payment stays quarterly or
// annual.
const rentPeriodAmountCell = (agreement) => {
  if (agreement.frequency === 'annual' && agreement.annualAmount != null) {
    return `${money(agreement.annualAmount)} / שנה<br><small class="muted">≈ ${money(agreement.annualAmount / 12)} / חודש · לתצוגה בלבד, התשלום שנתי</small>`;
  }
  if (agreement.frequency === 'quarterly') {
    const quarterly = agreement.quarterlyAmount ?? (agreement.monthlyAmount != null ? agreement.monthlyAmount * 3 : (agreement.annualAmount != null ? agreement.annualAmount / 4 : null));
    if (quarterly != null) return `${money(quarterly)} / רבעון<br><small class="muted">≈ ${money(quarterly / 3)} / חודש · לתצוגה בלבד, התשלום רבעוני</small>`;
  }
  if (agreement.monthlyAmount != null) return `${money(agreement.monthlyAmount)} / חודש`;
  if (agreement.annualAmount != null) return `${money(agreement.annualAmount)} / שנה`;
  return 'טרם הוזן';
};

const openRentDoc = async (agreementId, docId) => {
  try {
    const response = await fetch(`/api/rent/agreements/${agreementId}/documents/${docId}`, { headers: state.token ? { Authorization: `Bearer ${state.token}` } : {} });
    if (!response.ok) {
      let message = 'לא ניתן לפתוח את הקובץ. נסו שוב.';
      try { message = (await response.json()).message || message; } catch {}
      throw new Error(message);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message, 'danger'); }
};

const confirmDeleteRentDoc = (agreementId, docId, fileName, onDeleted) => {
  const m = modal('מחיקת מסמך שכירות', `<div class="form-grid"><p>למחוק את המסמך <strong><bdi dir="ltr">${esc(fileName || '')}</bdi></strong>?</p><p class="muted">הסכם השכירות והתשלומים נשארים. לא ניתן לשחזר את הקובץ אחרי המחיקה.</p><div class="button-row"><button class="danger" id="confirmDeleteRentDoc">מחיקת המסמך</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('#confirmDeleteRentDoc').onclick = async () => { try { await api(`/api/rent/agreements/${agreementId}/documents/${docId}`, { method: 'DELETE' }); m.close(); toast('המסמך נמחק', 'success'); await renderRent(); if (onDeleted) onDeleted(docId); } catch (error) { toast(error.message, 'danger'); } };
};

// Rent documents live in their own modal, fully separate from license
// documents: different routes, different storage prefix, admin-only screen.
const rentDocsModal = (agreement) => {
  const docs = agreement.documents || [];
  const m = modal(`מסמכי שכירות · ${esc(agreement.branchId?.name || 'סניף')}`, `<div class="form-grid">
    ${docs.length ? `<div class="history-list">${docs.map((doc) => `<div class="history-row"><span class="history-mark">מסמך</span><strong><button class="file-link link-button" data-rent-open-doc="${doc._id}">${esc(doc.fileName || 'מסמך')}</button></strong><span class="muted">הועלה ${date(doc.uploadedAt)}</span><button class="text-button danger-text" data-rent-del-doc="${doc._id}" data-file-name="${esc(doc.fileName || '')}">מחיקה</button></div>`).join('')}</div>` : '<p class="muted">אין עדיין מסמכים להסכם זה.</p>'}
    <form id="rentDocForm" class="form-grid"><label class="file-field">הוספת מסמך (PDF או תמונה)<input name="file" type="file" accept=".pdf,image/*" required><small>עד 15MB. מסמכי שכירות נשמרים בנפרד ממסמכי האישורים.</small></label><button class="primary">העלאת מסמך</button></form>
  </div>`);
  autoCollapse(m.wrap, 'rent-docs');
  m.wrap.querySelectorAll('[data-rent-open-doc]').forEach((button) => button.onclick = () => openRentDoc(agreement._id, button.dataset.rentOpenDoc));
  // The modal stays open after a delete so several documents can be managed
  // in one visit: drop the row immediately instead of leaving a stale entry
  // whose second delete would 404.
  m.wrap.querySelectorAll('[data-rent-del-doc]').forEach((button) => button.onclick = () => confirmDeleteRentDoc(agreement._id, button.dataset.rentDelDoc, button.dataset.fileName, () => {
    button.closest('.history-row')?.remove();
    m.wrap.querySelectorAll('.history-list').forEach((el) => { delete el.dataset.collapseDone; }); autoCollapse(m.wrap, 'rent-docs');
    if (!m.wrap.querySelector('[data-rent-del-doc]')) {
      const list = m.wrap.querySelector('.history-list');
      if (list) list.outerHTML = '<p class="muted">אין עדיין מסמכים להסכם זה.</p>';
    }
  }));
  m.wrap.querySelector('#rentDocForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try { await api(`/api/rent/agreements/${agreement._id}/documents`, { method: 'POST', body: f }); m.close(); toast('המסמך הועלה', 'success'); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

const renderRent = async () => {
  let data;
  try { data = await api('/api/rent/summary'); }
  catch (error) { if (error.stale) return;
    app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את נתוני השכירות</h3><p>${esc(error.message)}</p><button class="secondary" id="retryRent">ניסיון חוזר</button>${retryNote()}</section>`;
    document.getElementById('retryRent').onclick = markRetry(renderRent);
    return;
  }
  state.rent = data;
  const { authorities, agreements, payments, groups = [], totals } = data;
  const active = agreements.filter((a) => a.status === 'Active');
  const today = israelToday();
  const in30 = new Date(today.getTime() + 30 * 86400000);
  const byDueDate = (a, b) => new Date(a.dueDate) - new Date(b.dueDate);
  const openPayments = payments.filter((p) => ['Pending', 'Handed'].includes(p.status));
  const overdue = openPayments.filter((p) => new Date(p.dueDate) < today).sort(byDueDate);
  const upcoming = openPayments.filter((p) => new Date(p.dueDate) >= today && new Date(p.dueDate) <= in30).sort(byDueDate);
  const handedCount = payments.filter((p) => p.status === 'Handed').length;
  // Shared row markup for the two open-payment lists; each list shows up to
  // LIST_LIMIT rows until "show all" is clicked.
  const LIST_LIMIT = 7;
  const paymentRow = (p) => { const [cls, txt] = rentStatusPill(p.status); return `<article class="license-row" data-payment-id="${p._id}"><div class="license-icon ${p.status === 'Handed' ? 'warning' : ''}">${p.method === 'cheque' ? '✎' : '⇄'}</div><div class="license-main"><strong>${esc(p.branchName)}</strong><small>${esc(p.authorityName)} · ${rentMethodText(p.method)} · פרעון ${date(p.dueDate)}</small></div><span class="amount-cell">${money(p.amount)}</span><span class="status-pill ${cls}">${txt}</span>${p.method === 'cheque' && p.status === 'Pending' ? `<button class="text-button" data-rent-handed="${p._id}">סמן כנמסר</button>` : ''}<button class="text-button" data-rent-cleared="${p._id}">סמן כנפרע</button></article>`; };
  const visibleList = (list, stateKey) => (state[stateKey] ? list : list.slice(0, LIST_LIMIT));
  const moreButton = (list, stateKey) => (list.length > LIST_LIMIT ? `<button class="secondary small-btn full" data-rent-more="${stateKey}">${collapseLabel(list.length - LIST_LIMIT, !!state[stateKey])}</button>` : '');
  // Yearly figure per agreement for the annual stat card: stored yearly sum,
  // or derived from the cadence's own amount when only that exists.
  const annualFigure = (a) => a.annualAmount ?? (a.monthlyAmount != null ? a.monthlyAmount * 12 : (a.quarterlyAmount != null ? a.quarterlyAmount * 4 : 0));
  const annualTotal = active.reduce((sum, a) => sum + annualFigure(a), 0);
  const rentAlerts = currentAlerts().filter((a) => a.kind === 'Rent').length;
  const filterId = state.rentAuthorityFilter || '';
  const visibleAuthorities = authorities.filter((a) => !filterId || a._id === filterId);
  const nextPayment = (agreementId) => payments.find((p) => String(p.agreementId) === String(agreementId) && ['Pending', 'Handed'].includes(p.status));
  const agreementRow = (agreement) => {
    const next = nextPayment(agreement._id);
    const [pillClass, pillText] = next ? rentStatusPill(next.status) : ['neutral', 'אין תשלומים קרובים'];
    const series = agreement.chequeSeries?.seriesEndDate ? ` · הסדרה מסתיימת ${date(agreement.chequeSeries.seriesEndDate)}` : '';
    return `<article class="license-row">
      <div class="license-icon ${next ? (next.status === 'Handed' ? 'warning' : '') : ''}">${agreement.paymentMethod === 'cheque' ? '✎' : '⇄'}</div>
      <div class="license-main"><strong>${esc(agreement.branchId?.name || 'סניף')}${agreement.branchId?.kind === 'property' ? ' <span class="muted">(משרד)</span>' : ''}${agreement.direction === 'incoming' ? ' <span class="muted">(הגוף משלם לנו)</span>' : ''}</strong><small>${agreement.frequency ? `${rentFrequencyText(agreement.frequency)} · ${rentMethodText(agreement.paymentMethod)} · ` : ''}${next ? `פרעון הבא ${date(next.dueDate)} · ${money(next.amount)}` : (agreement.monthlyAmount == null && agreement.annualAmount == null && agreement.quarterlyAmount == null ? 'הסכום והמועדים יוזנו בהמשך' : 'אין מועד קרוב')}${series}</small></div>
      <span class="amount-cell">${rentPeriodAmountCell(agreement)}</span>
      <span class="status-pill ${pillClass}">${pillText}</span>
      ${next && agreement.paymentMethod === 'cheque' && next.status === 'Pending' ? `<button class="text-button" data-rent-handed="${next._id}">סמן כנמסר</button>` : ''}
      ${next ? `<button class="text-button" data-rent-cleared="${next._id}">סמן כנפרע</button>` : ''}
      <button class="text-button" data-rent-docs="${agreement._id}">מסמכים (${agreement.documents?.length || 0})</button>
      <button class="text-button" data-rent-history="${agreement._id}">היסטוריה</button>
      <button class="text-button" data-rent-edit="${agreement._id}">עריכת הסכם</button>
      ${agreement.paymentMethod === 'cheque' ? `<button class="text-button" data-rent-series="${agreement._id}">סדרת צ'קים</button>` : ''}
      <button class="text-button danger-text" data-rent-close="${agreement._id}">סגירת הסכם</button>
    </article>`;
  };
  const authorityPanel = (authority) => {
    const list = active.filter((a) => String(a.authorityId?._id || a.authorityId) === authority._id);
    const total = totals[authority._id] || { monthly: 0, annual: 0 };
    return `<section class="panel"><div class="section-heading"><div><h3>${esc(authority.name)}${authority.type === 'private' ? ' <small class="muted">(פרטי)</small>' : ''}</h3><p>${list.length} הסכמים פעילים</p></div><span class="authority-total" title="הסכום החודשי כולל חלוקת תשלומים רבעוניים ושנתיים לחודשים - לתצוגה בלבד, התשלום בפועל לפי התדירות של כל הסכם">סה״כ לרשות: ${money(total.monthly)} לחודש · ${money(total.annual)} לשנה</span></div>${list.length ? `<div class="license-list">${list.map(agreementRow).join('')}</div>` : '<div class="empty-state small"><span>₪</span><h3>אין הסכמים פעילים ברשות</h3><p>הוסיפו הסכם שכירות כדי להתחיל לעקוב.</p></div>'}</section>`;
  };
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">תשלומי שכירות</div><h2>שכירות לרשויות</h2><p>מעקב תשלומי שכר דירה למועצות ולגופים פרטיים לפי מעון. תיעוד בלבד, ללא העברת כסף בפועל.</p></div><div class="button-row"><button class="secondary" id="newAuthority">＋ גוף לתשלום</button><button class="secondary" id="newGroup">₪ תשלום מרוכז</button><button class="primary" id="newAgreement">＋ הסכם שכירות</button></div></section>
  <section class="stats-grid"><article class="stat-card clickable" id="rentAnnualCard" role="button" tabindex="0" title="מעבר לרשויות וההסכמים"><span class="stat-icon teal">₪</span><div><strong>${money(annualTotal)}</strong><small>סה״כ שנתי, כל הרשויות</small></div></article><article class="stat-card clickable" id="rentUpcomingCard" role="button" tabindex="0" title="מעבר לתשלומים הקרובים"><span class="stat-icon amber">${upcoming.length}</span><div><strong>תשלומים קרובים</strong><small>מהיום ו־30 יום קדימה</small></div></article><article class="stat-card clickable" id="rentChecksCard" role="button" tabindex="0" title="רשימת הצ'קים שהופקדו"><span class="stat-icon blue">${handedCount}</span><div><strong>צ'קים מופקדים</strong><small>נמסרו, טרם נפרעו</small></div></article><article class="stat-card clickable" id="rentAlertsCard" role="button" tabindex="0" title="מעבר להתראות השכירות"><span class="stat-icon coral">${rentAlerts}</span><div><strong>תזכורות פעילות</strong><small>מועדי תשלום וסדרות צ'קים</small></div></article></section>
  ${overdue.length ? `<section class="panel" id="rentOverduePanel"><div class="section-heading"><div><h3>עבר מועד הפרעון · ממתין לבירור</h3><p>תשלומים פתוחים שהמועד שלהם עבר, מהישן לחדש. המערכת לא מסמנת אותם לבד כשולמו או כחוב - סמנו \"נפרע\" רק אחרי שווידאתם שהתשלום בוצע בפועל.</p></div><span class="inbox-total">${overdue.length} לבירור</span></div><div class="license-list">${visibleList(overdue, 'rentShowAllOverdue').map(paymentRow).join('')}</div>${moreButton(overdue, 'rentShowAllOverdue')}</section>` : ''}
  ${upcoming.length ? `<section class="panel" id="rentUpcomingPanel"><div class="section-heading"><div><h3>תשלומים קרובים</h3><p>מהיום ועד 30 הימים הבאים, לפי מועד פרעון</p></div></div><div class="license-list">${visibleList(upcoming, 'rentShowAllUpcoming').map(paymentRow).join('')}</div>${moreButton(upcoming, 'rentShowAllUpcoming')}</section>` : ''}
  <div id="rentAuthoritiesTop"></div>${authorities.length ? `<div class="rent-authority-filter"><label for="rentAuthorityFilter">סינון לפי רשות</label><select id="rentAuthorityFilter"><option value=""${!filterId ? ' selected' : ''}>כל הרשויות</option>${authorities.map((a) => `<option value="${esc(a._id)}"${filterId === a._id ? ' selected' : ''}>${esc(a.name)}${a.type === 'private' ? ' (פרטי)' : ''}</option>`).join('')}</select></div>` : ''}
  ${visibleAuthorities.length ? visibleAuthorities.map(authorityPanel).join('') : `<div class="empty-state"><span>₪</span><h3>${authorities.length ? 'לא נמצאה רשות מתאימה' : 'עוד אין רשויות'}</h3><p>${authorities.length ? 'נסו סינון אחר.' : 'הוסיפו את הרשות הראשונה ואז הגדירו הסכם שכירות לכל מעון.'}</p></div>`}
  ${groups.length ? `<section class="panel"><div class="section-heading"><div><h3>תשלומים מרוכזים</h3><p>צ'ק או העברה אחת שמחולקת בין מספר מעונות</p></div></div><div class="license-list">${groups.map((g) => { const [cls, txt] = rentStatusPill(g.status); return `<article class="license-row"><div class="license-icon ${g.status === 'Handed' ? 'warning' : ''}">${g.method === 'cheque' ? '✎' : '⇄'}</div><div class="license-main"><strong>${esc(g.authorityName)} · ${money(g.totalAmount)}</strong><small>${rentMethodText(g.method)} · מועד ${date(g.dueDate)} · ${g.allocations.map((a) => `${esc(a.branchName)} ${money(a.amount)}`).join(' + ')}</small></div><span class="status-pill ${cls}">${txt}</span>${g.method === 'cheque' && g.status === 'Pending' ? `<button class="text-button" data-group-handed="${g._id}">סמן כנמסר</button>` : ''}${['Pending', 'Handed'].includes(g.status) ? `<button class="text-button" data-group-cleared="${g._id}">סמן כנפרע</button><button class="text-button danger-text" data-group-cancel="${g._id}">ביטול</button>` : ''}${['Handed', 'Cleared'].includes(g.status) ? `<button class="text-button" data-group-revert="${g._id}">בטל סימון</button>` : ''}</article>`; }).join('')}</div></section>` : ''}
  <section class="panel"><div class="section-heading"><div><h3>דוח תשלומים בפועל</h3><p>כמה שולם בפועל בתקופה נבחרת - לכל רשות ולכל מעון</p></div></div><form id="paidReportForm" class="form-grid"><div class="three-col"><label>מתאריך<input type="date" name="from" value="${israelParts().year}-01-01" required></label><label>עד תאריך<input type="date" name="to" value="${israelParts().year}-12-31" required></label><label>רשות<select name="authorityId"><option value="">כל הרשויות</option>${authorities.map((a) => `<option value="${a._id}">${esc(a.name)}</option>`).join('')}</select></label></div><div class="two-col"><label>התקופה נספרת לפי<select name="dateField"><option value="due">מועד הפרעון המתוכנן (מה היה צריך לשלם, ומה עדיין פתוח)</option><option value="cleared">תאריך הפרעון בפועל (כסף שבאמת יצא בתקופה)</option></select></label><div><button class="secondary small-btn" type="submit">הפק דוח</button></div></div></form><div id="paidReportResults"></div></section>
  <section id="rentHistoryPanel"></section>`;
  document.getElementById('newAuthority').onclick = authorityForm;
  document.getElementById('newAgreement').onclick = () => rentAgreementForm();
  document.getElementById('newGroup').onclick = () => rentGroupForm();
  document.getElementById('paidReportForm').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    const params = new URLSearchParams({ from: f.get('from'), to: f.get('to'), dateField: f.get('dateField') });
    if (f.get('authorityId')) params.set('authorityId', f.get('authorityId'));
    const target = document.getElementById('paidReportResults');
    const byClear = f.get('dateField') === 'cleared';
    const modeLabel = byClear ? 'לפי תאריך פרעון בפועל' : 'לפי מועד פרעון מתוכנן';
    try {
      const report = await api(`/api/rent/reports/paid?${params}`);
      const body = report.authorities.length ? report.authorities.map((a) => `<div class="authority-report"><div class="section-heading"><div><h3>${esc(a.authorityName)}</h3><p>שולם בפועל: ${money(a.clearedTotal)} (צ'קים ${money(a.clearedCheque)} · העברות ${money(a.clearedTransfer)})${byClear ? '' : ` · יתרה פתוחה: ${money(a.outstandingTotal)}`}</p></div></div><div class="history-list">${a.branches.map((b) => `<div class="history-row"><strong>${esc(b.branchName)}</strong><span>שולם ${money(b.clearedTotal)}</span><span class="muted">${byClear ? '' : `יתרה פתוחה ${money(b.outstandingTotal)} · `}${b.paymentCount} תשלומים</span></div>`).join('')}</div></div>`).join('') : '<p class="muted">אין תשלומים בתקופה שנבחרה.</p>';
      target.innerHTML = `<p class="muted">${modeLabel} · ${f.get('from')} עד ${f.get('to')}</p>${body}`;
      autoCollapse(target, 'paid-report');
    } catch (error) { target.innerHTML = `<p class="muted">${esc(error.message)}</p>`; }
  };
  app.querySelectorAll('[data-group-handed]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payment-groups/${button.dataset.groupHanded}/handed`, { method: 'POST' }); toast('התשלום המרוכז סומן כנמסר (טרם נפרע)', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-group-cleared]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payment-groups/${button.dataset.groupCleared}/cleared`, { method: 'POST' }); toast('התשלום המרוכז סומן כנפרע', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-group-cancel]').forEach((button) => button.onclick = () => {
    const group = groups.find((g) => g._id === button.dataset.groupCancel);
    if (group) rentGroupCancelForm(group);
  });
  app.querySelectorAll('[data-group-revert]').forEach((button) => button.onclick = () => {
    const group = groups.find((g) => g._id === button.dataset.groupRevert);
    if (group) rentRevertForm('תשלום מרוכז', group.authorityName, `/api/rent/payment-groups/${group._id}/revert`);
  });
  autoCollapse(app, 'rent');
  app.querySelectorAll('[data-rent-more]').forEach((button) => button.onclick = async () => { state[button.dataset.rentMore] = !state[button.dataset.rentMore]; await renderRent(); scrollToRent(button.dataset.rentMore === 'rentShowAllOverdue' ? 'rentOverduePanel' : 'rentUpcomingPanel'); });
  // Summary cards double as shortcuts to the matching places on the page.
  const cardAction = (id, action) => { const card = document.getElementById(id); card.onclick = action; card.onkeydown = (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); action(); } }; };
  const scrollToRent = (id) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  cardAction('rentAnnualCard', async () => { state.rentAuthorityFilter = null; await renderRent(); scrollToRent('rentAuthoritiesTop'); });
  cardAction('rentUpcomingCard', () => { if (document.getElementById('rentUpcomingPanel')) scrollToRent('rentUpcomingPanel'); else toast('אין תשלומים קרובים ב־30 הימים הבאים', 'warning'); });
  cardAction('rentChecksCard', () => {
    const handed = payments.filter((p) => p.status === 'Handed').sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    if (!handed.length) { toast("אין צ'קים שהופקדו וטרם נפרעו", 'warning'); return; }
    const panel = document.getElementById('rentHistoryPanel');
    panel.innerHTML = `<section class="panel"><div class="section-heading"><div><h3>צ'קים מופקדים · טרם נפרעו</h3><p>${handed.length} צ'קים נמסרו וממתינים לפרעון (צפייה בלבד)</p></div><button class="icon-button" id="closeRentHistory">×</button></div><div class="history-list">${handed.map((p) => { const [cls, txt] = rentStatusPill(p.status); return `<div class="history-row"><span class="history-mark">${date(p.dueDate)}</span><strong>${esc(p.branchName || '')}</strong><span>${esc(p.authorityName || '')} · ${money(p.amount)} · ${rentMethodText(p.method)}</span><span class="status-pill ${cls}">${txt}</span></div>`; }).join('')}</div></section>`;
    autoCollapse(panel, 'rent-cheques');
    document.getElementById('closeRentHistory').onclick = () => { panel.innerHTML = ''; };
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  cardAction('rentAlertsCard', () => { state.page = 'alerts'; render(); });
  const authorityFilter = document.getElementById('rentAuthorityFilter');
  if (authorityFilter) authorityFilter.onchange = async (event) => {
    state.rentAuthorityFilter = event.currentTarget.value || null;
    await renderRent();
    // Keep keyboard/screen-reader users at the filter after the page redraw.
    document.getElementById('rentAuthorityFilter')?.focus({ preventScroll: true });
  };
  app.querySelectorAll('[data-rent-docs]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentDocs);
    if (agreement) rentDocsModal(agreement);
  });
  app.querySelectorAll('[data-rent-handed]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payments/${button.dataset.rentHanded}/handed`, { method: 'POST' }); toast('סומן: הצ\'ק נמסר לרשות (טרם נפרע)', 'success'); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-rent-cleared]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payments/${button.dataset.rentCleared}/cleared`, { method: 'POST' }); toast('התשלום סומן כנפרע', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-rent-close]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentClose);
    if (!agreement) return;
    const m = modal('סגירת הסכם שכירות', `<div class="form-grid"><p>לסגור את הסכם השכירות של <strong>${esc(agreement.branchId?.name || 'הסניף')}</strong>?</p><p class="muted">תשלומים עתידיים מתוכננים יבוטלו. היסטוריית התשלומים ששולמו והופקדו נשמרת לעיון.</p><div class="button-row"><button class="danger" id="confirmCloseAgreement">סגירת ההסכם</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
    m.wrap.querySelector('[data-cancel]').onclick = m.close;
    m.wrap.querySelector('#confirmCloseAgreement').onclick = async () => { try { await api(`/api/rent/agreements/${agreement._id}/close`, { method: 'POST' }); m.close(); toast('ההסכם נסגר, ההיסטוריה נשמרה', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } };
  });
  app.querySelectorAll('[data-rent-edit]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentEdit);
    if (agreement) rentAgreementEditForm(agreement);
  });
  app.querySelectorAll('[data-rent-series]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentSeries);
    if (agreement) rentSeriesForm(agreement);
  });
  app.querySelectorAll('[data-rent-history]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentHistory);
    const panel = document.getElementById('rentHistoryPanel');
    const rows = payments.filter((p) => String(p.agreementId) === String(agreement._id)).sort((a, b) => new Date(b.dueDate) - new Date(a.dueDate));
    panel.innerHTML = `<section class="panel"><div class="section-heading"><div><h3>היסטוריית תשלומים · ${esc(agreement.branchId?.name || 'סניף')}</h3><p>${esc(agreement.authorityId?.name || '')} · ${rentFrequencyText(agreement.frequency)} · ${rentMethodText(agreement.paymentMethod)}</p></div><button class="icon-button" id="closeRentHistory">×</button></div><div class="history-list">${rows.length ? rows.map((p) => { const [cls, txt] = rentStatusPill(p.status); const grp = p.groupId ? (state.rent.groups || []).find((g) => String(g._id) === String(p.groupId)) : null; return `<div class="history-row"><span class="history-mark">${txt}</span><strong>${date(p.dueDate)}</strong><span>${money(p.amount)} · ${rentMethodText(p.method)}${grp ? ` · חלק מתשלום מרוכז ${money(grp.totalAmount)}` : ''}</span><span class="muted">${p.clearedAt ? `נפרע ${date(p.clearedAt)}` : p.paidAt ? `נמסר ${date(p.paidAt)}` : 'טרם שולם'}${p.lastEditedAt ? ' · נערך (תיעוד שמור)' : ''}</span><span class="status-pill ${cls}">${txt}</span>${p.status === 'Pending' ? `<button class="text-button" data-rent-edit="${p._id}">עריכה</button>` : ''}${['Handed', 'Cleared'].includes(p.status) && !p.groupId ? `<button class="text-button" data-rent-revert="${p._id}">בטל סימון</button>` : ''}</div>`; }).join('') : '<p class="muted">אין עדיין תשלומים מתועדים להסכם זה.</p>'}</div></section>`;
    autoCollapse(panel, 'rent-hist');
    panel.querySelectorAll('[data-rent-edit]').forEach((button) => button.onclick = () => {
      const payment = payments.find((x) => String(x._id) === button.dataset.rentEdit);
      if (payment) rentPaymentEditForm(payment);
    });
    panel.querySelectorAll('[data-rent-revert]').forEach((button) => button.onclick = () => {
      const payment = payments.find((x) => String(x._id) === button.dataset.rentRevert);
      if (payment) rentRevertForm('תשלום', payment.branchName, `/api/rent/payments/${payment._id}/revert`);
    });
    document.getElementById('closeRentHistory').onclick = () => { panel.innerHTML = ''; };
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  // Landed from a native toast: flash the relevant payment row, else the
  // agreement row; a row that no longer shows (far-future payment, changed
  // filter) just does not flash.
  if (state.highlightPaymentId || state.highlightAgreementId) {
    if (state.highlightPaymentId) flashRow(`[data-payment-id="${state.highlightPaymentId}"]`);
    if (!state.highlightPaymentId || !document.querySelector('.row-flash')) {
      if (state.highlightAgreementId) flashRow(`[data-rent-history="${state.highlightAgreementId}"]`);
    }
    state.highlightPaymentId = null;
    state.highlightAgreementId = null;
  }
};

const authorityForm = () => {
  const m = modal('גוף לתשלום חדש', `<form id="authorityForm" class="form-grid"><label>שם הגוף<input name="name" required maxlength="120" placeholder="לדוגמה: מועצה אזורית שפיר"></label><label>סוג הגוף<select name="type"><option value="council">רשות / מועצה / עירייה</option><option value="private">גוף פרטי</option></select></label><button class="primary">שמירה</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { await api('/api/rent/authorities', { method: 'POST', body: JSON.stringify({ name: f.get('name'), type: f.get('type') }) }); m.close(); toast('הגוף לתשלום נוסף', 'success'); await renderRent(); } catch (error) { toast(error.message, 'danger'); } };
};

const rentAgreementForm = () => {
  const authorities = state.rent?.authorities || [];
  if (!state.branches.length) return toast('צריך להגדיר סניף לפני הוספת הסכם שכירות', 'warning');
  if (!authorities.length) return toast('צריך להגדיר רשות לפני הוספת הסכם שכירות', 'warning');
  const m = modal('הסכם שכירות חדש', `<form id="rentAgreementForm" class="form-grid">
    <div class="two-col"><label>מעון / משרד<select name="branchId">${state.branches.map((b) => `<option value="${b._id}">${esc(b.name)}${b.kind === 'property' ? ' (משרד)' : ''}</option>`).join('')}</select></label>
    <label>מקבל התשלום<select name="authorityId">${authorities.map((a) => `<option value="${a._id}">${esc(a.name)}</option>`).join('')}</select></label></div>
    <label>כיוון התשלום<select name="direction"><option value="outgoing">אנחנו משלמים לגוף (שכירות)</option><option value="incoming">הגוף משלם לנו</option></select></label>
    <div class="two-col"><label>תדירות תשלום<select name="frequency"><option value="monthly">חודשי</option><option value="quarterly">רבעוני</option><option value="annual">שנתי</option><option value="custom">מועדים מותאמים</option></select></label>
    <label>אמצעי תשלום<select name="paymentMethod"><option value="cheque">צ'ק</option><option value="transfer">העברה בנקאית</option></select></label></div>
    <div id="monthlyWrap"><label>סכום חודשי (₪)<input name="monthlyAmount" type="number" min="0" step="0.01" placeholder="יוזן בהמשך"><small class="muted">התשלום בפועל חודשי - תשלום אחד בכל חודש</small></label></div>
    <div id="quarterlyWrap" hidden><label>סכום רבעוני (₪)<input name="quarterlyAmount" type="number" min="0" step="0.01" placeholder="יוזן בהמשך"><small class="muted">התשלום בפועל רבעוני - תשלום אחד בכל 3 חודשים. לתצוגה בלבד יוצג גם שווה־ערך חודשי (רבעוני ÷ 3)</small></label></div>
    <div id="annualWrap" hidden><label>סכום שנתי (₪)<input name="annualAmount" type="number" min="0" step="0.01" placeholder="יוזן בהמשך"><small class="muted">התשלום בפועל שנתי - תשלום אחד בשנה. לתצוגה בלבד יוצג גם שווה־ערך חודשי (שנתי ÷ 12)</small></label></div>
    <label>תאריך פרעון ראשון<input name="firstDueDate" type="date"><small class="muted">נדרש רק אחרי שמוזן סכום</small></label>
    <div id="customDatesWrap" hidden><label>מועדי פרעון מותאמים</label><div id="customDates"><input type="date" name="customDate"></div><button type="button" class="secondary small-btn" id="addCustomDate">＋ מועד נוסף</button></div>
    <fieldset id="seriesWrap"><legend class="check-row"><input type="checkbox" name="hasSeries"> הופקדה סדרת צ'קים מראש</legend><div id="seriesFields" hidden><div class="two-col"><label>מספר צ'קים בסדרה<input name="depositedCount" type="number" min="1"></label><label>תאריך סיום הסדרה<input name="seriesEndDate" type="date"></label></div><p class="muted">סדרה מלאה מכסה שנה: 12 צ'קים בתדירות חודשית, 4 ברבעונית, 1 בשנתית. הפקדת הסדרה לא מסמנת תשלום כנפרע - כל צ'ק מסומן בפועל בנפרד. חודש לפני סיום הסדרה תופיע תזכורת להנפיק סדרה חדשה.</p></div></fieldset>
    <button class="primary">שמירת הסכם</button></form>`);
  const form = m.wrap.querySelector('form');
  // The frequency chooses the single visible amount input: monthly shows the
  // monthly sum, quarterly the quarterly sum, annual the yearly sum. Custom
  // dates are priced per payment with the monthly field.
  const syncAmountField = () => {
    const freq = form.elements.frequency.value;
    m.wrap.querySelector('#monthlyWrap').hidden = !(freq === 'monthly' || freq === 'custom');
    m.wrap.querySelector('#quarterlyWrap').hidden = freq !== 'quarterly';
    m.wrap.querySelector('#annualWrap').hidden = freq !== 'annual';
    m.wrap.querySelector('#customDatesWrap').hidden = freq !== 'custom';
  };
  form.elements.frequency.onchange = () => { syncAmountField(); applySeriesDefaults(); };
  syncAmountField();
  // A deposited cheque series covers one year of the agreement's cadence:
  // 12 monthly cheques, 4 quarterly, 1 annual. The count and the end date
  // (due date of the year's last cheque) prefill from the frequency and
  // first due date, and stay editable; a manual entry is never overwritten.
  const SERIES_YEAR_COUNT = { monthly: 12, quarterly: 4, annual: 1 };
  const SERIES_STEP_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };
  const seriesDirty = { count: false, end: false };
  form.elements.depositedCount.addEventListener('input', () => { seriesDirty.count = true; });
  form.elements.seriesEndDate.addEventListener('input', () => { seriesDirty.end = true; });
  function applySeriesDefaults() {
    const freq = form.elements.frequency.value;
    const count = SERIES_YEAR_COUNT[freq];
    if (count == null) return; // custom dates keep a fully manual series
    if (!seriesDirty.count) form.elements.depositedCount.value = count;
    const first = form.elements.firstDueDate.value;
    if (!seriesDirty.end && first) {
      const end = addMonthsClamped(new Date(`${first}T00:00:00`), (count - 1) * SERIES_STEP_MONTHS[freq]);
      form.elements.seriesEndDate.value = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    }
  }
  form.elements.firstDueDate.addEventListener('change', applySeriesDefaults);
  form.elements.hasSeries.onchange = () => { m.wrap.querySelector('#seriesFields').hidden = !form.elements.hasSeries.checked; if (form.elements.hasSeries.checked) applySeriesDefaults(); };
  m.wrap.querySelector('#addCustomDate').onclick = () => { const input = document.createElement('input'); input.type = 'date'; input.name = 'customDate'; m.wrap.querySelector('#customDates').append(input); };
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(form);
    const freq = f.get('frequency');
    // Only the amount field of the chosen frequency is sent, so each cadence
    // is recorded exactly as entered. The server derives yearly/quarterly
    // equivalents from it for totals and display convenience only.
    const visibleAmount = { monthly: 'monthlyAmount', custom: 'monthlyAmount', quarterly: 'quarterlyAmount', annual: 'annualAmount' }[freq];
    const body = {
      branchId: f.get('branchId'), authorityId: f.get('authorityId'), direction: f.get('direction'),
      monthlyAmount: visibleAmount === 'monthlyAmount' ? f.get('monthlyAmount') || undefined : undefined,
      annualAmount: visibleAmount === 'annualAmount' ? f.get('annualAmount') || undefined : undefined,
      quarterlyAmount: visibleAmount === 'quarterlyAmount' ? f.get('quarterlyAmount') || undefined : undefined,
      frequency: freq, paymentMethod: f.get('paymentMethod'), firstDueDate: f.get('firstDueDate') || undefined,
    };
    if (!body.monthlyAmount && !body.annualAmount && !body.quarterlyAmount) { body.frequency = undefined; body.paymentMethod = undefined; }
    if (body.frequency === 'custom') body.customDueDates = f.getAll('customDate').filter(Boolean);
    if (f.get('hasSeries')) body.chequeSeries = { depositedCount: f.get('depositedCount'), seriesEndDate: f.get('seriesEndDate') };
    try { await api('/api/rent/agreements', { method: 'POST', body: JSON.stringify(body) }); m.close(); toast('הסכם השכירות נשמר ומועדי התשלום נוצרו', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

const rentSeriesForm = (agreement) => {
  const series = agreement.chequeSeries || {};
  // A full series covers one year of the agreement's cadence: 12 monthly
  // cheques, 4 quarterly, 1 annual. The suggested end date is the due date
  // of that year's last upcoming cheque; both stay editable.
  const yearCount = { monthly: 12, quarterly: 4, annual: 1 }[agreement.frequency];
  const upcoming = (state.rent?.payments || [])
    .filter((p) => String(p.agreementId) === String(agreement._id) && ['Pending', 'Handed'].includes(p.status))
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  const suggestedEnd = yearCount && upcoming.length ? new Date(upcoming[Math.min(yearCount, upcoming.length) - 1].dueDate).toISOString().slice(0, 10) : '';
  const countValue = series.depositedCount || yearCount || '';
  const endValue = series.seriesEndDate ? new Date(series.seriesEndDate).toISOString().slice(0, 10) : suggestedEnd;
  const cadenceNote = yearCount ? `סדרה מלאה בתדירות ${rentFrequencyText(agreement.frequency)} מכסה שנה: ${yearCount} צ'קים.` : '';
  const m = modal(`סדרת צ'קים מופקדת · ${esc(agreement.branchId?.name || 'סניף')}`, `<form id="seriesForm" class="form-grid"><p class="muted">עדכנו כשמפקידים סדרה חדשה. ${cadenceNote} ההפקדה לא מסמנת תשלומים כנפרעו - כל צ'ק מסומן בפועל בנפרד. התזכורת תופיע שוב חודש לפני סיום הסדרה החדשה.</p><div class="two-col"><label>מספר צ'קים בסדרה<input name="depositedCount" type="number" min="1" value="${countValue}"></label><label>תאריך סיום הסדרה<input name="seriesEndDate" type="date" value="${endValue}" required></label></div><button class="primary">שמירת סדרה</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { await api(`/api/rent/agreements/${agreement._id}`, { method: 'PATCH', body: JSON.stringify({ chequeSeries: { depositedCount: f.get('depositedCount'), seriesEndDate: f.get('seriesEndDate') } }) }); m.close(); toast('סדרת הצ\'קים עודכנה', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } };
};

// Edit an existing agreement. The server (PATCH /api/rent/agreements/:id) updates untouched
// future Pending payments to the new figure; handed, cleared, grouped and manually edited
// payments stay as recorded. The note below tells the user exactly that, with live counts.
const rentAgreementEditForm = (agreement) => {
  const mine = (state.rent?.payments || []).filter((p) => String(p.agreementId) === String(agreement._id));
  const follow = mine.filter((p) => p.status === 'Pending' && !p.groupId && !p.lastEditedAt).length;
  const kept = mine.filter((p) => !(p.status === 'Pending' && !p.groupId && !p.lastEditedAt) && p.status !== 'Cancelled').length;
  const freq = agreement.frequency || 'monthly';
  const amountKey = { monthly: 'monthlyAmount', custom: 'monthlyAmount', quarterly: 'quarterlyAmount', annual: 'annualAmount' }[freq];
  const amountLabel = { monthly: 'סכום חודשי (₪)', custom: 'סכום לכל תשלום (₪)', quarterly: 'סכום רבעוני (₪)', annual: 'סכום שנתי (₪)' }[freq];
  const dateVal = agreement.firstDueDate ? new Date(agreement.firstDueDate).toISOString().slice(0, 10) : '';
  const opt = (v, t, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`;
  const m = modal(`עריכת הסכם · ${esc(agreement.branchId?.name || 'סניף')}`, `<form id="rentAgreementEditForm" class="form-grid">
    <div class="two-col"><label>תדירות תשלום<select name="frequency"${freq === 'custom' ? ' disabled' : ''}>${freq === 'custom' ? opt('custom', 'מועדים מותאמים', freq) : opt('monthly', 'חודשי', freq) + opt('quarterly', 'רבעוני', freq) + opt('annual', 'שנתי', freq)}</select></label>
    <label>אמצעי תשלום<select name="paymentMethod">${opt('cheque', "צ'ק", agreement.paymentMethod)}${opt('transfer', 'העברה בנקאית', agreement.paymentMethod)}</select></label></div>
    <label><span id="editAmountLabel">${amountLabel}</span><input name="amount" type="number" min="0.01" step="0.01" value="${agreement[amountKey] ?? ''}"></label>
    <label>תאריך פרעון ראשון<input name="firstDueDate" type="date" value="${dateVal}"></label>
    <fieldset id="editScope" hidden><legend>שינוי הסכום חל:</legend>
      <label class="check-row"><input type="radio" name="amountScope" value="all"> <span><strong>למפרע</strong><small class="ai-diff" style="display:block">כל התשלומים הממתינים שלא נערכו ידנית, כולל כאלה שמועדם כבר עבר</small></span></label>
      <label class="check-row"><input type="radio" name="amountScope" value="future"> <span><strong>מכאן ולהבא</strong><small class="ai-diff" style="display:block">רק תשלומים ממתינים שלא נערכו ידנית מהתאריך שנבחר ואילך</small></span></label>
      <div id="editFromWrap" hidden><label>תאריך תחולה<input name="amountEffectiveFrom" type="date" value="${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' })}"></label></div>
      <p class="muted">צ'קים שנמסרו, תשלומים שנפרעו, תשלומים מקובצים ותשלומים שתוקנו ידנית לא ישתנו בשום מקרה.</p></fieldset>
    <p class="muted" id="editImpact">שינוי הסכום יעדכן ${follow} תשלומים ממתינים שלא נגעו בהם. ${kept} תשלומים שנמסרו, נפרעו, קובצו או תוקנו ידנית נשארים כפי שנרשמו. שינוי תדירות או תאריך ראשון עשוי להסיר או ליצור מועדים עתידיים שלא נגעו בהם.</p>
    <button class="primary">שמירת שינויים</button></form>`);
  const form = m.wrap.querySelector('form');
  const amountMoves = () => { const nf = freq === 'custom' ? 'custom' : form.elements.frequency.value; const k = { monthly: 'monthlyAmount', custom: 'monthlyAmount', quarterly: 'quarterlyAmount', annual: 'annualAmount' }[nf]; const amt = form.elements.amount.value; return agreement.monthlyAmount != null || agreement.quarterlyAmount != null || agreement.annualAmount != null ? (nf !== freq || (amt && Number(amt) !== Number(agreement[k]))) : false; };
  const syncScope = () => { const need = amountMoves(); m.wrap.querySelector('#editScope').hidden = !need; m.wrap.querySelector('#editFromWrap').hidden = !(need && form.elements.amountScope.value === 'future'); form.querySelector('button.primary').disabled = need && !form.elements.amountScope.value;
    const sc = form.elements.amountScope.value; const from = form.elements.amountEffectiveFrom.value;
    const n = mine.filter((p) => p.status === 'Pending' && !p.groupId && !p.lastEditedAt && (sc !== 'future' || !from || new Date(p.dueDate).toISOString().slice(0, 10) >= from)).length;
    m.wrap.querySelector('#editImpact').textContent = `${need ? `שינוי הסכום יעדכן ${n} תשלומים ממתינים שלא נגעו בהם${sc === 'future' ? ' (מהתאריך שנבחר ואילך)' : ''}.` : 'שינוי הסכום יעדכן רק תשלומים ממתינים שלא נגעו בהם.'} ${mine.length - mine.filter((p) => p.status === 'Pending' && !p.groupId && !p.lastEditedAt).length - mine.filter((p) => p.status === 'Cancelled').length} תשלומים שנמסרו, נפרעו, קובצו או תוקנו ידנית נשארים כפי שנרשמו. שינוי תדירות או תאריך ראשון עשוי להסיר או ליצור מועדים עתידיים שלא נגעו בהם.`; };
  form.addEventListener('input', syncScope); form.addEventListener('change', syncScope); syncScope();
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(form); const body = {};
    const nf = freq === 'custom' ? 'custom' : f.get('frequency');
    if (nf !== freq) body.frequency = nf;
    if (f.get('paymentMethod') !== agreement.paymentMethod) body.paymentMethod = f.get('paymentMethod');
    if (f.get('firstDueDate') && f.get('firstDueDate') !== dateVal) body.firstDueDate = f.get('firstDueDate');
    const key = { monthly: 'monthlyAmount', custom: 'monthlyAmount', quarterly: 'quarterlyAmount', annual: 'annualAmount' }[nf];
    const amt = f.get('amount');
    if (amt && (nf !== freq || Number(amt) !== Number(agreement[key]))) body[key] = amt;
    if (!Object.keys(body).length) return toast('לא בוצע שינוי', 'warning');
    if (amountMoves()) { const sc = f.get('amountScope'); if (!sc) return toast('בחרו אם השינוי חל למפרע או מכאן ולהבא', 'warning'); body.amountScope = sc; if (sc === 'future') { if (!f.get('amountEffectiveFrom')) return toast('בחרו תאריך תחולה', 'warning'); body.amountEffectiveFrom = f.get('amountEffectiveFrom'); } }
    try { await api(`/api/rent/agreements/${agreement._id}`, { method: 'PATCH', body: JSON.stringify(body) }); m.close(); toast('ההסכם עודכן. התשלומים הממתינים שלא נגעו בהם עודכנו בהתאם', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

const rentGroupForm = () => {
  const { authorities = [], payments = [] } = state.rent || {};
  const pending = payments.filter((p) => p.status === 'Pending' && !p.groupId);
  if (!pending.length) return toast('אין תשלומים שממתינים לשיבוץ בתשלום מרוכז', 'warning');
  const m = modal('תשלום מרוכז לרשות', `<form id="rentGroupForm" class="form-grid"><p class="muted">צ'ק או העברה אחת לרשות, עם חלוקה מדויקת בין המעונות. הסכום הכולל הוא סכום החלוקות.</p><div class="two-col"><label>רשות<select name="authorityId">${authorities.map((a) => `<option value="${a._id}">${esc(a.name)}</option>`).join('')}</select></label><label>אמצעי תשלום<select name="method"><option value="cheque">צ'ק</option><option value="transfer">העברה בנקאית</option></select></label></div><label>מועד התשלום<input name="dueDate" type="date" required></label><div id="groupPayments"></div><div class="authority-total" id="groupTotal">סה״כ: ₪0</div><button class="primary">יצירת תשלום מרוכז</button></form>`);
  const form = m.wrap.querySelector('form');
  const listWrap = m.wrap.querySelector('#groupPayments');
  const totalEl = m.wrap.querySelector('#groupTotal');
  const renderList = () => {
    const eligible = pending.filter((p) => String(p.authorityId) === form.elements.authorityId.value && p.method === form.elements.method.value);
    listWrap.innerHTML = eligible.length ? eligible.map((p) => `<label class="check-row"><input type="checkbox" name="paymentIds" value="${p._id}">${esc(p.branchName)} · ${date(p.dueDate)} · ${money(p.amount)}</label>`).join('') : '<p class="muted">אין תשלומים ממתינים באמצעי תשלום זה לרשות זו.</p>';
    totalEl.textContent = 'סה״כ: ₪0';
  };
  form.elements.authorityId.onchange = renderList;
  form.elements.method.onchange = renderList;
  listWrap.onchange = () => {
    const sum = [...listWrap.querySelectorAll('input:checked')].reduce((acc, input) => acc + (pending.find((p) => String(p._id) === input.value)?.amount || 0), 0);
    totalEl.textContent = `סה״כ: ${money(sum)}`;
  };
  renderList();
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(form);
    const paymentIds = f.getAll('paymentIds');
    if (!paymentIds.length) return toast('יש לבחור לפחות תשלום אחד', 'warning');
    try { await api('/api/rent/payment-groups', { method: 'POST', body: JSON.stringify({ authorityId: f.get('authorityId'), method: f.get('method'), dueDate: f.get('dueDate'), paymentIds }) }); m.close(); toast('התשלום המרוכז נוצר', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

// Records-only correction of a pending payment. The original values stay in
// the audit trail; the row is marked "נערך".
const rentPaymentEditForm = (payment) => {
  const m = modal(`עריכת תשלום · ${esc(payment.branchName)}`, `<form id="rentEditForm" class="form-grid"><p class="muted">תיקון רישום בלבד. הסכום והמועד המקוריים נשמרים בתיעוד.</p><div class="two-col"><label>סכום (₪)<input name="amount" type="number" min="0.01" step="0.01" value="${payment.amount}" required></label><label>מועד פרעון<input name="dueDate" type="date" value="${new Date(payment.dueDate).toISOString().slice(0, 10)}" required></label></div><label>סיבת התיקון (לא חובה)<input name="reason" maxlength="200" placeholder="לדוגמה: תוקן מול הרשות"></label><button class="primary">שמירת התיקון</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try { await api(`/api/rent/payments/${payment._id}`, { method: 'PATCH', body: JSON.stringify({ amount: f.get('amount'), dueDate: f.get('dueDate'), reason: f.get('reason') }) }); m.close(); toast('התשלום תוקן והתיעוד נשמר', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

// Records-only undo of a mistaken status click. The event stays in the audit
// trail; nothing here touches a real bank account or cheque.
const rentRevertForm = (kind, name, url) => {
  const m = modal(`ביטול סימון · ${kind}`, `<form id="revertForm" class="form-grid"><p>לבטל את הסימון של <strong>${esc(name)}</strong>?</p><p class="muted">הרישום יחזור למצב הקודם (נמסר → ממתין, נפרע → נמסר או ממתין). פעולת רישום בלבד מול הטעות - הסימון המקורי נשמר בתיעוד, ואין כל פעולה מול הבנק.</p><label>סיבה (לא חובה)<input name="reason" maxlength="200" placeholder="לדוגמה: סומן בטעות"></label><div class="button-row"><button class="primary" type="submit">ביטול הסימון</button><button class="secondary" data-cancel type="button">חזרה</button></div></form>`);
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try { await api(url, { method: 'POST', body: JSON.stringify({ reason: f.get('reason') }) }); m.close(); toast('הסימון בוטל והרישום חזר למצב הקודם', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

// Cancels the RECORD of a grouped payment (never a real bank action). The
// obligations return to ungrouped pending payments; originals stay in audit.
const rentGroupCancelForm = (group) => {
  const m = modal('ביטול תשלום מרוכז', `<form id="groupCancelForm" class="form-grid"><p>לבטל את רישום התשלום המרוכז ל<strong>${esc(group.authorityName)}</strong> על סך ${money(group.totalAmount)}?</p><p class="muted">ביטול רישום בלבד, לא פעולה מול הבנק. התשלומים יחזרו להיות תשלומים ממתינים נפרדים לכל מעון, והרישום המקורי נשמר בתיעוד.</p><label>סיבת הביטול (לא חובה)<input name="reason" maxlength="200" placeholder="לדוגמה: הצ'ק לא נמסר בפועל"></label><div class="button-row"><button class="danger" type="submit">ביטול התשלום המרוכז</button><button class="secondary" data-cancel type="button">חזרה</button></div></form>`);
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('form').onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    try { await api(`/api/rent/payment-groups/${group._id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: f.get('reason') }) }); m.close(); toast('התשלום המרוכז בוטל והתשלומים חזרו למצב ממתין', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

// Fires the three fixture toasts from nativeNotify.testToastPayloads through
// the same Electron notify bridge the real alerts use. The 10s head start
// lets the user close the window with X first, which is exactly the hidden
// path under test; nothing here touches the API, the DB, or the dedupe state.
const runNotificationSelfTest = () => {
  if (!window.electronAPI?.notify) { toast('התראות מערכת זמינות רק באפליקציה המותקנת במחשב', 'danger'); return; }
  const payloads = testToastPayloads({ typeName, branchName, date, money });
  toast('שלוש התראות בדיקה יקפצו בעוד 10 שניות - אפשר לסגור את החלון ב־X ולהמתין להן', 'success');
  payloads.forEach((payload, index) => {
    setTimeout(() => {
      Promise.resolve(window.electronAPI.notify(payload))
        .then((sent) => { if (sent === false) toast('התראות Windows לא זמינות כרגע - בדקו את הגדרות ההתראות של המערכת', 'danger'); })
        .catch(() => toast('שליחת התראת הבדיקה נכשלה', 'danger'));
    }, 10000 + index * 3000);
  });
};

const renderSettings = async () => {
  let users;
  try { users = await api('/api/users'); } catch (error) { if (error.stale) return; app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את ההגדרות</h3><p>${esc(error.message)}</p><button class="secondary" id="retrySettings">ניסיון חוזר</button>${retryNote()}</section>`; document.getElementById('retrySettings').onclick = markRetry(renderSettings); return; }
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">ניהול החשבון</div><h2>הגדרות וצוות</h2><p>הגדירו את האישורים הנדרשים והחליטו למי יש גישה לכל סניף.</p></div></section><section class="settings-grid"><section class="panel"><div class="section-heading"><div><h3>סוגי אישורים</h3><p>לכל הסניפים או לסניף מסוים</p></div><button class="primary small-btn" id="newType">＋ סוג אישור</button></div><div class="settings-types" id="typeList">${state.types.map((type, i) => `<div class="settings-type"${i >= 7 ? ' data-extra-type hidden' : ''}><span>${esc(type.name)}<small>${type.branchId ? `רק ${esc(branchName(type.branchId))}` : 'כל הסניפים'}</small></span><button class="text-button danger-text" data-remove-type="${type._id}">הסרה</button></div>`).join('') || '<p class="muted">עדיין לא הוגדרו סוגי אישורים.</p>'}</div>${state.types.length > 7 ? `<button class="secondary small-btn full" id="toggleTypes">${collapseLabel(state.types.length - 7, false)}</button>` : ''}</section><section class="panel"><div class="section-heading"><div><h3>משתמשים</h3><p>משתמשים יכולים לטפל באישורים בסניפים שהוקצו להם</p></div><button class="primary small-btn" id="newUser">＋ הוספת משתמש</button></div><div class="settings-types" id="userList">${users.map((u) => `<div class="settings-type"><span>${esc(u.name)}<small>${esc(u.email)} · ${u.role === 'Admin' ? 'גישה מלאה לכל הסניפים' : (u.accessibleBranches || []).map((b) => esc(b.name)).join(', ') || 'ללא סניפים'}</small></span><b class="role-label">${u.role === 'Admin' ? 'מנהל שותף' : 'משתמש'}${u.aiEnabled ? ' · AI' : ''}</b></div>`).join('') || '<p class="muted">אין עדיין משתמשים נוספים.</p>'}</div></section><section class="panel"><div class="section-heading"><div><h3>בדיקת התראות</h3><p>שליחת שלוש התראות בדיקה של Windows (אישור, שכירות וסיכום). ההתראות מסומנות כבדיקה ולא יוצרות שום נתון אמיתי. הן יקפצו 10 שניות אחרי הלחיצה, כך שאפשר לסגור את החלון ב־X ולבדוק שהן מגיעות גם כשהתוכנה מוסתרת. לחיצה על התראה מחזירה לתוכנה ופותחת את המסך המתאים.</p></div><button class="primary small-btn" id="testToasts">שליחת התראות בדיקה</button></div></section></section>`;
  collapseList(document.getElementById('userList'), { itemSelector: '.settings-type', limit: LIST_LIMITS.row, key: 'users' });
  document.getElementById('testToasts').onclick = runNotificationSelfTest;
  document.getElementById('newType').onclick = () => licenseTypeForm();
  document.getElementById('toggleTypes')?.addEventListener('click', (e) => { const rows = app.querySelectorAll('[data-extra-type]'); const open = rows[0]?.hidden; rows.forEach((r) => { r.hidden = !open; }); e.currentTarget.textContent = collapseLabel(state.types.length - 7, !!open); });
  document.getElementById('newUser').onclick = createUserForm;
  app.querySelectorAll('[data-remove-type]').forEach((button) => button.onclick = async () => { if (!confirm('להסיר את סוג האישור מהרשימה הפעילה? מסמכים שכבר הועלו יישמרו.')) return; try { await api(`/api/license-types/${button.dataset.removeType}`, { method: 'DELETE' }); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } });
};
const createUserForm = () => {
  const m = modal('הוספת משתמש', `<form id="userForm" class="form-grid"><label>שם מלא<input name="name" required></label><label>דוא״ל<input name="email" type="email" required></label><label>סיסמה ראשונית<input name="password" type="password" minlength="8" required></label><fieldset><legend>תפקיד</legend><label class="check-row"><input type="radio" name="role" value="Manager" checked>משתמש - צופה ומעדכן רק בסניפים שיסומנו</label><label class="check-row"><input type="radio" name="role" value="Admin">מנהל שותף - אותן ההרשאות ואותם הנתונים שלך, כולל כל הסניפים וההגדרות</label></fieldset><label class="check-row"><input type="checkbox" name="aiEnabled">אפשר שימוש בעוזר ה-AI</label><fieldset id="branchAccess"><legend>גישה לסניפים</legend>${state.branches.map((b) => `<label class="check-row"><input type="checkbox" name="branches" value="${b._id}">${esc(b.name)}</label>`).join('') || '<p class="muted">צריך ליצור סניף לפני הוספת משתמש.</p>'}</fieldset><button class="primary">יצירת משתמש</button></form>`);
  const branchAccess = m.wrap.querySelector('#branchAccess');
  m.wrap.querySelectorAll('input[name="role"]').forEach((radio) => radio.onchange = () => { branchAccess.hidden = m.wrap.querySelector('input[name="role"]:checked').value === 'Admin'; });
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const role = f.get('role'); try { await api('/api/users', { method: 'POST', body: JSON.stringify({ name: f.get('name'), email: f.get('email'), password: f.get('password'), role, accessibleBranches: role === 'Admin' ? [] : f.getAll('branches'), aiEnabled: f.get('aiEnabled') === 'on' }) }); m.close(); toast(role === 'Admin' ? 'המנהל השותף נוסף' : 'המשתמש נוסף', 'success'); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } };
};

// ----- In-app updates -----
// A small update button in the top bar. When the desktop app finds a newer
// version it shows a yellow dot; the user clicks, approves, and the app
// downloads and installs by itself - including closing itself when needed.
const updateSlot = document.getElementById('update-slot');
const updateUi = { state: null, manualCheck: false, installPromptOpen: false };

const renderUpdateButton = () => {
  if (!updateSlot) return;
  if (!window.electronAPI?.getUpdateState || !updateUi.state || updateUi.state.status === 'disabled') { if (updateSlot) updateSlot.innerHTML = ''; return; }
  const s = updateUi.state;
  const hasUpdate = s.status === 'available' || s.status === 'downloaded';
  const busy = s.status === 'checking' || s.status === 'downloading';
  const label = { idle: 'עדכון', checking: 'בודק…', uptodate: 'עדכון', available: 'עדכון זמין', downloading: `מוריד ${s.percent ?? 0}%`, downloaded: 'התקנת עדכון', error: 'ניסיון חוזר' }[s.status] || 'עדכון';
  updateSlot.innerHTML = `<button class="update-button${hasUpdate ? ' has-update' : ''}" id="updateButton" ${busy ? 'disabled' : ''} title="בדיקת עדכונים לאפליקציה"><span class="update-icon">↻</span><span class="update-label">${label}</span>${hasUpdate ? '<span class="update-dot" aria-label="יש עדכון חדש"></span>' : ''}</button>`;
  updateSlot.querySelector('#updateButton').onclick = onUpdateButtonClick;
};

const promptDownloadUpdate = () => {
  const version = updateUi.state?.version ? ` (גרסה ${esc(updateUi.state.version)})` : '';
  const m = modal('עדכון זמין', `<div class="form-grid"><p>נמצאה גרסה חדשה של KinderGuard${version}.</p><p class="muted">לאחר האישור ההורדה מתבצעת ברקע ואפשר להמשיך לעבוד כרגיל. רק בסיום ההורדה תתבקשו לאשר את ההתקנה עצמה.</p><div class="button-row"><button class="primary" id="approveDownload">הורדת העדכון</button><button class="secondary" data-cancel>מאוחר יותר</button></div></div>`);
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('#approveDownload').onclick = async () => { m.close(); try { await window.electronAPI.downloadUpdate(); } catch { toast('הורדת העדכון נכשלה. נסו שוב מאוחר יותר.', 'danger'); } };
};

const promptInstallUpdate = () => {
  if (updateUi.installPromptOpen) return;
  updateUi.installPromptOpen = true;
  const version = updateUi.state?.version ? ` (גרסה ${esc(updateUi.state.version)})` : '';
  const m = modal('העדכון מוכן להתקנה', `<div class="form-grid"><p>העדכון${version} ירד בהצלחה.</p><p class="muted">בלחיצה על \"עדכון עכשיו\" האפליקציה תיסגר לבד, תתקין את הגרסה החדשה ותיפתח מחדש - אין צורך לסגור דבר ידנית. הנתונים השמורים, ההגדרות והמסמכים שהועלו נשמרים, אבל טופס פתוח שלא נשמר יאבד כמו בכל סגירה של האפליקציה - כדאי לשמור לפני ההתקנה. \"מאוחר יותר\" משאיר את הכול כמות שהוא, וכפתור העדכון ימשיך להציע את ההתקנה.</p><div class="button-row"><button class="primary" id="approveInstall">עדכון עכשיו</button><button class="secondary" data-cancel>מאוחר יותר</button></div></div>`, () => { updateUi.installPromptOpen = false; });
  m.wrap.querySelector('[data-cancel]').onclick = m.close;
  m.wrap.querySelector('#approveInstall').onclick = () => {
    const g = updateGuard.state();
    if (g.blocked) return promptPendingWrites(m);
    if (g.needsDecision) return promptInstallDecision(m);
    runUpdateInstall(m);
  };
};

const runUpdateInstall = async (m, { discardUnsaved = false } = {}) => {
  let result;
  try { result = await window.electronAPI.installUpdate({ discardUnsaved }); }
  catch { toast('התקנת העדכון נכשלה. נסו שוב.', 'danger'); return; }
  // The desktop process enforces the same guard: a refusal means state changed
  // since this dialog opened (a write started, or a form was edited).
  if (result && result.installed === false) {
    toast(result.reason === 'pending-writes' ? 'יש שמירות שעדיין מתבצעות - ההתקנה תתאפשר כשיסתיימו' : 'יש טפסים עם שינויים שלא נשמרו', 'warning');
    return;
  }
  updateUi.installPromptOpen = false;
  m.close();
};

// A pending write (a save or an upload mid-flight) blocks the install
// outright - no discard is offered for a half-written bank record or file.
const promptPendingWrites = (installModal) => {
  const risk = updateGuard.describe();
  const m = modal('שמירות עדיין מתבצעות', `<div class="form-grid"><p>לא ניתן להתקין כרגע: ${esc(risk)}.</p><p class="muted">ההתקנה סוגרת את האפליקציה מיד, וקטיעה באמצע שמירה עלולה להשאיר רישום חלקי. המתינו כמה שניות עד שהשמירה מסתיימת, ואז לחצו שוב על כפתור העדכון.</p><div class="button-row"><button class="primary" id="backToWait">חזרה</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
  m.wrap.querySelector('[data-cancel]').onclick = () => { m.close(); };
  m.wrap.querySelector('#backToWait').onclick = () => { m.close(); installModal.close(); };
};

// Once no write is pending, unsaved form changes still need an explicit
// decision: go back and save, discard and install anyway, or cancel.
const promptInstallDecision = (installModal) => {
  const risk = updateGuard.describe();
  const m = modal('יש שינויים שלא נשמרו', `<div class="form-grid"><p>לפני ההתקנה צריך להחליט מה לעשות עם ${esc(risk)}.</p><p class="muted">ההתקנה סוגרת את האפליקציה מיד. שינויים שלא נשמרו יאבדו. הנתונים שכבר נשמרו לא ייפגעו.</p><div class="button-row"><button class="primary" id="backToSave">חזרה לשמירה</button><button class="danger" id="discardAndInstall">התקנה בכל זאת</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
  m.wrap.querySelector('[data-cancel]').onclick = () => { m.close(); };
  m.wrap.querySelector('#backToSave').onclick = () => { m.close(); installModal.close(); };
  m.wrap.querySelector('#discardAndInstall').onclick = () => { m.close(); runUpdateInstall(installModal, { discardUnsaved: true }); };
};

// The desktop process keeps its own copy of the guard state so the
// update-install IPC enforces it even if a caller skips these dialogs.
updateGuard.onChange((s) => window.electronAPI?.reportUpdateGuard?.(s));
window.electronAPI?.reportUpdateGuard?.(updateGuard.state());

const onUpdateButtonClick = async () => {
  const status = updateUi.state?.status;
  if (status === 'available') return promptDownloadUpdate();
  if (status === 'downloaded') return promptInstallUpdate();
  updateUi.manualCheck = true;
  try { await window.electronAPI.checkForUpdates(); } catch { toast('בדיקת העדכון נכשלה. נסו שוב מאוחר יותר.', 'danger'); updateUi.manualCheck = false; }
};

if (window.electronAPI?.getUpdateState) {
  window.electronAPI.onUpdateStatus((s) => {
    const previous = updateUi.state?.status;
    updateUi.state = s;
    renderUpdateButton();
    if (s.status === 'downloaded' && previous !== 'downloaded') promptInstallUpdate();
    if (updateUi.manualCheck && s.status === 'uptodate') { toast('האפליקציה מעודכנת לגרסה האחרונה', 'success'); updateUi.manualCheck = false; }
    if (updateUi.manualCheck && s.status === 'error') { toast('בדיקת העדכון נכשלה. נסו שוב מאוחר יותר.', 'danger'); updateUi.manualCheck = false; }
    if (s.status === 'available' && previous !== 'available' && previous !== 'idle') toast('נמצא עדכון חדש - לחצו על כפתור העדכון למעלה', 'info');
  });
  window.electronAPI.getUpdateState().then((s) => { updateUi.state = s; renderUpdateButton(); });
}

window.electronAPI?.onNotificationRefresh(() => loadApp());

// Clicking a native toast: focus the app (done by the main process) and land on
// the relevant record; stale/deleted/unauthorized targets fall back to the inbox.
const openAlertTarget = (target) => {
  const route = resolveAlertTarget(target, state);
  state.highlightLicenseId = route.highlightLicenseId || null;
  state.highlightPaymentId = route.highlightPaymentId || null;
  state.highlightAgreementId = route.highlightAgreementId || null;
  state.branchId = route.page === 'branches' ? route.branchId : null;
  state.page = route.page;
  render();
};
window.electronAPI?.onOpenAlert(openAlertTarget);

// Flash a highlighted row once its view has rendered; missing rows just do not flash.
const flashRow = (selector) => {
  const row = document.querySelector(selector);
  if (!row) return;
  row.classList.add('row-flash');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => row.classList.remove('row-flash'), 4000);
};
setInterval(() => { if (state.user) loadApp(); }, 10 * 60 * 1000);
let lastDueCount = -1;
setInterval(() => { if (!state.user) return; runToasts(); if (state.user.role === 'Manager') { const n = dueTaskAlerts().length; if (lastDueCount !== -1 && n !== lastDueCount) render(); lastDueCount = n; } }, 60 * 1000);
// Back online: renew the session and re-run whichever "ניסיון חוזר" panel is on screen, so the user does not have to find the button.
window.addEventListener('online', async () => {
  if (!state.user) return;
  const btn = document.querySelector('[id^="retry"]'); if (!btn) return;
  const gen = sessionGen;
  const fresh = await renewToken();
  // Only retry if the renewal worked, this is still the same session, and that exact button is still on screen:
  // otherwise a detached or late click could draw an error panel over a login screen.
  if (!fresh || gen !== sessionGen || !state.user || !btn.isConnected) return;
  btn.click();
});
const resetLinkMatch = location.hash.match(/^#reset=([0-9a-f]{64})$/);
if (resetLinkMatch) {
  renderReset(resetLinkMatch[1]);
} else {
  loadApp().catch((error) => { renderAuth(); toast(error.message || 'לא ניתן לפתוח את KinderGuard כרגע.', 'danger'); });
}
