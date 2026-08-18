---
status: accepted
---

# 持久化 Execution Dispatch 与 Intervention Request，以投影表示待处理事项

[English](0009-durable-dispatch-intervention-and-attention-projections.md) | 中文

Saki 把每个创建或恢复 Execution 的请求持久化为 Execution Dispatch，并把每个人工操作请求持久化为 Intervention Request。Work Assignment 记录持续责任，而 Attention Inbox 只是未解决责任与介入请求的投影。DSH 运行时队列、实时问题、通知和产品 View 都不拥有这些事实。

## 决策原因

Control Intent 与 Execution Dispatch 回答不同问题。Control Intent 记录 Saki 接受了哪一项带归因、经过授权的产品变更。Execution Dispatch 记录由此产生的一次 Execution 如何到达已登记 Host，以及该交付是否仍需领取、检查、重试或对账。一个 Intent 可以同时更新 Saki 记录并产生多个外部操作；如果把它的生命周期当作执行队列，授权与副作用交付就会耦合。

DSH 已经提供几种范围更窄的机制。Schedule 把提醒状态保存在 Session 日志中，但只在 Session 活跃时交付。Workflow 会持久化观察历史，但实时 run 仍由调用方持有，重启后不能恢复。已发布 Jobs Provider 是进程本地实现。可继续 subagent 可以从持久 Session 冷恢复，但其 Agent inbox 只为一条运行时 lineage 排序轮次，不是离线、经过授权的 Project mailbox。用户问题与审批在打开的 Agent turn 内等待；它们的审计事件不能让进程消失后仍未回答的请求独立接受回答。

因此，Saki 要承诺自动工作、重启恢复、未来远程 Host 或 Project Coordinator，就需要产品级记录。系统在唤醒 Host 前持久化 dispatch，使交付可以重复而不会丢失已接受工作。稳定 dispatch identity 与有界 Dispatch Claim 防止重复交付创建多个 Agent Run。该 claim 不同于 Execution Lease：前者为一条命令选择一个消费方，后者防止多个可写 Run 并发访问同一 Resource Binding。

人工介入也具有相同的持久性要求。Agent、自动化 policy、提供方登录或对账流程可能在原进程或 model turn 结束后仍需要输入。请求必须保留主题、目标对象、所需决定、阻塞范围、状态、deadline 或 escalation policy，以及因果引用。通知送达不是回答，超时也绝不表示批准。

责任仍是另一个独立概念。Work Assignment 标明预期继续推动 Work Item 的 human Principal、Agent Identity 或 Project Automation Principal。它不授予权限，也不启动模型调用。因此，Project Coordinator 可以跨越可替换 Session 持续承担责任，而各次 Agent Run 仍是可追踪的单次尝试。

## 考虑过的方案

**用 DSH Agent inbox 充当 Saki 工作队列。** 该 inbox 为一条实时或可恢复 Agent lineage 排序消息。它不表示 Project 责任、Host 选择、Grant、dispatch claim、交付 receipt 或离线介入，而且会让产品归属依赖运行时父子关系。

**用 DSH Workflow 或 Jobs 记录充当 dispatch 权威来源。** Workflow 执行位于前台，而且没有执行恢复 journal；已发布 Jobs registry 是进程本地实现。两者仍可作为 Execution 实现，但不能跨重启拥有已接受产品工作。

**只在 Work Session 中保存待处理介入。** Session 必须保留所有模型可见回答，但仅有日志条目无法提供独立可寻址请求、经过授权的响应者、首个有效回答规则、deadline、escalation 或跨 Project 操作者视图。

**让 Attention Inbox 条目成为权威队列记录。** 复制出的队列条目会在 Work Assignment、Intervention Request、Dispatch 或恢复记录之外再造一套生命周期。通过投影重建与重新查询，每项事实只有一个来源，不同用户也能获得不同 View，而无需复制命令。

**合并 Dispatch Claim 与 Execution Lease。** 两种 claim 保护不同不变量。只读 Execution 仍需要带 fencing 的幂等 dispatch admission，却不需要 worktree Lease；一个可写 Run 也可能在启动 dispatch 已结算后继续持有 Execution Lease，并执行多个 Host Operation。

**把通知送达或超时当作回答。** 浏览器、飞书或 QQ adapter 最多确认 transport，不能证明具备权限的对象作出了决定；超时自动批准还会把可用性故障变成权限来源。

## 影响

已接受 Control Intent 可以在唤醒任何 Host 前创建持久 Execution Dispatch。Dispatch 标明目标 Execution、Host、Project、Work Session、Agent Profile version、资源需求、Actor 与委派 Grant reference，以及当前交付状态。系统可以重复尝试交付，但消费方必须提交当前 Dispatch Claim 与稳定 dispatch id，使 Host 创建或恢复同一个 Agent Run，而非另一个 Run。[ADR 0010](0010-fenced-idempotent-dispatch-admission.md)拥有 claim 过期、重试、fencing 与幂等 Host admission 规则。

Intervention Request 是面向输入、审批、凭据授权、验收、冲突解决或对账的持久控制面记录。针对 expected revision 的第一个有效授权回答胜出，后续回答发生冲突。回答是一条具有独立 Actor 归因的新 Control Intent，不能扩展 Grant，而且只能通过可重建 Work Session event 或持久 reference 进入模型上下文。实时 DSH question 或 approval Provider 可以展示请求，但不拥有其持久性。

Attention Inbox 是开放 Work Assignment、Intervention Request、失败或结果不明的 Dispatch 与选定 Signal 的 read model。它不同于 Work Management 中表示未评估 Work Item 的 `Inbox` status。Web、email、飞书、QQ 与未来 Agent delivery adapter 可以通知或渲染同一组记录，但不会获得权限，也不会仅因确认送达就改变这些记录的生命周期。

0.1.0 不需要持久 Agent Identity 或 Project Coordinator，但需要持久 Execution Dispatch、Host Operator Intervention Request 和简化的 Host Operator Attention Inbox，使手动与自动工作能跨重启继续，并在需要人工处理时以可见状态停止。后续 Agent 专属 Attention Inbox 会复用这些记录，而不会增加另一套队列。
