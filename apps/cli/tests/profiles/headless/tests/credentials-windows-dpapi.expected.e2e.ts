import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WINDOWS_DPAPI_CREDENTIALS_FILENAME } from '@deepseek-ai/dsh-credentials-windows-dpapi'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const fixtureDir = fileURLToPath(new URL(
  './fixtures/credentials/credentials-windows-dpapi/',
  import.meta.url,
))
const driver = join(fixtureDir, 'driver.ts')
const configPath = join(fixtureDir, 'cordis.yml')
const portableConfigPath = fileURLToPath(new URL(
  './fixtures/credentials/credentials-safe-view/cordis.yml',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url))
const ref = credentialRef('DSH_DPAPI_LOADER_TEST')
const expectedPath = fileURLToPath(new URL(
  './expected/credentials-windows-dpapi/host-safe-view.expected.json',
  import.meta.url,
))
const portableExpectedPath = fileURLToPath(new URL(
  './expected/credentials-windows-dpapi/host-safe-view-portable.expected.json',
  import.meta.url,
))

describe('credential safe-view public Loader snapshot', () => {
  it('pins every value-free Host response field on portable source and built compositions', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'credential safe-view Loader composition',
      tempDirPrefix: 'dsh-credential-safe-view-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath: portableConfigPath,
      tsconfigPath: repoTsconfig,
    })

    expect(stderr).toBe('')
    expect(stdout).toBe(await readFile(portableExpectedPath, 'utf8'))
    expect(stdout).not.toContain('loader-composition-secret')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})

describe.runIf(process.platform === 'win32')('Windows DPAPI Provider public Loader snapshot', () => {
  it('loads through an app process and persists only an authenticated current-user record', async () => {
    let stored: unknown
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'credentials-windows-dpapi Loader composition',
      tempDirPrefix: 'dsh-credentials-windows-dpapi-loader-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        stored = JSON.parse(await readFile(join(cwd, '.dsh', WINDOWS_DPAPI_CREDENTIALS_FILENAME), 'utf8'))
      },
    })

    expect(stderr).toBe('')
    expect(stdout).toBe(await readFile(expectedPath, 'utf8'))
    const document = stored as {
      version?: unknown
      refs?: Record<string, { kind?: unknown; ciphertext?: unknown }>
      records?: Record<string, { kind?: unknown; ciphertext?: unknown }>
    }
    expect(Object.keys(document).sort()).toEqual(['records', 'refs', 'version'])
    expect(document.version).toBe(2)
    expect(Object.keys(document.refs ?? {})).toEqual([ref])
    expect(document.records).toEqual({})
    expect(document.refs?.[ref]?.kind).toBe('dpapi-ng-local-user')
    expect(document.refs?.[ref]?.ciphertext).toBeTypeOf('string')
    expect(JSON.stringify({ stdout, stored })).not.toContain('loader-composition-secret')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
