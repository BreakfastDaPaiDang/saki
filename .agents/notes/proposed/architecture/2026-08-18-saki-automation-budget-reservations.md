# Agent Note: automation budget reservations and attributed usage settlement

Status: proposed

English | [中文](2026-08-18-saki-automation-budget-reservations.zh.md)

## Problem

Automatic mode can start concurrent Agent Runs, model requests, Generation Jobs, GitHub mutations, pushes, and CI-triggering work. Checking usage after completion lets concurrent operations oversubscribe the same allowance and cannot account safely for crashes or ambiguous external replies. Provider quota, subscription, cost, and GitHub Actions telemetry also vary in precision and availability.

## Proposal

Automatic admission requires both the Project Automation Principal's Grants and a current Automation Policy with finite local limits. Before each effect, the control plane atomically creates or reuses an Automation Budget Reservation tied to its Intent or Host Operation. Settlement appends attributed Usage Ledger Entries, releases unused allowance, and leaves ambiguous usage reserved until inspection or intervention.

Version 0.1.0 hard limits concurrent Runs, wall time, model requests, input and output tokens, Generation Jobs and attempts, GitHub mutations, pushes, and Saki-caused CI triggers. Provider-reported units, currency, allowance windows, and observed Actions duration remain typed optional dimensions. Actions minutes are an after-the-fact pause signal; Saki can hard-limit the pushes and dispatches it causes but cannot promise GitHub's eventual billing result.

For each route, policy chooses `pause-on-unknown` or `local-limits-only`. The latter requires all local hard limits to be finite and no observed provider exhaustion or denial; audit retains that provider-wide cost or quota was unknown. A one-time Host Operator exception is an attributed, exact-scope Intent and does not widen the underlying Grant. [ADR 0015](../../../../docs/adr/0015-reserved-automation-budgets-and-usage-ledger.md) owns the record and enforcement semantics.

The supersession audit found no active note owning Saki automation budgeting. DSH token-usage and timeout notes remain evidence mechanisms rather than product budget authority; the proposed [recoverable Control Intents](2026-08-18-saki-recoverable-control-intents.md) and [fenced dispatch admission](2026-08-18-saki-fenced-idempotent-dispatch-admission.md) notes remain independent owners of write admission and delivery safety.

## Alternatives considered

**Count only after completion.** Concurrent admission and crashes make the result unsafe as a limit.

**Convert every resource to one currency.** The inputs are neither uniformly observable nor reliably convertible.

**Treat missing provider telemetry as zero.** Missing data would become unlimited authority.

**Encode quotas in Grants.** This would combine security authority with changing resource windows and counters.

**Refund timeouts.** The external provider may have completed and charged the operation before the reply disappeared.

## Acceptance criteria

- Concurrent admission cannot exceed any hard scope, and replay cannot consume a reservation twice.
- Crash recovery settles confirmed usage, releases confirmed absence, and preserves unknown usage for reconciliation.
- Automatic mode stops visibly on budget, stale required telemetry, deadline, or CI-trigger limits and never turns exhaustion into Done.
- Projections attribute configured, reserved, settled, unknown, and exceptional usage to Project, Work Item, Run, route, and Actor.

## Risks

Conservative reservations reduce utilization while an ambiguous operation awaits recovery. Fine-grained reservations add records and enforcement points to model, generation, GitHub, and Host execution paths. The implementation must keep those points idempotent and must not let an adapter silently skip accounting because its provider lacks billing telemetry.
