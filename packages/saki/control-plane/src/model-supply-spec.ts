/** Durable Model Account Intents and operator-safe projections. @module @breakfastdapaidang/saki-control-plane/model-supply-spec */

import { z } from 'zod'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parseCredentialKey, credentialProtectionLevel } from '@deepseek-ai/dsh-credentials'
import type {
  ModelAccountIdentity, ModelAccountProfileId, ModelAccountProviderId, ModelAccountRouteId,
} from '@breakfastdapaidang/saki-model-account'
import { sakiControlIntentIdSchema } from './ids.ts'
import { controlIntentActorSchema } from './spec.ts'

/** Product Profile identity independent of a plugin's credential addressing. */
export const modelAccountProfileIdSchema = z.uuid().transform(value => value as ModelAccountProfileId)
const providerId = z.string().regex(/^[a-z][a-z0-9-]*$/).transform(value => value as ModelAccountProviderId)
const routeId = z.string().regex(/^saki-account-[0-9a-f-]+-[1-9][0-9]*$/).transform(value => value as ModelAccountRouteId)
const revision = z.number().int().positive()
const name = z.string().trim().min(1).max(200)
const implementation = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict()
const identity = z.string().min(1).transform(value => value as ModelAccountIdentity).nullable()

/** Immutable route inputs persisted without credential material. */
export const modelAccountBindingSchema = z.object({
  profileId: modelAccountProfileIdSchema,
  providerId,
  routeId,
  revision,
  credentialKey: z.string().transform(parseCredentialKey),
  requiredProtection: z.string().transform(credentialProtectionLevel),
  accountIdentity: identity,
  configuration: z.record(z.string(), z.json()),
}).strict()

/** Allowance retrieval is independent of authentication and never fills missing values with zero. */
export const modelAccountUsageSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'), observedAt: z.number(), source: z.string().min(1),
    windows: z.array(z.object({
      id: z.string().min(1), unit: z.enum(['percent', 'tokens', 'requests', 'currency']),
      remaining: z.number().nonnegative(), limit: z.number().nonnegative().nullable(),
      resetsAt: z.number().nullable(), blocksRequests: z.boolean(),
    }).strict()).min(1),
  }).strict(),
  z.object({ state: z.enum(['temporarily-unavailable', 'unsupported']),
    observedAt: z.number(), source: z.string().min(1) }).strict(),
])

/** Account observations retained independently of desired activation. */
export const modelAccountSnapshotSchema = z.object({
  authentication: z.enum(['authorized', 'missing', 'reauthorization-required']),
  health: z.enum(['available', 'unavailable', 'unknown']), entitlement: z.enum(['unknown', 'denied']),
  identity, protectionLevel: z.string().transform(credentialProtectionLevel).nullable(),
  observedAt: z.number(), usage: modelAccountUsageSchema,
  models: z.array(z.object({
    provider: z.string(), id: z.string(), name: z.string(), description: z.string().optional(),
    inputModalities: z.array(z.enum(['text', 'image'])).optional(),
    context: z.object({ contextWindow: z.number().int().positive() }).strict().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    reasoning: z.object({
      efforts: z.array(z.object({ id: z.string().min(1).transform(value => value as ReasoningEffortId),
        name: z.string(), description: z.string().optional() }).strict()),
      defaultEffort: z.string().min(1).transform(value => value as ReasoningEffortId).optional(),
    }).strict().optional(),
  }).strict()),
}).strict()

/** Structured login progress with no provider text or token-bearing fields. */
export const modelAccountProgressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }).strict(),
  z.object({ kind: z.literal('browser'), verificationUri: z.url() }).strict(),
  z.object({ kind: z.literal('device-code'), verificationUri: z.url(), userCode: z.string().min(1),
    expiresAt: z.number(), nextPollAt: z.number() }).strict(),
])

/** Current Profile record; display revisions do not rename the account-specific route. */
export const modelAccountRecordSchema = z.object({
  schemaVersion: z.literal(1), id: modelAccountProfileIdSchema, name, revision,
  binding: modelAccountBindingSchema, implementation, connected: z.boolean(), desiredActive: z.boolean(),
  snapshot: modelAccountSnapshotSchema.nullable(),
  lastConfirmedUsage: modelAccountUsageSchema.options[0].nullable(),
  changedByIntentId: sakiControlIntentIdSchema,
}).strict()

