/** Strict GraphQL envelope handling for Product App reads. @module @breakfastdapaidang/saki-github-app/graphql */

import { z } from 'zod'
import type { Octokit } from '@octokit/core'
import {
  GitHubProviderError,
  githubRepositoryDatabaseIdSchema,
} from '@breakfastdapaidang/saki-github'
import { githubRateLimitFailure } from './errors.ts'

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
}).loose()

/** Common GraphQL Repository fields admitted by Product App reads. */
export const graphqlRepositoryNodeSchema = z.object({
  id: z.string().min(1),
  databaseId: githubRepositoryDatabaseIdSchema,
  nameWithOwner: z.string().min(3),
  visibility: z.enum(['PUBLIC', 'PRIVATE', 'INTERNAL']),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  owner: z.object({ id: z.string().min(1) }).loose(),
}).loose()

/** Common GraphQL ProjectV2 fields admitted by Product App reads. */
export const graphqlProjectNodeSchema = z.object({
  id: z.string().min(1),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  title: z.string().min(1),
  closed: z.boolean(),
  url: z.url(),
  updatedAt: z.iso.datetime(),
  owner: z.object({ id: z.string().min(1) }).loose(),
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

/**
 * Execute one GraphQL document and reject partial data before projection.
 * @param client - operation-scoped installation client.
 * @param query - named GraphQL query document.
 * @param variables - typed provider variables.
 * @param signal - operation lifetime.
 * @param operation - safe failure attribution.
 * @returns the untrusted `data` member for an operation-specific parser.
 */
export async function queryGraphql(
  client: Octokit,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  const response = await client.request('POST /graphql', {
    query,
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
