# Agent Note: 可恢复的 GitHub Work Item mutation

Status: implemented

[English](2026-08-16-saki-recoverable-github-work-item-mutations.md) | 中文

## 问题

创建或移动一个由 GitHub 支撑的 Work Item 会跨越多个外部 effect 与持久控制面写入，而这些操作无法共享一个事务。GitHub 接受 Issue、Project membership、Status、position 或 Issue state mutation 后，进程可能在 Saki 记录结果前停止。若系统把结果丢失当作失败并盲目重试，就可能创建第二个 Issue，或依据已经变化的远端事实执行后续阶段。

完整 Board 扫描有意保持宽范围和异步特性。若每个 effect 后都要求执行完整扫描，交互 mutation 就会与 polling checkpoint 耦合，而且重启恢复仍然缺少特定阶段的 evidence。仅维护一张乐观本地卡片同样无法经受相互矛盾的 GitHub 状态或不确定 effect。

GitHub 还把 Issue open state、Project Status 与 API order 暴露为彼此独立的事实。Saki 必须记住最近一次确认的非终态 Status，才能把外部关闭或重新打开的 Issue 展示为一项带归因的修复，而不是静默改写它，或把它恢复到凭空推断的 Status。

## 决策

`SakiGitHub` 为 Issue 创建、Project membership、Project Status、Project API position 与 Issue open state 定义类型化原子 mutation 及与之对应的只读 targeted inspection。每个请求都携带由控制面持久化的 operation id，以及 GitHub 所需的该 mutation 专属目标。Service Provider 每次 dispatch 调用只执行一个外部调用，绝不在内部重试 mutation；Consumer 根据持久阶段状态与定向观察，判断目标结果是否已确认、已证明的 effect 前状态是否可以安全重复，或结果是否必须进入 conflict 或 reconciliation。

控制面状态版本 6 新增 `github_work_item_intents` 与 `github_work_item_recovery`。Intent 会冻结 Actor、调用方前置条件、不可变产品目标、有序 stage id，以及各阶段在派发前解析出的准确外部目标。控制面在调用 Provider 前先把阶段变为 `dispatching`，并写入 `effectPossible: true`。恢复流程会先检查 effect-possible 阶段，再决定是否重复操作；它会从当前阶段推导 partial-failure 展示、保留 reconciliation evidence，并从准确的剩余后缀恢复，而不是重启整个 saga。Recovery record 会保留最近一次完整的 targeted Work Item observation 与 `latestNonTerminalStatus`；浏览器 receipt 与 Board overlay 只暴露有界且适合产品使用的事实。

`CreateWorkItem` 依次运行 `issue-create`、`project-item-add` 和把 Status 设为 Inbox 的 `project-item-status-set`。Issue body 以一个确定且持久的 marker 结尾。完整的准确 marker inspection 会区分唯一 Issue、不存在、pull request 或 identity conflict、多个匹配项与不完整 evidence。Dispatch 返回的 Issue id 和 number 只是 inspection hint，不属于不可变 dispatch request。Marker evidence 存在歧义时，流程会进入 reconciliation，而不会创建另一个 Issue。

`MoveWorkItem` 从调用方提供的准确 remote fingerprint 与当前已配置 mapping 开始。需要时，它会补充缺失的 Project membership；恢复非终态 Status 前先重新打开已关闭 Issue；随后设置目标 Status、应用可选 API position，并且只在终态 Status 得到确认后关闭仍然打开的 Issue。省略 `position` 只改变 Status；`{ afterWorkItemId: null }` 表示 API 顶部；非空 predecessor 会携带该 Work Item 的 expected remote fingerprint。每个阶段都通过 targeted inspection 确认；陈旧的 membership、Status、Issue state、predecessor、mapping 或 authority 会生成类型化 conflict 或 repair result。

Confirmed Board item 带有可为 null 的 `latestNonTerminalStatus`。完整扫描会在终态观察之间延续这项记忆，targeted recovery record 会在 mutation 确认后更新它；v5 到 v6 的迁移则以非终态 item 的当前 Status 初始化该字段，对终态 item 初始化为 `null`，同时创建空的 Work Item Intent 与 recovery table。后续完整 Board checkpoint 会吸收匹配的 targeted result 并移除临时 overlay；targeted inspection 永远不会创建或推进 GitHub Sync Checkpoint。

