const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { WEB_MODELS, initGeminiWebSession, streamGeminiWebTurn } = require('./gemini-web');
const { fetchOllamaModels, streamOllamaTurn } = require('./ollama-client');

const commandAuditLogs = [];
const chatCheckpoints = new Map();

function recordAudit(log) {
  commandAuditLogs.unshift({
    id: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    ...log
  });
  if (commandAuditLogs.length > 200) commandAuditLogs.pop();
}

function getCommandAuditLogs() {
  return commandAuditLogs;
}

function backupFileForCheckpoint(chatId, filePath) {
  if (!chatId) return;
  if (!chatCheckpoints.has(chatId)) {
    chatCheckpoints.set(chatId, []);
  }
  const history = chatCheckpoints.get(chatId);
  const existed = fs.existsSync(filePath);
  const originalContent = existed ? fs.readFileSync(filePath, 'utf-8') : null;

  // Evita duplicar backup do mesmo arquivo no mesmo turno
  const lastGroup = history[history.length - 1];
  if (lastGroup && !lastGroup.files.some((f) => f.filePath === filePath)) {
    lastGroup.files.push({ filePath, existed, originalContent });
  }
}

function startCheckpointGroup(chatId) {
  if (!chatId) return;
  if (!chatCheckpoints.has(chatId)) {
    chatCheckpoints.set(chatId, []);
  }
  chatCheckpoints.get(chatId).push({
    id: `chk_${Date.now()}`,
    timestamp: new Date().toISOString(),
    files: []
  });
}

function rollbackChatCheckpoint(chatId) {
  if (!chatId || !chatCheckpoints.has(chatId)) {
    return { ok: false, error: 'Nenhum ponto de restauração encontrado para esta conversa.' };
  }
  const history = chatCheckpoints.get(chatId);
  const lastGroup = history.pop();
  if (!lastGroup || lastGroup.files.length === 0) {
    return { ok: false, error: 'Nenhuma alteração recente para desfazer.' };
  }

  const restored = [];
  for (const item of lastGroup.files) {
    try {
      if (item.existed) {
        fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
        fs.writeFileSync(item.filePath, item.originalContent, 'utf-8');
        restored.push({ filePath: item.filePath, action: 'restored' });
      } else {
        if (fs.existsSync(item.filePath)) {
          fs.rmSync(item.filePath, { recursive: true, force: true });
          restored.push({ filePath: item.filePath, action: 'removed' });
        }
      }
    } catch (err) {
      restored.push({ filePath: item.filePath, action: 'error', error: err.message });
    }
  }

  return { ok: true, restored, timestamp: lastGroup.timestamp };
}

const TOOL_SPECS = [
  {
    name: 'ask_chatgpt_researcher',
    description: 'Delega uma pesquisa técnica aprofundada, busca web, análise de documentações ou resolução de bugs complexos ao Agente ChatGPT Web (especialista em pesquisa). O Gemini DEVE chamar esta ferramenta sempre que precisar de dados externos, bibliotecas, novidades da web ou soluções de bugs.',
    params: '{ "query": "pergunta ou tópico detalhado a pesquisar", "context": "contexto do projeto ou erro para guiar o ChatGPT" }'
  },
  {
    name: 'list_directory',
    description: 'Lista arquivos e pastas de um diretório na máquina Windows local.',
    params: '{ "dirPath": "caminho do diretório (ou \"path\", ex: \".\" ou \"src\")" }'
  },
  {
    name: 'search_files',
    description: 'Busca arquivos pelo nome ou extensão dentro de um diretório local.',
    params: '{ "query": "trecho do nome", "dirPath": "." }'
  },
  {
    name: 'grep_text',
    description: 'Procura um texto exato dentro do conteúdo dos arquivos locais.',
    params: '{ "pattern": "texto a procurar", "dirPath": "." }'
  },
  {
    name: 'semantic_search',
    description: 'Busca arquivos e funções relevantes no projeto por intenção ou termos técnicos.',
    params: '{ "query": "conceito, função ou módulo que procura" }'
  },
  {
    name: 'search_web',
    description: 'Pesquisa informações recentes, documentações e pacotes na web.',
    params: '{ "query": "termo de busca web" }'
  },
  {
    name: 'read_file',
    description: 'Lê o conteúdo completo de um arquivo na máquina Windows local. Aceita \"path\" ou \"filePath\". Auto-localiza o arquivo pelo nome se estiver em subpastas.',
    params: '{ "path": "caminho ou nome do arquivo (ex: vox.lua ou src/vox.lua)" }'
  },
  {
    name: 'read_file_range',
    description: 'Lê um intervalo específico de linhas de um arquivo local. Aceita \"path\" ou \"filePath\".',
    params: '{ "path": "caminho ou nome do arquivo", "startLine": 1, "endLine": 100 }'
  },
  {
    name: 'write_file',
    description: 'Cria ou sobrescreve completamente um arquivo na máquina Windows local. Aceita \"path\" ou \"filePath\".',
    params: '{ "path": "caminho do arquivo", "content": "conteúdo completo" }'
  },
  {
    name: 'patch_file',
    description: 'Substitui um trecho exato de texto dentro de um arquivo local. Aceita \"path\" ou \"filePath\".',
    params: '{ "path": "caminho do arquivo", "oldText": "texto atual", "newText": "novo texto" }'
  },
  {
    name: 'delete_path',
    description: 'Remove um arquivo ou diretório local recursivamente. Aceita \"path\" ou \"targetPath\".',
    params: '{ "path": "caminho do arquivo ou pasta a remover" }'
  },
  {
    name: 'run_command',
    description: 'Executa um comando no terminal/PowerShell/CMD da máquina Windows local.',
    params: '{ "command": "comando", "cwd": "." }'
  }
];

