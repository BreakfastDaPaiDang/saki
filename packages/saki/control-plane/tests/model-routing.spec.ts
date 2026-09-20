import { expect, it, vi } from 'vitest'
import { ModelRouting } from '../src/model-routing.ts'
import { agentProfileRecordSchema, controlIntentActorSchema, developmentProjectRecordSchema } from '../src/spec.ts'
import { configureProjectModelRouteIntentSchema, resolvedAccountModelRouteSchema } from '../src/model-routing-spec.ts'
import type { AgentProfileModelRouteRecord, ProjectModelRouteIntentRecord } from '../src/model-routing-spec.ts'
import { MemoryTable } from './model-account-memory-table.ts'

const uuid = '00000000-0000-4000-8000-000000000001'
const actor = controlIntentActorSchema.parse({
  installationId: `installation-${uuid}`, storageGenerationId: `storage-generation-${uuid}`,
  hostId: `host-${uuid}`, principalId: `principal-${uuid}`, principalRevision: 1,
  grantId: `grant-${uuid}`, grantRevision: 1,
})
const request = configureProjectModelRouteIntentSchema.parse({
  type: 'configure-project-model-route', intentId: `intent-${uuid}`, projectId: `project-${uuid}`,
  expectedProjectRevision: 0, selection: { accountProfileId: uuid, configurationRevision: 1, model: 'fixture-model' },
})

function setup() {
  const profiles = new MemoryTable<AgentProfileModelRouteRecord['id'], AgentProfileModelRouteRecord>()
  const intents = new MemoryTable<ProjectModelRouteIntentRecord['id'], ProjectModelRouteIntentRecord>()
  const initial = agentProfileRecordSchema.parse({ id: 'agent-profile-00000000-0000-4000-8000-000000000002',
    projectId: request.projectId, version: 1, agentPresetId: 'development', modelRouteRequest: null, createdAt: 1 })
  let project = developmentProjectRecordSchema.parse({ id: request.projectId, revision: 0, projectTitle: 'Fixture',
    resourceBindingId: `binding-${uuid}`, state: 'active', createdAt: 1, defaultAgentProfileId: initial.id })
  const agentProfiles = [initial]
  let authorized = true
  type Options = ConstructorParameters<typeof ModelRouting>[0]
  const publish = vi.fn<Options['projects']['selectAgentProfile']>(async (profile, revision, mayPublish) => {
    if (agentProfiles.some(item => item.id === profile.id)) return 'selected'
    if (!mayPublish()) return 'denied'
    if (project.revision !== revision) return 'conflict'
    agentProfiles.push(profile)
    project = { ...project, defaultAgentProfileId: profile.id, revision: project.revision + 1 }
    return 'selected'
  })
  const resolveSelection = vi.fn<Options['supply']['resolveSelection']>(async selection => resolvedAccountModelRouteSchema.parse({
    selection, provider: `saki-account-${uuid}-1`, accountIdentity: 'fixture-account',
    implementation: { name: 'fixture', version: '1' }, configuration: { reasoning: 'medium' },
  }))
  const options: Options = { profiles, intents, projects: { registry: () => ({ projects: [project], agentProfiles }),
    selectAgentProfile: publish }, supply: { resolveSelection }, authorityCurrent: () => authorized,
  notifyChanged: () => {}, lifetime: new AbortController().signal }
  const routing = new ModelRouting(options)
  return { options, routing, profiles, intents, agentProfiles, publish, resolveSelection,
    revoke: () => { authorized = false }, signal: new AbortController().signal }
}

it('coalesces exact selection replay and preserves the previously selected Profile', async () => {
  const h = setup()
  try {
    const results = await Promise.all([h.routing.submit(request, actor, h.signal), h.routing.submit(request, actor, h.signal)])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ ok: true, receipt: { state: 'completed' } })
    expect(h.resolveSelection).toHaveBeenCalledTimes(1)
    expect(h.agentProfiles).toHaveLength(2)
    expect(h.agentProfiles[0]?.modelRouteRequest).toBeNull()
    expect(h.agentProfiles[1]?.modelRouteRequest).toEqual({ provider: `saki-account-${uuid}-1`, model: 'fixture-model' })
    expect(h.profiles.size).toBe(1)
    expect(await h.routing.submit({ ...request, selection: { ...request.selection, model: 'another-model' } }, actor, h.signal))
      .toEqual({ ok: false, reason: 'conflict' })
  } finally { await h.routing.dispose() }
})

