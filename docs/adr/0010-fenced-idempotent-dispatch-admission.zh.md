---
status: accepted
---

# 使用带 fencing 的 claim 与幂等 Host admission 交付 dispatch

[English](0010-fenced-idempotent-dispatch-admission.md) | 中文

Saki 对 Execution Dispatch 采用至少一次交付，但通过有界 Dispatch Claim 和一条以稳定 dispatch id 为键的持久 Host Operation 完成准入。Host 在产生任何外部副作用前准备该映射；控制面只在当前 fencing token 下接受它；Host 仅在接受完成后才启动 operation。该机制保证每条 dispatch 只有一个目标 Agent Run identity，但不会声称跨进程或网络故障实现 exactly-once execution。

## 决策原因

持久 dispatcher 必须在崩溃或确认丢失后重复交付。只有 claim 过期并不能保证重复安全：较慢的 claimant 可能在另一个执行器取得工作后恢复，而 Host 已经行动后也可能丢失回复。因此，把任一超时视为失败证明都可能创建第二个 Agent Run，或者重复计费操作和 mutation。

Dispatch 生命周期与结果 operation 生命周期回答的问题也不同。Dispatch acceptance 证明 Host 已经把命令持久关联到一条 Host Operation；它不证明 operation 已经启动、Agent Run 已经完成，或者结果满足验收条件。后续事实仍分别属于 Host Operation、Execution、Agent Run 与 Outcome Evidence 记录。

因此，Saki 使用至少一次交付与幂等 admission。系统不保证外部副作用 exactly once；它保证同一 dispatch 的每次重复提交都会收敛到一条 Host Operation 和一个目标 Agent Run identity，而且无法确认的结果会停止并进入对账，而不会由系统猜测。

## 协议

### Dispatch 生命周期

| 状态 | 含义 |
|---|---|
| `pending` | 尚未接受 Host Operation；dispatch 在 `nextAttemptAt` 到达后可被领取。 |
| `claimed` | 一条未过期 Dispatch Claim 可以准备 Host admission。 |
| `accepted` | Host Operation 映射及其控制面 receipt 已经持久化；dispatch 交付完成，但 Execution 未必完成。 |
| `canceled` | Control Intent 在接受前取消交付，因此已准备 operation 不得启动。 |
| `rejected` | Host 明确拒绝 admission；修正后的请求需要新的 Control Intent 和 dispatch。 |
| `reconciliation_required` | 因为无法证明 admission 或 absence，或者已耗尽配置的重试预算，自动交付已停止。 |

`accepted`、`canceled` 与 `rejected` 是交付终态。`reconciliation_required` 是自动交付终态；当证据能够确定安全结果时，具有归因的 Control Intent 可以把它解决为 `accepted`、`canceled`、`rejected` 或 `pending`。

### Claim 与 Host admission

1. Scanner 使用 expected revision，以原子方式领取一条符合条件的 `pending` dispatch，或者替换一条已过期 `claimed` 记录。每条新 claim 都会递增单调 fencing token，并记录 claim id、executor id、签发时间、过期时间和更新后的 dispatch revision。
2. 同一执行器可以用 expected revision 续期尚未过期的 claim，并保持 fencing token 不变。过期 claim 无法续期；重新领取会产生更高 token。控制面是时间和有效性的权威，因此未来远程 Host 不能只根据自己的本地时钟准入工作。
3. Claimant 请求目标 Host 准备 dispatch。Host 向控制面验证当前 claim，然后在调用 DSH、Git、模型或其他外部能力前，以 dispatch id 为键原子创建或读取 Host Operation。完全相同的重复请求或后续有效 claim 会返回同一个 operation reference，并记录最新 prepared token；同一 dispatch 的 payload digest 或目标 Execution 不同则构成冲突。
4. 控制面针对当前未过期 claim 以 compare-and-set 接受 Host Operation reference。系统重新检查 cancellation、委派权限、适用的 Automation Policy 和所有必需 Execution Lease，然后把 dispatch 转为 `accepted`。
5. Host 只有在验证已接受 dispatch、operation reference、fencing token、当前 cancellation state，以及该 capability boundary 所需权限后，才启动或恢复已准备 operation。启动操作按 Host Operation reference 保持幂等。如果准备记录未能通过 acceptance，它会保持 inert，供后续有效 claimant 复用，或者在 dispatch 进入终态后接受垃圾回收。
6. Claim 过期、释放或替换会使先前 claimant 失效，但不会取消已接受 Host Operation、停止其 Execution 或释放其 Execution Lease。系统通过另行授权的 inspect 与 cancel Control Intent 控制 operation。