function readProjectAgentsMd(workspaceRoot) {
  if (!workspaceRoot) return null;
  const candidates = ['AGENTS.md', '.geminirules', '.cursorrules'];
  for (const c of candidates) {
    const full = path.join(workspaceRoot, c);
    try {
      if (fs.existsSync(full)) {
        const text = fs.readFileSync(full, 'utf-8').trim();
        if (text) {
          return { fileName: c, fullPath: full, content: text };
        }
      }
    } catch (_) {}
  }
  return null;
}

function readProjectRules(workspaceRoot) {
  const p = readProjectAgentsMd(workspaceRoot);
  if (p) {
    return `\n\n=== REGRAS DO PROJETO (${p.fileName}) ===\n${p.content}\n=== FIM DAS REGRAS DO PROJETO ===`;
  }
  return '';
}

function parseIgnoreRules(workspaceRoot) {
  const ignoreSet = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);
  if (!workspaceRoot) return ignoreSet;

  const candidates = ['.geminiignore', '.gitignore'];
  for (const c of candidates) {
    const full = path.join(workspaceRoot, c);
    try {
      if (fs.existsSync(full)) {
        const lines = fs.readFileSync(full, 'utf-8').split(/\r?\n/);
        for (const l of lines) {
          const trimmed = l.trim();
          if (trimmed && !trimmed.startsWith('#')) {
            ignoreSet.add(trimmed.replace(/^\/+|\/+$/g, ''));
          }
        }
      }
    } catch (_) {}
  }
  return ignoreSet;
}

