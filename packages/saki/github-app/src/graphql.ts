/** Strict GraphQL envelope handling for Product App operations. @module @breakfastdapaidang/saki-github-app/graphql */

import { z } from 'zod'
import type { Octokit } from '@octokit/core'
import {
  GitHubProviderError,
  githubIssueId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubGraphqlRateObservation,
  GitHubIssueFact,
} from '@breakfastdapaidang/saki-github'
import { githubRateLimitFailure } from './errors.ts'

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
}).loose()

/** Numeric GraphQL Repository database identity before provider-neutral branding. */
export const graphqlNumericRepositoryDatabaseIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

/** Common GraphQL owner identity selected by Product App documents. */
const graphqlOwnerIdentitySchema = z.object({ id: z.string().min(1) }).loose()

/** Common numeric Repository identity selected by mutation inspection documents. */
export const graphqlNumericRepositoryIdentitySchema = z.object({
  id: z.string().min(1),
  databaseId: graphqlNumericRepositoryDatabaseIdSchema,
}).loose()

/** Common owned numeric Repository identity selected by mutation inspection documents. */
export const graphqlOwnedNumericRepositoryIdentitySchema = graphqlNumericRepositoryIdentitySchema.extend({
  owner: graphqlOwnerIdentitySchema,
}).loose()

/** Common GraphQL connection cursor fields. */
export const graphqlPageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).nullable(),
}).loose()

/** Common Project revision selected by targeted inspection documents. */
export const graphqlProjectRevisionSchema = z.object({
  id: z.string().min(1),
  updatedAt: z.iso.datetime(),
}).loose()

/** Common owned Project revision selected by complete membership traversals. */
const graphqlOwnedProjectRevisionSchema = graphqlProjectRevisionSchema.extend({
  owner: graphqlOwnerIdentitySchema,
}).loose()

/** Targeted Project node revision with an admitted GraphQL type tag. */
export const graphqlProjectRevisionNodeSchema = graphqlProjectRevisionSchema.extend({
  __typename: z.literal('ProjectV2'),
}).loose()

/** Owned Project node revision with an admitted GraphQL type tag. */
export const graphqlOwnedProjectRevisionNodeSchema = graphqlOwnedProjectRevisionSchema.extend({
  __typename: z.literal('ProjectV2'),
}).loose()

/** Owned numeric Repository node identity with an admitted GraphQL type tag. */
export const graphqlOwnedNumericRepositoryNodeSchema = graphqlOwnedNumericRepositoryIdentitySchema.extend({
  __typename: z.literal('Repository'),
}).loose()

/** Common Project-item position fields selected by complete membership traversals. */
export const graphqlProjectItemPositionSchema = z.object({
  __typename: z.literal('ProjectV2Item'),
  id: z.string().min(1),
  isArchived: z.boolean(),
  updatedAt: z.iso.datetime(),
  project: graphqlOwnedProjectRevisionSchema,
}).loose()

/** Common single-select field value selected by Board reads and mutation inspections. */
export const graphqlSingleSelectFieldValueSchema = z.object({
  __typename: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  field: z.object({ id: z.string().min(1) }).loose().nullable().optional(),
}).loose()

/** Common paginated single-select field-value connection. */
export const graphqlSingleSelectFieldValuesSchema = z.object({
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nodes: z.array(graphqlSingleSelectFieldValueSchema),
  pageInfo: graphqlPageInfoSchema,
}).loose()

/** Common GraphQL Repository fields admitted by Product App reads. */
export const graphqlRepositoryNodeSchema = z.object({
  id: z.string().min(1),
  databaseId: githubRepositoryDatabaseIdSchema,
  nameWithOwner: z.string().min(3),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL']),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  owner: graphqlOwnerIdentitySchema,
}).loose()

/** Common GraphQL ProjectV2 fields admitted by Product App reads. */
export const graphqlProjectNodeSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().min(1),
  closed: z.boolean(),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  owner: graphqlOwnerIdentitySchema,
}).loose()

/** Common GraphQL Issue fields admitted by Product App reads. */
export const graphqlIssueNodeSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['OPEN', 'CLOSED']),
  title: z.string().min(1),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  repository: z.object({
    id: z.string().min(1),
    databaseId: githubRepositoryDatabaseIdSchema,
  }).loose(),
}).loose()

/** Common Issue fields with the owned numeric Repository identity used by mutation inspections. */
export const graphqlOwnedIssueNodeSchema = graphqlIssueNodeSchema.extend({
  repository: graphqlOwnedNumericRepositoryIdentitySchema,
}).loose()

