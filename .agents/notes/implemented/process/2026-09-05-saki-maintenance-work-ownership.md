# Agent Note: Saki maintenance work ownership

Status: implemented

English | [中文](2026-09-05-saki-maintenance-work-ownership.zh.md)

## Problem

A daily upstream mirror can overwrite compatibility commits while an Agent works. Looking up tasks by `ready-for-agent` loses claimed Issues, and closing an Issue on successful CI reports completion before incorporation. Overlapping security proposals can also resolve the same lockfile to unrelated fresh dependencies and fail release-age checks.

## Decision

[Upstream maintenance](../../../../.github/maintenance/upstream.mjs) holds every open synchronization pull request without rewriting its branch or draft state. The official target remains fixed until closure; Agent repairs may advance its head. New targets use a read-only merge-tree probe and an exact remote lease. The [original synchronization decision](2026-08-15-saki-upstream-synchronization.md) retains GitHub App permission, required-CI, and merge-history rationale; this decision owns target lifetime and Issue completion.

Compatibility Issue identity is the synchronization pull request, including the legacy marker and exact PR link. Claiming the Issue does not create a replacement task. Automation updates its own evidence comment, preserving participant-owned body, labels, and assignees. Current-head CI failure routes work; successful CI waits for merge. A confirmed merged PR completes the Issue, and a closed unmerged PR cancels it. Duplicate identities fail for manual reconciliation.

The same Node module runs from trusted default-branch Actions and a local CLI. Its read-only status reports the current head, Issue, and assignees. GitHub records and the [maintenance procedure](../../../../docs/saki/maintenance.md) carry checkpoints across Agent hosts. GitHub commands name the repository explicitly because fork-local `gh` inference can select the upstream parent.

Dependabot groups npm security updates for the shared lockfile. Saki's routine version proposals remain disabled, while [dependency quarantine and review](2026-07-27-dependabot-version-updates.md) still apply. Grouping reduces duplicate work; agents still inspect dependency closure and retain release-age checks when a generated proposal contains unrelated fresh releases.

## Alternatives considered

- **Refresh the upstream branch every day.** This bounds update lag but destroys in-progress repair commits and invalidates the Agent's target.
- **Close work on green CI.** Checks can succeed while review, branch protection, or merge remains pending.
- **Store ownership in a host-specific session.** Another Saki or CLI session cannot reliably reconstruct that state from GitHub.
- **Relax the release-age check for security pull requests.** The security label does not establish a need for unrelated fresh dependencies.

## Verification

The [maintenance tests](../../../../.github/maintenance/upstream.test.mjs) exercise fixed targets, claimed Issues, stale and fork CI, merged versus canceled closure, duplicate identities, and exact-lease failure. Temporary Git repositories verify clean and conflicting merge probes without checkout changes. The [workflow specification](../../../../scripts/saki-upstream-sync-workflow.spec.ts) executes those tests and checks event wiring and trusted checkouts; the [Dependabot specification](../../../../scripts/saki-dependabot-policy.spec.ts) checks grouping and cooldown policy.

## Consequences

An open target can delay newer upstream commits; its Issue is the durable place to finish or explicitly abandon it. Preparation preserves a partially published PR after a workflow failure, so operators inspect and finish missing metadata or auto-merge configuration without replacing the target. No Agent scheduler or host-specific runtime is required by this maintenance mechanism.
