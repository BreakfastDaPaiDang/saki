/** Strict runtime schemas for provider-admitted GitHub values. @module @breakfastdapaidang/saki-github/schemas */

import { z } from 'zod'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials/types'
import {
  GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT,
  GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT,
  GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT,
  GITHUB_INSTALLATION_REPOSITORY_LIMIT,
  GITHUB_PROJECT_BOARD_FIELD_LIMIT,
  GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT,
  GITHUB_RATE_OBSERVATION_LIMIT,
  GITHUB_TAG_PEEL_DEPTH_LIMIT,
} from './constants.ts'
import {
  computeGitHubProjectBoardFingerprint,
} from './fingerprint.ts'
import {
  githubAccountIdSchema,
  githubAppIdSchema,
  githubCommitIdSchema,
  githubExternalOperationIdSchema,
  githubInstallationIdSchema,
  githubIssueIdSchema,
  githubIssueCreateMarkerIdSchema,
  githubProjectFieldIdSchema,
  githubProjectIdSchema,
  githubProjectItemIdSchema,
  githubProjectOptionIdSchema,
  githubPullRequestIdSchema,
  githubReleaseIdSchema,
  githubReleaseTagNameSchema,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryIdSchema,
  githubTagObjectIdSchema,
} from './ids.ts'

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const safeTimestamp = safeInteger
const safeText = z.string().min(1).max(4_096).regex(/^[^\u0000\u007f]*$/)
const safeName = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/)
const safeRequestId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const credentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .transform(value => value as CredentialRef)
const safeUrl = z.url().max(2_048).refine((value) => {
  const parsed = new URL(value)
  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hash === ''
}, 'URL must be credential-free HTTPS without a fragment')

/** Strict caller installation profile schema. */
export const githubInstallationProfileSchema = z.object({
  appId: githubAppIdSchema,
  installationId: githubInstallationIdSchema,
  accountId: githubAccountIdSchema,
  privateKeyRef: credentialRefSchema,
}).strict()

/** Strict granted-permission fact schema. */
export const githubPermissionFactSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100),
  access: z.enum(['read', 'write', 'admin']),
}).strict()

const permissionFactsSchema = z.array(githubPermissionFactSchema).max(200).superRefine((facts, ctx) => {
  rejectDuplicate(facts.map(fact => fact.name), 'permission name', ctx)
})

/** Strict safe installation-fact schema. */
export const githubInstallationFactSchema = z.object({
  installationId: githubInstallationIdSchema,
  account: z.object({
    id: githubAccountIdSchema,
    login: safeName,
    type: z.enum(['organization', 'user']),
  }).strict(),
  repositorySelection: z.enum(['all', 'selected']),
  permissions: z.object({
    repository: permissionFactsSchema,
    organization: permissionFactsSchema,
  }).strict(),
  accessibleRepositoryIds: z.array(githubRepositoryIdSchema).max(GITHUB_INSTALLATION_REPOSITORY_LIMIT)
    .superRefine((ids, ctx) => {
      rejectDuplicate(ids, 'accessible Repository id', ctx)
    }),
  suspendedAt: safeTimestamp.optional(),
  tokenExpiresAt: safeTimestamp,
  observedAt: safeTimestamp,
}).strict()

/** Strict raw Repository-fact schema. */
export const githubRepositoryFactSchema = z.object({
  id: githubRepositoryIdSchema,
  databaseId: githubRepositoryDatabaseIdSchema,
  ownerAccountId: githubAccountIdSchema,
  nameWithOwner: z.string().regex(/^[^/\u0000-\u001f\u007f]+\/[^/\u0000-\u001f\u007f]+$/).max(201),
  visibility: z.enum(['public', 'private', 'internal']),
  url: safeUrl,
  updatedAt: safeTimestamp,
  observedAt: safeTimestamp,
}).strict()

/** Strict raw Project-fact schema. */
export const githubProjectFactSchema = z.object({
  id: githubProjectIdSchema,
  ownerAccountId: githubAccountIdSchema,
  number: positiveInteger,
  title: safeText,
  closed: z.boolean(),
  url: safeUrl,
  updatedAt: safeTimestamp,
  observedAt: safeTimestamp,
}).strict()

/** Strict raw Project single-select option schema. */
export const githubProjectOptionFactSchema = z.object({
  id: githubProjectOptionIdSchema,
  name: safeName,
}).strict()

const singleSelectFieldSchema = z.object({
  kind: z.literal('single-select'),
  id: githubProjectFieldIdSchema,
  name: safeName,
  options: z.array(githubProjectOptionFactSchema).max(10_000).superRefine((options, ctx) => {
    rejectDuplicate(options.map(option => option.id), 'Project option id', ctx)
  }),
}).strict()

