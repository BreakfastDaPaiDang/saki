# Agent Note: polling-first staged GitHub synchronization

Status: proposed

English | [中文](2026-08-18-saki-polling-first-github-synchronization.zh.md)

## Problem

Saki makes GitHub Projects v2 authoritative for shared Work Item Status and manual order, yet local optimistic moves, paginated reads, missed webhook delivery, mapping recreation, and concurrent GitHub edits can leave a Board showing a state GitHub never confirmed. A page cursor is not a durable change offset, and a mutation timeout does not establish whether GitHub applied the effect.

## Proposal

Version 0.1.0 uses configurable polling as the baseline and publishes only complete staged Project-and-Repository scans. A GitHub Sync Checkpoint advances atomically with the confirmed snapshot; in-progress page cursors are discarded after success or failure. Active and background polling default to 30 seconds and five minutes, while startup, manual refresh, local mutations, reconnect, and later webhooks wake the same scanner.

Every mutation includes its expected remote fingerprint. A targeted read permits an idempotent success or the intended write; a mismatch becomes a visible conflict. The adapter confirms the target after mutation and inspects ambiguous replies before retry. Missing node-id mappings make writes unavailable until an attributed repair Intent and complete scan succeed.

One installation-token queue prioritizes mutation reads, mutations, confirmation, login, and manual refresh over background scans. Configurable reserve, GraphQL cost facts, REST conditional reads, `Retry-After`, and bounded backoff protect interactive work and prevent secondary-limit retry storms. [ADR 0013](../../../../docs/adr/0013-polling-first-staged-github-synchronization.md) owns the full protocol.

The supersession audit found no active Agent Note owning Saki product synchronization. The implemented [Saki upstream synchronization](../../implemented/process/2026-08-15-saki-upstream-synchronization.md) concerns repository incorporation workflow and remains independent.

## Alternatives considered

**Require webhooks.** This adds public ingress and recovery work without removing the need for reconciliation scans.

**Persist GraphQL cursors as change offsets.** They only paginate one connection traversal and cannot prove removals or unchanged earlier pages.

**Publish pages as they arrive.** A later failure would expose a partial world as confirmed.

**Use last-writer-wins mutations.** This would overwrite concurrent GitHub work and violate the authority decision.

## Acceptance criteria

- Multi-page scans publish one atomic revision and retain the prior revision on any incomplete scan.
- External changes, removals, recreated mappings, lost mutation replies, rate limits, and restart converge without treating optimistic state as confirmed.
- Client projections distinguish confirmed state, optimistic state, age, conflict, mapping repair, and transport failure.
- Webhook input, when added, only wakes the scanner.

## Risks

Polling delays visibility and can consume API allowance across many Projects. Configurable intervals, priority, conditional reads, and complete-scan telemetry limit that cost, while later webhook wake-up can reduce latency. GitHub lacks a general mutation compare-and-set, so the pre-read and confirmation protocol detects and exposes conflicts but cannot promise serializable cross-system writes.
