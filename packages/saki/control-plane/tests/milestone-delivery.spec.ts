import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { cloneLosslessJsonValue } from '@deepseek-ai/dsh-storage'
import { describe, expect, it } from 'vitest'
import {
  GitHubProviderError,
  githubCommitId,
  githubCommitStatusId,
  githubIssueId,
  githubMilestoneId,
  githubProjectId,
  githubPullRequestId,
  githubReleaseId,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import {
  sakiBoardRemoteFingerprintSchema,
  sakiBoardWorkItemIdSchema,
  sakiControlIntentIdSchema,
  sakiDevelopmentProjectIdSchema,
} from '../src/ids.ts'
import {
  MilestoneDeliveryOperations,
  milestoneDeliveryId,
  milestoneDeliveryIntentRecordSchema,
  milestoneDeliveryRecordSchema,
  projectMilestoneDelivery,
  type MilestoneDeliveryIntentRecord,
  type MilestoneDeliveryOperationsOptions,
  type MilestoneDeliveryRecord,
} from '../src/milestone-delivery.ts'
import type { ReleaseEvidencePolicyV1Snapshot } from '../src/release-evidence-policy.ts'
import { controlIntentActorSchema } from '../src/spec.ts'

const PROJECT_ID = sakiDevelopmentProjectIdSchema.parse('project-00000000-0000-4000-8000-000000000301')
const SAVE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000302')
const UPDATE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000308')
const STALE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000309')
const FINALIZE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000310')
const DRIFT_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000311')
const AFTER_RELEASE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000312')
const CRASH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000313')
const CONCURRENT_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000314')
const SAVE_CRASH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000315')
const REPAIR_RETRY_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000316')
const REPAIR_CRASH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000317')
const CONTEXT_DRIFT_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000318')
const REPAIR_REVOKED_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000319')
const PROVIDER_RECOVERY_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000320')
const STARTUP_DEFERRED_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000321')
const FIRST_BATCH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000322')
const SECOND_BATCH_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000323')
const SECOND_BATCH_SAVE_INTENT_ID = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000324')
const REPOSITORY_ID = githubRepositoryId('R_delivery')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('12')
const GITHUB_PROJECT_ID = githubProjectId('P_delivery')
const MILESTONE_ID = githubMilestoneId('M_delivery')
const SECOND_MILESTONE_ID = githubMilestoneId('M_delivery_second')
const RELEASE_COMMIT_ID = githubCommitId('1'.repeat(40))
const UPSTREAM_REPOSITORY_ID = githubRepositoryId('R_upstream')
const UPSTREAM_REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('34')
const UPSTREAM_COMMIT_ID = githubCommitId('2'.repeat(40))
const ISSUE_ID = githubIssueId('I_delivery')
const WORK_ITEM_ID = sakiBoardWorkItemIdSchema.parse(`work-item-${'3'.repeat(64)}`)
const REMOTE_FINGERPRINT = sakiBoardRemoteFingerprintSchema.parse(`remote-fingerprint-${'4'.repeat(64)}`)

const ACTOR = controlIntentActorSchema.parse({
  installationId: 'installation-00000000-0000-4000-8000-000000000303',
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000304',
  hostId: 'host-00000000-0000-4000-8000-000000000305',
  principalId: 'principal-00000000-0000-4000-8000-000000000306',
  principalRevision: 1,
  grantId: 'grant-00000000-0000-4000-8000-000000000307',
  grantRevision: 2,
})

class MemoryTable<K extends string, V> implements KvTable<K, V> {
  readonly values = new Map<K, V>()
  failNextUpdate: Error | undefined
  beforeUpdate: ((key: K) => void) | undefined
  get size(): number { return this.values.size }
  get(key: K): V | undefined { return this.values.get(key) }
  entries(): IterableIterator<[K, V]> { return new Map(this.values).entries() }
  keys(): IterableIterator<K> { return new Map(this.values).keys() }
  async put(key: K, value: V): Promise<void> { this.values.set(key, cloneLosslessJsonValue(value)) }
  async delete(key: K): Promise<boolean> { return this.values.delete(key) }
  async update(key: K, operation: (current: V) => V): Promise<V> {
    if (this.failNextUpdate !== undefined) {
      const error = this.failNextUpdate
      this.failNextUpdate = undefined
      throw error
    }
    this.beforeUpdate?.(key)
    const current = this.values.get(key)
    if (current === undefined) throw new Error('missing key')
    const next = cloneLosslessJsonValue(operation(structuredClone(current)))
    this.values.set(key, next)
    return structuredClone(next)
  }
}

describe('MilestoneDeliveryOperations', () => {
  it('retains the newest source facts and failure times across delayed and empty refreshes', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    const latest = releaseSnapshot(200, 200)
    harness.viewTransform.current = () => ({
      ...latest,
      upstreamCommit: {
        ...latest.upstreamCommit,
        failure: { failure: { code: 'transient-transport' }, failedAt: 300 },
        invalidatedAt: 400,
      },
    })
    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: true })
    const retained = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id)).sources.upstreamCommit
    harness.viewTransform.current = () => ({
      ...releaseSnapshot(100, 100),
      upstreamCommit: {
        ...releaseSnapshot(100, 100).upstreamCommit,
        failure: { failure: { code: 'transient-transport' }, failedAt: 250 },
        invalidatedAt: 350,
      },
    })
    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: true })
    expect(harness.deliveries.get(id)?.sources.upstreamCommit).toEqual(retained)
    harness.viewTransform.current = snapshot => ({
      ...snapshot, milestone: {}, tag: {}, release: {}, releaseCommit: {}, upstreamCommit: {}, upstreamAncestry: {},
    })
    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: true })
    expect(harness.deliveries.get(id)?.sources.upstreamCommit).toEqual(retained)
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0, sources: { revision: 3 } })
  })

  it('retains unavailable sources without inventing confirmations', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    harness.viewTransform.current = snapshot => ({
      ...snapshot, milestone: {}, tag: {}, release: {}, releaseCommit: {}, upstreamCommit: {}, upstreamAncestry: {},
    })
    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: true })
    expect(harness.deliveries.get(id)?.sources.milestone).toEqual({})
  })

  it('propagates storage failures during source retention without changing metadata', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    const failure = new Error('storage unavailable during refresh')
    harness.deliveries.failNextUpdate = failure
    await expect(harness.operations.refresh(id, signal())).rejects.toThrow(failure)
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0, sources: { revision: 0 } })
  })

  it('rejects a retained absent Release observation for a different tag', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    const record = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
    const sources = { ...record.sources, release: { confirmed: {
      observedAt: record.updatedAt,
      value: {
        kind: 'absent', repositoryId: REPOSITORY_ID, tagName: githubReleaseTagName('saki-v0.2.0'),
        observedAt: record.updatedAt,
      },
    } } }
    expect(() => milestoneDeliveryRecordSchema.parse({ ...record, sources })).toThrow('source target disagrees')
  })

  it.each([0, 10])('orders recovered Milestones and Intents deterministically with a %s ms timestamp gap', async (gap) => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    await harness.operations.submit({
      ...saveIntent(SECOND_BATCH_SAVE_INTENT_ID, null, 'planned'),
      release: { ...releaseExpectation(), milestoneId: SECOND_MILESTONE_ID, milestoneNumber: 2 },
    }, ACTOR, signal())
    let createdAt = 100
    for (const [id, record] of harness.deliveries.entries()) {
      harness.deliveries.values.set(id, { ...record, createdAt })
      createdAt += gap
    }
    createdAt = 100
    for (const [id, record] of harness.intents.entries()) {
      harness.intents.values.set(id, { ...record, createdAt })
      createdAt += gap
    }
    const state = harness.createOperations().validateDurableState(new Set())
    const ids = [milestoneDeliveryId(PROJECT_ID, MILESTONE_ID), milestoneDeliveryId(PROJECT_ID, SECOND_MILESTONE_ID)]
    expect(state.deliveries.map(record => record.id)).toEqual(gap === 0 ? ids.toSorted() : ids)
    expect(state.intents.map(record => record.id)).toEqual([SAVE_INTENT_ID, SECOND_BATCH_SAVE_INTENT_ID])
  })

  it.each([
    ['evaluation', 1, false], ['final-reread', 2, false],
    ['finalization', 3, false], ['repair', 3, true],
  ] as const)('preserves a concurrent metadata write during %s', async (_name, updateNumber, repair) => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    if (repair) {
      harness.finalRereadTransform.current = (snapshot) => {
        const milestone = snapshot.milestone.confirmed
        if (milestone === undefined) throw new Error('missing fixture Milestone')
        return { ...snapshot, milestone: { confirmed: {
          ...milestone, value: { ...milestone.value, state: 'closed' },
        } } }
      }
    }
    let updates = 0
    harness.deliveries.beforeUpdate = () => {
      if (++updates !== updateNumber) return
      const current = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
      harness.deliveries.values.set(id, { ...current, revision: current.revision + 1 })
    }
    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery', intentId: FINALIZE_INTENT_ID, deliveryId: id,
      expectedDeliveryRevision: 0, release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 1 })
    expect(harness.deliveries.get(id)).not.toHaveProperty('releaseEvidence')
    expect(harness.deliveries.get(id)).not.toHaveProperty('repair')
  })

  it.each([false, true])('retains a prepared finalization when its final storage write fails (repair: %s)', async (repair) => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    if (repair) {
      harness.finalRereadTransform.current = (snapshot) => {
        const milestone = snapshot.milestone.confirmed
        if (milestone === undefined) throw new Error('missing fixture Milestone')
        return { ...snapshot, milestone: { confirmed: {
          ...milestone, value: { ...milestone.value, state: 'closed' },
        } } }
      }
    }
    const failure = new Error('storage unavailable at final commit')
    let updates = 0
    harness.deliveries.beforeUpdate = () => { if (++updates === 3) throw failure }
    const intent = {
      type: 'finalize-milestone-delivery' as const, intentId: FINALIZE_INTENT_ID, deliveryId: id,
      expectedDeliveryRevision: 0, release: releaseExpectation(),
    }
    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow(failure)
    expect(harness.intents.get(FINALIZE_INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0 })
    harness.deliveries.beforeUpdate = undefined
    expect(await harness.createOperations().submit(intent, ACTOR, signal())).toMatchObject({
      receipt: { state: repair ? 'reconciliation-required' : 'succeeded', deliveryRevision: 1 },
    })
    expect(() => harness.createOperations().validateDurableState(new Set())).not.toThrow()
  })

  it('reports a refresh conflict without replacing newer metadata', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    harness.afterRead.current = async () => {
      const current = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
      harness.deliveries.values.set(id, { ...current, revision: 1 })
    }
    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 1, sources: { revision: 0 } })
  })

  it('leaves a phase write recoverable when storage changes its selected revision', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    harness.deliveries.beforeUpdate = () => {
      const current = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
      harness.deliveries.values.set(id, { ...current, revision: 1 })
    }
    const intent = saveIntent(UPDATE_INTENT_ID, 0, 'in-progress')
    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow()
    expect(harness.intents.get(UPDATE_INTENT_ID)).toMatchObject({ phase: 'prepared' })
    harness.deliveries.beforeUpdate = undefined
    expect(await harness.createOperations().submit(intent, ACTOR, signal())).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 1, phase: 'planned' })
  })

  it('does not read GitHub when refreshing a missing Milestone Delivery', async () => {
    const harness = createHarness()
    expect(await harness.operations.refresh(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID), signal()))
      .toEqual({ ok: false, reason: 'not-found' })
    expect(harness.readPasses).toEqual([])
  })

  it('replays terminal receipts but rejects reuse of an Intent id with a different payload', async () => {
    const harness = createHarness()
    const intent = saveIntent(SAVE_INTENT_ID, null, 'planned')
    const result = await harness.operations.submit(intent, ACTOR, signal())
    expect(await harness.createOperations().submit(intent, ACTOR, signal())).toEqual(result)
    expect(await harness.operations.submit({ ...intent, phase: 'canceled' }, ACTOR, signal()))
      .toEqual({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)))
      .toMatchObject({ revision: 0, phase: 'planned' })
  })

  it('retains a denied Save without creating Milestone metadata', async () => {
    const harness = createHarness()
    harness.authority.current = false
    expect(await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal()))
      .toMatchObject({ ok: false, reason: 'denied', receipt: { state: 'denied' } })
    expect(harness.deliveries.size).toBe(0)
    expect(harness.intents.get(SAVE_INTENT_ID)).toMatchObject({ phase: 'denied' })
  })

  it.each(['registry', 'project', 'repository', 'board', 'missing-revision'] as const)(
    'rejects stale %s evidence before saving Milestone metadata', async (changed) => {
      const harness = createHarness()
      const intent = saveIntent(SAVE_INTENT_ID, changed === 'missing-revision' ? 0 : null, 'planned')
      if (changed === 'registry') harness.context.current.registryRevision += 1
      if (changed === 'project') harness.context.current.projectRevision += 1
      if (changed === 'repository') harness.context.current.repositoryId = UPSTREAM_REPOSITORY_ID
      if (changed === 'board') harness.context.current.projectId = githubProjectId('P_other')
      expect(await harness.operations.submit(intent, ACTOR, signal())).toMatchObject({ ok: false, reason: 'conflict' })
      expect(harness.deliveries.size).toBe(0)
      expect(harness.readPasses).toEqual([])
    },
  )

  it.each(['missing', 'authority', 'revision', 'phase', 'release', 'project', 'context'] as const)(
    'rejects %s finalization preconditions before reading release evidence', async (changed) => {
      const harness = createHarness()
      const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
      if (changed !== 'missing') {
        await harness.operations.submit(saveIntent(
          SAVE_INTENT_ID, null, changed === 'phase' ? 'planned' : 'ready-to-release',
        ), ACTOR, signal())
      }
      if (changed === 'authority') harness.authority.current = false
      if (changed === 'project') harness.projectPresent.current = false
      if (changed === 'context') harness.context.current.projectRevision += 1
      const release = releaseExpectation()
      expect(await harness.operations.submit({
        type: 'finalize-milestone-delivery', intentId: FINALIZE_INTENT_ID, deliveryId: id,
        expectedDeliveryRevision: changed === 'revision' ? 1 : 0,
        release: changed === 'release' ? { ...release, releaseCommitId: UPSTREAM_COMMIT_ID } : release,
      }, ACTOR, signal())).toMatchObject({
        ok: false,
        reason: changed === 'authority' ? 'denied' : changed === 'project' ? 'unavailable' : 'conflict',
      })
      expect(harness.readPasses).toEqual([])
      expect(harness.deliveries.get(id)?.releaseEvidence).toBeUndefined()
    },
  )

  it.each([
    ['authority', false, 'denied'],
    ['project', false, 'unavailable'],
    ['project', true, 'unavailable'],
    ['context', true, 'conflict'],
  ] as const)('rechecks %s after the final reread (repair: %s)', async (changed, repair, reason) => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    if (repair) {
      harness.finalRereadTransform.current = (snapshot) => {
        const milestone = snapshot.milestone.confirmed
        if (milestone === undefined) throw new Error('missing fixture Milestone')
        return { ...snapshot, milestone: { confirmed: {
          ...milestone, value: { ...milestone.value, state: 'closed' },
        } } }
      }
    }
    harness.afterRead.current = async (pass) => {
      if (pass !== 'final-reread') return
      if (changed === 'authority') harness.authority.current = false
      if (changed === 'project') harness.projectPresent.current = false
      if (changed === 'context') harness.context.current.projectRevision += 1
    }
    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery', intentId: FINALIZE_INTENT_ID, deliveryId: id,
      expectedDeliveryRevision: 0, release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: false, reason })
    expect(harness.readPasses).toEqual(['evaluation', 'final-reread'])
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0 })
    expect(harness.deliveries.get(id)).not.toHaveProperty('releaseEvidence')
    expect(harness.deliveries.get(id)).not.toHaveProperty('repair')
  })

  it.each<readonly [string, (record: MilestoneDeliveryRecord) => unknown, string]>([
    ['backward timestamps', record => ({ ...record, updatedAt: record.createdAt - 1 }), 'timestamps are not monotonic'],
    ['another aggregate id', record => ({ ...record, id: milestoneDeliveryId(PROJECT_ID, SECOND_MILESTONE_ID) }), 'id disagrees'],
    ['sources newer than the aggregate', record => ({ ...record, sources: { ...record.sources, updatedAt: record.updatedAt + 1 } }), 'sources postdate'],
    ['another release phase', record => ({ ...record, phase: 'planned' }), 'not an atomic finalization'],
    ['another finalization Intent', record => ({ ...record, lastIntentId: SAVE_INTENT_ID }), 'not an atomic finalization'],
    ['another metadata revision', record => ({ ...record, revision: record.revision + 1 }), 'not an atomic finalization'],
    ['another evidence embedding time', record => ({
      ...record, releaseEvidence: { ...record.releaseEvidence, embeddedAt: record.updatedAt + 1 },
    }), 'release target disagrees'],
    ['another upstream name', record => ({
      ...record, release: { ...record.release, upstreamRepositoryNameWithOwner: 'other/upstream' },
    }), 'release target disagrees'],
    ['another Milestone source', record => ({
      ...record, release: { ...record.release, milestoneNumber: 2 },
    }), 'source target disagrees'],
    ['another tag source', record => ({
      ...record, release: { ...record.release, tagName: githubReleaseTagName('saki-v0.2.0') },
    }), 'source target disagrees'],
    ['another release commit source', record => ({
      ...record, release: { ...record.release, releaseCommitId: UPSTREAM_COMMIT_ID },
    }), 'source target disagrees'],
    ['another upstream commit source', record => ({
      ...record, release: { ...record.release, upstreamCommitId: RELEASE_COMMIT_ID },
    }), 'source target disagrees'],
    ['an unrelated repair Intent', record => ({
      ...record,
      repair: {
        intentId: SAVE_INTENT_ID, priorRevision: 0, reason: 'concurrent-github-change',
        blockages: [{ kind: 'final-reread-mismatch' }], recordedAt: record.updatedAt,
      },
    }), 'repair is not an atomic observation'],
  ])('rejects a persisted finalized Milestone with %s', async (_name, corrupt, message) => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery', intentId: FINALIZE_INTENT_ID, deliveryId: id,
      expectedDeliveryRevision: 0, release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: true })
    const record = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
    const parsed = milestoneDeliveryRecordSchema.safeParse(corrupt(record))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('inconsistent Milestone was accepted')
    expect(parsed.error.issues.map(issue => issue.message)).toContainEqual(expect.stringContaining(message))
  })

  it.each<readonly [string, (record: MilestoneDeliveryIntentRecord) => unknown, string]>([
    ['another Intent identity', record => ({ ...record, id: UPDATE_INTENT_ID }), 'identity or timestamps'],
    ['backward timestamps', record => ({ ...record, updatedAt: record.createdAt - 1 }), 'identity or timestamps'],
    ['a missing completion revision', record => ({ ...record, resultDeliveryRevision: undefined }), 'result disagrees'],
    ['an unfinished completion revision', record => ({ ...record, phase: 'prepared' }), 'result disagrees'],
    ['missing blockages', record => ({ ...record, phase: 'reconciliation-required' }), 'blockages disagree'],
    ['unexpected blockages', record => ({ ...record, blockages: [{ kind: 'final-reread-mismatch' }] }), 'blockages disagree'],
    ['a replaced payload digest', record => ({ ...record, payloadDigest: '0'.repeat(64) }), 'payload digest is invalid'],
  ])('rejects a persisted Milestone Intent with %s', async (_name, corrupt, message) => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    const record = milestoneDeliveryIntentRecordSchema.parse(harness.intents.get(SAVE_INTENT_ID))
    const parsed = milestoneDeliveryIntentRecordSchema.safeParse(corrupt(record))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('inconsistent Milestone Intent was accepted')
    expect(parsed.error.issues.map(issue => issue.message)).toContainEqual(expect.stringContaining(message))
  })

  it.each(['delivery-key', 'intent-key', 'intent-target', 'missing-aggregate'] as const)(
    'rejects %s corruption before Milestone recovery reads GitHub', async (corruption) => {
      const harness = createHarness()
      const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
      const otherId = milestoneDeliveryId(PROJECT_ID, SECOND_MILESTONE_ID)
      await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
      const record = milestoneDeliveryRecordSchema.parse(harness.deliveries.get(id))
      const intent = milestoneDeliveryIntentRecordSchema.parse(harness.intents.get(SAVE_INTENT_ID))
      expect(() => harness.operations.validateDurableState(new Set())).not.toThrow()
      const messages = {
        'delivery-key': 'Milestone Delivery id disagrees with its table key',
        'intent-key': 'Milestone Delivery Intent id disagrees with its table key',
        'intent-target': 'Milestone Delivery Intent targets another aggregate',
        'missing-aggregate': 'completed Milestone Delivery Intent targets a missing aggregate',
      }
      if (corruption === 'delivery-key') {
        harness.deliveries.values.delete(id)
        harness.deliveries.values.set(otherId, record)
      } else if (corruption === 'intent-key') {
        harness.intents.values.delete(SAVE_INTENT_ID)
        harness.intents.values.set(UPDATE_INTENT_ID, intent)
      } else if (corruption === 'intent-target') {
        harness.intents.values.set(SAVE_INTENT_ID, { ...intent, deliveryId: otherId })
      } else {
        harness.deliveries.values.delete(id)
      }
      expect(() => harness.createOperations().validateDurableState(new Set())).toThrow(messages[corruption])
      expect(harness.readPasses).toEqual([])
    },
  )

  it('rejects an invalid targeted-observation freshness configuration at construction', () => {
    expect(() => createHarness({ maxObservationAgeMs: 0 })).toThrow(
      'Milestone Delivery observation freshness must be one positive safe integer',
    )
  })

  it('polls only repair-bearing Milestones and can retry an isolated failed pass', async () => {
    const ordinary = createHarness()
    await ordinary.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    await ordinary.operations.pollPending(signal())
    expect(ordinary.readPasses).toEqual([])

    const repaired = createHarness()
    await repaired.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await repaired.deliveries.update(id, value => milestoneDeliveryRecordSchema.parse({
      ...value,
      revision: 1,
      repair: {
        intentId: SAVE_INTENT_ID,
        priorRevision: 0,
        reason: 'concurrent-github-change',
        blockages: [{ kind: 'final-reread-mismatch' }],
        recordedAt: value.updatedAt,
      },
    }))
    const failure = new Error('view failed unexpectedly')
    let fail = true
    repaired.afterRead.current = async (pass) => {
      if (pass === 'view' && fail) {
        fail = false
        throw failure
      }
    }
    await expect(repaired.operations.pollPending(signal())).rejects.toThrow(failure)
    expect(repaired.readPasses).toEqual(['view'])

    await repaired.operations.pollPending(signal())
    expect(repaired.readPasses).toEqual(['view', 'view'])
  })

  it('creates the one current phase record from exact Project evidence', async () => {
    const harness = createHarness()
    const result = await harness.operations.submit({
      type: 'save-milestone-delivery',
      intentId: SAVE_INTENT_ID,
      projectId: PROJECT_ID,
      expectedDeliveryRevision: null,
      expectedRegistryRevision: 4,
      expectedProjectRevision: 2,
      phase: 'planned',
      release: releaseExpectation(),
    }, ACTOR, new AbortController().signal)

    expect(result).toEqual({
      ok: true,
      receipt: {
        intentId: SAVE_INTENT_ID,
        deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
        state: 'succeeded',
        deliveryRevision: 0,
      },
    })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 0,
      projectId: PROJECT_ID,
      phase: 'planned',
      release: releaseExpectation(),
      lastIntentId: SAVE_INTENT_ID,
    })
  })

  it('updates phase metadata only from the exact current revision', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())

    expect(await harness.operations.submit(
      saveIntent(UPDATE_INTENT_ID, 0, 'in-progress'),
      ACTOR,
      signal(),
    )).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 1 } })
    expect(await harness.operations.submit(
      saveIntent(STALE_INTENT_ID, 0, 'ready-to-release'),
      ACTOR,
      signal(),
    )).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 1,
      phase: 'in-progress',
      lastIntentId: UPDATE_INTENT_ID,
    })
    expect(() => harness.createOperations().validateDurableState(new Set())).not.toThrow()
  })

  it('refreshes durable View sources without changing the metadata revision', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'in-progress'), ACTOR, signal())

    expect(await harness.operations.refresh(id, signal())).toEqual({ ok: true })
    expect(harness.readPasses).toEqual(['view'])
    expect(harness.deliveries.get(id)).toMatchObject({
      revision: 0,
      sources: {
        revision: 1,
        milestone: { confirmed: { value: { id: MILESTONE_ID } } },
        releaseCommit: { confirmed: { value: { id: RELEASE_COMMIT_ID } } },
      },
    })
  })

  it('persists a provider failure whose unavailable optional evidence was omitted', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    const failure = new GitHubProviderError({
      code: 'transient-transport',
      retryAfterMs: undefined,
      requestId: undefined,
    }).failure
    harness.finalRereadTransform.current = snapshot => ({
      ...snapshot,
      upstreamCommit: {
        ...snapshot.upstreamCommit,
        failure: { failure, failedAt: snapshot.capturedAt },
      },
    })

    const result = await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FINALIZE_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())

    expect(result).toMatchObject({
      ok: false,
      reason: 'unavailable',
      blockages: [{ kind: 'source-failed', pass: 'final-reread', source: 'upstream-commit' }],
      receipt: { state: 'blocked' },
    })
    const retained = harness.deliveries.get(id)?.sources.upstreamCommit.failure?.failure
    expect(retained).toStrictEqual({ code: 'transient-transport' })
    expect(Object.hasOwn(retained ?? {}, 'retryAfterMs')).toBe(false)
    expect(Object.hasOwn(retained ?? {}, 'requestId')).toBe(false)
  })

  it('atomically embeds fixed-policy evidence after a matching final reread', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())

    const result = await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FINALIZE_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())

    expect(result).toMatchObject({ ok: true, receipt: { state: 'succeeded', deliveryRevision: 1 } })
    expect(harness.readPasses).toEqual(['evaluation', 'final-reread'])
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 1,
      phase: 'ready-to-release',
      releaseEvidence: {
        intentId: FINALIZE_INTENT_ID,
        actor: ACTOR,
        priorMetadataRevision: 0,
        evidence: {
          policy: 'release-evidence/v1',
          projectId: GITHUB_PROJECT_ID,
          milestoneId: MILESTONE_ID,
          upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
          upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
          upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
        },
      },
      sources: {
        revision: 2,
        milestone: { confirmed: { value: { id: MILESTONE_ID } } },
        tag: { confirmed: { value: { peel: { commitId: RELEASE_COMMIT_ID } } } },
        releaseCommit: { confirmed: { value: { id: RELEASE_COMMIT_ID } } },
      },
    })
  })

  it('rejects embedded evidence detached from its release target or final reread time', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FINALIZE_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())
    const record = harness.deliveries.get(id)
    if (record?.releaseEvidence === undefined) throw new Error('release evidence was not embedded')

    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      release: { ...record.release, tagName: githubReleaseTagName('saki-v0.1.1') },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      releaseEvidence: { ...record.releaseEvidence, embeddedAt: record.releaseEvidence.embeddedAt + 1 },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      release: { ...record.release, projectId: githubProjectId('P_other') },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      release: { ...record.release, upstreamRepositoryId: githubRepositoryId('R_other_upstream') },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      release: {
        ...record.release,
        upstreamRepositoryDatabaseId: githubRepositoryDatabaseId('35'),
      },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      release: { ...record.release, upstreamRepositoryNameWithOwner: 'other/upstream' },
    }).success).toBe(false)
    expect(milestoneDeliveryRecordSchema.safeParse({
      ...record,
      sources: {
        ...record.sources,
        releaseCommit: {
          confirmed: {
            value: {
              ...record.sources.releaseCommit.confirmed?.value,
              id: githubCommitId('f'.repeat(40)),
              repositoryId: REPOSITORY_ID,
              url: 'https://github.com/o/r/commit/invalid',
              committedAt: 1_500,
              observedAt: record.sources.updatedAt,
            },
            observedAt: record.sources.updatedAt,
          },
        },
      },
    }).success).toBe(false)
  })

  it('records reconciliation without partial evidence when the final reread changes', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.finalRereadTransform.current = snapshot => ({
      ...snapshot,
      milestone: snapshot.milestone.confirmed === undefined
        ? snapshot.milestone
        : {
          confirmed: {
            ...snapshot.milestone.confirmed,
            value: { ...snapshot.milestone.confirmed.value, title: 'changed externally' },
          },
        },
    })

    const result = await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: DRIFT_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())

    expect(result).toMatchObject({
      ok: false,
      reason: 'reconciliation-required',
      blockages: [{ kind: 'final-reread-mismatch' }],
      receipt: { deliveryRevision: 1 },
    })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 1,
      phase: 'ready-to-release',
      repair: { intentId: DRIFT_INTENT_ID, reason: 'concurrent-github-change' },
    })
    expect(projectMilestoneDelivery(
      harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))!,
      {},
    )).toMatchObject({
      repair: {
        source: 'record',
        blockages: [{ kind: 'final-reread-mismatch' }],
      },
    })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).not.toHaveProperty('releaseEvidence')
  })

  it('does not record reconciliation after authority is revoked during the reread', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.finalRereadTransform.current = snapshot => ({
      ...snapshot,
      milestone: snapshot.milestone.confirmed === undefined
        ? snapshot.milestone
        : {
          confirmed: {
            ...snapshot.milestone.confirmed,
            value: { ...snapshot.milestone.confirmed.value, title: 'changed externally' },
          },
        },
    })
    harness.afterRead.current = async (pass) => {
      if (pass === 'final-reread') harness.authority.current = false
    }

    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: REPAIR_REVOKED_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: false, reason: 'denied' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0, phase: 'ready-to-release' })
    expect(harness.deliveries.get(id)).not.toHaveProperty('repair')
  })

  it('keeps embedded release evidence immutable', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FINALIZE_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())

    expect(await harness.operations.submit(
      saveIntent(AFTER_RELEASE_INTENT_ID, 1, 'canceled'),
      ACTOR,
      signal(),
    )).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 1,
      phase: 'ready-to-release',
      releaseEvidence: { intentId: FINALIZE_INTENT_ID },
    })
  })

  it('recovers a durable finalization acknowledgement without rereading GitHub', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    const intent = {
      type: 'finalize-milestone-delivery' as const,
      intentId: CRASH_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }
    harness.intents.failNextUpdate = new Error('simulated stop before Intent acknowledgement')

    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow('simulated stop')
    expect(harness.deliveries.get(intent.deliveryId)).toMatchObject({
      revision: 1,
      releaseEvidence: { intentId: CRASH_INTENT_ID },
    })

    expect(await harness.createOperations().submit(intent, ACTOR, signal())).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded', deliveryRevision: 1 },
    })
    expect(harness.readPasses).toEqual(['evaluation', 'final-reread'])
  })

  it('finishes a committed finalization acknowledgement locally during startup', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    const intent = {
      type: 'finalize-milestone-delivery' as const,
      intentId: CRASH_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }
    harness.intents.failNextUpdate = new Error('simulated stop before Intent acknowledgement')
    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow('simulated stop')
    harness.afterRead.current = async () => { throw new Error('startup must not read GitHub') }
    const restarted = harness.createOperations()
    const state = restarted.validateDurableState(new Set())

    await restarted.initializeValidated(state, signal())

    expect(harness.intents.get(CRASH_INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      resultDeliveryRevision: 1,
    })
    expect(harness.readPasses).toEqual(['evaluation', 'final-reread'])
  })

  it('finishes a committed reconciliation acknowledgement locally during startup', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.finalRereadTransform.current = snapshot => ({
      ...snapshot,
      milestone: snapshot.milestone.confirmed === undefined
        ? snapshot.milestone
        : {
          confirmed: {
            ...snapshot.milestone.confirmed,
            value: { ...snapshot.milestone.confirmed.value, title: 'changed externally' },
          },
        },
    })
    const intent = {
      type: 'finalize-milestone-delivery' as const,
      intentId: REPAIR_CRASH_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }
    harness.intents.failNextUpdate = new Error('simulated stop before reconciliation acknowledgement')

    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow('simulated stop')
    expect(harness.deliveries.get(id)).toMatchObject({
      revision: 1,
      repair: {
        intentId: REPAIR_CRASH_INTENT_ID,
        reason: 'concurrent-github-change',
        blockages: [{ kind: 'final-reread-mismatch' }],
      },
    })

    harness.afterRead.current = async () => { throw new Error('startup must not read GitHub') }
    const restarted = harness.createOperations()
    await restarted.initializeValidated(restarted.validateDurableState(new Set()), signal())

    expect(harness.intents.get(REPAIR_CRASH_INTENT_ID)).toMatchObject({
      phase: 'reconciliation-required',
      blockages: [{ kind: 'final-reread-mismatch' }],
      resultDeliveryRevision: 1,
    })
    expect(harness.readPasses).toEqual(['evaluation', 'final-reread'])
  })

  it('does not publish evidence across a concurrent metadata revision', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.afterRead.current = async (pass) => {
      if (pass !== 'final-reread') return
      await harness.deliveries.update(id, current => ({
        ...current,
        revision: current.revision + 1,
        phase: 'canceled',
      }))
    }

    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: CONCURRENT_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 1, phase: 'canceled' })
    expect(harness.deliveries.get(id)).not.toHaveProperty('releaseEvidence')
  })

  it('revalidates the Project context after the final GitHub reread', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.afterRead.current = async (pass) => {
      if (pass === 'final-reread') harness.context.current = { ...harness.context.current, projectRevision: 3 }
    }

    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: CONTEXT_DRIFT_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({ ok: false, reason: 'conflict' })
    expect(harness.deliveries.get(id)).toMatchObject({ revision: 0, phase: 'ready-to-release' })
    expect(harness.deliveries.get(id)).not.toHaveProperty('releaseEvidence')
  })

  it('derives Released only from evidence and flags an unclassified external closure', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    const openMilestone = releaseSnapshot(Date.now(), Date.now()).milestone.confirmed
    if (openMilestone === undefined) throw new Error('fixture milestone is missing')
    const closedMilestone = {
      confirmed: {
        ...openMilestone,
        value: { ...openMilestone.value, state: 'closed' as const },
      },
    }

    expect(projectMilestoneDelivery(harness.deliveries.get(id)!, closedMilestone)).toMatchObject({
      phase: 'ready-to-release',
      repair: {
        reason: 'external-milestone-closed',
        source: 'current-milestone',
        blockages: [{ kind: 'milestone-closed' }],
      },
    })

    await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FINALIZE_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())
    expect(projectMilestoneDelivery(harness.deliveries.get(id)!, closedMilestone)).toMatchObject({
      phase: 'released',
      releaseEvidence: { intentId: FINALIZE_INTENT_ID },
    })
    expect(projectMilestoneDelivery(harness.deliveries.get(id)!, closedMilestone)).not.toHaveProperty('repair')
  })

  it('recovers a phase-write acknowledgement from the durable record', async () => {
    const harness = createHarness()
    const intent = saveIntent(SAVE_CRASH_INTENT_ID, null, 'planned')
    harness.intents.failNextUpdate = new Error('simulated stop before phase Intent acknowledgement')

    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow('simulated stop')
    expect(harness.deliveries.get(milestoneDeliveryId(PROJECT_ID, MILESTONE_ID))).toMatchObject({
      revision: 0,
      lastIntentId: SAVE_CRASH_INTENT_ID,
    })
    expect(await harness.createOperations().submit(intent, ACTOR, signal())).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded', deliveryRevision: 0 },
    })
  })

  it('validates all durable ownership before resuming a prepared phase write at startup', async () => {
    const harness = createHarness()
    const intent = saveIntent(SAVE_CRASH_INTENT_ID, null, 'planned')
    harness.intents.failNextUpdate = new Error('simulated stop before phase Intent acknowledgement')
    await expect(harness.operations.submit(intent, ACTOR, signal())).rejects.toThrow('simulated stop')

    const restarted = harness.createOperations()
    const state = restarted.validateDurableState(new Set())
    await restarted.initializeValidated(state, signal())

    expect(harness.intents.get(SAVE_CRASH_INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      resultDeliveryRevision: 0,
    })
  })

  it('leaves an externally unresolved prepared finalization dormant during startup', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.afterRead.current = async () => { throw new Error('release reads are unavailable during startup') }
    await expect(harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: STARTUP_DEFERRED_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).rejects.toThrow('release reads are unavailable during startup')
    const restarted = harness.createOperations()
    const state = restarted.validateDurableState(new Set())

    await expect(restarted.initializeValidated(state, signal())).resolves.toBeUndefined()

    expect(harness.readPasses).toEqual(['evaluation'])
    expect(harness.intents.get(STARTUP_DEFERRED_INTENT_ID)).toMatchObject({ phase: 'prepared' })
  })

  it('resumes every current prepared finalization when release reads become available', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    let unavailable = true
    harness.afterRead.current = async () => {
      if (!unavailable) return
      unavailable = false
      throw new Error('simulated Product App detach before release evidence')
    }
    await expect(harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: PROVIDER_RECOVERY_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).rejects.toThrow('simulated Product App detach')
    expect(harness.intents.get(PROVIDER_RECOVERY_INTENT_ID)).toMatchObject({ phase: 'prepared' })

    await harness.createOperations().resumePreparedFinalizations(signal())

    expect(harness.intents.get(PROVIDER_RECOVERY_INTENT_ID)).toMatchObject({
      phase: 'succeeded',
      resultDeliveryRevision: 1,
    })
    expect(harness.deliveries.get(id)).toMatchObject({
      revision: 1,
      releaseEvidence: { intentId: PROVIDER_RECOVERY_INTENT_ID },
    })
  })

  it.each([false, true])('attempts later prepared finalizations before reporting the first failure (both fail: %s)', async (bothFail) => {
    const harness = createHarness()
    const secondRelease = {
      ...releaseExpectation(),
      milestoneId: SECOND_MILESTONE_ID,
      milestoneNumber: 2,
    }
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    await harness.operations.submit({
      ...saveIntent(SECOND_BATCH_SAVE_INTENT_ID, null, 'ready-to-release'),
      release: secondRelease,
    }, ACTOR, signal())
    harness.afterRead.current = async () => { throw new Error('prepare both finalizations for recovery') }
    await expect(harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: FIRST_BATCH_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())).rejects.toThrow('prepare both finalizations for recovery')
    await expect(harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: SECOND_BATCH_INTENT_ID,
      deliveryId: milestoneDeliveryId(PROJECT_ID, SECOND_MILESTONE_ID),
      expectedDeliveryRevision: 0,
      release: secondRelease,
    }, ACTOR, signal())).rejects.toThrow('prepare both finalizations for recovery')
    let recoveryReads = 0
    harness.afterRead.current = async () => {
      recoveryReads += 1
      if (recoveryReads === 1) throw new Error('first finalization remains unavailable')
      if (bothFail) throw new Error('second finalization remains unavailable')
    }

    const recovery = harness.createOperations()
    await expect(bothFail ? recovery.pollPending(signal()) : recovery.resumePreparedFinalizations(signal()))
      .rejects.toThrow('first finalization remains unavailable')

    expect(recoveryReads).toBe(bothFail ? 2 : 3)
    expect(harness.intents.get(FIRST_BATCH_INTENT_ID)).toMatchObject({ phase: 'prepared' })
    expect(harness.intents.get(SECOND_BATCH_INTENT_ID)).toMatchObject(bothFail ? { phase: 'prepared' } : {
      phase: 'succeeded',
      resultDeliveryRevision: 1,
    })
  })

  it('attempts every repair refresh and reports the first failure when all providers fail', async () => {
    const harness = createHarness()
    harness.finalRereadTransform.current = (snapshot) => {
      const milestone = snapshot.milestone.confirmed
      if (milestone === undefined) throw new Error('missing fixture Milestone')
      return { ...snapshot, milestone: { confirmed: {
        ...milestone, value: { ...milestone.value, state: 'closed' },
      } } }
    }
    for (const [milestoneId, milestoneNumber, saveId, finalizeId] of [
      [MILESTONE_ID, 1, SAVE_INTENT_ID, FIRST_BATCH_INTENT_ID],
      [SECOND_MILESTONE_ID, 2, SECOND_BATCH_SAVE_INTENT_ID, SECOND_BATCH_INTENT_ID],
    ] as const) {
      const release = { ...releaseExpectation(), milestoneId, milestoneNumber }
      await harness.operations.submit({
        ...saveIntent(saveId, null, 'ready-to-release'), release,
      }, ACTOR, signal())
      expect(await harness.operations.submit({
        type: 'finalize-milestone-delivery', intentId: finalizeId,
        deliveryId: milestoneDeliveryId(PROJECT_ID, milestoneId), expectedDeliveryRevision: 0, release,
      }, ACTOR, signal())).toMatchObject({ ok: false, reason: 'reconciliation-required' })
    }
    let attempts = 0
    harness.afterRead.current = async () => { throw new Error(`repair source unavailable ${++attempts}`) }
    await expect(harness.operations.pollPending(signal())).rejects.toThrow('repair source unavailable 1')
    expect(attempts).toBe(2)
    expect(harness.readPasses.slice(-2)).toEqual(['view', 'view'])
    expect([...harness.deliveries.values.values()].every(record => record.repair !== undefined)).toBe(true)
  })

  it('rejects a saved aggregate whose owning Intent was replaced with a denied record', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    const record = milestoneDeliveryIntentRecordSchema.parse(harness.intents.get(SAVE_INTENT_ID))
    harness.intents.values.set(SAVE_INTENT_ID, milestoneDeliveryIntentRecordSchema.parse({
      ...record, phase: 'denied', resultDeliveryRevision: undefined,
    }))
    expect(() => harness.createOperations().validateDurableState(new Set()))
      .toThrow('Milestone Delivery last Intent reference is inconsistent')
    expect(harness.readPasses).toEqual([])
  })

  it('rejects duplicate global Intent ownership and dangling aggregate references before recovery', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())

    expect(() => harness.operations.validateDurableState(new Set([SAVE_INTENT_ID]))).toThrow(
      `Saki Control Intent '${SAVE_INTENT_ID}' is retained by multiple Intent kinds`,
    )
    harness.intents.values.delete(SAVE_INTENT_ID)
    expect(() => harness.operations.validateDurableState(new Set())).toThrow(
      'Milestone Delivery last Intent reference is inconsistent',
    )
  })

  it('rejects a retained Milestone Delivery after its Development Project disappears', async () => {
    const harness = createHarness()
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'planned'), ACTOR, signal())
    harness.projectPresent.current = false

    expect(() => harness.createOperations().validateDurableState(new Set())).toThrow(
      'Milestone Delivery targets a missing Development Project',
    )
  })

  it('accepts an unavailable Save Intent retained before a missing Project could create an aggregate', async () => {
    const harness = createHarness()
    harness.projectPresent.current = false

    expect(await harness.operations.submit(
      saveIntent(SAVE_INTENT_ID, null, 'planned'),
      ACTOR,
      signal(),
    )).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(harness.deliveries.size).toBe(0)
    expect(harness.intents.get(SAVE_INTENT_ID)).toMatchObject({ phase: 'unavailable' })
    expect(() => harness.createOperations().validateDurableState(new Set())).not.toThrow()
  })

  it('replaces a resolved reconciliation marker with immutable release evidence', async () => {
    const harness = createHarness()
    const id = milestoneDeliveryId(PROJECT_ID, MILESTONE_ID)
    await harness.operations.submit(saveIntent(SAVE_INTENT_ID, null, 'ready-to-release'), ACTOR, signal())
    harness.finalRereadTransform.current = snapshot => ({
      ...snapshot,
      milestone: snapshot.milestone.confirmed === undefined
        ? snapshot.milestone
        : {
          confirmed: {
            ...snapshot.milestone.confirmed,
            value: { ...snapshot.milestone.confirmed.value, title: 'temporary drift' },
          },
        },
    })
    await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: DRIFT_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 0,
      release: releaseExpectation(),
    }, ACTOR, signal())
    harness.finalRereadTransform.current = snapshot => snapshot

    expect(await harness.operations.submit({
      type: 'finalize-milestone-delivery',
      intentId: REPAIR_RETRY_INTENT_ID,
      deliveryId: id,
      expectedDeliveryRevision: 1,
      release: releaseExpectation(),
    }, ACTOR, signal())).toMatchObject({
      ok: true,
      receipt: { state: 'succeeded', deliveryRevision: 2 },
    })
    expect(harness.deliveries.get(id)).toMatchObject({
      revision: 2,
      releaseEvidence: { intentId: REPAIR_RETRY_INTENT_ID },
    })
    expect(harness.deliveries.get(id)).not.toHaveProperty('repair')
  })
})

