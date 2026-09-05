# Agent Note: Saki 维护工作归属

Status: implemented

[English](2026-09-05-saki-maintenance-work-ownership.md) | 中文

## 问题

每日上游镜像可能在 Agent 工作期间覆盖兼容修复 commit。按 `ready-for-agent` 查找任务会丢失已认领 Issue，而在 CI 成功时关闭 Issue 会在纳入代码前报告完成。重叠的安全提案也可能把同一锁文件解析到无关的刚发布依赖，导致发布时长检查失败。

## 决策

[上游维护](../../../../.github/maintenance/upstream.mjs)保留每个打开的同步 Pull Request，不重写其分支或 draft 状态。官方目标固定到关闭为止；Agent 修复可以推进其 head。新目标使用只读 merge-tree 探测和精确的远程 lease。[原始同步决策](2026-08-15-saki-upstream-synchronization.zh.md)保留 GitHub App 权限、必需 CI 和合并历史的理由；本决策负责目标生命周期与 Issue 完成条件。

兼容性 Issue 的身份是同步 Pull Request，同时支持旧标记与精确 PR 链接。认领 Issue 不会创建替代任务。自动化更新自己的证据评论，保留参与者管理的正文、标签和被分配者。当前 head 的 CI 失败会路由工作；CI 成功则等待合并。确认已合并的 PR 完成 Issue，关闭但未合并的 PR 取消 Issue。出现重复身份时失败，交由人工协调。

同一 Node 模块可从受信任默认分支的 Actions 和本地 CLI 运行。只读状态报告当前 head、Issue 和被分配者。GitHub 记录与[维护流程](../../../../docs/saki/maintenance.zh.md)在 Agent 宿主之间承载检查点。GitHub 命令显式指定仓库，因为 fork 中的 `gh` 推断可能选中上游父仓库。

Dependabot 为共享锁文件分组提出 npm 安全更新。Saki 的常规版本提案保持禁用，[依赖隔离与评审](2026-07-27-dependabot-version-updates.zh.md)仍然适用。分组减少重复工作；当生成的提案包含无关的刚发布版本时，Agent 仍须检查依赖闭包并保留发布时长检查。

## 考虑过的替代方案

- **每天刷新上游分支。** 这能限制更新延迟，但会破坏进行中的修复 commit，使 Agent 的目标失效。
- **CI 通过即关闭工作。** 检查可以在评审、分支保护或合并仍未完成时成功。
- **将归属保存在特定宿主会话中。** 另一 Saki 或 CLI 会话无法从 GitHub 可靠重建该状态。
- **为安全 Pull Request 放宽发布时长检查。** 安全标签不能证明需要纳入无关的刚发布依赖。

## 验证

[维护测试](../../../../.github/maintenance/upstream.test.mjs)覆盖固定目标、已认领 Issue、过期与 fork CI、已合并和已取消的关闭、重复身份以及精确 lease 失败。临时 Git 仓库验证干净和冲突合并探测均不改变检出内容。[工作流规格测试](../../../../scripts/saki-upstream-sync-workflow.spec.ts)执行这些测试并检查事件连接和受信任检出；[Dependabot 规格测试](../../../../scripts/saki-dependabot-policy.spec.ts)检查分组和冷却期政策。

## 后果

打开的目标可能延迟较新的上游 commit；其 Issue 是完成或明确放弃目标的持久记录位置。工作流失败后，准备操作会保留部分发布的 PR，因此操作者检查并补齐缺失元数据或自动合并配置，不替换目标。这套维护机制不要求 Agent 调度器或特定宿主运行时。
