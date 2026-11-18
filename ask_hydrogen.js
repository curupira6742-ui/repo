const path = require('path');
const fs = require('fs');
const { AccountManager } = require('./auth');
const { initGeminiWebSession, streamGeminiWebTurn } = require('./gemini-web');

async function consultHydrogen(promptText) {
  const userData = path.join(process.env.APPDATA, 'gemini-bw-agent');
  const accountManager = new AccountManager(userData);
  const account = accountManager.getActiveAccountRecord();
  if (!account) {
    console.error(JSON.stringify({ error: "Nenhuma conta ativa no Gemini-BW-Agent." }));
    process.exit(1);
  }

  const sessionTokens = await initGeminiWebSession(account, (acc) => accountManager.updateAccountCookies(acc));

  let fullResponse = '';
  const result = await streamGeminiWebTurn({
    account,
    sessionTokens,
    modelId: '4-hydrogen',
    promptText,
    webContext: null,
    onCookiesUpdated: (acc) => accountManager.updateAccountCookies(acc),
    onStreamChunk: ({ fullText }) => {
      fullResponse = fullText;
    }
  });

  return fullResponse || result.text;
}

const inputPrompt = process.argv.slice(2).join(' ') || "Olá Hydrogen, reporte de status da automação de quests.";

consultHydrogen(inputPrompt)
  .then((reply) => {
    console.log("=== HYDROGEN REPLY ===");
    console.log(reply);
    process.exit(0);
  })
  .catch((err) => {
    console.error("ERRO HYDROGEN:", err.message);
    process.exit(1);
  });
