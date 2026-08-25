/** Plain-Node smoke for the built private Saki executable. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from '../../../../scripts/saki-snapshot-environment.ts'

const execFileAsync = promisify(execFile)
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

function keylessEnvironment(directory: string): NodeJS.ProcessEnv {
  const environment = sakiSnapshotEnvironment()
  environment.DSH_HOME = join(directory, 'home')
  environment.SAKI_DATABASE_PATH = ':memory:'
  environment.SAKI_ONESHOT = '1'
  return environment
}

describe('built Saki child environment', () => {
  it('scrubs mixed-case ambient credentials', () => {
    const key = 'sAkI_BuIlT_CaNaRy_SeCrEt'
    const previousNodeOptions = process.env.NODE_OPTIONS
    const previousNodePath = process.env.NODE_PATH
    const previousExtraCaCerts = process.env.NODE_EXTRA_CA_CERTS
    process.env[key] = 'secret'
    process.env.NODE_OPTIONS = '--import untrusted-loader'
    process.env.NODE_PATH = 'untrusted-modules'
    process.env.NODE_EXTRA_CA_CERTS = 'untrusted-certificates'
    try {
      const environment = keylessEnvironment('fixture')
      expect(environment[key]).toBeUndefined()
      expect(environment.NODE_OPTIONS).toBeUndefined()
      expect(environment.NODE_PATH).toBeUndefined()
      expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, key)
      if (previousNodeOptions === undefined) Reflect.deleteProperty(process.env, 'NODE_OPTIONS')
      else process.env.NODE_OPTIONS = previousNodeOptions
      if (previousNodePath === undefined) Reflect.deleteProperty(process.env, 'NODE_PATH')
      else process.env.NODE_PATH = previousNodePath
      if (previousExtraCaCerts === undefined) Reflect.deleteProperty(process.env, 'NODE_EXTRA_CA_CERTS')
      else process.env.NODE_EXTRA_CA_CERTS = previousExtraCaCerts
    }
  })
})

describe.skipIf(!existsSync(bin))('built Saki executable', () => {
  it('boots under plain Node without credentials', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-built-bin-'))
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [bin], {
        cwd: directory,
        env: keylessEnvironment(directory),
        timeout: 30_000,
      })

      expect(stdout).toBe('{"product":"saki","status":"ready"}\n')
      expect(stderr).toBe('')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a port that cannot identify the configured browser Origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-built-bin-'))
    try {
      const environment = keylessEnvironment(directory)
      environment.SAKI_PORT = '0'
      let rejected = false
      try {
        await execFileAsync(process.execPath, [bin], {
          cwd: directory,
          env: environment,
          timeout: 30_000,
        })
      } catch (error) {
        if (!(error instanceof Error)
          || !('code' in error)
          || !('stdout' in error)
          || !('stderr' in error)
          || typeof error.stdout !== 'string'
          || typeof error.stderr !== 'string') throw error
        rejected = true
        expect(error.code).toBe(1)
        expect(error.stdout).toBe('')
        expect(error.stderr).toContain('SAKI_PORT must be an integer from 1 through 65535')
      }
      expect(rejected).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
