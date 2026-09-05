import { describe, expect, it, vi } from 'vitest'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

vi.mock('@breakfastdapaidang/saki-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breakfastdapaidang/saki-execution')>()
  const { z } = await import('zod')
  const forbiddenCurrentHelper = () => {
    throw new Error('v4 source reader reached a current execution helper')
  }
  return {
    ...actual,
    canonicalDigest: forbiddenCurrentHelper,
    compareSafeGitRemoteObservations: forbiddenCurrentHelper,
    deriveGitHubRepositoryCandidates: forbiddenCurrentHelper,
    exactBytesDigest: forbiddenCurrentHelper,
    inheritedChangeBaselineSchema: z.never(),
    inheritedChangeBaselineIdentityMaterial: forbiddenCurrentHelper,
    isAbsoluteHostPath: forbiddenCurrentHelper,
    isSafeDisplayLocation: forbiddenCurrentHelper,
    isSafeGitBranchName: forbiddenCurrentHelper,
    isSafeGitRef: forbiddenCurrentHelper,
    projectSelectionProjectionSchema: z.never(),
    safeGitRemoteObservationSchema: z.never(),
    safeGitRemoteObservationKey: forbiddenCurrentHelper,
    trustedProjectSelectionObservationSchema: z.never(),
    MAX_DISPLAY_LOCATION_CHARS: 1,
    // Current schemas must remain constructible while their accepted range drifts from v4.
    MAX_GIT_REF_CHARS: 'refs/heads/a'.length,
    MAX_INVENTORY_ENTRIES: 1,
    MAX_REMOTE_COORDINATE_CHARS: 1,
    MAX_SAFE_REMOTES: 1,
    MAX_TRUSTED_PATH_CHARS: 1,
  }
})

vi.mock('@breakfastdapaidang/saki-github', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breakfastdapaidang/saki-github')>()
  const { z } = await import('zod')
  return {
    ...actual,
    githubAccountIdSchema: z.never(),
    githubAppIdSchema: z.never(),
    githubFailureSchema: z.never(),
    githubInstallationIdSchema: z.never(),
    githubIssueIdSchema: z.never(),
    githubProjectBoardFingerprintSchema: z.never(),
    githubProjectFieldIdSchema: z.never(),
    githubProjectIdSchema: z.never(),
    githubProjectItemIdSchema: z.never(),
    githubProjectOptionIdSchema: z.never(),
    githubRepositoryDatabaseIdSchema: z.never(),
    githubRepositoryIdSchema: z.never(),
  }
})

vi.mock('@deepseek-ai/dsh-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-workspace')>()
  const { z } = await import('zod')
  return { ...actual, workspaceIdSchema: z.never() }
})

vi.mock('../src/constants.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/constants.ts')>()
  return {
    ...actual,
    SAKI_BOARD_WORK_ITEM_LIMIT: 1,
    SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT: 2,
    SAKI_GITHUB_MAPPING_ISSUE_LIMIT: 8,
  }
})

vi.mock('../src/ids.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ids.ts')>()
  const { z } = await import('zod')
  return {
    ...actual,
    sakiBoardRemoteFingerprintSchema: z.never(),
    sakiBoardWorkItemIdSchema: z.never(),
    sakiBuildIdSchema: z.never(),
    sakiBootstrapChallengeIdSchema: z.never(),
    sakiBrowserSessionIdSchema: z.never(),
    sakiControlIntentIdSchema: z.never(),
    sakiDevelopmentProjectIdSchema: z.never(),
    sakiGitHubScanAttemptIdSchema: z.never(),
    sakiGrantIdSchema: z.never(),
    sakiHostIdSchema: z.never(),
    sakiInstallationAccessIdSchema: z.never(),
    sakiInstallationIdSchema: z.never(),
    sakiIntentReceiptIdSchema: z.never(),
    sakiPrincipalIdSchema: z.never(),
    sakiResourceBindingIdSchema: z.never(),
    sakiStorageGenerationIdSchema: z.never(),
  }
})

vi.mock('../src/spec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/spec.ts')>()
  const { z } = await import('zod')
  return {
    ...actual,
    CONTROL_STATE_KEY: 'drifted-control-state',
    DEVELOPMENT_PROJECT_REGISTRY_KEY: 'drifted-development-project-registry',
    V4_HOST_OPERATOR_ACTIONS: ['drifted-action'],
    controlStateRecordSchema: z.never(),
    hostRecordSchema: z.never(),
    installationAccessRecordSchema: z.never(),
    installationRecordSchema: z.never(),
    principalRecordSchema: z.never(),
    registrationActorSchema: z.never(),
    v4GrantRecordSchema: z.never(),
  }
})

import {
  githubSynchronizationConfigurationSchema,
  githubStatusOptionMappingSchema,
  sakiGitHubMappingIssueSchema,
  sakiGitHubScanFailureSchema,
} from '../src/migration-v4-github.ts'
import { v4CanonicalDigest } from '../src/migration-v4-canonical.ts'
import { sakiControlPlaneV4DomainSpec } from '../src/migration.ts'
import { v4Source } from '../src/migration-v4-source.ts'
import { validateSakiV4SourceState } from '../src/state-validation.ts'
import {
  sakiStorageGenerationV2DomainSpec,
  storageGenerationV2SealRecordSchema,
} from '../src/state-version.ts'

const HOST_ID = 'host-00000000-0000-4000-8000-000000000002'
const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001'
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000003'
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000004'
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000005'
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000006'
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000007'
const INTENT_ID = 'intent-00000000-0000-4000-8000-000000000009'
const CONFIGURATION_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000011'
const SECOND_CONFIGURATION_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000013'
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000008'
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000012'
const OTHER_HOST_ID = 'host-00000000-0000-4000-8000-000000000102'
const OTHER_INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000101'
const OTHER_PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000103'
const OTHER_ACCESS_ID = 'access-00000000-0000-4000-8000-000000000105'
const OTHER_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000106'
const OTHER_BINDING_ID = 'binding-00000000-0000-4000-8000-000000000107'
const OTHER_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000109'
const OTHER_STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000112'
const BUILD_ID = 'saki-build-v4-freeze-test'
const INSPECTION_FINGERPRINT = '37ba595febc28fdf4242dee72760556df57b8c91a4d4c2280a24d6870218b33d'
const REGISTRATION_PAYLOAD_DIGEST = '16fbbd81ef02c4fe094224b73051773a000a61235ef54103f2a15224f553fede'
const GITHUB_PAYLOAD_DIGEST = '763e992fa691499e79dded835c733c7640b43aeeb0109cc402c97150f86e3446'
const WORK_ITEM_DIGEST = '87376bfb4a94ed6d5b2902af688908b5c8e9013fe75035ab9043d20700e1463f'
const {
  V4_CONTROL_STATE_KEY,
  V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
  V4_STORAGE_GENERATION_KEY,
} = v4Source
const V4_GITHUB_CONFIGURATION_FIELDS = [
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
] as const

function v4Actor() {
  return {
    installationId: INSTALLATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
    storageGenerationId: STORAGE_GENERATION_ID,
  }
}

function v4GitHubConfiguration() {
  return {
    appId: '123',
    githubInstallationId: '456',
    accountNodeId: 'account-node',
    repositoryNodeId: 'repository-node',
    repositoryDatabaseId: '789',
    projectNodeId: 'project-node',
    credentialRef: 'SAKI_GITHUB_PRIVATE_KEY',
    statusFieldNodeId: 'status-field-node',
    statusOptionNodeIds: {
      inbox: 'option-inbox',
      backlog: 'option-backlog',
      ready: 'option-ready',
      inProgress: 'option-in-progress',
      inReview: 'option-in-review',
      done: 'option-done',
      canceled: 'option-canceled',
    },
    activePollIntervalMs: 1_000,
    backgroundPollIntervalMs: 60_000,
    rateLimitReserve: 500,
  }
}

function v4InspectionFixture() {
  const baseline = {
    kind: 'unavailable' as const,
    reason: 'entry-limit' as const,
    observed: { entries: 2, pathBytes: 20, gitOutputBytes: 30, hashedBytes: 40, elapsedMs: 50 },
  }
  const trusted = {
    canonicalWorktreePath: '/fixture/repository',
    canonicalGitDirectory: '/fixture/repository/.git',
    canonicalCommonGitDirectory: '/fixture/repository/.git',
    gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    comparison: { fileMode: true, symlinks: true, autocrlf: false },
  }
  const projectionWithoutFingerprint = {
    observationVersion: 1 as const,
    hostId: HOST_ID,
    displayLocation: 'repository',
    objectFormat: 'sha1' as const,
    head: '1'.repeat(40),
    branch: 'main',
    detached: false,
    upstream: 'refs/remotes/origin/main',
    locked: false,
    inheritedChangeEntryCount: 2,
    conversionAmbiguous: false,
    remotes: [
      { transport: 'https' as const, coordinate: 'github.com/owner/repository' },
      { transport: 'ssh' as const, coordinate: 'github.com/owner/repository' },
    ],
    githubRepositoryCandidates: ['github.com/owner/repository'],
    workspaceId: WORKSPACE_ID,
    automaticMutationEligible: false,
    blockingReasons: ['dirty', 'baseline-unavailable'] as const,
    baseline,
  }
  return {
    projection: {
      ...projectionWithoutFingerprint,
      fingerprint: { version: 1 as const, digest: INSPECTION_FINGERPRINT },
    },
    trusted,
  }
}

