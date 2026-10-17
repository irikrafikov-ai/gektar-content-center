'use strict';
// Synthetic transport and storage fixtures only. Never contacts a real core or
// presents the test calendar as a business observation. Pinned KB facts are real.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os'); const { join } = require('node:path');
const { hashJson, prepareEditorial, evidenceHash } = require('../work-preparation/editorial');
const { readCalendarFile, materializeEditorialInput, buildCalendarSnapshot } = require('../work-preparation/source-loader');
const { coreOrigin, operationConfig, createCoreTransport, validateClaim, processContentOperation, startContentOperationWorker } = require('../work-preparation/operation-worker');
const PINNED = require('../work-preparation/pinned-project-facts.json');
const NOW = '2026-10-17T10:00:00.000Z', TOKEN = 'SYNTHETIC-OPERATION-ONLY-TOKEN-000000000000';
const clock = () => NOW;
function seed() { return { schema_version: 'content.editorial.prepare.v1', kind: 'content.editorial.prepare', input_class: 'real', project_id: 'sb', objective: { goal: 'education', instruction: 'Explain the source-qualified infrastructure and location facts for internal review.' }, audience: 'client', planning_window: { starts_at: '2026-10-18T00:00:00.000Z', ends_at: '2026-10-21T00:00:00.000Z' }, cadence: { weekdays: [1, 2, 3, 4, 5, 6, 7], time_utc: '10:00', max_slots: 2, minimum_gap_hours: 24 }, evaluated_at: NOW, snapshots: { project_facts: null, calendar: null } }; }
function task(payload = seed()) {
  const identity = { plan_id: 'op_' + '0'.repeat(64), agent: 'content', kind: 'content.editorial.prepare', created_at: NOW, deadline: '2026-10-17T11:00:00.000Z', parent_task_id: null, work: { objective: 'SYNTHETIC internal transport test only', priority: 'normal', dependencies: [], acceptance: 'content.editorial.prepare.v1' }, payload };
  const id = `ot_${hashJson(identity)}`; return { protocol: 1, task_id: id, idempotency_key: id, ...identity };
}
function mockCore({ frozen = null, uncertainInput = false, uncertainResult = false, persistInput = true, persistResult = true } = {}) {
  const t = task(), requestHash = hashJson(t), calls = [];
  const state = { task: t, request_hash: requestHash, status: 'accepted', input: frozen, input_hash: frozen ? hashJson(frozen) : null, artifact: null };
  const claim = { task: t, request_hash: requestHash, lease_id: 'a'.repeat(43), lease_until: '2026-10-17T10:02:00.000Z', accepted_at: NOW };
  return { calls, state, claim, async request(method, path, body) {
    calls.push({ method, path, body });
    if (path === '/operations/tasks/claim') return claim;
    if (method === 'GET') return JSON.parse(JSON.stringify(state));
    if (path.endsWith('/input')) {
      if (persistInput) Object.assign(state, { input: body.input, input_hash: hashJson(body.input), status: 'running' });
      if (uncertainInput) throw Error('SYNTHETIC timeout');
      return { task_id: t.task_id, request_hash: requestHash, input_hash: state.input_hash, status: 'running' };
    }
    if (path.endsWith('/result')) {
      assert(state.input, 'must freeze before preparing');
      if (persistResult) Object.assign(state, { artifact: body.artifact, status: body.status });
      if (uncertainResult) throw Error('SYNTHETIC timeout');
      return { task_id: t.task_id, request_hash: requestHash, input_hash: state.input_hash, status: state.status, artifact_hash: hashJson(body.artifact) };
    }
    throw Error('unexpected mock route');
  } };
}
const syntheticCalendar = () => ({ posts: [], revision: 'a'.repeat(64) });

test('pinned source facts are explicitly dated and content-addressed, not current availability or prices', () => {
  assert.equal(PINNED.revision, '4d3b612413f4483529d6af01dabe157dba007993'); assert.equal(evidenceHash(PINNED), PINNED.evidence_hash);
  assert.equal(PINNED.data.facts.length, 3); assert(PINNED.data.facts[0].statement.includes('по границам нашего посёлка согласованы'));
  assert.doesNotMatch(JSON.stringify(PINNED.data.facts), /свободн|скидк|цена|₽/i);
});

test('production loader uses actual pinned facts and captured calendar, never mutates seed or fabricates assets', async () => {
  const s = seed(), before = JSON.stringify(s); const input = await materializeEditorialInput(s, { readCalendar: syntheticCalendar, observedAt: NOW });
  assert.equal(JSON.stringify(s), before); assert.equal(input.snapshots.calendar.revision, 'a'.repeat(64));
  assert.equal(input.snapshots.project_facts.evidence_hash, PINNED.evidence_hash);
  const a = prepareEditorial(input); assert.equal(a.status, 'ready_for_review'); assert(a.slots.every(x => x.missing_assets.length)); assert.equal(a.publication_authorized, false);
});