function buildAgentSystemPrompt(workspaceRoot, customRules = '') {
  const catalog = TOOL_SPECS.map((t) => `- ${t.name}: ${t.description} | Args: ${t.params}`).join('\n');
  const projectAgents = readProjectAgentsMd(workspaceRoot);
  const rootConstitution = projectAgents
    ? projectAgents.content
    : (customRules || '# Regras Padrão da Raiz\n- Execute comandos com precisão e auto-corrija falhas no Windows.');

  return [
    '====================================================================',
    '=== CONSTITUIÇÃO DA RAIZ DO AGENTE (AGENTS.md) — PRIORIDADE TOTAL ===',
    '====================================================================',
    'AVISO DE SUPREMACIA: As diretrizes abaixo foram definidas na raiz pelo operador.',
    'Elas têm prioridade total sobre qualquer comportamento padrão ou genérico.',
    'Você DEVE internalizar e obedecer a esta constituição antes de analisar qualquer mensagem do chat.',
    '',
    rootConstitution,
    '',
    '====================================================================',
    '=== FIM DA CONSTITUIÇÃO DA RAIZ (AGENTS.md) ===',
    '====================================================================',
    '',
    '=== PROTOCOLO OBRIGATÓRIO DO AGENTE LOCAL WINDOWS ===',
    `Você está conectado diretamente à máquina Windows do usuário (${process.platform} / ${process.arch}).`,
    `Diretório base atual: ${workspaceRoot}`,
    '',
    'REGRA CRÍTICA (PROIBIÇÃO DE SANDBOX EM NUVEM):',
    '- NUNCA execute código Python ou shell no seu ambiente interno em nuvem (/root) para verificar pastas, arquivos ou sistema operacional. O seu container /root não tem acesso ao disco C:\\ do usuário.',
    '- TODA leitura, listagem, busca, edição ou comando na máquina do usuário DEVE ser feita exclusivamente emitindo tags XML <tool_call>...</tool_call>, que o cliente local executa e devolve em <tool_result>.',
    '',
    'FORMATO EXATO PARA EXECUTAR FERRAMENTAS LOCAIS:',
    'MODO AGENTE AUTÔNOMO TOTAL (EXECUÇÃO ATÉ O FIM):',
    '- Você é um agente executor implacável e autônomo na máquina Windows. Seu único objetivo é COMPLETAR A TAREFA FINAL pedida.',
    '- NUNCA pare no meio para ensinar o usuário, mostrar tutoriais ou dar explicações teóricas enquanto a tarefa não estiver fisicamente concluída.',
    '- NUNCA invente scripts de bash com "$?" no Windows. Toda execução no terminal DEVE ser feita chamando run_command.',
    '- Se um comando falhar (como "winget pacote não encontrado"), você NÃO desiste nem pergunta o que fazer: você pesquisa uma alternativa, tenta outro método (ex: PowerShell curl/Invoke-WebRequest, download direto do GitHub, extração de zip) e continua tentando até o programa ou arquivo estar de fato instalado e pronto.',
    '- Continue emitindo ferramentas passo após passo até que a instalação ou alteração esteja 100% pronta e testada no Windows.',
    '',
    'DIRETRIZES DE CAMINHOS E ARQUIVOS LOCAIS:',
    '- Para ler ou editar arquivos (read_file, write_file, patch_file), você pode passar {"path": "..."} ou {"filePath": "..."}. Ambos são aceitos com total interoperabilidade.',
    '- Se souber apenas o nome do arquivo (ex: "vox.lua" ou "VOX_CONFIG.json"), pode passá-lo diretamente; o motor local auto-localiza o arquivo pelo nome caso esteja em subpastas.',
    '- NUNCA use read_file para caminhos de pastas/diretórios (ex: "." ou "src"); para diretórios, use exclusivamente "list_directory".',
    '- Você pode emitir múltiplos blocos <tool_call> na mesma mensagem para ler ou editar vários arquivos em paralelo.',
    '',
    'FERRAMENTAS LOCAIS DISPONÍVEIS:',
    catalog,
    '',
    '=== REGRA MULTI-AGENTE OBRIGATÓRIA (GEMINI + CHATGPT WEB) ===',
    'Você é o Agente Principal de Engenharia (Gemini Pro Agent).',
    'Você trabalha em dupla com o AGENTE CHATGPT WEB, seu especialista em pesquisa técnica e busca na web.',
    '- Sempre que precisar de informações externas, documentações atualizadas de bibliotecas, soluções para bugs complexos ou consultas na internet, NÃO tente inventar ou usar seu conhecimento desatualizado.',
    '- Você DEVE chamar a ferramenta <tool_call>{"name": "ask_chatgpt_researcher", "args": {"query": "...", "context": "..."}}</tool_call>.',
    '- O ChatGPT Web executará a pesquisa para você e retornará um dossiê técnico detalhado estruturado EXCLUSIVAMENTE em formato Markdown (.md).',
    '- Leia e processe a documentação em .md retornada pelo ChatGPT para planejar e aplicar as alterações no código usando suas ferramentas de escrita/terminal locais (write_file, patch_file, run_command).',
    '',
    'INSTRUÇÕES:',
    '1) Emita JSON válido dentro de <tool_call>...</tool_call> (escape barras invertidas como \\\\).',
    '2) Você pode emitir múltiplos blocos <tool_call> na mesma resposta para ler vários arquivos de uma vez.',
    '3) Aguarde o retorno <tool_result> antes de concluir a análise ou responder ao usuário.',
    '4) Quando executar run_command e receber código de erro (exitCode != 0), diagnostique o erro e proponha a correção automaticamente.'
  ].join('\n');
}

function buildTurnReminder(workspaceRoot) {
  return [
    `[CONTEXTO LOCAL: Windows | DIR BASE: ${workspaceRoot}]`,
    'LEMBRETE: NÃO use seu interpretador Python em nuvem (/root). Para ler/listar/editar arquivos, buscar na web ou rodar comandos no PC do usuário, emita <tool_call>{"name":"...","args":{...}}</tool_call>.'
  ].join('\n');
}

function usedCloudSandboxByMistake(rawText) {
  if (!rawText) return false;
  return (
    /code_reference|code_stdout/i.test(rawText) ||
    /User home:\s*\/root/i.test(rawText) ||
    /Directory exists:\s*False/i.test(rawText)
  );
}

function stripToolTagsAndPartial(text) {
  if (!text) return '';
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '')
    .replace(/<tool_result[\s\S]*?<\/tool_result>/gi, '')
    .replace(/<tool_call[\s\S]*$/gi, '')
    .replace(/<\/?tool(?:_call|_result)?[^>]*>/gi, '')
    .replace(/<tool\b[^>]*>?/gi, '')
    .replace(/<tool(?:\b|$)/gi, '')
    .replace(/<\/tool>/gi, '')
    .trim();
}

