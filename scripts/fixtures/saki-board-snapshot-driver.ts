#!/usr/bin/env node
/** Source Loader driver for the assembled keyless Saki Board snapshot. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  providePreparedSakiState,
  withPreparedSakiServingState,
} from '@breakfastdapaidang/saki-installation-maintenance'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { announceSakiReadiness } from '../../packages/saki/bundle/src/index.ts'
import {
  sakiAgentPresetsPatch,
  sakiPreparedStoragePatch,
  sakiServingInstallationOptions,
} from '../../packages/saki/bundle/src/launcher.ts'
import type {} from '../../packages/saki/bundle/tests/fixtures/controllable-fake-llm.ts'
import { installLocalGitPushInternals } from '../../packages/saki/execution-local/src/git-push-internals.ts'
import { sakiBoardSnapshotGitPushTransport } from './saki-board-fake-github.ts'

const ROOT_CONFIG = fileURLToPath(new URL('../../packages/saki/bundle/cordis.yml', import.meta.url))
const BUNDLE_PATCH = fileURLToPath(new URL('../../packages/saki/bundle/cordis.patch.yml', import.meta.url))

const lifetime = new AbortController()
let app: Context | undefined
let stopping = false
let resolveStop!: () => void
const stopped = new Promise<void>((resolve) => { resolveStop = resolve })

function agentRunControlProfilePatch(bundlePatches: readonly PatchOptions[]): PatchOptions {
  const control = bundlePatches
    .flatMap(patch => patch.insert ?? [])
    .find((entry: EntryOptions) => entry.id === 'saki-control-plane')
  if (control === undefined || control.name !== '@breakfastdapaidang/saki-control-plane'
    || typeof control.config !== 'object' || control.config === null || Array.isArray(control.config)) {
    throw new Error('Saki Agent Run snapshot could not locate the production control-plane row')
  }
  return {
    id: control.id,
    name: control.name,
    config: {
      ...structuredClone(control.config as Record<string, unknown>),
      defaultAgentProfile: {
        agentPresetId: 'development',
        modelRouteRequest: { provider: 'saki-test', model: 'controllable' },
      },
    },
  }
}

function deliveryExecutionPatch(bundlePatches: readonly PatchOptions[]): PatchOptions {
  const execution = bundlePatches
    .flatMap(patch => patch.insert ?? [])
    .find((entry: EntryOptions) => entry.id === 'saki-execution-local')
  if (execution === undefined || execution.name !== '@breakfastdapaidang/saki-execution-local') {
    throw new Error('Saki Delivery snapshot could not locate the production Local Host row')
  }
  const config = typeof execution.config === 'object' && execution.config !== null && !Array.isArray(execution.config)
    ? structuredClone(execution.config as Record<string, unknown>)
    : {}
  return {
    id: execution.id,
    name: execution.name,
    config: { ...config, pushCredentialHelper: 'git-credential-manager' },
  }
}

async function reportAgentRunSnapshot(ctx: Context): Promise<void> {
  const signal = AbortSignal.timeout(5_000)
  const inputs: unknown[] = []
  const inputInsertions: unknown[] = []
  const interventionAnswerInputs: unknown[] = []
  const interventionAnswerInputInsertions: unknown[] = []
  const interventionAnswerInputSessionIds: string[] = []
  const interventionToolLifecycle: unknown[] = []
  const inputSessionIds: string[] = []
  for (const snapshot of await ctx.sessionPersistence.list({ signal })) {
    await using handle = await ctx.sessionPersistence.open(snapshot.header.id, 'read', { signal })
    const events = await handle.read(0, undefined, { signal })
    const foundInterventionCall = events.find(event =>
      event.type === 'tool/call' && event.data.name === 'request_intervention')
    const interventionCall = foundInterventionCall?.type === 'tool/call'
      ? foundInterventionCall
      : undefined
    for (const event of events) {
      if (event.type === 'user/message' && event.data.source.kind === 'saki-agent-run') {
        inputs.push(event.data)
        inputSessionIds.push(snapshot.header.id)
      }
      if (event.type === 'user/message' && event.data.source.kind === 'saki-intervention-answer') {
        interventionAnswerInputs.push(event.data)
        interventionAnswerInputSessionIds.push(snapshot.header.id)
      }
      if (event.type === 'agent/inbox/spliced') {
        inputInsertions.push(...event.data.inserted.filter(message => message.source.kind === 'saki-agent-run'))
        interventionAnswerInputInsertions.push(...event.data.inserted.filter(
          message => message.source.kind === 'saki-intervention-answer',
        ))
      }
      if (interventionCall !== undefined
        && event.type === 'tool/call'
        && event.data.callId === interventionCall.data.callId) {
        interventionToolLifecycle.push({ type: event.type, data: event.data })
      }
      if (interventionCall !== undefined
        && event.type === 'tool/result'
        && event.data.message.source.callId === interventionCall.data.callId) {
        interventionToolLifecycle.push({
          type: event.type,
          data: {
            turn: event.data.turn,
            step: event.data.step,
            source: event.data.message.source,
            content: event.data.message.content,
            ...(event.data.error === undefined ? {} : { error: event.data.error }),
          },
        })
      }
      if (interventionCall !== undefined
        && event.type === 'step/end'
        && event.data.turn === interventionCall.data.turn
        && event.data.step === interventionCall.data.step) {
        interventionToolLifecycle.push({ type: event.type, data: event.data })
      }
      if (interventionCall !== undefined
        && event.type === 'turn/end'
        && event.data.turn === interventionCall.data.turn) {
        interventionToolLifecycle.push({ type: event.type, data: event.data })
      }
    }
  }
  process.stdout.write(`${JSON.stringify({
    product: 'saki-agent-run-snapshot',
    modelRequests: ctx.sakiTestLlm.requests,
    modelInput: ctx.sakiTestLlm.lastAgentRunInput ?? null,
    modelInterventionAnswerInput: ctx.sakiTestLlm.lastInterventionAnswerInput ?? null,
    modelComposition: ctx.sakiTestLlm.lastAgentRunComposition ?? null,
    durableInputs: inputs,
    durableInputInsertions: inputInsertions,
    durableInterventionAnswerInputs: interventionAnswerInputs,
    durableInterventionAnswerInputInsertions: interventionAnswerInputInsertions,
    durableInterventionAnswerInputSessionIds: interventionAnswerInputSessionIds,
    interventionToolLifecycle,
    durableInputSessionIds: inputSessionIds,
    liveAgentSessionIds: ctx.agents.list().map(agent => agent.id),
  })}\n`)
}

function reportAgentRunRecovery(ctx: Context): void {
  process.stdout.write(`${JSON.stringify({
    product: 'saki-agent-run-recovery',
    liveAgentSessionIds: ctx.agents.list().map(agent => agent.id),
  })}\n`)
}

function requestStop(): void {
  if (stopping) return
  stopping = true
  resolveStop()
}

process.once('SIGINT', requestStop)
process.once('SIGTERM', requestStop)
if (process.env.SAKI_AGENT_RUN_SNAPSHOT === '1') {
  process.stdin.resume()
  process.stdin.once('end', requestStop)
}

try {
  process.exitCode = await withPreparedSakiServingState(
    sakiServingInstallationOptions(),
    lifetime.signal,
    async (prepared) => {
      const fakeProviderEnabled = process.env.SAKI_BOARD_SNAPSHOT_PROVIDER_ENABLED !== '0'
      const agentRunSnapshot = process.env.SAKI_AGENT_RUN_SNAPSHOT === '1'
      const deliverySnapshot = process.env.SAKI_DELIVERY_SNAPSHOT === '1'
      const bundlePatches = loadOverlayPatches('saki-board-snapshot', BUNDLE_PATCH)
      const patches = [
        ...bundlePatches,
        { id: 'saki-github-app', disabled: true },
        ...(fakeProviderEnabled ? [{
          insert: [{
            id: 'saki-board-snapshot-github',
            name: '../../../scripts/fixtures/saki-board-fake-github.ts',
          }],
        }] : []),
        ...(agentRunSnapshot ? [
          agentRunControlProfilePatch(bundlePatches),
          sakiAgentPresetsPatch(),
          {
            insert: [{
              id: 'saki-agent-run-snapshot-llm',
              name: './tests/fixtures/controllable-fake-llm.ts',
            }],
          },
        ] : []),
        ...(deliverySnapshot ? [deliveryExecutionPatch(bundlePatches)] : []),
        sakiPreparedStoragePatch(prepared.databasePath),
      ]
      app = await announceSakiReadiness(
        boot(
          'saki-board-snapshot',
          ROOT_CONFIG,
          patches,
          (ctx) => {
            providePreparedSakiState(ctx, prepared)
            provideCmdline(ctx, { args: [], exit: requestStop })
            if (deliverySnapshot) {
              installLocalGitPushInternals(ctx, { transport: sakiBoardSnapshotGitPushTransport })
            }
          },
          import.meta.url,
        ),
        { stdout: process.stdout, exit: requestStop },
        { exitAfterAnnounce: false },
      )
      if (agentRunSnapshot) reportAgentRunRecovery(app)
      const handoff = app.sakiControlPlane.bootstrap.take()
      if (handoff !== undefined) {
        process.stdout.write(`${JSON.stringify({
          product: 'saki',
          bootstrapPurpose: handoff.purpose,
          bootstrapSecret: handoff.consume(),
          url: `http://127.0.0.1:${String(app.webServer.port)}`,
        })}\n`)
      }
      await stopped
      if (agentRunSnapshot) await reportAgentRunSnapshot(app)
      lifetime.abort(new Error('Saki Board snapshot driver stopped'))
      await app.fiber.dispose()
      app = undefined
      return 0
    },
  )
} catch (error) {
  await app?.fiber.dispose()
  if (lifetime.signal.aborted) {
    process.exitCode = 0
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
} finally {
  lifetime.abort(new Error('Saki Board snapshot driver settled'))
  process.off('SIGINT', requestStop)
  process.off('SIGTERM', requestStop)
  process.stdin.off('end', requestStop)
}
