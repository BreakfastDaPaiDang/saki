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
      files?: string[]
      dsh?: { bundle?: { patch?: string } }
    }

    expect(manifest.name).toBe('@breakfastdapaidang/saki-bundle')
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('config/agent-presets/**/*.yml')

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
      ['timer', '@deepseek-ai/cordis-plugin-timer'],
      ['storage', '@deepseek-ai/dsh-storage'],
      ['storage-json', '@deepseek-ai/dsh-storage-json'],
      ['saki-storage-sqlite', '@deepseek-ai/dsh-storage-sqlite'],
      ['storage-domain', '@deepseek-ai/dsh-storage-domain'],
      ['llm', '@deepseek-ai/dsh-llm'],
      ['session', '@deepseek-ai/dsh-session'],
      ['session-projection', '@deepseek-ai/dsh-session-projection'],
      ['session-persistence-jsonl', '@deepseek-ai/dsh-session-persistence-jsonl'],
      ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
      ['tools', '@deepseek-ai/dsh-tools'],
      ['agent', '@deepseek-ai/dsh-agent'],
      ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
      ['session-checkpoint-policy', '@deepseek-ai/dsh-session-checkpoint-policy'],
      ['agent-presets', '@deepseek-ai/dsh-agent-presets'],
      ['workspace', '@deepseek-ai/dsh-workspace'],
      ['fs-local', '@deepseek-ai/dsh-fs-local'],
      ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
      ['sandbox', '@deepseek-ai/dsh-sandbox-local'],
      ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy'],
      ['approval', '@deepseek-ai/dsh-user-approval'],
      ['shell-env', '@deepseek-ai/dsh-shell-env'],
      ['pwsh-sandbox', '@deepseek-ai/dsh-pwsh-sandbox'],
      ['saki-execution-local', '@breakfastdapaidang/saki-execution-local'],
      ['saki-credentials', '@deepseek-ai/dsh-credentials-windows-dpapi'],
      ['saki-github-app', '@breakfastdapaidang/saki-github-app'],
      ['saki-webserver', '@deepseek-ai/dsh-host-webserver'],
      ['saki-connection', '@deepseek-ai/dsh-client-connection'],
      ['saki-control-plane', '@breakfastdapaidang/saki-control-plane'],
      ['saki-host-api', '@breakfastdapaidang/saki-host-api'],
      ['saki-readiness', '@breakfastdapaidang/saki-bundle'],
    ])
    expect(insert.find(entry => entry.id === 'storage-json')?.config).toEqual({
      root: { __jsExpr: "dshHomePath('storages')" },
    })
    expect(insert.find(entry => entry.id === 'storage-domain')?.config).toEqual({
      backend: 'json',
      routes: {
        saki_control_plane: 'sqlite',
        saki_host_execution: 'sqlite',
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
    expect(insert.find(entry => entry.id === 'agent-presets')?.config).toEqual({
      default: 'development',
      includeShippedRoot: false,
      includeUserRoot: false,
    })
    expect(insert.find(entry => entry.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(insert.find(entry => entry.id === 'sandbox-policy')?.config).toEqual({
      mode: 'workspace-write',
      workspaceRoot: { __jsExpr: 'process.cwd()' },
    })
    expect(insert.find(entry => entry.id === 'approval')?.config).toEqual({ policy: 'never' })
    expect(insert.find(entry => entry.id === 'pwsh-sandbox')?.disabled).toEqual({
      __jsExpr: "process.platform !== 'win32'",
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
      defaultAgentProfile: { agentPresetId: 'development' },
    })
  })

  it('ships one Saki-owned Development capability whitelist with its resolver closure', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const presetPath = resolve(root, 'config', 'agent-presets', 'development', 'agent.cordis.yml')
    const preset = yaml.load(readFileSync(presetPath, 'utf8'), { schema: entryListSchema }) as Array<{
      id: string
      name: string
      disabled?: unknown
      isolate?: Record<string, unknown>
      config?: unknown
    }>

    expect(Object.keys(manifest.dependencies ?? {})).toEqual(expect.arrayContaining([
      '@breakfastdapaidang/saki-tool-intervention',
      '@deepseek-ai/cordis-plugin-timer',
      '@deepseek-ai/dsh-agent',
      '@deepseek-ai/dsh-agent-instructions',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-agent-presets',
      '@deepseek-ai/dsh-fs-observation-policy',
      '@deepseek-ai/dsh-fs-sandbox',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-pwsh-sandbox',
      '@deepseek-ai/dsh-sandbox-local',
      '@deepseek-ai/dsh-sandbox-policy',
      '@deepseek-ai/dsh-session-checkpoint-policy',
      '@deepseek-ai/dsh-shell-env',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-user-approval',
    ]))
    expect(preset.map(entry => [entry.id, entry.name])).toEqual([
      ['persona', '@deepseek-ai/dsh-persona'],
      ['agent-instructions', '@deepseek-ai/dsh-agent-instructions'],
      ['request-intervention', '@breakfastdapaidang/saki-tool-intervention'],
      ['tool-pwsh', '@deepseek-ai/dsh-tool-pwsh'],
      ['filesystem', 'cordis:group'],
    ])
    expect(preset.find(entry => entry.id === 'tool-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { enableRunInBackground: false },
    })
    expect(preset.find(entry => entry.id === 'filesystem')).toMatchObject({
      isolate: { fs: true },
      config: [
        { id: 'fs-sandbox', name: '@deepseek-ai/dsh-fs-sandbox' },
        { id: 'fs-observation-policy', name: '@deepseek-ai/dsh-fs-observation-policy' },
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
      ],
    })
  })
})
