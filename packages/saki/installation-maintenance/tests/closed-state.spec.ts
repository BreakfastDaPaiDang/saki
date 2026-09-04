import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { descriptorOf, type DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  startAgentRunHostOperationRequestSchema,
  startAgentRunInputMessageSchema,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  type HostOperationId,
} from '@breakfastdapaidang/saki-execution'
import {
  branchDeliveryId,
  bindingWriteAdmissionRecordSchema,
  createStorageGenerationSeal,
  agentOperationIntentRecordSchema,
  sakiControlPlaneV2DomainSpec,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiControlPlaneV8DomainSpec,
  sakiStorageGenerationDomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV5DomainSpec,
  sakiStorageGenerationV6DomainSpec,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV5SealRecordSchema,
  storageGenerationV6SealRecordSchema,
  type SakiBuildId,
  type SakiBoardWorkItemId,
  type SakiControlIntentId,
  type SakiDevelopmentProjectId,
  type SakiGrantId,
  type SakiHostId,
  type SakiInstallationAccessId,
  type SakiInstallationId,
  type SakiPrincipalId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  SAKI_BOARD_PROJECTION_FIXTURES,
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
} from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
} from '@breakfastdapaidang/saki-control-plane/src/spec.ts'
import { sakiControlPlaneDomainSpec } from '@breakfastdapaidang/saki-control-plane/src/domain-spec.ts'
import {
  readClosedCurrentSakiState,
  readClosedProvisioningSakiState,
  readClosedSakiV2State,
  readClosedSakiV3State,
  readClosedSakiV4State,
  readClosedSakiV5State,
  readClosedSakiV6State,
  readClosedSakiV7State,
  readClosedSakiV8State,
} from '../src/closed-state.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000003' as SakiHostId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000004' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000005' as SakiGrantId
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000006' as SakiInstallationAccessId
const BUILD_ID = 'saki-build-closed-state-test' as SakiBuildId
const OTHER_BUILD_ID = 'saki-build-other' as SakiBuildId
const V5_EXPECTATION = {
  installationId: INSTALLATION_ID,
  storageGenerationId: STORAGE_GENERATION_ID,
  createdByBuildId: BUILD_ID,
}
const roots: string[] = []
const realClose = Reflect.get(SqliteStorageBackend.prototype, 'close')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function databasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'saki-closed-state-'))
  roots.push(root)
  return join(root, 'state.sqlite')
}

function emptySnapshot(spec: DomainSpec): KvUnitSnapshot {
  return {
    tables: Object.fromEntries(Object.keys(spec.tables).map(table => [table, {}])),
    global: null,
  }
}

function currentControlSnapshot(): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      control_state: {
        [CONTROL_STATE_KEY]: {
          schemaVersion: 2,
          revision: 1,
          phase: 'ready',
          installationId: INSTALLATION_ID,
          initialHostId: HOST_ID,
          hostOperatorPrincipalId: PRINCIPAL_ID,
          hostOperatorGrantId: GRANT_ID,
          installationAccessId: ACCESS_ID,
        },
      },
      installations: {
        [INSTALLATION_ID]: {
          id: INSTALLATION_ID,
          revision: 1,
          state: 'active',
          currentHostId: HOST_ID,
        },
      },
      hosts: {
        [HOST_ID]: {
          id: HOST_ID,
          revision: 1,
          installationId: INSTALLATION_ID,
          state: 'enrolled',
        },
      },
      principals: {
        [PRINCIPAL_ID]: {
          id: PRINCIPAL_ID,
          revision: 1,
          kind: 'human',
          displayName: 'Host Operator',
          state: 'active',
        },
      },
      grants: {
        [GRANT_ID]: {
          id: GRANT_ID,
          revision: 1,
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
          schemaVersion: 2,
          revision: 0,
          installationId: INSTALLATION_ID,
          nextChallengeOrdinal: 0,
          nextSessionOrdinal: 0,
          requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
          challenges: [],
          sessions: [],
        },
      },
      development_project_registry: {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: {
          id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
          schemaVersion: 2,
          revision: 0,
          projects: [],
          agentProfiles: [],
          resourceBindings: [],
          canonicalWorktreeIndex: [],
          gitDirectoryIndex: [],
          intentMappings: [],
        },
      },
      registration_intents: {},
      github_project_sync: {},
      github_sync_configuration_intents: {},
      git_operation_intents: {},
      binding_write_admissions: {},
      github_work_item_intents: {},
      github_work_item_recovery: {},
      agent_operation_intents: {},
      work_assignments: {},
      work_sessions: {},
      agent_runs: {},
      execution_dispatches: {},
      intervention_requests: {},
      branch_deliveries: {},
      branch_delivery_intents: {},
      milestone_deliveries: {},
      milestone_delivery_intents: {},
    },
  }
}

