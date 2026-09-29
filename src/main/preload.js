/**
 * preload.js - The only bridge between the interface and the main process.
 *
 * Exposes named requests rather than raw messaging so the page cannot reach
 * anything that is not listed here.
 */

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel) {
  return listener => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld('zbk', {
  startup: () => ipcRenderer.invoke('app:startup'),
  selection: () => ipcRenderer.invoke('app:selection'),
  saveConfig: changes => ipcRenderer.invoke('config:save', changes),

  chooseWorld: () => ipcRenderer.invoke('world:choose'),
  chooseResourcePack: () => ipcRenderer.invoke('pack:choose'),
  chooseServerFolder: () => ipcRenderer.invoke('server-folder:choose'),
  openServerFolder: () => ipcRenderer.invoke('server-folder:open'),
  openLink: name => ipcRenderer.invoke('link:open', name),

  startServer: request => ipcRenderer.invoke('server:start', request),
  stopServer: force => ipcRenderer.invoke('server:stop', force),
  sendCommand: command => ipcRenderer.invoke('server:command', command),
  setOperator: (name, enabled) => ipcRenderer.invoke('server:operator', name, enabled),

  onStatus: subscribe('server:status'),
  onLog: subscribe('server:log'),
  onPlayers: subscribe('server:players')
});
