---
status: accepted
---

# Reserve automation budgets before effects and settle them in a usage ledger

English | [中文](0015-reserved-automation-budgets-and-usage-ledger.zh.md)

Automatic mode admits work only when its Project Automation Principal has the required Grants and the current Automation Policy can reserve every applicable hard budget. Each reservation is durable, idempotently tied to the Control Intent or external operation, and settled against attributed usage observations. Missing provider quota or billing data is never interpreted as zero consumption or unlimited supply; a versioned policy explicitly chooses whether stricter locally measured limits may authorize that route.

## Why this decision

A post-run usage counter cannot prevent overspend or excessive concurrency. Several automatic Runs can all observe the same remaining allowance and begin before any of them records actual usage. A process crash or lost provider response also leaves real consumption uncertain. Admission therefore needs atomic reservations before effects and a durable account of settlement, not a dashboard-only estimate.

Grants and budgets solve different problems. A Grant permits an action within a resource scope; it does not decide how often, for how long, or at what resource cost automatic mode may use that authority. Automation Policy applies those limits without enlarging the Grant. A manual Host Operator action may use a separate explicit exception Intent, but it cannot make the automatic Principal silently exceed either mechanism.

Provider subscriptions expose uneven telemetry. DSH can observe request and token usage for completed model calls, while a provider may expose only a stale allowance window, an approximate percentage, or no account usage at all. GitHub can report workflow runs and durations after they occur, but a push may trigger workflows before Saki knows their final billable minutes. A single synthetic dollar counter would hide these differences and make an unavailable number look precise.

## Budget model

### Records and scopes

An Automation Policy is versioned and names applicable limits, windows, pause rules, unknown-usage behavior, permitted delivery actions, and required completion evidence. An Automation Budget Reservation records the policy revision, Actor, Intent or Host Operation, Project, Work Item, Agent Run or Generation Job, Provider Account Profile when applicable, reserved dimensions, expiry, lifecycle, and settlement references. A Usage Ledger Entry records one attributed measurement, estimate, correction, release, or unresolved amount with its evidence source and observation time.

Reservations and ledger entries are Saki control-plane records. DSH Session usage events, GitHub observations, provider Usage Snapshots, Generation Job results, and Host Operation results remain the evidence owners for their respective facts. Corrections append a compensating entry rather than rewriting the observation used by an earlier admission decision.

Budgets may apply per operation, Agent Run, Work Item, Project rolling window, or Provider Account Profile. One reservation may consume several scopes atomically. Project concurrency claims and Resource Binding Execution Leases remain separate records because one limits aggregate automation while the other prevents two writers from sharing a worktree.

### Required version 0.1.0 dimensions

Every enabled automatic-mode policy sets finite local hard limits for concurrent Agent Runs, Run wall time, model requests, input tokens, output-token allowance, concurrent and total Generation Jobs, generation attempts, GitHub mutations, Git pushes, and Saki-caused CI triggers. The policy may additionally limit provider-reported units or currency, observed GitHub Actions duration, and account allowance windows when reliable observations exist.

The local dimensions have different enforcement points. A Run reserves a concurrency slot and deadline before dispatch. Each model request reserves its measured input plus configured maximum output before provider invocation and settles to reported usage afterward. A Generation Job reserves its slot and attempt before submission. A GitHub mutation, push, merge, or workflow-triggering operation consumes its count before dispatch; an ambiguous external result retains the reservation until inspection or intervention resolves it.

GitHub Actions minutes are an observed pause signal in version 0.1.0, not a pre-execution hard guarantee. Saki counts each push or explicit dispatch it can causally attribute as a CI trigger, reads resulting workflow duration when available, and stops further automatic triggers once policy says the observation is too old, unknown, or above its threshold. The release does not claim to predict workflows triggered by external actors or GitHub billing adjustments.

### Admission, settlement, and exhaustion

Control Intent admission resolves the current Grants and Automation Policy, checks mapping and binding health, and atomically creates or reuses the required reservations before persisting an Execution Dispatch or invoking an external capability. Replaying the same Intent or Host Operation reuses the reservation; it does not spend twice. A policy revision affects new reservations and later capability-boundary checks but does not rewrite historical settlement.

At each effect boundary, the Host or capability adapter validates the reservation, fencing or operation identity, cancellation, and current Grant. Settlement releases unused reserved allowance and appends actual usage. A crash recovers prepared reservations by inspecting their linked operation. Confirmed absence releases them, confirmed usage settles them, and an unknown result stays reserved and enters `reconciliation_required` rather than being refunded optimistically.

Reaching a hard limit prevents new automatic effects, requests cancellation at the nearest safe boundary when a Run deadline expires, and creates or updates an Intervention Request with the limiting dimensions and evidence. It never marks the Work Item Done. Automatic Done remains a separately granted and policy-authorized Intent that requires the configured Outcome Evidence.

### Unknown provider usage and manual exceptions

For each route, Automation Policy chooses `pause-on-unknown` or `local-limits-only`. The latter is valid only when all required local hard limits are finite and the latest provider observation does not report exhaustion, denial, or an incompatible entitlement. The resulting audit record states that provider-wide quota or monetary cost was unknown. A policy that names a provider-reported or currency limit cannot reserve that dimension from an absent or stale Usage Snapshot and therefore pauses.

The Host Operator may submit an attributed one-time budget-exception Intent or update the policy revision. A one-time exception names exact dimensions, scope, expiry, and target operation; it does not change the underlying action Grant or authorize descendants. Automatic account rotation intended to bypass provider limits remains prohibited, and an unresolved reservation cannot be escaped by switching profiles.

## Considered options

**Check usage only after a Run.** Concurrent Runs can oversubscribe the same allowance, and a crash can omit the accounting entirely. Reservations move the decisive check before the effect.

**Use one cost number for every provider and operation.** Subscription quotas, tokens, generation attempts, elapsed time, GitHub mutations, and Actions minutes are not reliably convertible to one amount. Typed dimensions preserve what is measured and what is unknown.

**Treat unknown provider usage as zero.** This turns missing telemetry into unlimited authorization. Explicit `local-limits-only` mode permits useful operation under measurable caps while retaining the uncertainty in audit and UI.

**Reserve a whole Work Item estimate once.** Long or exploratory work has poor initial estimates, and reserving the worst case would strand supply. Hierarchical reservations at each effect boundary provide tighter control and more accurate settlement.

**Use Grants to encode quotas.** Grant revisions would then mix security authority with consumption windows and runtime counters. Keeping budgets in Automation Policy allows revocation and budget changes to retain distinct semantics.

**Refund every timeout.** A timeout may follow a successful paid request or mutation. Unknown external outcomes remain reserved until inspection or attributed reconciliation.

## Consequences

Automatic mode has more admission records and may leave capacity unavailable while an ambiguous operation awaits reconciliation. That conservatism buys bounded concurrency, crash-safe accounting, explainable pauses, and a direct answer to which Principal, Project, Work Item, Run, route, and operation consumed a resource.

The Web client needs projections for configured limits, reserved amounts, settled usage, observation age, unknown dimensions, and Intervention Requests. It may summarize these values but cannot infer spend from client counters. Tests cover atomic competing admission, replay, partial settlement, deadline cancellation, stale and absent Usage Snapshots, account exhaustion, ambiguous model and GitHub results, CI-trigger caps, restart recovery, one-time exceptions, and evidence-gated automatic Done.
