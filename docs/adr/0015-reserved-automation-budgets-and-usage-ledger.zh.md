---
status: accepted
---

# 在外部 effect 前预留自动化预算并结算到 usage ledger

[English](0015-reserved-automation-budgets-and-usage-ledger.md) | 中文

只有 Project Automation Principal 具备所需 Grant，且当前 Automation Policy 能预留所有适用硬预算时，自动模式才准入工作。每笔预留都持久化，以幂等方式关联 Control Intent 或外部 operation，并根据带归因的用量观察进行结算。缺失的提供方 quota 或计费数据绝不会被解释为零消耗或无限供给；版本化策略必须明确选择是否允许更严格的本地可测限制授权该 route。

## 决策原因

Run 后用量计数器不能防止超支或过量并发。多个自动 Run 可能同时观察到同一剩余额度，并在任何实际用量被记录前全部开始。进程崩溃或提供方响应丢失也会让实际消耗不确定。因此准入需要在 effect 前原子预留以及持久结算账目，而不只是 dashboard 估算。

Grant 与预算解决不同问题。Grant 允许在资源 scope 内执行操作；它不决定自动模式使用该权限的次数、持续时间或资源成本。Automation Policy 在不扩张 Grant 的情况下施加这些限制。手动 Host Operator 操作可以使用单独的明确例外 Intent，但不能让自动 Principal 静默超出任一机制。

不同提供方订阅暴露的 telemetry 并不一致。DSH 可以观察已完成模型调用的请求和 token 用量，而提供方可能只暴露陈旧的 allowance window、近似百分比，或者完全不暴露账号用量。GitHub 可以在 workflow 发生后报告 run 与时长，但一次 push 可能在 Saki 知道最终可计费分钟前触发 workflow。单一合成美元计数器会隐藏这些差异，并让不可用数字显得精确。

## 预算模型

### 记录与 scope

Automation Policy 带版本，并声明适用 limit、window、暂停规则、未知用量行为、允许的交付操作和所需完成证据。Automation Budget Reservation 记录策略 revision、Actor、Intent 或 Host Operation、Project、Work Item、Agent Run 或 Generation Job、适用时的 Provider Account Profile、预留维度、过期时间、生命周期和结算引用。Usage Ledger Entry 记录一条带归因的测量、估算、修正、释放或未解决金额，以及其证据来源与观察时间。

预留与 ledger entry 都是 Saki 控制面记录。DSH Session 用量事件、GitHub 观察、提供方 Usage Snapshot、Generation Job 结果和 Host Operation 结果仍分别拥有对应事实的证据。修正通过追加抵消 entry 完成，而不是重写较早准入决策使用的观察。

预算可以按 operation、Agent Run、Work Item、Project rolling window 或 Provider Account Profile 应用。一笔预留可以原子消耗多个 scope。Project 并发 claim 与 Resource Binding Execution Lease 继续保持独立，因为前者限制自动化总量，后者阻止两个 writer 共享一个 worktree。

### 0.1.0 必需维度

每个启用的自动模式策略都要为并发 Agent Run、Run wall time、模型请求、input token、output-token allowance、并发与总 Generation Job、generation attempt、GitHub mutation、Git push 和由 Saki 引发的 CI trigger 设置有限本地硬限制。存在可靠观察时，策略还可以限制提供方报告单位或货币、观察到的 GitHub Actions 时长，以及账号 allowance window。

本地维度具有不同执行点。Run 在 dispatch 前预留并发 slot 与 deadline。每个模型请求在调用提供方前预留已测 input 与已配置最大 output，之后按报告用量结算。Generation Job 在提交前预留 slot 与 attempt。GitHub mutation、push、merge 或触发 workflow 的 operation 在 dispatch 前消耗计数；外部结果不明确时保留预留，直到检查或 intervention 解决它。

GitHub Actions 分钟在 0.1.0 中是观察型暂停信号，而非执行前硬保证。Saki 统计它能够建立因果归因的每次 push 或明确 dispatch 为 CI trigger，在可用时读取后续 workflow 时长，并在策略判断观察过旧、未知或超过阈值后停止进一步自动 trigger。该版本不声称能预测外部参与者触发的 workflow 或 GitHub 计费调整。

