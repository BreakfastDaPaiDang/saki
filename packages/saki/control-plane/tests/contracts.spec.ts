import { describe, expect, it } from 'vitest'
import {
  projectGitStatusObservationSchema,
  projectSelectionProjectionSchema,
  readProjectDiffResultSchema,
} from '@breakfastdapaidang/saki-execution'
import type { SakiControlPlaneModule } from '../src/index.ts'
import { SakiAuthenticationContext } from '../src/authentication.ts'
import {
  SAKI_ACCESS_FIXTURES,
  SAKI_ACCESS_LIFECYCLE_FIXTURES,
  SAKI_ACCESS_RESULT_FIXTURES,
  SAKI_AGENT_RUN_PROJECTION_FIXTURES,
  SAKI_BOARD_MUTATION_OVERLAY_FIXTURES,
  SAKI_BOARD_PROJECTION_FIXTURES,
  SAKI_CONTROL_RESULT_FIXTURES,
  SAKI_EMPTY_PROJECT_INDEX_FIXTURE,
  SAKI_GIT_CHANGES_PROJECTION_FIXTURES,
  SAKI_GIT_DIFF_PROJECTION_FIXTURES,
  SAKI_GIT_OPERATION_RESULT_FIXTURES,
  SAKI_GIT_QUERY_RESULT_FIXTURES,
  SAKI_GIT_REQUEST_FIXTURES,
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_RECEIPT_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
  SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
  SAKI_SECURITY_RECORD_FIXTURES,
  SAKI_WORK_ITEM_RESULT_FIXTURES,
  SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE,
} from '../src/fixtures.ts'
import {
  resolveSakiAuthentication,
  sakiSessionCookieName,
} from '../src/host.ts'
import {
  bootstrapDigest,
  cookieDigest,
  SakiBootstrapHandoff,
} from '../src/secrets.ts'
import {
  principalRecordSchema,
  createCommitIntentSchema,
  registerDevelopmentProjectIntentSchema,
  stageFilesIntentSchema,
  unstageFilesIntentSchema,
} from '../src/spec.ts'
import type {
  SakiBootstrapChallengeId,
  SakiBrowserSessionId,
  SakiPrincipalId,
} from '../src/types.ts'

