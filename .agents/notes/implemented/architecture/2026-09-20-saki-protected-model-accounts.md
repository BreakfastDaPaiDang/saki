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

The [API Provider](../../../../packages/saki/model-account-api/README.md) imports an explicit DSH Models connection into an immutable configuration revision and copies its key into an independently protected record. Source edits do not retarget imported accounts. Its identity denotes a local Profile, not a verified remote account; health and entitlement remain unknown, and quota inspection is unsupported. Provider registration changes trigger reconciliation after startup and remount without repeating authorization.

Project defaults resolve an exact account configuration before publishing a new immutable Agent Profile. A retained Intent owns the resolution and repairs interrupted acknowledgement without repeating provider inspection. Project revision history is validated against published selections; registration history still owns the original Project identity. State v12 adds these records through an adjacent v11 migration and retains the original v11 domain and seal. Account selection, lost acknowledgements, concurrent edits, restart, and historical upgrade journals have focused tests. Work Session switches retain a completed history cut and create an immutable successor Run under the same Assignment. The cut is persisted before Host publication so retries and restart cannot choose another history prefix. Source retirement follows the successor’s publication checks.

Saki-owned Sessions reject generic model selection and cold activation through the Session Controller’s synchronous owner policy. The check runs at mutation commit points and Agent publication, so asynchronous preparation cannot outlive a change of execution ownership. Physical history remains readable. Only the current Run accepts live prompts; historical and transitioning Sessions reject generic execution commands. This keeps generic Conversation controls from bypassing immutable Run attribution.

## Alternatives considered

**Mount the entire community subscription bundle.** This would import account UI, routing, optional external-Agent integration, and credential-storage assumptions beyond the required capability. The maintained public usage helper deletes owned quota parsing without transferring product authority.

**Implement OAuth and Codex transport locally.** This would duplicate actively maintained protocol code. Public pi-ai credential-store, fetch, and response hooks provide the required transaction and request attribution without a transport fork.

**Shared ambient credentials or account pooling.** These cannot preserve an explicit immutable account choice across refresh, concurrent requests, and replacement. Each route owns one protected destination and never falls back to another account.

## Consequences

The integration supports text-only SSE and requires Windows local-user-trust storage in the shipped composition. Library upgrades require renewed authorization/refresh, final-wire, turn-isolation, and usage tests. Keyless tests execute real maintained libraries with controlled external responses; live endpoint entitlement remains an operator-authorized acceptance step. Both subscription and explicit API routes use the same immutable Run selection and attribution.

State v11 adds account tables and Host Operator permissions through an adjacent migration. Historical v10 domains and seals remain independently readable; existing Agent/Host evidence is retained. The broader [capability proposal](../../proposed/architecture/2026-08-18-saki-control-plane-capability-seams.md) remains active for its other unimplemented capabilities.
