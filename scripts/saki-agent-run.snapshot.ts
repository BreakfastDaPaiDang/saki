/** Keyless product snapshot for one manual Saki Agent Run, durable Intervention answer, and exact restart replay. */

import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  sakiAnswerInterventionResultSchema,
  sakiAttentionResultSchema,
  sakiBoardResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiGiveWorkItemToAgentResultSchema,
  sakiMyWorkResultSchema,
  sakiProjectIndexResultSchema,
} from '@breakfastdapaidang/saki-host-api'
import type {
  SakiAttentionProjection,
  SakiBoardProjection,
  SakiInterventionRequestProjection,
  SakiMyWorkProjection,
  SakiQueryResult,
} from '@breakfastdapaidang/saki-control-plane'
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
type MyWorkResult = SakiQueryResult<'my-work'>
type AttentionResult = SakiQueryResult<'attention'>
type SakiMyWorkItemProjection = SakiMyWorkProjection['items'][number]
type SakiAttentionItemProjection = SakiAttentionProjection['items'][number]
type ConfirmedBoardProjection = SakiBoardProjection & {
  readonly state: 'confirmed'
  readonly confirmed: NonNullable<SakiBoardProjection['confirmed']>
}

interface AgentRunSnapshotSummary {
  readonly product: 'saki-agent-run-snapshot'
  readonly modelRequests: number
  readonly modelInput: unknown
  readonly modelInterventionAnswerInput: unknown
  readonly modelComposition: unknown
  readonly durableInputs: readonly unknown[]
  readonly durableInputInsertions: readonly unknown[]
  readonly durableInterventionAnswerInputs: readonly unknown[]
  readonly durableInterventionAnswerInputInsertions: readonly unknown[]
  readonly durableInterventionAnswerInputSessionIds: readonly string[]
  readonly interventionToolLifecycle: readonly unknown[]
  readonly durableInputSessionIds: readonly string[]
  readonly liveAgentSessionIds: readonly string[]
}

interface AgentRunRecoverySummary {
  readonly product: 'saki-agent-run-recovery'
  readonly liveAgentSessionIds: readonly string[]
}

interface OpenInterventionSnapshot {
  readonly work: SakiMyWorkItemProjection
  readonly intervention: SakiInterventionRequestProjection
  readonly attention: SakiAttentionItemProjection
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

async function queryMyWork(port: number, cookie: string): Promise<MyWorkResult> {
  const response = await rpc(port, 'control/query', { type: 'my-work' }, { cookie })
  return sakiMyWorkResultSchema.parse(response.value)
}

async function queryAttention(port: number, cookie: string): Promise<AttentionResult> {
  const response = await rpc(port, 'control/query', { type: 'attention' }, { cookie })
  return sakiAttentionResultSchema.parse(response.value)
}

async function waitForOpenIntervention(
  port: number,
  cookie: string,
  workItemId: string,
): Promise<OpenInterventionSnapshot> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const myWork = await queryMyWork(port, cookie)
    if (myWork.ok) {
      const work = myWork.projection.items.find(item => item.workItem.id === workItemId)
      const intervention = work?.intervention
      if (work !== undefined && intervention?.state === 'open'
        && work.group === 'waiting-for-operator'
        && work.recommendation.available
        && work.recommendation.offer.type === 'answer-intervention') {
        const attention = await queryAttention(port, cookie)
        if (attention.ok) {
          const item = attention.projection.items.find(candidate =>
            candidate.source.kind === 'intervention'
            && candidate.source.id === intervention.id
            && candidate.source.revision === intervention.revision)
          if (item?.requiredResponse?.kind === 'text') return { work, intervention, attention: item }
        }
      }
    }
    await delay(20)
  }
  throw new Error('Saki Agent Run snapshot did not project an open Intervention')
}

async function waitForInterventionCleared(
  port: number,
  cookie: string,
  workItemId: string,
  interventionId: string,
): Promise<SakiMyWorkItemProjection> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const [myWork, attention] = await Promise.all([
      queryMyWork(port, cookie),
      queryAttention(port, cookie),
    ])
    if (myWork.ok && attention.ok) {
      const work = myWork.projection.items.find(item => item.workItem.id === workItemId)
      const interventionStillVisible = attention.projection.items.some(item =>
        item.source.kind === 'intervention' && item.source.id === interventionId)
      if (work !== undefined && work.intervention === undefined && !interventionStillVisible) return work
    }
    await delay(20)
  }
  throw new Error('Saki Agent Run snapshot did not clear the resolved Intervention')
}

async function setProviderState(path: string, state: 'complete' | 'hold'): Promise<void> {
  const temporaryPath = `${path}.next`
  await writeFile(temporaryPath, `${state}\n`)
  await rename(temporaryPath, path)
}

