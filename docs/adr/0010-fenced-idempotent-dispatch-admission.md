---
status: accepted
---

# Use fenced claims and idempotent Host admission for dispatch

English | [中文](0010-fenced-idempotent-dispatch-admission.zh.md)

Saki delivers an Execution Dispatch at least once, but admits it through a bounded Dispatch Claim and one durable Host Operation keyed by the stable dispatch id. The Host prepares that mapping before any external effect, the control plane accepts it only under the current fencing token, and the Host starts it only after that acceptance. This guarantees one intended Agent Run identity per dispatch without claiming exactly-once execution across process or network failures.

## Why this decision

A durable dispatcher must repeat delivery after a crash or lost acknowledgement. Claim expiry alone does not make repetition safe: a slow claimant can resume after another executor acquires the work, and a reply can disappear after the Host has already acted. Treating either timeout as proof of failure can therefore create a second Agent Run or repeat a paid or mutating operation.

The dispatch lifecycle and the resulting operation lifecycle also answer different questions. Dispatch acceptance proves that the Host durably associated the command with one Host Operation. It does not prove that the operation started, that an Agent Run completed, or that its outcome passed acceptance criteria. Those later facts remain on the Host Operation, Execution, Agent Run, and Outcome Evidence records.

Saki consequently uses at-least-once delivery with idempotent admission. The guarantee is not exactly-once external effects. It is that every repeated presentation of the same dispatch converges on one Host Operation and one intended Agent Run identity, while an outcome that cannot be established stops for reconciliation instead of being guessed.

## Protocol

### Dispatch lifecycle

| State | Meaning |
|---|---|
| `pending` | No Host Operation has been accepted; the dispatch becomes claimable at `nextAttemptAt`. |
| `claimed` | One unexpired Dispatch Claim may prepare Host admission. |
| `accepted` | The Host Operation mapping and its control-plane receipt are durable; dispatch delivery is complete, not Execution completion. |
| `canceled` | A Control Intent canceled delivery before acceptance, so no prepared operation may begin. |
| `rejected` | The Host definitively refused admission; a corrected request requires a new Control Intent and dispatch. |
| `reconciliation_required` | Automatic delivery stopped because admission or absence could not be proved, or the configured retry budget was exhausted. |

`accepted`, `canceled`, and `rejected` are delivery-terminal states. `reconciliation_required` is terminal for automatic delivery but may be resolved by an attributed Control Intent to `accepted`, `canceled`, `rejected`, or `pending` when evidence establishes a safe outcome.

### Claim and Host admission

1. A scanner atomically claims an eligible `pending` dispatch or replaces an expired `claimed` record using its expected revision. Each new claim increments a monotonic fencing token and records a claim id, executor id, issuance time, expiry, and updated dispatch revision.
2. The same executor may renew an unexpired claim with the expected revision without changing its fencing token. An expired claim cannot renew; reacquisition creates a higher token. The control plane is the time and validity authority, so a future remote Host cannot admit work from its local clock alone.
3. The claimant asks the target Host to prepare the dispatch. The Host validates the current claim with the control plane, then atomically creates or reads a Host Operation keyed by dispatch id before invoking DSH, Git, a model, or another external capability. An exact replay or a later valid claim returns the same operation reference and records the latest prepared token; a different payload digest or intended Execution for that dispatch is a conflict.
4. The control plane accepts the Host Operation reference with a compare-and-set against the current unexpired claim. It rechecks cancellation, delegated authority, applicable Automation Policy, and any required Execution Lease, then moves the dispatch to `accepted`.
5. The Host starts or resumes the prepared operation only after validating the accepted dispatch, operation reference, fencing token, current cancellation state, and authority required at that capability boundary. Start is idempotent by Host Operation reference. A prepared record whose acceptance failed remains inert and may be reused by a later valid claimant or garbage-collected after the dispatch reaches a terminal state.
6. Claim expiry, release, or replacement invalidates the prior claimant but does not cancel an accepted Host Operation, stop its Execution, or release its Execution Lease. Operation control uses separately authorized inspect and cancel Control Intents.

### Retry, recovery, and cancellation

Persisted `attemptCount`, `nextAttemptAt`, and `lastError` drive configurable backoff; an in-process notification only wakes the authoritative scanner. A transient failure confirmed before Host preparation can release the claim and return the same dispatch to `pending`. Retry never creates a new dispatch identity.

After a lost prepare or acceptance acknowledgement, Saki inspects by dispatch id before retrying. A matching Host Operation completes or confirms admission through the same mapping. Confirmed absence permits reacquisition after the prior claim expires. Conflicting evidence, an unavailable inspection path, or a Host that cannot prove absence moves the dispatch to `reconciliation_required`; Saki does not infer failure from silence.

Cancellation before acceptance moves `pending` or `claimed` to `canceled`, advances the dispatch revision, and prevents a prepared operation from starting. Cancellation after acceptance leaves the dispatch `accepted` and targets the Host Operation or Execution through another Control Intent, preserving the fact that delivery occurred.

A writable dispatch is not claimable until its intended Agent Run holds the required Execution Lease. Claim expiry never releases that Lease. Manual and automatic starts use the same protocol; Automation Policy changes who may submit the originating Intent, not the safety properties of delivery.

## Considered options

**Claim exactly-once delivery.** A transaction cannot span the control-plane store, a future remote Host, DSH, Git, and model providers. Calling the result exactly once would hide ambiguous effects rather than remove them.

**Let a claimant start the effect immediately after obtaining a claim.** A claimant can pause beyond expiry and act after another executor recovers the dispatch. A fencing token without Host-side admission and validation does not close that race.

**Hold the Dispatch Claim for the complete Execution.** Agent Runs may last far longer than dispatch admission, and one Run may perform several Host operations. Long claims delay recovery and duplicate the separate Resource Binding invariant already owned by Execution Lease.

**Create a new dispatch for each retry.** A new id destroys Host deduplication and makes a lost acknowledgement indistinguishable from a new requested effect. Retry metadata belongs to the stable dispatch.

**Treat timeout or a missing acknowledgement as rejection.** Silence cannot distinguish no effect from a lost reply after preparation or start. Inspection and explicit reconciliation preserve the uncertainty instead of turning it into duplicate work.

## Consequences

The Host Execution interface needs separate prepare, start, inspect, and cancel operations backed by a durable Host Operation registry. Version 0.1.0 may keep both records in one process and storage implementation, but it preserves their logical ownership and ordering so a remote Host can implement the same protocol later.

Remote Hosts must contact the control plane when admitting new work and cannot begin a prepared operation while disconnected. This deliberately gives up offline start in exchange for current cancellation, Grant, Automation Policy, Lease, and fencing checks. Already accepted operations may continue under their own Execution and Lease rules.

Crash tests cover persistence before claim, after claim, after Host preparation, after control-plane acceptance, and after operation start. A stale claimant, payload conflict, late receipt, or protocol-violating Host result becomes visible reconciliation work and cannot silently create another Agent Run.
