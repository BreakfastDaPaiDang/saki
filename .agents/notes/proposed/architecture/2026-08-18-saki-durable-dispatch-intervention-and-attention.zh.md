# Agent Note: Saki 持久派发、介入与待处理事项

Status: proposed

[English](2026-08-18-saki-durable-dispatch-intervention-and-attention.md) | 中文

## 问题

Saki 必须启动手动与自动工作、在重启后恢复工作，并在后续把工作交付给远程 Host 或持久 Agent Identity。DSH 提供持久 Session 历史与几种实时执行机制，但没有产品级工作 dispatcher。Workflow run 保持前台运行，重启后无法恢复；已发布 Jobs registry 是进程本地实现；Schedule 交付依赖活动 Session；可继续 subagent 的 inbox 在一条运行时 lineage 内排序轮次，不表示 Project 责任或经过授权的 Host 交付。

人工交互存在类似缺口。DSH question 与 approval 在打开的 Agent turn 内等待。Approval 审计事件保留问了什么和如何决定，但实时 answerer 拥有待处理请求。进程丢失后不能依赖旧 Promise 仍然存在；已发布 continuation/report 路径也明确不提供持久 mailbox、delivery receipt 或离线重试。因此，Saki 不能只依靠这些实时机制实现可跨重启的自动化或操作者待处理事项。

## 提案

Saki 控制面实现 [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.zh.md)，并延续可恢复的 [Control Intent](2026-08-18-saki-recoverable-control-intents.zh.md)生命周期。Work Assignment、Execution Dispatch、Dispatch Claim、Intervention Request 和 Attention Inbox 保持为不同概念。

Work Assignment 记录一个 Work Item 的持续责任。Assignee 是 human Principal、持久 Agent Identity 或 Project Automation Principal；在 assignment 获得独立生命周期前，该记录可以留在 Work Item control metadata 中。Assignment 既不提供 Grant，也不创建 Agent Run。0.1.0 可以把手动责任分配给 Host Operator，把自动责任分配给 Project Automation Principal，而无需引入持久 Agent Identity。

当已接受 Control Intent 的副作用需要创建或恢复 Execution 时，系统会在唤醒任何 Host 前创建 Execution Dispatch。Dispatch 记录稳定的品牌 id、Intent id、目标 Agent Run 与 Work Session、目标 Installation 与 Host、Project 与 Resource Binding reference、Agent Profile version、已解析 Model Route reference、限制、不可变 Actor 归因、委派 Grant reference、payload digest、生命周期 revision，以及任何稳定 Host Operation reference。它只包含 reference，不包含 Host 路径、凭据、Agent handle 或 provider object。

Dispatch 采用至少一次交付。本地 scheduler、恢复后的 poller 或未来网络 adapter 可以重复提交同一 dispatch。只有携带当前 revision 与 fencing value 的有界 Dispatch Claim 才允许一个执行器进入；Host 通过 dispatch id 和目标 Agent Run id 对 `StartAgentRun` 去重。确认丢失时进入 `inspectOperation` 或对账，而不会创建第二个 Run。Dispatch Claim 协调命令 admission；Execution Lease 另行保护可写 Resource Binding 的所有权。

[带 fencing 的幂等 admission 提案](2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)拥有确切的 `pending`、`claimed`、`accepted`、cancellation、rejection 与 reconciliation 转换。它要求 Host 在产生副作用前准备一条持久 Host Operation，并要求控制面在 Host 启动 operation 前使用当前 fencing token 接受该映射。

[手动 Give-to-Agent 决策](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)通过 Work Assignment、主要 Work Session、Agent Run、Execution Dispatch、expected-revision Dispatch Claim、共享 Host Operation 生命周期与 Binding Write Admission，实现了一项显式 Ready-to-Run 操作。[持久 Intervention 回答决策](../../implemented/feature/2026-08-18-saki-durable-intervention-answer.zh.md)增加了文本输入 Intervention Request、同一 Run 与 Session 上的后续回答 Dispatch，以及 Principal-scoped Host Operator My Work 与 Attention Projection。自动领取、持久 Agent Identity 交付、通知 adapter 与通用恢复交互仍处于 proposed 状态。

Intervention Request 是持久控制面记录，包含稳定 id、kind、Project 与 subject reference、目标 Principal 或角色、所需决定或 input schema、阻塞范围、因果 Intent、Dispatch、Work Session 或 Agent Run reference、当前 revision、生命周期状态、可选 deadline 与 escalation policy。初始 kind 覆盖输入、审批、凭据授权、验收、冲突解决和对账。通知确认与请求解决是不同事实，过期不能产生批准。