function closedBranchPushCorruption(): {
  readonly delivery: { readonly id: string }
  readonly intent: { readonly id: string }
  readonly admission: { readonly id: string }
  readonly operation: { readonly snapshot: { readonly operation: { readonly id: string } } }
} {
  const projectId = 'project-00000000-0000-4000-8000-000000000181' as SakiDevelopmentProjectId
  const workItemId = `work-item-${'a'.repeat(64)}` as SakiBoardWorkItemId
  const intentId = 'intent-00000000-0000-4000-8000-000000000182' as SakiControlIntentId
  const operationId = 'host-operation-00000000-0000-4000-8000-000000000182' as HostOperationId
  const bindingId = 'binding-00000000-0000-4000-8000-000000000183'
  const deliveryId = branchDeliveryId(projectId, workItemId)
  const binding = {
    id: bindingId,
    revision: 0,
    health: 'active' as const,
    hostId: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.hostId,
    workspaceId: 'workspace-closed-branch-push',
    expectedInspection: {
      projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
      trusted: {
        canonicalWorktreePath: '/fixture/repository',
        canonicalGitDirectory: '/fixture/repository/.git',
        canonicalCommonGitDirectory: '/fixture/repository/.git',
        gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
        commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
        comparison: { fileMode: true, symlinks: true, autocrlf: false },
      },
    },
    inheritedChangeBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
  }
  const actor = {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 1,
    grantId: GRANT_ID,
    grantRevision: 1,
  }
  const payload = {
    intent: { type: 'push-branch-delivery' as const, intentId, deliveryId, expectedDeliveryRevision: 0 },
    actor,
  }
  const payloadDigest = canonicalDigest('saki/branch-delivery-intent/v1', payload)
  const request = hostOperationRequestSchema.parse({
    type: 'push-branch',
    source: { kind: 'control-intent', intentId, intentRevision: 0, payloadDigest },
    expected: {
      binding,
      commitId: 'b'.repeat(40),
      repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
    },
    targetRef: 'refs/heads/feature/offline-validation',
  })
  if (request.type !== 'push-branch') throw new Error('Closed Branch Push request changed kind')
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    id: deliveryId,
    schemaVersion: 1,
    revision: 1,
    projectId,
    workItemId,
    target: {
      registryRevision: 1,
      projectRevision: 1,
      binding,
      synchronizationRevision: 1,
      mappingRevision: 1,
      installation: {
        appId: '1', installationId: '2', accountId: 'A_fixture',
        privateKeyRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
      },
      repository: { id: 'R_fixture', databaseId: '3', nameWithOwner: 'BreakfastDaPaiDang/saki' },
      workItem: {
        id: workItemId,
        remoteFingerprint: `remote-fingerprint-${'c'.repeat(64)}`,
        issueId: 'I_fixture',
      },
    },
    commitId: request.expected.commitId,
    headRef: request.targetRef,
    baseRef: 'refs/heads/master',
    markerId: `pull-request-marker-${canonicalDigest(
      'saki/branch-delivery/pull-request-marker/v1',
      { deliveryId },
    )}`,
    phase: 'draft',
    activeIntentId: intentId,
    remoteRef: { current: { state: 'unobserved' } },
    pullRequest: { current: { state: 'unobserved' } },
    reviews: { current: { state: 'unobserved' } },
    ci: { current: { state: 'unobserved' } },
    lastIntentId: intentId,
    createdAt: 1,
    updatedAt: 2,
  })
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    id: intentId,
    schemaVersion: 1,
    revision: 1,
    payloadDigest,
    payload,
    deliveryId,
    operation: { kind: 'push', request },
    checkpoint: { state: 'active', deliveryRevision: delivery.revision },
    createdAt: 2,
    updatedAt: 2,
  })
  const mismatchedRequest = hostOperationRequestSchema.parse({
    ...request,
    expected: { ...request.expected, repository: { nameWithOwner: 'BreakfastDaPaiDang/other' } },
  })
  if (mismatchedRequest.type !== 'push-branch') throw new Error('Closed mismatched Push request changed kind')
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', mismatchedRequest),
  }
  const operationReference = {
    id: operationId,
    hostId: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.hostId,
    type: 'push-branch' as const,
  }
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 4,
    request: mismatchedRequest,
    preparationRevision: 0,
    snapshot: hostOperationSnapshotSchema.parse({
      operation: operationReference,
      revision: 0,
      source: mismatchedRequest.source,
      requestFingerprint,
      bindingId,
      bindingRevision: binding.revision,
      preparedAt: 3,
      updatedAt: 3,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    }),
  })
  const admission = bindingWriteAdmissionRecordSchema.parse({
    id: bindingId,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: binding.revision,
    source: request.source,
    action: 'project-branch:push',
    reservedAt: 2,
    updatedAt: 2,
  })
  return { delivery, intent, admission, operation }
}

