import { describe, it, expect } from 'vitest';
import { israelWallInstant } from '../frontend/israelTime.js';
import { dueTaskAlertItems, planNativeToasts, alertToastPayload, resolveAlertTarget } from '../frontend/nativeNotify.js';

const NOW = new Date('2026-11-26T12:00:00+02:00');
const task = (over) => ({ _id: 't1', title: 'להזמין ציוד', status: 'To_Do', editable: true, dueDate: '2026-11-26T00:00:00.000Z', branchId: null, ...over });
describe('manager due-task alerts', () => {
  it('own task due today or earlier alerts; future, done, no date and others\' tasks do not', () => {
    const r = dueTaskAlertItems([
      task({ _id: 'today' }), task({ _id: 'past', dueDate: '2026-11-20' }), task({ _id: 'future', dueDate: '2026-11-27' }),
      task({ _id: 'done', status: 'Done' }), task({ _id: 'nodate', dueDate: null }), task({ _id: 'other', editable: false }),
    ], NOW);
    expect(r.map((x) => x.taskId).sort()).toEqual(['past', 'today']);
    expect(r.every((x) => x.kind === 'Task' && x.status === 'Open')).toBe(true);
  });
  it('never yields license or rent items, even if given', () => {
    expect(dueTaskAlertItems([{ _id: 'x', kind: 'License', status: 'Open', title: 'x' }, { _id: 'y', kind: 'Rent', status: 'Open' }], NOW)).toEqual([]);
  });
  it('toasts once per deadline (dedupe) and again only if the due day moves', () => {
    const a = dueTaskAlertItems([task()], NOW); const p1 = planNativeToasts(a, { seenIds: [], firstOfSession: false });
    expect(p1.mode).toBe('individual');
    expect(planNativeToasts(dueTaskAlertItems([task()], NOW), { seenIds: p1.seen, firstOfSession: false }).mode).toBe('none');
    const moved = dueTaskAlertItems([task({ dueDate: '2026-11-25' })], NOW);
    expect(planNativeToasts(moved, { seenIds: p1.seen, firstOfSession: false }).mode).toBe('individual');
  });
  it('toast payload names the task and the click opens the alerts page', () => {
    const [item] = dueTaskAlertItems([task()], NOW);
    const pl = alertToastPayload(item, { date: () => '26.11.2026' });
    expect(pl.body).toContain('להזמין ציוד'); expect(pl.target.kind).toBe('Task');
    expect(resolveAlertTarget(pl.target, { user: { role: 'Manager' }, branches: [], licenses: [] })).toEqual({ page: 'alerts' });
  });
  describe('optional due time with 60 and 30 minute reminders (Israel time)', () => {
    const at = (hhmm) => new Date(`2026-11-26T${hhmm}:00+02:00`);
    const timed = (over) => task({ dueDate: '2026-11-26T00:00:00.000Z', dueTime: '15:00', dueSetAt: at('09:00').toISOString(), ...over });
    const ids = (tasks, now) => dueTaskAlertItems(tasks, now).map((x) => `${x.kind}${x.minutes || ''}`);
    it('nothing before the first reminder, 1h reminder at 14:00, 30 min at 14:30, deadline at 15:00', () => {
      expect(ids([timed()], at('13:59'))).toEqual([]);
      expect(ids([timed()], at('14:05'))).toEqual(['TaskReminder60']);
      expect(ids([timed()], at('14:35'))).toEqual(['TaskReminder30']);
      expect(ids([timed()], at('15:00'))).toEqual(['Task']);
    });
    it('a timed task is not an alert earlier the same day (date alone does not arrive it)', () => {
      expect(ids([timed()], at('08:00'))).toEqual([]);
    });
    it('no instant or retroactive reminder: created 20 min before the deadline fires neither reminder', () => {
      const t = timed({ dueSetAt: at('14:40').toISOString() });
      expect(ids([t], at('14:45'))).toEqual([]);
      expect(ids([t], at('15:00'))).toEqual(['Task']);
    });
    it('created 45 min before: only the 30 minute reminder is ever armed', () => {
      const t = timed({ dueSetAt: at('14:15').toISOString() });
      expect(ids([t], at('14:20'))).toEqual([]); expect(ids([t], at('14:31'))).toEqual(['TaskReminder30']);
    });
    it('marking the task Done removes it from alerts, reminders and the deadline alert, in every state', () => {
      for (const when of ['14:05', '14:35', '15:00', '18:00']) {
        expect(ids([timed()], at(when)).length).toBe(1);
        expect(ids([timed({ status: 'Done' })], at(when))).toEqual([]);
      }
      expect(dueTaskAlertItems([task({ status: 'Done' })], NOW)).toEqual([]);
    });
    it('strict boundary: a reminder moment equal to the set time never fires, one millisecond later does', () => {
      const exact = timed({ dueSetAt: at('14:00').toISOString() }); // 1h reminder moment == set time
      expect(ids([exact], at('14:10'))).toEqual([]);
      const justAfter = timed({ dueSetAt: new Date(at('14:00').getTime() - 1).toISOString() });
      expect(ids([justAfter], at('14:10'))).toEqual(['TaskReminder60']);
    });
    it('no due time, no dueSetAt (old records), done or others tasks produce no reminders', () => {
      expect(ids([task({ dueDate: '2026-11-27' })], at('14:35'))).toEqual([]);
      expect(ids([timed({ dueSetAt: null })], at('14:35'))).toEqual([]);
      expect(ids([timed({ status: 'Done' }), timed({ editable: false })], at('14:35'))).toEqual([]);
    });
    it('only the later reminder shows when both passed, ids are per deadline version and per reminder', () => {
      const a = dueTaskAlertItems([timed()], at('14:40')); expect(a).toHaveLength(1);
      const b = dueTaskAlertItems([timed()], at('14:10'))[0]._id; expect(b).not.toBe(a[0]._id);
      const moved = dueTaskAlertItems([timed({ dueTime: '16:00', dueSetAt: at('09:00').toISOString() })], at('15:10'))[0]._id; expect(moved).not.toBe(b);
    });
    it('timed items are flagged so they bypass the 11:00 hold, date-only ones are not', () => {
      expect(dueTaskAlertItems([timed()], at('14:35'))[0].timed).toBe(true);
      expect(dueTaskAlertItems([task()], NOW)[0].timed).toBe(false);
    });
  });
  describe('Israel DST wall-clock conversion', () => {
    it('summer and winter offsets are right', () => {
      expect(israelWallInstant('2026-07-15', '15:00').instant.toISOString()).toBe('2026-07-15T12:00:00.000Z');
      expect(israelWallInstant('2026-12-15', '15:00').instant.toISOString()).toBe('2026-12-15T13:00:00.000Z');
    });
    it('clocks forward (2027-03-26): 02:30 does not exist and is flagged, 03:30 is fine', () => {
      expect(israelWallInstant('2027-03-26', '02:30').status).toBe('gap');
      expect(israelWallInstant('2027-03-26', '03:30').status).toBe('ok');
    });
    it('clocks back (2026-10-25): 01:30 happens twice and resolves to the first occurrence', () => {
      const r = israelWallInstant('2026-10-25', '01:30'); expect(r.status).toBe('ambiguous'); expect(r.instant.toISOString()).toBe('2026-10-24T22:30:00.000Z');
    });
  });
});
