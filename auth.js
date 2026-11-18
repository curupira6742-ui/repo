const { spawn } = require('child_process');
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { initGeminiWebSession } = require('./gemini-web');

function findSystemBrowser() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];

  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Cliente WebSocket nativo sobre http/crypto para falar com o Chrome DevTools Protocol sem depender de WebSocket global
function cdpRequest(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const wsKey = crypto.randomBytes(16).toString('base64');

    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': wsKey,
        'Sec-WebSocket-Version': '13'
      }
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout CDP em ${method}`));
    }, 6000);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('upgrade', (_, socket) => {
      const payloadBuf = Buffer.from(JSON.stringify({ id: 1, method, params }), 'utf-8');
      const mask = crypto.randomBytes(4);
      let header;

      if (payloadBuf.length < 126) {
        header = Buffer.from([0x81, 0x80 | payloadBuf.length]);
      } else if (payloadBuf.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payloadBuf.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(payloadBuf.length), 2);
      }

      const maskedPayload = Buffer.alloc(payloadBuf.length);
      for (let i = 0; i < payloadBuf.length; i++) {
        maskedPayload[i] = payloadBuf[i] ^ mask[i % 4];
      }

      socket.write(Buffer.concat([header, mask, maskedPayload]));

      let recvBuf = Buffer.alloc(0);
      const fragments = [];

      socket.on('data', (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);

        while (recvBuf.length >= 2) {
          const fin = (recvBuf[0] & 0x80) !== 0;
          const opcode = recvBuf[0] & 0x0f;
          const masked = (recvBuf[1] & 0x80) !== 0;
          let len = recvBuf[1] & 0x7f;
          let offset = 2;

          if (len === 126) {
            if (recvBuf.length < 4) return;
            len = recvBuf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (recvBuf.length < 10) return;
            len = Number(recvBuf.readBigUInt64BE(2));
            offset = 10;
          }

          if (masked) offset += 4;
          if (recvBuf.length < offset + len) return;

          const frameData = recvBuf.subarray(offset, offset + len);
          recvBuf = recvBuf.subarray(offset + len);

          if (opcode === 0x08) {
            clearTimeout(timer);
            socket.destroy();
            return;
          }

          if (opcode === 0x01 || opcode === 0x00) {
            fragments.push(frameData);
            if (fin) {
              const fullText = Buffer.concat(fragments).toString('utf-8');
              fragments.length = 0;
              try {
                const msg = JSON.parse(fullText);
                if (msg.id === 1) {
                  clearTimeout(timer);
                  socket.destroy();
                  if (msg.error) reject(new Error(msg.error.message));
                  else resolve(msg.result);
                  return;
                }
              } catch (_) {}
            }
          }
        }
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    req.end();
  });
}

class AccountManager {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.storePath = path.join(userDataPath, 'accounts.json');
    this.profilesRoot = path.join(userDataPath, 'browser-profiles');
    fs.mkdirSync(this.profilesRoot, { recursive: true });
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
        if (Array.isArray(parsed.accounts)) return parsed;
      }
    } catch (_) {}
    return { activeId: null, accounts: [] };
  }

  _save() {
    fs.writeFileSync(this.storePath, JSON.stringify(this.data, null, 2), 'utf-8');
  }

  listAccounts() {
    return {
      activeId: this.data.activeId,
      accounts: this.data.accounts.map((acc) => ({
        id: acc.id,
        email: acc.email,
        addedAt: acc.addedAt,
        needsReconnect: !Array.isArray(acc.cookies) || acc.cookies.length === 0
      }))
    };
  }

  getActiveAccountRecord() {
    const acc = this.data.accounts.find((a) => a.id === this.data.activeId);
    if (!acc) throw new Error('Nenhuma conta Google conectada.');
    if (!Array.isArray(acc.cookies) || acc.cookies.length === 0) {
      throw new Error(`A conta ${acc.email} precisa ser reconectada.`);
    }
    return acc;
  }

  updateAccountCookies(updatedAccount) {
    const idx = this.data.accounts.findIndex((a) => a.id === updatedAccount.id);
    if (idx >= 0) {
      this.data.accounts[idx] = updatedAccount;
      this._save();
    }
  }

  setActiveAccount(id) {
    const exists = this.data.accounts.find((a) => a.id === id);
    if (!exists) throw new Error('Conta não encontrada.');
    this.data.activeId = id;
    this._save();
    return this.listAccounts();
  }

  getNextAccount(excludeIds = []) {
    const excluded = new Set(excludeIds);
    return (
      this.data.accounts.find(
        (a) => !excluded.has(a.id) && Array.isArray(a.cookies) && a.cookies.length > 0
      ) || null
    );
  }

  removeAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeId === id) {
      this.data.activeId = this.data.accounts[0]?.id || null;
    }
    this._save();
    return this.listAccounts();
  }

  async loginNewAccount(parentWindow) {
    const browserExe = findSystemBrowser();
    if (!browserExe) {
      throw new Error('Google Chrome ou Microsoft Edge não encontrado no sistema.');
    }

    const port = await getFreePort();
    const tempProfileDir = path.join(this.profilesRoot, `session_${Date.now()}`);
    fs.mkdirSync(tempProfileDir, { recursive: true });

    const child = spawn(
      browserExe,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${tempProfileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        'https://gemini.google.com/app'
      ],
      { stdio: 'ignore' }
    );

    let browserExited = false;
    child.on('exit', () => {
      browserExited = true;
    });

    const deadline = Date.now() + 240_000;

    try {
      while (Date.now() < deadline) {
        if (browserExited) {
          throw new Error('Janela do navegador fechada antes de concluir o login no Gemini.');
        }

        await new Promise((r) => setTimeout(r, 1200));

        let targets = [];
        try {
          const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (listRes.ok) targets = await listRes.json();
        } catch (_) {}

        const geminiTab = targets.find(
          (t) =>
            t.type === 'page' &&
            typeof t.url === 'string' &&
            t.url.startsWith('https://gemini.google.com/') &&
            t.webSocketDebuggerUrl
        );

        if (!geminiTab) continue;

        try {
          // 1. Extrai dados da sessão diretamente da página aberta do Gemini
          const evalRes = await cdpRequest(geminiTab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `JSON.stringify({
              snlm0e: (window.WIZ_global_data && window.WIZ_global_data.SNlM0e) || '',
              bl: (window.WIZ_global_data && window.WIZ_global_data.cfb2h) || '',
              fsid: (window.WIZ_global_data && window.WIZ_global_data.FdrFJe) || '',
              email: (window.WIZ_global_data && window.WIZ_global_data.oPEP7c) || ''
            })`,
            returnByValue: true
          });

          const pageData = JSON.parse(evalRes?.result?.value || '{}');
          if (!pageData.snlm0e) continue;

          // 2. Captura todos os cookies válidos da sessão Google
          const cookieRes = await cdpRequest(geminiTab.webSocketDebuggerUrl, 'Network.getAllCookies');
          const allCookies = cookieRes?.cookies || [];
          const validDomains = new Set(['.google.com', 'google.com', 'gemini.google.com', '.gemini.google.com']);
          const googleCookies = allCookies
            .filter((c) => validDomains.has(c.domain) && c.value)
            .map(({ name, value, domain, path: cPath }) => ({
              name,
              value,
              domain,
              path: cPath || '/'
            }));

          const hasPsid = googleCookies.some((c) => c.name === '__Secure-1PSID' || c.name === 'SID');
          if (!hasPsid) continue;

          let finalEmail = pageData.email;
          if (!finalEmail) {
            const sessionCheck = await initGeminiWebSession({
              id: 'pending',
              email: 'conta@gmail.com',
              cookies: googleCookies
            });
            finalEmail = sessionCheck.email;
          }

          console.log(`[AUTH] Conta conectada com sucesso: ${finalEmail} (${googleCookies.length} cookies)`);

          const accountRecord = {
            id: finalEmail,
            email: finalEmail,
            cookies: googleCookies,
            cachedSession: {
              snlm0e: pageData.snlm0e,
              bl: pageData.bl,
              fsid: pageData.fsid,
              email: finalEmail
            },
            profileDir: tempProfileDir,
            addedAt: new Date().toISOString()
          };

          const existingIdx = this.data.accounts.findIndex((a) => a.email === finalEmail);
          if (existingIdx >= 0) {
            this.data.accounts[existingIdx] = accountRecord;
          } else {
            this.data.accounts.push(accountRecord);
          }

          this.data.activeId = accountRecord.id;
          this._save();

          try { child.kill(); } catch (_) {}
          if (parentWindow && !parentWindow.isDestroyed()) {
            if (parentWindow.isMinimized()) parentWindow.restore();
            parentWindow.focus();
          }

          return this.listAccounts();
        } catch (err) {
          console.log('[AUTH] Aguardando finalização do carregamento do Gemini:', err.message);
        }
      }

      throw new Error('Tempo limite de login excedido.');
    } finally {
      if (!browserExited) {
        try { child.kill(); } catch (_) {}
      }
    }
  }
}

module.exports = { AccountManager };