const otherFieldSchema = z.object({
  kind: z.literal('field'),
  id: githubProjectFieldIdSchema,
  name: safeName,
  dataType: safeName,
}).strict()

/** Strict raw Project-field union schema. */
export const githubProjectFieldFactSchema = z.discriminatedUnion('kind', [singleSelectFieldSchema, otherFieldSchema])

/** Strict raw Issue-fact schema. */
export const githubIssueFactSchema = z.object({
  id: githubIssueIdSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  number: positiveInteger,
  state: z.enum(['open', 'closed']),
  title: safeText,
  url: safeUrl,
  updatedAt: safeTimestamp,
}).strict()

const githubIssueDetailBodySchema = z.string().max(GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT)
  .superRefine((value, ctx) => {
    if (!value.isWellFormed()) issue(ctx, 'Issue detail body must be well-formed Unicode')
    if (value.includes('\u0000')) issue(ctx, 'Issue detail body contains a forbidden NUL')
    if (utf8ByteLength(value) > GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT) {
      issue(ctx, 'Issue detail body exceeds the complete UTF-8 byte limit')
    }
  })

/** Strict complete targeted Issue-detail fact schema. */
export const githubIssueDetailFactSchema = githubIssueFactSchema.extend({
  body: githubIssueDetailBodySchema,
}).strict()

/** Strict raw Project-item content union schema. */
export const githubProjectItemContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('issue'), issue: githubIssueFactSchema }).strict(),
  z.object({
    kind: z.literal('pull-request'),
    id: githubPullRequestIdSchema,
    repositoryId: githubRepositoryIdSchema.optional(),
    url: safeUrl.optional(),
  }).strict(),
  z.object({ kind: z.literal('draft-issue'), title: safeText }).strict(),
  z.object({ kind: z.literal('redacted') }).strict(),
  z.object({ kind: z.literal('other'), typeName: safeName }).strict(),
])

/** Strict raw Project-item schema. */
export const githubProjectItemFactSchema = z.object({
  id: githubProjectItemIdSchema,
  projectId: githubProjectIdSchema,
  content: githubProjectItemContentSchema,
  statusOptionId: githubProjectOptionIdSchema.optional(),
  archived: z.boolean(),
  apiOrder: safeInteger,
  updatedAt: safeTimestamp,
}).strict()

/** Strict pre/post Project-board update-fence schema. */
export const githubProjectBoardUpdateFenceSchema = z.object({
  projectUpdatedAt: safeTimestamp,
  repositoryUpdatedAt: safeTimestamp,
  projectItemCount: safeInteger,
  openIssueCount: safeInteger,
}).strict()

const graphqlRateObservationSchema = z.object({
  kind: z.literal('graphql'),
  cost: safeInteger,
  limit: safeInteger,
  used: safeInteger,
  remaining: safeInteger,
  resetAt: safeTimestamp,
  observedAt: safeTimestamp,
}).strict().superRefine(validatePrimaryRateCounters)

const restRateObservationSchema = z.object({
  kind: z.literal('rest'),
  resource: safeName,
  limit: safeInteger,
  used: safeInteger,
  remaining: safeInteger,
  resetAt: safeTimestamp,
  retryAfterMs: safeInteger.optional(),
  observedAt: safeTimestamp,
}).strict().superRefine(validatePrimaryRateCounters)

/** Strict safe GitHub rate-observation union schema. */
export const githubRateObservationSchema = z.discriminatedUnion('kind', [
  graphqlRateObservationSchema,
  restRateObservationSchema,
  z.object({
    kind: z.literal('secondary-limit'),
    retryAfterMs: safeInteger.optional(),
    observedAt: safeTimestamp,
  }).strict(),
])

/** Strict version-1 Project-board fingerprint schema. */
export const githubProjectBoardFingerprintSchema = z.object({
  version: z.literal(1),
  digest,
}).strict()

const githubProjectBoardScanCandidateBaseSchema = z.object({
  kind: z.literal('project-board'),
  formatVersion: z.literal(1),
  installation: githubInstallationFactSchema,
  repository: githubRepositoryFactSchema,
  project: githubProjectFactSchema,
  statusFieldId: githubProjectFieldIdSchema,
  fields: z.array(githubProjectFieldFactSchema).max(GITHUB_PROJECT_BOARD_FIELD_LIMIT),
  items: z.array(githubProjectItemFactSchema).max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  openIssues: z.array(githubIssueFactSchema).max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  fences: z.object({
    before: githubProjectBoardUpdateFenceSchema,
    after: githubProjectBoardUpdateFenceSchema,
  }).strict(),
  rateObservations: z.array(githubRateObservationSchema).max(GITHUB_RATE_OBSERVATION_LIMIT),
  fingerprint: githubProjectBoardFingerprintSchema,
  observedAt: safeTimestamp,
}).strict()

