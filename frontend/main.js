import { createUpdateGuard } from './updateGuard.js';
import { SEEN_KEY, SESSION_KEY, planNativeToasts, resolveAlertTarget, alertToastPayload, summaryToastPayload, testToastPayloads } from './nativeNotify.js';

const app = document.getElementById('app');
// Show where this UI is actually served from (embedded loopback on the
// developer's PC, or the hosted server for the website/client mode).
{ const el = document.getElementById('server-origin'); if (el) el.textContent = 'שרת: ' + location.host; }

const headerActions = document.getElementById('header-actions');
// Tracks unsaved form input and in-flight uploads so the self-closing update
// install can demand an explicit save/discard decision first.
const updateGuard = createUpdateGuard();
window.__updateGuard = updateGuard;
const state = { user: null, branches: [], licenses: [], types: [], alerts: [], tasks: [], taskFilter: 'all', taskScope: 'mine', page: 'branches', branchId: null, token: null, cardFilter: null, rent: null, rentAuthorityFilter: null };
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (value) => value ? new Date(value).toLocaleDateString('he-IL') : '—';
const api = async (url, options = {}) => {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  const method = (options.method || 'GET').toUpperCase();
  const isMutating = !['GET', 'HEAD'].includes(method);
  const isUpload = options.body instanceof FormData;
  if (isMutating) updateGuard.mutationStarted({ upload: isUpload });
  try {
    return await apiRequest(url, options, headers);
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
  if (!response.ok) { const error = new Error(data.message || 'הפעולה לא הושלמה. נסו שוב.'); error.status = response.status; error.fields = data.errors || []; throw error; }
  return data;
};
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
  headerActions.innerHTML = '';
  app.innerHTML = `<section class="auth-layout"><div class="auth-intro"><div class="eyebrow">ניהול אישורים למעונות יום</div><h2>כל הסניפים.<br>כל האישורים.<br><span>בלי לפספס חידוש.</span></h2><p>מקום אחד לעקוב אחרי אישורים, מועדי פקיעה ומשימות חידוש.</p><div class="auth-decoration"><span>✓</span><span>30 יום</span><span>7 ימים</span><span>יום הפקיעה</span></div></div><div class="panel auth-panel"><div class="tabs"><button class="tab active" data-tab="login">התחברות</button><button class="tab" data-tab="register">פתיחת חשבון מנהל</button></div><form id="authForm"><label>כתובת דוא״ל<input name="email" type="email" autocomplete="username" required></label><label>סיסמה<input name="password" type="password" autocomplete="current-password" minlength="8" required></label><div id="nameField" hidden><label>שם מלא<input name="name" autocomplete="name"></label></div><button class="primary full" type="submit">התחברות</button><p id="authHint" class="muted">התחברו לחשבון KinderGuard שלכם.</p></form></div></section>`;
  let mode = 'login';
  app.querySelectorAll('[data-tab]').forEach((button) => button.onclick = () => {
    mode = button.dataset.tab;
    app.querySelectorAll('[data-tab]').forEach((item) => item.classList.toggle('active', item === button));
    const register = mode === 'register';
    document.getElementById('nameField').hidden = !register;
    document.querySelector('#authForm button').textContent = register ? 'יצירת חשבון מנהל' : 'התחברות';
    document.getElementById('authHint').textContent = register ? 'פתיחת חשבון מנהל ראשי. משתמשים נוספים יוזמנו מתוך המערכת.' : 'התחברו לחשבון KinderGuard שלכם.';
  });
  document.getElementById('authForm').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    try {
      const endpoint = mode === 'register' ? '/api/users/register' : '/api/users/login';
      const result = await api(endpoint, { method: 'POST', body: JSON.stringify({ name: form.get('name'), email: form.get('email'), password: form.get('password') }) });
      state.token = result.token; await loadApp();
    } catch (error) { toast(error.message, 'danger'); }
  };
};

let isLoading = false;
const loadApp = async () => {
  if (isLoading) return;
  isLoading = true;
  try {
    const refreshed = await api('/api/auth/refresh', { method: 'POST' });
    state.token = refreshed.token;
    state.user = await api('/api/users/me');
    [state.branches, state.licenses, state.alerts, state.tasks] = await Promise.all([api('/api/branches'), api('/api/licenses'), api('/api/notifications'), api('/api/tasks')]);
    state.types = await api('/api/license-types');
    if (state.branchId && !state.branches.some((b) => b._id === state.branchId)) state.branchId = null;
    render();
    // Native Windows toasts: one summary on the first refresh of the session
    // (no burst after the app was closed), individual typed toasts afterwards.
    // Works while the window is hidden to the tray; nothing runs once quit.
    const seen = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    const firstOfSession = !sessionStorage.getItem(SESSION_KEY);
    sessionStorage.setItem(SESSION_KEY, '1');
    const plan = planNativeToasts(state.alerts, { seenIds: seen, firstOfSession });
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
  } catch (error) {
    if (error.status === 401) { state.user = null; state.token = null; renderAuth(); }
    else { if (!state.user) renderAuth(); toast(error.message, 'danger'); }
  }
  finally { isLoading = false; }
};
const statusText = (status) => ({ Valid: 'בתוקף', Expiring_Soon: 'לקראת פקיעה', Expired: 'פג תוקף' }[status] || status);
const statusClass = (status) => ({ Valid: 'good', Expiring_Soon: 'warning', Expired: 'danger' }[status] || 'neutral');
const branchName = (id) => state.branches.find((b) => b._id === (id?._id || id))?.name || id?.name || 'סניף';
const typeName = (id) => state.types.find((t) => t._id === (id?._id || id))?.name || id?.name || 'אישור';
const currentAlerts = () => state.alerts.filter((a) => ['Open', 'In_Progress'].includes(a.status));
const renderHeader = () => {
  headerActions.innerHTML = `<nav class="nav"><button data-page="branches" class="${state.page === 'branches' ? 'selected' : ''}">הסניפים שלי</button><button data-page="alerts" class="${state.page === 'alerts' ? 'selected' : ''}">התראות <b class="nav-count">${currentAlerts().length}</b></button><button data-page="tasks" class="${state.page === 'tasks' ? 'selected' : ''}">משימות <b class="nav-count">${state.tasks.filter((task) => task.status !== 'Done').length}</b></button>${state.user.role === 'Admin' ? `<button data-page="rent" class="${state.page === 'rent' ? 'selected' : ''}">שכירות</button><button data-page="settings" class="${state.page === 'settings' ? 'selected' : ''}">הגדרות וצוות</button>` : ''}</nav><div class="user-menu"><span class="user-avatar">${esc(state.user.name.slice(0, 1))}</span><span class="user-name">${esc(state.user.name)}<small>${state.user.role === 'Admin' ? 'מנהל חשבון' : 'משתמש'}</small></span><button class="icon-button" id="logout" title="התנתקות">↪</button></div>`;
  headerActions.querySelectorAll('[data-page]').forEach((button) => button.onclick = () => { state.page = button.dataset.page; state.branchId = null; render(); });
  document.getElementById('logout').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} state.user = null; state.token = null; renderAuth(); };
};
const render = () => { renderHeader(); if (state.page === 'alerts') return renderAlerts(); if (state.page === 'tasks') return renderTasks(); if (state.page === 'rent') return renderRent(); if (state.page === 'settings') return renderSettings(); if (state.branchId) return renderBranch(); return renderBranches(); };

