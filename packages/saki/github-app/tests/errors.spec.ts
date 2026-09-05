import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import { describe, expect, it } from 'vitest'
import {
  GitHubResponseLimitError,
  githubRateLimitFailure,
  githubRestRateObservation,
  translateGitHubError,
} from '../src/errors.ts'

const VALID_RATE_HEADERS = {
  'x-ratelimit-limit': '10',
  'x-ratelimit-used': '2',
  'x-ratelimit-remaining': '8',
  'x-ratelimit-reset': '100',
  'x-ratelimit-resource': 'core',
}

function translated(error: unknown, signal = new AbortController().signal): GitHubProviderError['failure'] {
  return translateGitHubError(error, 'test-operation', signal).failure
}

describe('rate-limit evidence', () => {
  it('does not classify incomplete headers as a primary limit', () => {
    expect(githubRateLimitFailure({}, false)).toBeUndefined()
    expect(githubRateLimitFailure({ 'x-ratelimit-remaining': '1' }, false)).toBeUndefined()
  })

  it('classifies secondary and primary limits without retaining unsafe request ids', () => {
    expect(githubRateLimitFailure({ 'retry-after': '3', 'x-github-request-id': 'request/1' }, false)?.failure)
      .toEqual({ code: 'secondary-rate-limit', retryAfterMs: 3_000, requestId: 'request/1' })
    expect(githubRateLimitFailure({ 'x-github-request-id': 'unsafe id' }, true)?.failure)
      .toEqual({ code: 'secondary-rate-limit' })
    expect(githubRateLimitFailure({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '100',
      'x-github-request-id': 'request-2',
    }, false)?.failure).toEqual({
      code: 'primary-rate-limit',
      resetAt: 100_000,
      requestId: 'request-2',
    })
  })

  it('admits complete REST rate observations with optional retry evidence', () => {
    expect(githubRestRateObservation(VALID_RATE_HEADERS, 'rate')).toMatchObject({
      kind: 'rest',
      resource: 'core',
      limit: 10,
      used: 2,
      remaining: 8,
      resetAt: 100_000,
    })
    expect(githubRestRateObservation({ ...VALID_RATE_HEADERS, 'retry-after': '4' }, 'rate'))
      .toMatchObject({ retryAfterMs: 4_000 })
  })

  it.each([
    ['headers are not an object', undefined],
    ['limit is missing', { ...VALID_RATE_HEADERS, 'x-ratelimit-limit': undefined }],
    ['limit is negative', { ...VALID_RATE_HEADERS, 'x-ratelimit-limit': '-1' }],
    ['used is missing', { ...VALID_RATE_HEADERS, 'x-ratelimit-used': undefined }],
    ['remaining is missing', { ...VALID_RATE_HEADERS, 'x-ratelimit-remaining': undefined }],
    ['reset is missing', { ...VALID_RATE_HEADERS, 'x-ratelimit-reset': undefined }],
    ['resource is missing', { ...VALID_RATE_HEADERS, 'x-ratelimit-resource': undefined }],
    ['resource is invalid', { ...VALID_RATE_HEADERS, 'x-ratelimit-resource': 'Core API' }],
    ['used exceeds limit', { ...VALID_RATE_HEADERS, 'x-ratelimit-used': '11', 'x-ratelimit-remaining': '0' }],
    ['remaining exceeds limit', { ...VALID_RATE_HEADERS, 'x-ratelimit-used': '0', 'x-ratelimit-remaining': '11' }],
    ['partition is inconsistent', { ...VALID_RATE_HEADERS, 'x-ratelimit-used': '1' }],
    ['retry-after is malformed', { ...VALID_RATE_HEADERS, 'retry-after': 'later' }],
    ['retry-after overflows milliseconds', { ...VALID_RATE_HEADERS, 'retry-after': '9007199254741' }],
    ['numeric header is unsafe', { ...VALID_RATE_HEADERS, 'x-ratelimit-limit': '9007199254740992' }],
    ['reset overflows milliseconds', { ...VALID_RATE_HEADERS, 'x-ratelimit-reset': '9007199254741' }],
  ])('rejects REST rate evidence when %s', (_description, headers) => {
    expect(() => githubRestRateObservation(headers, 'rate')).toThrow(
      expect.objectContaining<Partial<GitHubProviderError>>({
        failure: { code: 'invalid-external-response', operation: 'rate' },
      }),
    )
  })
})

