# Saki control plane

English | [中文](saki.zh.md)

The Saki control plane owns product state independently from agent conversations. Its implemented surface establishes one stable local Installation, one enrolled Host, one human Principal with a current Host Operator Grant, one versioned Installation Access aggregate, a revisioned Development Project Registry with recoverable first-registration Intents, and recoverable direct structured-Git Intents for bound Projects. A versioned provisioning owner and independently revisioned entity tables retain those identities and operation evidence across interrupted startup. The [Saki backend architecture](../saki/architecture/0.1.0-backend.md) defines the wider control-plane and execution-plane split; this page is the reference for the implemented Cordis service.

## Installation access

[`saki-control-plane`](../../packages/saki/control-plane/README.md) persists digest-only Bootstrap Challenge and Browser Session entries in SQLite through `storageDomain`. A bootstrap exchange consumes one issued challenge, revokes the other issued challenges, and creates one active session in the same compare-and-set update. Monotonic ordinals allocate deterministic entry ids, and an immutable completion summary survives terminal-detail cleanup. Every privileged launcher startup issues a new initial-bootstrap or local-reauthentication challenge, so cookie expiry, logout, and a lost response recover without reopening initial completion. Configuration accepts only an exact HTTP(S) loopback Origin. The browser cookie authenticates the human Host Operator Principal; every protected operation still reads the current Installation generation, Principal lifecycle, and Grant authority. Raw bootstrap and cookie credentials remain in their exact launcher or HTTP carrier locations, while the authenticated Access Projection carries only the derived request-forgery token required for later mutations.

## Development Project registration

The protected `inspect-project-selection` query passes an enrolled Host id and untrusted directory locator to [`ctx.sakiHostExecution`](../../packages/saki/execution/README.md). Its browser Projection contains bounded Git facts, a fingerprint, and a complete-or-unavailable inherited-change baseline without canonical paths, plaintext filenames, file contents, or credential-bearing remote material. Inspection is read-only and never creates a Workspace or Resource Binding.

`register-development-project` repeats the locator and exact browser-confirmed fingerprint and baseline, names an expected Registry revision, and carries no client-selected Actor or Grant. The control plane derives attribution from current authority, persists the Intent before Workspace creation, re-inspects the retained canonical worktree path as an untrusted locator before each effect-sensitive phase, and commits the Project, Resource Binding, path indexes, and Intent mapping through one Registry compare-and-set. Exact replay resumes the recorded phase and returns the same receipt and identities; changed payload, stale Registry revision, or duplicate canonical worktree or per-worktree Git-directory identity conflicts. Startup validates the complete Registry and Intent inventory before recovery, resumes nonterminal registration, and refreshes each Binding to `active`, `missing`, or `repair-required` from a new Host inspection.

The `project-index` query returns the current Registry revision, enrolled Host choice, and detached Project summaries. A `development-workspace` query must name that exact revision and returns one Project with current safe inspection and recovery reasons, or a typed `stale` or `not-found` result. Rebind, retirement, and Execution Leases are not part of the registration operation set; repository mutation uses the dedicated direct operation set below.

## Project changes and Git operations

The protected `project-changes` query reopens the exact active Resource Binding through `ctx.sakiHostExecution` and returns a complete path-free status observation. It includes exact Binding revision, HEAD, branch and upstream, index-tree evidence, worktree fingerprint, structured rows, status fingerprint, and repository-level eligibility for stage, unstage, and Commit. Each row uses an observation-scoped opaque id and fingerprint. `project-diff` resolves that identity and a staged, unstaged, or conflict layer against the exact observation and returns one bounded page tied to a complete patch fingerprint and cursor.

`stage-files`, `unstage-files`, and `create-commit` are durable direct Control Intents. Submission freezes the authenticated Actor and authority plus the exact Registry, Project, Binding, status, HEAD, index, worktree, and inherited-change evidence. One Binding Write Admission row allows only one `manual-host-operation` writer for the Resource Binding. The control plane reserves it, prepares one idempotent `{ kind: 'control-intent' }` Host Operation, accepts that exact preparation, and starts or inspects it outside storage callbacks. Exact replay returns the same receipt; changed immutable input conflicts; unknown or contradictory effect evidence remains `reconciliation-required`.

The Local Host builds stage and unstage results in an alternate index, persists a random same-directory pin, and links that pin without clobbering into the bound index lock before publication. It creates deterministic hook-free unsigned Commits from the observed index tree. Attached-HEAD publication freezes the target branch, revalidates HEAD immediately before the effect, and compare-and-sets only that target. Detached HEAD remains available for inspection, Diff, stage, and unstage, but CreateCommit is unavailable because Git 2.45 cannot atomically prove that `HEAD` stayed direct while compare-and-setting its object id. Git 2.45 is the minimum. Random scratch cleanup requires an exact owner marker; index-lock cleanup requires the operation-owned path, file identity, and digest; and attempted publication that cannot be proved is never retried automatically. Automated dispatch and Agent Run sources remain later work.

## Host transport

[`saki-host-api`](../../packages/saki/host-api/README.md) owns strict endpoint schemas on the logical `/saki` [Connection](../../packages/client/connection/README.md) channel. The Host adapter rejects URL queries before decoding, extracts cookies and request headers outside JSON, constructs the non-wire `SakiAuthenticationContext`, and returns `Set-Cookie` outside the RPC result. Every Saki reply uses `Cache-Control: no-store`, and every transport or RPC failure uses one fixed opaque internal error. Its protected operations correlate exact request and result types for inspection, Project-index, Development-Workspace, first-registration, Project Changes, Project Diff, stage, unstage, and Commit calls; strict outbound validation rejects an implementation result containing unexpected authority, path, credential, or Projection fields before serialization.

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

GitHub capability. Providers own authentication, pagination, response admission, and rate observations. Consumers receive only complete detached facts or a GitHubProviderError.

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
