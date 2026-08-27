import { describe, expect, it } from 'vitest'
import { InstallationPriorityQueue } from '../src/priority-queue.ts'

describe('GitHub installation request queue', () => {
  it('serializes one installation and lets an interactive read overtake queued background work', async () => {
    const queue = new InstallationPriorityQueue()
    const firstStarted = Promise.withResolvers<undefined>()
    const releaseFirst = Promise.withResolvers<undefined>()
    const order: string[] = []

    const firstBackgroundPage = queue.run('background', new AbortController().signal, async () => {
      order.push('background-page-1')
      firstStarted.resolve(undefined)
      await releaseFirst.promise
    })
    await firstStarted.promise
    const secondBackgroundPage = queue.run('background', new AbortController().signal, () => {
      order.push('background-page-2')
      return Promise.resolve()
    })
    const interactiveRead = queue.run('interactive', new AbortController().signal, () => {
      order.push('interactive')
      return Promise.resolve()
    })

    releaseFirst.resolve(undefined)
    await Promise.all([firstBackgroundPage, secondBackgroundPage, interactiveRead])

    expect(order).toEqual(['background-page-1', 'interactive', 'background-page-2'])
  })

  it('does not start a queued request after its caller cancels', async () => {
    const queue = new InstallationPriorityQueue()
    const firstStarted = Promise.withResolvers<undefined>()
    const releaseFirst = Promise.withResolvers<undefined>()
    const blocker = queue.run('background', new AbortController().signal, async () => {
      firstStarted.resolve(undefined)
      await releaseFirst.promise
    })
    await firstStarted.promise

    const cancellation = new AbortController()
    let ran = false
    const queued = queue.run('interactive', cancellation.signal, () => {
      ran = true
      return Promise.resolve()
    })
    cancellation.abort(new Error('caller cancelled'))
    releaseFirst.resolve(undefined)

    await expect(queued).rejects.toThrow('GitHub operation cancelled')
    await blocker
    expect(ran).toBe(false)
  })

  it('rejects work whose caller cancelled before scheduling', async () => {
    const queue = new InstallationPriorityQueue()
    const cancellation = new AbortController()
    cancellation.abort()

    await expect(queue.run('interactive', cancellation.signal, () => Promise.resolve()))
      .rejects.toThrow('GitHub operation cancelled')
  })

  it('preserves FIFO order among queued requests with equal priority', async () => {
    const queue = new InstallationPriorityQueue()
    const release = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const order: number[] = []
    const blocker = queue.run('interactive', new AbortController().signal, async () => {
      started.resolve(undefined)
      await release.promise
    })
    await started.promise
    const first = queue.run('background', new AbortController().signal, () => {
      order.push(1)
      return Promise.resolve()
    })
    const second = queue.run('background', new AbortController().signal, () => {
      order.push(2)
      return Promise.resolve()
    })

    release.resolve(undefined)
    await Promise.all([blocker, first, second])
    expect(order).toEqual([1, 2])
  })
})
