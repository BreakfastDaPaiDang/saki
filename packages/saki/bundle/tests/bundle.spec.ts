import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

describe('Saki bundle package', () => {
  it('declares the complete local Project-registration composition through dsh.bundle', () => {
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
    const insert = (parsed as Array<{
      insert: Array<{
        id: string
        name: string
        config?: unknown
        inject?: string[]
        disabled?: unknown
      }>
    }>)[0]!.insert
    expect(insert.map(entry => [entry.id, entry.name])).toEqual([
      ['storage', '@deepseek-ai/dsh-storage'],
      ['storage-json', '@deepseek-ai/dsh-storage-json'],
      ['saki-storage-sqlite', '@deepseek-ai/dsh-storage-sqlite'],
      ['storage-domain', '@deepseek-ai/dsh-storage-domain'],
      ['session', '@deepseek-ai/dsh-session'],
      ['session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'],
      ['workspace', '@deepseek-ai/dsh-workspace'],
      ['fs-local', '@deepseek-ai/dsh-fs-local'],
      ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
      ['saki-execution-local', '@breakfastdapaidang/saki-execution-local'],
      ['saki-credentials', '@deepseek-ai/dsh-credentials-windows-dpapi'],
      ['saki-github-app', '@breakfastdapaidang/saki-github-app'],
      ['typert', '@deepseek-ai/dsh-typert-registry'],
      ['typert-loader', '@deepseek-ai/dsh-typert-loader'],
      ['typert-gateway', '@deepseek-ai/dsh-api-gateway'],
      ['commands', '@deepseek-ai/dsh-commands'],
      ['saki-webserver', '@deepseek-ai/dsh-host-webserver'],
      ['saki-connection', '@deepseek-ai/dsh-client-connection'],
      ['saki-control-plane', '@breakfastdapaidang/saki-control-plane'],
      ['saki-host-api', '@breakfastdapaidang/saki-host-api'],
      ['modules', '@deepseek-ai/dsh-client-modules'],
      ['api-remotes', '@deepseek-ai/dsh-api-remotes'],
      ['client-runtime', '@deepseek-ai/dsh-client-runtime'],
      ['ui-theme', '@deepseek-ai/dsh-client-ui-theme'],
      ['locale', '@deepseek-ai/dsh-client-locale'],
      ['ui-layout', '@deepseek-ai/dsh-client-ui-layout'],
      ['ui-renderer', '@deepseek-ai/dsh-client-ui-renderer'],
      ['ui-sidebar', '@deepseek-ai/dsh-client-ui-sidebar'],
      ['ui-settings', '@deepseek-ai/dsh-client-ui-settings'],
      ['ui-settings-general', '@deepseek-ai/dsh-client-ui-settings-general'],
      ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation'],
      ['ui-workspace', '@deepseek-ai/dsh-client-ui-workspace'],
      ['ui-brand-official', '@deepseek-ai/dsh-client-ui-brand-official'],
      ['saki-web-ui', '@breakfastdapaidang/saki-web-ui'],
      ['saki-web-runtime', '@breakfastdapaidang/saki-bundle/web-runtime'],
      ['saki-readiness', '@breakfastdapaidang/saki-bundle'],
    ])
    expect(insert.find(entry => entry.id === 'storage-json')?.config).toEqual({
      root: { __jsExpr: "dshHomePath('storages')" },
    })
    expect(insert.find(entry => entry.id === 'storage-domain')?.config).toEqual({
      backend: 'json',
      routes: {
        saki_control_plane: 'sqlite',
        saki_storage_generation: 'sqlite',
      },
    })
    expect(insert.find(entry => entry.id === 'saki-storage-sqlite')?.config).toEqual({
      backend: 'sqlite',
      path: ':memory:',
      journalMode: 'wal',
    })
    expect(insert.find(entry => entry.id === 'session-persistence-jsonl')?.config).toEqual({
      root: { __jsExpr: "dshHomePath('sessions')" },
    })
    expect(insert.find(entry => entry.id === 'saki-credentials')?.disabled).toEqual({
      __jsExpr: "process.platform !== 'win32'",
    })
    expect(insert.find(entry => entry.id === 'saki-github-app')).toMatchObject({
      inject: ['credentials'],
      disabled: { __jsExpr: "process.platform !== 'win32'" },
    })
    expect(insert.find(entry => entry.id === 'saki-webserver')?.config).toEqual({
      host: '127.0.0.1',
      port: {
        __jsExpr: "(() => { const port = Number(process.env.SAKI_PORT ?? 43119); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SAKI_PORT must be an integer from 1 through 65535'); return port })()",
      },
    })
    expect(insert.find(entry => entry.id === 'saki-webserver')?.inject).toEqual(['sakiControlPlane'])
    expect(insert.find(entry => entry.id === 'saki-control-plane')?.config).toMatchObject({
      origin: { __jsExpr: "'http://127.0.0.1:' + String(Number(process.env.SAKI_PORT ?? 43119))" },
    })
  })
})
