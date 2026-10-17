'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { mkdtemp, writeFile, readFile, rm, mkdir, truncate } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_EXECUTION_MS, MAX_STORE_BYTES, MAX_POSTS,
  canonicalJson, sha256, validateTaskRequest, readLocalPosts, aggregateCalendar,
  executeCalendarTask, createDirectorTaskHandler,
} = require('../director-tasks');
const TOKEN = 'synthetic-content-test-token-000000000000000000';
const OBSERVED = '2026-10-17T05:00:00.000Z';
const clock = () => new Date(OBSERVED);
function task(changes = {}) {
  const id = 'dt_' + 'a'.repeat(64);
  return { task_id: id, agent: 'content', kind: 'content.calendar.audit', idempotency_key: id,
    created_at: '2026-10-17T04:59:00.000Z', deadline: '2026-10-17T05:10:00.000Z',
    acceptance: 'content_calendar_v1', payload: {}, ...changes };
}
const emptyResult = () => ({ total: 0, scheduled: 0, overdue: 0, unready: 0, duplicate_candidates: 0,
  duplicate_groups: 0, published: 0, unscheduled: 0,
  readiness: { missing_content: 0, missing_schedule_time: 0, invalid_schedule_time: 0,
    invalid_audience: 0, invalid_channels: 0, invalid_media: 0, invalid_state_flags: 0 } });
async function request({ body = JSON.stringify(task()), headers = {}, method = 'POST', url = '/',
  token = TOKEN, readPosts = () => [], now = clock, chunks, leaveOpen = false } = {}) {
  const req = new PassThrough();
  Object.assign(req, { method, url, headers: { 'x-director-task-token': TOKEN, 'content-type': 'application/json', ...headers } });
  const res = { headers: {}, writableEnded: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value) { this.writableEnded = true; this.body = JSON.parse(value); this.raw = value; },
  };
  const running = createDirectorTaskHandler({ token, readPosts, now })(req, res);
  if (!leaveOpen) {
    if (chunks) for (const chunk of chunks) req.write(chunk);
    else req.write(body);
    req.end();
  }
  await running;
  req.destroy();
  return res;
}
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'content-director-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('canonical hashing recursively sorts keys and uses compact JSON', () => {
  assert.equal(canonicalJson({ z: [3, { b: 1, a: 2 }], a: 'x' }), '{"a":"x","z":[3,{"a":2,"b":1}]}');
  assert.equal(sha256({ b: 2, a: 1 }), createHash('sha256').update('{"a":1,"b":2}').digest('hex'));
});

test('strict exact role, kind, payload, acceptance, task ID, and keys', () => {
  assert.equal(validateTaskRequest(task(), clock().getTime()).agent, 'content');
  const bad = [null, [], {}, task({ agent: 'sales' }), task({ kind: 'snapshot.review' }),
    task({ acceptance: 'aggregate_snapshot_v1' }), task({ task_id: 'dt_a' }),
    task({ idempotency_key: 'dt_' + 'b'.repeat(64) }), task({ payload: [] }),
    task({ payload: { publish: true } }), task({ extra: 'ignored?' }),
    Object.fromEntries(Object.entries(task()).filter(([key]) => key !== 'deadline'))];
  for (const value of bad) assert.throws(() => validateTaskRequest(value, clock().getTime()), { code: 'invalid_task' });
});

test('strict ISO timestamps, actual calendar dates, and deadline enforcement', () => {
  for (const date of ['2026-02-30T05:00:00Z', '2026-13-01T05:00:00Z', '2026-10-17', '2026-10-17T25:00:00Z', '2026-10-17T05:00:00+99:00', 123]) {
    assert.throws(() => validateTaskRequest(task({ created_at: date }), clock().getTime()), { code: 'invalid_task_time' });
  }
  assert.throws(() => validateTaskRequest(task({ created_at: '2026-10-17T05:06:00Z' }), clock().getTime()), { code: 'invalid_task_time' });
  assert.throws(() => validateTaskRequest(task({ deadline: OBSERVED }), clock().getTime()), { code: 'deadline_expired' });
  assert.throws(() => validateTaskRequest(task({ deadline: '2026-10-17T04:58:00Z' }), clock().getTime()), { code: 'invalid_task_time' });
});