function v4BaselineEntry(
  entry: Readonly<Record<string, unknown>>,
  pathDigest = '1'.repeat(64),
) {
  const material = { formatVersion: 1 as const, pathDigest, ...entry }
  return {
    ...material,
    digest: v4CanonicalDigest('saki/inherited-entry/v1', material),
  }
}

function v4CompleteBaseline(entries: readonly Readonly<Record<string, unknown>>[]) {
  const bounds = {
    maxEntries: 10,
    maxPathBytes: 1_000,
    maxGitOutputBytes: 1_000,
    maxFileBytes: 100,
    maxTotalFileBytes: 1_000,
    maxCaptureMs: 1_000,
  }
  const observed = {
    entries: entries.length,
    pathBytes: entries.length * 10,
    gitOutputBytes: entries.length * 20,
    hashedBytes: entries.length * 100,
    elapsedMs: 25,
  }
  const material = { formatVersion: 1 as const, bounds, observed: { ...observed, elapsedMs: 0 }, entries }
  return {
    kind: 'complete' as const,
    formatVersion: 1 as const,
    capturedAt: 10,
    bounds,
    observed,
    entries,
    digest: v4CanonicalDigest('saki/inherited-baseline/v1', material),
  }
}

function completeV4Domains() {
  const actor = v4Actor()
  const inspection = v4InspectionFixture()
  const challengeId = `${ACCESS_ID}:challenge:0`
  const sessionId = `${ACCESS_ID}:session:0`
  const control = sakiControlPlaneV4DomainSpec.tables.control_state.valueSchema.parse({
    schemaVersion: 2,
    revision: 6,
    phase: 'ready',
    installationId: INSTALLATION_ID,
    initialHostId: HOST_ID,
    hostOperatorPrincipalId: PRINCIPAL_ID,
    hostOperatorGrantId: GRANT_ID,
    installationAccessId: ACCESS_ID,
  })
  const installation = sakiControlPlaneV4DomainSpec.tables.installations.valueSchema.parse({
    id: INSTALLATION_ID,
    revision: 7,
    state: 'active',
    currentHostId: HOST_ID,
  })
  const host = sakiControlPlaneV4DomainSpec.tables.hosts.valueSchema.parse({
    id: HOST_ID,
    revision: 2,
    installationId: INSTALLATION_ID,
    state: 'enrolled',
  })
  const principal = sakiControlPlaneV4DomainSpec.tables.principals.valueSchema.parse({
    id: PRINCIPAL_ID,
    revision: actor.principalRevision,
    kind: 'human',
    displayName: 'Host Operator',
    state: 'active',
  })
  const grant = sakiControlPlaneV4DomainSpec.tables.grants.valueSchema.parse({
    id: GRANT_ID,
    revision: actor.grantRevision,
    installationId: INSTALLATION_ID,
    principalId: PRINCIPAL_ID,
    state: 'active',
    scope: { kind: 'installation', installationId: INSTALLATION_ID },
    actions: [...v4Source.V4_HOST_OPERATOR_ACTIONS],
  })
  const access = sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
    id: ACCESS_ID,
    schemaVersion: 2,
    revision: 8,
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
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      verifierDigest: 'a'.repeat(64),
      issuedAt: 10,
      expiresAt: 20,
      state: 'consumed',
      terminalAt: 11,
      browserSessionId: sessionId,
      storageGenerationId: STORAGE_GENERATION_ID,
    }],
    sessions: [{
      id: sessionId,
      ordinal: 0,
      revision: 0,
      installationId: INSTALLATION_ID,
      principalId: PRINCIPAL_ID,
      cookieDigest: 'b'.repeat(64),
      createdAt: 11,
      expiresAt: 21,
      state: 'active',
      storageGenerationId: STORAGE_GENERATION_ID,
    }],
  })
  const registrationPayload = {
    intent: {
      type: 'register-development-project' as const,
      intentId: INTENT_ID,
      projectTitle: 'Historical project',
      hostId: HOST_ID,
      directoryLocator: '/fixture/repository',
      expectedRegistryRevision: 0,
      confirmedFingerprint: inspection.projection.fingerprint,
      confirmedBaseline: inspection.projection.baseline,
    },
    actor,
  }
  const registrationIntent = sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse({
    id: INTENT_ID,
    schemaVersion: 2,
    revision: 1,
    receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
    payloadDigest: REGISTRATION_PAYLOAD_DIGEST,
    payload: registrationPayload,
    inspection,
    workspaceInspection: inspection,
    phase: 'workspace-observed',
    workspaceId: WORKSPACE_ID,
    createdAt: 12,
    updatedAt: 13,
  })
  const registry = sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.parse({
    id: V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 1,
    revision: 1,
    projects: [{
      id: PROJECT_ID,
      revision: 0,
      projectTitle: 'Historical project',
      resourceBindingId: BINDING_ID,
      state: 'active',
      createdAt: 12,
    }],
    resourceBindings: [{
      id: BINDING_ID,
      revision: 0,
      projectId: PROJECT_ID,
      hostId: HOST_ID,
      workspaceId: WORKSPACE_ID,
      health: 'active',
      registrationInspection: inspection,
      currentInspection: inspection,
      inheritedChangeBaseline: inspection.projection.baseline,
      createdAt: 12,
      observedAt: 13,
    }],
    canonicalWorktreeIndex: [{
      hostId: HOST_ID,
      path: inspection.trusted.canonicalWorktreePath,
      resourceBindingId: BINDING_ID,
    }],
    gitDirectoryIndex: [{
      hostId: HOST_ID,
      path: inspection.trusted.canonicalGitDirectory,
      resourceBindingId: BINDING_ID,
    }],
    intentMappings: [{
      intentId: INTENT_ID,
      projectId: PROJECT_ID,
      resourceBindingId: BINDING_ID,
      registryRevision: 1,
    }],
  })
  const configuration = v4GitHubConfiguration()
  const configurationPayload = {
    intent: {
      type: 'configure-github-synchronization' as const,
      intentId: CONFIGURATION_INTENT_ID,
      projectId: PROJECT_ID,
      expectedSynchronizationRevision: 0,
      patch: configuration,
    },
    actor,
  }
  const configurationIntent = sakiControlPlaneV4DomainSpec.tables.github_sync_configuration_intents.valueSchema.parse({
    id: CONFIGURATION_INTENT_ID,
    schemaVersion: 1,
    revision: 0,
    receiptId: CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
    payloadDigest: GITHUB_PAYLOAD_DIGEST,
    payload: configurationPayload,
    phase: 'prepared',
    createdAt: 14,
    updatedAt: 14,
  })
  const githubSync = sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
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
      changedFields: V4_GITHUB_CONFIGURATION_FIELDS,
      acceptedIntentId: CONFIGURATION_INTENT_ID,
      receiptId: CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
      savedAt: 14,
    },
  })
  const tables = {
    control_state: new Map([[V4_CONTROL_STATE_KEY, control]]),
    installations: new Map([[installation.id, installation]]),
    hosts: new Map([[host.id, host]]),
    principals: new Map([[principal.id, principal]]),
    grants: new Map([[grant.id, grant]]),
    installation_access: new Map([[access.id, access]]),
    development_project_registry: new Map([[V4_DEVELOPMENT_PROJECT_REGISTRY_KEY, registry]]),
    registration_intents: new Map([[registrationIntent.id, registrationIntent]]),
    github_project_sync: new Map([[githubSync.id, githubSync]]),
    github_sync_configuration_intents: new Map([[configurationIntent.id, configurationIntent]]),
  }
  const controlPlane = {
    name: sakiControlPlaneV4DomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
  } as unknown as Domain<typeof sakiControlPlaneV4DomainSpec>
  const seal = storageGenerationV2SealRecordSchema.parse({
    schemaVersion: 2,
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    stateVersion: 4,
    createdByBuildId: BUILD_ID,
  })
  const storageTables = { storage_generation: new Map([[V4_STORAGE_GENERATION_KEY, seal]]) }
  const storageGeneration = {
    name: sakiStorageGenerationV2DomainSpec.name,
    table: (name: keyof typeof storageTables) => storageTables[name],
  } as unknown as Domain<typeof sakiStorageGenerationV2DomainSpec>
  const records = {
    control,
    installation,
    host,
    principal,
    grant,
    access,
    registrationIntent,
    registry,
    configurationIntent,
    githubSync,
  }
  return { controlPlane, storageGeneration, seal, tables, storageTables, records }
}

