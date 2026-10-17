# Offline editorial work preparation

This is an isolated, deterministic implementation of `content.editorial.prepare`.
It is **not connected to HTTP handlers**, the existing audit contract, public auth,
stores, model APIs, generators, scheduling timers, publication, or deployment.
Importing it loads only `node:crypto`. No environment variables are read.

## Exports

- `prepareEditorial(request)` or `content.editorial.prepare(request)` returns a
  deeply frozen artifact and does not mutate the request.
- `validateEditorialRequest(request)` checks the closed input contract and source
  digests; malformed input throws a `TypeError` with a stable `code` and `field`.
- `validateEditorialArtifact(artifact, request)` recomputes the result and requires
  exact canonical equality. Rehashing fabricated claims or removing blockers does
  not make a modified artifact valid.
- `evidenceHash(snapshot)` returns the canonical SHA-256 of the snapshot envelope
  excluding its `evidence_hash` field. The envelope includes its source reference,
  revision, evidence class, observation/validity timestamps, and complete data.
- `hashJson(value)` hashes bounded JSON-only values with recursively sorted object
  keys and preserved array order, encoded as compact UTF-8 JSON.

The request and artifact JSON Schemas are next to the module. The runtime validator
adds date validity, hash integrity, uniqueness, safe-text and cross-field checks.
It rejects unknown fields, cyclic/accessor/non-JSON objects, more than 512 KiB,
more than 30,000 graph nodes, and nesting deeper than 20. Identifiers are bounded
opaque references, never URLs or file paths. Narrative fields are plain inert text
with HTML, URL/path prefixes and shell interpolation/operators rejected. No field
is interpreted as a command, template, markup, network target or file location.
This syntactic filter is not a general natural-language instruction classifier.

## Required frozen input

The caller supplies an explicit objective (bounded goal plus instruction), project,
client/partner audience, planning window (at most 90 days), UTC cadence,
`evaluated_at`, and dated immutable project-fact/calendar snapshots. The adapter
never obtains missing facts from an environment, service, filesystem or model.
Missing snapshots are represented explicitly by `null`.

Every snapshot has `source_ref`, `revision`, `evidence_class`, `observed_at`,
`valid_until`, `evidence_hash`, and `data`. The project facts contain attributed
literal statements, topic IDs/titles, per-fact date validity, applicable audiences,
required asset kinds and bounded asset metadata. Asset references are opaque IDs,
not fetchable locations. The calendar contains a complete explicit coverage
window and dated entries with audience, topic and state.

All timestamps are exact UTC ISO strings with milliseconds. Window ends and fact
validity ends are exclusive. Calendar coverage must include the planning window
plus seven days on each side, so collision and topic-repetition checks have the
required bounded history/context. The source snapshots must be valid at supplied
`evaluated_at`; facts must be observed no more than seven days earlier, calendar no
more than 24 hours earlier, and neither may be future-dated. Freshness is checked
only against that supplied evaluation time, not the current wall clock.

A supplied hash proves correspondence to the supplied bytes, not authenticity,
truth, immutability of the upstream system, or completeness of an upstream export.
The caller must obtain, authenticate and freeze sources independently. The adapter
explicitly reports source authenticity as unverified offline and semantic fact
verification as not performed. It cannot replace a live pre-publication refresh.

## Useful proposal and blockers

The adapter enumerates candidate UTC slots, avoids minimum-gap collisions with
existing calendar entries and its own proposed slots, then balances source topics
using recorded/proposed topic counts. Ties use stable identifier order. Each brief
copies only whole supplied, audience-applicable statements valid for its proposed
date; it never writes unsupported sales claims or invents business facts. Each
claim includes the exact fact/record reference, revision, snapshot evidence hash
and statement hash. Missing assets, asset rights problems, topic repeats and
insufficient capacity are visible. Asset metadata/rights are not externally checked.

`ready_for_review` means only that a proposed internal plan can be reviewed, not
that media are complete, facts independently verified, copy approved, publication
destinations chosen or posting authorized. Missing assets may remain in a
reviewable brief. `publication_authorized` is always false; `business_readiness`
is always `not_assessed`. Slots always have state `proposed_only`.

An already-started planning window is stale and is never silently shifted.
Missing facts/audience, missing or incomplete calendar, and an impossible slot
window yield `blocked_missing_input`. Expired/future source evidence or no facts
valid for a planned date yield `blocked_stale_input`. With partial facts, some
proposals may be present but the artifact remains blocked if any needed slot
lacks valid evidence. No placeholders are emitted in place of missing business
facts. Structural or hash violations are rejected, not turned into business-ready
artifacts.

Synthetic tests are labeled `input_class: synthetic_test` and each snapshot is
labeled `evidence_class: synthetic_test`. Such artifacts may be ready to review as
**synthetic tests only**. Passing a synthetic source under a `real` request yields
an explicit blocker. These labels are assertions from the caller, not an offline
method of proving real-world provenance.

The artifact's `request_hash` covers the whole validated request. `artifact_hash`
covers every output field except itself. There is no wall-clock timestamp or
randomness: identical frozen requests produce identical hashes and artifacts.
There is no durable job/idempotency ledger because this module does no writes.

## Verification

Run `node --test test/editorial-preparation.test.js` for pure synthetic tests.
`npm test` additionally runs the existing isolated audit regression suite. Neither
command needs the content server or external project data. The separate runtime
layer and its pinned real-source provenance are documented in OPERATION_RUNTIME.md.
Tests do not establish deployment, operational activation or publication approval.