/**
 * Strict complete Project-board candidate schema. It rejects mismatched target
 * identities, incomplete update fences, duplicate external ids, non-contiguous
 * API order, a missing/non-single-select Status field, conflicting same-Issue
 * facts, Repository Issue-number aliases, invalid open-Issue facts, and a stale
 * fingerprint.
 */
export const githubProjectBoardScanCandidateSchema = githubProjectBoardScanCandidateBaseSchema.superRefine(
  (candidate, ctx) => {
    if (candidate.installation.account.id !== candidate.repository.ownerAccountId
      || candidate.installation.account.id !== candidate.project.ownerAccountId) {
      issue(ctx, 'installation, Repository, and Project ownership must match')
    }
    if (candidate.installation.repositorySelection === 'selected'
      && !candidate.installation.accessibleRepositoryIds.includes(candidate.repository.id)) {
      issue(ctx, 'selected installation must include the scanned Repository')
    }

    rejectDuplicate(candidate.fields.map(field => field.id), 'Project field id', ctx)
    const statusFields = candidate.fields.filter(field => field.id === candidate.statusFieldId)
    if (statusFields.length !== 1 || statusFields[0]?.kind !== 'single-select') {
      issue(ctx, 'statusFieldId must identify exactly one single-select field')
    }

    rejectDuplicate(candidate.items.map(item => item.id), 'Project item id', ctx)
    rejectDuplicate(candidate.items.map(item => String(item.apiOrder)), 'Project item API order', ctx)
    for (const [index, item] of candidate.items.entries()) {
      if (item.projectId !== candidate.project.id) issue(ctx, 'Project item ownership must match the scanned Project')
      if (item.apiOrder !== index) issue(ctx, 'Project item API order must be contiguous from zero')
    }

    rejectDuplicate(candidate.openIssues.map(openIssue => openIssue.id), 'open Issue id', ctx)
    const openIssueById = new Map(candidate.openIssues.map(openIssue => [openIssue.id, openIssue] as const))
    for (const openIssue of candidate.openIssues) {
      if (openIssue.state !== 'open') issue(ctx, 'openIssues may contain only open Issues')
      if (openIssue.repositoryId !== candidate.repository.id
        || openIssue.repositoryDatabaseId !== candidate.repository.databaseId) {
        issue(ctx, 'open Issue ownership must match the scanned Repository')
      }
    }
    for (const item of candidate.items) {
      if (item.content.kind !== 'issue') continue
      const openIssue = openIssueById.get(item.content.issue.id)
      if (openIssue !== undefined && !sameIssue(item.content.issue, openIssue)) {
        issue(ctx, 'Project item and open-Issue facts for one Issue must match')
      }
    }
    const configuredIssueIdByNumber = new Map<number, string>()
    for (const issueFact of [
      ...candidate.openIssues,
      ...candidate.items.flatMap(item => item.content.kind === 'issue'
        && item.content.issue.repositoryId === candidate.repository.id
        && item.content.issue.repositoryDatabaseId === candidate.repository.databaseId
        ? [item.content.issue]
        : []),
    ]) {
      const retainedId = configuredIssueIdByNumber.get(issueFact.number)
      if (retainedId !== undefined && retainedId !== issueFact.id) {
        issue(ctx, 'one configured-Repository Issue number must identify exactly one Issue')
      } else {
        configuredIssueIdByNumber.set(issueFact.number, issueFact.id)
      }
    }

    if (!sameFence(candidate.fences.before, candidate.fences.after)) {
      issue(ctx, 'Project-board update fences must be stable')
    }
    if (candidate.fences.after.projectItemCount !== candidate.items.length
      || candidate.fences.after.openIssueCount !== candidate.openIssues.length) {
      issue(ctx, 'Project-board update-fence counts must match the complete result')
    }

    const { fingerprint: _fingerprint, ...source } = candidate
    if (computeGitHubProjectBoardFingerprint(source).digest !== candidate.fingerprint.digest) {
      issue(ctx, 'Project-board fingerprint does not match retained facts')
    }
  },
)

/** Strict installation-read request schema. */
export const githubInstallationReadRequestSchema = z.object({
  kind: z.literal('installation'),
  installation: githubInstallationProfileSchema,
}).strict()

