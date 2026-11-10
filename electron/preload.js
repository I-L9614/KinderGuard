import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  checkLicensesNow: () => ipcRenderer.invoke('check-licenses-now'),
  notify: (payload) => ipcRenderer.invoke('show-license-notification', payload),
  onNotificationRefresh: (callback) => ipcRenderer.on('notification-refresh-requested', callback),
  onLog: (callback) => ipcRenderer.on('log', (event, data) => callback(data)),
});
