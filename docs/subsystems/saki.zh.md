# Saki 控制面

[English](saki.md) | 中文

Saki 控制面独立于 agent（智能体）对话拥有产品状态。已实现接口建立一个稳定的本地 Installation、一个已登记的 Saki Host、一个具备当前 Host Operator Grant 的人类 Principal、一条带版本的 Installation Access 聚合记录、包含可恢复首次登记 Intent 的 Development Project Registry、面向已绑定 Project 的可恢复直接结构化 Git Intent、由 GitHub 支持的可恢复 Create/Move Work Item Intent，以及启动一个可恢复 Agent Run 的手动 Give-to-Agent Intent。版本化的置备所有者与各自带修订号的实体表会在启动中断后保留这些身份与 operation evidence。[Saki 后端架构](../saki/architecture/0.1.0-backend.zh.md)定义了更完整的控制面与执行面划分；本页是已实现 Cordis 服务的参考。

## Installation 访问

[`saki-control-plane`](../../packages/saki/control-plane/README.zh.md) 通过 `storageDomain` 在 SQLite 中持久保存只含摘要的 Bootstrap Challenge 与 Browser Session 条目。bootstrap 交换在同一次比较并设置更新中消费一个状态为 `issued` 的挑战、撤销其他状态为 `issued` 的挑战，并创建一个状态为 `active` 的会话。只增不减的序号分配确定性条目 id，不可变的完成摘要会在终态详细记录清理后继续保留。每次启动具备权限的启动器都会签发新的 `initial-bootstrap` 或 `local-reauthentication` 挑战，因此 Cookie 过期、登出和响应丢失都能恢复，且不会重新开放首次完成记录。配置只接受一项准确的 HTTP(S) 回环 Origin。浏览器 Cookie 认证人类 Host Operator Principal；每项受保护操作仍会读取当前 Installation State Generation、Principal 生命周期与 Grant 权限。原始 bootstrap 与 Cookie 凭据只留在各自准确的启动器或 HTTP 载体位置，已认证的 Access Projection 仅携带后续状态变更所需的派生请求防伪令牌。

## Development Project 登记

受保护的 `inspect-project-selection` 查询把已登记 Host id 与不可信目录 locator 传给 [`ctx.sakiHostExecution`](../../packages/saki/execution/README.zh.md)。它的浏览器 Projection 包含有界 Git 事实、指纹与“完整或不可用”的继承变更 baseline，但不包含规范路径、明文文件名、文件内容或带凭据的 remote 信息。检查只读，绝不创建 Workspace 或 Resource Binding。

`register-development-project` 会重复 locator 与浏览器确认的准确指纹和 baseline，指定预期 Registry revision，并且不携带由 client 选择的 Actor 或 Grant。控制面根据当前权限派生归因，在创建 Workspace 前持久化 Intent，并在每个涉及 effect 的阶段前把保留的规范 worktree 路径作为不可信 locator 重新检查，再通过一次 Registry 比较并设置提交 Project、Resource Binding、路径索引与 Intent 映射。准确重放会从已记录阶段继续，并返回相同回执与身份；payload 变化、Registry revision 陈旧，或者规范 worktree 或每 worktree Git 目录身份重复时会发生冲突。启动流程在恢复前校验完整 Registry 与 Intent 库存，继续非终态登记，并根据新的 Host 检查把每项 Binding 刷新为 `active`、`missing` 或 `repair-required`。

`project-index` 查询返回当前 Registry revision、已登记 Host 选项与分离的 Project 摘要。`development-workspace` 查询必须指定该准确 revision，并返回一个 Project 及其当前安全检查和恢复原因，或者类型化的 `stale` 或 `not-found` 结果。重绑定、退役与 Execution Lease 不属于登记操作集；仓库 mutation 使用下方专用直接操作集。

## Project change 与 Git 操作

受保护的 `project-changes` 查询会通过 `ctx.sakiHostExecution` 重新打开精确 active Resource Binding，并返回一份完整且展示安全的 status observation。它包含精确 Binding revision、HEAD、branch 与 upstream、index-tree evidence、worktree fingerprint、带有界 repository-relative 展示路径的结构化 row、status fingerprint，以及 stage、unstage 与 Commit 的仓库级 eligibility；规范 Host 路径始终保持私有。每项 row 使用 observation-scoped opaque id 与 fingerprint。`project-diff` 会针对精确 observation 解析该 identity 与 staged、unstaged 或 conflict layer，并返回绑定到完整 patch fingerprint 与 cursor 的一个有界页面。

