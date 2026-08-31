/** Shared mapping identities for complete and targeted GitHub Work Item observations. */

import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type {
  GitHubProjectItemFact,
  GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
} from './types.ts'

/**
 * Derive one stable Saki Work Item id from its authoritative GitHub identities.
 * @param repositoryId - owning GitHub Repository node id.
 * @param issueId - owning GitHub Issue node id.
 * @returns stable product Work Item id.
 */
export function boardWorkItemId(repositoryId: string, issueId: string): SakiBoardWorkItemId {
  return `work-item-${canonicalDigest('saki/board-work-item/v1', { repositoryId, issueId })}` as SakiBoardWorkItemId
}

/**
 * Fingerprint one joined Work Item observed by a complete Board scan.
 * @param rawItems - every Project item in authoritative API order.
 * @param item - joined Project item being fingerprinted.
 * @param issueState - current GitHub Issue open state.
 * @returns product remote fingerprint used by mutation preconditions.
 */
export function joinedBoardRemoteFingerprint(
  rawItems: readonly GitHubProjectItemFact[],
  item: GitHubProjectItemFact,
  issueState: 'open' | 'closed',
): SakiBoardRemoteFingerprint {
  const previous = rawItems[item.apiOrder - 1]
  const next = rawItems[item.apiOrder + 1]
  return joinedFingerprint({
    projectItemId: item.id,
    statusOptionId: item.statusOptionId,
    archived: item.archived,
    issueState,
    apiOrder: item.apiOrder,
    previousProjectItemId: previous?.id,
    nextProjectItemId: next?.id,
  })
}

/**
 * Fingerprint one open Repository Issue absent from the configured Project.
 * @param repositoryId - owning GitHub Repository node id.
 * @param issueId - GitHub Issue node id.
 * @param issueState - current GitHub Issue open state.
 * @returns product remote fingerprint used by mutation preconditions.
 */
export function unjoinedBoardRemoteFingerprint(
  repositoryId: string,
  issueId: string,
  issueState: 'open' | 'closed',
): SakiBoardRemoteFingerprint {
  const digest = canonicalDigest('saki/board-remote-fingerprint/v1', {
    membership: { state: 'absent', repositoryId, issueId },
    status: 'inbox',
    issueState,
  })
  return `remote-fingerprint-${digest}` as SakiBoardRemoteFingerprint
}

/**
 * Map a targeted provider observation onto the same product fingerprint used
 * by complete Board publication without advancing its checkpoint.
 * @param snapshot - raw targeted Issue and Project membership facts.
 * @returns product remote fingerprint used by mutation preconditions.
 */
export function targetedBoardRemoteFingerprint(
  snapshot: GitHubTargetedWorkItemSnapshot,
): SakiBoardRemoteFingerprint {
  if (snapshot.membership.state === 'absent') {
    return unjoinedBoardRemoteFingerprint(
      snapshot.repositoryId,
      snapshot.issue.id,
      snapshot.issue.state,
    )
  }
  const item = snapshot.membership.item
  return joinedFingerprint({
    projectItemId: item.id,
    statusOptionId: item.statusOptionId,
    archived: item.archived,
    issueState: snapshot.issue.state,
    apiOrder: item.apiOrder,
    previousProjectItemId: item.previousItemId ?? undefined,
    nextProjectItemId: item.nextItemId ?? undefined,
  })
}

function joinedFingerprint(material: {
  readonly projectItemId: string
  readonly statusOptionId?: string | undefined
  readonly archived: boolean
  readonly issueState: 'open' | 'closed'
  readonly apiOrder: number
  readonly previousProjectItemId?: string | undefined
  readonly nextProjectItemId?: string | undefined
}): SakiBoardRemoteFingerprint {
  const digest = canonicalDigest('saki/board-remote-fingerprint/v1', {
    membership: { state: 'joined', projectItemId: material.projectItemId },
    statusOptionId: material.statusOptionId,
    archived: material.archived,
    issueState: material.issueState,
    apiOrder: material.apiOrder,
    previousProjectItemId: material.previousProjectItemId,
    nextProjectItemId: material.nextProjectItemId,
  })
  return `remote-fingerprint-${digest}` as SakiBoardRemoteFingerprint
}
