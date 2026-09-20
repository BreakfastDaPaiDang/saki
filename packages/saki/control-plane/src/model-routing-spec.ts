/** Immutable account selection captured by versioned Agent Profiles. @module @breakfastdapaidang/saki-control-plane/model-routing-spec */

import { z } from 'zod'
import { modelAccountBindingSchema, modelAccountRecordSchema } from './model-supply-spec.ts'
import { sakiAgentProfileIdSchema, sakiControlIntentIdSchema, sakiDevelopmentProjectIdSchema } from './ids.ts'
import { controlIntentActorSchema } from './spec.ts'

const revision = z.number().int().nonnegative()

/** An operator choice names one account configuration revision, never a mutable default. */
export const accountModelSelectionSchema = z.object({
  accountProfileId: modelAccountBindingSchema.shape.profileId,
  configurationRevision: modelAccountBindingSchema.shape.revision,
  model: z.string().min(1).max(200),
}).strict()

/** Detached route facts retained independently of subsequent account display edits. */
export const resolvedAccountModelRouteSchema = z.object({
  selection: accountModelSelectionSchema,
  provider: modelAccountBindingSchema.shape.routeId,
  accountIdentity: modelAccountBindingSchema.shape.accountIdentity.unwrap(),
  implementation: modelAccountRecordSchema.shape.implementation,
  configuration: modelAccountBindingSchema.shape.configuration,
}).strict().refine(value => value.provider === `saki-account-${value.selection.accountProfileId}-${value.selection.configurationRevision}`,
  'Account route does not match its selected configuration revision')

/** Permanent account attribution for one immutable Agent Profile. */
export const agentProfileModelRouteRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: sakiAgentProfileIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  profileVersion: z.number().int().positive(),
  agentPresetId: z.string().min(1),
  intentId: sakiControlIntentIdSchema,
  route: resolvedAccountModelRouteSchema,
  createdAt: z.number().nonnegative(),
}).strict()

/** Select a project's next Agent Profile without modifying any retained Run. */
export const configureProjectModelRouteIntentSchema = z.object({
  type: z.literal('configure-project-model-route'),
  intentId: sakiControlIntentIdSchema,
  projectId: sakiDevelopmentProjectIdSchema,
  expectedProjectRevision: revision,
  selection: accountModelSelectionSchema,
}).strict()

/** Replayable admission captures route resolution before modifying the Project Registry. */
export const projectModelRouteIntentRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: sakiControlIntentIdSchema,
  request: configureProjectModelRouteIntentSchema,
  actor: controlIntentActorSchema,
  profile: agentProfileModelRouteRecordSchema,
  state: z.enum(['accepted', 'completed', 'failed']),
  createdAt: z.number().nonnegative(),
  updatedAt: z.number().nonnegative(),
}).strict()

/** Parsed explicit account and model choice. */
export type AccountModelSelection = z.infer<typeof accountModelSelectionSchema>
/** Parsed detached account route resolution. */
export type ResolvedAccountModelRoute = z.infer<typeof resolvedAccountModelRouteSchema>
/** Parsed immutable Agent Profile attribution. */
export type AgentProfileModelRouteRecord = z.infer<typeof agentProfileModelRouteRecordSchema>
/** Parsed Project default selection request. */
export type ConfigureProjectModelRouteIntent = z.infer<typeof configureProjectModelRouteIntentSchema>
/** Parsed replayable Project default selection. */
export type ProjectModelRouteIntentRecord = z.infer<typeof projectModelRouteIntentRecordSchema>

/** Safe Project selection view with provider configuration kept on the Host. */
export interface ProjectModelRouteProjection {
  readonly type: 'project-model-route'
  readonly projectId: ConfigureProjectModelRouteIntent['projectId']
  readonly projectRevision: number
  readonly profile: {
    readonly id: AgentProfileModelRouteRecord['id']
    readonly version: number
    readonly agentPresetId: string
    readonly provider: string | null
    readonly model: string | null
    readonly account: Omit<ResolvedAccountModelRoute, 'configuration'> | null
  }
}
