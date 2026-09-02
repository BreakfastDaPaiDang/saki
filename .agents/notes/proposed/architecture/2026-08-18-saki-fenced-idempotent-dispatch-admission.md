# Agent Note: Saki fenced idempotent dispatch admission

Status: proposed

English | [中文](2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)

## Problem

Saki must redeliver a durable Execution Dispatch after process loss, a claimant timeout, or a missing Host acknowledgement. A Dispatch Claim can select one current executor, but it cannot by itself prevent an expired claimant from acting late or distinguish an unperformed operation from a lost response after the Host acted. Retrying either ambiguous case as a new start can create a second Agent Run or repeat another external effect.

Dispatch delivery is shorter than the resulting Execution. Holding one claim for an entire Agent Run would delay recovery and overlap the independent Execution Lease that protects writable Resource Bindings. The design needs a short admission claim, a stable Host-side operation identity, and explicit reconciliation without claiming a cross-system transaction.

## Proposal

The Saki dispatch module will implement [ADR 0010](../../../../docs/adr/0010-fenced-idempotent-dispatch-admission.md) as the exact claim and admission protocol under [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.md). Execution Dispatch, Dispatch Claim, Host Operation, Agent Run, and Execution Lease remain separate records with separate completion meanings.

The [implemented structured-Git decision](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.md) provides the direct `control-intent` Host Operation source and the source-general `prepareOperation`, `startOperation`, `inspectOperation`, and `cancelOperation` Host Execution lifecycle. The [manual Give-to-Agent decision](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md) implements Execution Dispatch, Agent Run, and Dispatch Claim records for one `StartAgentRun` path, extends the operation-source union with `execution-dispatch`, and uses long-lived `BindingWriteAdmission.agent-run` ownership. This proposal remains active for generalized dispatch sources, independent Execution Leases, automatic backoff and retry budgets, multi-Dispatch orchestration, and remote admission.

### State and ownership

| Record | Owned fact |
|---|---|
| Execution Dispatch | Intended effect, target Host and Execution, delivery state, attempts, current claim, and accepted Host Operation reference. |
| Dispatch Claim | Current executor, claim id, monotonically increasing fencing token, issuance and expiry, and the dispatch revision used for renewal or acceptance. |
| Host Operation | Host-side idempotency mapping from dispatch id to the prepared operation, intended Execution, payload digest, prepared and accepted fencing tokens, and operation lifecycle. |
| Agent Run | One Agent Execution and its actual Session, Profile, model route, evidence, and outcome. |
| Execution Lease | Exclusive writable ownership of one Resource Binding by the intended Agent Run. |

The Dispatch lifecycle is `pending`, `claimed`, `accepted`, `canceled`, `rejected`, or `reconciliation_required`. `accepted` means delivery has a durable Host Operation receipt. It does not mean the operation started or completed. The last state stops automatic delivery until an attributed reconciliation Control Intent records a proven resolution.

### Admission protocol

1. The control plane persists the dispatch as `pending` before any wake-up. A durable scanner selects records whose `nextAttemptAt` has arrived; an in-process signal only prompts that scan.
2. Claim acquisition compare-and-sets the expected dispatch revision, changes `pending` to `claimed` or replaces an expired `claimed` record, increments the fencing token, and records a bounded expiry. Renewal by the same executor requires an unexpired claim and expected revision and retains the token; reacquisition after expiry increments it.
3. A writable dispatch is ineligible until its intended Agent Run holds the required Execution Lease. Admission also fails closed when cancellation, Grant revocation, Automation Policy, Host enrollment, or capability inventory no longer permits an unstarted effect.
4. `prepareOperation` presents the stable `execution-dispatch` source, intended Agent Run, payload digest, and current claim. The Host validates the claim with the control plane and atomically creates or returns the Host Operation keyed by dispatch id before any external effect. A later valid claim reuses the operation and updates its prepared token; a replay with different immutable inputs returns a conflict.
5. After all awaited Host work, the control plane compare-and-sets the same unexpired claim and persists the operation reference while moving the dispatch to `accepted`. A failed acceptance leaves the prepared Host Operation inert.
6. `startOperation` validates the accepted dispatch, operation reference, fencing token, current cancellation state, and capability-boundary authority before starting or resuming the Host Operation. The call is idempotent by operation reference. Recovery repeats it or calls `inspectOperation`; it never allocates another intended Agent Run.
7. A stale claimant cannot renew, accept, or start. Claim expiry does not cancel an accepted operation or release its Execution Lease. Later inspect or cancel requests use their own Control Intents and current authorization.

