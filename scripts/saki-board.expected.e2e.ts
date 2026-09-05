/** Keyless source Loader snapshot for the assembled Saki GitHub Board Projection. */

import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  sakiBoardResultSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiMoveWorkItemResultSchema,
  sakiProjectSettingsResultSchema,
} from '@breakfastdapaidang/saki-host-api'
import type {
  SakiBoardProjection,
  SakiProjectSettingsProjection,
  SakiQueryResult,
} from '@breakfastdapaidang/saki-control-plane'
import { describe, expect, it } from 'vitest'
import {
  SAKI_BOARD_SNAPSHOT_CONFIGURATION,
  readSakiBoardSnapshotMutationState,
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
const expected = join(root, 'scripts/tests/expected/saki-board/board.expected.jsonl')
const refreshing = process.env.DSH_SNAPSHOT === 'record' || process.env.DSH_SNAPSHOT === 'refresh'

type BoardResult = SakiQueryResult<'board'>
type ConfirmedBoardProjection = SakiBoardProjection & {
  readonly state: 'confirmed'
  readonly confirmed: NonNullable<SakiBoardProjection['confirmed']>
  readonly checkpoint: NonNullable<SakiBoardProjection['checkpoint']>
  readonly freshness: Exclude<SakiBoardProjection['freshness'], { readonly state: 'unavailable' }>
}

function isConfirmedProjection(projection: SakiBoardProjection): projection is ConfirmedBoardProjection {
  return projection.state === 'confirmed'
    && projection.confirmed !== undefined
    && projection.checkpoint !== undefined
    && projection.freshness.state !== 'unavailable'
}

function requireConfirmed(result: BoardResult): ConfirmedBoardProjection | undefined {
  if (!result.ok || !isConfirmedProjection(result.projection)) return undefined
  return result.projection
}

async function queryBoard(
  port: number,
  cookie: string,
  projectId: string,
  refresh: 'cached' | 'interactive' = 'cached',
): Promise<BoardResult> {
  const response = await rpc(port, 'control/query', {
    type: 'board',
    projectId,
    refresh,
  }, { cookie })
  return sakiBoardResultSchema.parse(response.value)
}

async function querySettings(
  port: number,
  cookie: string,
  projectId: string,
): Promise<SakiProjectSettingsProjection> {
  const response = await rpc(port, 'control/query', {
    type: 'project-settings',
    projectId,
  }, { cookie })
  const result = sakiProjectSettingsResultSchema.parse(response.value)
  if (!result.ok) throw new Error(`Saki Board snapshot settings query failed: ${result.reason}`)
  return result.projection
}

async function waitForSettings(
  port: number,
  cookie: string,
  projectId: string,
  accepts: (projection: SakiProjectSettingsProjection) => boolean,
): Promise<SakiProjectSettingsProjection> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const projection = await querySettings(port, cookie, projectId)
    if (accepts(projection)) return projection
    await delay(20)
  }
  throw new Error('Saki Board snapshot did not reach the expected settings state')
}

async function waitForConfirmedBoard(
  port: number,
  cookie: string,
  projectId: string,
  accepts: (projection: ConfirmedBoardProjection) => boolean,
): Promise<ConfirmedBoardProjection> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const projection = requireConfirmed(await queryBoard(port, cookie, projectId))
    if (projection !== undefined && accepts(projection)) return projection
    await delay(20)
  }
  throw new Error('Saki Board snapshot did not reach the expected confirmed state')
}

function summarizeCheckpoint(checkpoint: ConfirmedBoardProjection['checkpoint']): object {
  const rateLimit = checkpoint.rateLimit
  return {
    generation: checkpoint.generation,
    configurationRevision: checkpoint.configurationRevision,
    installationId: checkpoint.installationId,
    repositoryId: checkpoint.repositoryId,
    projectId: checkpoint.projectId,
    statusFieldId: checkpoint.statusFieldId,
    sourceFingerprint: checkpoint.sourceFingerprint,
    observation: 'recorded',
    confirmation: 'recorded',
    rateLimit: rateLimit.state === 'available'
      ? { state: rateLimit.state, minimumRemaining: rateLimit.minimumRemaining }
      : { state: rateLimit.state },
  }
}

