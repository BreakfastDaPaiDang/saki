import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { type KvUnitSnapshot } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import {
  agentOperationIntentRecordSchema,
  agentRunV1RecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchV1RecordSchema,
  sakiControlPlaneMigrationPlan,
  sakiControlPlaneV3DomainSpec,
  sakiControlPlaneV4DomainSpec,
  sakiControlPlaneV5DomainSpec,
  sakiControlPlaneV6DomainSpec,
  sakiControlPlaneV7DomainSpec,
  sakiControlPlaneV8DomainSpec,
  sakiStorageGenerationV1DomainSpec,
  sakiStorageGenerationV2DomainSpec,
  sakiStorageGenerationV3DomainSpec,
  sakiStorageGenerationV4DomainSpec,
  sakiStorageGenerationV5DomainSpec,
  sakiStorageGenerationV6DomainSpec,
  sakiWorkAssignmentIdSchema,
  STORAGE_GENERATION_KEY,
  storageGenerationV1SealRecordSchema,
  storageGenerationV2SealRecordSchema,
  storageGenerationV3SealRecordSchema,
  storageGenerationV4SealRecordSchema,
  storageGenerationV5SealRecordSchema,
  storageGenerationV6SealRecordSchema,
  workSessionRecordSchema,
  type SakiBuildId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  SAKI_BOARD_PROJECTION_FIXTURES,
  SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES,
} from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  canonicalDigest,
  computeStartAgentRunPayloadDigest,
  hostOperationPreparationSchema,
  hostOperationIdSchema,
  hostOperationSnapshotSchema,
  sakiAgentRunIdSchema,
  sakiControlIntentIdSchema,
  startAgentRunHostOperationRequestSchema,
  startAgentRunInputMessageSchema,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
} from '@breakfastdapaidang/saki-execution-local'
import {
  readActiveOperation,
  readClosedCurrentSakiState,
  readClosedSakiV2State,
  readClosedSakiV7State,
  readClosedSakiV8State,
  readInstallationManifest,
  backupSakiInstallation,
  createSakiMaintenanceOperations,
  generationManifestReference,
  LEGACY_B03_BUILD_ID,
  renderGenerationManifest,
  renderInstallationManifest,
  upgradeSakiInstallation,
  verifySakiInstallationBackup,
  withPreparedSakiServingState,
} from '../src/index.ts'
import type { SakiMaintenanceEffects, SakiMaintenanceOptions } from '../src/index.ts'
import {
  B03_INSTALLATION_ID,
  B03_RETIRED_INSTALLATION_ID,
  B03_REGISTRY_REVISION,
  B03_STORAGE_GENERATION_ID,
  b03Snapshot,
  writeB03Database,
} from './b03-fixture.ts'

const roots: string[] = []
const V3_SOURCE_BUILD_ID = 'saki-build-0.1.0-b18-test' as SakiBuildId
const V4_SOURCE_BUILD_ID = 'saki-build-0.1.0-b29-test' as SakiBuildId
const V5_SOURCE_BUILD_ID = 'saki-build-0.1.0-b05-test' as SakiBuildId
const V6_SOURCE_BUILD_ID = 'saki-build-0.1.0-b30-test' as SakiBuildId
const V7_SOURCE_BUILD_ID = 'saki-build-0.1.0-b07-test' as SakiBuildId
const V8_SOURCE_BUILD_ID = 'saki-build-0.1.0-b09-test' as SakiBuildId
const AGENT_INTENT_ID = sakiControlIntentIdSchema.parse('intent-11111111-1111-4111-8111-111111111111')
const ASSIGNMENT_ID = sakiWorkAssignmentIdSchema.parse('assignment-22222222-2222-4222-8222-222222222222')
const WORK_SESSION_ID = 'work-session-33333333-3333-4333-8333-333333333333'
const AGENT_RUN_ID = sakiAgentRunIdSchema.parse('agent-run-44444444-4444-4444-8444-444444444444')
const DISPATCH_ID = 'dispatch-55555555-5555-4555-8555-555555555555'
const OPERATION_ID = hostOperationIdSchema.parse('host-operation-55555555-5555-4555-8555-555555555555')
const SESSION_ID = 'session-66666666-6666-4666-8666-666666666666'
const MESSAGE_ID = '77777777-7777-4777-8777-777777777777'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true })
  }))
})

async function fixture(): Promise<{ readonly options: SakiMaintenanceOptions; readonly legacy: string }> {
  const installationRoot = await mkdtemp(join(tmpdir(), 'saki-maintenance-operations-'))
  roots.push(installationRoot)
  const legacy = join(installationRoot, 'control.sqlite')
  writeB03Database(legacy)
  return {
    legacy,
    options: {
      installationRoot,
      legacyDatabasePath: legacy,
      currentBuildId: 'saki-build-0.1.0-b05-test' as SakiBuildId,
      legacyBuildId: LEGACY_B03_BUILD_ID,
    },
  }
}

