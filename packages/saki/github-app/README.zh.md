# `@breakfastdapaidang/saki-github-app`

[English](README.md) | 中文

这个 Saki 私有包通过 Saki Product GitHub App 提供 `ctx.sakiGitHub`。它使用 operation 作用域的 installation token 认证，把外部响应准入为 [`saki-github`](../github/README.zh.md) 定义的提供方无关 fact、mutation result 和 inspection。产品 Status 语义、持久 GitHub Sync Checkpoint、mutation saga 和 Board Projection 仍属于 Consumer。

## Product App 身份与权限

`product-app-manifest.json` 是 Product App 权限上限的源 manifest。已安装 App 使用 Organization Projects 与 Issue 写权限创建和移动 Work Item；pull request 写权限仍保留给后续 PR 切片。它对 Actions、Checks、Contents、Metadata 和 commit status 具有读权限。Contents write、Workflows write、OAuth user authorization 和 webhook delivery 均不存在。

每次 operation 都重新解析配置的 private-key `CredentialRef`，并要求精确的 `local-user-trust` Credential Protection Level。private key 只在该 operation 内用于签署 App 认证。Repository-bound operation 请求绑定到已配置 Repository database id 的短期 installation token，要求 selected-Repository mode 和精确的该 Repository id，并且只请求该 operation 指定的权限。Read 和 inspection 使用 read grant；Project mutation 使用 Organization Projects write 与 Metadata read；Issue create 与 state change 使用 Issues write 与 Metadata read，对应 inspection 则使用 Issues read 与 Metadata read。token、private key、JWT、authorization header、SDK error、response body 和 pagination cursor 都不会进入提供方结果或诊断。

配置的 installation account 改变、installation suspension、App grant 缺失或超出上限、token 响应升权、配置的 Repository 不可访问、不安全的数字 id、畸形响应或 token 过期都会被拒绝。精确 GraphQL node 为 null 时会产生类型化 `not-found` failure，而不会被视为畸形响应。任何 operation 都不请求 Contents write 或 Workflows write。

## Read 与完整 scan

提供方实现 installation、Repository、Issue revision、完整 Issue detail、branch safety、Project v2、精确 `refs/tags/saki-v*`、递归 annotated-tag peel、按 tag 查找 Release、Commit 和 Commit comparison read。已有分支采用 GitHub 的 `protected` 事实，其中包括适用的 branch protection 和 ruleset。缺失分支通过 GitHub 的 effective-rules endpoint 检查；存在活动规则时归类为受保护，没有活动规则时返回 `legacy-protection-unknown`，因为只读 token 无法排除旧式保护。该路径不请求 Administration 权限。tag peel 会检查循环并限制深度。Release `target_commitish` 只为展示保留，绝不作为 Commit 证据。

一次 `project-board` scan 会执行两遍完整读取，覆盖 Project field、按 API position 升序排列的 archived 与 non-archived Project item、嵌套 item field value 和 open Repository Issue。每一遍都有自己的前后 Project 与 Repository fence、mapping 校验、分页和计数校验。每一页都经过严格解析，并且必须重复精确的请求 Project、Repository node/database-id 对或 Project item 父身份；id 与 cursor 不得重复；配置的 Status id 必须仍精确标识一个 single-select field 及每个必需 option；配置的 item、field-value、page 和 response-byte 限制会快速失败，而不是截断结果。只有两遍的语义指纹相同时，提供方才返回第二遍 candidate；数量不变的 Status 变更或任何其他语义差异都会拒绝本次 operation，且不存在部分 candidate。

Repository access 检查的 installation-token REST rate header 和 GraphQL rate fact 会随成功 scan 返回。App-JWT installation identity 读取不消耗该 token 的预算，也可能省略 primary-rate header。每次 GraphQL request 成功后，如果报告的剩余点数达到或低于 request 中由 Consumer 从每项目配置解析的 `rateLimitReserve`，background scan 就会停止；内部不会 sleep 或 retry。每个 installation 使用一个队列串行化 HTTP request，并让已排队的 interactive call 优先于 background page。`maxConcurrentScans` 另行限制跨 installation 的完整 scan。dispose 会取消已排队和活动中的工作，并等待自有 operation 结算。

## 原子 mutation 与 targeted inspection

Provider 每次 dispatch 调用执行一次 Issue create、Project membership、Status、API-position 或 Issue open-state mutation call，不会在内部 retry。每个 request 都携带调用方已持久化的 `operationId`，GitHub 以 `clientMutationId` 接收它；dispatch 与 targeted inspection 以 interactive work 进入 installation 队列。Issue create 通过 GraphQL `createIssue` 发送完整且已验证的 title 和确定性 marker-bearing body，并且只返回创建后的 Issue id 与 number；可选的已知 Issue hint 绝不会被发送。其余四种 dispatch operation 验证 GitHub acknowledgement 后返回 void。传输失败或 acknowledgement 缺失会返回给 Consumer，由其先执行 inspection，再决定另一次调用是否安全。

