# Agent Note: Saki 手动 Give-to-Agent dispatch

Status: implemented

[English](2026-08-18-saki-manual-give-to-agent-dispatch.md) | 中文

## Problem

只有显式执行“交给 Agent”操作才能启动一个可写 Agent Run；Work Item 仅仅处于 Ready 时不得消耗模型资源。控制面持久化、Host 准入、Session 输入交付与 Run 确认之间都可能发生进程丢失或 acknowledgement 缺失；恢复不得创建另一个 Run，也不得把原始模型可见输入插入两次。

启动还会与直接 Git operation 共用 Resource Binding。第二套准入系统会让两条路径都以为自己拥有 worktree，也会增加稳妥接管历史仓库的难度。

## Decision

控制面会重新验证 Host Operator Grant、当前 Ready Issue 与 remote fingerprint、验收条件、Blockage、活动 Resource Binding、完整 inherited-change evidence、attached branch safety 与 Agent Profile，随后要求当前 LLM adapter 解析精确的 provider/model route；只有这些检查通过后，才接受一条手动 `give-work-item-to-agent` Intent。Route 解析不会启动生成；失败时不会记录 Intent，并返回 `model-route-unavailable`。接受的 Intent 使用 canonical digest 固定完整 Issue、Project、Profile、Git precondition、纯文本 `UserMessage` 及其 message source。

接受操作会预先分配 Work Assignment、主要 Work Session、Agent Run、Execution Dispatch、精确 DSH Session、输入 MessageId 和稳定的子 `MoveWorkItem` Intent。这些记录以及有序的 Run-to-Dispatch 关联会在唤醒 Host 前持久化。

`StartAgentRun` 使用 `execution-dispatch` source 扩展既有 Host Operation 生命周期。短期 expected-revision Dispatch Claim 对交付进行 fencing；同一个 executor 可以在预期 revision 上续期一项尚未过期的 claim，而不改变其 fencing token。等待所有 Host preparation 与准入检查后，最终 Dispatch compare-and-set 会要求该精确 claim 仍是当前 claim 且尚未过期。现有 `BindingWriteAdmission` row 是唯一可写所有者。它的 `agent-run` variant 命名来源 Intent 与 Agent Run，而非 Dispatch，因此直接 Git operation 与 Agent 启动会竞争同一条原子 row，并且一个 Run 可以在后续 Dispatch 之间继续持有所有权。

Local Host 使用已固定的 cwd、Agent Preset 与 Model Route 创建或恢复精确 DSH Session。分离读取的物理 Session persistence 会提供完整 history，并把原始输入分类为 absent、pending、recorded、canceled or replaced、unknown 或 conflicting。获取 live Agent 后，Host 会在插入原始 `next-turn` 或唤醒 pending 输入前立即重新验证可写 Git world。只有完全不存在时才允许插入原始输入。Host 会 flush 并重新检查该插入；pending 输入会收到确定且对模型不可见的 `next-step` wake，Agent pre-step filter 会在模型组装前移除该 Run 的 wake message。recorded 输入确认成功，而 canceled、replaced、unknown 或 conflicting evidence 一律不得重新发送。

Host Operation 成功表示预期 Agent Run、Session 与精确输入已经获得持久确认，并不表示模型轮次已经完成。只有此后，稳定的子 Intent 才会把 Work Item 移到 In progress。acknowledgement 缺失、重启和精确 replay 都复用全部预分配 id 与同一条 Host Operation。结果不明的副作用证据会停在 reconciliation required。

启动流程会先交叉验证精确的 running Agent Run、活动 Binding 与 succeeded Host Operation，再要求 Host 根据匹配的物理 Session header 和原始输入恢复 live Agent handle。恢复后的 Agent 保持 model-idle：恢复不会增加输入、wake 或模型请求。live dependency 不可用或发生不匹配时，启动流程不会进入 ready。

在 Dispatch acceptance 前取消会记录 canceled Dispatch；acceptance 后取消会保留 accepted receipt，并记录终态 Host snapshot。Host 会先停止并排空所拥有的 live Agent，控制面随后才持久化子 Intent 取消并释放 write admission。disposal 失败会让 operation 保持可重试，并继续跟踪 handle。终态多记录更新只会沿有效的单调前缀推进，启动流程会幂等完成任何保留前缀。

