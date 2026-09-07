# Agent Note: Saki 手动 Give-to-Agent dispatch

Status: implemented

[English](2026-08-18-saki-manual-give-to-agent-dispatch.md) | 中文

## Problem

只有显式执行“交给 Agent”操作才能启动一个可写 Agent Run；Work Item 仅仅处于 Ready 时不得消耗模型资源。控制面持久化、Host 准入、Session 输入交付与 Run 确认之间都可能发生进程丢失或 acknowledgement 缺失；恢复不得创建另一个 Run，也不得把原始模型可见输入插入两次。

Resource Binding 标识一个共享目录。长期独占 Run 预留会禁止并行对话和手动 Git 工作，却无法排除编辑器或外部进程。因此，Saki 把执行归因到各自的 Run 与 Session，但不承诺这些文件由其独占创作。

## Decision

控制面重新验证 Host Operator Grant、精确的当前 Issue 身份与远端指纹、活跃 Resource Binding 和 Agent Profile，并解析精确 provider/model 路由后，接受手动 `give-work-item-to-agent` Intent。路由解析不会启动生成；失败时不记录 Intent，并返回 `model-route-unavailable`。Intent 使用规范摘要固定完整 Issue 正文、Project、Profile、纯文本 `UserMessage` 及其消息来源。手动使用接受任意任务状态和自由格式的 Issue 文本，不要求读取分支保护，也不要求 Git 工作区干净、分支处于 attached 状态或没有冲突。这些事实可以供 Agent 或显式自动化策略参考，但不授权或禁止人类发起的对话。

接受操作会预先分配 Work Assignment、主要 Work Session、Agent Run、Execution Dispatch、精确 DSH Session 和输入 MessageId。这些记录及有序的 Run-to-Dispatch 关联会在唤醒 Host 前持久化。

`StartAgentRun` 使用带 `execution-dispatch` 来源的 Host Operation 生命周期。短期且带预期修订号的 Dispatch Claim 选择一次投递；续期保留 fencing token。最终接受要求同一 claim 在等待 Host 工作后仍为当前且未过期，随后在 Dispatch 上一起持久化已接受 token 与 Host 准入修订号。各个 Run 及后续回答 Dispatch 独立准入。`BindingWriteAdmission` 只为直接 Git 和 Branch Push 操作及其未决副作用保留预留。

Local Host 使用已固定的 cwd、Agent Preset 与 Model Route 创建或恢复精确 DSH Session。分离读取的物理 Session persistence 会提供完整 history，并把原始输入分类为 absent、pending、recorded、canceled or replaced、unknown 或 conflicting。获取 live Agent 后，Host 会在插入原始 `next-turn` 或唤醒 pending 输入前立即重新验证 Workspace 映射、规范仓库路径与 Git 管理目录身份。只有完全不存在时才允许插入原始输入。Host 会 flush 并重新检查该插入；pending 输入会收到确定且对模型不可见的 `next-step` wake，Agent pre-step filter 会在模型组装前移除该 Run 的 wake message。recorded 输入确认成功，而 canceled、replaced、unknown 或 conflicting evidence 一律不得重新发送。

Host Operation 成功表示预期 Agent Run、Session 与精确输入已经获得持久确认，并不表示模型轮次已经完成。Work Item 保持用户选择的状态。acknowledgement 缺失、重启和精确 replay 都复用全部预分配 id 与同一条 Host Operation。结果不明的副作用证据会停在 reconciliation required。

启动流程会先交叉验证精确的 running Agent Run、活动 Binding 与 succeeded Host Operation，再要求 Host 根据匹配的物理 Session header 和原始输入恢复 live Agent handle。恢复后的 Agent 保持 model-idle：恢复不会增加输入、wake 或模型请求。live dependency 不可用或发生不匹配时，启动流程不会进入 ready。

Dispatch 接受前取消会记录 canceled Dispatch；接受后取消保留已接受回执和终态 Host 快照。Host 会先停止并排空所属 live Agent，再由控制面持久化子记录与 Intent 取消。释放失败时操作保持可重试，句柄仍受跟踪。有效的多记录终态前缀保持单调，重启以幂等方式补全。

