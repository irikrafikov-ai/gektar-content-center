# Internal operation worker

This layer is distinct from the pure editorial module. It is disabled unless
both `OPERATION_ENABLED=true` and `OPERATION_TASKS_ENABLED=true` are set. It uses
only `OPERATION_TASK_TOKEN` and `OPERATION_CORE_URL`; the existing director audit
credential, routes, public endpoints, UI and publication scheduler are unchanged.

`OPERATION_CORE_URL` must be the exact verified bare origin
`https://zemfond-codex-core-production.up.railway.app`. Other Railway tenants and
private hostnames are rejected. Credentials, paths, queries, fragments and redirects
are prohibited. No task field supplies a network target. Only the bounded fixed
claim, task-status, immutable-input and result routes are used. The token must not
reuse known existing audit/backend keys. Core independently enforces role scope.
Each request has a 15-second deadline and a 1 MiB body/response bound. No credential
or raw response is logged. Safe operation IDs/hashes/status or fixed error codes
are the only logs.

The worker validates task/plan identity and hashes, materializes only snapshots
and explicit evaluation time, freezes input on core before pure preparation, and
submits the substantive artifact. Core owns all durable task/input/result state;
this worker never saves posts or other business data. An uncertain write is read
back before claiming it succeeded; no blind write retry is performed. On a
reclaimed pure task, previously frozen input is reused, never refreshed into a
new input hash. The server starts one process-local single-flight polling loop at
60 seconds. Importing the worker does not start the loop. This is not a separate
process, service, public endpoint, or publication scheduler.

## Read-only source capture

`source-loader.js` opens the server-owned posts path read-only, checks file type,
size and pre/post read metadata, caps bytes at 8 MiB, and SHA-256 hashes the exact
file bytes for source revision. Missing, unreadable, corrupt or changing storage
never becomes an invented empty calendar. Malformed dates/audiences/states for
occupied slots likewise become an explicit missing-calendar blocker. The fixed
calendar interval includes seven-day collision/topic-check margins.

The existing posts format has no reliable project ID. Therefore collision checks
conservatively include every project sharing the requested client/partner
channel; video maps to the existing partner routing. Existing topic matching is
exact source-statement inclusion only. Other posts have opaque legacy topic IDs;
no semantic or comprehensive duplicate-topic detection is claimed. Unscheduled
undated drafts do not occupy a calendar slot. Identical duplicated post records
are collapsed to one occupied slot, not assumed to be multiple deliveries.

## Verified, pinned background evidence

`pinned-project-facts.json` contains only three exact source statements for `sb`:

- Boundary-qualified network wording, not a promise of connections at every plot.
- Explicit absence of central sewer and the source's septic wording.
- Canonical map coordinates.

The source was read through the connected GitHub source on 17 October 2026. It is
`irikrafikov-ai/gektar-avito-kb`, commit
`4d3b612413f4483529d6af01dabe157dba007993`, file
`ЛОКАЦИЯ-И-КОММУНИКАЦИИ.md`, blob
`c8ef2962d199eef2962da262f5b9a310858a8d0b`, lines 23, 27 and 47 respectively.
The committed source timestamp is 14 October 2026 at 09:58:26 UTC; the observation
was 17 October 2026 at 09:58:59 UTC. Source URL:
https://github.com/irikrafikov-ai/gektar-avito-kb/blob/4d3b612413f4483529d6af01dabe157dba007993/ЛОКАЦИЯ-И-КОММУНИКАЦИИ.md

The seven-day `valid_from`/`valid_until` span is a conservative internal evidence-use
window from capture, not a warranty that the underlying facts remain true. It
expires on 24 October 2026 at 09:58:59 UTC and is never silently refreshed by the
worker. An independently refreshed source must replace this manifest explicitly.
No assets/rights are invented: briefs show missing diagram/map assets. Other
projects remain blocked until their exact current source facts are supplied.

The source contains inconsistent inventory history elsewhere: a cadastral table
still labels plot 3 free while the current ideal-bundle document says it was sold
on 14 October. This adapter deliberately does not use inventory, prices, discounts,
financial terms, availability claims or viewing commitments from static KB text.
No paid model/image calls, source GitHub token provisioning, customer sends, CRM
writes, publication, price changes or advertising actions exist in this worker.

## Activation and acceptance

Code and synthetic transport tests alone do not establish live activation or a
live ready artifact. Deployment must apply only the new files and additive server
insertions onto the verified current service revision, provision the distinct
scoped credential through the approved secure workflow, and verify the actual
core lease/input/result receipts. Director review must independently validate the
frozen request and exact artifact. `submitted` is not completed or approved;
`ready_for_review` is not publication authority. Missing live sources remain
persisted blocked artifacts with the missing source role, never fixture fallback.