/** Strict Repository-read request schema. */
export const githubRepositoryReadRequestSchema = z.object({
  kind: z.literal('repository'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
}).strict()

/** Strict Issue-read request schema. */
export const githubIssueReadRequestSchema = z.object({
  kind: z.literal('issue'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  issueId: githubIssueIdSchema,
}).strict()

/** Strict complete Issue-detail read request schema. */
export const githubIssueDetailReadRequestSchema = z.object({
  kind: z.literal('issue-detail'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  issueId: githubIssueIdSchema,
}).strict()

const githubBranchNameSchema = z.string().min(1).max(255).superRefine((value, ctx) => {
  if (!value.isWellFormed()) issue(ctx, 'branch name must be well-formed Unicode')
  if (/[\u0000-\u001f\u007f]/u.test(value)) issue(ctx, 'branch name contains a forbidden control character')
})

/** Strict exact branch-safety read request schema. */
export const githubBranchSafetyReadRequestSchema = z.object({
  kind: z.literal('branch-safety'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  branch: githubBranchNameSchema,
}).strict()

/** Strict fail-closed branch-safety fact schema. */
export const githubBranchSafetyFactSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('safe'), branchExists: z.literal(true), observedAt: safeTimestamp }).strict(),
  z.object({ kind: z.literal('protected'), branchExists: z.boolean(), observedAt: safeTimestamp }).strict(),
  z.object({
    kind: z.literal('legacy-protection-unknown'),
    branchExists: z.literal(false),
    observedAt: safeTimestamp,
  }).strict(),
])

/** Strict Project-read request schema. */
export const githubProjectReadRequestSchema = z.object({
  kind: z.literal('project'),
  installation: githubInstallationProfileSchema,
  projectId: githubProjectIdSchema,
}).strict()

/** Strict exact tag-reference read request schema. */
export const githubTagReferenceReadRequestSchema = z.object({
  kind: z.literal('tag-reference'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  tagName: githubReleaseTagNameSchema,
}).strict()

/** Strict tag-target schema. */
export const githubTagTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), id: githubTagObjectIdSchema }).strict(),
  z.object({ kind: z.literal('commit'), id: githubCommitIdSchema }).strict(),
])

/** Strict exact tag-reference fact schema. */
export const githubTagReferenceFactSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  tagName: githubReleaseTagNameSchema,
  ref: z.string().regex(/^refs\/tags\/saki-v[0-9A-Za-z][0-9A-Za-z._-]*$/).max(265),
  target: githubTagTargetSchema,
  observedAt: safeTimestamp,
}).strict().superRefine((fact, ctx) => {
  if (fact.ref !== `refs/tags/${fact.tagName}`) issue(ctx, 'tag ref must exactly match tagName')
})

/** Strict recursive tag-object read request schema. */
export const githubTagObjectReadRequestSchema = z.object({
  kind: z.literal('tag-object'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  target: githubTagTargetSchema,
}).strict()

/** Strict annotated-tag object fact schema. */
export const githubTagObjectFactSchema = z.object({
  id: githubTagObjectIdSchema,
  target: githubTagTargetSchema,
  taggedAt: safeTimestamp.optional(),
  url: safeUrl.optional(),
}).strict()

/** Strict complete recursive tag-peel fact schema. */
export const githubTagPeelFactSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  tagObjects: z.array(githubTagObjectFactSchema).max(GITHUB_TAG_PEEL_DEPTH_LIMIT),
  commitId: githubCommitIdSchema,
  observedAt: safeTimestamp,
}).strict().superRefine((fact, ctx) => {
  rejectDuplicate(fact.tagObjects.map(tag => tag.id), 'annotated-tag object id', ctx)
  for (const [index, tag] of fact.tagObjects.entries()) {
    const next = fact.tagObjects[index + 1]
    if (next !== undefined && (tag.target.kind !== 'tag' || tag.target.id !== next.id)) {
      issue(ctx, 'annotated-tag chain must be contiguous')
    }
    if (next === undefined && (tag.target.kind !== 'commit' || tag.target.id !== fact.commitId)) {
      issue(ctx, 'annotated-tag chain must terminate at commitId')
    }
  }
})

