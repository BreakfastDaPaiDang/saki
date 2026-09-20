/** Durable Project model selection and immutable Agent Profile attribution. @module @breakfastdapaidang/saki-control-plane/model-routing */

import { isDeepStrictEqual } from 'node:util'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { sakiAgentProfileIdSchema } from './ids.ts'
import type { SakiAgentProfileId, SakiControlIntentId } from './types.ts'
import type { AgentProfileRecord, ControlIntentActor, DevelopmentProjectRegistryRecord } from './spec.ts'
import type { DevelopmentProjects } from './projects.ts'
import type { ModelSupply } from './model-supply.ts'
import { enqueueKeyedOperation } from './keyed-operation.ts'
import { agentProfileModelRouteRecordSchema, projectModelRouteIntentRecordSchema } from './model-routing-spec.ts'
import type {
  AgentProfileModelRouteRecord, ConfigureProjectModelRouteIntent, ProjectModelRouteIntentRecord,
  ProjectModelRouteProjection,
} from './model-routing-spec.ts'

/** Permanent account resolutions keyed by immutable Agent Profile identity. */
export type AgentProfileModelRouteTable = KvTable<SakiAgentProfileId, AgentProfileModelRouteRecord>
/** Exact model selection Intents and their acknowledgements. */
export type ProjectModelRouteIntentTable = KvTable<SakiControlIntentId, ProjectModelRouteIntentRecord>

/** Closed admission result without provider or credential error text. */
export type ProjectModelRouteResult =
  | {
    readonly ok: true
    readonly receipt: {
      readonly intentId: SakiControlIntentId
      readonly state: ProjectModelRouteIntentRecord['state']
      readonly profileId: SakiAgentProfileId
    }
  }
  | { readonly ok: false; readonly reason: 'denied' | 'conflict' | 'unavailable' }

interface Options {
  readonly profiles: AgentProfileModelRouteTable
  readonly intents: ProjectModelRouteIntentTable
  readonly projects: Pick<DevelopmentProjects, 'selectAgentProfile'> & {
    registry(): Pick<DevelopmentProjectRegistryRecord, 'projects' | 'agentProfiles'>
  }
  readonly supply: Pick<ModelSupply, 'resolveSelection'>
  readonly authorityCurrent: (actor: ControlIntentActor) => boolean
  readonly notifyChanged: () => void
  readonly lifetime: AbortSignal
}

/** Project defaults allocate new Profiles; retained Runs keep their prior Profile identity. */
export class ModelRouting {
  private readonly operations = new Map<string, Promise<void>>()
  private closed = false

  constructor(private readonly options: Options) {}

  /**
   * Project the current default and its retained account attribution.
   * @param projectId - selected Development Project.
   * @returns safe selection facts, absent when the Project does not exist.
   */
  projectProjection(projectId: ConfigureProjectModelRouteIntent['projectId']): ProjectModelRouteProjection | undefined {
    const registry = this.options.projects.registry()
    const project = registry.projects.find(candidate => candidate.id === projectId)
    if (project === undefined) return undefined
    const profile = registry.agentProfiles.find(candidate => candidate.id === project.defaultAgentProfileId)
    if (profile === undefined) throw new Error('Project Agent Profile is absent')
    const route = this.options.profiles.get(profile.id)?.route
    return { type: 'project-model-route', projectId, projectRevision: project.revision,
      profile: { id: profile.id, version: profile.version, agentPresetId: profile.agentPresetId,
        provider: profile.modelRouteRequest?.provider ?? null, model: profile.modelRouteRequest?.model ?? null,
        account: route === undefined ? null : { selection: structuredClone(route.selection), provider: route.provider,
          accountIdentity: route.accountIdentity, implementation: { ...route.implementation } } } }
  }

  /**
   * Recheck the captured account without following a changed Project default.
   * @param profile - versioned Profile captured by execution admission.
   * @param signal - admission lifetime before model I/O.
   * @returns after the exact account, implementation and configuration remain eligible.
   */
  async validateAdmission(profile: AgentProfileRecord, signal: AbortSignal): Promise<void> {
    const retained = this.options.profiles.get(profile.id)
    if (retained === undefined) {
      if (profile.modelRouteRequest?.provider.startsWith('saki-account-')) throw new Error('Account route attribution is missing')
      return
    }
    if (profile.version !== retained.profileVersion || profile.projectId !== retained.projectId
      || profile.modelRouteRequest?.provider !== retained.route.provider
      || profile.modelRouteRequest.model !== retained.route.selection.model) throw new Error('Agent Profile route attribution conflicts')
    const resolved = await this.options.supply.resolveSelection(retained.route.selection, signal)
    if (!isDeepStrictEqual(resolved, retained.route)) throw new Error('Selected account route changed')
  }

