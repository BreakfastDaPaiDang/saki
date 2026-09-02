/** Cross-domain validation for one complete current Saki product state. */

import { isDeepStrictEqual } from 'node:util'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import {
  agentRunRecordSchema,
  bindingWriteAdmissionRecordSchema,
  executionDispatchRecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  sakiStorageGenerationDomainSpec,
  validateCurrentSakiState,
  type AgentRunRecord,
  type BindingWriteAdmissionRecord,
  type ExecutionDispatchRecord,
  type GitOperationIntentRecord,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiHostExecutionDomainSpec,
  sakiHostExecutionV1DomainSpec,
  type LocalHostGitOperationRecordV1,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'

type CurrentControlPlaneDomain = Domain<typeof sakiControlPlaneDomainSpec>
type CurrentHostExecutionDomain = Domain<typeof sakiHostExecutionDomainSpec>
type HistoricalHostExecutionDomain = Domain<typeof sakiHostExecutionV1DomainSpec>
type CurrentStorageGenerationDomain = Domain<typeof sakiStorageGenerationDomainSpec>
type CurrentGitHostOperationRecord = Exclude<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'start-agent-run' } }
>
type GitHostOperationRecord = LocalHostGitOperationRecordV1 | CurrentGitHostOperationRecord
type AgentHostOperationRecord = Extract<
  LocalHostOperationRecord,
  { readonly request: { readonly type: 'start-agent-run' } }
>

interface GitOperationControlPlaneDomain {
  table(name: 'git_operation_intents' | 'binding_write_admissions'): KvTable<string, unknown>
}

interface AgentOperationControlPlaneDomain {
  table(name: 'agent_runs' | 'execution_dispatches' | 'binding_write_admissions'): KvTable<string, unknown>
}

/**
 * Validate complete current product relationships across Control Plane, Host Execution, and generation identity.
 * Recoverable write-order gaps are accepted only when the Host still proves that no effect was admitted.
 * @param controlPlane - opened exact `saki_control_plane@6` domain.
 * @param hostExecution - opened exact `saki_host_execution@1` domain.
 * @param storageGeneration - opened exact `saki_storage_generation@4` domain.
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
  validateAgentOperationLinks(controlPlane, hostExecution)
}

/**
 * Validate current Control Intent, Host Operation, and Binding write-admission links.
 * @param controlPlane - opened exact current Control Plane domain.
 * @param hostExecution - opened exact current Host Execution domain.
 * @returns nothing after every cross-domain relationship passes.
 */
export function validateGitOperationLinks(
  controlPlane: GitOperationControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain | HistoricalHostExecutionDomain,
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
 * @param controlPlane - opened exact current Control Plane domain.
 * @param hostExecution - opened exact current Host Execution domain.
 * @returns nothing after every StartAgentRun cross-domain relationship passes.
 */
export function validateAgentOperationLinks(
  controlPlane: AgentOperationControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain,
): void {
  const runs = identifiedAgentRecords(
    controlPlane.table('agent_runs'),
    agentRunRecordSchema,
    'Agent Run',
  )
  const dispatches = identifiedAgentRecords(
    controlPlane.table('execution_dispatches'),
    executionDispatchRecordSchema,
    'Execution Dispatch',
  )
  const admissions = identifiedAgentRecords(
    controlPlane.table('binding_write_admissions'),
    bindingWriteAdmissionRecordSchema,
    'Binding write admission',
  )
  const operations = new Map<ExecutionDispatchRecord['id'], AgentHostOperationRecord>()

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
  dispatch: ExecutionDispatchRecord,
  run: AgentRunRecord,
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

function identifiedAgentRecords<K extends string, V extends { readonly id: K }>(
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

function isAgentHostOperation(
  operation: LocalHostOperationRecord,
): operation is AgentHostOperationRecord {
  return operation.request.type === 'start-agent-run'
}

function validateDispatchHostEvidence(
  dispatch: ExecutionDispatchRecord,
  operation: AgentHostOperationRecord,
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
  dispatch: ExecutionDispatchRecord,
  run: AgentRunRecord,
  operation: AgentHostOperationRecord,
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
  operation: LocalHostOperationRecord | LocalHostGitOperationRecordV1,
): operation is GitHostOperationRecord {
  return operation.request.type !== 'start-agent-run'
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
  operation: LocalHostOperationRecord | LocalHostGitOperationRecordV1,
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
