# Saki 控制面

[English](saki.md) | 中文

Saki 控制面独立于 agent（智能体）对话拥有产品状态。首个发布版本的接口建立一个稳定的本地 Installation、一个已登记的 Saki Host、一个具备当前 Host Operator Grant 的人类 Principal，以及一条带版本的 Installation Access 聚合记录。版本化的置备所有者与各自带修订号的实体表会在启动中断后保留这些身份。[Saki 后端架构](../saki/architecture/0.1.0-backend.md)定义了更完整的控制面与执行面划分；本页是已实现 Cordis 服务的参考。

## Installation 访问

[`saki-control-plane`](../../packages/saki/control-plane/README.md) 通过 `storageDomain` 在 SQLite 中持久保存只含摘要的 Bootstrap Challenge 与 Browser Session 条目。bootstrap 交换在同一次比较并设置更新中消费一个状态为 `issued` 的挑战、撤销其他状态为 `issued` 的挑战，并创建一个状态为 `active` 的会话。只增不减的序号分配确定性条目 id，不可变的完成摘要会在终态详细记录清理后继续保留。每次启动具备权限的启动器都会签发新的 `initial-bootstrap` 或 `local-reauthentication` 挑战，因此 Cookie 过期、登出和响应丢失都能恢复，且不会重新开放首次完成记录。配置只接受一项准确的 HTTP(S) 回环 Origin。浏览器 Cookie 认证人类 Host Operator Principal；每项受保护操作仍会读取当前 Installation State Generation、Principal 生命周期与 Grant 权限。原始 bootstrap 与 Cookie 凭据只留在各自准确的启动器或 HTTP 载体位置，已认证的 Access Projection 仅携带后续状态变更所需的派生请求防伪令牌。

## Host 传输

[`saki-host-api`](../../packages/saki/host-api/README.md) 在逻辑 `/saki` [Connection](../../packages/client/connection/README.md) 通道上拥有严格的端点 schema。Host 适配器在解码前拒绝 URL 查询参数，在 JSON 外提取 Cookie 和请求头，构造不进入协议载荷的 `SakiAuthenticationContext`，并在 RPC 结果之外返回 `Set-Cookie`。每个 Saki 响应都使用 `Cache-Control: no-store`，每项传输或 RPC 故障都使用同一种固定且不透明的内部错误。B01 暴露空 Project-index Projection，并以稳定的 `intent-unavailable` 结果拒绝每个 Control Intent；第一个成功 Intent 属于 B03。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsakicontrolplane--sakicontrolplanemodule"></a>

### `ctx.sakiControlPlane` — `SakiControlPlaneModule`

Public deep-module operations used by Host and future automation Consumers.

```ts cordis-catalog
/**
 * Read trusted local Installation and current Host identities.
 * @returns stable independent identities.
 */
identity(): SakiInstallationIdentity

/**
 * Query one protected Projection after revalidating current authority.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param query - closed B01 Projection query.
 * @param signal - caller cancellation.
 * @returns authorized Projection or safe denial.
 */
query( authentication: SakiAuthenticationContext, query: SakiQuery, signal: AbortSignal, ): Promise<SakiQueryResult>

/**
 * Reject the empty B01 Intent map after revalidating current authority.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param intent - absent only while the merge-extensible Intent map is empty.
 * @param signal - caller cancellation.
 * @returns stable unavailable receipt.
 */
submit( authentication: SakiAuthenticationContext, intent: SakiIntentInput, signal: AbortSignal, ): Promise<SakiIntentReceipt>

/**
 * Subscribe to contained post-commit Projection invalidations.
 * @param listener - listener that re-queries affected Projection keys.
 * @returns disposer removing the listener.
 */
onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer
```

Source: [`packages/saki/control-plane/src/service.ts:125`](../../packages/saki/control-plane/src/service.ts)
<!-- END GENERATED cordis-surface -->
