# Agent Note: polling-first 分阶段 GitHub 同步

Status: proposed

[English](2026-08-18-saki-polling-first-github-synchronization.md) | 中文

## 问题

Saki 让 GitHub Projects v2 成为共享 Work Item Status 与手动排序的权威，但本地乐观移动、分页读取、遗漏 webhook 交付、映射重建和并发 GitHub 编辑都可能让 Board 展示 GitHub 从未确认的状态。Page cursor 不是持久变更 offset，mutation timeout 也不能证明 GitHub 是否应用了 effect。

## 提案

0.1.0 版本使用可配置轮询作为基线，只发布完整的分阶段 Project 与 Repository 扫描。GitHub Sync Checkpoint 与已确认快照原子推进；进行中的 page cursor 在成功或失败后丢弃。活动和后台轮询默认分别为 30 秒与五分钟，而启动、手动刷新、本地 mutation、重连和后续 webhook 会唤醒同一个扫描器。

每个 mutation 都包含预期远端指纹。定向读取允许幂等成功或执行预期写入；不匹配会成为可见冲突。适配器在 mutation 后确认目标，并在重试前检查歧义回复。Node-id 映射缺失会使写入不可用，直到带归因的修复 Intent 与完整扫描成功。

Board checkpoint 与定向 PR、CI、Milestone、tag、Release、Commit 和祖先关系读取保持独立。只有 View 处于活动状态，或相关 Intent、Run、delivery、reconciliation 仍在 pending 时，这些事实才按可配置 polling 刷新；每个 Projection 携带自己的 observation、failure、staleness 与 invalidation 状态。Tag 从 `refs/tags/saki-v*` 开始，递归 peel annotated target 得到 Commit；Release `target_commitish` 不是 evidence。

单一版本化 Milestone Delivery record 拥有 Saki 的 Planned、In Progress、Ready to Release 或 Canceled phase，以及可选不可变 Release Evidence。带 expected revision 的 finalization 验证准确官方 Upstream Baseline 存在于配置的 upstream repository，且是 peeled Release Commit 的祖先，然后在该 record 中原子嵌入 evidence。Released 只从匹配 evidence 派生；外部关闭或并发变化会进入 repair、conflict 或 reconciliation，不会发布局部结果。

每个 installation-token 队列会让 mutation 读取、mutation、确认、登录与手动刷新优先于后台扫描。可配置保留量、GraphQL cost 事实、REST 条件读取、`Retry-After` 与有界退避保护交互工作，并防止 secondary-limit 重试风暴。[ADR 0013](../../../../docs/adr/0013-polling-first-staged-github-synchronization.zh.md)拥有完整协议。

已实现的 [Saki 上游同步](../../implemented/process/2026-08-15-saki-upstream-synchronization.zh.md)拥有 repository 纳入工作流，与产品 GitHub 同步及 Release Evidence 相互独立。

## 考虑过的方案

**要求 webhook。** 这会增加公共入口与恢复工作，却不会消除协调扫描需求。

**把 GraphQL cursor 持久化为变更 offset。** 它只能为一个 connection 遍历分页，无法证明移除或较早页面未改变。

**在页面到达时发布。** 后续失败会把部分世界暴露为已确认状态。

**使用 last-writer-wins mutation。** 这会覆盖并发 GitHub 工作并违背权威性决策。

**使用 Release `target_commitish` 或单独 evidence record。** 类似 branch 的 target 不能证明 tag Commit；单独 record 还会增加不必要的原子性与恢复问题。先准确递归 peel，再把 evidence 内嵌到同一 record，可以保持单一 owner。

## 验收标准

- 多页扫描只发布一个原子 revision，任何不完整扫描都会保留旧 revision。
- 外部变更、移除、重建映射、mutation 回复丢失、rate limit 与重启都会收敛，且不会把乐观状态当作已确认状态。
- 客户端投影会区分已确认状态、乐观状态、时效、冲突、映射修复与传输失败。
- 加入 webhook 后，它只会唤醒扫描器。
- 定向 delivery observation 保留独立 freshness 与 failure state，不推进 Board checkpoint。
- Annotated tag 会 peel 到准确 Commit；finalization 证明官方 upstream baseline 是其祖先，并通过一次 expected-revision Milestone Delivery update 内嵌不可变 Release Evidence。

## 风险

轮询会延迟可见性，并可能在多个 Project 上消耗 API allowance。可配置间隔、优先级、条件读取与完整扫描 telemetry 会限制该成本，而后续 webhook 唤醒可以降低延迟。GitHub 缺少通用 mutation compare-and-set，因此预读取与确认协议能发现并暴露冲突，却不能承诺可串行化跨系统写入。
