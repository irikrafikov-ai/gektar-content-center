'use strict';
const { open } = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { validateEditorialRequest, evidenceHash, hashJson } = require('./editorial');
const PINNED_FACTS = require('./pinned-project-facts.json');
const MAX_POSTS_BYTES = 8 * 1024 * 1024;
const DAY = 86400000;

// The path is server-owned configuration, never task input. No directories or
// files are created; unreadable/corrupt/mutating files remain unavailable.
async function readCalendarFile(filePath) {
  const file = await open(filePath, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_POSTS_BYTES) throw new Error('calendar_source_unavailable');
    const chunks = []; let size = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, MAX_POSTS_BYTES + 1 - size));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > MAX_POSTS_BYTES) throw new Error('calendar_source_unavailable');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('calendar_source_changed');
    const bytes = Buffer.concat(chunks, size), posts = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(posts) || posts.length > 100000) throw new Error('calendar_source_unavailable');
    return { posts, revision: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}
function buildCalendarSnapshot(source, request, observedAt) {
  if (!source || !Array.isArray(source.posts) || !/^[a-f0-9]{64}$/.test(source.revision)) throw new Error('calendar_source_unavailable');
  const from = Date.parse(request.planning_window.starts_at) - 7 * DAY, until = Date.parse(request.planning_window.ends_at) + 7 * DAY;
  const entries = [], facts = request.snapshots.project_facts?.data.facts || [];
  for (const post of source.posts) {
    if (!post || typeof post !== 'object' || Array.isArray(post)) throw new Error('calendar_source_unavailable');
    for (const field of ['scheduled', 'published']) if (post[field] !== undefined && typeof post[field] !== 'boolean') throw new Error('calendar_state_unknown');
    if (!post.scheduled && !post.published) continue;
    const at = typeof post.date === 'string' ? Date.parse(post.date) : NaN;
    if (!Number.isFinite(at)) throw new Error('calendar_date_unknown');
    if (at < from || at >= until) continue;
    if (!['client', 'partner', 'video'].includes(post.aud)) throw new Error('calendar_audience_unknown');
    const text = typeof post.text === 'string' ? post.text : '';
    const matchingTopics = [...new Set(facts.filter(f => text.includes(f.statement)).map(f => f.topic_id))].sort();
    entries.push({ entry_id: `post_${createHash('sha256').update(JSON.stringify(post)).digest('hex')}`, scheduled_at: new Date(at).toISOString(),
      audience: post.aud === 'client' ? 'client' : 'partner', topic_id: matchingTopics.length === 1 ? matchingTopics[0] : `legacy_${createHash('sha256').update(text).digest('hex')}`,
      status: post.published ? 'published' : 'scheduled' });
  }
  if (entries.length > 2000) throw new Error('calendar_capacity_exceeded');
  entries.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at) || a.entry_id.localeCompare(b.entry_id));
  // Identical duplicates represent a single occupied time, not two independent
  // facts. Keep both collision protection and a strictly unique bounded contract.
  const unique = [...new Map(entries.map(e => [e.entry_id, e])).values()];
  const envelope = { source_ref: 'content.local_posts.all_projects', revision: source.revision, evidence_class: 'real', observed_at: observedAt,
    valid_until: new Date(Date.parse(observedAt) + DAY).toISOString(),
    data: { project_id: request.project_id, coverage_start: new Date(from).toISOString(), coverage_end: new Date(until).toISOString(), complete: true, entries: unique } };
  return { ...envelope, evidence_hash: evidenceHash(envelope) };
}
async function materializeEditorialInput(seed, { readCalendar, observedAt, projectFacts = PINNED_FACTS }) {
  validateEditorialRequest(seed);
  const input = JSON.parse(JSON.stringify(seed));
  input.evaluated_at = observedAt;
  // Never relabel synthetic tasks into production or let caller evidence override
  // a live source capture. Synthetic tasks cannot be run by this production loader.
  if (input.input_class !== 'real') throw new Error('production_worker_requires_real_input');
  input.snapshots = { project_facts: projectFacts?.data?.project_id === input.project_id ? JSON.parse(JSON.stringify(projectFacts)) : null, calendar: null };
  try { input.snapshots.calendar = buildCalendarSnapshot(await readCalendar(), input, observedAt); }
  catch { /* Explicit null snapshot -> a persisted missing-input artifact. */ }
  validateEditorialRequest(input);
  return input;
}
module.exports = { MAX_POSTS_BYTES, readCalendarFile, buildCalendarSnapshot, materializeEditorialInput };
