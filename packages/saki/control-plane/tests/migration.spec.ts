import { describe, expect, it } from 'vitest'
import {
  canonicalDigest,
  compareSafeGitRemoteObservations,
  deriveGitHubRepositoryCandidates,
  exactBytesDigest,
  inheritedChangeBaselineIdentityMaterial,
  sakiControlIntentIdSchema,
} from '@breakfastdapaidang/saki-execution'
import { workspaceIdSchema } from '@deepseek-ai/dsh-workspace'
import {
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
} from '../src/fixtures.ts'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiControlPlaneV8DomainSpec,
} from '../src/migration.ts'
import {
  v4GitHubConfigurationIntentRecordSchema,
  v4GitHubProjectSyncRecordSchema,
} from '../src/migration-v4-github.ts'
import { sakiHostIdSchema, sakiIntentReceiptIdSchema } from '../src/ids.ts'
import { sakiControlPlaneDomainSpec } from '../src/domain-spec.ts'
import {
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  HOST_OPERATOR_ACTIONS,
  V8_HOST_OPERATOR_ACTIONS,
  bindingWriteAdmissionRecordSchema,
  bindingWriteAdmissionV2RecordSchema,
  grantRecordSchema,
  v8GrantRecordSchema,
} from '../src/spec.ts'

const UUID = '00000000-0000-4000-8000-000000000009'
const INSTALLATION_GENERATION_ID = `installation-generation-${UUID}`
const STORAGE_GENERATION_ID = `storage-generation-${UUID}`
const CANDIDATE_STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000099'
const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001'
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002'
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000003'
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000004'
const OTHER_GRANT_ID = 'grant-00000000-0000-4000-8000-000000000104'
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000005'
const INTENT_ID = SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000006'
const AGENT_PROFILE_ID = 'agent-profile-00000000-0000-4000-8000-000000000006'
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000007'
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000008'
const ASSIGNMENT_ID = 'assignment-00000000-0000-4000-8000-000000000010'
const WORK_SESSION_ID = 'work-session-00000000-0000-4000-8000-000000000011'
const AGENT_RUN_ID = 'agent-run-00000000-0000-4000-8000-000000000012'
const AGENT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000013'

function historicalSnapshot(detached = false) {
  const actor = {
    installationId: INSTALLATION_ID,
    installationGenerationId: INSTALLATION_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
  }
  const current = SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection
  if (current.head.kind !== 'commit') throw new Error('historical fixture requires a committed HEAD')
  const trusted = {
    canonicalWorktreePath: '/fixture/repository',
    canonicalGitDirectory: '/fixture/repository/.git',
    canonicalCommonGitDirectory: '/fixture/repository/.git',
    gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
    comparison: { fileMode: true, symlinks: true, autocrlf: false },
  }
  const { fingerprint: _fingerprint, observationVersion: _version, head: _head, ...retained } = current
  const historicalProjectionWithoutFingerprint = {
    ...retained,
    observationVersion: 1 as const,
    head: current.head.objectId,
    ...(detached || current.head.symbolicRef === undefined
      ? { detached: true }
      : { branch: current.head.symbolicRef.slice('refs/heads/'.length), detached: false }),
  }
  const material = {
    observationVersion: 1,
    hostId: historicalProjectionWithoutFingerprint.hostId,
    displayLocation: historicalProjectionWithoutFingerprint.displayLocation,
    worktreePathDigest: exactBytesDigest('saki/worktree-path/v1', new TextEncoder().encode(trusted.canonicalWorktreePath)),
    gitDirectoryDigest: exactBytesDigest('saki/git-directory/v1', new TextEncoder().encode(trusted.canonicalGitDirectory)),
    commonDirectoryDigest: exactBytesDigest('saki/common-git-directory/v1', new TextEncoder().encode(trusted.canonicalCommonGitDirectory)),
    gitDirectoryIdentity: trusted.gitDirectoryIdentity,
    commonGitDirectoryIdentity: trusted.commonGitDirectoryIdentity,
    objectFormat: historicalProjectionWithoutFingerprint.objectFormat,
    head: historicalProjectionWithoutFingerprint.head,
    ...('branch' in historicalProjectionWithoutFingerprint
      ? { branch: `refs/heads/${historicalProjectionWithoutFingerprint.branch}` } : {}),
    detached: historicalProjectionWithoutFingerprint.detached,
    locked: historicalProjectionWithoutFingerprint.locked,
    inheritedChangeEntryCount: historicalProjectionWithoutFingerprint.inheritedChangeEntryCount,
    conversionAmbiguous: historicalProjectionWithoutFingerprint.conversionAmbiguous,
    comparison: trusted.comparison,
    workspace: historicalProjectionWithoutFingerprint.workspaceId === undefined
      ? { kind: 'absent' } : { kind: 'present', workspaceId: historicalProjectionWithoutFingerprint.workspaceId },
    ...(historicalProjectionWithoutFingerprint.upstream === undefined
      ? {} : { upstream: historicalProjectionWithoutFingerprint.upstream }),
    remotes: historicalProjectionWithoutFingerprint.remotes,
    ...(historicalProjectionWithoutFingerprint.githubRepositoryCandidates === undefined
      ? {} : { githubRepositoryCandidates: historicalProjectionWithoutFingerprint.githubRepositoryCandidates }),
    baseline: inheritedChangeBaselineIdentityMaterial(historicalProjectionWithoutFingerprint.baseline),
  }
  const fingerprint = { version: 1 as const, digest: canonicalDigest('saki/project-inspection/v1', material) }
  const historicalProjection = { ...historicalProjectionWithoutFingerprint, fingerprint }
  const workspaceFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/project-inspection/v1', {
      ...material,
      workspace: { kind: 'present', workspaceId: WORKSPACE_ID },
    }),
  }
  const workspaceInspection = {
    projection: { ...historicalProjectionWithoutFingerprint, workspaceId: WORKSPACE_ID, fingerprint: workspaceFingerprint },
    trusted,
  }
  const historicalIntent = { ...SAKI_PROJECT_REQUEST_FIXTURES.registration, confirmedFingerprint: fingerprint }
  const payload = { intent: historicalIntent, actor }
  const inspection = {
    projection: historicalProjection,
    trusted,
  }
  return {
    global: null,
    tables: {
      control_state: {
        'control-state': {
          schemaVersion: 1,
          revision: 6,
          phase: 'ready',
          installationId: INSTALLATION_ID,
          initialInstallationGenerationId: INSTALLATION_GENERATION_ID,
          initialHostId: HOST_ID,
          hostOperatorPrincipalId: PRINCIPAL_ID,
          hostOperatorGrantId: GRANT_ID,
          installationAccessId: ACCESS_ID,
        },
      },
      installations: {
        [INSTALLATION_ID]: {
          id: INSTALLATION_ID,
          revision: 7,
          state: 'active',
          currentInstallationGenerationId: INSTALLATION_GENERATION_ID,
          currentHostId: HOST_ID,
        },
      },
      hosts: {
        [HOST_ID]: {
          id: HOST_ID,
          revision: 2,
          installationId: INSTALLATION_ID,
          state: 'enrolled',
        },
      },
      principals: {
        [PRINCIPAL_ID]: {
          id: PRINCIPAL_ID,
          revision: 4,
          kind: 'human',
          displayName: 'Host Operator',
          state: 'active',
        },
      },
      grants: {
        [GRANT_ID]: {
          id: GRANT_ID,
          revision: 5,
          installationId: INSTALLATION_ID,
          principalId: PRINCIPAL_ID,
          state: 'active',
          actions: ['development-project:register'],
          scope: { kind: 'installation', installationId: INSTALLATION_ID },
        },
      },
      installation_access: {
        [ACCESS_ID]: {
          id: ACCESS_ID,
          schemaVersion: 1,
          revision: 8,
          installationId: INSTALLATION_ID,
          nextChallengeOrdinal: 1,
          nextSessionOrdinal: 1,
          requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
          challenges: [{
            id: `${ACCESS_ID}:challenge:0`,
            ordinal: 0,
            revision: 1,
            purpose: 'initial-bootstrap',
            installationId: INSTALLATION_ID,
            installationGenerationId: INSTALLATION_GENERATION_ID,
            hostId: HOST_ID,
            principalId: PRINCIPAL_ID,
            verifierDigest: 'a'.repeat(64),
            issuedAt: 10,
            expiresAt: 20,
            state: 'consumed',
            terminalAt: 11,
            browserSessionId: `${ACCESS_ID}:session:0`,
          }],
          sessions: [{
            id: `${ACCESS_ID}:session:0`,
            ordinal: 0,
            revision: 0,
            installationId: INSTALLATION_ID,
            installationGenerationId: INSTALLATION_GENERATION_ID,
            principalId: PRINCIPAL_ID,
            cookieDigest: 'b'.repeat(64),
            createdAt: 11,
            expiresAt: 21,
            state: 'active',
          }],
        },
      },
      development_project_registry: {
        'development-project-registry': {
          id: 'development-project-registry',
          schemaVersion: 1,
          revision: 3,
          projects: [{ id: PROJECT_ID, revision: 0, projectTitle: 'Historical project', resourceBindingId: BINDING_ID,
            state: 'active', createdAt: 12 }],
          resourceBindings: [{
            id: BINDING_ID, revision: 0, projectId: PROJECT_ID, hostId: HOST_ID, workspaceId: WORKSPACE_ID,
            health: 'active', registrationInspection: inspection, currentInspection: workspaceInspection,
            inheritedChangeBaseline: historicalProjection.baseline, createdAt: 12, observedAt: 12,
          }],
          canonicalWorktreeIndex: [{ hostId: HOST_ID, path: trusted.canonicalWorktreePath, resourceBindingId: BINDING_ID }],
          gitDirectoryIndex: [{ hostId: HOST_ID, path: trusted.canonicalGitDirectory, resourceBindingId: BINDING_ID }],
          intentMappings: [{ intentId: INTENT_ID, projectId: PROJECT_ID, resourceBindingId: BINDING_ID, registryRevision: 1 }],
        },
      },
      registration_intents: {
        [INTENT_ID]: {
          id: INTENT_ID,
          schemaVersion: 1,
          revision: 9,
          receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          payload,
          inspection,
          workspaceInspection,
          phase: 'confirmed',
          workspaceId: WORKSPACE_ID,
          projectId: PROJECT_ID,
          resourceBindingId: BINDING_ID,
          registryRevision: 1,
          createdAt: 12,
          updatedAt: 13,
        },
      },
    },
  }
}

