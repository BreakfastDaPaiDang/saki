/** Bounded result projection for one stable Local Host inspection. @module @breakfastdapaidang/saki-execution-local/inspection-result */

import type {
  ActiveHostProjectBinding,
  InspectProjectResult,
  ProjectSelectionInspection,
} from '@breakfastdapaidang/saki-execution'
import type { StableLocalProjectSelectionFailureReason } from './inspection.ts'
import { ProjectGitStatusProjectionError } from './status.ts'

function bindingResourceMatches(
  binding: ActiveHostProjectBinding,
  current: ProjectSelectionInspection,
): boolean {
  const expected = binding.expectedInspection.trusted
  const actual = current.trusted
  return current.projection.hostId === binding.hostId
    && current.projection.workspaceId === binding.workspaceId
    && actual.canonicalWorktreePath === expected.canonicalWorktreePath
    && actual.canonicalGitDirectory === expected.canonicalGitDirectory
    && actual.canonicalCommonGitDirectory === expected.canonicalCommonGitDirectory
    && actual.gitDirectoryIdentity.digest === expected.gitDirectoryIdentity.digest
    && actual.commonGitDirectoryIdentity.digest === expected.commonGitDirectoryIdentity.digest
}

/**
 * Complete one already-stable bound inspection without leaking projection failures.
 * @param binding - current Resource Binding attributed to the observation.
 * @param current - stable selected-project identity and projection.
 * @param build - synchronous status projection over the same stable observation.
 * @returns one bounded Host inspection result.
 * @internal
 */
export function completeBoundProjectInspection(
  binding: ActiveHostProjectBinding,
  current: ProjectSelectionInspection,
  build: () => Omit<Extract<InspectProjectResult, { readonly ok: true }>, 'ok'>,
): InspectProjectResult {
  if (!bindingResourceMatches(binding, current)) return { ok: false, reason: 'binding-stale' }
  try {
    return { ok: true, ...build() }
  } catch (error) {
    if (error instanceof ProjectGitStatusProjectionError) return { ok: false, reason: error.reason }
    throw error
  }
}

/**
 * Project a stable-selection failure into the bounded Host inspection vocabulary.
 * @param reason - exact local selection failure.
 * @returns its public inspection failure.
 * @internal
 */
export function projectInspectionFailure(reason: StableLocalProjectSelectionFailureReason): InspectProjectResult {
  switch (reason) {
    case 'missing': return { ok: false, reason: 'missing' }
    case 'malformed': return { ok: false, reason: 'malformed' }
    case 'ambiguous': return { ok: false, reason: 'ambiguous' }
    case 'unavailable': return { ok: false, reason: 'unavailable' }
    case 'limit': return { ok: false, reason: 'limit' }
    case 'unsupported-index-state': return { ok: false, reason: 'unavailable' }
    case 'not-directory':
    case 'not-git':
    case 'bare':
    case 'prunable': return { ok: false, reason: 'binding-stale' }
  }
}
