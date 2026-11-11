import { ipcMain, Notification } from 'electron';
import { decideUpdateInstall } from './updater.js';

export const setupIpcHandlers = (getMainWindow = () => null) => {
  ipcMain.handle('check-licenses-now', async () => {
    return { requested: true };
  });

  ipcMain.handle('show-license-notification', async (_event, payload) => {
    if (!Notification.isSupported()) return false;
    // silent: false keeps the OS alert sound; timeoutType 'never' keeps the toast
    // on screen until the user dismisses it; clicking it brings the app forward.
    const notification = new Notification({
      title: String(payload?.title || 'KinderGuard'),
      body: String(payload?.body || ''),
      silent: false,
      urgency: 'critical',
      timeoutType: 'never',
    });
    notification.on('click', () => {
      const win = getMainWindow();
      if (win) { win.show(); win.focus(); }
    });
    notification.show();
    return true;
  });

  ipcMain.on('log', (event, message) => {
    console.log('[Frontend]', message);
  });
};

// Update flow IPC. getController is a getter because the controller is created
// after the window exists; handlers resolve it per call. The renderer reports
// its guard state (unsaved forms, in-flight writes) and the install handler
// enforces it here, so no caller can bypass the renderer's decision dialogs.
export const setupUpdateIpcHandlers = (getController) => {
  let lastGuardState = null;
  ipcMain.on('update-guard-state', (_event, state) => {
    lastGuardState = {
      dirtyForms: Math.max(0, Number(state?.dirtyForms) || 0),
      pendingWrites: Math.max(0, Number(state?.pendingWrites) || 0),
      pendingUploads: Math.max(0, Number(state?.pendingUploads) || 0),
    };
  });
  ipcMain.handle('update-get-state', () => getController()?.getState() || { status: 'disabled' });
  ipcMain.handle('update-check', () => getController()?.check() || { status: 'disabled' });
  ipcMain.handle('update-download', () => getController()?.download() || { status: 'disabled' });
  ipcMain.handle('update-install', (_event, options) => {
    const decision = decideUpdateInstall(lastGuardState, { discardUnsaved: !!options?.discardUnsaved });
    if (!decision.allow) return { installed: false, reason: decision.reason };
    return { installed: getController()?.install() || false };
  });
};
