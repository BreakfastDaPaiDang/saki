/**
 * Domain data form (`ctx.storage.domain`): schema-validated, change-emitting
 * KV domains over storage backends. The single implementation of the domain
 * layer — consumers depend on this package and never touch backends directly.
 * Plugin `Config` is schemastery; record schemas inside domain specs are zod
 * (see `src/spec.ts` for the split rationale).
 * @module @deepseek-ai/dsh-storage-domain
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { DomainError, parseStoredDomainValue } from './error.ts'
import { descriptorOf } from './spec.ts'
import type { DomainSpec } from './spec.ts'
import { DomainImpl } from './domain.ts'
import type { Domain } from './domain.ts'
import {
  assertDomainMigrationPlan,
  runDomainMaterialization,
  runDomainMigration,
} from './migration.ts'
import type {
  DomainMaterializationOptions,
  DomainMaterializationResult,
  DomainMigrationOptions,
  DomainMigrationPlan,
  DomainMigrationResult,
} from './migration.ts'

export { DomainError } from './error.ts'
export type { DomainErrorCode, DomainErrorOptions, InvalidRecordDetail } from './error.ts'
export { defineDomain, domainTable, descriptorOf } from './spec.ts'
export type {
  DomainSpec, DomainGlobalSpec, DomainTableSpec,
  TableKeyOf, TableValueOf, GlobalValueOf,
} from './spec.ts'
export type { DomainChanged } from './events.ts'
export type { Domain, DomainGlobal, DomainGlobalHandleOf, KvTable } from './domain.ts'
export { defineDomainMigrations } from './migration.ts'
export type {
  DomainMigrationOptions,
  DomainMigrationPlan,
  DomainMigrationPlanInput,
  DomainMigrationResult,
  DomainMigrationSnapshot,
  DomainMigrationStep,
  DomainMaterializationOptions,
  DomainMaterializationResult,
} from './migration.ts'

declare module '@deepseek-ai/dsh-storage' {
  interface StorageForms {
    domain: DomainFacility
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    storageDomain: DomainFacility
  }
}

/** Cordis plugin name. */
export const name = 'storage-domain'
/** The storage hub must be present before the form can mount. */
export const inject = ['storage']

/**
 * Plugin config. Which backend serves which domain is decided here, not
 * globally on the hub: `backend` is the default route and `routes` overrides
 * it per domain name. A route naming an unregistered backend fails loud at
 * `open` with `backend-not-found`.
 */
export interface Config {
  /** Default backend name for every domain without an explicit route. Required: there is no universally correct medium. */
  backend: string
  /** Per-domain overrides: domain name → backend name. */
  routes?: Record<string, string>
}

export const Config: z<Config> = z.object({
  backend: z.string().required(),
  routes: z.dict(z.string()).default({}),
})

/**
 * The mounted domain facility. Opens declared domains over routed backends;
 * one facility instance owns the open-domain table and enforces single-open
 * per domain name.
 */
export class DomainFacility {
  private readonly domains = new Map<string, DomainImpl>()
  /** Names reserved by an in-flight or completed open, so concurrent opens of one name fail loud. */
  private readonly reserved = new Set<string>()
  /** Facility operations admitted before disposal; teardown waits for them. */
  private readonly admittedOperations = new Set<Promise<undefined>>()
  private disposing = false

  /**
   * @param ctx - Context of the domain plugin; open-domain effects and change
   * events attach here.
   * @param config - Validated plugin config.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
  ) {}

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
  async open<S extends DomainSpec>(spec: S): Promise<Domain<S>> {
    if (this.disposing) {
      throw new DomainError('closed', 'domain facility is disposing')
    }
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open`)
    }
    this.reserved.add(spec.name)
    const completeAdmission = this.admitOperation()
    try {
      const backendName = this.config.routes?.[spec.name] ?? this.config.backend
      const backend = this.ctx.storage.backend.get(backendName)
      if (!backend.kv) {
        throw new DomainError(
          'facet-unsupported',
          `backend '${backendName}' routed for domain '${spec.name}' has no kv facet`,
        )
      }
      const unit = await backend.kv.open(descriptorOf(spec))
      try {
        const snapshot = await unit.loadAll()
        const tables = new Map<string, Map<string, unknown>>()
        for (const [table, tableSpec] of Object.entries(spec.tables)) {
          const records = new Map<string, unknown>()
          for (const [key, raw] of Object.entries(snapshot.tables[table] ?? {})) {
            let parsed: unknown
            try {
              parsed = parseStoredDomainValue(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
            } catch (error) {
              // Backup-and-skip policy (disposable derived data): move the record's
              // document aside, log the concrete failure, and open without the
              // record. Backends that cannot move a document keep the loud path.
              if (spec.invalidRecords !== 'backup-and-skip' || unit.backupRecord === undefined) throw error
              const moved = await unit.backupRecord(table, key)
              // parseStoredDomainValue always wraps the zod failure as the cause.
              this.ctx.logger.error(
                `domain '${spec.name}': stored record '${key}' in table '${table}' failed schema validation; `
                + `moved to '${moved}' and treated as absent. Cause: ${String((error as DomainError).cause)}`,
              )
              continue
            }
            records.set(key, parsed)
          }
          tables.set(table, records)
        }
        // A null stored global means "never written": serve `initial` without
        // materializing it — the first `set` writes.
        const globalSpec = spec.global
        const globalValue = globalSpec === undefined
          ? undefined
          : snapshot.global === null
            ? globalSpec.initial
            : parseStoredDomainValue(spec.name, '', '', () => globalSpec.schema.parse(snapshot.global))
        // The onClosed hook runs strictly after teardown completes: writes
        // landing during the drain still emit domain/changed, and the domain
        // stays resolvable (the package invariant cross-checks each event)
        // until fully closed — only then does the name free up for reopening.
        const domain: DomainImpl = new DomainImpl(this.ctx, spec, unit, tables, globalValue, () => {
          this.domains.delete(spec.name)
          this.reserved.delete(spec.name)
        })
        this.domains.set(spec.name, domain)
        // The single type-erasure point: DomainImpl is the untyped runtime,
        // Domain<S> the spec-typed view; the unknown hop is required because
        // S's conditional global-handle type stays unresolved here.
        return domain as unknown as Domain<S>
      } catch (error) {
        await unit.close()
        throw error
      }
    } catch (error) {
      // Any failure means the domain never registered (nothing can throw
      // after it), so releasing the name reservation is unconditional.
      this.reserved.delete(spec.name)
      throw error
    } finally {
      completeAdmission()
    }
  }

  /**
   * Migrate one closed historical unit into a different missing target
   * backend. The domain name is reserved against ordinary open and concurrent
   * migration until every validation and committed readback phase settles.
   * @param plan - Complete retained adjacent migration chain.
   * @param options - Source/target backend names and caller cancellation.
   * @returns backend-independent migration evidence.
   */
  async migrate(
    plan: DomainMigrationPlan,
    options: DomainMigrationOptions,
  ): Promise<DomainMigrationResult> {
    assertDomainMigrationPlan(plan)
    if (this.disposing) {
      throw new DomainError('closed', 'domain facility is disposing')
    }
    if (this.reserved.has(plan.current.name)) {
      throw new DomainError('already-open', `domain '${plan.current.name}' is already open or migrating`)
    }
    this.reserved.add(plan.current.name)
    const completeAdmission = this.admitOperation()
    try {
      return await runDomainMigration(this.ctx, plan, options)
    } finally {
      this.reserved.delete(plan.current.name)
      completeAdmission()
    }
  }

