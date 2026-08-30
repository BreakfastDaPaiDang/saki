/** Frozen relationship validation for the exact Saki control-plane v4 migration source. */

import type { Domain, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import { isDeepStrictEqual } from 'node:util'
import type { sakiControlPlaneV4DomainSpec } from './migration.ts'
import { v4CanonicalDigest } from './migration-v4-canonical.ts'
import {
  githubSynchronizationConfigurationSchema as v4GitHubSynchronizationConfigurationSchema,
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from './migration-v4-github.ts'
import { v4Source } from './migration-v4-source.ts'
import type { sakiStorageGenerationV2DomainSpec } from './state-version.ts'

/* Historical relationship validation intentionally duplicates the exact v4 producer semantics. */
/* jscpd:ignore-start */
const {
  V4_CONTROL_STATE_KEY,
  V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
  V4_STORAGE_GENERATION_KEY,
} = v4Source

type V4ControlPlaneDomain = Domain<typeof sakiControlPlaneV4DomainSpec>
type V4StorageGenerationDomain = Domain<typeof sakiStorageGenerationV2DomainSpec>
type V4ControlState = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'control_state'>
type V4Installation = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'installations'>
type V4Host = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'hosts'>
type V4Principal = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'principals'>
type V4Grant = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'grants'>
type V4InstallationAccess = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'installation_access'>
type V4Registry = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'development_project_registry'>
type V4RegistrationIntent = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'registration_intents'>
type V4GitHubSync = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'github_project_sync'>
type V4GitHubIntent = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'github_sync_configuration_intents'>
type V4StorageGenerationSeal = TableValueOf<typeof sakiStorageGenerationV2DomainSpec, 'storage_generation'>
type V4InstallationId = V4Installation['id']
type V4HostId = V4Host['id']
type V4PrincipalId = V4Principal['id']
type V4GrantId = V4Grant['id']
type V4InstallationAccessId = V4InstallationAccess['id']
type V4BrowserSessionId = V4InstallationAccess['sessions'][number]['id']
type V4DevelopmentProjectId = V4Registry['projects'][number]['id']
type V4RegistrationActor = V4RegistrationIntent['payload']['actor']
type V4GitHubConfiguration = NonNullable<V4GitHubSync['active']>['configuration']

interface V4FoundationSnapshot {
  readonly control: V4ControlState
  readonly installations: ReadonlyMap<V4InstallationId, V4Installation>
  readonly hosts: ReadonlyMap<V4HostId, V4Host>
  readonly principals: ReadonlyMap<V4PrincipalId, V4Principal>
  readonly grants: ReadonlyMap<V4GrantId, V4Grant>
}

interface ValidatedV4Projects {
  readonly registry: V4Registry
  readonly intents: readonly V4RegistrationIntent[]
  readonly projectIds: ReadonlySet<V4DevelopmentProjectId>
}

interface HistoricalProjectMappingState {
  readonly registryRevision: number
  readonly intentId: string
  readonly projectId: string
  readonly resourceBindingId: string
}

interface HistoricalProjectRegistryState {
  readonly revision: number
  readonly intentMappings: readonly HistoricalProjectMappingState[]
}

interface HistoricalProjectIntentState {
  readonly id: string
  readonly phase: string
  readonly projectId?: string | undefined
  readonly resourceBindingId?: string | undefined
  readonly registryRevision?: number | undefined
  readonly payload: { readonly intent: { readonly expectedRegistryRevision: number } }
}

/**
 * Validate exact v4 product relationships and its historical storage-generation seal.
 * This source validator reads only tables declared by `saki_control_plane@4`; later
 * admission and Git-operation tables are not part of the migration source.
 * @param controlPlane - opened exact `saki_control_plane@4` source domain.
 * @param storageGeneration - opened exact `saki_storage_generation@2` source domain.
 * @param expectedInstallationId - Installation selected by maintenance metadata.
 * @param expectedStorageGenerationId - physical generation selected by maintenance metadata.
 * @param expectedCreatedByBuildId - generation provenance repeated by the seal.
 * @returns nothing after all retained v4 product invariants pass.
 */
export function validateSakiV4SourceState(
  controlPlane: V4ControlPlaneDomain,
  storageGeneration: V4StorageGenerationDomain,
  expectedInstallationId: V4InstallationId,
  expectedStorageGenerationId: V4StorageGenerationSeal['storageGenerationId'],
  expectedCreatedByBuildId: V4StorageGenerationSeal['createdByBuildId'],
): void {
  validateStorageGenerationV2Seal(
    storageGeneration,
    expectedInstallationId,
    expectedStorageGenerationId,
    expectedCreatedByBuildId,
  )
  const foundation = validateFoundationAndAccess(controlPlane, expectedInstallationId)
  const projects = validateV4Projects(controlPlane, foundation)
  validateV4GitHub(controlPlane, foundation, projects)
}

function validateStorageGenerationV2Seal(
  domain: V4StorageGenerationDomain,
  expectedInstallationId: V4InstallationId,
  expectedStorageGenerationId: V4StorageGenerationSeal['storageGenerationId'],
  expectedCreatedByBuildId: V4StorageGenerationSeal['createdByBuildId'],
): void {
  const entries = [...domain.table('storage_generation').entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== V4_STORAGE_GENERATION_KEY) {
    throw new Error('historical Saki v4 storage generation seal is not the required singleton')
  }
  const seal = entries[0][1]
  if (seal.installationId !== expectedInstallationId
    || seal.storageGenerationId !== expectedStorageGenerationId
    || seal.createdByBuildId !== expectedCreatedByBuildId) {
    throw new Error('historical Saki v4 storage generation seal disagrees with selected generation metadata')
  }
}

function validateFoundationAndAccess(
  domain: V4ControlPlaneDomain,
  expectedInstallationId: V4InstallationId,
): V4FoundationSnapshot {
  const controlEntries = [...domain.table('control_state').entries()]
  const installations = identifiedRecords(domain.table('installations').entries(), 'Installation')
  const hosts = identifiedRecords(domain.table('hosts').entries(), 'Host')
  const principals = identifiedRecords(domain.table('principals').entries(), 'Principal')
  const grants = identifiedRecords(domain.table('grants').entries(), 'Grant')
  const accessRecords = identifiedRecords(domain.table('installation_access').entries(), 'Installation Access')
  if (controlEntries.length !== 1 || controlEntries[0]?.[0] !== V4_CONTROL_STATE_KEY) {
    throw new Error('Saki control state is not the required singleton')
  }
  const control = controlEntries[0][1]
  if (control.phase !== 'ready') throw new Error('Saki control-plane provisioning is not ready')
  if (control.installationId !== expectedInstallationId) {
    throw new Error('Saki control state belongs to another Installation')
  }

  const installation = requiredRecord(installations, control.installationId, 'Installation')
  const initialHost = requiredRecord(hosts, control.initialHostId, 'Host')
  const currentHost = requiredRecord(hosts, installation.currentHostId, 'Host')
  const principal = requiredRecord(principals, control.hostOperatorPrincipalId, 'Principal')
  const grant = requiredRecord(grants, control.hostOperatorGrantId, 'Grant')
  if (principal.kind !== 'human') throw new Error('Saki Host Operator Principal must be human')
  if (initialHost.installationId !== installation.id
    || currentHost.installationId !== installation.id
    || grant.installationId !== installation.id
    || grant.principalId !== principal.id
    || grant.scope.installationId !== installation.id) {
    throw new Error('Saki control-plane Foundation relationships are inconsistent')
  }

  const foundation = { control, installations, hosts, principals, grants }
  validateAccessRecords(accessRecords, foundation)
  return foundation
}

function validateAccessRecords(
  accessRecords: ReadonlyMap<V4InstallationAccessId, V4InstallationAccess>,
  foundation: V4FoundationSnapshot,
): void {
  if (accessRecords.size !== 1) throw new Error('Saki Installation Access is not the required singleton')
  const record = accessRecords.get(foundation.control.installationAccessId)
  if (record === undefined) {
    throw new Error('Saki Installation Access belongs to another provisioning owner')
  }
  validateInstallationAccessRecord(record, foundation)
}

function validateInstallationAccessRecord(
  record: V4InstallationAccess,
  foundation: V4FoundationSnapshot,
): void {
  if (record.id !== foundation.control.installationAccessId
    || record.installationId !== foundation.control.installationId) {
    throw new Error('Saki Installation Access belongs to another provisioning owner')
  }
  const challengeIds = new Set<string>()
  const challengeOrdinals = new Set<number>()
  const challengeDigests = new Set<string>()
  const sessionIds = new Set<string>()
  const sessionOrdinals = new Set<number>()
  const sessionDigests = new Set<string>()

  for (const challenge of record.challenges) {
    const terminal = challenge.state !== 'issued'
    if (challenge.id !== childId(record.id, 'challenge', challenge.ordinal)
      || challenge.ordinal >= record.nextChallengeOrdinal
      || challengeIds.has(challenge.id)
      || challengeOrdinals.has(challenge.ordinal)
      || challengeDigests.has(challenge.verifierDigest)
      || terminal !== (challenge.terminalAt !== undefined)
      || (terminal && challenge.revision === 0)
      || challenge.expiresAt <= challenge.issuedAt
      || (challenge.terminalAt !== undefined && challenge.terminalAt < challenge.issuedAt)
      || (challenge.state === 'expired' && (challenge.terminalAt ?? -1) < challenge.expiresAt)
      || (challenge.state === 'consumed') !== (challenge.browserSessionId !== undefined)) {
      throw new Error('Saki Installation Access contains an invalid Bootstrap Challenge')
    }
    if (challenge.installationId !== record.installationId) {
      throw new Error('Saki Bootstrap Challenge belongs to another Installation')
    }
    const installation = requiredRecord(foundation.installations, challenge.installationId, 'Installation')
    const host = requiredRecord(foundation.hosts, challenge.hostId, 'Host')
    requiredRecord(foundation.principals, challenge.principalId, 'Principal')
    if (host.installationId !== installation.id) {
      throw new Error('Saki Bootstrap Challenge references an unrelated Host')
    }
    challengeIds.add(challenge.id)
    challengeOrdinals.add(challenge.ordinal)
    challengeDigests.add(challenge.verifierDigest)
  }

  for (const session of record.sessions) {
    const terminal = session.state !== 'active'
    if (session.id !== childId(record.id, 'session', session.ordinal)
      || session.ordinal >= record.nextSessionOrdinal
      || sessionIds.has(session.id)
      || sessionOrdinals.has(session.ordinal)
      || sessionDigests.has(session.cookieDigest)
      || terminal !== (session.terminalAt !== undefined)
      || (terminal && session.revision === 0)
      || session.expiresAt <= session.createdAt
      || (session.terminalAt !== undefined && session.terminalAt < session.createdAt)
      || (session.state === 'expired' && (session.terminalAt ?? -1) < session.expiresAt)) {
      throw new Error('Saki Installation Access contains an invalid Browser Session')
    }
    if (session.installationId !== record.installationId) {
      throw new Error('Saki Browser Session belongs to another Installation')
    }
    requiredRecord(foundation.installations, session.installationId, 'Installation')
    requiredRecord(foundation.principals, session.principalId, 'Principal')
    sessionIds.add(session.id)
    sessionOrdinals.add(session.ordinal)
    sessionDigests.add(session.cookieDigest)
  }

  const consumedSessionIds = new Set<V4BrowserSessionId>()
  for (const challenge of record.challenges) {
    if (challenge.browserSessionId === undefined) continue
    if (consumedSessionIds.has(challenge.browserSessionId)) {
      throw new Error('Saki multiple Bootstrap Challenges reference one Browser Session')
    }
    const session = record.sessions.find(candidate => candidate.id === challenge.browserSessionId)
    if (session === undefined
      || session.installationId !== challenge.installationId
      || challenge.storageGenerationId !== session.storageGenerationId
      || session.principalId !== challenge.principalId
      || session.createdAt !== challenge.terminalAt) {
      throw new Error('Saki consumed Bootstrap Challenge references an inconsistent Browser Session')
    }
    consumedSessionIds.add(challenge.browserSessionId)
  }

  validateBootstrapCompletion(record, foundation)
}

function validateBootstrapCompletion(
  record: V4InstallationAccess,
  foundation: V4FoundationSnapshot,
): void {
  const completion = record.bootstrapCompletion
  if (completion === undefined) {
    if (record.sessions.length !== 0
      || record.challenges.some(challenge =>
        challenge.purpose !== 'initial-bootstrap' || challenge.state === 'consumed')) {
      throw new Error('Saki Installation Access contains reauthentication state before bootstrap completion')
    }
    return
  }

  if (!allocatedEntryId(record.id, 'challenge', completion.challengeId, record.nextChallengeOrdinal)
    || !allocatedEntryId(record.id, 'session', completion.sessionId, record.nextSessionOrdinal)) {
    throw new Error('Saki bootstrap completion references an unallocated entry identity')
  }

  const completionHost = requiredRecord(foundation.hosts, completion.hostId, 'Host')
  requiredRecord(foundation.principals, completion.principalId, 'Principal')
  if (completionHost.installationId !== record.installationId
    || record.challenges.some(challenge =>
      challenge.purpose === 'initial-bootstrap'
      && (challenge.state === 'issued'
        || (challenge.state === 'consumed' && challenge.id !== completion.challengeId)))) {
    throw new Error('Saki Installation Access contains an invalid bootstrap completion')
  }
  const completionChallenge = record.challenges.find(challenge => challenge.id === completion.challengeId)
  if (completionChallenge !== undefined
    && (completionChallenge.purpose !== 'initial-bootstrap'
      || completionChallenge.state !== 'consumed'
      || completionChallenge.browserSessionId !== completion.sessionId
      || completionChallenge.hostId !== completion.hostId
      || completionChallenge.principalId !== completion.principalId
      || completionChallenge.terminalAt !== completion.completedAt)) {
    throw new Error('Saki bootstrap completion disagrees with its retained challenge')
  }
  const completionSession = record.sessions.find(session => session.id === completion.sessionId)
  if (completionSession !== undefined
    && (completionSession.principalId !== completion.principalId
      || completionSession.createdAt !== completion.completedAt)) {
    throw new Error('Saki bootstrap completion disagrees with its retained Browser Session')
  }
}

function validateV4Projects(
  domain: V4ControlPlaneDomain,
  foundation: V4FoundationSnapshot,
): ValidatedV4Projects {
  const registryEntries = [...domain.table('development_project_registry').entries()]
  const registryEntry = registryEntries[0]
  if (registryEntries.length !== 1 || registryEntry?.[0] !== V4_DEVELOPMENT_PROJECT_REGISTRY_KEY) {
    throw new Error('historical Saki v4 Project Registry is not the required singleton')
  }
  const registry = registryEntry[1]
  const intents = [...domain.table('registration_intents').entries()].map(([key, value]) => {
    if (key !== value.id) throw new Error('historical Saki v4 registration Intent id disagrees with its table key')
    validateRegistrationActorReference(value.payload.actor, foundation)
    return value
  })
  validateHistoricalProjectMappings([registry], intents)

  const intentById = new Map(intents.map(intent => [intent.id, intent] as const))
  for (const mapping of registry.intentMappings) {
    const intent = intentById.get(mapping.intentId)
    const project = registry.projects.find(candidate => candidate.id === mapping.projectId)
    const binding = registry.resourceBindings.find(candidate => candidate.id === mapping.resourceBindingId)
    if (intent === undefined || project === undefined || binding === undefined) {
      throw new Error(`historical Saki v4 registration mapping '${mapping.intentId}' has incomplete children`)
    }
    if (project.projectTitle !== intent.payload.intent.projectTitle
      || project.revision !== 0
      || binding.hostId !== intent.payload.intent.hostId
      || binding.workspaceId !== intent.workspaceId
      || !isDeepStrictEqual(binding.registrationInspection, intent.inspection)
      || !isDeepStrictEqual(binding.inheritedChangeBaseline, intent.payload.intent.confirmedBaseline)) {
      throw new Error(`historical Saki v4 registration Intent '${intent.id}' disagrees with its committed children`)
    }
    if (intent.phase === 'workspace-observed' || intent.phase === 'registry-committed') {
      if (intent.workspaceInspection === undefined
        || binding.revision !== 0
        || !isDeepStrictEqual(binding.currentInspection, intent.workspaceInspection)) {
        throw new Error(`historical Saki v4 registration Intent '${intent.id}' has invalid initial Binding evidence`)
      }
    }
    if (intent.phase === 'confirmed' && binding.revision === 0
      && !isDeepStrictEqual(binding.currentInspection, intent.workspaceInspection)) {
      throw new Error(`historical Saki v4 registration Intent '${intent.id}' disagrees with its initial current inspection`)
    }
    if (binding.revision > registry.revision - mapping.registryRevision) {
      throw new Error(`historical Saki v4 registration Intent '${intent.id}' has an unreachable Binding revision`)
    }
  }
  return {
    registry,
    intents,
    projectIds: new Set(registry.projects.map(project => project.id)),
  }
}

function validateHistoricalProjectMappings(
  registries: readonly HistoricalProjectRegistryState[],
  intents: readonly HistoricalProjectIntentState[],
): void {
  if (registries.length !== 1) throw new Error('historical Saki Project Registry has an invalid singleton key')
  const registry = registries[0] as HistoricalProjectRegistryState
  const byId = new Map(intents.map(intent => [intent.id, intent] as const))
  for (const mapping of registry.intentMappings) {
    const intent = byId.get(mapping.intentId)
    if (intent === undefined || (intent.phase !== 'workspace-observed'
      && intent.phase !== 'registry-committed' && intent.phase !== 'confirmed')) {
      throw new Error(`historical registration mapping '${mapping.intentId}' has no committed Intent`)
    }
    if (mapping.registryRevision !== intent.payload.intent.expectedRegistryRevision + 1
      || mapping.registryRevision > registry.revision
      || (intent.phase !== 'workspace-observed' && (intent.projectId !== mapping.projectId
        || intent.resourceBindingId !== mapping.resourceBindingId
        || intent.registryRevision !== mapping.registryRevision))) {
      throw new Error(`historical registration Intent '${intent.id}' disagrees with its mapping`)
    }
  }
  for (const intent of intents) {
    if ((intent.phase === 'registry-committed' || intent.phase === 'confirmed')
      && !registry.intentMappings.some(mapping => mapping.intentId === intent.id)) {
      throw new Error(`historical committed registration Intent '${intent.id}' has no mapping`)
    }
  }
}

function validateV4GitHub(
  domain: V4ControlPlaneDomain,
  foundation: V4FoundationSnapshot,
  projects: ValidatedV4Projects,
): void {
  const syncRecords = [...domain.table('github_project_sync').entries()].map(([key, value]) => {
    const record = v4GitHubProjectSyncRecordSchema.parse(value)
    if (record.id !== key) throw new Error(`historical Saki v4 GitHub Project sync '${key}' disagrees with its table key`)
    if (record.installationId !== foundation.control.installationId) {
      throw new Error(`historical Saki v4 GitHub Project sync '${key}' belongs to another Installation`)
    }
    if (!projects.projectIds.has(record.id)) {
      throw new Error(`historical Saki v4 GitHub Project sync '${key}' has no Development Project`)
    }
    return record
  })
  const registrationIds = new Set(projects.intents.map(intent => intent.id))
  const intents = [...domain.table('github_sync_configuration_intents').entries()].map(([key, value]) => {
    const record = v4GitHubConfigurationIntentRecordSchema.parse(value)
    if (record.id !== key) {
      throw new Error(`historical Saki v4 GitHub synchronization Intent '${key}' disagrees with its table key`)
    }
    if (registrationIds.has(record.id)) {
      throw new Error(`historical Saki v4 Control Intent '${key}' is retained by multiple Intent kinds`)
    }
    if (record.payload.actor.installationId !== foundation.control.installationId) {
      throw new Error(`historical Saki v4 GitHub synchronization Intent '${key}' belongs to another Installation`)
    }
    validateRegistrationActorReference(record.payload.actor, foundation)
    if ((record.phase !== 'conflict' || record.terminalReason !== 'project-not-found')
      && !projects.projectIds.has(record.payload.intent.projectId)) {
      throw new Error(`historical Saki v4 GitHub synchronization Intent '${key}' has no Development Project`)
    }
    return record
  })
  validateV4GitHubIntentMappings(syncRecords, intents)
}

function validateV4GitHubIntentMappings(
  syncRecords: readonly V4GitHubSync[],
  intents: readonly V4GitHubIntent[],
): void {
  const syncByProject = new Map(syncRecords.map(record => [record.id, record] as const))
  const preparedProjects = new Set<V4DevelopmentProjectId>()
  for (const intent of intents) {
    if (intent.phase === 'prepared') {
      const projectId = intent.payload.intent.projectId
      if (preparedProjects.has(projectId)) {
        throw new Error(`historical Saki v4 GitHub Project sync '${projectId}' retains multiple prepared Intents`)
      }
      preparedProjects.add(projectId)
    }
    if (intent.phase !== 'saved') continue
    const sync = syncByProject.get(intent.payload.intent.projectId)
    if (sync === undefined
      || (intent.candidateRevision as number) >= sync.nextCandidateRevision
      || (intent.synchronizationRevision as number) > sync.revision) {
      throw new Error(`historical Saki v4 saved GitHub synchronization Intent '${intent.id}' has no aggregate mapping`)
    }
  }
  for (const sync of syncRecords) validateV4GitHubSyncMappings(sync, intents)
}

function validateV4GitHubSyncMappings(
  sync: V4GitHubSync,
  intents: readonly V4GitHubIntent[],
): void {
  const projectIntents = intents.filter(intent => intent.payload.intent.projectId === sync.id)
  const saved = projectIntents
    .filter(intent => intent.phase === 'saved')
    .sort((left, right) => (left.candidateRevision as number) - (right.candidateRevision as number))
  const accepted = [sync.active, sync.pending].filter(candidate => candidate !== undefined)
  if (new Set(accepted.map(candidate => candidate.acceptedIntentId)).size !== accepted.length) {
    throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
  }
  const mappedPrepared = accepted.flatMap((candidate) => {
    const intent = projectIntents.find(value => value.id === candidate.acceptedIntentId)
    return intent?.phase === 'prepared' ? [{ candidate, intent }] : []
  })
  const preparedCommit = mappedPrepared[0]
  const expectedSavedRevisions = sync.revision - (preparedCommit === undefined ? 0 : 1)
  if (saved.length !== expectedSavedRevisions
    || !saved.every((intent, index) => intent.candidateRevision === index + 1
      && intent.synchronizationRevision === index + 1
      && intent.payload.intent.expectedSynchronizationRevision === index)) {
    throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has invalid saved Intent revisions`)
  }
  if (preparedCommit !== undefined
    && (preparedCommit.candidate.revision !== sync.revision
      || preparedCommit.intent.payload.intent.expectedSynchronizationRevision !== sync.revision - 1)) {
    throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
  }

  const commits = saved.map(intent => ({
    intent,
    candidateRevision: intent.candidateRevision as number,
    synchronizationRevision: intent.synchronizationRevision as number,
  }))
  if (preparedCommit !== undefined) {
    commits.push({
      intent: preparedCommit.intent,
      candidateRevision: preparedCommit.candidate.revision,
      synchronizationRevision: sync.revision,
    })
  }
  let priorConfiguration: V4GitHubConfiguration | undefined
  for (const commit of commits) {
    const resolved = v4GitHubSynchronizationConfigurationSchema.safeParse({
      ...priorConfiguration,
      ...commit.intent.payload.intent.patch,
    })
    if (!resolved.success) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has invalid saved Intent revisions`)
    }
    const candidate = accepted.find(value => value.acceptedIntentId === commit.intent.id)
    if (candidate !== undefined
      && (candidate.receiptId !== commit.intent.receiptId
        || candidate.revision !== commit.candidateRevision
        || v4CanonicalDigest('saki/github-synchronization-configuration/v1', candidate.configuration)
          !== v4CanonicalDigest('saki/github-synchronization-configuration/v1', resolved.data))) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
    priorConfiguration = resolved.data
  }
  for (const candidate of accepted) {
    const intent = projectIntents.find(value => value.id === candidate.acceptedIntentId)
    const permittedPhase = intent?.phase === 'saved'
      || (intent?.phase === 'prepared' && preparedCommit?.intent.id === intent.id)
    if (!permittedPhase) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
  }
  if (sync.pending !== undefined) {
    const expectedChangedFields = v4ChangedFields(sync.pending.configuration, sync.active?.configuration)
    if (v4CanonicalDigest('saki/github-synchronization-changed-fields/v1', sync.pending.changedFields)
      !== v4CanonicalDigest('saki/github-synchronization-changed-fields/v1', expectedChangedFields)) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
  }
}

