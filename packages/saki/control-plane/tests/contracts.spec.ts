import { describe, expect, it } from 'vitest'
import { projectSelectionProjectionSchema } from '@breakfastdapaidang/saki-execution'
import type { SakiControlPlaneModule } from '../src/index.ts'
import { SakiAuthenticationContext } from '../src/authentication.ts'
import {
  SAKI_ACCESS_FIXTURES,
  SAKI_ACCESS_LIFECYCLE_FIXTURES,
  SAKI_ACCESS_RESULT_FIXTURES,
  SAKI_BOARD_PROJECTION_FIXTURES,
  SAKI_CONTROL_RESULT_FIXTURES,
  SAKI_EMPTY_PROJECT_INDEX_FIXTURE,
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_RECEIPT_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
  SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
  SAKI_SECURITY_RECORD_FIXTURES,
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
  registerDevelopmentProjectIntentSchema,
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
    expect(projectSelectionProjectionSchema.parse(
      SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
    ).automaticMutationEligible).toBe(true)
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
    expect(SAKI_ACCESS_LIFECYCLE_FIXTURES.challenges).toContain('revoked')
    expect(SAKI_SECURITY_RECORD_FIXTURES.sessions.active.verifier.redacted).toBe(true)
    const serialized = JSON.stringify([
      SAKI_ACCESS_FIXTURES,
      SAKI_ACCESS_RESULT_FIXTURES,
      SAKI_BOARD_PROJECTION_FIXTURES,
      SAKI_CONTROL_RESULT_FIXTURES,
      SAKI_PROJECT_REQUEST_FIXTURES,
      SAKI_PROJECT_PROJECTION_FIXTURES,
      SAKI_PROJECT_RECEIPT_FIXTURES,
      SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
      SAKI_ACCESS_LIFECYCLE_FIXTURES,
      SAKI_SECURITY_RECORD_FIXTURES,
    ])
    expect(serialized).not.toMatch(/bootstrapSecret|cookieDigest|requestTokenDerivation/)
    expect(serialized).not.toMatch(/privateKey|installationToken|accessToken|-----BEGIN [A-Z ]*PRIVATE KEY-----/)
    expect(serialized).not.toMatch(/canonicalWorktreePath|canonicalGitDirectory|canonicalCommonGitDirectory/)
    expect(serialized).not.toContain('/fixture/repository')
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
        reasons: ['configuration-not-activated', 'mapping-revalidation-required', 'no-concrete-mutation'],
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
        reasons: ['configuration-not-activated', 'mapping-revalidation-required', 'no-concrete-mutation'],
      },
    })
    expect(activated.synchronization).toMatchObject({
      revision: 1,
      state: 'activated',
      active: { revision: 1 },
      checkpoint: { generation: 1, configurationRevision: 1 },
      mapping: { state: 'valid', configurationRevision: 1 },
      scan: { state: 'idle' },
      effectiveMutationAvailability: { available: false, reasons: ['no-concrete-mutation'] },
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
        reasons: ['synchronization-unconfigured', 'checkpoint-unavailable', 'no-concrete-mutation'],
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
          'no-concrete-mutation',
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
        reasons: ['configuration-not-activated', 'mapping-revalidation-required', 'no-concrete-mutation'],
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
      effectiveMutationAvailability: { available: false, reasons: ['no-concrete-mutation'] },
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
  })
})
