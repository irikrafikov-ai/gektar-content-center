'use strict';

// Isolated, read-only metadata audit. Never import publication/generation code.
const { createHash, timingSafeEqual } = require('node:crypto');
const { open } = require('node:fs/promises');
const { performance } = require('node:perf_hooks');

const MAX_REQUEST_BYTES = 4096;
const MAX_RESPONSE_BYTES = 65536;
const MAX_EXECUTION_MS = 20000;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_POSTS = 100000;
const KNOWN_FAULT = Symbol('directorTaskFault');
const TASK_ID = /^dt_[a-f0-9]{64}$/;
const REQUEST_KEYS = ['acceptance', 'agent', 'created_at', 'deadline', 'idempotency_key', 'kind', 'payload', 'task_id'];

function fault(status, code) {
  return Object.assign(new Error(code), { status, code, [KNOWN_FAULT]: true });
}
function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}
function timestamp(value) {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const days = new Date(Date.UTC(+year, +month, 0)).getUTCDate();
  if (+month < 1 || +month > 12 || +day < 1 || +day > days || +hour > 23 || +minute > 59 || +second > 59) return NaN;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return NaN;
  return Date.parse(value);
}
function validateTaskRequest(value, now = Date.now()) {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== REQUEST_KEYS.join(',')) throw fault(400, 'invalid_task');
  if (typeof value.task_id !== 'string' || !TASK_ID.test(value.task_id) || value.idempotency_key !== value.task_id ||
      value.agent !== 'content' || value.kind !== 'content.calendar.audit' || value.acceptance !== 'content_calendar_v1' ||
      !plainObject(value.payload) || Object.keys(value.payload).length) throw fault(400, 'invalid_task');
  const created = timestamp(value.created_at), deadline = timestamp(value.deadline);
  if (!Number.isFinite(created) || !Number.isFinite(deadline) || deadline <= created || created > now + 300000) throw fault(400, 'invalid_task_time');
  if (deadline <= now) throw fault(410, 'deadline_expired');
  return value;
}
function checkSignal(signal) {
  if (signal?.aborted) throw fault(504, 'task_timeout');
}

// Unlike the ordinary UI loader, never turn missing/unreadable data into [].
// Bounded chunk reads also cap growth between stat() and reading the file.
async function readLocalPosts(filePath, { signal } = {}) {
  let file;
  try {
    checkSignal(signal);
    file = await open(filePath, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) throw fault(503, 'snapshot_unavailable');
    const chunks = [];
    let size = 0;
    while (true) {
      checkSignal(signal);
      const buffer = Buffer.allocUnsafe(Math.min(65536, MAX_STORE_BYTES + 1 - size));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > MAX_STORE_BYTES) throw fault(503, 'snapshot_unavailable');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    checkSignal(signal);
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch (error) {
    if (error?.[KNOWN_FAULT]) throw error;
    throw fault(503, 'snapshot_unavailable');
  } finally {
    if (file) await file.close();
  }
}
function usableMedia(item) {
  if (!plainObject(item) || !['photo', 'video'].includes(item.type) || typeof item.url !== 'string' || !item.url.trim()) return false;
  // Only inspect stored references. Do not fetch assets or verify their existence.
  return /^https?:\/\/[^\s]+$/i.test(item.url) || (item.type === 'photo' && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+$/i.test(item.url));
}
async function aggregateCalendar(posts, observedAt, { signal, checkBudget = () => {} } = {}) {
  if (!Array.isArray(posts) || posts.length > MAX_POSTS || !Number.isFinite(observedAt)) throw fault(503, 'snapshot_unavailable');
  const result = {
    total: posts.length, scheduled: 0, overdue: 0, unready: 0, duplicate_candidates: 0,
    duplicate_groups: 0, published: 0, unscheduled: 0,
    readiness: { missing_content: 0, missing_schedule_time: 0, invalid_schedule_time: 0,
      invalid_audience: 0, invalid_channels: 0, invalid_media: 0, invalid_state_flags: 0 },
  };
  const fingerprints = new Map();
  for (let index = 0; index < posts.length; index++) {
    if (index % 256 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      checkSignal(signal); checkBudget();
    }
    const post = posts[index];
    if (!plainObject(post)) throw fault(503, 'snapshot_unavailable');
    // Match the existing scheduler's truthiness, flag malformed booleans below.
    const pending = !post.published;
    const scheduled = pending && !!post.scheduled;
    if (!pending) result.published++;
    else if (scheduled) result.scheduled++;
    else result.unscheduled++;
    const date = timestamp(post.date);
    if (scheduled && Number.isFinite(date) && date <= observedAt) result.overdue++;
    const text = typeof post.text === 'string' ? post.text.trim().replace(/\s+/g, ' ') : '';
    const media = Array.isArray(post.media) ? post.media : [];
    const validMedia = media.filter(usableMedia);
    if (pending) {
      const issues = {
        missing_content: !text && !validMedia.length,
        missing_schedule_time: scheduled && (post.date === undefined || post.date === null || post.date === ''),
        invalid_schedule_time: scheduled && post.date !== undefined && post.date !== null && post.date !== '' && !Number.isFinite(date),
        invalid_audience: post.aud !== undefined && !['partner', 'client', 'video'].includes(post.aud),
        invalid_channels: post.channels !== undefined && !['both', 'tg', 'max'].includes(post.channels),
        invalid_media: (post.media !== undefined && !Array.isArray(post.media)) || validMedia.length !== media.length,
        invalid_state_flags: (post.scheduled !== undefined && typeof post.scheduled !== 'boolean') || (post.published !== undefined && typeof post.published !== 'boolean'),
      };
      if (Object.values(issues).some(Boolean)) result.unready++;
      for (const [key, invalid] of Object.entries(issues)) if (invalid) result.readiness[key]++;
    }
    if (text || validMedia.length) {
      // URLs/content are hashed locally, never included in the response. Sort
      // media signatures so reordering the same attachments still matches.
      const signature = sha256({
        audience: post.aud === 'client' ? 'client' : 'partner',
        channels: post.channels === 'tg' || post.channels === 'max' ? post.channels : 'both',
        text,
        media: validMedia.map(item => sha256({ type: item.type, url: item.url })).sort(),
      });
      const group = fingerprints.get(signature) || { total: 0, pending: 0 };
      group.total++; if (pending) group.pending++;
      fingerprints.set(signature, group);
    }
  }
  for (const group of fingerprints.values()) {
    if (group.total > 1 && group.pending > 0) {
      result.duplicate_groups++;
      result.duplicate_candidates += group.pending;
    }
  }
  checkSignal(signal); checkBudget();
  return result;
}
async function executeCalendarTask(request, { readPosts, now = () => new Date(), signal, checkBudget = () => {} }) {
  const accepted_at = now().toISOString();
  validateTaskRequest(request, Date.parse(accepted_at));
  const request_hash = sha256(request);
  const started_at = now().toISOString();
  const posts = await readPosts({ signal });
  const observed_at = now().toISOString();
  const result = await aggregateCalendar(posts, Date.parse(observed_at), { signal, checkBudget });
  const finished_at = now().toISOString();
  if (Date.parse(finished_at) >= timestamp(request.deadline)) throw fault(410, 'deadline_expired');
  // Retries intentionally re-observe current local state; the director owns
  // durable delivery/results. No cached/frozen receipt is claimed here.
  return {
    protocol: 1, task_id: request.task_id, agent: 'content', status: 'completed', request_hash,
    receipt_id: `dr_${sha256({ request_hash, observed_at, result })}`,
    accepted_at, started_at, finished_at,
    evidence: { source: 'content.local_posts', observed_at, result },
  };
}
function secureToken(token) {
  return typeof token === 'string' && /^[\x21-\x7e]{32,256}$/.test(token);
}
function authenticated(req, token) {
  const supplied = req.headers['x-director-task-token'];
  if (typeof supplied !== 'string' || supplied.length > 256) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(token));
}
function respond(res, status, body) {
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE_BYTES) throw fault(500, 'response_too_large');
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(json);
}
function readJson(req, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onTimeout); };
    const fail = error => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const onTimeout = () => fail(fault(504, 'task_timeout'));
    const timer = setTimeout(() => fail(fault(408, 'request_timeout')), 10000);
    timer.unref?.();
    signal.addEventListener('abort', onTimeout, { once: true });
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { fail(fault(413, 'request_too_large')); return; }
      if (!settled) chunks.push(chunk);
    });
    req.once('end', () => {
      if (settled) return;
      settled = true; cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(fault(400, 'invalid_json')); }
    });
    req.once('aborted', () => fail(fault(400, 'request_aborted')));
    req.once('error', () => fail(fault(400, 'request_aborted')));
  });
}

