const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const WEB_MODELS = [
  { id: '4-argon', displayName: '4 Argon — Código e análise' },
  { id: '4-hydrogen', displayName: '4 Hydrogen — Ajuda no dia a dia' },
  { id: '3.1-pro', displayName: '3.1 Pro — Pesquisa detalhada' },
  { id: '3.5-flash-lite', displayName: '3.5 Flash Lite — Respostas rápidas' }
];

const MODEL_HEADERS = {
  '4-argon': { 'x-goog-ext-525001261-jspb': '[1,null,null,null,"9d8ca3786ebdfbea"]' },
  '4-hydrogen': {},
  '3.1-pro': { 'x-goog-ext-525001261-jspb': '[1,null,null,null,"e6fa609c3fa255c0"]' },
  '3.5-flash-lite': { 'x-goog-ext-525001261-jspb': '[1,null,null,null,"71c2d248d3b102ff"]' }
};

function cookiesToHeader(cookies) {
  const dedup = new Map();
  for (const c of cookies) {
    if (c && c.name && c.value) {
      dedup.set(c.name, c.value);
    }
  }
  return Array.from(dedup.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function mergeSetCookies(existingCookies, setCookieHeaders) {
  if (!Array.isArray(setCookieHeaders) || setCookieHeaders.length === 0) {
    return existingCookies;
  }
  const map = new Map(existingCookies.map((c) => [c.name, { ...c }]));
  for (const raw of setCookieHeaders) {
    const firstPart = raw.split(';')[0];
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    map.set(name, { name, value, domain: '.google.com', path: '/' });
  }
  return Array.from(map.values());
}

function cleanGeminiWebText(rawText) {
  if (!rawText) return '';
  return rawText
    .replace(/https?:\/\/googleusercontent\.com\/lmdx_content\/[^\s)]+/g, '')
    .replace(/```(?:python|text)\?code_(?:reference|stdout)[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function rotateGoogleCookies(account, onCookiesUpdated) {
  try {
    const res = await fetch('https://accounts.google.com/RotateCookies', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookiesToHeader(account.cookies),
        'User-Agent': CHROME_UA
      },
      body: JSON.stringify(['180000000', '-0000000000000000000'])
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      account.cookies = mergeSetCookies(account.cookies, setCookies);
      onCookiesUpdated?.(account);
    }
  } catch (_) {}
}

async function initGeminiWebSession(account, onCookiesUpdated) {
  await rotateGoogleCookies(account, onCookiesUpdated);

  try {
    const res = await fetch('https://gemini.google.com/app', {
      method: 'GET',
      headers: {
        Cookie: cookiesToHeader(account.cookies),
        'User-Agent': CHROME_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      redirect: 'follow'
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      account.cookies = mergeSetCookies(account.cookies, setCookies);
      onCookiesUpdated?.(account);
    }

    const html = await res.text();
    const snlm0e = html.match(/"SNlM0e":"([^"]+)"/)?.[1];
    const bl = html.match(/"cfb2h":"([^"]+)"/)?.[1];
    const fsid = html.match(/"FdrFJe":"([^"]+)"/)?.[1];
    const detectedEmail = html.match(/"oPEP7c":"([^"]+@[^"]+)"/)?.[1];

    if (snlm0e) {
      const session = {
        snlm0e,
        bl: bl || account.cachedSession?.bl || 'boq_assistant-bard-web-server_20261115.00_p0',
        fsid: fsid || account.cachedSession?.fsid || '',
        email: detectedEmail || account.email
      };
      account.cachedSession = session;
      onCookiesUpdated?.(account);
      return session;
    }
  } catch (_) {}

  if (account.cachedSession?.snlm0e) {
    return account.cachedSession;
  }

  throw new Error(
    `Sessão expirada na conta ${account.email}. Remova e clique em + CONECTAR para reautenticar.`
  );
}

function extractTextFromWrbFrame(rawJsonStr) {
  const inner = JSON.parse(rawJsonStr);
  const cid = inner?.[1]?.[0] || null;
  const rid = inner?.[1]?.[1] || null;
  const candidate = inner?.[4]?.[0];
  const rcid = candidate?.[0] || null;

  let text = '';
  if (Array.isArray(candidate?.[1]) && typeof candidate[1][0] === 'string') {
    text = candidate[1][0];
  } else if (typeof candidate?.[1] === 'string') {
    text = candidate[1];
  }

  return { cid, rid, rcid, text };
}

async function executeStreamRequest({
  account,
  sessionTokens,
  modelId,
  extraHeaders,
  promptText,
  webContext,
  signal,
  onStreamChunk,
  onCookiesUpdated
}) {
  const reqId = Math.floor(100000 + Math.random() * 899999);
  const url = new URL(
    'https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate'
  );
  url.searchParams.set('bl', sessionTokens.bl);
  if (sessionTokens.fsid) url.searchParams.set('f.sid', sessionTokens.fsid);
  url.searchParams.set('hl', 'pt-BR');
  url.searchParams.set('_reqid', String(reqId));
  url.searchParams.set('rt', 'c');

  const innerPayload = [
    [promptText, 0, null, null, null, null, 0],
    ['pt-BR'],
    webContext || null
  ];

  const fReq = JSON.stringify([null, JSON.stringify(innerPayload)]);
  const body = new URLSearchParams({
    'f.req': fReq,
    at: sessionTokens.snlm0e
  });

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Origin: 'https://gemini.google.com',
      Referer: 'https://gemini.google.com/',
      'X-Same-Domain': '1',
      Cookie: cookiesToHeader(account.cookies),
      'User-Agent': CHROME_UA,
      ...extraHeaders
    },
    body: body.toString(),
    signal
  });

  const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
  if (setCookies.length > 0) {
    account.cookies = mergeSetCookies(account.cookies, setCookies);
    onCookiesUpdated?.(account);
  }

  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Erro HTTP ${response.status} no Gemini Web: ${errText.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let rawLatestText = '';
  let latestContext = webContext ? [...webContext] : [null, null, null];
  let errorCode = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('[[')) continue;

      try {
        const envelope = JSON.parse(trimmed);
        for (const item of envelope) {
          if (!Array.isArray(item)) continue;

          if (item[0] === 'e' && typeof item[1] === 'number') {
            errorCode = item[1];
          }

          if (item[0] === 'wrb.fr' && typeof item[2] === 'string') {
            try {
              const parsed = extractTextFromWrbFrame(item[2]);
              if (parsed.cid) latestContext[0] = parsed.cid;
              if (parsed.rid) latestContext[1] = parsed.rid;
              if (parsed.rcid) latestContext[2] = parsed.rcid;

              if (parsed.text && parsed.text.length >= rawLatestText.length) {
                rawLatestText = parsed.text;
                const cleaned = cleanGeminiWebText(rawLatestText);
                onStreamChunk?.({ fullText: cleaned, rawText: rawLatestText, resolvedModel: modelId });
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }

  return {
    rawLatestText,
    latestText: cleanGeminiWebText(rawLatestText),
    latestContext,
    errorCode
  };
}

async function streamGeminiWebTurn({
  account,
  sessionTokens,
  modelId,
  promptText,
  webContext,
  signal,
  onStreamChunk,
  onCookiesUpdated
}) {
  const primaryHeaders = MODEL_HEADERS[modelId] || {};
  let res = await executeStreamRequest({
    account,
    sessionTokens,
    modelId,
    extraHeaders: primaryHeaders,
    promptText,
    webContext,
    signal,
    onStreamChunk,
    onCookiesUpdated
  });

  if (!res.rawLatestText && res.errorCode !== 1037 && res.errorCode !== 1052 && Object.keys(primaryHeaders).length > 0) {
    res = await executeStreamRequest({
      account,
      sessionTokens,
      modelId: '4-hydrogen',
      extraHeaders: {},
      promptText,
      webContext,
      signal,
      onStreamChunk,
      onCookiesUpdated
    });
  }

  if (!res.rawLatestText) {
    if (res.errorCode === 1037 || res.errorCode === 1052) {
      const qErr = new Error(`Limite de uso atingido na conta ${account.email} (código ${res.errorCode}).`);
      qErr.code = 'QUOTA_EXHAUSTED';
      qErr.status = 429;
      throw qErr;
    }
    throw new Error(
      `O Gemini Web não retornou texto (código ${res.errorCode || 'vazio'}). Tente reenviar.`
    );
  }

  return {
    text: res.latestText,
    rawText: res.rawLatestText,
    webContext: res.latestContext
  };
}

module.exports = {
  WEB_MODELS,
  initGeminiWebSession,
  streamGeminiWebTurn
};
