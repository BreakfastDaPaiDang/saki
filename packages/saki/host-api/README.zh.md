# `@breakfastdapaidang/saki-host-api`

[English](README.md) | 中文

Saki 私有双侧 Host API 把控制面适配到共享 Connection 载体。Host 入口注册由 Saki 拥有的 `/saki` 逻辑通道；`./client` 入口在浏览器上下文注册 `ctx.sakiHostClient`。`./wire` 包含两侧共用、适用于浏览器的严格 schema。

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
| `control/submit` | 完整的 `register-development-project` Intent 与请求令牌请求头 | `SakiIntentReceipt`：已确认回执，或类型化的 denied、unavailable、conflict、failure、reconciliation-required 结果 |
| `control/submit` | 字段级 `configure-github-synchronization` Intent 与请求令牌请求头 | 已保存回执，或类型化的 denied、unavailable、conflict、failure 结果 |
| `control/submit` | 无路径的 `stage-files` Intent 与请求令牌请求头 | 带准确暂存结果证据的安全持久回执 |
| `control/submit` | 无路径的 `unstage-files` Intent 与请求令牌请求头 | 带准确取消暂存结果证据的安全持久回执 |
| `control/submit` | 无身份输入的 `create-commit` Intent 与请求令牌请求头 | 带准确 Commit 证据的安全持久回执 |

所有请求 schema 都是严格的。查询与 Intent 结果 schema 会把每种请求与其准确的 Projection、回执阶段及失败原因关联。结构化 Git Intent 只携带 Project、Registry 与 Binding revision，status、HEAD、index tree 与 worktree 证据，供 StageFiles/UnstageFiles 使用的不透明选中变更身份，以及供 CreateCommit 使用的 Commit 消息。它们不能提供路径、完整 Binding、effect 前基线、Host Operation source 或 acceptance、Actor、Principal、Grant、Browser Session、generation、Git 身份或 ref、argv、环境或 Git 管理位置。安全回执只公开关联的 Intent/Project 身份、operation id/type/revision/state、终态原因与严格结果证据；StageFiles/UnstageFiles 结果可以包含由 Host 解析出的仓库相对路径。再次提交与当前 pending 或 active 值完全相同的同步配置时，系统会返回类型化的 `configuration-unchanged` conflict，并且不会分配 revision。Board 结果要么包含一个与检查点匹配的原子化已确认代次，要么明确表示未配置或正在等待；它绝不携带提供方的部分分页结果，并且最多接纳 10,000 个 Work Item。超限扫描会暴露类型化容量失败，其中包含固定 resource 与 limit 以及观察数量。Board schema 会根据 Repository 与 Issue 身份重新计算每个 Work Item id，并交叉校验 GitHub item order、当前 configuration revision、mapping、failure、scan、freshness、checkpoint 与准确的有效 mutation 不可用原因集合。Host 适配器会在序列化前校验控制面结果，因此意外的权限字段、规范路径、凭据材料、原始提供方详情与错配的 Projection 类型都会触发固定的不透明错误。`/saki` 会在分派操作或解码请求体前拒绝非空 URL 查询参数。适配器不会忽略试图提供 Principal、Grant、Actor、AuthenticationContext 或生命周期权限事实的浏览器字段。路由信任校验失败、格式错误的信封、方法不匹配、无效的操作载荷、处理方返回的 RPC 错误与意外实现失败都会使用同一种固定且不透明的内部错误，不包含解析器、请求或异常细节。处理方运行前与运行后的每项 Saki 响应，以及成功、拒绝和错误响应，都会携带 `Cache-Control: no-store`；Cookie 响应头保持在 JSON 之外。

## 传输职责

Connection 负责路由信任校验、有界 JSON 封装、请求关联、取消、dispose（资源释放）和 JSON Content-Type。`/saki` 注册要求 Connection 通道应用 `Cache-Control: no-store` 与固定的不透明错误，因此这些策略也覆盖 Host 适配器运行前的故障。Host 适配器只从 Connection 提供的可信请求元数据读取 Cookie、Origin 与 `x-saki-request-token`。它通过控制面仅供 Host 使用的解析器取得 AuthenticationContext，并消费持久提交后不透明的 Cookie 交接值。AuthenticationContext 与原始 Cookie 材料都不会进入浏览器 JSON。

浏览器客户端的每次调用都使用同源凭据。登出与每次 Intent 提交都需要当前请求令牌。客户端提供选择检查、Project-index、Development-Workspace、Changes、文件级 Diff、Project Settings 与 Board 查询、首次登记、字段级 GitHub 同步配置、StageFiles、UnstageFiles 与 CreateCommit 的准确方法；每个方法只解析与自身对应的结果 schema。`queryBoard(projectId, 'cached')` 只读取持久状态；`interactive` 策略会持久安排一次高优先级完整扫描，并返回当前持久 Projection，不暴露尚未完成的分页。业务拒绝仍作为类型化的 RPC 成功值返回；取消、载体故障与 schema 校验不匹配则通过 Connection 固定且不透明的 RPC 错误信封拒绝 Promise。

## 模型体验

无。Host 与浏览器适配器传递 Saki 访问和 Projection 值，但不注册模型可见输入。

#### KV Cache 影响

无；该包既不组装也不发送模型提供方请求。

## 已知限制与暂缓事项

- **仅支持回环通道**：`/saki` 使用 Connection 的回环信任策略；远程认证与网络公开需要另一套部署设计。
- **只读 Board**：Board 与 Project Settings 会公开完整扫描检查点、映射健康度、鲜度、安全失败、调度状态和有效变更不可用原因。重新绑定、退役与远端 GitHub 变更不属于该包当前的操作集。
- **受限的结构化 Git 写入**：CreateCommit 不运行钩子且不签名；要求钩子、签名或不受支持的外部过滤器的仓库需使用 Terminal 或之后明确受信任的提供方。
- **不包含前端组合**：该包提供客户端服务与 schema，不拥有路由或渲染后的 UI。
