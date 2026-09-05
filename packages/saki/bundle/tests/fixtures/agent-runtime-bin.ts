/** Source/build-neutral real-Loader driver for the Saki Agent runtime smoke. */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sakiAgentPresetsPatch } from '../../src/launcher.ts'
import type {} from './controllable-fake-llm.ts'

const rootConfig = fileURLToPath(new URL('../../cordis.yml', import.meta.url))
const bundlePatch = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))

const AGENT_RUNTIME_ROWS = new Set([
  'timer',
  'llm',
  'session',
  'session-projection',
  'session-persistence-jsonl',
  'system-prompt',
  'tools',
  'agent',
  'agent-loop',
  'session-checkpoint-policy',
  'agent-presets',
  'fs-local',
  'subprocess',
  'sandbox',
  'sandbox-policy',
  'approval',
  'shell-env',
  'pwsh-sandbox',
  'saki-readiness',
])

class ControlPlaneProbe extends Service {
  /** @param ctx - isolated runtime-smoke context. */
  constructor(ctx: Context) {
    super(ctx, 'sakiControlPlane')
  }
}

/** Select the exact production rows this real-composition smoke exercises. */
function agentRuntimePatch(): PatchOptions {
  const patches = loadOverlayPatches('saki-agent-runtime-test', bundlePatch)
  const inserted = (patches[0] as { insert?: EntryOptions[] } | undefined)?.insert
  if (inserted === undefined) throw new Error('Saki bundle must begin with one insert patch')
  return { insert: inserted.filter(entry => typeof entry.id === 'string' && AGENT_RUNTIME_ROWS.has(entry.id)) }
}

async function run(): Promise<void> {
  let ctx: Context | undefined
  try {
    ctx = await boot(
      'saki-agent-runtime-test',
      rootConfig,
      [
        agentRuntimePatch(),
        {
          id: 'session-persistence-jsonl',
          name: '@deepseek-ai/dsh-session-persistence-jsonl',
          config: { root: join(process.cwd(), 'sessions') },
        },
        sakiAgentPresetsPatch(),
        {
          insert: [{ id: 'controllable-fake-llm', name: './tests/fixtures/controllable-fake-llm.ts' }],
        },
      ],
      async (ctx) => { await ctx.plugin(ControlPlaneProbe) },
      import.meta.url,
    )

    const preset = await ctx.agentPresets.resolve('development')
    let sessionStarts = 0
    ctx.on('agent/session-start', () => { sessionStarts += 1 })
    const handle = await ctx.agents.create({
      sessionId: SessionId('saki-development-start'),
      meta: { cwd: process.cwd(), agentPreset: 'development' },
      agentOptions: { provider: 'saki-test', model: 'controllable' },
      setup: async agentCtx => void await ctx!.agentPresets.mount(agentCtx, 'development'),
    })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      process.stdout.write(`${JSON.stringify({
        preset: { id: preset.id, trust: preset.trust },
        sessionStarts,
        status: handle.agent.status,
        events: handle.agent.session.snapshotEvents().map(event => event.type),
        modelRequests: ctx.sakiTestLlm.requests,
        tools: ctx.tools.schemas(handle.agent).map(schema => schema.name).sort(),
      })}\n`)
    } finally {
      await handle.dispose()
    }
  } finally {
    await ctx?.fiber.dispose()
  }
}

await run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