`stage-files`、`unstage-files` 与 `create-commit` 是持久直接 Control Intent。提交会固定已认证 Actor 与 authority，以及精确 Registry、Project、Binding、status、HEAD、index、worktree 与 inherited-change evidence。一条 Binding Write Admission row 只允许该 Resource Binding 存在一个 `manual-host-operation` 或 `agent-run` writer。直接 Git Intent 会预留前者、prepare 一条幂等 `{ kind: 'control-intent' }` Host Operation、接受该精确 preparation，并在 storage callback 外启动或检查它。精确 replay 返回同一 receipt；不可变 input 改变会 conflict；未知或矛盾 effect evidence 会保持 `reconciliation-required`。

Local Host 会通过 alternate index 构建 stage 与 unstage result，持久化位于同一目录的随机 pin，并在 publication 前以不覆盖既有文件的方式将该 pin 链接为绑定 index lock。它还会从已观察 index tree 创建确定性、无 hook 且无签名的 Commit。Attached-HEAD publication 会固定目标 branch、在副作用前立即重新验证 HEAD，并只对该 target 执行 compare-and-set。Detached HEAD 仍可用于 inspection、Diff、stage 与 unstage；但 CreateCommit 不可用，因为 Git 2.45 无法在 compare-and-set object id 的同时原子证明 `HEAD` 始终是 direct ref。Git 2.45 是最低版本。随机 scratch cleanup 要求精确 owner marker；index-lock cleanup 要求 operation-owned path、file identity 与 digest；而且无法证明结果的 attempted publication 绝不会自动重试。

## 手动 Agent dispatch

`give-work-item-to-agent` 是一条持久的手动 Control Intent。它会重新验证当前 Ready Issue 与 branch safety、活动 Binding 与完整 inherited-change baseline、Host Operator authority、验收条件、Blockage 和默认 Agent Profile，随后要求当前 LLM adapter 在持久接受前解析该 Profile 的精确 provider/model route。解析失败会返回 `model-route-unavailable`，不会保留 Agent operation 记录或启动生成。这项解析只证明已登记的 provider adapter 与精确 model metadata，不证明生产 provider authorization、credential availability、quota 或 account health。Acceptance 会固定模型可见输入，并在唤醒 Host 前预分配 Work Assignment、主要 Work Session、Agent Run、Execution Dispatch、DSH Session、输入 MessageId 与子 `MoveWorkItem` Intent。短期且可续期的 Dispatch Claim 会对交付进行 fencing；等待 Host 工作结束后的最终 acceptance 会要求该精确 claim 仍是当前 claim 且尚未过期。生命周期更长的 `agent-run` Binding Write Admission 会在同一条 row 上与直接 Git 竞争。

Local Host 会分离读取物理 Session persistence，在获取 live Agent 后重新验证可写 Git world，并且只在完整 history 证明输入不存在时才插入原始输入。Host success 证明精确 Session 与输入，而非模型执行已经完成。启动流程会在进入 ready 前，根据精确 succeeded Host Operation、物理 Session header 与原始输入恢复每个已经过校验的 running Run，而且不会增加输入、wake 或模型请求。取消与终态多记录恢复会保留 accepted delivery、live-Agent quiescence、write ownership，以及[手动 dispatch 决策](../../.agents/notes/implemented/feature/2026-08-18-saki-manual-give-to-agent-dispatch.zh.md)说明的单调 crash-prefix 语义。Automated dispatch 仍属于后续工作。

`SakiWorkItemDetailProjection` 与 `SakiAgentRunProjection` 是供前端交接使用的严格且面向浏览器安全的 schema fixture。本切片不为任一 Projection 增加控制面 query、Host route 或 browser-client method，也不会公开规范路径、凭据或 Host snapshot。

## GitHub Board 与 Work Item 操作

完整 GitHub Project scan 会原子发布一份已确认 Board 与 checkpoint。每个投影 Work Item 保留可为 null 的 `latestNonTerminalStatus` memory，让后续外部 Issue reopen 具有确定的 repair 目标；archived item 保持 Canceled，不会暴露无法执行的 reopen action。非终态 Status 下的 closed Issue 与终态 Status 下的 open Issue 会产生窄化的 `move-with-actor` repair overlay，而不会形成第二套 repair 状态机。

`create-work-item` 会持久分阶段执行带 marker 的 Issue 创建、Project membership 与 Inbox 分配。`move-work-item` 会按需分阶段执行 membership、Status、可选 API position，以及匹配的 Issue close 或 reopen 转换。控制面会在每个外部 effect 前记录 Intent 与 stage target，不允许 Provider 内部重试，并使用定向 inspection 与每 Work Item recovery evidence，在回复缺失或重启后判定 success、conflict、从准确 effect 前状态出发且已证明安全的再次尝试，或 reconciliation。Targeted overlay 会弥合下次完整 Board scan 前的间隔，但不声称 exactly-once 行为。

## Host 传输

