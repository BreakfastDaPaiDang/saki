# Agent Note: Saki 可恢复控制意图

Status: proposed

[English](2026-08-18-saki-recoverable-control-intents.md) | 中文

## 问题

一次 Saki 操作可能同时修改本地控制面记录，并调用 DSH、Git、GitHub 或模型提供方。现有 `storageDomain` 接口会串行执行一个 domain 的写入，并保证单条记录更新原子，但没有跨表事务。即使 Saki 增加这种事务，外部系统也无法加入。简单地按顺序写入，会在进程终止后留下含义不明的局部状态，并可能在重试时重复执行外部工作。Intent 还必须保留谁行使了哪些权限，不能信任 client 归因、把 Agent Run 等同于安全身份，或让后续 Grant 变化改写历史。

## 提案

Saki 控制面 Module 通过一个接收幂等 Control Intent request 与可信认证上下文的写接口，实现 [ADR 0005](../../../../docs/adr/0005-recoverable-control-intents.md)、[ADR 0008](../../../../docs/adr/0008-principals-grants-and-actor-attribution.md)和 [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.md)。控制面解析 Principal、评估当前 Grant 与 Automation Policy，并派生不可变 Actor；调用方提供的 Actor 或 Grant 字段不能产生权限。Envelope 记录带品牌类型的 Intent id、Actor、Grant revision、提交时间、可选 expected revision、Project 范围和封闭 payload union。以相同 payload 重用同一 id 时返回已有 receipt，以不同内容重用时拒绝。

Principal 与 Grant 保持为持久版本化记录。Grant 标明签发者、目标主体、操作、资源范围、有效期、委派限制、可选父级、revision 和撤销状态。启用自动模式的 Project 通过独立 Project Automation Principal 行动，并且必须同时具备 Grant 与满足 Automation Policy。一次性 Agent Run 接收父级子集授权，不会成为 Principal；持久 Agent Identity 可以接收自己的 Grant。环境中的 DSH initiator 或 Session lineage 仍是来源信息，不是权限；这与 [Agent initiator scope](../../implemented/architecture/2026-07-15-agent-initiator-scope.md)一致。

撤销会阻止新 Intent、新委派，以及任何需要被撤销 Grant 但尚未开始的外部副作用。对于可能已经发生的副作用，仍允许检查、取消、对账和补偿。活动 Host capability 边界检查当前 Grant revision，不把 Intent 的历史 Actor 快照当作永久权限。

Module 在跨越 capability seam 前持久化 Intent。Intent 生命周期记录区分 prepared、reserved、dispatched、waiting、completed、failed、canceled 和 reconciliation-required 结果。每个外部 adapter 都接收 Intent id，返回稳定外部标识与普通数据，并支持幂等重新派发，或者提供足以对账的检查能力。外部调用不得在 `storageDomain` update callback 内运行。

已接受 Intent 需要创建或恢复 Execution 时，控制面会在唤醒 Host 前持久化独立 Execution Dispatch。Dispatch 交付、claim、Host operation identity 与恢复归[持久派发提案](2026-08-18-saki-durable-dispatch-intervention-and-attention.md)所有，Intent 则继续拥有授权、归因与请求的产品 mutation。等待人工输入的 Intent 会关联持久 Intervention Request；Attention Inbox 从该待处理工作派生，绝不会成为另一个命令 owner。

以 Resource Binding 为键的 Execution Lease 记录拥有可写工作的唯一强准入事实。它通过原子读改写授予一个 Agent Run 工作树使用权，或者返回当前持有者。Intent 先于 Lease 获取写入；两次写入之间崩溃会留下可重试的 prepared Intent，获取 Lease 后崩溃则会在 Lease 上留下 Intent id 与拟创建 Run 的事实，使恢复逻辑能完成或释放它，而不允许竞争写入者进入。

Principal、Grant、Development Project、Work Item 控制元数据、Work Session、Agent Run、Provider Account Profile、Context Policy、Generation Job、Control Intent 和 Execution Lease 保持为独立的版本化记录。每条记录只有一个拥有 Module，并以来源和观察时间标记缓存的外部事实。跨记录引用通过 Intent 恢复逐步收敛；任何代码都不得宣称多条记录已原子提交。

控制面 Interface 暴露 Intent 提交以及显式 Project、Work Item、Agent Run 和 Model Supply 投影。提交后变更通知携带标识与失效范围，使客户端重新读取投影；它们不是持久命令或事件溯源事实日志。Project 级进程内串行可以减少争用，但不能取代持久 revision、Intent 恢复或 Execution Lease。

