/** Cross-domain validation for one complete current Saki product state. */

import { isDeepStrictEqual } from 'node:util'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  agentRunRecordSchema,
  agentRunV1RecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  executionDispatchV1RecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  sakiStorageGenerationDomainSpec,
  validateCurrentSakiState,
  type AgentRunRecord,
  type AgentRunV1Record,
  type BindingWriteAdmissionRecord,
  type ExecutionDispatchRecord,
  type ExecutionDispatchV1Record,
  type GitOperationIntentRecord,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  sakiHostExecutionV2DomainSpec,
  sakiHostExecutionV3DomainSpec,
  type LocalHostGitOperationRecordV1,
  type LocalHostOperationRecord,
  type LocalHostOperationRecordV2,
  type LocalHostOperationRecordV3,
} from '@breakfastdapaidang/saki-execution-local'

type CurrentControlPlaneDomain = Domain<typeof sakiControlPlaneDomainSpec>
type CurrentHostExecutionDomain = Domain<typeof sakiHostExecutionDomainSpec>
type HistoricalV1HostExecutionDomain = Domain<typeof sakiHostExecutionV1DomainSpec>
type HistoricalV2HostExecutionDomain = Domain<typeof sakiHostExecutionV2DomainSpec>
type HistoricalV3HostExecutionDomain = Domain<typeof sakiHostExecutionV3DomainSpec>
type CurrentStorageGenerationDomain = Domain<typeof sakiStorageGenerationDomainSpec>
type CurrentGitHostOperationRecord = Exclude<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'start-agent-run' | 'push-branch' } }
>
type CurrentPushHostOperationRecord = Extract<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'push-branch' } }
>
type CurrentBranchDeliveryRecord = ReturnType<
  (typeof sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema)['parse']
>
type CurrentBranchDeliveryIntentRecord = ReturnType<
  (typeof sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema)['parse']
>
type CurrentBranchPushIntentRecord = CurrentBranchDeliveryIntentRecord & {
  readonly operation: Extract<CurrentBranchDeliveryIntentRecord['operation'], { readonly kind: 'push' }>
}
type BranchPushAdmissionRecord = Extract<
  BindingWriteAdmissionRecord,
  { readonly state: 'manual-host-operation' }
> & { readonly action: 'project-branch:push' }
type HistoricalV2GitHostOperationRecord = Exclude<
  LocalHostOperationRecordV2,
  { readonly request: { readonly type: 'start-agent-run' } }
>
type HistoricalV3GitHostOperationRecord = Exclude<
  LocalHostOperationRecordV3,
  { readonly request: { readonly type: 'start-agent-run' } }
>
type GitHostOperationRecord = LocalHostGitOperationRecordV1
  | HistoricalV2GitHostOperationRecord
  | HistoricalV3GitHostOperationRecord
  | CurrentGitHostOperationRecord
type AgentHostOperationRecord = Extract<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'start-agent-run' } }
>
type HistoricalAgentHostOperationRecord = Extract<
  LocalHostOperationRecordV2 | LocalHostOperationRecordV3,
  { readonly request: { readonly type: 'start-agent-run' } }
>
type LinkedAgentRunRecord = AgentRunRecord | AgentRunV1Record
type LinkedExecutionDispatchRecord = ExecutionDispatchRecord | ExecutionDispatchV1Record
type LinkedAgentHostOperationRecord = AgentHostOperationRecord | HistoricalAgentHostOperationRecord

interface GitOperationControlPlaneDomain {
  table(name: 'git_operation_intents' | 'binding_write_admissions'): KvTable<string, unknown>
}

interface AgentOperationControlPlaneDomain {
  table(name: 'agent_runs' | 'execution_dispatches' | 'binding_write_admissions'): KvTable<string, unknown>
}

interface BranchDeliveryControlPlaneDomain {
  table(name: 'branch_deliveries' | 'branch_delivery_intents' | 'binding_write_admissions'):
  KvTable<string, unknown>
}

/**
 * Validate complete current product relationships across Control Plane, Host Execution, and generation identity.
 * Recoverable write-order gaps are accepted only when the Host still proves that no effect was admitted.
 * @param controlPlane - opened exact `saki_control_plane@9` domain.
 * @param hostExecution - opened exact `saki_host_execution@4` domain.
 * @param storageGeneration - opened exact `saki_storage_generation@7` domain.
 * @param expectedInstallationId - Installation selected by maintenance metadata.
 * @param expectedStorageGenerationId - physical generation selected by maintenance metadata.
 * @param expectedCreatedByBuildId - generation provenance repeated by its seal.
 * @returns nothing after every within-domain and cross-domain relationship passes.
 */
export function validateCurrentSakiProductState(
  controlPlane: CurrentControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain,
  storageGeneration: CurrentStorageGenerationDomain,
  expectedInstallationId: SakiInstallationId,
  expectedStorageGenerationId: SakiStorageGenerationId,
  expectedCreatedByBuildId: SakiBuildId,
): void {
  validateCurrentSakiState(
    controlPlane,
    storageGeneration,
    expectedInstallationId,
    expectedStorageGenerationId,
    expectedCreatedByBuildId,
  )
  validateGitOperationLinks(controlPlane, hostExecution)
  validateBranchDeliveryOperationLinks(controlPlane, hostExecution)
  validateAgentOperationLinks(controlPlane, hostExecution)
}

