# Storage

English | [中文](storage.zh.md)

The storage subsystem persists everything that is not a session event log (session logs have their own seam — [persistence.md](persistence.md)). It is one optional capability, not part of the agent-loop spine, split as a [capability seam](../../.agents/notes/implemented/architecture/2026-06-13-capability-seams.md): the hub and Service Definition ([dsh-storage](../../packages/storage/storage), `ctx.storage`), the Service Providers ([dsh-storage-json](../../packages/storage/storage-json), whose registry name defaults to `json`, and [dsh-storage-sqlite](../../packages/storage/storage-sqlite), whose name defaults to `sqlite`), and the Consumer data form ([dsh-storage-domain](../../packages/storage/storage-domain), `ctx.storageDomain`, also reachable as `ctx.storage.domain`) — the backend contract's only Consumer and the typed API everything else uses. Provider names are configurable so one composition can mount independent source and target media of the same type. The hub performs no IO itself: backends own media, data forms own semantics, and product packages never touch backends directly. Design record: [domain KV storage Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

Source: [`packages/storage/storage/src/backend.ts`](../../packages/storage/storage/src/backend.ts) · [`packages/storage/storage-domain/src/spec.ts`](../../packages/storage/storage-domain/src/spec.ts) · [`packages/storage/storage-domain/src/events.ts`](../../packages/storage/storage-domain/src/events.ts)

## The hub: `ctx.storage`

