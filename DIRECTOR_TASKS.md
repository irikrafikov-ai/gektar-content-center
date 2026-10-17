# Read-only content-calendar task inbox

This change adds one isolated `POST /director/tasks` inbox. It does not change
any existing public API, UI, generation, upload, publication, or scheduler
behavior. The director must never use `/api/posts` POST for an audit: that
existing endpoint can immediately publish content.

## Authentication and input

Set a separate `DIRECTOR_TASK_TOKEN` (32–256 printable non-space ASCII
characters). Missing/invalid configuration returns 503. The only accepted
credential is `X-Director-Task-Token`; Authorization and session cookies have
no authority here. Do not reuse a publishing, admin, or UI-session credential.

Only this exact request shape is accepted. No extra keys or payload fields:

```json
{
  "task_id": "dt_<64 lowercase hex characters>",
  "agent": "content",
  "kind": "content.calendar.audit",
  "idempotency_key": "<same value as task_id>",
  "created_at": "<ISO timestamp with timezone>",
  "deadline": "<later ISO timestamp with timezone>",
  "acceptance": "content_calendar_v1",
  "payload": {}
}
```

The request body is limited to 4 KiB, must be uncompressed JSON, and has a
10-second body-read timeout. Total task time is capped at 20 seconds. The
response is limited to 64 KiB. The task reads only the configured local
`DATA_DIR/posts.json` (the same path as the existing server store), capped at
32 MiB and 100,000 posts. No network calls or external API requests occur.

Missing/unreadable/corrupt/oversized stores or non-object entries return a
sanitized `snapshot_unavailable` failure, not a completed zero result. Only
an actual readable empty JSON array produces zero counts.

## Result contract: content_calendar_v1

Fixed evidence source: `content.local_posts`. Result properties, all
nonnegative integers:

- `total`: all local stored posts.
- `published`: records with a truthy published flag, matching current scheduler
  semantics. This reflects the local flag, not verified external delivery.
- `scheduled`: unpublished records with a truthy scheduled flag.
- `unscheduled`: unpublished records without that scheduled flag.
- `overdue`: scheduled records with a valid ISO date at/before `observed_at`.
- `unready`: unpublished records with one or more readiness issues below.
- `duplicate_candidates`: unpublished records sharing normalized text, usable
  media, effective audience, and effective channels with another stored post.
  Published history can be the matching record. All unpublished matching
  records count, including the first when two pending posts match.
- `duplicate_groups`: repeated signatures with at least one unpublished post.
- `readiness`: an object with these exact counts among unpublished posts:
  - `missing_content`: no nonblank string text or usable photo/video reference.
  - `missing_schedule_time`: scheduled but absent/null/empty date.
  - `invalid_schedule_time`: scheduled with a nonempty invalid ISO date.
  - `invalid_audience`: present audience outside partner/client/video.
  - `invalid_channels`: present channel selection outside both/tg/max.
  - `invalid_media`: present non-array media or any unusable media entry.
  - `invalid_state_flags`: present scheduled/published flag is not boolean.

Readiness counts overlap, but `unready` counts each post at most once. A
text-only post is valid; missing media alone does not imply unreadiness. Media
validation only checks stored reference shape, never network availability.
Duplicate text comparison collapses whitespace and preserves case. Attachment
order is ignored. URLs/content are locally hashed, never returned. Blank posts
are not grouped as duplicate candidates. Post IDs, text, audiences, channel
IDs, destinations, credentials, and media URLs never appear in results.

## Response and retry semantics

Successful responses contain `protocol: 1`, the task ID, `agent: "content"`,
`status: "completed"`, request/receipt hashes, accepted/started/finished ISO
timestamps, and `evidence: {source, observed_at, result}`.

`request_hash` is SHA-256 of recursively key-sorted compact JSON for the exact
validated request. `receipt_id` is `dr_` plus SHA-256 of recursively key-sorted
compact JSON for `{request_hash, observed_at, result}`. Object keys are sorted;
array order is preserved. Hash input is UTF-8.

Retries deliberately re-observe local state, and may produce a different
receipt. The receiver has no durable task ledger and does not claim a cached
idempotent result. It causes no publication or other business mutation. The
director owns durable task delivery, receipt reconciliation, and acceptance.

## Verification

Run `npm test`, `node --check server.js`, and `node --check director-tasks.js`.
Tests use synthetic temporary files and in-memory request/response streams.
They do not import/start the production server, run its scheduler, or call any
external service. One test exercises the real 20-second timeout. An integration
check removes only the additive inbox mount and verifies the remaining server
and full UI against their exact live Git blob hashes at
`99239857fe17e02e04c3022fe647c31b93a4434b`.
