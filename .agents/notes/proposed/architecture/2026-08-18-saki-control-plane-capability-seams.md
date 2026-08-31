# Agent Note: Saki control plane and capability seams

Status: proposed

English | [中文](2026-08-18-saki-control-plane-capability-seams.zh.md)

## Problem

Saki needs one place to coordinate Work Item, Work Session, Agent Run, model-account routing, generation, automation, and recovery rules. It must do so without placing product policy in upstream DSH packages, coupling Web code directly to provider SDKs, or creating a shallow Saki wrapper for every existing DSH Service. The initial package boundary must remain easy to change while the domain is forming and must also preserve a replaceable future remote-Host boundary.

## Proposal

Implement [ADR 0006](../../../../docs/adr/0006-modular-control-plane-and-four-capability-seams.md), [ADR 0007](../../../../docs/adr/0007-single-control-plane-and-enrolled-hosts.md), [ADR 0012](../../../../docs/adr/0012-forward-migrations-and-installation-maintenance.md), and the [version 0.1.0 backend architecture](../../../../docs/saki/architecture/0.1.0-backend.md) as a plugin-composed modular monolith. Saki-owned packages live under `packages/saki/` and use the `@breakfastdapaidang/saki-*` namespace. One deep `saki-control-plane` package keeps Work Management, Agent Operations, Model Supply, and recovery as private modules. It exposes `SakiAccess.readAccess`, `exchangeBootstrap`, and `logoutCurrentSession` beside `SakiControlPlane.submit`, `query`, and `onChanged`; Host API publishes both Interfaces.

Persist a stable Saki Installation identity and a registry of enrolled Saki Hosts. Version 0.1.0 runs one active control-plane writer and one independently identified Local Host in the same process; migration quiesces the old writer, and active-active control planes remain unsupported. Each Host reports a revalidated capability inventory and owns machine-local resource resolution. Resource Bindings and Host operations target a Host identity rather than an implicit local machine.

Add exactly four Saki capability seams for version 0.1.0: Host Execution, GitHub, Model Account, and Image Generation. They share Control Intent identities, stable external references, provider-neutral error categories, cancellation signals, and reconciliation obligations, but do not implement a universal adapter base. Their authorization, cancellation, queuing, natural identity, and outcome-observation semantics are different enough to require precise capability-specific Interfaces.

The implemented [existing-directory Project registration](../../implemented/architecture/2026-08-20-saki-existing-directory-project-registration.md) supplies the read-only Project-selection operation, its Local Host Provider foundation, and the first control-plane Consumer operation. The implemented [structured-Git decision](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.md) extends the same Host Execution seam with bound status, bounded Diff, direct mutations, and durable Host Operations. The implemented [polling-first GitHub synchronization](../../implemented/architecture/2026-08-18-saki-polling-first-github-synchronization.md) supplies the GitHub Service Definition, Product App Provider, recoverable polling Consumer, synchronization configuration, and confirmed Board Projection. The implemented [recoverable GitHub Work Item mutations](../../implemented/architecture/2026-08-16-saki-recoverable-github-work-item-mutations.md) add typed writes, targeted inspections, and the recoverable CreateWorkItem and MoveWorkItem Consumer. This note remains proposed because automated dispatch-sourced Host operations, remaining GitHub writes and mapping repair, and the Model Account and Image Generation seams are not implemented.

Use existing DSH Services directly for Workspace, Session, Agent, LLM, compaction, credential references, attachments, live jobs, skills, files, shell, terminal, sandbox, and tools. Add no pass-through wrapper unless the product needs behavior the DSH Interface does not express. A generally reusable missing behavior belongs upstream or in a generic DSH Provider before it becomes Saki-specific.

Route canonical Saki control state through `storageDomain` to a dedicated SQLite database. Generic opt-in schema migration remains owned by `storage-domain`; the `installation-maintenance` product plugin owns Saki-specific generation switching, Recovery Backup, and exact B03 upgrade under the [implemented maintenance decision](../../implemented/architecture/2026-08-26-saki-manifest-selected-installation-maintenance.md). Encrypted Installation Export, restore, retention, and replacement-Host recovery remain in the [active portability proposal](2026-08-18-saki-forward-migrations-and-installation-maintenance.md). This ownership split adds no fifth external capability seam.