`SakiWorkItemDetailProjection` 与 `SakiAgentRunProjection` 固定前端交接，但本切片不增加 query。它们的严格 wire schema 只公开有界且经过解析的 Issue definition、Assignment 与主要 Work Session reference、不透明 Run source、可安全显示的 Profile 与 Model fact、时间戳，以及明确的 resumable、terminal 或 reconciliation recovery state；其中不包含规范路径、凭据或 Host snapshot。

当前状态版本 10 使用 `saki_control_plane@10`、`saki_host_execution@5` 和 `saki_storage_generation@8`。冻结的源 schema 保留各历史格式。v9-to-v10 迁移会校验历史 Agent 归属，把准入修订号保留到各自 Dispatch，清除 Agent 持有的 Binding 预留，并移除 Agent 的 Git 前置条件和从模板派生的 Issue 字段。迁移重新计算上下文及 Host 请求指纹，不改变 Session 历史、输入消息、身份或已接受凭据。手动 Git 预留保留各操作所需的证据。

## Alternatives considered

**增加 `prepareDispatch` 和第二个 Host registry。** 现有 prepare、start、inspect 与 cancel 生命周期已经拥有持久 Host 幂等性。并行 registry 会重复恢复与准入规则。

**在整个 Agent Run 生命周期内预留工作树。** Run 生命周期包括空闲对话和等待回答。将该生命周期串行化会阻止有用的共享目录工作，也无法隔离外部写入者。用户可以选择不同工作树；Saki 保留逐 Dispatch 授权、精确重放及操作范围内的 Git 校验。

**把 Agent send acknowledgement 或已 claimed 的 inbox entry 视为已交付。** 两项事实都可能先于持久记录。控制面报告 Run 已启动之前，必须显式 flush 并检查完整 history。

**要求工作流或 Git 就绪后才能手动对话。** 用户可能要求 Agent 澄清自由格式的 Issue、检查已关闭任务，或修复存在冲突或 detached HEAD 的工作树。这类限制既不隔离文件，也不证明权限，却会阻止用户要求的工作。显式用户意图授权输入投递；Git 修改在执行时校验自身的前置条件。

## Verification

无密钥组合测试通过可控 fake LLM 使用已交付的 Saki bundle、真实 Agent、物理 Session persistence、系统拥有的 Development Agent Preset 与 checkpoint-policy stack。它们证明已配置的 provider 与 model、persona、repository instruction 和 read、write、edit tool，精确的输入与插入次数，replay 前的 live-Agent registry membership，在不增加 wake 或模型请求的情况下恢复相同 Session id，最终资源身份重新验证，等待 acceptance 期间的 claim 过期，acceptance 前后取消，disposal 失败后的重试，以及从每个终态多记录写入前缀恢复。协议测试还会在保留任何 Agent operation 记录前拒绝无法解析的精确 Model Route，并在该 route 可解析后接受同一个 Intent；协议测试同时覆盖精确 replay、陈旧 claim、共享目录中的独立 Run、flush acknowledgement 丢失、被移除或替换的 inbox 输入，以及冲突 evidence。Projection contract test 会 round-trip 当前与最近 Run fixture，并审计其序列化值中不存在 Host 路径、凭据与内部 snapshot。

## Related proposals

本决策只对更广泛的 [dispatch 与 attention](../../proposed/architecture/2026-08-18-saki-durable-dispatch-intervention-and-attention.zh.md)、[带 fencing 的 dispatch 准入](../../proposed/architecture/2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md)、[可恢复 Control Intent](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)、[稳定 Resource Binding](../../proposed/architecture/2026-08-18-saki-stable-resource-bindings.zh.md)与 [Work Session lineage](../../proposed/architecture/2026-08-17-saki-work-sessions-over-dsh-lineage.zh.md) Agent Note 中的手动 Give-to-Agent 部分形成 partial supersession。[持久 Intervention 回答决策](2026-08-18-saki-durable-intervention-answer.zh.md)以本决策的精确 Run 与 admission 为基础增加后续操作员输入。这些 proposal 仍然有效，因为它们还覆盖自动领取、其他交互、通用 effect、rebind 与 retirement，或多个 Session 与 coordinator。

## Consequences

手动路径只会在显式 Intent 被接受后启动模型生成，并在崩溃后保留精确执行归因。多个 Run 可以共用一个目录，包括其他 Run 正在等待 Intervention 回答时。并发编辑可能冲突。恢复可能需要操作员对账；自动认领、生产 Provider 授权、账户健康、更多 Intervention 类型及通用定时分派仍不属于本决策范围。