针对 expected revision 的第一个有效授权回答胜出。回答通过新的 Control Intent 进入，获得独立 Actor 归因，并且只能满足已声明条件，不能授予额外权限。回答需要进入模型时，Work Session 接收带归因、可重建的 event 或持久 reference。实时 DSH question 或 approval Provider 可以把开放请求桥接到当前 turn。进程丢失后，Saki 通过后续带归因 turn 恢复，而不会假装已挂起工具调用仍然存活。

Attention Inbox 是 query projection，不是持久队列。它为一个 Principal 或 Agent Identity 连接开放 Work Assignment、Intervention Request、失败或需要对账的 Dispatch，以及选定 Signal。每个条目都链接到拥有它的记录，并公开可执行 Control Intent；关闭通知不会解决拥有记录。该名称与 Work Management 中作为 Work Item Status 的 `Inbox` 保持区别。

已实现的手动与 Intervention 决策会持久化 Execution Dispatch 与 Intervention Request 记录，并公开简化的 Host Operator My Work 与 Attention Projection。持久 Agent Identity inbox、Project Coordinator assignment、跨 Host 交付、飞书或 QQ adapter 与通用定时工作仍是这些记录的后续 Consumer。

## 考虑过的方案

**把 Control Intent 扩展为唯一队列与交互记录。** Intent 是已接受、带归因的命令与恢复 envelope。如果还让它拥有执行器 claim、assignment、问题 schema、回答目标和每种用户 View，就会把授权准入与几个独立变化的生命周期耦合，并使具有多个副作用的 Intent 含义不明。

**用 DSH Agent inbox event 作为持久 dispatch。** Agent inbox event 为一个 Session 关联已经接受和领取的消息。它们不选择已登记 Host、不携带 Project Grant、不预留 worktree、不授权离线响应者，也不会在 Agent dispose 后作为未领取产品工作继续存在。Saki 把这些 event 用作 Execution evidence，而不是产品命令。

**用可继续 subagent 作为 Project worker。** 可继续 child 在确切 parent lineage 下提供持久对话 identity 与冷恢复。[Work Session 决策](2026-08-17-saki-work-sessions-over-dsh-lineage.zh.md)让产品所有权独立于该 lineage；已发布 report 与 settlement 路径也承认，离线交付需要单独的寻址、授权与 replay protocol。

**持久化一张 Attention Inbox 表，并把其中行视为工作。** 这会简化第一个 query，却会复制 assignment、intervention 与 recovery state，并迫使每个 View 专用的关闭或排序变化进入命令生命周期。Projection 使每项底层事实只由一个 owner 管理。

**把通知作为持久边界。** Delivery adapter 可以证明自己发送或展示了消息，不能证明获得授权的目标理解或回答了它。通知重试仍然有用，但不能结算 Intervention Request state。

**合并 Dispatch Claim 与 Execution Lease。** Dispatch 可以启动不需要 worktree Lease 的只读 Execution，而一个可写 Agent Run 可以在启动 dispatch 结算后跨越多个 Host Operation 继续持有 Execution Lease。合并两者要么会过度锁定只读工作，要么会过早释放写入所有权。

## 验收条件

- 已提交 Execution Dispatch 在任何 Host 被唤醒前发生进程重启后仍然存在，并保持可交付。
- 重复交付同一 dispatch 不能创建第二个 Agent Run；陈旧或竞争 Dispatch Claim 不能执行它。
- Dispatch Claim 与 Execution Lease 作为不同不变量接受观察与测试。
- Host 确认结果不明时，系统会检查或进入 reconciliation required，不会把它当作启动失败。
- Intervention Request 在 Web 重连和进程重启后仍可回答，不依赖旧的进程内 Promise。
- 针对 expected revision 的第一个有效授权回答胜出；陈旧、重复、未授权和扩大权限的回答都会被拒绝。
- 进入模型的 intervention 回答可从 Work Session 重建，包括 Actor 与来源 reference。
- Attention Inbox 可以完全根据拥有记录重建，而且通知确认不会解决条目。
- 产品文案与 API 区分 Attention Inbox 和名为 Inbox 的 Work Item Status。
- 0.1.0 自动工作要么达到可恢复 Dispatch 结果，要么产生可见 Intervention Request，绝不会消失在进程本地队列中。

## 风险

Dispatch 安全依赖每个 Host 实现都遵守[该 admission 提案](2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)中的 preparation、current-fence acceptance 与 start 顺序；违反协议的 adapter 仍可能重复副作用，必须隔离并进入 reconciliation。持久 Intervention Request 无法恢复任意 provider 或 tool stack frame；DSH 缺少可恢复 continuation 时，已实现的 Host Operator 路径会使用后续带归因 Session turn。Attention projection 连接多个 Project 后可能开销较高，但在测量前保存复制 inbox row 会制造更难处理的一致性问题。后续通知 adapter 也需要去重与隐私 policy，同时不能成为授权通道。
