---
status: accepted
---

# Bind each Development Project to one Git worktree

English | [中文](0003-development-project-worktree-ownership.zh.md)

Each Development Project binds one DSH Workspace to one Git worktree. Multiple worktrees from the same repository may be registered as separate Development Projects, but a worktree has at most one active writable Agent Run.

## Considered options

Allowing several Agent Runs to write one worktree would require Saki to infer ownership of unstaged files, index changes, branch movement, and conflicts after the fact. A repository-wide Project would also hide which worktree and Session own a change. One Project per worktree makes location and write ownership explicit while retaining repository-level parallelism through Git worktrees.

## Consequences

Parallel writable Work Items require separate worktrees and therefore separate Development Projects. Read-only Sessions may coexist, but Saki must reject a second writable Agent Run until the first ends or moves to another worktree.
