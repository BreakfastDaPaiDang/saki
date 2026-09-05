# Saki maintenance

English | [中文](maintenance.zh.md)

This procedure covers dependency maintenance and upstream compatibility. Work is recorded in GitHub so an Agent in any host, including Saki, can resume it. Product implementation remains with its assigned Agent.

## Prerequisites

Use a repository checkout with Git, Node, the pinned pnpm version, and authenticated GitHub access to read checks and manage this repository's Issues and pull requests. Follow the [issue tracker conventions](../agents/issue-tracker.md), especially explicit repository selection for this fork. Upstream automation credentials and branch protection are defined in [upstream synchronization](upstream-sync.md).

## Resume and claim work

1. Read open maintenance Issues, synchronization status, and dependency pull requests. Inspect the current head, review state, CI evidence, and assignees before modifying work.
2. Claim an existing Issue through the [triage workflow](../agents/triage-labels.md); retain its identity and current owner when another Agent is active. Create a typed Issue for uncovered work, linking related pull requests and the failure evidence.
3. Use a separate worktree for each independent change. Record its branch, exact base and target commits, scope, commands run, remaining failures, and next action on the Issue. Never rely on a host-specific conversation as the only checkpoint.
4. Iterate as a draft, run the [relevant local checks](../../.agents/skills/dsh-pre-push-checks/SKILL.md), and publish a reviewable pull request with the Issue reference. Follow the repository's delegated landing rules for eligible standalone changes; upstream work follows its own merge-commit procedure.
5. Verify the merged result before closing work. Close superseded pull requests only after their intended fixes have landed. Delete a remote branch only after checking for dependent pull requests and matching its last reviewed head with an exact lease.

## Security dependencies

Dependabot groups npm security updates for the shared pnpm lockfile. Routine version-update pull requests are disabled in Saki; the configured 30-day version cooldown and repository release-age checks remain in place. Grouping reduces overlapping proposals but does not guarantee a narrow lockfile diff.

For each security proposal, identify the advisory, affected package paths, patched versions, and generated lockfile scope. If the solver includes unrelated fresh dependencies, retain the release-age checks and narrow the update to package-manager-generated resolutions for the affected dependency closure. Confirm package metadata and integrity, run a frozen install, and select tests for the consumers that changed. Update generated notices when their content changes. Do not merge unrelated upgrades merely because they share the security pull request.

After landing, inspect the vulnerability alerts again; GitHub's dependency scan can lag behind the merge. Record unresolved alerts and their current package paths before treating them as new work. The [dependency policy](../../.agents/notes/implemented/process/2026-07-27-dependabot-version-updates.md) owns supply-chain and vendoring constraints; [maintenance ownership](../../.agents/notes/implemented/process/2026-09-05-saki-maintenance-work-ownership.md) explains task continuity.
