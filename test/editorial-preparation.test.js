'use strict';
// All business values below are synthetic test fixtures, not project facts.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { CONTRACT, prepareEditorial, evidenceHash, hashJson, validateEditorialRequest, validateEditorialArtifact } = require('../work-preparation/editorial');
const NOW = '2026-10-17T08:00:00.000Z';
function sign(s) { return { ...s, evidence_hash: evidenceHash(s) }; }
function fixture() {
  return {
    schema_version: CONTRACT, kind: 'content.editorial.prepare', input_class: 'synthetic_test', project_id: 'synthetic-project',
    objective: { goal: 'education', instruction: 'Explain only the supplied synthetic project facts.' }, audience: 'client',
    planning_window: { starts_at: '2026-10-18T00:00:00.000Z', ends_at: '2026-10-22T00:00:00.000Z' },
    cadence: { weekdays: [1, 2, 3, 4, 5, 6, 7], time_utc: '10:00', max_slots: 3, minimum_gap_hours: 24 }, evaluated_at: NOW,
    snapshots: {
      project_facts: sign({ source_ref: 'synthetic.project-facts', revision: 'synthetic-r1', evidence_class: 'synthetic_test', observed_at: NOW, valid_until: '2026-10-18T08:00:00.000Z',
        data: { project_id: 'synthetic-project', facts: [
          { fact_id: 'synthetic-fact-1', topic_id: 'synthetic-topic-1', topic_title: 'Synthetic map explanation', statement: 'Synthetic project map revision 4 shows the northern entrance.',
            source_record_id: 'synthetic-record-1', audiences: ['client', 'partner'], valid_from: '2026-10-01T00:00:00.000Z', valid_until: '2026-10-31T00:00:00.000Z', required_asset_kinds: ['map'] },
          { fact_id: 'synthetic-fact-2', topic_id: 'synthetic-topic-2', topic_title: 'Synthetic project photograph', statement: 'Synthetic photograph record was captured on 15 October.',
            source_record_id: 'synthetic-record-2', audiences: ['client'], valid_from: '2026-10-01T00:00:00.000Z', valid_until: '2026-10-31T00:00:00.000Z', required_asset_kinds: ['project_photo'] },
        ], assets: [{ asset_id: 'synthetic-map-1', kind: 'map', related_fact_ids: ['synthetic-fact-1'], rights_status: 'approved' }] } }),
      calendar: sign({ source_ref: 'synthetic.calendar', revision: 'synthetic-r7', evidence_class: 'synthetic_test', observed_at: NOW, valid_until: '2026-10-18T08:00:00.000Z',
        data: { project_id: 'synthetic-project', coverage_start: '2026-10-11T00:00:00.000Z', coverage_end: '2026-10-29T00:00:00.000Z', complete: true, entries: [] } }),
    },
  };
}
function editFact(r, changes) { Object.assign(r.snapshots.project_facts.data.facts[0], changes); r.snapshots.project_facts = sign(r.snapshots.project_facts); }
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('synthetic test produces review-only dated slots, verbatim briefs and exact provenance', () => {
  const r = fixture(), result = prepareEditorial(r);
  assert.equal(result.status, 'ready_for_review'); assert.equal(result.scope, 'internal_review_only');
  assert.equal(result.publication_authorized, false); assert.equal(result.input_class, 'synthetic_test');
  assert.equal(result.business_readiness, 'not_assessed'); assert.equal(result.semantic_fact_verification, 'not_performed');
  assert.deepEqual(result.slots.map(s => s.proposed_at), ['2026-10-18T10:00:00.000Z', '2026-10-19T10:00:00.000Z', '2026-10-20T10:00:00.000Z']);
  const s = result.slots[0], f = r.snapshots.project_facts.data.facts[0];
  assert.equal(s.topic_title, f.topic_title); assert.equal(s.brief.source_claims[0].text, f.statement);
  assert.deepEqual(s.fact_refs[0], { fact_id: f.fact_id, source_record_id: f.source_record_id, statement_hash: hashJson(f.statement), source_ref: 'synthetic.project-facts', revision: 'synthetic-r1', evidence_hash: r.snapshots.project_facts.evidence_hash });
  assert.deepEqual(s.asset_refs, ['synthetic-map-1']); assert.deepEqual(result.slots[1].missing_assets, ['project_photo']);
  assert.equal(result.request_hash, hashJson(r)); assert.equal(validateEditorialArtifact(result, r), true);
});

test('frozen input remains untouched, output is deeply frozen, replay and key ordering are deterministic', () => {
  const r = freeze(fixture()), before = JSON.stringify(r), a = prepareEditorial(r), b = prepareEditorial(r);
  assert.deepEqual(a, b); assert.equal(JSON.stringify(r), before); assert(Object.isFrozen(a.slots[0].brief));
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reorder(value[key])])) : value;
  const reordered = reorder(fixture());
  assert.deepEqual(a, prepareEditorial(reordered));
  const canonicalOrder = value => Array.isArray(value) ? value.map(canonicalOrder) : value && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalOrder(value[key])])) : value;
  const stored = canonicalOrder(fixture());
  assert.deepEqual(a, prepareEditorial(stored));
  assert.deepEqual(a.evidence.map(item => item.role), ['calendar', 'project_facts']);
  assert.equal(validateEditorialArtifact(a, reordered), true);
  assert.equal(validateEditorialArtifact(a, stored), true);
  assert.throws(() => a.slots.push({}), TypeError);
  const { artifact_hash, ...body } = a; assert.equal(artifact_hash, hashJson(body));
});

