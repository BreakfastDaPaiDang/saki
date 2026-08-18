---
status: accepted
---

# Coordinate external effects with recoverable Control Intents

English | [中文](0005-recoverable-control-intents.zh.md)

Saki persists every product mutation except bootstrap exchange and logout as an idempotent Control Intent and advances it through a recoverable lifecycle. The two access operations modify only one Installation Access aggregate through their dedicated authentication protocol. Versioned domain records own current facts, an Execution Lease atomically grants one writable Agent Run access to a worktree, and product Views read explicit projections. Version 0.1.0 uses DSH `storageDomain` for these records and does not introduce full event sourcing or a separate transactional database.

## Why this decision

Starting work is not one database write. It can reserve a worktree, create an Agent Run and Work Session association, start a DSH Session, change a GitHub Work Item, and later receive provider or GitHub results. DSH `storageDomain` serializes writes and makes one record update durable before publishing it, but it deliberately provides no cross-record transaction. A sequence of unrelated writes could therefore crash after only part of the state changed, leaving a false In progress item, an unowned Run, or two writers that both believe they own one worktree.

A relational transaction would make several local rows atomic but could not atomically include Git, a DSH runtime, GitHub, or a model provider. Saki would still need idempotency, durable progress, compensation, and reconciliation for external effects. Adding a second persistence abstraction in version 0.1.0 would duplicate DSH storage while leaving the decisive distributed-failure problem unsolved.

A Control Intent makes the incomplete operation explicit. Saki records the requested action and actor before dispatch, uses the Intent id as the idempotency key across capability seams, and records progress as external facts become observable. Restart recovery resumes or reconciles unfinished Intents instead of inferring success from partially updated projections. The UI can distinguish pending, failed, and reconciliation-required work rather than presenting an optimistic state as confirmed.

The one safety fact that must reject concurrent admission is narrower: one worktree has at most one active writable Agent Run. `storageDomain` can enforce that fact with one atomic read-modify-write on an Execution Lease record keyed by the Project's Resource Binding. Other records may converge through the Intent lifecycle without pretending that their updates share a transaction.

## Considered options

**Write each record and call each Provider in sequence.** This has the least initial code but has no durable account of which step committed. Retries can duplicate Runs or remote changes, and a process-local lock disappears exactly when restart recovery needs it.

**Store an entire Development Project as one aggregate record.** One-record atomicity would cover more local facts, but unrelated Work Items, Run history, provider state, and generated assets would contend on and repeatedly rewrite an ever-growing document. It also would not make external effects atomic.

**Add a Saki-specific relational store with multi-row transactions.** This would improve local multi-record commits, but Saki would own another persistence lifecycle, schema path, backup path, and test matrix while still requiring a saga for every external system. Reconsider this only when measured query, scale, or multi-host requirements exceed `storageDomain`, not to avoid designing recovery.

**Use full event sourcing for all control-plane state.** An append-only source can rebuild projections and preserve history, but version 0.1.0 would also need event ordering, replay, schema evolution, projection rebuilds, and external-effect deduplication before the product has stable commands or read models. Durable lifecycle records and existing DSH Session events provide the required traceability with less irreversible infrastructure.

## Consequences

The control plane exposes `SakiAccess` for Access, bootstrap exchange, and logout beside `SakiControlPlane` for Intent submission, protected Projection queries, and invalidation. Bootstrap and logout cannot reach product or external-effect state. Post-commit notifications invalidate projections; they are not a second durable event stream and cannot authorize external work.

Every external adapter must accept stable Intent identifiers and support idempotent dispatch or explicit reconciliation. An adapter returns stable identifiers and ordinary data rather than live process handles or credential contents. A Control Intent that cannot be resolved automatically remains visible as reconciliation required.

Saki does not promise cross-record ACID transactions in version 0.1.0. Each authoritative record identifies its owner and revision, and only one record owns each hard admission invariant. Recovery tests must interrupt work after every durable phase, reopen the store, and prove that Saki neither loses attribution nor starts a second writable Run.