`Storage` ([signatures](#ctxstorage--storage)) is a meeting point, not a store. `ctx.storage.backend` is a name → backend table: multiple backends stay mounted side by side, and which backend serves which consumer is that consumer's configuration (the domain layer's route table), never a hub-global choice. `register(name, backend)` returns the disposer; duplicate names and unknown lookups throw `StorageError`. Disposal only unregisters the name — the owning plugin closes the backend after unregistering. Each backend plugin also publishes a lifecycle-only service key (`storageBackendServiceKey(name)`), which form providers inject so their activation cannot race backend registration.

Data forms mount on the hub under a merge-extensible key map:

```ts type-equiv
/**
 * Data forms mountable on the hub, keyed by form name. Form owners extend
 * this map via declaration merging (the domain layer merges
 * `domain: DomainFacility`) and mount the facility in their `apply`.
 */
interface StorageForms {}
```

`mount(form, facility)` is an effect whose disposer unmounts; a second mount of the same key throws `duplicate-mount`. `form(form)` resolves a mounted facility and throws `form-not-mounted` until the owning plugin loads — assemblies order plugins accordingly rather than silently deferring. The domain layer merges `domain: DomainFacility`, so `ctx.storage.domain` and `ctx.storageDomain` are the same object.

## The backend contract

```ts type-equiv
/**
 * One registered backend. A backend owns exactly one medium and shares its
 * lifecycle across all facets; facets are optional members — a backend that
 * cannot serve a data kind simply omits it, and resolution fails loud instead.
 */
interface StorageBackend {
  /** Key-value operations; absent when this backend cannot serve them. */
  readonly kv?: KvFacet

  /**
   * Reject new backend and live-unit work as soon as close begins, drain every
   * admitted live-unit operation and closed-unit callback plus every lease
   * method admitted before that callback settled, then release the medium.
   * Idempotent; concurrent and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void>
}
```

A backend owns one medium (a file-tree root, a database file) and exposes optional operation groups; `kv` is the only group today. `KvFacet.open(descriptor)` opens one named unit — `KvUnitDescriptor` carries the name, format version, table names, and whether a global singleton slot exists — and returns a `KvUnit` with `loadAll`, `putRecord`, `deleteRecord`, `setGlobal`, and `close`. Unit and table names must match `UNIT_NAME_RE` (safe as a file name and as a SQL identifier segment); `single` record keys are arbitrary strings; `per-record` keys become path components and reject empty, dot-only, slash, backslash, or NUL-containing values. `KvUnitDescriptor.version` must be a non-negative safe integer; negative zero is invalid. Values are exact JSON data: a backend rejects any value whose JSON encoding would omit or coerce data, including `undefined`, non-finite numbers, negative zero, sparse arrays, cycles, accessors, and exotic objects. Text-backed providers also reject invalid UTF-8, byte-order marks, comments, trailing commas, duplicate object members, and numeric tokens that JavaScript would round, underflow, or overflow. A unit does not serialize concurrent writes — ordering belongs to the caller — but each call is atomic on the medium and durable once resolved. Backend close synchronously ends admission for new opens, cold reservations, and methods on existing live units before it drains admitted work. `durability-uncertain` with `published: true` means the requested value is visible but durability is not confirmed; `commit-outcome-unknown` with `publicationPossible: true` means publication itself cannot be decided. Either result requires closing the live handle, discarding and recreating the affected backend (or restarting), and only then reopening from the medium. The `single` layout requires the exact version and rejects `version-mismatch`; `per-record` accepts the current version plus `compatibleVersions` and discards unaccepted records. Unparseable unit media reject `malformed-medium`. Ordinary `single` open never migrates an old medium.

Backends may expose the optional `kv.closed` operation group for maintenance that must not create or open the source. `withReservedUnit(name, signal, callback)` synchronously reserves one unit name; a live handle or competing reservation rejects `unit-open` immediately. Once the scope observes callback settlement it ends admission to that lease, and escaped leases and commit tokens reject with `closed`. The name remains reserved until every lease method admitted earlier drains, including methods the callback did not await; backend close waits for the callback and the same admitted work. The lease can inspect stored identity, read through an exact descriptor, or create-only materialize a complete missing unit. Materialization returns a lease-scoped `KvClosedUnitMaterialization`: `durable` confirms commit durability and reads the target back; `uncertain` carries the backend cause and reads either the visible target or `undefined` after confirmed absence. Only definite non-publication rejects. Caller cancellation applies before publication; afterward, readback and cleanup preserve commit evidence despite a late abort. [`backend.ts`](../../packages/storage/storage/src/backend.ts) is the normative clause-by-clause contract, and the shared conformance suites in [`tests/contract.ts`](../../packages/storage/storage/tests/contract.ts) check ordinary and cold operations against each supporting backend. The [json backend](../../packages/storage/storage-json/README.md) publishes one whole human-readable file per `single` unit, or independent files for `per-record` records; the [sqlite backend](../../packages/storage/storage-sqlite/README.md) stores one document per row in one database for frequently updated data.

## Declaring a domain

A domain is declared once by its owning package as a spec object — the single source of the domain's identity, layout, and record schemas (zod, so `z.infer` keeps consumer types un-duplicated):

```ts type-equiv
/** Static declaration of one domain: identity, version, and record layout. */
interface DomainSpec {
  /** Domain name; must match `UNIT_NAME_RE` (doubles as the backend unit name). */
  readonly name: string
  /** Current domain format version; reads enforce it according to the selected layout. */
  readonly version: number
  /**
   * Medium layout for the backend unit: `single` (the default) stores the
   * whole unit as one document; `per-record` stores each record as its own
   * document, for units whose records are large, sparse, or individually
   * disposable — the projection cache — and scopes version checks per record
   * (an unaccepted record document is discarded, never migrated).
   */
  readonly layout?: 'single' | 'per-record'
  /**
   * Older domain versions whose stored records the current record schemas
   * also accept (the declaring owner vouches for that, typically by
   * declaring the fields older records lack as optional). `per-record` backends
   * read documents stamped with a listed version instead of discarding them,
   * and accept a legacy whole-unit file so stamped for the one-time
   * bootstrap; writes always stamp {@link version}.
   */
  readonly compatibleVersions?: readonly number[]
  /**
   * What `open` does with a stored table record that fails its zod schema.
   * Absent (the default), the whole open rejects with `invalid-record` —
   * right for authoritative data. `'backup-and-skip'` is for domains whose
   * records are disposable derived data: the backend moves the record's
   * document aside (`KvUnit.backupRecord`), the failure is logged with
   * its cause, and the open continues with the record absent. A backend
   * without `backupRecord` (no per-record document to move) falls back
   * to the rejecting default. The global slot always rejects.
   */
  readonly invalidRecords?: 'backup-and-skip'
  /** Optional global singleton slot. */
  readonly global?: DomainGlobalSpec<unknown>
  /** Table declarations keyed by table name; each name must match `UNIT_NAME_RE`. */
  readonly tables: Record<string, DomainTableSpec>
}
```

`defineDomain(spec)` pins the spec's literal types and fails loud at the owner's module load, before any medium is touched: a domain or table name outside `UNIT_NAME_RE`, a version that is not a non-negative safe integer or is negative zero, or a global schema that accepts `null` all throw (`null` is the medium's "never written" sentinel, so a stored nullable global could not round-trip). `domainTable<K, V>(schema)` declares one table with a phantom compile-time key type (typically a [branded id](core.md#branded-ids)); `descriptorOf(spec)` projects the backend-facing unit descriptor.

## The open domain

```ts type-equiv
/** One open domain, typed by its spec. */
interface Domain<S extends DomainSpec> {
  /** Domain name from the spec. */
  readonly name: string
  /** Global singleton handle; a spec without `global` has no usable handle (`never`). */
  readonly global: DomainGlobalHandleOf<S>
  /**
   * Resolve one declared table handle. Handles are stable — repeated calls
   * return the same instance.
   * @param name - Declared table name.
   * @returns the typed table handle.
   */
  table<N extends keyof S['tables'] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>

  /**
   * Close this domain: reject new writes immediately, drain already-queued
   * writes (their events still emit), release the backend unit, then free
   * the domain name for a later open. Idempotent — repeated calls share one
   * teardown. The consumer owns this call (typically as its own `ctx.effect`
   * disposer); the facility closes any domain left open when it unmounts.
   * @returns resolution after the unit is released.
   */
  close(): Promise<void>
}
```

Reads are synchronous from authoritative in-memory state: `KvTable` exposes `get`/`entries`/`keys`/`size` (snapshot iterators that stay stable while queued writes land), and the global handle's `get()` serves the spec's `initial` until the first `set` materializes the slot on the medium. Every write — `put`, `delete`, `update`, `global.set` — queues on one per-domain chain and reaches backend durability first, then mutates memory, then emits `domain/changed`; a definite rejected backend write leaves memory untouched and the chain usable. A `durability-uncertain` or `commit-outcome-unknown` result also leaves memory untouched and emits no event, but poisons the live domain because its memory can no longer be reconciled with the medium. The initiating call preserves the backend error; every already-queued and later read or write rejects `write-outcome-uncertain`; `close()` still drains and releases the unit. Recovery then discards and recreates the affected backend (or restarts) before reopening from the medium. `update(key, fn)` is an atomic read-modify-write at its chain slot (a missing key rejects `missing-key`); `delete` of an absent key resolves `false` with no write and no event. Returned records are the stored objects themselves, not copies — replace via `put`/`update`, never mutate in place.

## The domain facility: `ctx.storageDomain`

`DomainFacility` ([signatures](#ctxstoragedomain--domainfacility)) opens declared domains over routed backends. Routing is the domain plugin's configuration, never the hub's: `backend` names the required default route and `routes` overrides it per domain name. `open(spec)` runs a strict sequence, each step failing the whole call: it rejects a name already open or still closing (`already-open`), resolves the route (`backend-not-found`), requires the backend's `kv` facet (`facet-unsupported`), opens the unit (backend `version-mismatch`/`malformed-medium` pass through), and validates every stored record and global against the spec's zod schemas (`invalid-record` with the offending table and key). The caller owns the returned handle and releases it with `Domain.close()`; a closed domain's name frees for reopening only after teardown fully completes. `get(name)` is an untyped diagnostic lookup onto the package-private `DomainImpl` runtime behind every typed handle. `closeAll()` is the unmount path: it waits for every remaining domain close even when one fails, preserves a sole failure or aggregates several, and plugin disposal unmounts the form after that drain regardless of the outcome.

## Cold domain migration

`defineDomainMigrations` is the only plan constructor. It declares an ordered, continuous chain of `N -> N+1` transformations ending at an exact current `DomainSpec`, captures frozen copies of the schema declaration containers, and gives the plan a module-private registered identity; the execution entry points reject structural forgeries. `DomainFacility.migrate(plan, options)` requires different source and target backends with `kv.closed`, reserves the domain and both unit names, and rejects an existing target before inspecting or reading the source. It selects the retained source spec by its stored version, verifies its exact table/global layout, validates every historical record, supplies a detached deeply frozen snapshot to each synchronous step, and requires every source and output to be lossless JSON data before validating it against the adjacent schema. Missing retained steps, current or newer source versions, malformed layouts, invalid rows, lossy JavaScript values, and step failures all reject without publishing a complete target.

After the final step, migration create-only materializes the current descriptor and reads the actual target back through the still-held reservation. The raw visible snapshot must equal the intended validated snapshot under exact JSON semantics (object member order is irrelevant) before an independent current-schema validation; a dropped or changed but still schema-valid value is invalid. The source remains unchanged, no live domain opens, and no `domain/changed` event fires. Cancellation is observed through publication; afterward, readback and cleanup preserve commit evidence despite a late abort. An uncertain result with an exact returned target reports `migration-target-durability-uncertain` and `committed: true`; confirmed absence reports `migration-target-not-committed`; a rejected uncertain readback reports `migration-target-outcome-unknown`. A durable materialization whose readback rejects has a known commit but an unverifiable target, so it reports `migration-target-invalid` and `committed: true`; a successfully returned snapshot that is schema-invalid or divergent reports the same failure. The generic layer neither blindly retries nor deletes any uncertain target. `DomainFacility.materialize` applies the same validation, create-only publication, and evidence classification to fresh current-version state. Product maintenance remains responsible for choosing source and candidate media, validating product-wide invariants, and publishing whichever candidate becomes authoritative. Facility teardown rejects new opens and cold operations, waits for every admitted open/migration/materialization, attempts every resulting live-domain close to settlement, and always removes the mounted form.

## The change event: `domain/changed`

Every durable write emits one event strictly after the backend acknowledged durability, in the domain's write-chain order ([event entry](#domainchanged--emit)):

```ts type-equiv
/** Shared location fields of one durable domain change. */
interface DomainChangedBase {
  /** Owning domain name. */
  readonly domain: string
  /** Table name; `''` for a global-singleton write. */
  readonly table: string
  /** Record key; `''` for a global-singleton write. */
  readonly key: string
}
```

```ts type-equiv
/** One durable domain change; a closed union — switch on `operation`. */
type DomainChanged = DomainChangedPut | DomainChangedDeleted
```

`put` (inserts, overwrites, and global writes) carries the new snapshot in `value` — never the old value; a diffing consumer keeps its own previous snapshot. `deleted` is a tombstone with no value. The event is a notification, not a transaction participant: the commit point has passed at emission, so a synchronously throwing listener is contained with a logged warning rather than rejecting the already-durable write, and emitted values equal the in-memory state at emission. The event is in-process only; cross-process change push is a recorded limitation ([package README](../../packages/storage/storage-domain/README.md)).

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxstorage--storage"></a>

### `ctx.storage` — `Storage`

The storage hub service. Backends register under `backend`; data forms mount under their `StorageForms` key and are reached as `ctx.storage.<form>`.

```ts cordis-catalog
/**
 * Mount a data-form facility on the hub. Mounting is an effect: the
 * returned disposer unmounts the form.
 * @param form - Form key declared in {@link StorageForms}.
 * @param facility - The facility instance to expose.
 * @returns the disposer that unmounts the form.
 */
mount<K extends keyof StorageForms>(form: K, facility: StorageForms[K]): () => void

/**
 * Resolve a mounted data form.
 * @param form - Form key declared in {@link StorageForms}.
 * @returns the mounted facility.
 */
form<K extends keyof StorageForms>(form: K): StorageForms[K]
```

Source: [`packages/storage/storage/src/index.ts`](../../packages/storage/storage/src/index.ts)

<a id="ctxstoragedomain--domainfacility"></a>

### `ctx.storageDomain` — `DomainFacility`

The mounted domain facility. Opens declared domains over routed backends; one facility instance owns the open-domain table and enforces single-open per domain name.

```ts cordis-catalog
/**
 * Open one declared domain. Steps, each failing the whole call: reject a
 * name that is already open (`already-open`); resolve the backend route
 * (`backend-not-found` passes through from the hub); require its `kv` facet
 * (`facet-unsupported`); open the unit projected from the spec (backend
 * `version-mismatch`/`malformed-medium` pass through); load and validate
 * every stored record against the spec's zod schemas (`invalid-record`
 * with the offending table and key — unless the spec declares
 * `invalidRecords: 'backup-and-skip'` and the unit can move documents aside, in
 * which case the failing record is backed up, logged, and skipped);
 * construct the domain.
 *
 * Lifecycle: the CALLER owns the returned handle and closes it via
 * `Domain.close()` (typically as its own `ctx.effect` disposer) — the
 * facility does not tie the domain to any consumer fiber. Domains still
 * open when the facility unmounts are closed by the plugin disposer.
 * @param spec - The domain declaration, typically from `defineDomain`.
 * @returns the opened domain handle, typed by the spec.
 */
async open<S extends DomainSpec>(spec: S): Promise<Domain<S>>

/**
 * Migrate one closed historical unit into a different missing target
 * backend. The domain name is reserved against ordinary open and concurrent
 * migration until every validation and committed readback phase settles.
 * @param plan - Complete retained adjacent migration chain.
 * @param options - Source/target backend names and caller cancellation.
 * @returns backend-independent migration evidence.
 */
async migrate( plan: DomainMigrationPlan, options: DomainMigrationOptions, ): Promise<DomainMigrationResult>

/**
 * Validate and atomically create one missing current-version domain on a
 * selected backend. The name is reserved against ordinary open and other
 * cold operations until the committed target has been read back and validated.
 * @param spec - Current domain declaration.
 * @param snapshot - Complete detached initial contents.
 * @param options - Target backend and caller cancellation.
 * @returns backend-independent materialization evidence.
 */
async materialize( spec: DomainSpec, snapshot: KvUnitSnapshot, options: DomainMaterializationOptions, ): Promise<DomainMaterializationResult>

/**
 * Look up an open domain by name, untyped. Diagnostic surface (the package
 * invariant cross-checks change events against live domain state); typed
 * consumers hold the handle returned by {@link open}.
 * @param name - Domain name.
 * @returns the open domain runtime, or `undefined` when not open.
 */
get(name: string): DomainImpl | undefined

/**
 * Attempt to close every domain still open on this facility and report
 * failures only after all closes settle. The unmount path for consumers
 * that never called `Domain.close()` themselves; closing is idempotent, so
 * double-closing an already-closed domain is harmless.
 * @returns resolution after every close settles.
 */
async closeAll(): Promise<void>
```

Source: [`packages/storage/storage-domain/src/index.ts`](../../packages/storage/storage-domain/src/index.ts)

<a id="domain-events"></a>

### `domain/*` events

<a id="domainchanged--emit"></a>

#### `domain/changed` — emit

A domain record or the global singleton changed, emitted once per write strictly after the backend acknowledged durability. Events of one domain arrive in its write-chain order.

```ts cordis-catalog
/**
 * A domain record or the global singleton changed, emitted once per write
 * strictly after the backend acknowledged durability. Events of one
 * domain arrive in its write-chain order.
 * @param change - domain, table (`''` for global), key (`''` for global),
 * operation discriminant, and on `put` the new snapshot.
 * @mode emit
 */
'domain/changed'(change: DomainChanged): void
```

Source: [`packages/storage/storage-domain/src/events.ts`](../../packages/storage/storage-domain/src/events.ts)
<!-- END GENERATED cordis-surface -->