function parsedHistoricalTables(source: ReturnType<typeof historicalSnapshot>) {
  return Object.fromEntries(Object.entries(sakiControlPlaneV2DomainSpec.tables).map(
    ([table, spec]) => [
      table,
      Object.fromEntries(Object.entries(source.tables[table as keyof typeof source.tables]).map(
        ([key, value]) => [key, spec.valueSchema.parse(value)],
      )),
    ],
  ))
}

function migratedV4Snapshot(detached = false) {
  const source = historicalSnapshot(detached)
  const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
    global: null,
    tables: parsedHistoricalTables(source),
  })
  return sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
}

function parsedV4Records(detached = false) {
  const snapshot = migratedV4Snapshot(detached)
  const registry = sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.parse(
    snapshot.tables['development_project_registry']!['development-project-registry'],
  )
  const intent = sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse(
    snapshot.tables['registration_intents']![INTENT_ID],
  )
  return { intent, registry, snapshot }
}

type V4Intent = ReturnType<
  typeof sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse
>
type V4Projection = V4Intent['inspection']['projection']
type V4CompleteBaseline = Extract<V4Projection['baseline'], { readonly kind: 'complete' }>
type V4UnmergedStages = Extract<
  V4CompleteBaseline['entries'][number],
  { readonly statusKind: 'unmerged' }
>['stages']

function withInspectionProjection(intent: V4Intent, projection: V4Projection): V4Intent {
  return { ...intent, inspection: { ...intent.inspection, projection } }
}

function signedEntry<T extends object>(material: T): T & { readonly digest: string } {
  return { ...material, digest: canonicalDigest('saki/inherited-entry/v1', material) }
}

function signedBaseline<T extends {
  readonly formatVersion: 1
  readonly bounds: object
  readonly observed: { readonly elapsedMs: number }
  readonly entries: readonly object[]
}>(material: T): T & { readonly digest: string } {
  return {
    ...material,
    digest: canonicalDigest('saki/inherited-baseline/v1', {
      formatVersion: material.formatVersion,
      bounds: material.bounds,
      observed: { ...material.observed, elapsedMs: 0 },
      entries: material.entries,
    }),
  }
}

type SchemaParseResult =
  | { readonly success: true }
  | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } }

function expectSchemaIssue(result: SchemaParseResult, message: string, variant: string): void {
  if (result.success) throw new Error(`${variant} unexpectedly passed the frozen v4 schema`)
  expect(result.error.issues.map(issue => issue.message), variant).toContain(message)
}

function v5GitHubSyncRecord() {
  const repositoryId = 'R_saki_migration_repository'
  const projectNodeId = 'PVT_saki_migration_project'
  const statusFieldId = 'PVTSSF_saki_migration_status'
  const configuration = {
    appId: '12345',
    githubInstallationId: '12345678',
    accountNodeId: 'O_saki_migration_account',
    repositoryNodeId: repositoryId,
    repositoryDatabaseId: '87654321',
    projectNodeId,
    credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
    statusFieldNodeId: statusFieldId,
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
  }
  const item = (number: number, status: 'ready' | 'done') => {
    const issueId = `I_saki_migration_issue_${number}`
    return {
      id: `work-item-${canonicalDigest('saki/board-work-item/v1', { repositoryId, issueId })}`,
      title: `Migration Issue ${number}`,
      issueNumber: number,
      url: `https://github.example.invalid/saki/issues/${number}`,
      issueState: status === 'done' ? 'closed' as const : 'open' as const,
      status,
      order: number - 1,
      archived: false,
      notInProject: false,
      updatedAt: 10,
      source: {
        kind: 'github-issue' as const,
        repositoryId,
        issueId,
        projectItemId: `PVTI_saki_migration_item_${number}`,
        apiOrder: number - 1,
      },
      remoteFingerprint: `remote-fingerprint-${String(number).repeat(64)}`,
    }
  }
  return v4GitHubProjectSyncRecordSchema.parse({
    id: PROJECT_ID,
    schemaVersion: 1,
    revision: 1,
    installationId: INSTALLATION_ID,
    nextCandidateRevision: 2,
    nextBoardGeneration: 2,
    active: {
      revision: 1,
      configuration,
      acceptedIntentId: INTENT_ID,
      receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
      activatedAt: 12,
    },
    confirmedBoard: {
      generation: 1,
      configurationRevision: 1,
      repository: {
        id: repositoryId,
        nameWithOwner: 'BreakfastDaPaiDang/saki',
        url: 'https://github.example.invalid/BreakfastDaPaiDang/saki',
      },
      project: {
        id: projectNodeId,
        title: 'Saki',
        url: 'https://github.example.invalid/orgs/BreakfastDaPaiDang/projects/1',
      },
      items: [item(1, 'ready'), item(2, 'done')],
    },
    checkpoint: {
      generation: 1,
      configurationRevision: 1,
      attemptId: 'scan-attempt-00000000-0000-4000-8000-000000000001',
      installationId: configuration.githubInstallationId,
      repositoryId,
      projectId: projectNodeId,
      statusFieldId,
      sourceFingerprint: { version: 1, digest: '3'.repeat(64) },
      observedAt: 10,
      confirmedAt: 11,
      rateLimit: { state: 'unobserved' },
    },
  })
}