/** Strict Release-by-tag read request schema. */
export const githubReleaseByTagReadRequestSchema = z.object({
  kind: z.literal('release-by-tag'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  tagName: githubReleaseTagNameSchema,
}).strict()

/** Strict raw Release-fact schema. */
export const githubReleaseFactSchema = z.object({
  id: githubReleaseIdSchema,
  repositoryId: githubRepositoryIdSchema,
  tagName: githubReleaseTagNameSchema,
  targetCommitish: safeName,
  draft: z.boolean(),
  prerelease: z.boolean(),
  url: safeUrl,
  publishedAt: safeTimestamp.optional(),
  observedAt: safeTimestamp,
}).strict()

/** Strict Release-by-tag presence observation schema. */
export const githubReleaseByTagObservationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('present'), release: githubReleaseFactSchema }).strict(),
  z.object({
    kind: z.literal('absent'),
    repositoryId: githubRepositoryIdSchema,
    tagName: githubReleaseTagNameSchema,
    observedAt: safeTimestamp,
  }).strict(),
])

/** Strict exact Commit-read request schema. */
export const githubCommitReadRequestSchema = z.object({
  kind: z.literal('commit'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  commitId: githubCommitIdSchema,
}).strict()

/** Strict exact Commit-fact schema. */
export const githubCommitFactSchema = z.object({
  id: githubCommitIdSchema,
  repositoryId: githubRepositoryIdSchema,
  url: safeUrl,
  committedAt: safeTimestamp,
  observedAt: safeTimestamp,
}).strict()

/** Strict ancestry/compare read request schema. */
export const githubCompareCommitsReadRequestSchema = z.object({
  kind: z.literal('compare-commits'),
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  baseCommitId: githubCommitIdSchema,
  headCommitId: githubCommitIdSchema,
}).strict()

/** Strict raw ancestry/compare fact schema. */
export const githubCommitComparisonFactSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  baseCommitId: githubCommitIdSchema,
  headCommitId: githubCommitIdSchema,
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  aheadBy: safeInteger,
  behindBy: safeInteger,
  mergeBaseCommitId: githubCommitIdSchema.optional(),
  observedAt: safeTimestamp,
}).strict()

/** Strict complete Project-board scan request schema. */
export const githubProjectBoardScanRequestSchema = z.object({
  kind: z.literal('project-board'),
  installation: githubInstallationProfileSchema,
  projectId: githubProjectIdSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  requiredStatusOptionIds: z.array(githubProjectOptionIdSchema).min(1).max(100).superRefine((ids, ctx) => {
    rejectDuplicate(ids, 'required Status option id', ctx)
  }),
  priority: z.enum(['interactive', 'background']),
  rateLimitReserve: safeInteger,
}).strict()

const standardGitHubFailureSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('cancelled') }).strict(),
  z.object({ code: z.literal('auth-unavailable'), credentialRef: credentialRefSchema.optional() }).strict(),
  z.object({
    code: z.literal('permission-mismatch'),
    permission: safeName,
    required: z.enum(['none', 'read', 'write', 'admin']),
    observed: z.enum(['none', 'read', 'write', 'admin']).optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({ code: z.literal('not-found'), resource: safeName, requestId: safeRequestId.optional() }).strict(),
  z.object({
    code: z.literal('invalid-external-response'),
    operation: safeName,
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({ code: z.literal('primary-rate-limit'), resetAt: safeTimestamp.optional(), requestId: safeRequestId.optional() }).strict(),
  z.object({
    code: z.literal('secondary-rate-limit'),
    retryAfterMs: safeInteger.optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('transient-transport'),
    retryAfterMs: safeInteger.optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('permanent-rejection'),
    status: z.number().int().min(100).max(599).optional(),
    requestId: safeRequestId.optional(),
  }).strict(),
])

const mappingMismatchFailureSchema = z.discriminatedUnion('reason', [
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('field-missing-or-not-single-select'),
    statusFieldId: githubProjectFieldIdSchema,
  }).strict(),
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('required-options-missing'),
    statusFieldId: githubProjectFieldIdSchema,
    missingRequiredStatusOptionIds: z.array(githubProjectOptionIdSchema).min(1).max(100).superRefine((ids, ctx) => {
      rejectDuplicate(ids, 'missing required Status option id', ctx)
    }),
  }).strict(),
])

/** Strict closed provider-failure data schema. */
export const githubFailureSchema = z.union([standardGitHubFailureSchema, mappingMismatchFailureSchema])

/** Strict exact Issue identity returned by create and used by inspection. */
export const githubIssueCreateInspectionHintSchema = z.object({
  issueId: githubIssueIdSchema,
  issueNumber: positiveInteger,
}).strict()

