---
status: accepted
---

# Separate Work Sessions from subagent lineage

English | [中文](0002-work-sessions-and-subagent-lineage.zh.md)

Saki models a Work Session as a durable, user-visible conversation associated with a Work Item, independently of whether DSH runs it as a top-level Session or a continuable subagent. A Project Coordinator is an Agent Identity whose responsibility persists across replaceable Coordination Sessions; DSH `parentSession` lineage records execution provenance and runtime authority rather than permanent product ownership.

## Considered options

Equating one Work Item with exactly one Session would make retries, specialist review, and reassignment overwrite or overload one conversation. Equating a Project Coordinator with one permanent parent Session would strand delegated work when that Session restarts or is replaced, and would make growing chat context the Project's source of truth. Treating every Work Session as an intrinsic subagent would also prevent user-created or externally executed work from using the same product model.

## Consequences

A Work Item may have multiple Work Sessions but designates at most one as primary; Automation Policy governs whether non-primary specialist Sessions may run concurrently. A Work Session can remain addressable across Agent Runs and coordinator replacement; direct human input and coordinator messages retain distinct attribution. DSH continuable subagents are the preferred initial adapter when parent-child coordination is useful, while one-shot or nested subagents remain execution details inside a Work Session. Saki stores the Work Item, assignment, primary-session, and coordination relationships; a DSH session id and `parentSession` remain runtime references and provenance.
