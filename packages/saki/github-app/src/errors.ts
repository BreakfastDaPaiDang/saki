/** Safe GitHub SDK and transport error translation. @module @breakfastdapaidang/saki-github-app/errors */

import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import type { GitHubRestRateObservation } from '@breakfastdapaidang/saki-github'

/** Internal marker for an HTTP response that exceeds the configured admission limit. */
export class GitHubResponseLimitError extends Error {
  override name = 'GitHubResponseLimitError'
}

/**
 * Classify rate-limit evidence carried by a successful GraphQL HTTP response.
 * @param headers - untrusted response headers from Octokit.
 * @param secondary - whether the GraphQL error envelope identifies a secondary limit.
 * @returns a closed rate-limit failure, or undefined when the headers do not prove one.
 */
export function githubRateLimitFailure(
  headers: unknown,
  secondary: boolean,
): GitHubProviderError | undefined {
  const admitted = record(headers)
  const requestId = safeRequestId(header(admitted, 'x-github-request-id'))
  const retryAfterMs = retryAfter(header(admitted, 'retry-after'))
  if (secondary || retryAfterMs !== undefined) {
    return new GitHubProviderError({ code: 'secondary-rate-limit', retryAfterMs, requestId })
  }
  const remaining = nonnegativeInteger(header(admitted, 'x-ratelimit-remaining'))
  if (remaining !== 0) return undefined
  return new GitHubProviderError({
    code: 'primary-rate-limit',
    resetAt: epochSeconds(header(admitted, 'x-ratelimit-reset')),
    requestId,
  })
}

/**
 * Admit the complete primary-rate header set from one successful REST response.
 * @param headers - untrusted response headers from Octokit.
 * @param operation - safe operation name used when admission fails.
 * @returns a detached REST rate observation.
 */
export function githubRestRateObservation(
  headers: unknown,
  operation: string,
): GitHubRestRateObservation {
  const admitted = record(headers)
  const limit = nonnegativeInteger(header(admitted, 'x-ratelimit-limit'))
  const used = nonnegativeInteger(header(admitted, 'x-ratelimit-used'))
  const remaining = nonnegativeInteger(header(admitted, 'x-ratelimit-remaining'))
  const resetAt = epochSeconds(header(admitted, 'x-ratelimit-reset'))
  const resource = header(admitted, 'x-ratelimit-resource')
  const rawRetryAfter = header(admitted, 'retry-after')
  const retryAfterMs = retryAfter(rawRetryAfter)
  if (limit === undefined
    || used === undefined
    || remaining === undefined
    || resetAt === undefined
    || resource === undefined
    || !/^[a-z][a-z0-9_-]{0,99}$/u.test(resource)
    || used > limit
    || remaining > limit
    || used !== limit - remaining
    || (rawRetryAfter !== undefined && retryAfterMs === undefined)) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation })
  }
  return {
    kind: 'rest',
    resource,
    limit,
    used,
    remaining,
    resetAt,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    observedAt: Date.now(),
  }
}

/**
 * Translate SDK, HTTP, cancellation, and parser failures without retaining raw
 * response bodies, headers, URLs, tokens, or credential material.
 * @param error - unknown failure raised inside one provider operation.
 * @param operation - provider-neutral operation name.
 * @param signal - operation lifetime used to classify caller cancellation.
 * @returns a safe provider exception.
 */
export function translateGitHubError(
  error: unknown,
  operation: string,
  signal: AbortSignal,
): GitHubProviderError {
  if (error instanceof GitHubProviderError) return error
  if (signal.aborted) return new GitHubProviderError({ code: 'cancelled' })
  if (error instanceof GitHubResponseLimitError || record(error)?.cause instanceof GitHubResponseLimitError) {
    return new GitHubProviderError({ code: 'invalid-external-response', operation })
  }

  const response = record(record(error)?.response)
  const headers = record(response?.headers)
  const status = safeStatus(record(error)?.status) ?? safeStatus(response?.status)
  const requestId = safeRequestId(header(headers, 'x-github-request-id'))
  const retryAfterMs = retryAfter(header(headers, 'retry-after'))

  if (status === 401) return new GitHubProviderError({ code: 'auth-unavailable' })
  if (status === 404) return new GitHubProviderError({ code: 'not-found', resource: operation, requestId })
  if (status === 403 || status === 429) {
    const rateFailure = githubRateLimitFailure(headers, false)
    if (rateFailure !== undefined) return rateFailure
    if (status === 429) {
      return new GitHubProviderError({ code: 'secondary-rate-limit', retryAfterMs, requestId })
    }
  }
  if (status !== undefined && status >= 500) {
    return new GitHubProviderError({ code: 'transient-transport', retryAfterMs, requestId })
  }
  if (status !== undefined) {
    return new GitHubProviderError({ code: 'permanent-rejection', status, requestId })
  }
  if (error instanceof TypeError) {
    return new GitHubProviderError({ code: 'transient-transport' })
  }
  return new GitHubProviderError({ code: 'invalid-external-response', operation })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function header(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  return typeof value === 'string' ? value : undefined
}

function safeStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined
}

function safeRequestId(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value) ? value : undefined
}

function retryAfter(value: string | undefined): number | undefined {
  if (value === undefined || !/^[0-9]+$/.test(value)) return undefined
  const milliseconds = Number(value) * 1_000
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined
}

function nonnegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const normalized = value.replaceAll(',', '')
  if (!/^[0-9]+$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function epochSeconds(value: string | undefined): number | undefined {
  const seconds = nonnegativeInteger(value)
  if (seconds === undefined || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return undefined
  return seconds * 1_000
}
