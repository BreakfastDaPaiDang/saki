import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

describe.skipIf(process.platform !== 'win32')('shipped protected account composition', () => {
  it('loads Codex and streams with account and turn attribution through the maintained transport', async () => {
    const driver = fileURLToPath(new URL('./fixtures/model-account-bin.ts', import.meta.url))
    const { stdout, stderr } = await runLoaderSmoke({ label: 'Saki Model Account', tempDirPrefix: 'saki-model-account-',
      binScript: driver, libBinScript: driver, binArgs: [],
      configPath: fileURLToPath(new URL('../cordis.yml', import.meta.url)),
      tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(JSON.parse(stdout)).toEqual({ authentication: 'authorized', output: ['fixture-ok', 'fixture-ok', 'fixture-ok'],
      requests: [null, 'fixture-state', null, null, 'fixture-state'].map(state => ({ session: 'fixture-session', thread: 'fixture-session',
        state, account: 'fixture-account' })), tool: { name: 'lookup', arguments: '{}', finish: 'stop' } })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
