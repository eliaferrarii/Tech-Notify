const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('techNotify', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (payload) => ipcRenderer.invoke('config:save', payload),
  checkNow: () => ipcRenderer.invoke('notifications:check-now'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  getLog: () => ipcRenderer.invoke('log:get'),
  showWindow: () => ipcRenderer.invoke('window:show'),
  onStatus: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('notifications:status', listener);
    return () => ipcRenderer.removeListener('notifications:status', listener);
  },
  onUpdaterStatus: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.removeListener('updater:status', listener);
  },
  onLogUpdated: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('log:updated', listener);
    return () => ipcRenderer.removeListener('log:updated', listener);
  },
});
