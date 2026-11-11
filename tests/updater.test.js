import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createUpdateController, startUpdateScheduling, decideUpdateInstall } from '../electron/updater.js';

const fakeAutoUpdater = () => {
  const emitter = new EventEmitter();
  emitter.autoDownload = true;
  emitter.autoInstallOnAppQuit = false;
  emitter.checkForUpdates = vi.fn(async () => {});
  emitter.downloadUpdate = vi.fn(async () => {});
  emitter.quitAndInstall = vi.fn();
  return emitter;
};

describe('decideUpdateInstall (main-process enforcement)', () => {
  it('allows a clean install', () => {
    expect(decideUpdateInstall(null)).toEqual({ allow: true });
    expect(decideUpdateInstall({ dirtyForms: 0, pendingWrites: 0 })).toEqual({ allow: true });
  });

  it('blocks pending writes and never offers discard for them', () => {
    expect(decideUpdateInstall({ pendingWrites: 1 })).toEqual({ allow: false, reason: 'pending-writes' });
    expect(decideUpdateInstall({ pendingWrites: 1 }, { discardUnsaved: true })).toEqual({ allow: false, reason: 'pending-writes' });
  });

  it('blocks unsaved forms unless the user explicitly chose discard', () => {
    expect(decideUpdateInstall({ dirtyForms: 1 })).toEqual({ allow: false, reason: 'unsaved-forms' });
    expect(decideUpdateInstall({ dirtyForms: 1 }, { discardUnsaved: true })).toEqual({ allow: true });
  });
});

describe('update controller', () => {
  it('is disabled outside a packaged app and never touches the updater', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController({ autoUpdater, isPackaged: false });
    expect(controller.getState().status).toBe('disabled');
    const result = await controller.check();
    expect(result.status).toBe('disabled');
    expect(autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(controller.install()).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('requires manual approval: marks an available update without downloading it', async () => {
    const autoUpdater = fakeAutoUpdater();
    const sent = [];
    const controller = createUpdateController({ autoUpdater, isPackaged: true, send: (s) => sent.push(s) });
    expect(autoUpdater.autoDownload).toBe(false);
    // "Later" defers; it never silently installs on an unrelated quit.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    await controller.check();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);

    autoUpdater.emit('update-available', { version: '0.3.0' });
    expect(controller.getState()).toMatchObject({ status: 'available', version: '0.3.0' });
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(sent.at(-1)).toMatchObject({ status: 'available', version: '0.3.0' });
  });

  it('reports up to date when no update exists', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController({ autoUpdater, isPackaged: true });
    await controller.check();
    autoUpdater.emit('update-not-available');
    expect(controller.getState().status).toBe('uptodate');
  });

  it('downloads only after approval, tracks progress, and reaches downloaded', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController({ autoUpdater, isPackaged: true });

    // Download is ignored before an update is known to exist.
    await controller.download();
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();

    autoUpdater.emit('update-available', { version: '0.3.0' });
    const downloadPromise = controller.download();
    autoUpdater.emit('download-progress', { percent: 42.4 });
    expect(controller.getState()).toMatchObject({ status: 'downloading', percent: 42 });
    autoUpdater.emit('update-downloaded', { version: '0.3.0' });
    await downloadPromise;

    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ status: 'downloaded', version: '0.3.0', percent: 100 });
  });

  it('installs only a downloaded update, and quitAndInstall closes the app itself', async () => {
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController({ autoUpdater, isPackaged: true });

    expect(controller.install()).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    autoUpdater.emit('update-available', { version: '0.3.0' });
    expect(controller.install()).toBe(false);

    autoUpdater.emit('update-downloaded', { version: '0.3.0' });
    expect(controller.install()).toBe(true);
    // isSilent=false lets the installer close the app; isForceRunAfter reopens it.
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('surfaces check and download failures as an error state', async () => {
    const autoUpdater = fakeAutoUpdater();
    autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    const controller = createUpdateController({ autoUpdater, isPackaged: true });

    const result = await controller.check();
    expect(result.status).toBe('error');

    autoUpdater.emit('update-available', { version: '0.3.0' });
    autoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('broken pipe'));
    const downloadResult = await controller.download();
    expect(downloadResult.status).toBe('error');
  });

  it('recovers from the updater error event into an error state once', () => {
    const autoUpdater = fakeAutoUpdater();
    const sent = [];
    const controller = createUpdateController({ autoUpdater, isPackaged: true, send: (s) => sent.push(s) });
    autoUpdater.emit('error', new Error('boom'));
    autoUpdater.emit('error', new Error('boom again'));
    expect(controller.getState().status).toBe('error');
    expect(sent.filter((s) => s.status === 'error')).toHaveLength(1);
  });

  it('schedules a startup check plus a slow cadence, and stops cleanly', () => {
    const timeouts = [];
    const intervals = [];
    const autoUpdater = fakeAutoUpdater();
    const controller = createUpdateController({ autoUpdater, isPackaged: true });

    const stop = startUpdateScheduling(controller, {
      startupDelayMs: 10,
      intervalMs: 1000,
      setTimeoutFn: (fn, ms) => { timeouts.push({ fn, ms }); return 't1'; },
      setIntervalFn: (fn, ms) => { intervals.push({ fn, ms }); return 'i1'; },
    });

    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(10);
    expect(intervals).toHaveLength(1);
    expect(intervals[0].ms).toBe(1000);

    timeouts[0].fn();
    intervals[0].fn();
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

    // Stop hooks into the real clear functions; here we just verify it is callable.
    expect(() => stop()).not.toThrow();
  });

  it('does not schedule checks when updates are disabled', () => {
    const controller = createUpdateController({ autoUpdater: null, isPackaged: false });
    let scheduled = 0;
    const stop = startUpdateScheduling(controller, {
      setTimeoutFn: () => { scheduled += 1; return 1; },
      setIntervalFn: () => { scheduled += 1; return 1; },
    });
    expect(scheduled).toBe(0);
    expect(() => stop()).not.toThrow();
  });
});
