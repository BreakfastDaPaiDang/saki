# Agent Note: Saki manual Give-to-Agent dispatch

Status: implemented

English | [中文](2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)

## Problem

An explicit Give-to-Agent action must start one writable Agent Run without spending model resources merely because a Work Item is Ready. Process loss or a missing acknowledgement can occur between control-plane persistence, Host admission, Session input delivery, and Run confirmation; recovery must not create another Run or insert the original model-visible input twice.

A Resource Binding identifies a shared directory. A long-lived exclusive Run reservation would prohibit parallel conversations and manual Git work without excluding editors or external processes. Saki therefore attributes execution to each Run and Session without promising exclusive authorship of their files.

## Decision

The control plane accepts a manual `give-work-item-to-agent` Intent after revalidating the Host Operator Grant, exact current Issue identity and remote fingerprint, active Resource Binding, and Agent Profile, then resolving the exact provider/model route. Route resolution starts no generation; failure records no Intent and returns `model-route-unavailable`. The Intent freezes the complete Issue body, Project, Profile, text-only `UserMessage`, and message source under canonical digests. Manual use accepts any task state and free-form Issue text; it requires neither branch protection reads nor clean, attached, or conflict-free Git state. These facts can inform the Agent or an explicit automation policy, but do not authorize or prohibit a human-directed conversation.

Acceptance preallocates the Work Assignment, primary Work Session, Agent Run, Execution Dispatch, exact DSH Session, and input MessageId. These records and the ordered Run-to-Dispatch links are durable before any Host wake-up.

`StartAgentRun` uses the Host Operation lifecycle with an `execution-dispatch` source. A short expected-revision Dispatch Claim selects one delivery; renewal retains the fencing token. Final acceptance requires the exact claim to remain current and unexpired after awaited Host work, then persists its accepted token and Host admission revision together on the Dispatch. Each Run and later answer Dispatch is admitted independently. `BindingWriteAdmission` reserves only direct Git and Branch Push operations, including their unresolved effects.

The Local Host creates or resumes the exact DSH Session with the frozen cwd, Agent Preset, and Model Route. Detached physical Session persistence supplies the complete history that classifies the original input as absent, pending, recorded, canceled or replaced, unknown, or conflicting. After acquiring the live Agent, the Host revalidates Workspace mapping, canonical repository paths, and Git administrative-directory identities immediately before either the original `next-turn` insertion or a pending-input wake. Only complete absence permits the original insertion. The Host flushes and re-inspects that insertion; a pending input receives a deterministic model-invisible `next-step` wake, and the Agent pre-step filter removes that Run's wake messages before model assembly. A recorded input confirms success, while canceled, replaced, unknown, or conflicting evidence never permits resend.

Host Operation success means that the intended Agent Run, Session, and exact input are durably confirmed; it does not mean that the model turn completed. The Work Item retains its user-selected status. Missing acknowledgements, restart, and exact replay reuse every preallocated id and the same Host Operation. Unknown effect evidence stops in reconciliation required.

Startup first cross-validates the exact running Agent Run, active Binding, and succeeded Host Operation, then asks the Host to restore the live Agent handle from the matching physical Session header and original input. The restored Agent remains model-idle: recovery adds no input, wake, or model request. A mismatch or unavailable live dependency prevents startup readiness.

Cancellation before Dispatch acceptance records a canceled Dispatch; cancellation after acceptance preserves the accepted receipt and terminal Host snapshot. The Host stops and drains the owned live Agent before the control plane persists child and Intent cancellation. Disposal failure leaves the operation retryable and its handle tracked. Valid multi-record terminal prefixes remain monotonic and restart completes them idempotently.

`SakiWorkItemDetailProjection` and `SakiAgentRunProjection` freeze the frontend handoff without adding a query in this slice. Their strict wire schemas expose the bounded parsed Issue definition, Assignment and primary Work Session references, opaque Run source, display-safe Profile and Model facts, timestamps, and explicit resumable, terminal, or reconciliation recovery state; canonical paths, credentials, and Host snapshots are absent.

Current state version 10 uses `saki_control_plane@10`, `saki_host_execution@5`, and `saki_storage_generation@8`. Frozen source schemas preserve each retained format. The v9-to-v10 migration validates historical Agent ownership, preserves each admission revision on its Dispatch, clears Agent-owned Binding reservations, and removes Agent Git preconditions and template-derived Issue fields. It recomputes context and Host request fingerprints without changing Session history, input messages, identities, or accepted credentials. Manual Git reservations retain their operation-specific evidence.

## Alternatives considered

**Add `prepareDispatch` and a second Host registry.** The existing prepare, start, inspect, and cancel lifecycle already owns durable Host idempotency. A parallel registry would duplicate recovery and admission rules.

**Reserve the worktree for an entire Agent Run.** Run lifetime includes idle conversation and waiting for answers. Serializing that lifetime blocks useful shared-directory work and offers no filesystem isolation against external writers. Users can choose separate worktrees; Saki retains per-Dispatch authorization, exact replay, and operation-scoped Git checks.

**Treat an Agent send acknowledgement or claimed inbox entry as delivery.** Either fact can precede durable recording. Explicit flush plus complete-history inspection is required before the control plane may report the Run as started.

**Require workflow or Git readiness for manual conversation.** A user may ask the Agent to clarify a free-form Issue, inspect a closed task, or repair a conflicted or detached worktree. Such restrictions block the requested work without isolating files or proving authority. Explicit user intent authorizes delivery; Git mutations enforce their own preconditions when they execute.

## Verification

Keyless assembled tests use the shipped Saki bundle, real Agent, physical Session persistence, system-owned Development Agent Preset, and checkpoint-policy stack with a controllable fake LLM. They prove the configured provider and model, persona, repository instructions, and read, write, and edit tools; exact input and insertion counts; live-Agent registry membership before replay; restoration of the same Session id without another wake or model request; final resource-identity revalidation; claim expiry during awaited acceptance; cancellation before and after acceptance; retry after disposal failure; and recovery from every terminal multi-record write prefix. Protocol tests also reject an unresolved exact Model Route before any Agent operation record is retained, then accept the same Intent after the route resolves; they exercise exact replay, stale claims, independent shared-directory Runs, lost flush acknowledgement, removed or replaced inbox input, and conflicting evidence. Projection contract tests round-trip current and recent Run fixtures and audit their serialized values for Host paths, credentials, and internal snapshots.

## Related proposals

This decision partially supersedes only the manual Give-to-Agent parts of the broader [dispatch and attention](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.md), [fenced dispatch admission](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.md), [recoverable Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.md), [stable Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.md), and [Work Session lineage](../../proposed/architecture/2026-08-17-saki-work-sessions-over-dsh-lineage.md) notes. The [durable Intervention answer decision](2026-08-18-saki-durable-intervention-answer.md) extends this exact Run and admission with later operator input. The proposals remain active because they also cover automatic claiming, additional interactions, generalized effects, rebind and retirement, or multiple Sessions and coordinators.

## Consequences

The manual path starts no model generation before an accepted explicit Intent and preserves exact execution attribution across crashes. Multiple Runs can share one directory, including while another Run waits for an Intervention answer. Concurrent edits can conflict. Recovery may require operator reconciliation; automatic claiming, production provider authorization, account health, additional Intervention kinds, and generalized scheduled dispatch remain outside this decision.
