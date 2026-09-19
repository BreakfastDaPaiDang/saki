import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { announceSakiReadiness, apply, SAKI_READY_RECORD } from '../src/index.ts'

const rootConfig = fileURLToPath(new URL('../cordis.yml', import.meta.url))

describe('Saki readiness startup', () => {
  it('publishes the stable readiness record for the active composition', async () => {
    const ctx = new Context()
    apply(ctx)

    expect(ctx.get('sakiReadiness')).toBe(SAKI_READY_RECORD)

    await ctx.fiber.dispose()
    expect(ctx.get('sakiReadiness')).toBeUndefined()
  })

  it('announces readiness only after the complete startup promise resolves', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    apply(ctx)
    let release!: (value: Context) => void
    const startup = new Promise<Context>((resolve) => { release = resolve })
    let output = ''
    const exits: number[] = []

    const announced = announceSakiReadiness(startup, {
      stdout: { write: (chunk: string) => { output += chunk } },
      exit: (code) => { exits.push(code) },
    })
    await Promise.resolve()
    expect(output).toBe('')
    expect(exits).toEqual([])

    release(ctx)
    await expect(announced).resolves.toBe(ctx)
    expect(output).toBe(`${JSON.stringify(SAKI_READY_RECORD)}\n`)
    expect(exits).toEqual([0])
    await ctx.fiber.dispose()
  })

  it('rejects reporting failures and disposes the audited application', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    apply(ctx)
    let exited = false

    await expect(announceSakiReadiness(Promise.resolve(ctx), {
      stdout: { write: () => { throw new Error('readiness stdout failed') } },
      exit: () => { exited = true },
    })).rejects.toThrow('readiness stdout failed')

    expect(exited).toBe(false)
    expect(ctx.get('sakiReadiness')).toBeUndefined()
  })

  it('rejects a boot result whose readiness row was not active', async () => {
    const ctx = new Context()
    let output = ''
    let exited = false

    await expect(announceSakiReadiness(Promise.resolve(ctx), {
      stdout: { write: (chunk: string) => { output += chunk } },
      exit: () => { exited = true },
    })).rejects.toThrow('saki: activated bundle did not provide sakiReadiness')

    expect(output).toBe('')
    expect(exited).toBe(false)
  })

  it('rejects readiness without an application Loader and disposes its provider', async () => {
    const ctx = new Context()
    apply(ctx)
    let output = ''
    let exited = false
    await expect(announceSakiReadiness(Promise.resolve(ctx), {
      stdout: { write: (chunk: string) => { output += chunk } },
      exit: () => { exited = true },
    })).rejects.toThrow('saki: readiness requires the application Loader')
    expect(output).toBe('')
    expect(exited).toBe(false)
    expect(ctx.get('sakiReadiness')).toBeUndefined()
  })

  it.each([
    { label: 'pending', name: './tests/fixtures/pending-readiness.ts', disabled: false },
    { label: 'missing', name: './tests/fixtures/missing-readiness.ts', disabled: false },
    { label: 'disabled', name: './tests/fixtures/pending-readiness.ts', disabled: true },
  ])('audits a $label configured row before announcing readiness', async ({ name, disabled }) => {
    let output = ''
    let exited = false
    const startup = boot(
      'saki-readiness-test',
      rootConfig,
      [
        {
          insert: [
            {
              id: 'saki-readiness',
              name: './src/index.ts',
            },
            {
              id: 'pending-readiness-test',
              name,
              disabled,
            },
          ],
        },
      ],
      undefined,
      import.meta.url,
    )

    const app = await startup
    const announced = announceSakiReadiness(Promise.resolve(app), {
      stdout: { write: (chunk: string) => { output += chunk } },
      exit: () => { exited = true },
    })
    if (disabled) {
      await expect(announced).resolves.toBe(app)
      expect(output).toBe(`${JSON.stringify(SAKI_READY_RECORD)}\n`)
      expect(exited).toBe(true)
      await app.fiber.dispose()
    } else {
      await expect(announced).rejects.toThrow(`saki: entry pending-readiness-test (${name}) did not activate`)
      expect(output).toBe('')
      expect(exited).toBe(false)
    }
    expect(app.get('loader')).toBeUndefined()
    expect(app.get('sakiReadiness')).toBeUndefined()
  })
})
