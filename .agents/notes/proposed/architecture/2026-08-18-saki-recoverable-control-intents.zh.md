# Agent Note: Saki 可恢复控制意图

Status: proposed

[English](2026-08-18-saki-recoverable-control-intents.md) | 中文

## 问题

一次 Saki 操作可能同时修改本地控制面记录，并调用 DSH、Git、GitHub 或模型提供方。现有 `storageDomain` 接口会串行执行一个 domain 的写入，并保证单条记录更新原子，但没有跨表事务。即使 Saki 增加这种事务，外部系统也无法加入。简单地按顺序写入，会在进程终止后留下含义不明的局部状态，并可能在重试时重复执行外部工作。Intent 还必须保留谁行使了哪些权限，不能信任 client 归因、把 Agent Run 等同于安全身份，或让后续 Grant 变化改写历史。

## 提案

Saki 控制面 Module 通过一个接收幂等 Control Intent request 与可信认证上下文的写接口，实现 [ADR 0005](../../../../docs/adr/0005-recoverable-control-intents.zh.md)、[ADR 0008](../../../../docs/adr/0008-principals-grants-and-actor-attribution.zh.md)和 [ADR 0009](../../../../docs/adr/0009-durable-dispatch-intervention-and-attention-projections.zh.md)。控制面解析 Principal、评估当前 Grant 与 Automation Policy，并派生不可变 Actor；调用方提供的 Actor 或 Grant 字段不能产生权限。Envelope 记录带品牌类型的 Intent id、Actor、Grant revision、提交时间、可选 expected revision、Project 范围和封闭 payload union。以相同 payload 重用同一 id 时返回已有 receipt，以不同内容重用时拒绝。

Principal 与 Grant 保持为持久版本化记录。Grant 标明签发者、目标主体、操作、资源范围、有效期、委派限制、可选父级、revision 和撤销状态。启用自动模式的 Project 通过独立 Project Automation Principal 行动，并且必须同时具备 Grant 与满足 Automation Policy。一次性 Agent Run 接收父级子集授权，不会成为 Principal；持久 Agent Identity 可以接收自己的 Grant。环境中的 DSH initiator 或 Session lineage 仍是来源信息，不是权限；这与 [Agent initiator scope](../../implemented/architecture/2026-07-15-agent-initiator-scope.zh.md)一致。

单一 Installation Access aggregate 拥有不同的 branded、revisioned Bootstrap Challenge 与 Browser Session entry。一次 expected-revision record update 验证 `issued` challenge，并在 transport 发出 `Set-Cookie` 前原子记录终态 `consumed` 与一个 `active` session。响应丢失不会证明 cookie 已送达、重新打开 challenge 或创建另一个 session。终态按服务端时钟保持单调；重启只 reconcile 已经过期的 entry，generation 替换与 Principal 退役会使受影响 session 失效，retained terminal entry 可以进入 cleanup，但绝不让 id 或 secret 可复用。

明文 bootstrap secret 只存在于 launcher handoff 与准确的 exchange POST body 中；raw cookie 只存在于 `Set-Cookie` 与 Cookie header 和浏览器 HttpOnly jar 中；派生 request token 只存在于已认证 Access 与请求防伪 header 中。持久存储保存 bootstrap 与 cookie digest，以及非秘密 request-token derivation version 与 domain metadata。服务端通过 constant-time digest compare 认证请求呈现的 raw cookie，再使用版本化加密 HMAC 或 KDF，通过 domain separation 从同一个 cookie 派生 Access request token；mutation 会重新计算并与 header 做 constant-time compare。系统不存在独立 verifier secret，重启也不需要在存储中保留 raw token。除具名 transport 外，明文 secret 与 token 绝不进入持久记录、receipt、snapshot、无关 wire payload 或 Projection、URL、analytics、log、diagnostic、trace、event、error text、crash artifact、adapter error 或 export。未认证 Access 读取不会泄漏 Installation、安全 object identifier 或 secret failure class。

撤销会阻止新 Intent、新委派，以及任何需要被撤销 Grant 但尚未开始的外部副作用。对于可能已经发生的副作用，仍允许检查、取消、对账和补偿。活动 Host capability 边界检查当前 Grant revision，不把 Intent 的历史 Actor 快照当作永久权限。

Module 在跨越 capability seam 前持久化 Intent。Intent 生命周期记录区分 prepared、reserved、dispatched、waiting、completed、failed、canceled 和 reconciliation-required 结果。每个外部 adapter 都接收 Intent id，返回稳定外部标识与普通数据，并支持幂等重新派发，或者提供足以对账的检查能力。外部调用不得在 `storageDomain` update callback 内运行。