function orphanAgentIntentRecord(): unknown {
  const intentId = 'intent-22222222-2222-4222-8222-222222222222'
  const assignmentId = 'assignment-11111111-1111-4111-8111-111111111111'
  const workSessionId = 'work-session-55555555-5555-4555-8555-555555555555'
  const agentRunId = 'agent-run-66666666-6666-4666-8666-666666666666'
  const dispatchId = 'dispatch-77777777-7777-4777-8777-777777777777'
  const projectId = 'project-33333333-3333-4333-8333-333333333333'
  const bindingId = 'binding-88888888-8888-4888-8888-888888888888'
  const workItemId = `work-item-${'4'.repeat(64)}`
  const profile = {
    id: 'agent-profile-99999999-9999-4999-8999-999999999999',
    version: 1,
    agentPresetId: 'standard',
    modelRoute: { provider: 'fixture', model: 'fixture-model' },
  } as const
  const input = startAgentRunInputMessageSchema.parse({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    role: 'user',
    content: [{ type: 'text', text: 'Implement the frozen Work Item.' }],
    source: { kind: 'saki-agent-run', dispatchId, agentRunId, workSessionId },
  })
  const baseline = SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline
  const hostRequest = startAgentRunHostOperationRequestSchema.parse({
    type: 'start-agent-run',
    source: {
      kind: 'execution-dispatch',
      dispatchId,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
    expected: {
      binding: {
        id: bindingId,
        revision: 0,
        health: 'active',
        hostId: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.hostId,
        workspaceId: 'workspace-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expectedInspection: {
          projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
          trusted: {
            canonicalWorktreePath: '/fixture/repository',
            canonicalGitDirectory: '/fixture/repository/.git',
            canonicalCommonGitDirectory: '/fixture/repository/.git',
            gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
            commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
            comparison: { fileMode: true, symlinks: true, autocrlf: false },
          },
        },
        inheritedChangeBaseline: baseline,
      },
      status: { version: 1, digest: '2'.repeat(64) },
      head: { kind: 'commit', objectId: '3'.repeat(40), symbolicRef: 'refs/heads/main' },
      index: { kind: 'tree', treeId: '4'.repeat(40) },
      worktree: { version: 1, digest: '5'.repeat(64) },
      preEffectBaseline: baseline,
    },
    run: {
      agentRunId,
      workSessionId,
      sessionId: 'session-cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      profile,
      input,
    },
  })
  const item = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure.confirmed?.items[0]
  const active = SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activated.synchronization.active
  if (item === undefined || active === undefined) throw new Error('Agent closed-state fixture is incomplete')
  const actor = {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 1,
    grantId: GRANT_ID,
    grantRevision: 1,
  }
  const intent = {
    type: 'give-work-item-to-agent' as const,
    intentId,
    projectId,
    workItemId,
    expectedProjectRevision: 0,
    expectedRemoteFingerprint: item.remoteFingerprint,
  }
  const workItemDefinition = {
    repositoryId: item.source.repositoryId,
    repositoryDatabaseId: active.configuration.repositoryDatabaseId,
    issueId: item.source.issueId,
    issueNumber: item.issueNumber,
    issueState: 'open' as const,
    title: item.title,
    url: item.url,
    body: '# Acceptance criteria\n- remains bounded',
    updatedAt: item.updatedAt,
    remoteFingerprint: item.remoteFingerprint,
    intendedOutcome: 'Complete the Work Item.',
    acceptanceCriteria: ['remains bounded'],
    blockage: [],
  }
  const projectContext = {
    projectId,
    projectRevision: 0,
    projectTitle: 'Orphan fixture',
    resourceBindingId: bindingId,
    bindingRevision: 0,
  }
  const payload = { intent, actor }
  return agentOperationIntentRecordSchema.parse({
    id: intentId,
    schemaVersion: 1,
    revision: 0,
    receiptId: 'receipt-22222222-2222-4222-8222-222222222222',
    payloadDigest: canonicalDigest('saki/agent-operation-intent/v1', payload),
    payload,
    phase: 'prepared',
    assignmentId,
    workSessionId,
    agentRunId,
    dispatchId,
    inProgressIntentId: 'intent-dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    workItemDefinition,
    projectContext,
    profile,
    contextDigest: canonicalDigest('saki/agent-operation-context/v1', {
      workItemDefinition,
      projectContext,
      profile,
    }),
    hostRequest,
    createdAt: 1,
    updatedAt: 1,
  })
}

function sealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: createStorageGenerationSeal(
          INSTALLATION_ID,
          STORAGE_GENERATION_ID,
          createdByBuildId,
        ),
      },
    },
  }
}

function v3ControlSnapshot(): KvUnitSnapshot {
  const current = v6ControlSnapshot()
  const tables = { ...current.tables }
  delete tables['github_project_sync']
  delete tables['github_sync_configuration_intents']
  delete tables['git_operation_intents']
  delete tables['binding_write_admissions']
  delete tables['github_work_item_intents']
  delete tables['github_work_item_recovery']
  return { global: null, tables }
}

function v4ControlSnapshot(): KvUnitSnapshot {
  const current = v6ControlSnapshot()
  const tables = { ...current.tables }
  delete tables['git_operation_intents']
  delete tables['binding_write_admissions']
  delete tables['github_work_item_intents']
  delete tables['github_work_item_recovery']
  return { global: null, tables }
}

function v5ControlSnapshot(): KvUnitSnapshot {
  const current = v6ControlSnapshot()
  const tables = { ...current.tables }
  delete tables['github_work_item_intents']
  delete tables['github_work_item_recovery']
  return { global: null, tables }
}

function v6ControlSnapshot(): KvUnitSnapshot {
  const current = currentControlSnapshot()
  const registry = current.tables.development_project_registry?.[DEVELOPMENT_PROJECT_REGISTRY_KEY]
  if (registry === undefined || typeof registry !== 'object') throw new Error('current Registry fixture is missing')
  const { agentProfiles: _agentProfiles, ...historicalRegistry } = registry as Record<string, unknown>
  const tables = { ...current.tables }
  delete tables['agent_operation_intents']
  delete tables['work_assignments']
  delete tables['work_sessions']
  delete tables['agent_runs']
  delete tables['execution_dispatches']
  delete tables['intervention_requests']
  delete tables['branch_deliveries']
  delete tables['branch_delivery_intents']
  delete tables['milestone_deliveries']
  delete tables['milestone_delivery_intents']
  return {
    global: null,
    tables: {
      ...tables,
      development_project_registry: {
        [DEVELOPMENT_PROJECT_REGISTRY_KEY]: { ...historicalRegistry, schemaVersion: 1 },
      },
    },
  }
}

function v1SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
          schemaVersion: 1,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 3,
          createdByBuildId,
        }),
      },
    },
  }
}

function v2SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV2SealRecordSchema.parse({
          schemaVersion: 2,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 4,
          createdByBuildId,
        }),
      },
    },
  }
}

function v3SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV3SealRecordSchema.parse({
          schemaVersion: 3,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 5,
          createdByBuildId,
        }),
      },
    },
  }
}

function v4SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV4SealRecordSchema.parse({
          schemaVersion: 4,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 6,
          createdByBuildId,
        }),
      },
    },
  }
}

function v5SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV5SealRecordSchema.parse({
          schemaVersion: 5,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 7,
          createdByBuildId,
        }),
      },
    },
  }
}

function v6SealSnapshot(createdByBuildId: SakiBuildId = BUILD_ID): KvUnitSnapshot {
  return {
    global: null,
    tables: {
      storage_generation: {
        [STORAGE_GENERATION_KEY]: storageGenerationV6SealRecordSchema.parse({
          schemaVersion: 6,
          installationId: INSTALLATION_ID,
          storageGenerationId: STORAGE_GENERATION_ID,
          stateVersion: 8,
          createdByBuildId,
        }),
      },
    },
  }
}

async function materialize(
  path: string,
  units: readonly { readonly spec: DomainSpec; readonly snapshot: KvUnitSnapshot }[],
): Promise<void> {
  const backend = new SqliteStorageBackend({ path, journalMode: 'delete' })
  try {
    const closed = backend.kv.closed
    if (closed === undefined) throw new Error('test SQLite backend has no closed operations')
    for (const unit of units) {
      await closed.withReservedUnit(unit.spec.name, AbortSignal.timeout(2_000), async (lease) => {
        const result = await lease.materializeMissing(descriptorOf(unit.spec), unit.snapshot)
        if (result.outcome !== 'durable') throw result.cause
      })
    }
  } finally {
    await backend.close()
  }
}

