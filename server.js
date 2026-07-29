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
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key.trim() },
      body: JSON.stringify({ model, prompt, size: '1536x1024', n: 1 })
    });
    const data = await r.json();
    if (!r.ok) {
      console.log('OpenAI image error', r.status, 'model=' + model, JSON.stringify(data.error || data));
      return res.status(r.status).json({ error: { message: (data.error && data.error.message) || ('OpenAI error ' + r.status) } });
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

// Прокси картинок с Диска для задеплоенного сайта (в браузере адрес yandex-mcp скрыт)
app.get('/api/img', async (req, res) => {
  const base = process.env.YANDEX_MCP_URL;
  if (!base) return res.status(500).send('YANDEX_MCP_URL не задан');
  const imgUrl = base.replace('/mcp/', '/img/') + '?path=' + encodeURIComponent(req.query.path || '');
  try {
    const r = await fetch(imgUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(r.status).send(buf);
  } catch (e) {
    res.status(500).send(String(e && e.message || e));
  }
});

// ── Публикация в каналы. Маршрут по аудитории: partner / client (video → partner). ──
// Переменные окружения (per-audience, с общим фолбэком):
//   TG_TOKEN_PARTNER / TG_TOKEN_CLIENT  (или общий TG_TOKEN)
//   TG_CHAT_PARTNER  / TG_CHAT_CLIENT
//   MAX_TOKEN_PARTNER / MAX_TOKEN_CLIENT (или общий MAX_TOKEN)
//   MAX_CHAT_PARTNER  / MAX_CHAT_CLIENT
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  return { blob: new Blob([Buffer.from(m[2], 'base64')], { type: m[1] }), type: m[1] };
}
// markdown → HTML-теги Telegram, безопасное экранирование прочего
function toTgHtml(src) {
  let s = String(src || '');
  // защитим уже готовые теги b/i/u/s от экранирования
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // markdown → html
  s = s.replace(/\*\*([^\n*][\s\S]*?)\*\*/g, '<b>$1</b>');   // **жирный**
  s = s.replace(/__([^\n_][\s\S]*?)__/g, '<u>$1</u>');       // __подчёркнутый__
  s = s.replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>'); // *курсив*
  s = s.replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>');   // _курсив_
  return s;
}
async function tgSend(token, chat, text, media) {
  // приводим ссылку t.me/name к @name; числовой id и @username оставляем как есть
  if (typeof chat === 'string') {
    const m = chat.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/);
    if (m) chat = '@' + m[1];
  }
  const api = (m) => `https://api.telegram.org/bot${token}/${m}`;
  const html = toTgHtml(text);
  const photos = (media || []).filter((x) => x.type === 'photo');
  const video = (media || []).find((x) => x.type === 'video');
  try {
    if (video) {
      const r = await fetch(api('sendVideo'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, video: video.url, caption: html, parse_mode: 'HTML' }) });
      return !!(await r.json()).ok;
    }
    if (photos.length === 1 && photos[0].url.startsWith('data:')) {
      const d = dataUrlToBlob(photos[0].url);
      const fd = new FormData();
      fd.append('chat_id', chat); fd.append('caption', html); fd.append('parse_mode', 'HTML');
      fd.append('photo', d.blob, 'photo.png');
      const r = await fetch(api('sendPhoto'), { method: 'POST', body: fd });
      return !!(await r.json()).ok;
    }
    const httpPhotos = photos.filter((p) => /^https?:/.test(p.url));
    if (httpPhotos.length > 1) {
      const r = await fetch(api('sendMediaGroup'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, media: httpPhotos.slice(0, 10).map((p, i) => ({ type: 'photo', media: p.url, caption: i === 0 ? html : undefined, parse_mode: i === 0 ? 'HTML' : undefined })) }) });
      const j = await r.json(); return Array.isArray(j.result) ? true : !!j.ok;
    }
    if (httpPhotos.length === 1) {
      const r = await fetch(api('sendPhoto'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, photo: httpPhotos[0].url, caption: html, parse_mode: 'HTML' }) });
      return !!(await r.json()).ok;
    }
    const r = await fetch(api('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: html, parse_mode: 'HTML' }) });
    return !!(await r.json()).ok;
  } catch (e) { console.error('TG', e); return false; }
}
function toPlain(src) {
  return String(src || '')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1')
    .replace(/(^|[\s(])\*([^\s*][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^\s_][^_\n]*?)_(?=[\s).,!?:;]|$)/g, '$1$2');
}
// байты картинки: из data:URL (base64) или по http-ссылке (с Диска)
async function fetchImageBytes(u) {
  try {
    if (u.startsWith('data:')) { const m = /^data:[^;]+;base64,(.*)$/.exec(u); return m ? Buffer.from(m[1], 'base64') : null; }
    const r = await fetch(u); if (!r.ok) return null; return Buffer.from(await r.arrayBuffer());
  } catch (_) { return null; }
}
// запрос к MAX с перебором способов авторизации; возвращает первый успешный
async function maxAuthFetch(url, init, clean) {
  const auths = [{ Authorization: 'Bearer ' + clean }, { Authorization: clean }, { 'X-Access-Token': clean }];
  let last = { ok: false };
  for (const a of auths) {
    const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...a } });
    let j = null; try { j = await r.json(); } catch (_) {}
    last = { ok: r.ok && !(j && (j.code || j.error)), status: r.status, j };
    if (last.ok) return last;
  }
  return last;
}
// загрузка одной картинки в MAX: getUploadUrl -> upload bytes -> payload вложения
async function maxUploadImage(clean, bytes) {
  const u = await maxAuthFetch('https://botapi.max.ru/uploads?type=image', { method: 'POST' }, clean);
  if (!u.ok || !u.j || !u.j.url) { console.log('MAX upload-url fail', u.status, JSON.stringify(u.j)); return null; }
  try {
    const fd = new FormData();
    fd.append('data', new Blob([bytes], { type: 'image/png' }), 'photo.png');
    const r2 = await fetch(u.j.url, { method: 'POST', body: fd });
    let j2 = null; try { j2 = await r2.json(); } catch (_) {}
    if (!r2.ok || !j2) { console.log('MAX upload-data fail', r2.status, JSON.stringify(j2)); return null; }
    return j2; // {photos:{...}} или {token:...} — целиком как payload вложения
  } catch (e) { console.log('MAX upload-data err', String(e && e.message || e)); return null; }
}
async function maxSend(token, chat, text, media) {
  try {
    const clean = String(token || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bearer\s+/i, '').trim();
    let chatId = String(chat || '').trim();
    const mm = chatId.match(/max\.ru\/[^/]*\/(-?\d+)/) || chatId.match(/(-?\d{5,})/);
    if (mm) chatId = mm[1];
    const url = 'https://botapi.max.ru/messages?chat_id=' + encodeURIComponent(chatId);
    // MAX markdown: подчёркивание __x__ у MAX ненадёжно — превращаем в жирный **x**
    const mdText = String(text || '').replace(/__([\s\S]*?)__/g, '**$1**');
    const photos = (media || []).filter((m) => m.type === 'photo').slice(0, 4);

    // грузим фото как вложения
    const attachments = [];
    for (const p of photos) {
      const bytes = await fetchImageBytes(p.url);
      if (!bytes) continue;
      const payload = await maxUploadImage(clean, bytes);
      if (payload) attachments.push({ type: 'image', payload });
    }

    async function send(bodyObj, label) {
      const res = await maxAuthFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bodyObj) }, clean);
      console.log('MAX', label, res.status, JSON.stringify(res.j));
      return res;
    }

    // отправка с вложениями + markdown; ретрай, если вложения ещё обрабатываются
    let body = { text: mdText, format: 'markdown' };
    if (attachments.length) body.attachments = attachments;
    let res = await send(body, attachments.length ? 'md+img' : 'md');
    let tries = 0;
    while (!res.ok && res.j && /not[._-]?ready|processing|proc\.error/i.test(JSON.stringify(res.j)) && tries < 3) {
      await new Promise((r) => setTimeout(r, 2000)); tries++;
      res = await send(body, 'retry');
    }
    if (res.ok) return true;

    // фолбэк: чистый текст (+ ссылки на фото), без markdown/вложений — чтобы пост не потерялся
    const links = photos.map((p) => p.url).filter((u) => /^https?:/.test(u)).join('\n');
    const res2 = await send({ text: toPlain(text) + (links ? '\n\n' + links : '') }, 'plain');
    return res2.ok;
  } catch (e) { console.error('MAX', e); return false; }
}
app.post('/api/publish', async (req, res) => {
  const { aud, text, media, channels } = req.body || {};
  const ch = channels || 'both';
  const wantTg = ch !== 'max', wantMax = ch !== 'tg';
  const A = aud === 'client' ? 'CLIENT' : 'PARTNER';
  const tgToken = process.env['TG_TOKEN_' + A] || process.env.TG_TOKEN;
  const tgChat = process.env['TG_CHAT_' + A];
  const maxToken = process.env['MAX_TOKEN_' + A] || process.env.MAX_TOKEN;
  const maxChat = process.env['MAX_CHAT_' + A];
  const out = { tg: 'skip', max: 'skip', audience: A.toLowerCase() };
  if (wantTg && tgToken && tgChat) out.tg = (await tgSend(tgToken, tgChat, text || '', media || [])) ? 'ok' : 'err';
  if (wantMax && maxToken && maxChat) out.max = (await maxSend(maxToken, maxChat, text || '', media || [])) ? 'ok' : 'err';
  res.json(out);
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('ГектарЪ content-center up on :' + port));