async function waitForModelRequests(started: StartedSaki, expectedRequests: number): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const requests = modelRequestCount(started)
    if (requests >= expectedRequests) return
    await delay(20)
  }
  throw new Error(`Saki Agent Run snapshot did not reach ${String(expectedRequests)} fake model request(s)`)
}

function modelRequestCount(started: StartedSaki): number {
  return started.records.filter(record => isRecord(record)
    && record.product === 'saki-agent-run-model-request').length
}

function summary(records: readonly unknown[]): AgentRunSnapshotSummary {
  const value = records.findLast(record => isRecord(record)
    && record.product === 'saki-agent-run-snapshot')
  if (!isRecord(value) || value.product !== 'saki-agent-run-snapshot'
    || !Number.isSafeInteger(value.modelRequests) || !Array.isArray(value.durableInputs)
    || !Array.isArray(value.durableInputInsertions) || !Array.isArray(value.durableInputSessionIds)
    || !Array.isArray(value.durableInterventionAnswerInputs)
    || !Array.isArray(value.durableInterventionAnswerInputInsertions)
    || !Array.isArray(value.durableInterventionAnswerInputSessionIds)
    || value.durableInterventionAnswerInputSessionIds.some(id => typeof id !== 'string')
    || !Array.isArray(value.interventionToolLifecycle)
    || value.durableInputSessionIds.some(id => typeof id !== 'string')
    || !Array.isArray(value.liveAgentSessionIds)
    || value.liveAgentSessionIds.some(id => typeof id !== 'string')
    || !Object.hasOwn(value, 'modelInput')
    || !Object.hasOwn(value, 'modelInterventionAnswerInput')
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
    modelInterventionAnswerInput: value.modelInterventionAnswerInput,
    modelComposition: value.modelComposition,
    durableInputs: value.durableInputs,
    durableInputInsertions: value.durableInputInsertions,
    durableInterventionAnswerInputs: value.durableInterventionAnswerInputs,
    durableInterventionAnswerInputInsertions: value.durableInterventionAnswerInputInsertions,
    durableInterventionAnswerInputSessionIds: value.durableInterventionAnswerInputSessionIds as string[],
    interventionToolLifecycle: value.interventionToolLifecycle,
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
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
  return JSON.parse(JSON.stringify(value)
    .replaceAll(projectId, 'project-<id>')
    .replace(/agent-profile-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu, 'agent-profile-<id>')
    .replace(new RegExp(`installation-${uuid}`, 'gu'), 'installation-<id>')
    .replace(new RegExp(`storage-generation-${uuid}`, 'gu'), 'storage-generation-<id>')
    .replace(new RegExp(`host-${uuid}`, 'gu'), 'host-<id>')
    .replace(new RegExp(`principal-${uuid}`, 'gu'), 'principal-<id>')
    .replace(new RegExp(`grant-${uuid}`, 'gu'), 'grant-<id>'))
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
    await waitForModelRequests(first, 1)
    const firstOpen = await waitForOpenIntervention(port, cookie, workItem.id)
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
    expect(firstSummary.durableInterventionAnswerInputs).toHaveLength(0)
    expect(firstSummary.durableInterventionAnswerInputInsertions).toHaveLength(0)
    expect(firstSummary.durableInterventionAnswerInputSessionIds).toHaveLength(0)
    expect(firstSummary.durableInputSessionIds).toHaveLength(1)
    expect(firstSummary.liveAgentSessionIds).toEqual(firstSummary.durableInputSessionIds)
    expect(firstSummary.modelInput).toEqual(firstSummary.durableInputs[0])
    expect(firstSummary.modelInterventionAnswerInput).toBeNull()
    expect(firstSummary.durableInputInsertions[0]).toEqual(firstSummary.durableInputs[0])
    expect(firstSummary.interventionToolLifecycle).toMatchObject([
      {
        type: 'tool/call',
        data: { callId: 'saki-agent-run-intervention', name: 'request_intervention' },
      },
      { type: 'tool/result', data: { content: [{ isError: false }] } },
      { type: 'step/end' },
      { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    ])
    expect(firstSummary.modelComposition).toEqual({
      provider: 'saki-test',
      model: 'controllable',
      developmentPersona: true,
      filesystemTools: ['edit', 'read', 'write'],
      interventionTool: true,
    })

    second = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      agentRunSnapshot: true,
      boardProviderStatePath: providerStatePath,
    })
    const secondBootstrapSecret = second.bootstrapSecret
    const recoveredBeforeReplay = recoverySummary(second.records)
    expect(recoveredBeforeReplay.liveAgentSessionIds).toEqual([])
    const restartedOpen = await waitForOpenIntervention(port, cookie, workItem.id)
    expect(restartedOpen.intervention).toEqual(firstOpen.intervention)
    expect(restartedOpen.attention).toEqual(firstOpen.attention)
    const replayResponse = await rpc(port, 'control/submit', intent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const replayed = sakiGiveWorkItemToAgentResultSchema.parse(replayResponse.value)
    expect(replayed).toEqual(given)
    const replayModelRequests = modelRequestCount(second)
    expect(replayModelRequests).toBe(0)
    expect((await readSakiBoardSnapshotMutationState(providerStatePath)).dispatchCount).toBe(1)

    const recommendation = restartedOpen.work.recommendation
    if (!recommendation.available || recommendation.offer.type !== 'answer-intervention') {
      throw new Error('Saki Agent Run snapshot lost its Intervention answer offer')
    }
    const answerIntent = {
      type: 'answer-intervention',
      intentId: 'intent-99999999-9999-4999-8999-999999999999',
      interventionId: recommendation.offer.interventionId,
      expectedInterventionRevision: recommendation.offer.expectedInterventionRevision,
      answer: { kind: 'text', text: 'Preserve the current repository state and continue.' },
    } as const
    const answerResponse = await rpc(port, 'control/submit', answerIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const answered = sakiAnswerInterventionResultSchema.parse(answerResponse.value)
    if (!answered.ok) throw new Error(`Saki Agent Run snapshot answer failed: ${answered.reason}`)
    expect(answered.receipt.state).toBe('resolved')
    await waitForModelRequests(second, 1)
    const clearedWork = await waitForInterventionCleared(
      port,
      cookie,
      workItem.id,
      restartedOpen.intervention.id,
    )
    expect(clearedWork).toMatchObject({
      group: 'active',
      run: { id: given.receipt.agentRunId, state: 'running' },
      recommendation: { available: false, reason: 'active-work' },
    })
    const secondProcess = second
    await secondProcess.stop()
    second = undefined
    const secondSummary = summary(secondProcess.records)
    expect(secondSummary).toMatchObject({ modelRequests: 1 })
    expect(secondSummary.durableInputs).toEqual(firstSummary.durableInputs)
    expect(secondSummary.durableInputInsertions).toEqual(firstSummary.durableInputInsertions)
    expect(secondSummary.durableInterventionAnswerInputs).toHaveLength(1)
    expect(secondSummary.durableInterventionAnswerInputInsertions).toHaveLength(1)
    expect(secondSummary.durableInterventionAnswerInputSessionIds).toEqual(firstSummary.durableInputSessionIds)
    expect(secondSummary.modelInterventionAnswerInput).toEqual(secondSummary.durableInterventionAnswerInputs[0])
    expect(secondSummary.durableInterventionAnswerInputInsertions[0])
      .toEqual(secondSummary.durableInterventionAnswerInputs[0])
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
        step: 'durable-intervention-after-restart',
        result: {
          intervention: {
            id: restartedOpen.intervention.id,
            revision: restartedOpen.intervention.revision,
            state: restartedOpen.intervention.state,
            prompt: restartedOpen.intervention.requiredAnswer.prompt,
            maxLength: restartedOpen.intervention.requiredAnswer.maxLength,
          },
          myWork: {
            group: restartedOpen.work.group,
            runState: restartedOpen.work.run?.state,
            offer: normalizeAgentValue(recommendation.offer, project.id),
          },
          attention: {
            source: restartedOpen.attention.source,
            severity: restartedOpen.attention.severity,
            requiredResponse: restartedOpen.attention.requiredResponse,
            sameReturnAddress: JSON.stringify(restartedOpen.attention.returnAddress)
              === JSON.stringify(restartedOpen.intervention.returnAddress),
          },
          durableToolLifecycle: normalizeAgentValue(firstSummary.interventionToolLifecycle, project.id),
        },
      },
      {
        step: 'restart-exact-replay',
        result: {
          launcherPurpose: secondProcess.bootstrapPurpose,
          sameReceipt: true,
          waitingProjectionRecovered: true,
          liveSessionCount: recoveredBeforeReplay.liveAgentSessionIds.length,
          modelRequests: replayModelRequests,
          durableInputCount: secondSummary.durableInputs.length,
          providerDispatchCount: mutation.dispatchCount,
        },
      },
      {
        step: 'answer-and-resume',
        result: {
          receipt: normalizeAgentValue(answered.receipt, project.id),
          modelInput: normalizeAgentValue(secondSummary.modelInterventionAnswerInput, project.id),
          durableInput: normalizeAgentValue(secondSummary.durableInterventionAnswerInputs[0], project.id),
          physicallyRecordedOnce: true,
          physicallyInsertedOnce: true,
          sameRun: clearedWork.run?.id === given.receipt.agentRunId,
          sameSession: secondSummary.durableInterventionAnswerInputSessionIds[0]
            === firstSummary.durableInputSessionIds[0],
          pendingCleared: clearedWork.intervention === undefined,
          myWorkGroup: clearedWork.group,
          runState: clearedWork.run?.state,
          recommendation: clearedWork.recommendation,
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
  it('persists an Intervention across restart and resumes the same Run after its answer', async () => {
    await verify()
  })
})
