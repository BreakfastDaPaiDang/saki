import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
} from '../src/fixtures.ts'
import {
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
} from '../src/migration.ts'
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

function historicalSnapshot() {
  const actor = {
    installationId: INSTALLATION_ID,
    installationGenerationId: INSTALLATION_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
  }
  const payload = { intent: SAKI_PROJECT_REQUEST_FIXTURES.registration, actor }
  const inspection = {
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
          projects: [],
          resourceBindings: [],
          canonicalWorktreeIndex: [],
          gitDirectoryIndex: [],
          intentMappings: [],
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
          phase: 'prepared',
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

  it('declares strict adjacent v2 to v3 to current v4 steps and keeps v3 frozen', () => {
    expect(sakiControlPlaneV2DomainSpec.version).toBe(2)
    expect(sakiControlPlaneV3DomainSpec.version).toBe(3)
    expect(sakiControlPlaneDomainSpec.version).toBe(4)
    expect(sakiControlPlaneMigrationPlan.steps).toHaveLength(2)
    expect(sakiControlPlaneMigrationPlan.steps[0]).toMatchObject({
      from: { name: 'saki_control_plane', version: 2 },
      to: { name: 'saki_control_plane', version: 3 },
    })
    expect(sakiControlPlaneMigrationPlan.steps[1]).toMatchObject({
      from: { name: 'saki_control_plane', version: 3 },
      to: { name: 'saki_control_plane', version: 4 },
    })
    expect(Object.keys(sakiControlPlaneV2DomainSpec.tables).sort()).toEqual(
      Object.keys(sakiControlPlaneV3DomainSpec.tables).sort(),
    )
    expect(Object.keys(sakiControlPlaneDomainSpec.tables).sort()).toEqual([
      ...Object.keys(sakiControlPlaneV3DomainSpec.tables),
      'github_project_sync',
      'github_sync_configuration_intents',
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
    for (const [table, spec] of Object.entries(sakiControlPlaneDomainSpec.tables)) {
      for (const value of Object.values(v4.tables[table] ?? {})) spec.valueSchema.parse(value)
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
})