const renderBranches = () => {
  // Only daycare branches carry permits; rented properties (offices) live in
  // the rent module and never appear here.
  const daycares = state.branches.filter((b) => b.kind !== 'property');
  const alerts = currentAlerts();
  const overdue = state.licenses.filter((l) => l.status === 'Expired').length;
  const soon = state.licenses.filter((l) => l.status === 'Expiring_Soon').length;
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז הבקרה</div><h2>שלום ${esc(state.user.name)}, מה מצב האישורים?</h2><p>סקירה עדכנית של הסניפים והמשימות שדורשות תשומת לב.</p></div>${state.user.role === 'Admin' ? '<button id="newBranch" class="primary">＋ הוספת סניף</button>' : ''}</section><section class="stats-grid"><article class="stat-card clickable" data-card-filter="" role="button" tabindex="0" aria-pressed="${state.cardFilter === null}" title="הצגת כל הסניפים"><span class="stat-icon teal">⌂</span><div><strong>${daycares.length}</strong><small>סניפים</small></div></article><article class="stat-card clickable${state.cardFilter === 'expiring' ? ' selected' : ''}" data-card-filter="expiring" role="button" tabindex="0" aria-pressed="${state.cardFilter === 'expiring'}" title="הצגת סניפים עם אישורים לקראת פקיעה"><span class="stat-icon amber">◷</span><div><strong>${soon}</strong><small>אישורים לקראת פקיעה</small></div></article><article class="stat-card clickable${state.cardFilter === 'expired' ? ' selected' : ''}" data-card-filter="expired" role="button" tabindex="0" aria-pressed="${state.cardFilter === 'expired'}" title="הצגת סניפים עם אישורים שפג תוקפם"><span class="stat-icon coral">!</span><div><strong>${overdue}</strong><small>אישורים שפג תוקפם</small></div></article><article class="stat-card clickable" id="alertsSummary"><span class="stat-icon blue">♧</span><div><strong>${alerts.length}</strong><small>התראות לטיפול</small></div></article></section><section class="section-heading"><div><h3>הסניפים שלך</h3><p>בחרו סניף כדי לראות את כל האישורים וההיסטוריה שלו</p></div><span class="muted">${daycares.length} סניפים</span></section>${daycares.length ? '<div class="search-row"><input type="search" class="search-input" id="branchSearch" placeholder="חיפוש סניף לפי שם או כתובת" aria-label="חיפוש סניף"></div>' : ''}<section class="branch-grid" id="branchGrid">${daycares.length ? daycares.map((branch) => { const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id); const expiring = licenses.filter((l) => l.status === 'Expiring_Soon').length; const expiredCount = licenses.filter((l) => l.status === 'Expired').length; return `<article class="branch-card" data-branch="${branch._id}" data-search="${esc((branch.name || '') + ' ' + (branch.address || ''))}" role="button" tabindex="0" aria-label="${esc(branch.name)}"><div class="branch-card-top"><span class="branch-symbol">⌂</span><span class="branch-card-actions">${state.user.role === 'Admin' ? `<button class="icon-button branch-delete" data-delete-branch="${branch._id}" title="מחיקת סניף" aria-label="מחיקת ${esc(branch.name)}">🗑</button>` : ''}<span class="arrow">←</span></span></div><h3>${esc(branch.name)}</h3><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p>${branch.managerName ? `<p class="muted small-text">מנהלת: ${esc(branch.managerName)}${branch.phone ? ` · ${esc(branch.phone)}` : ''}</p>` : ''}<div class="branch-card-bottom"><span>${licenses.length} אישורים</span><span class="branch-signals">${expiredCount ? `<i class="dot danger"></i>${expiredCount} פגו` : ''}${expiring ? `<i class="dot warning"></i>${expiring} לקראת פקיעה` : ''}${!expiredCount && !expiring ? '<i class="dot good"></i>הכול תקין' : ''}</span></div></article>`; }).join('') : `<div class="empty-state"><span>⌂</span><h3>עוד אין סניפים</h3><p>הוסיפו את הסניף הראשון כדי להתחיל לנהל את האישורים שלו.</p></div>`}</section><div class="empty-state" id="noBranchMatches" hidden><span>⌂</span><h3>לא נמצאו סניפים תואמים</h3><p>נסו לשנות את מילות החיפוש.</p></div>`;
  document.getElementById('alertsSummary').onclick = () => { state.page = 'alerts'; render(); };
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
  if (noMatches) noMatches.hidden = visible !== 0;
};

const renderBranch = async () => {
  const branch = state.branches.find((b) => b._id === state.branchId); if (!branch) { state.branchId = null; return renderBranches(); }
  const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id);
  let types;
  try { types = await api(`/api/license-types?branchId=${branch._id}`); }
  catch (error) { app.innerHTML = `<button class="back-link" id="back">← כל הסניפים</button><section class="panel"><h3>לא ניתן לטעון את פרטי הסניף</h3><p>${esc(error.message)}</p><button class="secondary" id="retryBranch">ניסיון חוזר</button></section>`; document.getElementById('back').onclick = () => { state.branchId = null; renderBranches(); }; document.getElementById('retryBranch').onclick = renderBranch; return; }
  app.innerHTML = `<button class="back-link" id="back">← כל הסניפים</button><section class="branch-title"><div><div class="eyebrow">פרטי סניף</div><h2>${esc(branch.name)}</h2><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p></div><div class="button-row">${state.user.role === 'Admin' ? '<button class="secondary" id="editBranch">✎ עריכת פרטים</button><button class="secondary" id="addType">＋ סוג אישור</button>' : ''}<button class="primary" id="addLicense">＋ העלאת אישור</button></div></section>${branch.managerName || branch.phone || (branch.emails || []).length || branch.authorityId ? `<section class="panel"><div class="section-heading"><div><h3>אנשי קשר ושיוך</h3></div></div><div class="contact-grid">${branch.managerName ? `<div><span class="muted">מנהלת</span><strong>${esc(branch.managerName)}</strong></div>` : ''}${branch.phone ? `<div><span class="muted">טלפון</span><strong dir="ltr">${esc(branch.phone)}</strong></div>` : ''}${(branch.emails || []).length ? `<div><span class="muted">מיילים</span><strong>${branch.emails.map((em) => esc(em)).join(', ')}</strong></div>` : ''}${branch.authorityId ? `<div><span class="muted">מקבל התשלום (שכירות)</span><strong>${esc(branch.authorityId.name || '')}${branch.authorityId.type === 'private' ? ' · פרטי' : ''}</strong></div>` : ''}</div></section>` : ''}<section class="stats-grid compact"><article class="stat-card"><div><strong>${licenses.length}</strong><small>אישורים פעילים</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Valid').length}</strong><small>בתוקף</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Expiring_Soon').length}</strong><small>לקראת פקיעה</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Expired').length}</strong><small>פגו</small></div></article></section><section class="panel"><div class="section-heading"><div><h3>אישורי הסניף</h3><p>האישור החדש ביותר מכל סוג מוצג כאן</p></div><span class="muted">${licenses.length} פעילים</span></div>${licenses.length ? `<input type="search" class="search-input" id="licenseSearch" placeholder="חיפוש אישור לפי סוג או שם קובץ" aria-label="חיפוש אישור"><div class="license-list" id="licenseList">${licenses.map((license) => `<article class="license-row" data-license-id="${license._id}" data-search="${esc(typeName(license.licenseTypeId) + ' ' + (license.fileName || ''))}"><div class="license-icon ${statusClass(license.status)}">▤</div><div class="license-main"><strong>${esc(typeName(license.licenseTypeId))}</strong><small>תוקף ${date(license.issueDate)} — ${date(license.expiryDate)} ${license.fileName && license.fileUrl ? `· <button class="file-link link-button" data-open-file="${license._id}">${esc(license.fileName)}</button>` : ''}</small></div><span class="status-pill ${statusClass(license.status)}">${statusText(license.status)}</span><button class="text-button" data-history="${license._id}">היסטוריה</button></article>`).join('')}</div><div class="empty-state small" id="noLicenseMatches" hidden><span>▤</span><h3>לא נמצאו אישורים תואמים</h3><p>נסו לשנות את מילות החיפוש.</p></div>` : `<div class="empty-state small"><span>▤</span><h3>אין עדיין אישורים בסניף</h3><p>הגדירו סוג אישור והעלו את המסמך הראשון.</p></div>`}</section><section class="panel"><div class="section-heading"><div><h3>סוגי האישורים לסניף</h3><p>סוגים כלליים וגם סוגים שהוגדרו רק לסניף זה</p></div></div><div class="type-chips">${types.map((t) => `<span class="type-chip">${esc(t.name)}${t.branchId ? '<small>סניף זה</small>' : '<small>כל הסניפים</small>'}</span>`).join('') || '<span class="muted">לא הוגדרו עדיין סוגי אישור</span>'}</div></section><section id="historyPanel"></section>`;
  document.getElementById('back').onclick = () => { state.branchId = null; renderBranches(); };
  document.getElementById('addLicense').onclick = () => licenseForm(branch, types);
  document.getElementById('addType')?.addEventListener('click', () => licenseTypeForm(branch));
  document.getElementById('editBranch')?.addEventListener('click', () => branchForm(branch));
  app.querySelectorAll('[data-open-file]').forEach((button) => button.onclick = () => openLicenseFile(button.dataset.openFile));
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
  };
  app.querySelectorAll('[data-history]').forEach((button) => button.onclick = async () => {
    let rows;
    try { rows = await api(`/api/licenses/${button.dataset.history}/history`); } catch (error) { toast(error.message, 'danger'); return; }
    const panel = document.getElementById('historyPanel');
    panel.innerHTML = `<section class="panel"><div class="section-heading"><div><h3>היסטוריית חידושים · ${esc(typeName(rows[0]?.licenseTypeId))}</h3><p>הגרסאות הקודמות נשמרות לעיון</p></div><button class="icon-button" id="closeHistory">×</button></div><div class="history-list">${rows.map((row) => `<div class="history-row"><span class="history-mark">${row.lifecycle === 'Active' ? 'פעיל' : 'הוחלף'}</span><strong>${date(row.issueDate)} — ${date(row.expiryDate)}</strong><span>${row.fileName && row.fileUrl ? `<button class="file-link link-button" data-open-file="${row._id}">${esc(row.fileName)}</button>` : 'ללא קובץ מצורף'}</span><span class="muted">הועלה ${date(row.createdAt)}</span></div>`).join('')}</div></section>`;
    document.getElementById('closeHistory').onclick = () => panel.innerHTML = '';
    panel.querySelectorAll('[data-open-file]').forEach((button) => button.onclick = () => openLicenseFile(button.dataset.openFile));
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
      await api(`/api/branches/${branch._id}`, { method: 'DELETE' });
      m.close();
      toast('הסניף נמחק', 'success');
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
  const m = modal('העלאת אישור שהתקבל', `<form id="licenseForm" class="form-grid"><label>סניף<select name="branchId" required>${branchOptions}</select></label><label>סוג אישור<select name="licenseTypeId" required>${initialTypes.map((t) => `<option value="${t._id}">${esc(t.name)}</option>`).join('')}</select></label><div class="two-col"><label>תאריך תחילת תוקף<input name="issueDate" type="date" required></label><label>תאריך פקיעה<input name="expiryDate" type="date" required></label></div><label class="file-field">מסמך (PDF או תמונה)<input name="file" type="file" accept=".pdf,image/*"><small>עד 15MB. בהעלאת חידוש, האישור הקודם יישמר בהיסטוריה.</small></label><button class="primary" ${initialTypes.length ? '' : 'disabled'}>שמירת אישור</button>${initialTypes.length ? '' : '<p class="inline-hint">קודם הגדירו סוג אישור לסניף הזה.</p>'}</form>`);
  if (!selectedBranch) m.wrap.querySelector('[name="branchId"]').onchange = async (event) => {
    let types;
    try { types = await api(`/api/license-types?branchId=${event.target.value}`); } catch (error) { toast(error.message, 'danger'); return; }
    const select = m.wrap.querySelector('[name="licenseTypeId"]'); select.innerHTML = types.map((t) => `<option value="${t._id}">${esc(t.name)}</option>`).join('');
    const submit = m.wrap.querySelector('button.primary'); submit.disabled = !types.length;
  };
  if (!selectedBranch && state.branches.length) m.wrap.querySelector('[name="branchId"]').dispatchEvent(new Event('change'));
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (new Date(f.get('expiryDate')) < new Date(f.get('issueDate'))) return toast('תאריך הפקיעה חייב להיות אחרי תאריך ההתחלה', 'warning'); try { await api('/api/licenses', { method: 'POST', body: f }); m.close(); toast('האישור נשמר. אם היה אישור קודם, הוא הועבר להיסטוריה.', 'success'); await loadApp(); if (state.branchId) await renderBranch(); } catch (error) { toast(error.message, 'danger'); } };
};

