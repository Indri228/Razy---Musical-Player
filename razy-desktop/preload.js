const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('razyDiscord', {
  update: s => ipcRenderer.send('presence', s),
  onStatus: cb => ipcRenderer.on('discord-status', (_e, s) => cb(s)),
  getStatus: () => ipcRenderer.invoke('discord:status'),
  setId: id => ipcRenderer.invoke('discord:setId', id),
  retry: () => ipcRenderer.invoke('discord:retry')
});
contextBridge.exposeInMainWorld('razyNet', { search: (q, o) => ipcRenderer.invoke('search', q, o), popular: o => ipcRenderer.invoke('popular', o), lyrics: (a, t, d) => ipcRenderer.invoke('lyrics', a, t, d), section: (k, o, s) => ipcRenderer.invoke('section', k, o, s), suggest: q => ipcRenderer.invoke('suggest', q), match: (a, t, o) => ipcRenderer.invoke('match', a, t, o), getProxy: () => ipcRenderer.invoke('proxy:get'), setProxy: r => ipcRenderer.invoke('proxy:set', r), spotify: u => ipcRenderer.invoke('spotify:playlist', u) });
contextBridge.exposeInMainWorld('razyMail', {
  send: e => ipcRenderer.invoke('mail:send', e),
  check: (e, c) => ipcRenderer.invoke('mail:check', e, c),
  setCfg: c => ipcRenderer.invoke('mail:setCfg', c)
});
contextBridge.exposeInMainWorld('razyYT', { search: (k, q) => ipcRenderer.invoke('yt:search', k, q) });
contextBridge.exposeInMainWorld('razyCfg', { get: () => ipcRenderer.invoke('cfg:get') });
contextBridge.exposeInMainWorld('razyMini', {
  state: s => ipcRenderer.send('mini:state', s),
  viz: a => ipcRenderer.send('mini:viz', a),
  cfg: c => ipcRenderer.send('mini:cfg', c),
  preview: () => ipcRenderer.send('mini:preview'),
  onCmd: cb => ipcRenderer.on('mini:cmd', (_e, c) => cb(c)),
  onVisible: cb => ipcRenderer.on('mini:visible', (_e, v) => cb(v))
});
