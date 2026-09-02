# Agent Note: Saki 基于 DSH 谱系承载 Work Session

Status: proposed

[English](2026-08-17-saki-work-sessions-over-dsh-lineage.md) | 中文

## 问题

DSH 可继续 subagent 提供持久子 Session、父级协调、独立 transcript，以及确切父级可用时的用户交互。Saki 需要一种用户可见协作记录，使其在协调 Session 重启或被替换、用户直接创建工作，以及一个 Work Item 需要重试或专项会话时仍可寻址。把 DSH `parentSession` 当作产品归属，会使这些场景依赖一条运行时谱系。

## 提案

Saki 控制面按照 [Agent Operations ADR 0002](../../../../docs/adr/agent-operations/0002-work-sessions-and-subagent-lineage.zh.md)，独立于 DSH Session 谱系记录 Work Session 身份、Work Item 关联、指派、主要状态和参与者来源。执行适配器把每个 Work Session 与一个 DSH session id 关联，并可以使用顶层 Session 或可继续 subagent；可选的 `parentSession` 数据仍只代表执行来源和运行时权限。

Project Coordinator 是通过可替换 Coordination Session 工作的持久 Agent Identity。它从 Work Session 接收带来源摘要和 Signal，并读取持久 Project 投影，而不在一个模型上下文中保留每个子会话的全文。人类消息、协调者消息和执行 Agent 消息即使进入同一个 Work Session，也保留不同的来源。

[手动 Give-to-Agent 决策](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)为每次已接受的手动启动创建一个主要 Work Session，并预分配一个顶层 DSH Session。多个 Work Session、Project Coordinator 身份与替换、并发专项 Session、会话间自主路由，以及嵌套执行后代的提升仍处于 proposed 状态。

## 考虑过的方案

**使用 DSH 父子谱系作为 Saki 归属。** 这可以复用现有授权和导航，但会把持久工作绑定到一个具体父 Session，也无法一致表达直接创建或外部执行的工作。

**要求每个 Work Item 只有一个 DSH Session。** 这会简化初始界面，但会把重试、重新指派、实现和专项审阅挤入同一个 transcript，并且无法把被替换的对话保留为历史。

**构建独立会话运行时。** 这会让 Saki 完全控制生命周期，但会重复 DSH 的持久化、模型循环、Provider 和 subagent 能力，而这些能力应当直接继承。

## 验收条件

- 一个 Work Item 可以保留多个 Work Session，但最多把其中一个指定为主要会话；并发是独立的策略决定。
- 替换协调 Session 或 Work Session 关联的 DSH Session，不会改变 Work Item 身份，也不会删除先前 transcript 和运行关联。
- Work Session 分别记录人类、协调者和执行 Agent 的消息来源。
- DSH 适配器可以用顶层 Session 或可继续 subagent 表达 Work Session，而不改变控制面语义。
- 一次性和嵌套 subagent 保持为可检查的执行后代，除非控制面显式提升并关联，否则不会成为 Work Session。

## 风险

Saki 关系与 DSH 谱系可能在崩溃或部分写入后发生偏差，因此适配器需要稳定标识和对账，而不能依赖树中的位置推断。把 Work Session 提升到 Project View 可能与 DSH 的嵌套 subagent 导航重复，因此每个入口需要明确的展示归属。DSH 目前会在确切父级不可用时限制对非活动 child 的直接继续操作，因此持久用户参与可能需要恢复协调者或增加更窄的上游继续能力。
