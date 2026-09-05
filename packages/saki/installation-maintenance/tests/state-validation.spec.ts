import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { describe, expect, it } from 'vitest'
import {
  branchDeliveryId,
  bindingWriteAdmissionRecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  type BindingWriteAdmissionRecord,
  type BranchDeliveryRecord,
  type GitOperationIntentRecord,
  type SakiControlIntentId,
  type SakiDevelopmentProjectId,
  type SakiGrantId,
  type SakiInstallationId,
  type SakiIntentReceiptId,
  type SakiPrincipalId,
  type SakiResourceBindingId,
  type SakiStorageGenerationId,
  type SakiBoardWorkItemId,
} from '@breakfastdapaidang/saki-control-plane'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  canonicalDigest,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  type HostOperationId,
  type HostOperationRequest,
  type HostOperationSnapshot,
  type PushBranchHostOperationRequest,
  type SakiHostId,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiHostExecutionDomainSpec,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'
import {
  validateAgentOperationLinks,
  validateBranchDeliveryOperationLinks,
  validateGitOperationLinks,
} from '../src/state-validation.ts'

const INTENT_ID = 'intent-00000000-0000-4000-8000-000000000071' as SakiControlIntentId
const RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000071' as SakiIntentReceiptId
const OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000071' as HostOperationId
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000072' as SakiDevelopmentProjectId
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000073' as SakiResourceBindingId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002' as SakiHostId
const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000074' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000075' as SakiStorageGenerationId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000076' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000077' as SakiGrantId
const CHANGE = {
  id: `git-change-${'1'.repeat(64)}`,
  fingerprint: { version: 1 as const, digest: '2'.repeat(64) },
}
const ALT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000078' as SakiControlIntentId
const ALT_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000078' as HostOperationId
const ALT_BINDING_ID = 'binding-00000000-0000-4000-8000-000000000078' as SakiResourceBindingId
const TRUSTED_INSPECTION = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1 as const, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
}

const BRANCH_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000171' as SakiControlIntentId
const BRANCH_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000171' as HostOperationId
const BRANCH_WORK_ITEM_ID = `work-item-${'a'.repeat(64)}` as SakiBoardWorkItemId
const BRANCH_COMMIT_ID = 'b'.repeat(40)

type BranchDeliveryIntentRecord = ReturnType<
  (typeof sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema)['parse']
>
type PushHostOperationRecord = Extract<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'push-branch' } }
>

interface BranchPushFixture {
  readonly delivery: BranchDeliveryRecord
  readonly intent: BranchDeliveryIntentRecord
  readonly request: PushBranchHostOperationRequest
  readonly preparation: NonNullable<Extract<BranchDeliveryIntentRecord['checkpoint'], {
    readonly state: 'push-host-accepted'
  }>['preparation']>
  readonly operation: PushHostOperationRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
  readonly reservedAdmission: BindingWriteAdmissionRecord
}

function assertPushHostOperationRecord(
  operation: LocalHostOperationRecord,
  message: string,
): asserts operation is PushHostOperationRecord {
  if (operation.request.type !== 'push-branch') throw new Error(message)
}

function branchPushFixture(): BranchPushFixture {
  const binding = linkedFixture().request.expected.binding
  const deliveryId = branchDeliveryId(PROJECT_ID, BRANCH_WORK_ITEM_ID)
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
    intent: {
      type: 'push-branch-delivery' as const,
      intentId: BRANCH_INTENT_ID,
      deliveryId,
      expectedDeliveryRevision: 0,
    },
    actor,
  }
  const payloadDigest = canonicalDigest('saki/branch-delivery-intent/v1', payload)
  const parsedRequest = hostOperationRequestSchema.parse({
    type: 'push-branch',
    source: { kind: 'control-intent', intentId: BRANCH_INTENT_ID, intentRevision: 0, payloadDigest },
    expected: {
      binding,
      commitId: BRANCH_COMMIT_ID,
      repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
    },
    targetRef: 'refs/heads/feature/offline-validation',
  })
  if (parsedRequest.type !== 'push-branch') throw new Error('Branch Push fixture parsed as another Host operation')
  const request = parsedRequest
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  const operationReference = { id: BRANCH_OPERATION_ID, hostId: HOST_ID, type: 'push-branch' as const }
  const preparation = { operation: operationReference, preparationRevision: 0, requestFingerprint }
  const preparedSnapshot = hostOperationSnapshotSchema.parse({
    operation: operationReference,
    revision: 0,
    source: request.source,
    requestFingerprint,
    bindingId: BINDING_ID,
    bindingRevision: binding.revision,
    preparedAt: 3,
    updatedAt: 3,
    state: 'prepared',
    admission: { kind: 'not-accepted' },
  }) as HostOperationSnapshot<'push-branch'>
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    id: deliveryId,
    schemaVersion: 1,
    revision: 1,
    projectId: PROJECT_ID,
    workItemId: BRANCH_WORK_ITEM_ID,
    target: {
      registryRevision: 1,
      projectRevision: 1,
      binding,
      synchronizationRevision: 1,
      mappingRevision: 1,
      installation: {
        appId: '1',
        installationId: '2',
        accountId: 'A_fixture',
        privateKeyRef: credentialRef('SAKI_GITHUB_PRIVATE_KEY'),
      },
      repository: { id: 'R_fixture', databaseId: '3', nameWithOwner: 'BreakfastDaPaiDang/saki' },
      workItem: {
        id: BRANCH_WORK_ITEM_ID,
        remoteFingerprint: `remote-fingerprint-${'c'.repeat(64)}`,
        issueId: 'I_fixture',
      },
    },
    commitId: BRANCH_COMMIT_ID,
    headRef: request.targetRef,
    baseRef: 'refs/heads/master',
    markerId: `pull-request-marker-${canonicalDigest(
      'saki/branch-delivery/pull-request-marker/v1',
      { deliveryId },
    )}`,
    phase: 'draft',
    activeIntentId: BRANCH_INTENT_ID,
    remoteRef: { current: { state: 'unobserved' } },
    pullRequest: { current: { state: 'unobserved' } },
    reviews: { current: { state: 'unobserved' } },
    ci: { current: { state: 'unobserved' } },
    lastIntentId: BRANCH_INTENT_ID,
    createdAt: 1,
    updatedAt: 2,
  })
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    id: BRANCH_INTENT_ID,
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
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 4,
    request,
    preparationRevision: preparation.preparationRevision,
    snapshot: preparedSnapshot,
  })
  assertPushHostOperationRecord(operation, 'Branch Push fixture stored another operation')
  const reservedAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
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
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 0,
    state: 'available',
    updatedAt: 1,
  })
  return { delivery, intent, request, preparation, operation, availableAdmission, reservedAdmission }
}

function acceptedBranchPushFixture(fixture = branchPushFixture()): BranchPushFixture & {
  readonly operation: PushHostOperationRecord
  readonly acceptedAdmission: BindingWriteAdmissionRecord
} {
  const acceptedAt = 4
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: 1,
    state: 'accepted',
    admission: { kind: 'accepted', revision: 2, acceptedAt },
    updatedAt: acceptedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
  })
  assertPushHostOperationRecord(operation, 'Accepted Branch Push fixture changed kind')
  const acceptedAdmission = bindingWriteAdmissionRecordSchema.parse({
    ...fixture.reservedAdmission,
    revision: 2,
    phase: 'accepted',
    preparation: fixture.preparation,
    acceptedAt,
    updatedAt: acceptedAt,
  })
  return { ...fixture, operation, acceptedAdmission }
}

function acceptedAdmissionBeforeBranchCheckpointFixture(fixture = branchPushFixture()): BranchPushFixture & {
  readonly acceptedAdmission: BindingWriteAdmissionRecord
} {
  const acceptedAt = 4
  return {
    ...fixture,
    acceptedAdmission: bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      preparation: fixture.preparation,
      acceptedAt,
      updatedAt: acceptedAt,
    }),
  }
}

function checkpointedBranchPushFixture(fixture = acceptedBranchPushFixture()): ReturnType<
  typeof acceptedBranchPushFixture