[`saki-host-api`](../../packages/saki/host-api/README.zh.md) 在逻辑 `/saki` [Connection](../../packages/client/connection/README.zh.md) 通道上拥有严格的端点 schema。Host 适配器在解码前拒绝 URL 查询参数，在 JSON 外提取 Cookie 和请求头，构造不进入协议载荷的 `SakiAuthenticationContext`，并在 RPC 结果之外返回 `Set-Cookie`。每个 Saki 响应都使用 `Cache-Control: no-store`，每项传输或 RPC 故障都使用同一种固定且不透明的内部错误。其受保护操作为检查、Project-index、Development-Workspace、首次登记、Project Changes、Project Diff、Board、Project Settings、stage、unstage、Commit、CreateWorkItem、MoveWorkItem 与 Give-to-Agent 调用关联准确的请求和结果类型；严格的出站验证会在序列化前拒绝含有意外权限、路径、凭据或 Projection 字段的实现结果。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @returns the authorized Projection or that query kind's typed `denied`,
 * `unavailable`, `stale`, `not-found`, or `binding-unavailable` failure.
 */
query<K extends keyof SakiQueryMap>( authentication: SakiAuthenticationContext, query: SakiQueryMap[K]['request'], signal: AbortSignal, ): Promise<SakiQueryResult<K>>

/**
 * Submit one durable Control Intent after current authorization.
 * @param authentication - trusted server-derived AuthenticationContext.
 * @param intent - bounded immutable content for one declared Intent kind.
 * @param signal - caller cancellation.
 * @returns the kind-correlated terminal or recoverable receipt, or a typed
 * `denied`, `unavailable`, `conflict`, `failure`, `canceled`, or
 * `reconciliation-required` result with only phase-valid receipt fields.
 */
submit<I extends SakiIntent>( authentication: SakiAuthenticationContext, intent: I, signal: AbortSignal, ): Promise<SakiIntentReceipt<I['type']>>

/**
 * Subscribe to contained post-commit Projection invalidations.
 * @param listener - listener that re-queries affected Projection keys.
 * @returns disposer removing the listener.
 */
onChanged(listener: (keys: readonly SakiProjectionKey[]) => void): SakiChangedDisposer
```

Source: [`packages/saki/control-plane/src/service.ts`](../../packages/saki/control-plane/src/service.ts)

<a id="ctxsakigithub--sakigithub-abstract-seam"></a>

### `ctx.sakiGitHub` — `SakiGitHub` (abstract seam)

GitHub capability. Providers own authentication, pagination, response admission, and scan rate observations. Consumers receive only complete detached facts and mutation results, or a GitHubProviderError.

```ts cordis-catalog
/**
 * Perform one typed provider-neutral GitHub read.
 * @param request - declaration-map read request.
 * @param signal - required caller lifetime and cancellation.
 * @returns one detached validated GitHub fact.
 */
abstract read<K extends keyof GitHubReadMap>( request: GitHubReadMap[K]['request'], signal: AbortSignal, ): Promise<GitHubReadMap[K]['result']>

/**
 * Perform one complete scan; pagination cursors and partial results never cross this interface.
 * @param request - declaration-map scan request including caller priority.
 * @param signal - required caller lifetime and cancellation.
 * @returns one detached complete validated scan candidate.
 */
abstract scan<K extends keyof GitHubScanMap>( request: GitHubScanMap[K]['request'], signal: AbortSignal, ): Promise<GitHubScanMap[K]['result']>

/**
 * Dispatch one atomic GitHub mutation without provider retries.
 * @param request - declaration-map mutation request with a caller-persisted operation id.
 * @param signal - required caller lifetime and cancellation.
 * @returns the declaration-map result after one validated external call.
 */
abstract dispatch<K extends keyof GitHubMutationMap>( request: GitHubMutationMap[K]['request'], signal: AbortSignal, ): Promise<GitHubMutationMap[K]['result']>

/**
 * Inspect the exact external target of one mutation without publishing a complete scan.
 * @param request - the immutable request originally recorded for dispatch.
 * @param signal - required caller lifetime and cancellation.
 * @returns detached targeted facts; provider failures reject with {@link GitHubProviderError}.
 */
