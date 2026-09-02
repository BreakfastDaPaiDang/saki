/** Provider-neutral GitHub Service Definition for Saki. @module @breakfastdapaidang/saki-github */

import { Context, Service } from '@deepseek-ai/cordis'
import { githubFailureSchema } from './schemas.ts'
import type { GitHubFailure, GitHubMutationMap, GitHubReadMap, GitHubScanMap } from './types.ts'

export {
  githubAccountId,
  githubAccountIdSchema,
  githubAppId,
  githubAppIdSchema,
  githubCommitId,
  githubCommitIdSchema,
  githubExternalOperationId,
  githubExternalOperationIdSchema,
  githubInstallationId,
  githubInstallationIdSchema,
  githubIssueId,
  githubIssueIdSchema,
  githubIssueCreateMarkerId,
  githubIssueCreateMarkerIdSchema,
  githubProjectFieldId,
  githubProjectFieldIdSchema,
  githubProjectId,
  githubProjectIdSchema,
  githubProjectItemId,
  githubProjectItemIdSchema,
  githubProjectOptionId,
  githubProjectOptionIdSchema,
  githubPullRequestId,
  githubPullRequestIdSchema,
  githubReleaseId,
  githubReleaseIdSchema,
  githubReleaseTagName,
  githubReleaseTagNameSchema,
  githubRepositoryDatabaseId,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryId,
  githubRepositoryIdSchema,
  githubTagObjectId,
  githubTagObjectIdSchema,
} from './ids.ts'
export {
  computeGitHubProjectBoardFingerprint,
} from './fingerprint.ts'
export {
  GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT,
  GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT,
  GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT,
  GITHUB_INSTALLATION_REPOSITORY_LIMIT,
  GITHUB_PROJECT_BOARD_FIELD_LIMIT,
  GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT,
  GITHUB_RATE_OBSERVATION_LIMIT,
  GITHUB_TAG_PEEL_DEPTH_LIMIT,
} from './constants.ts'
export {
  githubBranchSafetyFactSchema,
  githubBranchSafetyReadRequestSchema,
  githubCommitComparisonFactSchema,
  githubCommitFactSchema,
  githubCommitReadRequestSchema,
  githubCompareCommitsReadRequestSchema,
  githubFailureSchema,
  githubInstallationFactSchema,
  githubInstallationProfileSchema,
  githubInstallationReadRequestSchema,
  githubIssueStateSetInspectionSchema,
  githubIssueStateSnapshotSchema,
  githubIssueCreateInspectionHintSchema,
  githubIssueCreateInspectionSchema,
  githubIssueCreateRequestSchema,
  githubIssueFactSchema,
  githubIssueDetailFactSchema,
  githubIssueDetailReadRequestSchema,
  githubIssueReadRequestSchema,
  githubPermissionFactSchema,
  githubProjectBoardFingerprintSchema,
  githubProjectBoardScanCandidateSchema,
  githubProjectBoardScanRequestSchema,
  githubProjectBoardUpdateFenceSchema,
  githubProjectFactSchema,
  githubProjectFieldFactSchema,
  githubProjectItemContentSchema,
  githubProjectItemFactSchema,
  githubProjectItemAddInspectionSchema,
  githubProjectItemAddSnapshotSchema,
  githubProjectItemPositionSetInspectionSchema,
  githubProjectItemPositionSnapshotSchema,
  githubProjectItemStatusSetInspectionSchema,
  githubProjectOptionFactSchema,
  githubProjectReadRequestSchema,
  githubRateObservationSchema,
  githubReleaseByTagObservationSchema,
  githubReleaseByTagReadRequestSchema,
  githubReleaseFactSchema,
  githubRepositoryFactSchema,
  githubRepositoryReadRequestSchema,
  githubTagObjectFactSchema,
  githubTagObjectReadRequestSchema,
  githubTagPeelFactSchema,
  githubTagReferenceFactSchema,
  githubTagReferenceReadRequestSchema,
  githubTagTargetSchema,
} from './schemas.ts'
export type {
  GitHubBranchSafetyFact,
  GitHubBranchSafetyReadRequest,
  GitHubAccountId,
  GitHubAppId,
  GitHubCommitComparisonFact,
  GitHubCommitFact,
  GitHubCommitId,
  GitHubCommitReadRequest,
  GitHubCompareCommitsReadRequest,
  GitHubExternalOperationId,
  GitHubFailure,
  GitHubFailureCode,
  GitHubGraphqlRateObservation,
  GitHubInstallationFact,
  GitHubInstallationId,
  GitHubInstallationProfile,
  GitHubInstallationReadRequest,
  GitHubIssueFact,
  GitHubIssueDetailFact,
  GitHubIssueDetailReadRequest,
  GitHubIssueId,
  GitHubIssueCreateInspection,
  GitHubIssueCreateInspectionHint,
  GitHubIssueCreateInspectionOutcome,
  GitHubIssueCreateMarkerId,
  GitHubIssueCreateRequest,
  GitHubIssueCreateSnapshot,
  GitHubIssueReadRequest,
  GitHubIssueStateSetInspection,
  GitHubIssueStateSetRequest,
  GitHubMutationMap,
  GitHubPermissionFact,
  GitHubProjectBoardFingerprint,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectBoardUpdateFence,
  GitHubProjectFact,
  GitHubProjectFieldFact,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemContent,
  GitHubProjectItemFact,
  GitHubProjectItemAddInspection,
  GitHubProjectItemAddMembership,
  GitHubProjectItemAddRequest,
  GitHubProjectItemId,
  GitHubProjectItemPositionAnchorFact,
  GitHubProjectItemPositionMembership,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemPositionSetRequest,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  GitHubProjectOptionFact,
  GitHubProjectOptionId,
  GitHubProjectReadRequest,
  GitHubPullRequestId,
  GitHubRateObservation,
  GitHubReadMap,
  GitHubReadRequest,
  GitHubReadResult,
  GitHubReleaseByTagObservation,
  GitHubReleaseByTagReadRequest,
  GitHubReleaseFact,
  GitHubReleaseId,
  GitHubReleaseTagName,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryFact,
  GitHubRepositoryId,
  GitHubRepositoryReadRequest,
  GitHubRestRateObservation,
  GitHubScanMap,
  GitHubScanRequest,
  GitHubScanResult,
  GitHubSecondaryRateObservation,
  GitHubTagObjectFact,
  GitHubTagObjectId,
  GitHubTagObjectReadRequest,
  GitHubTagPeelFact,
  GitHubTagReferenceFact,
  GitHubTagReferenceReadRequest,
  GitHubTagTarget,
  GitHubTargetedProjectItemFact,
  GitHubProjectMembershipItemFact,
  GitHubTargetedWorkItemSnapshot,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider-neutral GitHub reads, scans, and mutations used by Saki Consumers. */
    sakiGitHub: SakiGitHub
  }
}