test('unavailable calendar, unsupported project, and old source capture remain explicit blockers', async () => {
  const missing = await materializeEditorialInput(seed(), { readCalendar: () => { throw Error('missing'); }, observedAt: NOW });
  assert.equal(prepareEditorial(missing).status, 'blocked_missing_input'); assert.equal(missing.snapshots.calendar, null);
  const s = seed(); s.project_id = 'sd'; const other = await materializeEditorialInput(s, { readCalendar: syntheticCalendar, observedAt: NOW });
  assert.equal(other.snapshots.project_facts, null); assert.equal(prepareEditorial(other).status, 'blocked_missing_input');
  const expired = seed(); expired.planning_window = { starts_at: '2026-10-25T00:00:00.000Z', ends_at: '2026-10-26T00:00:00.000Z' };
  const old = await materializeEditorialInput(expired, { readCalendar: syntheticCalendar, observedAt: '2026-10-24T10:00:00.000Z' });
  assert.equal(prepareEditorial(old).status, 'blocked_stale_input'); assert.equal(old.snapshots.project_facts.observed_at, PINNED.observed_at);
});

test('calendar snapshot conservatively includes every project sharing audience and blocks malformed occupied slots', () => {
  const s = seed(); s.snapshots.project_facts = PINNED;
  const input = { posts: [{ id: 3, date: '2026-10-18T10:00:00Z', aud: 'client', scheduled: true, published: false, text: PINNED.data.facts[0].statement }, { id: 4, date: null, aud: 'client', scheduled: false, published: false }], revision: 'b'.repeat(64) };
  const a = buildCalendarSnapshot(input, s, NOW); assert.equal(a.data.entries.length, 1); assert.equal(a.data.entries[0].topic_id, 'sb-utilities');
  assert.equal(a.source_ref, 'content.local_posts.all_projects');
  for (const change of [{ date: null }, { aud: 'unknown' }, { scheduled: 'true' }]) {
    const bad = structuredClone(input); Object.assign(bad.posts[0], change); assert.throws(() => buildCalendarSnapshot(bad, s, NOW));
  }
});

test('source file reader is bounded and read-only; corrupt or absent files do not become empty calendars', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'content-source-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic-posts.json'); await assert.rejects(readCalendarFile(path));
  await writeFile(path, '[ ]\n'); const result = await readCalendarFile(path); assert.deepEqual(result.posts, []); assert.equal((await readFile(path, 'utf8')), '[ ]\n');
  await writeFile(path, '{corrupt'); await assert.rejects(readCalendarFile(path));
  await writeFile(path, '{}'); await assert.rejects(readCalendarFile(path));
});

test('both activation flags and distinct operation credentials are required; only configured trusted core origin allowed', () => {
  assert.equal(operationConfig({}), null); assert.equal(operationConfig({ OPERATION_ENABLED: 'true' }), null);
  const env = { OPERATION_ENABLED: 'true', OPERATION_TASKS_ENABLED: 'true', OPERATION_TASK_TOKEN: TOKEN, OPERATION_CORE_URL: 'https://zemfond-codex-core-production.up.railway.app' };
  assert.equal(operationConfig(env).token, TOKEN);
  assert.throws(() => operationConfig({ ...env, DIRECTOR_TASK_TOKEN: TOKEN }));
  for (const url of ['https://example.invalid', 'https://synthetic.up.railway.app/steal', 'https://user:pass@synthetic.up.railway.app', 'file:///etc/passwd', 'http://localhost:1234', 'https://synthetic.up.railway.app?token=x']) assert.throws(() => coreOrigin(url));
  assert.throws(() => coreOrigin('http://core.railway.internal:8081')); assert.throws(() => coreOrigin('https://another-tenant.up.railway.app'));
});

test('worker freezes input before execution and submits substantive artifact, not a success flag', async () => {
  const core = mockCore(); const result = await processContentOperation({ request: core.request, readCalendar: syntheticCalendar, now: clock });
  assert.equal(result.outcome, 'submitted'); assert.equal(core.state.artifact.slots.length, 2);
  assert.deepEqual(core.calls.map(c => c.method + ' ' + c.path.split('/').at(-1)), ['POST claim', `GET ${core.state.task.task_id}`, 'POST input', 'POST result']);
  assert.equal(result.artifact_hash, hashJson(core.state.artifact)); assert.equal(core.state.artifact.publication_authorized, false);
});

test('missing real source produces a durable blocked artifact with explicit checklist', async () => {
  const core = mockCore(); const result = await processContentOperation({ request: core.request, readCalendar: () => { throw Error('missing source'); }, now: clock });
  assert.equal(result.outcome, 'blocked'); assert(core.state.artifact.blockers.some(b => b.source_role === 'calendar')); assert.equal(core.state.artifact.slots.length, 0);
});

