import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { providePreparedSakiState } from '../src/index.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId

const base = {
  databasePath: resolve('saki-test', 'state.sqlite'),
  installationId: INSTALLATION_ID,
  storageGenerationId: GENERATION_ID,
  stateVersion: 8,
  createdByBuildId: BUILD_ID,
} as const

describe('prepared Saki Installation state', () => {
  it('injects ready state as an idempotent validation point', async () => {
    const ctx = new Context()
    const state = providePreparedSakiState(ctx, { ...base, phase: 'ready' })
    expect(ctx.get('sakiInstallationState')).toBeDefined()
    expect(state).toMatchObject({
      phase: 'ready',
      installationId: INSTALLATION_ID,
      storageGenerationId: GENERATION_ID,
      stateVersion: 8,
      createdByBuildId: BUILD_ID,
    })
    await expect(state.activateAfterValidation(AbortSignal.timeout(2_000))).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('promotes provisioning state exactly once after validation', async () => {
    const ctx = new Context()
    const promote = vi.fn<(signal: AbortSignal) => Promise<void>>(() => Promise.resolve())
    const state = providePreparedSakiState(ctx, {
      ...base,
      phase: 'provisioning',
      promoteToReady: promote,
    })
    await Promise.all([
      state.activateAfterValidation(AbortSignal.timeout(2_000)),
      state.activateAfterValidation(AbortSignal.timeout(2_000)),
    ])
    expect(promote).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('rejects ephemeral or relative paths before registering the service', () => {
    for (const databasePath of [':memory:', 'relative/state.sqlite']) {
      const ctx = new Context()
      expect(() => providePreparedSakiState(ctx, {
        ...base,
        phase: 'ready',
        databasePath,
      })).toThrow('absolute filesystem path')
      expect(ctx.get('sakiInstallationState')).toBeUndefined()
    }
  })
})
