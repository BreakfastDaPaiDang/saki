/** Strict GraphQL envelope handling for Product App reads. @module @breakfastdapaidang/saki-github-app/graphql */

import { z } from 'zod'
import type { Octokit } from '@octokit/core'
import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import { githubRateLimitFailure } from './errors.ts'

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.unknown()).optional(),
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
