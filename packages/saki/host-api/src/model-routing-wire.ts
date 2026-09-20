/** Credential-free Project model selection transport. @module @breakfastdapaidang/saki-host-api/model-routing-wire */

import { z } from 'zod'
import { sakiAgentRunIdSchema, sakiWorkSessionIdSchema } from '@breakfastdapaidang/saki-execution'
import type {
  SwitchWorkSessionModelIntent, SwitchWorkSessionModelResult,
  ConfigureProjectModelRouteIntent, ProjectModelRouteProjection, ProjectModelRouteResult, SakiQueryResult,
} from '@breakfastdapaidang/saki-control-plane'

const projectId = z.string().regex(/^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(value => value as ConfigureProjectModelRouteIntent['projectId'])
const intentId = z.string().regex(/^intent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(value => value as ConfigureProjectModelRouteIntent['intentId'])
const profileId = z.string().regex(/^agent-profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).transform(value => value as ProjectModelRouteProjection['profile']['id'])
const selection = z.object({
  accountProfileId: z.uuid().transform(value => value as ConfigureProjectModelRouteIntent['selection']['accountProfileId']),
  configurationRevision: z.number().int().positive(), model: z.string().min(1).max(200),
}).strict()
type Account = NonNullable<ProjectModelRouteProjection['profile']['account']>
/** Immutable public account attribution; provider configuration remains on the Host. */
export const sakiModelRouteAttributionSchema = z.object({ selection,
  provider: z.string().regex(/^saki-account-[0-9a-f-]+-[1-9][0-9]*$/).transform(value => value as Account['provider']),
  accountIdentity: z.string().min(1).transform(value => value as Account['accountIdentity']),
  implementation: z.object({ name: z.string().min(1), version: z.string().min(1) }).strict(),
}).strict().refine(value => value.provider === `saki-account-${value.selection.accountProfileId}-${value.selection.configurationRevision}`,
  'Account route does not match its selected revision')

/** Expected-revision Project selection without credentials or resolved implementation objects. */
export const sakiConfigureProjectModelRouteIntentSchema = z.object({
  type: z.literal('configure-project-model-route'), intentId, projectId,
  expectedProjectRevision: z.number().int().nonnegative(), selection,
}).strict() satisfies z.ZodType<ConfigureProjectModelRouteIntent>

/** Safe Project selection response. */
export const sakiProjectModelRouteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: z.object({ type: z.literal('project-model-route'), projectId,
    projectRevision: z.number().int().nonnegative(), profile: z.object({ id: profileId, version: z.number().int().positive(),
      agentPresetId: z.string().min(1), provider: z.string().min(1).nullable(), model: z.string().min(1).nullable(),
      account: sakiModelRouteAttributionSchema.nullable() }).strict().refine(value => value.account === null
        || (value.provider === value.account.provider && value.model === value.account.selection.model),
    'Agent Profile differs from its account route') }).strict() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'not-found', 'unavailable']) }).strict(),
]) satisfies z.ZodType<SakiQueryResult<'project-model-route'>>

/** Durable acknowledgement for an exact selection Intent. */
export const sakiConfigureProjectModelRouteResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: z.object({ intentId, profileId,
    state: z.enum(['accepted', 'completed', 'failed']) }).strict() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]) satisfies z.ZodType<ProjectModelRouteResult>

/** Browser Project selection query result. */
export type SakiWireProjectModelRouteResult = z.infer<typeof sakiProjectModelRouteResultSchema>
/** Browser Project selection request. */
export type SakiWireConfigureProjectModelRouteIntent = z.infer<typeof sakiConfigureProjectModelRouteIntentSchema>
/** Browser Project selection acknowledgement. */
export type SakiWireConfigureProjectModelRouteResult = z.infer<typeof sakiConfigureProjectModelRouteResultSchema>

/** Revision-fenced Work Session model selection. */
export const sakiSwitchWorkSessionModelIntentSchema = z.object({
  type: z.literal('switch-work-session-model'), intentId, projectId,
  workSessionId: sakiWorkSessionIdSchema,
  expectedAgentRunId: sakiAgentRunIdSchema,
  expectedWorkSessionRevision: z.number().int().nonnegative(), selection,
}).strict() satisfies z.ZodType<SwitchWorkSessionModelIntent>

/** Exact successor identities and durable switch state. */
export const sakiSwitchWorkSessionModelResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: z.object({ intentId,
    agentRunId: sakiAgentRunIdSchema,
    sessionId: z.string().min(1).transform(value => value as Extract<SwitchWorkSessionModelResult, { ok: true }>['receipt']['sessionId']),
    state: z.enum(['accepted', 'completed', 'failed', 'reconciliation-required']),
  }).strict() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]) satisfies z.ZodType<SwitchWorkSessionModelResult>

/** Browser Work Session selection request. */
export type SakiWireSwitchWorkSessionModelIntent = z.infer<typeof sakiSwitchWorkSessionModelIntentSchema>
/** Browser Work Session selection acknowledgement. */
export type SakiWireSwitchWorkSessionModelResult = z.infer<typeof sakiSwitchWorkSessionModelResultSchema>
