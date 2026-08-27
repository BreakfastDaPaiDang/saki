import { DatabaseSync } from 'node:sqlite'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import {
  canonicalDigest,
  exactBytesDigest,
  inheritedChangeBaselineIdentityMaterial,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiControlPlaneV2DomainSpec,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_RECEIPT_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
} from '@breakfastdapaidang/saki-control-plane/fixtures'

const UUID = '00000000-0000-4000-8000-000000000009'

export const B03_INSTALLATION_ID =
  'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
export const B03_STORAGE_GENERATION_ID =
  `storage-generation-${UUID}` as SakiStorageGenerationId
export const B03_REGISTRY_REVISION = 1
export const B03_RETIRED_INSTALLATION_ID =
  'installation-00000000-0000-4000-8000-000000000006' as SakiInstallationId

const INSTALLATION_GENERATION_ID = `installation-generation-${UUID}`
const RETIRED_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000007'
const ABSENT_RETIRED_HOST_ID = 'host-00000000-0000-4000-8000-000000000008'
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002'
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000003'
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000004'
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000005'

const TRUSTED_PROJECT_OBSERVATION = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
} as const

type CurrentProjectProjection = typeof SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection

function historicalInspection(current: CurrentProjectProjection) {
  if (current.head.kind !== 'commit') {
    throw new Error('registered B03 fixture requires a committed HEAD')
  }
  const { fingerprint: _fingerprint, observationVersion: _version, head: _head, ...retained } = current
  const projectionWithoutFingerprint = {
    ...retained,
    observationVersion: 1 as const,
    head: current.head.objectId,
    ...(current.head.symbolicRef === undefined
      ? { detached: true as const }
      : { branch: current.head.symbolicRef.slice('refs/heads/'.length), detached: false as const }),
  }
  const material = {
    observationVersion: 1,
    hostId: projectionWithoutFingerprint.hostId,
    displayLocation: projectionWithoutFingerprint.displayLocation,
    worktreePathDigest: exactBytesDigest(
      'saki/worktree-path/v1',
      new TextEncoder().encode(TRUSTED_PROJECT_OBSERVATION.canonicalWorktreePath),
    ),
    gitDirectoryDigest: exactBytesDigest(
      'saki/git-directory/v1',
      new TextEncoder().encode(TRUSTED_PROJECT_OBSERVATION.canonicalGitDirectory),
    ),
    commonDirectoryDigest: exactBytesDigest(
      'saki/common-git-directory/v1',
      new TextEncoder().encode(TRUSTED_PROJECT_OBSERVATION.canonicalCommonGitDirectory),
    ),
    gitDirectoryIdentity: TRUSTED_PROJECT_OBSERVATION.gitDirectoryIdentity,
    commonGitDirectoryIdentity: TRUSTED_PROJECT_OBSERVATION.commonGitDirectoryIdentity,
    objectFormat: projectionWithoutFingerprint.objectFormat,
    head: projectionWithoutFingerprint.head,
    ...('branch' in projectionWithoutFingerprint
      ? { branch: `refs/heads/${projectionWithoutFingerprint.branch}` }
      : {}),
    detached: projectionWithoutFingerprint.detached,
    locked: projectionWithoutFingerprint.locked,
    inheritedChangeEntryCount: projectionWithoutFingerprint.inheritedChangeEntryCount,
    conversionAmbiguous: projectionWithoutFingerprint.conversionAmbiguous,
    comparison: TRUSTED_PROJECT_OBSERVATION.comparison,
    workspace: projectionWithoutFingerprint.workspaceId === undefined
      ? { kind: 'absent' as const }
      : { kind: 'present' as const, workspaceId: projectionWithoutFingerprint.workspaceId },
    ...(projectionWithoutFingerprint.upstream === undefined
      ? {}
      : { upstream: projectionWithoutFingerprint.upstream }),
    remotes: projectionWithoutFingerprint.remotes,
    ...(projectionWithoutFingerprint.githubRepositoryCandidates === undefined
      ? {}
      : { githubRepositoryCandidates: projectionWithoutFingerprint.githubRepositoryCandidates }),
    baseline: inheritedChangeBaselineIdentityMaterial(projectionWithoutFingerprint.baseline),
  }
  return {
    projection: {
      ...projectionWithoutFingerprint,
      fingerprint: {
        version: 1 as const,
        digest: canonicalDigest('saki/project-inspection/v1', material),
      },
    },
    trusted: TRUSTED_PROJECT_OBSERVATION,
  }
}