const issueCreateTitleSchema = z.string().min(1).max(GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT)
  .superRefine((value, ctx) => {
    if (!value.isWellFormed()) issue(ctx, 'Issue-create title must be well-formed Unicode')
    if (value.trim() === '') issue(ctx, 'Issue-create title must contain visible text')
    if (/\r|\n|[\u0000-\u001f\u007f]/u.test(value)) issue(ctx, 'Issue-create title must be one safe line')
    if (utf8ByteLength(value) > GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT) {
      issue(ctx, 'Issue-create title exceeds the complete UTF-8 byte limit')
    }
  })

const issueCreateBodySchema = z.string().min(1).max(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT)
  .superRefine((value, ctx) => {
    if (!value.isWellFormed()) issue(ctx, 'Issue-create body must be well-formed Unicode')
    if (value.includes('\r')) issue(ctx, 'Issue-create body must use normalized LF line endings')
    if (/[\u0000\u007f]/u.test(value)) issue(ctx, 'Issue-create body contains a forbidden control character')
    if (utf8ByteLength(value) > GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT) {
      issue(ctx, 'Issue-create body exceeds the complete UTF-8 byte limit')
    }
  })

/** Strict atomic Issue-create request schema. */
export const githubIssueCreateRequestSchema = z.object({
  kind: z.literal('issue-create'),
  operationId: githubExternalOperationIdSchema,
  installation: githubInstallationProfileSchema,
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  title: issueCreateTitleSchema,
  body: issueCreateBodySchema,
  markerId: githubIssueCreateMarkerIdSchema,
  inspectionHint: githubIssueCreateInspectionHintSchema.optional(),
}).strict().superRefine((request, ctx) => {
  const marker = `<!-- saki-work-item:${request.markerId} -->`
  if (!request.body.endsWith(`\n${marker}\n`)) {
    issue(ctx, 'Issue-create body must end with the exact persisted marker on its own line')
  }
  if (request.body.split('<!-- saki-work-item:').length !== 2) {
    issue(ctx, 'Issue-create body must contain exactly one Saki Work Item marker prefix')
  }
})

const projectMembershipItemFactShape = {
  id: githubProjectItemIdSchema,
  projectId: githubProjectIdSchema,
  issueId: githubIssueIdSchema,
  archived: z.boolean(),
} as const

const projectPositionItemFactShape = {
  ...projectMembershipItemFactShape,
  apiOrder: safeInteger,
  totalCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousItemId: githubProjectItemIdSchema.nullable(),
  nextItemId: githubProjectItemIdSchema.nullable(),
  updatedAt: safeTimestamp,
} as const

/** Strict Project membership fact without an implied Status-field read. */
const githubProjectMembershipItemFactSchema = z.object(projectMembershipItemFactShape)
  .strict()

/** Strict Project membership fact retained by a Status inspection. */
const githubTargetedProjectItemFactSchema = z.object({
  ...projectPositionItemFactShape,
  statusOptionId: githubProjectOptionIdSchema.optional(),
}).strict().superRefine(validateProjectMembershipItem)

const githubTargetedWorkItemMembershipOptions = [
  z.object({ state: z.literal('present'), item: githubTargetedProjectItemFactSchema }).strict(),
  z.object({ state: z.literal('absent') }).strict(),
] as const

const githubTargetedWorkItemMembershipSchema = z.discriminatedUnion(
  'state',
  githubTargetedWorkItemMembershipOptions,
)

function validateProjectMembershipItem(
  item: {
    readonly id: z.infer<typeof githubProjectItemIdSchema>
    readonly apiOrder: number
    readonly totalCount: number
    readonly previousItemId: z.infer<typeof githubProjectItemIdSchema> | null
    readonly nextItemId: z.infer<typeof githubProjectItemIdSchema> | null
  },
  ctx: z.core.$RefinementCtx,
): void {
  if (item.apiOrder >= item.totalCount) {
    issue(ctx, 'Project item order must be within the complete connection')
  }
  if ((item.apiOrder === 0) !== (item.previousItemId === null)) {
    issue(ctx, 'Project item previous neighbor must match its complete position')
  }
  if ((item.apiOrder === item.totalCount - 1) !== (item.nextItemId === null)) {
    issue(ctx, 'Project item next neighbor must match its complete position')
  }
  if (item.previousItemId === item.id || item.nextItemId === item.id
    || (item.previousItemId !== null && item.previousItemId === item.nextItemId)) {
    issue(ctx, 'Project item neighbors must be distinct')
  }
}

/** Strict raw targeted Work Item snapshot schema. */
const githubTargetedWorkItemSnapshotSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  issue: githubIssueFactSchema,
  membership: githubTargetedWorkItemMembershipSchema,
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.issue.repositoryId !== snapshot.repositoryId
    || snapshot.issue.repositoryDatabaseId !== snapshot.repositoryDatabaseId) {
    issue(ctx, 'targeted Issue ownership must match the inspected Repository')
  }
  if (snapshot.membership.state === 'present'
    && (snapshot.membership.item.projectId !== snapshot.projectId
      || snapshot.membership.item.issueId !== snapshot.issue.id)) {
    issue(ctx, 'targeted Project membership must match the inspected Project and Issue')
  }
})

