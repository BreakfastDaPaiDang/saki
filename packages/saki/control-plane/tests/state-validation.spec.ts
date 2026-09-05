import { describe, expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { Domain, KvTable, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import { branchDeliveryIntentRecordSchema } from '../src/branch-delivery.ts'
import { boardWorkItemId, unjoinedBoardRemoteFingerprint } from '../src/work-item-mapping.ts'
import {
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
} from '../src/fixtures.ts'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
} from '../src/migration.ts'
import {
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from '../src/migration-v4-github.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  controlStateRecordSchema,
  developmentProjectRegistryRecordSchema,
  grantRecordSchema,
  githubProjectSyncRecordSchema,
  githubWorkItemRecoveryId,
  githubWorkItemRecoveryRecordSchema,
  historicalControlStateRecordSchema,
  historicalInstallationAccessRecordSchema,
  historicalInstallationRecordSchema,
  historicalRegistrationIntentRecordSchema,
  hostRecordSchema,
  installationAccessRecordSchema,
  installationRecordSchema,
  principalRecordSchema,
  registrationIntentRecordSchema,
} from '../src/spec.ts'
import { sakiControlPlaneDomainSpec } from '../src/domain-spec.ts'
import type {
  ControlStateRecord,
  DevelopmentProjectRegistryRecord,
  GrantRecord,
  GitHubProjectSyncRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  PrincipalRecord,
  RegistrationIntentRecord,
} from '../src/spec.ts'
import {
  validateCurrentSakiState,
  validateDisjointControlIntentIds,
  validateSakiV2SourceState,
  validateSakiV3SourceState,
  validateSakiV4SourceState,
} from '../src/state-validation.ts'
import {
  createStorageGenerationSeal,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
} from '../src/state-version.ts'
import type { StorageGenerationSealRecord, StorageGenerationV1SealRecord } from '../src/state-version.ts'
import type {
  SakiBuildId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from '../src/types.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OTHER_INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000101' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const OTHER_STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000102' as SakiStorageGenerationId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002' as SakiHostId
const OTHER_HOST_ID = 'host-00000000-0000-4000-8000-000000000102' as SakiHostId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000003' as SakiPrincipalId
const OTHER_PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000103' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000004' as SakiGrantId
const OTHER_GRANT_ID = 'grant-00000000-0000-4000-8000-000000000104' as SakiGrantId
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000005' as SakiInstallationAccessId
const OTHER_ACCESS_ID = 'access-00000000-0000-4000-8000-000000000105' as SakiInstallationAccessId
const BUILD_ID = 'saki-build-state-validation-test' as SakiBuildId
const INITIAL_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000002'
const CURRENT_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000003'
const OTHER_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000104'
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000006' as SakiDevelopmentProjectId
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000007' as
  DevelopmentProjectRegistryRecord['resourceBindings'][number]['id']
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000008' as
  DevelopmentProjectRegistryRecord['resourceBindings'][number]['workspaceId']
const GITHUB_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000109' as SakiControlIntentId
const ROTATED_GITHUB_CREDENTIAL_REF = credentialRef('ROTATED_GITHUB_APP_PRIVATE_KEY')

interface CurrentFixture {
  readonly controlState: Map<typeof CONTROL_STATE_KEY, ControlStateRecord>
  readonly installations: Map<SakiInstallationId, InstallationRecord>
  readonly hosts: Map<SakiHostId, HostRecord>
  readonly principals: Map<SakiPrincipalId, PrincipalRecord>
  readonly grants: Map<SakiGrantId, GrantRecord>
  readonly access: Map<SakiInstallationAccessId, InstallationAccessRecord>
  readonly registries: Map<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
  readonly intents: Map<SakiControlIntentId, RegistrationIntentRecord>
  readonly seals: Map<string, StorageGenerationSealRecord>
}

type HistoricalControl = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'control_state'>
type HistoricalInstallation = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installations'>
type HistoricalAccess = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installation_access'>
type HistoricalIntent = ReturnType<typeof historicalRegistrationIntentRecordSchema.parse>
type V4Registry = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'development_project_registry'>
type V4RegistrationIntent = TableValueOf<typeof sakiControlPlaneV4DomainSpec, 'registration_intents'>
type V4GitHubSync = ReturnType<typeof v4GitHubProjectSyncRecordSchema.parse>
type V4GitHubIntent = ReturnType<typeof v4GitHubConfigurationIntentRecordSchema.parse>

interface HistoricalFixture {
  readonly controlState: Map<typeof CONTROL_STATE_KEY, HistoricalControl>
  readonly installations: Map<SakiInstallationId, HistoricalInstallation>
  readonly hosts: Map<SakiHostId, HostRecord>
  readonly principals: Map<SakiPrincipalId, PrincipalRecord>
  readonly grants: Map<SakiGrantId, GrantRecord>
  readonly access: Map<SakiInstallationAccessId, HistoricalAccess>
  readonly registries: Map<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
  readonly intents: Map<SakiControlIntentId, HistoricalIntent>
}

function currentFixture(): CurrentFixture {
  const control = controlStateRecordSchema.parse({
    schemaVersion: 2,
    revision: 1,
    phase: 'ready',
    installationId: INSTALLATION_ID,
    initialHostId: HOST_ID,
    hostOperatorPrincipalId: PRINCIPAL_ID,
    hostOperatorGrantId: GRANT_ID,
    installationAccessId: ACCESS_ID,
  })
  const installation = installationRecordSchema.parse({
    id: INSTALLATION_ID,
    revision: 1,
    state: 'active',
    currentHostId: HOST_ID,
  })
  const host = hostRecordSchema.parse({
    id: HOST_ID,
    revision: 1,
    installationId: INSTALLATION_ID,
    state: 'enrolled',
  })
  const principal = principalRecordSchema.parse({
    id: PRINCIPAL_ID,
    revision: 4,
    kind: 'human',
    displayName: 'Host Operator',
    state: 'active',
  })
  const grant = grantRecordSchema.parse({
    id: GRANT_ID,
    revision: 5,
    installationId: INSTALLATION_ID,
    principalId: PRINCIPAL_ID,
    state: 'active',
    actions: ['development-project:register'],
    scope: { kind: 'installation', installationId: INSTALLATION_ID },
  })
  const access = installationAccessRecordSchema.parse({
    id: ACCESS_ID,
    schemaVersion: 2,
    revision: 0,
    installationId: INSTALLATION_ID,
    nextChallengeOrdinal: 0,
    nextSessionOrdinal: 0,
    requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
    challenges: [],
    sessions: [],
  })
  const registry = developmentProjectRegistryRecordSchema.parse({
    id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 2,
    revision: 0,
    projects: [],
    agentProfiles: [],
    resourceBindings: [],
    canonicalWorktreeIndex: [],
    gitDirectoryIndex: [],
    intentMappings: [],
  })
  return {
    controlState: new Map([[CONTROL_STATE_KEY, control]]),
    installations: new Map([[INSTALLATION_ID, installation]]),
    hosts: new Map([[HOST_ID, host]]),
    principals: new Map([[PRINCIPAL_ID, principal]]),
    grants: new Map([[GRANT_ID, grant]]),
    access: new Map([[ACCESS_ID, access]]),
    registries: new Map([[DEVELOPMENT_PROJECT_REGISTRY_KEY, registry]]),
    intents: new Map(),
    seals: new Map([[
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID),
    ]]),
  }
}

function historicalFixture(): HistoricalFixture {
  const current = currentFixture()
  const control = historicalControlStateRecordSchema.parse({
    ...current.controlState.get(CONTROL_STATE_KEY),
    schemaVersion: 1,
    initialInstallationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
  })
  const installation = historicalInstallationRecordSchema.parse({
    ...current.installations.get(INSTALLATION_ID),
    currentInstallationGenerationId: CURRENT_INSTALLATION_GENERATION_ID,
  })
  const challengeId = `${ACCESS_ID}:challenge:0`
  const sessionId = `${ACCESS_ID}:session:0`
  const access = historicalInstallationAccessRecordSchema.parse({
    id: ACCESS_ID,
    schemaVersion: 1,
    revision: 2,
    installationId: INSTALLATION_ID,
    nextChallengeOrdinal: 1,
    nextSessionOrdinal: 1,
    bootstrapCompletion: {
      challengeId,
      sessionId,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      completedAt: 11,
    },
    requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
    challenges: [{
      id: challengeId,
      ordinal: 0,
      revision: 1,
      purpose: 'initial-bootstrap',
      installationId: INSTALLATION_ID,
      installationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      verifierDigest: 'a'.repeat(64),
      issuedAt: 10,
      expiresAt: 20,
      state: 'consumed',
      terminalAt: 11,
      browserSessionId: sessionId,
    }],
    sessions: [{
      id: sessionId,
      ordinal: 0,
      revision: 0,
      installationId: INSTALLATION_ID,
      installationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
      principalId: PRINCIPAL_ID,
      cookieDigest: 'b'.repeat(64),
      createdAt: 11,
      expiresAt: 21,
      state: 'active',
    }],
  })
  const intent = historicalIntent(CURRENT_INSTALLATION_GENERATION_ID, GRANT_ID)
  return {
    controlState: new Map([[CONTROL_STATE_KEY, control]]),
    installations: new Map([[INSTALLATION_ID, installation]]),
    hosts: current.hosts,
    principals: current.principals,
    grants: current.grants,
    access: new Map([[ACCESS_ID, access]]),
    registries: current.registries,
    intents: new Map([[intent.id, intent]]),
  }
}

function historicalIntent(installationGenerationId: string, grantId: SakiGrantId): HistoricalIntent {
  const actor = {
    installationId: INSTALLATION_ID,
    installationGenerationId,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId,
    grantRevision: 5,
  }
  const payload = { intent: SAKI_PROJECT_REQUEST_FIXTURES.registration, actor }
  const id = SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId
  return historicalRegistrationIntentRecordSchema.parse({
    id,
    schemaVersion: 1,
    revision: 0,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    payload,
    inspection: fixtureInspection(),
    phase: 'prepared',
    createdAt: 12,
    updatedAt: 12,
  })
}

function currentIntent(): RegistrationIntentRecord {
  const actor = {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
  }
  const payload = { intent: SAKI_PROJECT_REQUEST_FIXTURES.registration, actor }
  const id = SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId
  return registrationIntentRecordSchema.parse({
    id,
    schemaVersion: 2,
    revision: 0,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    payload,
    inspection: fixtureInspection(),
    phase: 'prepared',
    createdAt: 12,
    updatedAt: 12,
  })
}

function fixtureInspection() {
  return {
    projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
    trusted: {
      canonicalWorktreePath: '/fixture/repository',
      canonicalGitDirectory: '/fixture/repository/.git',
      canonicalCommonGitDirectory: '/fixture/repository/.git',
      gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      comparison: { fileMode: true, symlinks: true, autocrlf: false },
    },
  }
}

function currentDomains(
  fixture: CurrentFixture,
  githubProjectSync: ReadonlyMap<SakiDevelopmentProjectId, GitHubProjectSyncRecord> = new Map(),
  deliveryIntents: ReadonlyMap<SakiControlIntentId, unknown> = new Map(),
  workItemRecoveries: ReadonlyMap<string, unknown> = new Map(),
) {
  const tables = {
    control_state: readonlyTable(fixture.controlState),
    installations: readonlyTable(fixture.installations),
    hosts: readonlyTable(fixture.hosts),
    principals: readonlyTable(fixture.principals),
    grants: readonlyTable(fixture.grants),
    installation_access: readonlyTable(fixture.access),
    development_project_registry: readonlyTable(fixture.registries),
    registration_intents: readonlyTable(fixture.intents),
    github_project_sync: readonlyTable(githubProjectSync),
    github_sync_configuration_intents: readonlyTable(new Map()),
    github_work_item_intents: readonlyTable(new Map()),
    github_work_item_recovery: readonlyTable(workItemRecoveries),
    git_operation_intents: readonlyTable(new Map()),
    binding_write_admissions: readonlyTable(new Map()),
    branch_deliveries: readonlyTable(new Map()),
    branch_delivery_intents: readonlyTable(deliveryIntents),
    milestone_deliveries: readonlyTable(new Map()),
    milestone_delivery_intents: readonlyTable(new Map()),
    agent_operation_intents: readonlyTable(new Map()),
    work_assignments: readonlyTable(new Map()),
    work_sessions: readonlyTable(new Map()),
    agent_runs: readonlyTable(new Map()),
    execution_dispatches: readonlyTable(new Map()),
    intervention_requests: readonlyTable(new Map()),
  }
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const storageTables = { storage_generation: readonlyTable(fixture.seals) }
  const storageGeneration = {
    name: sakiStorageGenerationDomainSpec.name,
    table: (name: keyof typeof storageTables) => storageTables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiStorageGenerationDomainSpec>
  return { controlPlane, storageGeneration }
}

function v1Seal(
  overrides: Partial<StorageGenerationV1SealRecord> = {},
): StorageGenerationV1SealRecord {
  return storageGenerationV1SealRecordSchema.parse({
    schemaVersion: 1,
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    stateVersion: 3,
    createdByBuildId: BUILD_ID,
    ...overrides,
  })
}

function v3Domains(
  fixture: CurrentFixture,
  seals: ReadonlyMap<string, StorageGenerationV1SealRecord> = new Map([[
    STORAGE_GENERATION_KEY,
    v1Seal(),
  ]]),
) {
  const tables = {
    control_state: readonlyTable(fixture.controlState),
    installations: readonlyTable(fixture.installations),
    hosts: readonlyTable(fixture.hosts),
    principals: readonlyTable(fixture.principals),
    grants: readonlyTable(fixture.grants),
    installation_access: readonlyTable(fixture.access),
    development_project_registry: readonlyTable(fixture.registries),
    registration_intents: readonlyTable(fixture.intents),
  }
  const controlPlane = {
    name: sakiControlPlaneV3DomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneV3DomainSpec>
  const storageTables = { storage_generation: readonlyTable(seals) }
  const storageGeneration = {
    name: sakiStorageGenerationV1DomainSpec.name,
    table: (name: keyof typeof storageTables) => storageTables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiStorageGenerationV1DomainSpec>
  return { controlPlane, storageGeneration }
}

function historicalDomain(fixture: HistoricalFixture): Domain<typeof sakiControlPlaneV2DomainSpec> {
  const tables = {
    control_state: readonlyTable(fixture.controlState),
    installations: readonlyTable(fixture.installations),
    hosts: readonlyTable(fixture.hosts),
    principals: readonlyTable(fixture.principals),
    grants: readonlyTable(fixture.grants),
    installation_access: readonlyTable(fixture.access),
    development_project_registry: readonlyTable(fixture.registries),
    registration_intents: readonlyTable(fixture.intents),
  }
  return {
    name: sakiControlPlaneV2DomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneV2DomainSpec>
}

type MutableV4Tables = Record<string, Record<string, unknown>>
type V4Seal = ReturnType<typeof storageGenerationV2SealRecordSchema.parse>

function v4Domains(
  fixture: HistoricalFixture,
  mutate?: (tables: MutableV4Tables) => void,
  seals?: ReadonlyMap<string, V4Seal>,
) {
  const v2 = {
    global: null,
    tables: {
      control_state: Object.fromEntries(fixture.controlState),
      installations: Object.fromEntries(fixture.installations),
      hosts: Object.fromEntries(fixture.hosts),
      principals: Object.fromEntries(fixture.principals),
      grants: Object.fromEntries(fixture.grants),
      installation_access: Object.fromEntries(fixture.access),
      development_project_registry: Object.fromEntries(fixture.registries),
      registration_intents: Object.fromEntries(fixture.intents),
    },
  }
  const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate(v2)
  const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
  const mutableTables = v4.tables as MutableV4Tables
  mutate?.(mutableTables)
  const tables = Object.fromEntries(Object.entries(v4.tables).map(([name, records]) => [
    name,
    readonlyTable(new Map(Object.entries(records ?? {}))),
  ]))
  const controlPlane = {
    name: sakiControlPlaneV4DomainSpec.name,
    table: (name: string) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneV4DomainSpec>
  const seal = storageGenerationV2SealRecordSchema.parse({
    schemaVersion: 2,
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    stateVersion: 4,
    createdByBuildId: BUILD_ID,
  })
  const storageTables = {
    storage_generation: readonlyTable(seals ?? new Map([[STORAGE_GENERATION_KEY, seal]])),
  }
  const storageGeneration = {
    name: sakiStorageGenerationV2DomainSpec.name,
    table: (name: keyof typeof storageTables) => storageTables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiStorageGenerationV2DomainSpec>
  return { controlPlane, storageGeneration }
}

function requiredV4Record(
  tables: MutableV4Tables,
  table: string,
  key: string,
): unknown {
  const value = tables[table]?.[key]
  if (value === undefined) throw new Error(`v4 test fixture is missing ${table}/${key}`)
  return value
}

function installV4Project(tables: MutableV4Tables): {
  readonly intent: V4RegistrationIntent
  readonly registry: V4Registry
} {
  const prepared = requiredV4Record(
    tables,
    'registration_intents',
    SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
  ) as V4RegistrationIntent
  const intent: V4RegistrationIntent = {
    ...prepared,
    phase: 'confirmed',
    workspaceId: WORKSPACE_ID,
    workspaceInspection: prepared.inspection,
    projectId: PROJECT_ID,
    resourceBindingId: BINDING_ID,
    registryRevision: prepared.payload.intent.expectedRegistryRevision + 1,
  }
  const registry: V4Registry = {
    id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 1,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      revision: 0,
      projectTitle: prepared.payload.intent.projectTitle,
      resourceBindingId: BINDING_ID,
      state: 'active',
      createdAt: prepared.createdAt,
    }],
    resourceBindings: [{
      id: BINDING_ID,
      revision: 0,
      projectId: PROJECT_ID,
      hostId: prepared.payload.intent.hostId,
      workspaceId: WORKSPACE_ID,
      health: 'active',
      registrationInspection: prepared.inspection,
      currentInspection: prepared.inspection,
      inheritedChangeBaseline: prepared.payload.intent.confirmedBaseline,
      createdAt: prepared.createdAt,
      observedAt: prepared.updatedAt,
    }],
    canonicalWorktreeIndex: [{
      hostId: prepared.payload.intent.hostId,
      path: prepared.inspection.trusted.canonicalWorktreePath,
      resourceBindingId: BINDING_ID,
    }],
    gitDirectoryIndex: [{
      hostId: prepared.payload.intent.hostId,
      path: prepared.inspection.trusted.canonicalGitDirectory,
      resourceBindingId: BINDING_ID,
    }],
    intentMappings: [{
      intentId: prepared.id,
      projectId: PROJECT_ID,
      resourceBindingId: BINDING_ID,
      registryRevision: 1,
    }],
  }
  tables['development_project_registry'] = { [DEVELOPMENT_PROJECT_REGISTRY_KEY]: registry }
  tables['registration_intents'] = { [intent.id]: intent }
  return { intent, registry }
}

function installHistoricalProject(fixture: HistoricalFixture): {
  readonly intent: HistoricalIntent
  readonly registry: DevelopmentProjectRegistryRecord
} {
  const prepared = requiredMapRecord(
    fixture.intents,
    SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
  )
  const workspaceInspection = {
    ...prepared.inspection,
    projection: { ...prepared.inspection.projection, workspaceId: WORKSPACE_ID },
  }
  const intent = {
    ...prepared,
    phase: 'confirmed' as const,
    workspaceId: WORKSPACE_ID,
    workspaceInspection,
    projectId: PROJECT_ID,
    resourceBindingId: BINDING_ID,
    registryRevision: 1,
  } as HistoricalIntent
  const registry = {
    id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 1 as const,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      revision: 0,
      projectTitle: prepared.payload.intent.projectTitle,
      resourceBindingId: BINDING_ID,
      state: 'active' as const,
      createdAt: prepared.createdAt,
    }],
    resourceBindings: [{
      id: BINDING_ID,
      revision: 0,
      projectId: PROJECT_ID,
      hostId: prepared.payload.intent.hostId,
      workspaceId: WORKSPACE_ID,
      health: 'active' as const,
      registrationInspection: prepared.inspection,
      currentInspection: workspaceInspection,
      inheritedChangeBaseline: prepared.payload.intent.confirmedBaseline,
      createdAt: prepared.createdAt,
      observedAt: prepared.updatedAt,
    }],
    canonicalWorktreeIndex: [{
      hostId: prepared.payload.intent.hostId,
      path: prepared.inspection.trusted.canonicalWorktreePath,
      resourceBindingId: BINDING_ID,
    }],
    gitDirectoryIndex: [{
      hostId: prepared.payload.intent.hostId,
      path: prepared.inspection.trusted.canonicalGitDirectory,
      resourceBindingId: BINDING_ID,
    }],
    intentMappings: [{
      intentId: prepared.id,
      projectId: PROJECT_ID,
      resourceBindingId: BINDING_ID,
      registryRevision: 1,
    }],
  } as unknown as DevelopmentProjectRegistryRecord
  fixture.intents.set(intent.id, intent)
  fixture.registries.set(DEVELOPMENT_PROJECT_REGISTRY_KEY, registry)
  return { intent, registry }
}

const GITHUB_CONFIGURATION = Object.freeze({
  appId: '12345',
  githubInstallationId: '12345678',
  accountNodeId: 'O_saki_test_account',
  repositoryNodeId: 'R_saki_test_repository',
  repositoryDatabaseId: '87654321',
  projectNodeId: 'PVT_saki_test_project',
  credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
  statusFieldNodeId: 'PVTSSF_saki_test_status',
  statusOptionNodeIds: {
    inbox: 'option-inbox',
    backlog: 'option-backlog',
    ready: 'option-ready',
    inProgress: 'option-in-progress',
    inReview: 'option-in-review',
    done: 'option-done',
    canceled: 'option-canceled',
  },
  activePollIntervalMs: 30_000,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
})

const GITHUB_CONFIGURATION_FIELDS = Object.freeze([
  'appId', 'githubInstallationId', 'accountNodeId', 'repositoryNodeId', 'repositoryDatabaseId',
  'projectNodeId', 'credentialRef', 'statusFieldNodeId', 'statusOptionNodeIds',
  'activePollIntervalMs', 'backgroundPollIntervalMs', 'rateLimitReserve',
] as const)

function v4GitHubIntent(
  actor: V4RegistrationIntent['payload']['actor'],
  options: {
    readonly id?: SakiControlIntentId
    readonly projectId?: SakiDevelopmentProjectId
    readonly expectedRevision?: number
    readonly patch?: V4GitHubIntent['payload']['intent']['patch']
    readonly phase?: V4GitHubIntent['phase']
    readonly candidateRevision?: number
    readonly synchronizationRevision?: number
    readonly terminalReason?: V4GitHubIntent['terminalReason']
  } = {},
): V4GitHubIntent {
  const id = options.id ?? GITHUB_INTENT_ID
  const payload = {
    intent: {
      type: 'configure-github-synchronization' as const,
      intentId: id,
      projectId: options.projectId ?? PROJECT_ID,
      expectedSynchronizationRevision: options.expectedRevision ?? 0,
      patch: options.patch ?? GITHUB_CONFIGURATION,
    },
    actor,
  }
  return v4GitHubConfigurationIntentRecordSchema.parse({
    id,
    schemaVersion: 1,
    revision: 0,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', payload),
    payload,
    phase: options.phase ?? 'prepared',
    ...(options.candidateRevision === undefined ? {} : { candidateRevision: options.candidateRevision }),
    ...(options.synchronizationRevision === undefined
      ? {} : { synchronizationRevision: options.synchronizationRevision }),
    ...(options.terminalReason === undefined ? {} : { terminalReason: options.terminalReason }),
    createdAt: 20,
    updatedAt: 20,
  })
}

function pendingV4GitHubSync(
  intent: V4GitHubIntent,
  configuration = GITHUB_CONFIGURATION,
): V4GitHubSync {
  return v4GitHubProjectSyncRecordSchema.parse({
    id: PROJECT_ID,
    schemaVersion: 1,
    revision: 1,
    installationId: INSTALLATION_ID,
    nextCandidateRevision: 2,
    nextBoardGeneration: 1,
    pending: {
      revision: 1,
      state: 'saved',
      configuration,
      changedFields: GITHUB_CONFIGURATION_FIELDS,
      acceptedIntentId: intent.id,
      receiptId: intent.receiptId,
      savedAt: 20,
    },
  })
}

function activeAndPendingV4GitHub(
  actor: V4RegistrationIntent['payload']['actor'],
): { readonly sync: V4GitHubSync; readonly saved: V4GitHubIntent; readonly prepared: V4GitHubIntent } {
  const saved = v4GitHubIntent(actor, {
    id: 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId,
    phase: 'saved',
    candidateRevision: 1,
    synchronizationRevision: 1,
  })
  const prepared = v4GitHubIntent(actor, {
    id: 'intent-00000000-0000-4000-8000-000000000111' as SakiControlIntentId,
    expectedRevision: 1,
    patch: { credentialRef: ROTATED_GITHUB_CREDENTIAL_REF },
  })
  const pendingConfiguration = {
    ...GITHUB_CONFIGURATION,
    credentialRef: ROTATED_GITHUB_CREDENTIAL_REF,
  }
  const sync = v4GitHubProjectSyncRecordSchema.parse({
    id: PROJECT_ID,
    schemaVersion: 1,
    revision: 2,
    installationId: INSTALLATION_ID,
    nextCandidateRevision: 3,
    nextBoardGeneration: 2,
    active: {
      revision: 1,
      configuration: GITHUB_CONFIGURATION,
      acceptedIntentId: saved.id,
      receiptId: saved.receiptId,
      activatedAt: 20,
    },
    pending: {
      revision: 2,
      state: 'saved',
      configuration: pendingConfiguration,
      changedFields: ['credentialRef'],
      acceptedIntentId: prepared.id,
      receiptId: prepared.receiptId,
      savedAt: 21,
    },
    confirmedBoard: {
      generation: 1,
      configurationRevision: 1,
      repository: {
        id: GITHUB_CONFIGURATION.repositoryNodeId,
        nameWithOwner: 'BreakfastDaPaiDang/saki',
        url: 'https://github.example.invalid/BreakfastDaPaiDang/saki',
      },
      project: {
        id: GITHUB_CONFIGURATION.projectNodeId,
        title: 'Saki',
        url: 'https://github.example.invalid/orgs/BreakfastDaPaiDang/projects/1',
      },
      items: [],
    },
    checkpoint: {
      generation: 1,
      configurationRevision: 1,
      attemptId: 'scan-attempt-00000000-0000-4000-8000-000000000112',
      installationId: GITHUB_CONFIGURATION.githubInstallationId,
      repositoryId: GITHUB_CONFIGURATION.repositoryNodeId,
      projectId: GITHUB_CONFIGURATION.projectNodeId,
      statusFieldId: GITHUB_CONFIGURATION.statusFieldNodeId,
      sourceFingerprint: { version: 1, digest: 'f'.repeat(64) },
      observedAt: 20,
      confirmedAt: 20,
      rateLimit: { state: 'unobserved' },
    },
  })
  return { sync, saved, prepared }
}

function activeV4GitHubHistory(
  actor: V4RegistrationIntent['payload']['actor'],
): { readonly sync: V4GitHubSync; readonly intents: readonly [V4GitHubIntent, V4GitHubIntent] } {
  const state = activeAndPendingV4GitHub(actor)
  const secondSaved = v4GitHubIntent(actor, {
    id: state.prepared.id,
    expectedRevision: 1,
    patch: { credentialRef: ROTATED_GITHUB_CREDENTIAL_REF },
    phase: 'saved',
    candidateRevision: 2,
    synchronizationRevision: 2,
  })
  const pending = state.sync.pending
  const board = state.sync.confirmedBoard
  const checkpoint = state.sync.checkpoint
  if (pending === undefined || board === undefined || checkpoint === undefined) {
    throw new Error('v4 GitHub fixture requires active and pending evidence')
  }
  const sync = v4GitHubProjectSyncRecordSchema.parse({
    ...state.sync,
    active: {
      revision: 2,
      configuration: pending.configuration,
      acceptedIntentId: secondSaved.id,
      receiptId: secondSaved.receiptId,
      activatedAt: 21,
    },
    pending: undefined,
    confirmedBoard: { ...board, configurationRevision: 2 },
    checkpoint: { ...checkpoint, configurationRevision: 2 },
  })
  return { sync, intents: [state.saved, secondSaved] }
}

function readonlyTable<K extends string, V>(records: ReadonlyMap<K, V>): KvTable<K, V> {
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: rejectUnexpectedMutation,
    delete: rejectUnexpectedMutation,
    update: rejectUnexpectedMutation,
  }
}

function rejectUnexpectedMutation<T>(): Promise<T> {
  return Promise.reject(new Error('pure validation attempted a mutation'))
}

function requiredMapRecord<K, V>(records: ReadonlyMap<K, V>, key: K): V {
  const record = records.get(key)
  if (record === undefined) throw new Error('test fixture record is missing')
  return record
}

describe('current Saki state validation', () => {
  it('rejects one identity retained by separate Control Intent families', () => {
    const id = 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId

    expect(() => { validateDisjointControlIntentIds([{ id }], [{ id }]) }).toThrow(
      `Saki Control Intent '${id}' is retained by multiple Intent kinds`,
    )
  })

  it('accepts a complete ready generation without writes or external calls', () => {
    const fixture = currentFixture()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })

  it.each([false, true])('validates retained denied Delivery actor attribution (invalid revision: %s)', (invalid) => {
    const fixture = currentFixture()
    const payload = {
      actor: {
        installationId: INSTALLATION_ID, storageGenerationId: STORAGE_GENERATION_ID, hostId: HOST_ID,
        principalId: PRINCIPAL_ID, principalRevision: 4, grantId: GRANT_ID, grantRevision: invalid ? 6 : 5,
      },
      intent: {
        type: 'mark-branch-delivery-in-review', intentId: GITHUB_INTENT_ID,
        deliveryId: `branch-delivery-${'a'.repeat(64)}`, expectedDeliveryRevision: 0,
        expectedWorkItemRemoteFingerprint: `remote-fingerprint-${'b'.repeat(64)}`,
      },
    }
    const record = branchDeliveryIntentRecordSchema.parse({
      id: GITHUB_INTENT_ID, schemaVersion: 1, revision: 1, payload,
      payloadDigest: canonicalDigest('saki/branch-delivery-intent/v1', payload),
      deliveryId: payload.intent.deliveryId, operation: { kind: 'in-review' },
      checkpoint: { state: 'terminal', outcome: 'denied', reason: 'authority' }, createdAt: 1, updatedAt: 2,
    })
    const domains = currentDomains(fixture, new Map(), new Map([[GITHUB_INTENT_ID, record]]))
    const validate = () => {
      validateCurrentSakiState(domains.controlPlane, domains.storageGeneration,
        INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID)
    }
    if (invalid) expect(validate).toThrow('Saki registration Intent actor reference is inconsistent')
    else expect(validate).not.toThrow()
  })

  it('rejects targeted Work Item recovery when its Project no longer exists', () => {
    const fixture = currentFixture()
    const workItemId = boardWorkItemId('R_repo', 'I_issue')
    const recovery = githubWorkItemRecoveryRecordSchema.parse({
      id: githubWorkItemRecoveryId(PROJECT_ID, workItemId), workItemId,
      schemaVersion: 1, revision: 0, projectId: PROJECT_ID, latestNonTerminalStatus: null, updatedAt: 2,
      confirmed: {
        sourceIntentId: GITHUB_INTENT_ID, confirmedAt: 2,
        observation: {
          stageMutationId: 'work-item:missing-project:status', stageKind: 'project-item-status-set', workItemId,
          remoteFingerprint: unjoinedBoardRemoteFingerprint('R_repo', 'I_issue', 'open'), observedAt: 1,
          facts: {
            repositoryId: 'R_repo', repositoryDatabaseId: '1', projectId: 'P_project', statusFieldId: 'F_status',
            membership: { state: 'absent' },
            issue: {
              id: 'I_issue', repositoryId: 'R_repo', repositoryDatabaseId: '1', number: 1, state: 'open',
              title: 'Recover work', url: 'https://github.com/owner/repo/issues/1', updatedAt: 1,
            },
          },
        },
      },
    })
    const domains = currentDomains(fixture, new Map(), new Map(), new Map([[recovery.id, recovery]]))
    expect(() => {
      validateCurrentSakiState(domains.controlPlane, domains.storageGeneration,
        INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID)
    }).toThrow('GitHub Work Item recovery targets a missing Development Project')
  })

  it('rejects a missing current control singleton', () => {
    const fixture = currentFixture()
    fixture.controlState.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('control state is not the required singleton')
  })

  it('rejects unfinished current provisioning', () => {
    const fixture = currentFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, phase: 'provisioning' })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('provisioning is not ready')
  })

  it('rejects a current control owner other than the selected Installation', () => {
    const fixture = currentFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, installationId: OTHER_INSTALLATION_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('control state belongs to another Installation')
  })

  it('rejects a non-human current Host Operator', () => {
    const fixture = currentFixture()
    const principal = requiredMapRecord(fixture.principals, PRINCIPAL_ID)
    fixture.principals.set(PRINCIPAL_ID, { ...principal, kind: 'automation' })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host Operator Principal must be human')
  })

  it('rejects inconsistent current Foundation relationships', () => {
    const fixture = currentFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, installationId: OTHER_INSTALLATION_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Foundation relationships are inconsistent')
  })

  it('rejects an invalid current Access singleton count', () => {
    const fixture = currentFixture()
    fixture.access.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Installation Access is not the required singleton')
  })

  it('rejects a current Access singleton owned under another key', () => {
    const fixture = currentFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.clear()
    fixture.access.set(OTHER_ACCESS_ID, { ...access, id: OTHER_ACCESS_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('belongs to another provisioning owner')
  })

  it('rejects a current record whose id disagrees with its table key', () => {
    const fixture = currentFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, id: OTHER_HOST_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('record id disagrees with its table key')
  })

  it('rejects a Foundation reference to a missing current Host', () => {
    const fixture = currentFixture()
    const installation = requiredMapRecord(fixture.installations, INSTALLATION_ID)
    fixture.installations.set(INSTALLATION_ID, { ...installation, currentHostId: OTHER_HOST_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host')
  })

  it('rejects an Access challenge that references a missing Host', () => {
    const fixture = currentFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, installationAccessRecordSchema.parse({
      ...access,
      nextChallengeOrdinal: 1,
      challenges: [{
        id: `${ACCESS_ID}:challenge:0`,
        ordinal: 0,
        revision: 0,
        purpose: 'initial-bootstrap',
        installationId: INSTALLATION_ID,
        storageGenerationId: STORAGE_GENERATION_ID,
        hostId: OTHER_HOST_ID,
        principalId: PRINCIPAL_ID,
        verifierDigest: 'a'.repeat(64),
        issuedAt: 10,
        expiresAt: 20,
        state: 'issued',
      }],
    }))
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host')
  })

  it('rejects registration Intents without the Registry singleton', () => {
    const fixture = currentFixture()
    const intent = currentIntent()
    fixture.intents.set(intent.id, intent)
    fixture.registries.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Intents exist without the Project Registry')
  })

  it('rejects a GitHub Project sync when the Project Registry is absent', () => {
    const fixture = currentFixture()
    fixture.registries.clear()
    const projectId = SAKI_PROJECT_REQUEST_FIXTURES.projectSettings.projectId
    const sync = githubProjectSyncRecordSchema.parse({
      id: projectId,
      schemaVersion: 2,
      revision: 0,
      installationId: INSTALLATION_ID,
      nextCandidateRevision: 1,
      nextBoardGeneration: 1,
    })
    const domains = currentDomains(fixture, new Map([[projectId, sync]]))

    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('has no Development Project')
  })

  it('rejects a registration actor whose captured Principal revision is from the future', () => {
    const fixture = currentFixture()
    const intent = currentIntent()
    const payload = {
      ...intent.payload,
      actor: {
        ...intent.payload.actor,
        principalRevision: intent.payload.actor.principalRevision + 1,
      },
    }
    fixture.intents.set(intent.id, registrationIntentRecordSchema.parse({
      ...intent,
      payload,
      payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    }))
    const domains = currentDomains(fixture)

    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('registration Intent actor reference is inconsistent')
  })

  it.each([
    ['Installation', OTHER_INSTALLATION_ID, STORAGE_GENERATION_ID],
    ['physical generation', INSTALLATION_ID, OTHER_STORAGE_GENERATION_ID],
  ] as const)('rejects a seal for another %s', (_name, installationId, generationId) => {
    const fixture = currentFixture()
    fixture.seals.set(
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(installationId, generationId, BUILD_ID),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow(`another ${_name}`)
  })

  it('rejects seal provenance that disagrees with generation.json', () => {
    const fixture = currentFixture()
    fixture.seals.set(
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        'saki-build-other' as SakiBuildId,
      ),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('build provenance')
  })

  it('rejects a non-singleton storage-generation seal table', () => {
    const fixture = currentFixture()
    fixture.seals.set(
      'storage-generation-shadow',
      createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('required singleton')
  })

  it('retains unreferenced Foundation history without imposing current-owner relationships', () => {
    const fixture = currentFixture()
    fixture.installations.set(OTHER_INSTALLATION_ID, installationRecordSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'retired',
      currentHostId: OTHER_HOST_ID,
    }))
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })
})

describe('historical Saki v4 source validation', () => {
  it('validates the frozen v4 tables and storage-generation v2 singleton without later Git tables', () => {
    const domains = v4Domains(historicalFixture())
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })

  it('rejects storage-generation metadata from another physical generation', () => {
    const domains = v4Domains(historicalFixture())
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        OTHER_STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('selected generation metadata')
  })

  it.each(['missing', 'wrong-key'] as const)(
    'rejects a %s v2 storage-generation seal singleton',
    (variant) => {
      const seal = storageGenerationV2SealRecordSchema.parse({
        schemaVersion: 2,
        installationId: INSTALLATION_ID,
        storageGenerationId: STORAGE_GENERATION_ID,
        stateVersion: 4,
        createdByBuildId: BUILD_ID,
      })
      const seals = variant === 'missing'
        ? new Map<string, V4Seal>()
        : new Map<string, V4Seal>([['storage-generation-shadow', seal]])
      const domains = v4Domains(historicalFixture(), undefined, seals)
      expect(() => {
        validateSakiV4SourceState(
          domains.controlPlane,
          domains.storageGeneration,
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          BUILD_ID,
        )
      }).toThrow('v4 storage generation seal is not the required singleton')
    },
  )

  it.each(['missing', 'wrong-key'] as const)(
    'rejects a %s v4 Project Registry singleton',
    (variant) => {
      const domains = v4Domains(historicalFixture(), (tables) => {
        const registry = requiredV4Record(
          tables,
          'development_project_registry',
          DEVELOPMENT_PROJECT_REGISTRY_KEY,
        ) as V4Registry
        tables['development_project_registry'] = variant === 'missing'
          ? {}
          : { 'shadow-project-registry': registry }
      })
      expect(() => {
        validateSakiV4SourceState(
          domains.controlPlane,
          domains.storageGeneration,
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          BUILD_ID,
        )
      }).toThrow('v4 Project Registry is not the required singleton')
    },
  )

  it('rejects a v4 registration Intent whose table key disagrees with its id', () => {
    const domains = v4Domains(historicalFixture(), (tables) => {
      const intent = requiredV4Record(
        tables,
        'registration_intents',
        SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
      ) as V4RegistrationIntent
      tables['registration_intents'] = { [GITHUB_INTENT_ID]: intent }
    })
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('v4 registration Intent id disagrees with its table key')
  })

  it.each(['workspace-observed', 'registry-committed'] as const)(
    'accepts valid %s initial Binding evidence',
    (phase) => {
      const domains = v4Domains(historicalFixture(), (tables) => {
        const { intent } = installV4Project(tables)
        tables['registration_intents'] = { [intent.id]: { ...intent, phase } }
      })
      expect(() => {
        validateSakiV4SourceState(
          domains.controlPlane,
          domains.storageGeneration,
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          BUILD_ID,
        )
      }).not.toThrow()
    },
  )

  it.each([
    ['incomplete children', (tables: MutableV4Tables) => {
      const { registry } = installV4Project(tables)
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: { ...registry, projects: [] },
      }
    }],
    ['committed children', (tables: MutableV4Tables) => {
      const { registry } = installV4Project(tables)
      const project = registry.projects[0]!
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          ...registry,
          projects: [{ ...project, projectTitle: `${project.projectTitle} mismatch` }],
        },
      }
    }],
    ['initial Binding evidence', (tables: MutableV4Tables) => {
      const { intent, registry } = installV4Project(tables)
      const binding = registry.resourceBindings[0]!
      tables['registration_intents'] = { [intent.id]: { ...intent, phase: 'registry-committed' } }
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          ...registry,
          resourceBindings: [{ ...binding, revision: 1 }],
        },
      }
    }],
    ['workspace-observed missing inspection', (tables: MutableV4Tables) => {
      const { intent } = installV4Project(tables)
      tables['registration_intents'] = {
        [intent.id]: { ...intent, phase: 'workspace-observed', workspaceInspection: undefined },
      }
    }],
    ['workspace-observed current inspection', (tables: MutableV4Tables) => {
      const { intent, registry } = installV4Project(tables)
      const binding = registry.resourceBindings[0]!
      tables['registration_intents'] = { [intent.id]: { ...intent, phase: 'workspace-observed' } }
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          ...registry,
          resourceBindings: [{ ...binding, currentInspection: undefined }],
        },
      }
    }],
    ['initial current inspection', (tables: MutableV4Tables) => {
      const { registry } = installV4Project(tables)
      const binding = registry.resourceBindings[0]!
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          ...registry,
          resourceBindings: [{ ...binding, currentInspection: undefined }],
        },
      }
    }],
    ['unreachable Binding revision', (tables: MutableV4Tables) => {
      const { registry } = installV4Project(tables)
      const binding = registry.resourceBindings[0]!
      tables['development_project_registry'] = {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          ...registry,
          resourceBindings: [{ ...binding, revision: 1 }],
        },
      }
    }],
  ] as const)('rejects v4 Project mappings with invalid %s', (_name, mutate) => {
    const domains = v4Domains(historicalFixture(), mutate)
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow()
  })

  it.each([
    ['table key', (tables: MutableV4Tables) => {
      const { intent: registration } = installV4Project(tables)
      const intent = v4GitHubIntent(registration.payload.actor)
      tables['github_sync_configuration_intents'] = {
        ['intent-00000000-0000-4000-8000-000000000110']: intent,
      }
    }, 'synchronization Intent'],
    ['shared registration identity', (tables: MutableV4Tables) => {
      const { intent: registration } = installV4Project(tables)
      const intent = v4GitHubIntent(registration.payload.actor, { id: registration.id })
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }, 'multiple Intent kinds'],
    ['Installation', (tables: MutableV4Tables) => {
      const { intent: registration } = installV4Project(tables)
      const intent = v4GitHubIntent({ ...registration.payload.actor, installationId: OTHER_INSTALLATION_ID })
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }, 'belongs to another Installation'],
    ['actor reference', (tables: MutableV4Tables) => {
      const { intent: registration } = installV4Project(tables)
      const intent = v4GitHubIntent({ ...registration.payload.actor, principalRevision: 10 })
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }, 'actor reference is inconsistent'],
    ['Development Project', (tables: MutableV4Tables) => {
      const registration = requiredV4Record(
        tables,
        'registration_intents',
        SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
      ) as V4RegistrationIntent
      const intent = v4GitHubIntent(registration.payload.actor)
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }, 'has no Development Project'],
  ] as const)('rejects a v4 GitHub Intent with an invalid %s', (_name, mutate, message) => {
    const domains = v4Domains(historicalFixture(), mutate)
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow(message)
  })

  it.each([
    ['table key', (tables: MutableV4Tables) => {
      installV4Project(tables)
      const sync = v4GitHubProjectSyncRecordSchema.parse({
        id: PROJECT_ID,
        schemaVersion: 1,
        revision: 0,
        installationId: INSTALLATION_ID,
        nextCandidateRevision: 1,
        nextBoardGeneration: 1,
      })
      tables['github_project_sync'] = { ['project-00000000-0000-4000-8000-000000000106']: sync }
    }, 'table key'],
    ['Installation', (tables: MutableV4Tables) => {
      installV4Project(tables)
      const sync = v4GitHubProjectSyncRecordSchema.parse({
        id: PROJECT_ID,
        schemaVersion: 1,
        revision: 0,
        installationId: OTHER_INSTALLATION_ID,
        nextCandidateRevision: 1,
        nextBoardGeneration: 1,
      })
      tables['github_project_sync'] = { [sync.id]: sync }
    }, 'another Installation'],
    ['Development Project', (tables: MutableV4Tables) => {
      const sync = v4GitHubProjectSyncRecordSchema.parse({
        id: PROJECT_ID,
        schemaVersion: 1,
        revision: 0,
        installationId: INSTALLATION_ID,
        nextCandidateRevision: 1,
        nextBoardGeneration: 1,
      })
      tables['github_project_sync'] = { [sync.id]: sync }
    }, 'no Development Project'],
  ] as const)('rejects a v4 GitHub sync with an invalid %s', (_name, mutate, message) => {
    const domains = v4Domains(historicalFixture(), mutate)
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow(message)
  })

  it('accepts a project-not-found conflict without a retained Development Project', () => {
    const domains = v4Domains(historicalFixture(), (tables) => {
      const registration = requiredV4Record(
        tables,
        'registration_intents',
        SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
      ) as V4RegistrationIntent
      const intent = v4GitHubIntent(registration.payload.actor, {
        phase: 'conflict',
        terminalReason: 'project-not-found',
      })
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    })
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })

  it.each(['prepared', 'saved', 'active-and-pending', 'active-history'] as const)(
    'accepts a complete %s v4 GitHub aggregate mapping',
    (variant) => {
      const domains = v4Domains(historicalFixture(), (tables) => {
        const { intent: registration } = installV4Project(tables)
        if (variant === 'active-and-pending') {
          const state = activeAndPendingV4GitHub(registration.payload.actor)
          tables['github_project_sync'] = { [state.sync.id]: state.sync }
          tables['github_sync_configuration_intents'] = {
            [state.saved.id]: state.saved,
            [state.prepared.id]: state.prepared,
          }
          return
        }
        if (variant === 'active-history') {
          const state = activeV4GitHubHistory(registration.payload.actor)
          tables['github_project_sync'] = { [state.sync.id]: state.sync }
          tables['github_sync_configuration_intents'] = Object.fromEntries(
            state.intents.map(intent => [intent.id, intent]),
          )
          return
        }
        const intent = v4GitHubIntent(registration.payload.actor, variant === 'saved'
          ? { phase: 'saved', candidateRevision: 1, synchronizationRevision: 1 }
          : {})
        const sync = pendingV4GitHubSync(intent)
        tables['github_project_sync'] = { [sync.id]: sync }
        tables['github_sync_configuration_intents'] = { [intent.id]: intent }
      })
      expect(() => {
        validateSakiV4SourceState(
          domains.controlPlane,
          domains.storageGeneration,
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          BUILD_ID,
        )
      }).not.toThrow()
    },
  )

  it('rejects multiple prepared v4 GitHub Intents for one Project', () => {
    const domains = v4Domains(historicalFixture(), (tables) => {
      const { intent: registration } = installV4Project(tables)
      const first = v4GitHubIntent(registration.payload.actor)
      const second = v4GitHubIntent(registration.payload.actor, {
        id: 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId,
      })
      tables['github_sync_configuration_intents'] = { [first.id]: first, [second.id]: second }
    })
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('retains multiple prepared Intents')
  })

  it.each([
    ['missing aggregate', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor, { phase: 'saved', candidateRevision: 1, synchronizationRevision: 1 })
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
    ['candidate revision', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor, { phase: 'saved', candidateRevision: 2, synchronizationRevision: 1 })
      const accepted = v4GitHubIntent(actor, {
        id: 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId,
      })
      const sync = pendingV4GitHubSync(accepted)
      tables['github_project_sync'] = { [sync.id]: sync }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent, [accepted.id]: accepted }
    }],
    ['synchronization revision', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor, { phase: 'saved', candidateRevision: 1, synchronizationRevision: 2 })
      const sync = pendingV4GitHubSync(intent)
      tables['github_project_sync'] = { [sync.id]: sync }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
  ] as const)('rejects a saved v4 GitHub Intent with an invalid %s', (_name, mutate) => {
    const domains = v4Domains(historicalFixture(), (tables) => {
      const { intent: registration } = installV4Project(tables)
      mutate(tables, registration.payload.actor)
    })
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('has no aggregate mapping')
  })

  it.each([
    ['accepted identity', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const state = activeAndPendingV4GitHub(actor)
      const duplicate = v4GitHubProjectSyncRecordSchema.parse({
        ...state.sync,
        pending: {
          ...state.sync.pending!,
          acceptedIntentId: state.saved.id,
          receiptId: state.saved.receiptId,
        },
      })
      tables['github_project_sync'] = { [duplicate.id]: duplicate }
      tables['github_sync_configuration_intents'] = {
        [state.saved.id]: state.saved,
        [state.prepared.id]: state.prepared,
      }
    }],
    ['saved count', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const prepared = v4GitHubIntent(actor)
      const saved = v4GitHubIntent(actor, {
        id: 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId,
        phase: 'saved',
        candidateRevision: 1,
        synchronizationRevision: 1,
      })
      const sync = pendingV4GitHubSync(prepared)
      tables['github_project_sync'] = { [sync.id]: sync }
      tables['github_sync_configuration_intents'] = { [prepared.id]: prepared, [saved.id]: saved }
    }],
    ['saved candidate sequence', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const state = activeAndPendingV4GitHub(actor)
      const saved = v4GitHubIntent(actor, {
        id: state.saved.id,
        phase: 'saved',
        candidateRevision: 2,
        synchronizationRevision: 1,
      })
      tables['github_project_sync'] = { [state.sync.id]: state.sync }
      tables['github_sync_configuration_intents'] = { [saved.id]: saved, [state.prepared.id]: state.prepared }
    }],
    ['saved synchronization sequence', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const state = activeAndPendingV4GitHub(actor)
      const saved = v4GitHubIntent(actor, {
        id: state.saved.id,
        phase: 'saved',
        candidateRevision: 1,
        synchronizationRevision: 2,
      })
      tables['github_project_sync'] = { [state.sync.id]: state.sync }
      tables['github_sync_configuration_intents'] = { [saved.id]: saved, [state.prepared.id]: state.prepared }
    }],
    ['saved expected revision', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const state = activeAndPendingV4GitHub(actor)
      const saved = v4GitHubIntent(actor, {
        id: state.saved.id,
        expectedRevision: 1,
        phase: 'saved',
        candidateRevision: 1,
        synchronizationRevision: 1,
      })
      tables['github_project_sync'] = { [state.sync.id]: state.sync }
      tables['github_sync_configuration_intents'] = { [saved.id]: saved, [state.prepared.id]: state.prepared }
    }],
    ['prepared expected revision', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const state = activeAndPendingV4GitHub(actor)
      const prepared = v4GitHubIntent(actor, { id: state.prepared.id, expectedRevision: 0,
        patch: { credentialRef: ROTATED_GITHUB_CREDENTIAL_REF } })
      tables['github_project_sync'] = { [state.sync.id]: state.sync }
      tables['github_sync_configuration_intents'] = { [state.saved.id]: state.saved, [prepared.id]: prepared }
    }],
    ['incomplete resolved configuration', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor, { patch: { credentialRef: ROTATED_GITHUB_CREDENTIAL_REF } })
      const sync = pendingV4GitHubSync(intent)
      tables['github_project_sync'] = { [sync.id]: sync }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
    ['accepted receipt', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor)
      const sync = pendingV4GitHubSync(intent)
      const mismatched = v4GitHubProjectSyncRecordSchema.parse({
        ...sync,
        pending: { ...sync.pending!, receiptId: 'receipt-00000000-0000-4000-8000-000000000110' },
      })
      tables['github_project_sync'] = { [mismatched.id]: mismatched }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
    ['accepted configuration', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor)
      const sync = pendingV4GitHubSync(intent)
      const configuration = { ...GITHUB_CONFIGURATION, credentialRef: ROTATED_GITHUB_CREDENTIAL_REF }
      const mismatched = v4GitHubProjectSyncRecordSchema.parse({
        ...sync,
        pending: { ...sync.pending!, configuration, changedFields: GITHUB_CONFIGURATION_FIELDS },
      })
      tables['github_project_sync'] = { [mismatched.id]: mismatched }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
    ['accepted phase', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const saved = v4GitHubIntent(actor, { phase: 'saved', candidateRevision: 1, synchronizationRevision: 1 })
      const conflict = v4GitHubIntent(actor, {
        id: 'intent-00000000-0000-4000-8000-000000000110' as SakiControlIntentId,
        phase: 'conflict',
        terminalReason: 'expected-revision',
      })
      const sync = pendingV4GitHubSync(conflict)
      tables['github_project_sync'] = { [sync.id]: sync }
      tables['github_sync_configuration_intents'] = { [saved.id]: saved, [conflict.id]: conflict }
    }],
    ['changed fields', (tables: MutableV4Tables, actor: V4RegistrationIntent['payload']['actor']) => {
      const intent = v4GitHubIntent(actor)
      const sync = pendingV4GitHubSync(intent)
      const mismatched = v4GitHubProjectSyncRecordSchema.parse({
        ...sync,
        pending: { ...sync.pending!, changedFields: ['appId'] },
      })
      tables['github_project_sync'] = { [mismatched.id]: mismatched }
      tables['github_sync_configuration_intents'] = { [intent.id]: intent }
    }],
  ] as const)('rejects a v4 GitHub aggregate with an invalid %s mapping', (_name, mutate) => {
    const domains = v4Domains(historicalFixture(), (tables) => {
      const { intent: registration } = installV4Project(tables)
      mutate(tables, registration.payload.actor)
    })
    expect(() => {
      validateSakiV4SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow()
  })
})

