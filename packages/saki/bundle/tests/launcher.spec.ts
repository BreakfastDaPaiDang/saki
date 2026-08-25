import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import {
  CURRENT_SAKI_BUILD_ID,
  sakiPreparedStoragePatch,
  sakiServingInstallationOptions,
} from '../src/launcher.ts'

describe('Saki Installation launcher inputs', () => {
  it('uses the Harness home for Installation state and treats the old variable as legacy-only', () => {
    const home = resolve('fixture-home')
    const legacy = resolve('legacy', 'control.sqlite')

    expect(sakiServingInstallationOptions({ DSH_HOME: home, SAKI_DATABASE_PATH: legacy })).toEqual({
      installationRoot: join(home, 'saki'),
      legacyDatabasePath: legacy,
      currentBuildId: CURRENT_SAKI_BUILD_ID,
    })
  })

  it('defaults the legacy database beneath the Installation root', () => {
    const home = resolve('fixture-home')

    expect(sakiServingInstallationOptions({ DSH_HOME: home })).toMatchObject({
      installationRoot: join(home, 'saki'),
      legacyDatabasePath: join(home, 'saki', 'control.sqlite'),
    })
  })

  it('builds a literal final SQLite patch for the prepared generation', () => {
    const databasePath = resolve('generation', 'state.sqlite')
    expect(sakiPreparedStoragePatch(databasePath)).toEqual({
      id: 'saki-storage-sqlite',
      name: '@deepseek-ai/dsh-storage-sqlite',
      config: { backend: 'sqlite', path: databasePath, journalMode: 'wal' },
    })
  })
})
