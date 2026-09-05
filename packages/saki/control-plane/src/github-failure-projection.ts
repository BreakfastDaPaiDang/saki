/** Browser-safe GitHub provider-failure projection. */

import type { GitHubFailure } from '@breakfastdapaidang/saki-github'

/** GitHub failure projected to a Browser; `auth-unavailable` omits `credentialRef`. */
export type SakiGitHubFailureProjection =
  | Exclude<GitHubFailure, { readonly code: 'auth-unavailable' }>
  | { readonly code: 'auth-unavailable' }

/**
 * Remove `credentialRef` from one provider failure before browser projection.
 * @param failure - trusted provider failure retained by an internal owner.
 * @returns detached browser-safe failure details.
 */
export function projectGitHubFailure(failure: GitHubFailure): SakiGitHubFailureProjection {
  if (failure.code === 'auth-unavailable') return { code: 'auth-unavailable' }
  return structuredClone(failure)
}
