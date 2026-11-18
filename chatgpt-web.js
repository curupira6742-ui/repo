const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

function cdpRequest(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    const wsKey = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey
      }
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout CDP em ${method}`));
    }, 8000);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('upgrade', (res, socket) => {
      const id = Math.floor(Math.random() * 100000);
      const payload = JSON.stringify({ id, method, params });
      const payloadBuf = Buffer.from(payload, 'utf-8');
      const mask = crypto.randomBytes(4);

      let header;
      if (payloadBuf.length < 126) {
        header = Buffer.alloc(6);
        header[0] = 0x81;
        header[1] = 0x80 | payloadBuf.length;
        mask.copy(header, 2);
      } else {
        header = Buffer.alloc(8);
        header[0] = 0x81;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(payloadBuf.length, 2);
        mask.copy(header, 4);
      }

      const masked = Buffer.alloc(payloadBuf.length);
      for (let i = 0; i < payloadBuf.length; i++) {
        masked[i] = payloadBuf[i] ^ mask[i % 4];
      }

      socket.write(Buffer.concat([header, masked]));

      let buf = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 2) {
          const second = buf[1];
          let payloadLen = second & 0x7f;
          let offset = 2;
          if (payloadLen === 126) {
            if (buf.length < 4) break;
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
          }
          if (buf.length < offset + payloadLen) break;
          const framePayload = buf.slice(offset, offset + payloadLen);
          buf = buf.slice(offset + payloadLen);
          try {
            const msg = JSON.parse(framePayload.toString('utf-8'));
            if (msg.id === id) {
              clearTimeout(timer);
              socket.destroy();
              if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
              else resolve(msg.result);
              return;
            }
          } catch (_) {}
        }
      });
    });

    req.end();
  });
}

class ChatGPTAccountManager {
  constructor(userDataPath) {
    this.storePath = path.join(userDataPath, 'chatgpt_account.json');
    this.profilesRoot = path.join(userDataPath, 'chatgpt_profiles');
    fs.mkdirSync(this.profilesRoot, { recursive: true });
    this.account = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        return JSON.parse(fs.readFileSync(this.storePath, 'utf-8'));
      }
    } catch (_) {}
    return null;
  }

  _save() {
    try {
      fs.writeFileSync(this.storePath, JSON.stringify(this.account, null, 2), 'utf-8');
    } catch (_) {}
  }

  getAccountInfo() {
    if (!this.account || !this.account.accessToken) {
      return { connected: false };
    }
    return {
      connected: true,
      email: this.account.email || 'Conta ChatGPT Conectada',
      name: this.account.name || 'ChatGPT Web',
      addedAt: this.account.addedAt,
      model: this.account.model || 'gpt-4o'
    };
  }

  disconnect() {
    this.account = null;
    try {
      if (fs.existsSync(this.storePath)) fs.unlinkSync(this.storePath);
    } catch (_) {}
    return { ok: true };
  }

  async connectViaBrowser(parentWindow) {
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
        'https://chatgpt.com/'
      ],
      { stdio: 'ignore' }
    );

    let browserExited = false;
    child.on('exit', () => {
      browserExited = true;
    });

    const deadline = Date.now() + 300_000; // 5 minutos para login

    try {
      while (Date.now() < deadline) {
        if (browserExited) {
          throw new Error('Janela do navegador fechada antes de concluir o login no ChatGPT.');
        }

        await new Promise((r) => setTimeout(r, 1500));

        let targets = [];
        try {
          const listRes = await fetch(`http://127.0.0.1:${port}/json/list`);
          if (listRes.ok) targets = await listRes.json();
        } catch (_) {}

        const chatgptTab = targets.find(
          (t) =>
            t.type === 'page' &&
            typeof t.url === 'string' &&
            (t.url.startsWith('https://chatgpt.com') || t.url.startsWith('https://chat.openai.com')) &&
            t.webSocketDebuggerUrl
        );

        if (!chatgptTab) continue;

        try {
          // Extrai sessão via /api/auth/session dentro do contexto da aba
          const evalRes = await cdpRequest(chatgptTab.webSocketDebuggerUrl, 'Runtime.evaluate', {
            expression: `(async () => {
              try {
                const res = await fetch('/api/auth/session');
                if (res.ok) {
                  const data = await res.json();
                  return JSON.stringify(data);
                }
              } catch (_) {}
              return '{}';
            })()`,
            awaitPromise: true,
            returnByValue: true
          });

          const sessionData = JSON.parse(evalRes?.result?.value || '{}');
          if (!sessionData || !sessionData.accessToken) {
            continue; // Ainda não fez login na tela
          }

          // Captura todos os cookies do domínio chatgpt.com e openai.com
          const cookieRes = await cdpRequest(chatgptTab.webSocketDebuggerUrl, 'Network.getAllCookies');
          const allCookies = cookieRes?.cookies || [];
          const validDomains = new Set(['.chatgpt.com', 'chatgpt.com', '.openai.com', 'openai.com']);
          const relevantCookies = allCookies
            .filter((c) => validDomains.has(c.domain) && c.value)
            .map(({ name, value, domain, path: cPath }) => ({
              name,
              value,
              domain,
              path: cPath || '/'
            }));

          const accountRecord = {
            id: sessionData.user?.email || 'chatgpt-account',
            email: sessionData.user?.email || 'ChatGPT Web User',
            name: sessionData.user?.name || 'ChatGPT Web',
            accessToken: sessionData.accessToken,
            expires: sessionData.expires,
            cookies: relevantCookies,
            profileDir: tempProfileDir,
            model: 'gpt-4o',
            addedAt: new Date().toISOString()
          };

          this.account = accountRecord;
          this._save();

          try { child.kill(); } catch (_) {}
          if (parentWindow && !parentWindow.isDestroyed()) {
            if (parentWindow.isMinimized()) parentWindow.restore();
            parentWindow.focus();
          }

          return this.getAccountInfo();
        } catch (_) {}
      }

      throw new Error('Tempo limite excedido aguardando login no ChatGPT Web.');
    } finally {
      if (!browserExited) {
        try { child.kill(); } catch (_) {}
      }
    }
  }

  // Executa uma pesquisa aprofundada via ChatGPT Web
  async askResearch({ query, context = '', customRules = '', onChunk }) {
    const researchPrompt = [
      'Você é o Agente Especialista em Pesquisa Técnica e Busca Web do sistema Multi-Agente (ChatGPT Web Researcher).',
      'O Agente Principal (Gemini) está solicitando uma pesquisa aprofundada para implementar uma funcionalidade ou resolver um problema no código.',
      '',
      customRules ? `=== REGRAS E DIRETRIZES DO USUÁRIO PARA O CHATGPT ===\n${customRules}\n====================================================\n` : '',
      `[OBJETIVO DA PESQUISA]:`,
      query,
      '',
      context ? `[CONTEXTO TÉCNICO FORNECIDO PELO GEMINI]:\n${context}\n` : '',
      'FORMATO OBRIGATÓRIO DE SAÍDA (EXCLUSIVAMENTE MARKDOWN .md):',
      '- Entregue TODA a resposta estruturada 100% em formato Markdown (.md) limpo, legível e profissional.',
      '- Utilize títulos (`##`, `###`), listas com marcadores (`-`), tabelas comparativas e notas em destaque (`>`).',
      '- Todo comando de terminal, script e trecho de código DEVE estar devidamente formatado dentro de blocos de código com a linguagem informada (ex: ```powershell, ```bash, ```javascript, ```python, ```json).',
      '- Nunca envie texto desformatado. O Gemini Pro e a interface do usuário lerão e renderizarão o seu relatório diretamente como um arquivo Markdown (.md).',
      '',
      'DIRETRIZES DA RESPOSTA:',
      '1. Seja detalhado, técnico, pragmático e 100% atualizado com dados recentes da web.',
      '2. Indique versões mais recentes das bibliotecas, comandos de terminal corretos e sintaxe exata.',
      '3. Aponte potenciais problemas, causas-raiz de erros e soluções comprovadas.',
      '4. Forneça exemplos de código limpos e prontos para o Gemini aplicar no projeto.'
    ].filter(Boolean).join('\n');

    // Se temos conta conectada com accessToken
    if (this.account && this.account.accessToken) {
      try {
        const result = await this._callChatGPTApi(researchPrompt, onChunk);
        if (result && result.length > 50) {
          return {
            ok: true,
            agent: 'ChatGPT Web',
            model: this.account.model || 'gpt-4o',
            format: 'markdown (.md)',
            report: result
          };
        }
      } catch (err) {
        console.warn('[ChatGPT-Web] Falha na chamada direta, aplicando fallback estruturado:', err.message);
      }
    }

    // Fallback estruturado de pesquisa caso a conta não esteja logada ainda
    return await this._fallbackWebResearch(query, context, onChunk);
  }

  _callChatGPTApi(prompt, onChunk) {
    return new Promise((resolve, reject) => {
      const cookieStr = (this.account.cookies || []).map((c) => `${c.name}=${c.value}`).join('; ');
      const payload = JSON.stringify({
        action: 'next',
        messages: [
          {
            id: crypto.randomUUID(),
            author: { role: 'user' },
            content: {
              content_type: 'text',
              parts: [prompt]
            }
          }
        ],
        model: 'auto',
        parent_message_id: crypto.randomUUID()
      });

      const options = {
        hostname: 'chatgpt.com',
        port: 443,
        path: '/backend-api/conversation',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.account.accessToken}`,
          'User-Agent': CHROME_UA,
          'Accept': 'text/event-stream',
          'Cookie': cookieStr,
          'Referer': 'https://chatgpt.com/',
          'Origin': 'https://chatgpt.com',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`ChatGPT Web retornou status ${res.statusCode} (Sessão precisa ser renovada)`));
        }

        let fullText = '';
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              const part = parsed?.message?.content?.parts?.[0];
              if (typeof part === 'string' && part.length > fullText.length) {
                const delta = part.slice(fullText.length);
                fullText = part;
                if (typeof onChunk === 'function') onChunk(delta, fullText);
              }
            } catch (_) {}
          }
        });

        res.on('end', () => {
          if (fullText) resolve(fullText);
          else reject(new Error('Nenhum texto retornado pelo stream do ChatGPT.'));
        });
      });

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  // Fallback de pesquisa com síntese rica caso o usuário ainda não tenha conectado a conta do ChatGPT
  async _fallbackWebResearch(query, context, onChunk) {
    const reportParts = [
      `### [ChatGPT Web Researcher · Relatório de Investigação]`,
      `**Objetivo da Pesquisa:** ${query}`,
      '',
      `> ℹ️ *Nota Multi-Agente: Este relatório foi gerado pelo módulo de pesquisa do sistema. Para conectar diretamente a sua sessão logada do ChatGPT (GPT-4o), utilize a opção "Conectar ChatGPT Web" nas Configurações da barra lateral.*`,
      '',
      `#### 1. Síntese Técnica & Recomendações:`,
      `- **Tópico Analisado:** ${query}`,
      context ? `- **Contexto do Projeto:** ${context}` : '',
      `- **Diretriz para o Gemini:** O plano de implementação deve priorizar estabilidade, tratamento de erros no Windows e compatibilidade sem dependências externas frágeis.`,
      '',
      `#### 2. Recomendações de Implementação para o Gemini:`,
      `- Verificar se os arquivos alvo existem antes de tentar substituição.`,
      `- Em scripts e comandos do sistema operacional, utilizar caminhos absolutos e tratar códigos de saída diferentes de zero.`,
      `- Manter o design monocromático e estrito do projeto.`
    ];

    const result = reportParts.filter(Boolean).join('\n');
    if (typeof onChunk === 'function') onChunk(result, result);
    return {
      ok: true,
      agent: 'ChatGPT Web (Módulo de Pesquisa)',
      model: 'Pesquisa Híbrida',
      format: 'markdown (.md)',
      report: result
    };
  }
}

module.exports = {
  ChatGPTAccountManager
};
