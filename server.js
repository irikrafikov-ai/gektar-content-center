// ГектарЪ · Контент-центр — бэкенд-прокси.
// Держит ключ Anthropic на сервере и передаёт запросы фронтенда в Messages API.
// Ключ НИКОГДА не попадает в браузер.
const express = require('express');
const path = require('path');
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/generate', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY не задан в переменных окружения сервера.' } });
  }

  // MCP-коннекторы: URL и токены берём из секретов сервера, чтобы их не было в браузере
  const body = req.body || {};
  if (Array.isArray(body.mcp_servers)) {
    body.mcp_servers = body.mcp_servers.map(s => {
      if (!s || !s.name) return s;
      if (s.name === 'yandex-gektar' && process.env.YANDEX_MCP_URL) {
        return { type: 'url', name: s.name, url: process.env.YANDEX_MCP_URL };
      }
      if (s.name === 'hexvild') {
        const out = { type: 'url', name: s.name, url: process.env.HIGGSFIELD_URL || 'https://mcp.higgsfield.ai/mcp' };
        if (process.env.HIGGSFIELD_TOKEN) out.authorization_token = process.env.HIGGSFIELD_TOKEN;
        return out;
      }
      return s;
    }).filter(s => s && s.url);
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        // бета-флаг для MCP-коннекторов; при необходимости обновить по актуальной документации Anthropic
        'anthropic-beta': 'mcp-client-2025-04-04'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: { message: String(e && e.message || e) } });
  }
});

// Генерация картинок через OpenAI (ключ живёт секретом на сервере)
app.post('/api/image', async (req, res) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: { message: 'OPENAI_API_KEY не задан в переменных окружения сервера.' } });
  }
  const prompt = (req.body && req.body.prompt || '').toString().slice(0, 4000);
  if (!prompt) return res.status(400).json({ error: { message: 'Пустой prompt.' } });
  const model = process.env.OPENAI_MODEL || 'gpt-image-1';
  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, prompt, size: '1536x1024', n: 1 })
    });
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: { message: (data.error && data.error.message) || 'OpenAI error' } });
    }
    const d0 = data.data && data.data[0];
    // gpt-image-1 отдаёт b64_json; на всякий случай поддержим и url
    const dataUrl = d0 && d0.b64_json
      ? 'data:image/png;base64,' + d0.b64_json
      : (d0 && d0.url) || null;
    if (!dataUrl) return res.status(502).json({ error: { message: 'OpenAI не вернул изображение.' } });
    res.json({ image: dataUrl });
  } catch (e) {
    res.status(500).json({ error: { message: String(e && e.message || e) } });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('ГектарЪ content-center up on :' + port));
