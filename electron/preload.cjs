// IMPORTANT: this file must stay CommonJS (.cjs). The project is ESM
// ("type": "module"), and sandboxed Electron preloads only load as CJS - an
// ESM preload fails silently in the renderer and window.electronAPI never
// appears (the v0.2.4 installed-app regression this fixes).
const { contextBridge, ipcRenderer } = require('electron');

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
