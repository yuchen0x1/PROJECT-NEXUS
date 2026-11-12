const { contextBridge, ipcRenderer } = require('electron')

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld('nexusDesktop', Object.freeze({
  requestApi: (request) => invoke('desktop:api:request', request),
  getInfo: () => invoke('desktop:info'),
  detectEnvironment: () => invoke('desktop:environment:detect'),
  listProjects: () => invoke('desktop:projects:list'),
  addProject: (dialogTitle) => invoke('desktop:projects:add', dialogTitle),
  removeProject: (projectId, projectName, dialogText) => invoke('desktop:projects:remove', projectId, projectName, dialogText),
  scanProject: (projectId) => invoke('desktop:projects:scan', projectId),
  setAutoStart: (enabled) => invoke('desktop:settings:auto-start', enabled),
  getSettings: () => invoke('desktop:settings:get'),
  updateSettings: (partial) => invoke('desktop:settings:update', partial)
}))