## 边界和非目标

本决策只实现交互式 `CreateWorkItem` 与 `MoveWorkItem`。它不会加入 pull-request creation、任意 Issue editing、label mutation、按名称修复 mapping、webhook publication、automation dispatch、通用 saga language 或通用 compensation。更广泛的 [可恢复 Control Intent 提案](../../proposed/architecture/2026-08-18-saki-recoverable-control-intents.zh.md)仍负责这些跨能力生命周期；[polling-first GitHub 同步](2026-08-18-saki-polling-first-github-synchronization.zh.md)继续拥有完整扫描与 checkpoint。

当外部关闭 Issue 而 Project Status 仍为非终态时，系统会产生 `external-close` repair overlay，并建议 Done。当外部重新打开 Issue 而 Project Status 仍为终态时，系统会建议记住的非终态 Status；如果不存在这类观察，则建议 Backlog。两种情况都要求提交一条带归因的 `MoveWorkItem`；控制面不会静默修改 GitHub。

该生命周期不声称 exactly-once delivery。它会阻止未经 inspection 的重试，利用准确观察接纳结果，或在受支持阶段安全恢复，并把存在歧义的 effect 显示为 `reconciliation-required`。Operation id、`clientMutationId` 与各 mutation 专属的预期远端事实用于关联和准入；GitHub 不为这些调用提供跨调用事务或去重保证。

## 验证

Service Definition 与 Product App 测试覆盖类型化 mutation map，严格的外部 request、result 与 inspection admission、逐 operation token permission、每次 dispatch invocation 只执行一次外部调用、marker traversal、membership cardinality、Status 与 Issue-state read、完整 API-order inspection、semantic fingerprint、cancellation 与有界 failure。可复用 Provider 约定会覆盖每个 dispatch 与 targeted-inspection 成员，同时不会向 Provider 授予控制面 authority。

控制面测试覆盖 Create 与 Move stage order、准确 replay、pre-dispatch inspection、lost dispatch result、从每个 effect-possible stage 重启、partial failure、revocation、陈旧远端事实、mapping conflict、membership repair、全部三种 position form、终态 close 与 reopen 顺序、完整扫描后的 overlay retirement，以及 external close/reopen repair。Host API 测试保证 receipt 与 overlay 的 wire safety，组装后的无 key Board snapshot 则覆盖真实 bundle 路径。迁移测试会打开保留的 v5 SQLite 状态、把它迁移到 v6，并校验初始化后的 Status memory 与空 Work Item table。

## 考虑过的方案

**自动重试失败的 Provider 调用。** Transport error 不能证明 GitHub 拒绝了 mutation。Provider 内部重试或 Consumer 盲目重试可能重复创建 Issue，或丢失让后续 mutation 得以安全执行的准确远端前置条件。

**每个 effect 后等待一次完整 Board 扫描。** Polling scan 可以证明一个完整 Board generation，但它对阶段恢复来说范围过宽，也可能受到 rate limit 或无关 Project 活动的延迟。Targeted inspection 在不削弱 checkpoint 语义的前提下提供所需的最小 evidence。

**只发布一张乐观本地卡片。** 本地乐观状态可以提供及时展示，但无法确定哪些外部阶段已经发生、发现相互矛盾的 GitHub 事实，或在重启后恢复。因此，持久 overlay 会投影 Intent 与 targeted evidence，而不会取代远端确认。

**引入通用 saga framework 与持久 Provider result ledger。** 五种固定 mutation 与两种产品 Intent 需要明确的阶段专属 admission rule，尤其是 marker 歧义、membership cardinality 与 API order。通用 DSL、semantic fence、facts digest 或 Provider 持久 result 会增加第二个 authority，却无法消除这些检查。

## 后果

交互式 Create 与 Move operation 通过持久乐观 overlay 保持及时响应，而进程中断、dispatch result 丢失和部分完成都有明确的恢复路径。代价是外部 effect 周围需要一份持久 stage graph 与 targeted read，并且部分歧义结果会有意要求 reconciliation，而不是自动继续。

该实现为共享 Board generation 保留唯一的完整扫描 authority，不会增加并行同步引擎。它只支持当前 Work Item mutation，不提供 exactly-once 承诺，并把更广泛的 GitHub 写入与通用 Intent orchestration 留在本决策之外。