/**
 * Validate current Branch Delivery Push Intent, Host Operation, and write-admission links.
 * @param controlPlane - opened current Control Plane domain exposing Branch Delivery tables.
 * @param hostExecution - opened current Host Execution domain.
 * @returns nothing after every Push recovery relationship passes.
 */
export function validateBranchDeliveryOperationLinks(
  controlPlane: BranchDeliveryControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain,
): void {
  const deliveries = identifiedRecords(
    controlPlane.table('branch_deliveries'),
    sakiControlPlaneDomainSpec.tables.branch_deliveries.valueSchema,
    'Branch Delivery',
  )
  const intents = identifiedRecords(
    controlPlane.table('branch_delivery_intents'),
    sakiControlPlaneDomainSpec.tables.branch_delivery_intents.valueSchema,
    'Branch Delivery Intent',
  )
  const pushIntents = new Map<CurrentBranchPushIntentRecord['id'], CurrentBranchPushIntentRecord>()
  for (const record of intents.values()) {
    if (isBranchPushIntent(record)) pushIntents.set(record.id, record)
  }
  const admissions = identifiedRecords(
    controlPlane.table('binding_write_admissions'),
    bindingWriteAdmissionRecordSchema,
    'Binding write admission',
  )
  const pushAdmissions = new Map<BranchPushAdmissionRecord['id'], BranchPushAdmissionRecord>()
  for (const record of admissions.values()) {
    if (isBranchPushAdmission(record)) pushAdmissions.set(record.id, record)
  }
  const pushOperations = new Map<CurrentPushHostOperationRecord['snapshot']['operation']['id'],
    CurrentPushHostOperationRecord>()

  for (const [key, value] of hostExecution.table('operations').entries()) {
    if (value.snapshot.operation.id !== key) {
      throw new Error('Saki Host Operation id disagrees with its table key')
    }
    if (!isCurrentPushHostOperation(value)) continue
    const operation = value
    const expectedId = operation.request.source.intentId.replace(/^intent-/u, 'host-operation-')
    if (key !== expectedId) throw new Error('Branch Push Host Operation id disagrees with its Intent source')
    const intent = pushIntents.get(operation.request.source.intentId)
    if (intent === undefined) throw new Error('Branch Push Host Operation has no Branch Delivery Intent')
    const delivery = deliveries.get(intent.deliveryId)
    if (delivery === undefined) throw new Error('Branch Push Intent has no Branch Delivery')
    if (!supersededBranchPush(intent, delivery) && !branchPushRequestMatchesDelivery(intent.operation.request, delivery)) {
      throw new Error('Branch Push Intent request disagrees with its Branch Delivery')
    }
    const admission = admissions.get(intent.operation.request.expected.binding.id)
    if (!isDeepStrictEqual(operation.request, intent.operation.request)
      && !sourceConflictedBranchPushValid(intent, delivery, operation, admission)) {
      throw new Error('Branch Push Host Operation request disagrees with its Intent')
    }
    if (!branchPushWindowValid(intent, delivery, operation, admission)) {
      throw new Error('Branch Push checkpoint has no exact Host and admission window')
    }
    pushOperations.set(operation.snapshot.operation.id, operation)
  }

  for (const intent of pushIntents.values()) {
    const operationId = intent.id.replace(/^intent-/u, 'host-operation-')
    if (pushOperations.has(operationId as CurrentPushHostOperationRecord['snapshot']['operation']['id'])) continue
    const delivery = deliveries.get(intent.deliveryId)
    const request = intent.operation.request
    const admission = admissions.get(request.expected.binding.id)
    if (delivery === undefined || (!supersededBranchPush(intent, delivery) && !branchPushRequestMatchesDelivery(request, delivery))
      || !branchPushWithoutHostValid(intent, delivery, admission)) {
      throw new Error('Branch Push Intent has no Host Operation')
    }
  }
  for (const delivery of deliveries.values()) {
    if (delivery.push === undefined) continue
    const intent = pushIntents.get(delivery.push.intentId)
    const operationId = delivery.push.intentId.replace(/^intent-/u, 'host-operation-')
    const operation = pushOperations.get(operationId as CurrentPushHostOperationRecord['snapshot']['operation']['id'])
    if (intent === undefined || intent.deliveryId !== delivery.id
      || operation?.snapshot.state !== 'succeeded'
      || !isDeepStrictEqual(delivery.push.result, operation.snapshot.result)
      || delivery.push.confirmedAt !== operation.snapshot.completedAt) {
      throw new Error('applied Branch Delivery has no exact succeeded Push operation')
    }
  }
  for (const admission of pushAdmissions.values()) {
    const intent = pushIntents.get(admission.source.intentId)
    if (intent === undefined) throw new Error('Branch Push admission has no Branch Delivery Intent')
    if (!branchPushAdmissionMatchesRequest(admission, intent, intent.operation.request)) {
      throw new Error('Branch Push admission has no exact recovery owner')
    }
  }
}

