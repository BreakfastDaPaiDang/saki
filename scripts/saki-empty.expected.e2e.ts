/** Runnable keyless readiness snapshot for the assembled Saki application. */

import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sakiSnapshotEnvironment } from './saki-snapshot-environment.ts'

const root = resolve(import.meta.dirname, '..')
const expected = join(root, 'scripts/tests/expected/saki-empty/readiness.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'
const tsxLoader = import.meta.resolve('tsx/esm')

describe('assembled Saki application readiness snapshot', () => {
  it('scrubs mixed-case ambient Saki controls from child processes', () => {
    const key = 'sAkI_EmPtY_CaNaRy'
    process.env[key] = 'untrusted'
    try {
      expect(sakiSnapshotEnvironment()[key]).toBeUndefined()
    } finally {
      Reflect.deleteProperty(process.env, key)
    }
  })

  it('boots the real bundle without credentials and exits after readiness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'saki-empty-snapshot-'))
    try {
      const environment = sakiSnapshotEnvironment()
      environment.DSH_HOME = join(directory, 'home')
      environment.SAKI_ONESHOT = '1'
      environment.SAKI_DATABASE_PATH = join(directory, 'legacy.sqlite')
      environment.SAKI_PORT = '43129'
      environment.TSX_TSCONFIG_PATH = join(root, 'tsconfig.json')
      const result = spawnSync(process.execPath, [
        '--import',
        tsxLoader,
        join(root, 'packages/saki/bundle/src/bin.ts'),
      ], { cwd: directory, env: environment, encoding: 'utf8', timeout: 30_000 })

      expect(result.error).toBeUndefined()
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
      if (refreshing) {
        await mkdir(dirname(expected), { recursive: true })
        await writeFile(expected, result.stdout)
      } else {
        await access(expected)
      }
      await expect(result.stdout).toMatchFileSnapshot(expected)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
