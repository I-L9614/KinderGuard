import { describe, it, expect, vi } from 'vitest';
import { createUpdateGuard } from '../frontend/updateGuard.js';

describe('update guard', () => {
  it('starts clean and needs no decision', () => {
    const guard = createUpdateGuard();
    expect(guard.state()).toEqual({ dirtyForms: 0, pendingWrites: 0, pendingUploads: 0, blocked: false, needsDecision: false });
  });

  it('requires a decision while a form has unsaved changes, and releases it when that form closes', () => {
    const guard = createUpdateGuard();
    guard.formBecameDirty();
    guard.formBecameDirty();
    expect(guard.state()).toMatchObject({ dirtyForms: 2, needsDecision: true, blocked: false });
    guard.formClosed(true);
    expect(guard.state()).toMatchObject({ dirtyForms: 1, needsDecision: true });
    guard.formClosed(true);
    expect(guard.state()).toMatchObject({ dirtyForms: 0, needsDecision: false });
  });

  it('a clean form closing releases nothing and never goes negative', () => {
    const guard = createUpdateGuard();
    guard.formBecameDirty();
    guard.formClosed(false);
    guard.formClosed(false);
    expect(guard.state()).toMatchObject({ dirtyForms: 1, needsDecision: true });
    guard.formClosed(true);
    guard.formClosed(true);
    expect(guard.state().dirtyForms).toBe(0);
  });

  it('a failed save keeps the form dirty: the modal stays open with its mark', () => {
    const guard = createUpdateGuard();
    guard.formBecameDirty(); // user edited; save attempted and failed, modal stays
    guard.mutationStarted({});
    guard.mutationFinished({});
    expect(guard.state()).toMatchObject({ dirtyForms: 1, pendingWrites: 0, needsDecision: true, blocked: false });
  });

  it('any in-flight mutating request blocks the install until it settles, however long it takes', () => {
    const guard = createUpdateGuard();
    guard.mutationStarted({}); // slow task/permit/rent save
    expect(guard.state()).toMatchObject({ pendingWrites: 1, blocked: true, needsDecision: true });
    guard.mutationFinished({});
    expect(guard.state()).toMatchObject({ pendingWrites: 0, blocked: false, needsDecision: false });
  });

  it('tracks uploads as a subset of pending writes and never goes negative', () => {
    const guard = createUpdateGuard();
    guard.mutationStarted({ upload: true });
    guard.mutationStarted({});
    expect(guard.state()).toMatchObject({ pendingWrites: 2, pendingUploads: 1, blocked: true });
    guard.mutationFinished({ upload: true });
    guard.mutationFinished({});
    guard.mutationFinished({});
    expect(guard.state()).toMatchObject({ pendingWrites: 0, pendingUploads: 0, blocked: false });
  });

  it('describes the risk in Hebrew for the decision dialog', () => {
    const guard = createUpdateGuard();
    guard.formBecameDirty();
    guard.mutationStarted({ upload: true });
    guard.mutationStarted({});
    expect(guard.describe()).toBe('טופס אחד עם שינויים שלא נשמרו וגם העלאת קובץ שעדיין מתבצעת וגם שמירה שעדיין מתבצעת');
    guard.formBecameDirty();
    expect(guard.describe()).toContain('2 טפסים');
  });

  it('notifies listeners on every change so the desktop process can enforce it', () => {
    const guard = createUpdateGuard();
    const seen = [];
    const off = guard.onChange((s) => seen.push(s));
    guard.formBecameDirty();
    guard.mutationStarted({ upload: true });
    guard.mutationFinished({ upload: true });
    guard.formClosed(true);
    expect(seen.map((s) => [s.dirtyForms, s.pendingWrites])).toEqual([[1, 0], [1, 1], [1, 0], [0, 0]]);
    off();
    guard.formBecameDirty();
    expect(seen).toHaveLength(4);
  });
});