abstract inspectMutation<K extends keyof GitHubMutationMap>( request: GitHubMutationMap[K]['request'], signal: AbortSignal, ): Promise<GitHubMutationMap[K]['inspection']>
```

Source: [`packages/saki/github/src/index.ts`](../../packages/saki/github/src/index.ts)

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

/**
 * Revalidate the Host resource named by one Resource Binding and return
 * complete bounded Git status without changing the repository.
 * @param request - revisioned binding and registration-time attribution evidence.
 * @param signal - required caller lifetime and cancellation.
 * @returns browser-safe structured status or one bounded safe failure.
 */
abstract inspectProject( request: InspectProjectRequest, signal: AbortSignal, ): Promise<InspectProjectResult>

/**
 * Read one bounded page of a stable file-scoped Diff without accepting a
 * caller-controlled path or Git command.
 * @param binding - active Resource Binding evidence from the authorized control plane.
 * @param request - expected status, opaque change id, layer, and optional continuation.
 * @param signal - required caller lifetime and cancellation.
 * @returns one internally consistent Diff page or a bounded safe failure.
 */
abstract readDiff( binding: ActiveHostProjectBinding, request: ReadProjectDiffRequest, signal: AbortSignal, ): Promise<ReadProjectDiffResult>

/**
 * Durably create or replay one inert Host Operation before any external
 * effect and bind an ephemeral current-admission callback to its receipt.
 * @param request - complete immutable operation request and trusted Git preconditions.
 * @param admissionSource - same-process callback used only at the effect boundary.
 * @param signal - caller lifetime for preparation; aborting it is not durable cancellation.
 * @returns the durable preparation plus a Provider-owned nominal acceptance, or a bounded rejection.
 */
abstract prepareOperation<K extends HostOperationKind>( request: HostOperationRequest<K>, admissionSource: HostOperationAdmissionSource, signal: AbortSignal, ): Promise<HostOperationReceipt<K>>

/**
 * Start or resume one prepared operation after checking its Provider-owned
 * acceptance and current Binding write admission.
 * @param operation - stable reference returned by preparation.
 * @param acceptance - non-serializable Provider-owned acceptance from the matching receipt.
 * @param signal - caller lifetime for this start attempt; aborting it is not durable cancellation.
 * @returns the current durable snapshot and whether current admission allowed execution.
 */
abstract startOperation<K extends HostOperationKind>( operation: HostOperationReference<K>, acceptance: HostOperationAcceptance, signal: AbortSignal, ): Promise<HostOperationStartResult<K>>

/**
 * Restore the live handle for one control-plane-validated running Agent Run
 * from the exact succeeded Host Operation and durable Session evidence.
 * This recovery never wakes the Agent or submits model input.
 * @param operation - exact succeeded StartAgentRun Host Operation reference.
 * @param request - complete immutable request retained by the validated control plane.
 * @param signal - required startup lifetime and cancellation.
 * @returns after the matching live Agent handle has been restored for the exact Session.
 * @throws when the operation, request, physical Session evidence, or live Agent conflicts or is unavailable.
 */
abstract resumeAgentRun( operation: HostOperationReference<'start-agent-run'>, request: StartAgentRunHostOperationRequest, signal: AbortSignal, ): Promise<void>

/**
 * Inspect and recover one durable Host Operation without starting a new external effect.
 * @param operation - stable Provider-routed reference.
 * @param signal - required caller lifetime and cancellation.
 * @returns the current durable snapshot after evidence-driven lifecycle advancement.
 */
abstract inspectOperation<K extends HostOperationKind>( operation: HostOperationReference<K>, signal: AbortSignal, ): Promise<HostOperationSnapshot<K>>

/**
 * Request durable cancellation without treating caller cancellation as an
 * operation outcome.
 * @param operation - stable Provider-routed reference.
 * @param reason - closed durable product reason.
 * @param signal - caller lifetime for the cancellation request.
 * @returns the current durable operation snapshot after cancellation handling.
 */
abstract cancelOperation<K extends HostOperationKind>( operation: HostOperationReference<K>, reason: HostOperationCancellationReason, signal: AbortSignal, ): Promise<HostOperationSnapshot<K>>

/**
 * Subscribe to post-commit Host Operation revision changes.
 * @param listener - contained wake-up listener; snapshots remain authoritative.
 * @returns disposer for this subscription.
 */
abstract onChanged(listener: (change: HostOperationChange) => void): HostOperationChangedDisposer
```

Types: [StartAgentRunHostOperationRequest](../../packages/saki/execution/README.zh.md)

Source: [`packages/saki/execution/src/index.ts`](../../packages/saki/execution/src/index.ts)

<a id="ctxsakiinstallationstate--sakiinstallationstate-abstract-seam"></a>

### `ctx.sakiInstallationState` — `SakiInstallationState` (abstract seam)

Maintenance-owned active Installation and storage-generation identity.

```ts cordis-catalog
/**
 * Promote an already-published provisioning manifest to ready after product validation.
 * A generation selected by a ready manifest treats this as an idempotent validation point.
 * @param signal - control-plane startup lifetime.
 */
abstract activateAfterValidation(signal: AbortSignal): Promise<void>
```

Source: [`packages/saki/control-plane/src/installation-state.ts`](../../packages/saki/control-plane/src/installation-state.ts)
<!-- END GENERATED cordis-surface -->
