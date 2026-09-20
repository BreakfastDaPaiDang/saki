/** Durable Work Session model succession and its immutable Run attribution. */

import { z } from 'zod'
import { agentRunForkPlanSchema, forkAgentRunRequestSchema, sakiAgentRunIdSchema, sakiWorkSessionIdSchema } from '@breakfastdapaidang/saki-execution'
import { accountModelSelectionSchema, resolvedAccountModelRouteSchema } from './model-routing-spec.ts'
import { agentRunRecordSchema, controlIntentActorSchema } from './spec.ts'
import { sakiControlIntentIdSchema, sakiDevelopmentProjectIdSchema } from './ids.ts'

/** Select an explicit successor for the currently observed Work Session Run. */
export const switchWorkSessionModelIntentSchema = z.object({
  type: z.literal('switch-work-session-model'),
  intentId: sakiControlIntentIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  workSessionId: sakiWorkSessionIdSchema,
  expectedWorkSessionRevision: z.number().int().nonnegative(),
  expectedAgentRunId: sakiAgentRunIdSchema,
  selection: accountModelSelectionSchema,
}).strict()

/** Prepared model switch; the exact history cut precedes successor Session publication. */
export const runModelSwitchIntentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: sakiControlIntentIdSchema,
  request: switchWorkSessionModelIntentSchema,
  actor: controlIntentActorSchema,
  hostRequest: forkAgentRunRequestSchema,
  accountRoute: resolvedAccountModelRouteSchema,
  plan: agentRunForkPlanSchema.optional(),
  state: z.enum(['accepted', 'completed', 'failed', 'reconciliation-required']),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict()

/** A history-forked Run starts idle without claiming delivery of a new user message. */
export const forkedAgentRunRecordSchema = z.object({
  ...agentRunRecordSchema.shape,
  schemaVersion: z.literal(3),
  forkIntentId: sakiControlIntentIdSchema,
  sourceAgentRunId: sakiAgentRunIdSchema,
  accountRoute: resolvedAccountModelRouteSchema,
  inputPlan: agentRunRecordSchema.shape.inputPlan.optional(),
  dispatchIds: z.array(agentRunRecordSchema.shape.dispatchIds.element),
  state: z.enum(['running', 'waiting', 'resume-pending', 'reconciliation-required']),
}).strict().superRefine((value, context) => {
  if (value.updatedAt < value.createdAt || new Set(value.dispatchIds).size !== value.dispatchIds.length) {
    context.addIssue({ code: 'custom', message: 'Forked Run timestamps or Dispatch identities conflict' })
  }
  if (value.profile.modelRoute.provider !== value.accountRoute.provider
    || value.profile.modelRoute.model !== value.accountRoute.selection.model) {
    context.addIssue({ code: 'custom', message: 'Forked Run profile differs from its account attribution' })
  }
  if ((value.inputPlan === undefined) !== (value.dispatchIds.length === 0)) {
    context.addIssue({ code: 'custom', message: 'Forked Run input plan differs from its Dispatch history' })
  }
  if (value.hostResult !== undefined && (value.hostResult.agentRunId !== value.id
    || value.hostResult.workSessionId !== value.workSessionId || value.hostResult.sessionId !== value.sessionId
    || value.hostResult.inputMessageId !== value.inputPlan?.messageId)) {
    context.addIssue({ code: 'custom', message: 'Forked Run delivery evidence conflicts' })
  }
  if (value.state !== 'reconciliation-required' && ((value.state === 'waiting' || value.state === 'resume-pending')
    !== (value.blockingInterventionId !== undefined))) {
    context.addIssue({ code: 'custom', message: 'Forked Run Intervention blocker conflicts' })
  }
  if (value.state !== 'reconciliation-required' && (value.hostResult !== undefined)
    !== (value.inputPlan !== undefined && value.state !== 'resume-pending')) {
    context.addIssue({ code: 'custom', message: 'Forked Run delivery evidence differs from its state' })
  }
})

/** Current Runs retain the exact historical manual-Run schema alongside forked Runs. */
export const currentAgentRunRecordSchema = z.union([agentRunRecordSchema, forkedAgentRunRecordSchema])
/** Parsed current Run record. */
export type CurrentAgentRunRecord = z.infer<typeof currentAgentRunRecordSchema>
/** Parsed history-forked Run record. */
export type ForkedAgentRunRecord = z.infer<typeof forkedAgentRunRecordSchema>
/** Parsed operator request for Work Session model succession. */
export type SwitchWorkSessionModelIntent = z.infer<typeof switchWorkSessionModelIntentSchema>
/** Parsed durable model succession Intent. */
export type RunModelSwitchIntentRecord = z.infer<typeof runModelSwitchIntentRecordSchema>

/** Stable receipt for exact retries of a model switch. */
export type SwitchWorkSessionModelResult =
  | {
    readonly ok: true
    readonly receipt: {
      readonly intentId: SwitchWorkSessionModelIntent['intentId']
      readonly state: RunModelSwitchIntentRecord['state']
      readonly agentRunId: RunModelSwitchIntentRecord['hostRequest']['target']['agentRunId']
      readonly sessionId: RunModelSwitchIntentRecord['hostRequest']['target']['sessionId']
    }
  }
  | { readonly ok: false; readonly reason: 'denied' | 'conflict' | 'unavailable' }
