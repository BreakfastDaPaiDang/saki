/**
 * Strict argument parsing and command dispatch for offline Saki maintenance.
 * @module @breakfastdapaidang/saki-installation-maintenance/cli
 */

import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { SakiStorageGenerationId } from '@breakfastdapaidang/saki-control-plane'
import { SakiMaintenanceError } from './error.ts'
import { sakiRecoveryBackupIdSchema } from './journal.ts'
import type { SakiRecoveryBackupId } from './journal.ts'
import type {
  SakiMaintenanceOperations,
  SakiMaintenanceOptions,
} from './maintenance-operations.ts'
import { CURRENT_SAKI_BUILD_ID, LEGACY_B03_BUILD_ID } from './release.ts'

interface CommandBase {
  /** Exact Installation paths and fixed build provenance. */
  readonly options: SakiMaintenanceOptions
}

/** A validated maintenance command ready for the lease-owning operations module. */
export type SakiMaintenanceCliCommand =
  | CommandBase & { readonly kind: 'backup' }
  | CommandBase & { readonly kind: 'verify'; readonly backupId: SakiRecoveryBackupId }
  | CommandBase & { readonly kind: 'upgrade' }

/** Path-free machine-readable success emitted by the maintenance executable. */
export type SakiMaintenanceCliSuccess =
  | {
    readonly ok: true
    readonly command: 'backup' | 'verify'
    readonly backupId: SakiRecoveryBackupId
    readonly stateVersion: 2 | 3 | 4 | 5 | 6 | 7
  }
  | {
    readonly ok: true
    readonly command: 'upgrade'
    readonly backupId: SakiRecoveryBackupId
    readonly storageGenerationId: SakiStorageGenerationId
    readonly sourceVersion: 2 | 3 | 4 | 5 | 6
    readonly targetVersion: 7
  }

/** Machine-readable CLI completion with its required process destination and exit code. */
export type SakiMaintenanceCliOutcome =
  | { readonly exitCode: 0; readonly stream: 'stdout'; readonly value: SakiMaintenanceCliSuccess }
  | {
    readonly exitCode: 2
    readonly stream: 'stderr'
    readonly value: { readonly ok: false; readonly error: 'usage'; readonly usage: string }
  }
  | {
    readonly exitCode: 1
    readonly stream: 'stderr'
    readonly value:
      | { readonly ok: false; readonly error: 'operation-failed' }
      | {
        readonly ok: false
        readonly command: SakiMaintenanceCliCommand['kind']
        readonly error: 'aborted' | 'operation-failed' | SakiMaintenanceError['code']
      }
  }

/** Command usage written for invalid arguments. */
export const SAKI_MAINTENANCE_USAGE = 'Usage: saki-maintenance (backup | verify <backup-id> | upgrade) [--installation-root <absolute-path>] [--legacy-database <absolute-path>]'

/** Invalid command-line input, distinct from a failed maintenance operation. */
export class SakiMaintenanceCliUsageError extends Error {
  constructor() {
    super('invalid Saki maintenance command line')
    this.name = 'SakiMaintenanceCliUsageError'
  }
}

const CLI_OPTIONS = {
  'installation-root': { type: 'string' },
  'legacy-database': { type: 'string' },
} as const

function usageError(): never {
  throw new SakiMaintenanceCliUsageError()
}

function absolutePath(value: string): string {
  if (!isAbsolute(value)) return usageError()
  return resolve(value)
}

function parseTokens(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: CLI_OPTIONS,
      strict: true,
      allowPositionals: true,
      tokens: true,
    })
  } catch {
    return usageError()
  }
}

/**
 * Parse a maintenance command without touching Installation state.
 * @param argv - arguments after the executable name.
 * @param environment - immutable environment used for path defaults.
 * @returns validated command and lease-owning operation options.
 */
