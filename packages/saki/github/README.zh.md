# `@breakfastdapaidang/saki-github`

[English](README.md) | 中文

Saki 私有 GitHub Service Definition 注册 `ctx.sakiGitHub`。它拥有提供方无关的外部身份、原始平台事实、严格 schema、闭合失败、scan rate observation、确定性扫描指纹和可复用的 Service Provider 约定。认证和 GitHub 传输属于 Service Provider；Saki Status 映射、持久检查点、轮询和 Intent 生命周期属于 Consumer。

## 能力接口

`SakiGitHub.read(request, signal)` 由可通过声明合并扩展的 `GitHubReadMap` 确定类型。它定义 GitHub App installation、Repository、Issue revision、完整且有界的 Issue detail、branch safety、Project v2、精确 `refs/tags/saki-v*` 引用、递归 annotated tag 剥离、按 tag 查找 Release、精确 Commit 和 Commit 比较读取。Branch safety 区分已有的安全或受保护分支，以及由活动规则覆盖的缺失分支；当缺失分支没有活动规则时，事实为 `legacy-protection-unknown`，因为它无法排除旧式保护。对已配置上游 Commit 的存在性检查就是精确 Commit 读取；缺失使用类型化的 `not-found` 失败。

`SakiGitHub.scan(request, signal)` 由 `GitHubScanMap` 确定类型。其 `project-board` 成员接受一个 installation profile、Project node id、Repository node/database-id 对、持久 Status field id、提供方无关的必需 Status option id、调用方拥有的 `interactive` 或 `background` 优先级，以及调用方从每项目配置解析的 `rateLimitReserve`。Provider 在内部完整翻页读取所有 field、option、item、嵌套值和 open Issue connection。cursor 和部分结果不能穿过接口。结果是一个经过验证的 `GitHubProjectBoardScanCandidate`，包含稳定的前后 update fence、API 顺序、原始 item 内容、完整 open Issue、rate observation 和带版本指纹。

必需的 Status id 不携带 Inbox 或 Ready 等 Saki 语义。它们使 Provider 能验证持久 field 恰好存在一次、类型为 single-select，且每个必需的外部 option 恰好出现一次，而不按显示名称猜测。

`SakiGitHub.dispatch(request, signal)` 和 `inspectMutation(request, signal)` 由 `GitHubMutationMap` 确定类型。其具体成员创建绑定 marker 的 Issue、把 Issue 加入 Project、设置单个 Project item 的 Status 或 API position，以及把单个 Issue 设置为 open 或 closed。每个 request 都携带调用方已持久化的 `operationId`；mutation dispatch 与 inspection 始终属于 interactive，因此只有 scan request 携带队列 priority。每次 dispatch 调用执行一次外部 call，Provider 不在内部 retry；Issue create 只返回后续 inspection 所需的 Issue id 和 number，其他 dispatch result 为 void。Inspection 只返回 targeted snapshot 及其 observation time，使 Consumer 能处理已确认、acknowledgement 丢失或冲突的结果。

## 安全值与失败

GitHub App、installation、account、Repository、Project、field、option、item、Issue、Issue-create marker、pull request、tag object、Release、Commit 和 external operation 身份均带 brand。Database id 保持为经过验证的正十进制字符串；Provider 只有在证明 SDK 数字是安全整数后才转换它。原始事实保留平台 ownership、visibility、Issue state、Project membership、Status option、archive state、API 顺序、update observation、不含凭据的 HTTPS URL、安全 request id 和 rate-limit timing。它们排除 authorization header、token、private key、JWT、raw error、pagination cursor 和 SDK object。

Provider 抛出 `GitHubProviderError`；其 `failure` 只有以下闭合分支：取消、认证不可用、权限不匹配、可归因的 Status 映射不匹配、未找到、外部响应无效、primary rate limit、secondary rate limit、临时传输故障或永久拒绝。映射不匹配会标识精确的已配置 Status field 或非空的缺失必需 option id 集合，但不携带 Saki Status 语义。只有安全的 request、retry、reset、resource、operation、permission、外部 id 和 HTTP status observation 可以进入该值。因此，除非响应事实能证明类型化 rate-limit 失败，否则 GraphQL field error 或 partial data 会成为 `invalid-external-response`；不存在部分 candidate。