> & { readonly intent: BranchDeliveryIntentRecord } {
  return {
    ...fixture,
    intent: sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      revision: 2,
      checkpoint: {
        state: 'push-host-accepted',
        deliveryRevision: fixture.delivery.revision,
        preparation: fixture.preparation,
        admissionRevision: fixture.acceptedAdmission.revision,
      },
      updatedAt: 4,
    }),
  }
}

function hostStartPendingBranchPushFixture(
  fixture = acceptedAdmissionBeforeBranchCheckpointFixture(),
): ReturnType<typeof acceptedAdmissionBeforeBranchCheckpointFixture> & {
  readonly intent: BranchDeliveryIntentRecord
} {
  return checkpointedBranchPushFixture(fixture)
}

function terminalHostBeforeBranchCheckpointFixture(
  state: 'failed' | 'canceled',
  fixture = checkpointedBranchPushFixture(),
): ReturnType<typeof checkpointedBranchPushFixture> & {
  readonly delivery: BranchDeliveryRecord
  readonly operation: PushHostOperationRecord
} {
  const completedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: fixture.operation.snapshot.revision + 1,
    state,
    completedAt,
    ...(state === 'failed'
      ? { failure: { reason: 'binding-stale' as const }, effect: 'none' as const }
      : { reason: 'authority-revoked' as const, effect: 'none' as const }),
    updatedAt: completedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
  })
  assertPushHostOperationRecord(operation, 'Terminal Branch Push fixture changed kind')
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    lastIntentId: fixture.intent.id,
    updatedAt: completedAt,
  })
  return { ...fixture, delivery, operation }
}

function preEffectCanceledBeforeBranchCheckpointFixture(
  fixture = checkpointedBranchPushFixture(),
): ReturnType<typeof checkpointedBranchPushFixture> & {
  readonly delivery: BranchDeliveryRecord
  readonly operation: PushHostOperationRecord
} {
  const completedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...branchPushFixture().operation.snapshot,
    revision: 1,
    state: 'canceled',
    completedAt,
    reason: 'source-canceled',
    effect: 'none',
    updatedAt: completedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
  })
  assertPushHostOperationRecord(operation, 'Pre-effect canceled Branch Push fixture changed kind')
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    lastIntentId: fixture.intent.id,
    updatedAt: completedAt,
  })
  return { ...fixture, delivery, operation }
}

function repairedBeforeBranchCheckpointFixture(
  fixture = checkpointedBranchPushFixture(),
): ReturnType<typeof checkpointedBranchPushFixture> & {
  readonly delivery: BranchDeliveryRecord
  readonly operation: PushHostOperationRecord
} {
  const result = {
    type: 'push-branch' as const,
    repository: fixture.request.expected.repository,
    targetRef: fixture.request.targetRef,
    commitId: fixture.request.expected.commitId,
    previous: { kind: 'absent' as const },
    credential: { helperId: 'git-credential-manager' as const },
  }
  const observedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: fixture.operation.snapshot.revision + 1,
    state: 'reconciliation-required',
    observedAt,
    reason: 'effect-unknown',
    updatedAt: observedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
    effectPlan: { kind: 'push-branch', publication: 'attempting', result },
  })
  assertPushHostOperationRecord(operation, 'Reconciliation Branch Push fixture changed kind')
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    repair: { intentId: fixture.intent.id, reason: 'effect-unknown', recordedAt: observedAt + 1 },
    lastIntentId: fixture.intent.id,
    updatedAt: observedAt + 1,
  })
  return { ...fixture, delivery, operation }
}

function terminalPreEffectCanceledBranchPushFixture(
  fixture = preEffectCanceledBeforeBranchCheckpointFixture(),
): ReturnType<typeof preEffectCanceledBeforeBranchCheckpointFixture> & {
  readonly intent: BranchDeliveryIntentRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
} {
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    ...fixture.intent,
    revision: fixture.intent.revision + 1,
    checkpoint: {
      state: 'terminal',
      outcome: 'failure',
      reason: 'host-operation',
      deliveryRevision: fixture.delivery.revision,
      host: { preparation: fixture.preparation, snapshot: fixture.operation.snapshot },
    },
    updatedAt: fixture.operation.snapshot.updatedAt,
  })
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 3,
    state: 'available',
    updatedAt: fixture.operation.snapshot.updatedAt + 1,
  })
  return { ...fixture, intent, availableAdmission }
}

function appliedBranchPushFixture(fixture = checkpointedBranchPushFixture()): ReturnType<
  typeof checkpointedBranchPushFixture
> & {
  readonly delivery: BranchDeliveryRecord
  readonly operation: PushHostOperationRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
} {
  const result = {
    type: 'push-branch' as const,
    repository: fixture.request.expected.repository,
    targetRef: fixture.request.targetRef,
    commitId: fixture.request.expected.commitId,
    previous: { kind: 'absent' as const },
    credential: { helperId: 'git-credential-manager' as const },
  }
  const completedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: 2,
    state: 'succeeded',
    completedAt,
    result,
    updatedAt: completedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
    effectPlan: { kind: 'push-branch', publication: 'applied-recorded', result },
  })
  assertPushHostOperationRecord(operation, 'Applied Branch Push fixture changed kind')
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    push: { intentId: fixture.intent.id, result, confirmedAt: completedAt },
    lastIntentId: fixture.intent.id,
    updatedAt: completedAt,
  })
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 3,
    state: 'available',
    updatedAt: 7,
  })
  return { ...fixture, delivery, operation, availableAdmission }
}

function terminalBranchPushFixture(fixture = appliedBranchPushFixture()): ReturnType<
  typeof appliedBranchPushFixture
> & { readonly intent: BranchDeliveryIntentRecord } {
  return {
    ...fixture,
    intent: sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      revision: 3,
      checkpoint: {
        state: 'terminal',
        outcome: 'succeeded',
        deliveryRevision: fixture.delivery.revision,
        host: { preparation: fixture.preparation, snapshot: fixture.operation.snapshot },
      },
      updatedAt: fixture.operation.snapshot.updatedAt,
    }),
  }
}

function repairedBranchDelivery(
  fixture: BranchPushFixture,
  reason: 'effect-unknown' | 'evidence-conflict',
  recordedAt: number,
): BranchDeliveryRecord {
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  return sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    repair: { intentId: fixture.intent.id, reason, recordedAt },
    lastIntentId: fixture.intent.id,
    updatedAt: recordedAt,
  })
}

function sourceConflictedBranchPushFixture(fixture = branchPushFixture()): BranchPushFixture & {
  readonly delivery: BranchDeliveryRecord
  readonly intent: BranchDeliveryIntentRecord
  readonly operation: PushHostOperationRecord
} {
  const recordedAt = 4
  const delivery = repairedBranchDelivery(fixture, 'evidence-conflict', recordedAt)
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    ...fixture.intent,
    revision: 2,
    checkpoint: {
      state: 'terminal',
      outcome: 'reconciliation-required',
      deliveryRevision: delivery.revision,
      reason: 'evidence-conflict',
    },
    updatedAt: recordedAt,
  })
  const parsedRequest = hostOperationRequestSchema.parse({
    ...fixture.request,
    expected: {
      ...fixture.request.expected,
      repository: { nameWithOwner: 'BreakfastDaPaiDang/other' },
    },
  })
  if (parsedRequest.type !== 'push-branch') throw new Error('Conflicted Branch Push fixture changed kind')
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', parsedRequest),
  }
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 4,
    request: parsedRequest,
    preparationRevision: 0,
    snapshot: {
      ...fixture.operation.snapshot,
      requestFingerprint,
    },
  })
  assertPushHostOperationRecord(operation, 'Conflicted Branch Push operation changed kind')
  return { ...fixture, delivery, intent, operation }
}

function reconciliationBranchPushFixture(fixture = checkpointedBranchPushFixture()): ReturnType<
  typeof checkpointedBranchPushFixture
