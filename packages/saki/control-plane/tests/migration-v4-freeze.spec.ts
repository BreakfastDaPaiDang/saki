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
    MAX_GIT_REF_CHARS: 1,
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
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000008'
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000012'
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
  return { controlPlane, storageGeneration, seal }
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