function branchPushWithoutHostValid(
  intent: CurrentBranchPushIntentRecord,
  delivery: CurrentBranchDeliveryRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): boolean {
  const checkpoint = intent.checkpoint
  const ownedAdmission = admission !== undefined && isBranchPushAdmission(admission)
    && branchPushAdmissionMatchesRequest(admission, intent, intent.operation.request)
  if (checkpoint.state === 'prepared') {
    return !ownedAdmission
  }
  if (checkpoint.state === 'active') {
    if (delivery.lastIntentId !== intent.id || admission === undefined) return false
    if (delivery.activeIntentId === undefined) return !ownedAdmission
    if (delivery.activeIntentId !== intent.id) return false
    return !ownedAdmission || (isBranchPushAdmission(admission) && admission.phase === 'reserved')
  }
  return checkpoint.state === 'terminal' && checkpoint.host === undefined
    && (checkpoint.outcome === 'conflict' || checkpoint.outcome === 'denied')
    && !ownedAdmission
}

function identifiedRecords<K extends string, V extends { readonly id: K }>(
  table: KvTable<string, unknown>,
  schema: { parse(value: unknown): V },
  kind: string,
): ReadonlyMap<K, V> {
  return new Map([...table.entries()].map(([key, value]) => {
    const parsed = schema.parse(value)
    if (parsed.id !== key) throw new Error(`Saki ${kind} id disagrees with its table key`)
    return [parsed.id, parsed] as const
  }))
}

function isBranchPushAdmission(
  record: BindingWriteAdmissionRecord,
): record is BranchPushAdmissionRecord {
  return record.state === 'manual-host-operation' && record.action === 'project-branch:push'
}

function isBranchPushIntent(record: CurrentBranchDeliveryIntentRecord): record is CurrentBranchPushIntentRecord {
  return record.operation.kind === 'push'
}

function isCurrentPushHostOperation(
  operation: LocalHostOperationRecord,
): operation is CurrentPushHostOperationRecord {
  return operation.request.type === 'push-branch'
}

function branchPushRequestMatchesDelivery(
  request: CurrentPushHostOperationRecord['request'],
  delivery: CurrentBranchDeliveryRecord,
): boolean {
  return isDeepStrictEqual(request.expected.binding, delivery.target.binding)
    && request.expected.commitId === delivery.commitId
    && request.expected.repository.nameWithOwner === delivery.target.repository.nameWithOwner
    && request.targetRef === delivery.headRef
}

function supersededBranchPush(intent: CurrentBranchDeliveryIntentRecord, delivery: CurrentBranchDeliveryRecord): boolean {
  const checkpoint = intent.checkpoint
  return checkpoint.state === 'terminal' && checkpoint.outcome !== 'reconciliation-required'
    && checkpoint.deliveryRevision !== undefined && checkpoint.deliveryRevision < delivery.revision
    && delivery.lastIntentId !== intent.id && delivery.activeIntentId !== intent.id
    && delivery.push?.intentId !== intent.id && delivery.repair?.intentId !== intent.id
}

function branchPushAdmissionMatchesRequest(
  admission: BranchPushAdmissionRecord,
  intent: CurrentBranchDeliveryIntentRecord,
  request: CurrentPushHostOperationRecord['request'],
): boolean {
  return admission.id === request.expected.binding.id
    && admission.bindingRevision === request.expected.binding.revision
    && admission.source.intentId === intent.id
    && isDeepStrictEqual(admission.source, request.source)
}

function activeBranchPushWindowValid(
  intent: CurrentBranchDeliveryIntentRecord,
  operation: CurrentPushHostOperationRecord,
  admission: Extract<BindingWriteAdmissionRecord, {
    readonly state: 'manual-host-operation'
    readonly action: 'project-branch:push'
  }>,
): boolean {
  if (!branchPushAdmissionMatchesRequest(admission, intent, operation.request)) return false
  if (operation.snapshot.state === 'prepared') {
    if (admission.phase === 'reserved') return true
    return isDeepStrictEqual(admission.preparation, operationPreparation(operation))
  }
  return false
}