test('missing real facts is an explicit blocker, not an empty ready artifact', () => {
  const r = fixture(); r.input_class = 'real'; r.snapshots.project_facts = null;
  const a = prepareEditorial(r); assert.equal(a.status, 'blocked_missing_input'); assert.deepEqual(a.slots, []);
  assert(a.blockers.some(b => b.code === 'missing_snapshot' && b.source_role === 'project_facts'));
  r.snapshots.calendar = null; assert.equal(prepareEditorial(r).blockers.length, 2);
});

test('empty or audience-mismatched facts block instead of inventing business topics', () => {
  const r = fixture(); r.snapshots.project_facts.data.facts = []; r.snapshots.project_facts.data.assets = []; r.snapshots.project_facts = sign(r.snapshots.project_facts);
  assert.equal(prepareEditorial(r).status, 'blocked_missing_input');
  const r2 = fixture(); r2.audience = 'partner'; editFact(r2, { audiences: ['client'] });
  assert.equal(prepareEditorial(r2).status, 'blocked_missing_input');
});

test('stale, expired and future-dated source snapshots fail closed', () => {
  for (const [role, observed, until] of [
    ['project_facts', '2026-10-01T00:00:00.000Z', '2026-10-31T00:00:00.000Z'],
    ['calendar', '2026-10-16T07:59:59.000Z', '2026-10-31T00:00:00.000Z'],
    ['calendar', NOW, NOW.replace('08:00:00', '08:00:01')],
    ['project_facts', '2026-10-17T08:00:01.000Z', '2026-10-31T00:00:00.000Z'],
  ]) {
    const r = fixture(); Object.assign(r.snapshots[role], { observed_at: observed, valid_until: until });
    if (until === NOW.replace('08:00:00', '08:00:01')) r.evaluated_at = until;
    r.snapshots[role] = sign(r.snapshots[role]);
    const a = prepareEditorial(r); assert.equal(a.status, 'blocked_stale_input'); assert.deepEqual(a.slots, []);
  }
});

test('facts expired for planned date are not used even when snapshot is fresh', () => {
  const r = fixture(); r.snapshots.project_facts.data.facts.forEach(f => { f.valid_until = '2026-10-18T00:00:00.000Z'; }); r.snapshots.project_facts = sign(r.snapshots.project_facts);
  const a = prepareEditorial(r); assert.equal(a.status, 'blocked_stale_input'); assert.equal(a.slots.length, 0);
  assert(a.blockers.every(b => b.code === 'no_facts_valid_for_slot'));
});

test('partial calendar and missing collision margins block preparation', () => {
  for (const change of [{ complete: false }, { coverage_start: '2026-10-18T00:00:00.000Z' }, { coverage_end: '2026-10-22T00:00:00.000Z' }]) {
    const r = fixture(); Object.assign(r.snapshots.calendar.data, change); r.snapshots.calendar = sign(r.snapshots.calendar);
    assert.equal(prepareEditorial(r).status, 'blocked_missing_input');
  }
});

test('calendar collisions skip slots; topic diversity and asset rights warnings are explicit', () => {
  const r = fixture(); r.snapshots.calendar.data.entries = [{ entry_id: 'synthetic-entry-1', scheduled_at: '2026-10-18T12:00:00.000Z', audience: 'client', topic_id: 'synthetic-topic-1', status: 'scheduled' }];
  r.snapshots.calendar = sign(r.snapshots.calendar); r.snapshots.project_facts.data.assets[0].rights_status = 'unknown'; r.snapshots.project_facts = sign(r.snapshots.project_facts);
  const a = prepareEditorial(r); assert.equal(a.slots[0].proposed_at, '2026-10-20T10:00:00.000Z');
  assert.equal(a.slots[0].topic_id, 'synthetic-topic-2');
  assert(a.conflict_warnings.some(w => w.code === 'cadence_conflict'));
  assert(a.conflict_warnings.some(w => w.code === 'asset_rights_not_approved'));
  assert(a.slots.every(s => s.asset_refs.length === 0));
});

test('planned slots enforce minimum spacing and empty cadence opportunity is blocked', () => {
  const r = fixture(); r.cadence.minimum_gap_hours = 48;
  r.snapshots.calendar.data.coverage_start = '2026-10-11T00:00:00.000Z'; r.snapshots.calendar.data.coverage_end = '2026-10-29T00:00:00.000Z'; r.snapshots.calendar = sign(r.snapshots.calendar);
  const a = prepareEditorial(r); assert.equal(a.slots.length, 2); assert.equal(a.status, 'ready_for_review');
  const r2 = fixture(); r2.cadence.weekdays = [6]; assert.equal(prepareEditorial(r2).status, 'blocked_missing_input');
});

