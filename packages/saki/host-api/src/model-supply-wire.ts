/** Browser-safe Model Account requests and projections. @module @breakfastdapaidang/saki-host-api/model-supply-wire */

import { z } from 'zod'
import type { ModelAccountIntent, ModelAccountIntentResult, ModelSupplyProjection, SakiControlIntentId, SakiQueryResult } from '@breakfastdapaidang/saki-control-plane'

type Profile = ModelSupplyProjection['profiles'][number]
type Snapshot = NonNullable<Profile['snapshot']>
const profileId = z.uuid().transform(value => value as Profile['id'])
const intentId = z.string().regex(/^intent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .transform(value => value as SakiControlIntentId)
const providerId = z.string().regex(/^[a-z][a-z0-9-]*$/).transform(value => value as Profile['providerId'])
const routeId = z.string().regex(/^saki-account-[0-9a-f-]+-[1-9][0-9]*$/).transform(value => value as Profile['routeId'])
const revision = z.number().int().positive()
const name = z.string().trim().min(1).max(200)
const implementation = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict()
const state = z.enum(['accepted', 'authorizing', 'completed', 'cancelled', 'interrupted', 'failed'])
const existing = { intentId, profileId, expectedRevision: revision }

/** Strict credential-free account mutations. */
export const sakiModelAccountIntentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('authorize-model-account'), intentId, providerId, name,
    method: z.string().min(1), configuration: z.record(z.string(), z.json()).optional(),
    existing: z.object({ profileId, expectedRevision: revision }).strict().optional() }).strict(),
  z.object({ type: z.literal('set-model-account-active'), ...existing, active: z.boolean() }).strict(),
  z.object({ type: z.literal('rename-model-account'), ...existing, name }).strict(),
  z.object({ type: z.literal('refresh-model-account'), ...existing }).strict(),
  z.object({ type: z.literal('disconnect-model-account'), ...existing }).strict(),
  z.object({ type: z.literal('cancel-model-authorization'), intentId, authorizationIntentId: intentId }).strict(),
]) satisfies z.ZodType<ModelAccountIntent>

const availableUsage = z.object({
  state: z.literal('available'), observedAt: z.number(), source: z.string().min(1),
  windows: z.array(z.object({ id: z.string().min(1), unit: z.enum(['percent', 'tokens', 'requests', 'currency']),
    remaining: z.number().nonnegative(), limit: z.number().nonnegative().nullable(),
    resetsAt: z.number().nullable(), blocksRequests: z.boolean() }).strict()).min(1),
}).strict()
const usage = z.discriminatedUnion('state', [availableUsage,
  z.object({ state: z.enum(['temporarily-unavailable', 'unsupported']), observedAt: z.number(), source: z.string().min(1) }).strict(),
])
const snapshot = z.object({
  authentication: z.enum(['authorized', 'missing', 'reauthorization-required']),
  health: z.enum(['available', 'unavailable', 'unknown']), entitlement: z.enum(['unknown', 'denied']),
  identity: z.string().min(1).transform(value => value as NonNullable<Snapshot['identity']>).nullable(),
  protectionLevel: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).transform(value => value as NonNullable<Snapshot['protectionLevel']>).nullable(),
  observedAt: z.number(), usage,
  models: z.array(z.object({ provider: z.string(), id: z.string(), name: z.string(), description: z.string().optional(),
    inputModalities: z.array(z.enum(['text', 'image'])).optional(),
    context: z.object({ contextWindow: z.number().int().positive() }).strict().optional(),
    defaultMaxTokens: z.number().int().positive().optional(),
    reasoning: z.object({
      efforts: z.array(z.object({ id: z.string().min(1).transform(value => value as NonNullable<Snapshot['models'][number]['reasoning']>['efforts'][number]['id']),
        name: z.string(), description: z.string().optional() }).strict()),
      defaultEffort: z.string().min(1).transform(value => value as NonNullable<Snapshot['models'][number]['reasoning']>['efforts'][number]['id']).optional(),
    }).strict().optional(),
  }).strict()),
}).strict()
const progress = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }).strict(),
  z.object({ kind: z.literal('browser'), verificationUri: z.url() }).strict(),
  z.object({ kind: z.literal('device-code'), verificationUri: z.url(), userCode: z.string().min(1),
    expiresAt: z.number(), nextPollAt: z.number() }).strict(),
])

/** Model supply contains observable facts and route identities, never credential keys or payloads. */
export const sakiModelSupplyProjectionSchema: z.ZodType<ModelSupplyProjection> = z.object({
  type: z.literal('model-supply'),
  providers: z.array(z.object({ id: providerId, implementation,
    methods: z.array(z.object({ id: z.string().min(1), kind: z.enum(['browser', 'device-code', 'stored-credential']),
      name: z.string().optional() }).strict()) }).strict()),
  profiles: z.array(z.object({ id: profileId, name, revision, providerId, routeId, configurationRevision: revision,
    implementation, connected: z.boolean(), desiredActive: z.boolean(), effectiveActive: z.boolean(),
    snapshot: snapshot.nullable(), lastConfirmedUsage: availableUsage.nullable() }).strict()),
  authorizations: z.array(z.object({ intentId, profileId: profileId.nullable(), state, progress: progress.nullable() }).strict()),
}).strict() satisfies z.ZodType<ModelSupplyProjection>

/** Authenticated account inventory query result. */
export const sakiModelSupplyResultSchema: z.ZodType<SakiQueryResult<'model-supply'>> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiModelSupplyProjectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'unavailable']) }).strict(),
])

/** Durable acknowledgement for all account mutation requests. */
export const sakiModelAccountResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), receipt: z.object({ intentId, profileId: profileId.nullable(), state }).strict() }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'conflict', 'unavailable']) }).strict(),
]) satisfies z.ZodType<ModelAccountIntentResult>

/** Browser account inventory result. */
export type SakiWireModelSupplyResult = z.infer<typeof sakiModelSupplyResultSchema>
/** Browser account mutation request. */
export type SakiWireModelAccountIntent = z.infer<typeof sakiModelAccountIntentSchema>
/** Browser durable account mutation acknowledgement. */
export type SakiWireModelAccountResult = z.infer<typeof sakiModelAccountResultSchema>