已实现的[已有目录 Project 登记](../../implemented/architecture/2026-08-20-saki-existing-directory-project-registration.zh.md)把这一顺序应用于一项有界 Workspace 创建 effect，以及控制域 version 2 中的第一版 Project Registry。已实现的[polling-first GitHub 同步](../../implemented/architecture/2026-08-18-saki-polling-first-github-synchronization.zh.md)增加了第二个持久 Intent family：`configure-github-synchronization` 会幂等保存 pending configuration 及其扫描计划，但不执行外部 effect。随后，可恢复 polling Consumer 会在独立的 attempt 与 checkpoint 生命周期下读取 GitHub。已实现的[可恢复 GitHub Work Item mutation](../../implemented/architecture/2026-08-16-saki-recoverable-github-work-item-mutations.zh.md)通过 version 6 Work Item Intent、recovery record 与 targeted external inspection，把这一顺序应用于 CreateWorkItem 和 MoveWorkItem。已实现的[结构化 Git 决策](../../implemented/architecture/2026-08-28-saki-recoverable-structured-git-operations.zh.md)把这一顺序应用于 StageFiles、UnstageFiles 与 CreateCommit，并通过 Binding Write Admission 和持久 Host Operation 收口；无法确定的 effect 必须进入 reconciliation。已实现的 [Branch Delivery 与 Milestone Release Evidence 决策](../../implemented/feature/2026-08-18-saki-branch-delivery-and-milestone-release-evidence.zh.md)通过持久 Delivery 聚合与可恢复子 mutation，把这一顺序应用于 Branch Delivery Push、PR 创建与关联、人工验收，以及 Milestone Delivery finalization。已实现的[手动 Give-to-Agent 决策](../../implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)把相同顺序应用于一条 `give-work-item-to-agent` Intent 及其 Work Assignment、主要 Work Session、Agent Run、Execution Dispatch、Dispatch Claim 与 Host Operation。已实现的[持久 Intervention 回答决策](../../implemented/feature/2026-08-18-saki-durable-intervention-answer.zh.md)在同一 Run 与 Session 上增加一条独立归因、带 expected revision 的回答 Intent 及后续 Dispatch。本 Agent Note 保持 proposed，因为通用 Intent phase、Execution Lease、其他 Intervention kind、补偿、自动 dispatch 与剩余外部 adapter 尚未实现。

手动 Give-to-Agent 与持久回答路径是这种分离方式的具体实例。已接受 Intent 需要创建或恢复 Execution 时，控制面会在唤醒 Host 前持久化独立 Execution Dispatch。更广泛的 Dispatch 交付、claim、Host operation identity 与恢复归[持久派发提案](2026-08-18-saki-durable-dispatch-intervention-and-attention.zh.md)所有，Intent 则继续拥有授权、归因与请求的产品 mutation。等待人工输入的 Agent 会关联持久 Intervention Request；Attention 从该待处理工作派生，绝不会成为另一个命令 owner。

以 Resource Binding 为键的 Execution Lease 记录拥有可写工作的唯一强准入事实。它通过原子读改写授予一个 Agent Run 工作树使用权，或者返回当前持有者。Intent 先于 Lease 获取写入；两次写入之间崩溃会留下可重试的 prepared Intent，获取 Lease 后崩溃则会在 Lease 上留下 Intent id 与拟创建 Run 的事实，使恢复逻辑能完成或释放它，而不允许竞争写入者进入。

Installation Access、Principal、Grant、Development Project、Work Item 控制元数据、Work Session、Agent Run、Provider Account Profile、Context Policy、Generation Job、Control Intent 和 Execution Lease 保持为独立的版本化记录。Bootstrap Challenge 与 Browser Session 是同一 aggregate 内的 entry，因此 challenge 消费与 session 插入共享一次 record commit；其他跨记录引用都不得声称具有原子性。每条记录只有一个拥有 Module，并以来源和观察时间标记缓存的外部事实。跨记录引用通过 Intent 恢复逐步收敛。

控制面 Module 把 `SakiAccess.readAccess(presentedSession?, signal)`、`exchangeBootstrap(transportContext, request, signal)` 与 `logoutCurrentSession(authentication, requestToken, signal)` 和 `SakiControlPlane.submit(authentication, intent, signal)`、`query(authentication, query, signal)` 与 `onChanged` 并列暴露。只有 Host API 使用 package-private SakiAccess resolver，把 HTTP cookie 与 transport 事实转换为可信 `AuthenticationContext`；resolver 与 context 都不是 wire API。Bootstrap exchange 与 logout 是仅有的两个不经过 Control Intent 的产品 mutation，并且只修改 Installation Access。每次受保护 query 与 submit 都重新验证 active session 与 Installation generation、Principal lifecycle，以及当前 Grant revision 与 resource scope。Principal 或 Grant 变化会使受影响 Projection 失效。提交后变更通知携带标识与失效范围，使客户端重新读取投影；它们不是持久命令或事件溯源事实日志。Project 级进程内串行可以减少争用，但不能取代持久 revision、Intent 恢复或 Execution Lease。

