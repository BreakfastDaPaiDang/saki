import { describe, expect, it } from 'vitest'
import { ScanConcurrencyGate } from '../src/scan-gate.ts'

describe('GitHub complete-scan concurrency gate', () => {
  it('admits only the configured number of complete scans across installations', async () => {
    const gate = new ScanConcurrencyGate(2)
    const firstRelease = Promise.withResolvers<undefined>()
    const secondRelease = Promise.withResolvers<undefined>()
    const started: number[] = []

    const first = gate.run(new AbortController().signal, async () => {
      started.push(1)
      await firstRelease.promise
    })
    const second = gate.run(new AbortController().signal, async () => {
      started.push(2)
      await secondRelease.promise
    })
    const third = gate.run(new AbortController().signal, () => {
      started.push(3)
      return Promise.resolve()
    })
    await viWaitUntil(() => started.length === 2)
    expect(started).toEqual([1, 2])

    firstRelease.resolve(undefined)
    await viWaitUntil(() => started.length === 3)
    secondRelease.resolve(undefined)
    await Promise.all([first, second, third])
    expect(started).toEqual([1, 2, 3])
  })

  it('removes a canceled scan before admission', async () => {
    const gate = new ScanConcurrencyGate(1)
    const release = Promise.withResolvers<undefined>()
    const blocker = gate.run(new AbortController().signal, async () => { await release.promise })
    const cancellation = new AbortController()
    let ran = false
    const queued = gate.run(cancellation.signal, () => {
      ran = true
      return Promise.resolve()
    })
    cancellation.abort(new Error('scan cancelled'))
    release.resolve(undefined)

    await expect(queued).rejects.toThrow('GitHub operation cancelled')
    await blocker
    expect(ran).toBe(false)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency limit %s at construction',
    (limit) => {
      expect(() => new ScanConcurrencyGate(limit)).toThrow(
        'scan concurrency limit must be a positive integer',
      )
    },
  )

  it('rejects a scan whose caller cancelled before admission', async () => {
    const gate = new ScanConcurrencyGate(1)
    const cancellation = new AbortController()
    cancellation.abort()

    await expect(gate.run(cancellation.signal, () => Promise.resolve()))
      .rejects.toThrow('GitHub operation cancelled')
  })
})

async function viWaitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error('condition did not settle')
}
