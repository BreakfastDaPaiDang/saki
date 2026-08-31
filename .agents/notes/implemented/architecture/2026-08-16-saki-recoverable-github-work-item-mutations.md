# Agent Note: Recoverable GitHub Work Item mutations

Status: implemented

English | [中文](2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)

## Problem

Creating or moving one GitHub-backed Work Item spans several external effects and durable control-plane writes that cannot share a transaction. The process may stop after GitHub accepts an Issue, Project membership, Status, position, or Issue-state mutation but before Saki records the result. Treating that loss as failure and retrying blindly can create a second Issue or apply a later stage against changed remote facts.

A complete Board scan is intentionally broad and asynchronous. Requiring one after every effect would couple interactive mutations to the polling checkpoint and still leave restart recovery without stage-specific evidence. An optimistic local card alone would instead survive neither contradictory GitHub state nor an uncertain effect.

GitHub also exposes Issue open state, Project Status, and API order as independent facts. Saki must remember the last confirmed non-terminal Status so an externally closed or reopened Issue can be presented as an attributed repair instead of being silently rewritten or restored to an invented Status.

## Decision

`SakiGitHub` defines typed atomic mutations and matching read-only targeted inspections for Issue creation, Project membership, Project Status, Project API position, and Issue open state. Each request carries a control-plane-persisted operation id plus the kind-specific target needed by GitHub. A Service Provider makes one external call per dispatch invocation and never retries a mutation internally; the Consumer decides from durable stage state and targeted observations whether a desired result is confirmed, a proven pre-effect state is safe to repeat, or the outcome requires conflict or reconciliation.

Control-plane state version 6 adds `github_work_item_intents` and `github_work_item_recovery`. An Intent freezes the Actor, caller preconditions, immutable product target, ordered stage ids, and each resolved external target before dispatch. The control plane changes a stage to `dispatching` with `effectPossible: true` before calling the Provider. Recovery inspects an effect-possible stage before any repeat, derives partial-failure presentation from the current stage, retains reconciliation evidence, and resumes the exact remaining suffix rather than restarting the saga. Recovery records retain the latest complete targeted Work Item observation and `latestNonTerminalStatus`; browser receipts and Board overlays expose only bounded product-safe facts.

`CreateWorkItem` runs `issue-create`, `project-item-add`, and `project-item-status-set` to Inbox. The Issue body ends with one deterministic persisted marker. A complete exact-marker inspection distinguishes a unique Issue, absence, pull-request or identity conflict, multiple matches, and incomplete evidence. The Issue id and number returned by dispatch are an inspection-only hint, not part of the immutable dispatch request. Ambiguous marker evidence enters reconciliation instead of creating another Issue.

`MoveWorkItem` starts from the caller's exact remote fingerprint and the current configured mapping. It adds a missing Project membership when needed, opens a closed Issue before restoring a non-terminal Status, sets the target Status, applies an optional API position, and closes an open Issue only after a terminal Status is confirmed. Omitting `position` changes only Status; `{ afterWorkItemId: null }` means the API top; a non-null predecessor carries that Work Item's expected remote fingerprint. Every stage confirms through a targeted inspection, and stale membership, Status, Issue state, predecessor, mapping, or authority becomes a typed conflict or repair result.

Confirmed Board items carry nullable `latestNonTerminalStatus`. Complete scans carry the remembered value across terminal observations, targeted recovery records update it after confirmed mutations, and the v5-to-v6 migration initializes it from the current Status for non-terminal items or `null` for terminal items while creating empty Work Item Intent and recovery tables. A later complete Board checkpoint absorbs a matching targeted result and removes the temporary overlay; targeted inspections never create or advance a GitHub Sync Checkpoint.

## Boundaries and non-goals

This decision implements only interactive `CreateWorkItem` and `MoveWorkItem`. It does not add pull-request creation, arbitrary Issue editing, label mutations, mapping repair by name, webhook publication, automation dispatch, a generic saga language, or generic compensation. The broader [recoverable Control Intent proposal](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.md) remains proposed for those cross-capability lifecycles, while [polling-first GitHub synchronization](2026-08-18-saki-polling-first-github-synchronization.md) continues to own complete scans and checkpoints.

An external close while Project Status remains non-terminal produces an `external-close` repair overlay that suggests Done. An external reopen while Project Status remains terminal suggests the remembered non-terminal Status, or Backlog when no such observation exists. Both require an attributed `MoveWorkItem`; the control plane does not silently mutate GitHub.

The lifecycle does not claim exactly-once delivery. It prevents uninspected retries, uses exact observations to accept or safely resume supported stages, and makes ambiguous effects visible as `reconciliation-required`. Operation ids, `clientMutationId`, and kind-specific expected remote facts support correlation and admission; GitHub provides no transactional or deduplication guarantee across these calls.

## Verification

Service Definition and Product App tests cover the typed mutation map, strict external request, result, and inspection admission, per-operation token permissions, one external call per dispatch invocation, marker traversal, membership cardinality, Status and Issue-state reads, complete API-order inspection, semantic fingerprints, cancellation, and bounded failures. The reusable Provider contract exercises every dispatch and targeted-inspection member without granting a Provider control-plane authority.

Control-plane tests cover Create and Move stage order, exact replay, pre-dispatch inspection, lost dispatch results, restart from every effect-possible stage, partial failures, revocation, stale remote facts, mapping conflicts, membership repair, all three position forms, terminal close and reopen ordering, overlay retirement after a complete scan, and external close/reopen repair. Host API tests keep receipts and overlays wire-safe, and the assembled keyless Board snapshot exercises the real bundle path. Migration tests open retained v5 SQLite state, migrate it to v6, and validate the initialized Status memory and empty Work Item tables.

## Alternatives considered

**Retry a failed Provider call automatically.** A transport error does not prove that GitHub rejected the mutation. An internal or blind Consumer retry can duplicate Issue creation or lose the exact remote precondition that made a later mutation safe.

**Wait for a complete Board scan after every effect.** The polling scan proves one complete Board generation, but it is too broad for stage recovery and may be delayed by rate limits or unrelated Project activity. Targeted inspections provide the smallest evidence needed without weakening checkpoint semantics.

**Publish only an optimistic local card.** Local optimism gives responsive presentation but cannot establish which external stages occurred, detect contradictory GitHub facts, or recover after restart. Durable overlays therefore project the Intent and targeted evidence rather than replace remote confirmation.

**Introduce a generic saga framework and durable Provider result ledger.** The five fixed mutation kinds and two product Intents need explicit stage-specific admission rules, especially for marker ambiguity, membership cardinality, and API order. A generic DSL, semantic fences, facts digests, or Provider-owned durable results would add a second authority without eliminating these checks.

## Consequences

Interactive Create and Move operations remain responsive through durable optimistic overlays while process loss, lost dispatch results, and partial completion have explicit recovery paths. The cost is one durable stage graph plus targeted reads around external effects, and some ambiguous outcomes deliberately require reconciliation instead of automatic progress.

The implementation preserves one complete-scan authority for shared Board generations and adds no parallel synchronization engine. It supports exactly the current Work Item mutations, exposes no exactly-once promise, and leaves broader GitHub writes and generalized Intent orchestration outside this decision.
