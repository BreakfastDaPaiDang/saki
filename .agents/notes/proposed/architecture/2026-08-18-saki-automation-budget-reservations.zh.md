# Agent Note: 自动化预算预留与带归因用量结算

Status: proposed

[English](2026-08-18-saki-automation-budget-reservations.md) | 中文

## 问题

自动模式可以启动并发 Agent Run、模型请求、Generation Job、GitHub mutation、push 和触发 CI 的工作。只在完成后检查用量，会让并发 operation 超量使用同一 allowance，也无法安全记录崩溃或歧义外部回复。不同提供方的 quota、订阅、成本与 GitHub Actions telemetry 还具有不同精度与可用性。

## 提案

自动准入同时要求 Project Automation Principal 的 Grant，以及具有有限本地 limit 的当前 Automation Policy。每个 effect 前，控制面都会原子创建或复用与其 Intent 或 Host Operation 关联的 Automation Budget Reservation。结算会追加带归因的 Usage Ledger Entry，释放未使用 allowance，并让歧义用量继续保持预留，直到检查或 intervention 完成。

0.1.0 版本对并发 Run、wall time、模型请求、input 与 output token、Generation Job 与 attempt、GitHub mutation、push 和由 Saki 引发的 CI trigger 设置硬限制。提供方报告单位、货币、allowance window 和观察到的 Actions 时长仍是类型化可选维度。Actions 分钟是事后暂停信号；Saki 可以硬限制自己引发的 push 与 dispatch，却不能承诺 GitHub 最终计费结果。

策略为每条 route 选择 `pause-on-unknown` 或 `local-limits-only`。后者要求所有本地硬 limit 都有限，且没有观察到提供方耗尽或拒绝；审计会保留提供方全局成本或 quota 未知这一事实。Host Operator 一次性例外是带归因、精确 scope 的 Intent，不会扩张底层 Grant。[ADR 0015](../../../../docs/adr/0015-reserved-automation-budgets-and-usage-ledger.zh.md)拥有记录与执行语义。

DSH token 用量与 timeout Agent Note 拥有证据机制，而不是产品预算权威；提议中的[可恢复 Control Intent](2026-08-18-saki-recoverable-control-intents.zh.md)与[带 fencing 的 dispatch 准入](2026-08-18-saki-fenced-idempotent-dispatch-admission.zh.md) Agent Note 分别拥有写入准入与交付安全。

## 考虑过的方案

**只在完成后计数。** 并发准入与崩溃会使结果无法作为安全 limit。

**把每种资源转换为一种货币。** 这些输入既不能统一观察，也不能可靠换算。

**把缺失提供方 telemetry 当作零。** 缺失数据会变成无限权限。

**把 quota 编码到 Grant 中。** 这会把安全权限与变化的资源 window 和 counter 混在一起。

**为 timeout 退款。** 回复丢失前，外部提供方可能已经完成 operation 并收费。

## 验收标准

- 并发准入不能超过任何硬 scope，重放也不能重复消费同一预留。
- 崩溃恢复会结算已确认用量、释放已确认不存在，并保留未知用量等待协调。
- 自动模式在预算、陈旧必需 telemetry、deadline 或 CI-trigger limit 上可见地停止，绝不会把耗尽变成 Done。
- 投影会把已配置、已预留、已结算、未知与例外用量归因到 Project、Work Item、Run、route 和 Actor。

## 风险

歧义 operation 等待恢复期间，保守预留会降低利用率。细粒度预留会为模型、生成、GitHub 与 Host 执行路径增加记录与执行点。实现必须保持这些点幂等，也不能因为提供方缺少计费 telemetry 就让适配器静默跳过记账。