function replaceOnly<K, V>(records: Map<K, V>, replacement: V): true {
  const key = records.keys().next().value
  if (key === undefined) throw new Error('v4 fixture table must contain one record')
  records.set(key, replacement)
  return true
}

function validateV4Fixture(fixture: ReturnType<typeof completeV4Domains>): true {
  validateSakiV4SourceState(
    fixture.controlPlane,
    fixture.storageGeneration,
    fixture.seal.installationId,
    fixture.seal.storageGenerationId,
    fixture.seal.createdByBuildId,
  )
  return true
}

function v4ConfigurationIntent(
  fixture: ReturnType<typeof completeV4Domains>,
  options: {
    readonly id?: string
    readonly projectId?: string
    readonly expectedSynchronizationRevision?: number
    readonly patch?: Readonly<Record<string, unknown>>
    readonly actor?: Readonly<Record<string, unknown>>
    readonly phase?: 'prepared' | 'saved' | 'conflict' | 'failure'
    readonly candidateRevision?: number
    readonly synchronizationRevision?: number
    readonly terminalReason?: 'expected-revision' | 'project-not-found' | 'configuration-incomplete'
      | 'configuration-unchanged' | 'authority'
  } = {},
) {
  const id = options.id ?? CONFIGURATION_INTENT_ID
  const payload = {
    intent: {
      ...fixture.records.configurationIntent.payload.intent,
      intentId: id,
      projectId: options.projectId ?? PROJECT_ID,
      expectedSynchronizationRevision: options.expectedSynchronizationRevision ?? 0,
      patch: options.patch ?? v4GitHubConfiguration(),
    },
    actor: options.actor ?? fixture.records.configurationIntent.payload.actor,
  }
  return sakiControlPlaneV4DomainSpec.tables.github_sync_configuration_intents.valueSchema.parse({
    ...fixture.records.configurationIntent,
    id,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payload,
    payloadDigest: v4CanonicalDigest('saki/configure-github-synchronization/v1', payload),
    phase: options.phase ?? 'prepared',
    candidateRevision: options.candidateRevision,
    synchronizationRevision: options.synchronizationRevision,
    terminalReason: options.terminalReason,
  })
}

function v4ActivePendingSync(
  fixture: ReturnType<typeof completeV4Domains>,
  options: {
    readonly pendingAcceptedIntentId?: string
    readonly pendingReceiptId?: string
    readonly pendingConfiguration?: ReturnType<typeof v4GitHubConfiguration>
    readonly pendingChangedFields?: readonly (typeof V4_GITHUB_CONFIGURATION_FIELDS)[number][]
  } = {},
) {
  const configuration = v4GitHubConfiguration()
  const pendingConfiguration = options.pendingConfiguration ?? {
    ...configuration,
    credentialRef: 'SAKI_GITHUB_ROTATED_PRIVATE_KEY',
  }
  return sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
    ...fixture.records.githubSync,
    revision: 2,
    nextCandidateRevision: 3,
    nextBoardGeneration: 2,
    active: {
      revision: 1,
      configuration,
      acceptedIntentId: CONFIGURATION_INTENT_ID,
      receiptId: CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
      activatedAt: 14,
    },
    pending: {
      revision: 2,
      state: 'saved',
      configuration: pendingConfiguration,
      changedFields: options.pendingChangedFields ?? ['credentialRef'],
      acceptedIntentId: options.pendingAcceptedIntentId ?? SECOND_CONFIGURATION_INTENT_ID,
      receiptId: options.pendingReceiptId
        ?? SECOND_CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
      savedAt: 15,
    },
    confirmedBoard: {
      generation: 1,
      configurationRevision: 1,
      repository: {
        id: configuration.repositoryNodeId,
        nameWithOwner: 'owner/repository',
        url: 'https://github.com/owner/repository',
      },
      project: {
        id: configuration.projectNodeId,
        title: 'Historical board',
        url: 'https://github.com/orgs/owner/projects/1',
      },
      items: [],
    },
    checkpoint: {
      generation: 1,
      configurationRevision: 1,
      attemptId: 'scan-attempt-00000000-0000-4000-8000-000000000010',
      installationId: configuration.githubInstallationId,
      repositoryId: configuration.repositoryNodeId,
      projectId: configuration.projectNodeId,
      statusFieldId: configuration.statusFieldNodeId,
      sourceFingerprint: { version: 1, digest: '5'.repeat(64) },
      observedAt: 14,
      confirmedAt: 14,
      rateLimit: { state: 'unobserved' },
    },
  })
}

