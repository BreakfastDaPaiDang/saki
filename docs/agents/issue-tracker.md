# Issue tracker: GitHub

English | [中文](issue-tracker.zh.md)

Issues and PRDs for this repository live in [BreakfastDaPaiDang/saki](https://github.com/BreakfastDaPaiDang/saki). Use the `gh` CLI for issue operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body-file <path>`.
- Read an issue with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels,comments`.
- Comment with `gh issue comment <number> --body-file <path>`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close completed work with `gh issue close <number> --reason completed`.
- Close canceled work with `gh issue close <number> --reason "not planned"`.

Run commands inside this checkout so `gh` infers the repository from `origin`.

## Pull requests as a triage surface

External pull requests are not a request surface. Do not route them through the issue triage state machine.

Pull requests may implement existing Work Items and follow the repository's review process. GitHub shares one number space across issues and pull requests, so resolve an ambiguous reference with `gh pr view <number>` and fall back to `gh issue view <number>`.

## Publishing and fetching work

When a skill says to publish work to the issue tracker, create a GitHub issue.

When a skill says to fetch a ticket, run `gh issue view <number> --comments` and include its labels.