/** Safe typed exception thrown by a GitHub Service Provider. */
export class GitHubProviderError extends Error {
  /** Closed provider failure data. */
  readonly failure: GitHubFailure

  /**
   * @param failure - safe closed failure data; raw provider errors are not retained.
   */
  constructor(failure: GitHubFailure) {
    const admitted = githubFailureSchema.parse(failure) as GitHubFailure
    super(`GitHub provider failed: ${admitted.code}`)
    this.name = 'GitHubProviderError'
    this.failure = admitted
  }
}

/**
 * GitHub capability. Providers own authentication, pagination, response
 * admission, and scan rate observations. Consumers receive only complete
 * detached facts and mutation results, or a {@link GitHubProviderError}.
 */
export abstract class SakiGitHub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'sakiGitHub')
  }

  /**
   * Perform one typed provider-neutral GitHub read.
   * @param request - declaration-map read request.
   * @param signal - required caller lifetime and cancellation.
   * @returns one detached validated GitHub fact.
   */
  abstract read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']>

  /**
   * Perform one complete scan; pagination cursors and partial results never cross this interface.
   * @param request - declaration-map scan request including caller priority.
   * @param signal - required caller lifetime and cancellation.
   * @returns one detached complete validated scan candidate.
   */
  abstract scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']>

  /**
   * Dispatch one atomic GitHub mutation without provider retries.
   * @param request - declaration-map mutation request with a caller-persisted operation id.
   * @param signal - required caller lifetime and cancellation.
   * @returns the declaration-map result after one validated external call.
   */
  abstract dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']>

  /**
   * Inspect the exact external target of one mutation without publishing a complete scan.
   * @param request - the immutable request originally recorded for dispatch.
   * @param signal - required caller lifetime and cancellation.
   * @returns detached targeted facts; provider failures reject with {@link GitHubProviderError}.
   */
  abstract inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']>
}

export default SakiGitHub