it('repairs lost acknowledgement without re-resolving or replacing the published Profile', async () => {
  const h = setup()
  const put = h.intents.put.bind(h.intents)
  vi.spyOn(h.intents, 'put').mockImplementationOnce(put).mockRejectedValueOnce(new Error('ack write interrupted'))
  await expect(h.routing.submit(request, actor, h.signal)).rejects.toThrow('ack write interrupted')
  await h.routing.dispose()
  expect(h.agentProfiles).toHaveLength(2)
  expect(h.intents.get(request.intentId)?.state).toBe('accepted')
  const recovered = new ModelRouting(h.options)
  try {
    await recovered.recover()
    expect(h.intents.get(request.intentId)?.state).toBe('completed')
    expect(h.resolveSelection).toHaveBeenCalledTimes(1)
    expect(h.agentProfiles).toHaveLength(2)
  } finally { await recovered.dispose() }
})

it('checks authority again after account resolution completes', async () => {
  const h = setup()
  const original = h.resolveSelection.getMockImplementation()!
  h.resolveSelection.mockImplementation(async (selection, signal) => {
    const route = await original(selection, signal)
    h.revoke()
    return route
  })
  try {
    expect(await h.routing.submit(request, actor, h.signal)).toEqual({ ok: false, reason: 'denied' })
    expect(h.publish).not.toHaveBeenCalled()
    expect(h.intents.size).toBe(0)
  } finally { await h.routing.dispose() }
})

it('rejects a competing selection at the same Project revision without resolving it', async () => {
  const h = setup()
  const other = configureProjectModelRouteIntentSchema.parse({ ...request,
    intentId: 'intent-00000000-0000-4000-8000-000000000003' })
  try {
    const results = await Promise.all([h.routing.submit(request, actor, h.signal), h.routing.submit(other, actor, h.signal)])
    expect(results[0]).toMatchObject({ ok: true, receipt: { state: 'completed' } })
    expect(results[1]).toEqual({ ok: false, reason: 'conflict' })
    expect(h.resolveSelection).toHaveBeenCalledTimes(1)
  } finally { await h.routing.dispose() }
})

it('replaying a previous selection preserves the newer Project default', async () => {
  const h = setup()
  try {
    await h.routing.submit(request, actor, h.signal)
    const next = configureProjectModelRouteIntentSchema.parse({ ...request, expectedProjectRevision: 1,
      intentId: 'intent-00000000-0000-4000-8000-000000000003' })
    await h.routing.submit(next, actor, h.signal)
    const selected = h.routing.projectProjection(request.projectId)
    await h.routing.submit(request, actor, h.signal)
    expect(h.routing.projectProjection(request.projectId)).toEqual(selected)
    expect(selected?.profile.version).toBe(3)
    expect(selected?.profile.account).not.toHaveProperty('configuration')
    expect(h.agentProfiles).toHaveLength(3)
  } finally { await h.routing.dispose() }
})

it('blocks changed implementation facts and missing account attribution before dispatch', async () => {
  const h = setup()
  try {
    await h.routing.submit(request, actor, h.signal)
    const profile = h.agentProfiles[1]!
    await h.routing.validateAdmission(profile, h.signal)
    const original = h.resolveSelection.getMockImplementation()!
    h.resolveSelection.mockImplementation(async (selection, signal) => ({ ...await original(selection, signal),
      implementation: { name: 'fixture', version: '2' } }))
    await expect(h.routing.validateAdmission(profile, h.signal)).rejects.toThrow('Selected account route changed')
    await h.profiles.delete(profile.id)
    await expect(h.routing.validateAdmission(profile, h.signal)).rejects.toThrow('Account route attribution is missing')
  } finally { await h.routing.dispose() }
})