export function parseSakiMaintenanceCliArgs(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): SakiMaintenanceCliCommand {
  const { positionals, tokens, values } = parseTokens(argv)
  const seen = new Set<string>()
  for (const token of tokens) {
    if (token.kind !== 'option') continue
    if (seen.has(token.name)) return usageError()
    seen.add(token.name)
  }

  const installationRoot = values['installation-root'] === undefined
    ? join(resolveDshHome(undefined, environment), 'saki')
    : absolutePath(values['installation-root'])
  const legacyDatabasePath = absolutePath(
    values['legacy-database']
      ?? environment.SAKI_DATABASE_PATH
      ?? join(installationRoot, 'control.sqlite'),
  )
  const options: SakiMaintenanceOptions = {
    installationRoot,
    legacyDatabasePath,
    currentBuildId: CURRENT_SAKI_BUILD_ID,
    legacyBuildId: LEGACY_B03_BUILD_ID,
  }

  if (positionals.length === 1 && positionals[0] === 'backup') return { kind: 'backup', options }
  if (positionals.length === 1 && positionals[0] === 'upgrade') return { kind: 'upgrade', options }
  if (positionals.length === 2 && positionals[0] === 'verify') {
    const parsed = sakiRecoveryBackupIdSchema.safeParse(positionals[1])
    if (parsed.success) return { kind: 'verify', backupId: parsed.data, options }
  }
  return usageError()
}

/**
 * Run one parsed command through the shared lease-owning maintenance operations.
 * @param command - strictly parsed command and resolved paths.
 * @param operations - common maintenance implementation used by all commands.
 * @param signal - caller cancellation retained through operation completion.
 * @returns path-free data suitable for one-line JSON output.
 */
export async function executeSakiMaintenanceCliCommand(
  command: SakiMaintenanceCliCommand,
  operations: SakiMaintenanceOperations,
  signal: AbortSignal,
): Promise<SakiMaintenanceCliSuccess> {
  switch (command.kind) {
    case 'backup': {
      const result = await operations.backup(command.options, signal)
      return {
        ok: true,
        command: 'backup',
        backupId: result.manifest.backupId,
        stateVersion: result.manifest.stateVersion,
      }
    }
    case 'verify': {
      const result = await operations.verify(command.options, command.backupId, signal)
      return {
        ok: true,
        command: 'verify',
        backupId: result.manifest.backupId,
        stateVersion: result.manifest.stateVersion,
      }
    }
    case 'upgrade': {
      const result = await operations.upgrade(command.options, signal)
      return {
        ok: true,
        command: 'upgrade',
        backupId: result.backup.manifest.backupId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        sourceVersion: result.sourceVersion,
        targetVersion: result.targetVersion,
      }
    }
    /* v8 ignore next -- SakiMaintenanceCliCommand is a closed same-process union. */
    default: return assertNever(command)
  }
}

/**
 * Parse and run one command while converting every completion into one safe JSON value.
 * @param argv - arguments after the executable name.
 * @param environment - immutable environment used for path defaults.
 * @param operations - common lease-owning maintenance implementation.
 * @param signal - process-lifetime cancellation.
 * @returns output destination, exact exit code, and a value containing no filesystem paths.
 */
export async function runSakiMaintenanceCli(
  argv: readonly string[],
  environment: NodeJS.ProcessEnv,
  operations: SakiMaintenanceOperations,
  signal: AbortSignal,
): Promise<SakiMaintenanceCliOutcome> {
  let command: SakiMaintenanceCliCommand
  try {
    command = parseSakiMaintenanceCliArgs(argv, environment)
  } catch (error) {
    if (error instanceof SakiMaintenanceCliUsageError) {
      return {
        exitCode: 2,
        stream: 'stderr',
        value: { ok: false, error: 'usage', usage: SAKI_MAINTENANCE_USAGE },
      }
    }
    return {
      exitCode: 1,
      stream: 'stderr',
      value: { ok: false, error: 'operation-failed' },
    }
  }

  try {
    return {
      exitCode: 0,
      stream: 'stdout',
      value: await executeSakiMaintenanceCliCommand(command, operations, signal),
    }
  } catch (error) {
    return {
      exitCode: 1,
      stream: 'stderr',
      value: {
        ok: false,
        command: command.kind,
        error: signal.aborted
          ? 'aborted'
          : error instanceof SakiMaintenanceError
            ? error.code
            : 'operation-failed',
      },
    }
  }
}

/* v8 ignore start -- SakiMaintenanceCliCommand is a closed same-process union. */
function assertNever(command: never): never {
  throw new Error(`unsupported Saki maintenance command '${JSON.stringify(command)}'`)
}
/* v8 ignore stop */
