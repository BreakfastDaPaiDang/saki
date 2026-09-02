# Agent Note: Saki 持久 Intervention 回答

Status: implemented

[English](2026-08-18-saki-durable-intervention-answer.md) | 中文

## Problem

Agent 可能在原有浏览器连接或 Saki 进程消失后仍需要操作员作出决定。DSH question 与 approval 服务有意把待处理回答绑定到 live turn，因此保留其 Promise 无法提供可在重启后恢复的产品工作。Saki 也不能把通知、dismiss、timeout 或 transport acknowledgement 当作回答，因为它们都不能证明当前已授权 Principal 提供了所需输入。

回答必须成为可重建的模型输入，同时不得创建另一个 Agent Run、Work Session、write admission 或命令队列。从记录问题、完成工具轮次、接受回答、把回答追加到 Session，直至确认恢复后的 Run，任意两步之间都可能发生崩溃，因此每个局部状态都需要一条无歧义的恢复路径。

## Decision

Development Agent 使用 Saki 自有的 `request_intervention` 工具请求可在重启后恢复的操作员输入。该工具先提交或精确复用一条由 Agent Run 与带品牌的 Tool Call id 确定身份的 `opening` Intervention Request。只有持久写入成功后才会调用 `exec.concludeTurn()` 并返回稳定的 Intervention id；拒绝会抛错，且不会结束轮次。工具会等规范的成功结果与完整轮次 flush，随后才请求控制面继续 opening 流程。短暂的 finalization 失败会安排一次可配置的本地唤醒；成功或持久阶段已有 owner 时会移除它，因此恢复不依赖另一个 Session event，也不引入队列。

控制面通过 Local Host 检查精确的持久工具名、问题参数、结果、步骤与轮次。确认 evidence 后，系统会先把所属 Agent Run 从 `running` 改为 `waiting`，并把该 Intervention 设为唯一 blocker，随后再把请求改为 `open`。两次写入之间发生崩溃会留下可由启动流程完成的合法前缀。启动时发现的缺失、不完整或冲突 evidence 会进入 `reconciliation-required`；时间流逝本身绝不会让它变成开放问题。

Local Host 可能在控制面记录输入交付完成前就开始执行一份已经精确接受的输入。因此，只有在存在精确已接受 Dispatch 与 write-admission 前缀时，opening 才能与 `starting` 共存，或与 `resume-pending` 及其已回答前序请求共存。只有前序请求 resolved 且该次输入交付完成后，opening 才会成为 blocker。这个交接窗口最多容纳一个后继 opening；它不是队列，其他重叠请求都会被拒绝。

`intervention_requests` 在 Agent 轮次之外独立拥有问题。v8 record 是 Agent 请求的文本输入；其 owner、subject、blocking scope 与 return address 都命名精确 Agent Run，cause 则命名同一 Run 与 Work Session，并带上物理 Session 和 branded Tool Call id。它还保留 Project、目标 Principal、有界且 well-formed 的文本要求、revision、时间戳与生命周期状态。Return address 只包含稳定产品 id，不包含路径、凭据、浏览器 draft 或 provider 对象。该格式不编码通用 subject、Dispatch 拥有的恢复请求、deadline 或 escalation policy。

回答是一条独立的 `answer-intervention` Control Intent，并携带预期 Intervention revision。已认证请求不能提供 Actor 或 Grant 字段；控制面会派生不可变 Actor 归因，并重新检查当前 Principal、target、Grant、Assignment、Work Session、Resource Binding revision、保留的 Run write admission 与 operation condition。一次 Intervention compare-and-set 会选定首个已授权且 revision 精确的回答。精确 replay 返回同一 receipt；发生变化、陈旧、未授权、超出长度限制或改变 owner 的输入都不能替换胜者。

## Delivery and projections

