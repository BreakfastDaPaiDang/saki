# Agent Note: Saki 带 fencing 的幂等 dispatch admission

Status: proposed

[English](2026-08-18-saki-fenced-idempotent-dispatch-admission.md) | 中文

## 问题

进程丢失、claimant 超时或 Host acknowledgement 缺失后，Saki 必须重新交付持久 Execution Dispatch。Dispatch Claim 可以选择一个当前执行器，但它自身既不能阻止已过期 claimant 迟到行动，也不能区分尚未执行的 operation 和 Host 行动后回复丢失。把任一结果不明情况作为新启动重试，都可能创建第二个 Agent Run 或重复其他外部副作用。

Dispatch 交付时间短于结果 Execution。让一条 claim 覆盖完整 Agent Run 会延迟恢复，并与保护可写 Resource Binding 的独立 Execution Lease 重叠。该设计需要短期 admission claim、稳定 Host-side operation identity，以及不声称跨系统事务的显式 reconciliation。

## 提案

Saki dispatch module 将实现 [ADR 0010](../../../../docs/adr/0010-fenced-idempotent-dispatch-admission.zh.md)，作为 [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.zh.md)之下的精确 claim 与 admission 协议。Execution Dispatch、Dispatch Claim、Host Operation、Agent Run 与 Execution Lease 保持为不同记录，并具有不同的完成含义。

[已实现的结构化 Git 决策](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)提供直接 `control-intent` Host Operation source，以及 source-general `prepareOperation`、`startOperation`、`inspectOperation` 与 `cancelOperation` Host Execution 生命周期。[手动 Give-to-Agent 决策](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)为一条 `StartAgentRun` 路径实现 Execution Dispatch、Agent Run 与 Dispatch Claim 记录，以 `execution-dispatch` 扩展 operation-source union，并使用长期 `BindingWriteAdmission.agent-run` 所有权。本提案仍覆盖通用 dispatch source、独立 Execution Lease、自动 backoff 与 retry budget、多 Dispatch orchestration 和远程 admission。

### 状态与所有权

| 记录 | 拥有的事实 |
|---|---|
| Execution Dispatch | 目标副作用、目标 Host 与 Execution、交付状态、attempt、当前 claim 和已接受 Host Operation reference。 |
| Dispatch Claim | 当前执行器、claim id、单调递增 fencing token、签发与过期时间，以及续期或 acceptance 使用的 dispatch revision。 |
| Host Operation | 从 dispatch id 到已准备 operation 的 Host-side 幂等映射、目标 Execution、payload digest、prepared 与 accepted fencing token 和 operation 生命周期。 |
| Agent Run | 一次 Agent Execution 及其实际 Session、Profile、model route、evidence 与 outcome。 |
| Execution Lease | 目标 Agent Run 对一个 Resource Binding 的排他可写所有权。 |

Dispatch 生命周期为 `pending`、`claimed`、`accepted`、`canceled`、`rejected` 或 `reconciliation_required`。`accepted` 表示交付具有持久 Host Operation receipt，不表示 operation 已经启动或完成。最后一种状态会停止自动交付，直到带归因的 reconciliation Control Intent 记录已经证实的解决结果。

### Admission 协议

1. 控制面在任何 wake-up 前把 dispatch 持久化为 `pending`。持久 scanner 选择 `nextAttemptAt` 已到达的记录；进程内 signal 只会触发该扫描。
2. 获取 claim 时，系统针对 expected dispatch revision 执行 compare-and-set，把 `pending` 改为 `claimed` 或替换已过期 `claimed` 记录、递增 fencing token，并记录有界 expiry。同一执行器续期时必须持有未过期 claim 并提供 expected revision，而且保持 token 不变；过期后重新领取会递增 token。
3. 可写 dispatch 只有在目标 Agent Run 持有必需 Execution Lease 后才符合条件。当 cancellation、Grant revocation、Automation Policy、Host enrollment 或 capability inventory 不再允许尚未启动的副作用时，admission 也会 fail closed。
4. `prepareOperation` 会提交稳定 `execution-dispatch` source、目标 Agent Run、payload digest 与当前 claim。Host 向控制面验证 claim，并在产生任何外部副作用前，以 dispatch id 为键原子创建或返回 Host Operation。后续有效 claim 会复用该 operation，并更新 prepared token；如果重复请求的不可变 input 不同，则返回 conflict。
5. 所有需要等待的 Host 工作结束后，控制面对同一条未过期 claim 执行 compare-and-set，在把 dispatch 转为 `accepted` 时持久化 operation reference。Acceptance 失败会使已准备 Host Operation 保持 inert。
6. `startOperation` 在启动或恢复 Host Operation 前验证已接受 dispatch、operation reference、fencing token、当前 cancellation state 与 capability-boundary authority。该调用按 operation reference 保持幂等。恢复时重复该调用或执行 `inspectOperation`，绝不会重新分配目标 Agent Run。
7. 陈旧 claimant 无法续期、accept 或 start。Claim 过期不会取消已接受 operation，也不会释放其 Execution Lease。后续 inspect 或 cancel 请求使用各自的 Control Intent 与当前授权。

