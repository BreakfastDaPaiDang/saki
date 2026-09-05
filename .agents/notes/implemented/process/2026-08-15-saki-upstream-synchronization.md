# Agent Note: Saki upstream synchronization

Status: implemented

English | [中文](2026-08-15-saki-upstream-synchronization.zh.md)

## Problem

Saki must absorb continuing DeepSeek Harness development without treating a clean Git text merge as proof of product compatibility. Directly merging on a schedule can silently break Saki, while routing every upstream commit to a person prevents routine updates from remaining automatic.

## Decision

[`upstream-sync.yml`](../../../../.github/workflows/upstream-sync.yml) mirrors the official upstream head to one lease-protected branch and represents every pending incorporation as a pull request. A dedicated GitHub App creates the branch and pull request so the normal Saki CI event runs; its token is limited to Contents, Workflows, Pull requests, and Issues for this repository.

`master` requires the aggregate `all checks passed` status. A merge candidate without textual conflicts is marked ready and has merge-commit auto-merge enabled, so GitHub merges it only after required CI succeeds. A textual conflict or unsuccessful CI creates or updates a compatibility Issue containing the upstream commit, pull request, evidence, and acceptance conditions. The [maintenance ownership decision](2026-09-05-saki-maintenance-work-ownership.md) owns fixed targets, claimed-Issue identity, and completion after confirmed merge.

CI-result routing mutates Issues only in its dedicated job. That job accepts a `workflow_run` only when its branch and head repository identify this repository's synchronization branch, the open pull request still has the run's head SHA, and the pull request is no longer a draft. Fork runs, superseded results, and the intentionally skipped CI of a conflict draft therefore cannot overwrite the textual-conflict diagnosis; the workflow's default Issues permission remains read-only.

The synchronization branch starts at the upstream commit and can receive compatibility repairs while the target remains open. GitHub tests and merges the combined tree presented by the pull request, while the merge commit records both the Saki and official upstream histories. The workflow probes textual compatibility with `git merge-tree` without modifying the checkout or requiring a commit identity.

## Alternatives considered

**Merge every conflict-free Git result directly into `master`.** A textually clean merge can still fail type checks, tests, builds, snapshots, or Saki-specific behavior.

**Create pull requests with `GITHUB_TOKEN`.** Repository-token events suppress ordinary follow-on workflow runs or require explicit approval, so the required compatibility signal cannot drive unattended auto-merge.

**Store a personal access token.** A PAT ties repository maintenance to one person's account and usually carries broader, longer-lived authority than an installation token.

**Require an Agent for every upstream commit.** This maximizes inspection but spends Agent time on updates already proven compatible by the repository's required CI.

## Consequences

Routine compatible updates merge without attention, and incompatibilities become durable, Agent-ready Work Items instead of stalled workflow logs. Saki must maintain the GitHub App credentials, the required aggregate CI check, and the small workflow adaptation that selects runners available to the Saki organization.
