# 用户凭据

[English](credentials.md) | 中文

[dsh-credentials](../../packages/credentials/credentials) 的凭据 seam 把机密挡在配置之外：settings 分节与 `cordis.yml` 条目携带的是*引用*（环境变量名），值归 [dsh-credentials-local](../../packages/credentials/credentials-local) 与 [dsh-credentials-windows-dpapi](../../packages/credentials/credentials-windows-dpapi) 这类提供方所有，消费方每个操作解析一次引用——LLM（大语言模型）适配器每次模型请求解析一次，因此轮换后的凭据无需任何重启即可作用于紧随其后的下一次请求。一条 seam 级规则约束每个提供方：空的存储值在任何地方都视为不存在。

来源：[`packages/credentials/credentials/src/index.ts`](../../packages/credentials/credentials/src/index.ts)

## 标识

引用以 POSIX 风格环境变量名命名一条凭据。brand 防止调用方将凭据引用与在包或进程之间传递的其他字符串混用；构造时校验 shell 标识符语法。

```ts type-equiv
/** Nominal reference to one credential: a POSIX-style environment-variable name. */
type CredentialRef = Branded<'CredentialRef'>
```

保护级别是提供方为某个实际来源声明的恢复信任模型。标识符只作描述而不排序：策略接受一个精确标识符，而不把每种存储机制排成通用的强弱顺序。健康状态则区分「值不存在」与「记录已配置但当前 Host 无法使用」。

```ts type-equiv
/** Provider-defined description of the identities and processes that may recover a credential value. */
type CredentialProtectionLevel = Branded<'CredentialProtectionLevel'>
```

```ts type-equiv
/** Safe observation of whether a credential can be used without exposing its value. */
type CredentialHealth = 'available' | 'missing' | 'unavailable'
```

## 解析

`resolve(ref)` 返回值以及提供该值的来源层和保护级别（由提供方定义）；未配置期间返回 `undefined`。消费方在每个操作中重新解析，绝不跨操作缓存——这种按操作进行的读取正是热更新机制。`resolveRequired(ref, level)` 在同一结果上强制一个精确保护标识符；值缺失、旧提供方没有有效元数据或来源不匹配时，都会在调用方拿到值之前失败关闭。

```ts type-equiv
/** One resolved credential value and the source layer that supplied it. */
interface ResolvedCredential {
  /** The non-empty secret value. */
  value: string
  /** Provider-defined source layer id (the local provider uses `env`, `file`, `project-env`, and `user-env`). */
  source: string
  /** Provider-defined recovery trust model for this exact resolved value. */
  protectionLevel: CredentialProtectionLevel
}
```

## 描述

`describe(ref)` 在绝不暴露值的前提下回应配置界面：引用本身、当前是否可解析、来源与保护级别、`set` 当前能否成功、健康状态以及这些事实的观察时间。本地提供方把由当前进程环境供值的引用报告为 `writable: false`——那样的写入会表面成功而解析持续返回遮蔽值，因此 seam 直接拒绝，界面也得以提前把该引用渲染为只读。Windows DPAPI 提供方会把复制而来、损坏或作用域不同的记录报告为已配置但不可用，且不会返回其密文。

```ts type-equiv
/** Safe observation for one reference, including its recovery trust model but never its value. */
interface CredentialInfo {
  /** Reference this observation describes. */
  ref: CredentialRef
  /** Whether the provider has a record or effective source assigned to this reference. */
  configured: boolean
  /** Source layer currently supplying the value; absent while unconfigured. */
  source?: string
  /** Recovery trust model of the effective source, or the provider's writable source while missing. */
  protectionLevel: CredentialProtectionLevel
  /** Whether {@link CredentialProvider.set} would currently succeed for this reference. */
  writable: boolean
  /** Whether the value is available, absent, or present but unusable. */
  health: CredentialHealth
  /** Unix epoch milliseconds at which the provider made this observation. */
  observedAt: number
}
```

`plaintext`、`ephemeral` 与 `local-user-trust` 是内置标识符。`local-user-trust` 表示 Windows 当前用户 DPAPI 存储：它保护持久化值，但不声称能隔离刻意以同一 Windows 用户身份运行的进程。要建立更强边界，需要独立隔离的凭据代理或外部机密管理器。

