import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { validateClosedSakiV2Source } from '../src/legacy-state.ts'
import {
  B03_INSTALLATION_ID,
  B03_STORAGE_GENERATION_ID,
  writeB03Database,
} from './b03-fixture.ts'

const roots: string[] = []

async function legacyDatabase(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-legacy-state-'))
  roots.push(root)
  const path = join(root, 'control.sqlite')
  writeB03Database(path)
  return path
}

function execute(path: string, sql: string, ...parameters: SQLInputValue[]): void {
  const database = new DatabaseSync(path)
  try {
    database.prepare(sql).run(...parameters)
  } finally {
    database.close()
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('exact B03 source identity validation', () => {
  it('returns the selected Installation and retained historical generation identities', async () => {
    const source = await validateClosedSakiV2Source(
      await legacyDatabase(),
      undefined,
      undefined,
      AbortSignal.timeout(2_000),
    )

    expect(source).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
    })
    expect(source.historicalStorageGenerationIds.has(B03_STORAGE_GENERATION_ID)).toBe(true)
  })

  it('requires the exact B03 control singleton', async () => {
    const path = await legacyDatabase()
    execute(path, 'DELETE FROM "u_saki_control_plane_control_state"')

    await expect(validateClosedSakiV2Source(
      path,
      undefined,
      undefined,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required', message: 'B03 Saki state has no control singleton' })
  })

  it('requires the manifest-selected Installation owner', async () => {
    const other = 'installation-00000000-0000-4000-8000-000000000099' as SakiInstallationId
    await expect(validateClosedSakiV2Source(
      await legacyDatabase(),
      other,
      undefined,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires the control-owned Installation record', async () => {
    const path = await legacyDatabase()
    execute(
      path,
      'DELETE FROM "u_saki_control_plane_installations" WHERE key = ?',
      B03_INSTALLATION_ID,
    )

    await expect(validateClosedSakiV2Source(
      path,
      B03_INSTALLATION_ID,
      undefined,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'B03 Saki state has no selected Installation',
    })
  })

  it('requires the manifest-selected physical generation', async () => {
    const other = 'storage-generation-00000000-0000-4000-8000-000000000099' as SakiStorageGenerationId
    await expect(validateClosedSakiV2Source(
      await legacyDatabase(),
      B03_INSTALLATION_ID,
      other,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })
})
