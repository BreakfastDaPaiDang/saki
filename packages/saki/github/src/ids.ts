/** Runtime constructors and strict schemas for GitHub-owned opaque ids. @module @breakfastdapaidang/saki-github/ids */

import { z } from 'zod'
import type {
  GitHubAccountId,
  GitHubAppId,
  GitHubCommitId,
  GitHubCommitStatusId,
  GitHubCheckRunId,
  GitHubExternalOperationId,
  GitHubInstallationId,
  GitHubIssueId,
  GitHubIssueCreateMarkerId,
  GitHubMilestoneId,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemId,
  GitHubProjectOptionId,
  GitHubPullRequestId,
  GitHubPullRequestReviewId,
  GitHubPullRequestCreateMarkerId,
  GitHubReleaseId,
  GitHubReleaseTagName,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
  GitHubTagObjectId,
  GitHubWorkflowRunId,
  GitHubWorkflowId,
} from './types.ts'

const nodeId = <T extends string>() => z.string().min(1).max(1_024).regex(/^[^\u0000-\u001f\u007f]+$/).transform(value => value as T)
const positiveDecimalId = <T extends string>() => z.string().regex(/^[1-9][0-9]*$/).max(40).transform(value => value as T)

/** Strict GitHub App-id schema. */
export const githubAppIdSchema = positiveDecimalId<GitHubAppId>()
/** Strict GitHub App installation-id schema. */
export const githubInstallationIdSchema = positiveDecimalId<GitHubInstallationId>()
/** Strict GitHub account node-id schema. */
export const githubAccountIdSchema = nodeId<GitHubAccountId>()
/** Strict GitHub Repository node-id schema. */
export const githubRepositoryIdSchema = nodeId<GitHubRepositoryId>()
/** Strict positive-decimal Repository database-id schema. */
export const githubRepositoryDatabaseIdSchema = positiveDecimalId<GitHubRepositoryDatabaseId>()
/** Strict GitHub Project v2 node-id schema. */
export const githubProjectIdSchema = nodeId<GitHubProjectId>()
/** Strict GitHub Project v2 field node-id schema. */
export const githubProjectFieldIdSchema = nodeId<GitHubProjectFieldId>()
/** Strict GitHub Project v2 option-id schema. */
export const githubProjectOptionIdSchema = nodeId<GitHubProjectOptionId>()
/** Strict GitHub Project v2 item node-id schema. */
export const githubProjectItemIdSchema = nodeId<GitHubProjectItemId>()
/** Strict GitHub Issue node-id schema. */
export const githubIssueIdSchema = nodeId<GitHubIssueId>()
/** Strict persisted Saki Work Item marker-id schema. */
export const githubIssueCreateMarkerIdSchema = z.string()
  .regex(/^work-item-marker-[0-9a-f]{64}$/)
  .transform(value => value as GitHubIssueCreateMarkerId)
/** Strict GitHub pull-request node-id schema. */
export const githubPullRequestIdSchema = nodeId<GitHubPullRequestId>()
/** Strict GitHub pull-request review node-id schema. */
export const githubPullRequestReviewIdSchema = nodeId<GitHubPullRequestReviewId>()
/** Strict persisted Pull Request creation marker schema. */
export const githubPullRequestCreateMarkerIdSchema = z.string()
  .regex(/^pull-request-marker-[0-9a-f]{64}$/)
  .transform(value => value as GitHubPullRequestCreateMarkerId)
/** Strict GitHub Milestone node-id schema. */
export const githubMilestoneIdSchema = nodeId<GitHubMilestoneId>()
/** Strict GitHub Actions workflow-run-id schema. */
export const githubWorkflowRunIdSchema = positiveDecimalId<GitHubWorkflowRunId>()
/** Strict GitHub Actions workflow-id schema. */
export const githubWorkflowIdSchema = positiveDecimalId<GitHubWorkflowId>()
/** Strict GitHub check-run-id schema. */
export const githubCheckRunIdSchema = positiveDecimalId<GitHubCheckRunId>()
/** Strict GitHub commit-status-id schema. */
export const githubCommitStatusIdSchema = positiveDecimalId<GitHubCommitStatusId>()
/** Strict annotated-tag object-id schema. */
export const githubTagObjectIdSchema = nodeId<GitHubTagObjectId>()
/** Strict GitHub Release node-id schema. */
export const githubReleaseIdSchema = nodeId<GitHubReleaseId>()
/** Strict exact Git commit-id schema. */
export const githubCommitIdSchema = z.string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .refine(value => /[1-9a-f]/.test(value), 'commit id must not be all zeroes')
  .transform(value => value as GitHubCommitId)
/** Strict exact Saki release-tag schema. */
export const githubReleaseTagNameSchema = z.string()
  .min(7)
  .max(255)
  .regex(/^saki-v[0-9A-Za-z][0-9A-Za-z._-]*$/)
  .transform(value => value as GitHubReleaseTagName)
/** Strict external-operation-id schema. */
export const githubExternalOperationIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
  .transform(value => value as GitHubExternalOperationId)
/** Brand one validated App id.
 * @param value - raw App id.
 * @returns validated branded id.
 */
export const githubAppId = (value: string): GitHubAppId => githubAppIdSchema.parse(value)
/** Brand one validated App installation id.
 * @param value - raw installation id.
 * @returns validated branded id.
 */