test('source tampering, wrong project, duplicate and dangling identities are rejected', () => {
  const bad = [];
  { const r = fixture(); r.snapshots.project_facts.data.facts[0].statement = 'Tampered'; bad.push([r, 'evidence_hash_mismatch']); }
  { const r = fixture(); r.snapshots.project_facts.data.project_id = 'different'; r.snapshots.project_facts = sign(r.snapshots.project_facts); bad.push([r, 'project_mismatch']); }
  { const r = fixture(); r.snapshots.project_facts.data.facts.push(r.snapshots.project_facts.data.facts[0]); r.snapshots.project_facts = sign(r.snapshots.project_facts); bad.push([r, 'duplicate_identifier']); }
  { const r = fixture(); r.snapshots.project_facts.data.assets[0].related_fact_ids = ['unknown']; r.snapshots.project_facts = sign(r.snapshots.project_facts); bad.push([r, 'unknown_fact_reference']); }
  for (const [r, code] of bad) assert.throws(() => prepareEditorial(r), { code });
});

test('closed contract rejects overrides, URLs, file paths, commands and HTML fields', () => {
  for (const change of [r => { r.publish = true; }, r => { r.snapshots.calendar.url = 'https://example.invalid'; }, r => { r.objective.command = 'publish'; }, r => { r.cadence.weekdays = [1, 1]; }]) {
    const r = fixture(); change(r); assert.throws(() => prepareEditorial(r));
  }
  for (const text of ['https://example.invalid', '/tmp/source.json', '../source', '<img src=x>', '$(touch x)', '`run`', 'run && publish']) {
    const r = fixture(); r.objective.instruction = text; assert.throws(() => prepareEditorial(r), { code: 'unsafe_or_invalid_text' });
  }
});

test('invalid dates, unlimited horizons, malformed cadence and out-of-coverage calendar entries are rejected', () => {
  const cases = [r => { r.evaluated_at = '2026-02-30T00:00:00.000Z'; },
    r => { r.planning_window.ends_at = '2027-10-17T00:00:00.000Z'; }, r => { r.cadence.time_utc = '24:00'; }, r => { r.cadence.max_slots = 61; },
    r => { r.snapshots.calendar.data.entries = [{ entry_id: 'outside', scheduled_at: '2026-10-10T00:00:00.000Z', audience: 'client', topic_id: 'topic', status: 'scheduled' }]; r.snapshots.calendar = sign(r.snapshots.calendar); }];
  for (const change of cases) { const r = fixture(); change(r); assert.throws(() => validateEditorialRequest(r)); }
});

test('non-JSON inputs, cycles, accessors and oversize input are rejected without invoking getters', () => {
  for (const value of [undefined, Infinity, new Date(), Object.create(null), [, 1]]) assert.throws(() => hashJson(value));
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => hashJson(cyclic), { code: 'invalid_json' });
  let called = false; const getter = { get x() { called = true; return 1; } }; assert.throws(() => hashJson(getter), { code: 'invalid_json' }); assert.equal(called, false);
  assert.throws(() => hashJson('a'.repeat(600000)), { code: 'input_too_large' });
});

test('output validator rejects fabricated claims, approval flags, removed blockers and modified evidence', () => {
  for (const edit of [a => { a.publication_authorized = true; }, a => { a.slots[0].brief.source_claims[0].text = 'Unsupported invented superiority claim'; }, a => { a.evidence[0].revision = 'other'; }, a => { a.extra = 'publish'; }]) {
    const r = fixture(), a = JSON.parse(JSON.stringify(prepareEditorial(r))); edit(a);
    const { artifact_hash, ...body } = a; a.artifact_hash = hashJson(body);
    assert.throws(() => validateEditorialArtifact(a, r), { code: 'artifact_mismatch' });
  }
  const r = fixture(); r.snapshots.calendar = null; const a = JSON.parse(JSON.stringify(prepareEditorial(r))); a.status = 'ready_for_review'; a.blockers = [];
  assert.throws(() => validateEditorialArtifact(a, r), { code: 'artifact_mismatch' });
});

test('module imports only crypto, never the server, store, network or model modules', () => {
  const source = readFileSync(require.resolve('../work-preparation/editorial'), 'utf8');
  assert.deepEqual([...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]), ['node:crypto']);
  assert.doesNotMatch(source, /\b(?:fetch|setInterval|setTimeout|exec|spawn|writeFile|Date\.now)\s*\(/);
});

test('synthetic snapshots cannot be relabeled as real business evidence by the outer request', () => {
  const r = fixture(); r.input_class = 'real'; const a = prepareEditorial(r);
  assert.equal(a.status, 'blocked_missing_input'); assert.equal(a.slots.length, 0);
  assert.equal(a.blockers.filter(b => b.code === 'synthetic_source_not_real').length, 2);
});

test('a planning window already started is stale, never silently shifted', () => { const r = fixture(); r.planning_window.starts_at = '2026-10-17T07:59:59.000Z'; const a = prepareEditorial(r); assert.equal(a.status, 'blocked_stale_input'); assert(a.blockers.some(b => b.code === 'planning_window_started')); });