async function publishSelectedHistorical(
  options: SakiMaintenanceOptions,
  stateVersion: 3 | 4 | 5 | 6 | 7 | 8,
  customizeV7?: (controlPlane: KvUnitSnapshot) => {
    readonly controlPlane: KvUnitSnapshot
    readonly hostExecution: KvUnitSnapshot
  },
): Promise<string> {
  const signal = new AbortController().signal
  const sourceBuildId = stateVersion === 3
    ? V3_SOURCE_BUILD_ID
    : stateVersion === 4
      ? V4_SOURCE_BUILD_ID
      : stateVersion === 5
        ? V5_SOURCE_BUILD_ID
        : stateVersion === 6
          ? V6_SOURCE_BUILD_ID
          : stateVersion === 7 ? V7_SOURCE_BUILD_ID : V8_SOURCE_BUILD_ID
  const historical = await readClosedSakiV2State(options.legacyDatabasePath, signal)
  const v3Snapshot = sakiControlPlaneMigrationPlan.steps[0]!.migrate(
    historical.controlPlaneSnapshot,
  )
  const directory = resolve(
    options.installationRoot,
    'generations',
    B03_STORAGE_GENERATION_ID,
  )
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'state.sqlite')
  const context = new Context()
  await context.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: databasePath, journalMode: 'delete' })
  const sourceBackend = `source-v${stateVersion}`
  context.storage.backend.register(sourceBackend, backend)
  const facility = new DomainFacility(context, { backend: sourceBackend })
  try {
    if (stateVersion === 3) {
      await facility.materialize(
        sakiControlPlaneV3DomainSpec,
        v3Snapshot,
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV1DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV1SealRecordSchema.parse({
                schemaVersion: 1,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 4) {
      await facility.materialize(
        sakiControlPlaneV4DomainSpec,
        sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV2DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV2SealRecordSchema.parse({
                schemaVersion: 2,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 5) {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      await facility.materialize(
        sakiControlPlaneV5DomainSpec,
        sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV1DomainSpec,
        { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV3DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV3SealRecordSchema.parse({
                schemaVersion: 3,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 6) {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
      await facility.materialize(
        sakiControlPlaneV6DomainSpec,
        sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV1DomainSpec,
        { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV4DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV4SealRecordSchema.parse({
                schemaVersion: 4,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else if (stateVersion === 7) {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
      const v6Snapshot = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot)
      const v7ControlPlane = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6Snapshot)
      const customized = customizeV7?.(v7ControlPlane)
      await facility.materialize(
        sakiControlPlaneV7DomainSpec,
        customized?.controlPlane ?? v7ControlPlane,
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV2DomainSpec,
        customized?.hostExecution ?? { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV5DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV5SealRecordSchema.parse({
                schemaVersion: 5,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    } else {
      const v4Snapshot = sakiControlPlaneMigrationPlan.steps[1]!.migrate(v3Snapshot)
      const v5Snapshot = sakiControlPlaneMigrationPlan.steps[2]!.migrate(v4Snapshot)
      const v6Snapshot = sakiControlPlaneMigrationPlan.steps[3]!.migrate(v5Snapshot)
      const v7Snapshot = sakiControlPlaneMigrationPlan.steps[4]!.migrate(v6Snapshot)
      await facility.materialize(
        sakiControlPlaneV8DomainSpec,
        sakiControlPlaneMigrationPlan.steps[5]!.migrate(v7Snapshot),
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiHostExecutionV3DomainSpec,
        { tables: { operations: {} }, global: null },
        { targetBackend: sourceBackend, signal },
      )
      await facility.materialize(
        sakiStorageGenerationV6DomainSpec,
        {
          tables: {
            storage_generation: {
              [STORAGE_GENERATION_KEY]: storageGenerationV6SealRecordSchema.parse({
                schemaVersion: 6,
                installationId: B03_INSTALLATION_ID,
                storageGenerationId: B03_STORAGE_GENERATION_ID,
                stateVersion,
                createdByBuildId: sourceBuildId,
              }),
            },
          },
          global: null,
        },
        { targetBackend: sourceBackend, signal },
      )
    }
  } finally {
    await facility.closeAll()
    await backend.close()
    await context.fiber.dispose()
  }
  const generationBytes = renderGenerationManifest(
    B03_INSTALLATION_ID,
    B03_STORAGE_GENERATION_ID,
    stateVersion,
    sourceBuildId,
  )
  await writeFile(join(directory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(options.installationRoot, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(B03_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return databasePath
}

async function publishSelectedV3(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 3)
}

async function publishSelectedV4(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 4)
}

async function publishSelectedV5(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 5)
}

async function publishSelectedV6(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 6)
}

async function publishSelectedV7(
  options: SakiMaintenanceOptions,
  customize?: Parameters<typeof publishSelectedHistorical>[2],
): Promise<string> {
  return await publishSelectedHistorical(options, 7, customize)
}

async function publishSelectedV8(options: SakiMaintenanceOptions): Promise<string> {
  return await publishSelectedHistorical(options, 8)
}

function withRunningPreviousWritableAgent(
  controlPlane: KvUnitSnapshot,
): {
  readonly controlPlane: KvUnitSnapshot
  readonly hostExecution: KvUnitSnapshot
} {
  const registryEntry = Object.entries(controlPlane.tables['development_project_registry'] ?? {})[0]
  if (registryEntry === undefined) throw new Error('v7 Registry fixture is missing')
  const registry = sakiControlPlaneV7DomainSpec.tables.development_project_registry.valueSchema
    .parse(registryEntry[1])
  const project = registry.projects[0]
  const binding = registry.resourceBindings[0]
  const registryProfile = registry.agentProfiles[0]
  if (project === undefined || binding === undefined || registryProfile === undefined
    || binding.currentInspection === undefined) {
    throw new Error('v7 Agent operation fixture lacks a current Project Binding and Profile')
  }
  const modelRoute = { provider: 'fixture', model: 'fixture-model' }
  const updatedRegistry = sakiControlPlaneV7DomainSpec.tables.development_project_registry.valueSchema.parse({
    ...registry,
    agentProfiles: [{ ...registryProfile, modelRouteRequest: modelRoute }],
  })
  const controlEntry = Object.entries(controlPlane.tables['control_state'] ?? {})[0]
  if (controlEntry === undefined) throw new Error('v7 control-state fixture is missing')
  const control = sakiControlPlaneV7DomainSpec.tables.control_state.valueSchema.parse(controlEntry[1])
  const principal = sakiControlPlaneV7DomainSpec.tables.principals.valueSchema.parse(
    controlPlane.tables['principals']?.[control.hostOperatorPrincipalId],
  )
  const grant = sakiControlPlaneV7DomainSpec.tables.grants.valueSchema.parse(
    controlPlane.tables['grants']?.[control.hostOperatorGrantId],
  )
  const item = SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure.confirmed?.items[0]
  const active = SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activated.synchronization.active
  if (item === undefined || active === undefined) throw new Error('v7 Work Item fixture is missing')
  const profile = {
    id: registryProfile.id,
    version: registryProfile.version,
    agentPresetId: registryProfile.agentPresetId,
    modelRoute,
  }
  const input = startAgentRunInputMessageSchema.parse({
    id: MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text: 'Resume the retained v7 Agent Run.' }],
    source: {
      kind: 'saki-agent-run',
      dispatchId: DISPATCH_ID,
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
    },
  })
  const hostRequest = startAgentRunHostOperationRequestSchema.parse({
    type: 'start-agent-run',
    source: {
      kind: 'execution-dispatch',
      dispatchId: DISPATCH_ID,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
    expected: {
      binding: {
        id: binding.id,
        revision: binding.revision,
        health: binding.health,
        hostId: binding.hostId,
        workspaceId: binding.workspaceId,
        expectedInspection: binding.currentInspection,
        inheritedChangeBaseline: binding.inheritedChangeBaseline,
      },
      status: { version: 1, digest: '2'.repeat(64) },
      head: { kind: 'commit', objectId: '3'.repeat(40), symbolicRef: 'refs/heads/main' },
      index: { kind: 'tree', treeId: '4'.repeat(40) },
      worktree: { version: 1, digest: '5'.repeat(64) },
      preEffectBaseline: binding.inheritedChangeBaseline,
    },
    run: {
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      sessionId: SESSION_ID,
      profile,
      input,
    },
  })
  const result = {
    type: 'start-agent-run' as const,
    agentRunId: AGENT_RUN_ID,
    workSessionId: WORK_SESSION_ID,
    sessionId: SESSION_ID,
    inputMessageId: MESSAGE_ID,
  }
  const operation = { id: OPERATION_ID, hostId: binding.hostId, type: 'start-agent-run' as const }
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', hostRequest),
  }
  const preparation = hostOperationPreparationSchema.parse({
    operation,
    preparationRevision: 0,
    requestFingerprint,
  })
  const operationSnapshot = hostOperationSnapshotSchema.parse({
    operation,
    revision: 4,
    source: hostRequest.source,
    requestFingerprint,
    bindingId: binding.id,
    bindingRevision: binding.revision,
    preparedAt: 2,
    updatedAt: 6,
    state: 'succeeded',
    admission: { kind: 'accepted', revision: 2, acceptedAt: 3 },
    completedAt: 6,
    result,
  })
  const actor = {
    installationId: B03_INSTALLATION_ID,
    storageGenerationId: B03_STORAGE_GENERATION_ID,
    hostId: binding.hostId,
    principalId: principal.id,
    principalRevision: principal.revision,
    grantId: grant.id,
    grantRevision: grant.revision,
  }
  const intent = {
    type: 'give-work-item-to-agent' as const,
    intentId: AGENT_INTENT_ID,
    projectId: project.id,
    workItemId: item.id,
    expectedProjectRevision: project.revision,
    expectedRemoteFingerprint: item.remoteFingerprint,
  }
  const payload = { intent, actor }
  const workItemDefinition = {
    repositoryId: item.source.repositoryId,
    repositoryDatabaseId: active.configuration.repositoryDatabaseId,
    issueId: item.source.issueId,
    issueNumber: item.issueNumber,
    issueState: 'open' as const,
    title: item.title,
    url: item.url,
    body: '# Acceptance criteria\n- survives adjacent migration',
    updatedAt: item.updatedAt,
    remoteFingerprint: item.remoteFingerprint,
    intendedOutcome: 'Retain the running Agent operation.',
    acceptanceCriteria: ['survives adjacent migration'],
    blockage: [],
  }
  const projectContext = {
    projectId: project.id,
    projectRevision: project.revision,
    projectTitle: project.projectTitle,
    resourceBindingId: binding.id,
    bindingRevision: binding.revision,
  }
  const retainedIntent = agentOperationIntentRecordSchema.parse({
    id: AGENT_INTENT_ID,
    schemaVersion: 1,
    revision: 4,
    receiptId: AGENT_INTENT_ID.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/agent-operation-intent/v1', payload),
    payload,
    phase: 'started',
    assignmentId: ASSIGNMENT_ID,
    workSessionId: WORK_SESSION_ID,
    agentRunId: AGENT_RUN_ID,
    dispatchId: DISPATCH_ID,
    inProgressIntentId: 'intent-88888888-8888-4888-8888-888888888888',
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
    updatedAt: 6,
  })
  const assignment = sakiControlPlaneV7DomainSpec.tables.work_assignments.valueSchema.parse({
    id: ASSIGNMENT_ID,
    schemaVersion: 1,
    revision: 2,
    intentId: AGENT_INTENT_ID,
    projectId: project.id,
    workItemId: item.id,
    primaryWorkSessionId: WORK_SESSION_ID,
    agentRunId: AGENT_RUN_ID,
    state: 'active',
    createdAt: 1,
    updatedAt: 6,
  })
  const workSession = workSessionRecordSchema.parse({
    id: WORK_SESSION_ID,
    schemaVersion: 1,
    revision: 1,
    intentId: AGENT_INTENT_ID,
    assignmentId: ASSIGNMENT_ID,
    projectId: project.id,
    workItemId: item.id,
    primary: true,
    agentRunIds: [AGENT_RUN_ID],
    state: 'open',
    createdAt: 1,
    updatedAt: 6,
  })
  const run = agentRunV1RecordSchema.parse({
    id: AGENT_RUN_ID,
    schemaVersion: 1,
    revision: 2,
    intentId: AGENT_INTENT_ID,
    assignmentId: ASSIGNMENT_ID,
    workSessionId: WORK_SESSION_ID,
    projectId: project.id,
    workItemId: item.id,
    bindingId: binding.id,
    profile,
    sessionId: SESSION_ID,
    inputPlan: { messageId: MESSAGE_ID, payloadDigest: hostRequest.source.payloadDigest },
    dispatchIds: [DISPATCH_ID],
    state: 'running',
    hostResult: result,
    createdAt: 1,
    updatedAt: 6,
  })
  const dispatch = executionDispatchV1RecordSchema.parse({
    id: DISPATCH_ID,
    schemaVersion: 1,
    revision: 4,
    intentId: AGENT_INTENT_ID,
    agentRunId: AGENT_RUN_ID,
    workSessionId: WORK_SESSION_ID,
    hostId: binding.hostId,
    bindingId: binding.id,
    payloadDigest: hostRequest.source.payloadDigest,
    hostRequest,
    state: 'accepted',
    latestFencingToken: 1,
    acceptedFencingToken: 1,
    preparation,
    operationSnapshot,
    createdAt: 1,
    updatedAt: 6,
  })
  const admission = bindingWriteAdmissionRecordSchema.parse({
    id: binding.id,
    schemaVersion: 1,
    revision: 2,
    state: 'agent-run',
    phase: 'accepted',
    bindingRevision: binding.revision,
    originIntentId: AGENT_INTENT_ID,
    agentRunId: AGENT_RUN_ID,
    payloadDigest: hostRequest.source.payloadDigest,
    reservedAt: 2,
    acceptedAt: 3,
    updatedAt: 3,
  })
  const hostOperation = sakiHostExecutionV2DomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 2,
    request: hostRequest,
    preparationRevision: 0,
    snapshot: operationSnapshot,
    effectPlan: { kind: 'agent-run', publication: 'applied-recorded', result },
  })
  return {
    controlPlane: {
      global: controlPlane.global,
      tables: {
        ...controlPlane.tables,
        development_project_registry: { [registryEntry[0]]: updatedRegistry },
        agent_operation_intents: { [AGENT_INTENT_ID]: retainedIntent },
        work_assignments: { [ASSIGNMENT_ID]: assignment },
        work_sessions: { [WORK_SESSION_ID]: workSession },
        agent_runs: { [AGENT_RUN_ID]: run },
        execution_dispatches: { [DISPATCH_ID]: dispatch },
        binding_write_admissions: {
          ...(controlPlane.tables['binding_write_admissions'] ?? {}),
          [binding.id]: admission,
        },
      },
    },
    hostExecution: {
      global: null,
      tables: { operations: { [OPERATION_ID]: hostOperation } },
    },
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false
    throw error
  }
}

async function publishSelectedB03(
  options: SakiMaintenanceOptions,
  phase: 'provisioning' | 'ready' = 'ready',
  stateVersion = 2,
): Promise<string> {
  const directory = resolve(
    options.installationRoot,
    'generations',
    B03_STORAGE_GENERATION_ID,
  )
  await mkdir(directory, { recursive: true })
  const databasePath = join(directory, 'state.sqlite')
  writeB03Database(databasePath)
  const generationBytes = renderGenerationManifest(
    B03_INSTALLATION_ID,
    B03_STORAGE_GENERATION_ID,
    stateVersion,
    options.legacyBuildId,
  )
  await writeFile(join(directory, 'generation.json'), generationBytes)
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(options.installationRoot, 'installation.json'),
    renderInstallationManifest(
      phase,
      generation,
      generationManifestReference(B03_STORAGE_GENERATION_ID, generationBytes),
    ),
  )
  return databasePath
}

async function rewriteAuthorityPhase(
  installationRoot: string,
  phase: 'provisioning' | 'ready',
): Promise<void> {
  const signal = new AbortController().signal
  const authority = await readInstallationManifest(installationRoot, signal)
  if (authority === undefined) throw new Error('test Installation authority is missing')
  const generationBytes = await readFile(resolve(
    installationRoot,
    ...authority.value.generationJson.leaf.split('/'),
  ))
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(installationRoot, 'installation.json'),
    renderInstallationManifest(phase, generation, authority.value.generationJson),
  )
}

async function publishActiveCandidateAuthority(
  installationRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const active = await readActiveOperation(installationRoot, signal)
  if (active?.journal.kind !== 'upgrade') throw new Error('active candidate journal is missing')
  const generationBytes = await readFile(resolve(
    installationRoot,
    'generations',
    active.journal.candidateStorageGenerationId,
    'generation.json',
  ))
  const generation = JSON.parse(generationBytes.toString('utf8')) as Parameters<
    typeof renderInstallationManifest
  >[1]
  await writeFile(
    join(installationRoot, 'installation.json'),
    renderInstallationManifest(
      'ready',
      generation,
      generationManifestReference(active.journal.candidateStorageGenerationId, generationBytes),
    ),
  )
}

const PRE_MANIFEST_CRASH_PHASES = [
  'afterJournalPublication',
  'afterBackupVerification',
  'afterCandidatePartialCreation',
  'afterCandidateMaterialization',
  'afterCandidateManifestPublication',
  'afterCandidatePublication',
  'afterCandidateValidation',
  'beforeManifestPublication',
] as const satisfies readonly (keyof SakiMaintenanceEffects)[]

describe('offline Saki Installation operations', () => {
  it('upgrades an exact physical-v1 B03 database with a registered Project and reopenable backup', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 2, targetVersion: 9 })
    expect(await readFile(legacy)).toEqual(before)
    expect(result.selected.installation).toMatchObject({
      phase: 'ready',
      installationId: B03_INSTALLATION_ID,
      stateVersion: 9,
    })
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated Registry is missing')
    expect(registry).toMatchObject({
      revision: B03_REGISTRY_REVISION,
      projects: [{ state: 'active', projectTitle: 'Fixture project' }],
      resourceBindings: [{ health: 'active' }],
      intentMappings: [{ registryRevision: B03_REGISTRY_REVISION }],
    })
    const project = registry.projects[0]
    const binding = registry.resourceBindings[0]
    const mapping = registry.intentMappings[0]
    if (project === undefined || binding === undefined || mapping === undefined) {
      throw new Error('migrated registered Project aggregate is incomplete')
    }
    expect(project.resourceBindingId).toBe(binding.id)
    expect(binding.projectId).toBe(project.id)
    expect(mapping).toMatchObject({ projectId: project.id, resourceBindingId: binding.id })
    expect(current.controlPlane.table('registration_intents').get(mapping.intentId)).toMatchObject({
      phase: 'confirmed',
      projectId: project.id,
      resourceBindingId: binding.id,
      payload: { actor: { storageGenerationId: B03_STORAGE_GENERATION_ID } },
    })
    const access = [...current.controlPlane.table('installation_access').entries()][0]?.[1]
    expect(access).toMatchObject({
      challenges: [{
        storageGenerationId: B03_STORAGE_GENERATION_ID,
        browserSessionId: 'access-00000000-0000-4000-8000-000000000005:session:0',
      }],
      sessions: [{ storageGenerationId: B03_STORAGE_GENERATION_ID }],
    })
    expect(current.controlPlane.table('installations').get(B03_RETIRED_INSTALLATION_ID))
      .toMatchObject({ state: 'retired' })
    const verifiedBackup = await verifySakiInstallationBackup(
      options,
      result.backup.manifest.backupId,
      signal,
    )
    expect(verifiedBackup).toMatchObject({
      manifest: {
        installationId: B03_INSTALLATION_ID,
        stateVersion: 2,
        sourceBuildId: options.legacyBuildId,
      },
    })
    const reopenedBackup = await readClosedSakiV2State(verifiedBackup.databasePath, signal)
    expect(reopenedBackup.controlPlane.table('development_project_registry')
      .get('development-project-registry')).toEqual(
      b03Snapshot().tables.development_project_registry?.['development-project-registry'],
    )
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: { phase: 'ready', stateVersion: 9 },
    })

    const currentBackup = await backupSakiInstallation(options, signal)
    expect(currentBackup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      stateVersion: 9,
      sourceBuildId: options.currentBuildId,
    })
    await expect(upgradeSakiInstallation(options, signal)).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'selected Saki state is already current',
    })
  }, 20_000)

  it('creates and clears an explicit Recovery Backup for manifest-less B03 state', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal

    const backup = await backupSakiInstallation(options, signal)

    expect(backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 2,
      sourceBuildId: options.legacyBuildId,
    })
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
  })

  it('rejects invalid maintenance options before taking the Installation lease', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal

    await expect(backupSakiInstallation({
      ...options,
      installationRoot: ':memory:',
    }, signal)).rejects.toThrow('Saki Installation root must be an absolute filesystem path')
    await expect(backupSakiInstallation({
      ...options,
      legacyDatabasePath: 'control.sqlite',
    }, signal)).rejects.toThrow('legacy Saki database path must be an absolute filesystem path')
    await expect(backupSakiInstallation({
      ...options,
      legacyBuildId: 'saki-build-not-b03' as SakiBuildId,
    }, signal)).rejects.toThrow(`legacy Saki build provenance must be '${LEGACY_B03_BUILD_ID}'`)
  })

  it('rejects maintenance when neither an Installation manifest nor B03 source exists', async () => {
    const { options, legacy } = await fixture()
    await rm(legacy)

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'fresh Saki state has nothing to maintain',
    })
  })

  it('upgrades a manifest-selected exact v2 generation without mutating it', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedB03(options)
    const before = await readFile(selectedDatabasePath)

    const result = await upgradeSakiInstallation(options, new AbortController().signal)

    expect(result).toMatchObject({ sourceVersion: 2, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      stateVersion: 2,
      sourceBuildId: options.legacyBuildId,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(readInstallationManifest(
      options.installationRoot,
      new AbortController().signal,
    )).resolves.toMatchObject({ value: { phase: 'ready', stateVersion: 9 } })
  })

  it('upgrades a manifest-selected exact v3 generation without mutating it', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV3(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 3, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 3,
      sourceBuildId: V3_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.controlPlane.table('github_project_sync').size).toBe(0)
    expect(current.controlPlane.table('github_sync_configuration_intents').size).toBe(0)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
  })

  it('upgrades a nonempty manifest-selected v4 generation and derives current write admission', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV4(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 4, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 4,
      sourceBuildId: V4_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: { phase: 'ready', stateVersion: 9 },
    })
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()

    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated v7 Registry is missing')
    const project = registry.projects[0]
    const binding = registry.resourceBindings[0]
    const mapping = registry.intentMappings[0]
    if (project === undefined || binding === undefined || mapping === undefined) {
      throw new Error('migrated v7 registered Project aggregate is incomplete')
    }
    expect(project.resourceBindingId).toBe(binding.id)
    expect(binding.projectId).toBe(project.id)
    expect(mapping).toMatchObject({ projectId: project.id, resourceBindingId: binding.id })
    const registration = current.controlPlane.table('registration_intents').get(mapping.intentId)
    expect(registration).toMatchObject({
      phase: 'confirmed',
      projectId: project.id,
      resourceBindingId: binding.id,
    })
    expect(current.controlPlane.table('binding_write_admissions').get(binding.id)).toEqual({
      id: binding.id,
      schemaVersion: 1,
      revision: 0,
      state: 'available',
      updatedAt: binding.observedAt,
    })
    if (registration === undefined) throw new Error('migrated v7 registration Intent is missing')
    expect(current.controlPlane.table('grants').get(registration.payload.actor.grantId)?.actions)
      .toEqual(expect.arrayContaining([
        'project-changes:read',
        'project-diff:read',
        'project-changes:stage',
        'project-changes:unstage',
        'project-commit:create',
      ]))
  })

  it('upgrades an exact v5 generation into reopenable v9 state without mutating the source', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV5(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 5, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 5,
      sourceBuildId: V5_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.controlPlane.table('github_work_item_intents').size).toBe(0)
    expect(current.controlPlane.table('github_work_item_recovery').size).toBe(0)
    expect(current.hostExecution.table('operations').size).toBe(0)
    expect([...current.controlPlane.table('grants').entries()][0]?.[1].actions).toEqual(
      expect.arrayContaining(['work-item:create', 'work-item:move']),
    )
  })

  it('upgrades an exact v6 generation with an unavailable default Agent Profile', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV6(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 6, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 6,
      sourceBuildId: V6_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const registry = current.controlPlane.table('development_project_registry')
      .get('development-project-registry')
    if (registry === undefined) throw new Error('migrated v7 Registry is missing')
    const project = registry.projects[0]
    if (project === undefined) throw new Error('migrated v7 Project is missing')
    expect(registry.agentProfiles).toContainEqual({
      id: project.defaultAgentProfileId,
      projectId: project.id,
      version: 1,
      agentPresetId: 'standard',
      modelRouteRequest: null,
      createdAt: project.createdAt,
    })
    expect([...current.controlPlane.table('grants').entries()][0]?.[1].actions).toContain(
      'work-item:give-to-agent',
    )
    expect(current.hostExecution.table('operations').size).toBe(0)
  })

  it('upgrades an exact v7 generation through Host v2 and the retained v7 backup', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV7(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal
    const source = await readClosedSakiV7State(
      selectedDatabasePath,
      {
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: B03_STORAGE_GENERATION_ID,
        createdByBuildId: V7_SOURCE_BUILD_ID,
      },
      signal,
    )
    expect(source.hostExecution.table('operations').size).toBe(0)

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 7, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 7,
      sourceBuildId: V7_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(verifySakiInstallationBackup(
      options,
      result.backup.manifest.backupId,
      signal,
    )).resolves.toMatchObject({ manifest: { stateVersion: 7 } })
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.stateVersion).toBe(9)
    expect(current.hostExecution.table('operations').size).toBe(0)
    expect(current.controlPlane.table('intervention_requests').size).toBe(0)
    expect(current.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ schemaVersion: 7, stateVersion: 9 })
  })

  it('upgrades an exact v8 generation through Host v3 and the retained v8 backup', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV8(options)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal
    const source = await readClosedSakiV8State(
      selectedDatabasePath,
      {
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: B03_STORAGE_GENERATION_ID,
        createdByBuildId: V8_SOURCE_BUILD_ID,
      },
      signal,
    )
    expect(source.hostExecution.table('operations').size).toBe(0)

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 8, targetVersion: 9 })
    expect(result.backup.manifest).toMatchObject({
      installationId: B03_INSTALLATION_ID,
      storageGenerationId: B03_STORAGE_GENERATION_ID,
      stateVersion: 8,
      sourceBuildId: V8_SOURCE_BUILD_ID,
    })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    await expect(verifySakiInstallationBackup(
      options,
      result.backup.manifest.backupId,
      signal,
    )).resolves.toMatchObject({ manifest: { stateVersion: 8 } })
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    expect(current.stateVersion).toBe(9)
    expect(current.hostExecution.table('operations').size).toBe(0)
    expect(current.controlPlane.table('branch_deliveries').size).toBe(0)
    expect(current.storageGeneration.table('storage_generation').get(STORAGE_GENERATION_KEY))
      .toMatchObject({ schemaVersion: 7, stateVersion: 9 })
  })

  it('migrates a linked running v7 Agent operation and Host v2 record into valid v9 state', async () => {
    const { options } = await fixture()
    const selectedDatabasePath = await publishSelectedV7(options, withRunningPreviousWritableAgent)
    const before = await readFile(selectedDatabasePath)
    const signal = new AbortController().signal
    const source = await readClosedSakiV7State(
      selectedDatabasePath,
      {
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: B03_STORAGE_GENERATION_ID,
        createdByBuildId: V7_SOURCE_BUILD_ID,
      },
      signal,
    )
    expect(source.controlPlane.table('agent_runs').size).toBe(1)
    expect(source.hostExecution.table('operations').size).toBe(1)

    const result = await upgradeSakiInstallation(options, signal)

    expect(result).toMatchObject({ sourceVersion: 7, targetVersion: 9 })
    expect(await readFile(selectedDatabasePath)).toEqual(before)
    const current = await readClosedCurrentSakiState(
      result.selected.databasePath,
      {
        installationId: result.selected.generation.installationId,
        storageGenerationId: result.selected.generation.storageGenerationId,
        createdByBuildId: result.selected.generation.createdByBuildId,
      },
      signal,
    )
    const retainedIntent = current.controlPlane.table('agent_operation_intents').get(AGENT_INTENT_ID)
    expect(current.controlPlane.table('work_assignments').get(ASSIGNMENT_ID)).toMatchObject({
      schemaVersion: 2,
      ownerPrincipalId: retainedIntent?.payload.actor.principalId,
    })
    expect(current.controlPlane.table('agent_runs').get(AGENT_RUN_ID)).toMatchObject({
      schemaVersion: 2,
      state: 'running',
    })
    expect(current.hostExecution.table('operations').get(OPERATION_ID)).toMatchObject({
      schemaVersion: 4,
      snapshot: { state: 'succeeded' },
    })
  }, 20_000)

  it('recovers a pre-backup v7 upgrade journal before retrying the v7-to-v9 upgrade', async () => {
    const { options } = await fixture()
    await publishSelectedV7(options)
    const crash = new Error('crash after v7 journal publication')
    const interrupted = createSakiMaintenanceOperations({
      afterJournalPublication: async () => { throw crash },
    })
    const signal = new AbortController().signal

    await expect(interrupted.upgrade(options, signal)).rejects.toBe(crash)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toMatchObject({
      journal: { kind: 'upgrade', sourceStateVersion: 7 },
    })

    await expect(upgradeSakiInstallation(options, signal)).resolves.toMatchObject({
      sourceVersion: 7,
      targetVersion: 9,
    })
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
  })

  it('requires a ready selected Installation before offline maintenance', async () => {
    const { options } = await fixture()
    await publishSelectedB03(options, 'provisioning')

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'offline maintenance requires a ready Installation; finish provisioning first',
    })
  })

  it('rejects a selected state version that this build cannot read', async () => {
    const { options } = await fixture()
    await publishSelectedB03(options, 'ready', 99)

    await expect(backupSakiInstallation(
      options,
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: 'state-unsupported',
      message: 'Saki state version 99 is not readable by this build',
    })
  })

  it('rejects an Installation authority that appears during a manifest-less upgrade', async () => {
    const { options } = await fixture()
    const signal = new AbortController().signal
    const operations = createSakiMaintenanceOperations({
      beforeManifestPublication: async () => {
        await publishActiveCandidateAuthority(options.installationRoot, signal)
      },
    })

    await expect(operations.upgrade(options, signal)).rejects.toMatchObject({
      code: 'recovery-required',
      message: 'Installation authority appeared during legacy upgrade',
    })
  })

  it.each(['removed', 'changed'] as const)(
    'rejects a selected source authority that is %s during upgrade',
    async (change) => {
      const { options } = await fixture()
      await publishSelectedB03(options)
      const operations = createSakiMaintenanceOperations({
        beforeManifestPublication: async () => {
          if (change === 'removed') {
            await rm(join(options.installationRoot, 'installation.json'))
          } else {
            await rewriteAuthorityPhase(options.installationRoot, 'provisioning')
          }
        },
      })

      await expect(operations.upgrade(
        options,
        new AbortController().signal,
      )).rejects.toMatchObject({
        code: 'recovery-required',
        message: 'source Installation authority changed during upgrade',
      })
    },
  )

  it.each(['removed', 'changed'] as const)(
    'rejects upgraded Installation authority readback when it is %s',
    async (change) => {
      const { options } = await fixture()
      const operations = createSakiMaintenanceOperations({
        afterManifestPublication: async () => {
          if (change === 'removed') {
            await rm(join(options.installationRoot, 'installation.json'))
          } else {
            await rewriteAuthorityPhase(options.installationRoot, 'provisioning')
          }
        },
      })

      await expect(operations.upgrade(
        options,
        new AbortController().signal,
      )).rejects.toMatchObject({
        code: 'recovery-required',
        message: 'upgraded Installation authority changed before operation cleanup',
      })
    },
  )

  it.each(PRE_MANIFEST_CRASH_PHASES)(
    'reopens only the unchanged B03 source after a crash at %s',
    async (phase) => {
      const { options, legacy } = await fixture()
      const before = await readFile(legacy)
      const crash = new Error(`crash at ${phase}`)
      const operations = createSakiMaintenanceOperations({
        [phase]: async () => { throw crash },
      })
      const signal = new AbortController().signal

      await expect(operations.upgrade(options, signal)).rejects.toBe(crash)
      const active = await readActiveOperation(options.installationRoot, signal)
      if (active?.journal.kind !== 'upgrade') throw new Error('crashed upgrade journal is not selected')

      let served = false
      await expect(withPreparedSakiServingState({
        installationRoot: options.installationRoot,
        legacyDatabasePath: options.legacyDatabasePath,
        currentBuildId: options.currentBuildId,
      }, signal, async () => {
        served = true
      })).rejects.toMatchObject({ code: 'upgrade-required' })

      expect(served).toBe(false)
      expect(await readFile(legacy)).toEqual(before)
      await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toBeUndefined()
      await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
      for (const leaf of [
        active.journal.backup.partialLeaf,
        active.journal.backup.finalLeaf,
        active.journal.candidate.partialLeaf,
        active.journal.candidate.finalLeaf,
      ]) {
        expect(await exists(resolve(options.installationRoot, ...leaf.split('/')))).toBe(false)
      }
    },
  )

  it('reopens only the new generation after a crash immediately after manifest publication', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const crash = new Error('crash after manifest publication')
    const operations = createSakiMaintenanceOperations({
      afterManifestPublication: async () => { throw crash },
    })
    const signal = new AbortController().signal

    await expect(operations.upgrade(options, signal)).rejects.toBe(crash)
    const active = await readActiveOperation(options.installationRoot, signal)
    if (active?.journal.kind !== 'upgrade') throw new Error('committed upgrade journal is not selected')
    const candidateStorageGenerationId = active.journal.candidateStorageGenerationId

    await withPreparedSakiServingState({
      installationRoot: options.installationRoot,
      legacyDatabasePath: options.legacyDatabasePath,
      currentBuildId: options.currentBuildId,
    }, signal, async (prepared) => {
      expect(prepared).toMatchObject({
        phase: 'ready',
        installationId: B03_INSTALLATION_ID,
        storageGenerationId: candidateStorageGenerationId,
      })
    })

    expect(await readFile(legacy)).toEqual(before)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    await expect(readInstallationManifest(options.installationRoot, signal)).resolves.toMatchObject({
      value: {
        phase: 'ready',
        storageGenerationId: candidateStorageGenerationId,
      },
    })
    expect(await exists(resolve(
      options.installationRoot,
      ...active.journal.backup.finalLeaf.split('/'),
    ))).toBe(true)
    expect(await exists(resolve(
      options.installationRoot,
      ...active.journal.candidate.finalLeaf.split('/'),
    ))).toBe(true)
  })

  it('settles an interrupted pre-publication upgrade before a maintenance-command retry', async () => {
    const { options, legacy } = await fixture()
    const before = await readFile(legacy)
    const crash = new Error('crash with a complete unselected candidate')
    const interrupted = createSakiMaintenanceOperations({
      afterCandidatePublication: async () => { throw crash },
    })
    const signal = new AbortController().signal

    await expect(interrupted.upgrade(options, signal)).rejects.toBe(crash)
    const first = await readActiveOperation(options.installationRoot, signal)
    if (first?.journal.kind !== 'upgrade') throw new Error('interrupted upgrade journal is not selected')

    const result = await upgradeSakiInstallation(options, signal)

    expect(result.selected.generation.storageGenerationId)
      .not.toBe(first.journal.candidateStorageGenerationId)
    expect(await readFile(legacy)).toEqual(before)
    await expect(readActiveOperation(options.installationRoot, signal)).resolves.toBeUndefined()
    for (const leaf of [
      first.journal.backup.partialLeaf,
      first.journal.backup.finalLeaf,
      first.journal.candidate.partialLeaf,
      first.journal.candidate.finalLeaf,
    ]) {
      expect(await exists(resolve(options.installationRoot, ...leaf.split('/')))).toBe(false)
    }
  })
})
