# Agent Note: Saki durable Intervention answers

Status: implemented

English | [中文](2026-08-18-saki-durable-intervention-answer.zh.md)

## Problem

An Agent can require an operator decision after its original browser connection or Saki process has disappeared. DSH question and approval services intentionally bind their pending answer to a live turn, so retaining their Promise cannot provide restart-safe product work. Saki also cannot treat a notification, dismissal, timeout, or transport acknowledgement as the answer, because none proves that the current authorized Principal supplied the requested input.

The answer must become reconstructable model input without creating another Agent Run, Work Session, write admission, or command queue. A crash can occur between recording the question, completing its tool turn, accepting an answer, appending the answer to the Session, and confirming the resumed Run, so each partial state needs one unambiguous recovery path.

## Decision

The Development Agent uses the Saki-owned `request_intervention` tool for restart-safe operator input. The tool first commits or exactly reuses an `opening` Intervention Request identified by the Agent Run and branded Tool Call id. Only that durable success calls `exec.concludeTurn()` and returns the stable Intervention id; rejection throws and leaves the turn unconcluded. The tool waits for the canonical success result and balanced turn to flush before asking the control plane to continue the opening. A transient finalization failure schedules one configurable local wake-up; success or durable phase ownership removes it, so recovery does not depend on another Session event and does not introduce a queue.

The control plane inspects the exact durable tool name, question argument, result, step, and turn through the Local Host. Confirmed evidence first changes the owning Agent Run from `running` to `waiting` with the Intervention as its exclusive blocker, then changes the request to `open`. A crash between those writes retains a valid prefix that startup completes. Missing, incomplete, or conflicting evidence found during startup becomes `reconciliation-required`; it never becomes an open question merely because time passed.

The Local Host may execute an exactly accepted input before the control plane records completion of that delivery. An opening may therefore coexist with `starting`, or with `resume-pending` and its answered predecessor, only under the exact accepted Dispatch and write-admission prefix. It becomes the blocker only after the predecessor resolves and that input delivery completes. At most one successor opening may occupy this handoff; the handoff is not a queue, and every other overlapping request is rejected.

`intervention_requests` owns the question independently of the Agent turn. The v8 record is an Agent-requested text input whose owner, subject, blocking scope, and return address all name the exact Agent Run; its cause names the same Run and Work Session plus the physical Session and branded Tool Call id. It also retains the Project, target Principal, bounded well-formed text requirement, revision, timestamps, and lifecycle state. The return address contains stable product ids rather than paths, credentials, browser drafts, or provider objects. The format does not encode generalized subjects, dispatch-owned recovery requests, deadlines, or escalation policy.

An answer is a separate `answer-intervention` Control Intent carrying the expected Intervention revision. The authenticated request supplies no Actor or Grant fields; the control plane derives immutable Actor attribution and rechecks the current Principal, target, Grant, Assignment, Work Session, Resource Binding revision, retained Run write admission, and operation conditions. One Intervention compare-and-set selects the first authorized exact-revision answer. Exact replay returns the same receipt, while changed, stale, unauthorized, oversized, or ownership-changing input cannot replace the winner.

## Delivery and projections

An accepted answer reuses the owning Run's durable `RunInputPlan`. It derives a stable MessageId and a new ordered Execution Dispatch, moves the blocked Run to `resume-pending`, and retains the original long-lived `agent-run` write admission. The ordinary `StartAgentRun` Host Operation appends the attributed answer as a new user message to the same Agent Run, Work Session, and physical Session. The Local Host flushes and inspects that exact message before reporting success. Only confirmed delivery returns the Run to `running`, clears its blocker, and resolves the Intervention; every resolved historical answer retains its own accepted Dispatch and exact succeeded Host evidence. Unknown or contradictory evidence requires reconciliation, and startup completes the exact crash prefix where the answer Dispatch and Run reached reconciliation before their Intervention.

My Work and Attention are pure Principal-scoped projections over current Projects, synchronized Work Items, Assignments, Runs, Dispatches, Grants, Bindings, and Interventions. They have no inbox table or global inbox revision. My Work assigns one of four presentation groups and at most one reasoned Action Offer to each item. An active or recovering Run takes precedence over a newer unaccepted Give prefix, and a bare assigned/allocated/pending prefix does not become current work. Locally available facts may produce a candidate offer without network work, but the offer is not authority and submission repeats the live authorization and operation checks. In-review work exposes no acceptance action before that action exists; Done and Canceled work exposes no acceptance offer.

Only `open` Interventions expose an answer offer and required response. A reconciliation-required Intervention remains visible as a warning without an executable answer. Notification delivery, reconnect, dismissal, timeout, acknowledgement, and client-owned draft changes do not mutate Intervention state.

## Alternatives considered

**Keep a live DSH question Promise across reconnect.** A live provider can collect an answer while its turn exists, but process loss destroys the pending continuation and cannot establish durable product ownership.

**Persist an Attention Inbox queue.** Copied inbox rows would duplicate the authoritative Assignment, Dispatch, and Intervention lifecycles and introduce another revision and recovery protocol. Derivation keeps mutation authority with the owning records.

**Resume the suspended tool frame or create a replacement Run.** DSH does not persist arbitrary JavaScript continuations, and a replacement Run would split the Work Session and write ownership. A later attributed user message preserves the existing Session history and ordinary Run-start idempotency.

**Let notification acknowledgement or timeout settle the request.** Those events describe delivery or elapsed time, not an authorized answer. Treating either as approval would permit silent privilege expansion.

## Verification

Keyless product and protocol tests cover opening flush and retry order, exact question and result inspection, both orderings of initial and answer-input delivery against an immediate Intervention request, restart and reconciliation prefixes, per-answer Dispatch evidence, first-writer answer selection, stale and revoked authority, timeout and notification independence, current return addresses, same-Session answer reconstruction, Host replay, concurrent Give projection prefixes, and My Work and Attention derivation through the typed Host API. Historical schemas remain frozen while adjacent migrations add the Intervention table and current answer message source.

## Related proposals

This decision partially implements the Intervention, response-delivery, and Host Operator projection portion of the broader [durable dispatch and attention proposal](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.md). The [manual Give-to-Agent decision](2026-08-18-saki-manual-give-to-agent-dispatch.md) owns the original Run, Dispatch, Session, and write-admission lifecycle. Automatic claiming, persistent Agent Identity delivery, notification adapters, and generalized recovery interactions remain proposal-owned. Selected durable Git, pull-request, and CI observations remain producer-owned and join these projections through [follow-up #74](https://github.com/BreakfastDaPaiDang/saki/issues/74); no generic Signal aggregate exists ahead of those producers.

## Consequences

Operator questions survive browser and process loss, retain one authoritative answer, and re-enter the exact model-visible Session without a second queue or execution identity. The cost is an additional durable aggregate, adjacent state migrations, and explicit reconciliation for ambiguous partial effects. The design deliberately gives up resuming arbitrary live stack frames and performing network-dependent eligibility checks during projection reads.
