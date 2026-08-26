import type { Octokit } from '@octokit/core'
import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import { describe, expect, it, vi } from 'vitest'
import { queryGraphql } from '../src/graphql.ts'

function clientWith(data: unknown, headers: unknown = {}): Octokit {
  return {
    request: vi.fn().mockResolvedValue({ data, headers }),
  } as unknown as Octokit
}

async function failureOf(promise: Promise<unknown>): Promise<GitHubProviderError['failure']> {
  const error = await promise.catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(GitHubProviderError)
  return (error as GitHubProviderError).failure
}

describe('GraphQL envelope admission', () => {
  it('returns complete data and forwards variables and cancellation', async () => {
    const client = clientWith({ data: { repository: { id: 'R_1' } } })
    const signal = new AbortController().signal

    await expect(queryGraphql(client, 'query Test { viewer { id } }', { owner: 'acme' }, signal, 'test'))
      .resolves.toEqual({ repository: { id: 'R_1' } })
    expect(client.request).toHaveBeenCalledWith('POST /graphql', {
      query: 'query Test { viewer { id } }',
      variables: { owner: 'acme' },
      request: { signal },
    })
  })

  it.each([
    ['missing data and errors', {}],
    ['an ordinary error', { errors: [{ message: 'repository missing' }] }],
    ['a primitive error', { errors: ['repository missing'] }],
    ['a null error', { errors: [null] }],
    ['an error with a non-string message', { errors: [{ message: 1 }] }],
  ])('rejects %s as an invalid external response', async (_description, envelope) => {
    await expect(failureOf(queryGraphql(
      clientWith(envelope),
      'query Test { viewer { id } }',
      {},
      new AbortController().signal,
      'test-query',
    ))).resolves.toEqual({ code: 'invalid-external-response', operation: 'test-query' })
  })

  it.each(['secondary rate limit', 'abuse detection mechanism']) (
    'classifies a GraphQL %s error as a secondary rate limit',
    async (message) => {
      await expect(failureOf(queryGraphql(
        clientWith({ errors: [{ message }] }, { 'x-github-request-id': 'request-1' }),
        'query Test { viewer { id } }',
        {},
        new AbortController().signal,
        'test-query',
      ))).resolves.toEqual({ code: 'secondary-rate-limit', requestId: 'request-1' })
    },
  )

  it('classifies primary rate-limit headers before rejecting missing data', async () => {
    await expect(failureOf(queryGraphql(
      clientWith({}, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '300',
      }),
      'query Test { viewer { id } }',
      {},
      new AbortController().signal,
      'test-query',
    ))).resolves.toEqual({ code: 'primary-rate-limit', resetAt: 300_000 })
  })
})
