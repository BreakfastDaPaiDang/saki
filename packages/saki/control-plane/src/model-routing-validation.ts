/** Cross-record validation for retained model selection. @module @breakfastdapaidang/saki-control-plane/model-routing-validation */

import { isDeepStrictEqual } from 'node:util'
import type { ControlIntentActor, DevelopmentProjectRegistryRecord } from './spec.ts'
import type { AgentProfileModelRouteTable, ProjectModelRouteIntentTable } from './model-routing.ts'
import { agentProfileModelRouteRecordSchema, projectModelRouteIntentRecordSchema } from './model-routing-spec.ts'
import type { ResolvedAccountModelRoute, ProjectModelRouteIntentRecord } from './model-routing-spec.ts'
import type { ModelAccountTable, ModelAccountIntentTable } from './model-supply.ts'

/**
 * Validate route ownership and partially acknowledged Registry publication without effects.
 * @param profiles - all retained immutable Profile resolutions.
 * @param intents - all model selection Intents.
 * @param registry - retained Project Registry, absent only before provisioning.
 * @param accounts - account identity and immutable authorization history.
 * @param validateActor - Foundation-owned historical Actor reference validation.
 * @returns detached Intents for cross-family identity validation and recovery.
 */
export function validateModelRoutingRecords(
  profiles: Pick<AgentProfileModelRouteTable, 'entries' | 'get'>,
  intents: Pick<ProjectModelRouteIntentTable, 'entries' | 'get'>,
  registry: DevelopmentProjectRegistryRecord | undefined,
  accounts: {
    readonly profiles: Pick<ModelAccountTable, 'get'>
    readonly intents: Pick<ModelAccountIntentTable, 'entries'>
  },
  validateActor: (actor: ControlIntentActor) => void,
): readonly ProjectModelRouteIntentRecord[] {
  const parsed = [...intents.entries()].map(([key, value]) => {
    const record = projectModelRouteIntentRecordSchema.parse(value)
    const { profile, request } = record
    if (record.id !== key || request.intentId !== record.id || profile.intentId !== record.id
      || profile.id !== `agent-profile-${record.id.slice('intent-'.length)}`
      || profile.projectId !== request.projectId || !isDeepStrictEqual(profile.route.selection, request.selection)
      || record.updatedAt < record.createdAt || profile.createdAt !== record.createdAt
      || !registry?.projects.some(project => project.id === request.projectId)) {
      throw new Error('Model route Intent ownership is inconsistent')
    }
    validateActor(record.actor)
    validateCapturedModelRoute(profile.route, accounts)
    const published = registry.agentProfiles.find(candidate => candidate.id === profile.id)
    if (record.state === 'completed' && published === undefined) throw new Error('Completed model route lacks its Agent Profile')
    if (published !== undefined && (!isDeepStrictEqual(profiles.get(profile.id), profile)
      || !isDeepStrictEqual(published, { id: profile.id, projectId: profile.projectId, version: profile.profileVersion,
        agentPresetId: profile.agentPresetId, modelRouteRequest: { provider: profile.route.provider, model: profile.route.selection.model },
        createdAt: profile.createdAt }))) throw new Error('Published model route attribution is inconsistent')
    return record
  })
  for (const [key, value] of profiles.entries()) {
    const profile = agentProfileModelRouteRecordSchema.parse(value)
    const owner = intents.get(profile.intentId)
    if (key !== profile.id || owner === undefined || !isDeepStrictEqual(owner.profile, profile)) {
      throw new Error('Agent Profile model route has no exact owning Intent')
    }
  }
  for (const project of registry?.projects ?? []) {
    const published = parsed.filter(record => record.profile.projectId === project.id
      && registry?.agentProfiles.some(profile => profile.id === record.profile.id))
      .toSorted((left, right) => left.request.expectedProjectRevision - right.request.expectedProjectRevision)
    if (project.revision !== published.length || published.some((record, index) =>
      record.request.expectedProjectRevision !== index || record.profile.profileVersion !== index + 2
      || record.state === 'failed')
      || (published.length > 0 && project.defaultAgentProfileId !== published.at(-1)?.profile.id)) {
      throw new Error('Project model selection history disagrees with its current revision')
    }
  }
  return parsed
}

/**
 * Check an immutable route against retained account identity and authorization history.
 * @param route - captured account configuration and implementation.
 * @param accounts - durable Profile and authorization records.
 */
export function validateCapturedModelRoute(route: ResolvedAccountModelRoute, accounts: {
  readonly profiles: Pick<ModelAccountTable, 'get'>
  readonly intents: Pick<ModelAccountIntentTable, 'entries'>
}): void {
  const account = accounts.profiles.get(route.selection.accountProfileId)
  const authorization = [...accounts.intents.entries()].some(([, intent]) => intent.binding?.routeId === route.provider
    && intent.profileId === account?.id && isDeepStrictEqual(intent.binding.configuration, route.configuration)
    && isDeepStrictEqual(intent.implementation, route.implementation))
  if (account?.binding.accountIdentity !== route.accountIdentity || !authorization) {
    throw new Error('Model route lacks its exact account authorization')
  }
}
