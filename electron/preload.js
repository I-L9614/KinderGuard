import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  checkLicensesNow: () => ipcRenderer.invoke('check-licenses-now'),
  notify: (payload) => ipcRenderer.invoke('show-license-notification', payload),
  onNotificationRefresh: (callback) => ipcRenderer.on('notification-refresh-requested', callback),
  onOpenAlert: (callback) => ipcRenderer.on('open-alert', (event, target) => callback(target)),
  onLog: (callback) => ipcRenderer.on('log', (event, data) => callback(data)),
  getUpdateState: () => ipcRenderer.invoke('update-get-state'),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate: (options) => ipcRenderer.invoke('update-install', options),
  reportUpdateGuard: (state) => ipcRenderer.send('update-guard-state', state),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (event, data) => callback(data)),
});
