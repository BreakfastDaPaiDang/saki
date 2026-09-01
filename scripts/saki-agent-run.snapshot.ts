/** Keyless product snapshot for one assembled manual Saki Agent Run and exact restart replay. */

import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  sakiBoardResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiGiveWorkItemToAgentResultSchema,
  sakiProjectIndexResultSchema,
} from '@breakfastdapaidang/saki-host-api'
import type { SakiBoardProjection, SakiQueryResult } from '@breakfastdapaidang/saki-control-plane'
import { describe, expect, it } from 'vitest'
import {
  readSakiBoardSnapshotMutationState,
  SAKI_BOARD_SNAPSHOT_CONFIGURATION,
} from './fixtures/saki-board-fake-github.ts'
import {
  cleanupSnapshot,
  createRepository,
  freePort,
  registerSnapshotProject,
  rpc,
  runWithCleanup,
  serializeSnapshotRecords,
  startSaki,
  verifySnapshotOutput,
  type StartedSaki,
} from './fixtures/saki-host-snapshot.ts'

const root = resolve(import.meta.dirname, '..')
const driver = join(root, 'scripts/fixtures/saki-board-snapshot-driver.ts')
const expected = join(root, 'scripts/snapshots/saki-agent-run/agent-run.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

type BoardResult = SakiQueryResult<'board'>
type ConfirmedBoardProjection = SakiBoardProjection & {
  readonly state: 'confirmed'
  readonly confirmed: NonNullable<SakiBoardProjection['confirmed']>
}

interface AgentRunSnapshotSummary {
  readonly product: 'saki-agent-run-snapshot'
  readonly modelRequests: number
  readonly modelInput: unknown
  readonly modelComposition: unknown
  readonly durableInputs: readonly unknown[]
  readonly durableInputInsertions: readonly unknown[]
  readonly durableInputSessionIds: readonly string[]
  readonly liveAgentSessionIds: readonly string[]
}

interface AgentRunRecoverySummary {
  readonly product: 'saki-agent-run-recovery'
  readonly liveAgentSessionIds: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isConfirmed(projection: SakiBoardProjection): projection is ConfirmedBoardProjection {
  return projection.state === 'confirmed' && projection.confirmed !== undefined
}

async function queryBoard(port: number, cookie: string, projectId: string): Promise<BoardResult> {
  const response = await rpc(port, 'control/query', {
    type: 'board',
    projectId,
    refresh: 'cached',
  }, { cookie })
  return sakiBoardResultSchema.parse(response.value)
}

async function waitForConfirmedBoard(
  port: number,
  cookie: string,
  projectId: string,
): Promise<ConfirmedBoardProjection> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = await queryBoard(port, cookie, projectId)
    if (result.ok && isConfirmed(result.projection)
      && result.projection.effectiveMutationAvailability.available) return result.projection
    await delay(20)
  }
  throw new Error('Saki Agent Run snapshot did not reach a confirmed mutable Board')
}

async function setProviderState(path: string, state: 'complete' | 'hold'): Promise<void> {
  const temporaryPath = `${path}.next`
  await writeFile(temporaryPath, `${state}\n`)
  await rename(temporaryPath, path)
}

async function waitForModelRequest(started: StartedSaki): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (started.records.some(record => isRecord(record)
      && record.product === 'saki-agent-run-model-request')) return
    await delay(20)
  }
  throw new Error('Saki Agent Run snapshot did not reach the fake model')
}

