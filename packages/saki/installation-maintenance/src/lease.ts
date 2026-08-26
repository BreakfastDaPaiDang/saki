/** Crash-released Installation lease backed by a dedicated SQLite database. */

import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  asError,
  isExistingPathError,
  isMissingPathError,
  SakiMaintenanceError,
} from './error.ts'

/** Fixed derived lock-database leaf; it never selects product state. */
export const INSTALLATION_LOCK_LEAF = 'installation-lock.sqlite' as const

interface DirectoryInfo {
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

/** Injectable directory-publication effects for Installation lease fault tests. */
export interface InstallationLeaseEffects {
  /** Override the Host directory durability family. */
  readonly platform?: 'posix' | 'win32'
  /** Override exact no-follow directory inspection. */
  readonly inspectDirectory?: (path: string) => Promise<DirectoryInfo>
  /** Override creation of one missing directory whose parent already exists. */
  readonly createDirectory?: (path: string) => Promise<void>
  /** Override POSIX directory synchronization. */
  readonly syncDirectory?: (path: string) => Promise<void>
}

function isBusy(error: unknown): boolean {
  const candidate = error as { readonly errcode?: unknown } | null
  return candidate?.errcode === 5
}

function unsafeDirectory(path: string, cause?: unknown): SakiMaintenanceError {
  return new SakiMaintenanceError(
    'recovery-required',
    `Saki Installation directory '${path}' is not a readable real directory`,
    cause === undefined ? undefined : { cause },
  )
}

/* v8 ignore start -- Windows cannot open directories for fsync; POSIX Hosts exercise this default effect. */
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
/* v8 ignore stop */

async function realDirectoryExists(
  path: string,
  signal: AbortSignal,
  inspect: (path: string) => Promise<DirectoryInfo>,
): Promise<boolean> {
  signal.throwIfAborted()
  let info: DirectoryInfo
  try {
    info = await inspect(path)
  } catch (error) {
    if (isMissingPathError(error)) return false
    throw unsafeDirectory(path, error)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeDirectory(path)
  return true
}

async function syncDirectoryCheckpoint(
  path: string,
  signal: AbortSignal,
  effects: InstallationLeaseEffects,
): Promise<void> {
  /* v8 ignore next -- process.platform is Host-invariant; injected effects cover both families. */
  const platform = effects.platform ?? (process.platform === 'win32' ? 'win32' : 'posix')
  const sync = effects.syncDirectory ?? syncDirectory
  if (platform === 'win32') return
  try {
    signal.throwIfAborted()
    await sync(path)
    signal.throwIfAborted()
    await sync(dirname(path))
    signal.throwIfAborted()
  } catch (error) {
    signal.throwIfAborted()
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki Installation directory '${path}' is visible but its namespace durability is uncertain`,
      { cause: error },
    )
  }
}

async function ensureInstallationRoot(
  installationRoot: string,
  signal: AbortSignal,
  effects: InstallationLeaseEffects,
): Promise<void> {
  const inspect = effects.inspectDirectory ?? lstat
  const create = effects.createDirectory ?? (async (path) => {
    await mkdir(path, { mode: 0o700 })
  })
  const missing: string[] = []
  let checkpoint = installationRoot
  while (!await realDirectoryExists(checkpoint, signal, inspect)) {
    missing.push(checkpoint)
    const parent = dirname(checkpoint)
    if (parent === checkpoint) {
      throw unsafeDirectory(checkpoint, new Error('filesystem root is missing'))
    }
    checkpoint = parent
  }
  await syncDirectoryCheckpoint(checkpoint, signal, effects)
  for (const path of missing.reverse()) {
    signal.throwIfAborted()
    try {
      await create(path)
    } catch (error) {
      if (!isExistingPathError(error)) throw error
    }
    if (!await realDirectoryExists(path, signal, inspect)) {
      throw unsafeDirectory(path, new Error('directory is missing after creation'))
    }
    await syncDirectoryCheckpoint(path, signal, effects)
  }
}

function releaseLease(database: DatabaseSync): void {
  const failures: unknown[] = []
  try {
    database.exec('ROLLBACK')
  } catch (error) {
    failures.push(error)
  }
  try {
    database.close()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'failed to release Saki Installation lease')
}

/**
 * Hold the one Installation-scoped lease around a complete serving or maintenance lifetime.
 * The dedicated SQLite connection owns `BEGIN EXCLUSIVE`; process death lets the OS release
 * it without stale-file deletion, timestamps, or PID reuse guesses.
 * @param installationRoot - root containing the derived lock database.
 * @param signal - caller cancellation checked before filesystem and lock effects.
 * @param operation - complete serving or cold-maintenance lifetime.
 * @param effects - optional directory-publication effects for platform fault tests.
 * @returns the callback result after the lock transaction is released.
 */
export async function withInstallationLease<T>(
  installationRoot: string,
  signal: AbortSignal,
  operation: (lockDatabasePath: string) => Promise<T>,
  effects: InstallationLeaseEffects = {},
): Promise<T> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  await ensureInstallationRoot(root, signal, effects)
  signal.throwIfAborted()
  const lockDatabasePath = resolve(root, INSTALLATION_LOCK_LEAF)
  const database = new DatabaseSync(lockDatabasePath, { timeout: 0 })
  try {
    try {
      database.exec('BEGIN EXCLUSIVE')
    } catch (error) {
      if (isBusy(error)) {
        throw new SakiMaintenanceError(
          'lease-busy',
          `Saki Installation at '${root}' is already serving or under maintenance`,
          { cause: error },
        )
      }
      throw error
    }

    let outcome: T | undefined
    let operationFailure: unknown
    try {
      outcome = await operation(lockDatabasePath)
    } catch (error) {
      operationFailure = error
    }

    let releaseFailure: unknown
    try {
      releaseLease(database)
    } catch (error) {
      releaseFailure = error
    }
    if (operationFailure !== undefined && releaseFailure !== undefined) {
      throw new AggregateError(
        [operationFailure, releaseFailure],
        'Saki Installation operation and lease release both failed',
      )
    }
    if (operationFailure !== undefined) throw asError(operationFailure, 'Saki Installation operation failed')
    if (releaseFailure !== undefined) throw asError(releaseFailure, 'Saki Installation lease release failed')
    return outcome as T
  } catch (error) {
    if (database.isOpen) database.close()
    throw error
  }
}