严格 schema 拒绝未知属性，并交叉检查扫描 ownership、唯一的 field/item/Issue 身份、每个 Repository 中 Issue number 对 Issue 身份的唯一映射、Project item 与 open Issue 中同一 Issue 的事实一致性、连续 API 顺序、所选 Status field 类型、稳定 update fence、完整计数、open Issue state 和保留指纹。Issue-detail read 要么接纳完整 Markdown body，要么拒绝；body 可以为空，经过 UTF-8 编码后最多为 256 KiB。Issue-create request 要求不超过 1,024 个 UTF-8 字节的良构单行 title，以及不超过 60,000 个 UTF-8 字节、使用 LF 归一化并以唯一持久 `<!-- saki-work-item:<markerId> -->` 行结尾的良构 body。一次 installation observation 最多接纳 100,000 个可访问 Repository identity；一次 scan candidate 最多接纳 10,000 个 Project field、100,000 个 Project item 和 100,000 个 open Issue。

## Scan 指纹与 mutation 恢复

`computeGitHubProjectBoardFingerprint()` 生成版本 `1` 的指纹。它覆盖外部 source id、Issue state 与 revision、Project membership 与 Status、archive state、API 顺序与相邻 item，以及 update fence。field 枚举会规范化，而 Project item 与 open Issue 的 API 顺序保持权威。Provider observation time、rate timing、label、URL 和分页机制不会改变语义身份。

Targeted inspection 只保留对应 mutation 所需的事实。Project membership inspection 区分 absent、unique 和 duplicate membership，并且只公开 membership identity 与 archive state。Status 和 position inspection 保留精确 Issue、Status、API order 与相关 neighbor；position 还保留请求 predecessor 的 observation（包括缺失 anchor），但不回显 request target。Issue-state inspection 保留精确的 open 或 closed Issue fact。Targeted observation 绝不声称或推进完整 Board scan checkpoint。

Issue-create inspection 使用已持久化的精确隐藏 marker，区分唯一真实 Issue、完整缺失、pull-request 命中、已知 Issue marker 被移除、已知 Issue 缺失、身份冲突、多次出现，以及有界或不一致遍历。唯一结果携带 Issue fact；每个非成功结果仅携带分类状态。可选的已知 Issue hint 仅用于 inspection，不改变已持久化的 `operationId`。完整缺失只是证据，不授予 Provider 再次创建的权限；`effectPossible` 决策属于 Consumer。

## Service Provider 约定

`tests/contract.ts` 导出 `runGitHubProviderContract()`。Provider 提供全新且确定的 harness；该测试套件验证公开 installation 读取、完整且分离的 scan、每次调用的 mutation result、targeted mutation inspection、Status node-id 强制校验、预取消、闭合失败数据、scan rate observation 和稳定的语义指纹。Provider 专属测试仍负责 HTTP 分页、GraphQL partial-data 拒绝、认证、SDK 转换、mutation response 准入以及 primary/secondary rate-limit 解析。

## 模型体验

### GitHub 事实

#### 模型看到什么

什么也看不到。`ctx.sakiGitHub` 向 Host 侧 Saki Consumer 提供分离事实，不注册工具、prompt section 或 session event。

#### Token 影响

每次操作直接增加零个 token。

#### KV Cache 影响

与模型请求相互独立：该 Service Definition 不组装或更改请求前缀。

## 已知限制与暂缓事项

- **没有产品 saga**：GitHub fact 和 mutation result 不选择 mutation 顺序、不重试未知结果、不分配 Saki Status、不发布 GitHub Sync Checkpoint，也不改变持久控制面状态。
- **没有 pull-request create**：mutation map 只创建 Issue；pull request 以及任何 Contents 或 Workflows write 都不在此能力中。
- **没有传输实现**：本包定义并测试 Service Definition；每个 Service Provider 拥有自己的 HTTP/SDK 机制、认证生命周期、分页和响应准入。