test('counts concrete scheduled/overdue/unready/duplicate posts without exposing values', async () => {
  const posts = [
    { id: 'PRIVATE-ID-1', text: 'Private client content', aud: 'client', channels: 'tg', scheduled: false, published: true },
    { id: 'PRIVATE-ID-2', text: ' Private  client content ', aud: 'client', channels: 'tg', scheduled: true, published: false, date: '2026-10-17T04:00:00Z' },
    { text: 'Ready future', aud: 'partner', channels: 'both', scheduled: true, date: '2026-10-18T05:00:00Z', media: [] },
    { text: '', scheduled: true, date: null, media: [{ type: 'photo', url: '' }] },
    { text: 'bad settings', aud: 'secret-audience', channels: 'wrong', scheduled: true, published: false, date: '2026-02-30T05:00:00Z', media: 'not-an-array' },
    { text: 'Unscheduled draft', media: [] },
    { text: 'Malformed flag', scheduled: 'yes', date: OBSERVED },
  ];
  const before = JSON.stringify(posts);
  const result = await aggregateCalendar(posts, clock().getTime());
  assert.deepEqual(result, { total: 7, scheduled: 5, overdue: 2, unready: 3, duplicate_candidates: 1,
    duplicate_groups: 1, published: 1, unscheduled: 1,
    readiness: { missing_content: 1, missing_schedule_time: 1, invalid_schedule_time: 1,
      invalid_audience: 1, invalid_channels: 1, invalid_media: 2, invalid_state_flags: 1 } });
  assert.equal(JSON.stringify(posts), before);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|client content|secret-audience|https?:/);
});

test('duplicates respect effective audience/channels and media, ignore order and blank posts', async () => {
  const media = [{ type: 'photo', url: 'https://example.invalid/photo' }, { type: 'video', url: 'https://example.invalid/video' }];
  const result = await aggregateCalendar([
    { text: 'same', aud: 'video', channels: 'both', media },
    { text: 'same', aud: 'partner', media: [...media].reverse() },
    { text: 'same', aud: 'client', media },
    { text: 'same', channels: 'tg', media },
    { text: 'same', media: [{ type: 'photo', url: 'https://example.invalid/different' }] },
    {}, {},
  ], clock().getTime());
  assert.equal(result.duplicate_groups, 1);
  assert.equal(result.duplicate_candidates, 2);
  assert.equal(result.unready, 2);
});

test('text-only and usable photo/video-only posts are ready; no network needed', async () => {
  const result = await aggregateCalendar([
    { text: 'Text only' },
    { media: [{ type: 'photo', url: 'data:image/png;base64,YQ==' }] },
    { media: [{ type: 'video', url: 'https://example.invalid/movie' }] },
  ], clock().getTime());
  assert.equal(result.unready, 0);
  assert.equal(result.unscheduled, 3);
});

test('explicit empty array succeeds; malformed or excessive state never becomes zero', async () => {
  assert.deepEqual(await aggregateCalendar([], clock().getTime()), emptyResult());
  for (const value of [null, {}, [null], [1], ['PRIVATE-SECRET'], new Array(MAX_POSTS + 1)]) {
    await assert.rejects(aggregateCalendar(value, clock().getTime()), { code: 'snapshot_unavailable' });
  }
});

test('local reader reads exact synthetic file without mutating it', async t => {
  const dir = await temporary(t), file = join(dir, 'posts.json');
  const bytes = Buffer.from(JSON.stringify([{ text: 'Private fixture' }]));
  await writeFile(file, bytes);
  assert.deepEqual(await readLocalPosts(file), [{ text: 'Private fixture' }]);
  assert.deepEqual(await readFile(file), bytes);
});

