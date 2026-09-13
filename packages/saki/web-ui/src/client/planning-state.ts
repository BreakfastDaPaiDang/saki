/** Persisted planning addresses, drafts, and exact unacknowledged user Intents. */
import { z } from 'zod'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { sakiConfigureGitHubSynchronizationIntentSchema, sakiMoveWorkItemIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiWireProjectId, SakiWireMoveWorkItemIntent, SakiWireSaveMilestoneDeliveryIntent, SakiWireWorkItemViewResult } from '@breakfastdapaidang/saki-host-api/wire'

/** Stable selected Work Item id. */
export type WorkItemId = SakiWireMoveWorkItemIntent['workItemId']
/** Stable GitHub Milestone id. */
export type MilestoneId = SakiWireSaveMilestoneDeliveryIntent['release']['milestoneId']
/** Backend-mapped Work Item status. */
export type BoardStatus = SakiWireMoveWorkItemIntent['targetStatus']
type AgentRunId = Extract<SakiWireWorkItemViewResult, { ok: true }>['projection']['runs'][number]['id']

const addressSchema = z.object({
  view: z.enum(['board', 'workspace', 'detail', 'milestone', 'mapping', 'changes']),
  changesRunId: z.string().min(1).max(512).transform(value => value as AgentRunId).nullable().default(null),
  workItemId: sakiMoveWorkItemIntentSchema.shape.workItemId.nullable(),
  milestoneId: z.string().min(1).max(512).transform(value => value as MilestoneId).nullable(),
  returnView: z.enum(['board', 'milestone']),
  filter: z.string().max(512), includeCanceled: z.boolean(),
  moveDraft: z.object({ expectedRemoteFingerprint: sakiMoveWorkItemIntentSchema.shape.expectedRemoteFingerprint, afterFingerprint: sakiMoveWorkItemIntentSchema.shape.expectedRemoteFingerprint.nullable(), workItemId: sakiMoveWorkItemIntentSchema.shape.workItemId, targetStatus: sakiMoveWorkItemIntentSchema.shape.targetStatus, position: z.union([z.literal('keep'), z.literal('top'), sakiMoveWorkItemIntentSchema.shape.workItemId]) }).strict().nullable().default(null),
  mappingDraft: z.object({ fieldId: z.string().nullable(), options: z.record(z.string(), z.string()) }).strict().nullable().default(null),
}).strict()
const scopeSchema = z.object({
  addresses: z.record(z.string(), addressSchema),
  pendingMoves: z.record(z.string(), sakiMoveWorkItemIntentSchema),
  pendingMapping: z.record(z.string(), sakiConfigureGitHubSynchronizationIntentSchema),
}).strict()
const stateSchema = z.object({ scopes: z.record(z.string(), scopeSchema) }).strict()
/** Persisted address contains viewing choices and no authoritative business facts. */
export type PlanningAddress = z.infer<typeof addressSchema>
type PlanningState = z.infer<typeof stateSchema>
/** Pending gestures are partitioned by authenticated Principal. */
export type PlanningScope = z.infer<typeof scopeSchema>

type PlanningStoreActions = {
  hydrate: (draft: PlanningState, input: unknown) => void
  address: (draft: PlanningState, principalId: string, projectId: SakiWireProjectId, address: PlanningAddress) => void
  move: (draft: PlanningState, principalId: string, intent: SakiWireMoveWorkItemIntent) => void
  forgetMove: (draft: PlanningState, principalId: string, intentId: string) => void
  mapping: (draft: PlanningState, principalId: string, intent: z.infer<typeof sakiConfigureGitHubSynchronizationIntentSchema>) => void
  forgetMapping: (draft: PlanningState, principalId: string, projectId: SakiWireProjectId) => void
}

/**
 * Construct shared planning interaction state.
 * @returns a declared store factory; the object owner validates hydration before use.
 */
export function createPlanningStore(): EngineStoreHandle<PlanningState, PlanningStoreActions> {
  return defineStore({
    init: (): PlanningState => ({ scopes: {} }), persist: 'saki.planning',
    actions: {
      hydrate: (draft: PlanningState, input: unknown) => {
        const parsed = stateSchema.safeParse(input)
        draft.scopes = parsed.success ? parsed.data.scopes : {}
      },
      address: (draft: PlanningState, principalId: string, projectId: SakiWireProjectId, address: PlanningAddress) => {
        const scope = draft.scopes[principalId] ??= { addresses: {}, pendingMoves: {}, pendingMapping: {} }
        scope.addresses[projectId] = address
      },
      move: (draft: PlanningState, principalId: string, intent: SakiWireMoveWorkItemIntent) => {
        const scope = draft.scopes[principalId] ??= { addresses: {}, pendingMoves: {}, pendingMapping: {} }
        scope.pendingMoves[intent.intentId] = intent
      },
      forgetMove: (draft: PlanningState, principalId: string, intentId: string) => {
        delete draft.scopes[principalId]?.pendingMoves[intentId]
      },
      mapping: (draft: PlanningState, principalId: string, intent: z.infer<typeof sakiConfigureGitHubSynchronizationIntentSchema>) => {
        const scope = draft.scopes[principalId] ??= { addresses: {}, pendingMoves: {}, pendingMapping: {} }
        scope.pendingMapping[intent.projectId] = intent
      },
      forgetMapping: (draft: PlanningState, principalId: string, projectId: SakiWireProjectId) => {
        delete draft.scopes[principalId]?.pendingMapping[projectId]
      },
    },
  })
}

/**
 * Resolve a fresh Project destination without persisting backend defaults.
 * @returns Board address with archived Canceled items hidden.
 */
export function initialPlanningAddress(): PlanningAddress {
  return { view: 'board', workItemId: null, milestoneId: null, returnView: 'board', filter: '', includeCanceled: false, moveDraft: null, mappingDraft: null, changesRunId: null }
}
