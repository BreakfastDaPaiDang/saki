/** Unit coverage for the web-runtime glue: it mounts frontend-static over the built dist. */
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { apply, inject, name } from '../src/web-runtime.ts'

vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return Object.assign({}, actual, { createRequire: vi.fn(actual.createRequire) })
})

describe('saki-web-runtime', () => {
  it('mounts the frontend-static owner over the built web dist', () => {
    const plugin = vi.fn()
    const ctx = { plugin } as unknown as Context
    const require = createRequire(import.meta.url)
    const resolve = Object.assign(vi.fn(() => '/fixture/apps/web/dist/index.html'), {
      paths: (request: string) => require.resolve.paths(request),
    })
    vi.mocked(createRequire).mockReturnValueOnce(Object.assign(require, { resolve }))

    apply(ctx)

    expect(name).toBe('saki-web-runtime')
    expect(inject).toEqual(['webServer'])
    expect(plugin).toHaveBeenCalledOnce()
    const [pluginRef, config] = plugin.mock.calls[0]! as [unknown, { distIndex: string }]
    expect(pluginRef).toBe(FrontendStatic)
    expect(config.distIndex).toMatch(/apps[\\/]web[\\/]dist[\\/]index\.html$/)
    expect(resolve).toHaveBeenCalledWith('@deepseek-ai/dsh-web-frontend/dist/index.html')
  })
})
