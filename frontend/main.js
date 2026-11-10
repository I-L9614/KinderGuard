const app = document.getElementById('app');
const headerActions = document.getElementById('header-actions');
const state = { user: null, branches: [], licenses: [], types: [], alerts: [], page: 'branches', branchId: null, token: null };
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const date = (value) => value ? new Date(value).toLocaleDateString('he-IL') : '—';
const safeUrl = (value) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const api = async (url, options = {}) => {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...options.headers };
  let response;
  try { response = await fetch(url, { credentials: 'include', ...options, headers }); }
  catch { const error = new Error('לא ניתן להתחבר לשרת. בדקו שהאפליקציה פועלת ושיש חיבור לרשת.'); error.status = 0; throw error; }
  const raw = await response.text();
  let data = {}; try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (!response.ok) { const error = new Error(data.message || 'הפעולה לא הושלמה. נסו שוב.'); error.status = response.status; error.fields = data.errors || []; throw error; }
  return data;
};
const toast = (text, kind = 'info') => { const node = document.createElement('div'); node.className = `toast toast-${kind}`; node.textContent = text; document.body.append(node); setTimeout(() => node.remove(), 3600); };

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
    [state.branches, state.licenses, state.alerts] = await Promise.all([api('/api/branches'), api('/api/licenses'), api('/api/notifications')]);
    state.types = await api('/api/license-types');
    if (state.branchId && !state.branches.some((b) => b._id === state.branchId)) state.branchId = null;
    render();
    state.alerts.filter((item) => item.status === 'Open').forEach((item) => {
      const seen = JSON.parse(localStorage.getItem('seenNotifications') || '[]');
      if (!seen.includes(item._id)) {
        window.electronAPI?.notify({ title: 'KinderGuard · תזכורת לחידוש', body: `${typeName(item.licenseId?.licenseTypeId)} · ${branchName(item.branchId)}` });
        seen.push(item._id); localStorage.setItem('seenNotifications', JSON.stringify(seen.slice(-1000)));
      }
    });
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
  headerActions.innerHTML = `<nav class="nav"><button data-page="branches" class="${state.page === 'branches' ? 'selected' : ''}">הסניפים שלי</button><button data-page="alerts" class="${state.page === 'alerts' ? 'selected' : ''}">התראות <b class="nav-count">${currentAlerts().length}</b></button>${state.user.role === 'Admin' ? `<button data-page="settings" class="${state.page === 'settings' ? 'selected' : ''}">הגדרות וצוות</button>` : ''}</nav><div class="user-menu"><span class="user-avatar">${esc(state.user.name.slice(0, 1))}</span><span>${esc(state.user.name)}<small>${state.user.role === 'Admin' ? 'מנהל חשבון' : 'משתמש'}</small></span><button class="icon-button" id="logout" title="התנתקות">↪</button></div>`;
  headerActions.querySelectorAll('[data-page]').forEach((button) => button.onclick = () => { state.page = button.dataset.page; state.branchId = null; render(); });
  document.getElementById('logout').onclick = async () => { try { await api('/api/auth/logout', { method: 'POST' }); } catch {} state.user = null; state.token = null; renderAuth(); };
};
const render = () => { renderHeader(); if (state.page === 'alerts') return renderAlerts(); if (state.page === 'settings') return renderSettings(); if (state.branchId) return renderBranch(); return renderBranches(); };

