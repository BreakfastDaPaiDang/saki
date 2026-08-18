# Agent Note: Saki recoverable control intents

Status: proposed

English | [中文](2026-08-18-saki-recoverable-control-intents.zh.md)

## Problem

One Saki action can change local control-plane records and invoke DSH, Git, GitHub, or a model provider. The existing `storageDomain` interface serializes a domain's writes and makes one record update atomic, but it has no cross-table transaction. External systems could not join such a transaction even if Saki added one. Naive ordered writes would leave ambiguous partial state after process termination and could duplicate external work on retry. The Intent must also preserve who exercised which authority without trusting client attribution, equating an Agent Run with a security identity, or letting later Grant changes rewrite history.

## Proposal

The Saki control-plane Module implements [ADR 0005](../../../../docs/adr/0005-recoverable-control-intents.md), [ADR 0008](../../../../docs/adr/0008-principals-grants-and-actor-attribution.md), and [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.md) through one write interface that accepts an idempotent Control Intent request plus trusted authentication context. The control plane resolves the Principal, evaluates current Grants and Automation Policy, and derives an immutable Actor; caller-supplied Actor or Grant fields cannot confer authority. The envelope records a branded Intent id, Actor, Grant revisions, submission time, optional expected revision, Project scope, and a closed payload union. Reusing one id with the same payload returns the recorded receipt; reusing it with different content rejects.

Principal and Grant remain durable versioned records. A Grant names its issuer, subject, actions, resource scope, validity, delegation limit, optional parent, revision, and revocation state. A Project using automatic mode acts through its own Project Automation Principal and requires both Grants and a satisfied Automation Policy. A one-off Agent Run receives a parent-subset delegation without becoming a Principal; a durable Agent Identity may receive its own Grants. Ambient DSH initiator or Session lineage remains provenance, not authority, consistent with the [Agent initiator scope](../../implemented/architecture/2026-07-15-agent-initiator-scope.md).

Revocation blocks new Intents, new delegation, and any not-yet-started external effect that requires the revoked Grant. Inspection, cancellation, reconciliation, and compensation remain available for an effect that may already have occurred. Active Host capability boundaries check the current Grant revision rather than treating the Intent's historical Actor snapshot as permanent authority.

The Module persists the Intent before crossing a capability seam. Intent lifecycle records distinguish prepared, reserved, dispatched, waiting, completed, failed, canceled, and reconciliation-required outcomes. Each external adapter receives the Intent id, returns stable external identifiers and plain data, and supports either idempotent redispatch or inspection sufficient for reconciliation. External calls never run inside a `storageDomain` update callback.

When an accepted Intent requires creating or resuming an Execution, the control plane persists a separate Execution Dispatch before waking a Host. Dispatch delivery, claims, Host operation identity, and recovery belong to the [durable dispatch proposal](2026-08-18-saki-durable-dispatch-intervention-and-attention.md), while the Intent continues to own authorization, attribution, and the requested product mutation. An Intent waiting for human input links a durable Intervention Request; Attention Inbox derives that pending work and never becomes another command owner.

An Execution Lease record keyed by Resource Binding owns the single hard admission fact for writable work. Its atomic read-modify-write either grants one Agent Run the worktree or reports the current holder. The Intent is written before lease acquisition; a crash between those writes leaves a retryable prepared Intent, while a crash after acquisition leaves the Intent id and proposed Run facts on the Lease so recovery can finish or release it without admitting a competing writer.

Principal, Grant, Development Project, Work Item control metadata, Work Session, Agent Run, Provider Account Profile, Context Policy, Generation Job, Control Intent, and Execution Lease remain separate versioned records. Each record has one owning module and identifies cached external facts by source and observation time. Cross-record links converge through Intent recovery; no code claims that several records committed atomically.

The control-plane Interface exposes Intent submission plus explicit Project, Work Item, Agent Run, and Model Supply projections. Post-commit change notifications carry identifiers and invalidation scope so clients refetch projections; they are not durable commands or an event-sourced fact log. Per-Project in-process serialization reduces contention but does not replace persistent revisions, Intent recovery, or Execution Leases.

