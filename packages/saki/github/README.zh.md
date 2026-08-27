# `@breakfastdapaidang/saki-github`

[English](README.md) | 中文

Saki 私有 GitHub Service Definition 注册 `ctx.sakiGitHub`。它拥有提供方无关的外部身份、原始平台事实、严格 schema、闭合失败、rate observation、确定性扫描指纹和可复用的 Service Provider 约定。认证和 GitHub 传输属于 Service Provider；Saki Status 映射、持久检查点、轮询和 Intent 生命周期属于 Consumer。

## 能力接口

`SakiGitHub.read(request, signal)` 由可通过声明合并扩展的 `GitHubReadMap` 确定类型。B05 定义 GitHub App installation、Repository、Issue、Project v2、精确 `refs/tags/saki-v*` 引用、递归 annotated tag 剥离、按 tag 查找 Release、精确 Commit 和 Commit 比较读取。对已配置上游 Commit 的存在性检查就是精确 Commit 读取；缺失使用类型化的 `not-found` 失败。

`SakiGitHub.scan(request, signal)` 由 `GitHubScanMap` 确定类型。其 `project-board` 成员接受一个 installation profile、Project node id、Repository node/database-id 对、持久 Status field id、提供方无关的必需 Status option id、调用方拥有的 `interactive` 或 `background` 优先级，以及调用方从每项目配置解析的 `rateLimitReserve`。Provider 在内部完整翻页读取所有 field、option、item、嵌套值和 open Issue connection。cursor 和部分结果不能穿过接口。结果是一个经过验证的 `GitHubProjectBoardScanCandidate`，包含稳定的前后 update fence、API 顺序、原始 item 内容、完整 open Issue、rate observation 和带版本指纹。

必需的 Status id 不携带 Inbox 或 Ready 等 Saki 语义。它们使 Provider 能验证持久 field 恰好存在一次、类型为 single-select，且每个必需的外部 option 恰好出现一次，而不按显示名称猜测。

## 安全值与失败

GitHub App、installation、account、Repository、Project、field、option、item、Issue、pull request、tag object、Release、Commit 和 external operation 身份均带 brand。Database id 保持为经过验证的正十进制字符串；Provider 只有在证明 SDK 数字是安全整数后才转换它。原始事实保留平台 ownership、visibility、Issue state、Project membership、Status option、archive state、API 顺序、update observation、不含凭据的 HTTPS URL、安全 request id 和 rate-limit timing。它们排除 authorization header、token、private key、JWT、raw error、pagination cursor 和 SDK object。

Provider 抛出 `GitHubProviderError`；其 `failure` 只有以下闭合分支：取消、认证不可用、权限不匹配、可归因的 Status 映射不匹配、未找到、外部响应无效、primary rate limit、secondary rate limit、临时传输故障或永久拒绝。映射不匹配会标识精确的已配置 Status field 或非空的缺失必需 option id 集合，但不携带 Saki Status 语义。只有安全的 request、retry、reset、resource、operation、permission、外部 id 和 HTTP status observation 可以进入该值。因此，除非响应事实能证明类型化 rate-limit 失败，否则 GraphQL field error 或 partial data 会成为 `invalid-external-response`；不存在部分 candidate。

严格 schema 拒绝未知属性，并交叉检查扫描 ownership、唯一的 field/item/Issue 身份、每个 Repository 中 Issue number 对 Issue 身份的唯一映射、Project item 与 open Issue 中同一 Issue 的事实一致性、连续 API 顺序、所选 Status field 类型、稳定 update fence、完整计数、open Issue state 和保留指纹。一次 installation observation 最多接纳 100,000 个可访问 Repository identity；一次 scan candidate 最多接纳 10,000 个 Project field、100,000 个 Project item 和 100,000 个 open Issue。

## 指纹与未来 mutation 恢复

`computeGitHubProjectBoardFingerprint()` 生成版本 `1` 的指纹。它覆盖外部 source id、Issue state 与 revision、Project membership 与 Status、archive state、API 顺序与相邻 item，以及 update fence。field 枚举会规范化，而 Project item 与 open Issue 的 API 顺序保持权威。Provider observation time、rate timing、label、URL 和分页机制不会改变语义身份。

`GitHubMutationMap` 刻意保持为空，并可通过声明合并扩展。本包只导出 `GitHubMutationIdentity` 和后续 mutation Service Definition 所需的提供方无关 `pending | observed | absent | unknown | error` inspection 词汇。它不定义 `dispatch` 或 `inspectMutation` 方法，不定义具体 mutation 或 receipt，也没有运行时“unsupported”占位实现。

## Service Provider 约定

`tests/contract.ts` 导出 `runGitHubProviderContract()`。Provider 提供全新且确定的 harness；该测试套件验证公开 installation 读取、完整且分离的扫描、Status node-id 强制校验、预取消、闭合失败数据、rate observation 和稳定的语义指纹。Provider 专属测试仍负责 HTTP 分页、GraphQL partial-data 拒绝、认证、SDK 转换以及 primary/secondary rate-limit 解析。

## 模型体验

### GitHub 事实

#### 模型看到什么

什么也看不到。`ctx.sakiGitHub` 向 Host 侧 Saki Consumer 提供分离事实，不注册工具、prompt section 或 session event。

#### Token 影响

每次操作直接增加零个 token。

#### KV Cache 影响

与模型请求相互独立：该 Service Definition 不组装或更改请求前缀。

## 已知限制与暂缓事项

- **仅 read 和 scan**：mutation request、receipt、dispatch、崩溃后 inspection 方法和幂等策略属于后续 mutation 切片。
- **没有产品 Projection**：原始 GitHub 事实不分配 Saki Status、不创建 Inbox entry、不发布 GitHub Sync Checkpoint，也不改变持久控制面状态。
- **没有传输实现**：本包定义并测试 Service Definition；每个 Service Provider 拥有自己的 HTTP/SDK 机制、认证生命周期、分页和响应准入。
