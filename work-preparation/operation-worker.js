'use strict';
const { hashJson, validateEditorialRequest, prepareEditorial, validateEditorialArtifact } = require('./editorial');
const { materializeEditorialInput } = require('./source-loader');
const draftContract = require('./text-draft.cjs');
const { materializeTextDraftInput } = require('./text-draft-sources.cjs');
const MAX_WIRE_BYTES = 1024 * 1024;
const TASK_KEYS = ['protocol', 'task_id', 'idempotency_key', 'plan_id', 'work', 'agent', 'kind', 'created_at', 'deadline', 'parent_task_id', 'payload'];
const resultStatusAllowed = (actual, expected) => actual === expected || (expected === 'submitted' && ['completed', 'rejected'].includes(actual));
function fail(code) { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('invalid_operation_envelope');
}
function instant(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00:00)$/.exec(value);
  if (!match) fail('invalid_operation_time');
  const normalized = match[1] + '.' + (match[2] || '').padEnd(3, '0').slice(0, 3) + 'Z';
  if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) fail('invalid_operation_time');
  return Date.parse(normalized);
}
function coreOrigin(value) {
  let url; try { url = new URL(value); } catch { fail('invalid_operation_configuration'); }
  const allowed = url.origin === 'https://zemfond-codex-core-production.up.railway.app';
  if (!allowed || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) fail('invalid_operation_configuration');
  return url.origin;
}
function operationConfig(env) {
  if (env.OPERATION_ENABLED !== 'true' || env.OPERATION_TASKS_ENABLED !== 'true') return null;
  const token = env.OPERATION_TASK_TOKEN;
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token) ||
      [env.DIRECTOR_TASK_TOKEN, env.BACKEND_API_KEY, env.CORE_API_KEY].filter(Boolean).includes(token)) fail('invalid_operation_configuration');
  return { origin: coreOrigin(env.OPERATION_CORE_URL), token };
}
async function boundedResponse(response) {
  const length = response.headers?.get('content-length');
  if (length && (!/^\d+$/.test(length) || +length > MAX_WIRE_BYTES)) fail('operation_response_too_large');
  if (!response.body || typeof response.body.getReader !== 'function') fail('invalid_operation_response');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > MAX_WIRE_BYTES) { await reader.cancel(); fail('operation_response_too_large'); } chunks.push(Buffer.from(value)); }
  } finally { reader.releaseLock(); }
  let body; try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail('invalid_operation_response'); }
  if (!response.ok) fail(`operation_http_${response.status}`);
  return body;
}
function createCoreTransport(config, fetchImpl = globalThis.fetch) {
  const origin = coreOrigin(config.origin);
  return async function request(method, pathname, body) {
    if (!['GET', 'POST'].includes(method) || !/^\/operations\/tasks(?:\/claim|\/ot_[a-f0-9]{64}(?:\/(?:input|result))?)?$/.test(pathname)) fail('invalid_operation_target');
    const raw = body === undefined ? undefined : JSON.stringify(body);
    if (raw && Buffer.byteLength(raw, 'utf8') > MAX_WIRE_BYTES) fail('operation_request_too_large');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000); timer.unref?.();
    try {
      const response = await fetchImpl(origin + pathname, { method, headers: { 'X-Operation-Token': config.token, 'Content-Type': 'application/json', Accept: 'application/json' }, body: raw, redirect: 'error', signal: controller.signal });
      return await boundedResponse(response);
    } catch (error) {
      if (error?.code && /^operation_|^invalid_operation/.test(error.code)) throw error;
      fail('operation_transport_unknown');
    } finally { clearTimeout(timer); }
  };
}
function validateClaim(claim, observedAt) {
  if (claim?.task === null) { exact(claim, ['task']); return null; }
  exact(claim, ['task', 'request_hash', 'lease_id', 'lease_until', 'accepted_at']);
  const task = claim.task;
  exact(task, TASK_KEYS);
  if (task.protocol !== 1 || task.agent !== 'content' || !['content.editorial.prepare', 'content.text_draft.prepare'].includes(task.kind) || !/^ot_[a-f0-9]{64}$/.test(task.task_id) || task.idempotency_key !== task.task_id) fail('invalid_operation_task');
  if (!/^op_[a-f0-9]{64}$/.test(task.plan_id)) fail('invalid_operation_task');
  exact(task.work, ['objective', 'priority', 'dependencies', 'acceptance']);
  if (task.work.acceptance !== `${task.kind}.v1` || typeof task.work.objective !== 'string' || !task.work.objective.trim() || task.work.objective.length > 1000 || /[\u0000-\u001f]/.test(task.work.objective) || !['critical', 'high', 'normal', 'low'].includes(task.work.priority) || !Array.isArray(task.work.dependencies) || task.work.dependencies.length > 20 || task.work.dependencies.some(id => !/^ot_[a-f0-9]{64}$/.test(id) || id === task.task_id) || new Set(task.work.dependencies).size !== task.work.dependencies.length) fail('invalid_operation_task');
  const identity = { plan_id: task.plan_id, work: task.work, agent: task.agent, kind: task.kind, created_at: task.created_at, deadline: task.deadline, parent_task_id: task.parent_task_id, payload: task.payload };
  if (task.task_id !== `ot_${hashJson(identity)}` || claim.request_hash !== hashJson(task)) fail('operation_hash_mismatch');
  if (task.parent_task_id !== null && !/^ot_[a-f0-9]{64}$/.test(task.parent_task_id)) fail('invalid_operation_task');
  if (instant(task.created_at) > instant(observedAt) || instant(task.deadline) <= instant(observedAt) || instant(claim.lease_until) <= instant(observedAt) || instant(claim.accepted_at) > instant(observedAt)) fail('operation_lease_expired');
  if (typeof claim.lease_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claim.lease_id)) fail('invalid_operation_lease');
  if (task.kind === 'content.text_draft.prepare') draftContract.validateInput(task.payload, { production: true, now: observedAt });
  else validateEditorialRequest(task.payload);
  if (task.payload.input_class !== 'real') fail('production_worker_requires_real_input');
  return task;
}
function sameIntent(seed, input) {
  validateEditorialRequest(input);
  const clean = value => { const copy = { ...value }; delete copy.snapshots; delete copy.evaluated_at; return copy; };
  if (hashJson(clean(seed)) !== hashJson(clean(input))) fail('operation_intent_mismatch');
}
async function processContentOperation({ request, readCalendar, now = () => new Date().toISOString(), projectFacts, draft }) {
  const claim = await request('POST', '/operations/tasks/claim', {});
  const task = validateClaim(claim, now());
  if (!task) return { outcome: 'idle' };
  if (task.kind === 'content.text_draft.prepare') return draftContract.processDraftClaim({ claim, request, now, ...draft });
  const base = `/operations/tasks/${task.task_id}`;
  const state = await request('GET', base);
  if (state.request_hash !== claim.request_hash || hashJson(state.task) !== hashJson(task)) fail('operation_hash_mismatch');
  let input = state.input;
  if (input !== null && input !== undefined) {
    sameIntent(task.payload, input);
    if (state.input_hash !== hashJson(input)) fail('operation_hash_mismatch');
  } else {
    input = await materializeEditorialInput(task.payload, { readCalendar, observedAt: now(), ...(projectFacts === undefined ? {} : { projectFacts }) });
    sameIntent(task.payload, input);
  }
  {
    // Rebind even an existing frozen input to the current accepted lease.
    const inputHash = hashJson(input);
    let frozen;
    try { frozen = await request('POST', `${base}/input`, { lease_id: claim.lease_id, request_hash: claim.request_hash, input }); }
    catch {
      // An uncertain write never proves it froze. Read back the immutable input.
      const check = await request('GET', base);
      if (check.request_hash !== claim.request_hash || check.input_hash !== inputHash || check.status !== 'running' || !check.input || hashJson(check.input) !== inputHash) fail('operation_input_unconfirmed');
      frozen = { task_id: task.task_id, request_hash: check.request_hash, input_hash: check.input_hash, status: 'running' };
    }
    exact(frozen, ['task_id', 'request_hash', 'input_hash', 'status']);
    if (frozen.task_id !== task.task_id || frozen.request_hash !== claim.request_hash || frozen.input_hash !== inputHash || frozen.status !== 'running') fail('operation_input_unconfirmed');
  }
  if (Date.parse(now()) >= instant(claim.lease_until)) fail('operation_lease_expired');
  const artifact = prepareEditorial(input); validateEditorialArtifact(artifact, input);
  const inputHash = hashJson(input), artifactHash = hashJson(artifact), status = artifact.status === 'ready_for_review' ? 'submitted' : 'blocked';
  let stored;
  try { stored = await request('POST', `${base}/result`, { lease_id: claim.lease_id, request_hash: claim.request_hash, input_hash: inputHash, status, artifact }); }
  catch {
    const check = await request('GET', base);
    if (check.request_hash !== claim.request_hash || check.input_hash !== inputHash || !check.artifact || hashJson(check.artifact) !== artifactHash || !resultStatusAllowed(check.status, status)) fail('operation_result_unconfirmed');
    stored = { task_id: task.task_id, request_hash: check.request_hash, input_hash: check.input_hash, status: check.status, artifact_hash: artifactHash };
  }
  exact(stored, ['task_id', 'request_hash', 'input_hash', 'status', 'artifact_hash']);
  if (stored.task_id !== task.task_id || stored.request_hash !== claim.request_hash || stored.input_hash !== inputHash || stored.artifact_hash !== artifactHash || !resultStatusAllowed(stored.status, status)) fail('operation_result_unconfirmed');
  return { outcome: stored.status, task_id: task.task_id, input_hash: inputHash, artifact_hash: artifactHash, preparation_status: artifact.status };
}
function startContentOperationWorker({ env = process.env, readCalendar, fetchImpl = globalThis.fetch, now, log = () => {}, intervalMs = 60000, projectFacts, draftMaterialize } = {}) {
  let config;
  try { config = operationConfig(env); } catch (error) { log({ code: error.code }); return { enabled: false, stop() {} }; }
  if (!config) return { enabled: false, stop() {} };
  if (typeof readCalendar !== 'function' || !Number.isInteger(intervalMs) || intervalMs < 1000) fail('invalid_operation_configuration');
  let draft;
  try { const c = draftContract.draftConfiguration(env, 'content'); if (c) draft = { infer: draftContract.createDraftInference(c, fetchImpl), materialize: draftMaterialize || ((seed, options) => materializeTextDraftInput(seed, { ...options, fetchImpl })) }; }
  catch { log({ code: 'draft_configuration_invalid' }); }
  const request = createCoreTransport(config, fetchImpl); let active = false, stopped = false;
  async function tick() {
    if (stopped || active) return; active = true;
    try { const outcome = await processContentOperation({ request, readCalendar, now, projectFacts, draft }); if (outcome.outcome !== 'idle') log(outcome); }
    catch (error) { log({ code: /^operation_|^invalid_operation|^production_worker|^draft_/.test(error?.code || '') ? error.code : 'operation_preparation_blocked' }); }
    finally { active = false; }
  }
  const timer = setInterval(tick, intervalMs); timer.unref?.(); void tick();
  return { enabled: true, tick, stop() { stopped = true; clearInterval(timer); } };
}
module.exports = { MAX_WIRE_BYTES, coreOrigin, operationConfig, createCoreTransport, validateClaim, processContentOperation, startContentOperationWorker };
