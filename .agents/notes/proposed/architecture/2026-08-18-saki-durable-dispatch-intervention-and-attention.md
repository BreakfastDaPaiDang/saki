# Agent Note: Saki durable dispatch, intervention, and attention

Status: proposed

English | [中文](2026-08-18-saki-durable-dispatch-intervention-and-attention.zh.md)

## Problem

Saki must start manual and automatic work, recover it after restart, and later deliver it to remote Hosts or persistent Agent Identities. DSH supplies durable Session history and several live execution mechanisms, but none is a product-level work dispatcher. Workflow runs remain foreground and cannot resume after restart; the shipped Jobs registry is process-local; Schedule delivery depends on a live Session; and a continuable subagent's inbox orders turns inside one runtime lineage rather than representing Project responsibility or authorized Host delivery.

Human interaction has a parallel gap. DSH questions and approvals wait inside an open Agent turn. Approval audit events preserve what was asked and decided, but the live answerer owns the pending request. A process loss cannot rely on the old Promise still existing, and the shipped continuation/report paths explicitly provide no durable mailbox, delivery receipt, or offline retry. Saki therefore cannot base restart-safe automation or operator attention on those live mechanisms alone.

## Proposal

The Saki control plane implements [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.md) in addition to the recoverable [Control Intent](2026-08-18-saki-recoverable-control-intents.md) lifecycle. Work Assignment, Execution Dispatch, Dispatch Claim, Intervention Request, and Attention Inbox remain distinct concepts.

A Work Assignment records continuing responsibility for one Work Item. Its assignee is a human Principal, persistent Agent Identity, or Project Automation Principal; the record may remain inside Work Item control metadata until assignment acquires an independent lifecycle. Assignment neither provides a Grant nor creates an Agent Run. Version 0.1.0 can assign manual responsibility to the Host Operator or automatic responsibility to the Project Automation Principal without introducing persistent Agent Identities.

An accepted Control Intent creates an Execution Dispatch before any Host wake-up when its effect requires creating or resuming an Execution. The dispatch records a stable branded id, Intent id, intended Agent Run and Work Session, target Installation and Host, Project and Resource Binding references, Agent Profile version, resolved Model Route reference, limits, immutable Actor attribution, delegated Grant references, payload digest, lifecycle revision, and any stable Host Operation reference. It contains references rather than Host paths, credentials, Agent handles, or provider objects.

Dispatch delivery is at least once. A local scheduler, recovered poller, or future network adapter may present the same dispatch repeatedly. Only a bounded Dispatch Claim with the current revision and fencing value admits one executor, and the Host deduplicates `StartAgentRun` by dispatch id and intended Agent Run id. A lost acknowledgement leads to `inspectOperation` or reconciliation rather than a second Run. Dispatch Claim coordinates command admission; Execution Lease separately protects writable Resource Binding ownership.

The [fenced idempotent admission proposal](2026-08-18-saki-fenced-idempotent-dispatch-admission.md) owns the exact `pending`, `claimed`, `accepted`, cancellation, rejection, and reconciliation transitions. It requires the Host to prepare one durable Host Operation before any effect and the control plane to accept that mapping under the current fencing token before the Host starts it.

The [manual Give-to-Agent decision](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md) implements one explicit Ready-to-Run action with a Work Assignment, primary Work Session, Agent Run, Execution Dispatch, expected-revision Dispatch Claim, shared Host Operation lifecycle, and Binding Write Admission. The [durable Intervention answer decision](../../implemented/feature/2026-08-18-saki-durable-intervention-answer.md) adds text-input Intervention Requests, later answer Dispatches on the same Run and Session, and Principal-scoped Host Operator My Work and Attention projections. Automatic claiming, persistent Agent Identity delivery, notification adapters, and generalized recovery interactions remain proposed.

An Intervention Request is a durable control-plane record with a stable id, kind, Project and subject references, target Principal or role, requested decision or input schema, blocking scope, causal Intent, Dispatch, Work Session, or Agent Run references, current revision, lifecycle state, optional deadline, and escalation policy. Initial kinds cover input, approval, credential authorization, acceptance, conflict resolution, and reconciliation. Notification acknowledgement and request resolution are separate facts, and expiry cannot produce approval.

