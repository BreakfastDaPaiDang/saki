# Agent Note: Saki manual Give-to-Agent dispatch

Status: implemented

English | [中文](2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)

## Problem

An explicit Give-to-Agent action must start one writable Agent Run without spending model resources merely because a Work Item is Ready. Process loss or a missing acknowledgement can occur between control-plane persistence, Host admission, Session input delivery, and Run confirmation; recovery must not create another Run or insert the original model-visible input twice.

The start also shares a Resource Binding with direct Git operations. A second admission system would allow both paths to believe they own the worktree and would make historical repositories harder to adopt safely.

## Decision

The control plane accepts one manual `give-work-item-to-agent` Intent only after revalidating the Host Operator Grant, the current Ready Issue and remote fingerprint, acceptance criteria, Blockage, active Resource Binding, complete inherited-change evidence, attached branch safety, and Agent Profile, then requiring the current LLM adapter to resolve the exact provider/model route. Route resolution starts no generation; failure records no Intent and returns `model-route-unavailable`. The accepted Intent freezes the complete Issue, Project, Profile, Git precondition, text-only `UserMessage`, and message source under canonical digests.

Acceptance preallocates the Work Assignment, primary Work Session, Agent Run, Execution Dispatch, exact DSH Session, input MessageId, and stable child `MoveWorkItem` Intent. These records and the ordered Run-to-Dispatch association are durable before the Host is woken.

`StartAgentRun` extends the existing Host Operation lifecycle with an `execution-dispatch` source. A short expected-revision Dispatch Claim fences delivery; the same executor can renew an unexpired claim at the expected revision without changing its fencing token. After every awaited Host preparation and admission check, the final Dispatch compare-and-set requires that exact claim to remain current and unexpired. The existing `BindingWriteAdmission` row is the sole writable owner. Its `agent-run` variant names the origin Intent and Agent Run rather than the Dispatch, so direct Git operations and Agent starts contend on the same atomic row and a Run can retain ownership across later Dispatches.

The Local Host creates or resumes the exact DSH Session with the frozen cwd, Agent Preset, and Model Route. Detached physical Session persistence supplies the complete history that classifies the original input as absent, pending, recorded, canceled or replaced, unknown, or conflicting. After acquiring the live Agent, the Host freshly revalidates the writable Git world immediately before either the original `next-turn` insertion or a pending-input wake. Only complete absence permits the original insertion. The Host flushes and re-inspects that insertion; a pending input receives a deterministic model-invisible `next-step` wake, and the Agent pre-step filter removes that Run's wake messages before model assembly. A recorded input confirms success, while canceled, replaced, unknown, or conflicting evidence never permits resend.

Host Operation success means that the intended Agent Run, Session, and exact input are durably confirmed; it does not mean that the model turn completed. Only then does the stable child Intent move the Work Item to In progress. Missing acknowledgements, restart, and exact replay reuse every preallocated id and the same Host Operation. Unknown effect evidence stops in reconciliation required.

Startup first cross-validates the exact running Agent Run, active Binding, and succeeded Host Operation, then asks the Host to restore the live Agent handle from the matching physical Session header and original input. The restored Agent remains model-idle: recovery adds no input, wake, or model request. A mismatch or unavailable live dependency prevents startup readiness.

Cancellation before Dispatch acceptance records a canceled Dispatch; cancellation after acceptance preserves the accepted receipt and records the terminal Host snapshot. The Host stops and drains an owned live Agent before the control plane persists child-Intent cancellation and releases write admission. A disposal failure leaves the operation retryable and the handle tracked. Terminal multi-record updates advance only through valid monotonic prefixes, and startup idempotently completes any retained prefix.

`SakiWorkItemDetailProjection` and `SakiAgentRunProjection` freeze the frontend handoff without adding a query in this slice. Their strict wire schemas expose the bounded parsed Issue definition, Assignment and primary Work Session references, opaque Run source, display-safe Profile and Model facts, timestamps, and explicit resumable, terminal, or reconciliation recovery state; canonical paths, credentials, and Host snapshots are absent.

Current state version 8 carries the manual-Agent records in `saki_control_plane@8`, the `StartAgentRun` Host records in `saki_host_execution@3`, and `saki_storage_generation@6`. Frozen v7/v2/v5 schemas retain the original manual start format. Adjacent migration adds explicit Assignment ownership, Run waiting and resume-pending states, the Intervention table, and the current answer message source without changing retained original-start requests or evidence.

## Alternatives considered

**Add `prepareDispatch` and a second Host registry.** The existing prepare, start, inspect, and cancel lifecycle already owns durable Host idempotency. A parallel registry would duplicate recovery and admission rules.

**Key writable ownership by Dispatch.** A Dispatch is a delivery attempt, while writable ownership belongs to the longer-lived Agent Run. Dispatch ownership would release or reacquire the worktree at the wrong lifecycle boundary.

**Treat an Agent send acknowledgement or claimed inbox entry as delivery.** Either fact can precede durable recording. Explicit flush plus complete-history inspection is required before the control plane may report the Run as started.

**Start when a Work Item becomes Ready or when the Dispatch is accepted.** Ready is eligibility rather than authority, and Dispatch acceptance proves only a prepared Host mapping. The explicit Intent and exact Session evidence keep model spending and In progress state attributable.

## Verification

Keyless assembled tests use the shipped Saki bundle, real Agent, physical Session persistence, system-owned Development Agent Preset, and checkpoint-policy stack with a controllable fake LLM. They prove the configured provider and model, persona, repository instructions, and read, write, and edit tools; exact input and insertion counts; live-Agent registry membership before replay; restoration of the same Session id without another wake or model request; final writable-world revalidation; claim expiry during awaited acceptance; cancellation before and after acceptance; retry after disposal failure; and recovery from every terminal multi-record write prefix. Protocol tests also reject an unresolved exact Model Route before any Agent operation record is retained, then accept the same Intent after the route resolves; they exercise exact replay, stale claims, shared write admission, lost flush acknowledgement, removed or replaced inbox input, and conflicting evidence. Projection contract tests round-trip current and recent Run fixtures and audit their serialized values for Host paths, credentials, and internal snapshots.

## Related proposals

This decision partially supersedes only the manual Ready-to-Run parts of the broader [dispatch and attention](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.md), [fenced dispatch admission](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.md), [recoverable Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.md), [stable Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.md), and [Work Session lineage](../../proposed/architecture/2026-08-17-saki-work-sessions-over-dsh-lineage.md) notes. The [durable Intervention answer decision](2026-08-18-saki-durable-intervention-answer.md) extends this exact Run and admission with later operator input. The proposals remain active because they also cover automatic claiming, additional interactions, generalized effects, rebind and retirement, or multiple Sessions and coordinators.

## Consequences

The manual path starts no model generation before an accepted explicit Intent, preserves one writer across crashes, and can take over an existing repository only after fresh Git and branch-safety evidence. Recovery pays for a multi-record state machine and may require operator reconciliation instead of maximizing availability. Automatic claiming, production provider authorization, credential and account health, additional Intervention kinds, and generalized scheduled dispatch remain outside this decision.