> & {
  readonly delivery: BranchDeliveryRecord
  readonly intent: BranchDeliveryIntentRecord
  readonly operation: PushHostOperationRecord
} {
  const result = {
    type: 'push-branch' as const,
    repository: fixture.request.expected.repository,
    targetRef: fixture.request.targetRef,
    commitId: fixture.request.expected.commitId,
    previous: { kind: 'absent' as const },
    credential: { helperId: 'git-credential-manager' as const },
  }
  const observedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: 2,
    state: 'reconciliation-required',
    observedAt,
    reason: 'effect-unknown',
    updatedAt: observedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
    effectPlan: { kind: 'push-branch', publication: 'attempting', result },
  })
  assertPushHostOperationRecord(operation, 'Reconciliation Branch Push operation changed kind')
  const delivery = repairedBranchDelivery(fixture, 'effect-unknown', observedAt)
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    ...fixture.intent,
    revision: 3,
    checkpoint: {
      state: 'terminal',
      outcome: 'reconciliation-required',
      deliveryRevision: delivery.revision,
      reason: 'effect-unknown',
      host: { preparation: fixture.preparation, snapshot },
    },
    updatedAt: observedAt,
  })
  return { ...fixture, delivery, intent, operation }
}

function failedBranchPushFixture(fixture = checkpointedBranchPushFixture()): ReturnType<
  typeof checkpointedBranchPushFixture
> & {
  readonly delivery: BranchDeliveryRecord
  readonly intent: BranchDeliveryIntentRecord
  readonly operation: PushHostOperationRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
} {
  const completedAt = 6
  const snapshot = hostOperationSnapshotSchema.parse({
    ...fixture.operation.snapshot,
    revision: 2,
    state: 'failed',
    completedAt,
    failure: { reason: 'unsupported-state' },
    effect: 'none',
    updatedAt: completedAt,
  })
  const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    ...fixture.operation,
    snapshot,
  })
  assertPushHostOperationRecord(operation, 'Failed Branch Push operation changed kind')
  const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
  const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
    ...deliveryWithoutActive,
    revision: fixture.delivery.revision + 1,
    lastIntentId: fixture.intent.id,
    updatedAt: completedAt,
  })
  const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
    ...fixture.intent,
    revision: 3,
    checkpoint: {
      state: 'terminal',
      outcome: 'failure',
      deliveryRevision: delivery.revision,
      reason: 'host-operation',
      host: { preparation: fixture.preparation, snapshot },
    },
    updatedAt: completedAt,
  })
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: fixture.acceptedAdmission.revision + 1,
    state: 'available',
    updatedAt: completedAt + 1,
  })
  return { ...fixture, delivery, intent, operation, availableAdmission }
}

type GitHostOperationRequest = HostOperationRequest<'stage-files' | 'unstage-files' | 'commit'>

interface LinkedFixture {
  readonly intent: GitOperationIntentRecord
  readonly request: GitHostOperationRequest
  readonly preparation: NonNullable<GitOperationIntentRecord['preparation']>
  readonly preparedSnapshot: HostOperationSnapshot
  readonly operation: LocalHostOperationRecord
  readonly reservedAdmission: BindingWriteAdmissionRecord
  readonly availableAdmission: BindingWriteAdmissionRecord
}

function linkedFixture(requestType: GitHostOperationRequest['type'] = 'stage-files'): LinkedFixture {
  const expectation = {
    projectId: PROJECT_ID,
    expectedRegistryRevision: 1,
    expectedProjectRevision: 0,
    expectedBinding: { id: BINDING_ID, revision: 0 },
    expectedStatus: { version: 1 as const, digest: '5'.repeat(64) },
    expectedHead: { kind: 'commit' as const, objectId: '6'.repeat(40), symbolicRef: 'refs/heads/main' },
    expectedIndex: { kind: 'tree' as const, treeId: '7'.repeat(40) },
    expectedWorktree: { version: 1 as const, digest: '8'.repeat(64) },
  }
  const browserIntent = requestType === 'commit'
    ? {
      type: 'create-commit' as const,
      intentId: INTENT_ID,
      expected: expectation,
      message: 'subject',
    }
    : {
      type: requestType,
      intentId: INTENT_ID,
      expected: expectation,
      changes: [CHANGE],
    }
  const payload = {
    intent: browserIntent,
    actor: {
      installationId: INSTALLATION_ID,
      storageGenerationId: STORAGE_GENERATION_ID,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      principalRevision: 1,
      grantId: GRANT_ID,
      grantRevision: 1,
    },
  }
  const payloadDigest = canonicalDigest('saki/git-operation-intent/v1', payload)
  const source = { kind: 'control-intent' as const, intentId: INTENT_ID, intentRevision: 0, payloadDigest }
  const expected = {
    binding: {
      id: BINDING_ID,
      revision: 0,
      health: 'active' as const,
      hostId: HOST_ID,
      workspaceId: 'workspace-fixture',
      expectedInspection: {
        projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
        trusted: TRUSTED_INSPECTION,
      },
      inheritedChangeBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
    },
    status: browserIntent.expected.expectedStatus,
    head: browserIntent.expected.expectedHead,
    index: browserIntent.expected.expectedIndex,
    worktree: browserIntent.expected.expectedWorktree,
    preEffectBaseline: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection.baseline,
  }
  const parsedRequest = hostOperationRequestSchema.parse(requestType === 'commit'
    ? { type: requestType, source, expected, message: browserIntent.message }
    : { type: requestType, source, expected, changes: browserIntent.changes })
  if (parsedRequest.type === 'start-agent-run' || parsedRequest.type === 'push-branch') {
    throw new Error('Git operation fixture parsed as an unsupported Host operation')
  }
  const request = parsedRequest
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  const operation = { id: OPERATION_ID, hostId: HOST_ID, type: requestType }
  const preparation = { operation, preparationRevision: 0, requestFingerprint }
  const preparedSnapshot = hostOperationSnapshotSchema.parse({
    operation,
    revision: 0,
    source: request.source,
    requestFingerprint,
    bindingId: BINDING_ID,
    bindingRevision: 0,
    preparedAt: 2,
    updatedAt: 2,
    state: 'prepared' as const,
    admission: { kind: 'not-accepted' as const },
  })
  const intent = gitOperationIntentRecordSchema.parse({
    id: INTENT_ID,
    schemaVersion: 1,
    revision: 2,
    receiptId: RECEIPT_ID,
    payloadDigest,
    payload,
    requestRevision: 0,
    hostRequest: request,
    phase: 'host-prepared',
    reservationRevision: 1,
    preparation,
    operationSnapshot: preparedSnapshot,
    createdAt: 1,
    updatedAt: 2,
  })
  const operationRecord = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
    schemaVersion: 4,
    request,
    preparationRevision: 0,
    snapshot: preparedSnapshot,
  })
  const reservedAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: 0,
    source: request.source,
    action: requestType === 'stage-files'
      ? 'project-changes:stage'
      : requestType === 'unstage-files' ? 'project-changes:unstage' : 'project-commit:create',
    reservedAt: 2,
    updatedAt: 2,
  })
  const availableAdmission = bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 3,
    state: 'available',
    updatedAt: 4,
  })
  return {
    intent,
    request,
    preparation,
    preparedSnapshot,
    operation: operationRecord,
    reservedAdmission,
    availableAdmission,
  }
}

function sourceConflictIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 2,
    phase: 'conflict',
    reservationRevision: 1,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: 'source-conflict',
    updatedAt: 3,
  })
}

function admissionReservedIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 1,
    phase: 'admission-reserved',
    preparation: undefined,
    operationSnapshot: undefined,
    updatedAt: 2,
  })
}

function preHostConflictIntent(
  fixture: LinkedFixture,
  reason: 'expected-evidence' | 'invalid-selection' = 'expected-evidence',
): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 0,
    hostRequest: undefined,
    phase: 'conflict',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: reason,
    updatedAt: 1,
  })
}

function preparedIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 0,
    phase: 'prepared',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    updatedAt: 1,
  })
}

function canceledBeforePreparationIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    phase: 'canceled',
    reservationRevision: undefined,
    preparation: undefined,
    operationSnapshot: undefined,
    terminalReason: 'source-canceled',
    updatedAt: 2,
  })
}

