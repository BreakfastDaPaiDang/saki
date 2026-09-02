import { join, resolve } from 'node:path'
import {
  generationManifestSchema,
  installationManifestSchema,
  recoveryBackupManifestSchema,
} from '../src/index.ts'
import type {
  SakiMaintenanceOperations,
  VerifiedRecoveryBackup,
} from '../src/index.ts'
import { SakiMaintenanceError } from '../src/index.ts'
import {
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from '@breakfastdapaidang/saki-control-plane'
import { describe, expect, it, vi } from 'vitest'
import {
  CURRENT_SAKI_BUILD_ID,
  LEGACY_B03_BUILD_ID,
} from '../src/release.ts'
import {
  SakiMaintenanceCliUsageError,
  executeSakiMaintenanceCliCommand,
  parseSakiMaintenanceCliArgs,
  runSakiMaintenanceCli,
} from '../src/cli.ts'

const BACKUP_ID = 'backup-11111111-1111-4111-8111-111111111111'
const INSTALLATION_ID = sakiInstallationIdSchema.parse('installation-22222222-2222-4222-8222-222222222222')
const STORAGE_GENERATION_ID = sakiStorageGenerationIdSchema.parse(
  'storage-generation-33333333-3333-4333-8333-333333333333',
)
const SHA256 = '0'.repeat(64)

function verifiedBackup(): VerifiedRecoveryBackup {
  const databasePath = resolve('hidden-backup', 'state.sqlite')
  return {
    manifest: recoveryBackupManifestSchema.parse({
      formatVersion: 1,
      purpose: 'recovery-backup',
      backupId: BACKUP_ID,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 2,
      sourceBuildId: LEGACY_B03_BUILD_ID,
      databaseLeaf: 'state.sqlite',
      artifacts: [{ role: 'database', suffix: '', byteLength: 1, sha256: SHA256 }],
    }),
    directory: resolve('hidden-backup'),
    databasePath,
    artifacts: { databasePath, artifacts: [] },
  }
}

describe('Saki maintenance CLI', () => {
  it('pins B09 creator provenance and the retained manifest-less B03 source provenance', () => {
    expect(CURRENT_SAKI_BUILD_ID).toBe('saki-build-0.1.0-b09')
    expect(LEGACY_B03_BUILD_ID).toBe('saki-build-0.1.0-b03')
  })

  it('resolves the backup command from the Harness home', () => {
    const home = resolve('cli-home')

    expect(parseSakiMaintenanceCliArgs(['backup'], { DSH_HOME: home })).toEqual({
      kind: 'backup',
      options: {
        installationRoot: join(home, 'saki'),
        legacyDatabasePath: join(home, 'saki', 'control.sqlite'),
        currentBuildId: CURRENT_SAKI_BUILD_ID,
        legacyBuildId: LEGACY_B03_BUILD_ID,
      },
    })
  })

  it('accepts explicit absolute paths and the strict verify identity', () => {
    const installationRoot = resolve('explicit-installation')
    const legacyDatabasePath = resolve('legacy', 'control.sqlite')

    expect(parseSakiMaintenanceCliArgs([
      '--installation-root', installationRoot,
      'verify', BACKUP_ID,
      `--legacy-database=${legacyDatabasePath}`,
    ], {})).toEqual({
      kind: 'verify',
      backupId: BACKUP_ID,
      options: {
        installationRoot,
        legacyDatabasePath,
        currentBuildId: CURRENT_SAKI_BUILD_ID,
        legacyBuildId: LEGACY_B03_BUILD_ID,
      },
    })
  })

  it('uses SAKI_DATABASE_PATH only as the default exact legacy source', () => {
    const home = resolve('environment-home')
    const legacyDatabasePath = resolve('environment-legacy.sqlite')

    expect(parseSakiMaintenanceCliArgs(['upgrade'], {
      DSH_HOME: home,
      SAKI_DATABASE_PATH: legacyDatabasePath,
    })).toEqual({
      kind: 'upgrade',
      options: {
        installationRoot: join(home, 'saki'),
        legacyDatabasePath,
        currentBuildId: CURRENT_SAKI_BUILD_ID,
        legacyBuildId: LEGACY_B03_BUILD_ID,
      },
    })
  })

  it('dispatches every command and returns path-free JSON values', async () => {
    const backup = verifiedBackup()
    const installation = installationManifestSchema.parse({
      formatVersion: 1,
      phase: 'ready',
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 8,
      generationJson: {
        leaf: `generations/${STORAGE_GENERATION_ID}/generation.json`,
        byteLength: 1,
        sha256: SHA256,
      },
    })
    const generation = generationManifestSchema.parse({
      formatVersion: 1,
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 8,
      createdByBuildId: CURRENT_SAKI_BUILD_ID,
      databaseLeaf: 'state.sqlite',
    })
    const operations = {
      backup: vi.fn(async () => backup),
      verify: vi.fn(async () => backup),
      upgrade: vi.fn(async () => ({
        backup,
        selected: {
          installation,
          generation,
          generationManifestPath: resolve('hidden-generation.json'),
          databasePath: resolve('hidden-generation.sqlite'),
        },
        sourceVersion: 2 as const,
        targetVersion: 8 as const,
      })),
    } satisfies SakiMaintenanceOperations
    const signal = new AbortController().signal
    const environment = { DSH_HOME: resolve('dispatch-home') }
    const backupCommand = parseSakiMaintenanceCliArgs(['backup'], environment)
    const verifyCommand = parseSakiMaintenanceCliArgs(['verify', BACKUP_ID], environment)
    const upgradeCommand = parseSakiMaintenanceCliArgs(['upgrade'], environment)

    expect(await executeSakiMaintenanceCliCommand(backupCommand, operations, signal)).toEqual({
      ok: true,
      command: 'backup',
      backupId: BACKUP_ID,
      stateVersion: 2,
    })
    expect(await executeSakiMaintenanceCliCommand(verifyCommand, operations, signal)).toEqual({
      ok: true,
      command: 'verify',
      backupId: BACKUP_ID,
      stateVersion: 2,
    })
    expect(await executeSakiMaintenanceCliCommand(upgradeCommand, operations, signal)).toEqual({
      ok: true,
      command: 'upgrade',
      backupId: BACKUP_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      sourceVersion: 2,
      targetVersion: 8,
    })
    expect(operations.backup).toHaveBeenCalledWith(backupCommand.options, signal)
    expect(operations.verify).toHaveBeenCalledWith(verifyCommand.options, BACKUP_ID, signal)
    expect(operations.upgrade).toHaveBeenCalledWith(upgradeCommand.options, signal)
  })

  it('maps success, usage, operation, unexpected, and aborted outcomes to stable exit codes', async () => {
    const backup = verifiedBackup()
    const successOperations = {
      backup: vi.fn(async () => backup),
      verify: vi.fn(async () => backup),
      upgrade: vi.fn(async (): Promise<never> => { throw new Error('unused') }),
    } satisfies SakiMaintenanceOperations
    const environment = { DSH_HOME: resolve('outcome-home') }
    const signal = new AbortController().signal

    expect(await runSakiMaintenanceCli(['backup'], environment, successOperations, signal)).toEqual({
      exitCode: 0,
      stream: 'stdout',
      value: {
        ok: true,
        command: 'backup',
        backupId: BACKUP_ID,
        stateVersion: 2,
      },
    })
    expect(await runSakiMaintenanceCli([], environment, successOperations, signal)).toEqual({
      exitCode: 2,
      stream: 'stderr',
      value: {
        ok: false,
        error: 'usage',
        usage: 'Usage: saki-maintenance (backup | verify <backup-id> | upgrade) [--installation-root <absolute-path>] [--legacy-database <absolute-path>]',
      },
    })
    const brokenEnvironment = new Proxy({}, {
      get: (): never => { throw new Error('secret-environment-value') },
    })
    const parseFailure = await runSakiMaintenanceCli(
      ['backup'],
      brokenEnvironment,
      successOperations,
      signal,
    )
    expect(parseFailure).toEqual({
      exitCode: 1,
      stream: 'stderr',
      value: { ok: false, error: 'operation-failed' },
    })
    expect(JSON.stringify(parseFailure)).not.toContain('secret-environment-value')

    const hiddenPath = resolve('must-not-leak', 'state.sqlite')
    const knownFailure = {
      backup: async (): Promise<never> => {
        throw new SakiMaintenanceError('recovery-required', `failure at ${hiddenPath}`)
      },
      verify: async (): Promise<never> => { throw new Error('unused') },
      upgrade: async (): Promise<never> => { throw new Error('unused') },
    } satisfies SakiMaintenanceOperations
    const knownOutcome = await runSakiMaintenanceCli(['backup'], environment, knownFailure, signal)
    expect(knownOutcome).toEqual({
      exitCode: 1,
      stream: 'stderr',
      value: { ok: false, command: 'backup', error: 'recovery-required' },
    })
    expect(JSON.stringify(knownOutcome)).not.toContain(hiddenPath)

    const unexpectedFailure = {
      backup: async (): Promise<never> => { throw new Error('secret-value') },
      verify: async (): Promise<never> => { throw new Error('unused') },
      upgrade: async (): Promise<never> => { throw new Error('unused') },
    } satisfies SakiMaintenanceOperations
    const unexpectedOutcome = await runSakiMaintenanceCli(['backup'], environment, unexpectedFailure, signal)
    expect(unexpectedOutcome).toEqual({
      exitCode: 1,
      stream: 'stderr',
      value: { ok: false, command: 'backup', error: 'operation-failed' },
    })
    expect(JSON.stringify(unexpectedOutcome)).not.toContain('secret-value')

    const abortController = new AbortController()
    abortController.abort()
    const abortingOperations = {
      backup: async (_options, operationSignal): Promise<never> => {
        operationSignal.throwIfAborted()
        throw new Error('operation was not aborted')
      },
      verify: async (): Promise<never> => { throw new Error('unused') },
      upgrade: async (): Promise<never> => { throw new Error('unused') },
    } satisfies SakiMaintenanceOperations
    expect(await runSakiMaintenanceCli(
      ['backup'],
      environment,
      abortingOperations,
      abortController.signal,
    )).toEqual({
      exitCode: 1,
      stream: 'stderr',
      value: { ok: false, command: 'backup', error: 'aborted' },
    })
  })

  it.each([
    { argv: [] },
    { argv: ['unknown'] },
    { argv: ['backup', 'extra'] },
    { argv: ['verify'] },
    { argv: ['verify', BACKUP_ID, 'extra'] },
    { argv: ['verify', 'backup-invalid'] },
    { argv: ['upgrade', '--unknown'] },
    { argv: ['backup', '--installation-root', 'relative'] },
    { argv: ['backup', '--legacy-database', 'relative.sqlite'] },
    { argv: ['backup', '--installation-root', resolve('one'), '--installation-root', resolve('two')] },
    { argv: ['backup', '--legacy-database', resolve('one.sqlite'), '--legacy-database', resolve('two.sqlite')] },
    { argv: ['backup', '--installation-root'] },
  ])('rejects invalid argv %#', ({ argv }) => {
    expect(() => parseSakiMaintenanceCliArgs(argv, {})).toThrow(SakiMaintenanceCliUsageError)
  })
})