启动恢复先 reconcile 按服务端时钟已经过期的 access entry，并拒绝来自其他 Installation State Generation 或 inactive Principal 的 session，然后才会在接受自动工作前扫描非终态 Intent 与已占用 Lease。只有 adapter 接口保证操作幂等时才重新派发，否则检查外部标识。缺少证据或证据矛盾时，Intent 进入 reconciliation required，相关资源保持不可用，直到人工或确定性修复完成对账。

## 考虑过的方案

**顺序执行多记录 CRUD。** 它没有覆盖整个操作的持久提交标记，也无法区分“从未派发”和“派发成功但确认丢失”。重试任一猜测都可能丢失或重复工作。

**一个 Development Project 文档。** 它利用现有单记录原子性，却耦合互不相关的更新频率，记录会无有效上限地增长，并把每次历史或提供方变化都变成 Project 级重写；它仍不能原子提交外部工作。

**Saki 关系型事务层。** 多行事务只改善本地提交。GitHub、DSH Session、Git 和模型提供方仍需要持久派发与对账，而新存储层会在 DSH 存储之外再产生一套 schema、迁移、备份和 adapter 生命周期。

**完整事件溯源。** 它保存所有转换，却会在 Saki 命令与投影稳定前引入事件版本、排序、重放、投影恢复和副作用去重。现有 Session 事件继续拥有模型可见历史；控制面生命周期记录提供产品可追溯性，无需把每个领域对象都变成事件折叠结果。

**只使用进程内互斥锁。** 它可以串行化一个运行中进程，却会在重启时消失，也无法解释已经派发的外部副作用。进程锁只能作为优化，不能成为准入事实来源。

**信任调用方提供的 Actor 或权限字段。** 浏览器、Agent、webhook 或 adapter 将可以冒充其他身份或省略委派关系。可信控制面必须根据认证上下文和持久 Grant 派生归因与权限。

**使用 GitHub OAuth、本地密码或持久浏览器 bearer 完成 bootstrap。** 外部登录会让本地恢复依赖网络身份，并诱使 membership 变成 Host authority；密码会增加 verifier 与重置生命周期；浏览器存储会让 client code 接触 bearer 材料。一次性本地 challenge 与可撤销 HttpOnly Browser Session 在不改变 Principal 与 Grant 模型的情况下提供有界单操作者 transport。

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
- Installation Access 证明 issued-to-consumed challenge 转换与 active-session 插入在一个 record commit 中原子完成，并且发生在 `Set-Cookie` 前；响应丢失不能重新打开 challenge 或创建另一个 session。
- Challenge 与 session 测试覆盖服务端时钟 expiry、终态单调性、普通重启、登出、撤销、Principal 退役、generation 替换、retained-terminal cleanup，以及 id 或 secret 不可复用。
- 每种明文认证材料只出现在具名 handoff、cookie 或 request-token transport 中，绝不进入持久记录、receipt、snapshot、URL、analytics、log、diagnostic、trace、event、无关 wire payload 或 Projection、error text、crash artifact、adapter error 或 export；系统不存在独立 verifier secret。
- 未认证 Access 与 bootstrap 失败不会泄漏 Installation、challenge、Principal、Grant、Host 或 Project identifier；浏览器中改变状态的请求需要准确 Origin 与 session-bound 请求防伪保护。
- 撤销 Grant 会拒绝新 Intent、委派和尚未 dispatch 的副作用，同时保留安全检查、取消、对账和补偿。
- 自动工作必须同时具有 Project Automation Principal、显式 Grant 和满足 Automation Policy；一次性 Agent Run 只能接收父级子集授权。
- 控制面 Interface 不暴露存储 handle、Host 路径、活 DSH handle、提供方 token 或 adapter 专用响应对象。

## 风险

如果控制面 Module 不集中拥有生命周期转换，且 adapter 不把接口限制为派发与对账事实，恢复逻辑可能演变为散落在多个 adapter 中的分布式状态机。活动 capability 边界的 Grant 检查增加了撤销传播和竞态处理；测试必须区分尚未 dispatch 的副作用和结果未知的副作用，使撤销不会导致不安全的盲目重试。可变生命周期记录不提供不可变的全局审计日志，因此未来合规要求可能需要仅追加 journal。单进程 `storageDomain` 与 Project 级队列不支持 active-active 控制面；多 Host 控制面执行需要新的 Lease 与一致性机制，不能静默扩展本地假设。