function preparedProtocolConflictIntent(fixture: LinkedFixture): GitOperationIntentRecord {
  return gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 3,
    phase: 'conflict',
    terminalReason: 'protocol',
    updatedAt: 3,
  })
}

function preparedOperation(request: GitHostOperationRequest, updatedAt = 2): LocalHostOperationRecord {
  const requestFingerprint = {
    version: 1 as const,
    digest: canonicalDigest('saki/host-operation-request/v1', request),
  }
  return {
    schemaVersion: 4,
    request,
    preparationRevision: 0,
    snapshot: {
      operation: { id: OPERATION_ID, hostId: HOST_ID, type: request.type },
      revision: 0,
      source: request.source,
      requestFingerprint,
      bindingId: BINDING_ID,
      bindingRevision: 0,
      preparedAt: 2,
      updatedAt,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as HostOperationSnapshot,
  }
}

function mismatchedOperation(fixture: LinkedFixture): LocalHostOperationRecord {
  const request = hostOperationRequestSchema.parse({
    ...fixture.request,
    expected: {
      ...fixture.request.expected,
      status: { version: 1, digest: '9'.repeat(64) },
    },
  })
  if (request.type === 'start-agent-run' || request.type === 'push-branch') {
    throw new Error('Git operation fixture parsed as an unsupported Host operation')
  }
  return preparedOperation(request)
}

function canceledFixture(fixture: LinkedFixture): {
  readonly intent: GitOperationIntentRecord
  readonly operation: LocalHostOperationRecord
} {
  const snapshot = {
    ...fixture.preparedSnapshot,
    revision: 1,
    updatedAt: 4,
    state: 'canceled' as const,
    admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
    completedAt: 4,
    reason: 'authority-revoked' as const,
    effect: 'none' as const,
  }
  const intent = gitOperationIntentRecordSchema.parse({
    ...fixture.intent,
    revision: 4,
    phase: 'canceled',
    admissionRevision: 2,
    operationSnapshot: snapshot,
    terminalReason: 'authority-revoked',
    updatedAt: 4,
  })
  return {
    intent,
    operation: { ...fixture.operation, snapshot },
  }
}

function acceptedFixture(fixture: LinkedFixture): {
  readonly intent: GitOperationIntentRecord
  readonly operation: LocalHostOperationRecord
  readonly admission: BindingWriteAdmissionRecord
} {
  const snapshot = {
    ...fixture.preparedSnapshot,
    revision: 1,
    updatedAt: 3,
    state: 'accepted' as const,
    admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
  }
  return {
    intent: gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      revision: 3,
      phase: 'accepted',
      admissionRevision: 2,
      operationSnapshot: snapshot,
      updatedAt: 3,
    }),
    operation: { ...fixture.operation, snapshot },
    admission: bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      preparation: fixture.preparation,
      acceptedAt: 3,
      updatedAt: 3,
    }),
  }
}