  /**
   * Admit or replay one attributed Project default selection.
   * @param request - exact expected-revision request with an explicit account selection.
   * @param actor - current Host authority for this request.
   * @param signal - admission cancellation before the durable Intent exists.
   * @returns stable receipt or a closed rejection.
   */
  async submit(
    request: ConfigureProjectModelRouteIntent, actor: ControlIntentActor, signal: AbortSignal,
  ): Promise<ProjectModelRouteResult> {
    return await enqueueKeyedOperation(this.operations, request.projectId, async () => {
      signal.throwIfAborted()
      if (this.closed || this.options.lifetime.aborted) return { ok: false, reason: 'unavailable' }
      if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
      const retained = this.options.intents.get(request.intentId)
      if (retained !== undefined) {
        if (!isDeepStrictEqual(retained.request, request) || !isDeepStrictEqual(retained.actor, actor)) {
          return { ok: false, reason: 'conflict' }
        }
        return await this.finish(retained)
      }
      const registry = this.options.projects.registry()
      const project = registry.projects.find(candidate => candidate.id === request.projectId)
      if (project === undefined || project.revision !== request.expectedProjectRevision) return { ok: false, reason: 'conflict' }
      const previous = registry.agentProfiles.find(candidate => candidate.id === project.defaultAgentProfileId)
      if (previous === undefined) throw new Error('Project default Agent Profile is absent')
      let route
      try {
        route = await this.options.supply.resolveSelection(request.selection, signal)
      } catch {
        // Account inspection failures may contain credential or provider response text.
        signal.throwIfAborted()
        return { ok: false, reason: 'unavailable' }
      }
      signal.throwIfAborted()
      if (!this.options.authorityCurrent(actor)) return { ok: false, reason: 'denied' }
      const createdAt = Date.now()
      const profile = agentProfileModelRouteRecordSchema.parse({ schemaVersion: 1,
        id: sakiAgentProfileIdSchema.parse(`agent-profile-${request.intentId.slice('intent-'.length)}`),
        projectId: project.id, profileVersion: previous.version + 1, agentPresetId: previous.agentPresetId,
        intentId: request.intentId, route, createdAt })
      const record = projectModelRouteIntentRecordSchema.parse({ schemaVersion: 1, id: request.intentId,
        request, actor, profile, state: 'accepted', createdAt, updatedAt: createdAt })
      await this.options.intents.put(record.id, record)
      return await this.finish(record)
    })
  }

  /** Repair publication acknowledgement without resolving a different account or Profile. */
  async recover(): Promise<void> {
    for (const [, record] of this.options.intents.entries()) {
      if (record.state === 'accepted') await this.finish(record)
    }
  }

  /** Wait until all admitted Project selection work has settled. */
  async dispose(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.operations.values())
  }

  private async finish(record: ProjectModelRouteIntentRecord): Promise<ProjectModelRouteResult> {
    if (record.state === 'accepted') {
      const registry = this.options.projects.registry()
      const published = registry.agentProfiles.some(profile => profile.id === record.profile.id)
      const project = registry.projects.find(candidate => candidate.id === record.request.projectId)
      let state: ProjectModelRouteIntentRecord['state'] = !published && (!this.options.authorityCurrent(record.actor)
        || project?.revision !== record.request.expectedProjectRevision) ? 'failed' : 'completed'
      if (state === 'completed') {
        const profile = record.profile
        const existing = this.options.profiles.get(profile.id)
        if (existing !== undefined && !isDeepStrictEqual(existing, profile)) throw new Error('Model resolution identity conflict')
        if (existing === undefined) await this.options.profiles.put(profile.id, profile)
        const publication = await this.options.projects.selectAgentProfile({ id: profile.id, projectId: profile.projectId,
          version: profile.profileVersion, agentPresetId: profile.agentPresetId,
          modelRouteRequest: { provider: profile.route.provider, model: profile.route.selection.model },
          createdAt: profile.createdAt }, record.request.expectedProjectRevision,
        () => !this.closed && !this.options.lifetime.aborted && this.options.authorityCurrent(record.actor))
        if (publication !== 'selected') state = 'failed'
      }
      record = { ...record, state, updatedAt: Math.max(record.updatedAt, Date.now()) }
      await this.options.intents.put(record.id, record)
      this.options.notifyChanged()
    }
    return { ok: true, receipt: { intentId: record.id, state: record.state, profileId: record.profile.id } }
  }
}