### 准入、结算与耗尽

Control Intent 准入会解析当前 Grant 和 Automation Policy，检查映射与绑定健康，并在持久化 Execution Dispatch 或调用外部能力前原子创建或复用所需预留。重放同一 Intent 或 Host Operation 会复用预留，不会重复消费。策略 revision 影响新预留和后续能力边界检查，但不会重写历史结算。

在每个 effect 边界，Host 或能力适配器会验证预留、fencing 或 operation 身份、取消状态和当前 Grant。结算释放未使用的预留 allowance 并追加实际用量。崩溃恢复通过检查关联 operation 恢复 prepared reservation。已确认不存在会释放预留，已确认用量会结算，而未知结果保留预留并进入 `reconciliation_required`，不会乐观退款。

达到硬 limit 会阻止新的自动 effect；Run deadline 到期时在最近安全边界请求取消；同时创建或更新 Intervention Request，并带上限制维度与证据。它绝不会把 Work Item 标为 Done。自动 Done 继续是一条单独获得 Grant 与策略授权的 Intent，并要求已配置 Outcome Evidence。

### 未知提供方用量与手动例外

Automation Policy 为每条 route 选择 `pause-on-unknown` 或 `local-limits-only`。后者只在所有必需本地硬 limit 都有限，并且最新提供方观察没有报告耗尽、拒绝或不兼容 entitlement 时有效。产生的审计记录会说明提供方全局 quota 或货币成本未知。若策略声明提供方报告或货币 limit，就不能从缺失或陈旧 Usage Snapshot 预留该维度，因此会暂停。

Host Operator 可以提交带归因的一次性 budget-exception Intent，或更新策略 revision。一次性例外声明精确维度、scope、过期时间和目标 operation；它不会改变底层操作 Grant，也不会授权后代。为绕过提供方限制而进行的自动账号轮换继续禁止，未解决预留也不能通过切换 profile 逃避。

## 考虑过的方案

**只在 Run 后检查用量。** 并发 Run 可能超量使用同一 allowance，崩溃还可能完全遗漏记账。预留把决定性检查移动到 effect 前。

**为每个提供方与 operation 使用单一成本数字。** 订阅 quota、token、generation attempt、elapsed time、GitHub mutation 与 Actions 分钟无法可靠换算成一个数值。类型化维度保留哪些已测、哪些未知。

**把未知提供方用量当作零。** 这会把缺失 telemetry 变成无限授权。明确的 `local-limits-only` 模式允许在可测 cap 下运行，同时在审计与 UI 中保留不确定性。

**一次预留整个 Work Item 估算。** 长时间或探索性工作的初始估算很差，预留最坏情况会闲置供给。每个 effect 边界的分层预留能提供更紧约束与更准确结算。

**使用 Grant 表示 quota。** Grant revision 会混合安全权限、消耗 window 与 runtime counter。把预算放在 Automation Policy 中，可让撤销与预算变化保持不同语义。

**为每次 timeout 退款。** Timeout 可能发生在成功的付费请求或 mutation 之后。未知外部结果会保留预留，直到检查或带归因的协调完成。

## 后果

自动模式增加了准入记录，并可能在歧义 operation 等待协调期间占用容量。这种保守性换来有界并发、崩溃安全记账、可解释暂停，以及对哪个 Principal、Project、Work Item、Run、route 和 operation 消耗资源的直接回答。

Web 客户端需要展示已配置 limit、已预留金额、已结算用量、观察时效、未知维度和 Intervention Request 的投影。它可以汇总这些值，但不能从客户端计数器推断消费。测试覆盖原子竞争准入、重放、部分结算、deadline 取消、陈旧与缺失 Usage Snapshot、账号耗尽、歧义模型与 GitHub 结果、CI-trigger cap、重启恢复、一次性例外，以及证据驱动的自动 Done。
