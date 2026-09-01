# Agent Note: stable Resource Bindings over canonical worktree observations

Status: proposed

English | [中文](2026-08-18-saki-stable-resource-bindings.zh.md)

## Problem

One worktree may be addressed through path aliases, yet paths and Git administrative locations may also change legitimately. Keying a Development Project or Execution Lease directly by path either admits duplicate writers or makes relocation rewrite product identity. DSH Workspace paths and historical Session cwd values are intentionally immutable, so Saki also cannot move them in place.

## Proposal

Every Development Project and Execution Lease addresses a generated, stable Resource Binding id. Registration of an existing directory combines `fs.realpath`, Git top level, per-worktree Git directory, common Git directory, and `git worktree list --porcelain -z` to create a revisioned observation and reject same-Host aliases. Per-worktree Git directory distinguishes linked worktrees; common Git directory only groups their Repository family. Paths are not lowercased because the filesystem may be case-sensitive.

Binding health is `active`, `missing`, `repair-required`, `needs-rebind`, or `retired`. Mutation admission revalidates the observation and revision. An attributed rebind operation requires execution quiescence, selects an existing directory, advances the Project's DSH Workspace reference, and records operator confirmation when paths cannot prove continuity. Historical DSH Sessions keep their old Workspace and cwd; later turns use a successor Session at the new location.

Version 0.1.0 registers, rebinds, and retires Projects but does not physically create, move, repair, remove, or prune worktrees. Automatic mode requires a clean tree. Manual takeover of existing changes records their bounded fingerprint and attribution limits; any ambiguous mixture keeps automatic staging and completion unavailable. [ADR 0014](../../../../docs/adr/0014-stable-resource-bindings-over-canonical-worktrees.md) owns the lifecycle.

The proposed [domain KV storage and Workspace](2026-07-24-domain-kv-storage-and-workspace.md) note owns DSH Workspace `fs.realpath` uniqueness and immutable records; this proposal owns Saki's higher-level binding identity, Git observation, rebind, and lease semantics. The proposed [Installation maintenance](2026-08-18-saki-forward-migrations-and-installation-maintenance.md) note owns replacement-Host restore and links `needs-rebind` into this lifecycle.

The implemented [existing-directory Project registration](../../implemented/architecture/2026-08-20-saki-existing-directory-project-registration.md) establishes the first stable Project and Resource Binding ids, duplicate worktree identity checks, and startup revalidation. The implemented [structured-Git decision](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.md) revalidates an exact active Binding and its revision for bound status, Diff, and direct mutation, and gives each Binding one durable write-admission owner.

The [manual Give-to-Agent decision](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.md) makes `BindingWriteAdmission.agent-run` the long-lived writable owner for one manual Agent start, so it contends with direct Git operations on the same row. Independent Execution Leases, rebind, retirement, repair, successor Sessions, and physical worktree lifecycle remain proposed.

## Alternatives considered

**Use canonical path as identity.** It prevents aliases only while the location exists and cannot survive relocation or Host replacement.

**Use remote, branch, HEAD, or common Git directory.** Clones can share the first three, ordinary work changes branch and HEAD, and all linked worktrees share the common directory.

**Rewrite Workspace and Session paths.** That would change the historical location facts and violate DSH ownership.

**Manage all physical worktree operations immediately.** Safe creation and deletion expand the Git product beyond the minimum dogfood loop.

## Acceptance criteria

- Alias spellings of one available worktree cannot create two Resource Bindings or leases.
- Two linked worktrees in one Repository remain distinct and may run in parallel under separate bindings.
- Missing, moved, repaired, replacement-clone, dirty, and replacement-Host cases stop or rebind explicitly without rewriting historical Sessions.
- Rebind and retirement cannot race an active writable Run, terminal, Dispatch, or Host Operation.

## Risks

Git supplies no portable Repository identity, so some relocations need explicit human confirmation. Overly permissive confirmation can attach a Project to the wrong clone; Saki must show old and new evidence and keep the Actor record. Deferring physical worktree operations leaves terminal and Git fallbacks in the first release, but avoids destructive behavior before the binding lifecycle is proven.
