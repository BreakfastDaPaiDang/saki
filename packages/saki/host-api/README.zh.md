---
description: "将浏览器连接到本地 Saki Host，执行经过认证的项目、Work Item、Agent Run 和交付操作。"
kind: "package-reference"
---

# `@breakfastdapaidang/saki-host-api`

[English](README.md) | 中文

## 概述

将浏览器连接到本地 Saki Host，执行经过认证的项目、Work Item、Agent Run 和交付操作。

## 目录

- [使用本包](#use-this-package)
- [端点](#endpoints)
- [传输职责](#transport-responsibilities)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

Saki 私有双侧 Host API 把控制面适配到共享 Connection 载体。Host 入口注册由 Saki 拥有的 `/saki` 逻辑通道；`./client` 入口在浏览器上下文注册 `ctx.sakiHostClient`。`./wire` 包含两侧共用、适用于浏览器的严格 schema。

<a id="endpoints"></a>
## 端点

| 端点 | 请求 | 结果 |
| --- | --- | --- |
| `access/read` | `{}` | 封闭的 Access Projection |
| `access/exchange` | `{ secret }` | Bootstrap 交换结果；`Set-Cookie` 保持在 JSON 之外 |
| `access/logout` | `{}` 与请求令牌请求头 | 登出结果；Cookie 失效响应头保持在 JSON 之外 |
| `control/query` | `{ type: 'inspect-project-selection', hostId, directoryLocator }` | 含安全选择或有界选择拒绝的已授权 Projection，或外层 denied/unavailable 结果 |
| `control/query` | `{ type: 'project-index' }` | 带修订号的 Project-index Projection 或拒绝结果 |
| `control/query` | `{ type: 'development-workspace', projectId, expectedRegistryRevision }` | 单个 Development Workspace Projection 或类型化拒绝结果 |
| `control/query` | `{ type: 'project-changes', projectId, expectedRegistryRevision }` | 完整的结构化 Git 观察、仓库级操作资格与安全的当前操作引用 |
| `control/query` | `{ type: 'project-diff', projectId, expectedRegistryRevision, request }` | 由不透明变更 id 选择的单个有界文件级 Diff 分页 |
| `control/query` | `{ type: 'project-settings', projectId }` | 当前安全的 GitHub 同步配置、激活状态与完整扫描证据，或类型化拒绝结果 |
| `control/query` | `{ type: 'board', projectId, refresh: 'cached' \| 'interactive' }` | 当前完整 Board 代次与同步证据，或类型化拒绝结果 |
| `control/query` | `{ type: 'my-work' }` | 完整的当前 Principal My Work Projection，或类型化 denied/unavailable 结果 |
| `control/query` | `{ type: 'attention' }` | 完整的当前 Principal 派生 Attention Projection，或类型化 denied/unavailable 结果 |
| `control/query` | `{ type: 'branch-delivery', projectId, workItemId, refresh: 'cached' \| 'interactive' }` | 适用于浏览器的准确 Commit 交付与定向来源证据，或类型化拒绝结果 |
| `control/query` | `{ type: 'milestone-view', projectId, milestoneId, refresh: 'cached' \| 'interactive' }` | 适用于浏览器的 Milestone 阶段、准确范围与定向发布来源证据，或类型化拒绝结果 |
| `control/submit` | 完整的 `register-development-project` Intent 与请求令牌请求头 | `SakiIntentReceipt`：已确认回执，或类型化的 denied、unavailable、conflict、failure、reconciliation-required 结果 |
| `control/submit` | 字段级 `configure-github-synchronization` Intent 与请求令牌请求头 | 已保存回执，或类型化的 denied、unavailable、conflict、failure 结果 |
| `control/submit` | 无路径的 `stage-files` Intent 与请求令牌请求头 | 带准确暂存结果证据的安全持久回执 |
| `control/submit` | 无路径的 `unstage-files` Intent 与请求令牌请求头 | 带准确取消暂存结果证据的安全持久回执 |
| `control/submit` | 无身份输入的 `create-commit` Intent 与请求令牌请求头 | 带准确 Commit 证据的安全持久回执 |
| `control/submit` | 无权限输入的 `create-work-item` Intent 与请求令牌请求头 | 带目标 GitHub Issue 结果或恢复状态的安全持久 saga 回执 |
| `control/submit` | 受 fingerprint 约束的 `move-work-item` Intent 与请求令牌请求头 | 带目标 GitHub Work Item 结果或恢复状态的安全持久 saga 回执 |
| `control/submit` | 六种受 revision 约束的 Branch Delivery Intent 之一与请求令牌请求头 | 选择、Push、Pull Request 关联或创建、评审及验收所共用的安全持久交付回执 |
| `control/submit` | `save-milestone-delivery` 或 `finalize-milestone-delivery` Intent 与请求令牌请求头 | 受 revision 约束的元数据或准确发布证据终结所共用的安全持久 Milestone 回执 |
| `control/submit` | 显式 `give-work-item-to-agent` Intent 与请求令牌请求头 | 预分配 Assignment、Work Session、Agent Run 与 Dispatch 的安全持久回执，或类型化 eligibility、cancellation 或 reconciliation 结果 |
| `control/submit` | 显式 `answer-intervention` Intent 与请求令牌请求头 | 带 Dispatch identity 的安全持久回答回执，或类型化 denied、unavailable、conflict 或 reconciliation-required 结果 |

所有请求 schema 都是严格的。查询与 Intent 结果 schema 会把每种请求与其准确的 Projection、回执阶段及失败原因关联。结构化 Git Intent 只携带 Project、Registry 与 Binding revision，status、HEAD、index tree 与 worktree 证据，供 StageFiles/UnstageFiles 使用的不透明选中变更身份，以及供 CreateCommit 使用的 Commit 消息。Work Item Intent 携带产品字段、Project 与 mapping revision、移动操作所需的准确 remote fingerprint，以及可选的 Saki 相对邻居；它们不能提供 GitHub installation、Repository、Project item、Status field/option、marker 或 API position 权限。Branch Delivery Intent 只携带准确 revision、Commit 与 ref 选择、Pull Request 元数据或身份，以及 Work Item fingerprint；控制面派生 Host、installation、repository、actor 与 mutation 权限。Milestone Delivery Intent 只携带 Project 或 Delivery revision，以及准确的 Repository、Project、Milestone、tag、release Commit 与 upstream 目标；控制面派生 Product App 凭据、当前证据、Actor 与终结权限。Give-to-Agent 只携带 Intent、Project、Work Item、expected Project revision 与 expected remote fingerprint；可信控制面派生 Actor、Profile、Model Route、Git precondition、branch safety、Session、Run 与 Dispatch 事实。安全回执只公开关联的产品身份、生命周期或 mutation 阶段、终态原因、适用于浏览器的恢复动作与已确认 evidence。再次提交与当前 pending 或 active 值完全相同的同步配置时，系统会返回类型化的 `configuration-unchanged` conflict，并且不会分配 revision。Board 结果要么包含一个与检查点匹配的原子化已确认代次，要么明确表示未配置或正在等待；它绝不携带提供方的部分分页结果，Work Item 数组与未解决 mutation overlay 数组各自最多接纳 10,000 项。超限扫描会暴露类型化容量失败，其中包含固定 resource 与 limit 以及观察数量。Board schema 会根据 Repository 与 Issue 身份重新计算每个 Work Item id，并交叉校验 GitHub item order、当前 configuration revision、mapping、failure、scan、freshness、checkpoint、有效 mutation 可用性，以及每个 optimistic、targeted-confirmed、conflict、partial-failure、reconciliation 或 repair overlay。Host 适配器会在序列化前校验控制面结果，因此意外的权限字段、规范路径、凭据材料、原始提供方详情与错配的 Projection 类型都会触发固定的不透明错误。Branch Delivery 与 Milestone View 来源失败在再次投影时会移除凭据引用。`/saki` 会在分派操作或解码请求体前拒绝非空 URL 查询参数。适配器不会忽略试图提供 Principal、Grant、Actor、AuthenticationContext 或生命周期权限事实的浏览器字段。路由信任校验失败、格式错误的信封、方法不匹配、无效的操作载荷、处理方返回的 RPC 错误与意外实现失败都会使用同一种固定且不透明的内部错误，不包含解析器、请求或异常细节。处理方运行前与运行后的每项 Saki 响应，以及成功、拒绝和错误响应，都会携带 `Cache-Control: no-store`；Cookie 响应头保持在 JSON 之外。

Branch Delivery CI 会携带根据 last-confirmed 准确 Commit fact 派生的 `confirmedSummary`，并与独立的当前 source health 并列；该 summary 绝不会把当前 failure、stale 状态或 invalidation 转化为当前 success。

Branch Delivery review 携带完整的精确 pull-request fact，并具有独立的当前 source health。Host wire 接纳用于展示的原始 review state，但不接纳验收权限、credential material 或部分 provider page。

<a id="transport-responsibilities"></a>
## 传输职责

Connection 负责路由信任校验、有界 JSON 封装、请求关联、取消、dispose（资源释放）和 JSON Content-Type。`/saki` 注册要求 Connection 通道应用 `Cache-Control: no-store` 与固定的不透明错误，因此这些策略也覆盖 Host 适配器运行前的故障。Host 适配器只从 Connection 提供的可信请求元数据读取 Cookie、Origin 与 `x-saki-request-token`。它通过控制面仅供 Host 使用的解析器取得 AuthenticationContext，并消费持久提交后不透明的 Cookie 交接值。AuthenticationContext 与原始 Cookie 材料都不会进入浏览器 JSON。

浏览器客户端的每次调用都使用同源凭据。登出与每次 Intent 提交都需要当前请求令牌。客户端提供选择检查、Project-index、Development-Workspace、Changes、文件级 Diff、Project Settings、Board、`queryMyWork`、`queryAttention`、Branch Delivery 与 Milestone View 查询、首次登记、字段级 GitHub 同步配置、结构化 Git 与 Work Item mutation、全部六种 Branch Delivery transition、两种 Milestone Delivery transition、`giveWorkItemToAgent` 与 `answerIntervention` 的准确方法；每个方法只解析与自身对应的结果 schema。`queryMyWork()`、`queryAttention()`、`queryBoard(projectId, 'cached')`、`queryBranchDelivery(projectId, workItemId, 'cached')` 与 `queryMilestoneView(projectId, milestoneId, 'cached')` 都只读取持久状态。三项可刷新的 query 的 `interactive` 策略请求有界刷新，但仍只返回通过校验的 Projection。业务拒绝仍作为类型化的 RPC 成功值返回；取消、载体故障与 schema 校验不匹配则通过 Connection 固定且不透明的 RPC 错误信封拒绝 Promise。

<a id="model-experience"></a>
## 模型体验

无。Host 与浏览器适配器传递 Saki 访问和 Projection 值，但不注册模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送模型提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **仅支持回环通道**：`/saki` 使用 Connection 的回环信任策略；远程认证与网络公开需要另一套部署设计。
- **受限的 Board 写入**：Host API 只公开 CreateWorkItem 与 MoveWorkItem。重新绑定、退役、任意 Issue 编辑与提供方权限输入仍不属于其操作集。
- **受限的结构化 Git 写入**：CreateCommit 不运行钩子且不签名；要求钩子、签名或不受支持的外部过滤器的仓库需使用 Terminal 或之后明确受信任的提供方。
- **不包含前端组合**：该包提供客户端服务与 schema，不拥有路由或渲染后的 UI。
- **仅提供 Projection schema**：Work Item detail 与 Agent Run schema 会校验前端 fixture，但本切片不会把它们接入 `control/query`、Host route 或浏览器 client。

<a id="dev-note"></a>
### 开发备注

私有 Host 组合保留 peer dependencies：认证检查共享控制面的服务构造器，Cookie 交接消费其模块持有的 WeakMap。因此它不适用已发布 Client 的依赖扁平化策略。

<details>
<summary>维护者工作上下文——点击展开</summary>

不发布 runtime invariant companion，因为适配器校验并转发每个请求，不保留第二份状态投影。

</details>
