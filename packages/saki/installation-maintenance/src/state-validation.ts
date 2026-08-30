/** Cross-domain validation for one complete current Saki product state. */

import { isDeepStrictEqual } from 'node:util'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import {
  bindingWriteAdmissionRecordSchema,
  gitOperationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
  sakiStorageGenerationDomainSpec,
  validateCurrentSakiState,
  type BindingWriteAdmissionRecord,
  type GitOperationIntentRecord,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  sakiHostExecutionDomainSpec,
  type LocalHostOperationRecord,
} from '@breakfastdapaidang/saki-execution-local'

type CurrentControlPlaneDomain = Domain<typeof sakiControlPlaneDomainSpec>
type CurrentHostExecutionDomain = Domain<typeof sakiHostExecutionDomainSpec>
type CurrentStorageGenerationDomain = Domain<typeof sakiStorageGenerationDomainSpec>

/**
 * Validate complete current product relationships across Control Plane, Host Execution, and generation identity.
 * Recoverable write-order gaps are accepted only when the Host still proves that no effect was admitted.
 * @param controlPlane - opened exact `saki_control_plane@5` domain.
 * @param hostExecution - opened exact `saki_host_execution@1` domain.
 * @param storageGeneration - opened exact `saki_storage_generation@3` domain.
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
}

/**
 * Validate current Control Intent, Host Operation, and Binding write-admission links.
 * @param controlPlane - opened exact current Control Plane domain.
 * @param hostExecution - opened exact current Host Execution domain.
 * @returns nothing after every cross-domain relationship passes.
 */
export function validateGitOperationLinks(
  controlPlane: CurrentControlPlaneDomain,
  hostExecution: CurrentHostExecutionDomain,
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
  const operations = new Map([...hostExecution.table('operations').entries()].map(([key, operation]) => {
    if (operation.snapshot.operation.id !== key) {
      throw new Error('Saki Host Operation id disagrees with its table key')
    }
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
    return [key, operation] as const
  }))

  for (const intent of intents.values()) {
    const operationId = intent.id.replace(/^intent-/u, 'host-operation-')
    const operation = operations.get(operationId as LocalHostOperationRecord['snapshot']['operation']['id'])
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

function sourceConflictedIntent(intent: GitOperationIntentRecord): boolean {
  return intent.phase === 'conflict' && intent.terminalReason === 'source-conflict'
}

function validateOperationIntentLink(
  intent: GitOperationIntentRecord,
  operation: LocalHostOperationRecord,
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
  operation: LocalHostOperationRecord,
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

function operationPreparation(operation: LocalHostOperationRecord) {
  return {
    operation: operation.snapshot.operation,
    preparationRevision: operation.preparationRevision,
    requestFingerprint: operation.snapshot.requestFingerprint,
  }
}

function validatePrePreparationHostRecord(
  intent: GitOperationIntentRecord,
  operation: LocalHostOperationRecord,
): void {
  if (sourceConflictedIntent(intent)) return
  const recoverablePhase = intent.phase === 'admission-reserved' || intent.phase === 'canceled'
  if (!recoverablePhase || operation.snapshot.state !== 'prepared') {
    throw new Error('Saki Control Intent has an unexplained pre-preparation Host Operation')
  }
}

function validateOperationAdmissionLink(
  intent: GitOperationIntentRecord,
  operation: LocalHostOperationRecord,
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
  operation: LocalHostOperationRecord,
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
  operation: LocalHostOperationRecord,
): boolean {
  return admission.id === operation.request.expected.binding.id
    && admission.bindingRevision === operation.request.expected.binding.revision
    && isDeepStrictEqual(admission.source, operation.request.source)
    && admission.action === actionFor(operation.request.type)
    && isDeepStrictEqual(admission.preparation, operationPreparation(operation))
}

function actionFor(type: LocalHostOperationRecord['request']['type']):
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

const TERMINAL_HOST_OPERATION_STATES: ReadonlySet<LocalHostOperationRecord['snapshot']['state']> = new Set([
  'succeeded', 'failed', 'canceled', 'reconciliation-required',
])

function terminalHostOperation(operation: LocalHostOperationRecord): boolean {
  return TERMINAL_HOST_OPERATION_STATES.has(operation.snapshot.state)
}
