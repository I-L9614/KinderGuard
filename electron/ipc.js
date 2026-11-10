import { ipcMain, Notification } from 'electron';

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