/** Owned Issue target with an admitted GraphQL type tag. */
export const graphqlOwnedIssueTargetSchema = graphqlOwnedIssueNodeSchema.extend({
  __typename: z.literal('Issue'),
}).loose()

/**
 * Build the common bounded connection envelope around one operation-specific node schema.
 * @param nodeSchema - exact node shape selected by the owning GraphQL document.
 * @returns a loose connection schema with total count and cursor evidence.
 */
export function graphqlConnectionSchema<T extends z.ZodType>(
  nodeSchema: T,
): z.ZodType<{
  totalCount: number
  nodes: Array<z.output<T>>
  pageInfo: z.output<typeof graphqlPageInfoSchema>
}> {
  return z.object({
    totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nodes: z.array(nodeSchema),
    pageInfo: graphqlPageInfoSchema,
  }).loose()
}

/** Strict GraphQL primary-rate fields selected by Product App documents. */
export const graphqlRateSchema = z.object({
  cost: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  used: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  remaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resetAt: z.iso.datetime(),
}).loose().superRefine((rate, ctx) => {
  if (rate.used > rate.limit || rate.remaining > rate.limit || rate.used !== rate.limit - rate.remaining) {
    ctx.addIssue({ code: 'custom', message: 'primary rate counters must partition the reported limit' })
  }
})

/**
 * Project one admitted GraphQL rate object without retaining response metadata.
 * @param rate - parsed GraphQL rate fields.
 * @param observedAt - provider observation time.
 * @returns safe provider-neutral rate facts.
 */
export function graphqlRateObservation(
  rate: z.infer<typeof graphqlRateSchema>,
  observedAt: number,
): GitHubGraphqlRateObservation {
  return {
    kind: 'graphql',
    cost: rate.cost,
    limit: rate.limit,
    used: rate.used,
    remaining: rate.remaining,
    resetAt: graphqlTimestamp(rate.resetAt),
    observedAt,
  }
}

interface GraphqlIssueProjection {
  readonly id?: string | undefined
  readonly number?: number | undefined
  readonly state?: 'OPEN' | 'CLOSED' | undefined
  readonly title?: string | undefined
  readonly url?: string | undefined
  readonly updatedAt?: string | undefined
  readonly repository?: {
    readonly id: string
    readonly databaseId: string | number
  } | undefined
}

interface GraphqlProjectIssueTargetRequest {
  readonly projectId: string
  readonly repositoryId: string
  readonly repositoryDatabaseId: string
  readonly issueId: string
  readonly installation: { readonly accountId: string }
}

interface GraphqlProjectIssueTarget {
  readonly project: { readonly id: string; readonly owner: { readonly id: string } }
  readonly repository: {
    readonly id: string
    readonly databaseId: number
    readonly owner: { readonly id: string }
  }
  readonly issue: {
    readonly id: string
    readonly repository: {
      readonly id: string
      readonly databaseId: number
      readonly owner: { readonly id: string }
    }
  }
}

/**
 * Project one admitted or union-narrowed GraphQL Issue into provider-neutral facts.
 * @param issue - external Issue fields selected by the owning document.
 * @param operation - safe failure attribution when a union branch omits required fields.
 * @returns provider-neutral Issue facts.
 * @throws `GitHubProviderError` when a union branch omits a required Issue field.
 */
export function graphqlIssueFact(issue: GraphqlIssueProjection, operation: string): GitHubIssueFact {
  if (issue.id === undefined
    || issue.number === undefined
    || issue.state === undefined
    || issue.title === undefined
    || issue.url === undefined
    || issue.updatedAt === undefined
    || issue.repository === undefined) {
    invalidGraphqlResponse(operation)
  }
  return {
    id: githubIssueId(issue.id),
    repositoryId: githubRepositoryId(issue.repository.id),
    repositoryDatabaseId: githubRepositoryDatabaseId(String(issue.repository.databaseId)),
    number: issue.number,
    state: issue.state.toLowerCase() as 'open' | 'closed',
    title: issue.title,
    url: issue.url,
    updatedAt: graphqlTimestamp(issue.updatedAt),
  }
}

/**
 * Compare the complete Project, Repository, owner, and Issue identity selected by a mutation inspection.
 * @param request - immutable expected target identity.
 * @param target - admitted GraphQL target nodes.
 * @returns whether every selected identity belongs to the requested installation target.
 */