The first authorized response at the expected revision wins. A response enters through a new Control Intent, obtains its own Actor attribution, and can satisfy a declared condition but cannot grant additional authority. If the response must reach a model, the Work Session receives an attributed, reconstructable event or durable reference. A live DSH question or approval provider may bridge an open request into the current turn. After process loss, Saki resumes through a later attributed turn rather than pretending the suspended tool call survived.

Attention Inbox is a query projection, not a persisted queue. It joins open Work Assignments, Intervention Requests, failed or reconciliation-required Dispatches, and selected Signals for one Principal or Agent Identity. Each entry links to its owning record and exposes available Control Intents; dismissing a notification does not resolve the owner. The name remains distinct from Work Management `Inbox`, which is a Work Item Status.

The implemented manual and Intervention decisions persist Execution Dispatch and Intervention Request records and expose simplified Host Operator My Work and Attention projections. Persistent Agent Identity inboxes, Project Coordinator assignment, cross-Host delivery, Feishu or QQ adapters, and general scheduled work remain later consumers of the same records.

## Alternatives considered

**Extend Control Intent into the only queue and interaction record.** Intent is the accepted attributed command and recovery envelope. Making it also own executor claims, assignment, question schemas, response targeting, and every user View would couple authorization admission to several independently changing lifecycles and make one Intent with multiple effects ambiguous.

**Use DSH Agent inbox events as durable dispatch.** Agent inbox events correlate accepted and claimed messages for a Session. They do not select an enrolled Host, carry Project Grants, reserve a worktree, authorize an offline responder, or survive as unclaimed product work after Agent disposal. Saki consumes them as Execution evidence rather than product commands.

**Use continuable subagents as Project workers.** Continuable children provide durable conversation identity and cold resume under an exact parent lineage. The [Work Session decision](2026-08-17-saki-work-sessions-over-dsh-lineage.md) keeps product ownership independent from that lineage, and the shipped report and settlement paths acknowledge that offline delivery needs a separate addressing, authorization, and replay protocol.

**Persist one Attention Inbox table and treat its rows as work.** This simplifies the first query but duplicates assignment, intervention, and recovery state and forces every View-specific dismissal or ranking change into the command lifecycle. Projections keep each underlying fact with one owner.

**Use notifications as the durable boundary.** A delivery adapter can prove that it sent or displayed a message, not that the authorized target understood or answered it. Notification retry remains useful but cannot settle Intervention Request state.

**Combine Dispatch Claim and Execution Lease.** A dispatch can start a read-only Execution that needs no worktree lease, while one writable Agent Run may retain its Execution Lease across multiple Host Operations after its start dispatch settles. Combining them would either over-lock read-only work or release write ownership too early.

## Acceptance criteria

- A committed Execution Dispatch survives process restart before any wake-up and remains eligible for delivery.
- Repeated delivery of one dispatch cannot create a second Agent Run; a stale or competing Dispatch Claim cannot execute it.
- Dispatch Claim and Execution Lease are observed and tested as separate invariants.
- An unknown Host acknowledgement is inspected or becomes reconciliation required rather than being treated as a failed start.
- An Intervention Request remains answerable after Web reconnect and process restart without relying on an old in-memory Promise.
- The first authorized response at the expected revision wins; stale, duplicate, unauthorized, and authority-expanding responses reject.
- A model-visible intervention response is reconstructable from the Work Session, including its Actor and source reference.
- Attention Inbox can be rebuilt solely from owning records, and notification acknowledgement does not resolve an item.
- Product copy and APIs distinguish Attention Inbox from the Work Item Status named Inbox.
- Version 0.1.0 automatic work either reaches a recoverable Dispatch outcome or produces a visible Intervention Request; it never disappears into a process-local queue.

## Risks

Dispatch safety depends on every Host implementation preserving the preparation, current-fence acceptance, and start ordering in the [admission proposal](2026-08-18-saki-fenced-idempotent-dispatch-admission.md); a protocol-violating adapter can still duplicate effects and must be quarantined for reconciliation. A durable Intervention Request cannot resume an arbitrary provider or tool stack frame; the implemented Host Operator path uses a later attributed Session turn where DSH lacks a resumable continuation. Attention projections may become expensive when they join many Projects, but storing copied inbox rows before this is measured would create a harder consistency problem. Later notification adapters also need deduplication and privacy policy without becoming authorization channels.
