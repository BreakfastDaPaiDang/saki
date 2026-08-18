import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { observeProcessExit, waitForFile } from './fixtures/process-exit-coordination.ts'

describe('process-exit fixture coordination', () => {
  it('observes a rejected process promise before accepting a preexisting file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-process-exit-coordination-'))
    const target = join(root, 'proceed')
    await writeFile(target, 'ready')
    const exited = observeProcessExit(
      Promise.reject(new Error('fixture transport failed')),
      'fixture child',
      () => 'captured output',
    )
    try {
      await expect(waitForFile(target, exited, 'proceed signal')).rejects.toThrow(
        'fixture child failed during proceed signal: fixture transport failed: captured output',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('releases its watcher after accepting a preexisting file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-process-exit-coordination-'))
    const target = join(root, 'tree.json')
    await writeFile(target, '{}')
    const running = new Promise<never>(() => {})
    try {
      await expect(waitForFile(target, running, 'tree-state publication')).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
