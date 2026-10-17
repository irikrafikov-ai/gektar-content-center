'use strict';
// Release-owned, import-safe contract. No writes, model SDK, public routes, or fallback.
const { createHash } = require('node:crypto');
const INPUT_SCHEMA = require('./text-draft-input.schema.json');
const MODEL_SCHEMA = require('./text-draft-model-output.schema.json');
const ARTIFACT_SCHEMA = require('./text-draft-artifact.schema.json');
const CORE_ORIGIN = 'https://zemfond-codex-core-production.up.railway.app';
const PILOT_ID = 'marketing-drafts-20261017-v1';
const PROMPT_VERSION = 'marketing-draft-v1';
const ARTIFACT_VERSION = 'marketing.text_draft.artifact.v1';
const KINDS = Object.freeze(['content.text_draft.prepare', 'avitolog.text_draft.prepare']);
const SOURCE_REFS = Object.freeze({ inventory: 'google.inventory.sb', project: 'github.kb.sb.location', cadastre: 'github.kb.sb.cadastre', source_text: 'release.sb.text_seed', calendar: 'content.local_posts.all_projects' });
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v);
const hashJson = v => createHash('sha256').update(canonical(v), 'utf8').digest('hex');
const hashText = v => createHash('sha256').update(v, 'utf8').digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/;
function utc(v) { return typeof v === 'string' && UTC.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 19) === v.slice(0, 19); }
function validateSchema(schema, value) {
  if (schema.anyOf) { if (!schema.anyOf.some(s => { try { validateSchema(s, value); return true; } catch { return false; } })) fail('draft_schema_invalid'); return; }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail('draft_schema_invalid');
  if (schema.enum && !schema.enum.includes(value)) fail('draft_schema_invalid');
  if (!schema.type) return;
  if (schema.type === 'null') { if (value !== null) fail('draft_schema_invalid'); return; }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('draft_schema_invalid');
    if ((schema.required || []).some(k => !Object.hasOwn(value, k)) || (schema.additionalProperties === false && Object.keys(value).some(k => !Object.hasOwn(schema.properties, k)))) fail('draft_schema_invalid');
    for (const [k, v] of Object.entries(value)) if (schema.properties[k]) validateSchema(schema.properties[k], v);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || Infinity)) fail('draft_schema_invalid');
    for (const v of value) validateSchema(schema.items, v);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.format === 'date-time' && !utc(value))) fail('draft_schema_invalid');
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('draft_schema_invalid');
  }
}
function safeSelectedText(text) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || /(?:https?:\/\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d ()-]{9,}\d|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|Bearer\s+\S+|api[_ -]?key\s*[:=]|password\s*[:=]|token\s*[:=]))/i.test(text)) fail('draft_selected_data_rejected');
}
function validateInput(input, { complete = false, production = false, now = input?.evaluated_at } = {}) {
  if (Buffer.byteLength(canonical(input) || '', 'utf8') > 48 * 1024) fail('draft_input_too_large');
  validateSchema(INPUT_SCHEMA, input);
  if (production && input.input_class !== 'real') fail('draft_real_input_required');
  const content = input.kind === KINDS[0];
  if (input.output.format !== (content ? 'content_posts' : 'avito_listing') || (!content && input.output.count !== 1) || ! /^[1-9]\d{0,2}$/.test(input.selection.plot_number)) fail('draft_intent_invalid');
  if (!utc(now) || Date.parse(input.evaluated_at) > Date.parse(now)) fail('draft_time_invalid');
  for (const [type, s] of Object.entries(input.snapshots)) {
    if (s === null) { if (complete && ['inventory', 'project', 'cadastre'].includes(type)) fail('draft_source_missing'); continue; }
    if (s.source_ref !== SOURCE_REFS[type] || s.sha256 !== hashJson(s.data) || Date.parse(now) - Date.parse(s.observed_at) > (type === 'inventory' ? 15 * 60 * 1000 : 24 * 60 * 60 * 1000) || s.data.project_id !== input.project_id || Date.parse(s.observed_at) > Date.parse(input.evaluated_at) || (s.source_modified_at !== null && Date.parse(s.source_modified_at) > Date.parse(s.observed_at))) fail('draft_source_binding_invalid');
    if (['inventory', 'cadastre', 'source_text'].includes(type) && s.data.plot_number !== input.selection.plot_number) fail('draft_plot_mismatch');
    for (const f of s.data.facts || []) { if (f.text !== f.quote) fail('draft_quote_mismatch'); safeSelectedText(f.text); }
    if (s.data.facts && new Set(s.data.facts.map(f => f.fact_id)).size !== s.data.facts.length) fail('draft_fact_duplicate');
    if (type === 'source_text') { safeSelectedText(s.data.title); safeSelectedText(s.data.text); }
  }
  const { inventory, cadastre } = input.snapshots;
  if (inventory && (Date.parse(now) - Date.parse(inventory.observed_at) > 15 * 60 * 1000 || !/^\d{1,3}(?:[.,]\d{1,4})?$/.test(inventory.data.area_raw) || !/^\d{1,9}(?:[.,]\d{1,2})?$/.test(inventory.data.price_raw))) fail('draft_inventory_invalid');
  if (cadastre && !/^\d{2}:\d{2}:\d{6,7}:\d{1,7}$/.test(cadastre.data.cadastral_number)) fail('draft_cadastre_mismatch');
  if (inventory && cadastre && Number(inventory.data.area_raw.replace(',', '.')) !== Number(cadastre.data.area_raw.replace(',', '.'))) fail('draft_cadastre_mismatch');
  return input;
}
function seedInput({ kind, plotNumber = '4', count = kind === KINDS[0] ? 2 : 1, audience = 'client', evaluatedAt, inputClass = 'real' }) {
  const input = { schema_version: 'text_draft.input.v1', kind, pilot_id: PILOT_ID, project_id: 'sb', input_class: inputClass, output: { format: kind === KINDS[0] ? 'content_posts' : 'avito_listing', count, audience }, selection: { plot_number: plotNumber }, evaluated_at: evaluatedAt, snapshots: Object.fromEntries(Object.keys(SOURCE_REFS).map(k => [k, null])) };
  return validateInput(input);
}
function sameIntent(seed, input) {
  validateInput(input);
  const intent = v => { const out = { ...v }; delete out.snapshots; delete out.evaluated_at; return out; };
  if (hashJson(intent(seed)) !== hashJson(intent(input))) fail('draft_intent_mismatch');
  for (const key of ['project', 'cadastre', 'source_text', 'calendar']) if (hashJson(seed.snapshots[key]) !== hashJson(input.snapshots[key])) fail('draft_static_source_changed');
}
function operationKey(taskId, inputHash) { return 'mdg_' + hashJson({ task_id: taskId, input_hash: inputHash, phase: 'generate', prompt_version: PROMPT_VERSION, schema_version: ARTIFACT_VERSION }); }
function draftConfiguration(env, agent) {
  if (env.MARKETING_DRAFTS_ENABLED !== 'true') return null;
  if (!['content', 'avitolog'].includes(agent)) fail('draft_configuration_invalid');
  const token = env[`${agent.toUpperCase()}_DRAFT_BACKEND_TOKEN`];
  const other = ['CONTENT_DRAFT_BACKEND_TOKEN', 'AVITOLOG_DRAFT_BACKEND_TOKEN', 'OPERATION_TASK_TOKEN', 'DIRECTOR_TASK_TOKEN', 'BACKEND_API_KEY', 'CORE_API_KEY', 'ADMIN_TOKEN', 'AVITOLOG_BACKEND_TOKEN', 'CODEX_BACKEND_TOKEN'].filter(k => k !== `${agent.toUpperCase()}_DRAFT_BACKEND_TOKEN`).map(k => env[k]).filter(Boolean);
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token) || other.includes(token)) fail('draft_configuration_invalid');
  return Object.freeze({ token, purpose: `${agent}.internal_draft` });
}
async function responseJson(response) {
  if (!response || response.redirected || (response.status !== 429 && (response.status < 200 || response.status >= 300)) || !/^application\/json(?:;|$)/i.test(response.headers?.get('content-type') || '')) fail('draft_inference_unconfirmed');
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > 1024 * 1024)) fail('draft_inference_response_too_large');
  if (!response.body?.getReader) fail('draft_inference_unconfirmed');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); fail('draft_inference_response_too_large'); } chunks.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
  let body; try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); } catch { fail('draft_inference_unconfirmed'); }
  if (response.status === 429) { if (exact(body, ['status','error']) && body.status === 'not_started' && exact(body.error, ['code']) && body.error.code === 'busy_before_inference') fail('draft_busy_not_started'); fail('draft_inference_unconfirmed'); }
  return body;
}
function createDraftInference(config, fetchImpl = globalThis.fetch) {
  if (!config || !['content.internal_draft', 'avitolog.internal_draft'].includes(config.purpose) || typeof config.token !== 'string') fail('draft_configuration_invalid');
  return async function infer(body) {
    if (!exact(body, ['purpose','operation_key','task_id','request_hash','input_hash','phase','lease_id']) || body.purpose !== config.purpose || body.phase !== 'generate' || body.operation_key !== operationKey(body.task_id, body.input_hash) || !/^ot_[a-f0-9]{64}$/.test(body.task_id) || !/^[a-f0-9]{64}$/.test(body.request_hash) || !/^[a-f0-9]{64}$/.test(body.input_hash) || !/^[A-Za-z0-9_-]{43}$/.test(body.lease_id)) fail('draft_inference_request_invalid');
    const controller = new AbortController(); let timer;
    try { return await Promise.race([
      (async () => responseJson(await fetchImpl(CORE_ORIGIN + '/v1/infer', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: controller.signal })))(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('draft_inference_unknown'), {code:'draft_inference_unknown'})); }, 200000); timer.unref?.(); })
    ]); } catch (e) { if (e?.code) throw e; fail('draft_inference_unknown'); } finally { clearTimeout(timer); }
  };
}
function validateArtifact(artifact, input, task, requestHash) {
  validateSchema(ARTIFACT_SCHEMA, artifact);
  const inputHash = hashJson(input), purpose = task.agent + '.internal_draft', p = artifact.provenance;
  if (artifact.kind !== task.kind || artifact.kind !== input.kind || artifact.input_hash !== inputHash || artifact.items.length !== input.output.count || p.task_id !== task.task_id || p.request_hash !== requestHash || p.input_hash !== inputHash || p.purpose !== purpose || p.operation_key !== operationKey(task.task_id, inputHash) || p.schema_hash !== hashJson(MODEL_SCHEMA) || hashJson(artifact.financial_source_strings) !== hashJson([input.snapshots.inventory.data.price_raw])) fail('draft_artifact_binding_invalid');
  if (p.output_hash !== hashJson({ items: artifact.items, uncertainties: artifact.uncertainties, excluded_claims: artifact.excluded_claims })) fail('draft_output_hash_invalid');
  if (task.agent === 'avitolog' && artifact.items.some(i => i.title.length > 50 || i.body.length < 500)) fail('draft_copy_incomplete');
  for (const item of artifact.items) {
    const copy = item.title + '\n' + item.body;
    if (copy.includes(input.snapshots.inventory.data.price_raw) || /(?:цен[аыуе]|стоимост|\d\s*(?:₽|руб)|скидк|рассроч|ипотек|доходност|окупаем|без\s+переплат|инвестиц)/i.test(copy)) fail('draft_financial_claim_forbidden');
    for (const claim of item.claims) {
      const type = Object.keys(SOURCE_REFS).find(key => SOURCE_REFS[key] === claim.source_id), source = input.snapshots[type];
      if (!source || !copy.includes(claim.text)) fail('draft_claim_mismatch');
      let quote;
      if (type === 'inventory') { if (!['plot_number','status_raw','area_raw'].includes(claim.fact_id)) fail('draft_claim_mismatch'); quote = source.data[claim.fact_id]; }
      else { const matches = source.data.facts.filter(f => f.fact_id === claim.fact_id); if (matches.length !== 1) fail('draft_claim_mismatch'); quote = matches[0].quote; }
      if (quote !== claim.quote) fail('draft_claim_mismatch');
    }
  }
  if (new Set(artifact.items.map(i => i.id)).size !== artifact.items.length) fail('draft_item_duplicate');
  return artifact;
}
async function processDraftClaim({ claim, request, infer, materialize, now = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const task = claim.task;
  validateInput(task.payload, { production: true, now: now() });
  if (task.kind !== task.payload.kind || task.work.acceptance !== task.kind + '.v1') fail('draft_task_invalid');
  if (typeof infer !== 'function' || typeof materialize !== 'function') fail('draft_disabled');
  if (Date.parse(claim.lease_until) - Date.parse(now()) < 205000) fail('draft_lease_insufficient');
  const base = `/operations/tasks/${task.task_id}`;
  const state = await request('GET', base);
  if (state.request_hash !== claim.request_hash || hashJson(state.task) !== hashJson(task)) fail('draft_task_binding_invalid');
  let input = state.input;
  if (input != null) { sameIntent(task.payload, input); if (state.input_hash !== hashJson(input)) fail('draft_input_hash_invalid'); }
  else input = await materialize(task.payload, { observedAt: now() });
  sameIntent(task.payload, input); validateInput(input, { complete: true, production: true, now: now() });
  const inputHash = hashJson(input);
  let frozen;
  try { frozen = await request('POST', base + '/input', { lease_id: claim.lease_id, request_hash: claim.request_hash, input }); }
  catch { const check = await request('GET', base); if (check.request_hash !== claim.request_hash || check.input_hash !== inputHash || check.status !== 'running' || hashJson(check.input) !== inputHash) fail('draft_input_unconfirmed'); frozen = {task_id:task.task_id,request_hash:check.request_hash,input_hash:check.input_hash,status:'running'}; }
  if (!exact(frozen,['task_id','request_hash','input_hash','status']) || frozen.task_id !== task.task_id || frozen.request_hash !== claim.request_hash || frozen.input_hash !== inputHash || frozen.status !== 'running') fail('draft_input_unconfirmed');
  if (Date.parse(claim.lease_until) - Date.parse(now()) < 205000 || Date.parse(task.deadline) - Date.parse(now()) < 205000) fail('draft_lease_insufficient');
  // Exactly one request. Uncertain inference is held by core; never regenerate here.
  const inferenceBody = { purpose: task.agent + '.internal_draft', operation_key: operationKey(task.task_id,inputHash), task_id:task.task_id,request_hash:claim.request_hash,input_hash:inputHash,phase:'generate',lease_id:claim.lease_id };
  let result, busyRetries = 0;
  while (true) {
    try { result = await infer(inferenceBody); break; }
    catch (error) {
      // Only this exact authoritative pre-execution refusal proves no attempt.
      // Unknown, timeouts, generic rate limits and other errors are never retried.
      if (error?.code !== 'draft_busy_not_started') throw error;
      if (busyRetries >= 12) fail('draft_busy_retry_limit');
      busyRetries += 1;
      if (Math.min(Date.parse(claim.lease_until), Date.parse(task.deadline)) - Date.parse(now()) < 210000) fail('draft_lease_insufficient');
      await sleep(5000);
      if (Math.min(Date.parse(claim.lease_until), Date.parse(task.deadline)) - Date.parse(now()) < 205000) fail('draft_lease_insufficient');
    }
  }
  if (result?.status !== 'completed') fail('draft_inference_unconfirmed');
  const artifact = validateArtifact(result.json,input,task,claim.request_hash), artifactHash = hashJson(artifact);
  let ack;
  try { ack = await request('POST',base+'/result',{lease_id:claim.lease_id,request_hash:claim.request_hash,input_hash:inputHash,status:'submitted',artifact}); }
  catch { const check = await request('GET',base); if (check.request_hash !== claim.request_hash || check.input_hash !== inputHash || !check.artifact || hashJson(check.artifact) !== artifactHash || !['submitted','completed','rejected'].includes(check.status)) fail('draft_result_unconfirmed'); ack={task_id:task.task_id,request_hash:check.request_hash,input_hash:inputHash,status:check.status,artifact_hash:artifactHash}; }
  if (!exact(ack,['task_id','request_hash','input_hash','status','artifact_hash']) || ack.task_id!==task.task_id || ack.request_hash!==claim.request_hash || ack.input_hash!==inputHash || ack.artifact_hash!==artifactHash || !['submitted','completed','rejected'].includes(ack.status)) fail('draft_result_unconfirmed');
  return { outcome:ack.status,state:ack.status,task_id:task.task_id,input_hash:inputHash,artifact_hash:artifactHash,preparation_status:'generated' };
}
module.exports = { INPUT_SCHEMA,MODEL_SCHEMA,ARTIFACT_SCHEMA,CORE_ORIGIN,PILOT_ID,PROMPT_VERSION,ARTIFACT_VERSION,KINDS,SOURCE_REFS,hashJson,hashText,validateSchema,validateInput,seedInput,sameIntent,operationKey,draftConfiguration,createDraftInference,validateArtifact,processDraftClaim,safeSelectedText };
