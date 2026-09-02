import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/agent-runtime-bin.ts', import.meta.url))
const configPath = fileURLToPath(new URL('../cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

interface AgentRuntimeReport {
  readonly preset: { readonly id: string; readonly trust: string }
  readonly sessionStarts: number
  readonly status: string
  readonly events: string[]
  readonly modelRequests: number
  readonly tools: string[]
}

describe('Saki Development Agent runtime composition', () => {
  it('discovers and mounts the shipped preset without driving the new session', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'Saki Development Agent runtime',
      tempDirPrefix: 'saki-agent-runtime-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      binArgs: [],
      tsconfigPath: repoTsconfig,
    })
    const report = JSON.parse(stdout) as AgentRuntimeReport

    expect(stderr).not.toContain('UNHANDLED')
    expect(report).toEqual({
      preset: { id: 'development', trust: 'system' },
      sessionStarts: 1,
      status: 'idle',
      events: [],
      modelRequests: 0,
      tools: process.platform === 'win32'
        ? ['edit', 'pwsh', 'read', 'request_intervention', 'write']
        : ['edit', 'read', 'request_intervention', 'write'],
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
