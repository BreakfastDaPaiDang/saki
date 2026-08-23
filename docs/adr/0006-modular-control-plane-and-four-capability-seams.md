---
status: accepted
---

# Build one modular Saki control plane behind four capability seams

English | [中文](0006-modular-control-plane-and-four-capability-seams.zh.md)

Version 0.1.0 is a plugin-composed modular monolith: Saki-specific packages live under `packages/saki/` in the `@breakfastdapaidang/saki-*` namespace, and one deep control-plane Module contains private Work Management, Agent Operations, Model Supply, and recovery modules. External variation enters through exactly four new capability seams: Host Execution, GitHub, Model Account, and Image Generation. Existing DSH Services remain the interfaces for Sessions, Agents, Workspaces, LLM streaming, credentials, attachments, compaction, skills, jobs, and tools.

## Why this decision

The product rules that start work, reserve a worktree, choose a model account, synchronize GitHub, and interpret evidence must change together while Saki's domain is still forming. Splitting those rules into a package per bounded context would expose orchestration data as public interfaces before its ownership stabilizes and would turn one product transaction into calls across shallow packages. Keeping private domain modules behind one control-plane Interface concentrates authorization, revisions, Control Intent recovery, and Projection construction without merging their domain language.

Host resources, GitHub, provider accounts, and generated-media providers have genuinely different implementations or external protocols, so they earn replaceable seams. DSH already supplies the other required capabilities; wrapping each existing Service in a Saki look-alike would add pass-through interfaces, lose upstream improvements, and make tests exercise wrappers rather than the runtime Saki actually uses.

Saki-owned paths and package names make ownership visible during upstream synchronization. They prevent product packages from appearing to be official `@deepseek-ai/dsh-*` modules, while the single repository still permits atomic updates when DSH interfaces change.

## Considered options

**One public package per Saki bounded context.** This looks architecturally pure but makes cross-context orchestration a public dependency graph before there are independent consumers, deployments, or release cycles. Private modules preserve the language separation without paying that coordination cost.

**Separate control-plane and execution services in version 0.1.0.** This would add RPC authentication, delivery, deployment, and partial-network failure before a second Host exists. The accepted logical separation remains, and a future network adapter can implement Host Execution without moving product rules.

**Implement Saki behavior inside upstream DSH packages.** This would reduce package count but increase merge conflicts, blur ownership, and make the generic harness depend on Saki's Board and Project semantics.

**Create a Saki seam for every DSH Service.** Pass-through wrappers would be shallow Modules with one implementation. Saki instead depends directly on stable DSH Service Definitions and adds a seam only where behavior really varies or an external protocol must be isolated.

**Use one universal external-adapter interface.** Host operations, GitHub mutations, device authorization, and image attempts have different cancellation and observation semantics. Sharing only identifiers, error classes, and reconciliation rules keeps each Interface precise instead of accumulating optional methods and fields.

## Consequences

The control-plane package is a deep Module, not a collection of exported repositories or domain managers. Its public Interface consists of Intent submission, typed Projection reads, and invalidation notification. Internal context modules may split into packages only when an independent consumer, deployment, security lifecycle, or release cadence appears.

Each new capability seam includes a Service Definition, at least one Provider, and a Consumer. Provider-specific packages never own Saki Project semantics, and Web code never calls them directly. The Saki backend reference defines their initial Interfaces and package topology.

Before the first Saki package lands, repository checks and release tooling must recognize the Saki namespace without weakening the existing `@deepseek-ai/dsh-*` rules. Version 0.1.0 keeps Saki packages private unless a separate Saki publication workflow is deliberately added.