const renderBranches = () => {
  const alerts = currentAlerts();
  const overdue = state.licenses.filter((l) => l.status === 'Expired').length;
  const soon = state.licenses.filter((l) => l.status === 'Expiring_Soon').length;
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז הבקרה</div><h2>שלום ${esc(state.user.name)}, מה מצב האישורים?</h2><p>סקירה עדכנית של הסניפים והמשימות שדורשות תשומת לב.</p></div>${state.user.role === 'Admin' ? '<button id="newBranch" class="primary">＋ הוספת סניף</button>' : ''}</section><section class="stats-grid"><article class="stat-card"><span class="stat-icon teal">⌂</span><div><strong>${state.branches.length}</strong><small>סניפים</small></div></article><article class="stat-card"><span class="stat-icon amber">◷</span><div><strong>${soon}</strong><small>אישורים לקראת פקיעה</small></div></article><article class="stat-card"><span class="stat-icon coral">!</span><div><strong>${overdue}</strong><small>אישורים שפג תוקפם</small></div></article><article class="stat-card clickable" id="alertsSummary"><span class="stat-icon blue">♧</span><div><strong>${alerts.length}</strong><small>התראות לטיפול</small></div></article></section><section class="section-heading"><div><h3>הסניפים שלך</h3><p>בחרו סניף כדי לראות את כל האישורים וההיסטוריה שלו</p></div><span class="muted">${state.branches.length} סניפים</span></section><section class="branch-grid">${state.branches.length ? state.branches.map((branch) => { const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id); const expiring = licenses.filter((l) => l.status === 'Expiring_Soon').length; const expiredCount = licenses.filter((l) => l.status === 'Expired').length; return `<button class="branch-card" data-branch="${branch._id}"><div class="branch-card-top"><span class="branch-symbol">⌂</span><span class="arrow">←</span></div><h3>${esc(branch.name)}</h3><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p><div class="branch-card-bottom"><span>${licenses.length} אישורים</span><span class="branch-signals">${expiredCount ? `<i class="dot danger"></i>${expiredCount} פגו` : ''}${expiring ? `<i class="dot warning"></i>${expiring} לקראת פקיעה` : ''}${!expiredCount && !expiring ? '<i class="dot good"></i>הכול תקין' : ''}</span></div></button>`; }).join('') : `<div class="empty-state"><span>⌂</span><h3>עוד אין סניפים</h3><p>הוסיפו את הסניף הראשון כדי להתחיל לנהל את האישורים שלו.</p></div>`}</section>`;
  document.getElementById('alertsSummary').onclick = () => { state.page = 'alerts'; render(); };
  app.querySelectorAll('[data-branch]').forEach((node) => node.onclick = () => { state.branchId = node.dataset.branch; render(); });
  document.getElementById('newBranch')?.addEventListener('click', createBranchForm);
};

const renderBranch = async () => {
  const branch = state.branches.find((b) => b._id === state.branchId); if (!branch) { state.branchId = null; return renderBranches(); }
  const licenses = state.licenses.filter((l) => (l.branchId?._id || l.branchId) === branch._id);
  let types;
  try { types = await api(`/api/license-types?branchId=${branch._id}`); }
  catch (error) { app.innerHTML = `<button class="back-link" id="back">← כל הסניפים</button><section class="panel"><h3>לא ניתן לטעון את פרטי הסניף</h3><p>${esc(error.message)}</p><button class="secondary" id="retryBranch">ניסיון חוזר</button></section>`; document.getElementById('back').onclick = () => { state.branchId = null; renderBranches(); }; document.getElementById('retryBranch').onclick = renderBranch; return; }
  app.innerHTML = `<button class="back-link" id="back">← כל הסניפים</button><section class="branch-title"><div><div class="eyebrow">פרטי סניף</div><h2>${esc(branch.name)}</h2><p>${esc(branch.address || 'כתובת לא הוגדרה')}</p></div><div class="button-row">${state.user.role === 'Admin' ? '<button class="secondary" id="addType">＋ סוג אישור</button>' : ''}<button class="primary" id="addLicense">＋ העלאת אישור</button></div></section><section class="stats-grid compact"><article class="stat-card"><div><strong>${licenses.length}</strong><small>אישורים פעילים</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Valid').length}</strong><small>בתוקף</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Expiring_Soon').length}</strong><small>לקראת פקיעה</small></div></article><article class="stat-card"><div><strong>${licenses.filter((l) => l.status === 'Expired').length}</strong><small>פגו</small></div></article></section><section class="panel"><div class="section-heading"><div><h3>אישורי הסניף</h3><p>האישור החדש ביותר מכל סוג מוצג כאן</p></div><span class="muted">${licenses.length} פעילים</span></div>${licenses.length ? `<div class="license-list">${licenses.map((license) => `<article class="license-row"><div class="license-icon ${statusClass(license.status)}">▤</div><div class="license-main"><strong>${esc(typeName(license.licenseTypeId))}</strong><small>תוקף ${date(license.issueDate)} — ${date(license.expiryDate)} ${license.fileName && safeUrl(license.fileUrl) ? `· <a class="file-link" href="${esc(safeUrl(license.fileUrl))}" target="_blank" rel="noopener noreferrer">${esc(license.fileName)}</a>` : ''}</small></div><span class="status-pill ${statusClass(license.status)}">${statusText(license.status)}</span><button class="text-button" data-history="${license._id}">היסטוריה</button></article>`).join('')}</div>` : `<div class="empty-state small"><span>▤</span><h3>אין עדיין אישורים בסניף</h3><p>הגדירו סוג אישור והעלו את המסמך הראשון.</p></div>`}</section><section class="panel"><div class="section-heading"><div><h3>סוגי האישורים לסניף</h3><p>סוגים כלליים וגם סוגים שהוגדרו רק לסניף זה</p></div></div><div class="type-chips">${types.map((t) => `<span class="type-chip">${esc(t.name)}${t.branchId ? '<small>סניף זה</small>' : '<small>כל הסניפים</small>'}</span>`).join('') || '<span class="muted">לא הוגדרו עדיין סוגי אישור</span>'}</div></section><section id="historyPanel"></section>`;
  document.getElementById('back').onclick = () => { state.branchId = null; renderBranches(); };
  document.getElementById('addLicense').onclick = () => licenseForm(branch, types);
  document.getElementById('addType')?.addEventListener('click', () => licenseTypeForm(branch));
  app.querySelectorAll('[data-history]').forEach((button) => button.onclick = async () => {
    let rows;
    try { rows = await api(`/api/licenses/${button.dataset.history}/history`); } catch (error) { toast(error.message, 'danger'); return; }
    const panel = document.getElementById('historyPanel');
    panel.innerHTML = `<section class="panel"><div class="section-heading"><div><h3>היסטוריית חידושים · ${esc(typeName(rows[0]?.licenseTypeId))}</h3><p>הגרסאות הקודמות נשמרות לעיון</p></div><button class="icon-button" id="closeHistory">×</button></div><div class="history-list">${rows.map((row) => `<div class="history-row"><span class="history-mark">${row.lifecycle === 'Active' ? 'פעיל' : 'הוחלף'}</span><strong>${date(row.issueDate)} — ${date(row.expiryDate)}</strong><span>${row.fileName && safeUrl(row.fileUrl) ? `<a class="file-link" href="${esc(safeUrl(row.fileUrl))}" target="_blank" rel="noopener noreferrer">${esc(row.fileName)}</a>` : 'ללא קובץ מצורף'}</span><span class="muted">הועלה ${date(row.createdAt)}</span></div>`).join('')}</div></section>`;
    document.getElementById('closeHistory').onclick = () => panel.innerHTML = '';
  });
};

const modal = (title, content, onClose) => {
  const wrap = document.createElement('div'); wrap.className = 'modal-backdrop'; wrap.innerHTML = `<section class="modal panel"><div class="section-heading"><h3>${title}</h3><button class="icon-button" data-close>×</button></div>${content}</section>`; document.body.append(wrap);
  const close = () => { wrap.remove(); onClose?.(); }; wrap.querySelector('[data-close]').onclick = close; wrap.onclick = (e) => { if (e.target === wrap) close(); }; return { wrap, close };
};
const createBranchForm = () => {
  const m = modal('הוספת סניף', `<form id="branchForm" class="form-grid"><label>שם הסניף<input name="name" required maxlength="120"></label><label>כתובת<input name="address" maxlength="240"></label><label>מספר ילדים מרבי<input name="maxChildren" type="number" min="0"></label><button class="primary">שמירת סניף</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { await api('/api/branches', { method: 'POST', body: JSON.stringify({ name: f.get('name'), address: f.get('address'), maxChildren: f.get('maxChildren') || undefined }) }); m.close(); toast('הסניף נוסף', 'success'); await loadApp(); } catch (error) { toast(error.message, 'danger'); } };
};
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
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">מרכז טיפול</div><h2>התראות לחידוש אישורים</h2><p>כל התזכורות מכל הסניפים נשמרות כאן עד לסגירת הטיפול.</p></div><span class="inbox-total">${open.length} ממתינות לטיפול</span></section><section class="panel"><div class="section-heading"><div><h3>ממתינות לטיפול</h3><p>התראות מופיעות 30 יום, 7 ימים וביום הפקיעה</p></div></div>${open.length ? `<div class="alert-list">${open.map((item) => alertCard(item)).join('')}</div>` : `<div class="empty-state small"><span>✓</span><h3>אין התראות פתוחות</h3><p>כל ההתראות טופלו. נעדכן אתכם כשיגיע מועד חידוש.</p></div>`}</section><section class="panel"><details><summary>התראות שטופלו (${done.length})</summary><div class="alert-list archived">${done.map((item) => alertCard(item, true)).join('') || '<p class="muted">אין עדיין התראות שטופלו.</p>'}</div></details></section>`;
  app.querySelectorAll('[data-alert-action]').forEach((button) => button.onclick = async () => { try { await api(`/api/notifications/${button.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.alertAction }) }); await loadApp(); } catch (error) { toast(error.message, 'danger'); } });
  app.querySelectorAll('[data-alert-branch]').forEach((button) => button.onclick = () => { state.branchId = button.dataset.alertBranch; state.page = 'branches'; render(); });
};
const alertCard = (item, archived = false) => {
  const license = item.licenseId || {}; const kind = item.triggerDays === 30 ? '30 יום מראש' : item.triggerDays === 7 ? 'שבוע מראש' : 'היום';
  const stateLabel = { Open: 'חדש', In_Progress: 'בטיפול', Resolved: 'טופל', Dismissed: 'הושתק' }[item.status];
  return `<article class="alert-card ${item.triggerDays === 0 ? 'urgent' : ''}"><div class="alert-marker ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'blue'}">${item.triggerDays === 0 ? '!' : '◷'}</div><div class="alert-copy"><div class="alert-heading"><strong>${esc(typeName(license.licenseTypeId))}</strong><span class="status-pill ${item.triggerDays === 0 ? 'danger' : item.triggerDays === 7 ? 'warning' : 'neutral'}">${kind}</span><span class="muted">${stateLabel}</span></div><p><button class="inline-link" data-alert-branch="${item.branchId?._id || item.branchId}">${esc(branchName(item.branchId))}</button> · פקיעה ${date(license.expiryDate)}</p></div>${archived ? '' : `<div class="alert-actions"><button class="secondary small-btn" data-id="${item._id}" data-alert-action="In_Progress">${item.status === 'In_Progress' ? 'בטיפול ✓' : 'התחל טיפול'}</button><button class="primary small-btn" data-id="${item._id}" data-alert-action="Resolved">סימון כטופל</button></div>`}</article>`;
};

const renderSettings = async () => {
  let users;
  try { users = await api('/api/users'); } catch (error) { app.innerHTML = `<section class="panel"><h3>לא ניתן לטעון את ההגדרות</h3><p>${esc(error.message)}</p><button class="secondary" id="retrySettings">ניסיון חוזר</button></section>`; document.getElementById('retrySettings').onclick = renderSettings; return; }
  app.innerHTML = `<section class="welcome-row"><div><div class="eyebrow">ניהול החשבון</div><h2>הגדרות וצוות</h2><p>הגדירו את האישורים הנדרשים והחליטו למי יש גישה לכל סניף.</p></div></section><section class="settings-grid"><section class="panel"><div class="section-heading"><div><h3>סוגי אישורים</h3><p>לכל הסניפים או לסניף מסוים</p></div><button class="primary small-btn" id="newType">＋ סוג אישור</button></div><div class="settings-types">${state.types.map((type) => `<div class="settings-type"><span>${esc(type.name)}<small>${type.branchId ? `רק ${esc(branchName(type.branchId))}` : 'כל הסניפים'}</small></span><button class="text-button danger-text" data-remove-type="${type._id}">הסרה</button></div>`).join('') || '<p class="muted">עדיין לא הוגדרו סוגי אישורים.</p>'}</div></section><section class="panel"><div class="section-heading"><div><h3>משתמשים</h3><p>משתמשים יכולים לטפל באישורים בסניפים שהוקצו להם</p></div><button class="primary small-btn" id="newUser">＋ הוספת משתמש</button></div><div class="settings-types">${users.map((u) => `<div class="settings-type"><span>${esc(u.name)}<small>${esc(u.email)} · ${(u.accessibleBranches || []).map((b) => esc(b.name)).join(', ') || 'ללא סניפים'}</small></span><b class="role-label">משתמש</b></div>`).join('') || '<p class="muted">אין עדיין משתמשים נוספים.</p>'}</div></section></section>`;
  document.getElementById('newType').onclick = () => licenseTypeForm();
  document.getElementById('newUser').onclick = createUserForm;
  app.querySelectorAll('[data-remove-type]').forEach((button) => button.onclick = async () => { if (!confirm('להסיר את סוג האישור מהרשימה הפעילה? מסמכים שכבר הועלו יישמרו.')) return; try { await api(`/api/license-types/${button.dataset.removeType}`, { method: 'DELETE' }); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } });
};
const createUserForm = () => {
  const m = modal('הוספת משתמש', `<form id="userForm" class="form-grid"><p class="muted">המשתמש יוכל לצפות ולעדכן אישורים רק בסניפים שיסומנו.</p><label>שם מלא<input name="name" required></label><label>דוא״ל<input name="email" type="email" required></label><label>סיסמה ראשונית<input name="password" type="password" minlength="8" required></label><fieldset><legend>גישה לסניפים</legend>${state.branches.map((b) => `<label class="check-row"><input type="checkbox" name="branches" value="${b._id}">${esc(b.name)}</label>`).join('') || '<p class="muted">צריך ליצור סניף לפני הוספת משתמש.</p>'}</fieldset><button class="primary">יצירת משתמש</button></form>`);
  m.wrap.querySelector('form').onsubmit = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); try { await api('/api/users', { method: 'POST', body: JSON.stringify({ name: f.get('name'), email: f.get('email'), password: f.get('password'), accessibleBranches: f.getAll('branches') }) }); m.close(); toast('המשתמש נוסף', 'success'); await loadApp(); state.page = 'settings'; render(); } catch (error) { toast(error.message, 'danger'); } };
};

window.electronAPI?.onNotificationRefresh(() => loadApp());
setInterval(() => { if (state.user) loadApp(); }, 15 * 60 * 1000);
loadApp().catch((error) => { renderAuth(); toast(error.message || 'לא ניתן לפתוח את KinderGuard כרגע.', 'danger'); });
