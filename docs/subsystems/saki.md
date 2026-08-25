# Saki control plane

English | [中文](saki.zh.md)

The Saki control plane owns product state independently from agent conversations. Its implemented surface establishes one stable local Installation, one enrolled Host, one human Principal with a current Host Operator Grant, one versioned Installation Access aggregate, and a revisioned Development Project Registry with recoverable first-registration Intents. A versioned provisioning owner and independently revisioned entity tables retain those identities across interrupted startup. The [Saki backend architecture](../saki/architecture/0.1.0-backend.md) defines the wider control-plane and execution-plane split; this page is the reference for the implemented Cordis service.

## Installation access

[`saki-control-plane`](../../packages/saki/control-plane/README.md) persists digest-only Bootstrap Challenge and Browser Session entries in SQLite through `storageDomain`. A bootstrap exchange consumes one issued challenge, revokes the other issued challenges, and creates one active session in the same compare-and-set update. Monotonic ordinals allocate deterministic entry ids, and an immutable completion summary survives terminal-detail cleanup. Every privileged launcher startup issues a new initial-bootstrap or local-reauthentication challenge, so cookie expiry, logout, and a lost response recover without reopening initial completion. Configuration accepts only an exact HTTP(S) loopback Origin. The browser cookie authenticates the human Host Operator Principal; every protected operation still reads the current Installation generation, Principal lifecycle, and Grant authority. Raw bootstrap and cookie credentials remain in their exact launcher or HTTP carrier locations, while the authenticated Access Projection carries only the derived request-forgery token required for later mutations.

## Development Project registration

The protected `inspect-project-selection` query passes an enrolled Host id and untrusted directory locator to [`ctx.sakiHostExecution`](../../packages/saki/execution/README.md). Its browser Projection contains bounded Git facts, a fingerprint, and a complete-or-unavailable inherited-change baseline without canonical paths, plaintext filenames, file contents, or credential-bearing remote material. Inspection is read-only and never creates a Workspace or Resource Binding.

`register-development-project` repeats the locator and exact browser-confirmed fingerprint and baseline, names an expected Registry revision, and carries no client-selected Actor or Grant. The control plane derives attribution from current authority, persists the Intent before Workspace creation, re-inspects the retained canonical worktree path as an untrusted locator before each effect-sensitive phase, and commits the Project, Resource Binding, path indexes, and Intent mapping through one Registry compare-and-set. Exact replay resumes the recorded phase and returns the same receipt and identities; changed payload, stale Registry revision, or duplicate canonical worktree or per-worktree Git-directory identity conflicts. Startup validates the complete Registry and Intent inventory before recovery, resumes nonterminal registration, and refreshes each Binding to `active`, `missing`, or `repair-required` from a new Host inspection.

The `project-index` query returns the current Registry revision, enrolled Host choice, and detached Project summaries. A `development-workspace` query must name that exact revision and returns one Project with current safe inspection and recovery reasons, or a typed `stale` or `not-found` result. Rebind, retirement, Execution Leases, and repository mutation are not part of this operation set.

## Host transport

[`saki-host-api`](../../packages/saki/host-api/README.md) owns strict endpoint schemas on the logical `/saki` [Connection](../../packages/client/connection/README.md) channel. The Host adapter rejects URL queries before decoding, extracts cookies and request headers outside JSON, constructs the non-wire `SakiAuthenticationContext`, and returns `Set-Cookie` outside the RPC result. Every Saki reply uses `Cache-Control: no-store`, and every transport or RPC failure uses one fixed opaque internal error. Its protected operations correlate exact request and result types for inspection, Project-index, Development-Workspace, and first-registration calls; strict outbound validation rejects an implementation result containing unexpected authority, path, credential, or Projection fields before serialization.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Source: [`packages/saki/control-plane/src/service.ts`](../../packages/saki/control-plane/src/service.ts)

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

Source: [`packages/saki/execution/src/index.ts`](../../packages/saki/execution/src/index.ts)
<!-- END GENERATED cordis-surface -->
