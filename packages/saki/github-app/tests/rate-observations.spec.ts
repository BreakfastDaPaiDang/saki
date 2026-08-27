import {
  GITHUB_RATE_OBSERVATION_LIMIT,
  GitHubProviderError,
} from '@breakfastdapaidang/saki-github'
import type { GitHubRateObservation } from '@breakfastdapaidang/saki-github'
import { expect, it } from 'vitest'
import { appendGitHubRateObservation } from '../src/rate-observations.ts'

const OBSERVATION: GitHubRateObservation = {
  kind: 'graphql',
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: 1,
  observedAt: 1,
}

it('admits the exact Service rate-observation limit and fails before retaining one more', () => {
  const observations = Array.from(
    { length: GITHUB_RATE_OBSERVATION_LIMIT - 1 },
    () => OBSERVATION,
  )

  appendGitHubRateObservation(observations, OBSERVATION)
  expect(observations).toHaveLength(GITHUB_RATE_OBSERVATION_LIMIT)
  expect(() => { appendGitHubRateObservation(observations, OBSERVATION) }).toThrow(
    expect.objectContaining<Partial<GitHubProviderError>>({
      failure: { code: 'invalid-external-response', operation: 'rate-observations' },
    }),
  )
  expect(observations).toHaveLength(GITHUB_RATE_OBSERVATION_LIMIT)
})
