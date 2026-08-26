/** Bounded rate-observation retention for GitHub operations. @module @breakfastdapaidang/saki-github-app/rate-observations */

import {
  GITHUB_RATE_OBSERVATION_LIMIT,
  GitHubProviderError,
} from '@breakfastdapaidang/saki-github'
import type { GitHubRateObservation } from '@breakfastdapaidang/saki-github'

/**
 * Retain one safe rate observation without exceeding the Service candidate limit.
 * @param target - operation-owned ordered observation array.
 * @param observation - admitted GraphQL, REST, or secondary-limit fact.
 */
export function appendGitHubRateObservation<T extends GitHubRateObservation>(
  target: T[],
  observation: T,
): void {
  if (target.length >= GITHUB_RATE_OBSERVATION_LIMIT) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: 'rate-observations' })
  }
  target.push(observation)
}
