// Gives the player page (and the mini player) a small, safe set of desktop features.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => { ipcRenderer.on(channel, (_e, data) => cb(data)); };

contextBridge.exposeInMainWorld('pocketDesktop', {
  platform: process.platform,
  // library
  scan: () => ipcRenderer.invoke('scan'),
  folders: () => ipcRenderer.invoke('folders'),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (folder) => ipcRenderer.invoke('remove-folder', folder),
  takeOpenFiles: () => ipcRenderer.invoke('take-open-files'),
  resolve: (paths) => ipcRenderer.invoke('resolve-paths', paths),
  onTags: on('tags'),
  onOpenFiles: on('open-files'),
  onLibraryChanged: on('library-changed'),
  // songs
  lyrics: (file) => ipcRenderer.invoke('lyrics', file),
  saveLyrics: (data) => ipcRenderer.invoke('save-lyrics', data),
  findLyrics: (query) => ipcRenderer.invoke('find-lyrics', query),
  editTags: (data) => ipcRenderer.invoke('edit-tags', data),
  showInFolder: (file) => ipcRenderer.invoke('show-in-folder', file),
  importM3u: () => ipcRenderer.invoke('import-m3u'),
  exportM3u: (data) => ipcRenderer.invoke('export-m3u', data),
  // player state for the tray, taskbar, mini player and Discord
  sendState: (state) => ipcRenderer.send('state', state),
  getState: () => ipcRenderer.invoke('get-state'),
  onState: on('state'),
  onCommand: on('command'),
  command: (cmd, value) => ipcRenderer.send('command', { cmd, value }),
  toggleMini: () => ipcRenderer.send('toggle-mini'),
  miniExpand: () => ipcRenderer.send('mini-expand'),
  miniClose: () => ipcRenderer.send('mini-close'),
  // downloads and online
  dlInspect: (url) => ipcRenderer.invoke('dl-inspect', url),
  dlAdd: (d) => ipcRenderer.invoke('dl-add', d),
  dlList: () => ipcRenderer.invoke('dl-list'),
  dlCancel: (id) => ipcRenderer.invoke('dl-cancel', id),
  dlRetry: (id) => ipcRenderer.invoke('dl-retry', id),
  dlClear: () => ipcRenderer.invoke('dl-clear'),
  dlShow: (id) => ipcRenderer.invoke('dl-show', id),
  dlFolder: () => ipcRenderer.invoke('dl-folder'),
  dlDir: () => ipcRenderer.invoke('dl-dir'),
  onDlUpdate: on('dl-update'),
  onDlDone: on('dl-done'),
  clipboardText: () => ipcRenderer.invoke('clipboard-text'),
  webGet: (url, as) => ipcRenderer.invoke('web-get', { url, as }),
  // files arriving from a connected device
  recvOpen: (name) => ipcRenderer.invoke('recv-open', name),
  recvWrite: (id, chunk) => ipcRenderer.invoke('recv-write', id, chunk),
  recvClose: (id, kind) => ipcRenderer.invoke('recv-close', id, kind),
  recvAbort: (id) => ipcRenderer.invoke('recv-abort', id),
  // PC settings
  getSettings: () => ipcRenderer.invoke('get-pc-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-pc-settings', patch),
  onDiscord: on('discord'),
  power: (action) => ipcRenderer.invoke('power', action)
});
