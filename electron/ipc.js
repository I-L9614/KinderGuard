import { ipcMain, Notification } from 'electron';

export const setupIpcHandlers = () => {
  ipcMain.handle('check-licenses-now', async () => {
    return { requested: true };
  });

  ipcMain.handle('show-license-notification', async (_event, payload) => {
    if (!Notification.isSupported()) return false;
    new Notification({ title: String(payload?.title || 'KinderGuard'), body: String(payload?.body || '') }).show();
    return true;
  });

  ipcMain.on('log', (event, message) => {
    console.log('[Frontend]', message);
  });
};
