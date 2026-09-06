---
status: accepted
---

# Bind each Development Project to one Git worktree

English | [中文](0003-development-project-worktree-ownership.zh.md)

Each Development Project binds one DSH Workspace to one Git worktree. Multiple worktrees from one repository may be registered as separate Development Projects. Independent Agent Runs and Sessions may share one Project and worktree.

## Considered options

One Project per worktree gives commands a stable location and repository identity. Agent attribution belongs to each Run and Session; it does not prove exclusive authorship of files. A lifetime worktree reservation would block ordinary parallel conversations and manual Git operations while leaving editors and external processes free to write the directory. Dispatch idempotency and Git operation checks protect their own effects without imposing that reservation.

## Consequences

Parallel Runs can edit the same files and encounter conflicting changes. Users choose separate worktrees when they need isolation. Direct Git operations retain expected-observation checks, atomic Git publication, and operation-scoped recovery. See the [manual dispatch decision](../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md).
