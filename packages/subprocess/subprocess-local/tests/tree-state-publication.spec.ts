import { watch } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { publishTreeState } from './fixtures/tree-state.ts'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-tree-state-publication-'))
}

describe('managed-tree state publication', () => {
  it('never exposes an intermediate target document', async () => {
    const root = await scratch()
    const target = join(root, 'tree.json')
    const previous = JSON.stringify({ root: 1, descendant: 2 })
    const nextState = { root: 3, descendant: 4, padding: 'x'.repeat(16 * 1024 * 1024) }
    const next = JSON.stringify(nextState)
    await writeFile(target, previous)
    let partialLength: number | undefined
    let settleObservation: (() => void) | undefined
    let rejectObservation: ((error: unknown) => void) | undefined
    const observedCommit = new Promise<void>((resolve, reject) => {
      settleObservation = resolve
      rejectObservation = reject
    })
    const watcher = watch(target, () => {
      void readFile(target, 'utf8').then((observed) => {
        if (observed === previous) return
        if (observed !== next) partialLength = observed.length
        settleObservation?.()
      }, (error: unknown) => { rejectObservation?.(error) })
    })

    try {
      await Promise.all([publishTreeState(target, nextState), observedCommit])
      expect(partialLength).toBeUndefined()
      expect(await readFile(target, 'utf8')).toBe(next)
      expect(await readdir(root)).toEqual(['tree.json'])
    } finally {
      watcher.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('removes its staging file when publication fails', async () => {
    const root = await scratch()
    const target = join(root, 'occupied')
    await mkdir(target)
    try {
      await expect(publishTreeState(target, { root: 1, descendant: 2 })).rejects.toThrow()
      expect(await readdir(root)).toEqual(['occupied'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