### Recovery rules

- A confirmed transient failure before Host preparation releases the claim, records `attemptCount`, `nextAttemptAt`, and `lastError`, and returns the same dispatch to `pending` under configurable backoff.
- A lost acknowledgement first triggers inspection by dispatch id. A matching prepared or started Host Operation reuses the same operation reference.
- Confirmed absence permits a new claim after the prior claim expires. Unknown or conflicting evidence changes the dispatch to `reconciliation_required` and creates an Intervention Request when operator action is required.
- Exhausting the configured retry budget also stops in `reconciliation_required`; no retry limit or delay is a hard-coded plugin constant.
- Cancellation before acceptance advances the dispatch revision and changes `pending` or `claimed` to `canceled`; the Host never starts its inert prepared operation.
- Cancellation after acceptance leaves the dispatch `accepted` and targets the Host Operation or Execution separately, preserving the delivery receipt and resulting cancellation outcome.

The Local Host stores the Host Operation registry durably even though both planes share one process in version 0.1.0. The Host Execution Service Definition exposes prepare, start, inspect, and cancel methods so a later network adapter preserves the same ordering. A remote Host must validate admission online; offline start is not part of this protocol.

## Alternatives considered

**Rely on Dispatch Claim expiry alone.** Expiry transfers eligibility in the control plane but cannot fence a paused claimant at the Host or deduplicate a response lost after an effect. The Host needs the stable dispatch mapping and current-token validation.

**Run the effect inside the control-plane transaction.** `storageDomain` callbacks cannot contain external calls, and future remote Hosts, DSH, Git, and model providers cannot join that transaction. The prepare and acceptance records make the unavoidable split recoverable.

**Use the intended Agent Run id without a Host Operation.** Agent Run identity deduplicates starts but does not provide one general inspection and cancellation reference for Git or other Host dispatch variants, nor does it record whether the Host admitted the request before DSH started.

**Keep a claim until Execution completion.** This merges delivery ownership with long-running execution and Resource Binding ownership, lengthens failure detection, and makes one claim cover unrelated Host Operations.

**Automatically retry every unknown result.** Repetition is safe only when Host idempotency or confirmed absence establishes what occurred. Blind retry converts an observation failure into another potentially paid or mutating effect.

## Acceptance criteria

- The persisted state machine permits only the documented transitions and uses expected revisions for every claim, acceptance, cancellation, and reconciliation mutation.
- Every new claim has a greater fencing token than every prior claim for the dispatch; renewal retains the token and an expired claim cannot renew.
- Host preparation writes or reads one Host Operation keyed by dispatch id before invoking any external capability.
- Exact replay returns the same Host Operation; immutable-input mismatch rejects as conflict and becomes reconciliation work.
- The Host cannot start a prepared operation until the control plane has accepted the same operation reference and fencing token.
- A crash after dispatch persistence, claim, preparation, acceptance, or start recovers through the same dispatch and Host Operation without creating a second Agent Run.
- A lost acknowledgement is inspected before retry; unknown evidence never becomes presumed failure.
- Cancellation before acceptance prevents start, while cancellation after acceptance preserves the dispatch receipt and controls the operation separately.
- Execution Lease validity and Dispatch Claim validity fail independently and neither lifecycle releases the other.
- Local configuration validates claim duration, retry backoff, and retry budget; the plugin contains no deployment-specific hard-coded tunables.

## Risks

The prepare and start split adds a Host Operation state and more crash points, so recovery tests must cover every persisted boundary rather than only the happy path. A Host implementation that performs an effect during preparation or starts without validating accepted fencing violates the protocol; Saki must quarantine the affected dispatch and Resource Binding as reconciliation required. Online validation also means a remote Host cannot start new work during control-plane loss, an intentional availability trade-off that can be reconsidered only with a separate offline delegation and revocation model.