describe('historical Saki v3 source validation', () => {
  it('accepts a retained registration Intent alongside unrelated Foundation history without writes', () => {
    const fixture = currentFixture()
    fixture.installations.set(OTHER_INSTALLATION_ID, installationRecordSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'retired',
      currentHostId: OTHER_HOST_ID,
    }))
    fixture.hosts.set(OTHER_HOST_ID, hostRecordSchema.parse({
      id: OTHER_HOST_ID,
      revision: 0,
      installationId: OTHER_INSTALLATION_ID,
      state: 'retired',
    }))
    fixture.principals.set(OTHER_PRINCIPAL_ID, principalRecordSchema.parse({
      id: OTHER_PRINCIPAL_ID,
      revision: 0,
      kind: 'human',
      displayName: 'Previous Operator',
      state: 'retired',
    }))
    const unrelatedGrant = grantRecordSchema.parse({
      id: OTHER_GRANT_ID,
      revision: 0,
      installationId: OTHER_INSTALLATION_ID,
      principalId: OTHER_PRINCIPAL_ID,
      state: 'revoked',
      actions: ['development-project:register'],
      scope: { kind: 'installation', installationId: OTHER_INSTALLATION_ID },
    })
    fixture.grants.set(OTHER_GRANT_ID, unrelatedGrant)
    const intent = currentIntent()
    fixture.intents.set(intent.id, intent)
    const domains = v3Domains(fixture)

    expect(() => {
      validateSakiV3SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
    expect(fixture.grants.get(OTHER_GRANT_ID)).toBe(unrelatedGrant)
    expect(fixture.intents.get(intent.id)).toBe(intent)
  })

  it('rejects a v3 registration Intent whose table key disagrees with its id', () => {
    const fixture = currentFixture()
    const intent = currentIntent()
    fixture.intents.set(GITHUB_INTENT_ID, intent)
    const domains = v3Domains(fixture)
    expect(() => {
      validateSakiV3SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('registration Intent id disagrees with its table key')
  })

  it.each(['missing', 'wrong-key'] as const)(
    'rejects a %s v1 storage-generation seal singleton',
    (variant) => {
      const seals = new Map<string, StorageGenerationV1SealRecord>()
      if (variant === 'wrong-key') seals.set('storage-generation-shadow', v1Seal())
      const domains = v3Domains(currentFixture(), seals)

      expect(() => {
        validateSakiV3SourceState(
          domains.controlPlane,
          domains.storageGeneration,
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          BUILD_ID,
        )
      }).toThrow('historical Saki storage generation seal is not the required singleton')
    },
  )

  it.each([
    ['Installation', { installationId: OTHER_INSTALLATION_ID }],
    ['physical generation', { storageGenerationId: OTHER_STORAGE_GENERATION_ID }],
    ['build provenance', { createdByBuildId: 'saki-build-other' as SakiBuildId }],
  ] as const)('rejects v1 seal metadata for another %s', (_name, overrides) => {
    const seals = new Map([[STORAGE_GENERATION_KEY, v1Seal(overrides)]])
    const domains = v3Domains(currentFixture(), seals)

    expect(() => {
      validateSakiV3SourceState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('historical Saki storage generation seal disagrees with selected generation metadata')
  })
})

describe('historical Saki v2 source validation', () => {
  it('accepts initial and current Foundation generation references without writes', () => {
    const fixture = historicalFixture()
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects unfinished historical provisioning', () => {
    const fixture = historicalFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, phase: 'provisioning' })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('provisioning is not ready')
  })

  it('rejects a non-human historical Host Operator', () => {
    const fixture = historicalFixture()
    const principal = requiredMapRecord(fixture.principals, PRINCIPAL_ID)
    fixture.principals.set(PRINCIPAL_ID, { ...principal, kind: 'automation' })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Host Operator Principal must be human')
  })

  it('rejects inconsistent historical Foundation relationships', () => {
    const fixture = historicalFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, installationId: OTHER_INSTALLATION_ID })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Foundation relationships are inconsistent')
  })

  it('rejects a historical record whose id disagrees with its table key', () => {
    const fixture = historicalFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, id: OTHER_HOST_ID })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('record id disagrees with its table key')
  })

  it('accepts exact B03 bootstrap evidence whose completion summary is absent', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse(withoutCompletion))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it.each([
    ['empty', undefined],
    ['issued', 'issued'],
    ['terminal', 'expired'],
  ] as const)('accepts %s exact B03 Access before bootstrap completion', (_name, state) => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    const retained = access.challenges[0]!
    const challenges = state === undefined
      ? []
      : [{
        ...retained,
        revision: state === 'issued' ? 0 : 1,
        state,
        terminalAt: state === 'issued' ? undefined : retained.expiresAt,
        browserSessionId: undefined,
      }]
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      nextChallengeOrdinal: challenges.length,
      nextSessionOrdinal: 0,
      challenges,
      sessions: [],
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects missing B03 completion evidence after a Browser Session was allocated', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      nextChallengeOrdinal: 0,
      nextSessionOrdinal: 1,
      challenges: [],
      sessions: [],
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('rejects exact B03 state whose absent completion cannot be reconstructed', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      challenges: withoutCompletion.challenges.map(challenge => ({
        ...challenge,
        revision: 1,
        state: 'expired',
        terminalAt: challenge.expiresAt,
        browserSessionId: undefined,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('bootstrap completion evidence')
  })

  it('rejects a historical Bootstrap Challenge whose child identity disagrees with its ordinal', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        id: `${ACCESS_ID}:challenge:1`,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('invalid Bootstrap Challenge')
  })

  it('compares historical consumed pairs by Installation State Generation', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      sessions: access.sessions.map(session => ({
        ...session,
        installationGenerationId: CURRENT_INSTALLATION_GENERATION_ID,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('consumed Bootstrap Challenge references an inconsistent Browser Session')
  })

  it('rejects a historical Project Registry with an invalid singleton key', () => {
    const fixture = historicalFixture()
    fixture.registries.set(
      'shadow-project-registry' as typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      requiredMapRecord(fixture.registries, DEVELOPMENT_PROJECT_REGISTRY_KEY),
    )

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('invalid singleton key')
  })

  it('rejects a historical registration Intent whose table key disagrees with its id', () => {
    const fixture = historicalFixture()
    const intent = requiredMapRecord(
      fixture.intents,
      SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId,
    )
    fixture.intents.clear()
    fixture.intents.set(GITHUB_INTENT_ID, intent)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('registration Intent id disagrees with its table key')
  })

  it.each([
    ['uncommitted Intent', (fixture: HistoricalFixture) => {
      const { intent } = installHistoricalProject(fixture)
      fixture.intents.set(intent.id, { ...intent, phase: 'prepared' })
    }, 'has no committed Intent'],
    ['revision mismatch', (fixture: HistoricalFixture) => {
      const { registry } = installHistoricalProject(fixture)
      const mapping = registry.intentMappings[0]!
      fixture.registries.set(DEVELOPMENT_PROJECT_REGISTRY_KEY, {
        ...registry,
        intentMappings: [{ ...mapping, registryRevision: 2 }],
      })
    }, 'disagrees with its mapping'],
    ['missing mapping', (fixture: HistoricalFixture) => {
      const { registry } = installHistoricalProject(fixture)
      fixture.registries.set(DEVELOPMENT_PROJECT_REGISTRY_KEY, { ...registry, intentMappings: [] })
    }, 'has no mapping'],
  ] as const)('rejects a historical Project mapping with an invalid %s', (_name, mutate, message) => {
    const fixture = historicalFixture()
    mutate(fixture)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow(message)
  })

  it('accepts a workspace-observed historical mapping before commit acknowledgement', () => {
    const fixture = historicalFixture()
    const { intent } = installHistoricalProject(fixture)
    fixture.intents.set(intent.id, { ...intent, phase: 'workspace-observed' })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects a control owner other than the selected Installation', () => {
    const fixture = historicalFixture()
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), OTHER_INSTALLATION_ID)
    }).toThrow('belongs to another Installation')
  })

  it('accepts terminal Access history from outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
      sessions: access.sessions.map(session => ({
        ...session,
        revision: 1,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
        state: 'revoked',
        terminalAt: 12,
      })),
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects an issued Access challenge outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      nextChallengeOrdinal: 2,
      challenges: [...access.challenges, {
        id: `${ACCESS_ID}:challenge:1`,
        ordinal: 1,
        revision: 0,
        purpose: 'local-reauthentication',
        installationId: INSTALLATION_ID,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
        hostId: HOST_ID,
        principalId: PRINCIPAL_ID,
        verifierDigest: 'c'.repeat(64),
        issuedAt: 12,
        expiresAt: 22,
        state: 'issued',
      }],
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('issued Bootstrap Challenge references an unrelated Installation State Generation')
  })

  it('rejects an active Access session outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
      sessions: access.sessions.map(session => ({
        ...session,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('active Browser Session references an unrelated Installation State Generation')
  })

  it('rejects a registration actor outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const intent = historicalIntent(OTHER_INSTALLATION_GENERATION_ID, GRANT_ID)
    fixture.intents.set(intent.id, intent)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('unrelated Installation State Generation')
  })

  it('does not impose current-Foundation relationships on unreferenced B03 records', () => {
    const fixture = historicalFixture()
    fixture.installations.set(OTHER_INSTALLATION_ID, historicalInstallationRecordSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'retired',
      currentInstallationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      currentHostId: OTHER_HOST_ID,
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects a historical registration actor whose Grant is absent', () => {
    const fixture = historicalFixture()
    const intent = historicalIntent(CURRENT_INSTALLATION_GENERATION_ID, OTHER_GRANT_ID)
    fixture.intents.set(intent.id, intent)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Grant')
  })

  it('rejects a non-singleton historical control owner', () => {
    const fixture = historicalFixture()
    fixture.controlState.set(
      'shadow-control' as typeof CONTROL_STATE_KEY,
      requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY),
    )
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    })
      .toThrow('required singleton')
  })
})