async function materializeV5(
  path: string,
  controlPlaneSnapshot: KvUnitSnapshot,
  storageGenerationSnapshot: KvUnitSnapshot,
): Promise<void> {
  await materialize(path, [
    { spec: sakiControlPlaneV5DomainSpec, snapshot: controlPlaneSnapshot },
    { spec: sakiHostExecutionV1DomainSpec, snapshot: emptySnapshot(sakiHostExecutionV1DomainSpec) },
    { spec: sakiStorageGenerationV3DomainSpec, snapshot: storageGenerationSnapshot },
  ])
}

async function materializeV6(
  path: string,
  storageGenerationSnapshot: KvUnitSnapshot = v4SealSnapshot(),
): Promise<void> {
  await materialize(path, [
    { spec: sakiControlPlaneV6DomainSpec, snapshot: v6ControlSnapshot() },
    { spec: sakiHostExecutionV1DomainSpec, snapshot: emptySnapshot(sakiHostExecutionV1DomainSpec) },
    { spec: sakiStorageGenerationV4DomainSpec, snapshot: storageGenerationSnapshot },
  ])
}

async function materializeV7(
  path: string,
  storageGenerationSnapshot: KvUnitSnapshot = v5SealSnapshot(),
): Promise<void> {
  await materialize(path, [
    { spec: sakiControlPlaneV7DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV7DomainSpec) },
    { spec: sakiHostExecutionV2DomainSpec, snapshot: emptySnapshot(sakiHostExecutionV2DomainSpec) },
    { spec: sakiStorageGenerationV5DomainSpec, snapshot: storageGenerationSnapshot },
  ])
}

async function materializeV8(
  path: string,
  storageGenerationSnapshot: KvUnitSnapshot = v6SealSnapshot(),
): Promise<void> {
  await materialize(path, [
    { spec: sakiControlPlaneV8DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV8DomainSpec) },
    { spec: sakiHostExecutionV3DomainSpec, snapshot: emptySnapshot(sakiHostExecutionV3DomainSpec) },
    { spec: sakiStorageGenerationV6DomainSpec, snapshot: storageGenerationSnapshot },
  ])
}

async function exactFiles(path: string): Promise<readonly [Buffer, Buffer]> {
  return await Promise.all([readFile(path), readFile(`${path}-shm`)])
}

