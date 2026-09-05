# Saki upstream synchronization

English | [中文](upstream-sync.zh.md)

This reference defines how Saki incorporates `deepseek-ai/deepseek-harness` without granting upstream automation direct access to `master`. The repository workflow owns detection, the synchronization pull request, compatibility routing, and automatic merge after required CI.

## Repository configuration

Create and install a GitHub App on `BreakfastDaPaiDang/saki` with these repository permissions:

- Contents: read and write
- Workflows: read and write
- Pull requests: read and write
- Issues: read and write

Store the App client ID as the Actions variable `SAKI_AUTOMATION_CLIENT_ID` and its complete private key as the Actions secret `SAKI_AUTOMATION_PRIVATE_KEY`. The workflow requests only these permissions when it creates an installation token. A GitHub App token is required because pull requests created with the repository `GITHUB_TOKEN` do not start ordinary CI without an approval step.

Set `SAKI_CI_RUNNERS=standard` as a repository Actions variable. Protect `master` with the required status check `all checks passed`, allow pull-request auto-merge, and retain merge commits so an upstream synchronization preserves the incorporated upstream history.

## Operation

[`upstream-sync.yml`](../../.github/workflows/upstream-sync.yml) runs every day at 19:17 UTC and accepts manual dispatch. It fetches official `master`, compares it with Saki `master`, and does nothing when Saki already contains that upstream commit.

An open synchronization pull request fixes the target: scheduled and manual preparation leave its branch, draft state, and repair commits untouched. With no open pull request, the workflow compares the checked-out Saki `master` with the fetched official head using `git merge-tree`, lease-protects `automation/upstream-sync`, and creates one pull request at that exact upstream commit. The probe does not modify the checkout.

A textually clean merge creates a ready pull request and enables merge-commit auto-merge. Branch protection delays the merge until `all checks passed` succeeds. A textual conflict creates a draft and a Bug Issue with `ready-for-agent` and `area/infra`.

The workflow routes completed CI only for the current head of a ready synchronization pull request from this repository. An unsuccessful run creates the compatibility Issue if absent, or updates its automation evidence comment. Issue identity follows the pull request even after an Agent claims it and removes `ready-for-agent`; existing labels, assignees, and body remain owned by the work's participants. Successful CI leaves the Issue open until the pull request merges. A closed pull request completes its Issue only when GitHub confirms the merge; closure without merge cancels the Issue as not planned.

## Agent handoff

Use the [maintenance procedure](maintenance.md) to claim work and retain checkpoints. From this checkout, inspect the current target and ownership without changing GitHub:

```sh
node .github/maintenance/upstream.mjs status
```

Read the pull request body for its fixed official commit, then fetch the current Saki base and exact pull request head into a separate worktree. If the head still equals the official commit, start from Saki `master` and merge that commit; if repair commits exist, continue from the current pull request head and merge the current Saki base. Preserve the official commit's ancestry, Saki product behavior, persisted data, and the [Saki Actions policy](../../.agents/notes/implemented/process/2026-08-18-saki-actions-cost-policy.md). Apply the repository's merge-conflict and pre-push skills, including checks required by changed vendored sources.

Publish repairs to `automation/upstream-sync` with an exact lease against the fetched pull request head. A moved remote ref stops publication and requires reconciliation. Keep the pull request draft during iteration; after local checks, mark it ready and enable auto-merge with `--merge --match-head-commit <tested-head>` through `gh pr merge --repo BreakfastDaPaiDang/saki --auto`. Upstream synchronization uses a merge commit to retain official history. Verify the merged result and the Issue's completion before taking the next target.

Workflow errors remain failed runs. If initial publication stops after creating a pull request, preparation holds that pull request on retry. Inspect the failed step and current head, then finish any missing labels, compatibility Issue, or auto-merge configuration using the same target. A missing Issue in `status` is valid for a clean target awaiting CI; it requires repair when conflicts or failed CI need Agent work.

## Manual dispatch

After configuring the GitHub App, run:

```sh
gh workflow run upstream-sync.yml --repo BreakfastDaPaiDang/saki
```

The workflow fails a manual dispatch with a configuration error when the client ID is absent. Scheduled runs remain idle until the client ID is configured, avoiding repeated failure notifications during bootstrap.
