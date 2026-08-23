import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
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

  it('does not announce readiness when a real configured row fails activation', async () => {
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
              name: './tests/fixtures/pending-readiness.ts',
            },
          ],
        },
      ],
      undefined,
      import.meta.url,
    )

    await expect(announceSakiReadiness(startup, {
      stdout: { write: (chunk: string) => { output += chunk } },
      exit: () => { exited = true },
    })).rejects.toThrow([
      'saki-readiness-test: plugin tree failed to load: saki-readiness-test: 1 entry did not activate',
      './tests/fixtures/pending-readiness.ts: pending (waiting for service: missingReadinessDependency)',
    ].join('\n'))

    expect(output).toBe('')
    expect(exited).toBe(false)
  })
})
