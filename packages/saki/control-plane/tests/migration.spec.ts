import { describe, expect, it } from 'vitest'
import { canonicalDigest, exactBytesDigest, inheritedChangeBaselineIdentityMaterial } from '@breakfastdapaidang/saki-execution'
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
import { sakiControlPlaneDomainSpec } from '../src/spec.ts'

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
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000007'
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000008'

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

describe('Saki control-plane retained migrations', () => {
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

  it('declares strict adjacent v2 through current v5 steps and keeps historical action vocabularies frozen', () => {
    expect(sakiControlPlaneV2DomainSpec.version).toBe(2)
    expect(sakiControlPlaneV3DomainSpec.version).toBe(3)
    expect(sakiControlPlaneV4DomainSpec.version).toBe(4)
    expect(sakiControlPlaneDomainSpec.version).toBe(5)
    expect(sakiControlPlaneMigrationPlan.steps).toHaveLength(3)
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
    expect(Object.keys(sakiControlPlaneV2DomainSpec.tables).sort()).toEqual(
      Object.keys(sakiControlPlaneV3DomainSpec.tables).sort(),
    )
    expect(Object.keys(sakiControlPlaneDomainSpec.tables).sort()).toEqual([
      ...Object.keys(sakiControlPlaneV3DomainSpec.tables),
      'github_project_sync',
      'github_sync_configuration_intents',
      'git_operation_intents',
      'binding_write_admissions',
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
    const migratedRegistry = sakiControlPlaneDomainSpec.tables.development_project_registry.valueSchema.parse(
      v5.tables['development_project_registry']!['development-project-registry'],
    )
    expect(migratedRegistry.resourceBindings[0]?.registrationInspection.projection.head).toMatchObject({
      kind: 'commit', symbolicRef: 'refs/heads/main',
    })
    const migratedIntent = sakiControlPlaneDomainSpec.tables.registration_intents.valueSchema.parse(
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
    const migratedGrant = sakiControlPlaneDomainSpec.tables.grants.valueSchema.parse(
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
    for (const [table, spec] of Object.entries(sakiControlPlaneDomainSpec.tables)) {
      for (const value of Object.values(v5.tables[table] ?? {})) spec.valueSchema.parse(value)
    }
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
    const registry = sakiControlPlaneDomainSpec.tables.development_project_registry.valueSchema.parse(
      v5.tables['development_project_registry']!['development-project-registry'],
    )
    expect(registry.resourceBindings[0]?.registrationInspection.projection.head).toEqual({
      kind: 'commit', objectId: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.head.kind === 'commit'
        ? SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.head.objectId : 'unreachable',
    })
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
