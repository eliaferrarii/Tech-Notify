const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('persistentNotification', {
  activate: (id) => ipcRenderer.invoke('persistent-notification:activate', id),
  close: (id) => ipcRenderer.invoke('persistent-notification:close', id),
  onData: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on('notification:data', listener);
    return () => ipcRenderer.removeListener('notification:data', listener);
  },
});
