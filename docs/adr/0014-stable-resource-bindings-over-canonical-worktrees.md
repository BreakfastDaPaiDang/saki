---
status: accepted
---

# Keep Resource Binding identity stable across worktree location changes

English | [中文](0014-stable-resource-bindings-over-canonical-worktrees.zh.md)

A Development Project and every Execution Lease address one stable Resource Binding id. A local binding stores a revisioned observation of its DSH Workspace and Git worktree location, but no path, branch, remote, or Git object id becomes the binding's identity. Registration canonicalizes an accepted ordinary directory spelling and its Git administrative paths, while a direct symlink or junction locator is rejected instead of treated as an alias. Relocation and replacement-Host recovery update the observation only through an attributed rebind operation.

## Why this decision

One physical worktree can be reached through different drive-letter case, separators, junctions, symlinks, or paths containing `..`. Keying an Execution Lease by caller spelling would allow two Development Projects to write the same files. Keying by branch is also incorrect because a worktree may use detached HEAD and can change branches without becoming another resource.

Git distinguishes the main worktree from linked worktrees through per-worktree administrative data. The `.git` marker, `commondir`, and reciprocal `gitdir` control files identify the private administrative location and shared repository family without asking repository-aware Git to discover them. Those paths are strong duplicate-detection evidence while the worktree is available, but they can change when a main repository is moved, copied to another Host, or reconstructed from a clone. Git does not provide a portable repository UUID that Saki can treat as permanent authority.

DSH Workspace already provides a stable generated id over an `fs.realpath` canonical directory, but its path is immutable. Historical DSH Sessions also retain their original cwd. Saki therefore cannot represent relocation by rewriting either record or by pretending old Session history executed at a new path.

## Binding protocol

### Registration and duplicate detection

Version 0.1.0 registers an existing directory. It does not create, move, remove, prune, or repair a Git worktree. The Host resolves the directory with `fs.realpath`, verifies that it is a directory, and discovers the top level, per-worktree Git directory, and common Git directory from filesystem control files. It validates linked-worktree reciprocity or a local separate-Git-directory layout before copying the admitted config, HEAD, current ref, index, and repository-local exclude and attribute files into a private control directory. A fixed read-only Git query set then reads HEAD, branch or detached state, object format, remotes, and inventory against that private control snapshot and the live admitted worktree and object database.

The Host canonicalizes each filesystem-discovered worktree and administrative location with `fs.realpath`. It does not lowercase paths because a Windows directory may enable case-sensitive semantics. A direct reparse locator or final Git marker, administrative, control-file, object-directory, or configured-worktree entry fails closed rather than becoming another spelling of the candidate. A candidate collides with an available binding on the same Host when either its canonical worktree root or canonical per-worktree Git directory matches. The common Git directory groups related worktrees but does not make them the same binding.

If the selected directory is below the Git top level, registration presents the resolved top level and requires confirmation rather than silently changing scope. Saki creates or reuses the DSH Workspace for that canonical top level, creates one stable Resource Binding id and revision, and stores the inspected paths and Git facts as observations. Every Agent Run and Host Operation records the binding revision it used.

### Health and revalidation

A binding is `active`, `missing`, `repair-required`, `needs-rebind`, or `retired`. Before acquiring an Execution Lease or starting a mutating Host Operation, the Host repeats canonical and Git inspection. A matching observation keeps the binding active. A missing directory becomes `missing`; a present path whose worktree or administrative identity no longer matches becomes `repair-required`; an Installation restored to another Host begins as `needs-rebind`. None of these states is repaired by finding a similarly named path, branch, remote, or commit.

The stable Resource Binding id, not the observed location, remains the key for Execution Lease exclusivity. A binding revision change invalidates pending admission that was prepared against an older observation. Read-only history remains available in all non-active states, but new writable work is unavailable.

### Rebind and retirement

`RebindDevelopmentProject` selects an existing directory on the owning Host and records both old and new observations under a Host Operator Actor. It requires no active writable Agent Run, terminal, unaccepted Host Operation, or unresolved dispatch that may still mutate the prior location. Exact continuity of the per-worktree Git directory permits straightforward relocation. A replacement clone, moved main worktree, repaired administrative directory, or replacement Host cannot prove identity from paths; the operator must explicitly confirm the new resource after Saki displays Repository, remote, HEAD-lineage, dirty-state, and GitHub-binding evidence. This confirmation changes the location, not historical attribution.

Because DSH Workspace paths and Session cwd values are immutable, a location change creates or reuses a Workspace at the new canonical path and advances the Project's Workspace reference. Existing DSH Sessions remain attached to their historical Workspace and are available for reading. A continued Saki Work Session opens a successor DSH Session at the new location rather than rewriting the old Session.

`RetireDevelopmentProject` prevents new execution and mutation while preserving Project identity, Work Sessions, evidence, GitHub associations, and audit records. It requires the same execution quiescence as rebind and does not delete the directory, Git worktree, DSH Workspace registration, Session log, branch, or remote resource. Version 0.1.0 has no separate operation that detaches a live Project from its worktree while leaving it executable.

### Existing changes

Registration and rebind capture staged, unstaged, untracked, branch, and HEAD observations. Automatic mode requires a clean worktree. A dirty worktree creates an Intervention Request and cannot be adopted by automation. A manual Host Operator may submit an explicit takeover Intent that records a bounded fingerprint and diff summary as pre-existing input evidence; the resulting Run and every Changes view continue to mark those modifications as inherited. If Saki cannot distinguish later changes from that baseline, automatic staging or completion remains unavailable.

## Considered options

**Use canonical path as the durable binding id.** `fs.realpath` prevents aliases while the directory exists but cannot survive relocation, replacement-Host restore, or a reconstructed clone. A generated id lets location observations change without reinterpreting history.

**Use Repository remote, branch, or HEAD as identity.** Clones can share all three, branches and HEAD change during ordinary work, and detached worktrees have no branch. These values support operator review but cannot own a lease.

**Use the Git common directory as worktree identity.** Every linked worktree shares it, so parallel worktrees would collapse into one binding. The per-worktree Git directory distinguishes them while available.

**Rewrite DSH Workspace and Session paths after a move.** Those values describe where prior execution happened and participate in DSH's own membership rules. Rewriting them would corrupt historical meaning and cross package ownership.

**Let Saki manage physical worktree creation and deletion in version 0.1.0.** Safe creation, branch selection, dirty removal, submodules, locking, repair, and deletion require a larger Git product surface. Terminal, PowerShell 7, Git, and Agents remain the fallback while Saki owns registration, rebind, retirement, and execution safety.

**Allow automatic work to inherit a dirty tree.** A later commit could include changes with no reliable Actor or Work Item attribution. Manual takeover preserves an explicit decision; automatic mode stops.

## Consequences

Relocation is a Project lifecycle operation rather than a path edit. The UI must present binding health, observed location, binding revision, Git facts, inherited changes, and any action required before writable execution. It must not present a guessed move as repaired.

Host tests cover ordinary, linked, detached, and local separate-Git-directory layouts; direct reparse locators and Git control entries; linked worktrees sharing one common directory; missing paths; dirty registration; source-control changes between observations; private config precedence; non-files ref-storage rejection; split-index rejection; and source object-alternate rejection. Control-plane tests cover duplicate canonical observations, restart, stale binding revisions, and preserved historical Sessions within the implemented registration subset; move, repair, replacement clone, rebind quiescence, and the remaining binding lifecycle stay deferred. The Git mechanisms follow the official [git-worktree](https://git-scm.com/docs/git-worktree) configuration rules while repository-aware queries run against a private control snapshot.