describe('safe error translation', () => {
  it('preserves typed failures and gives cancellation precedence over raw errors', () => {
    const typed = new GitHubProviderError({ code: 'auth-unavailable' })
    expect(translateGitHubError(typed, 'test-operation', new AbortController().signal)).toBe(typed)

    const controller = new AbortController()
    controller.abort()
    expect(translated(new Error('secret'), controller.signal)).toEqual({ code: 'cancelled' })
  })

  it('maps direct and wrapped response admission failures', () => {
    expect(translated(new GitHubResponseLimitError())).toEqual({
      code: 'invalid-external-response',
      operation: 'test-operation',
    })
    expect(translated({ cause: new GitHubResponseLimitError() })).toEqual({
      code: 'invalid-external-response',
      operation: 'test-operation',
    })
  })

  it('classifies a Fetch network rejection without an HTTP status as transient transport', () => {
    expect(translated(new TypeError('fetch failed'))).toEqual({ code: 'transient-transport' })
  })

  it.each([
    [401, { code: 'auth-unavailable' }],
    [404, { code: 'not-found', resource: 'test-operation', requestId: 'request-404' }],
    [422, { code: 'permanent-rejection', status: 422, requestId: 'request-422' }],
    [500, { code: 'transient-transport', requestId: 'request-500' }],
  ])('maps HTTP status %i to a closed failure', (status, expected) => {
    expect(translated({
      status,
      response: { headers: { 'x-github-request-id': `request-${status}` } },
    })).toEqual(expected)
  })

  it('uses response status and classifies primary and secondary rate limits', () => {
    expect(translated({ response: {
      status: 403,
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '200',
      },
    } })).toEqual({ code: 'primary-rate-limit', resetAt: 200_000 })
    expect(translated({ response: {
      status: 429,
      headers: { 'retry-after': '2', 'x-github-request-id': 'request-429' },
    } })).toEqual({ code: 'secondary-rate-limit', retryAfterMs: 2_000, requestId: 'request-429' })
    expect(translated({ status: 429, response: { headers: {} } }))
      .toEqual({ code: 'secondary-rate-limit' })
    expect(translated({ status: 403, response: { headers: {} } }))
      .toEqual({ code: 'permanent-rejection', status: 403 })
  })

  it.each([
    [404, { code: 'not-found', resource: 'test-operation' }, ['requestId']],
    [429, { code: 'secondary-rate-limit' }, ['retryAfterMs', 'requestId']],
    [503, { code: 'transient-transport' }, ['retryAfterMs', 'requestId']],
  ] as const)('omits unavailable optional evidence for HTTP status %i', (status, expected, absent) => {
    const failure = translated({ status, response: { headers: {} } })
    expect(failure).toStrictEqual(expected)
    for (const property of absent) expect(Object.hasOwn(failure, property)).toBe(false)
    expect(JSON.parse(JSON.stringify(failure))).toStrictEqual(failure)
  })

  it.each([undefined, null, '500', 99, 600, 500.5])(
    'rejects an invalid or absent HTTP status %j without retaining raw values',
    (status) => {
      const error = status === undefined ? new Error('secret') : { status }
      expect(translated(error)).toEqual({
        code: 'invalid-external-response',
        operation: 'test-operation',
      })
    },
  )

  it('does not retain malformed request ids or retry values', () => {
    expect(translated({ status: 503, response: {
      headers: {
        'retry-after': 'later',
        'x-github-request-id': 'unsafe id',
      },
    } })).toEqual({ code: 'transient-transport' })
  })
})