describe('Saki control-plane public contracts', () => {
  it('binds durable verifiers to their owning entry identities', () => {
    const challengeA = 'access:challenge:0' as SakiBootstrapChallengeId
    const challengeB = 'access:challenge:1' as SakiBootstrapChallengeId
    const sessionA = 'access:session:0' as SakiBrowserSessionId
    const sessionB = 'access:session:1' as SakiBrowserSessionId
    expect(bootstrapDigest(challengeA, 'same-secret')).not.toBe(bootstrapDigest(challengeB, 'same-secret'))
    expect(cookieDigest(sessionA, 'same-cookie')).not.toBe(cookieDigest(sessionB, 'same-cookie'))
  })

  it('permits each launcher handoff to reveal its secret only once', () => {
    const handoff = new SakiBootstrapHandoff('local-reauthentication', 'one-time-secret')
    expect(handoff.consume()).toBe('one-time-secret')
    expect(() => handoff.consume()).toThrow('saki bootstrap handoff was already consumed')
  })

  it('admits automation Principals without weakening the closed Principal kinds', () => {
    expect(principalRecordSchema.parse({
      id: 'principal-00000000-0000-4000-8000-000000000001' as SakiPrincipalId,
      revision: 0,
      kind: 'automation',
      displayName: 'Release automation',
      state: 'active',
    }).kind).toBe('automation')
    expect(() => principalRecordSchema.parse({
      id: 'principal-00000000-0000-4000-8000-000000000002' as SakiPrincipalId,
      revision: 0,
      kind: 'unknown',
      displayName: 'Unknown',
      state: 'active',
    })).toThrow()
  })

  it('rejects Host helpers and token projection without service-owned authority', async () => {
    const foreign = {} as SakiControlPlaneModule
    await expect(resolveSakiAuthentication(
      foreign,
      undefined,
      { origin: undefined, mutation: false },
      AbortSignal.timeout(1_000),
    )).rejects.toThrow('active control-plane implementation')
    expect(() => sakiSessionCookieName(foreign)).toThrow('active control-plane implementation')

    const orphan = Object.create(SakiAuthenticationContext.prototype) as SakiAuthenticationContext
    expect(() => orphan.projectRequestToken()).toThrow('has no request token')
  })

  it('publishes typed secret-free frontend fixtures for access and Project workflows', () => {
    expect(SAKI_ACCESS_FIXTURES.authenticated.kind).toBe('authenticated')
    expect(SAKI_EMPTY_PROJECT_INDEX_FIXTURE.projects).toEqual([])
    expect(SAKI_ACCESS_RESULT_FIXTURES.logoutConfirmed).toEqual({ ok: true })
    expect(SAKI_CONTROL_RESULT_FIXTURES.intentDenied).toEqual({ ok: false, reason: 'denied' })
    expect(registerDevelopmentProjectIntentSchema.parse(
      SAKI_PROJECT_REQUEST_FIXTURES.registration,
    ).projectTitle).toBe('Fixture project')
    expect(SAKI_PROJECT_REQUEST_FIXTURES.registration.confirmedFingerprint.version).toBe(2)
    expect(registerDevelopmentProjectIntentSchema.safeParse({
      ...SAKI_PROJECT_REQUEST_FIXTURES.registration,
      confirmedFingerprint: {
        version: 1,
        digest: SAKI_PROJECT_REQUEST_FIXTURES.registration.confirmedFingerprint.digest,
      },
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.parse(
      SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
    ).automaticMutationEligible).toBe(true)
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection).toMatchObject({
      observationVersion: 2,
      head: { kind: 'commit', symbolicRef: 'refs/heads/main' },
      fingerprint: { version: 2 },
    })
    expect(projectSelectionProjectionSchema.parse(
      SAKI_PROJECT_PROJECTION_FIXTURES.dirtySelection,
    ).blockingReasons).toEqual(['dirty'])
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.invalidDirectoryInspection)
      .toEqual({ type: 'inspect-project-selection', result: { ok: false, reason: 'missing' } })
    expect(SAKI_PROJECT_RECEIPT_FIXTURES.confirmed)
      .toMatchObject({ ok: true, receipt: { state: 'confirmed', registryRevision: 1 } })
    expect(SAKI_PROJECT_RECEIPT_FIXTURES.duplicate)
      .toMatchObject({ ok: false, reason: 'conflict', receipt: { reason: 'duplicate-binding' } })
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.recovery)
      .toEqual({ state: 'ready', reasons: [] })
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex.projects[0]?.binding).toMatchObject({
      objectFormat: 'sha1',
      head: { kind: 'commit', symbolicRef: 'refs/heads/main' },
    })
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex.projects[0]?.binding).not.toHaveProperty('branch')
    expect(SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex.projects[0]?.binding).not.toHaveProperty('detached')
    expect(SAKI_ACCESS_LIFECYCLE_FIXTURES.challenges).toContain('revoked')
    expect(SAKI_SECURITY_RECORD_FIXTURES.sessions.active.verifier.redacted).toBe(true)
    const serialized = JSON.stringify([
      SAKI_ACCESS_FIXTURES,
      SAKI_ACCESS_RESULT_FIXTURES,
      SAKI_AGENT_RUN_PROJECTION_FIXTURES,
      SAKI_BOARD_PROJECTION_FIXTURES,
      SAKI_CONTROL_RESULT_FIXTURES,
      SAKI_GIT_CHANGES_PROJECTION_FIXTURES,
      SAKI_GIT_DIFF_PROJECTION_FIXTURES,
      SAKI_GIT_OPERATION_RESULT_FIXTURES,
      SAKI_GIT_QUERY_RESULT_FIXTURES,
      SAKI_GIT_REQUEST_FIXTURES,
      SAKI_PROJECT_REQUEST_FIXTURES,
      SAKI_PROJECT_PROJECTION_FIXTURES,
      SAKI_PROJECT_RECEIPT_FIXTURES,
      SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
      SAKI_ACCESS_LIFECYCLE_FIXTURES,
      SAKI_SECURITY_RECORD_FIXTURES,
      SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE,
    ])
    expect(serialized).not.toMatch(/bootstrapSecret|cookieDigest|requestTokenDerivation/)
    expect(serialized).not.toMatch(/privateKey|installationToken|accessToken|-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    expect(serialized).not.toMatch(/canonicalWorktreePath|canonicalGitDirectory|canonicalCommonGitDirectory/)
    expect(serialized).not.toContain('/fixture/repository')
  })

  it('publishes one assigned Work Item with current and recent browser-safe Agent Runs', () => {
    expect(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE).toMatchObject({
      type: 'work-item-detail',
      definition: { number: 27, status: 'in-progress', blockage: [] },
      assignment: { state: 'active' },
      primaryWorkSession: { state: 'open' },
      currentAgentRun: { state: 'running', recovery: { state: 'resumable' } },
    })
    expect(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE.recentAgentRuns.map(run => [
      run.state,
      run.recovery.state,
    ])).toEqual([
      ['reconciliation-required', 'required'],
      ['canceled', 'terminal'],
    ])
    expect(Object.values(SAKI_AGENT_RUN_PROJECTION_FIXTURES).map(run => run.state)).toEqual([
      'running',
      'canceled',
      'reconciliation-required',
    ])

    const serialized = JSON.stringify({
      runs: SAKI_AGENT_RUN_PROJECTION_FIXTURES,
      detail: SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE,
    })
    expect(serialized).not.toMatch(
      /canonicalWorktreePath|canonicalGitDirectory|canonicalCommonGitDirectory|operationSnapshot/u,
    )
    expect(serialized).not.toMatch(
      /credential|privateKey|installationToken|accessToken|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
    )
    expect(serialized).not.toMatch(/(?:"[A-Za-z]:[\\/]|\/fixture\/repository)/u)
  })

  it('publishes typed Changes, bounded Diff, and terminal operation fixtures for every B07 state', () => {
    const { clean, dirty, conflict } = SAKI_GIT_CHANGES_PROJECTION_FIXTURES
    if (!clean.result.ok || !dirty.result.ok || !conflict.result.ok) {
      throw new Error('Changes fixtures must carry complete observations')
    }
    expect(projectGitStatusObservationSchema.parse(clean.result.observation).changes).toEqual([])
    expect(clean.gitOperations.createCommit).toEqual({
      available: false,
      reasons: ['no-staged-changes'],
    })
    const dirtyObservation = projectGitStatusObservationSchema.parse(dirty.result.observation)
    expect(dirtyObservation).toMatchObject({
      head: { kind: 'commit', symbolicRef: 'refs/heads/main' },
      branch: { kind: 'attached', name: 'main' },
      upstream: { name: 'origin/main', divergence: { ahead: 1, behind: 0 } },
    })
    expect(dirtyObservation.changes.map(change => [change.path, change.indexStatus, change.worktreeStatus]))
      .toEqual([
        ['new.txt', 'absent', 'untracked'],
        ['staged.txt', 'modified', 'unchanged'],
        ['unstaged.txt', 'unchanged', 'modified'],
      ])
    expect(dirtyObservation.changes.map(change => change.attribution))
      .toEqual(['unattributed', 'not-inherited', 'inherited'])
    expect(projectGitStatusObservationSchema.parse(conflict.result.observation)).toMatchObject({
      index: { kind: 'unmerged' },
      changes: [{ kind: 'unmerged', conflict: 'both-modified' }],
      structuredMutation: { available: false, blockers: ['unmerged'] },
    })

    expect(readProjectDiffResultSchema.parse(SAKI_GIT_DIFF_PROJECTION_FIXTURES.success.result))
      .toEqual(SAKI_GIT_DIFF_PROJECTION_FIXTURES.success.result)
    expect(SAKI_GIT_DIFF_PROJECTION_FIXTURES.success.result.page).toMatchObject({
      layer: 'unstaged',
      range: { startLine: 0, totalLines: 6 },
      truncated: false,
    })
    expect(readProjectDiffResultSchema.parse(SAKI_GIT_DIFF_PROJECTION_FIXTURES.stale.result))
      .toEqual({ ok: false, reason: 'observation-stale' })

    expect(stageFilesIntentSchema.parse(SAKI_GIT_REQUEST_FIXTURES.stage))
      .toEqual(SAKI_GIT_REQUEST_FIXTURES.stage)
    expect(unstageFilesIntentSchema.parse(SAKI_GIT_REQUEST_FIXTURES.unstage))
      .toEqual(SAKI_GIT_REQUEST_FIXTURES.unstage)
    expect(createCommitIntentSchema.parse(SAKI_GIT_REQUEST_FIXTURES.commit))
      .toEqual(SAKI_GIT_REQUEST_FIXTURES.commit)
    expect(JSON.stringify(SAKI_GIT_REQUEST_FIXTURES))
      .not.toMatch(/"(?:path|argv|cwd|env|canonicalWorktreePath|canonicalGitDirectory)"/u)

    expect(SAKI_GIT_QUERY_RESULT_FIXTURES.stale).toEqual({ ok: false, reason: 'stale' })
    expect(Object.values(SAKI_GIT_OPERATION_RESULT_FIXTURES).map(result =>
      result.ok ? result.receipt.state : `${result.reason}:${result.receipt.state}`))
      .toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
        'conflict:conflict',
        'failure:failed',
        'canceled:canceled',
        'reconciliation-required:reconciliation-required',
      ])
    expect(SAKI_GIT_OPERATION_RESULT_FIXTURES.failure.receipt.reason).toBe('invalid-selection')
    expect(SAKI_GIT_OPERATION_RESULT_FIXTURES.unknownOutcome.receipt.reason).toBe('effect-unknown')
  })

  it('publishes relational Board and Project Settings synchronization fixtures', () => {
    expect(SAKI_PROJECT_REQUEST_FIXTURES.projectSettings).toEqual({
      type: 'project-settings',
      projectId: SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex.projects[0]?.id,
    })
    expect(SAKI_PROJECT_REQUEST_FIXTURES.cachedBoard).toEqual({
      type: 'board',
      projectId: SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex.projects[0]?.id,
      refresh: 'cached',
    })

    const { saved, activating, activated } = SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES
    expect([saved.synchronization.state, activating.synchronization.state, activated.synchronization.state])
      .toEqual(['saved', 'activating', 'activated'])
    expect(saved.synchronization).toMatchObject({
      revision: 2,
      active: { revision: 1 },
      pending: {
        revision: 2,
        state: 'saved',
        changedFields: ['activePollIntervalMs'],
        configuration: { credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY' },
      },
      mapping: { state: 'revalidation-required', configurationRevision: 2 },
      scan: { state: 'scheduled', reason: 'configuration' },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
      },
    })
    expect(activating.synchronization).toMatchObject({
      revision: 2,
      active: { revision: 1 },
      pending: { revision: 2, state: 'activating', changedFields: ['activePollIntervalMs'] },
      mapping: { state: 'revalidation-required', configurationRevision: 2 },
      scan: { state: 'in-flight', configurationRevision: 2 },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
      },
    })
    expect(activated.synchronization).toMatchObject({
      revision: 1,
      state: 'activated',
      active: { revision: 1 },
      checkpoint: { generation: 1, configurationRevision: 1 },
      mapping: { state: 'valid', configurationRevision: 1 },
      scan: { state: 'idle' },
      effectiveMutationAvailability: { available: true, reasons: [] },
    })
    expect(activated.synchronization.mapping).toEqual({
      state: 'valid',
      configurationRevision: activated.synchronization.checkpoint?.configurationRevision,
      validatedAt: activated.synchronization.checkpoint?.confirmedAt,
    })

    const {
      unconfigured,
      awaitingFirstCheckpoint,
      mappingRevalidation,
      confirmedStaleFailure,
    } = SAKI_BOARD_PROJECTION_FIXTURES
    expect(unconfigured).toMatchObject({
      state: 'unconfigured',
      synchronizationRevision: 0,
      mapping: { state: 'unconfigured' },
      freshness: { state: 'unavailable' },
      scan: { state: 'idle' },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['synchronization-unconfigured', 'checkpoint-unavailable'],
      },
    })
    expect(awaitingFirstCheckpoint).toMatchObject({
      state: 'awaiting-first-checkpoint',
      synchronizationRevision: 1,
      mapping: { state: 'revalidation-required', configurationRevision: 1 },
      freshness: { state: 'unavailable' },
      effectiveMutationAvailability: {
        available: false,
        reasons: [
          'configuration-not-activated',
          'mapping-revalidation-required',
          'checkpoint-unavailable',
        ],
      },
    })
    expect(mappingRevalidation).toMatchObject({
      state: 'confirmed',
      synchronizationRevision: 2,
      confirmed: { generation: 1, configurationRevision: 1 },
      checkpoint: { generation: 1, configurationRevision: 1 },
      mapping: { state: 'revalidation-required', configurationRevision: 2 },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
      },
    })
    expect(confirmedStaleFailure).toMatchObject({
      state: 'confirmed',
      synchronizationRevision: 1,
      confirmed: { generation: 1, configurationRevision: 1 },
      checkpoint: { generation: 1, configurationRevision: 1 },
      mapping: { state: 'valid', configurationRevision: 1 },
      failure: {
        configurationRevision: 1,
        failure: { kind: 'provider', failure: { code: 'transient-transport' } },
      },
      freshness: { state: 'stale' },
      scan: { state: 'scheduled', reason: 'retry' },
      effectiveMutationAvailability: { available: true, reasons: [] },
    })
    expect(confirmedStaleFailure.confirmed?.generation)
      .toBe(confirmedStaleFailure.checkpoint?.generation)
    expect(confirmedStaleFailure.confirmed?.configurationRevision)
      .toBe(confirmedStaleFailure.checkpoint?.configurationRevision)
    if (confirmedStaleFailure.freshness.state !== 'stale') throw new Error('fixture must be stale')
    expect(confirmedStaleFailure.freshness.staleAt)
      .toBe(confirmedStaleFailure.freshness.confirmedAt + 30_000)

    expect(SAKI_CONTROL_RESULT_FIXTURES.confirmedBoard).toEqual({
      ok: true,
      projection: confirmedStaleFailure,
    })
    expect(SAKI_CONTROL_RESULT_FIXTURES.savedProjectSettings).toEqual({ ok: true, projection: saved })

    expect(Object.values(SAKI_BOARD_MUTATION_OVERLAY_FIXTURES).map(overlay => overlay.state)).toEqual([
      'optimistic',
      'targeted-confirmed',
      'conflict',
      'partial-failure',
      'reconciliation-required',
      'repair-required',
    ])
    expect(Object.values(SAKI_WORK_ITEM_RESULT_FIXTURES).map(result => (
      result.receipt.state
    ))).toEqual(['succeeded', 'prepared', 'conflict', 'partial-failure', 'reconciliation-required'])
  })
})