function summary(records: readonly unknown[]): AgentRunSnapshotSummary {
  const value = records.findLast(record => isRecord(record)
    && record.product === 'saki-agent-run-snapshot')
  if (!isRecord(value) || value.product !== 'saki-agent-run-snapshot'
    || !Number.isSafeInteger(value.modelRequests) || !Array.isArray(value.durableInputs)
    || !Array.isArray(value.durableInputInsertions) || !Array.isArray(value.durableInputSessionIds)
    || value.durableInputSessionIds.some(id => typeof id !== 'string')
    || !Array.isArray(value.liveAgentSessionIds)
    || value.liveAgentSessionIds.some(id => typeof id !== 'string')
    || !Object.hasOwn(value, 'modelInput')
    || !Object.hasOwn(value, 'modelComposition')) {
    const products = records.flatMap(record => isRecord(record) && typeof record.product === 'string'
      ? [record.product]
      : [])
    throw new Error(`Saki Agent Run child did not emit a valid durable summary (${products.join(', ')})`)
  }
  return {
    product: value.product,
    modelRequests: value.modelRequests as number,
    modelInput: value.modelInput,
    modelComposition: value.modelComposition,
    durableInputs: value.durableInputs,
    durableInputInsertions: value.durableInputInsertions,
    durableInputSessionIds: value.durableInputSessionIds as string[],
    liveAgentSessionIds: value.liveAgentSessionIds as string[],
  }
}

function recoverySummary(records: readonly unknown[]): AgentRunRecoverySummary {
  const value = records.findLast(record => isRecord(record)
    && record.product === 'saki-agent-run-recovery')
  if (!isRecord(value) || value.product !== 'saki-agent-run-recovery'
    || !Array.isArray(value.liveAgentSessionIds)
    || value.liveAgentSessionIds.some(id => typeof id !== 'string')) {
    throw new Error('Saki Agent Run child did not emit a valid startup recovery summary')
  }
  return {
    product: value.product,
    liveAgentSessionIds: value.liveAgentSessionIds as string[],
  }
}

function normalizeAgentValue(value: unknown, projectId: string): unknown {
  return JSON.parse(JSON.stringify(value)
    .replaceAll(projectId, 'project-<id>')
    .replace(/agent-profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, 'agent-profile-<id>'))
}

