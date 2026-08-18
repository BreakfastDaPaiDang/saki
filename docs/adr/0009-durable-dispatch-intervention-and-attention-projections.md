---
status: accepted
---

# Persist execution dispatch and intervention; project attention as projections

English | [中文](0009-durable-dispatch-intervention-and-attention-projections.zh.md)

Saki persists each request to create or resume an Execution as an Execution Dispatch and each request for human action as an Intervention Request. A Work Assignment records continuing responsibility, while an Attention Inbox is only a projection of unresolved responsibilities and interventions. DSH runtime queues, live questions, notifications, and product Views do not own these facts.

## Why this decision

Control Intent and Execution Dispatch answer different questions. A Control Intent records which attributed, authorized product change Saki accepted. An Execution Dispatch records how one resulting Execution reaches an enrolled Host and whether that delivery still needs claiming, inspection, retry, or reconciliation. One Intent may update Saki records and create more than one external operation, so treating its lifecycle as the execution queue would couple authorization and effect delivery.

DSH already supplies several narrower mechanisms. Schedule stores reminder state in a Session log but only delivers while the Session is live. Workflow persists observational history while its live run remains holder-owned and cannot resume after restart. The shipped Jobs Provider is process-local. A continuable subagent can cold-resume from a durable Session, but its Agent inbox orders turns for one runtime lineage and is not an offline, authorized Project mailbox. User questions and approvals wait inside an open Agent turn; their audit events do not make the pending request independently answerable after the process disappears.

Saki therefore needs product-level records before it can promise automatic work, restart recovery, future remote Hosts, or a Project Coordinator. Persisting the dispatch before wake-up allows delivery to repeat without losing the accepted work. A stable dispatch identity and bounded Dispatch Claim prevent repeated delivery from creating multiple Agent Runs. That claim is distinct from an Execution Lease: the former selects one consumer for one command, while the latter protects a Resource Binding from concurrent writable Runs.

Human intervention has the same durability requirement. An Agent, automatic policy, provider login, or reconciliation path may need input after the originating process or model turn ends. The request must retain its subject, target, requested decision, blocking scope, status, deadline or escalation policy, and causal references. Notification delivery is not an answer, and timeout never means approval.

Responsibility is separate again. A Work Assignment identifies the human Principal, Agent Identity, or Project Automation Principal expected to carry a Work Item forward. It grants no authority and starts no model call. This allows a Project Coordinator to retain responsibility across replaceable Sessions while individual Agent Runs remain traceable attempts.

## Considered options

**Use the DSH Agent inbox as the Saki work queue.** That inbox orders messages for one live or resumable Agent lineage. It does not represent Project responsibility, Host selection, Grants, dispatch claims, delivery receipts, or offline intervention and would make product ownership depend on runtime parentage.

**Use DSH Workflow or Jobs records as the dispatch authority.** Workflow execution is foreground and not journaled for resume; the shipped Jobs registry is process-local. Both remain useful Execution implementations, but neither can own accepted product work across restart.

**Store pending intervention only in a Work Session.** The Session must retain every model-visible response, but a log entry alone does not provide an independently addressable request, authorized responder, first-valid-response rule, deadline, escalation, or cross-Project operator view.

**Make Attention Inbox entries authoritative queue records.** A copied queue item would create another lifecycle beside its Work Assignment, Intervention Request, Dispatch, or recovery owner. Projection rebuild and refetch preserve one source for each fact and let different users receive different Views without duplicating commands.

**Merge Dispatch Claim with Execution Lease.** The two claims protect different invariants. A read-only Execution still needs fenced, idempotent dispatch admission without a worktree lease, while one writable Run may hold its Execution Lease across several Host Operations after its start dispatch has settled.

**Treat notification delivery or timeout as a response.** A browser, Feishu, or QQ adapter can confirm transport at most. It cannot prove that an authorized subject decided, and automatic approval on timeout would turn an availability failure into authority.

## Consequences

An accepted Control Intent may create a durable Execution Dispatch before any Host wake-up. The dispatch identifies the intended Execution, Host, Project, Work Session, Agent Profile version, resource requirements, Actor and delegated Grant references, and current delivery state. Delivery attempts may repeat, but a consumer must present the current Dispatch Claim and stable dispatch id so the Host creates or resumes the same Agent Run rather than another one. [ADR 0010](0010-fenced-idempotent-dispatch-admission.md) owns claim expiry, retry, fencing, and idempotent Host admission.

An Intervention Request is a durable control-plane record for input, approval, credential authorization, acceptance, conflict resolution, or reconciliation. The first authorized response against the expected revision wins; later responses conflict. A response is a new Control Intent with its own Actor attribution, cannot expand a Grant, and becomes model-visible only through a reconstructable Work Session event or durable reference. A live DSH question or approval provider may present the request, but it is not the persistence owner.

Attention Inbox is a read model over open Work Assignments, Intervention Requests, failed or ambiguous Dispatches, and selected Signals. It is distinct from the Work Management `Inbox` status for unevaluated Work Items. Web, email, Feishu, QQ, and future Agent delivery adapters notify or render the same records without acquiring authority or changing their lifecycle merely by acknowledging delivery.

Version 0.1.0 does not need persistent Agent Identities or a Project Coordinator. It does need durable Execution Dispatches, Host Operator Intervention Requests, and a simplified Host Operator Attention Inbox so manual and automatic work survive restart and stop visibly when they need a person. Later Agent-specific Attention Inboxes reuse the same records rather than adding another queue.
