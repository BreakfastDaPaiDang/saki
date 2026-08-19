/** Browser-safe Saki Host API schemas and inferred wire values. @module @breakfastdapaidang/saki-host-api/wire */

import { z } from 'zod'

/** Strict body schema for endpoints with no operation fields. */
export const sakiEmptyRequestSchema = z.object({}).strict()

/** Strict bootstrap exchange body schema. */
export const sakiBootstrapExchangeRequestSchema = z.object({
  secret: z.string().min(1).max(512),
}).strict()

/** Closed B01 query body schema. */
export const sakiQueryRequestSchema = z.object({
  type: z.literal('project-index'),
}).strict()

/** Authenticated member of the Access Projection schema. */
export const sakiAuthenticatedAccessProjectionSchema = z.object({
  kind: z.literal('authenticated'),
  principal: z.object({ id: z.string(), displayName: z.string() }).strict(),
  expiresAt: z.number().int().nonnegative(),
  requestToken: z.string().min(1),
}).strict()

/** Display-safe Access Projection schema. */
export const sakiAccessProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['bootstrap-required', 'session-required', 'unavailable']),
    message: z.string(),
  }).strict(),
  sakiAuthenticatedAccessProjectionSchema,
])

/** Bootstrap exchange business-result schema. */
export const sakiAccessExchangeResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), access: sakiAuthenticatedAccessProjectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
])

/** Logout business-result schema. */
export const sakiAccessLogoutResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.literal('unavailable') }).strict(),
])

/** Empty Project-index Projection schema. */
export const sakiProjectIndexProjectionSchema = z.object({
  type: z.literal('project-index'),
  revision: z.literal(0),
  projects: z.tuple([]),
}).strict()

/** Protected query business-result schema. */
export const sakiQueryResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), projection: sakiProjectIndexProjectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(['denied', 'unavailable']) }).strict(),
])

/** Empty-Intent submission business-result schema. */
export const sakiIntentUnavailableResultSchema = z.object({
  ok: z.literal(false),
  reason: z.enum(['intent-unavailable', 'denied', 'unavailable']),
}).strict()

/** Browser Access Projection inferred from the strict wire schema. */
export type SakiWireAccessProjection = z.infer<typeof sakiAccessProjectionSchema>
/** Browser bootstrap exchange result inferred from the strict wire schema. */
export type SakiWireAccessExchangeResult = z.infer<typeof sakiAccessExchangeResultSchema>
/** Browser logout result inferred from the strict wire schema. */
export type SakiWireAccessLogoutResult = z.infer<typeof sakiAccessLogoutResultSchema>
/** Browser Project-index Projection inferred from the strict wire schema. */
export type SakiWireProjectIndexProjection = z.infer<typeof sakiProjectIndexProjectionSchema>
/** Browser protected query result inferred from the strict wire schema. */
export type SakiWireQueryResult = z.infer<typeof sakiQueryResultSchema>
