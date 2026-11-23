const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('razyMiniWin', {
  cmd: c => ipcRenderer.send('mini:cmd', c),
  onState: cb => ipcRenderer.on('mini:state', (_e, s) => cb(s)),
  onViz: cb => ipcRenderer.on('mini:viz', (_e, a) => cb(a)),
  onCfg: cb => ipcRenderer.on('mini:cfg', (_e, c) => cb(c)),
  onHover: cb => ipcRenderer.on('mini:hover', (_e, v) => cb(!!v))
});
