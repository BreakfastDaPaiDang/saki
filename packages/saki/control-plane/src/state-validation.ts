/** Pure validation of opened current and exact B03 Saki state. @module @breakfastdapaidang/saki-control-plane/state-validation */

import type { Domain, KvTable, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import { validateAgentOperationsDurableState } from './agent-operations.ts'
import { validateBranchDeliveryOperationsDurableState } from './branch-delivery.ts'
import { recoverBootstrapCompletion } from './bootstrap-completion.ts'
import { sakiControlPlaneDomainSpec } from './domain-spec.ts'
import { validateGitHubSynchronizationDurableState } from './github-sync.ts'
import { validateGitOperationsDurableState } from './git-operations.ts'
import { validateMilestoneDeliveryOperationsDurableState } from './milestone-delivery.ts'
import {
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
} from './migration.ts'
import {
  recoverableRegistrationAdmissionBindingIds,
  validateDevelopmentProjectsDurableState,
} from './projects.ts'
import {
  CONTROL_STATE_KEY,
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
import { validateGitHubWorkItemOperationsDurableState } from './work-item-operations.ts'
import {
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationSealRecordSchema,
  storageGenerationV1SealRecordSchema,
} from './state-version.ts'
import type {
  SakiBrowserSessionId,
  SakiBuildId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from './types.ts'

export { validateSakiV4SourceState } from './migration-v4-validation.ts'

type ControlPlaneDomain = Domain<typeof sakiControlPlaneDomainSpec>
type StorageGenerationDomain = Domain<typeof sakiStorageGenerationDomainSpec>
type V3ControlPlaneDomain = Domain<typeof sakiControlPlaneV3DomainSpec>
type V1StorageGenerationDomain = Domain<typeof sakiStorageGenerationV1DomainSpec>
type HistoricalControlPlaneDomain = Domain<typeof sakiControlPlaneV2DomainSpec>
type HistoricalControlState = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'control_state'>
type HistoricalInstallation = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installations'>
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
 * Reject a Control Intent identity retained by more than one durable family.
 * @param collections - complete Intent families plus projected answer-Intent identities.
 */
export function validateDisjointControlIntentIds(
  ...collections: readonly (readonly { readonly id: SakiControlIntentId }[])[]
): void {
  const ids = new Set<SakiControlIntentId>()
  for (const collection of collections) {
    for (const intent of collection) {
      if (ids.has(intent.id)) {
        throw new Error(`Saki Control Intent '${intent.id}' is retained by multiple Intent kinds`)
      }
      ids.add(intent.id)
    }
  }
}

/**
 * Validate every product relationship in one already-opened current Saki state generation.
 * The operation performs synchronous reads only: it never writes, invokes Host or Workspace
 * capabilities, or changes the active Installation. The caller must exclusively own both
 * domains with no concurrent writers because cross-table reads are not internally serialized.
 * @param controlPlane - opened `saki_control_plane@9` candidate domain.
 * @param storageGeneration - opened `saki_storage_generation@7` candidate domain.
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
  const projects = validateDevelopmentProjectsDurableState(
    domain.table('development_project_registry'),
    domain.table('registration_intents'),
    value => value,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const projectExists = (projectId: SakiDevelopmentProjectId): boolean => (
    projects.registry?.projects.some(project => project.id === projectId) ?? false
  )
  const projectRevision = (projectId: SakiDevelopmentProjectId): number | 'not-found' => (
    projects.registry?.projects.find(project => project.id === projectId)?.revision ?? 'not-found'
  )
  const github = validateGitHubSynchronizationDurableState(
    domain.table('github_project_sync'),
    domain.table('github_sync_configuration_intents'),
    foundation.control.installationId,
    projectExists,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const workItemOtherIntentIds = new Set([
    ...projects.intents.map(intent => intent.id),
    ...github.intents.map(intent => intent.id),
  ])
  const workItems = validateGitHubWorkItemOperationsDurableState(
    domain.table('github_work_item_intents'),
    domain.table('github_work_item_recovery'),
    projectRevision,
    workItemOtherIntentIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const gitOtherIntentIds = new Set([
    ...workItemOtherIntentIds,
    ...workItems.intents.map(intent => intent.id),
  ])
  const recoverableMissingBindingIds = recoverableRegistrationAdmissionBindingIds(
    projects.registry,
    projects.intents,
  )
  const git = validateGitOperationsDurableState(
    domain.table('git_operation_intents'),
    domain.table('binding_write_admissions'),
    projects.registry,
    gitOtherIntentIds,
    recoverableMissingBindingIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const branchOtherIntentIds = new Set([
    ...gitOtherIntentIds,
    ...git.intents.map(intent => intent.id),
  ])
  const branch = validateBranchDeliveryOperationsDurableState(
    domain.table('branch_deliveries'),
    domain.table('branch_delivery_intents'),
    domain.table('binding_write_admissions'),
    projectExists,
    branchOtherIntentIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const milestoneOtherIntentIds = new Set([
    ...branchOtherIntentIds,
    ...branch.intents.map(intent => intent.id),
  ])
  const milestone = validateMilestoneDeliveryOperationsDurableState(
    domain.table('milestone_deliveries'),
    domain.table('milestone_delivery_intents'),
    projectExists,
    milestoneOtherIntentIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  const agentOtherIntentIds = new Set([
    ...milestoneOtherIntentIds,
    ...milestone.intents.map(intent => intent.id),
  ])
  const agent = validateAgentOperationsDurableState(
    domain.table('agent_operation_intents'),
    domain.table('work_assignments'),
    domain.table('work_sessions'),
    domain.table('agent_runs'),
    domain.table('execution_dispatches'),
    domain.table('intervention_requests'),
    domain.table('binding_write_admissions'),
    projects.registry,
    agentOtherIntentIds,
    (actor) => { validateRegistrationActorReference(actor, foundation) },
  )
  validateDisjointControlIntentIds(
    projects.intents,
    github.intents,
    workItems.intents,
    git.intents,
    branch.intents,
    milestone.intents,
    agent.intents,
    agent.interventions.flatMap(intervention => (
      'answer' in intervention && intervention.answer !== undefined
        ? [{ id: intervention.answer.payload.intent.intentId }]
        : []
    )),
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