function branchPushWindowValid(
  intent: CurrentBranchPushIntentRecord,
  delivery: CurrentBranchDeliveryRecord,
  operation: CurrentPushHostOperationRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): boolean {
  const checkpoint = intent.checkpoint
  if (!isDeepStrictEqual(operation.request, intent.operation.request)) {
    return sourceConflictedBranchPushValid(intent, delivery, operation, admission)
  }
  if (checkpoint.state === 'active') {
    return delivery.activeIntentId === intent.id && delivery.lastIntentId === intent.id
      && admission !== undefined && isBranchPushAdmission(admission)
      && activeBranchPushWindowValid(intent, operation, admission)
  }
  if (checkpoint.state === 'terminal') {
    return terminalBranchPushWindowValid(intent, delivery, operation, admission)
  }
  if (checkpoint.state !== 'push-host-accepted') return false
  const preparation = operationPreparation(operation)
  if (!isDeepStrictEqual(checkpoint.preparation, preparation)) return false
  const hostAdmission = operation.snapshot.admission
  const hostAccepted = hostAdmission.kind === 'accepted'
    && hostAdmission.revision === checkpoint.admissionRevision
  const hostStartPending = operation.snapshot.state === 'prepared'
    && hostAdmission.kind === 'not-accepted'
  const canceledBeforeEffectAdmission = operation.snapshot.state === 'canceled'
    && hostAdmission.kind === 'not-accepted'
    && operation.effectPlan === undefined
  if (!hostAccepted && !hostStartPending && !canceledBeforeEffectAdmission) return false
  const appliedPush = delivery.activeIntentId === undefined && delivery.lastIntentId === intent.id
    && delivery.push?.intentId === intent.id ? delivery.push : undefined
  if (appliedPush !== undefined) {
    if (operation.snapshot.state !== 'succeeded'
      || !isDeepStrictEqual(appliedPush.result, operation.snapshot.result)
      || appliedPush.confirmedAt !== operation.snapshot.completedAt) {
      throw new Error('applied Branch Push disagrees with its succeeded Host snapshot')
    }
    return branchPushAdmissionAfterHostMatches(
      admission, intent, operation, checkpoint.preparation, operation.snapshot.admission,
    )
  }
  if (admission === undefined || !isBranchPushAdmission(admission) || admission.phase !== 'accepted'
    || admission.revision !== checkpoint.admissionRevision
    || !branchPushAcceptedAdmissionMatches(admission, intent, operation, preparation)) return false
  if (delivery.activeIntentId === intent.id && delivery.lastIntentId === intent.id) return true
  if (delivery.activeIntentId !== undefined || delivery.lastIntentId !== intent.id) return false
  if (delivery.repair?.intentId === intent.id) {
    return operation.snapshot.state === 'reconciliation-required'
      && delivery.repair.reason === operation.snapshot.reason
  }
  return delivery.push?.intentId !== intent.id
    && (operation.snapshot.state === 'failed' || operation.snapshot.state === 'canceled')
}

function sourceConflictedBranchPushValid(
  intent: CurrentBranchPushIntentRecord,
  delivery: CurrentBranchDeliveryRecord,
  operation: CurrentPushHostOperationRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): boolean {
  const checkpoint = intent.checkpoint
  const noEffect = operation.effectPlan === undefined
    && operation.snapshot.admission.kind === 'not-accepted'
    && (operation.snapshot.state === 'prepared' || operation.snapshot.state === 'failed'
      || operation.snapshot.state === 'canceled')
  const activeWindow = checkpoint.state === 'active'
    && delivery.lastIntentId === intent.id
    && ((delivery.activeIntentId === intent.id && delivery.repair === undefined)
      || (delivery.activeIntentId === undefined && delivery.repair?.intentId === intent.id
        && delivery.repair.reason === 'evidence-conflict'))
  const terminalWindow = checkpoint.state === 'terminal' && checkpoint.outcome === 'reconciliation-required'
    && checkpoint.reason === 'evidence-conflict'
    && checkpoint.host === undefined && delivery.activeIntentId === undefined
    && delivery.lastIntentId === intent.id && delivery.repair?.intentId === intent.id
    && delivery.repair.reason === 'evidence-conflict'
  return !isDeepStrictEqual(operation.request, intent.operation.request)
    && isDeepStrictEqual(operation.request.source, intent.operation.request.source)
    && admission !== undefined && isBranchPushAdmission(admission) && admission.phase === 'reserved'
    && branchPushAdmissionMatchesRequest(admission, intent, intent.operation.request)
    && noEffect && (activeWindow || terminalWindow)
}

function terminalBranchPushWindowValid(
  intent: CurrentBranchDeliveryIntentRecord,
  delivery: CurrentBranchDeliveryRecord,
  operation: CurrentPushHostOperationRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): boolean {
  const checkpoint = intent.checkpoint
  if (checkpoint.state !== 'terminal' || checkpoint.host === undefined
    || !isDeepStrictEqual(checkpoint.host.preparation, operationPreparation(operation))
    || !isDeepStrictEqual(checkpoint.host.snapshot, operation.snapshot)) return false
  if (operation.snapshot.state === 'succeeded' && !supersededBranchPush(intent, delivery)) {
    if (delivery.push?.intentId !== intent.id
      || !isDeepStrictEqual(delivery.push.result, operation.snapshot.result)
      || delivery.push.confirmedAt !== operation.snapshot.completedAt) {
      throw new Error('terminal Branch Push disagrees with its applied Delivery evidence')
    }
  }
  if (checkpoint.outcome === 'reconciliation-required') {
    return delivery.activeIntentId === undefined && delivery.lastIntentId === intent.id
      && delivery.repair?.intentId === intent.id
      && operation.snapshot.state === 'reconciliation-required'
      && delivery.repair.reason === operation.snapshot.reason
      && admission !== undefined && isBranchPushAdmission(admission) && admission.phase === 'accepted'
      && admission.revision === operation.snapshot.admission.revision
      && branchPushAcceptedAdmissionMatches(admission, intent, operation, checkpoint.host.preparation)
  }
  return delivery.activeIntentId !== intent.id
    && terminalBranchPushAdmissionMatches(admission, intent, operation, checkpoint.host.preparation)
}