function createHarness(configuration: {
  readonly maxObservationAgeMs?: number
} = {}) {
  const deliveries = new MemoryTable<ReturnType<typeof milestoneDeliveryId>, MilestoneDeliveryRecord>()
  const intents = new MemoryTable<
    ReturnType<typeof sakiControlIntentIdSchema.parse>,
    MilestoneDeliveryIntentRecord
  >()
  const readPasses: Array<'view' | 'evaluation' | 'final-reread'> = []
  const finalRereadTransform = {
    current: (snapshot: ReleaseEvidencePolicyV1Snapshot): ReleaseEvidencePolicyV1Snapshot => snapshot,
  }
  const viewTransform = {
    current: (snapshot: ReleaseEvidencePolicyV1Snapshot): ReleaseEvidencePolicyV1Snapshot => snapshot,
  }
  const afterRead = {
    current: async (_pass: 'view' | 'evaluation' | 'final-reread'): Promise<void> => {},
  }
  const context = {
    current: {
      registryRevision: 4,
      projectRevision: 2,
      repositoryId: REPOSITORY_ID,
      projectId: GITHUB_PROJECT_ID,
    },
  }
  const projectPresent = { current: true }
  const authority = { current: true }
  const options: MilestoneDeliveryOperationsOptions = {
    deliveryTable: deliveries,
    intentTable: intents,
    projectExists: projectId => projectId === PROJECT_ID && projectPresent.current,
    resolveContext: projectId => projectId === PROJECT_ID && projectPresent.current
      ? {
        ok: true,
        context: context.current,
      }
      : { ok: false, reason: 'not-found' },
    readReleaseSnapshot: async (developmentProjectId, expectation, pass) => {
      if (developmentProjectId !== PROJECT_ID) throw new Error('unexpected Development Project')
      readPasses.push(pass)
      const now = Date.now()
      const base = releaseSnapshot(now, now)
      const snapshot = expectation.milestoneId === MILESTONE_ID || base.milestone.confirmed === undefined
        ? base
        : {
          ...base,
          milestone: {
            confirmed: {
              ...base.milestone.confirmed,
              value: {
                ...base.milestone.confirmed.value,
                id: expectation.milestoneId,
                number: expectation.milestoneNumber,
              },
            },
          },
        }
      await afterRead.current(pass)
      return pass === 'final-reread' ? finalRereadTransform.current(snapshot)
        : pass === 'view' ? viewTransform.current(snapshot) : snapshot
    },
    authorityCurrent: () => authority.current,
    validateActorReference: () => {},
    maxObservationAgeMs: configuration.maxObservationAgeMs ?? 60_000,
    notifyChanged: () => {},
  }
  const createOperations = () => new MilestoneDeliveryOperations(options)
  return {
    operations: createOperations(),
    createOperations,
    deliveries,
    intents,
    readPasses,
    finalRereadTransform,
    viewTransform,
    afterRead,
    context,
    projectPresent,
    authority,
  }
}