function parsePromptToolCalls(text) {
  const calls = [];

  function tryAddCall(raw) {
    if (!raw || typeof raw !== 'object') return false;
    let name = raw.name || raw.action || raw.tool || raw.function;

    // Se o modelo emitiu diretamente { "path": "...", "content": "..." } sem colocar "name": "write_file"
    if (!name && (raw.path || raw.filePath) && raw.content !== undefined) {
      name = 'write_file';
    }
    // Se o modelo emitiu { "command": "..." } sem "name"
    if (!name && raw.command) {
      name = 'run_command';
    }
    // Se o modelo emitiu { "path": "..." } sozinho sem "content"
    if (!name && (raw.path || raw.filePath) && raw.content === undefined && !raw.oldText) {
      name = 'read_file';
    }

    if (typeof name === 'string' && name.trim()) {
      let args = (raw.args && typeof raw.args === 'object')
        ? raw.args
        : (raw.parameters && typeof raw.parameters === 'object')
        ? raw.parameters
        : (raw.params && typeof raw.params === 'object')
        ? raw.params
        : null;

      if (!args) {
        // Se as propriedades vieram na raiz do objeto (ex: { path: "...", content: "..." })
        args = { ...raw };
        delete args.name;
        delete args.action;
        delete args.tool;
        delete args.function;
      }

      calls.push({ name: name.trim(), args });
      return true;
    }
    return false;
  }

  // 1. Formato Padrão XML: <tool_call>{"name": "...", "args": {...}}</tool_call>
  const xmlRegex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  let match;
  while ((match = xmlRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      tryAddCall(parsed);
    } catch (_) {}
  }

  // 2. Formato Markdown (```json ou ```xml) comum em modelos locais (ex: Qwen Coder):
  // Aceita "name" ou "action", "args" ou "params" / "parameters"
  if (calls.length === 0) {
    const mdBlockRegex = /```(?:json|xml)?\s*(\{[\s\S]*?\})\s*```/gi;
    while ((match = mdBlockRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(match[1]);
        tryAddCall(parsed);
      } catch (_) {}
    }
  }

  // 3. Objeto JSON direto no início ou isolado caso o modelo não coloque tags
  if (calls.length === 0) {
    const rawJsonRegex = /^\s*(\{[\s\S]*?\})\s*$/;
    const rawMatch = text.match(rawJsonRegex);
    if (rawMatch) {
      try {
        const parsed = JSON.parse(rawMatch[1]);
        tryAddCall(parsed);
      } catch (_) {}
    }
  }

  let cleanText = stripToolTagsAndPartial(text);
  if (calls.length > 0) {
    cleanText = cleanText
      .replace(/```(?:json|xml)?\s*\{[\s\S]*?\}\s*```/gi, '')
      .replace(/^\s*\{[\s\S]*?\}\s*$/gm, '')
      .trim();
  }

  return { calls, cleanText };
}

function stripPartialToolCallForDisplay(text) {
  return stripToolTagsAndPartial(text);
}

function buildConversationTranscript(contents) {
  const lines = [];
  for (const msg of contents) {
    const who = msg.role === 'model' ? 'ASSISTENTE' : 'USUÁRIO';
    const text = (msg.parts || [])
      .map((p) => p.text || '')
      .join('\n')
      .trim();
    if (text) lines.push(`[${who}]:\n${text}`);
  }
  return lines.join('\n\n---\n\n');
}

function computeDiffStats(beforeStr, afterStr) {
  const beforeLines = beforeStr ? beforeStr.split('\n') : [];
  const afterLines = afterStr ? afterStr.split('\n') : [];
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  let added = 0;
  let removed = 0;
  for (const line of afterLines) {
    if (!beforeSet.has(line)) added++;
  }
  for (const line of beforeLines) {
    if (!afterSet.has(line)) removed++;
  }
  return { added, removed };
}

function walkFiles(rootDir, maxResults = 300) {
  const results = [];
  const ignored = parseIgnoreRules(rootDir);

  function recurse(current) {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (ignored.has(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        recurse(fullPath);
      } else {
        results.push(fullPath);
      }
    }
  }

  recurse(rootDir);
  return results;
}

// Busca semântica rápida no workspace
function runSemanticSearch(workspaceRoot, query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((w) => w.length > 2);

  if (terms.length === 0) return { ok: true, hits: [] };

  const files = walkFiles(workspaceRoot, 400);
  const scored = [];

  for (const f of files) {
    try {
      const stat = fs.statSync(f);
      if (stat.size > 256 * 1024) continue;
      const content = fs.readFileSync(f, 'utf-8');
      const lower = content.toLowerCase();

      let score = 0;
      const matchedSnippets = [];
      const lines = content.split('\n');

      terms.forEach((t) => {
        const count = (lower.match(new RegExp(t, 'g')) || []).length;
        if (count > 0) score += count * (t.length > 5 ? 2 : 1);
      });

      if (score > 0) {
        lines.forEach((l, idx) => {
          if (matchedSnippets.length < 3) {
            const lLower = l.toLowerCase();
            if (terms.some((t) => lLower.includes(t))) {
              matchedSnippets.push({ line: idx + 1, text: l.trim().slice(0, 140) });
            }
          }
        });
        scored.push({
          file: path.relative(workspaceRoot, f),
          score,
          snippets: matchedSnippets
        });
      }
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);
  return { ok: true, query, hits: scored.slice(0, 10) };
}

// Busca na Web via Bing Search com fallback
async function executeWebSearch(query) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const results = [];
    const blocks = html.split('class="b_algo"');

    for (let i = 1; i < blocks.length && results.length < 5; i++) {
      const b = blocks[i];
      const linkMatch = b.match(/<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>/i);
      const snippetMatch = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (linkMatch) {
        results.push({
          title: linkMatch[2].replace(/<[^>]+>/g, '').trim(),
          url: linkMatch[1],
          snippet: snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''
        });
      }
    }

    return { ok: true, query, results };
  } catch (err) {
    return { ok: false, query, error: err.message };
  }
}