const existing = { intentId: sakiControlIntentIdSchema, profileId: modelAccountProfileIdSchema, expectedRevision: revision }

/** Account operations accepted only through authenticated Control Intents. */
export const modelAccountIntentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('authorize-model-account'), intentId: sakiControlIntentIdSchema,
    providerId, name, method: z.string().min(1), configuration: z.record(z.string(), z.json()).optional(),
    existing: z.object({ profileId: modelAccountProfileIdSchema, expectedRevision: revision }).strict().optional(),
  }).strict(),
  z.object({ type: z.literal('set-model-account-active'), ...existing, active: z.boolean() }).strict(),
  z.object({ type: z.literal('rename-model-account'), ...existing, name }).strict(),
  z.object({ type: z.literal('refresh-model-account'), ...existing }).strict(),
  z.object({ type: z.literal('disconnect-model-account'), ...existing }).strict(),
  z.object({ type: z.literal('cancel-model-authorization'), intentId: sakiControlIntentIdSchema,
    authorizationIntentId: sakiControlIntentIdSchema }).strict(),
])

/** One durable authorization or mutation receipt, including interrupted login attempts. */
export const modelAccountIntentRecordSchema = z.object({
  schemaVersion: z.literal(1), id: sakiControlIntentIdSchema, request: modelAccountIntentSchema,
  actor: controlIntentActorSchema, profileId: modelAccountProfileIdSchema.nullable(),
  binding: modelAccountBindingSchema.nullable(), implementation: implementation.nullable(),
  state: z.enum(['accepted', 'authorizing', 'completed', 'cancelled', 'interrupted', 'failed']),
  progress: modelAccountProgressSchema.nullable(),
  createdAt: z.number(), updatedAt: z.number(),
}).strict()

/** Persisted account Profile and its latest safe observations. */
export type ModelAccountRecord = z.infer<typeof modelAccountRecordSchema>
/** Validated operator account gesture. */
export type ModelAccountIntent = z.infer<typeof modelAccountIntentSchema>
/** Durable authorization or mutation state for exact replay. */
export type ModelAccountIntentRecord = z.infer<typeof modelAccountIntentRecordSchema>

/** Safe acknowledgement; query supplies current progress after connection loss. */
export type ModelAccountIntentResult =
  | {
    readonly ok: true
    readonly receipt: {
      readonly intentId: ModelAccountIntentRecord['id']
      readonly state: ModelAccountIntentRecord['state']
      readonly profileId: ModelAccountProfileId | null
    }
  }
  | { readonly ok: false; readonly reason: 'denied' | 'conflict' | 'unavailable' }

/** Host-owned account inventory; credentials remain behind the Provider interface. */
export interface ModelSupplyProjection {
  readonly type: 'model-supply'
  readonly providers: readonly {
    readonly id: ModelAccountProviderId
    readonly implementation: { readonly name: string; readonly version: string }
    readonly methods: readonly { readonly id: string; readonly kind: 'browser' | 'device-code' | 'stored-credential'; readonly name?: string | undefined }[]
  }[]
  readonly profiles: readonly {
    readonly id: ModelAccountProfileId
    readonly name: string
    readonly revision: number
    readonly providerId: ModelAccountProviderId
    readonly routeId: ModelAccountRouteId
    readonly configurationRevision: number
    readonly implementation: ModelAccountRecord['implementation']
    readonly connected: boolean
    readonly desiredActive: boolean
    readonly effectiveActive: boolean
    readonly snapshot: ModelAccountRecord['snapshot']
    readonly lastConfirmedUsage: ModelAccountRecord['lastConfirmedUsage']
  }[]
  readonly authorizations: readonly {
    readonly intentId: ModelAccountIntentRecord['id']
    readonly profileId: ModelAccountProfileId | null
    readonly state: ModelAccountIntentRecord['state']
    readonly progress: ModelAccountIntentRecord['progress']
  }[]
}
