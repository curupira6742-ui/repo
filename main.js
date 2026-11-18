const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { AccountManager } = require('./auth');
const { ChatGPTAccountManager } = require('./chatgpt-web');
const {
  runAgentTurn,
  fetchAccountModels,
  getCommandAuditLogs,
  rollbackChatCheckpoint
} = require('./agent');

let mainWindow;
let accountManager;
let chatgptManager;
let chatsFile;
let policiesFile;
let activeAbortController = null;
const pendingConfirmations = new Map();

const DEFAULT_POLICIES = {
  geminiRules: '# Regras Globais do Gemini (Arquiteto & Dev)\n- Priorize código limpo, modular, resiliente e tipado.\n- Verifique caminhos de arquivo antes de editar.\n- Quando comandos de terminal falharem, analise o erro e auto-corrija automaticamente.',
  chatgptRules: '# Regras Globais do ChatGPT Web (Pesquisador)\n- Forneça respostas técnicas, diretas ao ponto e atualizadas.\n- Indique versões estáveis de pacotes e sintaxe recomendada.\n- Aponte armadilhas comuns e forneça exemplos prontos para aplicação.'
};

function loadPolicies() {
  try {
    if (fs.existsSync(policiesFile)) {
      return { ...DEFAULT_POLICIES, ...JSON.parse(fs.readFileSync(policiesFile, 'utf-8')) };
    }
  } catch (_) {}
  return { ...DEFAULT_POLICIES };
}