const V4_GITHUB_CONFIGURATION_FIELDS = Object.freeze([
  'appId',
  'githubInstallationId',
  'accountNodeId',
  'repositoryNodeId',
  'repositoryDatabaseId',
  'projectNodeId',
  'credentialRef',
  'statusFieldNodeId',
  'statusOptionNodeIds',
  'activePollIntervalMs',
  'backgroundPollIntervalMs',
  'rateLimitReserve',
] as const satisfies readonly (keyof V4GitHubConfiguration)[])

function v4ChangedFields(
  candidate: V4GitHubConfiguration,
  active: V4GitHubConfiguration | undefined,
): Array<keyof V4GitHubConfiguration> {
  return V4_GITHUB_CONFIGURATION_FIELDS.filter(field => active === undefined
    || v4CanonicalDigest('saki/github-synchronization-field/v1', candidate[field])
      !== v4CanonicalDigest('saki/github-synchronization-field/v1', active[field]))
}

function validateRegistrationActorReference(
  actor: V4RegistrationActor,
  foundation: V4FoundationSnapshot,
): void {
  const installation = requiredRecord(foundation.installations, actor.installationId, 'Installation')
  const host = requiredRecord(foundation.hosts, actor.hostId, 'Host')
  const principal = requiredRecord(foundation.principals, actor.principalId, 'Principal')
  const grant = requiredRecord(foundation.grants, actor.grantId, 'Grant')
  if (installation.id !== foundation.control.installationId
    || host.installationId !== installation.id
    || principal.kind !== 'human'
    || actor.principalRevision > principal.revision
    || grant.installationId !== installation.id
    || grant.principalId !== principal.id
    || grant.scope.installationId !== installation.id
    || actor.grantRevision > grant.revision) {
    throw new Error('Saki registration Intent actor reference is inconsistent')
  }
}

function identifiedRecords<K extends string, V extends { readonly id: string }>(
  entries: Iterable<readonly [K, V]>,
  name: string,
): ReadonlyMap<K, V> {
  const records = new Map<K, V>()
  for (const [key, record] of entries) {
    if (record.id !== key) throw new Error(`Saki ${name} record id disagrees with its table key`)
    records.set(key, record)
  }
  return records
}

function requiredRecord<K extends string, V>(records: ReadonlyMap<K, V>, id: K, name: string): V {
  const record = records.get(id)
  if (record === undefined) throw new Error(`Saki ${name} ${JSON.stringify(id)} is missing`)
  return record
}

function childId(
  accessId: V4InstallationAccessId,
  kind: 'challenge' | 'session',
  ordinal: number,
): string {
  return `${accessId}:${kind}:${String(ordinal)}`
}

function allocatedEntryId(
  accessId: V4InstallationAccessId,
  kind: 'challenge' | 'session',
  id: string,
  highWater: number,
): boolean {
  const prefix = `${accessId}:${kind}:`
  if (!id.startsWith(prefix)) return false
  const ordinal = Number(id.slice(prefix.length))
  return Number.isSafeInteger(ordinal) && ordinal < highWater
}
/* jscpd:ignore-end */
