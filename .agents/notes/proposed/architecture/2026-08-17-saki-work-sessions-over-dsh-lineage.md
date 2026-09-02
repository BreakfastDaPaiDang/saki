# Agent Note: Saki work sessions over DSH lineage

Status: proposed

English | [中文](2026-08-17-saki-work-sessions-over-dsh-lineage.zh.md)

## Problem

DSH continuable subagents provide durable child Sessions, parent coordination, independent transcripts, and user interaction while the exact parent is available. Saki needs a user-visible collaboration record that remains addressable when a coordinator Session restarts or is replaced, when a person creates work directly, and when one Work Item needs retries or specialist conversations. Treating DSH `parentSession` as product ownership would make those cases depend on one runtime lineage.

## Proposal

Saki's control plane records Work Session identity, Work Item association, assignment, primary status, and participant attribution independently of DSH Session lineage, following [Agent Operations ADR 0002](../../../../docs/adr/agent-operations/0002-work-sessions-and-subagent-lineage.md). The execution adapter associates each Work Session with a DSH session id and may use either a top-level Session or a continuable subagent; optional `parentSession` data remains execution provenance and runtime authority.

A Project Coordinator is a persistent Agent Identity that operates through replaceable Coordination Sessions. It receives attributed summaries and Signals from Work Sessions and reads durable Project projections rather than retaining every child transcript in one model context. Human messages, coordinator messages, and executing-Agent messages keep distinct sources even when they enter the same Work Session.

The [manual Give-to-Agent decision](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md) creates one primary Work Session with a preallocated top-level DSH Session for each accepted manual start. Multiple Work Sessions, Project Coordinator identity and replacement, concurrent specialist Sessions, autonomous inter-session routing, and promotion of nested execution descendants remain proposed.

## Alternatives considered

**Use DSH parent-child lineage as Saki ownership.** This reuses existing authorization and navigation but ties durable work to one concrete parent Session and cannot represent directly created or externally executed work consistently.

**Require exactly one DSH Session per Work Item.** This makes the initial interface simple but overloads one transcript across retries, reassignment, implementation, and specialist review, and prevents preserving replaced conversations as history.

**Build a separate conversation runtime.** This would give Saki complete lifecycle control but duplicate DSH persistence, model-loop, provider, and subagent capabilities that should remain inherited.

## Acceptance criteria

- One Work Item can retain multiple Work Sessions while designating at most one as primary; concurrency is a separate policy decision.
- Replacing a coordinator Session or the DSH Session associated with a Work Session does not change Work Item identity or delete prior transcripts and run associations.
- A Work Session records distinct human, coordinator, and executing-Agent message attribution.
- The DSH adapter can represent a Work Session with a top-level Session or continuable subagent without changing control-plane semantics.
- One-shot and nested subagents remain inspectable execution descendants without becoming Work Sessions unless the control plane explicitly promotes and associates them.

## Risks

Saki relationships and DSH lineage can drift after crashes or partial writes, so the adapter needs stable identifiers and reconciliation rather than positional tree inference. Promoting Work Sessions into Project views may duplicate DSH's nested subagent navigation unless one view owns each entry point. DSH currently restricts direct continuation of an inactive child when its exact parent is unavailable, so durable user participation may require coordinator recovery or a narrower upstream continuation capability.