function summarizeFreshness(projection: ConfirmedBoardProjection): object {
  return {
    availability: 'available',
    checkpointMatched: projection.freshness.confirmedAt === projection.checkpoint.confirmedAt,
  }
}

function summarizeMapping(mapping: SakiBoardProjection['mapping']): object {
  if (mapping.state === 'valid') {
    return {
      state: mapping.state,
      configurationRevision: mapping.configurationRevision,
      validation: 'checkpoint-confirmed',
    }
  }
  return mapping
}

function summarizeScan(scan: SakiBoardProjection['scan']): object {
  if (scan.state === 'idle') return { state: scan.state }
  if (scan.state === 'scheduled') {
    return { state: scan.state, priority: scan.priority, reason: scan.reason }
  }
  return {
    state: scan.state,
    priority: scan.priority,
    configurationRevision: scan.configurationRevision,
  }
}

async function setProviderState(path: string, state: string): Promise<void> {
  const temporaryPath = `${path}.next`
  await writeFile(temporaryPath, `${state}\n`)
  await rename(temporaryPath, path)
}

async function transcript(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'saki-board-snapshot-'))
  let first: StartedSaki | undefined
  let second: StartedSaki | undefined
  let third: StartedSaki | undefined
  return await runWithCleanup(async () => {
    const runtimeRoot = join(directory, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const providerStatePath = join(directory, 'provider-state')
    await setProviderState(providerStatePath, 'hold')
    const repository = await createRepository(directory)
    const databasePath = join(directory, 'control.sqlite')
    const port = await freePort()
    first = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      boardProviderEnabled: false,
      boardProviderStatePath: providerStatePath,
    })
    const bootstrapSecret = first.bootstrapSecret
    const {
      exchangeValue,
      cookie,
      confirmed: registration,
    } = await registerSnapshotProject(port, bootstrapSecret, repository)
    const configurationResponse = await rpc(port, 'control/submit', {
      type: 'configure-github-synchronization',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectId: registration.receipt.projectId,
      expectedSynchronizationRevision: 0,
      patch: SAKI_BOARD_SNAPSHOT_CONFIGURATION,
    }, { cookie, requestToken: exchangeValue.access.requestToken })
    const configured = sakiConfigureGitHubSynchronizationResultSchema.parse(configurationResponse.value)
    if (!configured.ok) throw new Error(`Saki Board snapshot configuration failed: ${configured.reason}`)
    const savedBoardResult = await queryBoard(port, cookie, registration.receipt.projectId)
    if (!savedBoardResult.ok || savedBoardResult.projection.state !== 'awaiting-first-checkpoint') {
      throw new Error('Saki Board snapshot did not retain its saved pre-checkpoint Board state')
    }
    const savedSettings = await querySettings(port, cookie, registration.receipt.projectId)
    if (savedSettings.synchronization.state !== 'saved'
      || savedSettings.synchronization.active !== undefined
      || savedSettings.synchronization.pending === undefined) {
      throw new Error('Saki Board snapshot configuration did not remain saved without a Provider')
    }
    const records: unknown[] = [{
      step: 'configuration-saved',
      result: {
        receiptState: configured.receipt.state,
        synchronizationRevision: configured.receipt.synchronizationRevision,
        candidateRevision: configured.receipt.candidateRevision,
        boardState: savedBoardResult.projection.state,
        settingsState: savedSettings.synchronization.state,
        activeConfiguration: 'absent',
        pendingRevision: savedSettings.synchronization.pending.revision,
        pendingConfiguration: savedSettings.synchronization.pending.configuration,
        mapping: summarizeMapping(savedBoardResult.projection.mapping),
        scan: summarizeScan(savedBoardResult.projection.scan),
        effectiveMutationAvailability: savedBoardResult.projection.effectiveMutationAvailability,
      },
    }]

    await first.stop()
    first = undefined
    second = await startSaki(driver, databasePath, port, true, runtimeRoot, {
      boardProviderEnabled: true,
      boardProviderStatePath: providerStatePath,
    })
    const activatingSettings = await waitForSettings(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.synchronization.state === 'activating'
        && projection.synchronization.scan.state === 'in-flight',
    )
    const activatingBoardResult = await queryBoard(port, cookie, registration.receipt.projectId)
    if (!activatingBoardResult.ok
      || activatingBoardResult.projection.state !== 'awaiting-first-checkpoint'
      || activatingSettings.synchronization.pending === undefined) {
      throw new Error('Saki Board snapshot did not expose pre-checkpoint activation')
    }
    records.push({
      step: 'configuration-activating',
      result: {
        launcherPurpose: second.bootstrapPurpose,
        boardState: activatingBoardResult.projection.state,
        settingsState: activatingSettings.synchronization.state,
        activeConfiguration: 'absent',
        pendingRevision: activatingSettings.synchronization.pending.revision,
        mapping: summarizeMapping(activatingBoardResult.projection.mapping),
        scan: summarizeScan(activatingBoardResult.projection.scan),
        effectiveMutationAvailability: activatingBoardResult.projection.effectiveMutationAvailability,
      },
    })

    await setProviderState(providerStatePath, 'complete')
    const initialBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.scan.state === 'scheduled' && projection.scan.reason === 'poll',
    )
    const settings = await querySettings(port, cookie, registration.receipt.projectId)
    if (settings.synchronization.state !== 'activated'
      || settings.synchronization.active === undefined) {
      throw new Error('Saki Board snapshot configuration did not activate')
    }
    expect(settings.synchronization.active.configuration)
      .toEqual(SAKI_BOARD_SNAPSHOT_CONFIGURATION)
    const initialConfirmed = structuredClone(initialBoard.confirmed)
    const initialCheckpoint = structuredClone(initialBoard.checkpoint)
    expect(initialBoard.mutationOverlays).toEqual([])
    records.push(
      {
        step: 'configuration-activated',
        result: {
          boardState: initialBoard.state,
          settingsState: settings.synchronization.state,
          activeRevision: settings.synchronization.active.revision,
          activeConfiguration: settings.synchronization.active.configuration,
          pendingConfiguration: 'absent',
          mapping: summarizeMapping(initialBoard.mapping),
        },
      },
      {
        step: 'confirmed-board',
        result: {
          synchronizationRevision: initialBoard.synchronizationRevision,
          confirmed: initialBoard.confirmed,
          checkpoint: summarizeCheckpoint(initialBoard.checkpoint),
          freshness: summarizeFreshness(initialBoard),
          scan: summarizeScan(initialBoard.scan),
          effectiveMutationAvailability: initialBoard.effectiveMutationAvailability,
        },
      },
    )

    await setProviderState(providerStatePath, 'hold')
    const movingItem = initialBoard.confirmed.items.find(item => item.issueNumber === 27)
    if (movingItem === undefined) throw new Error('Saki Board snapshot has no movable Issue')
    const moveIntent = {
      type: 'move-work-item',
      intentId: 'intent-33333333-3333-4333-8333-333333333333',
      projectId: registration.receipt.projectId,
      workItemId: movingItem.id,
      expectedRemoteFingerprint: movingItem.remoteFingerprint,
      targetStatus: 'in-review',
    } as const
    const moveResponse = await rpc(port, 'control/submit', moveIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const moveResult = sakiMoveWorkItemResultSchema.parse(moveResponse.value)
    if (!moveResult.ok) throw new Error(`Saki Board snapshot move failed: ${moveResult.reason}`)
    const targetedBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.scan.state === 'in-flight'
        && projection.mutationOverlays.some(overlay => overlay.state === 'targeted-confirmed'),
    )
    const targetedOverlay = targetedBoard.mutationOverlays.find(
      overlay => overlay.state === 'targeted-confirmed' && overlay.intentId === moveIntent.intentId,
    )
    if (targetedOverlay?.state !== 'targeted-confirmed') {
      throw new Error('Saki Board snapshot did not expose targeted mutation evidence')
    }
    const dispatchedState = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(targetedBoard.confirmed).toEqual(initialConfirmed)
    expect(targetedBoard.checkpoint).toEqual(initialCheckpoint)
    expect(dispatchedState.dispatchCount).toBe(1)
    records.push({
      step: 'targeted-move-confirmed',
      result: {
        receiptState: moveResult.receipt.state,
        targetStatus: targetedOverlay.workItem.status,
        issueNumber: targetedOverlay.workItem.issueNumber,
        dispatchCount: dispatchedState.dispatchCount,
        sameConfirmedBoard: true,
        sameCheckpoint: true,
        generation: targetedBoard.checkpoint.generation,
        overlayState: targetedOverlay.state,
        scan: summarizeScan(targetedBoard.scan),
      },
    })

    await second.stop()
    second = undefined
    third = await startSaki(driver, databasePath, port, true, runtimeRoot, { boardProviderStatePath: providerStatePath })
    const restoredBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.scan.state === 'in-flight'
        && projection.scan.priority === 'interactive'
        && projection.mutationOverlays.some(overlay => overlay.state === 'targeted-confirmed'),
    )
    expect(restoredBoard.confirmed).toEqual(initialConfirmed)
    expect(restoredBoard.checkpoint).toEqual(initialCheckpoint)
    const beforeReplay = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(beforeReplay.dispatchCount).toBe(1)
    records.push({
      step: 'restart-restoration',
      result: {
        launcherPurpose: third.bootstrapPurpose,
        boardState: restoredBoard.state,
        synchronizationRevision: restoredBoard.synchronizationRevision,
        sameConfirmedBoard: true,
        sameCheckpoint: true,
        provider: 'held-during-startup-scan',
        dispatchCount: beforeReplay.dispatchCount,
        mutationOverlay: restoredBoard.mutationOverlays[0]?.state,
        mapping: summarizeMapping(restoredBoard.mapping),
        freshness: summarizeFreshness(restoredBoard),
        scan: summarizeScan(restoredBoard.scan),
        effectiveMutationAvailability: restoredBoard.effectiveMutationAvailability,
      },
    })

    const replayResponse = await rpc(port, 'control/submit', moveIntent, {
      cookie,
      requestToken: exchangeValue.access.requestToken,
    })
    const replayResult = sakiMoveWorkItemResultSchema.parse(replayResponse.value)
    expect(replayResult).toEqual(moveResult)
    const afterReplay = await readSakiBoardSnapshotMutationState(providerStatePath)
    expect(afterReplay.dispatchCount).toBe(1)
    records.push({
      step: 'exact-move-replay',
      result: {
        receiptState: replayResult.ok ? replayResult.receipt.state : replayResult.reason,
        sameReceipt: true,
        dispatchCount: afterReplay.dispatchCount,
        scan: summarizeScan(restoredBoard.scan),
      },
    })

    await setProviderState(providerStatePath, 'complete')
    const convergedBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.checkpoint.generation > initialCheckpoint.generation
        && projection.mutationOverlays.length === 0
        && projection.confirmed.items.some(item => item.id === movingItem.id && item.status === 'in-review'),
    )
    const convergedItem = convergedBoard.confirmed.items.find(item => item.id === movingItem.id)
    if (convergedItem === undefined) throw new Error('Saki Board snapshot lost its moved Work Item')
    const convergedConfirmed = structuredClone(convergedBoard.confirmed)
    const convergedCheckpoint = structuredClone(convergedBoard.checkpoint)
    records.push({
      step: 'complete-scan-retires-move-overlay',
      result: {
        generationBefore: initialCheckpoint.generation,
        generationAfter: convergedBoard.checkpoint.generation,
        status: convergedItem.status,
        mutationOverlays: convergedBoard.mutationOverlays,
        dispatchCount: (await readSakiBoardSnapshotMutationState(providerStatePath)).dispatchCount,
        checkpointAdvanced: true,
      },
    })

    await setProviderState(providerStatePath, 'transient-transport')
    await queryBoard(port, cookie, registration.receipt.projectId, 'interactive')
    const failedBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.failure?.failure.kind === 'provider'
        && projection.failure.failure.failure.code === 'transient-transport'
        && projection.scan.state === 'scheduled'
        && projection.scan.reason === 'retry',
    )
    expect(failedBoard.confirmed).toEqual(convergedConfirmed)
    expect(failedBoard.checkpoint).toEqual(convergedCheckpoint)
    if (failedBoard.failure?.failure.kind !== 'provider') {
      throw new Error('Saki Board snapshot did not retain a provider failure')
    }
    records.push({
      step: 'provider-failure-retention',
      result: {
        boardState: failedBoard.state,
        synchronizationRevision: failedBoard.synchronizationRevision,
        sameConfirmedBoard: true,
        sameCheckpoint: true,
        failure: {
          configurationRevision: failedBoard.failure.configurationRevision,
          kind: failedBoard.failure.failure.kind,
          code: failedBoard.failure.failure.failure.code,
          retryAfterMs: failedBoard.failure.failure.failure.code === 'transient-transport'
            ? failedBoard.failure.failure.failure.retryAfterMs
            : undefined,
        },
        mapping: summarizeMapping(failedBoard.mapping),
        freshness: summarizeFreshness(failedBoard),
        scan: summarizeScan(failedBoard.scan),
        effectiveMutationAvailability: failedBoard.effectiveMutationAvailability,
      },
    })
    await setProviderState(providerStatePath, 'capacity')
    await queryBoard(port, cookie, registration.receipt.projectId, 'interactive')
    const capacityBoard = await waitForConfirmedBoard(
      port,
      cookie,
      registration.receipt.projectId,
      projection => projection.failure?.failure.kind === 'capacity'
        && projection.scan.state === 'scheduled'
        && projection.scan.reason === 'retry',
    )
    expect(capacityBoard.confirmed).toEqual(convergedConfirmed)
    expect(capacityBoard.checkpoint).toEqual(convergedCheckpoint)
    if (capacityBoard.failure?.failure.kind !== 'capacity') {
      throw new Error('Saki Board snapshot did not retain a capacity failure')
    }
    records.push({
      step: 'capacity-failure-retention',
      result: {
        boardState: capacityBoard.state,
        synchronizationRevision: capacityBoard.synchronizationRevision,
        sameConfirmedBoard: true,
        sameCheckpoint: true,
        failure: {
          configurationRevision: capacityBoard.failure.configurationRevision,
          kind: capacityBoard.failure.failure.kind,
          resource: capacityBoard.failure.failure.resource,
          limit: capacityBoard.failure.failure.limit,
          observed: capacityBoard.failure.failure.observed,
        },
        mapping: summarizeMapping(capacityBoard.mapping),
        freshness: summarizeFreshness(capacityBoard),
        scan: summarizeScan(capacityBoard.scan),
        effectiveMutationAvailability: capacityBoard.effectiveMutationAvailability,
      },
    })
    const output = serializeSnapshotRecords(
      records,
      [directory, repository, providerStatePath, bootstrapSecret, cookie, exchangeValue.access.requestToken],
    )
    await third.stop()
    third = undefined
    return output
  }, async () => { await cleanupSnapshot(directory, first, second, third) })
}

async function verify(): Promise<void> {
  const output = await transcript()
  await verifySnapshotOutput(expected, output, refreshing)
}

describe('assembled Saki GitHub Board snapshot', () => {
  it('recovers a targeted Work Item move without advancing its complete Board early', async () => {
    await verify()
  })
})