/** Strict targeted post-dispatch Status observation schema. */
export const githubProjectItemStatusSetInspectionSchema = z.object({
  snapshot: githubTargetedWorkItemSnapshotSchema,
  observedAt: safeTimestamp,
}).strict()

const githubProjectItemAddMembershipSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('absent') }).strict(),
  z.object({ state: z.literal('present'), item: githubProjectMembershipItemFactSchema }).strict(),
  z.object({
    state: z.literal('duplicate-conflict'),
    items: z.array(githubProjectMembershipItemFactSchema)
      .min(2)
      .max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  }).strict(),
])

const githubProjectItemPositionMembershipSchema = z.discriminatedUnion('state', [
  ...githubTargetedWorkItemMembershipOptions,
  z.object({
    state: z.literal('duplicate-conflict'),
    items: z.array(githubTargetedProjectItemFactSchema)
      .min(2)
      .max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT),
  }).strict(),
])

/** Strict Issue-selected Project membership snapshot schema. */
export const githubProjectItemAddSnapshotSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  issue: githubIssueFactSchema,
  membership: githubProjectItemAddMembershipSchema,
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.issue.repositoryId !== snapshot.repositoryId
    || snapshot.issue.repositoryDatabaseId !== snapshot.repositoryDatabaseId) {
    issue(ctx, 'targeted Issue ownership must match the inspected Repository')
  }
  const items = snapshot.membership.state === 'absent'
    ? []
    : snapshot.membership.state === 'present'
      ? [snapshot.membership.item]
      : snapshot.membership.items
  for (const item of items) {
    if (item.projectId !== snapshot.projectId || item.issueId !== snapshot.issue.id) {
      issue(ctx, 'targeted Project membership must match the inspected Project and Issue')
    }
  }
  if (snapshot.membership.state === 'duplicate-conflict') {
    rejectDuplicate(items.map(item => item.id), 'duplicate membership item id', ctx)
  }
})

/** Strict targeted Project membership observation schema. */
export const githubProjectItemAddInspectionSchema = z.object({
  snapshot: githubProjectItemAddSnapshotSchema,
  observedAt: safeTimestamp,
}).strict()

/** Strict API-position anchor fact without an implied content kind. */
const githubProjectItemPositionAnchorFactSchema = z.object({
  id: githubProjectItemIdSchema,
  projectId: githubProjectIdSchema,
  issue: githubIssueFactSchema,
  statusOptionId: githubProjectOptionIdSchema.optional(),
  archived: z.boolean(),
  apiOrder: safeInteger,
  totalCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  previousItemId: githubProjectItemIdSchema.nullable(),
  nextItemId: githubProjectItemIdSchema.nullable(),
  updatedAt: safeTimestamp,
}).strict().superRefine(validateProjectMembershipItem)

/** Strict observed predecessor and Project membership snapshot. */
export const githubProjectItemPositionSnapshotSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  projectId: githubProjectIdSchema,
  statusFieldId: githubProjectFieldIdSchema,
  issue: githubIssueFactSchema,
  membership: githubProjectItemPositionMembershipSchema,
  after: z.discriminatedUnion('state', [
    z.object({ state: z.literal('top') }).strict(),
    z.object({ state: z.literal('present'), item: githubProjectItemPositionAnchorFactSchema }).strict(),
    z.object({ state: z.literal('absent'), itemId: githubProjectItemIdSchema }).strict(),
  ]),
}).strict().superRefine((snapshot, ctx) => {
  if (snapshot.issue.repositoryId !== snapshot.repositoryId
    || snapshot.issue.repositoryDatabaseId !== snapshot.repositoryDatabaseId) {
    issue(ctx, 'position Issue ownership must match the inspected Repository')
  }
  const memberships = snapshot.membership.state === 'absent'
    ? []
    : snapshot.membership.state === 'present'
      ? [snapshot.membership.item]
      : snapshot.membership.items
  for (const item of memberships) {
    if (item.projectId !== snapshot.projectId || item.issueId !== snapshot.issue.id) {
      issue(ctx, 'position membership must match the inspected Project and Issue')
    }
  }
  if (snapshot.membership.state === 'duplicate-conflict') {
    rejectDuplicate(memberships.map(item => item.id), 'duplicate position membership item id', ctx)
    rejectDuplicate(memberships.map(item => String(item.apiOrder)), 'duplicate position membership API order', ctx)
    let previousApiOrder = -1
    for (const item of memberships) {
      if (item.apiOrder <= previousApiOrder) {
        issue(ctx, 'duplicate position memberships must remain in API order')
      }
      previousApiOrder = item.apiOrder
    }
  }
  if (snapshot.after.state === 'present'
    && (snapshot.after.item.projectId !== snapshot.projectId
      || snapshot.after.item.issue.repositoryId !== snapshot.repositoryId
      || snapshot.after.item.issue.repositoryDatabaseId !== snapshot.repositoryDatabaseId)) {
    issue(ctx, 'position predecessor observation must match the inspected Project and Repository')
  }
})

