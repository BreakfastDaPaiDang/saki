# Saki 上游同步

[English](upstream-sync.md) | 中文

本文档定义 Saki 如何纳入 `deepseek-ai/deepseek-harness`，而不让上游自动化直接访问 `master`。仓库工作流负责检测、同步 Pull Request、兼容性路由和必需 CI 通过后的自动合并。

## 仓库配置

创建一个 GitHub App 并安装到 `BreakfastDaPaiDang/saki`，授予以下仓库权限：

- Contents：读写
- Workflows：读写
- Pull requests：读写
- Issues：读写

把 App client ID 存为 Actions 变量 `SAKI_AUTOMATION_CLIENT_ID`，把完整私钥存为 Actions secret `SAKI_AUTOMATION_PRIVATE_KEY`。工作流创建安装 token 时只请求这些权限。必须使用 GitHub App token，因为使用仓库 `GITHUB_TOKEN` 创建的 Pull Request 不经过批准步骤就不会启动普通 CI。

把 `SAKI_CI_RUNNERS=standard` 设置为仓库 Actions 变量。用必需状态检查 `all checks passed` 保护 `master`，允许 Pull Request 自动合并，并保留 merge commit，使上游同步能够保存已纳入的上游历史。

## 运行方式

[`upstream-sync.yml`](../../.github/workflows/upstream-sync.yml) 每天 19:17 UTC 运行，也接受手动触发。它获取官方 `master`，与 Saki `master` 比较；当 Saki 已经包含该上游 commit 时不执行任何操作。

打开的同步 Pull Request 固定本次目标：定时与手动准备均保留其分支、draft 状态和修复 commit。没有打开的 Pull Request 时，工作流使用 `git merge-tree` 比较检出的 Saki `master` 与获取的官方 head，通过 lease 保护 `automation/upstream-sync`，并在该精确上游 commit 创建一个 Pull Request。探测不修改检出内容。

文本合并干净时，工作流创建 Ready 的 Pull Request，并启用 merge commit 自动合并。分支保护会延迟合并，直到 `all checks passed` 成功。存在文本冲突时，工作流创建 draft，以及带 `ready-for-agent` 和 `area/infra` 的 Bug Issue。

工作流仅为来自本仓库、处于 Ready 状态的同步 Pull Request 当前 head 路由已完成 CI。运行未成功时，若兼容性 Issue 不存在则创建，否则更新其自动化证据评论。Issue 身份随 Pull Request 保持，即使 Agent 认领后移除 `ready-for-agent` 也不改变；现有标签、被分配者和正文仍由工作参与者管理。CI 成功后 Issue 保持打开，直到 Pull Request 合并。Pull Request 关闭时，只有 GitHub 确认已合并才完成其 Issue；未合并的关闭则以 not planned 取消 Issue。

## Agent 接手

使用[维护流程](maintenance.zh.md)认领工作并保存检查点。在本检出中运行以下命令，只读查看当前目标与归属：

```sh
node .github/maintenance/upstream.mjs status
```

从 Pull Request 正文读取固定的官方 commit，再将当前 Saki 基线和精确的 Pull Request head 获取到独立 worktree。若 head 仍等于官方 commit，从 Saki `master` 开始并合并该 commit；若已有修复 commit，则从当前 Pull Request head 继续并合并当前 Saki 基线。保留官方 commit 的祖先关系、Saki 产品行为、持久数据及 [Saki Actions 政策](../../.agents/notes/implemented/process/2026-08-18-saki-actions-cost-policy.zh.md)。应用仓库的合并冲突与推送前检查 skill，包括 vendored 源码变更所要求的检查。

将修复发布到 `automation/upstream-sync` 时，用精确 lease 匹配已获取的 Pull Request head。远程 ref 发生移动时停止发布并进行协调。迭代期间保持 draft；本地检查通过后标为 Ready，并通过 `gh pr merge --repo BreakfastDaPaiDang/saki --auto` 配合 `--merge --match-head-commit <tested-head>` 启用自动合并。上游同步使用 merge commit 保留官方历史。接取下一个目标前，验证合并结果和 Issue 完成状态。

工作流错误会保留为失败运行。若初次发布在创建 Pull Request 后中断，重试准备会保留该 Pull Request。检查失败步骤与当前 head，再围绕同一目标补齐缺失的标签、兼容性 Issue 或自动合并配置。对于合并干净且等待 CI 的目标，`status` 中没有 Issue 属于正常状态；若冲突或失败 CI 需要 Agent 处理，则必须补齐。

## 手动触发

配置 GitHub App 后运行：

```sh
gh workflow run upstream-sync.yml --repo BreakfastDaPaiDang/saki
```

client ID 缺失时，工作流让手动触发以配置错误失败。client ID 配置完成前，定时运行保持空闲，避免在引导期间反复发送失败通知。