function savePolicies(policies) {
  try {
    fs.writeFileSync(policiesFile, JSON.stringify(policies, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function loadChats() {
  try {
    if (fs.existsSync(chatsFile)) {
      return JSON.parse(fs.readFileSync(chatsFile, 'utf-8'));
    }
  } catch (_) {}
  return [];
}

let saveChatsTimer = null;
function saveChats(chats) {
  if (saveChatsTimer) clearTimeout(saveChatsTimer);
  saveChatsTimer = setTimeout(() => {
    try {
      fs.writeFileSync(chatsFile, JSON.stringify(chats, null, 2), 'utf-8');
    } catch (_) {}
  }, 500);
}

function buildWorkspaceTree(rootDir, depth = 0, maxDepth = 3) {
  const ignored = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
  if (depth > maxDepth) return [];

  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  return entries
    .filter((e) => !ignored.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 100)
    .map((entry) => {
      const fullPath = path.join(rootDir, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file',
        children: entry.isDirectory() ? buildWorkspaceTree(fullPath, depth + 1, maxDepth) : []
      };
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#000000',
    frame: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  const showAndFocus = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.restore();
      mainWindow.focus();
    }
  };

  mainWindow.once('ready-to-show', showAndFocus);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(showAndFocus);
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  accountManager = new AccountManager(userData);
  chatgptManager = new ChatGPTAccountManager(userData);
  chatsFile = path.join(userData, 'chats.json');
  policiesFile = path.join(userData, 'policies.json');

  ipcMain.handle('policies:get', () => loadPolicies());
  ipcMain.handle('policies:save', (_, policies) => savePolicies(policies));

  ipcMain.handle('agents-md:get', (_, targetRoot) => {
    const root = targetRoot || process.cwd();
    const agentsPath = path.join(root, 'AGENTS.md');
    try {
      if (fs.existsSync(agentsPath)) {
        return { ok: true, path: agentsPath, content: fs.readFileSync(agentsPath, 'utf-8') };
      }
      const alt = path.join(root, '.geminirules');
      if (fs.existsSync(alt)) {
        return { ok: true, path: alt, content: fs.readFileSync(alt, 'utf-8') };
      }
    } catch (_) {}
    return { ok: true, path: agentsPath, content: '' };
  });

  ipcMain.handle('agents-md:save', (_, { targetRoot, content }) => {
    const root = targetRoot || process.cwd();
    const agentsPath = path.join(root, 'AGENTS.md');
    try {
      fs.writeFileSync(agentsPath, content, 'utf-8');
      return { ok: true, path: agentsPath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('accounts:list', () => accountManager.listAccounts());
  ipcMain.handle('accounts:login', () => accountManager.loginNewAccount(mainWindow));
  ipcMain.handle('accounts:switch', (_, id) => accountManager.setActiveAccount(id));
  ipcMain.handle('accounts:remove', (_, id) => accountManager.removeAccount(id));
  ipcMain.handle('accounts:next', (_, excludeIds) => accountManager.getNextAccount(excludeIds));

  ipcMain.handle('chatgpt:get-account', () => {
    return chatgptManager ? chatgptManager.getAccountInfo() : { connected: false };
  });
  ipcMain.handle('chatgpt:connect', () => {
    if (!chatgptManager) throw new Error('ChatGPT manager não inicializado.');
    return chatgptManager.connectViaBrowser(mainWindow);
  });
  ipcMain.handle('chatgpt:disconnect', () => {
    if (!chatgptManager) return { ok: true };
    return chatgptManager.disconnect();
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('window:maximize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
  });
  ipcMain.handle('window:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  });
  ipcMain.handle('window:is-maximized', () => {
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow.isMaximized() : false;
  });

  ipcMain.handle('models:list', async () => {
    return fetchAccountModels(accountManager);
  });

  ipcMain.handle('workspace:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('workspace:default', () => {
    // Se estiver rodando dentro do executável compilado em dist, aponta para a pasta do projeto ou para a home do usuário
    const cwd = process.cwd();
    const isPackagedDist = cwd.toLowerCase().includes('dist\\gemini-bw-agent') || cwd.toLowerCase().includes('dist/gemini-bw-agent');
    if (isPackagedDist) {
      const devProjectRoot = 'C:\\Users\\kayyk\\.gemini\\antigravity\\scratch\\gemini-bw-agent';
      if (fs.existsSync(devProjectRoot)) return devProjectRoot;
    }
    return cwd;
  });
  ipcMain.handle('workspace:tree', (_, rootDir) => buildWorkspaceTree(rootDir));
  ipcMain.handle('workspace:read-file', (_, filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        const stat = fs.statSync(filePath);
        if (stat.size > 1024 * 1024 * 2) {
          return { ok: false, error: 'Arquivo muito grande (> 2MB)' };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        return { ok: true, content, size: stat.size };
      }
      return { ok: false, error: 'Arquivo não encontrado' };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('workspace:save-file', (_, { filePath, content }) => {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('workspace:git-status', (_, workspaceRoot) => {
    return new Promise((resolve) => {
      exec('git status --short && git branch --show-current', { cwd: workspaceRoot, timeout: 5000 }, (err, stdout) => {
        if (err) return resolve({ isGit: false });
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        const branch = lines.pop() || 'main';
        resolve({ isGit: true, branch, changedCount: lines.length, files: lines });
      });
    });
  });

  ipcMain.handle('workspace:git-commit', (_, { workspaceRoot, message }) => {
    return new Promise((resolve) => {
      exec(`git add -A && git commit -m ${JSON.stringify(message)}`, { cwd: workspaceRoot, timeout: 10000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout.trim(), stderr: err ? stderr || err.message : '' });
      });
    });
  });

  ipcMain.handle('checkpoint:undo', (_, chatId) => {
    return rollbackChatCheckpoint(chatId);
  });

  ipcMain.handle('audit:get-logs', () => {
    return getCommandAuditLogs();
  });

  ipcMain.handle('notification:send', (_, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({
        title: title || 'Gemini Agent',
        body: body || 'Ação concluída na máquina.'
      }).show();
      return true;
    }
    return false;
  });

  ipcMain.handle('chats:load', () => loadChats());
  ipcMain.handle('chats:save', (_, chats) => {
    saveChats(chats);
    return true;
  });

  ipcMain.on('tool:confirm-response', (_, { confirmId, approved }) => {
    const resolver = pendingConfirmations.get(confirmId);
    if (resolver) {
      pendingConfirmations.delete(confirmId);
      resolver(Boolean(approved));
    }
  });

  ipcMain.handle('agent:abort', () => {
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
      return true;
    }
    return false;
  });

  ipcMain.handle('agent:send', async (_, { model, contents, webContext, workspaceRoot, executionMode, chatId }) => {
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeAbortController = new AbortController();

    try {
      return await runAgentTurn({
        accountManager,
        chatgptManager,
        policies: loadPolicies(),
        model,
        contents,
        webContext,
        workspaceRoot,
        executionMode,
        currentChatId: chatId,
        signal: activeAbortController.signal,
        onStreamChunk: (chunk) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:stream-chunk', chunk);
          }
        },
        onToolEvent: (evt) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('agent:tool-event', evt);
          }
        },
        requestConfirmation: ({ name, args }) =>
          new Promise((resolve) => {
            const confirmId = `cfm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            pendingConfirmations.set(confirmId, resolve);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('tool:confirm-request', { confirmId, name, args });
            } else {
              resolve(false);
            }
          })
      });
    } finally {
      activeAbortController = null;
    }
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
