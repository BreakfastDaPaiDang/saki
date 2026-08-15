# Agent Note: Saki 上游同步

Status: implemented

[English](2026-08-15-saki-upstream-synchronization.md) | 中文

## Problem

Saki 必须持续吸收 DeepSeek Harness 开发成果，同时不能把 Git 文本合并干净视为产品兼容证明。按计划直接合并可能静默破坏 Saki，而把每个上游 commit 都交给人工处理会让常规更新无法保持自动化。

## Decision

[`upstream-sync.yml`](../../../../.github/workflows/upstream-sync.yml) 把官方上游 head 镜像到一个受 lease 保护的分支，并用 Pull Request 表示每次等待纳入的更新。专用 GitHub App 创建分支和 Pull Request，使普通 Saki CI 事件能够运行；它的 token 仅限本仓库的 Contents、Workflows、Pull requests 和 Issues 权限。

`master` 要求汇总状态 `all checks passed`。没有文本冲突的合并候选会被标为 Ready 并启用 merge commit 自动合并，因此 GitHub 只在必需 CI 成功后合并。文本冲突或 CI 未成功时，工作流创建或更新一个 `ready-for-agent` 兼容性 Issue，其中包含上游 commit、Pull Request、证据和验收条件。CI 成功时关闭现有兼容性 Issue。

同步分支镜像上游 commit，而不包含预先解决的合并。GitHub 因此会测试并合并 Pull Request 所展示的同一棵组合树，而 merge commit 同时记录 Saki 和官方上游历史。

## Alternatives considered

**把每个没有 Git 冲突的结果直接合并到 `master`。** 文本合并干净仍可能无法通过类型检查、测试、构建、快照或 Saki 专属行为检查。

**使用 `GITHUB_TOKEN` 创建 Pull Request。** 仓库 token 触发的事件会抑制普通后续工作流运行或要求明确批准，因此必需兼容性信号无法驱动无人值守的自动合并。

**存储个人访问 token。** PAT 把仓库维护与一个人的账号绑定，而且通常比安装 token 拥有更广、更持久的权限。

**要求 Agent 处理每个上游 commit。** 这样检查最充分，但会把 Agent 时间花在已经由仓库必需 CI 证明兼容的更新上。

## Consequences

常规兼容更新无需关注即可合并，不兼容更新则成为持久、Agent-ready 的 Work Item，而不是停滞的工作流日志。Saki 必须维护 GitHub App 凭据、必需的汇总 CI 检查，以及选择 Saki 组织可用 runner 的小型工作流适配。
