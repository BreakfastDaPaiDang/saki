import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { expect, it } from 'vitest'
import { apply, inject, name } from '../src/invariant.ts'

it('registers and disposes the stateless package invariant companion', async () => {
  expect(name).toBe('saki-github-invariant')
  expect(inject).toEqual(['invariants'])
  const ctx = new Context()
  const fiber = await ctx.plugin(Invariants)
  const dispose = await apply(ctx)
  dispose()
  await fiber.dispose()
})