Startup recovery scans non-terminal Intents and occupied Leases before accepting automatic work. It redispatches only when the adapter contract makes the operation idempotent, otherwise it inspects the external identifier. Missing or contradictory evidence moves the Intent to reconciliation required and keeps the affected resource unavailable until a person or deterministic repair resolves it.

## Alternatives considered

**Sequential multi-record CRUD.** It has no durable commit marker for the whole action and cannot distinguish “dispatch never happened” from “dispatch succeeded but the acknowledgement was lost.” Retrying either assumption can lose or duplicate work.

**One Development Project document.** It uses the available single-record atomicity but couples unrelated update rates, grows without a useful bound, and turns every history or provider change into a Project-wide rewrite. It still cannot commit external work atomically.

**A Saki relational transaction layer.** Multi-row transactions improve only local commits. GitHub, DSH Sessions, Git, and providers still require durable dispatch and reconciliation, while the new layer creates a second schema, migration, backup, and adapter lifecycle beside DSH storage.

**Full event sourcing.** It preserves every transition but adds event versioning, ordering, replay, projection recovery, and effect deduplication before Saki's commands and projections stabilize. Existing Session events remain authoritative for model-visible history; control-plane lifecycle records supply product traceability without making every domain object an event fold.

**Process-local mutexes only.** They can serialize one running process but vanish on restart and cannot explain an already dispatched external effect. They remain an optimization, never the source of admission truth.

**Trust Actor or permission fields from the caller.** A browser, Agent, webhook, or adapter could claim another identity or omit delegation. The trusted control plane derives attribution and authority from authentication context and durable Grants.

**Use Automation Policy as authority.** Policy owns eligibility, budgets, and evidence, but making it the permission record would let a trigger edit grant Host access. A Project Automation Principal needs both an explicit Grant and satisfied policy.

**Create a Principal for every Agent Run.** Disposable Runs have no independent continuing identity and would produce meaningless durable security records. Parent-subset delegation records their authority without confusing attempt identity with security identity.

## Acceptance criteria

- Repeating an Intent id with identical content never creates a second Agent Run, GitHub mutation, or Generation Job; conflicting reuse rejects.
- One Resource Binding never grants two active writable Agent Runs, including across restart and recovery.
- Crash-injection tests stop after each persistent lifecycle transition and prove deterministic resume, failure, or reconciliation-required behavior after reopening storage.
- A lost adapter acknowledgement is resolved by stable external identity or becomes visibly reconciliation required; it is never assumed to have failed.
- A committed Execution Dispatch or Intervention Request survives restart independently of any live Agent, scheduler, browser connection, or pending Promise.
- Product Views distinguish requested, externally observed, completed, failed, and reconciliation-required states without treating `domain/changed` as durable evidence.
- A client cannot obtain authority by supplying Actor, Principal, Grant, Session-lineage, or GitHub-membership claims; accepted Intents record the control-plane-derived Actor and exact Grant revisions.
- Grant revocation rejects new Intents, delegation, and undispatched effects while preserving safe inspection, cancellation, reconciliation, and compensation.
- Automatic work requires a Project Automation Principal, an explicit Grant, and a satisfied Automation Policy; one-off Agent Runs receive only parent-subset delegations.
- No control-plane Interface exposes a storage handle, Host path, live DSH handle, provider token, or adapter-specific response object.

## Risks

Recovery logic can become a distributed state machine spread across adapters unless the control-plane Module owns lifecycle transitions and adapters expose only dispatch and reconciliation facts. Grant checks at active capability boundaries add revocation propagation and race handling; tests must distinguish an undispatched effect from one whose outcome is unknown so revocation never causes unsafe blind retry. Mutable lifecycle records do not provide an immutable global audit log, so any later compliance requirement may require an append-only journal. A single-process `storageDomain` and per-Project queue do not support active-active control planes; multi-Host control-plane execution requires a new lease and consistency mechanism rather than extending the local assumption silently.