Expose only the public `SakiAccess` and `SakiControlPlane` operations through Host transport. Host API takes the presented cookie from HTTP state and uses a package-private SakiAccess resolver available only to that trusted Consumer to construct `AuthenticationContext`; the resolver and context are never wire APIs. It passes that context explicitly to every protected `query(authentication, query, signal)` and `submit(authentication, intent, signal)`, which revalidate Browser Session, Installation generation, Principal lifecycle, and current Grant scope and revision. Bootstrap exchange and logout are the only product mutations outside Control Intent and modify only the Installation Access aggregate. Principal or Grant changes invalidate affected Projections. The Web client does not receive Provider objects, storage handles, required local paths, live DSH handles, secrets, or provider-specific response objects. A future remote Host implements Host Execution without acquiring Work Item, policy, model-selection, or recovery ownership.

Treat installed Cordis and npm plugins as privileged Host code, not sandboxed extensions. Dynamic model-generated plugins remain ephemeral until an operator reviews and installs them. Raw credential values remain inside capability Providers on the target Host; the control plane stores opaque references and observations. The [implemented DPAPI credential decision](../../implemented/architecture/2026-08-18-saki-local-user-trust-dpapi-credentials.md) refines this rule for 0.1.0 without claiming same-user Agent isolation. Browser clients, GitHub users, repository content, model output, and external event payloads remain outside the Host trust boundary.

## Alternatives considered

**A public package per bounded context.** This prematurely publishes orchestration dependencies while the product model is still changing. Private modules retain separate language and ownership without turning them into shallow network-shaped interfaces.

**Separate services immediately.** This adds RPC identity, transport delivery, partial-network failure, and deployment work before a second Host exists. Logical plane separation plus Host Execution preserves the later option.

**Make the control plane, current process, and Local Host one identity.** This embeds machine location in portable product state and leaves backup restoration, Host replacement, and remote execution without a stable ownership boundary.

**Support active-active control planes from the first version.** This requires distributed fencing, leader election, conflict resolution, and external-effect coordination before a second deployment target exists. One active writer makes current ownership explicit without blocking a later design.

**Implement Saki inside upstream DSH packages.** This blurs ownership, increases synchronization conflicts, and makes a generic harness depend on Saki Project and Board policy.

**Wrap every DSH capability.** Pass-through wrappers hide the actual runtime used in production, increase maintenance, and reduce the value of upstream contract tests.

**One universal provider interface.** A common interface would need optional methods for device authorization, long-running generation, local process cancellation, GitHub natural-resource reconciliation, and worktree mutation. Small shared types plus four complete seams are more testable and harder to misuse.

## Acceptance criteria

- Every product mutation except bootstrap exchange and logout enters through `SakiControlPlane.submit` and has one durable Control Intent before an external effect; the two access exceptions mutate only Installation Access through `SakiAccess`.
- Control-plane tests replace dependencies only at the four Saki capability seams; existing DSH Services use their real definitions or their upstream test Providers.
- Each seam lands as a complete Definition, Provider, and Consumer slice rather than an unused abstraction.
- No public Interface or wire payload exposes storage handles, required Host paths, live DSH handles, secret values, or provider SDK response objects.
- Credential-bearing Providers expose only references and safe protection observations outside privileged Host consumers; organization account sharing remains blocked until a stronger brokered boundary is accepted.
- Installation and Host identities survive restart; a Resource Binding names its Host and cannot obtain execution authority through browser reachability alone.
- Installation maintenance can migrate a candidate state generation, publish exactly one active generation, and restore a portable export without exposing storage backends or machine authority through the control-plane Interface.
- The Web surface binds to loopback by default, and tests classify installed plugins as privileged code while keeping repository, model, browser, and external-event data untrusted.
- The Local Host Provider can later be replaced by a transport-backed Host Execution Provider without moving product policy out of the control plane.
- Repository package-governance and release tooling explicitly understands `@breakfastdapaidang/saki-*` before the first package is accepted.

## Risks

A modular monolith can decay into one undifferentiated package if private module ownership and dependency direction are not enforced. Contract suites for the remaining dispatch-sourced Host operations, GitHub capabilities beyond Work Item Create and Move, and Model Account and Image Generation seams must drive refinement without leaking provider quirks into product types. The Saki namespace also crosses existing repository assumptions that every package is official `@deepseek-ai/dsh-*`; missing one governance or release check could create inconsistent local and CI behavior. A single active writer makes Host migration operationally explicit but gives up automatic control-plane failover; generation switching adds maintenance and disk costs; and every installed third-party plugin joins the Host trust boundary until a genuine process sandbox exists.