/** Strict targeted Project-item API-position observation schema. */
export const githubProjectItemPositionSetInspectionSchema = z.object({
  snapshot: githubProjectItemPositionSnapshotSchema,
  observedAt: safeTimestamp,
}).strict()

/** Strict repository-bound Issue-state snapshot schema. */
export const githubIssueStateSnapshotSchema = z.object({
  issue: githubIssueFactSchema,
}).strict()

/** Strict targeted Issue-state observation schema. */
export const githubIssueStateSetInspectionSchema = z.object({
  snapshot: githubIssueStateSnapshotSchema,
  observedAt: safeTimestamp,
}).strict()

const githubIssueCreateInspectionOutcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unique-issue'), issue: githubIssueFactSchema }).strict(),
  z.object({ state: z.literal('absent-complete') }).strict(),
  z.object({ state: z.literal('pull-request-marker-match') }).strict(),
  z.object({ state: z.literal('marker-removed') }).strict(),
  z.object({ state: z.literal('known-issue-absent') }).strict(),
  z.object({ state: z.literal('identity-conflict') }).strict(),
  z.object({ state: z.literal('multiple-matches') }).strict(),
  z.object({ state: z.literal('incomplete') }).strict(),
])

/** Strict repository-bound Issue-create marker snapshot schema. */
const githubIssueCreateSnapshotSchema = z.object({
  repositoryId: githubRepositoryIdSchema,
  repositoryDatabaseId: githubRepositoryDatabaseIdSchema,
  outcome: githubIssueCreateInspectionOutcomeSchema,
}).strict().superRefine((snapshot, ctx) => {
  const outcome = snapshot.outcome
  if (outcome.state === 'unique-issue'
    && (outcome.issue.repositoryId !== snapshot.repositoryId
      || outcome.issue.repositoryDatabaseId !== snapshot.repositoryDatabaseId)) {
    issue(ctx, 'unique Issue-create outcome must match the inspected Repository')
  }
})

/** Strict targeted Issue-create exact-marker observation schema. */
export const githubIssueCreateInspectionSchema = z.object({
  snapshot: githubIssueCreateSnapshotSchema,
  observedAt: safeTimestamp,
}).strict()

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function rejectDuplicate(values: readonly string[], subject: string, ctx: z.core.$RefinementCtx): void {
  if (new Set(values).size !== values.length) issue(ctx, `${subject} must not repeat`)
}

function validatePrimaryRateCounters(
  rate: { readonly limit: number; readonly used: number; readonly remaining: number },
  ctx: z.core.$RefinementCtx,
): void {
  if (rate.used > rate.limit || rate.remaining > rate.limit || rate.used !== rate.limit - rate.remaining) {
    issue(ctx, 'primary rate counters must partition the reported limit')
  }
}

function sameFence(
  left: z.infer<typeof githubProjectBoardUpdateFenceSchema>,
  right: z.infer<typeof githubProjectBoardUpdateFenceSchema>,
): boolean {
  return left.projectUpdatedAt === right.projectUpdatedAt
    && left.repositoryUpdatedAt === right.repositoryUpdatedAt
    && left.projectItemCount === right.projectItemCount
    && left.openIssueCount === right.openIssueCount
}

function sameIssue(
  left: z.infer<typeof githubIssueFactSchema>,
  right: z.infer<typeof githubIssueFactSchema>,
): boolean {
  return [
    left.id === right.id,
    left.repositoryId === right.repositoryId,
    left.repositoryDatabaseId === right.repositoryDatabaseId,
    left.number === right.number,
    left.state === right.state,
    left.title === right.title,
    left.url === right.url,
    left.updatedAt === right.updatedAt,
  ].every(Boolean)
}

function issue(ctx: z.core.$RefinementCtx, message: string): void {
  ctx.addIssue({ code: 'custom', message })
}