describe('closed Saki state reads', () => {
  it('validates current state through detached read-only domains without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: currentControlSnapshot() },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([1, 3, 3, 7]))
    const before = await exactFiles(path)

    const state = await readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(state.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)
    expect(state.storageGeneration.table('storage_generation').size).toBe(1)
    expect(state.hostExecution.table('operations').size).toBe(0)
    const installations = state.controlPlane.table('installations')
    const installation = installations.get(INSTALLATION_ID)!
    expect([...installations.keys()]).toEqual([INSTALLATION_ID])
    expect(() => state.controlPlane.global).toThrow('declares no global')
    await expect(installations.put(INSTALLATION_ID, installation)).rejects.toThrow('read-only')
    await expect(installations.delete(INSTALLATION_ID)).rejects.toThrow('read-only')
    await expect(installations.update(INSTALLATION_ID, value => value)).rejects.toThrow('read-only')
    await expect(state.controlPlane.close()).resolves.toBeUndefined()
    expect(await exactFiles(path)).toEqual(before)
    expect(state.sourceArtifacts.artifacts.map(artifact => artifact.role)).toEqual(['database', 'shm'])
  })

  it('accepts an empty current control plane while provisioning and leaves every source artifact unchanged', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([2, 4, 6, 8]))
    const before = await exactFiles(path)

    const state = await readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 9,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(state.controlPlane.table('control_state').size).toBe(0)
    expect(state.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ createdByBuildId: BUILD_ID })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects a current control plane without its Host Execution domain', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: currentControlSnapshot() },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])

    await expect(readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects a provisioning generation with no seal without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
    ])
    await writeFile(`${path}-shm`, Buffer.from([5, 5, 5]))
    const before = await exactFiles(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 9,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects an empty storage-generation domain without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: emptySnapshot(sakiStorageGenerationDomainSpec) },
    ])
    const before = await readFile(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 9,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readFile(path)).resolves.toEqual(before)
  })

  it('rejects a provisioning seal that disagrees with fixed build provenance without changing the source', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: emptySnapshot(sakiControlPlaneDomainSpec) },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot(OTHER_BUILD_ID) },
    ])
    await writeFile(`${path}-shm`, Buffer.from([7, 7, 7]))
    const before = await exactFiles(path)

    await expect(readClosedProvisioningSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      stateVersion: 9,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects a selected current generation with a missing seal without changing source artifacts', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: currentControlSnapshot() },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
    ])
    await writeFile(`${path}-shm`, 'sidecar-evidence')
    const before = await exactFiles(path)

    await expect(readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects corrupt current records without changing source artifacts', async () => {
    const path = await databasePath()
    const corrupt = currentControlSnapshot()
    corrupt.tables.control_state = { [CONTROL_STATE_KEY]: { corrupt: true } }
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: corrupt },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])
    await writeFile(`${path}-shm`, Buffer.from([9, 8, 7]))
    const before = await exactFiles(path)

    await expect(readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
    expect(await exactFiles(path)).toEqual(before)
  })

  it('rejects a closed current generation whose Branch Push Host request changed identity', async () => {
    const path = await databasePath()
    const control = currentControlSnapshot()
    const corruption = closedBranchPushCorruption()
    control.tables.branch_deliveries = { [corruption.delivery.id]: corruption.delivery }
    control.tables.branch_delivery_intents = { [corruption.intent.id]: corruption.intent }
    control.tables.binding_write_admissions = { [corruption.admission.id]: corruption.admission }
    const host = emptySnapshot(sakiHostExecutionDomainSpec)
    host.tables.operations = { [corruption.operation.snapshot.operation.id]: corruption.operation }
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: control },
      { spec: sakiHostExecutionDomainSpec, snapshot: host },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])

    await expect(readClosedCurrentSakiState(path, V5_EXPECTATION, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it.each([
    ['Work Assignment', 'work_assignments', 'assignment-11111111-1111-4111-8111-111111111111', {
      id: 'assignment-11111111-1111-4111-8111-111111111111',
      schemaVersion: 1,
      revision: 0,
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectId: 'project-33333333-3333-4333-8333-333333333333',
      workItemId: `work-item-${'4'.repeat(64)}`,
      primaryWorkSessionId: 'work-session-55555555-5555-4555-8555-555555555555',
      agentRunId: 'agent-run-66666666-6666-4666-8666-666666666666',
      state: 'assigned',
      createdAt: 1,
      updatedAt: 1,
    }],
    ['Work Session', 'work_sessions', 'work-session-55555555-5555-4555-8555-555555555555', {
      id: 'work-session-55555555-5555-4555-8555-555555555555',
      schemaVersion: 1,
      revision: 0,
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      assignmentId: 'assignment-11111111-1111-4111-8111-111111111111',
      projectId: 'project-33333333-3333-4333-8333-333333333333',
      workItemId: `work-item-${'4'.repeat(64)}`,
      primary: true,
      agentRunIds: ['agent-run-66666666-6666-4666-8666-666666666666'],
      state: 'open',
      createdAt: 1,
      updatedAt: 1,
    }],
    ['Agent operation Intent', 'agent_operation_intents', 'intent-22222222-2222-4222-8222-222222222222',
      orphanAgentIntentRecord()],
  ])('rejects an orphan current %s in a closed generation', async (_kind, table, id, record) => {
    const path = await databasePath()
    const control = currentControlSnapshot()
    control.tables[table] = { [id]: record }
    await materialize(path, [
      { spec: sakiControlPlaneDomainSpec, snapshot: control },
      { spec: sakiHostExecutionDomainSpec, snapshot: emptySnapshot(sakiHostExecutionDomainSpec) },
      { spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() },
    ])

    await expect(readClosedCurrentSakiState(path, V5_EXPECTATION, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('returns structural v2 data for separate validation and rejects a v2-plus-seal hybrid', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])

    const historical = await readClosedSakiV2State(path, AbortSignal.timeout(2_000))
    expect(historical.controlPlane.table('control_state').size).toBe(0)
    await expect(historical.controlPlane.table('control_state').delete(CONTROL_STATE_KEY))
      .rejects.toThrow('read-only')

    await materialize(path, [{ spec: sakiStorageGenerationDomainSpec, snapshot: sealSnapshot() }])
    await expect(readClosedSakiV2State(path, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('validates exact historical v3 control and storage-generation domains', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneV3DomainSpec, snapshot: v3ControlSnapshot() },
      { spec: sakiStorageGenerationV1DomainSpec, snapshot: v1SealSnapshot() },
    ])

    const historical = await readClosedSakiV3State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(3)
    expect(historical.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)
    expect(historical.storageGeneration.table('storage_generation').size).toBe(1)
  })

  it('validates exact historical v4 domains and rejects a v4-plus-Host-Execution hybrid', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneV4DomainSpec, snapshot: v4ControlSnapshot() },
      { spec: sakiStorageGenerationV2DomainSpec, snapshot: v2SealSnapshot() },
    ])

    const historical = await readClosedSakiV4State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(4)
    expect(historical.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)

    await materialize(path, [
      { spec: sakiHostExecutionV1DomainSpec, snapshot: emptySnapshot(sakiHostExecutionV1DomainSpec) },
    ])
    await expect(readClosedSakiV4State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('validates exact historical v5 domains without changing source artifacts', async () => {
    const path = await databasePath()
    await materializeV5(path, v5ControlSnapshot(), v3SealSnapshot())
    await writeFile(`${path}-shm`, Buffer.from([5, 3, 5, 3]))
    const before = await exactFiles(path)

    const historical = await readClosedSakiV5State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(5)
    expect(historical.controlPlane.table('installations').get(INSTALLATION_ID)?.currentHostId).toBe(HOST_ID)
    expect(historical.hostExecution.table('operations').size).toBe(0)
    expect(historical.storageGeneration.table('storage_generation').size).toBe(1)
    expect(await exactFiles(path)).toEqual(before)
  })

  it('validates exact historical v6 domains for adjacent migration', async () => {
    const path = await databasePath()
    await materializeV6(path)

    const historical = await readClosedSakiV6State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(6)
    expect(historical.controlPlane.table('development_project_registry')
      .get(DEVELOPMENT_PROJECT_REGISTRY_KEY)?.schemaVersion).toBe(1)
    expect(historical.hostExecution.table('operations').size).toBe(0)
    expect(historical.storageGeneration.table('storage_generation').size).toBe(1)
  })

  it('validates the exact v7 control, Host v2, and storage v5 domains', async () => {
    const path = await databasePath()
    await materializeV7(path)

    const historical = await readClosedSakiV7State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(7)
    expect(historical.controlPlane.table('agent_runs').size).toBe(0)
    expect(historical.hostExecution.table('operations').size).toBe(0)
    expect(historical.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ schemaVersion: 5, stateVersion: 7 })
  })

  it('validates the exact v8 control, Host v3, and storage v6 domains', async () => {
    const path = await databasePath()
    await materializeV8(path)

    const historical = await readClosedSakiV8State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))

    expect(historical.stateVersion).toBe(8)
    expect(historical.controlPlane.table('agent_runs').size).toBe(0)
    expect(historical.hostExecution.table('operations').size).toBe(0)
    expect(historical.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ schemaVersion: 6, stateVersion: 8 })
  })

  it.each([
    {
      description: 'a missing storage-generation seal',
      snapshot: () => ({ global: null, tables: { storage_generation: {} } }),
      causeMessage: 'historical v7 Saki storage-generation seal is not the required singleton',
    },
    {
      description: 'a storage-generation seal that disagrees with manifest build provenance',
      snapshot: () => v5SealSnapshot(OTHER_BUILD_ID),
      causeMessage: 'historical v7 Saki storage-generation seal disagrees with selected generation metadata',
    },
  ])('rejects historical v7 state with $description', async ({ snapshot, causeMessage }) => {
    const path = await databasePath()
    await materializeV7(path, snapshot())

    await expect(readClosedSakiV7State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))).rejects.toMatchObject({
      code: 'recovery-required',
      cause: { message: causeMessage },
    })
  })

  it.each([
    {
      description: 'a missing storage-generation seal',
      snapshot: () => ({ global: null, tables: { storage_generation: {} } }),
      causeMessage: 'historical v6 Saki storage-generation seal is not the required singleton',
    },
    {
      description: 'a storage-generation seal under a noncanonical singleton key',
      snapshot: () => {
        const source = v4SealSnapshot()
        const seal = source.tables.storage_generation?.[STORAGE_GENERATION_KEY]
        if (seal === undefined) throw new Error('historical storage-generation seal fixture is missing')
        return { global: null, tables: { storage_generation: { unexpected: seal } } }
      },
      causeMessage: 'historical v6 Saki storage-generation seal is not the required singleton',
    },
    {
      description: 'a storage-generation seal that disagrees with manifest build provenance',
      snapshot: () => v4SealSnapshot(OTHER_BUILD_ID),
      causeMessage: 'historical v6 Saki storage-generation seal disagrees with selected generation metadata',
    },
  ])('rejects historical v6 state with $description', async ({ snapshot, causeMessage }) => {
    const path = await databasePath()
    await materializeV6(path, snapshot())

    await expect(readClosedSakiV6State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))).rejects.toMatchObject({
      code: 'recovery-required',
      cause: { message: causeMessage },
    })
  })

  it('classifies malformed historical v5 SQLite state and retains its validation cause', async () => {
    const path = await databasePath()
    const corrupt = v5ControlSnapshot()
    corrupt.tables.control_state = { [CONTROL_STATE_KEY]: { corrupt: true } }
    await materializeV5(path, corrupt, v3SealSnapshot())

    const failure = await readClosedSakiV5State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'recovery-required',
      message: 'selected historical v5 Saki generation is missing, malformed, or inconsistent',
    })
    expect((failure as Error).cause).toBeInstanceOf(Error)
  })

  it.each([
    {
      description: 'a storage-generation seal under a noncanonical singleton key',
      snapshot: () => {
        const source = v3SealSnapshot()
        const seal = source.tables.storage_generation?.[STORAGE_GENERATION_KEY]
        if (seal === undefined) throw new Error('historical storage-generation seal fixture is missing')
        return {
          global: null,
          tables: {
            storage_generation: {
              unexpected: seal,
            },
          },
        }
      },
      causeMessage: 'historical v5 Saki storage-generation seal is not the required singleton',
    },
    {
      description: 'a storage-generation seal that disagrees with manifest build provenance',
      snapshot: () => v3SealSnapshot(OTHER_BUILD_ID),
      causeMessage: 'historical v5 Saki storage-generation seal disagrees with selected generation metadata',
    },
  ])('rejects $description', async ({ snapshot, causeMessage }) => {
    const path = await databasePath()
    await materializeV5(path, v5ControlSnapshot(), snapshot())

    await expect(readClosedSakiV5State(path, V5_EXPECTATION, AbortSignal.timeout(2_000))).rejects.toMatchObject({
      code: 'recovery-required',
      cause: { message: causeMessage },
    })
  })

  it('classifies a historical v3 seal that disagrees with selected build provenance', async () => {
    const path = await databasePath()
    await materialize(path, [
      { spec: sakiControlPlaneV3DomainSpec, snapshot: v3ControlSnapshot() },
      { spec: sakiStorageGenerationV1DomainSpec, snapshot: v1SealSnapshot(OTHER_BUILD_ID) },
    ])

    await expect(readClosedSakiV3State(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000))).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('preserves a state-read failure together with backend-close failure', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    const closeFailure = new Error('close failed')
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockRejectedValueOnce(closeFailure)

    const failure = await readClosedCurrentSakiState(path, {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      createdByBuildId: BUILD_ID,
    }, AbortSignal.timeout(2_000)).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors[0]).toMatchObject({ code: 'recovery-required' })
    expect((failure as AggregateError).errors[1]).toBe(closeFailure)
  })

  it('classifies a missing source database as recovery-required', async () => {
    await expect(readClosedSakiV2State(
      await databasePath(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('preserves cancellation while capturing source artifacts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)

    await expect(readClosedSakiV2State(await databasePath(), controller.signal)).rejects.toBe(reason)
  })

  it('rejects a source that changes after its closed read', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockImplementationOnce(async function (this: SqliteStorageBackend) {
      await realClose.call(this)
      await writeFile(path, 'changed after closed read')
    })

    await expect(readClosedSakiV2State(path, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'source-changed' })
  })

  it('retains backend-close and source-verification failures after a successful read', async () => {
    const path = await databasePath()
    await materialize(path, [{ spec: sakiControlPlaneV2DomainSpec, snapshot: emptySnapshot(sakiControlPlaneV2DomainSpec) }])
    const closeFailure = new Error('close failed')
    vi.spyOn(SqliteStorageBackend.prototype, 'close').mockImplementationOnce(async function (this: SqliteStorageBackend) {
      await realClose.call(this)
      await writeFile(path, 'changed after closed read')
      throw closeFailure
    })

    const failure = await readClosedSakiV2State(path, AbortSignal.timeout(2_000))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    expect((failure as AggregateError).errors[0]).toBe(closeFailure)
  })
})