export const githubInstallationId = (value: string): GitHubInstallationId => githubInstallationIdSchema.parse(value)
/** Brand one validated account node id.
 * @param value - raw account node id.
 * @returns validated branded id.
 */
export const githubAccountId = (value: string): GitHubAccountId => githubAccountIdSchema.parse(value)
/** Brand one validated Repository node id.
 * @param value - raw Repository node id.
 * @returns validated branded id.
 */
export const githubRepositoryId = (value: string): GitHubRepositoryId => githubRepositoryIdSchema.parse(value)
/** Brand one validated Repository database id.
 * @param value - raw Repository database id.
 * @returns validated branded id.
 */
export const githubRepositoryDatabaseId = (value: string): GitHubRepositoryDatabaseId => githubRepositoryDatabaseIdSchema.parse(value)
/** Brand one validated Project node id.
 * @param value - raw Project node id.
 * @returns validated branded id.
 */
export const githubProjectId = (value: string): GitHubProjectId => githubProjectIdSchema.parse(value)
/** Brand one validated Project field node id.
 * @param value - raw Project field node id.
 * @returns validated branded id.
 */
export const githubProjectFieldId = (value: string): GitHubProjectFieldId => githubProjectFieldIdSchema.parse(value)
/** Brand one validated Project option id.
 * @param value - raw Project option id.
 * @returns validated branded id.
 */
export const githubProjectOptionId = (value: string): GitHubProjectOptionId => githubProjectOptionIdSchema.parse(value)
/** Brand one validated Project item node id.
 * @param value - raw Project item node id.
 * @returns validated branded id.
 */
export const githubProjectItemId = (value: string): GitHubProjectItemId => githubProjectItemIdSchema.parse(value)
/** Brand one validated Issue node id.
 * @param value - raw Issue node id.
 * @returns validated branded id.
 */
export const githubIssueId = (value: string): GitHubIssueId => githubIssueIdSchema.parse(value)
/** Brand one validated persisted Work Item marker id.
 * @param value - raw marker id.
 * @returns validated branded marker id.
 */
export const githubIssueCreateMarkerId = (value: string): GitHubIssueCreateMarkerId => githubIssueCreateMarkerIdSchema.parse(value)
/** Brand one validated pull-request node id.
 * @param value - raw pull-request node id.
 * @returns validated branded id.
 */
export const githubPullRequestId = (value: string): GitHubPullRequestId => githubPullRequestIdSchema.parse(value)
/** Brand one validated pull-request review node id.
 * @param value - raw pull-request review node id.
 * @returns validated branded id.
 */
export const githubPullRequestReviewId = (value: string): GitHubPullRequestReviewId => (
  githubPullRequestReviewIdSchema.parse(value)
)
/** Brand one validated Pull Request creation marker id.
 * @param value - raw marker id.
 * @returns validated branded marker id.
 */
export const githubPullRequestCreateMarkerId = (value: string): GitHubPullRequestCreateMarkerId => (
  githubPullRequestCreateMarkerIdSchema.parse(value)
)
/** Brand one validated Milestone node id.
 * @param value - raw Milestone node id.
 * @returns validated branded id.
 */
export const githubMilestoneId = (value: string): GitHubMilestoneId => githubMilestoneIdSchema.parse(value)
/** Brand one validated workflow-run id.
 * @param value - raw positive-decimal workflow-run id.
 * @returns validated branded id.
 */
export const githubWorkflowRunId = (value: string): GitHubWorkflowRunId => githubWorkflowRunIdSchema.parse(value)
/** Brand one validated workflow id.
 * @param value - raw positive-decimal workflow id.
 * @returns validated branded id.
 */
export const githubWorkflowId = (value: string): GitHubWorkflowId => githubWorkflowIdSchema.parse(value)
/** Brand one validated check-run id.
 * @param value - raw positive-decimal check-run id.
 * @returns validated branded id.
 */
export const githubCheckRunId = (value: string): GitHubCheckRunId => githubCheckRunIdSchema.parse(value)
/** Brand one validated commit-status id.
 * @param value - raw positive-decimal commit-status id.
 * @returns validated branded id.
 */
export const githubCommitStatusId = (value: string): GitHubCommitStatusId => githubCommitStatusIdSchema.parse(value)
/** Brand one validated annotated-tag object id.
 * @param value - raw annotated-tag object id.
 * @returns validated branded id.
 */
export const githubTagObjectId = (value: string): GitHubTagObjectId => githubTagObjectIdSchema.parse(value)
/** Brand one validated Release node id.
 * @param value - raw Release node id.
 * @returns validated branded id.
 */
export const githubReleaseId = (value: string): GitHubReleaseId => githubReleaseIdSchema.parse(value)
/** Brand one validated Commit id.
 * @param value - raw Commit id.
 * @returns validated branded id.
 */
export const githubCommitId = (value: string): GitHubCommitId => githubCommitIdSchema.parse(value)
/** Brand one validated Saki release-tag name.
 * @param value - raw Saki release-tag name.
 * @returns validated branded name.
 */
export const githubReleaseTagName = (value: string): GitHubReleaseTagName => githubReleaseTagNameSchema.parse(value)
/** Brand one validated external-operation id.
 * @param value - raw external-operation id.
 * @returns validated branded id.
 */
export const githubExternalOperationId = (value: string): GitHubExternalOperationId => githubExternalOperationIdSchema.parse(value)
