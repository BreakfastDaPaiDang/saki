/** Plain-Node smoke for the built private Saki executable. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const bin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

describe.skipIf(!existsSync(bin))('built Saki executable', () => {
  it('boots under plain Node without credentials', async () => {
    const environment = { ...process.env }
    delete environment.DEEPSEEK_API_KEY
    delete environment.OPENAI_API_KEY
    delete environment.CODEX_API_KEY
    environment.SAKI_DATABASE_PATH = ':memory:'
    environment.SAKI_ONESHOT = '1'

    const { stdout, stderr } = await execFileAsync(process.execPath, [bin], {
      env: environment,
      timeout: 30_000,
    })

    expect(stdout).toBe('{"product":"saki","status":"ready"}\n')
    expect(stderr).toBe('')
  })

  it('rejects a port that cannot identify the configured browser Origin', async () => {
    let rejected = false
    try {
      await execFileAsync(process.execPath, [bin], {
        env: {
          ...process.env,
          SAKI_DATABASE_PATH: ':memory:',
          SAKI_ONESHOT: '1',
          SAKI_PORT: '0',
        },
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
  })
})