  /**
   * Validate and atomically create one missing current-version domain on a
   * selected backend. The name is reserved against ordinary open and other
   * cold operations until the committed target has been read back and validated.
   * @param spec - Current domain declaration.
   * @param snapshot - Complete detached initial contents.
   * @param options - Target backend and caller cancellation.
   * @returns backend-independent materialization evidence.
   */
  async materialize(
    spec: DomainSpec,
    snapshot: KvUnitSnapshot,
    options: DomainMaterializationOptions,
  ): Promise<DomainMaterializationResult> {
    if (this.disposing) {
      throw new DomainError('closed', 'domain facility is disposing')
    }
    if (this.reserved.has(spec.name)) {
      throw new DomainError('already-open', `domain '${spec.name}' is already open or migrating`)
    }
    this.reserved.add(spec.name)
    const completeAdmission = this.admitOperation()
    try {
      return await runDomainMaterialization(this.ctx, spec, snapshot, options)
    } finally {
      this.reserved.delete(spec.name)
      completeAdmission()
    }
  }

  /**
   * Look up an open domain by name, untyped. Diagnostic surface (the package
   * invariant cross-checks change events against live domain state); typed
   * consumers hold the handle returned by {@link open}.
   * @param name - Domain name.
   * @returns the open domain runtime, or `undefined` when not open.
   */
  get(name: string): DomainImpl | undefined {
    return this.domains.get(name)
  }

  /**
   * Attempt to close every domain still open on this facility and report
   * failures only after all closes settle. The unmount path for consumers
   * that never called `Domain.close()` themselves; closing is idempotent, so
   * double-closing an already-closed domain is harmless.
   * @returns resolution after every close settles.
   */
  async closeAll(): Promise<void> {
    this.disposing = true
    await Promise.allSettled([...this.admittedOperations])
    const outcomes = await Promise.allSettled([...this.domains.values()].map(domain => domain.close()))
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason as unknown)
    }
    throwFailures(failures, 'failed to close storage domains')
  }

  private admitOperation(): () => void {
    const completion = Promise.withResolvers<undefined>()
    this.admittedOperations.add(completion.promise)
    return () => {
      this.admittedOperations.delete(completion.promise)
      completion.resolve(undefined)
    }
  }
}

/**
 * Mount the domain data form on the storage hub.
 * @param ctx - Plugin context.
 * @param config - Validated plugin config.
 * @returns resolution after an already-available backend set activates the form.
 */
export function apply(ctx: Context, config: Config): Promise<void> {
  const backendServices = [...new Set([
    config.backend,
    ...Object.values(config.routes ?? {}),
  ])].map(storageBackendServiceKey)

  const fiber = ctx.inject(backendServices, (domainCtx) => {
    const facility = new DomainFacility(domainCtx, config)
    domainCtx.effect(() => {
      const unmount = domainCtx.storage.mount('domain', facility)
      return async () => {
        const failures: unknown[] = []
        try {
          await facility.closeAll()
        } catch (error) {
          failures.push(error)
        }
        try {
          unmount()
        } catch (error) {
          failures.push(error)
        }
        throwFailures(failures, 'failed to close and unmount the domain facility')
      }
    })
    domainCtx.provide('storageDomain', facility)
  })
  return Promise.resolve(fiber).then(() => {})
}

function throwFailures(failures: readonly unknown[], message: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, message)
}
