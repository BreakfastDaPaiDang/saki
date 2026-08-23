# Saki 控制面

[English](saki.md) | 中文

Saki 控制面独立于 agent（智能体）对话拥有产品状态。已实现接口建立一个稳定的本地 Installation、一个已登记的 Saki Host、一个具备当前 Host Operator Grant 的人类 Principal、一条带版本的 Installation Access 聚合记录，以及包含可恢复首次登记 Intent 的 Development Project Registry。版本化的置备所有者与各自带修订号的实体表会在启动中断后保留这些身份。[Saki 后端架构](../saki/architecture/0.1.0-backend.md)定义了更完整的控制面与执行面划分；本页是已实现 Cordis 服务的参考。

## Installation 访问

[`saki-control-plane`](../../packages/saki/control-plane/README.md) 通过 `storageDomain` 在 SQLite 中持久保存只含摘要的 Bootstrap Challenge 与 Browser Session 条目。bootstrap 交换在同一次比较并设置更新中消费一个状态为 `issued` 的挑战、撤销其他状态为 `issued` 的挑战，并创建一个状态为 `active` 的会话。只增不减的序号分配确定性条目 id，不可变的完成摘要会在终态详细记录清理后继续保留。每次启动具备权限的启动器都会签发新的 `initial-bootstrap` 或 `local-reauthentication` 挑战，因此 Cookie 过期、登出和响应丢失都能恢复，且不会重新开放首次完成记录。配置只接受一项准确的 HTTP(S) 回环 Origin。浏览器 Cookie 认证人类 Host Operator Principal；每项受保护操作仍会读取当前 Installation State Generation、Principal 生命周期与 Grant 权限。原始 bootstrap 与 Cookie 凭据只留在各自准确的启动器或 HTTP 载体位置，已认证的 Access Projection 仅携带后续状态变更所需的派生请求防伪令牌。

## Development Project 登记

受保护的 `inspect-project-selection` 查询把已登记 Host id 与不可信目录 locator 传给 [`ctx.sakiHostExecution`](../../packages/saki/execution/README.md)。它的浏览器 Projection 包含有界 Git 事实、指纹与“完整或不可用”的继承变更 baseline，但不包含规范路径、明文文件名、文件内容或带凭据的 remote 信息。检查只读，绝不创建 Workspace 或 Resource Binding。

`register-development-project` 会重复 locator 与浏览器确认的准确指纹和 baseline，指定预期 Registry revision，并且不携带由 client 选择的 Actor 或 Grant。控制面根据当前权限派生归因，在创建 Workspace 前持久化 Intent，并在每个涉及 effect 的阶段前把保留的规范 worktree 路径作为不可信 locator 重新检查，再通过一次 Registry 比较并设置提交 Project、Resource Binding、路径索引与 Intent 映射。准确重放会从已记录阶段继续，并返回相同回执与身份；payload 变化、Registry revision 陈旧，或者规范 worktree 或每 worktree Git 目录身份重复时会发生冲突。启动流程在恢复前校验完整 Registry 与 Intent 库存，继续非终态登记，并根据新的 Host 检查把每项 Binding 刷新为 `active`、`missing` 或 `repair-required`。

`project-index` 查询返回当前 Registry revision、已登记 Host 选项与分离的 Project 摘要。`development-workspace` 查询必须指定该准确 revision，并返回一个 Project 及其当前安全检查和恢复原因，或者类型化的 `stale` 或 `not-found` 结果。重绑定、退役、Execution Lease 与仓库修改不属于该操作集。

## Host 传输

[`saki-host-api`](../../packages/saki/host-api/README.md) 在逻辑 `/saki` [Connection](../../packages/client/connection/README.md) 通道上拥有严格的端点 schema。Host 适配器在解码前拒绝 URL 查询参数，在 JSON 外提取 Cookie 和请求头，构造不进入协议载荷的 `SakiAuthenticationContext`，并在 RPC 结果之外返回 `Set-Cookie`。每个 Saki 响应都使用 `Cache-Control: no-store`，每项传输或 RPC 故障都使用同一种固定且不透明的内部错误。其受保护操作为检查、Project-index、Development-Workspace 与首次登记调用关联准确的请求和结果类型；严格的出站验证会在序列化前拒绝含有意外权限、路径、凭据或 Projection 字段的实现结果。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsakicontrolplane--sakicontrolplanemodule"></a>

### `ctx.sakiControlPlane` — `SakiControlPlaneModule`

Control-plane operations used by trusted Consumers.

```ts cordis-catalog
/**
 * Read trusted local Installation and current Host identities.
 * @returns stable independent identities.
 */
identity(): SakiInstallationIdentity

/**
 * Query one protected Projection after revalidating current authority.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param query - closed Projection query.
 * @param signal - caller cancellation.
 * @returns the authorized Projection or that query kind's typed failure:
 * `denied` or `unavailable`, plus `stale` or `not-found` for Development Workspace reads.
 */
query<K extends keyof SakiQueryMap>( authentication: SakiAuthenticationContext, query: SakiQueryMap[K]['request'], signal: AbortSignal, ): Promise<SakiQueryResult<K>>

/**
 * Submit one durable Project-registration Intent after current authorization.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param intent - bounded immutable registration content.
 * @param signal - caller cancellation.
 * @returns a confirmed receipt or typed `denied`, `unavailable`, `conflict`,
 * `failure`, or `reconciliation-required` result with only phase-valid receipt fields.
 */
submit( authentication: SakiAuthenticationContext, intent: SakiIntentInput, signal: AbortSignal, ): Promise<SakiIntentReceipt>

/**
 * Subscribe to contained post-commit Projection invalidations.
 * @param listener - listener that re-queries affected Projection keys.
 * @returns disposer removing the listener.
 */
onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer
```

Source: [`packages/saki/control-plane/src/service.ts:136`](../../packages/saki/control-plane/src/service.ts)

<a id="ctxsakihostexecution--sakihostexecution-abstract-seam"></a>

### `ctx.sakiHostExecution` — `SakiHostExecution` (abstract seam)

Host Execution capability. Providers resolve untrusted locators in their own execution world; control-plane Consumers own product policy and state.

```ts cordis-catalog
/**
 * Resolve and inspect one selected directory without creating a Workspace or
 * changing repository state.
 * @param request - selected Host and untrusted directory locator.
 * @param signal - required caller lifetime and cancellation.
 * @returns detached safe evidence plus the trusted Host observation, or a bounded rejection.
 */
abstract inspectProjectSelection( request: InspectProjectSelectionRequest, signal: AbortSignal, ): Promise<InspectProjectSelectionResult>
```

Source: [`packages/saki/execution/src/index.ts:90`](../../packages/saki/execution/src/index.ts)
<!-- END GENERATED cordis-surface -->
