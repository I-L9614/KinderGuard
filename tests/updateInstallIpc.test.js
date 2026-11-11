// Backend-IPC integration test: the update-install handler must enforce the
// guard state reported by the renderer, so no caller can bypass the decision
// dialogs by invoking the IPC channel directly.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const handlers = new Map();
const listeners = new Map();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  },
  Notification: class {},
}));

const { setupUpdateIpcHandlers } = await import('../electron/ipc.js');

const install = vi.fn(() => true);
let guardReport;

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  install.mockClear();
  setupUpdateIpcHandlers(() => ({ install }));
  guardReport = (state) => listeners.get('update-guard-state')(null, state);
});

const invokeInstall = (options) => handlers.get('update-install')(null, options);

describe('update-install IPC enforcement', () => {
  it('installs when no guard state was ever reported and no risk exists', () => {
    expect(invokeInstall()).toEqual({ installed: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('blocks while any mutating write is pending - even with a discard flag', () => {
    guardReport({ dirtyForms: 1, pendingWrites: 2, pendingUploads: 1 });
    expect(invokeInstall()).toEqual({ installed: false, reason: 'pending-writes' });
    expect(invokeInstall({ discardUnsaved: true })).toEqual({ installed: false, reason: 'pending-writes' });
    expect(install).not.toHaveBeenCalled();
  });

  it('blocks unsaved forms without an explicit discard choice, then allows with it', () => {
    guardReport({ dirtyForms: 2, pendingWrites: 0, pendingUploads: 0 });
    expect(invokeInstall()).toEqual({ installed: false, reason: 'unsaved-forms' });
    expect(install).not.toHaveBeenCalled();
    expect(invokeInstall({ discardUnsaved: true })).toEqual({ installed: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('follows the latest reported state: after writes settle, install is allowed', () => {
    guardReport({ dirtyForms: 0, pendingWrites: 1, pendingUploads: 0 });
    expect(invokeInstall()).toEqual({ installed: false, reason: 'pending-writes' });
    guardReport({ dirtyForms: 0, pendingWrites: 0, pendingUploads: 0 });
    expect(invokeInstall()).toEqual({ installed: true });
  });

  it('sanitizes malformed guard reports instead of trusting them', () => {
    guardReport({ dirtyForms: -5, pendingWrites: 'x', pendingUploads: null });
    expect(invokeInstall()).toEqual({ installed: true });
    guardReport(null);
    expect(invokeInstall()).toEqual({ installed: true });
  });
});