/** Exact B03 product state with non-default Registry state retained through migration. */
export function b03Snapshot(): KvUnitSnapshot {
  const currentIntent = SAKI_PROJECT_REQUEST_FIXTURES.registration
  const receipt = SAKI_PROJECT_RECEIPT_FIXTURES.confirmed.receipt
  const registrationInspection = historicalInspection(SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection)
  const intent = {
    ...currentIntent,
    confirmedFingerprint: registrationInspection.projection.fingerprint,
  }
  const currentSelection = SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace.currentSelection
  if (currentSelection.workspaceId === undefined) {
    throw new Error('registered B03 fixture requires a Workspace identity')
  }
  const workspaceInspection = historicalInspection(currentSelection)
  const actor = {
    installationId: B03_INSTALLATION_ID,
    installationGenerationId: INSTALLATION_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
  }
  const payload = { intent, actor }
  return {
    global: null,
    tables: {
      control_state: {
        'control-state': {
          schemaVersion: 1,
          revision: 6,
          phase: 'ready',
          installationId: B03_INSTALLATION_ID,
          initialInstallationGenerationId: INSTALLATION_GENERATION_ID,
          initialHostId: HOST_ID,
          hostOperatorPrincipalId: PRINCIPAL_ID,
          hostOperatorGrantId: GRANT_ID,
          installationAccessId: ACCESS_ID,
        },
      },
      installations: {
        [B03_INSTALLATION_ID]: {
          id: B03_INSTALLATION_ID,
          revision: 7,
          state: 'active',
          currentInstallationGenerationId: INSTALLATION_GENERATION_ID,
          currentHostId: HOST_ID,
        },
        [B03_RETIRED_INSTALLATION_ID]: {
          id: B03_RETIRED_INSTALLATION_ID,
          revision: 0,
          state: 'retired',
          currentInstallationGenerationId: RETIRED_INSTALLATION_GENERATION_ID,
          currentHostId: ABSENT_RETIRED_HOST_ID,
        },
      },
      hosts: {
        [HOST_ID]: {
          id: HOST_ID,
          revision: 2,
          installationId: B03_INSTALLATION_ID,
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
          installationId: B03_INSTALLATION_ID,
          principalId: PRINCIPAL_ID,
          state: 'active',
          actions: ['development-project:register'],
          scope: { kind: 'installation', installationId: B03_INSTALLATION_ID },
        },
      },
      installation_access: {
        [ACCESS_ID]: {
          id: ACCESS_ID,
          schemaVersion: 1,
          revision: 8,
          installationId: B03_INSTALLATION_ID,
          nextChallengeOrdinal: 1,
          nextSessionOrdinal: 1,
          requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
          challenges: [{
            id: `${ACCESS_ID}:challenge:0`,
            ordinal: 0,
            revision: 1,
            purpose: 'initial-bootstrap',
            installationId: B03_INSTALLATION_ID,
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
            installationId: B03_INSTALLATION_ID,
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
          revision: B03_REGISTRY_REVISION,
          projects: [{
            id: receipt.projectId,
            revision: 0,
            projectTitle: intent.projectTitle,
            resourceBindingId: receipt.resourceBindingId,
            state: 'active',
            createdAt: 12,
          }],
          resourceBindings: [{
            id: receipt.resourceBindingId,
            revision: 0,
            projectId: receipt.projectId,
            hostId: HOST_ID,
            workspaceId: currentSelection.workspaceId,
            health: 'active',
            registrationInspection,
            currentInspection: workspaceInspection,
            inheritedChangeBaseline: intent.confirmedBaseline,
            createdAt: 12,
            observedAt: 12,
          }],
          canonicalWorktreeIndex: [{
            hostId: HOST_ID,
            path: TRUSTED_PROJECT_OBSERVATION.canonicalWorktreePath,
            resourceBindingId: receipt.resourceBindingId,
          }],
          gitDirectoryIndex: [{
            hostId: HOST_ID,
            path: TRUSTED_PROJECT_OBSERVATION.canonicalGitDirectory,
            resourceBindingId: receipt.resourceBindingId,
          }],
          intentMappings: [{
            intentId: intent.intentId,
            projectId: receipt.projectId,
            resourceBindingId: receipt.resourceBindingId,
            registryRevision: B03_REGISTRY_REVISION,
          }],
        },
      },
      registration_intents: {
        [intent.intentId]: {
          id: intent.intentId,
          schemaVersion: 1,
          revision: 4,
          receiptId: receipt.id,
          payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
          payload,
          inspection: registrationInspection,
          workspaceInspection,
          phase: 'confirmed',
          workspaceId: currentSelection.workspaceId,
          projectId: receipt.projectId,
          resourceBindingId: receipt.resourceBindingId,
          registryRevision: B03_REGISTRY_REVISION,
          createdAt: 10,
          updatedAt: 12,
        },
      },
    },
  }
}

/** Write the exact physical-v1 SQLite layout accepted only by the closed B03 reader. */
export function writeB03Database(path: string): void {
  const snapshot = b03Snapshot()
  const database = new DatabaseSync(path)
  try {
    database.exec(`
      PRAGMA user_version = 1;
      CREATE TABLE units (name TEXT PRIMARY KEY, version INTEGER NOT NULL) STRICT;
      CREATE TABLE unit_globals (unit TEXT PRIMARY KEY REFERENCES units(name), value TEXT NOT NULL) STRICT;
    `)
    database.prepare('INSERT INTO units (name, version) VALUES (?, ?)')
      .run(sakiControlPlaneV2DomainSpec.name, sakiControlPlaneV2DomainSpec.version)
    for (const table of Object.keys(sakiControlPlaneV2DomainSpec.tables)) {
      const physical = `u_${sakiControlPlaneV2DomainSpec.name}_${table}`
      database.exec(`CREATE TABLE "${physical}" (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`)
      const insert = database.prepare(`INSERT INTO "${physical}" (key, value) VALUES (?, ?)`)
      for (const [key, value] of Object.entries(snapshot.tables[table] ?? {})) {
        insert.run(key, JSON.stringify(value))
      }
    }
  } finally {
    database.close()
  }
}
