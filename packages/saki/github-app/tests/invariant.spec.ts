import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { expect, it } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

interface RuntimeDisposer extends PromiseLike<() => void> {
  (): void | Promise<void>
}

function runtimeDisposer(disposer: () => void): RuntimeDisposer {
  return disposer as RuntimeDisposer
}

it('registers, disposes, and re-registers the stateless provider invariant companion', async () => {
  expect(name).toBe('saki-github-app-invariant')
  expect(inject).toEqual(['invariants'])
  const ctx = new Context()
  const fiber = await ctx.plugin(Invariants)

  const disposeFirst = await apply(ctx)
  await runtimeDisposer(disposeFirst)()
  const disposeSecond = await apply(ctx)
  await runtimeDisposer(disposeSecond)()

  await fiber.dispose()
})