每项 mutation 都有只读 inspection 路径，并且只返回 `{ snapshot, observedAt }`。Issue-create inspection 先证明 Repository node、database 和 owner 身份，再以 `state=all`、固定 created 顺序分页、raw Markdown media 和权威 `Link rel="next"` 终止条件遍历 `GET /repos/{owner}/{repo}/issues`。它在分类前扫描每个已接纳页面，通过 `pull_request` 字段区分 REST pull-request entry，并把 page/item 边界、畸形分页或重复 entry 分类为 incomplete。Membership inspection 遍历完整 Project item connection，并报告 absent、unique 或 duplicate Issue membership。Status 与 position inspection 保留精确 Issue、membership、field option、archive state、API 顺序和相关 neighbor，同时拒绝不一致的 target revision。Issue-state inspection 读取精确 Repository 与 Issue，只接纳绑定 Repository 的 open 或 closed fact。这些 targeted inspection 不产生 Board scan candidate，也不推进 GitHub Sync Checkpoint。

## 配置

| 字段 | 默认值 | 接受范围 | 作用 |
| --- | ---: | ---: | --- |
| `pageSize` | 50 | 1–100 | 一页 GitHub connection 请求的 item 数量。 |
| `maxPages` | 1,000 | 1–10,000 | 一个 connection 遍历的页数。 |
| `maxItems` | 20,000 | 1–100,000 | 每个集合接纳的 Project item、open scan Issue 或 REST Issue-create inspection entry 数量；它不限制 installation Repository 或 Project field。 |
| `maxFieldValues` | 100,000 | 1–1,000,000 | 一次完整 scan 接纳的 item field value 数量。 |
| `maxResponseBytes` | 16 MiB | 1–`Number.MAX_SAFE_INTEGER` bytes | 一次 HTTP response 接纳的字节数。 |
| `requestTimeoutMs` | 30,000 | 1–2,147,483,647 ms | 一次 GitHub request 允许的 wall-clock 时间。 |
| `tagPeelDepth` | 32 | 1–100 | 一次递归 peel 接纳的 annotated-tag object 数量。 |
| `maxConcurrentScans` | 2 | 1–1,000 | 跨 installation 同时运行的完整 Project scan 数量。 |

Installation observation 最多接纳 100,000 个可访问 Repository identity，完整 scan candidate 最多接纳 10,000 个 Project field。这些 Service 级上限与 provider-neutral fact schema 一致，不受 `maxItems` 控制。

以上字段都是经过验证的 Cordis 插件配置，其默认值是本包拥有的部署选择。每项目 `rateLimitReserve` 则属于 Consumer，并且必须在每个 scan request 中显式提供；任何一层都不会在 `scan()` 内应用隐藏 fallback。

## 失败

失败使用 `saki-github` 的闭合 `GitHubProviderError` 数据：取消、认证不可用、权限不匹配、可归因的 Status 映射不匹配、缺失、外部响应无效、primary 或 secondary rate limit、临时传输故障或永久拒绝。只有经过清理的 operation、resource、permission、外部 id、HTTP status、request id、retry delay 和 reset time 可以穿过 Service Provider 接口。提供方绝不执行未报告的 retry，也不发布部分结果。

## 模型体验

### Product App 事实

#### 模型看到什么

什么也看不到。Host 侧 `ctx.sakiGitHub` Service Provider 不注册 tool、prompt section、session event 或 model request content。

#### Token 影响

每次 operation 直接增加零个 token。

#### KV Cache 影响

与 model request 相互独立：Product App 认证和 GitHub 响应准入不组装或改变 request prefix。

## 已知限制与暂缓事项

- **没有 pull-request create**：已支持 marker-bearing Issue create，但 pull-request create 以及任何 Contents 或 Workflows write 仍不存在。
- **轮询属于 Consumer**：这个 Service Provider 调度 page 和完整 scan concurrency，但不决定 Project 何时 refresh，也不持久化 GitHub Sync Checkpoint。
- **没有 webhook endpoint**：0.1.0 使用轮询；后续 webhook 可以唤醒同一个完整 scanner，但不能直接应用 Board state。
- **Operator smoke 需要 installation**：无密钥测试使用受控响应覆盖真实 Octokit 认证与传输边界。实时 read 要求安装 Product App，并通过 local-user-trust credential provider 配置其 private key。