const renderAlerts = () => {
  const open = state.alerts.filter((a) => ['Open', 'In_Progress'].includes(a.status)); const done = state.alerts.filter((a) => ['Resolved', 'Dismissed'].includes(a.status));
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז טיפול</div><h2>התראות</h2><p>תזכורות חידוש אישורים ותזכורות תשלומי שכירות נשמרות כאן עד לסגירת הטיפול.</p></div><span class="inbox-total">${open.length} ממתינות לטיפול</span></section><section class="panel"><div class="section-heading"><div><h3>ממתינות לטיפול</h3><p>אישורים: 30 יום, 7 ימים וביום הפקיעה · שכירות: שבוע לפני פרעון וחודש לפני סיום סדרת צ'קים</p></div></div>${open.length ? `<div class="alert-list">${open.map((item) => alertCard(item)).join('')}</div>` : `<div class="empty-state small"><span>✓</span><h3>אין התראות פתוחות</h3><p>כל ההתראות טופלו. נעדכן אתכם כשיגיע מועד חידוש.</p></div>`}</section><section class="panel"><details><summary>התראות שטופלו (${done.length})</summary><div class="alert-list archived">${done.map((item) => alertCard(item, true)).join('') || '<p class="muted">אין עדיין התראות שטופלו.</p>'}</div></details></section>`;
  app.querySelectorAll('[data-alert-action]').forEach((button) => button.onclick = async () => { try { await api(`/api/notifications/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.alertAction }) }); await loadApp(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-alert-branch]').forEach((button) => button.onclick = () => { state.branchId = button.dataset.alertBranch; state.page = 'branches'; render(); });
  app.querySelectorAll('[data-alert-rent]').forEach((button) => button.onclick = () => { state.page = 'rent'; render(); });
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
    return `<article class="alert-card ${isSeries ? 'urgent' : ''}"><div class="alert-marker ${isSeries ? 'warning' : 'blue'}">₪</div><div class="alert-copy"><div class="alert-heading"><strong>${title}</strong><span class="status-pill ${isSeries ? 'warning' : 'neutral'}">${isSeries ? 'חודש מראש' : 'שבוע מראש'}</span><span class="muted">${stateLabel}</span></div><p><button class="inline-link" data-alert-rent="1">${detail}</button></p></div>${archived ? '' : `<div class="alert-actions"><button class="secondary small-btn" data-id="${item._id}" data-alert-action="In_Progress">${item.status === 'In_Progress' ? 'בטיפול ✓' : 'התחל טיפול'}</button><button class="primary small-btn" data-id="${item._id}" data-alert-action="Resolved">סימון כטופל</button></div>`}</article>`;
  }
  const license = item.licenseId || {}; const kind = item.triggerDays === 30 ? '30 יום מראש' : item.triggerDays === 7 ? 'שבוע מראש' : 'היום';
  return `<article class="alert-card ${item.triggerDays === 0 ? 'urgent' : ''}"><div class="alert-marker ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'blue'}">${item.triggerDays === 0 ? '!' : '◷'}</div><div class="alert-copy"><div class="alert-heading"><strong>${esc(typeName(license.licenseTypeId))}</strong><span class="status-pill ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'neutral'}">${kind}</span><span class="muted">${stateLabel}</span></div><p><button class="inline-link" data-alert-branch="${item.branchId?._id || item.branchId}">${esc(branchName(item.branchId))}</button> · פקיעה ${date(license.expiryDate)}</p></div>${archived ? '' : `<div class="alert-actions"><button class="secondary small-btn" data-id="${item._id}" data-alert-action="In_Progress">${item.status === 'In_Progress' ? 'בטיפול ✓' : 'התחל טיפול'}</button><button class="primary small-btn" data-id="${item._id}" data-alert-action="Resolved">סימון כטופל</button></div>`}</article>`;
};

// ----- משימות כלליות -----
const taskStatusText = (status) => ({ To_Do: 'לביצוע', In_Progress: 'בטיפול', Done: 'בוצע' }[status] || status);
const taskStatusClass = (status) => ({ To_Do: 'neutral', In_Progress: 'warning', Done: 'good' }[status] || 'neutral');
const taskFilters = [['all', 'הכל'], ['To_Do', 'לביצוע'], ['In_Progress', 'בטיפול'], ['Done', 'בוצע']];

const renderTasks = async () => {
  const isTeam = state.user.role === 'Admin' && state.taskScope === 'team';
  let tasks;
  try { tasks = await api(`/api/tasks${isTeam ? '?scope=all' : ''}`); } catch (error) { app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את המשימות</h3><p>${esc(error.message)}</p><button class="secondary" id="retryTasks">ניסיון חוזר</button></section>`; document.getElementById('retryTasks').onclick = renderTasks; return; }
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
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">לוח משימות</div><h2>משימות כלליות לביצוע</h2><p>כל מה שצריך לעשות במעונות, במקום אחד - עם סטטוס טיפול.</p></div><button class="primary" id="newTask">＋ משימה חדשה</button></section><section class="panel">${state.user.role === 'Admin' ? `<div class="tabs" style="margin-bottom:16px"><button class="tab${isTeam ? '' : ' active'}" data-task-scope="mine">המשימות שלי</button><button class="tab${isTeam ? ' active' : ''}" data-task-scope="team">של כל הצוות</button></div>${isTeam ? '<p class="muted" style="margin:0 0 12px">תצוגת צוות לצפייה בלבד - משימה מעדכנים רק על ידי מי שפתח אותה.</p>' : ''}` : ''}<div class="task-filters">${taskFilters.map(([filter, label]) => `<button class="${state.taskFilter === filter ? 'primary' : 'secondary'} small-btn" data-task-filter="${filter}">${label} · ${countFor(filter)}</button>`).join('')}</div><div style="margin-top:10px">${ordered.length ? ordered.map((task) => taskRow(task)).join('') : `<div class="empty-state small"><span>✓</span><h3>${tasks.length ? 'אין משימות בסינון הזה' : 'אין עדיין משימות'}</h3><p>${tasks.length ? 'נסו סינון אחר.' : 'הוסיפו משימה ראשונה כדי לעקוב אחרי מה שצריך לעשות.'}</p></div>`}</div></section>`;
  document.getElementById('newTask').onclick = () => taskForm();
  app.querySelectorAll('[data-task-scope]').forEach((button) => button.onclick = () => { state.taskScope = button.dataset.taskScope; renderTasks(); });
  app.querySelectorAll('[data-task-filter]').forEach((button) => button.onclick = () => { state.taskFilter = button.dataset.taskFilter; renderTasks(); });
  app.querySelectorAll('[data-task-toggle]').forEach((button) => button.onclick = async () => { try { await api(`/api/tasks/${button.dataset.taskToggle}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.done === '1' ? 'To_Do' : 'Done' }) }); await renderTasks(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-task-edit]').forEach((button) => button.onclick = () => { const task = tasks.find((item) => item._id === button.dataset.taskEdit); if (task) taskForm(task); });
  app.querySelectorAll('[data-task-delete]').forEach((button) => button.onclick = async () => { if (!confirm('למחוק את המשימה?')) return; try { await api(`/api/tasks/${button.dataset.taskDelete}`, { method: 'DELETE' }); toast('המשימה נמחקה', 'success'); await renderTasks(); } catch (error) { toast(error.message, 'danger'); } });
};

const taskRow = (task) => {
  const done = task.status === 'Done';
  const overdue = task.dueDate && !done && new Date(task.dueDate) < new Date(new Date().toDateString());
  const branch = task.branchId ? branchName(task.branchId) : 'כל הסניפים';
  const creator = task.createdBy?.name || '';
  const meta = done
    ? `${creator ? `נוצר על ידי ${esc(creator)} · ` : ''}בוצע ${date(task.completedAt)}`
    : `${creator ? `נוצר על ידי ${esc(creator)} · ` : ''}${esc(branch)}${task.dueDate ? ` · עד ${date(task.dueDate)}` : ''}`;
  return `<article class="task-row"><button class="task-check${done ? ' done' : ''}${task.editable ? '' : ' readonly'}" ${task.editable ? `data-task-toggle="${task._id}" data-done="${done ? 1 : 0}"` : 'disabled'} title="${task.editable ? (done ? 'סימון כלביצוע' : 'סימון כבוצע') : 'צפייה בלבד - רק מי שפתח את המשימה מעדכן אותה'}" aria-label="${done ? 'סמנו כלביצוע' : 'סמנו כבוצע'}">${done ? '✓' : ''}</button><div class="task-main"><strong>${esc(task.title)}</strong><small class="${overdue ? 'task-overdue' : ''}">${meta}${overdue ? ' · באיחור' : ''}${task.notes ? ` · ${esc(task.notes)}` : ''}</small></div><span class="status-pill ${taskStatusClass(task.status)}">${taskStatusText(task.status)}</span>${task.editable ? `<span class="task-actions"><button class="icon-button" data-task-edit="${task._id}" title="עריכת משימה" aria-label="עריכה">✎</button><button class="icon-button branch-delete" data-task-delete="${task._id}" title="מחיקת משימה" aria-label="מחיקה">🗑</button></span>` : ''}</article>`;
};

const taskForm = (task = null) => {
  const m = modal(task ? 'עריכת משימה' : 'משימה חדשה', `<form id="taskForm" class="form-grid"><label>כותרת המשימה<input name="title" required maxlength="200" value="${esc(task?.title || '')}"></label><label>הערות (לא חובה)<input name="notes" maxlength="2000" value="${esc(task?.notes || '')}"></label><div class="two-col"><label>תאריך יעד (לא חובה)<input name="dueDate" type="date" value="${task?.dueDate ? new Date(task.dueDate).toISOString().slice(0, 10) : ''}"></label><label>סניף<select name="branchId"><option value="">כל הסניפים</option>${state.branches.map((branch) => `<option value="${branch._id}"${String(task?.branchId?._id || task?.branchId || '') === String(branch._id) ? ' selected' : ''}>${esc(branch.name)}</option>`).join('')}</select></label></div>${task ? `<label>סטטוס<select name="status">${taskFilters.slice(1).map(([value, label]) => `<option value="${value}"${task.status === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>` : ''}<button class="primary">${task ? 'שמירת שינויים' : 'יצירת משימה'}</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (event) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const payload = { title: form.get('title'), notes: form.get('notes') || '', dueDate: form.get('dueDate') || null, branchId: form.get('branchId') || null };
    if (task) payload.status = form.get('status');
    try {
      await api(task ? `/api/tasks/${task._id}` : '/api/tasks', { method: task ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      m.close(); toast(task ? 'המשימה עודכנה' : 'המשימה נוצרה', 'success'); await renderTasks();
    } catch (error) { toast(error.message, 'danger'); }
  };
};

// ----- שכירות: מעקב תשלומים לרשויות (תיעוד בלבד, ללא העברת כסף) -----
const money = (value) => `₪${Number(value || 0).toLocaleString('he-IL')}`;
const rentFrequencyText = (value) => ({ monthly: 'חודשי', quarterly: 'רבעוני', annual: 'שנתי', custom: 'מועדים מותאמים' }[value] || value);
const rentMethodText = (value) => ({ cheque: "צ'ק", transfer: 'העברה בנקאית' }[value] || value);
const rentStatusPill = (status) => ({ Pending: ['neutral', 'ממתין'], Handed: ['warning', "צ'ק נמסר · טרם נפרע"], Cleared: ['good', 'נפרע'], Cancelled: ['neutral', 'בוטל'] }[status] || ['neutral', status]);

const renderRent = async () => {
  let data;
  try { data = await api('/api/rent/summary'); }
  catch (error) {
    app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את נתוני השכירות</h3><p>${esc(error.message)}</p><button class="secondary" id="retryRent">ניסיון חוזר</button></section>`;
    document.getElementById('retryRent').onclick = renderRent;
    return;
  }
  state.rent = data;
  const { authorities, agreements, payments, groups = [], totals } = data;
  const active = agreements.filter((a) => a.status === 'Active');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const in30 = new Date(today.getTime() + 30 * 86400000);
  const upcoming = payments.filter((p) => ['Pending', 'Handed'].includes(p.status) && new Date(p.dueDate) <= in30);
  const handedCount = payments.filter((p) => p.status === 'Handed').length;
  const annualTotal = active.reduce((sum, a) => sum + (a.annualAmount || 0), 0);
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
      <div class="license-main"><strong>${esc(agreement.branchId?.name || 'סניף')}${agreement.branchId?.kind === 'property' ? ' <span class="muted">(משרד)</span>' : ''}${agreement.direction === 'incoming' ? ' <span class="muted">(הגוף משלם לנו)</span>' : ''}</strong><small>${agreement.frequency ? `${rentFrequencyText(agreement.frequency)} · ${rentMethodText(agreement.paymentMethod)} · ` : ''}${next ? `פרעון הבא ${date(next.dueDate)} · ${money(next.amount)}` : (agreement.monthlyAmount == null ? 'הסכום והמועדים יוזנו בהמשך' : 'אין מועד קרוב')}${series}</small></div>
      <span class="amount-cell">${agreement.monthlyAmount != null ? `${money(agreement.monthlyAmount)} / חודש` : 'טרם הוזן'}</span>
      <span class="status-pill ${pillClass}">${pillText}</span>
      ${next && agreement.paymentMethod === 'cheque' && next.status === 'Pending' ? `<button class="text-button" data-rent-handed="${next._id}">סמן כנמסר</button>` : ''}
      ${next ? `<button class="text-button" data-rent-cleared="${next._id}">סמן כנפרע</button>` : ''}
      <button class="text-button" data-rent-history="${agreement._id}">היסטוריה</button>
      ${agreement.paymentMethod === 'cheque' ? `<button class="text-button" data-rent-series="${agreement._id}">סדרת צ'קים</button>` : ''}
      <button class="text-button danger-text" data-rent-close="${agreement._id}">סגירת הסכם</button>
    </article>`;
  };
  const authorityPanel = (authority) => {
    const list = active.filter((a) => String(a.authorityId?._id || a.authorityId) === authority._id);
    const total = totals[authority._id] || { monthly: 0, annual: 0 };
    return `<section class="panel"><div class="section-heading"><div><h3>${esc(authority.name)}${authority.type === 'private' ? ' <small class="muted">(פרטי)</small>' : ''}</h3><p>${list.length} הסכמים פעילים</p></div><span class="authority-total">סה״כ לרשות: ${money(total.monthly)} לחודש · ${money(total.annual)} לשנה</span></div>${list.length ? `<div class="license-list">${list.map(agreementRow).join('')}</div>` : '<div class="empty-state small"><span>₪</span><h3>אין הסכמים פעילים ברשות</h3><p>הוסיפו הסכם שכירות כדי להתחיל לעקוב.</p></div>'}</section>`;
  };
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">תשלומי שכירות</div><h2>שכירות לרשויות</h2><p>מעקב תשלומי שכר דירה למועצות ולגופים פרטיים לפי מעון. תיעוד בלבד, ללא העברת כסף בפועל.</p></div><div class="button-row"><button class="secondary" id="newAuthority">＋ גוף לתשלום</button><button class="secondary" id="newGroup">₪ תשלום מרוכז</button><button class="primary" id="newAgreement">＋ הסכם שכירות</button></div></section>
  <section class="stats-grid"><article class="stat-card clickable" id="rentAnnualCard" role="button" tabindex="0" title="מעבר לרשויות וההסכמים"><span class="stat-icon teal">₪</span><div><strong>${money(annualTotal)}</strong><small>סה״כ שנתי, כל הרשויות</small></div></article><article class="stat-card clickable" id="rentUpcomingCard" role="button" tabindex="0" title="מעבר לתשלומים הקרובים"><span class="stat-icon amber">${upcoming.length}</span><div><strong>תשלומים קרובים</strong><small>ב־30 הימים הבאים</small></div></article><article class="stat-card clickable" id="rentChecksCard" role="button" tabindex="0" title="רשימת הצ'קים שהופקדו"><span class="stat-icon blue">${handedCount}</span><div><strong>צ'קים מופקדים</strong><small>נמסרו, טרם נפרעו</small></div></article><article class="stat-card clickable" id="rentAlertsCard" role="button" tabindex="0" title="מעבר להתראות השכירות"><span class="stat-icon coral">${rentAlerts}</span><div><strong>תזכורות פעילות</strong><small>מועדי תשלום וסדרות צ'קים</small></div></article></section>
  ${upcoming.length ? `<section class="panel" id="rentUpcomingPanel"><div class="section-heading"><div><h3>תשלומים קרובים</h3><p>30 הימים הבאים, לפי מועד פרעון</p></div></div><div class="license-list">${upcoming.map((p) => { const [cls, txt] = rentStatusPill(p.status); return `<article class="license-row" data-payment-id="${p._id}"><div class="license-icon ${p.status === 'Handed' ? 'warning' : ''}">${p.method === 'cheque' ? '✎' : '⇄'}</div><div class="license-main"><strong>${esc(p.branchName)}</strong><small>${esc(p.authorityName)} · ${rentMethodText(p.method)} · פרעון ${date(p.dueDate)}</small></div><span class="amount-cell">${money(p.amount)}</span><span class="status-pill ${cls}">${txt}</span>${p.method === 'cheque' && p.status === 'Pending' ? `<button class="text-button" data-rent-handed="${p._id}">סמן כנמסר</button>` : ''}<button class="text-button" data-rent-cleared="${p._id}">סמן כנפרע</button></article>`; }).join('')}</div></section>` : ''}
  <div id="rentAuthoritiesTop"></div>${authorities.length ? `<div class="type-chips" style="margin-bottom:18px"><button class="type-chip rent-filter" data-authority="" style="${!filterId ? 'border-color:var(--teal);background:#eaf5f2' : ''}"><strong>כל הרשויות</strong></button>${authorities.map((a) => `<button class="type-chip rent-filter" data-authority="${a._id}" style="${filterId === a._id ? 'border-color:var(--teal);background:#eaf5f2' : ''}">${esc(a.name)}${a.type === 'private' ? ' (פרטי)' : ''}</button>`).join('')}</div>` : ''}
  ${visibleAuthorities.length ? visibleAuthorities.map(authorityPanel).join('') : `<div class="empty-state"><span>₪</span><h3>${authorities.length ? 'לא נמצאה רשות מתאימה' : 'עוד אין רשויות'}</h3><p>${authorities.length ? 'נסו סינון אחר.' : 'הוסיפו את הרשות הראשונה ואז הגדירו הסכם שכירות לכל מעון.'}</p></div>`}
  ${groups.length ? `<section class="panel"><div class="section-heading"><div><h3>תשלומים מרוכזים</h3><p>צ'ק או העברה אחת שמחולקת בין מספר מעונות</p></div></div><div class="license-list">${groups.map((g) => { const [cls, txt] = rentStatusPill(g.status); return `<article class="license-row"><div class="license-icon ${g.status === 'Handed' ? 'warning' : ''}">${g.method === 'cheque' ? '✎' : '⇄'}</div><div class="license-main"><strong>${esc(g.authorityName)} · ${money(g.totalAmount)}</strong><small>${rentMethodText(g.method)} · מועד ${date(g.dueDate)} · ${g.allocations.map((a) => `${esc(a.branchName)} ${money(a.amount)}`).join(' + ')}</small></div><span class="status-pill ${cls}">${txt}</span>${g.method === 'cheque' && g.status === 'Pending' ? `<button class="text-button" data-group-handed="${g._id}">סמן כנמסר</button>` : ''}${['Pending', 'Handed'].includes(g.status) ? `<button class="text-button" data-group-cleared="${g._id}">סמן כנפרע</button><button class="text-button danger-text" data-group-cancel="${g._id}">ביטול</button>` : ''}${['Handed', 'Cleared'].includes(g.status) ? `<button class="text-button" data-group-revert="${g._id}">בטל סימון</button>` : ''}</article>`; }).join('')}</div></section>` : ''}
  <section class="panel"><div class="section-heading"><div><h3>דוח תשלומים בפועל</h3><p>כמה שולם בפועל בתקופה נבחרת - לכל רשות ולכל מעון</p></div></div><form id="paidReportForm" class="form-grid"><div class="three-col"><label>מתאריך<input type="date" name="from" value="${new Date().getFullYear()}-01-01" required></label><label>עד תאריך<input type="date" name="to" value="${new Date().getFullYear()}-12-31" required></label><label>רשות<select name="authorityId"><option value="">כל הרשויות</option>${authorities.map((a) => `<option value="${a._id}">${esc(a.name)}</option>`).join('')}</select></label></div><div class="two-col"><label>התקופה נספרת לפי<select name="dateField"><option value="due">מועד הפרעון המתוכנן (מה היה צריך לשלם, ומה עדיין פתוח)</option><option value="cleared">תאריך הפרעון בפועל (כסף שבאמת יצא בתקופה)</option></select></label><div><button class="secondary small-btn" type="submit">הפק דוח</button></div></div></form><div id="paidReportResults"></div></section>
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
    document.getElementById('closeRentHistory').onclick = () => { panel.innerHTML = ''; };
    panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  cardAction('rentAlertsCard', () => { state.page = 'alerts'; render(); });
  app.querySelectorAll('.rent-filter').forEach((chip) => chip.onclick = () => { state.rentAuthorityFilter = chip.dataset.authority || null; renderRent(); });
  app.querySelectorAll('[data-rent-handed]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payments/${button.dataset.rentHanded}/handed`, { method: 'POST' }); toast('סומן: הצ\'ק נמסר לרשות (טרם נפרע)', 'success'); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-rent-cleared]').forEach((button) => button.onclick = async () => { try { await api(`/api/rent/payments/${button.dataset.rentCleared}/cleared`, { method: 'POST' }); toast('התשלום סומן כנפרע', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-rent-close]').forEach((button) => button.onclick = () => {
    const agreement = agreements.find((a) => a._id === button.dataset.rentClose);
    if (!agreement) return;
    const m = modal('סגירת הסכם שכירות', `<div class="form-grid"><p>לסגור את הסכם השכירות של <strong>${esc(agreement.branchId?.name || 'הסניף')}</strong>?</p><p class="muted">תשלומים עתידיים מתוכננים יבוטלו. היסטוריית התשלומים ששולמו והופקדו נשמרת לעיון.</p><div class="button-row"><button class="danger" id="confirmCloseAgreement">סגירת ההסכם</button><button class="secondary" data-cancel>ביטול</button></div></div>`);
    m.wrap.querySelector('[data-cancel]').onclick = m.close;
    m.wrap.querySelector('#confirmCloseAgreement').onclick = async () => { try { await api(`/api/rent/agreements/${agreement._id}/close`, { method: 'POST' }); m.close(); toast('ההסכם נסגר, ההיסטוריה נשמרה', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } };
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
    <div class="two-col"><label>סכום חודשי (₪)<input name="monthlyAmount" type="number" min="0" step="0.01" placeholder="יוזן בהמשך"></label>
    <label>סכום שנתי (₪)<input name="annualAmount" type="number" min="0" step="0.01" placeholder="ברירת מחדל: חודשי × 12"><small class="muted">אפשר לשנות - למשל בהסכם לחלק משנה</small></label></div>
    <div class="two-col"><label>תדירות תשלום<select name="frequency"><option value="monthly">חודשי</option><option value="quarterly">רבעוני</option><option value="annual">שנתי</option><option value="custom">מועדים מותאמים</option></select></label>
    <label>אמצעי תשלום<select name="paymentMethod"><option value="cheque">צ'ק</option><option value="transfer">העברה בנקאית</option></select></label></div>
    <label>תאריך פרעון ראשון<input name="firstDueDate" type="date"><small class="muted">נדרש רק אחרי שמוזן סכום</small></label>
    <div id="customDatesWrap" hidden><label>מועדי פרעון מותאמים</label><div id="customDates"><input type="date" name="customDate"></div><button type="button" class="secondary small-btn" id="addCustomDate">＋ מועד נוסף</button></div>
    <fieldset id="seriesWrap"><legend class="check-row"><input type="checkbox" name="hasSeries"> הופקדה סדרת צ'קים מראש</legend><div id="seriesFields" hidden><div class="two-col"><label>מספר צ'קים בסדרה<input name="depositedCount" type="number" min="1"></label><label>תאריך סיום הסדרה<input name="seriesEndDate" type="date"></label></div><p class="muted">חודש לפני סיום הסדרה תופיע תזכורת להנפיק סדרה חדשה.</p></div></fieldset>
    <button class="primary">שמירת הסכם</button></form>`);
  const form = m.wrap.querySelector('form');
  form.elements.frequency.onchange = () => { m.wrap.querySelector('#customDatesWrap').hidden = form.elements.frequency.value !== 'custom'; };
  form.elements.hasSeries.onchange = () => { m.wrap.querySelector('#seriesFields').hidden = !form.elements.hasSeries.checked; };
  m.wrap.querySelector('#addCustomDate').onclick = () => { const input = document.createElement('input'); input.type = 'date'; input.name = 'customDate'; m.wrap.querySelector('#customDates').append(input); };
  form.onsubmit = async (e) => {
    e.preventDefault(); const f = new FormData(form);
    const body = {
      branchId: f.get('branchId'), authorityId: f.get('authorityId'), direction: f.get('direction'),
      monthlyAmount: f.get('monthlyAmount') || undefined, annualAmount: f.get('annualAmount') || undefined,
      frequency: f.get('frequency'), paymentMethod: f.get('paymentMethod'), firstDueDate: f.get('firstDueDate') || undefined,
    };
    if (!body.monthlyAmount) { body.frequency = undefined; body.paymentMethod = undefined; }
    if (body.frequency === 'custom') body.customDueDates = f.getAll('customDate').filter(Boolean);
    if (f.get('hasSeries')) body.chequeSeries = { depositedCount: f.get('depositedCount'), seriesEndDate: f.get('seriesEndDate') };
    try { await api('/api/rent/agreements', { method: 'POST', body: JSON.stringify(body) }); m.close(); toast('הסכם השכירות נשמר ומועדי התשלום נוצרו', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); }
  };
};

const rentSeriesForm = (agreement) => {
  const series = agreement.chequeSeries || {};
  const m = modal(`סדרת צ'קים מופקדת · ${esc(agreement.branchId?.name || 'סניף')}`, `<form id="seriesForm" class="form-grid"><p class="muted">עדכנו כשמפקידים סדרה חדשה. התזכורת תופיע שוב חודש לפני סיום הסדרה החדשה.</p><div class="two-col"><label>מספר צ'קים בסדרה<input name="depositedCount" type="number" min="1" value="${series.depositedCount || ''}"></label><label>תאריך סיום הסדרה<input name="seriesEndDate" type="date" value="${series.seriesEndDate ? new Date(series.seriesEndDate).toISOString().slice(0, 10) : ''}" required></label></div><button class="primary">שמירת סדרה</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { await api(`/api/rent/agreements/${agreement._id}`, { method: 'PATCH', body: JSON.stringify({ chequeSeries: { depositedCount: f.get('depositedCount'), seriesEndDate: f.get('seriesEndDate') } }) }); m.close(); toast('סדרת הצ\'קים עודכנה', 'success'); await loadApp(); await renderRent(); } catch (error) { toast(error.message, 'danger'); } };
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
  try { users = await api('/api/users'); } catch (error) { app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את ההגדרות</h3><p>${esc(error.message)}</p><button class="secondary" id="retrySettings">ניסיון חוזר</button></section>`; document.getElementById('retrySettings').onclick = renderSettings; return; }
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">ניהול החשבון</div><h2>הגדרות וצוות</h2><p>הגדירו את האישורים הנדרשים והחליטו למי יש גישה לכל סניף.</p></div></section><section class="settings-grid"><section class="panel"><div class="section-heading"><div><h3>סוגי אישורים</h3><p>לכל הסניפים או לסניף מסוים</p></div><button class="primary small-btn" id="newType">＋ סוג אישור</button></div><div class="settings-types">${state.types.map((type) => `<div class="settings-type"><span>${esc(type.name)}<small>${type.branchId ? `רק ${esc(branchName(type.branchId))}` : 'כל הסניפים'}</small></span><button class="text-button danger-text" data-remove-type="${type._id}">הסרה</button></div>`).join('') || '<p class="muted">עדיין לא הוגדרו סוגי אישורים.</p>'}</div></section><section class="panel"><div class="section-heading"><div><h3>משתמשים</h3><p>משתמשים יכולים לטפל באישורים בסניפים שהוקצו להם</p></div><button class="primary small-btn" id="newUser">＋ הוספת משתמש</button></div><div class="settings-types">${users.map((u) => `<div class="settings-type"><span>${esc(u.name)}<small>${esc(u.email)} · ${u.role === 'Admin' ? 'גישה מלאה לכל הסניפים' : (u.accessibleBranches || []).map((b) => esc(b.name)).join(', ') || 'ללא סניפים'}</small></span><b class="role-label">${u.role === 'Admin' ? 'מנהל שותף' : 'משתמש'}</b></div>`).join('') || '<p class="muted">אין עדיין משתמשים נוספים.</p>'}</div></section><section class="panel"><div class="section-heading"><div><h3>בדיקת התראות</h3><p>שליחת שלוש התראות בדיקה של Windows (אישור, שכירות וסיכום). ההתראות מסומנות כבדיקה ולא יוצרות שום נתון אמיתי. הן יקפצו 10 שניות אחרי הלחיצה, כך שאפשר לסגור את החלון ב־X ולבדוק שהן מגיעות גם כשהתוכנה מוסתרת. לחיצה על התראה מחזירה לתוכנה ופותחת את המסך המתאים.</p></div><button class="primary small-btn" id="testToasts">שליחת התראות בדיקה</button></div></section></section>`;
  document.getElementById('testToasts').onclick = runNotificationSelfTest;
  document.getElementById('newType').onclick = () => licenseTypeForm();
  document.getElementById('newUser').onclick = createUserForm;
  app.querySelectorAll('[data-remove-type]').forEach((button) => button.onclick = async () => { if (!confirm('להסיר את סוג האישור מהרשימה הפעילה? מסמכים שכבר הועלו יישמרו.')) return; try { await api(`/api/license-types/${button.dataset.removeType}`, { method: 'DELETE' }); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } });
};
const createUserForm = () => {
  const m = modal('הוספת משתמש', `<form id="userForm" class="form-grid"><label>שם מלא<input name="name" required></label><label>דוא״ל<input name="email" type="email" required></label><label>סיסמה ראשונית<input name="password" type="password" minlength="8" required></label><fieldset><legend>תפקיד</legend><label class="check-row"><input type="radio" name="role" value="Manager" checked>משתמש - צופה ומעדכן רק בסניפים שיסומנו</label><label class="check-row"><input type="radio" name="role" value="Admin">מנהל שותף - אותן ההרשאות ואותם הנתונים שלך, כולל כל הסניפים וההגדרות</label></fieldset><fieldset id="branchAccess"><legend>גישה לסניפים</legend>${state.branches.map((b) => `<label class="check-row"><input type="checkbox" name="branches" value="${b._id}">${esc(b.name)}</label>`).join('') || '<p class="muted">צריך ליצור סניף לפני הוספת משתמש.</p>'}</fieldset><button class="primary">יצירת משתמש</button></form>`);
  const branchAccess = m.wrap.querySelector('#branchAccess');
  m.wrap.querySelectorAll('input[name="role"]').forEach((radio) => radio.onchange = () => { branchAccess.hidden = m.wrap.querySelector('input[name="role"]:checked').value === 'Admin'; });
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const role = f.get('role'); try { await api('/api/users', { method: 'POST', body: JSON.stringify({ name: f.get('name'), email: f.get('email'), password: f.get('password'), role, accessibleBranches: role === 'Admin' ? [] : f.getAll('branches') }) }); m.close(); toast(role === 'Admin' ? 'המנהל השותף נוסף' : 'המשתמש נוסף', 'success'); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } };
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
setInterval(() => { if (state.user) loadApp(); }, 15 * 60 * 1000);
loadApp().catch((error) => { renderAuth(); toast(error.message || 'לא ניתן לפתוח את KinderGuard כרגע.', 'danger'); });