`SakiWorkItemDetailProjection` 与 `SakiAgentRunProjection` 固定前端交接，但本切片不增加 query。它们的严格 wire schema 只公开有界且经过解析的 Issue definition、Assignment 与主要 Work Session reference、不透明 Run source、可安全显示的 Profile 与 Model fact、时间戳，以及明确的 resumable、terminal 或 reconciliation recovery state；其中不包含规范路径、凭据或 Host snapshot。

手动 Give-to-Agent 最初通过 `saki_control_plane@7`、`saki_host_execution@2` 与 `saki_storage_generation@5` 落入状态版本 7。当前状态版本 9 使用 `saki_control_plane@9`、`saki_host_execution@4` 与 `saki_storage_generation@7` 保存这些记录；冻结的版本 7 domain schema 保留原始手动启动格式。v7-to-v8 migration 增加显式 Assignment ownership、Run waiting 与 resume-pending 状态、Intervention table 和 answer message source。v8-to-v9 migration 增加 Delivery record、action 与 Push Host operation format，但不改变保留的原始启动 request 或 evidence。

## Alternatives considered

**增加 `prepareDispatch` 和第二个 Host registry。** 现有 prepare、start、inspect 与 cancel 生命周期已经拥有持久 Host 幂等性。并行 registry 会重复恢复与准入规则。

**按 Dispatch 确定可写所有权。** Dispatch 是一次交付尝试，而可写所有权属于生命周期更长的 Agent Run。按 Dispatch 持有会在错误的生命周期边界释放或重新获取 worktree。

**把 Agent send acknowledgement 或已 claimed 的 inbox entry 视为已交付。** 两项事实都可能先于持久记录。控制面报告 Run 已启动之前，必须显式 flush 并检查完整 history。

**在 Work Item 进入 Ready 或 Dispatch 被接受时启动。** Ready 表示 eligibility 而非 authority，Dispatch acceptance 只证明 Host mapping 已准备。显式 Intent 与精确 Session evidence 让模型开销和 In progress 状态都有明确归因。

## Verification

无密钥组合测试通过可控 fake LLM 使用已交付的 Saki bundle、真实 Agent、物理 Session persistence、系统拥有的 Development Agent Preset 与 checkpoint-policy stack。它们证明已配置的 provider 与 model、persona、repository instruction 和 read、write、edit tool，精确的输入与插入次数，replay 前的 live-Agent registry membership，在不增加 wake 或模型请求的情况下恢复相同 Session id，最终可写 world 重新验证，等待 acceptance 期间的 claim 过期，acceptance 前后取消，disposal 失败后的重试，以及从每个终态多记录写入前缀恢复。协议测试还会在保留任何 Agent operation 记录前拒绝无法解析的精确 Model Route，并在该 route 可解析后接受同一个 Intent；协议测试同时覆盖精确 replay、陈旧 claim、共享 write admission、flush acknowledgement 丢失、被移除或替换的 inbox 输入，以及冲突 evidence。Projection contract test 会 round-trip 当前与最近 Run fixture，并审计其序列化值中不存在 Host 路径、凭据与内部 snapshot。

## Related proposals

本决策只对更广泛的 [dispatch 与 attention](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.zh.md)、[带 fencing 的 dispatch 准入](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)、[可恢复 Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)、[稳定 Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.zh.md)与 [Work Session lineage](../../proposed/architecture/2026-08-17-saki-work-sessions-over-dsh-lineage.zh.md) Agent Note 中的手动 Ready-to-Run 部分形成 partial supersession。[持久 Intervention 回答决策](2026-08-18-saki-durable-intervention-answer.zh.md)以本决策的精确 Run 与 admission 为基础增加后续操作员输入。这些 proposal 仍然有效，因为它们还覆盖自动领取、其他交互、通用 effect、rebind 与 retirement，或多个 Session 与 coordinator。

## Consequences

手动路径在接受显式 Intent 前不会启动模型生成，在崩溃前后保持单一 writer，并且只在取得新的 Git 与 branch-safety evidence 后接管已有仓库。恢复的代价是多记录状态机，并且为了安全可能要求操作者对账，而不会最大化可用性。自动领取、生产 provider authorization、credential 与 account health、其他 Intervention kind 和通用定时 dispatch 不属于本决策。
