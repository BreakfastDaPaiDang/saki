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

For a new upstream commit, the workflow lease-protects `automation/upstream-sync`, mirrors the exact upstream head there, and creates or updates one pull request. The Saki merge candidate retains Saki-only files and modifications while GitHub CI tests the combined tree.

A textually clean merge marks the pull request ready and enables automatic merge. Branch protection delays the merge until `all checks passed` succeeds. A textual conflict keeps the pull request as a draft and creates or updates one Chinese-titled compatibility Issue with `ready-for-agent` and `area/infra`.

The same workflow observes completed CI runs for the synchronization branch. A failed or canceled CI run creates or updates the compatibility Issue even when Git found no textual conflict. A successful run closes an existing compatibility Issue; GitHub then completes the enabled auto-merge.

## Manual dispatch

After configuring the GitHub App, run:

```sh
gh workflow run upstream-sync.yml --repo BreakfastDaPaiDang/saki
```

The workflow fails a manual dispatch with a configuration error when the client ID is absent. Scheduled runs remain idle until the client ID is configured, avoiding repeated failure notifications during bootstrap.