function terminalBranchPushAdmissionMatches(
  admission: BindingWriteAdmissionRecord | undefined,
  intent: CurrentBranchDeliveryIntentRecord,
  operation: CurrentPushHostOperationRecord,
  preparation: ReturnType<typeof operationPreparation>,
): boolean {
  if (admission === undefined || admission.id !== operation.request.expected.binding.id) return false
  const evidence = operation.snapshot.admission
  if (evidence.kind === 'not-accepted' && operation.effectPlan !== undefined) return false
  const sameSource = admission.state === 'manual-host-operation'
    && isDeepStrictEqual(admission.source, operation.request.source)
  if (sameSource) {
    return isBranchPushAdmission(admission) && admission.phase === 'accepted'
      && (evidence.kind === 'not-accepted' || admission.revision === evidence.revision)
      && branchPushAcceptedAdmissionMatches(admission, intent, operation, preparation)
  }
  // Intent schema hostSnapshotMatchesOutcome proves terminal state; the caller handles reconciliation separately.
  const snapshot = operation.snapshot as Extract<CurrentPushHostOperationRecord['snapshot'], {
    readonly state: 'succeeded' | 'failed' | 'canceled'
  }>
  return admission.updatedAt >= snapshot.completedAt
    && (evidence.kind === 'not-accepted' || admission.revision > evidence.revision)
}

function branchPushAdmissionAfterHostMatches(
  admission: BindingWriteAdmissionRecord | undefined,
  intent: CurrentBranchDeliveryIntentRecord,
  operation: CurrentPushHostOperationRecord,
  preparation: ReturnType<typeof operationPreparation>,
  evidence: Extract<CurrentPushHostOperationRecord['snapshot']['admission'], { readonly kind: 'accepted' }>,
): boolean {
  if (admission === undefined) return false
  if (admission.state === 'available') {
    return admission.id === operation.request.expected.binding.id && admission.revision === evidence.revision + 1
  }
  return isBranchPushAdmission(admission) && admission.phase === 'accepted'
    && admission.revision === evidence.revision
    && branchPushAcceptedAdmissionMatches(admission, intent, operation, preparation)
}

function branchPushAcceptedAdmissionMatches(
  admission: Extract<BindingWriteAdmissionRecord, {
    readonly state: 'manual-host-operation'
    readonly action: 'project-branch:push'
    readonly phase: 'accepted'
  }>,
  intent: CurrentBranchDeliveryIntentRecord,
  operation: CurrentPushHostOperationRecord,
  preparation: ReturnType<typeof operationPreparation>,
): boolean {
  return branchPushAdmissionMatchesRequest(admission, intent, operation.request)
    && isDeepStrictEqual(admission.preparation, preparation)
}

/**
 * Validate current Control Intent, Host Operation, and Binding write-admission links.
 * @param controlPlane - opened current or retained Control Plane domain exposing exact Git tables.
 * @param hostExecution - opened current or retained Host Execution domain.
 * @returns nothing after every cross-domain relationship passes.
 */
export function validateGitOperationLinks(
  controlPlane: GitOperationControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain | HistoricalV1HostExecutionDomain | HistoricalV2HostExecutionDomain
    | HistoricalV3HostExecutionDomain,
): void {
  const intents = new Map([...controlPlane.table('git_operation_intents').entries()].map(([key, value]) => {
    const intent = gitOperationIntentRecordSchema.parse(value)
    if (intent.id !== key) throw new Error('Saki Git operation Intent id disagrees with its table key')
    return [key, intent] as const
  }))
  const admissions = new Map([...controlPlane.table('binding_write_admissions').entries()].map(([key, value]) => {
    const admission = bindingWriteAdmissionRecordSchema.parse(value)
    if (admission.id !== key) throw new Error('Saki Binding write admission id disagrees with its table key')
    return [key, admission] as const
  }))
  const operations = new Map<
    GitHostOperationRecord['snapshot']['operation']['id'],
    GitHostOperationRecord
  >()
  for (const [key, operation] of hostExecution.table('operations').entries()) {
    if (operation.snapshot.operation.id !== key) {
      throw new Error('Saki Host Operation id disagrees with its table key')
    }
    if (!isGitHostOperation(operation)) continue
    const expectedId = operation.request.source.intentId.replace(/^intent-/u, 'host-operation-')
    if (key !== expectedId) throw new Error('Saki Host Operation id disagrees with its Control Intent source')
    const intent = intents.get(operation.request.source.intentId)
    if (intent === undefined) throw new Error('Saki Host Operation has no Control Intent')
    validateOperationIntentLink(intent, operation)
    validateOperationAdmissionLink(
      intent,
      operation,
      admissions.get(operation.request.expected.binding.id),
    )
    operations.set(key, operation)
  }

  for (const intent of intents.values()) {
    const operationId = intent.id.replace(/^intent-/u, 'host-operation-')
    const operation = operations.get(operationId as GitHostOperationRecord['snapshot']['operation']['id'])
    if (sourceConflictedIntent(intent) && operation === undefined) {
      throw new Error('source-conflicted Git Intent has no Host Operation')
    }
    if (intent.preparation !== undefined && operation === undefined) {
      throw new Error('Saki Git operation Intent preparation has no Host Operation')
    }
    if (intent.preparation === undefined && operation !== undefined) {
      validatePrePreparationHostRecord(intent, operation)
    }
  }

  for (const admission of admissions.values()) {
    if (admission.state !== 'manual-host-operation' || admission.phase !== 'accepted') continue
    if (admission.action === 'project-branch:push') continue
    const operation = operations.get(admission.preparation.operation.id)
    const intent = intents.get(admission.source.intentId)
    if (operation === undefined || intent === undefined || sourceConflictedIntent(intent)
      || intent.preparation === undefined
      || !isDeepStrictEqual(intent.preparation, admission.preparation)
      || !acceptedAdmissionMatchesOperation(admission, operation)) {
      throw new Error('Saki accepted Binding write admission has no matching Host Operation')
    }
  }
}

