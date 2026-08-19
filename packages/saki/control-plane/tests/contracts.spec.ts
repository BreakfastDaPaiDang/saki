import { describe, expect, it } from 'vitest'
import type { SakiControlPlaneModule } from '../src/index.ts'
import { SakiAuthenticationContext } from '../src/authentication.ts'
import {
  SAKI_ACCESS_FIXTURES,
  SAKI_ACCESS_LIFECYCLE_FIXTURES,
  SAKI_ACCESS_RESULT_FIXTURES,
  SAKI_CONTROL_RESULT_FIXTURES,
  SAKI_EMPTY_PROJECT_INDEX_FIXTURE,
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
import { principalRecordSchema } from '../src/spec.ts'
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

  it('publishes secret-free frontend fixtures for every B01 state family', () => {
    expect(SAKI_ACCESS_FIXTURES.authenticated.kind).toBe('authenticated')
    expect(SAKI_EMPTY_PROJECT_INDEX_FIXTURE.projects).toEqual([])
    expect(SAKI_ACCESS_RESULT_FIXTURES.logoutConfirmed).toEqual({ ok: true })
    expect(SAKI_CONTROL_RESULT_FIXTURES.intentUnavailable).toEqual({ ok: false, reason: 'intent-unavailable' })
    expect(SAKI_ACCESS_LIFECYCLE_FIXTURES.challenges).toContain('revoked')
    expect(SAKI_SECURITY_RECORD_FIXTURES.sessions.active.verifier.redacted).toBe(true)
    expect(JSON.stringify([
      SAKI_ACCESS_FIXTURES,
      SAKI_ACCESS_RESULT_FIXTURES,
      SAKI_CONTROL_RESULT_FIXTURES,
      SAKI_ACCESS_LIFECYCLE_FIXTURES,
      SAKI_SECURITY_RECORD_FIXTURES,
    ])).not.toMatch(/bootstrapSecret|cookieDigest|requestTokenDerivation/)
  })
})
