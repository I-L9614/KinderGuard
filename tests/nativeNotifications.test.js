import { describe, it, expect } from 'vitest';
import { planNativeToasts, resolveAlertTarget, alertToastPayload, summaryToastPayload, testToastPayloads } from '../frontend/nativeNotify.js';

const licenseAlert = (over = {}) => ({
  _id: 'lic1', kind: 'License', status: 'Open', triggerDays: 7,
  branchId: { _id: 'b1', name: 'גן השקמה' },
  licenseId: { _id: 'l1', licenseTypeId: { name: 'רישיון משרד הבריאות' }, expiryDate: '2026-11-20' },
  ...over,
});
const rentAlert = (over = {}) => ({
  _id: 'rent1', kind: 'Rent', status: 'Open', rentTrigger: 'week_before_due',
  branchId: 'b1', branchName: 'גן השקמה', amount: 5400, dueDate: '2026-11-15',
  rentAgreementId: 'a1', rentPaymentId: 'p1',
  ...over,
});
const stateFor = (role = 'Admin') => ({
  user: { role },
  branches: [{ _id: 'b1', name: 'גן השקמה' }],
  licenses: [{ _id: 'l1' }],
});

describe('planNativeToasts', () => {
  it('toasts nothing when there is nothing new', () => {
    expect(planNativeToasts([licenseAlert()], { seenIds: ['lic1'], firstOfSession: false }).mode).toBe('none');
    expect(planNativeToasts([licenseAlert({ status: 'Resolved' })], { seenIds: [], firstOfSession: false }).mode).toBe('none');
  });
  it('collapses the first refresh of a session into one summary (no burst after quit)', () => {
    const plan = planNativeToasts([licenseAlert(), rentAlert()], { seenIds: [], firstOfSession: true });
    expect(plan.mode).toBe('summary');
    expect(plan.count).toBe(2);
    expect(plan.seen).toEqual(['lic1', 'rent1']);
  });
  it('toasts each new alert individually during the session and never repeats one', () => {
    const first = planNativeToasts([licenseAlert()], { seenIds: [], firstOfSession: false });
    expect(first.mode).toBe('individual');
    const second = planNativeToasts([licenseAlert(), rentAlert()], { seenIds: first.seen, firstOfSession: false });
    expect(second.items.map((i) => i._id)).toEqual(['rent1']);
    expect(planNativeToasts([licenseAlert(), rentAlert()], { seenIds: second.seen.concat('lic1'), firstOfSession: false }).mode).toBe('none');
  });
});

describe('resolveAlertTarget', () => {
  it('routes a permit toast to the branch record with the license highlighted', () => {
    expect(resolveAlertTarget(alertToastPayload(licenseAlert(), helpers()).target, stateFor()))
      .toEqual({ page: 'branches', branchId: 'b1', highlightLicenseId: 'l1' });
  });
  it('routes a rent toast to the rent page with the payment row highlighted', () => {
    expect(resolveAlertTarget(alertToastPayload(rentAlert(), helpers()).target, stateFor()))
      .toEqual({ page: 'rent', highlightPaymentId: 'p1', highlightAgreementId: 'a1' });
  });
  it('falls back to the inbox for deleted/stale targets', () => {
    expect(resolveAlertTarget({ kind: 'License', branchId: 'gone', licenseId: 'gone' }, stateFor())).toEqual({ page: 'alerts' });
    expect(resolveAlertTarget({ kind: 'License', branchId: 'b1', licenseId: 'deleted' }, stateFor())).toEqual({ page: 'alerts' });
    expect(resolveAlertTarget(null, stateFor())).toEqual({ page: 'alerts' });
    expect(resolveAlertTarget({ kind: 'Summary' }, stateFor())).toEqual({ page: 'alerts' });
  });
  it('keeps rent toasts away from non-admin roles (permission boundary)', () => {
    expect(resolveAlertTarget({ kind: 'Rent', rentAgreementId: 'a1' }, stateFor('Manager'))).toEqual({ page: 'alerts' });
  });
});

describe('alertToastPayload', () => {
  it('makes the type obvious at a glance: permit vs rent, with urgency', () => {
    const h = helpers();
    expect(alertToastPayload(licenseAlert(), h).title).toContain('שבוע');
    expect(alertToastPayload(licenseAlert({ triggerDays: 0 }), h).title).toContain('פג תוקף');
    expect(alertToastPayload(rentAlert(), h).title).toContain('שכירות');
    expect(alertToastPayload(rentAlert({ rentTrigger: 'month_before_series_end' }), h).title).toContain("צ'קים");
    expect(alertToastPayload(rentAlert(), h).body).toContain('5,400');
  });
  it('summary toast targets the inbox', () => {
    expect(summaryToastPayload(3).target).toEqual({ kind: 'Summary' });
    expect(summaryToastPayload(3).body).toContain('3');
  });
});

function helpers() {
  return {
    typeName: (t) => t?.name || 'אישור',
    branchName: (b) => b?.name || 'סניף',
    date: (d) => String(d).slice(0, 10),
    money: (n) => Number(n).toLocaleString('en-US'),
  };
}

describe('testToastPayloads (settings self-test fixtures)', () => {
  const helpers = {
    typeName: () => 'אישור',
    branchName: () => 'סניף',
    date: (v) => String(v),
    money: (v) => `₪${v}`,
  };
  it('returns permit, rent and summary toasts, all marked as tests', () => {
    const [permit, rent, summary] = testToastPayloads(helpers);
    expect(permit.target.kind).toBe('License');
    expect(rent.target.kind).toBe('Rent');
    expect(summary.target.kind).toBe('Summary');
    for (const p of [permit, rent, summary]) {
      expect(p.title.startsWith('בדיקה · ')).toBe(true);
      expect(p.body).toContain('התראת בדיקה');
    }
  });
  it('fixture targets resolve to safe fallbacks on an empty account', () => {
    const [permit, rent, summary] = testToastPayloads(helpers);
    const empty = { user: { role: 'Admin' }, branches: [], licenses: [] };
    expect(resolveAlertTarget(permit.target, empty)).toEqual({ page: 'alerts' });
    expect(resolveAlertTarget(rent.target, empty)).toMatchObject({ page: 'rent' });
    expect(resolveAlertTarget(summary.target, empty)).toEqual({ page: 'alerts' });
  });
});