function releaseExpectation() {
  return {
    repositoryId: REPOSITORY_ID,
    projectId: GITHUB_PROJECT_ID,
    milestoneId: MILESTONE_ID,
    milestoneNumber: 1,
    tagName: githubReleaseTagName('saki-v0.1.0'),
    releaseCommitId: RELEASE_COMMIT_ID,
    upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
    upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
    upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
    upstreamCommitId: UPSTREAM_COMMIT_ID,
  }
}

function saveIntent(
  intentId: ReturnType<typeof sakiControlIntentIdSchema.parse>,
  expectedDeliveryRevision: number | null,
  phase: 'planned' | 'in-progress' | 'ready-to-release' | 'canceled',
) {
  return {
    type: 'save-milestone-delivery' as const,
    intentId,
    projectId: PROJECT_ID,
    expectedDeliveryRevision,
    expectedRegistryRevision: 4,
    expectedProjectRevision: 2,
    phase,
    release: releaseExpectation(),
  }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function releaseSnapshot(observedAt: number, capturedAt: number): ReleaseEvidencePolicyV1Snapshot {
  return {
    capturedAt,
    board: {
      confirmed: {
        observedAt,
        value: {
          repositoryId: REPOSITORY_ID,
          projectId: GITHUB_PROJECT_ID,
          generation: 8,
          sourceFingerprint: { version: 1, digest: 'a'.repeat(64) },
          items: [{
            workItemId: WORK_ITEM_ID,
            issueId: ISSUE_ID,
            status: 'done',
            remoteFingerprint: REMOTE_FINGERPRINT,
          }],
        },
      },
    },
    milestone: {
      confirmed: {
        observedAt,
        value: {
          id: MILESTONE_ID,
          repositoryId: REPOSITORY_ID,
          number: 1,
          state: 'open',
          title: '0.1.0',
          url: 'https://github.com/o/r/milestone/1',
          updatedAt: 900,
          issues: [{
            id: ISSUE_ID,
            repositoryId: REPOSITORY_ID,
            repositoryDatabaseId: REPOSITORY_DATABASE_ID,
            number: 32,
            state: 'closed',
            title: 'Deliver B10',
            url: 'https://github.com/o/r/issues/32',
            updatedAt: 800,
          }],
          observedAt,
        },
      },
    },
    deliveries: [{
      deliveryId: `branch-delivery-${'5'.repeat(64)}`,
      revision: 3,
      workItemId: WORK_ITEM_ID,
      repositoryId: REPOSITORY_ID,
      commitId: RELEASE_COMMIT_ID,
      headRef: 'refs/heads/feature/b10',
      baseRef: 'refs/heads/master',
      pullRequest: {
        confirmed: {
          observedAt,
          value: {
            id: githubPullRequestId('PR_delivery'),
            repositoryId: REPOSITORY_ID,
            number: 72,
            state: 'open',
            merged: false,
            draft: true,
            title: 'B10',
            url: 'https://github.com/o/r/pull/72',
            head: { repositoryId: REPOSITORY_ID, ref: 'feature/b10', commitId: RELEASE_COMMIT_ID },
            base: { repositoryId: REPOSITORY_ID, ref: 'master', commitId: RELEASE_COMMIT_ID },
            updatedAt: 1_800,
            observedAt,
          },
        },
      },
      ci: {
        confirmed: {
          observedAt,
          value: {
            repositoryId: REPOSITORY_ID,
            commitId: RELEASE_COMMIT_ID,
            workflowRuns: [],
            checkRuns: [],
            commitStatuses: [{
              id: githubCommitStatusId('1'),
              context: 'CI',
              state: 'success',
              createdAt: 1_600,
              updatedAt: 1_700,
            }],
            observedAt,
          },
        },
      },
      ancestry: comparison(observedAt, RELEASE_COMMIT_ID, RELEASE_COMMIT_ID),
      acceptance: {
        deliveryRevision: 3,
        acceptedAt: 1_850,
        intentId: SAVE_INTENT_ID,
        actorDigest: 'c'.repeat(64),
      },
    }],
    tag: {
      confirmed: {
        observedAt,
        value: {
          reference: {
            repositoryId: REPOSITORY_ID,
            tagName: githubReleaseTagName('saki-v0.1.0'),
            ref: 'refs/tags/saki-v0.1.0',
            target: { kind: 'commit', id: RELEASE_COMMIT_ID },
            observedAt,
          },
          peel: {
            repositoryId: REPOSITORY_ID,
            tagObjects: [],
            commitId: RELEASE_COMMIT_ID,
            observedAt,
          },
        },
      },
    },
    release: {
      confirmed: {
        observedAt,
        value: {
          kind: 'present',
          release: {
            id: githubReleaseId('REL_delivery'),
            repositoryId: REPOSITORY_ID,
            tagName: githubReleaseTagName('saki-v0.1.0'),
            targetCommitish: 'ignored-branch-name',
            draft: false,
            prerelease: false,
            url: 'https://github.com/o/r/releases/tag/saki-v0.1.0',
            publishedAt: 1_700,
            observedAt,
          },
        },
      },
    },
    releaseCommit: commit(observedAt, REPOSITORY_ID, RELEASE_COMMIT_ID),
    upstreamCommit: commit(observedAt, UPSTREAM_REPOSITORY_ID, UPSTREAM_COMMIT_ID),
    upstreamAncestry: comparison(observedAt, UPSTREAM_COMMIT_ID, RELEASE_COMMIT_ID),
  }
}

function commit(
  observedAt: number,
  repositoryId: typeof REPOSITORY_ID,
  commitId: typeof RELEASE_COMMIT_ID,
): ReleaseEvidencePolicyV1Snapshot['releaseCommit'] {
  return {
    confirmed: {
      observedAt,
      value: {
        id: commitId,
        repositoryId,
        url: `https://github.com/o/r/commit/${commitId}`,
        committedAt: 1_500,
        observedAt,
      },
    },
  }
}

function comparison(
  observedAt: number,
  baseCommitId: typeof RELEASE_COMMIT_ID,
  headCommitId: typeof RELEASE_COMMIT_ID,
): ReleaseEvidencePolicyV1Snapshot['upstreamAncestry'] {
  return {
    confirmed: {
      observedAt,
      value: {
        repositoryId: REPOSITORY_ID,
        baseCommitId,
        headCommitId,
        status: baseCommitId === headCommitId ? 'identical' : 'ahead',
        aheadBy: baseCommitId === headCommitId ? 0 : 1,
        behindBy: 0,
        mergeBaseCommitId: baseCommitId,
        observedAt,
      },
    },
  }
}
