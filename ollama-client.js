const { spawn } = require('child_process');

const OLLAMA_DEFAULT_URL = 'http://127.0.0.1:11434';
const OLLAMA_BIN = 'C:\\Users\\kayyk\\AppData\\Local\\Programs\\Ollama\\ollama.exe';

let ollamaProcess = null;

async function checkOllamaRunning(baseUrl = OLLAMA_DEFAULT_URL) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.models);
  } catch (_) {
    return false;
  }
}

async function ensureOllamaServer(baseUrl = OLLAMA_DEFAULT_URL) {
  const isRunning = await checkOllamaRunning(baseUrl);
  if (isRunning) return true;

  try {
    ollamaProcess = spawn(OLLAMA_BIN, ['serve'], {
      detached: true,
      stdio: 'ignore'
    });
    ollamaProcess.unref();

    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 600));
      if (await checkOllamaRunning(baseUrl)) return true;
    }
  } catch (_) {}

  return await checkOllamaRunning(baseUrl);
}

async function fetchOllamaModels(baseUrl = OLLAMA_DEFAULT_URL) {
  try {
    await ensureOllamaServer(baseUrl);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => ({
      id: m.name,
      name: `Local · ${m.name}`,
      tag: 'Ollama 0-Filter',
      size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : ''
    }));
  } catch (_) {
    return [];
  }
}

async function streamOllamaTurn({
  modelName = 'qwen2.5-coder:7b',
  promptText,
  systemPrompt = '',
  signal,
  onStreamChunk,
  baseUrl = OLLAMA_DEFAULT_URL
}) {
  await ensureOllamaServer(baseUrl);

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      prompt: promptText,
      system: systemPrompt,
      stream: true
    }),
    signal
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Erro Ollama (${res.status}): ${errText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) {
          fullText += parsed.response;
          onStreamChunk?.({
            delta: parsed.response,
            fullText,
            resolvedModel: modelName
          });
        }
      } catch (_) {}
    }
  }

  return { text: fullText, rawText: fullText };
}

module.exports = {
  OLLAMA_DEFAULT_URL,
  checkOllamaRunning,
  ensureOllamaServer,
  fetchOllamaModels,
  streamOllamaTurn
};
