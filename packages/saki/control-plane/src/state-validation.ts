/** Pure validation of opened current and exact B03 Saki state. @module @breakfastdapaidang/saki-control-plane/state-validation */

import type { Domain, KvTable, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import { isDeepStrictEqual } from 'node:util'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import { recoverBootstrapCompletion } from './bootstrap-completion.ts'
import { validateGitHubSynchronizationDurableState } from './github-sync.ts'
import { validateGitOperationsDurableState } from './git-operations.ts'
import {
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
} from './migration.ts'
import {
  githubSynchronizationConfigurationSchema as v4GitHubSynchronizationConfigurationSchema,
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from './migration-v4-github.ts'
import {
  recoverableRegistrationAdmissionBindingIds,
  validateDevelopmentProjectsDurableState,
} from './projects.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  sakiControlPlaneDomainSpec,
} from './spec.ts'
import type {
  ControlStateRecord,
  GrantRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  PrincipalRecord,
  RegistrationActor,
} from './spec.ts'
import {
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
} from './state-version.ts'
import type {
  SakiBrowserSessionId,
  SakiBuildId,
  SakiDevelopmentProjectId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from './types.ts'

type ControlPlaneDomain = Domain<typeof sakiControlPlaneDomainSpec>
type StorageGenerationDomain = Domain<typeof sakiStorageGenerationDomainSpec>
type V3ControlPlaneDomain = Domain<typeof sakiControlPlaneV3DomainSpec>
type V4ControlPlaneDomain = Domain<typeof sakiControlPlaneV4DomainSpec>
type V1StorageGenerationDomain = Domain<typeof sakiStorageGenerationV1DomainSpec>
type V2StorageGenerationDomain = Domain<typeof sakiStorageGenerationV2DomainSpec>
type HistoricalControlPlaneDomain = Domain<typeof sakiControlPlaneV2DomainSpec>
type HistoricalControlState = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'control_state'>
type HistoricalInstallation = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installations'>
type V4Registry = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'development_project_registry'>
type V4RegistrationIntent = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'registration_intents'>
type V4GitHubSync = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'github_project_sync'>
type V4GitHubIntent = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'github_sync_configuration_intents'>
type V4GitHubConfiguration = NonNullable<V4GitHubSync['active']>['configuration']
type AccessChallengeInvariant = Omit<InstallationAccessRecord['challenges'][number], 'storageGenerationId'>
type AccessSessionInvariant = Omit<InstallationAccessRecord['sessions'][number], 'storageGenerationId'>
type AccessAggregateInvariant<
  C extends AccessChallengeInvariant,
  S extends AccessSessionInvariant,
> = Omit<InstallationAccessRecord, 'schemaVersion' | 'challenges' | 'sessions'> & {
  readonly challenges: readonly C[]
  readonly sessions: readonly S[]
}
type BootstrapCompletionMode = 'current-summary' | 'historical-evidence'

interface FoundationSnapshot {
  readonly control: ControlStateRecord
  readonly installations: ReadonlyMap<SakiInstallationId, InstallationRecord>
  readonly hosts: ReadonlyMap<SakiHostId, HostRecord>
  readonly principals: ReadonlyMap<SakiPrincipalId, PrincipalRecord>
  readonly grants: ReadonlyMap<SakiGrantId, GrantRecord>
}

interface FoundationRecords {
  readonly controlEntries: readonly (readonly [typeof CONTROL_STATE_KEY, ControlStateRecord])[]
  readonly installations: ReadonlyMap<SakiInstallationId, InstallationRecord>
  readonly hosts: ReadonlyMap<SakiHostId, HostRecord>
  readonly principals: ReadonlyMap<SakiPrincipalId, PrincipalRecord>
  readonly grants: ReadonlyMap<SakiGrantId, GrantRecord>
  readonly access: ReadonlyMap<SakiInstallationAccessId, InstallationAccessRecord>
}

interface HistoricalFoundationSnapshot {
  readonly control: HistoricalControlState
  readonly installations: ReadonlyMap<SakiInstallationId, HistoricalInstallation>
  readonly hosts: ReadonlyMap<SakiHostId, HostRecord>
  readonly principals: ReadonlyMap<SakiPrincipalId, PrincipalRecord>
  readonly grants: ReadonlyMap<SakiGrantId, GrantRecord>
  readonly permittedGenerationIds: ReadonlySet<SakiInstallationGenerationId>
}

/**
 * Validate every product relationship in one already-opened current Saki state generation.
 * The operation performs synchronous reads only: it never writes, invokes Host or Workspace
 * capabilities, or changes the active Installation. The caller must exclusively own both
 * domains with no concurrent writers because cross-table reads are not internally serialized.
 * @param controlPlane - opened `saki_control_plane@5` candidate domain.
 * @param storageGeneration - opened `saki_storage_generation@3` candidate domain.
 * @param expectedInstallationId - Installation identity selected by maintenance metadata.
 * @param expectedStorageGenerationId - physical generation identity selected by maintenance metadata.
 * @param expectedCreatedByBuildId - generation.json provenance that the seal must repeat.
 * @returns nothing after all current product invariants pass.
 */
export function validateCurrentSakiState(
  controlPlane: ControlPlaneDomain,
  storageGeneration: StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  validateStorageGenerationSeal(storageGeneration, expectedInstallationId, expectedStorageGenerationId, expectedCreatedByBuildId)
  const foundation = validateFoundationAndAccess(foundationRecords(
    controlPlane.table('control_state'), controlPlane.table('installations'), controlPlane.table('hosts'),
    controlPlane.table('principals'), controlPlane.table('grants'), controlPlane.table('installation_access'),
  ), expectedInstallationId)
  validateProjects(controlPlane, foundation)
}

/**
 * Validate the historical relationships whose meaning would be lost by the v2-to-v3 transform.
 * Terminal B03 Access generation ids are historical attribution and may fall outside the retained
 * Foundation generations. Issued challenges, active sessions, and registration actors must belong
 * to the initial or current Installation State Generation.
 * The caller must exclusively own the opened source Domain with no concurrent writers because
 * cross-table reads are not internally serialized. The operation performs no writes or external calls.
 * @param controlPlane - opened exact `saki_control_plane@2` source domain.
 * @param expectedInstallationId - Installation identity selected or recovered by maintenance.
 * @returns nothing after the historical Foundation, Access, and Intent references pass.
 */
export function validateSakiV2SourceState(
  controlPlane: HistoricalControlPlaneDomain,
  expectedInstallationId: SakiInstallationId,
): void {
  const foundation = validateHistoricalFoundation(controlPlane, expectedInstallationId)
  validateHistoricalAccess(controlPlane, foundation)
  validateHistoricalProjects(controlPlane, foundation)
}

/**
 * Validate exact v3 product relationships and its historical storage-generation seal.
 * @param controlPlane - opened exact `saki_control_plane@3` source domain.
 * @param storageGeneration - opened exact `saki_storage_generation@1` source domain.
 * @param expectedInstallationId - Installation selected by maintenance metadata.
 * @param expectedStorageGenerationId - physical generation selected by maintenance metadata.
 * @param expectedCreatedByBuildId - generation provenance repeated by the seal.
 * @returns nothing after all retained v3 product invariants pass.
 */
export function validateSakiV3SourceState(
  controlPlane: V3ControlPlaneDomain,
  storageGeneration: V1StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  validateStorageGenerationV1Seal(storageGeneration, expectedInstallationId, expectedStorageGenerationId, expectedCreatedByBuildId)
  const foundation = validateFoundationAndAccess(foundationRecords(
    controlPlane.table('control_state'), controlPlane.table('installations'), controlPlane.table('hosts'),
    controlPlane.table('principals'), controlPlane.table('grants'), controlPlane.table('installation_access'),
  ), expectedInstallationId)
  for (const [key, value] of controlPlane.table('registration_intents').entries()) {
    if (key !== value.id) throw new Error('Saki registration Intent id disagrees with its table key')
    validateRegistrationActorReference(value.payload.actor, foundation)
  }
  validateHistoricalProjectMappings(
    [...controlPlane.table('development_project_registry').entries()].map(([, value]) => value),
    [...controlPlane.table('registration_intents').entries()].map(([, value]) => value),
  )
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
  storageGeneration: V2StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  validateStorageGenerationV2Seal(
    storageGeneration,
    expectedInstallationId,
    expectedStorageGenerationId,
    expectedCreatedByBuildId,
  )
  const foundation = validateFoundationAndAccess(foundationRecords(
    controlPlane.table('control_state'), controlPlane.table('installations'), controlPlane.table('hosts'),
    controlPlane.table('principals'), controlPlane.table('grants'), controlPlane.table('installation_access'),
  ), expectedInstallationId)
  const projects = validateV4Projects(controlPlane, foundation)
  validateV4GitHub(controlPlane, foundation, projects)
}

function validateFoundationAndAccess(
  records: FoundationRecords,
  expectedInstallationId: SakiInstallationId,
): FoundationSnapshot {
  const foundation = validateFoundationRecords(
    records.controlEntries,
    records.installations,
    records.hosts,
    records.principals,
    records.grants,
    expectedInstallationId,
  )
  validateAccessRecords(records.access, foundation)
  return foundation
}

function foundationRecords(
  controlState: KvTable<typeof CONTROL_STATE_KEY, ControlStateRecord>,
  installations: KvTable<SakiInstallationId, InstallationRecord>,
  hosts: KvTable<SakiHostId, HostRecord>,
  principals: KvTable<SakiPrincipalId, PrincipalRecord>,
  grants: KvTable<SakiGrantId, GrantRecord>,
  access: KvTable<SakiInstallationAccessId, InstallationAccessRecord>,
): FoundationRecords {
  return {
    controlEntries: [...controlState.entries()],
    installations: identifiedRecords(installations, 'Installation'),
    hosts: identifiedRecords(hosts, 'Host'),
    principals: identifiedRecords(principals, 'Principal'),
    grants: identifiedRecords(grants, 'Grant'),
    access: identifiedRecords(access, 'Installation Access'),
  }
}

function validateStorageGenerationSeal(
  domain: StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  const entries = [...domain.table('storage_generation').entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== STORAGE_GENERATION_KEY) {
    throw new Error('Saki storage generation seal is not the required singleton')
  }
  const seal = storageGenerationSealRecordSchema.parse(entries[0][1])
  if (seal.installationId !== expectedInstallationId) {
    throw new Error('Saki storage generation seal belongs to another Installation')
  }
  if (seal.storageGenerationId !== expectedStorageGenerationId) {
    throw new Error('Saki storage generation seal belongs to another physical generation')
  }
  if (seal.createdByBuildId !== expectedCreatedByBuildId) {
    throw new Error('Saki storage generation seal disagrees with generation build provenance')
  }
}

function validateStorageGenerationV1Seal(
  domain: V1StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  const entries = [...domain.table('storage_generation').entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== STORAGE_GENERATION_KEY) {
    throw new Error('historical Saki storage generation seal is not the required singleton')
  }
  const seal = storageGenerationV1SealRecordSchema.parse(entries[0][1])
  if (seal.installationId !== expectedInstallationId
    || seal.storageGenerationId !== expectedStorageGenerationId
    || seal.createdByBuildId !== expectedCreatedByBuildId) {
    throw new Error('historical Saki storage generation seal disagrees with selected generation metadata')
  }
}

function validateStorageGenerationV2Seal(
  domain: V2StorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  const entries = [...domain.table('storage_generation').entries()]
  if (entries.length !== 1 || entries[0]?.[0] !== STORAGE_GENERATION_KEY) {
    throw new Error('historical Saki v4 storage generation seal is not the required singleton')
  }
  const seal = storageGenerationV2SealRecordSchema.parse(entries[0][1])
  if (seal.installationId !== expectedInstallationId
    || seal.storageGenerationId !== expectedStorageGenerationId
    || seal.createdByBuildId !== expectedCreatedByBuildId) {
    throw new Error('historical Saki v4 storage generation seal disagrees with selected generation metadata')
  }
}

function validateHistoricalFoundation(
  domain: HistoricalControlPlaneDomain,
  expectedInstallationId: SakiInstallationId,
): HistoricalFoundationSnapshot {
  const controlEntries = [...domain.table('control_state').entries()]
  if (controlEntries.length !== 1 || controlEntries[0]?.[0] !== CONTROL_STATE_KEY) {
    throw new Error('historical Saki control state is not the required singleton')
  }
  const control = controlEntries[0][1]
  if (control.phase !== 'ready') throw new Error('historical Saki control-plane provisioning is not ready')
  if (control.installationId !== expectedInstallationId) {
    throw new Error('historical Saki control state belongs to another Installation')
  }

  const installations = new Map(domain.table('installations').entries())
  const hosts = new Map(domain.table('hosts').entries())
  const principals = new Map(domain.table('principals').entries())
  const grants = new Map(domain.table('grants').entries())

  const installation = requiredHistoricalRecord(installations, control.installationId, 'Installation')
  const initialHost = requiredHistoricalRecord(hosts, control.initialHostId, 'Host')
  const currentHost = requiredHistoricalRecord(hosts, installation.currentHostId, 'Host')
  const principal = requiredHistoricalRecord(principals, control.hostOperatorPrincipalId, 'Principal')
  const grant = requiredHistoricalRecord(grants, control.hostOperatorGrantId, 'Grant')
  if (principal.kind !== 'human') throw new Error('historical Saki Host Operator Principal must be human')
  if (initialHost.installationId !== installation.id
    || currentHost.installationId !== installation.id
    || grant.installationId !== installation.id
    || grant.principalId !== principal.id
    || grant.scope.installationId !== installation.id) {
    throw new Error('historical Saki control-plane Foundation relationships are inconsistent')
  }

  return {
    control,
    installations,
    hosts,
    principals,
    grants,
    permittedGenerationIds: new Set([
      control.initialInstallationGenerationId,
      installation.currentInstallationGenerationId,
    ]),
  }
}

function validateHistoricalAccess(
  domain: HistoricalControlPlaneDomain,
  foundation: HistoricalFoundationSnapshot,
): void {
  const record = requiredHistoricalRecord(
    new Map(domain.table('installation_access').entries()),
    foundation.control.installationAccessId,
    'Installation Access',
  )
  validateAccessAggregate(
    record,
    foundation.control.installationAccessId,
    foundation.control.installationId,
    id => requiredHistoricalRecord(foundation.installations, id, 'Installation'),
    id => requiredHistoricalRecord(foundation.hosts, id, 'Host'),
    id => requiredHistoricalRecord(foundation.principals, id, 'Principal'),
    (challenge, session) => challenge.installationGenerationId === session.installationGenerationId,
    'historical-evidence',
    'historical Saki',
  )

  for (const challenge of record.challenges) {
    if (challenge.state === 'issued') {
      validateHistoricalGeneration(
        challenge.installationGenerationId,
        foundation,
        'issued Bootstrap Challenge',
      )
    }
  }
  for (const session of record.sessions) {
    if (session.state === 'active') {
      validateHistoricalGeneration(
        session.installationGenerationId,
        foundation,
        'active Browser Session',
      )
    }
  }
}

function validateHistoricalProjects(
  domain: HistoricalControlPlaneDomain,
  foundation: HistoricalFoundationSnapshot,
): void {
  for (const [key, value] of domain.table('registration_intents').entries()) {
    if (key !== value.id) throw new Error('historical Saki registration Intent id disagrees with its table key')
    const actor = value.payload.actor
    validateHistoricalGeneration(actor.installationGenerationId, foundation, 'registration Intent actor')
    const installation = requiredHistoricalRecord(foundation.installations, actor.installationId, 'Installation')
    const host = requiredHistoricalRecord(foundation.hosts, actor.hostId, 'Host')
    const principal = requiredHistoricalRecord(foundation.principals, actor.principalId, 'Principal')
    const grant = requiredHistoricalRecord(foundation.grants, actor.grantId, 'Grant')
    assertRegistrationActorReference(
      actor,
      foundation.control.installationId,
      installation,
      host,
      principal,
      grant,
      'historical Saki',
    )
  }
  validateHistoricalProjectMappings(
    [...domain.table('development_project_registry').entries()].map(([, value]) => value),
    [...domain.table('registration_intents').entries()].map(([, value]) => value),
  )
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

function validateHistoricalProjectMappings(
  registries: readonly HistoricalProjectRegistryState[],
  intents: readonly HistoricalProjectIntentState[],
): void {
  if (registries.length !== 1) throw new Error('historical Saki Project Registry has an invalid singleton key')
  const registry = registries[0]
  if (registry === undefined) throw new Error('historical Saki Project Registry is absent')
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

interface ValidatedV4Projects {
  readonly registry: V4Registry
  readonly intents: readonly V4RegistrationIntent[]
  readonly projectIds: ReadonlySet<SakiDevelopmentProjectId>
}

function validateV4Projects(
  domain: V4ControlPlaneDomain,
  foundation: FoundationSnapshot,
): ValidatedV4Projects {
  const registryEntries = [...domain.table('development_project_registry').entries()]
  const registryEntry = registryEntries[0]
  if (registryEntries.length !== 1 || registryEntry?.[0] !== DEVELOPMENT_PROJECT_REGISTRY_KEY) {
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

function validateV4GitHub(
  domain: V4ControlPlaneDomain,
  foundation: FoundationSnapshot,
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
  const preparedProjects = new Set<SakiDevelopmentProjectId>()
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
  if (expectedSavedRevisions < 0
    || saved.length !== expectedSavedRevisions
    || sync.nextCandidateRevision - 1 !== sync.revision
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
        || canonicalDigest('saki/github-synchronization-configuration/v1', candidate.configuration)
          !== canonicalDigest('saki/github-synchronization-configuration/v1', resolved.data))) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
    priorConfiguration = resolved.data
  }
  for (const candidate of accepted) {
    const intent = projectIntents.find(value => value.id === candidate.acceptedIntentId)
    const permittedPhase = intent?.phase === 'saved'
      || (intent?.phase === 'prepared' && preparedCommit?.intent.id === intent.id)
    if (!permittedPhase || intent.receiptId !== candidate.receiptId
      || (intent.phase === 'saved'
        && (intent.candidateRevision !== candidate.revision
          || intent.synchronizationRevision !== candidate.revision))) {
      throw new Error(`historical Saki v4 GitHub Project sync '${sync.id}' has an invalid accepted Intent mapping`)
    }
  }
  if (sync.pending !== undefined) {
    const expectedChangedFields = v4ChangedFields(sync.pending.configuration, sync.active?.configuration)
    if (canonicalDigest('saki/github-synchronization-changed-fields/v1', sync.pending.changedFields)
      !== canonicalDigest('saki/github-synchronization-changed-fields/v1', expectedChangedFields)) {
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
    || canonicalDigest('saki/github-synchronization-field/v1', candidate[field])
      !== canonicalDigest('saki/github-synchronization-field/v1', active[field]))
}

function validateHistoricalGeneration(
  generationId: SakiInstallationGenerationId,
  foundation: HistoricalFoundationSnapshot,
  owner: string,
): void {
  if (!foundation.permittedGenerationIds.has(generationId)) {
    throw new Error(`historical Saki ${owner} references an unrelated Installation State Generation`)
  }
}

function requiredHistoricalRecord<K extends string, V extends { readonly id: string }>(
  records: ReadonlyMap<K, V>,
  id: K,
  name: string,
): V {
  const record = records.get(id)
  if (record === undefined) throw new Error(`historical Saki ${name} ${JSON.stringify(id)} is missing`)
  if (record.id !== id) throw new Error(`historical Saki ${name} record id disagrees with its table key`)
  return record
}

function validateFoundationRecords(
  controlEntries: readonly (readonly [typeof CONTROL_STATE_KEY, ControlStateRecord])[],
  installations: ReadonlyMap<SakiInstallationId, InstallationRecord>,
  hosts: ReadonlyMap<SakiHostId, HostRecord>,
  principals: ReadonlyMap<SakiPrincipalId, PrincipalRecord>,
  grants: ReadonlyMap<SakiGrantId, GrantRecord>,
  expectedInstallationId: SakiInstallationId,
): FoundationSnapshot {
  if (controlEntries.length !== 1 || controlEntries[0]?.[0] !== CONTROL_STATE_KEY) {
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

  return { control, installations, hosts, principals, grants }
}

function validateAccessRecords(
  accessRecords: ReadonlyMap<SakiInstallationAccessId, InstallationAccessRecord>,
  foundation: FoundationSnapshot,
): void {
  if (accessRecords.size !== 1) throw new Error('Saki Installation Access is not the required singleton')
  const record = accessRecords.get(foundation.control.installationAccessId)
  if (record === undefined) {
    throw new Error('Saki Installation Access belongs to another provisioning owner')
  }
  validateInstallationAccessRecord(
    record,
    foundation.control.installationAccessId,
    foundation.control.installationId,
    id => requiredRecord(foundation.installations, id, 'Installation'),
    id => requiredRecord(foundation.hosts, id, 'Host'),
    id => requiredRecord(foundation.principals, id, 'Principal'),
    'Saki',
  )
}

/**
 * Validate one current Installation Access aggregate and all retained Foundation references.
 * @param record - Parsed current Access aggregate.
 * @param expectedAccessId - Access identity owned by the provisioning record.
 * @param expectedInstallationId - Installation identity owned by the provisioning record.
 * @param requireInstallation - Resolve a referenced Installation or throw for absence.
 * @param requireHost - Resolve a referenced Host or throw for absence.
 * @param requirePrincipal - Resolve a referenced Principal or throw for absence.
 * @param subject - Diagnostic prefix identifying the validating Saki runtime.
 * @returns nothing after every aggregate and reference invariant passes.
 */
export function validateInstallationAccessRecord(
  record: InstallationAccessRecord,
  expectedAccessId: SakiInstallationAccessId,
  expectedInstallationId: SakiInstallationId,
  requireInstallation: (id: SakiInstallationId) => InstallationRecord,
  requireHost: (id: SakiHostId) => HostRecord,
  requirePrincipal: (id: SakiPrincipalId) => PrincipalRecord,
  subject: string,
): void {
  validateAccessAggregate(
    record,
    expectedAccessId,
    expectedInstallationId,
    requireInstallation,
    requireHost,
    requirePrincipal,
    (challenge, session) => challenge.storageGenerationId === session.storageGenerationId,
    'current-summary',
    subject,
  )
}

function validateAccessAggregate<
  C extends AccessChallengeInvariant,
  S extends AccessSessionInvariant,
>(
  record: AccessAggregateInvariant<C, S>,
  expectedAccessId: SakiInstallationAccessId,
  expectedInstallationId: SakiInstallationId,
  requireInstallation: (id: SakiInstallationId) => InstallationRecord,
  requireHost: (id: SakiHostId) => HostRecord,
  requirePrincipal: (id: SakiPrincipalId) => PrincipalRecord,
  sameGeneration: (challenge: C, session: S) => boolean,
  completionMode: BootstrapCompletionMode,
  subject: string,
): void {
  if (record.id !== expectedAccessId || record.installationId !== expectedInstallationId) {
    throw new Error(`${subject} Installation Access belongs to another provisioning owner`)
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
      throw new Error(`${subject} Installation Access contains an invalid Bootstrap Challenge`)
    }
    if (challenge.installationId !== record.installationId) {
      throw new Error(`${subject} Bootstrap Challenge belongs to another Installation`)
    }
    const installation = requireInstallation(challenge.installationId)
    const host = requireHost(challenge.hostId)
    requirePrincipal(challenge.principalId)
    if (host.installationId !== installation.id) {
      throw new Error(`${subject} Bootstrap Challenge references an unrelated Host`)
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
      throw new Error(`${subject} Installation Access contains an invalid Browser Session`)
    }
    if (session.installationId !== record.installationId) {
      throw new Error(`${subject} Browser Session belongs to another Installation`)
    }
    requireInstallation(session.installationId)
    requirePrincipal(session.principalId)
    sessionIds.add(session.id)
    sessionOrdinals.add(session.ordinal)
    sessionDigests.add(session.cookieDigest)
  }

  const consumedSessionIds = new Set<SakiBrowserSessionId>()
  for (const challenge of record.challenges) {
    if (challenge.browserSessionId === undefined) continue
    if (consumedSessionIds.has(challenge.browserSessionId)) {
      throw new Error(`${subject} multiple Bootstrap Challenges reference one Browser Session`)
    }
    const session = record.sessions.find(candidate => candidate.id === challenge.browserSessionId)
    if (session === undefined
      || session.installationId !== challenge.installationId
      || !sameGeneration(challenge, session)
      || session.principalId !== challenge.principalId
      || session.createdAt !== challenge.terminalAt) {
      throw new Error(`${subject} consumed Bootstrap Challenge references an inconsistent Browser Session`)
    }
    consumedSessionIds.add(challenge.browserSessionId)
  }

  validateBootstrapCompletion(record, requireHost, requirePrincipal, completionMode, subject)
}

function validateBootstrapCompletion<
  C extends AccessChallengeInvariant,
  S extends AccessSessionInvariant,
>(
  record: AccessAggregateInvariant<C, S>,
  requireHost: (id: SakiHostId) => HostRecord,
  requirePrincipal: (id: SakiPrincipalId) => PrincipalRecord,
  completionMode: BootstrapCompletionMode,
  subject: string,
): void {
  const completion = record.bootstrapCompletion
    ?? (completionMode === 'historical-evidence'
      ? recoverBootstrapCompletion(record, `${subject} Installation Access`)
      : undefined)
  if (completion === undefined) {
    if (record.sessions.length !== 0
      || record.challenges.some(challenge =>
        challenge.purpose !== 'initial-bootstrap' || challenge.state === 'consumed')) {
      throw new Error(`${subject} Installation Access contains reauthentication state before bootstrap completion`)
    }
    return
  }

  if (!allocatedEntryId(record.id, 'challenge', completion.challengeId, record.nextChallengeOrdinal)
    || !allocatedEntryId(record.id, 'session', completion.sessionId, record.nextSessionOrdinal)) {
    throw new Error(`${subject} bootstrap completion references an unallocated entry identity`)
  }

  const completionHost = requireHost(completion.hostId)
  requirePrincipal(completion.principalId)
  if (completionHost.installationId !== record.installationId
    || record.challenges.some(challenge =>
      challenge.purpose === 'initial-bootstrap'
      && (challenge.state === 'issued'
        || (challenge.state === 'consumed' && challenge.id !== completion.challengeId)))) {
    throw new Error(`${subject} Installation Access contains an invalid bootstrap completion`)
  }
  const completionChallenge = record.challenges.find(challenge => challenge.id === completion.challengeId)
  if (completionChallenge !== undefined
    && (completionChallenge.purpose !== 'initial-bootstrap'
      || completionChallenge.state !== 'consumed'
      || completionChallenge.browserSessionId !== completion.sessionId
      || completionChallenge.hostId !== completion.hostId
      || completionChallenge.principalId !== completion.principalId
      || completionChallenge.terminalAt !== completion.completedAt)) {
    throw new Error(`${subject} bootstrap completion disagrees with its retained challenge`)
  }
  const completionSession = record.sessions.find(session => session.id === completion.sessionId)
  if (completionSession !== undefined
    && (completionSession.principalId !== completion.principalId
      || completionSession.createdAt !== completion.completedAt)) {
    throw new Error(`${subject} bootstrap completion disagrees with its retained Browser Session`)
  }
}

function validateProjects(domain: ControlPlaneDomain, foundation: FoundationSnapshot): void {
  const state = validateDevelopmentProjectsDurableState(
    domain.table('development_project_registry'),
    domain.table('registration_intents'),
    value => value,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const github = validateGitHubSynchronizationDurableState(
    domain.table('github_project_sync'),
    domain.table('github_sync_configuration_intents'),
    foundation.control.installationId,
    projectId => state.registry?.projects.some(project => project.id === projectId) ?? false,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const otherIntentIds = new Set([
    ...state.intents.map(intent => intent.id),
    ...github.intents.map(intent => intent.id),
  ])
  const recoverableMissingBindingIds = recoverableRegistrationAdmissionBindingIds(
    state.registry,
    state.intents,
  )
  validateGitOperationsDurableState(
    domain.table('git_operation_intents'),
    domain.table('binding_write_admissions'),
    state.registry,
    otherIntentIds,
    recoverableMissingBindingIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
}

function validateRegistrationActorReference(
  actor: RegistrationActor,
  foundation: FoundationSnapshot,
): void {
  const installation = requiredRecord(foundation.installations, actor.installationId, 'Installation')
  const host = requiredRecord(foundation.hosts, actor.hostId, 'Host')
  const principal = requiredRecord(foundation.principals, actor.principalId, 'Principal')
  const grant = requiredRecord(foundation.grants, actor.grantId, 'Grant')
  assertRegistrationActorReference(
    actor,
    foundation.control.installationId,
    installation,
    host,
    principal,
    grant,
    'Saki',
  )
}

/**
 * Validate the Foundation relationships captured by one registration actor.
 * @param actor - Actor reference captured by the Intent.
 * @param expectedInstallationId - Installation selected by the provisioning owner.
 * @param installation - Referenced Installation record.
 * @param host - Referenced Host record.
 * @param principal - Referenced Principal record.
 * @param grant - Referenced Grant record.
 * @param subject - Diagnostic prefix identifying current or historical Saki state.
 * @returns nothing after every relationship and captured revision is consistent.
 */
export function assertRegistrationActorReference(
  actor: Pick<RegistrationActor,
  | 'installationId'
  | 'hostId'
  | 'principalId'
  | 'principalRevision'
  | 'grantId'
  | 'grantRevision'>,
  expectedInstallationId: SakiInstallationId,
  installation: InstallationRecord,
  host: HostRecord,
  principal: PrincipalRecord,
  grant: GrantRecord,
  subject: string,
): void {
  if (installation.id !== expectedInstallationId
    || host.installationId !== installation.id
    || principal.kind !== 'human'
    || actor.principalRevision > principal.revision
    || grant.installationId !== installation.id
    || grant.principalId !== principal.id
    || grant.scope.installationId !== installation.id
    || actor.grantRevision > grant.revision) {
    throw new Error(`${subject} registration Intent actor reference is inconsistent`)
  }
}

function identifiedRecords<K extends string, V extends { readonly id: string }>(
  table: KvTable<K, V>,
  name: string,
): ReadonlyMap<K, V> {
  const records = new Map<K, V>()
  for (const [key, record] of table.entries()) {
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
  accessId: SakiInstallationAccessId,
  kind: 'challenge' | 'session',
  ordinal: number,
): string {
  return `${accessId}:${kind}:${String(ordinal)}`
}

function allocatedEntryId(
  accessId: SakiInstallationAccessId,
  kind: 'challenge' | 'session',
  id: string,
  highWater: number,
): boolean {
  const prefix = `${accessId}:${kind}:`
  if (!id.startsWith(prefix)) return false
  const ordinal = Number(id.slice(prefix.length))
  return Number.isSafeInteger(ordinal) && ordinal < highWater
}