/**
 * Validate current Execution Dispatch, Agent Run, Host Operation, and write-admission links.
 * Host-first preparation is the sole accepted missing-backlink gap: once a Dispatch retains
 * preparation or snapshot evidence, the exact provider record must still exist.
 * @param controlPlane - opened current or exact v8 Control Plane domain using current Agent schemas.
 * @param hostExecution - opened current or exact v8 Host Execution domain using current Agent schemas.
 * @returns nothing after every StartAgentRun cross-domain relationship passes.
 */
export function validateAgentOperationLinks(
  controlPlane: AgentOperationControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain | HistoricalV3HostExecutionDomain,
): void {
  validateAgentOperationLinksWithSchemas(
    controlPlane,
    hostExecution,
    agentRunRecordSchema,
    executionDispatchRecordSchema,
  )
}

/**
 * Validate exact v7 Agent Run links before migrating its Control Plane and Host v2 domains.
 * @param controlPlane - opened exact `saki_control_plane@7` domain.
 * @param hostExecution - opened exact `saki_host_execution@2` domain.
 * @returns nothing after every historical cross-domain relationship passes.
 */
export function validateSakiV7AgentOperationLinks(
  controlPlane: AgentOperationControlPlaneDomain,
  hostExecution: HistoricalV2HostExecutionDomain,
): void {
  validateAgentOperationLinksWithSchemas(
    controlPlane,
    hostExecution,
    agentRunV1RecordSchema,
    executionDispatchV1RecordSchema,
  )
}

function validateAgentOperationLinksWithSchemas(
  controlPlane: AgentOperationControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain | HistoricalV2HostExecutionDomain | HistoricalV3HostExecutionDomain,
  runSchema: { parse(value: unknown): LinkedAgentRunRecord },
  dispatchSchema: { parse(value: unknown): LinkedExecutionDispatchRecord },
): void {
  const runs = identifiedRecords(
    controlPlane.table('agent_runs'),
    runSchema,
    'Agent Run',
  )
  const dispatches = identifiedRecords(
    controlPlane.table('execution_dispatches'),
    dispatchSchema,
    'Execution Dispatch',
  )
  const admissions = identifiedRecords(
    controlPlane.table('binding_write_admissions'),
    bindingWriteAdmissionRecordSchema,
    'Binding write admission',
  )
  const operations = new Map<LinkedExecutionDispatchRecord['id'], LinkedAgentHostOperationRecord>()

  for (const [key, operation] of hostExecution.table('operations').entries()) {
    if (operation.snapshot.operation.id !== key) {
      throw new Error('Saki Host Operation id disagrees with its table key')
    }
    if (!isAgentHostOperation(operation)) continue
    const dispatchId = operation.request.source.dispatchId
    const expectedId = dispatchId.replace(/^dispatch-/u, 'host-operation-')
    if (key !== expectedId) {
      throw new Error('StartAgentRun Host Operation id disagrees with its Execution Dispatch source')
    }
    const dispatch = dispatches.get(dispatchId)
    if (dispatch === undefined) throw new Error('StartAgentRun Host Operation has no Execution Dispatch')
    const run = runs.get(dispatch.agentRunId)
    if (run === undefined) throw new Error('StartAgentRun Host Operation has no Agent Run')
    if (!isDeepStrictEqual(operation.request, dispatch.hostRequest)) {
      if (retainedAgentSourceConflict(
        dispatch,
        run,
        admissions.get(dispatch.bindingId),
      )) {
        operations.set(dispatchId, operation)
        continue
      }
      throw new Error('StartAgentRun Host Operation request disagrees with its Execution Dispatch')
    }
    validateDispatchHostEvidence(dispatch, operation)
    validateAgentHostAdmission(dispatch, run, operation, admissions.get(dispatch.bindingId))
    operations.set(dispatchId, operation)
  }

  for (const dispatch of dispatches.values()) {
    const operation = operations.get(dispatch.id)
    if ((dispatch.preparation !== undefined || dispatch.operationSnapshot !== undefined)
      && operation === undefined) {
      throw new Error('Saki Execution Dispatch retains evidence for a missing Host Operation')
    }
  }

  for (const run of runs.values()) {
    if (run.state !== 'running') continue
    const matching = run.dispatchIds.some((dispatchId) => {
      const dispatch = dispatches.get(dispatchId)
      const operation = operations.get(dispatchId)
      return dispatch !== undefined
        && operation?.snapshot.state === 'succeeded'
        && dispatch.operationSnapshot?.state === 'succeeded'
        && isDeepStrictEqual(operation.snapshot, dispatch.operationSnapshot)
        && isDeepStrictEqual(operation.snapshot.result, run.hostResult)
    })
    if (!matching) throw new Error('running Saki Agent Run has no exact succeeded Host Operation')
  }
}

