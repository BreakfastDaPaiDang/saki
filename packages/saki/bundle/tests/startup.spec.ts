import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, internals, SAKI_READY_RECORD } from '../src/index.ts'

const processStdout = process.stdout

afterEach(() => {
  internals.stdout = processStdout
})

describe('Saki readiness startup', () => {
  it('announces readiness only after Loader settlement and requests a clean exit', async () => {
    const ctx = new Context()
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    let output = ''
    internals.stdout = { write: (chunk: string) => { output += chunk } }
    ctx.provide('loader', { await: () => settled } as never)
    const exited = new Promise<number>((resolve) => { ctx.provide('appExit', resolve) })

    apply(ctx)
    await Promise.resolve()
    expect(output).toBe('')

    release()
    await expect(exited).resolves.toBe(0)
    expect(output).toBe(`${JSON.stringify(SAKI_READY_RECORD)}\n`)
    await ctx.fiber.dispose()
  })

  it('does not announce readiness after its application is disposed', async () => {
    const ctx = new Context()
    let release!: () => void
    const settled = new Promise<void>((resolve) => { release = resolve })
    let output = ''
    let exited = false
    internals.stdout = { write: (chunk: string) => { output += chunk } }
    ctx.provide('loader', { await: () => settled } as never)
    ctx.provide('appExit', () => { exited = true })

    apply(ctx)
    await ctx.fiber.dispose()
    release()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(output).toBe('')
    expect(exited).toBe(false)
  })

  it('fails loud when no launcher owns process exit', () => {
    const ctx = new Context()
    ctx.provide('loader', { await: () => Promise.resolve() } as never)

    expect(() => { apply(ctx) }).toThrow('must provide ctx.appExit')
  })
})
