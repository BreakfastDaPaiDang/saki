/** Exact SQLite database and sidecar evidence for backup and source immutability. */

import { open } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { SakiMaintenanceError } from './error.ts'
import { readStableRegularFileEvidence } from './stable-files.ts'
import type { StableRegularFileFailures } from './stable-files.ts'

/** Physical files that may contribute to one closed SQLite state. */
export type SqliteArtifactRole = 'database' | 'wal' | 'shm' | 'journal'

const ARTIFACTS = Object.freeze([
  { role: 'database', suffix: '' },
  { role: 'wal', suffix: '-wal' },
  { role: 'shm', suffix: '-shm' },
  { role: 'journal', suffix: '-journal' },
] as const)

/** Stable identity and exact content evidence for one regular file. */
export interface FileEvidence {
  /** Absolute file path observed. */
  readonly path: string
  /** Exact byte length. */
  readonly byteLength: number
  /** Lowercase SHA-256 of the exact bytes. */
  readonly sha256: string
  /** Filesystem device identity when supplied by the platform. */
  readonly device: bigint
  /** Filesystem inode identity when supplied by the platform. */
  readonly inode: bigint
  /** Nanosecond modification time. */
  readonly modifiedNs: bigint
  /** Nanosecond metadata-change time. */
  readonly changedNs: bigint
}

/** One database or sidecar in a frozen SQLite artifact set. */
export interface SqliteArtifactEvidence extends FileEvidence {
  /** Semantic artifact role. */
  readonly role: SqliteArtifactRole
  /** Exact suffix relative to the database path. */
  readonly suffix: '' | '-wal' | '-shm' | '-journal'
}

/** Complete observed physical state for one SQLite database path. */
export interface SqliteArtifactSet {
  /** Absolute main database path. */
  readonly databasePath: string
  /** Main database plus every sidecar that existed during the stable observation. */
  readonly artifacts: readonly SqliteArtifactEvidence[]
}

const sqliteArtifactFailures = Object.freeze({
  invalid(path, reason) {
    if (reason === 'not-regular') {
      return new SakiMaintenanceError('recovery-required', `SQLite artifact '${path}' is not a regular file`)
    }
    const phase = reason === 'changed-opening' ? 'opening' : 'hashing'
    return new SakiMaintenanceError('source-changed', `SQLite artifact '${path}' changed while ${phase}`)
  },
} satisfies StableRegularFileFailures)

async function readRegularFileEvidence(path: string, signal: AbortSignal): Promise<FileEvidence> {
  return {
    path,
    ...await readStableRegularFileEvidence(path, signal, sqliteArtifactFailures),
  }
}

async function optionalEvidence(path: string, signal: AbortSignal): Promise<FileEvidence | undefined> {
  const evidence = await readStableRegularFileEvidence(path, signal, sqliteArtifactFailures, true)
  return evidence === undefined ? undefined : { path, ...evidence }
}

/**
 * Capture the main SQLite database and every extant WAL/SHM/rollback-journal sidecar.
 * Two complete passes must agree so a sidecar appearance or disappearance cannot be omitted.
 * @param databasePath - exact source database selected by manifest or legacy config.
 * @param signal - caller cancellation throughout reads and hashes.
 * @returns stable exact artifact evidence without opening SQLite.
 */
export async function captureSqliteArtifactSet(
  databasePath: string,
  signal: AbortSignal,
): Promise<SqliteArtifactSet> {
  const once = async (): Promise<SqliteArtifactEvidence[]> => {
    const values: SqliteArtifactEvidence[] = []
    for (const artifact of ARTIFACTS) {
      const evidence = await optionalEvidence(`${databasePath}${artifact.suffix}`, signal)
      if (evidence !== undefined) values.push({ ...evidence, ...artifact })
    }
    if (values[0]?.role !== 'database') {
      if (values.length > 0) {
        throw new SakiMaintenanceError(
          'recovery-required',
          `SQLite source '${databasePath}' is missing while sidecars remain`,
        )
      }
      throw Object.assign(new Error(`SQLite source '${databasePath}' does not exist`), { code: 'ENOENT' })
    }
    return values
  }
  const first = await once()
  const second = await once()
  if (!sameArtifactLists(first, second)) {
    throw new SakiMaintenanceError('source-changed', `SQLite source '${databasePath}' changed during observation`)
  }
  return { databasePath, artifacts: Object.freeze(second) }
}

function sameArtifactLists(
  left: readonly SqliteArtifactEvidence[],
  right: readonly SqliteArtifactEvidence[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const candidate = right[index]
    return candidate !== undefined
      && value.role === candidate.role
      && value.suffix === candidate.suffix
      && value.path === candidate.path
      && value.byteLength === candidate.byteLength
      && value.sha256 === candidate.sha256
      && value.device === candidate.device
      && value.inode === candidate.inode
      && value.modifiedNs === candidate.modifiedNs
      && value.changedNs === candidate.changedNs
  })
}