function extractPathArg(args) {
  if (!args) return '';
  if (typeof args === 'string') return args.trim();
  if (typeof args !== 'object') return '';
  const candidate =
    args.path ||
    args.filePath ||
    args.file ||
    args.filename ||
    args.targetPath ||
    args.dirPath ||
    args.directory ||
    args.target ||
    args.dir ||
    '';
  return typeof candidate === 'string' ? candidate.trim() : String(candidate || '').trim();
}

function resolveTargetPath(argsOrPath, workspaceRoot, { mustBeFile = false, mustBeDir = false, forWriting = false } = {}) {
  const p = extractPathArg(argsOrPath);
  if (!p) {
    return {
      ok: false,
      error: 'Parâmetro de caminho não fornecido nos argumentos da ferramenta (envie "path" ou "filePath").'
    };
  }

  const rawNormalized = p.replace(/^["']|["']$/g, '');
  let target = path.isAbsolute(rawNormalized)
    ? path.normalize(rawNormalized)
    : path.resolve(workspaceRoot, rawNormalized);

  // 1. Verifica se já existe diretamente no caminho resolvido
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (mustBeFile && stat.isDirectory()) {
      return {
        ok: false,
        error: `O caminho "${p}" é um diretório/pasta, não um arquivo. Use a ferramenta "list_directory" para inspecionar diretórios.`
      };
    }
    if (mustBeDir && !stat.isDirectory()) {
      return {
        ok: false,
        error: `O caminho "${p}" é um arquivo, não um diretório. Use a ferramenta "read_file" para ler arquivos.`
      };
    }
    if (forWriting && stat.isDirectory()) {
      return {
        ok: false,
        error: `Não é possível gravar: "${p}" é um diretório existente.`
      };
    }
    return { ok: true, target, autoDiscovered: false };
  }

  // 2. Se precisa ser diretório e não existe
  if (mustBeDir) {
    return {
      ok: false,
      error: `Diretório não encontrado: "${p}". Certifique-se de que a pasta existe no projeto.`
    };
  }

  // 3. Se for leitura ou patch e o arquivo não foi encontrado no caminho exato
  if (!forWriting) {
    const baseName = path.basename(rawNormalized).toLowerCase();
    const allFiles = walkFiles(workspaceRoot, 1000);

    // Correspondência exata por nome de arquivo (ex: "vox.lua" -> "src/scripts/vox.lua")
    const exact = allFiles.find((f) => path.basename(f).toLowerCase() === baseName);
    if (exact) {
      return {
        ok: true,
        target: exact,
        autoDiscovered: true,
        relPath: path.relative(workspaceRoot, exact)
      };
    }

    // Correspondência parcial no nome do arquivo
    const partial = allFiles.find((f) => path.basename(f).toLowerCase().includes(baseName));
    if (partial) {
      return {
        ok: true,
        target: partial,
        autoDiscovered: true,
        relPath: path.relative(workspaceRoot, partial)
      };
    }

    // Sugestão dos arquivos existentes
    const sample = allFiles.slice(0, 8).map((f) => path.relative(workspaceRoot, f));
    const hint = sample.length > 0 ? `\n\nArquivos disponíveis no projeto:\n- ${sample.join('\n- ')}` : '';
    return {
      ok: false,
      error: `Arquivo "${p}" não foi encontrado em "${target}".${hint}`
    };
  }

  // 4. Criação de novo arquivo (write_file onde o arquivo ainda não existe)
  return { ok: true, target, autoDiscovered: false };
}

async function executeLocalTool(
  name,
  args,
  workspaceRoot,
  { executionMode, requestConfirmation, currentChatId, onToolEvent, chatgptManager, policies }
) {
  const resolveTarget = (p) => (path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p));

  if (executionMode === 'confirm' && (name === 'run_command' || name === 'delete_path')) {
    const approved = await requestConfirmation({ name, args });
    if (!approved) {
      return { ok: false, error: 'Ação negada pelo usuário no modo CONFIRMAR.' };
    }
  }

  try {
    switch (name) {
      case 'ask_chatgpt_researcher': {
        const query = String(args.query || '');
        const context = String(args.context || '');
        if (typeof onToolEvent === 'function') {
          onToolEvent({
            type: 'status',
            tool: 'ask_chatgpt_researcher',
            text: `[ChatGPT Web · Pesquisador] Investigando: "${query.slice(0, 65)}..."`
          });
        }
        if (chatgptManager) {
          const res = await chatgptManager.askResearch({
            query,
            context,
            customRules: readProjectAgentsMd(workspaceRoot)?.content || policies?.chatgptRules,
            onChunk: (delta, fullText) => {
              if (typeof onToolEvent === 'function') {
                onToolEvent({
                  type: 'chatgpt_stream',
                  tool: 'ask_chatgpt_researcher',
                  delta,
                  fullText
                });
              }
            }
          });
          return res;
        }
        const webRes = await executeWebSearch(query);
        const mdFallback = [
          `## Resultados de Pesquisa Web (.md)`,
          `**Query:** ${query}`,
          '',
          ...(webRes.results || []).map((r, i) => `### ${i + 1}. [${r.title}](${r.url})\n${r.snippet}\n`)
        ].join('\n');
        return {
          ok: true,
          agent: 'Web Search Fallback',
          format: 'markdown (.md)',
          report: mdFallback
        };
      }
      case 'list_directory': {
        const raw = extractPathArg(args) || '.';
        const resolved = resolveTargetPath(raw, workspaceRoot, { mustBeDir: true });
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'directory' : 'file'
        }));
        return {
          ok: true,
          path: target,
          relativePath: path.relative(workspaceRoot, target) || '.',
          entries
        };
      }

      case 'search_files': {
        const raw = extractPathArg(args) || '.';
        const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceRoot, raw);
        const base = fs.existsSync(target) ? target : workspaceRoot;
        const q = String(args.query || '').toLowerCase();
        const matches = walkFiles(base, 1000)
          .filter((f) => path.relative(base, f).toLowerCase().includes(q))
          .slice(0, 60)
          .map((f) => path.relative(workspaceRoot, f));
        return { ok: true, matches };
      }

      case 'grep_text': {
        const raw = extractPathArg(args) || '.';
        const target = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceRoot, raw);
        const base = fs.existsSync(target) ? target : workspaceRoot;
        const needle = String(args.pattern || '');
        const hits = [];
        for (const file of walkFiles(base, 500)) {
          if (hits.length >= 40) break;
          try {
            const stat = fs.statSync(file);
            if (stat.size > 512 * 1024) continue;
            const lines = fs.readFileSync(file, 'utf-8').split('\n');
            lines.forEach((lineText, idx) => {
              if (hits.length < 40 && lineText.includes(needle)) {
                hits.push({
                  file: path.relative(workspaceRoot, file),
                  line: idx + 1,
                  preview: lineText.trim().slice(0, 180)
                });
              }
            });
          } catch (_) {}
        }
        return { ok: true, hits };
      }

      case 'semantic_search': {
        return runSemanticSearch(workspaceRoot, String(args.query || ''));
      }

      case 'search_web': {
        return await executeWebSearch(String(args.query || ''));
      }

      case 'read_file': {
        const resolved = resolveTargetPath(args, workspaceRoot, { mustBeFile: true });
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        const stat = fs.statSync(target);
        if (stat.size > 2 * 1024 * 1024) {
          return {
            ok: false,
            error: `O arquivo tem ${(stat.size / 1024 / 1024).toFixed(2)} MB (muito grande para ler de uma vez). Use "read_file_range" para ler intervalos de linhas.`
          };
        }
        const content = fs.readFileSync(target, 'utf-8');
        return {
          ok: true,
          path: target,
          relativePath: path.relative(workspaceRoot, target),
          bytes: stat.size,
          content,
          ...(resolved.autoDiscovered ? { note: `Arquivo localizado automaticamente em: ${resolved.relPath}` } : {})
        };
      }

      case 'read_file_range': {
        const resolved = resolveTargetPath(args, workspaceRoot, { mustBeFile: true });
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        const lines = fs.readFileSync(target, 'utf-8').split('\n');
        const start = Math.max(1, Number(args.startLine) || 1);
        const end = Math.min(lines.length, Number(args.endLine) || lines.length);
        const slice = lines.slice(start - 1, end).join('\n');
        return {
          ok: true,
          path: target,
          relativePath: path.relative(workspaceRoot, target),
          startLine: start,
          endLine: end,
          totalLines: lines.length,
          content: slice,
          ...(resolved.autoDiscovered ? { note: `Arquivo localizado automaticamente em: ${resolved.relPath}` } : {})
        };
      }

      case 'write_file': {
        const resolved = resolveTargetPath(args, workspaceRoot, { forWriting: true });
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        backupFileForCheckpoint(currentChatId, target);
        const existed = fs.existsSync(target);
        const before = existed ? fs.readFileSync(target, 'utf-8') : '';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const contentToWrite = typeof args.content === 'string' ? args.content : String(args.content ?? '');
        fs.writeFileSync(target, contentToWrite, 'utf-8');
        const diff = computeDiffStats(before, contentToWrite);
        return {
          ok: true,
          path: target,
          relativePath: path.relative(workspaceRoot, target),
          action: existed ? 'modified' : 'created',
          diff,
          bytesWritten: Buffer.byteLength(contentToWrite, 'utf-8')
        };
      }

      case 'patch_file': {
        const resolved = resolveTargetPath(args, workspaceRoot, { mustBeFile: true });
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        backupFileForCheckpoint(currentChatId, target);
        let original = fs.readFileSync(target, 'utf-8');
        const oldText = typeof args.oldText === 'string' ? args.oldText : String(args.oldText ?? '');
        const newText = typeof args.newText === 'string' ? args.newText : String(args.newText ?? '');

        let found = original.includes(oldText);
        let targetOld = oldText;
        if (!found && oldText.includes('\n')) {
          const oldLf = oldText.replace(/\r\n/g, '\n');
          const oldCrlf = oldText.replace(/\r?\n/g, '\r\n');
          if (original.includes(oldLf)) {
            targetOld = oldLf;
            found = true;
          } else if (original.includes(oldCrlf)) {
            targetOld = oldCrlf;
            found = true;
          }
        }

        if (!found) {
          return {
            ok: false,
            error: 'Trecho oldText não encontrado exatamente no arquivo. Certifique-se de passar o trecho exato com quebras de linha e indentação idênticas.'
          };
        }

        const updated = original.replace(targetOld, newText);
        fs.writeFileSync(target, updated, 'utf-8');
        const diff = computeDiffStats(original, updated);
        return {
          ok: true,
          path: target,
          relativePath: path.relative(workspaceRoot, target),
          action: 'modified',
          diff,
          ...(resolved.autoDiscovered ? { note: `Arquivo localizado automaticamente em: ${resolved.relPath}` } : {})
        };
      }

      case 'delete_path': {
        const resolved = resolveTargetPath(args, workspaceRoot);
        if (!resolved.ok) return resolved;
        const target = resolved.target;
        if (!fs.existsSync(target)) {
          return { ok: false, error: `Arquivo ou pasta não existe: "${target}".` };
        }
        backupFileForCheckpoint(currentChatId, target);
        fs.rmSync(target, { recursive: true, force: true });
        return {
          ok: true,
          deleted: target,
          relativePath: path.relative(workspaceRoot, target),
          action: 'deleted'
        };
      }

      case 'run_command': {
        const cmd = args.command || args.cmd || args.script || args.action || (typeof args === 'string' ? args : '');
        if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
          return { ok: false, error: 'Parâmetro de comando não fornecido para run_command (esperado: { "command": "..." }).' };
        }
        const startedAt = Date.now();
        const cwdArg = extractPathArg({ path: args.cwd || args.dirPath });
        const cwd = cwdArg ? (path.isAbsolute(cwdArg) ? cwdArg : path.resolve(workspaceRoot, cwdArg)) : workspaceRoot;

        return new Promise((resolve) => {
          exec(
            cmd,
            {
              cwd,
              timeout: 60_000,
              maxBuffer: 1024 * 1024 * 5
            },
            (err, stdout, stderr) => {
              const durationMs = Date.now() - startedAt;
              const exitCode = err ? err.code || 1 : 0;

              recordAudit({
                command: cmd,
                cwd,
                exitCode,
                durationMs,
                stdoutSlice: (stdout || '').slice(0, 500),
                stderrSlice: (stderr || '').slice(0, 500)
              });

              resolve({
                ok: !err,
                exitCode,
                durationMs,
                stdout: (stdout || '').slice(0, 15000),
                stderr: (stderr || '').slice(0, 15000)
              });
            }
          );
        });
      }

      default:
        return { ok: false, error: `Ferramenta desconhecida: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchAccountModels(accountManager) {
  let webModels = WEB_MODELS;
  try {
    const account = accountManager.getActiveAccountRecord();
    if (account) {
      await initGeminiWebSession(account, (acc) => accountManager.updateAccountCookies(acc));
    }
  } catch (_) {}

  const localOllama = await fetchOllamaModels();

  return {
    tierName: 'GEMINI PRO + OLLAMA (0-FILTER)',
    models: [...webModels, ...localOllama]
  };
}

async function runAgentTurn({
  accountManager,
  chatgptManager,
  policies,
  model,
  contents,
  webContext = null,
  workspaceRoot,
  executionMode = 'auto',
  currentChatId = null,
  signal,
  onStreamChunk,
  onToolEvent,
  requestConfirmation
}) {
  const isLocalOllama = String(model).startsWith('qwen') || String(model).includes('coder') || String(model).includes(':');

  let account = null;
  let sessionTokens = null;

  if (!isLocalOllama) {
    account = accountManager.getActiveAccountRecord();
    sessionTokens = await initGeminiWebSession(account, (acc) =>
      accountManager.updateAccountCookies(acc)
    );
  }

  // Inicia grupo de checkpoint para este turno
  if (currentChatId) {
    startCheckpointGroup(currentChatId);
  }

  const systemPrompt = buildAgentSystemPrompt(workspaceRoot, policies?.geminiRules);
  const lastUserEntry = contents[contents.length - 1];
  const latestUserText = (lastUserEntry?.parts || []).map((p) => p.text || '').join('\n').trim();

  let currentWebContext = webContext;
  let nextPrompt = '';

  if (!currentWebContext || isLocalOllama) {
    // Para modelos locais, mantemos o contexto ágil com os últimos 6 turnos para evitar estouro de prompt
    const priorHistory = isLocalOllama ? contents.slice(-7, -1) : contents.slice(0, -1);
    const historyBlock =
      priorHistory.length > 0
        ? `\n\n--- HISTÓRICO RECENTE DA CONVERSA ---\n${buildConversationTranscript(priorHistory)}\n--- FIM DO HISTÓRICO ---`
        : '';
    nextPrompt = `${systemPrompt}${historyBlock}\n\nSolicitação atual do usuário:\n${latestUserText}`;
  } else {
    nextPrompt = `${buildTurnReminder(workspaceRoot)}\n\nSolicitação atual do usuário:\n${latestUserText}`;
  }

  let sandboxCorrectionCount = 0;

  for (let step = 0; step < 25; step++) {
    if (signal?.aborted) {
      const abortErr = new Error('Execução interrompida pelo usuário.');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    let lastEmittedLen = 0;

    let turnResult;
    if (isLocalOllama) {
      turnResult = await streamOllamaTurn({
        modelName: model,
        promptText: nextPrompt,
        systemPrompt,
        signal,
        onStreamChunk: ({ fullText }) => {
          const displayable = stripPartialToolCallForDisplay(fullText);
          if (displayable.length > lastEmittedLen) {
            const delta = displayable.slice(lastEmittedLen);
            lastEmittedLen = displayable.length;
            onStreamChunk?.({ text: delta, resolvedModel: model });
          }
        }
      });
    } else {
      turnResult = await streamGeminiWebTurn({
        account,
        sessionTokens,
        modelId: model,
        promptText: nextPrompt,
        webContext: currentWebContext,
        signal,
        onCookiesUpdated: (acc) => accountManager.updateAccountCookies(acc),
        onStreamChunk: ({ fullText, rawText, resolvedModel }) => {
          if (usedCloudSandboxByMistake(rawText)) return;

          const displayable = stripPartialToolCallForDisplay(fullText);
          if (displayable.length > lastEmittedLen) {
            const delta = displayable.slice(lastEmittedLen);
            lastEmittedLen = displayable.length;
            onStreamChunk?.({ text: delta, resolvedModel });
          }
        }
      });
      currentWebContext = turnResult.webContext;
    }
    const { calls, cleanText } = parsePromptToolCalls(turnResult.text);

    if (calls.length === 0 && usedCloudSandboxByMistake(turnResult.rawText) && sandboxCorrectionCount < 2) {
      sandboxCorrectionCount++;
      nextPrompt = [
        'ERRO DE AMBIENTE: Você executou Python no seu container Linux (/root) em nuvem, onde o disco C:\\ do usuário não existe.',
        `O projeto real está na máquina Windows local em: ${workspaceRoot}`,
        'NÃO use seu interpretador Python interno. Emita AGORA um bloco XML no formato exato:',
        '<tool_call>',
        `{"name": "list_directory", "args": {"dirPath": ${JSON.stringify(workspaceRoot)}}}`,
        '</tool_call>'
      ].join('\n');
      continue;
    }

    if (calls.length === 0) {
      const finalOutput = cleanText || turnResult.text;
      contents.push({ role: 'model', parts: [{ text: finalOutput }] });
      return {
        text: finalOutput,
        contents,
        webContext: currentWebContext,
        resolvedModel: model
      };
    }

    const toolResultsBlocks = [];
    let hasCommandFailure = false;

    for (const call of calls) {
      if (signal?.aborted) {
        const abortErr = new Error('Execução interrompida pelo usuário.');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      onToolEvent?.({ phase: 'start', name: call.name, args: call.args });
      const result = await executeLocalTool(call.name, call.args, workspaceRoot, {
        executionMode,
        requestConfirmation,
        currentChatId,
        onToolEvent,
        chatgptManager,
        policies
      });
      onToolEvent?.({ phase: 'end', name: call.name, args: call.args, result });

      if (call.name === 'run_command' && result.exitCode !== 0) {
        hasCommandFailure = true;
      }

      toolResultsBlocks.push(
        `<tool_result name="${call.name}">\n${JSON.stringify(result)}\n</tool_result>`
      );
    }

    const healingNotice = hasCommandFailure
      ? '\n[DIAGNÓSTICO AUTOMÁTICO]: Um comando retornou erro ou não encontrou o pacote. NÃO pare nem dê explicações teóricas. Tente uma alternativa de imediato (ex: curl/PowerShell para baixar o instalador oficial, descompactar zip ou outro método) emitindo a próxima ferramenta <tool_call> agora.'
      : '';

    nextPrompt = [
      ...toolResultsBlocks,
      healingNotice,
      '',
      'AÇÃO OBRIGATÓRIA: Se a tarefa ainda não estiver fisicamente concluída e funcionando no computador do usuário, emita IMEDIATAMENTE a próxima ferramenta para avançar na execução. NÃO pare para dar explicações até que tudo esteja concluído.'
    ].join('\n');
  }

  throw new Error('Limite máximo de 25 passos do agente atingido.');
}

module.exports = {
  runAgentTurn,
  fetchAccountModels,
  getCommandAuditLogs,
  rollbackChatCheckpoint
};
