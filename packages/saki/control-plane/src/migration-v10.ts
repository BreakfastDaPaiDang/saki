/** Adjacent migration to independently admitted Agent inputs without Git preconditions. */

import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type { DomainMigrationSnapshot } from '@deepseek-ai/dsh-storage-domain'
import {
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  agentOperationIntentV1RecordSchema,
  agentRunV2RecordSchema as agentRunRecordSchema,
  bindingWriteAdmissionV3RecordSchema,
  developmentProjectRegistryRecordSchema,
  executionDispatchV2RecordSchema,
} from './spec.ts'

/**
 * Preserve accepted Host credentials while removing Agent Git preconditions and binding reservations.
 * Historical ownership is checked before the records carrying that evidence are removed.
 * @param snapshot - exact v9 source snapshot validated by the migration runner.
 * @returns v10 records retaining Session, Run, input, and admission identities with matching request fingerprints.
 */
export function migrateSakiV9ToV10(snapshot: DomainMigrationSnapshot): DomainMigrationSnapshot {
  const tables = snapshot.tables as Readonly<Record<
    'agent_operation_intents' | 'binding_write_admissions' | 'execution_dispatches'
    | 'agent_runs' | 'development_project_registry', Readonly<Record<string, unknown>>
  >>
  const intents = new Map(Object.entries(tables.agent_operation_intents)
    .map(([key, value]) => [key, agentOperationIntentV1RecordSchema.parse(value)]))
  const admissions = new Map(Object.entries(tables.binding_write_admissions)
    .map(([key, value]) => [key, bindingWriteAdmissionV3RecordSchema.parse(value)]))
  const dispatches = new Map(Object.entries(tables.execution_dispatches)
    .map(([key, value]) => [key, executionDispatchV2RecordSchema.parse(value)]))
  const runs = new Map(Object.entries(tables.agent_runs)
    .map(([key, value]) => [key, agentRunRecordSchema.parse(value)]))
  const registryValue = tables.development_project_registry[DEVELOPMENT_PROJECT_REGISTRY_KEY]
  const registry = registryValue === undefined ? undefined : developmentProjectRegistryRecordSchema.parse(registryValue)
  for (const [key, admission] of admissions) {
    if (key !== admission.id) throw new Error('v9 Binding admission id disagrees with its table key')
    if (admission.state !== 'agent-run') continue
    const intent = intents.get(admission.originIntentId)
    const binding = registry?.resourceBindings.find(value => value.id === key)
    const run = runs.get(admission.agentRunId)
    if (intent === undefined || binding === undefined || run === undefined
      || run.intentId !== intent.id
      || intent.agentRunId !== admission.agentRunId
      || intent.projectContext.resourceBindingId !== key
      || intent.projectContext.bindingRevision !== admission.bindingRevision
      || admission.bindingRevision > binding.revision
      || intent.hostRequest.source.payloadDigest !== admission.payloadDigest
      || intent.phase === 'canceled') {
      throw new Error('v9 Agent binding reservation has inconsistent ownership')
    }
  }
  for (const [key, intent] of intents) {
    if (key !== intent.id) throw new Error('v9 Agent Intent id disagrees with its table key')
    const admission = admissions.get(intent.projectContext.resourceBindingId)
    const owned = admission?.state === 'agent-run' && admission.originIntentId === key ? admission : undefined
    if (intent.phase === 'started' || intent.phase === 'reconciliation-required') {
      if (owned?.phase !== 'accepted') throw new Error('v9 started Agent Intent lacks its binding reservation')
    } else if (intent.phase === 'admission-reserved') {
      if (owned?.phase !== 'reserved') throw new Error('v9 reserved Agent Intent lacks its binding reservation')
    } else if (intent.phase === 'dispatching') {
      const dispatch = dispatches.get(intent.dispatchId)
      const canceled = dispatch?.state === 'canceled'
        || dispatch?.operationSnapshot?.state === 'canceled' || dispatch?.operationSnapshot?.state === 'failed'
      const valid = dispatch?.state === 'reconciliation-required' ? owned !== undefined
        : canceled ? true
          : dispatch?.state === 'claimed' ? owned !== undefined
            : dispatch?.state === 'accepted' ? owned?.phase === 'accepted'
              : dispatch?.state === 'pending' && owned?.phase === 'reserved'
      if (!valid) throw new Error('v9 dispatching Agent Intent has incompatible binding reservation')
    }
  }
  return {
    global: snapshot.global,
    tables: {
      ...snapshot.tables,
      agent_operation_intents: Object.fromEntries([...intents].map(([key, intent]) => {
        const { inProgressIntentId: _inProgressIntentId, ...retained } = intent
        const { intendedOutcome: _outcome, acceptanceCriteria: _criteria, blockage: _blockage, ...workItemDefinition }
          = intent.workItemDefinition
        return [key, {
          ...retained,
          schemaVersion: 2,
          phase: intent.phase === 'admission-reserved' ? 'prepared' : intent.phase,
          workItemDefinition,
          contextDigest: canonicalDigest('saki/agent-operation-context/v1', {
            workItemDefinition, projectContext: intent.projectContext, profile: intent.profile,
          }),
          hostRequest: { ...intent.hostRequest, expected: { binding: intent.hostRequest.expected.binding } },
        }]
      })),
      execution_dispatches: Object.fromEntries([...dispatches].map(([key, dispatch]) => {
        if (key !== dispatch.id) throw new Error('v9 Dispatch id disagrees with its table key')
        const binding = admissions.get(dispatch.bindingId)
        const admittedHost = dispatch.operationSnapshot?.admission
        const admissionRevision = dispatch.acceptedFencingToken === undefined ? undefined
          : admittedHost?.kind === 'accepted' ? admittedHost.revision
            : binding?.state === 'agent-run' && binding.agentRunId === dispatch.agentRunId && binding.phase === 'accepted'
              ? binding.revision : dispatch.revision
        const hostRequest = { ...dispatch.hostRequest, expected: { binding: dispatch.hostRequest.expected.binding } }
        const requestFingerprint = { version: 1, digest: canonicalDigest('saki/host-operation-request/v1', hostRequest) }
        return [key, {
          ...dispatch,
          schemaVersion: 2,
          hostRequest,
          ...(dispatch.preparation === undefined ? {} : { preparation: { ...dispatch.preparation, requestFingerprint } }),
          ...(dispatch.operationSnapshot === undefined ? {} : {
            operationSnapshot: { ...dispatch.operationSnapshot, requestFingerprint },
          }),
          ...(admissionRevision === undefined ? {} : { admissionRevision }),
        }]
      })),
      binding_write_admissions: Object.fromEntries([...admissions].map(([key, admission]) => [key,
        admission.state === 'agent-run' ? {
          id: admission.id,
          schemaVersion: 1,
          revision: admission.revision + 1,
          state: 'available',
          updatedAt: admission.updatedAt,
        } : admission,
      ])),
    },
  }
}
