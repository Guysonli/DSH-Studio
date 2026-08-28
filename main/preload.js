'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesktop', {
  submitApiKey: (key) => ipcRenderer.invoke('setup:submit', key),
  getVersionInfo: () => ipcRenderer.invoke('version:info'),
  retry: () => ipcRenderer.invoke('app:retry'),
  listDshChoices: () => ipcRenderer.invoke('dsh:choices'),
  selectDshChoice: (entry) => ipcRenderer.invoke('dsh:select', entry),
  onStage: (cb) => ipcRenderer.on('app:stage', (_e, payload) => cb(payload)),
  onFatal: (cb) => ipcRenderer.on('app:fatal', (_e, payload) => cb(payload)),
});
