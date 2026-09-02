# Agent Note: 基于规范 worktree 观察的稳定 Resource Binding

Status: proposed

[English](2026-08-18-saki-stable-resource-bindings.md) | 中文

## 问题

一个 worktree 可以通过多个路径别名寻址，而路径与 Git 管理位置也可能发生合法变化。直接按路径确定 Development Project 或 Execution Lease 键，要么会准入重复 writer，要么会让位置迁移重写产品身份。DSH Workspace 路径与历史 Session cwd 被有意设为不可变，因此 Saki 也不能原地移动它们。

## 提案

每个 Development Project 与 Execution Lease 都寻址一个生成且稳定的 Resource Binding id。登记已有目录时，组合 `fs.realpath`、Git top level、每 worktree Git directory、common Git directory 与 `git worktree list --porcelain -z` 创建带 revision 观察，并拒绝同 Host 别名。每 worktree Git directory 区分 linked worktree；common Git directory 只对其 Repository 家族分组。路径不会转换为小写，因为文件系统可能区分大小写。

绑定健康状态为 `active`、`missing`、`repair-required`、`needs-rebind` 或 `retired`。Mutation 准入会重新验证观察与 revision。带归因的 rebind 操作要求执行完全停稳，选择已有目录，推进 Project 的 DSH Workspace 引用，并在路径无法证明连续性时记录 operator 确认。历史 DSH Session 保留旧 Workspace 与 cwd；后续轮次在新位置使用后继 Session。

0.1.0 版本登记、rebind 和退役 Project，但不实际创建、移动、repair、移除或 prune worktree。自动模式要求 clean tree。手动接管已有变更会记录其有界指纹与归因限制；任何歧义混合都会继续使自动 staging 和 completion 不可用。[ADR 0014](../../../../docs/adr/0014-stable-resource-bindings-over-canonical-worktrees.zh.md)拥有该生命周期。

提议中的 [domain KV 存储与 Workspace](2026-07-24-domain-kv-storage-and-workspace.zh.md) Agent Note 拥有 DSH Workspace 的 `fs.realpath` 唯一性与不可变记录；本提案拥有 Saki 更高层的绑定身份、Git 观察、rebind 与 lease 语义。提议中的 [Installation 维护](2026-08-18-saki-forward-migrations-and-installation-maintenance.zh.md) Agent Note 拥有替换 Host 恢复，并把 `needs-rebind` 接入该生命周期。

已实现的[已有目录 Project 登记](../../implemented/architecture/2026-08-20-saki-existing-directory-project-registration.zh.md)建立首个稳定 Project 与 Resource Binding id、重复 worktree 身份检查和启动重新验证。已实现的[结构化 Git 决策](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)会为已绑定状态、Diff 与直接 mutation 重新验证精确 active Binding 及其 revision，并为每个 Binding 设置一个持久 write-admission owner。

[手动 Give-to-Agent 决策](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)把 `BindingWriteAdmission.agent-run` 设为一次手动 Agent 启动的长期可写所有者，使其与直接 Git operation 竞争同一条 row。独立 Execution Lease、rebind、retirement、repair、后继 Session 与物理 worktree 生命周期仍处于 proposed 状态。

## 考虑过的方案

**使用规范路径作为身份。** 它只能在位置存在时防止别名，无法跨越位置迁移或 Host 替换。

**使用 remote、branch、HEAD 或 common Git directory。** Clone 可以共享前三项；日常工作会改变 branch 与 HEAD；所有 linked worktree 共享 common directory。

**重写 Workspace 与 Session 路径。** 这会改变历史位置事实并违反 DSH 所有权。

**立即管理所有物理 worktree 操作。** 安全创建与删除会把 Git 产品范围扩张到最低 dogfood loop 之外。

## 验收标准

- 同一个可用 worktree 的不同别名拼写不能创建两个 Resource Binding 或 lease。
- 同一个 Repository 中的两个 linked worktree 保持独立，并可在不同绑定下并行运行。
- 缺失、移动、repair、替换 clone、dirty 与替换 Host 情况会明确停止或 rebind，且不会重写历史 Session。
- Rebind 与退役不能和活动可写 Run、terminal、Dispatch 或 Host Operation 竞态。

## 风险

Git 不提供可迁移 Repository 身份，因此部分位置迁移需要明确人工确认。过于宽松的确认可能把 Project 连接到错误 clone；Saki 必须展示新旧证据并保留 Actor 记录。推迟物理 worktree 操作会在首个版本保留 terminal 与 Git fallback，但可避免在绑定生命周期得到验证前引入破坏性行为。