/**
 * Prove a previously captured source still has the same files, identities, lengths, and bytes.
 * @param expected - prior source evidence retained by the operation journal.
 * @param signal - caller cancellation during the fresh observation.
 */
export async function assertSqliteArtifactSetUnchanged(
  expected: SqliteArtifactSet,
  signal: AbortSignal,
): Promise<void> {
  let actual: SqliteArtifactSet
  try {
    actual = await captureSqliteArtifactSet(expected.databasePath, signal)
  } catch (error) {
    if (error instanceof SakiMaintenanceError && error.code === 'source-changed') throw error
    throw new SakiMaintenanceError(
      'source-changed',
      `SQLite source '${expected.databasePath}' no longer matches its captured artifact set`,
      { cause: error },
    )
  }
  if (!sameArtifactLists(expected.artifacts, actual.artifacts)) {
    throw new SakiMaintenanceError(
      'source-changed',
      `SQLite source '${expected.databasePath}' changed after its captured artifact set`,
    )
  }
}

async function copyOne(
  source: SqliteArtifactEvidence,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const sourceHandle = await open(source.path, 'r')
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined
  let operationFailure: unknown
  try {
    targetHandle = await open(targetPath, 'wx', 0o600)
    const buffer = Buffer.allocUnsafe(64 * 1_024)
    let offset = 0
    for (;;) {
      signal.throwIfAborted()
      const result = await sourceHandle.read(buffer, 0, buffer.byteLength, offset)
      if (result.bytesRead === 0) break
      await targetHandle.write(buffer.subarray(0, result.bytesRead), 0, result.bytesRead, offset)
      offset += result.bytesRead
    }
    await targetHandle.sync()
  } catch (error) {
    operationFailure = error
  }
  const closeResults = await Promise.allSettled([
    sourceHandle.close(),
    targetHandle?.close() ?? Promise.resolve(),
  ])
  const failures: unknown[] = []
  for (const result of closeResults) {
    if (result.status === 'rejected') failures.push(result.reason as unknown)
  }
  if (operationFailure !== undefined) failures.unshift(operationFailure)
  if (failures.length > 1) {
    throw new AggregateError(failures, `copying SQLite artifact '${source.path}' and closing its files failed`)
  }
  if (failures.length === 1) throw failures[0]
  const copied = await readRegularFileEvidence(targetPath, signal)
  if (copied.byteLength !== source.byteLength || copied.sha256 !== source.sha256) {
    throw new SakiMaintenanceError('source-changed', `copied SQLite artifact '${targetPath}' failed verification`)
  }
}

/**
 * Copy one captured SQLite artifact set into a missing private directory and verify every byte.
 * The caller owns destination reservation and cleanup; this function never replaces a file.
 * @param source - stable source evidence.
 * @param targetDatabasePath - missing database path whose sidecars use the same suffixes.
 * @param signal - caller cancellation before every target file commit.
 * @returns exact copied artifact evidence.
 */
export async function copySqliteArtifactSet(
  source: SqliteArtifactSet,
  targetDatabasePath: string,
  signal: AbortSignal,
): Promise<SqliteArtifactSet> {
  if (basename(source.databasePath) !== basename(targetDatabasePath)) {
    throw new Error('SQLite artifact copy requires the same database leaf for sidecar compatibility')
  }
  if (dirname(source.databasePath) === dirname(targetDatabasePath)) {
    throw new Error('SQLite artifact copy target must use a different directory')
  }
  for (const artifact of source.artifacts) {
    await copyOne(artifact, `${targetDatabasePath}${artifact.suffix}`, signal)
  }
  const copied = await captureSqliteArtifactSet(targetDatabasePath, signal)
  if (copied.artifacts.length !== source.artifacts.length
    || copied.artifacts.some((value, index) => {
      const expected = source.artifacts[index]
      return expected === undefined
        || value.role !== expected.role
        || value.byteLength !== expected.byteLength
        || value.sha256 !== expected.sha256
    })) {
    throw new SakiMaintenanceError('source-changed', `copied SQLite artifact set at '${targetDatabasePath}' diverged`)
  }
  await assertSqliteArtifactSetUnchanged(source, signal)
  return copied
}

/**
 * Derive the copied database path while retaining its sidecar-compatible leaf.
 * @param directory - reserved destination directory.
 * @param sourceDatabasePath - source database whose basename is retained.
 * @returns the fixed target path for one source database and its sidecars.
 */
export function copiedDatabasePath(directory: string, sourceDatabasePath: string): string {
  return join(directory, basename(sourceDatabasePath))
}
