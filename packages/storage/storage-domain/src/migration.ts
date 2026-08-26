/** Validated adjacent forward migrations for detached domain snapshots. @module @deepseek-ai/dsh-storage-domain/src/migration */

import type { Context } from '@deepseek-ai/cordis'
import {
  cloneLosslessJsonValue,
  isPlainJsonObject,
  StorageError,
} from '@deepseek-ai/dsh-storage'
import type { KvClosedUnitLease, KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { DomainError, parseStoredDomainValue } from './error.ts'
import { descriptorOf } from './spec.ts'
import type { DomainSpec } from './spec.ts'

const migrationPlanIdentity: unique symbol = Symbol('dsh.storageDomain.migrationPlan')
const registeredMigrationPlans = new WeakSet<object>()

/** Deeply read-only detached input supplied to one migration step. */
export interface DomainMigrationSnapshot {
  /** Read-only record maps grouped by their declared table names. */
  readonly tables: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  /** Stored global singleton, or the `null` never-written sentinel. */
  readonly global: unknown
}

/** One deterministic adjacent transformation and both of its validation specs. */
export interface DomainMigrationStep {
  /** Exact historical schema accepted by this step. */
  readonly from: DomainSpec
  /** Exact adjacent schema produced by this step. */
  readonly to: DomainSpec
  /**
   * Transform a deeply frozen, JSON-compatible snapshot without external
   * effects. The returned complete snapshot is validated against {@link to}
   * before another step can observe it.
   * @param snapshot - Validated detached source data.
   * @returns the complete adjacent-version snapshot.
   */
  readonly migrate: (snapshot: DomainMigrationSnapshot) => KvUnitSnapshot
}

/** Complete retained chain ending at one current domain spec. */
export interface DomainMigrationPlan<S extends DomainSpec = DomainSpec> {
  /** Module-private identity proving construction by {@link defineDomainMigrations}. */
  readonly [migrationPlanIdentity]: true
  /** Current schema that a successful migration materializes and reads back. */
  readonly current: S
  /** Ordered, contiguous retained steps from the oldest supported source. */
  readonly steps: readonly DomainMigrationStep[]
}

/** Input accepted by {@link defineDomainMigrations}. */
export interface DomainMigrationPlanInput<S extends DomainSpec> {
  /** Current domain schema. */
  readonly current: S
  /** Retained adjacent steps; their final target must be `current`. */
  readonly steps: readonly DomainMigrationStep[]
}

/** Cold source and missing target selected for one migration. */
export interface DomainMigrationOptions {
  /** Registered backend holding the closed historical unit. */
  readonly sourceBackend: string
  /** Different registered backend that must not yet hold the target unit. */
  readonly targetBackend: string
  /** Caller cancellation through target publication; later readback preserves commit evidence. */
  readonly signal: AbortSignal
}

/** Successful migration evidence, without backend-specific rows. */
export interface DomainMigrationResult {
  /** Migrated domain name. */
  readonly domain: string
  /** Stored version read and validated at the source. */
  readonly sourceVersion: number
  /** Current version materialized and read back from the target. */
  readonly targetVersion: number
  /** Adjacent steps applied in order. */
  readonly steps: readonly { readonly from: number; readonly to: number }[]
}

/** Missing target selected for one validated cold materialization. */
export interface DomainMaterializationOptions {
  /** Registered backend that must not yet hold the domain unit. */
  readonly targetBackend: string
  /**
   * Caller cancellation before target publication. Once publication commits,
   * committed readback validation finishes even if the signal aborts.
   */
  readonly signal: AbortSignal
}

/** Successful cold materialization evidence. */
export interface DomainMaterializationResult {
  /** Materialized domain name. */
  readonly domain: string
  /** Materialized and read-back domain version. */
  readonly version: number
}

/**
 * Declare and validate one retained forward chain at module load. Versions
 * must be contiguous `N -> N+1` steps over the same domain, intermediate
 * target/source specs must be the same declarations, and the final target
 * must be the exact current spec.
 * @param input - Current spec and retained adjacent transformations.
 * @returns an immutable migration plan.
 */
export function defineDomainMigrations<S extends DomainSpec>(
  input: DomainMigrationPlanInput<S>,
): DomainMigrationPlan<S> {
  if (input.steps.length === 0) {
    throw new Error(`domain '${input.current.name}' migration plan must retain at least one source version`)
  }
  const steps = [...input.steps]
  for (const [index, step] of steps.entries()) {
    if (step.from.name !== input.current.name || step.to.name !== input.current.name) {
      throw new Error(`domain '${input.current.name}' migration step ${step.from.version} -> ${step.to.version} names another domain`)
    }
    if (step.to.version !== step.from.version + 1) {
      throw new Error(`domain '${input.current.name}' migration ${step.from.version} -> ${step.to.version} must be adjacent`)
    }
    const previous = steps[index - 1]
    if (previous !== undefined && previous.to !== step.from) {
      throw new Error(
        `domain '${input.current.name}' migration chain has a gap or a different schema declaration at version ${step.from.version}`,
      )
    }
  }
  const final = steps.reduce((_previous, step) => step)
  if (final.to !== input.current) {
    throw new Error(`domain '${input.current.name}' migration chain must end at current version ${input.current.version}`)
  }
  const specSnapshots = new Map<DomainSpec, DomainSpec>()
  const snapshotSpec = <T extends DomainSpec>(spec: T): T => {
    const existing = specSnapshots.get(spec)
    if (existing !== undefined) return existing as T
    const tables = Object.freeze(Object.fromEntries(Object.entries(spec.tables).map(([name, table]) => [
      name,
      Object.freeze({ ...table }),
    ])))
    const snapshot = Object.freeze({
      ...spec,
      tables,
      ...(spec.global === undefined ? {} : { global: Object.freeze({ ...spec.global }) }),
    }) as T
    specSnapshots.set(spec, snapshot)
    return snapshot
  }
  const plan = Object.freeze({
    [migrationPlanIdentity]: true as const,
    current: snapshotSpec(input.current),
    steps: Object.freeze(steps.map(step => Object.freeze({
      ...step,
      from: snapshotSpec(step.from),
      to: snapshotSpec(step.to),
    }))),
  })
  registeredMigrationPlans.add(plan)
  return plan
}

/**
 * Reject a structurally forged plan that bypassed {@link defineDomainMigrations}.
 * @param plan - Candidate migration plan.
 */
export function assertDomainMigrationPlan(plan: DomainMigrationPlan): void {
  if (!registeredMigrationPlans.has(plan)) {
    throw new DomainError(
      'migration-plan',
      'domain migration plans must be created by defineDomainMigrations',
    )
  }
}

/**
 * Run one cold migration between registered backends. The caller owns
 * facility-level name reservation; this function owns backend resolution,
 * historical validation, pure step execution, target materialization, and
 * committed current-spec readback validation.
 * @param ctx - Storage-owning Cordis context.
 * @param plan - Validated retained chain.
 * @param options - Closed source, missing target, and cancellation.
 * @returns structured successful migration evidence.
 */
export async function runDomainMigration(
  ctx: Context,
  plan: DomainMigrationPlan,
  options: DomainMigrationOptions,
): Promise<DomainMigrationResult> {
  assertDomainMigrationPlan(plan)
  options.signal.throwIfAborted()
  if (options.sourceBackend === options.targetBackend) {
    throw new DomainError('migration-unsupported', 'domain migration requires different source and target backends')
  }
  const source = ctx.storage.backend.get(options.sourceBackend)
  const target = ctx.storage.backend.get(options.targetBackend)
  if (source === target) {
    throw new DomainError('migration-unsupported', 'domain migration requires different source and target media')
  }
  const sourceClosed = source.kv?.closed
  const targetClosed = target.kv?.closed
  if (sourceClosed === undefined) {
    throw new DomainError(
      'migration-unsupported',
      `backend '${options.sourceBackend}' does not support closed KV operations`,
    )
  }
  if (targetClosed === undefined) {
    throw new DomainError(
      'migration-unsupported',
      `backend '${options.targetBackend}' does not support closed KV operations`,
    )
  }

  return await sourceClosed.withReservedUnit(plan.current.name, options.signal, sourceLease =>
    targetClosed.withReservedUnit(plan.current.name, options.signal, async (targetLease) => {
      if (await targetLease.inspect() !== undefined) {
        throw new StorageError(
          'target-exists',
          `domain '${plan.current.name}' target already exists on backend '${options.targetBackend}'`,
        )
      }
      return await migrateReserved(plan, options, sourceLease, targetLease)
    }))
}

async function migrateReserved(
  plan: DomainMigrationPlan,
  options: DomainMigrationOptions,
  source: KvClosedUnitLease,
  target: KvClosedUnitLease,
): Promise<DomainMigrationResult> {
  const inspection = await source.inspect()
  if (inspection === undefined) {
    throw new DomainError(
      'migration-source-missing',
      `domain '${plan.current.name}' has no source unit on backend '${options.sourceBackend}'`,
    )
  }
  if (inspection.version > plan.current.version) {
    throw new DomainError(
      'migration-version',
      `domain '${plan.current.name}' stored version ${inspection.version} is newer than current version ${plan.current.version}`,
    )
  }
  const firstStep = plan.steps.find(step => step.from.version === inspection.version)
  if (firstStep === undefined) {
    const reason = inspection.version === plan.current.version
      ? 'is already current and has no forward migration to run'
      : 'is older than the retained migration chain'
    throw new DomainError(
      'migration-version',
      `domain '${plan.current.name}' stored version ${inspection.version} ${reason}`,
    )
  }
  const expectedGlobal = firstStep.from.global !== undefined
  if (inspection.hasGlobal !== expectedGlobal) {
    throw new DomainError(
      'migration-layout',
      `domain '${plan.current.name}' stored source global layout does not match version ${inspection.version}`,
    )
  }
  assertTableSet(plan.current.name, firstStep.from, inspection.tables, 'stored source')

  let snapshot = validateSnapshot(
    firstStep.from,
    await source.read(descriptorOf(firstStep.from)),
    'stored source',
  )
  const applied: Array<{ from: number; to: number }> = []
  const start = plan.steps.indexOf(firstStep)
  for (const step of plan.steps.slice(start)) {
    options.signal.throwIfAborted()
    let output: KvUnitSnapshot
    try {
      output = step.migrate(deepFreeze(cloneSnapshot(snapshot, plan.current.name, 'migration input')))
    } catch (error) {
      throw new DomainError(
        'migration-step',
        `domain '${plan.current.name}' migration ${step.from.version} -> ${step.to.version} failed`,
        { cause: error },
      )
    }
    options.signal.throwIfAborted()
    snapshot = validateSnapshot(step.to, output, `migration output at version ${step.to.version}`)
    applied.push({ from: step.from.version, to: step.to.version })
  }

  options.signal.throwIfAborted()
  await materializeTarget(target, plan.current, snapshot)
  return {
    domain: plan.current.name,
    sourceVersion: inspection.version,
    targetVersion: plan.current.version,
    steps: applied,
  }
}

/**
 * Validate and atomically materialize one complete current-version domain on
 * a missing target, then read it back through the reserved closed path.
 * @param ctx - Storage-owning Cordis context.
 * @param spec - Current schema for the new unit.
 * @param snapshot - Complete detached initial contents.
 * @param options - Missing target backend and caller cancellation.
 * @returns structured successful materialization evidence.
 */
export async function runDomainMaterialization(
  ctx: Context,
  spec: DomainSpec,
  snapshot: KvUnitSnapshot,
  options: DomainMaterializationOptions,
): Promise<DomainMaterializationResult> {
  options.signal.throwIfAborted()
  const target = ctx.storage.backend.get(options.targetBackend)
  const targetClosed = target.kv?.closed
  if (targetClosed === undefined) {
    throw new DomainError(
      'migration-unsupported',
      `backend '${options.targetBackend}' does not support closed KV operations`,
    )
  }
  const validated = validateSnapshot(spec, snapshot, 'materialization input')
  return await targetClosed.withReservedUnit(spec.name, options.signal, async (lease) => {
    if (await lease.inspect() !== undefined) {
      throw new StorageError(
        'target-exists',
        `domain '${spec.name}' target already exists on backend '${options.targetBackend}'`,
      )
    }
    await materializeTarget(lease, spec, validated)
    return { domain: spec.name, version: spec.version }
  })
}

async function materializeTarget(
  target: KvClosedUnitLease,
  spec: DomainSpec,
  snapshot: KvUnitSnapshot,
): Promise<void> {
  const materialization = await target.materializeMissing(descriptorOf(spec), snapshot)
  if (materialization.outcome === 'uncertain') {
    let visible: KvUnitSnapshot | undefined
    try {
      visible = await materialization.readBack()
    } catch (error) {
      throw new DomainError(
        'migration-target-outcome-unknown',
        `domain '${spec.name}' target commit outcome could not be determined by readback`,
        { cause: new AggregateError([materialization.cause, error], 'materialization and readback both failed') },
      )
    }
    if (visible === undefined) {
      throw new DomainError(
        'migration-target-not-committed',
        `domain '${spec.name}' target was absent after an uncertain materialization outcome`,
        { cause: materialization.cause },
      )
    }
    validateMaterializedTarget(spec, snapshot, visible)
    throw new DomainError(
      'migration-target-durability-uncertain',
      `domain '${spec.name}' target is visible and exact, but commit durability is uncertain`,
      { cause: materialization.cause, committed: true },
    )
  }

  let visible: KvUnitSnapshot
  try {
    visible = await materialization.readBack()
  } catch (error) {
    throw targetInvalid(spec.name, error)
  }
  validateMaterializedTarget(spec, snapshot, visible)
}

function validateMaterializedTarget(
  spec: DomainSpec,
  snapshot: KvUnitSnapshot,
  visible: KvUnitSnapshot,
): void {
  const exact = equalJson(snapshot, visible)
  try {
    validateSnapshot(spec, visible, 'materialized target')
  } catch (error) {
    throw targetInvalid(spec.name, error)
  }
  if (!exact) {
    throw targetInvalid(
      spec.name,
      new Error(`domain '${spec.name}' materialized target differs from the requested snapshot`),
    )
  }
}

function targetInvalid(domain: string, error: unknown): DomainError {
  const detail = error instanceof DomainError ? error.detail : undefined
  return new DomainError(
    'migration-target-invalid',
    `domain '${domain}' target committed but failed exact current-version readback validation`,
    { cause: error, committed: true, ...(detail === undefined ? {} : { detail }) },
  )
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]))
  }
  if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) return false
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

