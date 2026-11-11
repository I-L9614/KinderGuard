// Guards the update install against losing work. The install closes the app
// by itself, so before it runs there must be an explicit decision when real
// state is at risk:
//
// - Pending writes (any in-flight mutating API request - task/permit/rent
//   saves, uploads) BLOCK the install outright. Latency is never assumed;
//   a write counts until it settles. No discard is offered for these.
// - Dirty forms (a modal whose fields the user edited) require an explicit
//   discard choice, allowed only once no write is pending.
//
// The module is DOM-free so it is unit-testable; main.js wires modal input
// events and api() into it, and reports every change to the Electron main
// process, which enforces the same rules on the update-install IPC so no
// caller can bypass the renderer dialog.

export const createUpdateGuard = () => {
  let dirtyForms = 0;
  let pendingWrites = 0;
  let pendingUploads = 0;
  const listeners = new Set();

  const state = () => ({
    dirtyForms,
    pendingWrites,
    pendingUploads,
    blocked: pendingWrites > 0,
    needsDecision: dirtyForms > 0 || pendingWrites > 0,
  });

  const changed = () => listeners.forEach((fn) => fn(state()));
  const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

  // One call per modal form that received its first real edit; formClosed
  // releases exactly that one mark, so counts never go negative. Programmatic
  // prefill does not mark dirty - only user input events do.
  const formBecameDirty = () => { dirtyForms += 1; changed(); };
  const formClosed = (wasDirty) => { if (wasDirty) { dirtyForms = Math.max(0, dirtyForms - 1); changed(); } };

  // Every mutating API request counts from start until it settles - success,
  // error or network failure - however long it takes.
  const mutationStarted = ({ upload = false } = {}) => { pendingWrites += 1; if (upload) pendingUploads += 1; changed(); };
  const mutationFinished = ({ upload = false } = {}) => {
    pendingWrites = Math.max(0, pendingWrites - 1);
    if (upload) pendingUploads = Math.max(0, pendingUploads - 1);
    changed();
  };

  // Hebrew description of what is at risk, for the decision dialog.
  const describe = () => {
    const parts = [];
    if (dirtyForms > 0) parts.push(dirtyForms === 1 ? 'טופס אחד עם שינויים שלא נשמרו' : `${dirtyForms} טפסים עם שינויים שלא נשמרו`);
    if (pendingUploads > 0) parts.push(pendingUploads === 1 ? 'העלאת קובץ שעדיין מתבצעת' : `${pendingUploads} העלאות שעדיין מתבצעות`);
    const otherWrites = pendingWrites - pendingUploads;
    if (otherWrites > 0) parts.push(otherWrites === 1 ? 'שמירה שעדיין מתבצעת' : `${otherWrites} שמירות שעדיין מתבצעות`);
    return parts.join(' וגם ');
  };

  return { state, onChange, formBecameDirty, formClosed, mutationStarted, mutationFinished, describe };
};
