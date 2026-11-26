// Native Windows notification policy for KinderGuard alerts.
// Pure module (no DOM/electron imports) so the policy is unit-testable.
//
// Behavior contract:
// - An alert the user was already told about is never re-toasted (dedupe by id).
// - The first refresh of an app session collapses everything new into ONE
//   summary toast (no burst after the app was closed); later 15-minute
//   refreshes toast each new alert individually.
// - Click targets route to the relevant record; stale/deleted/unauthorized
//   targets fall back to the alerts inbox instead of erroring.

import { israelParts, israelToday, calendarDay, israelWallInstant } from './israelTime.js';

export const SEEN_KEY = 'seenNotifications';
export const SESSION_KEY = 'kg-session-primed';

// Popups are held until 11:00 Israel time each day (the user is usually at the
// computer then). Alerts stay Open in the inbox and the badge regardless; any
// refresh at or after 11:00 shows what is still unseen, so a PC that was off or
// an app that was closed at 11:00 gets its popup at the next launch/refresh.
export const POPUP_HOUR_ISRAEL = 11;
export const popupWindowOpen = (now = new Date(), hour = POPUP_HOUR_ISRAEL) => israelParts(now).hour >= hour;

// Branch users (role Manager) are alerted only about tasks they created themselves. Done tasks never alert.
// - No due time: the deadline is the Israel calendar day; the alert is due from that day on (11:00 popup rule applies).
// - With a due time (Israel local): the deadline alert is due from that moment, plus a reminder 60 and 30 minutes before.
//   A reminder only counts if its moment is strictly after the deadline was set (dueSetAt), so nothing fires
//   instantly or in hindsight. If both reminders have passed, only the later one is shown. Reminders stop at the deadline.
// Ids carry the deadline (day and time), so each is toasted once per deadline version; moving the deadline re-arms them.
export const REMINDER_MINUTES = [60, 30];
export const dueInstant = (t) => (t?.dueTime && t.dueDate ? israelWallInstant(t.dueDate, t.dueTime).instant : null);
const deadlineKey = (t) => `${calendarDay(t.dueDate).toISOString().slice(0, 10)}${t.dueTime ? `T${t.dueTime}` : ''}`;
export const taskDeadlineArrived = (t, now = new Date()) => {
  if (!t || t.status === 'Done' || !t.editable || !t.dueDate) return false;
  const at = dueInstant(t);
  return at ? now >= at : calendarDay(t.dueDate) <= israelToday(now);
};
export const dueTaskAlertItems = (tasks, now = new Date()) => {
  const out = [];
  for (const t of tasks || []) {
    if (!t || t.status === 'Done' || !t.editable || !t.dueDate) continue;
    const base = { taskId: t._id, title: t.title, dueDate: t.dueDate, dueTime: t.dueTime || '', branchId: t.branchId, status: 'Open' };
    const at = dueInstant(t);
    if (taskDeadlineArrived(t, now)) { out.push({ ...base, _id: `task-${t._id}-${deadlineKey(t)}`, kind: 'Task', timed: Boolean(at) }); continue; }
    if (at && t.dueSetAt) {
      const set = new Date(t.dueSetAt).getTime();
      const due = REMINDER_MINUTES.map((mins) => ({ mins, when: at.getTime() - mins * 60000 })).filter((r) => r.when > set && r.when <= now.getTime());
      const last = due.sort((a, b) => b.when - a.when)[0];
      if (last) out.push({ ...base, _id: `task-${t._id}-${deadlineKey(t)}-r${last.mins}`, kind: 'TaskReminder', minutes: last.mins, timed: true });
    }
  }
  return out;
};

export const planNativeToasts = (alerts, { seenIds, firstOfSession }) => {
  const fresh = alerts.filter((item) => item.status === 'Open' && !seenIds.includes(item._id));
  if (!fresh.length) return { mode: 'none', items: [], count: 0, seen: [] };
  const seen = fresh.map((item) => item._id);
  if (firstOfSession) return { mode: 'summary', items: fresh, count: fresh.length, seen };
  return { mode: 'individual', items: fresh, count: fresh.length, seen };
};

