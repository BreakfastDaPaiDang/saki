# Agent Note: Delegated standalone PR landing

Status: implemented

English | [中文](2026-08-27-delegated-standalone-pr-landing.zh.md)

## Problem

A standalone product PR can reach a stable, fully tested, review-clean state while its agent still lacks authority to merge it. Requiring a separate owner confirmation at that point interrupts long-running work without adding technical evidence. Treating CI success as authority would be unsafe: checks do not establish the intended commit, review state, dependency topology, or correct merge mode.

## Decision

The repository owner delegates standalone Saki product PR landing to an entrusted agent. A standalone PR has no dependent open PR and is neither an official stack entry nor an upstream-synchronization PR.

No additional confirmation is required only when live GitHub state establishes that the PR is Ready and mergeable, its exact head matches the OID covered by the evidence, every required check passed, and no unresolved review thread or outstanding changes-requested decision remains. The agent squash-merges with that expected head OID. Missing, stale, or indeterminate evidence stops the operation and is reported.

After GitHub reports `MERGED`, the agent confirms that no open PR uses the remote feature branch as its base and that the ref still points to the landed head, then deletes that ref. Official stacks retain [their stack-wide landing workflow](2026-08-02-native-github-stacks-and-optional-rebases.md), and upstream synchronization retains [merge commits](2026-08-15-saki-upstream-synchronization.md).

## Alternatives considered

**Require owner confirmation for every merge.** This preserves a decision point after all acceptance evidence is complete, but turns unattended work into an idle wait without narrowing the technical conditions.

**Merge whenever required CI succeeds.** CI cannot grant authority or prove Ready state, the expected head, resolved review, standalone topology, or the required merge mode.

**Apply the delegation to every PR.** Official stacks and upstream synchronization have different ordering, branch-lifetime, and history requirements; per-PR squash merging would violate those workflows.

## Consequences

- Long-running product work can land as soon as deterministic acceptance conditions are satisfied.
- Ambiguous GitHub state fails closed and returns control to the owner.
- Standalone history stays compact, and remote feature branches are deleted only after their merged state and lack of dependents are verified.
