/** Plain-Node and PowerShell smokes for the built Saki maintenance executable. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  readClosedCurrentSakiState,
  readInstallationManifest,
  readSelectedGeneration,
} from '../src/index.ts'
import { B03_REGISTRY_REVISION, writeB03Database } from './b03-fixture.ts'

const execFileAsync = promisify(execFile)
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))
const powershellWrapper = fileURLToPath(new URL('../../../../scripts/saki-maintenance.ps1', import.meta.url))

interface MaintenanceOutput {
  readonly ok: true
  readonly command: 'upgrade' | 'verify'
  readonly backupId: string
}

interface Fixture {
  readonly directory: string
  readonly installationRoot: string
  readonly legacyDatabasePath: string
  readonly legacyBytes: Buffer
}

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-maintenance-built-'))
  const installationRoot = directory
  const legacyDatabasePath = join(installationRoot, 'control.sqlite')
  writeB03Database(legacyDatabasePath)
  return {
    directory,
    installationRoot,
    legacyDatabasePath,
    legacyBytes: await readFile(legacyDatabasePath),
  }
}

function args(command: readonly string[], value: Fixture): string[] {
  return [
    ...command,
    '--installation-root',
    value.installationRoot,
    '--legacy-database',
    value.legacyDatabasePath,
  ]
}

async function run(
  executable: string,
  prefix: readonly string[],
  command: readonly string[],
  value: Fixture,
): Promise<MaintenanceOutput> {
  const result = await execFileAsync(executable, [...prefix, ...args(command, value)], {
    cwd: value.directory,
    timeout: 60_000,
  })
  expect(result.stderr).toBe('')
  expect(result.stdout.trim().split(/\r?\n/u)).toHaveLength(1)
  return JSON.parse(result.stdout) as MaintenanceOutput
}

async function assertUpgradedFixture(value: Fixture): Promise<void> {
  expect(await readFile(value.legacyDatabasePath)).toEqual(value.legacyBytes)
  const signal = AbortSignal.timeout(10_000)
  const authority = await readInstallationManifest(value.installationRoot, signal)
  if (authority === undefined) throw new Error('built maintenance command did not publish Installation authority')
  const selected = await readSelectedGeneration(value.installationRoot, authority.value, signal)
  const current = await readClosedCurrentSakiState(selected.databasePath, {
    installationId: selected.generation.installationId,
    storageGenerationId: selected.generation.storageGenerationId,
    createdByBuildId: selected.generation.createdByBuildId,
  }, signal)
  expect(current.controlPlane.table('development_project_registry')
    .get('development-project-registry')).toMatchObject({
    revision: B03_REGISTRY_REVISION,
    projects: [{ projectTitle: 'Fixture project' }],
  })
}

describe.skipIf(!existsSync(bin))('built Saki maintenance executable', () => {
  it('upgrades and verifies a registered physical B03 Installation under plain Node', async () => {
    const value = await fixture()
    try {
      const upgraded = await run(process.execPath, [bin], ['upgrade'], value)
      expect(upgraded).toMatchObject({ ok: true, command: 'upgrade' })
      const verified = await run(process.execPath, [bin], ['verify', upgraded.backupId], value)
      expect(verified).toEqual({
        ok: true,
        command: 'verify',
        backupId: upgraded.backupId,
        stateVersion: 2,
      })
      await assertUpgradedFixture(value)
    } finally {
      await rm(value.directory, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')('forwards upgrade and verify through the PowerShell wrapper', async () => {
    const value = await fixture()
    try {
      const upgraded = await run(
        'pwsh',
        ['-NoLogo', '-NoProfile', '-File', powershellWrapper],
        ['upgrade'],
        value,
      )
      expect(upgraded).toMatchObject({ ok: true, command: 'upgrade' })
      const verified = await run(
        'pwsh',
        ['-NoLogo', '-NoProfile', '-File', powershellWrapper],
        ['verify', upgraded.backupId],
        value,
      )
      expect(verified).toMatchObject({
        ok: true,
        command: 'verify',
        backupId: upgraded.backupId,
      })
      await assertUpgradedFixture(value)
    } finally {
      await rm(value.directory, { recursive: true, force: true })
    }
  })
})
