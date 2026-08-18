/** Runnable keyless snapshot for the assembled empty Saki application. */

import { spawnSync } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const expected = join(root, 'scripts/snapshots/saki-empty/readiness.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

describe('empty Saki application snapshot', () => {
  it('boots the real bundle without credentials and exits after readiness', async () => {
    const environment = { ...process.env }
    delete environment.DEEPSEEK_API_KEY
    delete environment.OPENAI_API_KEY
    delete environment.CODEX_API_KEY
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx/esm',
      join(root, 'packages/saki/bundle/src/bin.ts'),
    ], { cwd: root, env: environment, encoding: 'utf8', timeout: 30_000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    if (refreshing) {
      await mkdir(dirname(expected), { recursive: true })
      await writeFile(expected, result.stdout)
    } else {
      await access(expected)
    }
    await expect(result.stdout).toMatchFileSnapshot(expected)
  })
})