启动恢复会在接受自动工作前扫描非终态 Intent 与已占用 Lease。只有 adapter 接口保证操作幂等时才重新派发，否则检查外部标识。缺少证据或证据矛盾时，Intent 进入 reconciliation required，相关资源保持不可用，直到人工或确定性修复完成对账。

## 考虑过的方案

**顺序执行多记录 CRUD。** 它没有覆盖整个操作的持久提交标记，也无法区分“从未派发”和“派发成功但确认丢失”。重试任一猜测都可能丢失或重复工作。

**一个 Development Project 文档。** 它利用现有单记录原子性，却耦合互不相关的更新频率，记录会无有效上限地增长，并把每次历史或提供方变化都变成 Project 级重写；它仍不能原子提交外部工作。

**Saki 关系型事务层。** 多行事务只改善本地提交。GitHub、DSH Session、Git 和模型提供方仍需要持久派发与对账，而新存储层会在 DSH 存储之外再产生一套 schema、迁移、备份和 adapter 生命周期。

**完整事件溯源。** 它保存所有转换，却会在 Saki 命令与投影稳定前引入事件版本、排序、重放、投影恢复和副作用去重。现有 Session 事件继续拥有模型可见历史；控制面生命周期记录提供产品可追溯性，无需把每个领域对象都变成事件折叠结果。

**只使用进程内互斥锁。** 它可以串行化一个运行中进程，却会在重启时消失，也无法解释已经派发的外部副作用。进程锁只能作为优化，不能成为准入事实来源。

**信任调用方提供的 Actor 或权限字段。** 浏览器、Agent、webhook 或 adapter 将可以冒充其他身份或省略委派关系。可信控制面必须根据认证上下文和持久 Grant 派生归因与权限。

**用 Automation Policy 作为权限。** Policy 拥有执行资格、预算与证据，但若把它作为权限记录，修改触发条件就会授予 Host 访问。Project Automation Principal 必须同时具备显式 Grant 并满足 policy。

**为每个 Agent Run 创建 Principal。** 一次性 Run 没有独立持续身份，会产生无意义的持久安全记录。父级子集授权可以记录其权限，而不会混淆 attempt identity 与 security identity。

## 验收条件

- 使用相同内容重复提交同一 Intent id，不会创建第二个 Agent Run、GitHub 修改或 Generation Job；冲突内容会被拒绝。
- 一个 Resource Binding 在包括重启恢复在内的所有情况下，都不会把写入权同时授予两个活动 Agent Run。
- 崩溃注入测试在每个持久生命周期转换后停止，并证明重新打开存储后会确定性地继续、失败或进入 reconciliation required。
- adapter 确认丢失时通过稳定外部身份确定结果，或者明确进入 reconciliation required；不得假定操作失败。
- 已提交 Execution Dispatch 或 Intervention Request 可以独立于任何实时 Agent、scheduler、浏览器连接或待处理 Promise 跨重启存在。
- 产品 View 区分 requested、externally observed、completed、failed 和 reconciliation-required 状态，不把 `domain/changed` 当作持久证据。
- Client 不能通过提供 Actor、Principal、Grant、Session lineage 或 GitHub 成员声明获得权限；已接受 Intent 保存控制面派生的 Actor 和准确 Grant revision。
- 撤销 Grant 会拒绝新 Intent、委派和尚未 dispatch 的副作用，同时保留安全检查、取消、对账和补偿。
- 自动工作必须同时具有 Project Automation Principal、显式 Grant 和满足 Automation Policy；一次性 Agent Run 只能接收父级子集授权。
- 控制面 Interface 不暴露存储 handle、Host 路径、活 DSH handle、提供方 token 或 adapter 专用响应对象。

## 风险

如果控制面 Module 不集中拥有生命周期转换，且 adapter 不把接口限制为派发与对账事实，恢复逻辑可能演变为散落在多个 adapter 中的分布式状态机。活动 capability 边界的 Grant 检查增加了撤销传播和竞态处理；测试必须区分尚未 dispatch 的副作用和结果未知的副作用，使撤销不会导致不安全的盲目重试。可变生命周期记录不提供不可变的全局审计日志，因此未来合规要求可能需要仅追加 journal。单进程 `storageDomain` 与 Project 级队列不支持 active-active 控制面；多 Host 控制面执行需要新的 Lease 与一致性机制，不能静默扩展本地假设。
