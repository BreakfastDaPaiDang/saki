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

    const { stdout, stderr } = await execFileAsync(process.execPath, [bin], {
      env: environment,
      timeout: 30_000,
    })

    expect(stdout).toBe('{"product":"saki","status":"ready"}\n')
    expect(stderr).toBe('')
  })
})
