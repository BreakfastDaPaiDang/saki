# Saki 维护

[English](maintenance.md) | 中文

本流程涵盖依赖维护与上游兼容。工作记录保存在 GitHub，使任何宿主中的 Agent（包括 Saki）都能接手。产品实现仍由被分配的 Agent 负责。

## 前置条件

使用配备 Git、Node、固定版本 pnpm 的仓库检出，并完成 GitHub 身份验证，具备读取检查结果及管理本仓库 Issue 和 Pull Request 的权限。遵循 [Issue 跟踪器约定](../agents/issue-tracker.zh.md)，尤其是为此 fork 显式指定仓库。上游自动化凭据和分支保护见[上游同步](upstream-sync.zh.md)。

## 恢复与认领工作

1. 阅读打开的维护 Issue、同步状态和依赖 Pull Request。修改工作前，检查当前 head、评审状态、CI 证据和被分配者。
2. 通过[分诊流程](../agents/triage-labels.zh.md)认领现有 Issue；若另一 Agent 正在工作，保留该 Issue 的身份与当前负责人。为尚未覆盖的工作创建带原生类型的 Issue，关联相关 Pull Request 和失败证据。
3. 每项独立变更使用单独的 worktree。在 Issue 中记录分支、精确的基线与目标 commit、范围、已运行命令、剩余失败及下一步操作。不要把特定宿主的会话作为唯一检查点。
4. 以 draft 状态迭代，运行[相关本地检查](../../.agents/skills/dsh-pre-push-checks/SKILL.md)，发布关联 Issue 且可供评审的 Pull Request。符合条件的独立变更遵循仓库委托合入规则；上游工作遵循其自身的 merge commit 流程。
5. 关闭工作前验证合并结果。只有预期修复已落地，才关闭被取代的 Pull Request。删除远程分支前必须检查依赖它的 Pull Request，并以精确 lease 匹配最后评审过的 head。

## 安全依赖

Dependabot 为共享 pnpm 锁文件分组提出 npm 安全更新。Saki 禁用常规版本更新 Pull Request；配置中的 30 天版本冷却期及仓库发布时长检查保持有效。分组可减少重叠提案，但不保证锁文件差异范围足够小。

对于每项安全提案，确认漏洞公告、受影响包路径、修复版本及生成的锁文件范围。若解析器带入了无关的刚发布依赖，保留发布时长检查，把更新缩小到包管理器为受影响依赖闭包生成的解析结果。确认包元数据与完整性，运行 frozen install，并为发生变化的 Consumer 选择测试。生成的声明内容变化时更新声明。不要仅因无关升级出现在同一个安全 Pull Request 中就合入它们。

合入后再次检查漏洞警报；GitHub 依赖扫描可能晚于合并完成。将未解决警报作为新工作前，先记录警报及其当前包路径。[依赖政策](../../.agents/notes/implemented/process/2026-07-27-dependabot-version-updates.zh.md)负责供应链与 vendoring 约束；[维护工作归属](../../.agents/notes/implemented/process/2026-09-05-saki-maintenance-work-ownership.zh.md)解释任务连续性。