// Maps a toast click target onto app state. Anything that no longer exists
// (deleted branch/license), is outside the user's role (rent for non-admins),
// or is otherwise unknown lands on the alerts inbox.
export const resolveAlertTarget = (target, state) => {
  if (!target || target.kind === 'Summary') return { page: 'alerts' };
  if (target.kind === 'Task' || target.kind === 'TaskReminder') return { page: 'alerts' };
  if (target.kind === 'License') {
    const branchId = target.branchId?._id || target.branchId;
    const licenseId = target.licenseId?._id || target.licenseId || null;
    const branchOk = state.branches.some((b) => b._id === branchId);
    const licenseOk = !licenseId || state.licenses.some((l) => l._id === licenseId);
    if (branchOk && licenseOk) return { page: 'branches', branchId, highlightLicenseId: licenseId };
    return { page: 'alerts' };
  }
  if (target.kind === 'Rent') {
    if (state.user?.role !== 'Admin') return { page: 'alerts' };
    return {
      page: 'rent',
      highlightPaymentId: target.rentPaymentId || null,
      highlightAgreementId: target.rentAgreementId || null,
    };
  }
  return { page: 'alerts' };
};

// Typed titles/bodies for the native toast: rent vs permit is obvious at a glance.
export const alertToastPayload = (item, { typeName, branchName, date, money }) => {
  const branchId = item.branchId?._id || item.branchId;
  if (item.kind === 'Task') return { title: 'KinderGuard · הגיע מועד משימה', body: `${item.title} · מועד יעד ${date(item.dueDate)}${item.dueTime ? ` ${item.dueTime}` : ''}`, target: { id: item._id, kind: 'Task' } };
  if (item.kind === 'TaskReminder') return { title: item.minutes === 30 ? 'KinderGuard · משימה בעוד חצי שעה' : 'KinderGuard · משימה בעוד שעה', body: `${item.title} · היום ב־${item.dueTime}`, target: { id: item._id, kind: 'TaskReminder' } };
  if (item.kind === 'Rent') {
    const isSeries = item.rentTrigger === 'month_before_series_end';
    const name = item.branchName || branchName(item.branchId);
    return {
      title: isSeries ? "KinderGuard · סדרת צ'קים מסתיימת" : 'KinderGuard · תשלום שכירות קרוב',
      body: isSeries
        ? `${name} · הסדרה מסתיימת ב־${date(item.seriesEndDate)}`
        : `${name} · ${money(item.amount)} · מועד פרעון ${date(item.dueDate)}`,
      target: { id: item._id, kind: 'Rent', branchId, rentAgreementId: item.rentAgreementId, rentPaymentId: item.rentPaymentId },
    };
  }
  const licenseId = item.licenseId?._id || item.licenseId;
  const urgent = item.triggerDays === 0;
  return {
    title: urgent ? 'KinderGuard · אישור פג תוקף!' : item.triggerDays === 7 ? 'KinderGuard · אישור לחידוש בעוד שבוע' : 'KinderGuard · אישור לחידוש בעוד 30 יום',
    body: `${typeName(item.licenseId?.licenseTypeId)} · ${branchName(item.branchId)} · פקיעה ${date(item.licenseId?.expiryDate)}`,
    target: { id: item._id, kind: 'License', branchId, licenseId },
  };
};

export const summaryToastPayload = (count) => ({
  title: 'KinderGuard',
  body: count === 1 ? 'התראה אחת ממתינה לטיפול' : `${count} התראות ממתינות לטיפול`,
  target: { kind: 'Summary' },
});

// Settings-screen self test: three clearly-marked TEST toasts fired through
// the exact same notify bridge, so a real PC can verify the Windows toast
// pipeline (banner, sound, click -> focus -> in-app routing) without creating
// real records. Fixture ids never match real data: the permit click exercises
// the stale-target fallback to the alerts inbox, the rent click lands on the
// rent page (admins), and the summary click opens the alerts inbox.
export const testToastPayloads = (helpers) => {
  const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const permit = alertToastPayload(
    { _id: 'test-toast-permit', triggerDays: 30, licenseId: { _id: 'test-toast-license', expiryDate: future(30) }, branchId: 'test-toast-branch' },
    helpers,
  );
  const rent = alertToastPayload(
    { _id: 'test-toast-rent', kind: 'Rent', branchName: 'סניף בדיקה', amount: 5000, dueDate: future(7), rentAgreementId: 'test-toast-agreement', rentPaymentId: 'test-toast-payment' },
    helpers,
  );
  const mark = (p) => ({ ...p, title: `בדיקה · ${p.title}`, body: `${p.body} · התראת בדיקה, לא נתון אמיתי` });
  return [mark(permit), mark(rent), mark(summaryToastPayload(2))];
};
