import { describe, expect, it } from 'vitest'
import {
  SAKI_AGENT_RUN_PROJECTION_FIXTURES,
  SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE,
} from '@breakfastdapaidang/saki-control-plane/fixtures'
import {
  sakiAgentRunProjectionSchema,
  sakiGiveWorkItemToAgentIntentSchema,
  sakiWorkItemDetailProjectionSchema,
} from '../src/wire.ts'

const INTENT = {
  type: 'give-work-item-to-agent',
  intentId: 'intent-33333333-3333-4333-8333-333333333333',
  projectId: 'project-22222222-2222-4222-8222-222222222222',
  workItemId: `work-item-${'4'.repeat(64)}`,
  expectedProjectRevision: 5,
  expectedRemoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
} as const

describe('Saki manual Agent Run wire contract', () => {
  it('admits only the revision-fenced Work Item command', () => {
    expect(sakiGiveWorkItemToAgentIntentSchema.parse(INTENT)).toEqual(INTENT)

    for (const authority of [
      { actor: { kind: 'human', value: 'authority-sentinel' } },
      { grant: { revision: 1, value: 'authority-sentinel' } },
      { hostId: 'host-authority-sentinel' },
      { resourceBindingId: 'binding-authority-sentinel' },
      { canonicalWorktreePath: 'D:/authority-sentinel' },
      { dispatchClaim: { revision: 1, fencingValue: 'authority-sentinel' } },
      { workSessionId: 'work-session-authority-sentinel' },
      { agentRunId: 'agent-run-authority-sentinel' },
      { agentProfileVersionId: 'agent-profile-version-authority-sentinel' },
      { modelRouteId: 'model-route-authority-sentinel' },
      { providerAccountProfileId: 'provider-account-profile-authority-sentinel' },
    ]) {
      expect(sakiGiveWorkItemToAgentIntentSchema.safeParse({ ...INTENT, ...authority }).success).toBe(false)
    }
  })

  it('round-trips bounded current, terminal, and reconciliation Projection fixtures', () => {
    for (const run of Object.values(SAKI_AGENT_RUN_PROJECTION_FIXTURES)) {
      expect(sakiAgentRunProjectionSchema.parse(run)).toEqual(run)
      expect(sakiAgentRunProjectionSchema.parse(JSON.parse(JSON.stringify(run)))).toEqual(run)
    }

    expect(sakiWorkItemDetailProjectionSchema.parse(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE))
      .toEqual(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE)
    expect(sakiWorkItemDetailProjectionSchema.parse(
      JSON.parse(JSON.stringify(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE)),
    )).toEqual(SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE)
  })

  it('rejects unsafe or inconsistent Work Item execution Projections', () => {
    const detail = SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE
    const running = SAKI_AGENT_RUN_PROJECTION_FIXTURES.running

    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      canonicalWorktreePath: 'D:/private/repository',
    }).success).toBe(false)
    expect(sakiAgentRunProjectionSchema.safeParse({
      ...running,
      profile: { ...running.profile, credentialRef: 'PRIVATE_KEY' },
    }).success).toBe(false)
    expect(sakiAgentRunProjectionSchema.safeParse({
      ...running,
      model: { ...running.model, model: 'unsafe\0model' },
    }).success).toBe(false)
    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      definition: { ...detail.definition, url: 'file:///D:/private/repository' },
    }).success).toBe(false)
    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      definition: { ...detail.definition, acceptanceCriteria: [] },
    }).success).toBe(false)
    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      currentAgentRun: { ...running, assignmentId: detail.recentAgentRuns[0].assignmentId },
    }).success).toBe(false)
    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      recentAgentRuns: [running],
    }).success).toBe(false)
    expect(sakiWorkItemDetailProjectionSchema.safeParse({
      ...detail,
      recentAgentRuns: Array.from({ length: 33 }, () => detail.recentAgentRuns[0]),
    }).success).toBe(false)

    const serialized = JSON.stringify({ runs: SAKI_AGENT_RUN_PROJECTION_FIXTURES, detail })
    expect(serialized).not.toMatch(
      /canonicalWorktreePath|canonicalGitDirectory|canonicalCommonGitDirectory|operationSnapshot/u,
    )
    expect(serialized).not.toMatch(
      /credential|privateKey|installationToken|accessToken|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
    )
    expect(serialized).not.toMatch(/(?:"[A-Za-z]:[\\/]|\/fixture\/repository)/u)
  })
})
