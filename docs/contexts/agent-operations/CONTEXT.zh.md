# Agent Operations

[English](CONTEXT.md) | 中文

Agent Operations 定义 Saki 如何命名持久 Agent 主体、可复用执行配置、单次尝试和输入事实。

## 语言

**Agent Identity**：可被定址的持久 Agent 主体，可以跨越多次 Execution 拥有持续责任、收件箱、长期记忆和历史。它说明谁持续承担工作，不说明单次尝试如何配置。_避免_：Agent Profile、Agent Session

**Agent Profile**：具名、可复用、可版本化的执行配置，声明角色指令、上下文来源、所需工具与权限、模型路由、预算和兼容的触发类型。它说明 Agent Run 如何工作，不说明谁拥有持续责任。_避免_：Agent Identity、Agent Preset

**Execution**：由 Agent、工作流、定时或事件驱动进程完成的一次可追踪尝试。Execution 完成本身不证明已验收或已产生业务结果。_避免_：Work Item、Session

**Agent Run**：由 Agent 执行的 Execution。它记录实际 Agent Profile 版本，并可在工作由持久主体承担时引用 Agent Identity。_避免_：Agent Session、Agent Identity

**Signal**：由人、机器或 Agent 产生的带来源时点事实。Signal 提供信息，但不授予执行权限。_避免_：Work Item、命令

**Event Subscription**：Project 用于选择外部事件并把它们规范化为带来源 Signal 的持久订阅。Automation Policy 决定这些 Signal 产生的效果。_避免_：定时任务、Automation Policy