export function graphqlProjectIssueTargetMatches(
  request: GraphqlProjectIssueTargetRequest,
  target: GraphqlProjectIssueTarget,
): boolean {
  return target.project.id === request.projectId
    && target.project.owner.id === request.installation.accountId
    && target.repository.id === request.repositoryId
    && String(target.repository.databaseId) === request.repositoryDatabaseId
    && target.repository.owner.id === request.installation.accountId
    && target.issue.id === request.issueId
    && target.issue.repository.id === request.repositoryId
    && String(target.issue.repository.databaseId) === request.repositoryDatabaseId
    && target.issue.repository.owner.id === request.installation.accountId
}

/**
 * Select the unique Status option from admitted single-select values.
 * @param values - complete field-value connection entries.
 * @param statusFieldId - exact Status field identity.
 * @param operation - safe failure attribution for duplicate values.
 * @returns the selected option identity, or undefined when Status is unset.
 * @throws `GitHubProviderError` when the response contains duplicate Status values.
 */
export function graphqlSingleSelectStatusOptionId(
  values: readonly z.infer<typeof graphqlSingleSelectFieldValueSchema>[],
  statusFieldId: string,
  operation: string,
): ReturnType<typeof githubProjectOptionId> | undefined {
  const matches = values.filter(value => value.__typename === 'ProjectV2ItemFieldSingleSelectValue'
    && value.field?.id === statusFieldId)
  if (matches.length > 1) invalidGraphqlResponse(operation)
  const optionId = matches[0]?.optionId
  return optionId === undefined || optionId === null ? undefined : githubProjectOptionId(optionId)
}

/**
 * Advance one admitted GraphQL connection without accepting a missing or repeated cursor.
 * @param pageInfo - admitted connection cursor fields.
 * @param seen - cursors already consumed by the owning traversal.
 * @param operation - safe failure attribution.
 * @returns the next cursor, or null when traversal is complete.
 * @throws `GitHubProviderError` when a continuing page omits or repeats its cursor.
 */
export function nextGraphqlCursor(
  pageInfo: z.infer<typeof graphqlPageInfoSchema>,
  seen: Set<string>,
  operation: string,
): string | null {
  if (!pageInfo.hasNextPage) return null
  if (pageInfo.endCursor === null || seen.has(pageInfo.endCursor)) invalidGraphqlResponse(operation)
  seen.add(pageInfo.endCursor)
  return pageInfo.endCursor
}

/**
 * Parse one admitted GraphQL timestamp into a durable millisecond value.
 * @param value - ISO timestamp selected by the owning document.
 * @returns a nonnegative safe-integer epoch millisecond value.
 * @throws `GitHubProviderError` when the timestamp cannot be represented durably.
 */
export function graphqlTimestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalidGraphqlResponse('timestamp')
  return parsed
}

/**
 * Throw a provider-neutral not-found failure for one missing GraphQL resource.
 * @param resource - safe missing-resource name.
 * @returns never; this helper always throws.
 * @throws a provider-neutral not-found failure.
 */
export function graphqlNotFound(resource: string): never {
  throw new GitHubProviderError({ code: 'not-found', resource })
}

/**
 * Throw a provider-neutral admission failure for one malformed GraphQL response.
 * @param operation - safe GraphQL operation name.
 * @returns never; this helper always throws.
 * @throws a provider-neutral admission failure.
 */
export function invalidGraphqlResponse(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}

/**
 * Execute one GraphQL document and reject partial data before projection.
 * @param client - operation-scoped installation client.
 * @param document - named GraphQL query or mutation document.
 * @param variables - typed provider variables.
 * @param signal - operation lifetime.
 * @param operation - safe failure attribution.
 * @returns the untrusted `data` member for an operation-specific parser.
 */
export async function queryGraphql(
  client: Octokit,
  document: string,
  variables: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  const response = await client.request('POST /graphql', {
    query: document,
    variables,
    request: { signal },
  })
  const envelope = envelopeSchema.parse(response.data)
  if (envelope.errors !== undefined || envelope.data === undefined) {
    const rateFailure = githubRateLimitFailure(response.headers, isSecondaryRateLimit(envelope.errors))
    if (rateFailure !== undefined) throw rateFailure
    throw new GitHubProviderError({ code: 'invalid-external-response', operation })
  }
  return envelope.data
}

function isSecondaryRateLimit(errors: readonly unknown[] | undefined): boolean {
  if (errors === undefined) return false
  return errors.some((error) => {
    const record = typeof error === 'object' && error !== null
      ? error as Record<string, unknown>
      : undefined
    return typeof record?.message === 'string'
      && /(?:secondary rate limit|abuse detection)/iu.test(record.message)
  })
}
