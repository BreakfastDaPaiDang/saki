# Work Management

[English](CONTEXT.md) | 中文

Work Management 定义 Saki 如何组织预期工作、交付进度、里程碑和发布。

## 语言

**Work Item**：具有明确结果和验收条件的一项预期项目工作。_避免_：Ticket、card

**Work Item Status**：Work Item 当前所处的交付阶段，独立于其 Triage Role 和任何 Agent Execution 状态。_避免_：Project status、Agent status

**Inbox**：等待初步评估的 Work Item。

**Backlog**：已经接受但尚不能认领的 Work Item。

**Ready**：说明完整、没有阻塞并且可以认领的 Work Item。

**In progress**：已经认领并正在实现的 Work Item。

**In review**：其实现正在等待评审、CI 或验收的 Work Item。

**Done**：验收条件已经满足的 Work Item。

**Canceled**：明确不交付并关闭的 Work Item。

**Blockage**：阻止进展但不取代 Work Item Status 的条件。_避免_：把 Blocked 用作 Work Item Status

**Outcome Evidence**：用于确定 Work Item 验收条件是否满足的可定位观察或产物，例如测试结果、commit、pull request、CI 结果、Release、部署状态、日志或业务指标。_避免_：Agent 成功消息

**Triage Role**：在 Work Item 被认领前，确定下一项人工或 agent 操作的路由决策。

**Board**：按 Work Item Status 分组显示 Work Item 的视图。

**Milestone**：对 Work Item 分组并衡量范围完成度的具名交付目标。Milestone 描述计划交付内容，而非已发布代码。_避免_：Release、version

**Milestone Phase**：Milestone 的交付阶段：Planned、In Progress、Ready to Release、Released 或 Canceled。

**Release**：由 Saki 版本标识的已交付仓库快照。_避免_：Milestone、build

**Release Tag**：把 Release 版本绑定到一个确切 commit 的 `saki-v*` Git tag。

**Release Commit**：为一次 Release 选定的确切 commit。_避免_：Versioned commit

**Upstream Baseline**：已经纳入一次 Saki Release 的确切官方 DeepSeek Harness commit。