// Mount before express.json() and static files. Only the dedicated task token
// authenticates this path; legacy API/UI authentication is untouched.
function createDirectorTaskHandler({ token, readPosts, now = () => new Date() }) {
  return async function directorTaskHandler(req, res) {
    let request, timer;
    const controller = new AbortController();
    const start = performance.now();
    const checkBudget = () => {
      if (performance.now() - start >= MAX_EXECUTION_MS) throw fault(504, 'task_timeout');
    };
    try {
      if (!secureToken(token)) throw fault(503, 'director_tasks_disabled');
      if (!authenticated(req, token)) throw fault(401, 'unauthorized');
      if (req.url !== '/' && req.url !== '') throw fault(404, 'not_found');
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw fault(405, 'method_not_allowed'); }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) throw fault(415, 'json_required');
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw fault(415, 'encoding_not_supported');
      if (Number(req.headers['content-length']) > MAX_REQUEST_BYTES) throw fault(413, 'request_too_large');
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fault(504, 'task_timeout')); }, MAX_EXECUTION_MS);
        timer.unref?.();
      });
      const response = await Promise.race([timeout, (async () => {
        request = await readJson(req, controller.signal);
        validateTaskRequest(request, now().getTime());
        return executeCalendarTask(request, { readPosts, now, signal: controller.signal, checkBudget });
      })()]);
      checkBudget();
      respond(res, 200, response);
    } catch (error) {
      controller.abort();
      req.resume();
      const status = error?.[KNOWN_FAULT] ? error.status : 503;
      const code = error?.[KNOWN_FAULT] ? error.code : 'snapshot_unavailable';
      const body = { protocol: 1, error: { code } };
      if (status >= 500 && request && TASK_ID.test(request.task_id)) {
        Object.assign(body, { task_id: request.task_id, agent: 'content', status: 'failed', request_hash: sha256(request) });
      }
      if (!res.writableEnded) respond(res, status, body);
    } finally {
      clearTimeout(timer);
    }
  };
}
module.exports = {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_EXECUTION_MS, MAX_STORE_BYTES, MAX_POSTS,
  canonicalJson, sha256, validateTaskRequest, readLocalPosts, aggregateCalendar,
  executeCalendarTask, createDirectorTaskHandler,
};