test('reclaimed pure task reuses the core-frozen input without re-reading live storage', async () => {
  const frozen = await materializeEditorialInput(seed(), { readCalendar: syntheticCalendar, observedAt: NOW }); const core = mockCore({ frozen });
  await processContentOperation({ request: core.request, readCalendar: () => { throw Error('must not read'); }, now: clock });
  assert.equal(core.calls.filter(c => c.path.endsWith('/input')).length, 1); assert.equal(core.state.artifact.request_hash, hashJson(frozen));
});

test('uncertain input write must be read back before preparation and never blindly retried', async () => {
  const core = mockCore({ uncertainInput: true }); assert.equal((await processContentOperation({ request: core.request, readCalendar: syntheticCalendar, now: clock })).outcome, 'submitted');
  assert.equal(core.calls.filter(c => c.path.endsWith('/input')).length, 1);
  const lost = mockCore({ uncertainInput: true, persistInput: false });
  await assert.rejects(processContentOperation({ request: lost.request, readCalendar: syntheticCalendar, now: clock }), { code: 'operation_input_unconfirmed' });
  assert.equal(lost.calls.filter(c => c.path.endsWith('/result')).length, 0);
});

test('uncertain result write is reconciled, never treated as failure-to-execute or blindly resubmitted', async () => {
  const core = mockCore({ uncertainResult: true }); assert.equal((await processContentOperation({ request: core.request, readCalendar: syntheticCalendar, now: clock })).outcome, 'submitted');
  assert.equal(core.calls.filter(c => c.path.endsWith('/result')).length, 1);
  const lost = mockCore({ uncertainResult: true, persistResult: false });
  await assert.rejects(processContentOperation({ request: lost.request, readCalendar: syntheticCalendar, now: clock }), { code: 'operation_result_unconfirmed' });
});

test('foreign role, changed task bytes, expired leases and changed immutable intent reject', async () => {
  for (const edit of [c => { c.task.agent = 'avitolog'; }, c => { c.task.payload.objective.instruction = 'changed'; }, c => { c.lease_until = NOW; }, c => { c.task.work.acceptance = 'publish'; }]) {
    const c = mockCore().claim; edit(c); assert.throws(() => validateClaim(c, NOW));
  }
  const frozen = await materializeEditorialInput(seed(), { readCalendar: syntheticCalendar, observedAt: NOW }); frozen.objective.instruction = 'Changed immutable objective';
  const core = mockCore({ frozen }); await assert.rejects(processContentOperation({ request: core.request, readCalendar: syntheticCalendar, now: clock }), { code: 'operation_intent_mismatch' });
});

test('transport fixes core destination, disallows redirects and bounds response bytes without network', async () => {
  const calls = [];
  const request = createCoreTransport({ origin: 'https://zemfond-codex-core-production.up.railway.app', token: TOKEN }, async (url, options) => { calls.push({ url, options }); return new Response('{"task":null}', { status: 200 }); });
  assert.deepEqual(await request('POST', '/operations/tasks/claim', {}), { task: null });
  assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].options.headers['X-Operation-Token'], TOKEN); assert.equal(calls[0].options.headers.Authorization, undefined);
  await assert.rejects(request('POST', 'https://example.invalid/steal', {}));
  const huge = createCoreTransport({ origin: 'https://zemfond-codex-core-production.up.railway.app', token: TOKEN }, async () => new Response('x', { headers: { 'content-length': '1048577' } }));
  await assert.rejects(huge('POST', '/operations/tasks/claim', {}), { code: 'operation_response_too_large' });
});

test('disabled worker has no startup effects; active ticks are process-locally single-flight', async () => {
  let calls = 0, release;
  const disabled = startContentOperationWorker({ env: {}, fetchImpl: () => { calls++; } }); assert.equal(disabled.enabled, false); assert.equal(calls, 0);
  const pending = new Promise(r => { release = r; });
  const worker = startContentOperationWorker({ env: { OPERATION_ENABLED: 'true', OPERATION_TASKS_ENABLED: 'true', OPERATION_TASK_TOKEN: TOKEN, OPERATION_CORE_URL: 'https://zemfond-codex-core-production.up.railway.app' }, readCalendar: syntheticCalendar, now: clock,
    fetchImpl: async () => { calls++; await pending; return new Response('{"task":null}'); } });
  await worker.tick(); assert.equal(calls, 1); worker.stop(); release(); await new Promise(r => setImmediate(r));
});

test('wire accepts canonical Python UTC microseconds without changing hashed task bytes', () => { const c = mockCore().claim; c.accepted_at = '2026-10-17T10:00:00.000000+00:00'; c.lease_until = '2026-10-17T10:02:00.123456+00:00'; assert.equal(validateClaim(c, NOW).agent, 'content'); });