function domains(
  intents: readonly GitOperationIntentRecord[],
  operations: readonly LocalHostOperationRecord[],
  admissions: readonly BindingWriteAdmissionRecord[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  return domainsFromEntries(
    intents.map(intent => [intent.id, intent] as const),
    operations.map(operation => [operation.snapshot.operation.id, operation] as const),
    admissions.map(admission => [admission.id, admission] as const),
  )
}

function domainsFromEntries(
  intents: readonly (readonly [string, GitOperationIntentRecord])[],
  operations: readonly (readonly [string, LocalHostOperationRecord])[],
  admissions: readonly (readonly [string, BindingWriteAdmissionRecord])[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  const controlTables = new Map<string, ReturnType<typeof readonlyTable>>([
    ['git_operation_intents', readonlyTable(intents)],
    ['agent_runs', readonlyTable([])],
    ['execution_dispatches', readonlyTable([])],
    ['binding_write_admissions', readonlyTable(admissions)],
  ])
  const operationTable = readonlyTable(operations)
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: string) => controlTables.get(name),
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const hostExecution = {
    name: sakiHostExecutionDomainSpec.name,
    table: () => operationTable,
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiHostExecutionDomainSpec>
  return [controlPlane, hostExecution]
}

function readonlyTable(entries: readonly (readonly [string, unknown])[]) {
  const records = new Map(entries)
  return {
    get size() { return records.size },
    get: (key: string) => records.get(key),
    entries: () => new Map(records).entries(),
    keys: () => new Map(records).keys(),
  }
}

function branchDomains(
  deliveries: readonly BranchDeliveryRecord[],
  intents: readonly BranchDeliveryIntentRecord[],
  operations: readonly LocalHostOperationRecord[],
  admissions: readonly BindingWriteAdmissionRecord[],
): readonly [Domain<typeof sakiControlPlaneDomainSpec>, Domain<typeof sakiHostExecutionDomainSpec>] {
  const controlTables = new Map<string, ReturnType<typeof readonlyTable>>([
    ['branch_deliveries', readonlyTable(deliveries.map(record => [record.id, record]))],
    ['branch_delivery_intents', readonlyTable(intents.map(record => [record.id, record]))],
    ['binding_write_admissions', readonlyTable(admissions.map(record => [record.id, record]))],
  ])
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: string) => controlTables.get(name),
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const hostExecution = {
    name: sakiHostExecutionDomainSpec.name,
    table: () => readonlyTable(operations.map(record => [record.snapshot.operation.id, record])),
    close: () => Promise.resolve(),
  } as unknown as Domain<typeof sakiHostExecutionDomainSpec>
  return [controlPlane, hostExecution]
}

function foreignBranchWriteAdmission(fixture = branchPushFixture()): BindingWriteAdmissionRecord {
  return bindingWriteAdmissionRecordSchema.parse({
    id: BINDING_ID,
    schemaVersion: 1,
    revision: 1,
    state: 'manual-host-operation',
    phase: 'reserved',
    bindingRevision: fixture.request.expected.binding.revision,
    source: {
      ...fixture.request.source,
      intentId: ALT_INTENT_ID,
      payloadDigest: '9'.repeat(64),
    },
    action: 'project-changes:stage',
    reservedAt: 2,
    updatedAt: 2,
  })
}

describe('current Saki Branch Push cross-domain validation', () => {
  it('leaves ordinary Git Host Operations to their own validator', () => {
    const [control, host] = branchDomains([], [], [linkedFixture().operation], [])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) }).not.toThrow()
  })

  it('does not demand a Push Host record for an In Review Intent', () => {
    const fixture = branchPushFixture()
    const payload = {
      ...fixture.intent.payload,
      intent: {
        type: 'mark-branch-delivery-in-review', intentId: fixture.intent.id,
        deliveryId: fixture.delivery.id, expectedDeliveryRevision: 0,
        expectedWorkItemRemoteFingerprint: fixture.delivery.target.workItem.remoteFingerprint,
      },
    }
    const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent, payload,
      payloadDigest: canonicalDigest('saki/branch-delivery-intent/v1', payload),
      operation: { kind: 'in-review' }, checkpoint: { state: 'prepared' },
    })
    const [control, host] = branchDomains([fixture.delivery], [intent], [], [fixture.availableAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) }).not.toThrow()
  })

  it('rejects a terminal Push after its Binding admission disappears', () => {
    const fixture = terminalBranchPushFixture()
    const [control, host] = branchDomains([fixture.delivery], [fixture.intent], [fixture.operation], [])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('rejects an accepted checkpoint when a different Intent owns the Delivery', () => {
    const fixture = checkpointedBranchPushFixture()
    const [control, host] = branchDomains([
      { ...fixture.delivery, activeIntentId: ALT_INTENT_ID },
    ], [fixture.intent], [fixture.operation], [fixture.acceptedAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it.each(['failed', 'canceled'] as const)('retains a no-effect source conflict with a %s Host record', (state) => {
    const fixture = sourceConflictedBranchPushFixture()
    const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: {
        ...fixture.operation.snapshot, state, revision: 1, updatedAt: 4, completedAt: 4, effect: 'none',
        ...(state === 'failed' ? { failure: { reason: 'binding-stale' } } : { reason: 'source-canceled' }),
      },
    })
    const [control, host] = branchDomains([fixture.delivery], [fixture.intent], [operation], [fixture.reservedAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) }).not.toThrow()
  })

  it.each(['prepared', 'denied'] as const)('accepts a %s Push without Host or reserved admission', (state) => {
    const fixture = branchPushFixture()
    const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      checkpoint: state === 'prepared' ? { state } : { state: 'terminal', outcome: state, reason: 'authority' },
    })
    const [control, host] = branchDomains([fixture.delivery], [intent], [], [fixture.availableAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) }).not.toThrow()
  })

  it.each([
    ['missing Delivery', (f: BranchPushFixture) => branchDomains([], [f.intent], [f.operation], [f.reservedAdmission]),
      'Branch Push Intent has no Branch Delivery'],
    ['missing admission before Host preparation', (f: BranchPushFixture) => branchDomains([f.delivery], [f.intent], [], []),
      'Branch Push Intent has no Host Operation'],
    ['missing Delivery before Host preparation', (f: BranchPushFixture) => branchDomains([], [f.intent], [], []),
      'Branch Push Intent has no Host Operation'],
    ['another active Delivery owner', (f: BranchPushFixture) => branchDomains([
      { ...f.delivery, activeIntentId: ALT_INTENT_ID },
    ], [f.intent], [], [f.reservedAdmission]), 'Branch Push Intent has no Host Operation'],
    ['prepared Intent with a Host record', (f: BranchPushFixture) => branchDomains([f.delivery], [
      { ...f.intent, checkpoint: { state: 'prepared' } },
    ], [f.operation], [f.reservedAdmission]), 'Branch Push checkpoint has no exact Host and admission window'],
    ['active admission with a different Binding revision', (f: BranchPushFixture) => branchDomains([f.delivery], [f.intent],
      [f.operation], [bindingWriteAdmissionRecordSchema.parse({ ...f.reservedAdmission, bindingRevision: 1 })]),
    'Branch Push checkpoint has no exact Host and admission window'],
  ])('rejects %s in detached Push recovery state', (_name, domainsFor, message) => {
    const [control, host] = domainsFor(branchPushFixture())
    expect(() => { validateBranchDeliveryOperationLinks(control, host) }).toThrow(message)
  })

  it('rejects a persisted Branch Delivery whose key disagrees with its identity', () => {
    const fixture = branchPushFixture()
    const [control, host] = branchDomains([fixture.delivery], [], [], [])
    const malformed = {
      ...control,
      table: () => readonlyTable([['wrong-key', fixture.delivery]]),
    } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
    expect(() => { validateBranchDeliveryOperationLinks(malformed, host) })
      .toThrow('Saki Branch Delivery id disagrees with its table key')
  })

  it('rejects a persisted Push Host record whose table key disagrees with its identity', () => {
    const fixture = branchPushFixture()
    const [control, host] = branchDomains([fixture.delivery], [fixture.intent], [], [fixture.reservedAdmission])
    const malformed = {
      ...host,
      table: () => readonlyTable([['wrong-key', fixture.operation]]),
    } as unknown as Domain<typeof sakiHostExecutionDomainSpec>
    expect(() => { validateBranchDeliveryOperationLinks(control, malformed) })
      .toThrow('Saki Host Operation id disagrees with its table key')
  })

  it('rejects a Push Host identity that was not derived from its Intent', () => {
    const fixture = branchPushFixture()
    const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: { ...fixture.operation.snapshot, operation: { ...fixture.preparation.operation, id: ALT_OPERATION_ID } },
    })
    assertPushHostOperationRecord(operation, 'Host identity fixture changed operation type')
    const [control, host] = branchDomains([fixture.delivery], [fixture.intent], [operation], [fixture.reservedAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) })
      .toThrow('Branch Push Host Operation id disagrees with its Intent source')
  })

  it.each(['accepted', 'missing', 'foreign'] as const)(
    'checks the %s Binding admission after Delivery publication and before Intent completion', (state) => {
      const fixture = appliedBranchPushFixture()
      const admissions = state === 'accepted' ? [fixture.acceptedAdmission]
        : state === 'missing' ? [] : [foreignBranchWriteAdmission(fixture)]
      const [control, host] = branchDomains([fixture.delivery], [fixture.intent], [fixture.operation], admissions)
      const validate = () => { validateBranchDeliveryOperationLinks(control, host) }
      if (state === 'accepted') expect(validate).not.toThrow()
      else expect(validate).toThrow('Branch Push checkpoint has no exact Host and admission window')
    },
  )

  it('rejects terminal succeeded Push evidence after its applied Delivery fact disappears', () => {
    const fixture = terminalBranchPushFixture()
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...fixture.delivery, push: undefined, phase: 'draft',
    })
    const [control, host] = branchDomains([delivery], [fixture.intent], [fixture.operation], [fixture.availableAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(control, host) })
      .toThrow('terminal Branch Push disagrees with its applied Delivery evidence')
  })

  it('accepts an active Push before its Binding admission is reserved', () => {
    const fixture = branchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [],
      [fixture.availableAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts an active Push waiting behind another Binding admission owner', () => {
    const fixture = branchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [],
      [foreignBranchWriteAdmission(fixture)],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it.each([
    ['available', (fixture: BranchPushFixture) => fixture.availableAdmission],
    ['foreign', (fixture: BranchPushFixture) => foreignBranchWriteAdmission(fixture)],
  ] as const)(
    'accepts Push cleanup before Intent completion while the Binding admission is %s',
    (_state, admissionFor) => {
      const fixture = branchPushFixture()
      const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
      const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
        ...deliveryWithoutActive,
        revision: fixture.delivery.revision + 1,
        updatedAt: 3,
      })
      const [controlPlane, hostExecution] = branchDomains(
        [delivery],
        [fixture.intent],
        [],
        [admissionFor(fixture)],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('rejects Push cleanup before Intent completion while its own admission remains reserved', () => {
    const fixture = branchPushFixture()
    const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...deliveryWithoutActive,
      revision: fixture.delivery.revision + 1,
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [delivery],
      [fixture.intent],
      [],
      [fixture.reservedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push Intent has no Host Operation')
  })

  it('accepts direct Push cancellation without releasing another admission owner', () => {
    const fixture = branchPushFixture()
    const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...deliveryWithoutActive,
      revision: fixture.delivery.revision + 1,
      updatedAt: 3,
    })
    const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      revision: fixture.intent.revision + 1,
      checkpoint: {
        state: 'terminal',
        outcome: 'conflict',
        reason: 'expected-evidence',
        deliveryRevision: delivery.revision,
      },
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [delivery],
      [intent],
      [],
      [foreignBranchWriteAdmission(fixture)],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a reserved active Push before the Host preparation is durable', () => {
    const fixture = branchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [],
      [fixture.reservedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts the Host-first prepared gap while the Branch Intent retains its reservation', () => {
    const fixture = branchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.reservedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts Control admission before the Branch Intent checkpoints the prepared Host operation', () => {
    const fixture = acceptedAdmissionBeforeBranchCheckpointFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects Host admission before the Branch Intent checkpoints its preparation', () => {
    const fixture = acceptedBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it.each([
    ['operation identity', (fixture: ReturnType<typeof acceptedAdmissionBeforeBranchCheckpointFixture>) => ({
      ...fixture.preparation,
      operation: { ...fixture.preparation.operation, id: ALT_OPERATION_ID },
    })],
    ['preparation revision', (fixture: ReturnType<typeof acceptedAdmissionBeforeBranchCheckpointFixture>) => ({
      ...fixture.preparation,
      preparationRevision: fixture.preparation.preparationRevision + 1,
    })],
    ['request fingerprint', (fixture: ReturnType<typeof acceptedAdmissionBeforeBranchCheckpointFixture>) => ({
      ...fixture.preparation,
      requestFingerprint: { ...fixture.preparation.requestFingerprint, digest: '8'.repeat(64) },
    })],
  ])('rejects an accepted pre-checkpoint admission with a mismatched %s', (_name, mismatch) => {
    const fixture = acceptedAdmissionBeforeBranchCheckpointFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.acceptedAdmission,
      preparation: mismatch(fixture),
    })
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [admission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('accepts the checkpointed Push while the exact Host operation and admission remain current', () => {
    const fixture = checkpointedBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a checkpointed Push after Control admission acceptance and before Host start', () => {
    const fixture = hostStartPendingBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it.each(['failed', 'canceled'] as const)(
    'accepts Delivery cleanup after a %s Host result and before the Branch Intent acknowledges it',
    (state) => {
      const fixture = terminalHostBeforeBranchCheckpointFixture(state)
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [fixture.intent],
        [fixture.operation],
        [fixture.acceptedAdmission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('accepts Delivery cleanup after a pre-effect Host cancellation and before Intent acknowledgement', () => {
    const fixture = preEffectCanceledBeforeBranchCheckpointFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it.each(['accepted', 'released'] as const)(
    'accepts a terminal pre-effect Host cancellation with its Control admission %s',
    (phase) => {
      const fixture = terminalPreEffectCanceledBranchPushFixture()
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [fixture.intent],
        [fixture.operation],
        [phase === 'accepted' ? fixture.acceptedAdmission : fixture.availableAdmission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it.each(['before-intent-acknowledgement', 'terminal'] as const)(
    'rejects a not-accepted Host cancellation with an impossible effect plan at %s',
    (phase) => {
      const fixture = phase === 'terminal'
        ? terminalPreEffectCanceledBranchPushFixture()
        : preEffectCanceledBeforeBranchCheckpointFixture()
      const result = {
        type: 'push-branch' as const,
        repository: fixture.request.expected.repository,
        targetRef: fixture.request.targetRef,
        commitId: fixture.request.expected.commitId,
        previous: { kind: 'absent' as const },
        credential: { helperId: 'git-credential-manager' as const },
      }
      const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
        ...fixture.operation,
        effectPlan: { kind: 'push-branch', publication: 'not-started', result },
      })
      assertPushHostOperationRecord(operation, 'impossible effect plan changed operation kind')
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [fixture.intent],
        [operation],
        [fixture.acceptedAdmission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
        .toThrow('Branch Push checkpoint has no exact Host and admission window')
    },
  )

  it('accepts applied reconciliation before the Branch Intent acknowledges the Host snapshot', () => {
    const fixture = repairedBeforeBranchCheckpointFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts Delivery publication before the nonterminal Intent acknowledges the succeeded Host snapshot', () => {
    const fixture = appliedBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects applied Delivery evidence that disagrees with the succeeded Host result or completion', () => {
    const fixture = appliedBranchPushFixture()
    const mismatches = [
      sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
        ...fixture.delivery,
        push: { ...fixture.delivery.push, confirmedAt: fixture.delivery.push!.confirmedAt + 1 },
      }),
      sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
        ...fixture.delivery,
        push: {
          ...fixture.delivery.push,
          result: {
            ...fixture.delivery.push!.result,
            previous: { kind: 'commit', objectId: 'd'.repeat(40) },
          },
        },
      }),
    ]

    for (const delivery of mismatches) {
      const [controlPlane, hostExecution] = branchDomains(
        [delivery],
        [fixture.intent],
        [fixture.operation],
        [fixture.availableAdmission],
      )
      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
        .toThrow('applied Branch Push disagrees with its succeeded Host snapshot')
    }
  })

  it.each(['accepted', 'available'] as const)(
    'accepts an exact terminal Host snapshot while its admission is %s',
    (admissionState) => {
      const fixture = terminalBranchPushFixture()
      const admission = admissionState === 'accepted' ? fixture.acceptedAdmission : fixture.availableAdmission
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [fixture.intent],
        [fixture.operation],
        [admission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('accepts a historical terminal Push after the Delivery advances to a later Intent', () => {
    const fixture = terminalBranchPushFixture()
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...fixture.delivery,
      lastIntentId: ALT_INTENT_ID,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a historical terminal Push while a later operation owns the Binding', () => {
    const fixture = terminalBranchPushFixture()
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...fixture.delivery,
      lastIntentId: ALT_INTENT_ID,
    })
    const previousOwner = foreignBranchWriteAdmission(fixture)
    const laterOwner = bindingWriteAdmissionRecordSchema.parse({
      ...previousOwner,
      revision: fixture.acceptedAdmission.revision + 2,
      updatedAt: fixture.operation.snapshot.updatedAt + 2,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [delivery],
      [fixture.intent],
      [fixture.operation],
      [laterOwner],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('retains exact historical Host evidence after Save replaces the Delivery commit', () => {
    const fixture = terminalBranchPushFixture()
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse({
      ...fixture.delivery,
      revision: fixture.delivery.revision + 1,
      lastIntentId: ALT_INTENT_ID,
      commitId: 'b'.repeat(40),
      headRef: 'refs/heads/revised-delivery',
      phase: 'draft',
      push: undefined,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [delivery], [fixture.intent], [fixture.operation], [fixture.availableAdmission],
    )
    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()

    const changedHost = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: { ...fixture.operation.snapshot, completedAt: fixture.operation.snapshot.updatedAt + 1,
        updatedAt: fixture.operation.snapshot.updatedAt + 1 },
    })
    assertPushHostOperationRecord(changedHost, 'Historical Push fixture changed kind')
    const [changedControl, changedExecution] = branchDomains(
      [delivery], [fixture.intent], [changedHost], [fixture.availableAdmission],
    )
    expect(() => { validateBranchDeliveryOperationLinks(changedControl, changedExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('rejects a historical terminal Push when a foreign admission did not advance past it', () => {
    const fixture = terminalBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [foreignBranchWriteAdmission(fixture)],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('accepts a source-conflict repair only with a reserved admission and no-effect Host record', () => {
    const fixture = sourceConflictedBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.reservedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it.each(['detected', 'repair-written'] as const)(
    'accepts a source-conflicted Host record while reconciliation is %s',
    (phase) => {
      const active = branchPushFixture()
      const repaired = sourceConflictedBranchPushFixture(active)
      const [controlPlane, hostExecution] = branchDomains(
        [phase === 'detected' ? active.delivery : repaired.delivery],
        [active.intent],
        [repaired.operation],
        [active.reservedAdmission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('accepts terminal reconciliation with the exact Host snapshot and accepted admission', () => {
    const fixture = reconciliationBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects terminal reconciliation after its accepted admission revision changes', () => {
    const fixture = reconciliationBranchPushFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.acceptedAdmission,
      revision: fixture.acceptedAdmission.revision + 1,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [admission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it.each(['accepted', 'available'] as const)(
    'accepts a terminal no-effect Host failure while its admission is %s',
    (admissionState) => {
      const fixture = failedBranchPushFixture()
      const admission = admissionState === 'accepted' ? fixture.acceptedAdmission : fixture.availableAdmission
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [fixture.intent],
        [fixture.operation],
        [admission],
      )

      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('rejects checkpointed Push state after its preparation or admission revision changes', () => {
    const fixture = checkpointedBranchPushFixture()
    const changedPreparation = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      checkpoint: {
        ...fixture.intent.checkpoint,
        preparation: { ...fixture.preparation, preparationRevision: fixture.preparation.preparationRevision + 1 },
      },
    })
    const changedAdmission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.acceptedAdmission,
      revision: fixture.acceptedAdmission.revision + 1,
    })
    for (const [intent, admission] of [
      [changedPreparation, fixture.acceptedAdmission],
      [fixture.intent, changedAdmission],
    ] as const) {
      const [controlPlane, hostExecution] = branchDomains(
        [fixture.delivery],
        [intent],
        [fixture.operation],
        [admission],
      )
      expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
        .toThrow('Branch Push checkpoint has no exact Host and admission window')
    }
  })

  it('rejects a Push request whose exact Binding differs from its Delivery', () => {
    const fixture = checkpointedBranchPushFixture()
    const request = hostOperationRequestSchema.parse({
      ...fixture.request,
      expected: {
        ...fixture.request.expected,
        binding: { ...fixture.request.expected.binding, workspaceId: 'workspace-altered' },
      },
    })
    if (request.type !== 'push-branch') throw new Error('altered request changed operation kind')
    const requestFingerprint = {
      version: 1 as const,
      digest: canonicalDigest('saki/host-operation-request/v1', request),
    }
    const preparation = { ...fixture.preparation, requestFingerprint }
    const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      request,
      snapshot: { ...fixture.operation.snapshot, requestFingerprint },
    })
    assertPushHostOperationRecord(operation, 'altered operation changed kind')
    const intent = sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema.parse({
      ...fixture.intent,
      operation: { kind: 'push', request },
      checkpoint: { ...fixture.intent.checkpoint, preparation },
    })
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.acceptedAdmission,
      preparation,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [intent],
      [operation],
      [admission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push Intent request disagrees with its Branch Delivery')
  })

  it('rejects a checkpointed Push whose Delivery no longer names the active Intent', () => {
    const fixture = checkpointedBranchPushFixture()
    const { activeIntentId: _activeIntentId, ...deliveryWithoutActive } = fixture.delivery
    const delivery = sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema.parse(deliveryWithoutActive)
    const [controlPlane, hostExecution] = branchDomains(
      [delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.acceptedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('rejects terminal reconciliation after its accepted admission was released', () => {
    const fixture = reconciliationBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [bindingWriteAdmissionRecordSchema.parse({
        id: BINDING_ID,
        schemaVersion: 1,
        revision: fixture.acceptedAdmission.revision + 1,
        state: 'available',
        updatedAt: fixture.operation.snapshot.updatedAt + 1,
      })],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('rejects a source conflict when the mismatched Host record admits a possible effect', () => {
    const fixture = sourceConflictedBranchPushFixture()
    const admittedSnapshot = hostOperationSnapshotSchema.parse({
      ...fixture.operation.snapshot,
      revision: 1,
      state: 'accepted',
      admission: { kind: 'accepted', revision: 2, acceptedAt: 4 },
      updatedAt: 4,
    })
    const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: admittedSnapshot,
    })
    assertPushHostOperationRecord(operation, 'Admitted conflict fixture changed kind')
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [operation],
      [fixture.reservedAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push Host Operation request disagrees with its Intent')
  })

  it('rejects a terminal Intent whose retained Host snapshot is not current', () => {
    const fixture = terminalBranchPushFixture()
    const changedSnapshot = hostOperationSnapshotSchema.parse({
      ...fixture.operation.snapshot,
      revision: fixture.operation.snapshot.revision + 1,
      updatedAt: fixture.operation.snapshot.updatedAt + 1,
    })
    const operation = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: changedSnapshot,
    })
    assertPushHostOperationRecord(operation, 'Changed terminal fixture changed kind')
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push checkpoint has no exact Host and admission window')
  })

  it('rejects orphan Push Host Operations and write admissions', () => {
    const fixture = branchPushFixture()
    const [, orphanHost] = branchDomains([], [], [fixture.operation], [])
    const [emptyControl] = branchDomains([], [], [], [])
    expect(() => { validateBranchDeliveryOperationLinks(emptyControl, orphanHost) })
      .toThrow('Branch Push Host Operation has no Branch Delivery Intent')

    const [orphanAdmissionControl, emptyHost] = branchDomains([], [], [], [fixture.reservedAdmission])
    expect(() => { validateBranchDeliveryOperationLinks(orphanAdmissionControl, emptyHost) })
      .toThrow('Branch Push admission has no Branch Delivery Intent')
  })

  it('rejects a second Binding write admission claiming the same Branch Push Intent', () => {
    const fixture = branchPushFixture()
    const duplicate = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      id: ALT_BINDING_ID,
    })
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [fixture.intent],
      [fixture.operation],
      [fixture.reservedAdmission, duplicate],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('Branch Push admission has no exact recovery owner')
  })

  it('rejects applied Delivery evidence after its Push Intent and Host Operation disappear', () => {
    const fixture = appliedBranchPushFixture()
    const [controlPlane, hostExecution] = branchDomains(
      [fixture.delivery],
      [],
      [],
      [fixture.availableAdmission],
    )

    expect(() => { validateBranchDeliveryOperationLinks(controlPlane, hostExecution) })
      .toThrow('applied Branch Delivery has no exact succeeded Push operation')
  })
})

describe('current Saki Git-operation cross-domain validation', () => {
  it('leaves accepted Push admission to the Branch Delivery validator', () => {
    const admission = bindingWriteAdmissionRecordSchema.parse({
      id: BINDING_ID,
      schemaVersion: 1,
      revision: 2,
      state: 'manual-host-operation',
      phase: 'accepted',
      bindingRevision: 0,
      source: {
        kind: 'control-intent',
        intentId: INTENT_ID,
        intentRevision: 0,
        payloadDigest: '1'.repeat(64),
      },
      action: 'project-branch:push',
      reservedAt: 1,
      preparation: {
        operation: { id: OPERATION_ID, hostId: HOST_ID, type: 'push-branch' },
        preparationRevision: 0,
        requestFingerprint: { version: 1, digest: '2'.repeat(64) },
      },
      acceptedAt: 2,
      updatedAt: 2,
    })
    const [controlPlane, hostExecution] = domains([], [], [admission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('is ignored by Agent-operation validation', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains([], [fixture.operation], [])

    expect(() => { validateAgentOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a reserved Intent with the prepared, not-accepted Host Operation from a safe crash gap', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [admissionReservedIntent(fixture)],
      [fixture.operation],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects an orphan Host Operation', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains([], [fixture.operation], [fixture.availableAdmission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation has no Control Intent')
  })

  it('rejects durable identities that disagree with their table keys or source-derived id', () => {
    const fixture = linkedFixture()
    const operationWithAnotherId = sakiHostExecutionDomainSpec.tables.operations.valueSchema.parse({
      ...fixture.operation,
      snapshot: {
        ...fixture.operation.snapshot,
        operation: { ...fixture.operation.snapshot.operation, id: ALT_OPERATION_ID },
      },
    })
    const cases = [
      {
        message: 'Saki Git operation Intent id disagrees with its table key',
        subjects: domainsFromEntries([[ALT_INTENT_ID, fixture.intent]], [], []),
      },
      {
        message: 'Saki Binding write admission id disagrees with its table key',
        subjects: domainsFromEntries([], [], [[ALT_BINDING_ID, fixture.availableAdmission]]),
      },
      {
        message: 'Saki Host Operation id disagrees with its table key',
        subjects: domainsFromEntries(
          [[fixture.intent.id, fixture.intent]],
          [[ALT_OPERATION_ID, fixture.operation]],
          [[fixture.reservedAdmission.id, fixture.reservedAdmission]],
        ),
      },
      {
        message: 'Saki Host Operation id disagrees with its Control Intent source',
        subjects: domainsFromEntries(
          [[fixture.intent.id, fixture.intent]],
          [[ALT_OPERATION_ID, operationWithAnotherId]],
          [[fixture.reservedAdmission.id, fixture.reservedAdmission]],
        ),
      },
    ] as const

    for (const { message, subjects: [controlPlane, hostExecution] } of cases) {
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it('rejects prepared Intent evidence after its Host Operation disappears', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [fixture.intent],
      [],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Git operation Intent preparation has no Host Operation')
  })

  it('rejects a source conflict without the existing mismatched Host Operation that caused it', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('source-conflicted Git Intent has no Host Operation')
  })

  it('accepts a source conflict only when its existing Host Operation has a mismatched safe request', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [mismatchedOperation(fixture)],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('rejects a source conflict that still matches its Host Operation request', () => {
    const fixture = linkedFixture()
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [fixture.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki source-conflicted Git Intent unexpectedly matches its Host Operation')
  })

  it('rejects a source conflict whose mismatched Host Operation was admitted', () => {
    const fixture = linkedFixture()
    const mismatched = mismatchedOperation(fixture)
    const admitted = {
      ...mismatched,
      snapshot: {
        ...mismatched.snapshot,
        revision: 1,
        updatedAt: 3,
        state: 'accepted' as const,
        admission: { kind: 'accepted' as const, revision: 2, acceptedAt: 3 },
      },
    }
    const [controlPlane, hostExecution] = domains(
      [sourceConflictIntent(fixture)],
      [admitted],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki source-conflicted Git Intent points to an admitted or possible-effect Host Operation')
  })

  it('rejects an accepted Binding admission whose preparation disagrees with the Host Operation', () => {
    const fixture = linkedFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      preparation: { ...fixture.preparation, preparationRevision: 1 },
      acceptedAt: 3,
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = domains([fixture.intent], [fixture.operation], [admission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation disagrees with its Binding write admission')
  })

  it('rejects an accepted Binding admission whose Binding revision disagrees with the Host request', () => {
    const fixture = linkedFixture()
    const admission = bindingWriteAdmissionRecordSchema.parse({
      ...fixture.reservedAdmission,
      revision: 2,
      phase: 'accepted',
      bindingRevision: 1,
      preparation: fixture.preparation,
      acceptedAt: 3,
      updatedAt: 3,
    })
    const [controlPlane, hostExecution] = domains([fixture.intent], [fixture.operation], [admission])

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Host Operation disagrees with its Binding write admission')
  })

  it('rejects different retained and current Host snapshots at the same revision', () => {
    const fixture = linkedFixture()
    const changed = preparedOperation(fixture.request, 3)
    const [controlPlane, hostExecution] = domains(
      [fixture.intent],
      [changed],
      [fixture.reservedAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
      .toThrow('Saki Git operation Intent disagrees with the same Host Operation revision')
  })

  it('rejects mismatched preparation, future retained evidence, and lagging terminal evidence', () => {
    const fixture = linkedFixture()
    const preparationMismatch = {
      ...fixture.operation,
      preparationRevision: fixture.operation.preparationRevision + 1,
    }
    const futureIntent = gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      operationSnapshot: { ...fixture.preparedSnapshot, revision: 1 },
    })
    const terminal = canceledFixture(fixture)
    const advancedTerminalOperation = {
      ...terminal.operation,
      snapshot: { ...terminal.operation.snapshot, revision: terminal.operation.snapshot.revision + 1 },
    }
    for (const [intent, operation, admission, message] of [
      [
        fixture.intent,
        preparationMismatch,
        fixture.reservedAdmission,
        'Saki Git operation Intent preparation disagrees with its Host Operation',
      ],
      [
        futureIntent,
        fixture.operation,
        fixture.reservedAdmission,
        'Saki Git operation Intent retains a future Host Operation revision',
      ],
      [
        terminal.intent,
        advancedTerminalOperation,
        fixture.availableAdmission,
        'terminal Saki Git operation Intent lags its Host Operation',
      ],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [admission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it.each(['stage-files', 'unstage-files', 'commit'] as const)(
    'accepts one fully linked accepted %s operation',
    (type) => {
      const accepted = acceptedFixture(linkedFixture(type))
      const [controlPlane, hostExecution] = domains(
        [accepted.intent],
        [accepted.operation],
        [accepted.admission],
      )

      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
    },
  )

  it('rejects lost or revision-mismatched current write admissions', () => {
    const fixture = linkedFixture()
    const accepted = acceptedFixture(fixture)
    const acceptedFromPreparedIntent = gitOperationIntentRecordSchema.parse({
      ...fixture.intent,
      revision: 3,
      phase: 'accepted',
      admissionRevision: 1,
      updatedAt: 3,
    })
    const wrongAdmissionRevision = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      revision: 3,
    })
    for (const [intent, operation, admission, message] of [
      [
        fixture.intent,
        fixture.operation,
        fixture.availableAdmission,
        'nonterminal Saki Host Operation lost its Binding write admission',
      ],
      [
        acceptedFromPreparedIntent,
        accepted.operation,
        accepted.admission,
        'accepted Saki Host Operation disagrees with its Control Intent admission',
      ],
      [
        accepted.intent,
        accepted.operation,
        wrongAdmissionRevision,
        'accepted Saki Host Operation disagrees with its Binding write admission',
      ],
      [
        accepted.intent,
        accepted.operation,
        fixture.reservedAdmission,
        'nonterminal accepted Saki Host Operation lost its Binding write admission',
      ],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [admission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).toThrow(message)
    }
  })

  it('accepts released admission after both the Host Operation and Intent are terminal', () => {
    const fixture = linkedFixture()
    const terminal = canceledFixture(fixture)
    const [controlPlane, hostExecution] = domains(
      [terminal.intent],
      [terminal.operation],
      [fixture.availableAdmission],
    )

    expect(() => { validateGitOperationLinks(controlPlane, hostExecution) }).not.toThrow()
  })

  it('accepts a cancellation recovered before preparation and rejects other unexplained pre-preparation records', () => {
    const fixture = linkedFixture()
    const [canceledControl, canceledHost] = domains(
      [canceledBeforePreparationIntent(fixture)],
      [fixture.operation],
      [fixture.availableAdmission],
    )
    expect(() => { validateGitOperationLinks(canceledControl, canceledHost) }).not.toThrow()

    const failedOperation = {
      ...fixture.operation,
      snapshot: {
        ...fixture.preparedSnapshot,
        revision: 1,
        updatedAt: 3,
        state: 'failed' as const,
        completedAt: 3,
        failure: { reason: 'unsupported-state' as const },
        effect: 'none' as const,
      },
    }
    for (const [intent, operation] of [
      [preparedIntent(fixture), fixture.operation],
      [admissionReservedIntent(fixture), failedOperation],
    ] as const) {
      const [controlPlane, hostExecution] = domains([intent], [operation], [fixture.reservedAdmission])
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
        .toThrow('Saki Control Intent has an unexplained pre-preparation Host Operation')
    }
  })

  it('rejects every broken accepted-admission back-link after operation validation', () => {
    const fixture = linkedFixture()
    const accepted = acceptedFixture(fixture)
    const sourceConflict = sourceConflictIntent(fixture)
    const protocolConflict = preparedProtocolConflictIntent(fixture)
    const admissionForMissingIntent = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      source: {
        kind: 'control-intent',
        intentId: ALT_INTENT_ID,
        intentRevision: fixture.request.source.intentRevision,
        payloadDigest: fixture.request.source.payloadDigest,
      },
    })
    const admissionWithNoOperationBinding = bindingWriteAdmissionRecordSchema.parse({
      ...accepted.admission,
      id: ALT_BINDING_ID,
    })
    const admissionWithWrongPreparation = bindingWriteAdmissionRecordSchema.parse({
      ...admissionWithNoOperationBinding,
      preparation: {
        ...fixture.preparation,
        preparationRevision: fixture.preparation.preparationRevision + 1,
      },
    })
    const cases = [
      domains([preHostConflictIntent(fixture)], [], [accepted.admission]),
      domains([canceledFixture(fixture).intent], [canceledFixture(fixture).operation], [admissionForMissingIntent]),
      domains([sourceConflict], [mismatchedOperation(fixture)], [accepted.admission]),
      domains([admissionReservedIntent(fixture)], [fixture.operation], [accepted.admission]),
      domains([protocolConflict], [fixture.operation], [admissionWithWrongPreparation]),
      domains([protocolConflict], [fixture.operation], [admissionWithNoOperationBinding]),
    ] as const

    for (const [controlPlane, hostExecution] of cases) {
      expect(() => { validateGitOperationLinks(controlPlane, hostExecution) })
        .toThrow('Saki accepted Binding write admission has no matching Host Operation')
    }
  })

  it.each(['expected-evidence', 'invalid-selection'] as const)(
    'accepts a pre-Host %s conflict only while no Host Operation exists',
    (reason) => {
      const fixture = linkedFixture()
      const conflict = preHostConflictIntent(fixture, reason)
      const [withoutControl, withoutHost] = domains([conflict], [], [fixture.availableAdmission])
      expect(() => { validateGitOperationLinks(withoutControl, withoutHost) }).not.toThrow()

      const [withControl, withHost] = domains([conflict], [fixture.operation], [fixture.availableAdmission])
      expect(() => { validateGitOperationLinks(withControl, withHost) })
        .toThrow('Saki Host Operation request disagrees with its Control Intent')
    },
  )
})