function retainedAgentSourceConflict(
  dispatch: LinkedExecutionDispatchRecord,
  run: LinkedAgentRunRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): boolean {
  return dispatch.state === 'reconciliation-required'
    && run.state === 'reconciliation-required'
    && dispatch.preparation === undefined
    && dispatch.operationSnapshot === undefined
    && admission?.state === 'agent-run'
    && admission.originIntentId === dispatch.intentId
    && admission.agentRunId === dispatch.agentRunId
    && admission.bindingRevision === dispatch.hostRequest.expected.binding.revision
    && admission.payloadDigest === dispatch.payloadDigest
}

function isAgentHostOperation(
  operation: LocalHostOperationRecord | LocalHostOperationRecordV2 | LocalHostOperationRecordV3,
): operation is LinkedAgentHostOperationRecord {
  return operation.request.type === 'start-agent-run'
}

function validateDispatchHostEvidence(
  dispatch: LinkedExecutionDispatchRecord,
  operation: LinkedAgentHostOperationRecord,
): void {
  if (dispatch.preparation !== undefined
    && !isDeepStrictEqual(dispatch.preparation, operationPreparation(operation))) {
    throw new Error('Saki Execution Dispatch preparation disagrees with its Host Operation')
  }
  const retained = dispatch.operationSnapshot
  if (retained === undefined) return
  if (retained.revision > operation.snapshot.revision) {
    throw new Error('Saki Execution Dispatch retains a future Host Operation revision')
  }
  if (retained.revision === operation.snapshot.revision
    && !isDeepStrictEqual(retained, operation.snapshot)) {
    throw new Error('Saki Execution Dispatch disagrees with the same Host Operation revision')
  }
}

function validateAgentHostAdmission(
  dispatch: LinkedExecutionDispatchRecord,
  run: LinkedAgentRunRecord,
  operation: LinkedAgentHostOperationRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): void {
  const releasedAfterNoEffect = (operation.snapshot.state === 'failed'
    || operation.snapshot.state === 'canceled')
    && dispatch.state === 'canceled' && run.state === 'canceled'
  if (releasedAfterNoEffect) return
  if (admission?.state !== 'agent-run'
    || admission.originIntentId !== dispatch.intentId
    || admission.agentRunId !== dispatch.agentRunId
    || admission.bindingRevision !== dispatch.hostRequest.expected.binding.revision
    || admission.payloadDigest !== dispatch.payloadDigest) {
    throw new Error('StartAgentRun Host Operation lost its Agent Run write admission')
  }
  const evidence = operation.snapshot.admission
  if (evidence.kind === 'accepted'
    && (admission.phase !== 'accepted' || admission.revision !== evidence.revision)) {
    throw new Error('accepted StartAgentRun Host Operation disagrees with its write admission')
  }
}

function isGitHostOperation(
  operation: LocalHostOperationRecord | LocalHostOperationRecordV2 | LocalHostOperationRecordV3
    | LocalHostGitOperationRecordV1,
): operation is GitHostOperationRecord {
  return operation.request.type !== 'start-agent-run' && operation.request.type !== 'push-branch'
}

function sourceConflictedIntent(intent: GitOperationIntentRecord): boolean {
  return intent.phase === 'conflict' && intent.terminalReason === 'source-conflict'
}

function validateOperationIntentLink(
  intent: GitOperationIntentRecord,
  operation: GitHostOperationRecord,
): void {
  if (sourceConflictedIntent(intent)) {
    validateSourceConflictHostRecord(intent, operation)
    return
  }
  if (intent.hostRequest === undefined || !isDeepStrictEqual(intent.hostRequest, operation.request)) {
    throw new Error('Saki Host Operation request disagrees with its Control Intent')
  }
  if (intent.preparation !== undefined && !isDeepStrictEqual(intent.preparation, operationPreparation(operation))) {
    throw new Error('Saki Git operation Intent preparation disagrees with its Host Operation')
  }
  const retained = intent.operationSnapshot
  if (retained === undefined) return
  if (retained.revision > operation.snapshot.revision) {
    throw new Error('Saki Git operation Intent retains a future Host Operation revision')
  }
  if (retained.revision === operation.snapshot.revision && !isDeepStrictEqual(retained, operation.snapshot)) {
    throw new Error('Saki Git operation Intent disagrees with the same Host Operation revision')
  }
  if (terminalIntent(intent) && retained.revision !== operation.snapshot.revision) {
    throw new Error('terminal Saki Git operation Intent lags its Host Operation')
  }
}