function validateSnapshot(spec: DomainSpec, value: unknown, stage: string): KvUnitSnapshot {
  const snapshot = cloneSnapshot(value, spec.name, stage)
  assertTableSet(spec.name, spec, Object.keys(snapshot.tables), stage)
  let global = snapshot.global
  const globalSpec = spec.global
  if (globalSpec === undefined) {
    if (global !== null) {
      throw new DomainError('migration-layout', `domain '${spec.name}' ${stage} has an undeclared global value`)
    }
  } else if (global !== null) {
    global = parseStoredDomainValue(spec.name, '', '', () => globalSpec.schema.parse(global))
  }
  for (const [table, tableSpec] of Object.entries(spec.tables)) {
    const records = snapshot.tables[table] as Record<string, unknown>
    for (const [key, raw] of Object.entries(records)) {
      records[key] = parseStoredDomainValue(spec.name, table, key, () => tableSpec.valueSchema.parse(raw))
    }
  }
  return cloneSnapshot({ tables: snapshot.tables, global }, spec.name, stage)
}

function assertTableSet(
  domain: string,
  spec: DomainSpec,
  actual: readonly string[],
  stage: string,
): void {
  const expected = Object.keys(spec.tables).sort()
  const sortedActual = [...actual].sort()
  if (expected.length !== sortedActual.length
    || expected.some((table, index) => table !== sortedActual[index])) {
    throw new DomainError(
      'migration-layout',
      `domain '${domain}' ${stage} tables [${sortedActual.join(', ')}] do not match version ${spec.version} [${expected.join(', ')}]`,
    )
  }
}

function cloneSnapshot(value: unknown, domain: string, stage: string): KvUnitSnapshot {
  let owned: unknown
  try {
    owned = cloneLosslessJsonValue(value, `domain '${domain}' ${stage}`)
  } catch (error) {
    throw new DomainError(
      'migration-layout',
      `domain '${domain}' ${stage} is not lossless JSON data`,
      { cause: error },
    )
  }
  if (!isPlainJsonObject(owned) || !Object.hasOwn(owned, 'tables') || !Object.hasOwn(owned, 'global')) {
    throw new DomainError('migration-layout', `domain '${domain}' ${stage} is not a complete snapshot`)
  }
  const tablesValue = owned['tables']
  if (!isPlainJsonObject(tablesValue)) {
    throw new DomainError('migration-layout', `domain '${domain}' ${stage} tables are not an object`)
  }
  const tables: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>
  for (const [table, recordsValue] of Object.entries(tablesValue)) {
    if (!isPlainJsonObject(recordsValue)) {
      throw new DomainError('migration-layout', `domain '${domain}' ${stage} table '${table}' is not an object`)
    }
    const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, record] of Object.entries(recordsValue)) {
      records[key] = record
    }
    tables[table] = records
  }
  return {
    tables,
    global: owned['global'],
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}
