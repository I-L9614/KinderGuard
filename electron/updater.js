// In-app updates for the packaged desktop app.
//
// Flow: the app checks the configured releases feed (GitHub Releases) for a
// newer version. When one exists it only MARKS it - the renderer shows a
// yellow dot on the update button. Nothing downloads or installs until the
// user clicks the button and approves. Once approved, the update downloads in
// the background, and installing it closes the app by itself (quitAndInstall),
// runs the installer and reopens the app. User data, settings and uploads
// live outside the install folder (MongoDB and the OS user-data folder), so
// they carry over. Unsaved form input is lost like on any app close, so the
// install dialog tells the user to save open forms first.
//
// The controller is a small state machine so it can be unit-tested with a fake
// autoUpdater; main.js wires it to electron-updater and the real window.

export const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const UPDATE_STARTUP_DELAY_MS = 15 * 1000;

export const createUpdateController = ({ autoUpdater = null, isPackaged = false, send = () => {}, log = () => {} } = {}) => {
  let state = { status: isPackaged && autoUpdater ? 'idle' : 'disabled', version: null, percent: null, error: null };

  const setState = (patch) => {
    state = { ...state, ...patch };
    send(state);
    return state;
  };

  const getState = () => state;

  if (autoUpdater) {
    // Never download on its own: the user approves the download explicitly.
    autoUpdater.autoDownload = false;
    // "מאוחר יותר" means later, not a hidden commitment: never install on an
    // unrelated quit. Installation happens only from the install dialog.
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => setState({ status: 'available', version: info?.version || null, percent: null, error: null }));
    autoUpdater.on('update-not-available', () => setState({ status: 'uptodate', version: null, percent: null, error: null }));
    autoUpdater.on('download-progress', (progress) => setState({ status: 'downloading', percent: Math.round(progress?.percent ?? 0), error: null }));
    autoUpdater.on('update-downloaded', (info) => setState({ status: 'downloaded', version: info?.version || state.version, percent: 100, error: null }));
    autoUpdater.on('error', (error) => {
      log(`update error: ${error?.message || error}`);
      if (state.status !== 'error') setState({ status: 'error', percent: null, error: 'update-failed' });
    });
  }

  const check = async () => {
    if (!isPackaged || !autoUpdater) return setState({ status: 'disabled' });
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      // The 'error' event usually fires too; only set it here if it did not.
      log(`update check failed: ${error?.message || error}`);
      if (state.status !== 'error') setState({ status: 'error', percent: null, error: 'update-check-failed' });
    }
    return state;
  };

  const download = async () => {
    if (!isPackaged || !autoUpdater) return setState({ status: 'disabled' });
    if (state.status !== 'available' && state.status !== 'error') return state;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log(`update download failed: ${error?.message || error}`);
      if (state.status !== 'error') setState({ status: 'error', percent: null, error: 'update-download-failed' });
    }
    return state;
  };

  // quitAndInstall closes the app itself, runs the installer and reopens the
  // new version - no manual quit. isForceRunAfter makes the new version start
  // again right after the installer finishes.
  const install = () => {
    if (state.status !== 'downloaded' || !autoUpdater) return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
  };

  return { getState, check, download, install };
};

// Install authorization, enforced by the main process on the update-install
// IPC so no caller can bypass the renderer's dialogs. A pending write always
// blocks - a half-written record is never discarded. Unsaved forms block too,
// unless the user explicitly chose "discard and install" in the dialog.
export const decideUpdateInstall = (guardState, { discardUnsaved = false } = {}) => {
  if ((guardState?.pendingWrites || 0) > 0) return { allow: false, reason: 'pending-writes' };
  if ((guardState?.dirtyForms || 0) > 0 && !discardUnsaved) return { allow: false, reason: 'unsaved-forms' };
  return { allow: true };
};

// Checks once shortly after startup (so it does not race app boot) and then on
// a slow cadence while the app runs, including from the tray.
export const startUpdateScheduling = (controller, { startupDelayMs = UPDATE_STARTUP_DELAY_MS, intervalMs = UPDATE_CHECK_INTERVAL_MS, setTimeoutFn = setTimeout, setIntervalFn = setInterval } = {}) => {
  if (!controller || controller.getState().status === 'disabled') return () => {};
  const startupTimer = setTimeoutFn(() => controller.check(), startupDelayMs);
  const interval = setIntervalFn(() => controller.check(), intervalMs);
  return () => { clearTimeout(startupTimer); clearInterval(interval); };
};