describe('frozen Saki control-plane v4 source schemas', () => {
  it('validates a complete v4 generation without reaching current helpers or relationship rules', () => {
    const { controlPlane, storageGeneration, seal } = completeV4Domains()
    expect(() => {
      validateSakiV4SourceState(
        controlPlane,
        storageGeneration,
        seal.installationId,
        seal.storageGenerationId,
        seal.createdByBuildId,
      )
    }).not.toThrow()
  })

  it('retains complete inherited-baseline validation and identity material', () => {
    const missing = { kind: 'missing' as const }
    const object = (mode: '100644' | '100755' | '120000' | '160000', objectId = '1'.repeat(40)) => ({
      kind: 'object' as const,
      mode,
      objectId,
    })
    const regular = {
      kind: 'regular' as const,
      mode: '100644' as const,
      byteLength: 10,
      contentDigest: '2'.repeat(64),
    }
    const entries = [
      v4BaselineEntry({ statusKind: 'tracked', head: object('100644'), index: missing, worktree: regular }),
      v4BaselineEntry({
        statusKind: 'tracked',
        head: missing,
        index: object('160000'),
        worktree: { kind: 'submodule' as const, objectId: '3'.repeat(40) },
      }, '2'.repeat(64)),
      v4BaselineEntry({
        statusKind: 'unmerged',
        head: missing,
        stages: [missing, object('100755'), missing],
        worktree: missing,
      }, '3'.repeat(64)),
      v4BaselineEntry({
        statusKind: 'unmerged',
        head: missing,
        stages: [missing, object('160000'), missing],
        worktree: { kind: 'submodule' as const, objectId: '3'.repeat(40) },
      }, '6'.repeat(64)),
      v4BaselineEntry({
        statusKind: 'untracked',
        worktree: { kind: 'symlink' as const, targetDigest: '4'.repeat(64) },
      }, '4'.repeat(64)),
    ]
    const baseline = v4CompleteBaseline(entries)
    const parsedBaseline = v4Source.v4InheritedChangeBaselineSchema.parse(baseline)
    expect(v4Source.v4InheritedChangeBaselineIdentityMaterial(parsedBaseline)).toEqual({
      kind: 'complete',
      formatVersion: 1,
      bounds: baseline.bounds,
      observed: { ...baseline.observed, elapsedMs: undefined },
      entries,
      digest: baseline.digest,
    })
    const unavailable = {
      kind: 'unavailable' as const,
      reason: 'io-failure' as const,
      observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 9 },
    }
    expect(v4Source.v4InheritedChangeBaselineIdentityMaterial(unavailable)).toEqual({
      kind: 'unavailable',
      reason: 'io-failure',
      observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0 },
    })

    const trackedWithoutObject = v4BaselineEntry({
      statusKind: 'tracked', head: missing, index: missing, worktree: missing,
    })
    const unmergedWithoutObject = v4BaselineEntry({
      statusKind: 'unmerged', head: missing, stages: [missing, missing, missing], worktree: missing,
    })
    const submoduleWithoutGitlink = v4BaselineEntry({
      statusKind: 'tracked',
      head: object('100644'),
      index: missing,
      worktree: { kind: 'submodule', objectId: '5'.repeat(40) },
    })
    const oversizedRegular = v4BaselineEntry({
      statusKind: 'untracked',
      worktree: { ...regular, byteLength: 101 },
    })
    const mixedWidthEntries = [
      entries[0]!,
      v4BaselineEntry({
        statusKind: 'unmerged',
        head: object('100644', '6'.repeat(64)),
        stages: [missing, missing, missing],
        worktree: missing,
      }, '5'.repeat(64)),
    ]
    const invalidBaselines = [
      v4CompleteBaseline([trackedWithoutObject]),
      v4CompleteBaseline([unmergedWithoutObject]),
      v4CompleteBaseline([submoduleWithoutGitlink]),
      v4CompleteBaseline([{ ...entries[0]!, digest: '0'.repeat(64) }]),
      { ...baseline, observed: { ...baseline.observed, entries: 0 } },
      v4CompleteBaseline([entries[0]!, entries[0]!]),
      v4CompleteBaseline([oversizedRegular]),
      { ...v4CompleteBaseline([entries[0]!]), observed: { ...baseline.observed, entries: 1, hashedBytes: 0 } },
      v4CompleteBaseline(mixedWidthEntries),
      { ...baseline, digest: '0'.repeat(64) },
      v4CompleteBaseline([v4BaselineEntry({
        statusKind: 'tracked',
        head: object('100644', '0'.repeat(40)),
        index: missing,
        worktree: missing,
      })]),
      v4CompleteBaseline([v4BaselineEntry({
        statusKind: 'tracked',
        head: object('100644', 'g'.repeat(40)),
        index: missing,
        worktree: missing,
      })]),
      v4CompleteBaseline([v4BaselineEntry({
        statusKind: 'tracked',
        head: object('100644', '1'.repeat(39)),
        index: missing,
        worktree: missing,
      })]),
    ]
    for (const candidate of invalidBaselines) {
      expect(v4Source.v4InheritedChangeBaselineSchema.safeParse(candidate).success).toBe(false)
    }
    expect(v4Source.v4InheritedChangeBaselineSchema.safeParse(v4CompleteBaseline([
      v4BaselineEntry({
        statusKind: 'tracked',
        head: object('100644', '6'.repeat(64)),
        index: missing,
        worktree: missing,
      }),
    ])).success).toBe(true)
  })

  it('retains frozen Host-path, display-location, and Git-ref grammars', () => {
    const pathCases = [
      ['/', true],
      ['/repository', true],
      ['/repository/child', true],
      ['C:\\', true],
      ['C:\\repository', true],
      ['\\\\server\\share', true],
      ['\\\\server\\share\\', true],
      ['', false],
      ['bad\0path', false],
      ['relative', false],
      ['/repository//child', false],
      ['/repository/./child', false],
      ['/repository/../child', false],
      ['C:\\repository/child', false],
      ['C:\\repository\\\\child', false],
      ['C:\\repository\\.\\child', false],
      ['C:\\repository\\..\\child', false],
      ['\\\\server', false],
      ['\\\\?\\volume', false],
      ['\\\\server\\share\\child\\', false],
    ] as const
    for (const [candidate, accepted] of pathCases) {
      expect(v4Source.v4IsAbsoluteHostPath(candidate), candidate).toBe(accepted)
    }

    const displayCases = [
      ['repository', true],
      ['', false],
      ['x'.repeat(v4Source.V4_MAX_DISPLAY_LOCATION_CHARS + 1), false],
      ['bad\nlocation', false],
      ['bad/location', false],
      ['.', false],
      ['..', false],
    ] as const
    for (const [candidate, accepted] of displayCases) {
      expect(v4Source.v4IsSafeDisplayLocation(candidate), candidate).toBe(accepted)
    }

    const branchCases = [
      ['main', true],
      ['', false],
      ['x'.repeat(v4Source.V4_MAX_GIT_REF_CHARS), false],
      ['bad branch', false],
      ['bad[name', false],
      ['@', false],
      ['bad..name', false],
      ['bad@{name', false],
      ['/bad', false],
      ['bad/', false],
      ['bad.', false],
      ['bad//name', false],
      ['.bad', false],
      ['bad.lock', false],
      ['-bad', false],
    ] as const
    for (const [candidate, accepted] of branchCases) {
      expect(v4Source.v4IsSafeGitBranchName(candidate), candidate).toBe(accepted)
    }
    const refCases = [
      ['refs/heads/main', true],
      ['heads/main', false],
      ['refs/main', false],
      ['refs/heads/bad.lock', false],
    ] as const
    for (const [candidate, accepted] of refCases) {
      expect(v4Source.v4IsSafeGitRef(candidate), candidate).toBe(accepted)
    }
  })

  it('retains normalized remote evidence and candidate derivation', () => {
    const remoteCases = [
      [{ transport: 'https', coordinate: 'github.com/owner/repository' }, true],
      [{ transport: 'ssh', coordinate: '[::1]:22/owner/repository' }, true],
      [{ transport: 'other' }, true],
      [{ transport: 'file', coordinate: 'github.com/owner/repository' }, false],
      [{ transport: 'other', coordinate: 'github.com/owner/repository' }, false],
      [{ transport: 'https', coordinate: '' }, false],
      [{ transport: 'https', coordinate: 'x'.repeat(v4Source.V4_MAX_REMOTE_COORDINATE_CHARS + 1) }, false],
      [{ transport: 'https', coordinate: 'github.com/owner/repo name' }, false],
      [{ transport: 'https', coordinate: 'github.com' }, false],
      [{ transport: 'https', coordinate: '/owner/repository' }, false],
      [{ transport: 'https', coordinate: 'github.com/' }, false],
      [{ transport: 'https', coordinate: 'github.com/owner/repository.git' }, false],
      [{ transport: 'https', coordinate: 'github.com:65536/owner/repository' }, false],
      [{ transport: 'https', coordinate: 'bad..host/owner/repository' }, false],
      [{ transport: 'https', coordinate: 'github.com/owner/..' }, false],
      [{ transport: 'https', coordinate: 'github.com/owner/%zz' }, false],
      [{ transport: 'https', coordinate: '[gg]/owner/repository' }, false],
      [{ transport: 'https', coordinate: '[:::]/owner/repository' }, false],
    ] as const
    for (const [candidate, accepted] of remoteCases) {
      expect(v4Source.v4SafeGitRemoteObservationSchema.safeParse(candidate).success).toBe(accepted)
    }

    expect(v4Source.v4SafeGitRemoteObservationKey({ transport: 'other' })).toBe(['other', '0'].join('\0'))
    expect(v4Source.v4SafeGitRemoteObservationKey({
      transport: 'https', coordinate: 'github.com/owner/repository',
    })).toBe(['https', '1github.com/owner/repository'].join('\0'))
    const remotes = [
      { transport: 'https' as const, coordinate: 'github.com/Owner/Repository' },
      { transport: 'ssh' as const, coordinate: 'github.com/owner/repository' },
      { transport: 'ssh' as const, coordinate: 'ssh.github.com:443/OWNER/REPOSITORY' },
      { transport: 'https' as const, coordinate: 'ssh.github.com:443/owner/repository' },
      { transport: 'https' as const, coordinate: 'gitlab.com/owner/repository' },
      { transport: 'https' as const, coordinate: 'github.com/has space/repository' },
      { transport: 'file' as const },
      { transport: 'other' as const, coordinate: 'ignored' },
    ]
    expect(v4Source.v4DeriveGitHubRepositoryCandidates(remotes)).toEqual(['github.com/owner/repository'])
    expect(v4Source.v4CompareSafeGitRemoteObservations(remotes[6]!, remotes[6]!)).toBe(0)
    expect(v4Source.v4CompareSafeGitRemoteObservations(remotes[6]!, remotes[0]!)).toBeLessThan(0)
    expect(v4Source.v4CompareSafeGitRemoteObservations(remotes[0]!, remotes[6]!)).toBeGreaterThan(0)

    expect(v4Source.v4GitHubFailureSchema.safeParse({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: 'status-field',
      missingRequiredStatusOptionIds: ['option', 'option'],
    }).success).toBe(false)
    expect(v4Source.v4GitHubFailureSchema.safeParse({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: 'status-field',
      missingRequiredStatusOptionIds: ['option-a', 'option-b'],
    }).success).toBe(true)
  })

  it('rejects inconsistent frozen generation, Foundation, and Access ownership', () => {
    const cases: readonly {
      readonly name: string
      readonly issue: string
      readonly mutate: (fixture: ReturnType<typeof completeV4Domains>) => void
    }[] = [
      {
        name: 'missing generation seal',
        issue: 'historical Saki v4 storage generation seal is not the required singleton',
        mutate: (fixture) => { fixture.storageTables.storage_generation.clear() },
      },
      {
        name: 'generation seal under another key',
        issue: 'historical Saki v4 storage generation seal is not the required singleton',
        mutate: (fixture) => {
          fixture.storageTables.storage_generation.clear()
          fixture.storageTables.storage_generation.set('other-key' as typeof V4_STORAGE_GENERATION_KEY, fixture.seal)
        },
      },
      {
        name: 'generation seal with different provenance',
        issue: 'historical Saki v4 storage generation seal disagrees with selected generation metadata',
        mutate: fixture => replaceOnly(
          fixture.storageTables.storage_generation,
          storageGenerationV2SealRecordSchema.parse({ ...fixture.seal, createdByBuildId: 'other-build' }),
        ),
      },
      {
        name: 'missing control state',
        issue: 'Saki control state is not the required singleton',
        mutate: (fixture) => { fixture.tables.control_state.clear() },
      },
      {
        name: 'control state under another key',
        issue: 'Saki control state is not the required singleton',
        mutate: (fixture) => {
          fixture.tables.control_state.clear()
          fixture.tables.control_state.set('other-key' as typeof V4_CONTROL_STATE_KEY, fixture.records.control)
        },
      },
      {
        name: 'unfinished provisioning',
        issue: 'Saki control-plane provisioning is not ready',
        mutate: fixture => replaceOnly(
          fixture.tables.control_state,
          sakiControlPlaneV4DomainSpec.tables.control_state.valueSchema.parse({
            ...fixture.records.control,
            phase: 'provisioning',
          }),
        ),
      },
      {
        name: 'control state for another Installation',
        issue: 'Saki control state belongs to another Installation',
        mutate: fixture => replaceOnly(
          fixture.tables.control_state,
          sakiControlPlaneV4DomainSpec.tables.control_state.valueSchema.parse({
            ...fixture.records.control,
            installationId: OTHER_INSTALLATION_ID,
          }),
        ),
      },
      {
        name: 'Installation id disagreeing with its key',
        issue: 'Saki Installation record id disagrees with its table key',
        mutate: (fixture) => {
          fixture.tables.installations.clear()
          fixture.tables.installations.set(
            v4Source.v4InstallationIdSchema.parse(OTHER_INSTALLATION_ID),
            fixture.records.installation,
          )
        },
      },
      {
        name: 'missing selected Installation',
        issue: 'Saki Installation',
        mutate: (fixture) => { fixture.tables.installations.clear() },
      },
      {
        name: 'automation Host Operator',
        issue: 'Saki Host Operator Principal must be human',
        mutate: fixture => replaceOnly(
          fixture.tables.principals,
          sakiControlPlaneV4DomainSpec.tables.principals.valueSchema.parse({
            ...fixture.records.principal,
            kind: 'automation',
          }),
        ),
      },
      {
        name: 'Host from another Installation',
        issue: 'Saki control-plane Foundation relationships are inconsistent',
        mutate: fixture => replaceOnly(
          fixture.tables.hosts,
          sakiControlPlaneV4DomainSpec.tables.hosts.valueSchema.parse({
            ...fixture.records.host,
            installationId: OTHER_INSTALLATION_ID,
          }),
        ),
      },
      {
        name: 'missing Installation Access',
        issue: 'Saki Installation Access is not the required singleton',
        mutate: (fixture) => { fixture.tables.installation_access.clear() },
      },
      {
        name: 'Installation Access under another provisioning owner',
        issue: 'Saki Installation Access belongs to another provisioning owner',
        mutate: (fixture) => {
          const access = sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
            ...fixture.records.access,
            id: OTHER_ACCESS_ID,
          })
          fixture.tables.installation_access.clear()
          fixture.tables.installation_access.set(access.id, access)
        },
      },
      {
        name: 'Installation Access for another Installation',
        issue: 'Saki Installation Access belongs to another provisioning owner',
        mutate: fixture => replaceOnly(
          fixture.tables.installation_access,
          sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
            ...fixture.records.access,
            installationId: OTHER_INSTALLATION_ID,
          }),
        ),
      },
    ]
    for (const testCase of cases) {
      const fixture = completeV4Domains()
      testCase.mutate(fixture)
      expect(() => validateV4Fixture(fixture), testCase.name).toThrow(testCase.issue)
    }
  })

  it('rejects inconsistent frozen Bootstrap Challenge and Browser Session histories', () => {
    const otherInstallation = sakiControlPlaneV4DomainSpec.tables.installations.valueSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'active',
      currentHostId: OTHER_HOST_ID,
    })
    const otherHost = sakiControlPlaneV4DomainSpec.tables.hosts.valueSchema.parse({
      id: OTHER_HOST_ID,
      revision: 0,
      installationId: OTHER_INSTALLATION_ID,
      state: 'enrolled',
    })
    const otherPrincipal = sakiControlPlaneV4DomainSpec.tables.principals.valueSchema.parse({
      id: OTHER_PRINCIPAL_ID,
      revision: 0,
      kind: 'human',
      displayName: 'Other Principal',
      state: 'active',
    })
    const cases: readonly {
      readonly name: string
      readonly issue?: string
      readonly mutate: (fixture: ReturnType<typeof completeV4Domains>) => void
    }[] = [
      {
        name: 'expired Challenge before its expiry',
        issue: 'Saki Installation Access contains an invalid Bootstrap Challenge',
        mutate: (fixture) => {
          const challenge = fixture.records.access.challenges[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              challenges: [{ ...challenge, state: 'expired', terminalAt: challenge.issuedAt,
                browserSessionId: undefined }],
            }))
        },
      },
      {
        name: 'Challenge from another Installation',
        issue: 'Saki Bootstrap Challenge belongs to another Installation',
        mutate: (fixture) => {
          const challenge = fixture.records.access.challenges[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              challenges: [{ ...challenge, installationId: OTHER_INSTALLATION_ID }],
            }))
        },
      },
      {
        name: 'Challenge Host from an unrelated Installation',
        issue: 'Saki Bootstrap Challenge references an unrelated Host',
        mutate: (fixture) => {
          fixture.tables.installations.set(otherInstallation.id, otherInstallation)
          fixture.tables.hosts.set(otherHost.id, otherHost)
          const challenge = fixture.records.access.challenges[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              challenges: [{ ...challenge, hostId: OTHER_HOST_ID }],
            }))
        },
      },
      {
        name: 'terminal Session retaining revision zero',
        issue: 'Saki Installation Access contains an invalid Browser Session',
        mutate: (fixture) => {
          const session = fixture.records.access.sessions[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              sessions: [{ ...session, state: 'expired', terminalAt: session.expiresAt }],
            }))
        },
      },
      {
        name: 'Session terminating before creation',
        issue: 'Saki Installation Access contains an invalid Browser Session',
        mutate: (fixture) => {
          const session = fixture.records.access.sessions[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              sessions: [{ ...session, revision: 1, state: 'revoked', terminalAt: session.createdAt - 1 }],
            }))
        },
      },
      {
        name: 'expired Session terminating before expiry',
        issue: 'Saki Installation Access contains an invalid Browser Session',
        mutate: (fixture) => {
          const session = fixture.records.access.sessions[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              sessions: [{ ...session, revision: 1, state: 'expired', terminalAt: session.createdAt }],
            }))
        },
      },
      {
        name: 'Session from another Installation',
        issue: 'Saki Browser Session belongs to another Installation',
        mutate: (fixture) => {
          const session = fixture.records.access.sessions[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              sessions: [{ ...session, installationId: OTHER_INSTALLATION_ID }],
            }))
        },
      },
      {
        name: 'two Challenges consuming one Session',
        issue: 'Saki multiple Bootstrap Challenges reference one Browser Session',
        mutate: (fixture) => {
          const challenge = fixture.records.access.challenges[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              nextChallengeOrdinal: 2,
              challenges: [challenge, {
                ...challenge,
                id: `${ACCESS_ID}:challenge:1`,
                ordinal: 1,
                purpose: 'local-reauthentication',
                verifierDigest: 'c'.repeat(64),
              }],
            }))
        },
      },
      {
        name: 'consumed Challenge and Session from different generations',
        issue: 'Saki consumed Bootstrap Challenge references an inconsistent Browser Session',
        mutate: (fixture) => {
          const session = fixture.records.access.sessions[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              sessions: [{ ...session, storageGenerationId: OTHER_STORAGE_GENERATION_ID }],
            }))
        },
      },
      {
        name: 'reauthentication before Bootstrap completion',
        issue: 'Saki Installation Access contains reauthentication state before bootstrap completion',
        mutate: (fixture) => {
          const challenge = fixture.records.access.challenges[0]!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              bootstrapCompletion: undefined,
              sessions: [],
              challenges: [{ ...challenge, revision: 0, purpose: 'local-reauthentication', state: 'issued',
                terminalAt: undefined, browserSessionId: undefined }],
            }))
        },
      },
      {
        name: 'empty pre-bootstrap state',
        mutate: fixture => replaceOnly(
          fixture.tables.installation_access,
          sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
            ...fixture.records.access,
            bootstrapCompletion: undefined,
            challenges: [],
            sessions: [],
          }),
        ),
      },
      {
        name: 'completion with another Access prefix',
        issue: 'Saki bootstrap completion references an unallocated entry identity',
        mutate: (fixture) => {
          const completion = fixture.records.access.bootstrapCompletion!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              bootstrapCompletion: { ...completion, challengeId: `${OTHER_ACCESS_ID}:challenge:0` },
            }))
        },
      },
      {
        name: 'completion Host from another Installation',
        issue: 'Saki Installation Access contains an invalid bootstrap completion',
        mutate: (fixture) => {
          fixture.tables.installations.set(otherInstallation.id, otherInstallation)
          fixture.tables.hosts.set(otherHost.id, otherHost)
          const completion = fixture.records.access.bootstrapCompletion!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              bootstrapCompletion: { ...completion, hostId: OTHER_HOST_ID },
            }))
        },
      },
      {
        name: 'completion disagreeing with retained Challenge',
        issue: 'Saki bootstrap completion disagrees with its retained challenge',
        mutate: (fixture) => {
          const completion = fixture.records.access.bootstrapCompletion!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              bootstrapCompletion: { ...completion, completedAt: completion.completedAt + 1 },
            }))
        },
      },
      {
        name: 'completion disagreeing with retained Session',
        issue: 'Saki bootstrap completion disagrees with its retained Browser Session',
        mutate: (fixture) => {
          fixture.tables.principals.set(otherPrincipal.id, otherPrincipal)
          const completion = fixture.records.access.bootstrapCompletion!
          replaceOnly(fixture.tables.installation_access,
            sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.parse({
              ...fixture.records.access,
              nextChallengeOrdinal: 2,
              challenges: [],
              bootstrapCompletion: {
                ...completion,
                challengeId: `${ACCESS_ID}:challenge:1`,
                principalId: OTHER_PRINCIPAL_ID,
              },
            }))
        },
      },
    ]
    for (const testCase of cases) {
      const fixture = completeV4Domains()
      testCase.mutate(fixture)
      if (testCase.issue === undefined) {
        expect(() => validateV4Fixture(fixture), testCase.name).not.toThrow()
      } else {
        expect(() => validateV4Fixture(fixture), testCase.name).toThrow(testCase.issue)
      }
    }
  })

  it('rejects inconsistent frozen Project Registry and registration Intent relationships', () => {
    const confirmedIntent = (fixture: ReturnType<typeof completeV4Domains>, overrides = {}) =>
      sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse({
        ...fixture.records.registrationIntent,
        phase: 'confirmed',
        projectId: PROJECT_ID,
        resourceBindingId: BINDING_ID,
        registryRevision: 1,
        ...overrides,
      })
    const cases: readonly {
      readonly name: string
      readonly issue: string
      readonly mutate: (fixture: ReturnType<typeof completeV4Domains>) => void
    }[] = [
      {
        name: 'missing Project Registry',
        issue: 'historical Saki v4 Project Registry is not the required singleton',
        mutate: (fixture) => { fixture.tables.development_project_registry.clear() },
      },
      {
        name: 'Project Registry under another key',
        issue: 'historical Saki v4 Project Registry is not the required singleton',
        mutate: (fixture) => {
          fixture.tables.development_project_registry.clear()
          fixture.tables.development_project_registry.set(
            'other-key' as typeof V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
            fixture.records.registry,
          )
        },
      },
      {
        name: 'registration Intent under another key',
        issue: 'historical Saki v4 registration Intent id disagrees with its table key',
        mutate: (fixture) => {
          fixture.tables.registration_intents.clear()
          fixture.tables.registration_intents.set(
            v4Source.v4ControlIntentIdSchema.parse(OTHER_INTENT_ID),
            fixture.records.registrationIntent,
          )
        },
      },
      {
        name: 'registration actor with unreachable Grant revision',
        issue: 'Saki registration Intent actor reference is inconsistent',
        mutate: (fixture) => {
          const payload = {
            ...fixture.records.registrationIntent.payload,
            actor: {
              ...fixture.records.registrationIntent.payload.actor,
              grantRevision: fixture.records.grant.revision + 1,
            },
          }
          replaceOnly(
            fixture.tables.registration_intents,
            sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse({
              ...fixture.records.registrationIntent,
              payload,
              payloadDigest: v4CanonicalDigest('saki/register-development-project/v1', payload),
            }),
          )
        },
      },
      {
        name: 'mapping without a retained committed Intent',
        issue: 'has no committed Intent',
        mutate: fixture => replaceOnly(fixture.tables.development_project_registry, {
          ...fixture.records.registry,
          intentMappings: [{
            ...fixture.records.registry.intentMappings[0]!,
            intentId: v4Source.v4ControlIntentIdSchema.parse(OTHER_INTENT_ID),
          }],
        }),
      },
      {
        name: 'mapping with the wrong Registry revision',
        issue: 'disagrees with its mapping',
        mutate: fixture => replaceOnly(fixture.tables.development_project_registry, {
          ...fixture.records.registry,
          intentMappings: [{ ...fixture.records.registry.intentMappings[0]!, registryRevision: 0 }],
        }),
      },
      {
        name: 'confirmed Intent with different committed Binding identity',
        issue: 'disagrees with its mapping',
        mutate: fixture => replaceOnly(
          fixture.tables.registration_intents,
          confirmedIntent(fixture, { resourceBindingId: OTHER_BINDING_ID }),
        ),
      },
      {
        name: 'confirmed Intent without a mapping',
        issue: 'has no mapping',
        mutate: (fixture) => {
          replaceOnly(fixture.tables.registration_intents, confirmedIntent(fixture))
          replaceOnly(fixture.tables.development_project_registry, {
            ...fixture.records.registry,
            intentMappings: [],
          })
        },
      },
      {
        name: 'mapping with a missing Project child',
        issue: 'has incomplete children',
        mutate: fixture => replaceOnly(fixture.tables.development_project_registry, {
          ...fixture.records.registry,
          intentMappings: [{
            ...fixture.records.registry.intentMappings[0]!,
            projectId: v4Source.v4DevelopmentProjectIdSchema.parse(OTHER_PROJECT_ID),
          }],
        }),
      },
      {
        name: 'Binding with different confirmed baseline',
        issue: 'disagrees with its committed children',
        mutate: fixture => replaceOnly(fixture.tables.development_project_registry, {
          ...fixture.records.registry,
          resourceBindings: [{
            ...fixture.records.registry.resourceBindings[0]!,
            inheritedChangeBaseline: {
              kind: 'unavailable',
              reason: 'io-failure',
              observed: {
                entries: 0,
                pathBytes: 0,
                gitOutputBytes: 0,
                hashedBytes: 0,
                elapsedMs: 0,
              },
            },
          }],
        }),
      },
      {
        name: 'workspace-observed Intent with different current inspection',
        issue: 'has invalid initial Binding evidence',
        mutate: fixture => replaceOnly(fixture.tables.development_project_registry, {
          ...fixture.records.registry,
          resourceBindings: [{
            ...fixture.records.registry.resourceBindings[0]!,
            currentInspection: {
              ...fixture.records.registry.resourceBindings[0]!.currentInspection!,
              projection: {
                ...fixture.records.registry.resourceBindings[0]!.currentInspection!.projection,
                displayLocation: 'different-repository',
              },
            },
          }],
        }),
      },
      {
        name: 'confirmed Intent with different current inspection',
        issue: 'disagrees with its initial current inspection',
        mutate: (fixture) => {
          replaceOnly(fixture.tables.registration_intents, confirmedIntent(fixture))
          replaceOnly(fixture.tables.development_project_registry, {
            ...fixture.records.registry,
            resourceBindings: [{
              ...fixture.records.registry.resourceBindings[0]!,
              currentInspection: undefined,
            }],
          })
        },
      },
      {
        name: 'Binding revision beyond the retained Registry history',
        issue: 'has an unreachable Binding revision',
        mutate: (fixture) => {
          replaceOnly(fixture.tables.registration_intents, confirmedIntent(fixture))
          replaceOnly(fixture.tables.development_project_registry, {
            ...fixture.records.registry,
            resourceBindings: [{ ...fixture.records.registry.resourceBindings[0]!, revision: 1 }],
          })
        },
      },
    ]
    for (const testCase of cases) {
      const fixture = completeV4Domains()
      testCase.mutate(fixture)
      expect(() => validateV4Fixture(fixture), testCase.name).toThrow(testCase.issue)
    }
  })

  it('validates frozen GitHub saved and acknowledgement-loss histories', () => {
    for (const secondPhase of ['saved', 'prepared'] as const) {
      const fixture = completeV4Domains()
      const first = v4ConfigurationIntent(fixture, {
        phase: 'saved',
        candidateRevision: 1,
        synchronizationRevision: 1,
      })
      const second = v4ConfigurationIntent(fixture, {
        id: SECOND_CONFIGURATION_INTENT_ID,
        expectedSynchronizationRevision: 1,
        patch: { credentialRef: 'SAKI_GITHUB_ROTATED_PRIVATE_KEY' },
        phase: secondPhase,
        ...(secondPhase === 'saved'
          ? { candidateRevision: 2, synchronizationRevision: 2 }
          : {}),
      })
      fixture.tables.github_sync_configuration_intents.clear()
      fixture.tables.github_sync_configuration_intents.set(first.id, first)
      fixture.tables.github_sync_configuration_intents.set(second.id, second)
      replaceOnly(fixture.tables.github_project_sync, v4ActivePendingSync(fixture))
      expect(() => validateV4Fixture(fixture), secondPhase).not.toThrow()
    }

    const activeOnly = completeV4Domains()
    const first = v4ConfigurationIntent(activeOnly, {
      phase: 'saved',
      candidateRevision: 1,
      synchronizationRevision: 1,
    })
    replaceOnly(activeOnly.tables.github_sync_configuration_intents, first)
    const { pending: _pending, ...withoutPending } = v4ActivePendingSync(activeOnly)
    replaceOnly(
      activeOnly.tables.github_project_sync,
      sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
        ...withoutPending,
        revision: 1,
        nextCandidateRevision: 2,
      }),
    )
    expect(() => validateV4Fixture(activeOnly)).not.toThrow()

    const missingProject = completeV4Domains()
    missingProject.tables.github_project_sync.clear()
    const conflict = v4ConfigurationIntent(missingProject, {
      projectId: OTHER_PROJECT_ID,
      phase: 'conflict',
      terminalReason: 'project-not-found',
    })
    replaceOnly(missingProject.tables.github_sync_configuration_intents, conflict)
    expect(() => validateV4Fixture(missingProject)).not.toThrow()
  })

  it('rejects inconsistent frozen GitHub aggregate and Intent mappings', () => {
    const savedIntent = (fixture: ReturnType<typeof completeV4Domains>, options = {}) =>
      v4ConfigurationIntent(fixture, {
        phase: 'saved',
        candidateRevision: 1,
        synchronizationRevision: 1,
        ...options,
      })
    const cases: readonly {
      readonly name: string
      readonly issue: string
      readonly mutate: (fixture: ReturnType<typeof completeV4Domains>) => void
    }[] = [
      {
        name: 'GitHub sync under another key',
        issue: 'disagrees with its table key',
        mutate: (fixture) => {
          fixture.tables.github_project_sync.clear()
          fixture.tables.github_project_sync.set(
            v4Source.v4DevelopmentProjectIdSchema.parse(OTHER_PROJECT_ID),
            fixture.records.githubSync,
          )
        },
      },
      {
        name: 'GitHub sync for another Installation',
        issue: 'belongs to another Installation',
        mutate: fixture => replaceOnly(
          fixture.tables.github_project_sync,
          sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
            ...fixture.records.githubSync,
            installationId: OTHER_INSTALLATION_ID,
          }),
        ),
      },
      {
        name: 'GitHub sync without a Development Project',
        issue: 'has no Development Project',
        mutate: (fixture) => {
          const sync = sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
            ...fixture.records.githubSync,
            id: OTHER_PROJECT_ID,
          })
          fixture.tables.github_project_sync.clear()
          fixture.tables.github_project_sync.set(sync.id, sync)
        },
      },
      {
        name: 'GitHub Intent under another key',
        issue: 'disagrees with its table key',
        mutate: (fixture) => {
          fixture.tables.github_sync_configuration_intents.clear()
          fixture.tables.github_sync_configuration_intents.set(
            v4Source.v4ControlIntentIdSchema.parse(OTHER_INTENT_ID),
            fixture.records.configurationIntent,
          )
        },
      },
      {
        name: 'Control Intent retained by both registration kinds',
        issue: 'is retained by multiple Intent kinds',
        mutate: (fixture) => {
          const intent = v4ConfigurationIntent(fixture, { id: INTENT_ID })
          fixture.tables.github_sync_configuration_intents.clear()
          fixture.tables.github_sync_configuration_intents.set(intent.id, intent)
        },
      },
      {
        name: 'GitHub Intent for another Installation',
        issue: 'belongs to another Installation',
        mutate: (fixture) => {
          const intent = v4ConfigurationIntent(fixture, {
            actor: { ...fixture.records.configurationIntent.payload.actor, installationId: OTHER_INSTALLATION_ID },
          })
          replaceOnly(fixture.tables.github_sync_configuration_intents, intent)
        },
      },
      {
        name: 'prepared GitHub Intent without a Development Project',
        issue: 'has no Development Project',
        mutate: fixture => replaceOnly(
          fixture.tables.github_sync_configuration_intents,
          v4ConfigurationIntent(fixture, { projectId: OTHER_PROJECT_ID }),
        ),
      },
      {
        name: 'multiple prepared Intents for one Project',
        issue: 'retains multiple prepared Intents',
        mutate: (fixture) => {
          const second = v4ConfigurationIntent(fixture, { id: SECOND_CONFIGURATION_INTENT_ID })
          fixture.tables.github_sync_configuration_intents.set(second.id, second)
        },
      },
      {
        name: 'saved Intent without a sync aggregate',
        issue: 'has no aggregate mapping',
        mutate: (fixture) => {
          fixture.tables.github_project_sync.clear()
          replaceOnly(fixture.tables.github_sync_configuration_intents, savedIntent(fixture))
        },
      },
      {
        name: 'saved Intent beyond the next candidate revision',
        issue: 'has no aggregate mapping',
        mutate: fixture => replaceOnly(
          fixture.tables.github_sync_configuration_intents,
          savedIntent(fixture, { candidateRevision: 2 }),
        ),
      },
      {
        name: 'saved Intent beyond the aggregate revision',
        issue: 'has no aggregate mapping',
        mutate: fixture => replaceOnly(
          fixture.tables.github_sync_configuration_intents,
          savedIntent(fixture, { synchronizationRevision: 2 }),
        ),
      },
      {
        name: 'two candidates accepting one Intent',
        issue: 'has an invalid accepted Intent mapping',
        mutate: fixture => replaceOnly(
          fixture.tables.github_project_sync,
          v4ActivePendingSync(fixture, {
            pendingAcceptedIntentId: CONFIGURATION_INTENT_ID,
            pendingReceiptId: CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
          }),
        ),
      },
      {
        name: 'aggregate revision missing saved history',
        issue: 'has invalid saved Intent revisions',
        mutate: (fixture) => {
          replaceOnly(fixture.tables.github_sync_configuration_intents, savedIntent(fixture))
          replaceOnly(fixture.tables.github_project_sync, v4ActivePendingSync(fixture))
        },
      },
      {
        name: 'prepared commit from the wrong expected revision',
        issue: 'has an invalid accepted Intent mapping',
        mutate: fixture => replaceOnly(
          fixture.tables.github_sync_configuration_intents,
          v4ConfigurationIntent(fixture, { expectedSynchronizationRevision: 1 }),
        ),
      },
      {
        name: 'saved history that cannot resolve a complete configuration',
        issue: 'has invalid saved Intent revisions',
        mutate: fixture => replaceOnly(
          fixture.tables.github_sync_configuration_intents,
          savedIntent(fixture, { patch: { credentialRef: 'ROTATED_KEY' } }),
        ),
      },
      {
        name: 'accepted candidate with different resolved configuration',
        issue: 'has an invalid accepted Intent mapping',
        mutate: (fixture) => {
          replaceOnly(fixture.tables.github_sync_configuration_intents, savedIntent(fixture))
          replaceOnly(fixture.tables.github_project_sync,
            sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.parse({
              ...fixture.records.githubSync,
              pending: {
                ...fixture.records.githubSync.pending!,
                configuration: { ...v4GitHubConfiguration(), credentialRef: 'DIFFERENT_KEY' },
              },
            }))
        },
      },
      {
        name: 'accepted candidate mapped to a terminal Intent',
        issue: 'has an invalid accepted Intent mapping',
        mutate: (fixture) => {
          const first = savedIntent(fixture)
          const second = savedIntent(fixture, {
            id: SECOND_CONFIGURATION_INTENT_ID,
            expectedSynchronizationRevision: 1,
            patch: { credentialRef: 'SAKI_GITHUB_ROTATED_PRIVATE_KEY' },
            candidateRevision: 2,
            synchronizationRevision: 2,
          })
          const terminal = v4ConfigurationIntent(fixture, {
            id: OTHER_INTENT_ID,
            phase: 'conflict',
            terminalReason: 'expected-revision',
          })
          fixture.tables.github_sync_configuration_intents.clear()
          for (const intent of [first, second, terminal]) {
            fixture.tables.github_sync_configuration_intents.set(intent.id, intent)
          }
          replaceOnly(fixture.tables.github_project_sync, v4ActivePendingSync(fixture, {
            pendingAcceptedIntentId: OTHER_INTENT_ID,
            pendingReceiptId: OTHER_INTENT_ID.replace(/^intent-/u, 'receipt-'),
          }))
        },
      },
      {
        name: 'pending candidate with stale changed fields',
        issue: 'has an invalid accepted Intent mapping',
        mutate: (fixture) => {
          const first = savedIntent(fixture)
          const second = v4ConfigurationIntent(fixture, {
            id: SECOND_CONFIGURATION_INTENT_ID,
            expectedSynchronizationRevision: 1,
            patch: { credentialRef: 'SAKI_GITHUB_ROTATED_PRIVATE_KEY' },
          })
          fixture.tables.github_sync_configuration_intents.clear()
          fixture.tables.github_sync_configuration_intents.set(first.id, first)
          fixture.tables.github_sync_configuration_intents.set(second.id, second)
          replaceOnly(fixture.tables.github_project_sync, v4ActivePendingSync(fixture, {
            pendingChangedFields: ['appId'],
          }))
        },
      },
    ]
    for (const testCase of cases) {
      const fixture = completeV4Domains()
      testCase.mutate(fixture)
      expect(() => validateV4Fixture(fixture), testCase.name).toThrow(testCase.issue)
    }
  })

  it('retain the v4 leaf grammars and limits when current exports drift', () => {
    expect(Object.keys(sakiControlPlaneV4DomainSpec.tables).sort()).toEqual([
      'control_state',
      'development_project_registry',
      'github_project_sync',
      'github_sync_configuration_intents',
      'grants',
      'hosts',
      'installation_access',
      'installations',
      'principals',
      'registration_intents',
    ])
    const actor = v4Actor()
    expect(sakiControlPlaneV4DomainSpec.tables.control_state.valueSchema.safeParse({
      schemaVersion: 2,
      revision: 6,
      phase: 'ready',
      installationId: INSTALLATION_ID,
      initialHostId: HOST_ID,
      hostOperatorPrincipalId: PRINCIPAL_ID,
      hostOperatorGrantId: GRANT_ID,
      installationAccessId: ACCESS_ID,
    }).success).toBe(true)
    expect(sakiControlPlaneV4DomainSpec.tables.installations.valueSchema.safeParse({
      id: INSTALLATION_ID,
      revision: 7,
      state: 'active',
      currentHostId: HOST_ID,
    }).success).toBe(true)
    expect(sakiControlPlaneV4DomainSpec.tables.hosts.valueSchema.safeParse({
      id: HOST_ID,
      revision: 2,
      installationId: INSTALLATION_ID,
      state: 'enrolled',
    }).success).toBe(true)
    expect(sakiControlPlaneV4DomainSpec.tables.principals.valueSchema.safeParse({
      id: PRINCIPAL_ID,
      revision: 4,
      kind: 'human',
      displayName: 'Host Operator',
      state: 'active',
    }).success).toBe(true)
    expect(sakiControlPlaneV4DomainSpec.tables.grants.valueSchema.safeParse({
      id: GRANT_ID,
      revision: 5,
      installationId: INSTALLATION_ID,
      principalId: PRINCIPAL_ID,
      state: 'active',
      scope: { kind: 'installation', installationId: INSTALLATION_ID },
      actions: [
        'inspect-project-selection',
        'project-index:read',
        'development-workspace:read',
        'development-project:register',
        'board:read',
        'project-settings:read',
        'github-synchronization:configure',
      ],
    }).success).toBe(true)
    const challengeId = `${ACCESS_ID}:challenge:0`
    const sessionId = `${ACCESS_ID}:session:0`
    expect(sakiControlPlaneV4DomainSpec.tables.installation_access.valueSchema.safeParse({
      id: ACCESS_ID,
      schemaVersion: 2,
      revision: 8,
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
        hostId: HOST_ID,
        principalId: PRINCIPAL_ID,
        verifierDigest: 'a'.repeat(64),
        issuedAt: 10,
        expiresAt: 20,
        state: 'consumed',
        terminalAt: 11,
        browserSessionId: sessionId,
        storageGenerationId: STORAGE_GENERATION_ID,
      }],
      sessions: [{
        id: sessionId,
        ordinal: 0,
        revision: 0,
        installationId: INSTALLATION_ID,
        principalId: PRINCIPAL_ID,
        cookieDigest: 'b'.repeat(64),
        createdAt: 11,
        expiresAt: 21,
        state: 'active',
        storageGenerationId: STORAGE_GENERATION_ID,
      }],
    }).success).toBe(true)

    const inspection = v4InspectionFixture()
    const registryResult = sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
      id: 'development-project-registry',
      schemaVersion: 1,
      revision: 3,
      projects: [{
        id: PROJECT_ID,
        revision: 0,
        projectTitle: 'Historical project',
        resourceBindingId: BINDING_ID,
        state: 'active',
        createdAt: 12,
      }],
      resourceBindings: [{
        id: BINDING_ID,
        revision: 0,
        projectId: PROJECT_ID,
        hostId: HOST_ID,
        workspaceId: WORKSPACE_ID,
        health: 'repair-required',
        registrationInspection: inspection,
        inheritedChangeBaseline: inspection.projection.baseline,
        createdAt: 12,
        observedAt: 12,
      }],
      canonicalWorktreeIndex: [{
        hostId: HOST_ID,
        path: inspection.trusted.canonicalWorktreePath,
        resourceBindingId: BINDING_ID,
      }],
      gitDirectoryIndex: [{
        hostId: HOST_ID,
        path: inspection.trusted.canonicalGitDirectory,
        resourceBindingId: BINDING_ID,
      }],
      intentMappings: [{
        intentId: INTENT_ID,
        projectId: PROJECT_ID,
        resourceBindingId: BINDING_ID,
        registryRevision: 1,
      }],
    })
    expect(registryResult.success ? [] : registryResult.error.issues).toEqual([])

    const registrationPayload = {
      intent: {
        type: 'register-development-project' as const,
        intentId: INTENT_ID,
        projectTitle: 'Historical project',
        hostId: HOST_ID,
        directoryLocator: '/fixture/repository',
        expectedRegistryRevision: 0,
        confirmedFingerprint: inspection.projection.fingerprint,
        confirmedBaseline: inspection.projection.baseline,
      },
      actor,
    }
    expect(sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse({
      id: INTENT_ID,
      schemaVersion: 2,
      revision: 0,
      receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
      payloadDigest: REGISTRATION_PAYLOAD_DIGEST,
      payload: registrationPayload,
      inspection,
      phase: 'prepared',
      createdAt: 12,
      updatedAt: 12,
    }).success).toBe(true)

    const statusOptionNodeIds = v4GitHubConfiguration().statusOptionNodeIds
    expect(githubStatusOptionMappingSchema.safeParse(statusOptionNodeIds).success).toBe(true)
    const githubConfiguration = v4GitHubConfiguration()
    expect(githubSynchronizationConfigurationSchema.safeParse(githubConfiguration).success).toBe(true)

    const configurationPayload = {
      intent: {
        type: 'configure-github-synchronization' as const,
        intentId: CONFIGURATION_INTENT_ID,
        projectId: PROJECT_ID,
        expectedSynchronizationRevision: 0,
        patch: githubConfiguration,
      },
      actor,
    }
    expect(sakiControlPlaneV4DomainSpec.tables.github_sync_configuration_intents.valueSchema.safeParse({
      id: CONFIGURATION_INTENT_ID,
      schemaVersion: 1,
      revision: 0,
      receiptId: CONFIGURATION_INTENT_ID.replace(/^intent-/u, 'receipt-'),
      payloadDigest: GITHUB_PAYLOAD_DIGEST,
      payload: configurationPayload,
      phase: 'prepared',
      createdAt: 12,
      updatedAt: 12,
    }).success).toBe(true)

    expect(sakiGitHubMappingIssueSchema.safeParse({
      reason: 'work-item-status-missing',
      issueId: 'issue-node',
    }).success).toBe(true)
    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'provider',
      failure: { code: 'cancelled' },
    }).success).toBe(true)

    expect(sakiGitHubScanFailureSchema.safeParse({
      kind: 'capacity',
      resource: 'board-work-items',
      limit: 10_000,
      observed: 10_001,
    }).success).toBe(true)

    const repositoryNodeId = githubConfiguration.repositoryNodeId
    const issueNodeId = 'issue-node'
    expect(sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.safeParse({
      id: PROJECT_ID,
      schemaVersion: 1,
      revision: 1,
      installationId: 'installation-00000000-0000-4000-8000-000000000001',
      nextCandidateRevision: 2,
      nextBoardGeneration: 2,
      active: {
        revision: 1,
        configuration: githubConfiguration,
        acceptedIntentId: INTENT_ID,
        receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
        activatedAt: 10,
      },
      confirmedBoard: {
        generation: 1,
        configurationRevision: 1,
        repository: {
          id: repositoryNodeId,
          nameWithOwner: 'owner/repository',
          url: 'https://github.com/owner/repository',
        },
        project: {
          id: githubConfiguration.projectNodeId,
          title: 'Historical board',
          url: 'https://github.com/orgs/owner/projects/1',
        },
        items: [{
          id: `work-item-${WORK_ITEM_DIGEST}`,
          title: 'Historical work item',
          issueNumber: 1,
          url: 'https://github.com/owner/repository/issues/1',
          issueState: 'open',
          status: 'ready',
          order: 0,
          archived: false,
          notInProject: false,
          updatedAt: 10,
          source: {
            kind: 'github-issue',
            repositoryId: repositoryNodeId,
            issueId: issueNodeId,
            projectItemId: 'project-item-node',
            apiOrder: 0,
          },
          remoteFingerprint: `remote-fingerprint-${'6'.repeat(64)}`,
        }],
      },
      checkpoint: {
        generation: 1,
        configurationRevision: 1,
        attemptId: 'scan-attempt-00000000-0000-4000-8000-000000000010',
        installationId: githubConfiguration.githubInstallationId,
        repositoryId: repositoryNodeId,
        projectId: githubConfiguration.projectNodeId,
        statusFieldId: githubConfiguration.statusFieldNodeId,
        sourceFingerprint: { version: 1, digest: '5'.repeat(64) },
        observedAt: 10,
        confirmedAt: 11,
        rateLimit: { state: 'unobserved' },
      },
    }).success).toBe(true)
  })
})
