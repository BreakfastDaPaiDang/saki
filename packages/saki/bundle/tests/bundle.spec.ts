import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

describe('Saki bundle package', () => {
  it('declares the parseable B01 Host composition through dsh.bundle', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      name?: string
      private?: boolean
      publishConfig?: unknown
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@breakfastdapaidang/saki-bundle')
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')

    const parsed = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    )
    const insert = (parsed as Array<{ insert: Array<{ id: string; name: string; config?: unknown }> }>)[0]!.insert
    expect(insert.map(entry => [entry.id, entry.name])).toEqual([
      ['storage', '@deepseek-ai/dsh-storage'],
      ['saki-storage-sqlite', '@deepseek-ai/dsh-storage-sqlite'],
      ['storage-domain', '@deepseek-ai/dsh-storage-domain'],
      ['saki-webserver', '@deepseek-ai/dsh-host-webserver'],
      ['saki-connection', '@deepseek-ai/dsh-client-connection'],
      ['saki-control-plane', '@breakfastdapaidang/saki-control-plane'],
      ['saki-host-api', '@breakfastdapaidang/saki-host-api'],
      ['saki-readiness', '@breakfastdapaidang/saki-bundle'],
    ])
    expect(insert.find(entry => entry.id === 'saki-webserver')?.config).toEqual({
      host: '127.0.0.1',
      port: {
        __jsExpr: "(() => { const port = Number(process.env.SAKI_PORT ?? 43119); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SAKI_PORT must be an integer from 1 through 65535'); return port })()",
      },
    })
    expect(insert.find(entry => entry.id === 'saki-control-plane')?.config).toMatchObject({
      origin: { __jsExpr: "'http://127.0.0.1:' + String(Number(process.env.SAKI_PORT ?? 43119))" },
    })
  })
})
