# Agent Note: Saki protected Model Accounts

Status: implemented

English | [中文](2026-09-20-saki-protected-model-accounts.zh.md)

## Problem

Subscription integration must survive provider-library upgrades without letting an SDK own product selection, durable authorization identity, or credential protection. Account switching must not mix credentials or reuse another account’s request state.

## Decision

The [Model Account service](../../../../packages/saki/model-account/README.md) defines complete authorization, inspection, and adapter capabilities. The control plane owns Profiles and replayable Intents; the [Codex Provider](../../../../packages/saki/model-account-codex/README.md) composes maintained pi-ai OAuth/SSE and the published subscription usage helper. Exact implementation identity is recorded with each account-route revision. A replacement implementation cannot silently activate an older revision.

Each authorization Intent allocates its own protected credential key. Completion inspects that key, verifies the account owner, commits the Profile, and then acknowledges the Intent. Restart repairs lost acknowledgement by inspection without replaying login. Browser cancellation is independent of Host authorization lifetime. A cancellation racing a committed credential can resolve to completed authorization.

Protected record reads and refresh transactions extend the [DPAPI decision](2026-08-18-saki-local-user-trust-dpapi-credentials.md). They reject unsupported protection before exposing credential material. Product records and browser projections retain no tokens. Usage failures remain unknown and retain the last confirmed observation separately. A model catalog is capability metadata, not evidence of entitlement.

Codex SSE requests capture the selected route, Session id, and logged turn number before asynchronous preparation. The final public fetch hook enforces Harness User-Agent, Saki originator, and Session request identifiers. Response turn state belongs only to that account, Session, and active turn; it is discarded on turn end or disposal. This provider-specific mapping extends the [application attribution decision](2026-06-21-mandatory-app-attribution-headers.md).

## Alternatives considered

**Mount the entire community subscription bundle.** This would import account UI, routing, optional external-Agent integration, and credential-storage assumptions beyond the required capability. The maintained public usage helper deletes owned quota parsing without transferring product authority.

**Implement OAuth and Codex transport locally.** This would duplicate actively maintained protocol code. Public pi-ai credential-store, fetch, and response hooks provide the required transaction and request attribution without a transport fork.

**Shared ambient credentials or account pooling.** These cannot preserve an explicit immutable account choice across refresh, concurrent requests, and replacement. Each route owns one protected destination and never falls back to another account.

## Consequences

The integration supports text-only SSE and requires Windows local-user-trust storage in the shipped composition. Library upgrades require renewed authorization/refresh, final-wire, turn-isolation, and usage tests. Keyless tests execute real maintained libraries with controlled external responses; live endpoint entitlement remains an operator-authorized acceptance step. Agent Run model binding and API-key relay routes remain separate consumers.

State v11 adds account tables and Host Operator permissions through an adjacent migration. Historical v10 domains and seals remain independently readable; existing Agent/Host evidence is retained. The broader [capability proposal](../../proposed/architecture/2026-08-18-saki-control-plane-capability-seams.md) remains active for its other unimplemented capabilities.
