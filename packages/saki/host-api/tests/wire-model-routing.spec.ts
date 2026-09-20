import { expect, it } from 'vitest'
import {
  sakiSwitchWorkSessionModelIntentSchema, sakiSwitchWorkSessionModelResultSchema,
  sakiConfigureProjectModelRouteIntentSchema, sakiConfigureProjectModelRouteResultSchema,
  sakiIntentRequestSchema, sakiProjectModelRouteResultSchema, sakiQueryRequestSchema, sakiQueryResultSchema,
} from '../src/wire.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const selection = { accountProfileId: uuid, configurationRevision: 2, model: 'selected-model' }
const request = { type: 'configure-project-model-route', intentId: `intent-${uuid}`, projectId: `project-${uuid}`,
  expectedProjectRevision: 3, selection }
const account = { selection, provider: `saki-account-${uuid}-2`, accountIdentity: 'fixture-account',
  implementation: { name: 'fixture', version: '1' } }
const projection = { type: 'project-model-route', projectId: request.projectId, projectRevision: 4,
  profile: { id: `agent-profile-${uuid}`, version: 5, agentPresetId: 'development',
    provider: account.provider, model: selection.model, account } }

it('round-trips Project model selection through both the specialized and union transports', () => {
  expect(sakiQueryRequestSchema.parse({ type: 'project-model-route', projectId: request.projectId }))
    .toEqual({ type: 'project-model-route', projectId: request.projectId })
  expect(sakiConfigureProjectModelRouteIntentSchema.parse(request)).toEqual(request)
  expect(sakiIntentRequestSchema.parse(request)).toEqual(request)
  expect(sakiProjectModelRouteResultSchema.parse({ ok: true, projection })).toEqual({ ok: true, projection })
  expect(sakiQueryResultSchema.parse({ ok: true, projection })).toEqual({ ok: true, projection })
  expect(sakiConfigureProjectModelRouteResultSchema.parse({ ok: true, receipt: {
    intentId: request.intentId, profileId: projection.profile.id, state: 'completed',
  } })).toMatchObject({ ok: true })
})

it('rejects browser authority, provider configuration, and inconsistent account attribution', () => {
  for (const candidate of [{ ...request, actor: {} }, { ...request, configuration: { token: 'fixture' } },
    { ...request, selection: { ...selection, provider: account.provider } },
    { ...request, expectedProjectRevision: -1 }]) {
    expect(sakiConfigureProjectModelRouteIntentSchema.safeParse(candidate).success).toBe(false)
  }
  for (const profile of [{ ...projection.profile, model: 'another-model' },
    { ...projection.profile, account: { ...account, configuration: {} } },
    { ...projection.profile, account: { ...account, provider: `saki-account-${uuid}-3` } }]) {
    expect(sakiProjectModelRouteResultSchema.safeParse({ ok: true, projection: { ...projection, profile } }).success).toBe(false)
  }
})


it('requires exact Work Session fences and excludes credentials from switch transport', () => {
  const value = { type: 'switch-work-session-model', intentId: request.intentId, projectId: request.projectId,
    workSessionId: `work-session-${uuid}`, expectedAgentRunId: `agent-run-${uuid}`,
    expectedWorkSessionRevision: 1, selection }
  expect(sakiSwitchWorkSessionModelIntentSchema.parse(value)).toEqual(value)
  expect(sakiIntentRequestSchema.parse(value)).toEqual(value)
  for (const invalid of [{ ...value, expectedAgentRunId: undefined }, { ...value, expectedWorkSessionRevision: -1 },
    { ...value, configuration: {} }, { ...value, actor: {} }, { ...value, selection: { ...selection, apiKey: 'fixture' } }]) {
    expect(sakiSwitchWorkSessionModelIntentSchema.safeParse(invalid).success).toBe(false)
  }
  expect(sakiSwitchWorkSessionModelResultSchema.parse({ ok: true, receipt: { intentId: value.intentId,
    agentRunId: value.expectedAgentRunId, sessionId: `session-${uuid}`, state: 'reconciliation-required' } })).toMatchObject({ ok: true })
})
