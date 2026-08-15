/**
 * Sandboxed preload bridge for the desktop shell: exposes the wallpaper
 * controls to the web UI without granting Node access.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshDesktop', {
  changeBackground: () => ipcRenderer.invoke('desktop:change-background'),
  clearBackground: () => ipcRenderer.invoke('desktop:clear-background'),
  getBalance: () => ipcRenderer.invoke('desktop:get-balance'),
})
