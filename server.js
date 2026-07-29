// ГектарЪ · Контент-центр — бэкенд-прокси.
// Держит ключ Anthropic на сервере и передаёт запросы фронтенда в Messages API.
// Ключ НИКОГДА не попадает в браузер.
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json({ limit: '16mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── постоянное хранилище (на Railway лучше смонтировать Volume и задать DATA_DIR=/data) ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const POSTS_FILE = path.join(DATA_DIR, 'posts.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (_) {}
app.use('/uploads', express.static(UPLOAD_DIR));
function loadPosts() { try { return JSON.parse(fs.readFileSync(POSTS_FILE, 'utf8')); } catch (_) { return []; } }
function savePosts(arr) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(POSTS_FILE, JSON.stringify(arr)); } catch (e) { console.error('savePosts', e); } }
function originOf(req) { return (req.headers['x-forwarded-proto'] || req.protocol || 'https') + '://' + req.get('host'); }

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
  if (!base) { console.log('IMG: YANDEX_MCP_URL не задан'); return res.status(500).send('YANDEX_MCP_URL не задан'); }
  const target = base.replace('/mcp/', '/img/') + '?path=' + encodeURIComponent(req.query.path || '');
  try {
    const r = await fetch(target);
    const ct = r.headers.get('content-type') || 'image/jpeg';
    if (!r.ok || !/^image\//.test(ct)) {
      const txt = await r.text().catch(() => '');
      console.log('IMG proxy fail', r.status, 'ct=' + ct, 'path=' + (req.query.path || ''), txt.slice(0, 200));
      return res.status(r.status || 502).send('img error: ' + r.status + ' ' + txt.slice(0, 200));
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).send(buf);
  } catch (e) {
    console.log('IMG proxy error', String(e && e.message || e));
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
// единая публикация поста по его аудитории/каналам — используется и API, и планировщиком
async function publishPost(item) {
  const ch = item.channels || 'both';
  const wantTg = ch !== 'max', wantMax = ch !== 'tg';
  const A = item.aud === 'client' ? 'CLIENT' : 'PARTNER';
  const tgToken = process.env['TG_TOKEN_' + A] || process.env.TG_TOKEN;
  const tgChat = process.env['TG_CHAT_' + A];
  const maxToken = process.env['MAX_TOKEN_' + A] || process.env.MAX_TOKEN;
  const maxChat = process.env['MAX_CHAT_' + A];
  const out = { tg: 'off', max: 'off' };
  if (wantTg) out.tg = (tgToken && tgChat) ? ((await tgSend(tgToken, tgChat, item.text || '', item.media || [])) ? 'ok' : 'err') : 'wait';
  if (wantMax) out.max = (maxToken && maxChat) ? ((await maxSend(maxToken, maxChat, item.text || '', item.media || [])) ? 'ok' : 'err') : 'wait';
  return out;
}
app.post('/api/publish', async (req, res) => {
  const out = await publishPost(req.body || {});
  res.json({ tg: out.tg === 'wait' ? 'skip' : out.tg, max: out.max === 'wait' ? 'skip' : out.max });
});

// ── KIE (kie.ai): генерация видео и видео-по-фото (Veo). Ключ KIE_API_KEY на сервере. ──
app.post('/api/video', async (req, res) => {
  const key = process.env.KIE_API_KEY;
  if (!key) return res.status(500).json({ error: { message: 'KIE_API_KEY не задан в переменных окружения сервера.' } });
  const { prompt, imageUrl } = req.body || {};
  if (!prompt) return res.status(400).json({ error: { message: 'Пустой prompt.' } });
  const body = { prompt, model: 'veo3_fast', aspect_ratio: '16:9', enableTranslation: true };
  if (imageUrl) body.imageUrls = [imageUrl];
  try {
    const r = await fetch('https://api.kie.ai/api/v1/veo/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key.trim() },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    console.log('KIE generate', r.status, JSON.stringify(data).slice(0, 300));
    const taskId = data && data.data && (data.data.taskId || data.data.task_id);
    if (!r.ok || data.code !== 200 || !taskId) {
      return res.status(502).json({ error: { message: (data && data.msg) || ('KIE error ' + r.status) } });
    }
    res.json({ taskId });
  } catch (e) { res.status(500).json({ error: { message: String(e && e.message || e) } }); }
});

app.get('/api/video-status', async (req, res) => {
  const key = process.env.KIE_API_KEY;
  if (!key) return res.status(500).json({ error: { message: 'KIE_API_KEY не задан.' } });
  const taskId = req.query.taskId;
  if (!taskId) return res.status(400).json({ error: { message: 'Нет taskId.' } });
  try {
    const r = await fetch('https://api.kie.ai/api/v1/veo/record-info?taskId=' + encodeURIComponent(taskId), {
      headers: { authorization: 'Bearer ' + key.trim() }
    });
    const data = await r.json();
    console.log('KIE status', r.status, JSON.stringify(data).slice(0, 300));
    const d = (data && data.data) || {};
    const flag = d.successFlag !== undefined ? d.successFlag : (d.state || d.status);
    // ссылку на видео ищем в разных возможных полях
    let videoUrl = (d.videoInfo && d.videoInfo.videoUrl) || d.video_url || d.videoUrl || null;
    if (!videoUrl && d.resultJson) { try { const rj = JSON.parse(d.resultJson); videoUrl = (rj.resultUrls && rj.resultUrls[0]) || rj.video_url || null; } catch (_) {} }
    if (!videoUrl && d.response && d.response.resultUrls) videoUrl = d.response.resultUrls[0];
    const failed = flag === 2 || flag === 3 || flag === 'fail' || flag === 'FAILED' || flag === 'error';
    res.json({ done: !!videoUrl, failed: failed && !videoUrl, videoUrl });
  } catch (e) { res.status(500).json({ error: { message: String(e && e.message || e) } }); }
});

// ── Хранилище постов: календарь/история + автопубликация отложенных ──
app.get('/api/posts', (req, res) => { res.json(loadPosts()); });

app.post('/api/posts', async (req, res) => {
  const p = req.body || {};
  if (!p.id) p.id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6);
  const posts = loadPosts();
  const now = Date.now();
  const when = p.date ? new Date(p.date).getTime() : now;
  const future = !!p.scheduled && when > now + 30000;
  if (future) {
    p.published = false;
    p.status = { tg: p.channels === 'max' ? 'off' : 'plan', max: p.channels === 'tg' ? 'off' : 'plan' };
  } else {
    p.status = await publishPost(p);
    p.published = true; p.scheduled = false; p.date = new Date().toISOString();
  }
  const i = posts.findIndex((x) => x.id === p.id);
  if (i > -1) posts[i] = p; else posts.push(p);
  savePosts(posts);
  res.json(p);
});

app.delete('/api/posts/:id', (req, res) => {
  savePosts(loadPosts().filter((x) => x.id !== req.params.id));
  res.json({ ok: true });
});

// загрузка своего фото (для «видео по фото») — принимаем data URL, отдаём публичную ссылку
app.post('/api/upload', (req, res) => {
  try {
    const data = (req.body && req.body.data) || '';
    const m = /^data:(image\/(png|jpe?g|webp));base64,(.*)$/.exec(data);
    if (!m) return res.status(400).json({ error: { message: 'Ожидается data:image/... base64' } });
    const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
    const name = 'up_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(m[3], 'base64'));
    res.json({ url: originOf(req) + '/uploads/' + name });
  } catch (e) { res.status(500).json({ error: { message: String(e && e.message || e) } }); }
});

// планировщик: каждые 30 сек публикует отложенные посты, у которых наступило время
setInterval(async () => {
  try {
    const posts = loadPosts();
    const now = Date.now();
    let changed = false;
    for (const p of posts) {
      if (p.scheduled && !p.published && p.date && new Date(p.date).getTime() <= now) {
        p.status = await publishPost(p);
        p.published = true; p.scheduled = false;
        changed = true;
        console.log('scheduled published', p.id, JSON.stringify(p.status));
      }
    }
    if (changed) savePosts(posts);
  } catch (e) { console.error('scheduler', e); }
}, 30000);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('ГектарЪ content-center up on :' + port));