已接受回答复用所属 Run 的持久 `RunInputPlan`。系统派生稳定 MessageId 与一条新的有序 Execution Dispatch，把受阻 Run 改为 `resume-pending`，并保留原有且生命周期更长的 `agent-run` write admission。普通 `StartAgentRun` Host Operation 会把带归因的回答作为新 user message 追加到同一个 Agent Run、Work Session 与物理 Session。Local Host 会 flush 并检查该精确 message，随后才报告成功。只有确认交付后，Run 才会恢复为 `running`、清除 blocker 并解析 Intervention；每个已 resolved 的历史回答都保留自己已接受的 Dispatch 与精确 succeeded Host evidence。未知或矛盾 evidence 必须进入 reconciliation；如果回答 Dispatch 与 Run 已进入 reconciliation，而 Intervention 尚未写入，启动流程会完成该精确崩溃前缀。

My Work 与 Attention 是根据当前 Project、已同步 Work Item、Assignment、Run、Dispatch、Grant、Binding 与 Intervention 派生的纯 Principal-scoped Projection。它们没有 inbox table 或全局 inbox revision。My Work 为每个 item 分配四种展示分组之一，并最多给出一个带原因的 Action Offer。活动或正在恢复的 Run 优先于更新但尚未接受的 Give 前缀；只有 assigned/allocated/pending 的前缀不会成为当前工作。本地可用事实可以在不执行网络操作的前提下生成候选 offer，但 offer 不构成 authority，提交时仍会重复实时 authorization 与 operation 检查。在 acceptance action 尚不存在时，In-review work 不公开该操作；Done 与 Canceled work 不公开 acceptance offer。

只有 `open` Intervention 会公开 answer offer 与 required response。进入 reconciliation-required 的 Intervention 仍以 warning 形式可见，但不提供可执行 answer。通知交付、重新连接、dismiss、timeout、acknowledgement 与客户端自有 draft 变更都不会修改 Intervention 状态。

## Alternatives considered

**在重新连接期间保留 live DSH question Promise。** live provider 可以在所属轮次存在时收集回答，但进程丢失会销毁待处理 continuation，也无法建立持久产品 ownership。

**持久化 Attention Inbox 队列。** 复制的 inbox row 会重复权威 Assignment、Dispatch 与 Intervention 生命周期，并引入另一套 revision 与恢复协议。派生 Projection 会让 mutation authority 留在所属记录中。

**恢复被挂起的工具 frame，或创建替代 Run。** DSH 不会持久化任意 JavaScript continuation，而替代 Run 会拆分 Work Session 与 write ownership。后续带归因的 user message 可以保留既有 Session history 与普通 Run-start 幂等性。

**让通知 acknowledgement 或 timeout 结算请求。** 这些事件描述交付或时间流逝，而非已授权回答。把其中任一事件视为批准都会允许静默升权。

## Verification

无密钥产品与协议测试覆盖 opening flush 与重试顺序、精确问题与结果检查、初始输入及回答输入交付与即时 Intervention 请求的两种先后顺序、重启与 reconciliation 前缀、每个回答的 Dispatch evidence、首个写入方回答选择、陈旧与已撤销 authority、timeout 与通知独立性、当前 return address、同一 Session 中的回答重建、Host replay、并发 Give 投影前缀，以及通过类型化 Host API 派生 My Work 与 Attention。历史 schema 保持冻结，相邻 migration 则增加 Intervention table 与当前 answer message source。

## Related proposals

本决策实现了更广泛的[持久 dispatch 与 attention 提案](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.zh.md)中的 Intervention、回答交付与 Host Operator Projection 部分。[手动 Give-to-Agent 决策](2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)拥有原始 Run、Dispatch、Session 与 write-admission 生命周期。自动领取、持久 Agent Identity 交付、通知 adapter 与通用恢复交互仍由提案拥有。选定的持久 Git、拉取请求与 CI observation 仍由其生产者拥有，并通过[后续工作 #74](https://github.com/BreakfastDaPaiDang/saki/issues/74)进入这些 Projection；在这些生产者出现前，不存在通用 Signal aggregate。

## Consequences

操作员问题可以跨越浏览器与进程丢失，保留一个权威回答，并在不增加第二个队列或 execution identity 的前提下重新进入精确的模型可见 Session。代价是额外的持久 aggregate、相邻状态 migration，以及对不明确局部 effect 的显式 reconciliation。该设计有意放弃恢复任意 live stack frame，也不会在 Projection 读取期间执行依赖网络的 eligibility 检查。