function validateSourceConflictHostRecord(
  intent: GitOperationIntentRecord,
  operation: GitHostOperationRecord,
): void {
  if (intent.hostRequest === undefined || isDeepStrictEqual(intent.hostRequest, operation.request)) {
    throw new Error('Saki source-conflicted Git Intent unexpectedly matches its Host Operation')
  }
  const stateProvesNoEffect = operation.snapshot.state === 'prepared'
    || operation.snapshot.state === 'failed' || operation.snapshot.state === 'canceled'
  if (intent.preparation !== undefined || intent.operationSnapshot !== undefined
    || intent.admissionRevision !== undefined || operation.effectPlan !== undefined
    || operation.snapshot.admission.kind !== 'not-accepted' || !stateProvesNoEffect) {
    throw new Error('Saki source-conflicted Git Intent points to an admitted or possible-effect Host Operation')
  }
}

function operationPreparation(
  operation: LocalHostOperationRecord | LocalHostOperationRecordV2 | LocalHostOperationRecordV3
    | LocalHostGitOperationRecordV1,
) {
  return {
    operation: operation.snapshot.operation,
    preparationRevision: operation.preparationRevision,
    requestFingerprint: operation.snapshot.requestFingerprint,
  }
}

function validatePrePreparationHostRecord(
  intent: GitOperationIntentRecord,
  operation: GitHostOperationRecord,
): void {
  if (sourceConflictedIntent(intent)) return
  const recoverablePhase = intent.phase === 'admission-reserved' || intent.phase === 'canceled'
  if (!recoverablePhase || operation.snapshot.state !== 'prepared') {
    throw new Error('Saki Control Intent has an unexplained pre-preparation Host Operation')
  }
}

function validateOperationAdmissionLink(
  intent: GitOperationIntentRecord,
  operation: GitHostOperationRecord,
  admission: BindingWriteAdmissionRecord | undefined,
): void {
  if (sourceConflictedIntent(intent)) return
  const owned = admission?.state === 'manual-host-operation'
    && admission.source.intentId === intent.id
  if (owned) validateManualAdmissionMatchesOperation(admission, operation)
  if (requiresCurrentAdmission(intent) && !owned) {
    throw new Error('nonterminal Saki Host Operation lost its Binding write admission')
  }
  const evidence = operation.snapshot.admission
  if (evidence.kind !== 'accepted') return
  if (intent.admissionRevision !== evidence.revision) {
    throw new Error('accepted Saki Host Operation disagrees with its Control Intent admission')
  }
  if (owned && admission.phase === 'accepted') {
    if (admission.revision !== evidence.revision) {
      throw new Error('accepted Saki Host Operation disagrees with its Binding write admission')
    }
    return
  }
  if (!terminalIntent(intent) || !terminalHostOperation(operation)) {
    throw new Error('nonterminal accepted Saki Host Operation lost its Binding write admission')
  }
}

function validateManualAdmissionMatchesOperation(
  admission: Extract<BindingWriteAdmissionRecord, { readonly state: 'manual-host-operation' }>,
  operation: GitHostOperationRecord,
): void {
  if (admission.id !== operation.request.expected.binding.id
    || admission.bindingRevision !== operation.request.expected.binding.revision
    || !isDeepStrictEqual(admission.source, operation.request.source)
    || admission.action !== actionFor(operation.request.type)
    || (admission.phase === 'accepted' && !acceptedAdmissionMatchesOperation(admission, operation))) {
    throw new Error('Saki Host Operation disagrees with its Binding write admission')
  }
}

function acceptedAdmissionMatchesOperation(
  admission: Extract<BindingWriteAdmissionRecord, {
    readonly state: 'manual-host-operation'
    readonly phase: 'accepted'
  }>,
  operation: GitHostOperationRecord,
): boolean {
  return admission.id === operation.request.expected.binding.id
    && admission.bindingRevision === operation.request.expected.binding.revision
    && isDeepStrictEqual(admission.source, operation.request.source)
    && admission.action === actionFor(operation.request.type)
    && isDeepStrictEqual(admission.preparation, operationPreparation(operation))
}

function actionFor(type: GitHostOperationRecord['request']['type']):
  'project-changes:stage' | 'project-changes:unstage' | 'project-commit:create' {
  return type === 'stage-files'
    ? 'project-changes:stage'
    : type === 'unstage-files' ? 'project-changes:unstage' : 'project-commit:create'
}

function requiresCurrentAdmission(intent: GitOperationIntentRecord): boolean {
  return intent.phase === 'admission-reserved' || intent.phase === 'host-prepared'
    || intent.phase === 'accepted' || intent.phase === 'reconciliation-required'
}

function terminalIntent(intent: GitOperationIntentRecord): boolean {
  return intent.phase === 'succeeded' || intent.phase === 'conflict' || intent.phase === 'failed'
    || intent.phase === 'canceled' || intent.phase === 'reconciliation-required'
}

const TERMINAL_HOST_OPERATION_STATES: ReadonlySet<GitHostOperationRecord['snapshot']['state']> = new Set([
  'succeeded', 'failed', 'canceled', 'reconciliation-required',
])

function terminalHostOperation(operation: GitHostOperationRecord): boolean {
  return TERMINAL_HOST_OPERATION_STATES.has(operation.snapshot.state)
}