async function transcript(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-agent-run-snapshot-'))
  let first: StartedSaki | undefined
  let second: StartedSaki | undefined
  return await runWithCleanup(async () => {
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const providerStatePath = join(directory, 'provider-state')
    await setProviderState(providerStatePath, 'complete')
    const repository = await createRepository(directory)
    const databasePath = join(directory, 'control.sqlite')
    const port = await freePort()
    first = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      agentRunSnapshot: true,
      boardProviderStatePath: providerStatePath,
    })
    const bootstrapSecret = first.bootstrapSecret
    const {
      exchangeValue,
      cookie,
      confirmed: registration,
    } = await registerSnapshotProject(port, bootstrapSecret, repository)
    const configuredResponse = await rpc(port, 'control/submit', {
      type: 'configure-github-synchronization',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectId: registration.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: SAKI_BOARD_SNAPSHOT_CONFIGURATION,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse(configuredResponse.value)
    if (!configured.ok) throw new Error(`Saki Agent Run snapshot configuration failed: ${configured.reason}`)

    const board = await waitForConfirmedBoard(port, cookie, registration.receipt.projectId)
    const workItem = board.confirmed.items.find(item => item.issueNumber === 27)
    if (workItem === undefined || workItem.status !== 'ready') {
      throw new Error('Saki Agent Run snapshot has no Ready Work Item')
    }
    const projectIndexResponse = await rpc(port, 'control/query', { type: 'project-index' }, { cookie })
    const projectIndex = sakiProjectIndexResultSchema.parse(projectIndexResponse.value)
    if (!projectIndex.ok) throw new Error(`Saki Agent Run snapshot project index failed: ${projectIndex.reason}`)
    const project = projectIndex.projection.projects.find(candidate => candidate.id === registration.receipt.projectId)
    if (project === undefined) throw new Error('Saki Agent Run snapshot lost its registered Project')

    const intent = {
      type: 'give-work-item-to-agent',
      intentId: 'intent-88888888-8888-4888-8888-888888888888',
      projectId: project.id,
      workItemId: workItem.id,
      expectedProjectRevision: project.revision,
      expectedRemoteFingerprint: workItem.remoteFingerprint,
    } as const
    const giveResponse = await rpc(port, 'control/submit', intent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const given = sakiGiveWorkItemToAgentResultSchema.parse(giveResponse.value)
    if (!given.ok) throw new Error(`Saki Agent Run snapshot dispatch failed: ${given.reason}`)
    await waitForModelRequest(first)
    const mutation = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(mutation.dispatchCount).toBe(1)
    await setProviderState(providerStatePath, 'hold')
    const firstProcess = first
    await firstProcess.stop()
    first = undefined
    const firstSummary = summary(firstProcess.records)
    expect(firstSummary).toMatchObject({ modelRequests: 1 })
    expect(firstSummary.durableInputs).toHaveLength(1)
    expect(firstSummary.durableInputInsertions).toHaveLength(1)
    expect(firstSummary.durableInputSessionIds).toHaveLength(1)
    expect(firstSummary.liveAgentSessionIds).toEqual(firstSummary.durableInputSessionIds)
    expect(firstSummary.modelInput).toEqual(firstSummary.durableInputs[0])
    expect(firstSummary.durableInputInsertions[0]).toEqual(firstSummary.durableInputs[0])
    expect(firstSummary.modelComposition).toEqual({
      provider: 'saki-test',
      model: 'controllable',
      developmentPersona: true,
      filesystemTools: ['edit', 'read', 'write'],
    })

    second = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      agentRunSnapshot: true,
      boardProviderStatePath: providerStatePath,
    })
    const secondBootstrapSecret = second.bootstrapSecret
    const recoveredBeforeReplay = recoverySummary(second.records)
    expect(recoveredBeforeReplay.liveAgentSessionIds).toEqual(firstSummary.durableInputSessionIds)
    const replayResponse = await rpc(port, 'control/submit', intent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const replayed = sakiGiveWorkItemToAgentResultSchema.parse(replayResponse.value)
    expect(replayed).toEqual(given)
    expect((await readSakiBoardSnapshotMutationState(providerStatePath)).dispatchCount).toBe(1)
    const secondProcess = second
    await secondProcess.stop()
    second = undefined
    const secondSummary = summary(secondProcess.records)
    expect(secondSummary).toMatchObject({ modelRequests: 0, modelInput: null, modelComposition: null })
    expect(secondSummary.durableInputs).toEqual(firstSummary.durableInputs)
    expect(secondSummary.durableInputInsertions).toEqual(firstSummary.durableInputInsertions)
    expect(secondSummary.durableInputSessionIds).toEqual(firstSummary.durableInputSessionIds)
    expect(secondSummary.liveAgentSessionIds).toEqual(firstSummary.durableInputSessionIds)

    const records = [
      {
        step: 'manual-agent-run',
        result: {
          receipt: normalizeAgentValue(given.receipt, project.id),
          modelRequests: firstSummary.modelRequests,
          providerMutation: {
            statusOptionId: mutation.statusOptionId,
            dispatchCount: mutation.dispatchCount,
          },
        },
      },
      {
        step: 'exact-model-input',
        result: {
          modelInput: normalizeAgentValue(firstSummary.modelInput, project.id),
          durableInput: normalizeAgentValue(firstSummary.durableInputs[0], project.id),
          composition: firstSummary.modelComposition,
          physicallyRecordedOnce: true,
          physicallyInsertedOnce: true,
        },
      },
      {
        step: 'restart-exact-replay',
        result: {
          launcherPurpose: secondProcess.bootstrapPurpose,
          sameReceipt: true,
          resumedBeforeReplay: true,
          liveSessionCount: recoveredBeforeReplay.liveAgentSessionIds.length,
          modelRequests: secondSummary.modelRequests,
          durableInputCount: secondSummary.durableInputs.length,
          providerDispatchCount: mutation.dispatchCount,
        },
      },
    ]
    return serializeSnapshotRecords(
      records,
      [
        directory,
        repository,
        providerStatePath,
        bootstrapSecret,
        secondBootstrapSecret,
        cookie,
        exchangeValue.access.requestToken,
      ],
    )
  }, async () => { await cleanupSnapshot(directory, first, second) })
}

async function verify(): Promise<void> {
  await verifySnapshotOutput(expected, await transcript(), refreshing)
}

describe('assembled Saki manual Agent Run snapshot', () => {
  it('records one exact input and replays the same durable Run after restart', async () => {
    await verify()
  })
})
