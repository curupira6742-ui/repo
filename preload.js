const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  loginAccount: () => ipcRenderer.invoke('accounts:login'),
  switchAccount: (id) => ipcRenderer.invoke('accounts:switch', id),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  getNextAccount: (excludeIds) => ipcRenderer.invoke('accounts:next', excludeIds),

  chatgptGetAccount: () => ipcRenderer.invoke('chatgpt:get-account'),
  chatgptConnect: () => ipcRenderer.invoke('chatgpt:connect'),
  chatgptDisconnect: () => ipcRenderer.invoke('chatgpt:disconnect'),

  getPolicies: () => ipcRenderer.invoke('policies:get'),
  savePolicies: (policies) => ipcRenderer.invoke('policies:save', policies),
  getAgentsMd: (targetRoot) => ipcRenderer.invoke('agents-md:get', targetRoot),
  saveAgentsMd: (targetRoot, content) => ipcRenderer.invoke('agents-md:save', { targetRoot, content }),

  listModels: () => ipcRenderer.invoke('models:list'),

  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  defaultWorkspace: () => ipcRenderer.invoke('workspace:default'),
  getWorkspaceTree: (rootDir) => ipcRenderer.invoke('workspace:tree', rootDir),
  readFile: (filePath) => ipcRenderer.invoke('workspace:read-file', filePath),
  saveFile: (filePath, content) => ipcRenderer.invoke('workspace:save-file', { filePath, content }),

  gitStatus: (workspaceRoot) => ipcRenderer.invoke('workspace:git-status', workspaceRoot),
  gitCommit: (workspaceRoot, message) => ipcRenderer.invoke('workspace:git-commit', { workspaceRoot, message }),

  undoCheckpoint: (chatId) => ipcRenderer.invoke('checkpoint:undo', chatId),
  getAuditLogs: () => ipcRenderer.invoke('audit:get-logs'),
  sendNotification: (title, body) => ipcRenderer.invoke('notification:send', { title, body }),

  loadChats: () => ipcRenderer.invoke('chats:load'),
  saveChats: (chats) => ipcRenderer.invoke('chats:save', chats),

  sendMessage: (payload) => ipcRenderer.invoke('agent:send', payload),
  abortMessage: () => ipcRenderer.invoke('agent:abort'),

  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),

  onStreamChunk: (cb) => {
    const handler = (_, chunk) => cb(chunk);
    ipcRenderer.on('agent:stream-chunk', handler);
    return () => ipcRenderer.removeListener('agent:stream-chunk', handler);
  },

  onToolEvent: (cb) => {
    const handler = (_, evt) => cb(evt);
    ipcRenderer.on('agent:tool-event', handler);
    return () => ipcRenderer.removeListener('agent:tool-event', handler);
  },

  onConfirmRequest: (cb) => {
    const handler = (_, req) => cb(req);
    ipcRenderer.on('tool:confirm-request', handler);
    return () => ipcRenderer.removeListener('tool:confirm-request', handler);
  },

  respondConfirmation: (confirmId, approved) => {
    ipcRenderer.send('tool:confirm-response', { confirmId, approved });
  }
});

// Suporte ao contrato do README
contextBridge.exposeInMainWorld('geminiBridge', {
  async sendMessage(params) {
    if (typeof window !== 'undefined' && window.__geminiBridgeHandler) {
      return window.__geminiBridgeHandler(params);
    }
    return { text: 'Bridge pronta.' };
  }
});