### 重试、恢复与取消

持久 `attemptCount`、`nextAttemptAt` 与 `lastError` 驱动可配置 backoff；进程内 notification 只用于唤醒权威 scanner。在 Host preparation 前确认的瞬态故障可以释放 claim，并让同一 dispatch 回到 `pending`。重试绝不会创建新的 dispatch identity。

Prepare 或 acceptance 确认丢失后，Saki 在重试前按 dispatch id 检查。匹配的 Host Operation 通过同一映射完成或确认 admission。确认不存在时，系统可以在旧 claim 过期后重新领取。证据冲突、inspection 路径不可用，或 Host 无法证明不存在时，dispatch 进入 `reconciliation_required`；Saki 不会根据无回复推断失败。

接受前取消会把 `pending` 或 `claimed` 转为 `canceled`、推进 dispatch revision，并阻止已准备 operation 启动。接受后取消不会改变 dispatch 的 `accepted` 状态，而是通过另一条 Control Intent 操作 Host Operation 或 Execution，从而保留交付已经发生的事实。

可写 dispatch 只有在目标 Agent Run 持有必需 Execution Lease 后才能被领取。Claim 过期绝不会释放该 Lease。手动启动与自动启动使用同一协议；Automation Policy 只改变谁能提交源 Intent，不改变交付安全属性。

## 考虑过的方案

**声称 exactly-once delivery。** 控制面存储、未来远程 Host、DSH、Git 与模型提供方无法共享一个事务。把结果称为 exactly once 只会隐藏结果不明的副作用，无法消除它们。

**允许 claimant 在取得 claim 后立即启动副作用。** Claimant 可能暂停到过期，并在另一个执行器恢复 dispatch 后行动。缺少 Host-side admission 与 validation 时，fencing token 本身无法封闭该竞态。

**在完整 Execution 期间持有 Dispatch Claim。** Agent Run 的持续时间可能远长于 dispatch admission，而且一个 Run 可以执行多个 Host operation。长时间 claim 会推迟恢复，还会复制已经由 Execution Lease 拥有的 Resource Binding 不变量。

**每次重试都创建新 dispatch。** 新 id 会破坏 Host 去重，使确认丢失无法与新请求的副作用区分。重试元数据属于稳定 dispatch。

**把超时或缺少确认视为 rejection。** 无回复无法区分没有副作用和 preparation 或启动后的回复丢失。Inspection 与显式 reconciliation 会保留这种不确定性，而不是把它变成重复工作。

## 影响

Host Execution 接口需要分开的 prepare、start、inspect 与 cancel operation，并由持久 Host Operation registry 支撑。0.1.0 可以在同一进程和存储实现中保存两侧记录，但仍保留逻辑所有权与顺序，使远程 Host 后续可以实现相同协议。

远程 Host 在准入新工作时必须联系控制面，断开连接期间不能启动已准备 operation。系统有意放弃离线启动，以换取当前 cancellation、Grant、Automation Policy、Lease 与 fencing 检查。已经接受的 operation 可以按照自身 Execution 与 Lease 规则继续运行。

崩溃测试覆盖 claim 前持久化、claim 后、Host preparation 后、控制面 acceptance 后与 operation 启动后。陈旧 claimant、payload 冲突、迟到 receipt 或违反协议的 Host 结果都会成为可见对账工作，不能静默创建另一个 Agent Run。
