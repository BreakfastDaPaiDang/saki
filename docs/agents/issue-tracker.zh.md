# Issue 跟踪器：GitHub

[English](issue-tracker.md) | 中文

本仓库的 Issue 和 PRD 位于 [BreakfastDaPaiDang/saki](https://github.com/BreakfastDaPaiDang/saki)。使用 `gh` CLI 操作 Issue。

## 约定

- 使用 `gh issue create --repo BreakfastDaPaiDang/saki --title "..." --body-file <path>` 创建 Issue。
- 使用 `gh issue view --repo BreakfastDaPaiDang/saki <number> --comments` 读取 Issue。
- 使用 `gh issue list --repo BreakfastDaPaiDang/saki --state open --json number,title,body,labels,comments` 列出 Issue。
- 使用 `gh issue comment --repo BreakfastDaPaiDang/saki <number> --body-file <path>` 添加评论。
- 使用 `gh issue edit --repo BreakfastDaPaiDang/saki <number> --add-label "..."` 或 `--remove-label "..."` 添加或移除标签。
- 使用 `gh issue close --repo BreakfastDaPaiDang/saki <number> --reason completed` 关闭已完成的工作。
- 使用 `gh issue close --repo BreakfastDaPaiDang/saki <number> --reason "not planned"` 关闭已取消的工作。

每条命令都显式指定仓库：fork 中的 `gh` 默认值可能选中上游父仓库，而不是 `origin`。

## 将 Pull Request 作为分诊界面

外部 Pull Request 不是请求入口。不要让它们进入 Issue 分诊状态机。

Pull Request 可以实现现有 Work Item，并遵循仓库的评审流程。GitHub 的 Issue 和 Pull Request 共用编号空间，因此遇到有歧义的编号时，先用 `gh pr view --repo BreakfastDaPaiDang/saki <number>` 解析，失败后再用 `gh issue view --repo BreakfastDaPaiDang/saki <number>`。

## 发布和获取工作

当 skill 要求把工作发布到 Issue 跟踪器时，创建 GitHub Issue。

当 skill 要求获取工作项时，运行 `gh issue view --repo BreakfastDaPaiDang/saki <number> --comments` 并包含其标签。