### 恢复规则

- Host preparation 前确认的瞬态失败会释放 claim，记录 `attemptCount`、`nextAttemptAt` 和 `lastError`，并在可配置 backoff 下让同一 dispatch 回到 `pending`。
- Acknowledgement 丢失后，系统先按 dispatch id 执行 inspection。匹配的已准备或已启动 Host Operation 会复用同一 operation reference。
- 确认不存在后，可以在旧 claim 过期后获取新 claim。结果不明或证据冲突会把 dispatch 改为 `reconciliation_required`，并在需要操作者行动时创建 Intervention Request。
- 耗尽配置的重试预算也会停止在 `reconciliation_required`；任何 retry limit 或 delay 都不是 plugin 中的硬编码常量。
- 接受前取消会推进 dispatch revision，并把 `pending` 或 `claimed` 改为 `canceled`；Host 绝不会启动 inert 的已准备 operation。
- 接受后取消会保留 dispatch 的 `accepted` 状态，并单独针对 Host Operation 或 Execution，从而保存交付 receipt 与结果 cancellation outcome。

即使两个面在 0.1.0 中共享一个进程，Local Host 仍会持久化 Host Operation registry。Host Execution Service Definition 公开 prepare、start、inspect 与 cancel 方法，使后续网络 adapter 保留相同顺序。远程 Host 必须在线验证 admission；本协议不支持 offline start。

## 考虑过的方案

**只依赖 Dispatch Claim expiry。** Expiry 会在控制面转移 eligibility，但无法在 Host 侧 fence 已暂停 claimant，也无法对副作用后的回复丢失进行去重。Host 需要稳定 dispatch mapping 与 current-token validation。

**在控制面 transaction 内运行副作用。** `storageDomain` callback 不能包含外部调用，而且未来远程 Host、DSH、Git 与模型提供方无法加入该 transaction。Preparation 与 acceptance 记录使无法避免的分离过程可恢复。

**使用目标 Agent Run id，而不使用 Host Operation。** Agent Run identity 可以对 start 去重，但不能为 Git 或其他 Host dispatch variant 提供一个通用 inspection 与 cancellation reference，也无法记录 Host 是否在 DSH 启动前准入了请求。

**保持 claim 直到 Execution 完成。** 这会合并 delivery ownership、长时执行与 Resource Binding ownership，延长故障发现时间，并使一条 claim 覆盖彼此无关的 Host Operation。

**自动重试所有结果不明情况。** 只有 Host idempotency 或确认不存在能够证明发生了什么时，重复才安全。盲目重试会把 observation failure 转化为另一次可能计费或产生 mutation 的副作用。

## 验收条件

- 持久状态机只允许文档规定的转换，而且每次 claim、acceptance、cancellation 与 reconciliation mutation 都使用 expected revision。
- 每条新 claim 的 fencing token 都大于该 dispatch 的所有先前 claim；续期保持 token，而且过期 claim 无法续期。
- Host preparation 在调用任何外部能力前，按 dispatch id 写入或读取一条 Host Operation。
- 完全相同的重复请求返回同一 Host Operation；不可变 input 不同会以 conflict 拒绝，并成为 reconciliation work。
- 控制面接受相同 operation reference 与 fencing token 前，Host 无法启动已准备 operation。
- 在 dispatch 持久化、claim、preparation、acceptance 或 start 后发生崩溃时，系统通过同一 dispatch 与 Host Operation 恢复，不会创建第二个 Agent Run。
- Acknowledgement 丢失后先执行 inspection；结果不明绝不会成为推定失败。
- 接受前取消会阻止 start；接受后取消会保留 dispatch receipt，并单独控制 operation。
- Execution Lease 与 Dispatch Claim 的有效性分别 fail，而且两种生命周期都不会释放另一种记录。
- 本地配置会验证 claim duration、retry backoff 与 retry budget；plugin 不包含部署专用的硬编码 tunable。

## 风险

Prepare 与 start 分离会增加一条 Host Operation state 和更多崩溃点，因此恢复测试必须覆盖每个持久边界，而不是只覆盖 happy path。Host 实现在 preparation 期间产生副作用，或者未经已接受 fencing validation 就启动，都违反该协议；Saki 必须隔离受影响 dispatch 与 Resource Binding，并标记为 reconciliation required。在线 validation 还意味着控制面丢失期间远程 Host 无法启动新工作；这是有意接受的可用性权衡，只有另行设计 offline delegation 与 revocation model 后才能重新考虑。