## 已提交的变更

`credentials/updated (ref)` 在提供方管理的来源发生已提交变更后发出——`set`、`unset` 或在存储中观察到的外部编辑。进程环境自身的变化不可观测，永不发出事件。消费方不需要该事件（它们按操作重新解析）；它服务于配置界面刷新「已配置」徽标。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcredentials--credentialprovider-abstract-seam"></a>

### `ctx.credentials` — `CredentialProvider` (abstract seam)

Abstract credential service. Providers implement the four operations over their source layers; one seam-wide rule binds them all: an empty stored value is absent everywhere — `resolve` skips it, `describe` reports it unconfigured — so a blank never masquerades as a configured secret.

```ts cordis-catalog
/**
 * Resolve one reference to its current value. Resolution is per call:
 * consumers re-resolve at each operation and must not cache across
 * operations — that per-operation read is what makes a changed credential
 * reach the next operation without a restart.
 * @param ref - the reference to resolve.
 * @returns the value and its source, or `undefined` while unconfigured.
 */
abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

/**
 * Resolve one reference and require an exact provider-defined protection
 * level on the same result. Missing values, missing metadata from an older
 * provider, and every non-matching level fail before the caller receives the
 * value. Protection identifiers are descriptive, not an ordered scale.
 * @param ref - the reference to resolve.
 * @param required - the exact protection level the consumer accepts.
 * @returns the resolved credential after its metadata satisfies the requirement.
 */
async resolveRequired(ref: CredentialRef, required: CredentialProtectionLevel): Promise<ResolvedCredential>

/**
 * Describe one reference for configuration surfaces without exposing the
 * value.
 * @param ref - the reference to describe.
 * @returns safe source, protection, health, and writability metadata observed at call time.
 */
abstract describe(ref: CredentialRef): Promise<CredentialInfo>

/**
 * Durably store one value in the provider-managed writable source. Rejects
 * while a read-only source shadows the reference — the write would appear
 * to succeed while resolution keeps returning the shadowing value — and
 * rejects an empty value (use {@link unset}).
 * @param ref - the reference to store.
 * @param value - the non-empty secret value.
 */
abstract set(ref: CredentialRef, value: string): Promise<void>

/**
 * Remove one reference from the provider-managed writable source; removing
 * an absent reference is a no-op. Rejects while a read-only source shadows
 * the reference, like {@link set}.
 * @param ref - the reference to remove.
 */
abstract unset(ref: CredentialRef): Promise<void>
```

Source: [`packages/credentials/credentials/src/index.ts:90`](../../packages/credentials/credentials/src/index.ts)

<a id="credentials-events"></a>

### `credentials/*` events

<a id="credentialsupdated--emit"></a>

#### `credentials/updated` — emit

Committed change to a provider-managed credential source: a `set`, an `unset`, or an external edit observed in storage. Ambient process-environment changes are not observable and never emit. Listener failures are contained and logged — a sync throw and an async rejection alike — without changing the committed operation's outcome, except `INVARIANT`-coded failures, which rethrow after every listener ran; that rethrow reaches the emitter only from synchronous listeners, so invariant checks on this event must not be async functions.

```ts cordis-catalog
/**
 * Committed change to a provider-managed credential source: a `set`, an
 * `unset`, or an external edit observed in storage. Ambient
 * process-environment changes are not observable and never emit. Listener
 * failures are contained and logged — a sync throw and an async rejection
 * alike — without changing the committed operation's outcome, except
 * `INVARIANT`-coded failures, which rethrow after every listener ran;
 * that rethrow reaches the emitter only from synchronous listeners, so
 * invariant checks on this event must not be async functions.
 * @param ref - the reference whose stored value changed.
 * @mode emit
 */
'credentials/updated'(ref: CredentialRef): void
```

Source: [`packages/credentials/credentials/src/types.ts:35`](../../packages/credentials/credentials/src/types.ts)
<!-- END GENERATED cordis-surface -->
