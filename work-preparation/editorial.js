'use strict';

// Pure, offline preparation. Do not import stores, servers, model or publication code.
const { createHash } = require('node:crypto');
const CONTRACT = 'content.editorial.prepare.v1';
const OUTPUT_CONTRACT = 'content.editorial.prepared.v1';
const MAX_BYTES = 512 * 1024;
const DAY = 86400000;
const ASSET_KINDS = ['project_photo', 'map', 'diagram', 'video'];
const GOALS = ['awareness', 'education', 'lead_qualification', 'partner_enablement'];
const STATUSES = ['ready_for_review', 'blocked_missing_input', 'blocked_stale_input'];

function invalid(code, field = '') {
  throw Object.assign(new TypeError(code), { code, field });
}
function object(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid('invalid_contract', field);
}
function scalar(value, allowed, field) { if (!allowed.includes(value)) invalid('invalid_contract', field); }
function list(value, max, field) { if (!Array.isArray(value) || value.length > max) invalid('invalid_contract', field); }
function unique(values, field) { if (new Set(values).size !== values.length) invalid('duplicate_identifier', field); }
function integer(value, min, max, field) { if (!Number.isInteger(value) || value < min || value > max) invalid('invalid_contract', field); }
function id(value, field) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$/.test(value)) invalid('invalid_reference', field); }
function plainText(value, max, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value !== value.trim() ||
      /[<>\\`$\u0000-\u001f\u007f]|(?:https?|ftp|file|data|javascript):|www\.|\/\/|(?:^|\s)(?:\/|~\/|\.\.?\/)|\|\||&&/i.test(value)) invalid('unsafe_or_invalid_text', field);
}
function time(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid('invalid_timestamp', field);
  return Date.parse(value);
}
function hex(value, field) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid('invalid_hash', field); }

// JSON-only, bounded graph validation precedes canonicalization. Accessors, sparse
// arrays, cycles, exotic objects, undefined and non-finite numbers are rejected.
function assertJson(value) {
  const active = new Set();
  let nodes = 0;
  function walk(v, depth) {
    if (++nodes > 30000 || depth > 20) invalid('input_too_complex');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') { if (!Number.isFinite(v)) invalid('invalid_json'); return; }
    if (typeof v !== 'object' || active.has(v)) invalid('invalid_json');
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) invalid('invalid_json');
    active.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(v);
    if (keys.some(k => typeof k !== 'string') || keys.some(k => !('value' in descriptors[k]))) invalid('invalid_json');
    if (Array.isArray(v)) {
      if (keys.length !== v.length + 1 || keys.some(k => k !== 'length' && !/^(0|[1-9]\d*)$/.test(k))) invalid('invalid_json');
      for (let i = 0; i < v.length; i++) { if (!Object.hasOwn(v, i)) invalid('invalid_json'); walk(descriptors[i].value, depth + 1); }
    } else {
      for (const key of keys) {
        if (!descriptors[key].enumerable || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid('invalid_json');
        walk(descriptors[key].value, depth + 1);
      }
    }
    active.delete(v);
  }
  walk(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_BYTES) invalid('input_too_large');
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hashJson(value) { assertJson(value); return createHash('sha256').update(canonical(value)).digest('hex'); }
function evidenceHash(snapshot) {
  assertJson(snapshot);
  const { evidence_hash, ...body } = snapshot;
  return hashJson(body);
}
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
function validateSnapshot(s, role, request) {
  if (s === null) return;
  object(s, ['source_ref', 'revision', 'evidence_class', 'observed_at', 'valid_until', 'evidence_hash', 'data'], role);
  id(s.source_ref, `${role}.source_ref`); id(s.revision, `${role}.revision`);
  scalar(s.evidence_class, ['real', 'synthetic_test'], `${role}.evidence_class`);
  const observed = time(s.observed_at, `${role}.observed_at`), validUntil = time(s.valid_until, `${role}.valid_until`);
  if (observed >= validUntil) invalid('invalid_validity_window', role);
  hex(s.evidence_hash, `${role}.evidence_hash`);
  if (s.evidence_hash !== evidenceHash(s)) invalid('evidence_hash_mismatch', role);
  if (role === 'project_facts') {
    object(s.data, ['project_id', 'facts', 'assets'], 'project_facts.data');
    id(s.data.project_id, 'project_facts.data.project_id');
    if (s.data.project_id !== request.project_id) invalid('project_mismatch', role);
    list(s.data.facts, 500, 'facts'); list(s.data.assets, 500, 'assets');
    for (const f of s.data.facts) {
      object(f, ['fact_id', 'topic_id', 'topic_title', 'statement', 'source_record_id', 'audiences', 'valid_from', 'valid_until', 'required_asset_kinds'], 'fact');
      id(f.fact_id, 'fact_id'); id(f.topic_id, 'topic_id'); id(f.source_record_id, 'source_record_id');
      plainText(f.topic_title, 120, 'topic_title'); plainText(f.statement, 2000, 'statement');
      list(f.audiences, 2, 'audiences'); if (!f.audiences.length) invalid('invalid_contract', 'audiences');
      unique(f.audiences, 'audiences'); f.audiences.forEach(a => scalar(a, ['client', 'partner'], 'audiences'));
      if (time(f.valid_from, 'fact.valid_from') >= time(f.valid_until, 'fact.valid_until')) invalid('invalid_validity_window', 'fact');
      list(f.required_asset_kinds, 4, 'required_asset_kinds'); unique(f.required_asset_kinds, 'required_asset_kinds');
      f.required_asset_kinds.forEach(a => scalar(a, ASSET_KINDS, 'required_asset_kinds'));
    }
    unique(s.data.facts.map(f => f.fact_id), 'facts');
    const topicTitles = new Map();
    for (const f of s.data.facts) {
      if (topicTitles.has(f.topic_id) && topicTitles.get(f.topic_id) !== f.topic_title) invalid('inconsistent_topic_title', 'facts');
      topicTitles.set(f.topic_id, f.topic_title);
    }
    for (const a of s.data.assets) {
      object(a, ['asset_id', 'kind', 'related_fact_ids', 'rights_status'], 'asset');
      id(a.asset_id, 'asset_id'); scalar(a.kind, ASSET_KINDS, 'asset.kind'); scalar(a.rights_status, ['approved', 'unknown', 'denied'], 'rights_status');
      list(a.related_fact_ids, 500, 'related_fact_ids'); unique(a.related_fact_ids, 'related_fact_ids');
      a.related_fact_ids.forEach(fid => { id(fid, 'related_fact_ids'); if (!s.data.facts.some(f => f.fact_id === fid)) invalid('unknown_fact_reference', 'asset'); });
    }
    unique(s.data.assets.map(a => a.asset_id), 'assets');
  } else {
    object(s.data, ['project_id', 'coverage_start', 'coverage_end', 'complete', 'entries'], 'calendar.data');
    id(s.data.project_id, 'calendar.project_id'); if (s.data.project_id !== request.project_id) invalid('project_mismatch', role);
    const from = time(s.data.coverage_start, 'coverage_start'), until = time(s.data.coverage_end, 'coverage_end');
    if (from >= until) invalid('invalid_validity_window', 'calendar.coverage');
    scalar(s.data.complete, [true, false], 'calendar.complete'); list(s.data.entries, 2000, 'calendar.entries');
    for (const e of s.data.entries) {
      object(e, ['entry_id', 'scheduled_at', 'audience', 'topic_id', 'status'], 'calendar.entry');
      id(e.entry_id, 'entry_id'); id(e.topic_id, 'entry.topic_id');
      const at = time(e.scheduled_at, 'entry.scheduled_at');
      if (at < from || at >= until) invalid('entry_outside_coverage', 'calendar.entry');
      scalar(e.audience, ['client', 'partner'], 'entry.audience'); scalar(e.status, ['draft', 'scheduled', 'published'], 'entry.status');
    }
    unique(s.data.entries.map(e => e.entry_id), 'calendar.entries');
  }
}
function validateEditorialRequest(request) {
  assertJson(request);
  object(request, ['schema_version', 'kind', 'input_class', 'project_id', 'objective', 'audience', 'planning_window', 'cadence', 'evaluated_at', 'snapshots'], 'request');
  scalar(request.schema_version, [CONTRACT], 'schema_version'); scalar(request.kind, ['content.editorial.prepare'], 'kind');
  scalar(request.input_class, ['real', 'synthetic_test'], 'input_class'); id(request.project_id, 'project_id');
  scalar(request.audience, ['client', 'partner'], 'audience');
  object(request.objective, ['goal', 'instruction'], 'objective'); scalar(request.objective.goal, GOALS, 'objective.goal'); plainText(request.objective.instruction, 500, 'objective.instruction');
  object(request.planning_window, ['starts_at', 'ends_at'], 'planning_window');
  const from = time(request.planning_window.starts_at, 'planning_window.starts_at'), until = time(request.planning_window.ends_at, 'planning_window.ends_at');
  const now = time(request.evaluated_at, 'evaluated_at');
  if (from >= until || until - from > 90 * DAY) invalid('invalid_planning_window', 'planning_window');
  object(request.cadence, ['weekdays', 'time_utc', 'max_slots', 'minimum_gap_hours'], 'cadence');
  list(request.cadence.weekdays, 7, 'cadence.weekdays'); if (!request.cadence.weekdays.length) invalid('invalid_contract', 'cadence.weekdays');
  unique(request.cadence.weekdays, 'cadence.weekdays'); request.cadence.weekdays.forEach(d => integer(d, 1, 7, 'cadence.weekdays'));
  if (typeof request.cadence.time_utc !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(request.cadence.time_utc)) invalid('invalid_contract', 'cadence.time_utc');
  integer(request.cadence.max_slots, 1, 60, 'cadence.max_slots'); integer(request.cadence.minimum_gap_hours, 1, 168, 'cadence.minimum_gap_hours');
  object(request.snapshots, ['project_facts', 'calendar'], 'snapshots');
  validateSnapshot(request.snapshots.project_facts, 'project_facts', request); validateSnapshot(request.snapshots.calendar, 'calendar', request);
  return request;
}
function sourceReference(snapshot, role) {
  return { role, source_ref: snapshot.source_ref, revision: snapshot.revision, evidence_class: snapshot.evidence_class, evidence_hash: snapshot.evidence_hash, observed_at: snapshot.observed_at, valid_until: snapshot.valid_until };
}
function factReference(fact, snapshot) {
  return { fact_id: fact.fact_id, source_record_id: fact.source_record_id, statement_hash: hashJson(fact.statement), source_ref: snapshot.source_ref, revision: snapshot.revision, evidence_hash: snapshot.evidence_hash };
}
function prepareEditorial(input) {
  validateEditorialRequest(input);
  // Copy caller data before freezing output. Caller-owned snapshots are never changed.
  const r = JSON.parse(JSON.stringify(input));
  const { project_facts: factsSnapshot, calendar: calendarSnapshot } = r.snapshots;
  const now = Date.parse(r.evaluated_at), start = Date.parse(r.planning_window.starts_at), end = Date.parse(r.planning_window.ends_at);
  const gap = r.cadence.minimum_gap_hours * 3600000;
  const blockers = [], warnings = [], slots = [];
  const block = (code, role, at = null) => blockers.push({ code, source_role: role, proposed_at: at });
  if (start < now) block('planning_window_started', 'calendar');
  for (const [role, snapshot, maxAge] of [['project_facts', factsSnapshot, 7 * DAY], ['calendar', calendarSnapshot, DAY]]) {
    if (!snapshot) block('missing_snapshot', role);
    else if (Date.parse(snapshot.observed_at) > now || now - Date.parse(snapshot.observed_at) > maxAge || Date.parse(snapshot.valid_until) <= now) block('stale_or_future_snapshot', role);
    if (snapshot && r.input_class === 'real' && snapshot.evidence_class === 'synthetic_test') block('synthetic_source_not_real', role);
  }
  if (factsSnapshot && !factsSnapshot.data.facts.some(f => f.audiences.includes(r.audience))) block('missing_audience_facts', 'project_facts');
  if (calendarSnapshot && (!calendarSnapshot.data.complete || Date.parse(calendarSnapshot.data.coverage_start) > start - Math.max(gap, 7 * DAY) || Date.parse(calendarSnapshot.data.coverage_end) < end + Math.max(gap, 7 * DAY))) block('incomplete_calendar_coverage', 'calendar');
  if (!blockers.length) {
    const candidates = [];
    for (let day = Math.floor(start / DAY) * DAY; day < end; day += DAY) {
      const [hour, minute] = r.cadence.time_utc.split(':').map(Number);
      const at = day + hour * 3600000 + minute * 60000;
      const weekday = new Date(at).getUTCDay() || 7;
      if (at >= start && at < end && r.cadence.weekdays.includes(weekday)) candidates.push(at);
    }
    const usage = new Map();
    for (const at of candidates) {
      if (slots.length >= r.cadence.max_slots) break;
      const proposedAt = new Date(at).toISOString();
      const conflicts = calendarSnapshot.data.entries.filter(e => e.audience === r.audience && Math.abs(Date.parse(e.scheduled_at) - at) < gap);
      if (conflicts.length || slots.some(s => Math.abs(Date.parse(s.proposed_at) - at) < gap)) {
        warnings.push({ code: 'cadence_conflict', proposed_at: proposedAt, reference_ids: conflicts.map(e => e.entry_id).sort() }); continue;
      }
      const validFacts = factsSnapshot.data.facts.filter(f => f.audiences.includes(r.audience) && Date.parse(f.valid_from) <= at && at < Date.parse(f.valid_until));
      if (!validFacts.length) { block('no_facts_valid_for_slot', 'project_facts', proposedAt); continue; }
      const topics = [...new Set(validFacts.map(f => f.topic_id))].sort();
      const recent = calendarSnapshot.data.entries.filter(e => e.audience === r.audience && Math.abs(Date.parse(e.scheduled_at) - at) < 7 * DAY);
      const score = topic => (usage.get(topic) || 0) + recent.filter(e => e.topic_id === topic).length;
      topics.sort((a, b) => score(a) - score(b) || (a < b ? -1 : a > b ? 1 : 0));
      const topicId = topics[0], topicFacts = validFacts.filter(f => f.topic_id === topicId).sort((a, b) => a.fact_id < b.fact_id ? -1 : 1);
      if (score(topicId) > 0) warnings.push({ code: 'topic_repetition_review', proposed_at: proposedAt, reference_ids: recent.filter(e => e.topic_id === topicId).map(e => e.entry_id).sort() });
      usage.set(topicId, (usage.get(topicId) || 0) + 1);
      const required = [...new Set(topicFacts.flatMap(f => f.required_asset_kinds))].sort();
      const eligibleAssets = factsSnapshot.data.assets.filter(a => a.rights_status === 'approved' && a.related_fact_ids.some(fid => topicFacts.some(f => f.fact_id === fid)));
      const missing = required.filter(kind => !eligibleAssets.some(a => a.kind === kind));
      const questionable = factsSnapshot.data.assets.filter(a => a.rights_status !== 'approved' && a.related_fact_ids.some(fid => topicFacts.some(f => f.fact_id === fid)));
      if (questionable.length) warnings.push({ code: 'asset_rights_not_approved', proposed_at: proposedAt, reference_ids: questionable.map(a => a.asset_id).sort() });
      const references = topicFacts.map(f => factReference(f, factsSnapshot));
      slots.push({ slot_id: `slot_${hashJson({ project_id: r.project_id, audience: r.audience, proposed_at: proposedAt, topic_id: topicId, fact_refs: references })}`,
        proposed_at: proposedAt, status: 'proposed_only', topic_id: topicId, topic_title: topicFacts[0].topic_title,
        brief: { goal: r.objective.goal, instruction: r.objective.instruction, source_claims: topicFacts.map(f => ({ text: f.statement, fact_id: f.fact_id })),
          review_requirements: ['verify_source_claims', 'confirm_audience_and_channel', 'review_final_copy', 'obtain_separate_publication_approval'] },
        fact_refs: references, asset_refs: eligibleAssets.filter(a => required.includes(a.kind)).map(a => a.asset_id).sort(), missing_assets: missing });
    }
    if (!slots.length && !blockers.length) block('no_available_editorial_slots', 'calendar');
    if (slots.length < r.cadence.max_slots) warnings.push({ code: 'cadence_capacity_limited', proposed_at: null, reference_ids: [] });
  }
  const status = blockers.some(b => ['stale_or_future_snapshot', 'no_facts_valid_for_slot', 'planning_window_started'].includes(b.code)) ? 'blocked_stale_input' : blockers.length ? 'blocked_missing_input' : 'ready_for_review';
  const body = {
    schema_version: OUTPUT_CONTRACT, kind: 'content.editorial.prepared', request_hash: hashJson(r), input_class: r.input_class,
    status, scope: 'internal_review_only', publication_authorized: false, business_readiness: 'not_assessed', semantic_fact_verification: 'not_performed', source_authenticity: 'not_verified_offline', freshness_scope: 'supplied_evaluation_time_only',
    project_id: r.project_id, audience: r.audience, objective: r.objective, planning_window: r.planning_window, cadence: r.cadence, evaluated_at: r.evaluated_at,
    // Object insertion order can change during canonical JSON storage/transport.
    // Keep evidence in canonical role order on the first run and every replay.
    evidence: ['calendar', 'project_facts'].filter(role => r.snapshots[role]).map(role => sourceReference(r.snapshots[role], role)), slots, conflict_warnings: warnings, blockers,
  };
  return deepFreeze({ ...body, artifact_hash: hashJson(body) });
}
function validateEditorialArtifact(artifact, request) {
  assertJson(artifact);
  // Full deterministic recomputation is the output contract and provenance check.
  // This is structural/exact-copy verification, never semantic fact verification.
  const expected = prepareEditorial(request);
  if (!STATUSES.includes(artifact.status) || canonical(artifact) !== canonical(expected)) invalid('artifact_mismatch');
  return true;
}
module.exports = { CONTRACT, OUTPUT_CONTRACT, MAX_BYTES, hashJson, evidenceHash, validateEditorialRequest, prepareEditorial, validateEditorialArtifact, content: Object.freeze({ editorial: Object.freeze({ prepare: prepareEditorial }) }) };