describe('Saki control-plane retained migrations', () => {
  it('keeps v8 exact while current v9 adds only the four Delivery tables', () => {
    expect(sakiControlPlaneV8DomainSpec.version).toBe(8)
    expect(sakiControlPlaneDomainSpec.version).toBe(9)
    expect(Object.keys(sakiControlPlaneDomainSpec.tables).sort()).toEqual([
      ...Object.keys(sakiControlPlaneV8DomainSpec.tables),
      'branch_deliveries',
      'branch_delivery_intents',
      'milestone_deliveries',
      'milestone_delivery_intents',
    ].sort())
  })

  it('keeps v8 Grants exact while current Grants admit the eight Delivery actions', () => {
    const deliveryActions = [
      'branch-delivery:save',
      'branch-delivery:push',
      'branch-delivery:pull-request:create',
      'branch-delivery:pull-request:associate',
      'branch-delivery:review',
      'branch-delivery:accept',
      'milestone-delivery:save',
      'milestone-delivery:finalize',
    ] as const
    expect(HOST_OPERATOR_ACTIONS).toEqual([...V8_HOST_OPERATOR_ACTIONS, ...deliveryActions])
    const v8Grant = {
      id: GRANT_ID,
      revision: 1,
      installationId: INSTALLATION_ID,
      principalId: PRINCIPAL_ID,
      state: 'active' as const,
      scope: { kind: 'installation' as const, installationId: INSTALLATION_ID },
      actions: [...V8_HOST_OPERATOR_ACTIONS],
    }
    expect(v8GrantRecordSchema.parse(v8Grant)).toEqual(v8Grant)
    expect(v8GrantRecordSchema.safeParse({ ...v8Grant, actions: [...v8Grant.actions, ...deliveryActions] }).success)
      .toBe(false)
    expect(grantRecordSchema.parse({ ...v8Grant, actions: [...v8Grant.actions, ...deliveryActions] }).actions)
      .toEqual([...v8Grant.actions, ...deliveryActions])
  })

  it('keeps v8 write admissions exact while current state admits Branch Push ownership', () => {
    const pushAdmission = {
      id: BINDING_ID,
      schemaVersion: 1 as const,
      revision: 2,
      state: 'manual-host-operation' as const,
      phase: 'reserved' as const,
      bindingRevision: 7,
      source: {
        kind: 'control-intent' as const,
        intentId: AGENT_INTENT_ID,
        intentRevision: 3,
        payloadDigest: 'a'.repeat(64),
      },
      action: 'project-branch:push' as const,
      reservedAt: 10,
      updatedAt: 10,
    }

    expect(bindingWriteAdmissionV2RecordSchema.safeParse(pushAdmission).success).toBe(false)
    expect(bindingWriteAdmissionRecordSchema.parse(pushAdmission)).toEqual(pushAdmission)
  })

  it('migrates v8 to v9 by granting Delivery actions and creating only empty Delivery tables', () => {
    const source = historicalSnapshot()
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4)
    const v6 = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5)
    const v7 = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6)
    const v8 = sakiControlPlaneMigrationPlan.steps[5]!.migrate(v7)
    const v8Grant = sakiControlPlaneV8DomainSpec.tables.grants.valueSchema.parse(v8.tables['grants']![GRANT_ID])
    const retainedGrant = sakiControlPlaneV8DomainSpec.tables.grants.valueSchema.parse({
      ...v8Grant,
      id: OTHER_GRANT_ID,
      revision: 41,
    })
    v8.tables['grants']![OTHER_GRANT_ID] = retainedGrant

    const migrated = sakiControlPlaneMigrationPlan.steps[6]!.migrate(v8)

    expect(sakiControlPlaneMigrationPlan.current).toMatchObject({ name: 'saki_control_plane', version: 9 })
    expect(sakiControlPlaneMigrationPlan.steps[6]).toMatchObject({
      from: { name: 'saki_control_plane', version: 8 },
      to: { name: 'saki_control_plane', version: 9 },
    })
    expect(migrated.tables).toMatchObject({
      branch_deliveries: {},
      branch_delivery_intents: {},
      milestone_deliveries: {},
      milestone_delivery_intents: {},
    })
    expect(sakiControlPlaneDomainSpec.tables.grants.valueSchema.parse(
      migrated.tables['grants']![GRANT_ID],
    )).toEqual({
      ...v8Grant,
      revision: v8Grant.revision + 1,
      actions: [...HOST_OPERATOR_ACTIONS],
    })
    expect(migrated.tables['grants']![OTHER_GRANT_ID]).toEqual(retainedGrant)
    for (const [table, spec] of Object.entries(sakiControlPlaneDomainSpec.tables)) {
      for (const value of Object.values(migrated.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
  })

  it('adds empty Work Item state and upgrades only the Host Operator across the adjacent v5-to-v6 step', () => {
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(historicalSnapshot()),
    })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4)
    const operatorGrant = sakiControlPlaneV5DomainSpec.tables.grants.valueSchema.parse(
      v5.tables['grants']![GRANT_ID],
    )
    const retainedGrant = sakiControlPlaneV5DomainSpec.tables.grants.valueSchema.parse({
      ...operatorGrant,
      id: OTHER_GRANT_ID,
      revision: 2,
    })
    const v5Sync = v5GitHubSyncRecord()

    const v6 = sakiControlPlaneMigrationPlan.steps[3]!.migrate({
      ...v5,
      tables: {
        ...v5.tables,
        grants: { ...v5.tables['grants'], [OTHER_GRANT_ID]: retainedGrant },
        github_project_sync: { [PROJECT_ID]: v5Sync },
      },
    })
    const activeSync = v5Sync.active
    if (activeSync === undefined) throw new Error('activated v5 synchronization fixture is missing')
    const neverScannedSync = v4GitHubProjectSyncRecordSchema.parse({
      id: PROJECT_ID,
      schemaVersion: 1,
      revision: 1,
      installationId: INSTALLATION_ID,
      nextCandidateRevision: 2,
      nextBoardGeneration: 1,
      pending: {
        revision: 1,
        state: 'saved',
        configuration: activeSync.configuration,
        changedFields: ['credentialRef'],
        acceptedIntentId: activeSync.acceptedIntentId,
        receiptId: activeSync.receiptId,
        savedAt: activeSync.activatedAt,
      },
    })
    const v6WithoutBoard = sakiControlPlaneMigrationPlan.steps[3]!.migrate({
      ...v5,
      tables: {
        ...v5.tables,
        github_project_sync: { [PROJECT_ID]: neverScannedSync },
      },
    })

    expect(sakiControlPlaneV5DomainSpec.version).toBe(5)
    expect(sakiControlPlaneV6DomainSpec.version).toBe(6)
    expect(sakiControlPlaneV7DomainSpec.version).toBe(7)
    expect(sakiControlPlaneV8DomainSpec.version).toBe(8)
    expect(sakiControlPlaneDomainSpec.version).toBe(9)
    expect(sakiControlPlaneMigrationPlan.steps[3]).toMatchObject({
      from: { name: 'saki_control_plane', version: 5 },
      to: { name: 'saki_control_plane', version: 6 },
    })
    expect(v6.tables['github_work_item_intents']).toEqual({})
    expect(v6.tables['github_work_item_recovery']).toEqual({})
    expect(v6.tables['github_project_sync']![PROJECT_ID]).toMatchObject({
      schemaVersion: 2,
      confirmedBoard: {
        items: [
          { status: 'ready', latestNonTerminalStatus: 'ready' },
          { status: 'done', latestNonTerminalStatus: null },
        ],
      },
    })
    const migratedNeverScannedSync = v6WithoutBoard.tables['github_project_sync']![PROJECT_ID]
    expect(migratedNeverScannedSync).toMatchObject({ schemaVersion: 2 })
    expect(migratedNeverScannedSync).not.toHaveProperty('confirmedBoard')
    expect(sakiControlPlaneDomainSpec.tables.github_project_sync.valueSchema.parse(migratedNeverScannedSync))
      .toEqual(migratedNeverScannedSync)
    expect(sakiControlPlaneV5DomainSpec.tables.github_project_sync.valueSchema.safeParse(v5Sync).success).toBe(true)
    expect(sakiControlPlaneV5DomainSpec.tables.github_project_sync.valueSchema.safeParse(
      v6.tables['github_project_sync']![PROJECT_ID],
    ).success).toBe(false)
    expect(sakiControlPlaneDomainSpec.tables.github_project_sync.valueSchema.safeParse(v5Sync).success).toBe(false)
    expect(v6.tables['grants']![OTHER_GRANT_ID]).toEqual(retainedGrant)
    expect(v6.tables['grants']![GRANT_ID]).toEqual({
      ...operatorGrant,
      revision: operatorGrant.revision + 1,
      actions: [...operatorGrant.actions, 'work-item:create', 'work-item:move'],
    })
    expect(sakiControlPlaneV5DomainSpec.tables.grants.valueSchema.safeParse(
      v6.tables['grants']![GRANT_ID],
    ).success).toBe(false)
    expect(sakiControlPlaneV5DomainSpec.tables.grants.valueSchema.safeParse({
      ...operatorGrant,
      futureCurrentAction: true,
    }).success).toBe(false)
    expect(sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6).tables['grants']![OTHER_GRANT_ID])
      .toEqual(retainedGrant)
    for (const [table, spec] of Object.entries(sakiControlPlaneV6DomainSpec.tables)) {
      for (const value of Object.values(v6.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
  })

  it('moves generation ownership out of the Foundation while preserving the source UUID in retained references', () => {
    const source = historicalSnapshot()
    const migrated = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })

    expect(migrated.tables['control_state']!['control-state']).toEqual({
      schemaVersion: 2,
      revision: 6,
      phase: 'ready',
      installationId: INSTALLATION_ID,
      initialHostId: HOST_ID,
      hostOperatorPrincipalId: PRINCIPAL_ID,
      hostOperatorGrantId: GRANT_ID,
      installationAccessId: ACCESS_ID,
    })
    expect(migrated.tables['installations']![INSTALLATION_ID]).toEqual({
      id: INSTALLATION_ID,
      revision: 7,
      state: 'active',
      currentHostId: HOST_ID,
    })
    expect(migrated.tables['installation_access']![ACCESS_ID]).toMatchObject({
      schemaVersion: 2,
      revision: 8,
      bootstrapCompletion: {
        challengeId: `${ACCESS_ID}:challenge:0`,
        sessionId: `${ACCESS_ID}:session:0`,
        hostId: HOST_ID,
        principalId: PRINCIPAL_ID,
        completedAt: 11,
      },
      challenges: [{ storageGenerationId: STORAGE_GENERATION_ID }],
      sessions: [{ storageGenerationId: STORAGE_GENERATION_ID }],
    })
    const migratedIntent = migrated.tables['registration_intents']![INTENT_ID] as {
      schemaVersion: number
      payload: { actor: { storageGenerationId: string } }
      payloadDigest: string
    }
    expect(migratedIntent).toMatchObject({
      schemaVersion: 2,
      revision: 9,
      payload: { actor: { storageGenerationId: STORAGE_GENERATION_ID } },
    })
    expect(migratedIntent.payloadDigest).toBe(canonicalDigest(
      'saki/register-development-project/v1',
      migratedIntent.payload,
    ))
    expect(migrated.tables['hosts']).toEqual(source.tables.hosts)
    expect(migrated.tables['principals']).toEqual(source.tables.principals)
    expect(migrated.tables['grants']).toEqual(source.tables.grants)
    expect(migrated.tables['development_project_registry']).toEqual(source.tables.development_project_registry)
    expect(migrated.global).toBeNull()
    for (const [table, spec] of Object.entries(sakiControlPlaneV3DomainSpec.tables)) {
      for (const value of Object.values(migrated.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
    expect(JSON.stringify(migrated)).not.toContain('installationGenerationId')
    expect(JSON.stringify(migrated)).not.toContain('initialInstallationGenerationId')
    expect(JSON.stringify(migrated)).not.toContain('currentInstallationGenerationId')
    expect(JSON.stringify(migrated)).not.toContain(CANDIDATE_STORAGE_GENERATION_ID)
  })

  it('rejects ambiguous B03 bootstrap evidence instead of selecting an arbitrary pair', () => {
    const source = historicalSnapshot()
    const access = source.tables.installation_access[ACCESS_ID]
    access.nextChallengeOrdinal = 2
    access.nextSessionOrdinal = 2
    access.challenges.push({
      ...access.challenges[0]!,
      id: `${ACCESS_ID}:challenge:1`,
      ordinal: 1,
      verifierDigest: 'c'.repeat(64),
      browserSessionId: `${ACCESS_ID}:session:1`,
    })
    access.sessions.push({
      ...access.sessions[0]!,
      id: `${ACCESS_ID}:session:1`,
      ordinal: 1,
      cookieDigest: 'd'.repeat(64),
    })

    expect(() => {
      sakiControlPlaneMigrationPlan.steps[0]!.migrate({
        global: null,
        tables: parsedHistoricalTables(source),
      })
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('rejects incomplete B03 consumed-challenge completion evidence', () => {
    const source = historicalSnapshot()
    const access = source.tables.installation_access[ACCESS_ID]
    const { browserSessionId: _browserSessionId, ...incompleteChallenge } = access.challenges[0]!
    const tables = parsedHistoricalTables(source)

    expect(() => {
      sakiControlPlaneMigrationPlan.steps[0]!.migrate({
        global: null,
        tables: {
          ...tables,
          installation_access: {
            [ACCESS_ID]: sakiControlPlaneV2DomainSpec.tables.installation_access.valueSchema.parse({
              ...access,
              challenges: [incompleteChallenge],
            }),
          },
        },
      })
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('rejects B03 completion evidence whose Browser Session is absent', () => {
    const source = historicalSnapshot()
    source.tables.installation_access[ACCESS_ID].sessions = []

    expect(() => {
      sakiControlPlaneMigrationPlan.steps[0]!.migrate({
        global: null,
        tables: parsedHistoricalTables(source),
      })
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('keeps completion absent for exact B03 state before initial bootstrap', () => {
    const source = historicalSnapshot()
    const access = source.tables.installation_access[ACCESS_ID]
    access.nextChallengeOrdinal = 0
    access.nextSessionOrdinal = 0
    access.challenges = []
    access.sessions = []
    const migrated = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })

    expect(migrated.tables['installation_access']![ACCESS_ID]).not.toHaveProperty('bootstrapCompletion')
  })

  it('retains an exact B03 bootstrap completion instead of reconstructing it', () => {
    const source = historicalSnapshot()
    const completion = {
      challengeId: `${ACCESS_ID}:challenge:0`,
      sessionId: `${ACCESS_ID}:session:0`,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      completedAt: 11,
    }
    Reflect.set(source.tables.installation_access[ACCESS_ID], 'bootstrapCompletion', completion)

    const migrated = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })

    expect(migrated.tables['installation_access']![ACCESS_ID]).toMatchObject({
      bootstrapCompletion: completion,
    })
  })

  it('rejects missing B03 completion evidence after a Browser Session was allocated', () => {
    const source = historicalSnapshot()
    const access = source.tables.installation_access[ACCESS_ID]
    access.nextChallengeOrdinal = 0
    access.challenges = []
    access.sessions = []

    expect(() => {
      sakiControlPlaneMigrationPlan.steps[0]!.migrate({
        global: null,
        tables: parsedHistoricalTables(source),
      })
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('declares strict adjacent v2 through current v9 steps and keeps historical action vocabularies frozen', () => {
    expect(sakiControlPlaneV2DomainSpec.version).toBe(2)
    expect(sakiControlPlaneV3DomainSpec.version).toBe(3)
    expect(sakiControlPlaneV4DomainSpec.version).toBe(4)
    expect(sakiControlPlaneV5DomainSpec.version).toBe(5)
    expect(sakiControlPlaneV6DomainSpec.version).toBe(6)
    expect(sakiControlPlaneV7DomainSpec.version).toBe(7)
    expect(sakiControlPlaneV8DomainSpec.version).toBe(8)
    expect(sakiControlPlaneDomainSpec.version).toBe(9)
    expect(sakiControlPlaneMigrationPlan.steps).toHaveLength(7)
    expect(sakiControlPlaneMigrationPlan.steps[0]).toMatchObject({
      from: { name: 'saki_control_plane', version: 2 },
      to: { name: 'saki_control_plane', version: 3 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[1]).toMatchObject({
      from: { name: 'saki_control_plane', version: 3 },
      to: { name: 'saki_control_plane', version: 4 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[2]).toMatchObject({
      from: { name: 'saki_control_plane', version: 4 },
      to: { name: 'saki_control_plane', version: 5 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[3]).toMatchObject({
      from: { name: 'saki_control_plane', version: 5 },
      to: { name: 'saki_control_plane', version: 6 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[4]).toMatchObject({
      from: { name: 'saki_control_plane', version: 6 },
      to: { name: 'saki_control_plane', version: 7 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[5]).toMatchObject({
      from: { name: 'saki_control_plane', version: 7 },
      to: { name: 'saki_control_plane', version: 8 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[6]).toMatchObject({
      from: { name: 'saki_control_plane', version: 8 },
      to: { name: 'saki_control_plane', version: 9 },
    })
    expect(Object.keys(sakiControlPlaneV2DomainSpec.tables).sort()).toEqual(
      Object.keys(sakiControlPlaneV3DomainSpec.tables).sort(),
    )
    expect(Object.keys(sakiControlPlaneV5DomainSpec.tables).sort()).toEqual([
      ...Object.keys(sakiControlPlaneV3DomainSpec.tables),
      'github_project_sync',
      'github_sync_configuration_intents',
      'git_operation_intents',
      'binding_write_admissions',
    ].sort())
    expect(Object.keys(sakiControlPlaneV6DomainSpec.tables).sort()).toEqual([
      ...Object.keys(sakiControlPlaneV5DomainSpec.tables),
      'github_work_item_intents',
      'github_work_item_recovery',
    ].sort())
    expect(Object.keys(sakiControlPlaneV7DomainSpec.tables).sort())
      .toEqual([
        ...Object.keys(sakiControlPlaneV6DomainSpec.tables),
        'agent_operation_intents',
        'work_assignments',
        'work_sessions',
        'agent_runs',
        'execution_dispatches',
      ].sort())
    expect(Object.keys(sakiControlPlaneV8DomainSpec.tables).sort())
      .toEqual([...Object.keys(sakiControlPlaneV7DomainSpec.tables), 'intervention_requests'].sort())
    expect(Object.keys(sakiControlPlaneDomainSpec.tables).sort())
      .toEqual([
        ...Object.keys(sakiControlPlaneV8DomainSpec.tables),
        'branch_deliveries',
        'branch_delivery_intents',
        'milestone_deliveries',
        'milestone_delivery_intents',
      ].sort())

    const source = historicalSnapshot()
    const historicalControl = source.tables.control_state['control-state']
    expect(sakiControlPlaneV2DomainSpec.tables.control_state.valueSchema.safeParse({
      ...historicalControl,
      unexpected: true,
    }).success).toBe(false)
    expect(sakiControlPlaneV3DomainSpec.tables.control_state.valueSchema.safeParse(historicalControl).success).toBe(false)
    expect(sakiControlPlaneV2DomainSpec.tables.control_state.valueSchema.safeParse({
      ...historicalControl,
      schemaVersion: 2,
    }).success).toBe(false)

    const historicalAccess = source.tables.installation_access[ACCESS_ID]
    expect(sakiControlPlaneV2DomainSpec.tables.installation_access.valueSchema.safeParse({
      ...historicalAccess,
      schemaVersion: 2,
    }).success).toBe(false)

    const historicalIntent = source.tables.registration_intents[INTENT_ID]!
    expect(sakiControlPlaneV2DomainSpec.tables.registration_intents.valueSchema.safeParse({
      ...historicalIntent,
      schemaVersion: 2,
    }).success).toBe(false)

    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    expect(v4.tables['github_project_sync']).toEqual({})
    expect(v4.tables['github_sync_configuration_intents']).toEqual({})
    expect(v4.tables['grants']![GRANT_ID]).toMatchObject({
      revision: 6,
      actions: [
        'inspect-project-selection',
        'project-index:read',
        'development-workspace:read',
        'development-project:register',
        'board:read',
        'project-settings:read',
        'github-synchronization:configure',
      ],
    })
    expect(sakiControlPlaneV3DomainSpec.tables.grants.valueSchema.safeParse(
      v4.tables['grants']![GRANT_ID],
    ).success).toBe(false)
    const v4Registry = v4.tables['development_project_registry']!['development-project-registry']
    expect(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse(v4Registry).success)
      .toBe(true)
    expect(sakiControlPlaneDomainSpec.tables.development_project_registry.valueSchema.safeParse(v4Registry).success)
      .toBe(false)
    for (const [table, spec] of Object.entries(sakiControlPlaneV4DomainSpec.tables)) {
      for (const value of Object.values(v4.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4)
    const migratedRegistry = sakiControlPlaneV5DomainSpec.tables.development_project_registry.valueSchema.parse(
      v5.tables['development_project_registry']!['development-project-registry'],
    )
    expect(migratedRegistry.resourceBindings[0]?.registrationInspection.projection.head).toMatchObject({
      kind: 'commit', symbolicRef: 'refs/heads/main',
    })
    const migratedIntent = sakiControlPlaneV5DomainSpec.tables.registration_intents.valueSchema.parse(
      v5.tables['registration_intents']![INTENT_ID],
    )
    expect(migratedIntent.payload.intent.confirmedFingerprint).toEqual(
      migratedIntent.inspection.projection.fingerprint,
    )
    expect(migratedIntent.payloadDigest).toBe(canonicalDigest(
      'saki/register-development-project/v1', migratedIntent.payload,
    ))
    expect(v5.tables['git_operation_intents']).toEqual({})
    expect(v5.tables['binding_write_admissions']).toEqual({
      [BINDING_ID]: {
        id: BINDING_ID,
        schemaVersion: 1,
        revision: 0,
        state: 'available',
        updatedAt: migratedRegistry.resourceBindings[0]!.observedAt,
      },
    })
    const migratedGrant = sakiControlPlaneV5DomainSpec.tables.grants.valueSchema.parse(
      v5.tables['grants']![GRANT_ID],
    )
    expect(migratedGrant).toMatchObject({ revision: 7 })
    expect(migratedGrant.actions).toEqual([
      'inspect-project-selection',
      'project-index:read',
      'development-workspace:read',
      'development-project:register',
      'board:read',
      'project-settings:read',
      'github-synchronization:configure',
      'project-changes:read',
      'project-diff:read',
      'project-changes:stage',
      'project-changes:unstage',
      'project-commit:create',
    ])
    expect(sakiControlPlaneV4DomainSpec.tables.grants.valueSchema.safeParse(
      v5.tables['grants']![GRANT_ID],
    ).success).toBe(false)
    for (const [table, spec] of Object.entries(sakiControlPlaneV5DomainSpec.tables)) {
      for (const value of Object.values(v5.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
    const v6 = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5)
    expect(v6.tables['github_work_item_intents']).toEqual({})
    expect(v6.tables['github_work_item_recovery']).toEqual({})
    expect(sakiControlPlaneV6DomainSpec.tables.grants.valueSchema.parse(
      v6.tables['grants']![GRANT_ID],
    ).actions).toEqual([...migratedGrant.actions, 'work-item:create', 'work-item:move'])
    for (const [table, spec] of Object.entries(sakiControlPlaneV6DomainSpec.tables)) {
      for (const value of Object.values(v6.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
    const v7 = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6)
    expect(v7.tables).toMatchObject({
      agent_operation_intents: {},
      work_assignments: {},
      work_sessions: {},
      agent_runs: {},
      execution_dispatches: {},
    })
    const v7Grant = sakiControlPlaneV7DomainSpec.tables.grants.valueSchema.parse(
      v7.tables['grants']![GRANT_ID],
    )
    expect(v7Grant).toMatchObject({
      revision: migratedGrant.revision + 2,
      actions: [...migratedGrant.actions, 'work-item:create', 'work-item:move', 'work-item:give-to-agent'],
    })
    for (const [table, spec] of Object.entries(sakiControlPlaneV7DomainSpec.tables)) {
      for (const value of Object.values(v7.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
    const otherGrant = sakiControlPlaneV7DomainSpec.tables.grants.valueSchema.parse({
      ...v7Grant,
      id: OTHER_GRANT_ID,
      revision: 41,
    })
    v7.tables['grants']![OTHER_GRANT_ID] = otherGrant
    const v8 = sakiControlPlaneMigrationPlan.steps[5]!.migrate(v7)
    expect(v8.tables['intervention_requests']).toEqual({})
    expect(v8.tables['grants']![OTHER_GRANT_ID]).toEqual(otherGrant)
    expect(sakiControlPlaneV8DomainSpec.tables.grants.valueSchema.parse(
      v8.tables['grants']![GRANT_ID],
    )).toMatchObject({
      revision: migratedGrant.revision + 3,
      actions: [
        ...migratedGrant.actions,
        'work-item:create',
        'work-item:move',
        'work-item:give-to-agent',
        'my-work:read',
        'attention:read',
        'intervention:answer',
      ],
    })
    for (const [table, spec] of Object.entries(sakiControlPlaneV8DomainSpec.tables)) {
      for (const value of Object.values(v8.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
  })

  it('derives each v8 Assignment owner from its exact v7 Agent operation Intent', () => {
    const assignment = {
      id: ASSIGNMENT_ID,
      schemaVersion: 1,
      revision: 2,
      intentId: AGENT_INTENT_ID,
      projectId: PROJECT_ID,
      workItemId: `work-item-${'a'.repeat(64)}`,
      primaryWorkSessionId: WORK_SESSION_ID,
      agentRunId: AGENT_RUN_ID,
      state: 'active',
      createdAt: 10,
      updatedAt: 11,
    }
    const run = {
      id: AGENT_RUN_ID,
      schemaVersion: 1,
      revision: 3,
    }
    const ownerLink = {
      assignmentId: ASSIGNMENT_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      projectContext: { projectId: PROJECT_ID },
      payload: {
        actor: { principalId: PRINCIPAL_ID },
        intent: { workItemId: assignment.workItemId },
      },
    }
    const source = {
      global: null,
      tables: {
        control_state: {},
        grants: {},
        agent_operation_intents: { [AGENT_INTENT_ID]: ownerLink },
        work_assignments: { [ASSIGNMENT_ID]: assignment },
        agent_runs: { [AGENT_RUN_ID]: run },
      },
    }
    const migrated = sakiControlPlaneMigrationPlan.steps[5]!.migrate(source)

    expect(migrated.tables['work_assignments']![ASSIGNMENT_ID]).toEqual({
      ...assignment,
      schemaVersion: 2,
      ownerPrincipalId: PRINCIPAL_ID,
    })
    expect(migrated.tables['agent_runs']![AGENT_RUN_ID]).toEqual({ ...run, schemaVersion: 2 })
    expect(migrated.tables['intervention_requests']).toEqual({})

    expect(() => sakiControlPlaneMigrationPlan.steps[5]!.migrate({
      ...source,
      tables: { ...source.tables, agent_operation_intents: {} },
    })).toThrow(`v7 Work Assignment '${ASSIGNMENT_ID}' lacks its exact Agent operation owner`)
    expect(() => sakiControlPlaneMigrationPlan.steps[5]!.migrate({
      ...source,
      tables: {
        ...source.tables,
        agent_operation_intents: {
          [AGENT_INTENT_ID]: { ...ownerLink, agentRunId: 'agent-run-ffffffff-ffff-4fff-8fff-ffffffffffff' },
        },
      },
    })).toThrow(`v7 Work Assignment '${ASSIGNMENT_ID}' lacks its exact Agent operation owner`)
  })

  it('adds one deterministic unavailable default Agent Profile to every migrated v6 Project', () => {
    const source = historicalSnapshot()
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4)
    const v6 = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5)
    const v7 = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6)

    const registry = sakiControlPlaneDomainSpec.tables.development_project_registry.valueSchema.parse(
      v7.tables['development_project_registry']!['development-project-registry'],
    )
    expect(registry).toMatchObject({
      schemaVersion: 2,
      projects: [{ id: PROJECT_ID, defaultAgentProfileId: AGENT_PROFILE_ID }],
      agentProfiles: [{
        id: AGENT_PROFILE_ID,
        projectId: PROJECT_ID,
        version: 1,
        agentPresetId: 'standard',
        modelRouteRequest: null,
        createdAt: 12,
      }],
    })
  })

  it('retains a non-Host-Operator Grant unchanged during the v3-to-v4 migration', () => {
    const source = historicalSnapshot()
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({
      global: null,
      tables: parsedHistoricalTables(source),
    })
    const operatorGrant = sakiControlPlaneV3DomainSpec.tables.grants.valueSchema.parse(
      v3.tables['grants']![GRANT_ID],
    )
    const retainedGrant = sakiControlPlaneV3DomainSpec.tables.grants.valueSchema.parse({
      ...operatorGrant,
      id: OTHER_GRANT_ID,
      revision: 2,
    })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate({
      ...v3,
      tables: {
        ...v3.tables,
        grants: {
          ...v3.tables['grants'],
          [OTHER_GRANT_ID]: retainedGrant,
        },
      },
    })

    expect(v4.tables['grants']![OTHER_GRANT_ID]).toEqual(retainedGrant)
  })

  it('upgrades only the current Host Operator Grant during the v4-to-v5 migration', () => {
    const source = historicalSnapshot()
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({ global: null, tables: parsedHistoricalTables(source) })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const operatorGrant = sakiControlPlaneV4DomainSpec.tables.grants.valueSchema.parse(v4.tables['grants']![GRANT_ID])
    const retainedGrant = sakiControlPlaneV4DomainSpec.tables.grants.valueSchema.parse({
      ...operatorGrant,
      id: OTHER_GRANT_ID,
      revision: 2,
    })
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate({
      ...v4,
      tables: { ...v4.tables, grants: { ...v4.tables['grants'], [OTHER_GRANT_ID]: retainedGrant } },
    })
    expect(v5.tables['grants']![OTHER_GRANT_ID]).toEqual(retainedGrant)
    expect(v5.tables['grants']![GRANT_ID]).toMatchObject({ revision: operatorGrant.revision + 1 })
  })

  it('migrates a detached v4 inspection without inventing a symbolic ref', () => {
    const source = historicalSnapshot(true)
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({ global: null, tables: parsedHistoricalTables(source) })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const v5 = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4)
    const registry = sakiControlPlaneV5DomainSpec.tables.development_project_registry.valueSchema.parse(
      v5.tables['development_project_registry']!['development-project-registry'],
    )
    expect(registry.resourceBindings[0]?.registrationInspection.projection.head).toEqual({
      kind: 'commit', objectId: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.head.kind === 'commit'
        ? SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.head.objectId : 'unreachable',
    })
  })

  it('rejects inconsistent frozen v4 Project selection evidence', () => {
    const { intent } = parsedV4Records()
    const base = intent.inspection.projection
    if (base.baseline.kind !== 'complete') throw new Error('v4 fixture requires a complete inherited baseline')
    const regular = {
      kind: 'regular' as const,
      mode: '100644' as const,
      byteLength: 1,
      contentDigest: '2'.repeat(64),
    }
    const tracked = signedEntry({
      formatVersion: 1 as const,
      pathDigest: '7'.repeat(64),
      statusKind: 'tracked' as const,
      head: { kind: 'object' as const, mode: '100644' as const, objectId: '4'.repeat(40) },
      index: { kind: 'missing' as const },
      worktree: regular,
    })
    const unmerged = signedEntry({
      formatVersion: 1 as const,
      pathDigest: '8'.repeat(64),
      statusKind: 'unmerged' as const,
      head: { kind: 'missing' as const },
      stages: [
        { kind: 'object' as const, mode: '160000' as const, objectId: '5'.repeat(40) },
        { kind: 'missing' as const },
        { kind: 'missing' as const },
      ] satisfies V4UnmergedStages,
      worktree: { kind: 'submodule' as const, objectId: '6'.repeat(40) },
    })
    const untracked = signedEntry({
      formatVersion: 1 as const,
      pathDigest: '9'.repeat(64),
      statusKind: 'untracked' as const,
      worktree: regular,
    })
    const populatedBaseline = signedBaseline({
      ...base.baseline,
      observed: { ...base.baseline.observed, entries: 3, pathBytes: 3, hashedBytes: 2 },
      entries: [tracked, unmerged, untracked],
    })
    const unavailableBaseline = {
      kind: 'unavailable' as const,
      reason: 'io-failure' as const,
      observed: { ...base.baseline.observed, entries: 0 },
    }
    const remoteType = base.remotes[0]
    if (remoteType === undefined) throw new Error('v4 fixture requires a remote observation')
    const orderedRemotes = [
      remoteType,
      { transport: 'https' as const, coordinate: 'github.com/example/saki' },
    ].sort(compareSafeGitRemoteObservations)
    const githubRemotes = [{ transport: 'https' as const, coordinate: 'github.com/example/saki' }]
    const githubCandidates = deriveGitHubRepositoryCandidates(githubRemotes)
    if (githubCandidates.length !== 1) throw new Error('GitHub fixture did not produce one repository candidate')

    const projectionVariants: readonly {
      readonly name: string
      readonly projection: V4Projection
      readonly issue: string
    }[] = [
      {
        name: 'attached projection without a branch',
        projection: { ...base, branch: undefined, detached: false },
        issue: 'branch and detached state disagree',
      },
      {
        name: 'detached projection with an upstream',
        projection: { ...base, branch: undefined, detached: true, upstream: 'refs/remotes/origin/main' },
        issue: 'upstream requires an attached branch',
      },
      {
        name: 'SHA-256 projection with a SHA-1 HEAD',
        projection: { ...base, objectFormat: 'sha256', head: '3'.repeat(40) },
        issue: 'HEAD does not match object format',
      },
      {
        name: 'projection count that differs from its baseline',
        projection: { ...base, inheritedChangeEntryCount: 1 },
        issue: 'inherited-change count disagrees with baseline observations',
      },
      {
        name: 'SHA-256 projection with SHA-1 baseline objects',
        projection: {
          ...base,
          objectFormat: 'sha256',
          head: '3'.repeat(64),
          baseline: populatedBaseline,
          inheritedChangeEntryCount: 3,
          automaticMutationEligible: false,
          blockingReasons: ['dirty'],
        },
        issue: 'baseline object does not match object format',
      },
      {
        name: 'projection baseline that differs from the confirmed baseline',
        projection: {
          ...base,
          baseline: unavailableBaseline,
          automaticMutationEligible: false,
          blockingReasons: ['baseline-unavailable'],
        },
        issue: 'Intent confirmation disagrees with retained inspection',
      },
      {
        name: 'coherent conversion evidence with a stale fingerprint',
        projection: {
          ...base,
          conversionAmbiguous: true,
          automaticMutationEligible: false,
          blockingReasons: ['conversion-ambiguous'],
        },
        issue: 'inspection fingerprint disagrees with retained evidence',
      },
      {
        name: 'eligible locked projection',
        projection: { ...base, locked: true, automaticMutationEligible: true, blockingReasons: ['locked'] },
        issue: 'automatic mutation eligibility disagrees with blocking evidence',
      },
      {
        name: 'locked projection without a blocker',
        projection: { ...base, locked: true, automaticMutationEligible: false, blockingReasons: [] },
        issue: 'automatic mutation eligibility disagrees with blocking evidence',
      },
      {
        name: 'locked projection with the wrong blocker',
        projection: {
          ...base,
          locked: true,
          automaticMutationEligible: false,
          blockingReasons: ['conversion-ambiguous'],
        },
        issue: 'automatic mutation eligibility disagrees with blocking evidence',
      },
      {
        name: 'projection with duplicate remotes',
        projection: { ...base, remotes: [remoteType, remoteType] },
        issue: 'remote observations are not unique and canonical',
      },
      {
        name: 'projection with noncanonical remote order',
        projection: { ...base, remotes: [...orderedRemotes].reverse() },
        issue: 'remote observations are not unique and canonical',
      },
      {
        name: 'empty GitHub candidates without GitHub remotes',
        projection: { ...base, githubRepositoryCandidates: [] },
        issue: 'GitHub repository candidates disagree with remote observations',
      },
      {
        name: 'absent GitHub candidates for a GitHub remote',
        projection: { ...base, remotes: githubRemotes, githubRepositoryCandidates: undefined },
        issue: 'GitHub repository candidates disagree with remote observations',
      },
      {
        name: 'empty GitHub candidates for a GitHub remote',
        projection: { ...base, remotes: githubRemotes, githubRepositoryCandidates: [] },
        issue: 'GitHub repository candidates disagree with remote observations',
      },
      {
        name: 'wrong GitHub candidate for a GitHub remote',
        projection: { ...base, remotes: githubRemotes, githubRepositoryCandidates: ['example/other'] },
        issue: 'GitHub repository candidates disagree with remote observations',
      },
      {
        name: 'coherent GitHub evidence with a stale fingerprint',
        projection: { ...base, remotes: githubRemotes, githubRepositoryCandidates: githubCandidates },
        issue: 'inspection fingerprint disagrees with retained evidence',
      },
    ]
    for (const variant of projectionVariants) {
      expectSchemaIssue(sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse(
        withInspectionProjection(intent, variant.projection),
      ), variant.issue, variant.name)
    }
  })

  it('rejects inconsistent frozen v4 Project Registry evidence', () => {
    const { registry } = parsedV4Records()
    const binding = registry.resourceBindings[0]
    const project = registry.projects[0]
    const mapping = registry.intentMappings[0]
    if (binding === undefined || project === undefined || mapping === undefined) {
      throw new Error('v4 fixture requires one complete Project mapping')
    }
    if (binding.inheritedChangeBaseline.kind !== 'complete') {
      throw new Error('v4 fixture requires a complete inherited baseline')
    }
    const unavailableBaseline = {
      kind: 'unavailable' as const,
      reason: 'io-failure' as const,
      observed: { ...binding.inheritedChangeBaseline.observed, entries: 0 },
    }
    const otherHostId = 'host-00000000-0000-4000-8000-000000000102'
    const otherBindingId = 'binding-00000000-0000-4000-8000-000000000107'
    const otherProjectId = 'project-00000000-0000-4000-8000-000000000106'
    const currentInspection = binding.currentInspection
    if (currentInspection === undefined) throw new Error('v4 fixture requires a current inspection')

    const bindingVariants = [
      {
        name: 'binding observation before creation',
        candidate: { ...binding, observedAt: binding.createdAt - 1 },
        issue: 'binding observation predates creation',
      },
      {
        name: 'registration inspection from another Host',
        candidate: {
          ...binding,
          registrationInspection: {
            ...binding.registrationInspection,
            projection: { ...binding.registrationInspection.projection, hostId: otherHostId },
          },
        },
        issue: 'binding inspection belongs to another Host',
      },
      {
        name: 'binding baseline that differs from registration',
        candidate: { ...binding, inheritedChangeBaseline: unavailableBaseline },
        issue: 'binding inherited baseline differs from registration evidence',
      },
      {
        name: 'active binding without a current inspection',
        candidate: { ...binding, currentInspection: undefined },
        issue: 'active binding has no current inspection',
      },
      {
        name: 'missing binding with a current inspection',
        candidate: { ...binding, health: 'missing' as const },
        issue: 'missing binding retains a current inspection',
      },
      {
        name: 'current inspection for another Workspace',
        candidate: {
          ...binding,
          currentInspection: {
            ...currentInspection,
            projection: {
              ...currentInspection.projection,
              workspaceId: 'workspace-00000000-0000-4000-8000-000000000108',
            },
          },
        },
        issue: 'binding current inspection disagrees with Workspace identity',
      },
      {
        name: 'current inspection with changed resource identity',
        candidate: {
          ...binding,
          currentInspection: {
            ...currentInspection,
            trusted: { ...currentInspection.trusted, canonicalWorktreePath: '/fixture/other-repository' },
          },
        },
        issue: 'binding current inspection changed resource identity',
      },
    ] as const
    for (const variant of bindingVariants) {
      expectSchemaIssue(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
        ...registry,
        resourceBindings: [variant.candidate],
      }), variant.issue, variant.name)
    }

    const registryVariants = [
      {
        name: 'duplicate Project identity',
        candidate: { ...registry, projects: [project, project] },
        issue: 'Project Registry repeats an owned identity',
      },
      {
        name: 'missing worktree index entry',
        candidate: { ...registry, canonicalWorktreeIndex: [] },
        issue: 'Project Registry child and index cardinalities disagree',
      },
      {
        name: 'Project pointing at an absent Resource Binding',
        candidate: { ...registry, projects: [{ ...project, resourceBindingId: otherBindingId }] },
        issue: 'Project has an inconsistent Resource Binding',
      },
      {
        name: 'worktree index with the wrong path',
        candidate: {
          ...registry,
          canonicalWorktreeIndex: [{ ...registry.canonicalWorktreeIndex[0]!, path: '/fixture/elsewhere' }],
        },
        issue: 'Resource Binding has inconsistent path indices',
      },
      {
        name: 'Intent mapping to an absent Project',
        candidate: { ...registry, intentMappings: [{ ...mapping, projectId: otherProjectId }] },
        issue: 'registration Intent maps to inconsistent children',
      },
      {
        name: 'Intent mapping beyond the Registry revision',
        candidate: { ...registry, intentMappings: [{ ...mapping, registryRevision: registry.revision + 1 }] },
        issue: 'registration Intent maps to inconsistent children',
      },
    ] as const
    for (const variant of registryVariants) {
      expectSchemaIssue(
        sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse(variant.candidate),
        variant.issue,
        variant.name,
      )
    }
  })

  it('rejects inconsistent frozen v4 registration Intent evidence', () => {
    const { intent } = parsedV4Records()
    const detachedWorkspaceInspection = parsedV4Records(true).intent.workspaceInspection
    if (intent.workspaceInspection === undefined || detachedWorkspaceInspection === undefined) {
      throw new Error('v4 fixture requires retained Workspace inspections')
    }
    const otherWorkspaceId = workspaceIdSchema.parse('workspace-00000000-0000-4000-8000-000000000108')
    const otherHostId = sakiHostIdSchema.parse('host-00000000-0000-4000-8000-000000000102')
    const otherIntentId = sakiControlIntentIdSchema.parse('intent-00000000-0000-4000-8000-000000000109')
    const otherReceiptId = sakiIntentReceiptIdSchema.parse('receipt-00000000-0000-4000-8000-000000000109')
    const unavailableBaseline = intent.payload.intent.confirmedBaseline.kind === 'complete'
      ? {
        kind: 'unavailable' as const,
        reason: 'io-failure' as const,
        observed: { ...intent.payload.intent.confirmedBaseline.observed, entries: 0 },
      }
      : intent.payload.intent.confirmedBaseline
    const { workspaceId: _workspaceId, ...withoutWorkspaceId } = intent
    const { resourceBindingId: _resourceBindingId, ...partialCommit } = intent
    const {
      workspaceId: _observedWorkspaceId,
      workspaceInspection: _observedWorkspaceInspection,
      projectId: _observedProjectId,
      resourceBindingId: _observedBindingId,
      registryRevision: _observedRegistryRevision,
      ...withoutWorkspaceEvidence
    } = intent
    const { workspaceInspection: _committedInspection, ...committedWithoutInspection } = intent
    const {
      workspaceId: _conflictWorkspaceId,
      workspaceInspection: _conflictWorkspaceInspection,
      projectId: _conflictProjectId,
      resourceBindingId: _conflictBindingId,
      registryRevision: _conflictRegistryRevision,
      ...terminalWithoutWorkspace
    } = intent

    const variants: readonly {
      readonly name: string
      readonly candidate: V4Intent
      readonly issue: string
    }[] = [
      {
        name: 'Intent and receipt identities that differ from the payload',
        candidate: { ...intent, id: otherIntentId, receiptId: otherReceiptId },
        issue: 'Intent identity disagrees with immutable payload',
      },
      {
        name: 'receipt identity that differs from the Intent',
        candidate: { ...intent, receiptId: otherReceiptId },
        issue: 'Intent identity disagrees with immutable payload',
      },
      {
        name: 'confirmed fingerprint that differs from the retained inspection',
        candidate: {
          ...intent,
          payload: {
            ...intent.payload,
            intent: {
              ...intent.payload.intent,
              confirmedFingerprint: { ...intent.payload.intent.confirmedFingerprint, digest: '0'.repeat(64) },
            },
          },
        },
        issue: 'Intent confirmation disagrees with retained inspection',
      },
      {
        name: 'Actor Host that differs from the confirmed Host',
        candidate: {
          ...intent,
          payload: {
            ...intent.payload,
            actor: { ...intent.payload.actor, hostId: otherHostId },
          },
        },
        issue: 'Intent confirmation disagrees with retained inspection',
      },
      {
        name: 'confirmed baseline that differs from the retained inspection',
        candidate: {
          ...intent,
          payload: {
            ...intent.payload,
            intent: { ...intent.payload.intent, confirmedBaseline: unavailableBaseline },
          },
        },
        issue: 'Intent confirmation disagrees with retained inspection',
      },
      {
        name: 'Intent update before creation',
        candidate: { ...intent, updatedAt: intent.createdAt - 1 },
        issue: 'Intent update predates creation',
      },
      {
        name: 'terminal phase without a terminal reason',
        candidate: { ...intent, phase: 'conflict', terminalReason: undefined },
        issue: 'Intent terminal reason disagrees with phase',
      },
      {
        name: 'nonterminal phase with a terminal reason',
        candidate: { ...intent, phase: 'prepared', terminalReason: 'authority' },
        issue: 'Intent terminal reason disagrees with phase',
      },
      {
        name: 'Workspace inspection without a Workspace identity',
        candidate: withoutWorkspaceId,
        issue: 'Workspace inspection has no retained identity',
      },
      {
        name: 'Workspace observation from another Host',
        candidate: {
          ...intent,
          workspaceInspection: {
            ...intent.workspaceInspection,
            projection: { ...intent.workspaceInspection.projection, hostId: otherHostId },
          },
        },
        issue: 'Workspace observation disagrees with retained identity',
      },
      {
        name: 'workspace-dispatching phase with later evidence',
        candidate: { ...intent, phase: 'workspace-dispatching' },
        issue: 'early Intent phase contains later-phase evidence',
      },
      {
        name: 'Workspace observation with another Workspace identity',
        candidate: {
          ...intent,
          workspaceInspection: {
            ...intent.workspaceInspection,
            projection: { ...intent.workspaceInspection.projection, workspaceId: otherWorkspaceId },
          },
        },
        issue: 'Workspace observation disagrees with retained identity',
      },
      {
        name: 'registration observation with another Workspace identity',
        candidate: {
          ...intent,
          inspection: {
            ...intent.inspection,
            projection: { ...intent.inspection.projection, workspaceId: otherWorkspaceId },
          },
        },
        issue: 'Workspace observation disagrees with retained identity',
      },
      {
        name: 'Workspace observation with changed repository evidence',
        candidate: { ...intent, workspaceInspection: detachedWorkspaceInspection },
        issue: 'Workspace observation changed repository evidence',
      },
      {
        name: 'partial Registry commit evidence',
        candidate: partialCommit,
        issue: 'registry commit fields must appear together',
      },
      {
        name: 'prepared phase with complete later evidence',
        candidate: { ...intent, phase: 'prepared' },
        issue: 'early Intent phase contains later-phase evidence',
      },
      {
        name: 'prepared phase with Registry evidence but no Workspace identity',
        candidate: { ...withoutWorkspaceId, phase: 'prepared' },
        issue: 'early Intent phase contains later-phase evidence',
      },
      {
        name: 'workspace-observed phase without Workspace evidence',
        candidate: { ...withoutWorkspaceEvidence, phase: 'workspace-observed' },
        issue: 'workspace-observed phase evidence is incomplete',
      },
      {
        name: 'workspace-observed phase with Registry commit evidence',
        candidate: { ...intent, phase: 'workspace-observed' },
        issue: 'workspace-observed phase evidence is incomplete',
      },
      {
        name: 'registry-committed phase without a Workspace inspection',
        candidate: { ...committedWithoutInspection, phase: 'registry-committed' },
        issue: 'committed Intent phase evidence is incomplete',
      },
      {
        name: 'expected-revision conflict with Registry commit evidence',
        candidate: { ...intent, phase: 'conflict', terminalReason: 'expected-revision' },
        issue: 'terminal Intent contains registry commit evidence',
      },
      {
        name: 'Registry commit revision beyond the expected successor',
        candidate: { ...intent, registryRevision: intent.payload.intent.expectedRegistryRevision + 2 },
        issue: 'Intent commit revision disagrees with expected revision',
      },
      {
        name: 'conflict with an observation terminal reason',
        candidate: { ...intent, phase: 'conflict', terminalReason: 'observation' },
        issue: 'conflict phase has an invalid terminal reason',
      },
      {
        name: 'duplicate-binding conflict with Registry commit evidence',
        candidate: { ...intent, phase: 'conflict', terminalReason: 'duplicate-binding' },
        issue: 'terminal Intent contains registry commit evidence',
      },
      {
        name: 'conflict without Workspace evidence',
        candidate: { ...terminalWithoutWorkspace, phase: 'conflict', terminalReason: 'expected-revision' },
        issue: 'conflict phase has no Workspace evidence',
      },
      {
        name: 'failure with an expected-revision terminal reason',
        candidate: { ...intent, phase: 'failure', terminalReason: 'expected-revision' },
        issue: 'failure phase has an invalid terminal reason',
      },
      {
        name: 'authority failure that retains Workspace evidence',
        candidate: { ...intent, phase: 'failure', terminalReason: 'authority' },
        issue: 'authority failure contains Workspace evidence',
      },
      {
        name: 'reconciliation with an authority terminal reason',
        candidate: { ...intent, phase: 'reconciliation-required', terminalReason: 'authority' },
        issue: 'reconciliation phase has an invalid terminal reason',
      },
      {
        name: 'stale payload digest',
        candidate: { ...intent, payloadDigest: '0'.repeat(64) },
        issue: 'Intent payload digest is stale',
      },
    ]
    for (const variant of variants) {
      expectSchemaIssue(
        sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse(variant.candidate),
        variant.issue,
        variant.name,
      )
    }
  })

  it.each(['workspace', 'observation'] as const)(
    'accepts %s reconciliation as a frozen v4 terminal reason',
    (terminalReason) => {
      const { intent } = parsedV4Records()
      const {
        workspaceId: _workspaceId,
        workspaceInspection: _workspaceInspection,
        projectId: _projectId,
        resourceBindingId: _resourceBindingId,
        registryRevision: _registryRevision,
        ...terminal
      } = intent
      expect(sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse({
        ...terminal,
        phase: 'reconciliation-required',
        terminalReason,
      }).success).toBe(true)
    },
  )

  it('retains optional v4 remote evidence and omits absent Workspace observations during migration', () => {
    const { intent, registry, snapshot } = parsedV4Records()
    const binding = registry.resourceBindings[0]
    if (binding === undefined || binding.currentInspection === undefined || intent.workspaceInspection === undefined) {
      throw new Error('v4 fixture requires complete Project observations')
    }
    const remotes = [
      { transport: 'https' as const, coordinate: 'github.com/example/saki' },
      { transport: 'other' as const },
    ].sort(compareSafeGitRemoteObservations)
    const candidates = deriveGitHubRepositoryCandidates(remotes)
    const withRemoteEvidence = <T extends V4Intent['inspection']>(inspection: T): T => ({
      ...inspection,
      projection: {
        ...inspection.projection,
        upstream: 'refs/remotes/origin/main',
        remotes,
        githubRepositoryCandidates: candidates,
      },
    })
    const migratedRegistry = {
      ...registry,
      resourceBindings: [{
        ...binding,
        registrationInspection: withRemoteEvidence(binding.registrationInspection),
        currentInspection: withRemoteEvidence(binding.currentInspection),
      }],
    }
    const migratedIntent = {
      ...intent,
      inspection: withRemoteEvidence(intent.inspection),
      workspaceInspection: withRemoteEvidence(intent.workspaceInspection),
    }
    const migrated = sakiControlPlaneMigrationPlan.steps[2]!.migrate({
      ...snapshot,
      tables: {
        ...snapshot.tables,
        development_project_registry: { [DEVELOPMENT_PROJECT_REGISTRY_KEY]: migratedRegistry },
        registration_intents: { [INTENT_ID]: migratedIntent },
      },
    })
    const currentRegistry = sakiControlPlaneV5DomainSpec.tables.development_project_registry.valueSchema.parse(
      migrated.tables['development_project_registry']![DEVELOPMENT_PROJECT_REGISTRY_KEY],
    )
    expect(currentRegistry.resourceBindings[0]?.currentInspection?.projection).toMatchObject({
      upstream: 'refs/remotes/origin/main',
      githubRepositoryCandidates: candidates,
    })

    const missingSnapshot = migratedV4Snapshot()
    const missingRegistry = sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.parse(
      missingSnapshot.tables['development_project_registry']![DEVELOPMENT_PROJECT_REGISTRY_KEY],
    )
    const missingIntent = sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse(
      missingSnapshot.tables['registration_intents']![INTENT_ID],
    )
    const missingBinding = missingRegistry.resourceBindings[0]
    if (missingBinding === undefined) throw new Error('v4 fixture requires a Resource Binding')
    const { workspaceId: _missingWorkspaceId, workspaceInspection: _missingWorkspaceInspection,
      projectId: _missingProjectId, resourceBindingId: _missingBindingId,
      registryRevision: _missingRegistryRevision, ...preparedIntent } = missingIntent
    const migratedMissing = sakiControlPlaneMigrationPlan.steps[2]!.migrate({
      ...missingSnapshot,
      tables: {
        ...missingSnapshot.tables,
        development_project_registry: {
          [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
            ...missingRegistry,
            resourceBindings: [{ ...missingBinding, health: 'missing', currentInspection: undefined }],
          },
        },
        registration_intents: { [INTENT_ID]: { ...preparedIntent, phase: 'prepared' } },
      },
    })
    const currentMissingRegistry = sakiControlPlaneV5DomainSpec.tables.development_project_registry.valueSchema.parse(
      migratedMissing.tables['development_project_registry']![DEVELOPMENT_PROJECT_REGISTRY_KEY],
    )
    const currentMissingIntent = sakiControlPlaneDomainSpec.tables.registration_intents.valueSchema.parse(
      migratedMissing.tables['registration_intents']![INTENT_ID],
    )
    expect(currentMissingRegistry.resourceBindings[0]?.currentInspection).toBeUndefined()
    expect(currentMissingIntent.workspaceInspection).toBeUndefined()

    const withoutRegistry = sakiControlPlaneMigrationPlan.steps[2]!.migrate({
      ...missingSnapshot,
      tables: { ...missingSnapshot.tables, development_project_registry: {} },
    })
    expect(withoutRegistry.tables['binding_write_admissions']).toEqual({})
  })

  it('keeps every v4 aggregate descriptor closed against future current fields', () => {
    const source = historicalSnapshot()
    const parsedV2 = parsedHistoricalTables(source)
    const v3 = sakiControlPlaneMigrationPlan.steps[0]!.migrate({ global: null, tables: parsedV2 })
    const v4 = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3)
    const registry = sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.parse(
      v4.tables['development_project_registry']!['development-project-registry'],
    )
    const intent = sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse(
      v4.tables['registration_intents']![INTENT_ID],
    )
    expect(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
      ...registry, futureCurrentField: true,
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
      ...registry,
      resourceBindings: registry.resourceBindings.map(binding => ({ ...binding, futureCurrentField: true })),
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
      ...registry,
      projects: registry.projects.map(project => ({ ...project, projectTitle: '   ' })),
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.development_project_registry.valueSchema.safeParse({
      ...registry,
      canonicalWorktreeIndex: registry.canonicalWorktreeIndex.map(entry => ({ ...entry, path: 'relative/repository' })),
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse({
      ...intent, futureCurrentField: true,
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.safeParse({
      ...intent,
      payload: { ...intent.payload, intent: { ...intent.payload.intent, futureCurrentField: true } },
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.github_project_sync.valueSchema.safeParse({
      id: PROJECT_ID,
      schemaVersion: 1,
      revision: 0,
      installationId: INSTALLATION_ID,
      nextCandidateRevision: 1,
      nextBoardGeneration: 1,
      futureCurrentField: true,
    }).success).toBe(false)
    expect(sakiControlPlaneV4DomainSpec.tables.github_sync_configuration_intents.valueSchema.safeParse({
      id: INTENT_ID,
      schemaVersion: 1,
      revision: 0,
      receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
      payloadDigest: '0'.repeat(64),
      payload: { intent: {}, actor: intent.payload.actor },
      phase: 'prepared',
      createdAt: 1,
      updatedAt: 1,
      futureCurrentField: true,
    }).success).toBe(false)
  })

  it('rejects nested future fields in frozen v4 GitHub aggregates and configuration Intents', () => {
    const configuration = {
      appId: '12345', githubInstallationId: '12345678', accountNodeId: 'O_saki_test_account',
      repositoryNodeId: 'R_saki_test_repository', repositoryDatabaseId: '87654321',
      projectNodeId: 'PVT_saki_test_project', credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
      statusFieldNodeId: 'PVTSSF_saki_test_status',
      statusOptionNodeIds: { inbox: 'option-inbox', backlog: 'option-backlog', ready: 'option-ready',
        inProgress: 'option-in-progress', inReview: 'option-in-review', done: 'option-done', canceled: 'option-canceled' },
      activePollIntervalMs: 30_000, backgroundPollIntervalMs: 300_000, rateLimitReserve: 500,
    }
    const sync = {
      id: PROJECT_ID, schemaVersion: 1, revision: 1, installationId: INSTALLATION_ID,
      nextCandidateRevision: 2, nextBoardGeneration: 1,
      pending: { revision: 1, state: 'saved', configuration, changedFields: ['credentialRef'],
        acceptedIntentId: INTENT_ID, receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'), savedAt: 1 },
    }
    expect(v4GitHubProjectSyncRecordSchema.safeParse(sync).success).toBe(true)
    expect(v4GitHubProjectSyncRecordSchema.safeParse({
      ...sync, pending: { ...sync.pending, futureCurrentField: true },
    }).success).toBe(false)

    const actor = sakiControlPlaneV4DomainSpec.tables.registration_intents.valueSchema.parse(
      sakiControlPlaneMigrationPlan.steps[1]!.migrate(sakiControlPlaneMigrationPlan.steps[0]!.migrate({
        global: null, tables: parsedHistoricalTables(historicalSnapshot()),
      })).tables['registration_intents']![INTENT_ID],
    ).payload.actor
    const intentPayload = { intent: { type: 'configure-github-synchronization', intentId: INTENT_ID,
      projectId: PROJECT_ID, expectedSynchronizationRevision: 0, patch: { credentialRef: 'ROTATED_KEY' } }, actor }
    const intent = { id: INTENT_ID, schemaVersion: 1, revision: 0,
      receiptId: INTENT_ID.replace(/^intent-/u, 'receipt-'),
      payloadDigest: canonicalDigest('saki/configure-github-synchronization/v1', intentPayload),
      payload: intentPayload, phase: 'prepared', createdAt: 1, updatedAt: 1 }
    expect(v4GitHubConfigurationIntentRecordSchema.safeParse(intent).success).toBe(true)
    expect(v4GitHubConfigurationIntentRecordSchema.safeParse({
      ...intent, payload: { ...intent.payload, intent: { ...intent.payload.intent, futureCurrentField: true } },
    }).success).toBe(false)
  })
})