test('local reader refuses missing/corrupt/nonfile/oversized/aborted state', async t => {
  const dir = await temporary(t), file = join(dir, 'posts.json');
  await assert.rejects(readLocalPosts(file), { code: 'snapshot_unavailable' });
  await writeFile(file, '{PRIVATE-BROKEN-JSON');
  await assert.rejects(readLocalPosts(file), { code: 'snapshot_unavailable' });
  await assert.rejects(readLocalPosts(dir), { code: 'snapshot_unavailable' });
  await truncate(file, MAX_STORE_BYTES + 1);
  await assert.rejects(readLocalPosts(file), { code: 'snapshot_unavailable' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readLocalPosts(file, { signal: controller.signal }), { code: 'task_timeout' });
});

test('receipt and request hash independently recompute; timestamps and fixed source', async () => {
  const response = await executeCalendarTask(task(), { readPosts: () => [], now: clock });
  assert.equal(response.protocol, 1); assert.equal(response.status, 'completed');
  assert.equal(response.agent, 'content'); assert.equal(response.evidence.source, 'content.local_posts');
  assert.equal(response.request_hash, sha256(task()));
  assert.equal(response.receipt_id, 'dr_' + sha256({ request_hash: response.request_hash, observed_at: OBSERVED, result: emptyResult() }));
  for (const key of ['accepted_at', 'started_at', 'finished_at']) assert.equal(response[key], OBSERVED);
});

test('retry re-observes current state, never claims a frozen result', async () => {
  let posts = [];
  const first = await executeCalendarTask(task(), { readPosts: () => posts, now: clock });
  posts = [{ text: 'New local draft' }];
  const second = await executeCalendarTask(task(), { readPosts: () => posts, now: clock });
  assert.equal(first.request_hash, second.request_hash);
  assert.notEqual(first.receipt_id, second.receipt_id);
  assert.equal(second.evidence.result.total, 1);
});

test('deadline expiring during execution is not reported completed', async () => {
  let ticks = 0;
  await assert.rejects(executeCalendarTask(task(), { readPosts: () => [],
    now: () => new Date(ticks++ < 3 ? OBSERVED : '2026-10-17T05:11:00Z') }), { code: 'deadline_expired' });
});

test('token absent/invalid disables route; legacy auth/session cannot grant access', async () => {
  for (const token of ['', 'short', 'unsafe token with spaces not valid 0000']) {
    const res = await request({ token }); assert.equal(res.statusCode, 503);
    assert.equal(res.body.error.code, 'director_tasks_disabled');
  }
  for (const supplied of [undefined, 'wrong', TOKEN + ', ' + TOKEN, [TOKEN, TOKEN], 'x'.repeat(257)]) {
    let reads = 0;
    const res = await request({ headers: { 'x-director-task-token': supplied, authorization: 'Bearer ' + TOKEN, cookie: 'session=' + TOKEN }, readPosts: () => { reads++; return []; } });
    assert.equal(res.statusCode, 401); assert.equal(reads, 0);
    assert.doesNotMatch(res.raw, new RegExp(TOKEN));
  }
});

test('success response is metadata-only JSON with no-cache, nosniff, bounded body', async () => {
  const res = await request();
  assert.equal(res.statusCode, 200); assert.equal(res.body.evidence.result.total, 0);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(Buffer.byteLength(res.raw) < MAX_RESPONSE_BYTES);
});

test('rejects wrong methods/path/encoding/content type without reading storage', async () => {
  const cases = [
    [{ method: 'GET' }, 405], [{ method: 'DELETE' }, 405], [{ method: 'OPTIONS' }, 405],
    [{ url: '/publish' }, 404], [{ url: '/?task_id=x' }, 404],
    [{ headers: { 'content-type': 'text/plain' } }, 415],
    [{ headers: { 'content-encoding': 'gzip' } }, 415],
  ];
  for (const [options, status] of cases) {
    let reads = 0;
    const res = await request({ ...options, readPosts: () => { reads++; return []; } });
    assert.equal(res.statusCode, status); assert.equal(reads, 0);
  }
});

test('request limit enforced for known length, chunked input, and exact 4KiB boundary', async () => {
  const base = JSON.stringify(task()), exact = base + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(base));
  assert.equal((await request({ body: exact })).statusCode, 200);
  assert.equal((await request({ body: exact + ' ' })).statusCode, 413);
  assert.equal((await request({ chunks: [exact, ' '] })).statusCode, 413);
  assert.equal((await request({ headers: { 'content-length': '4097' } })).statusCode, 413);
});

test('malformed JSON and unallowed payload reject before reading storage', async () => {
  for (const body of ['{', JSON.stringify(task({ payload: { text: 'PRIVATE', publish: true } }))]) {
    let reads = 0;
    const res = await request({ body, readPosts: () => { reads++; return []; } });
    assert.equal(res.statusCode, 400); assert.equal(reads, 0);
    assert.doesNotMatch(res.raw, /PRIVATE|publish/);
  }
});

test('storage errors and corrupt entries return bounded sanitized failure, never zero', async () => {
  for (const readPosts of [() => { throw Error('PRIVATE-TOKEN and /private/posts.json'); }, () => null, () => [null]]) {
    const res = await request({ readPosts });
    assert.equal(res.statusCode, 503); assert.equal(res.body.status, 'failed');
    assert.equal(res.body.error.code, 'snapshot_unavailable');
    assert.equal(res.body.request_hash, sha256(task()));
    assert.equal(res.body.evidence, undefined);
    assert.doesNotMatch(res.raw, /PRIVATE|private\/posts|stack/);
  }
});

test('20-second total task limit cancels blocked asynchronous local read', { timeout: 25000 }, async () => {
  const started = Date.now();
  let signal;
  const res = await request({ readPosts: (options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal(res.statusCode, 504); assert.equal(res.body.error.code, 'task_timeout');
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started >= MAX_EXECUTION_MS - 100);
  assert.ok(Date.now() - started < MAX_EXECUTION_MS + 1500);
});

test('integration is additive; original public server and UI bytes remain unchanged', async () => {
  const source = await readFile(join(__dirname, '..', 'server.js'), 'utf8');
  const insertion = "const { createDirectorTaskHandler, readLocalPosts } = require('./director-tasks');\n";
  const mount = "// Dedicated read-only task inbox; leave the public API/UI behavior unchanged.\napp.use('/director/tasks', createDirectorTaskHandler({\n  token: process.env.DIRECTOR_TASK_TOKEN,\n  readPosts: (options) => readLocalPosts(POSTS_FILE, options),\n}));\n\n";
  assert.equal(source.split(insertion).length, 2); assert.equal(source.split(mount).length, 2);
  assert.ok(source.indexOf("app.use('/director/tasks'") < source.indexOf('app.use(express.json'));
  const baseline = source.replace(insertion, '').replace(mount, '');
  const gitHash = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
  assert.equal(gitHash(baseline), '8300b260a3023fde2a375d92c0db0e4b22c17dae');
  assert.equal(gitHash(await readFile(join(__dirname, '..', 'public', 'index.html'))), 'd5c1464c0396a3ca3a8df8863a3f32d476d53462');
});
