'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('data:load'),
  db: (op, ...args) => ipcRenderer.invoke('db', op, ...args),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),
  openDataFolder: () => ipcRenderer.invoke('open:data-folder'),
  openBackupsFolder: () => ipcRenderer.invoke('open:backups-folder'),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  moveDatabase: () => ipcRenderer.invoke('db:move'),
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setStartup: (opts) => ipcRenderer.invoke('startup:set', opts),
  saveAttachment: (id) => ipcRenderer.invoke('attachment:save', id),
  copyAttachment: (id) => ipcRenderer.invoke('attachment:copy', id),
  // name: 'password' (default) or an extra secret such as 'backupCodes' or 'totp'
  // 'light' | 'dark' | 'system': the window frame, menus and Windows dialogs follow it
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),
  revealSecret: (assetId, name) => ipcRenderer.invoke('secret:reveal', assetId, name),
  copySecret: (assetId, name) => ipcRenderer.invoke('secret:copy', assetId, name),
  // current 2-step verification code from the saved setup key: { code, remaining, period } or null
  secretCode: (assetId) => ipcRenderer.invoke('secret:code', assetId),
  // database encryption: state, unlock, pickFile, encrypt, changePassword, setRemember
  security: (op, ...args) => ipcRenderer.invoke('security', op, ...args),
  // the main process needs the password of an encrypted backup: reply(password or null)
  onAskPassword: (cb) => ipcRenderer.on('ask-password', (_e, req) =>
    cb(req, (password) => ipcRenderer.send('ask-password:reply', req.id, password))),
  onDataReplaced: (cb) => ipcRenderer.on('data:replaced', (_e, data) => cb(data)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
});
