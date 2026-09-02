import { describe, expect, it } from 'vitest'
import { isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import {
  CURRENT_SAKI_BUILD_ID,
  sakiAgentPresetsPatch,
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

  it('injects the shipped Development preset root as an absolute system-owned path', () => {
    const patch = sakiAgentPresetsPatch()
    const config = patch.config as {
      default: string
      roots: Array<{ path: string; trust: string }>
      includeUserRoot: boolean
    }

    expect(patch).toMatchObject({
      id: 'agent-presets',
      name: '@deepseek-ai/dsh-agent-presets',
      config: {
        default: 'development',
        includeUserRoot: false,
        roots: [{ trust: 'system' }],
      },
    })
    expect(isAbsolute(config.roots[0]!.path)).toBe(true)
    expect(existsSync(join(config.roots[0]!.path, 'development', 'agent.cordis.yml'))).toBe(true)
  })
})
