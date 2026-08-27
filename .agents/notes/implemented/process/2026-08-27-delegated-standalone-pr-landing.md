# Agent Note: Delegated standalone PR landing

Status: implemented

English | [中文](2026-08-27-delegated-standalone-pr-landing.zh.md)

## Problem

A standalone product PR can reach a stable, fully tested, review-clean state while its agent still lacks authority to merge it. Requiring a separate owner confirmation at that point interrupts long-running work without adding technical evidence. Treating CI success as authority would be unsafe: checks do not establish the intended commit, review state, dependency topology, or correct merge mode.

## Decision

The repository owner delegates eligible standalone Saki product PR landing to an entrusted agent. An eligible PR comes from the same repository, directly targets the protected default branch, has no live native `stack` or `stackEntry`, has no open PR using its head branch as a base, and does not use the fixed `automation/upstream-sync` head.

Immediately before landing, complete live GitHub queries must establish that the PR is not Draft, is `MERGEABLE` with clean merge state, and still has the exact `headRefOid` covered by the evidence. The protected base must declare a nonempty required-check set, and every required check for that head must have succeeded. Every page of review threads must be exhausted and every thread resolved; no review request may remain; and `reviewDecision` must be neither `CHANGES_REQUESTED` nor `REVIEW_REQUIRED`. A null decision is acceptable only while the live protection rule requires zero approvals.

No additional confirmation is required once all conditions hold. The agent squash-merges with expected-head matching and never uses an administrative bypass, pre-authorized auto-merge, or combined branch deletion. Missing, stale, or indeterminate evidence stops the operation and is reported.

After GitHub reports `MERGED`, the agent repeats a complete query for open PRs based on the remote feature branch and requires zero results; any result stops cleanup and is reported. An absent ref means cleanup is already complete. If the ref remains, `git push --force-with-lease=refs/heads/<branch>:<headRefOid> origin :refs/heads/<branch>` deletes it under an exact lease against the pre-merge head; a moved ref aborts deletion. Official stacks retain [their stack-wide landing workflow](2026-08-02-native-github-stacks-and-optional-rebases.md), and upstream synchronization retains [merge commits](2026-08-15-saki-upstream-synchronization.md).

## Alternatives considered

**Require owner confirmation for every merge.** This preserves a decision point after all acceptance evidence is complete, but turns unattended work into an idle wait without narrowing the technical conditions.

**Merge whenever required CI succeeds.** CI cannot grant authority or prove Ready state, the expected head, resolved review, standalone topology, or the required merge mode.

**Apply the delegation to every PR.** Official stacks and upstream synchronization have different ordering, branch-lifetime, and history requirements; per-PR squash merging would violate those workflows.

## Consequences

- Long-running product work can land as soon as deterministic acceptance conditions are satisfied.
- Ambiguous GitHub state refuses landing by default and returns control to the owner.
- Standalone history stays compact, and remote feature branches are deleted only after merged state, lack of dependents, and the exact pre-merge head are verified.
