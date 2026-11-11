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

export const SEEN_KEY = 'seenNotifications';
export const SESSION_KEY = 'kg-session-primed';

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
