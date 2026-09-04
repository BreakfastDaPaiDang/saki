/** Atomic Product App GitHub mutations. @module @breakfastdapaidang/saki-github-app/mutations */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubIssueCreateInspectionHintSchema,
  githubPullRequestCreateInspectionHintSchema,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueStateSetRequest,
  GitHubIssueCreateInspectionHint,
  GitHubIssueCreateRequest,
  GitHubPullRequestCreateInspectionHint,
  GitHubPullRequestCreateRequest,
  GitHubProjectItemAddRequest,
  GitHubProjectItemPositionSetRequest,
  GitHubProjectItemStatusSetRequest,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { queryGraphql } from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const STATUS_SET_MUTATION = `
mutation SakiProjectItemStatusSet(
  $projectId: ID!
  $itemId: ID!
  $fieldId: ID!
  $optionId: String!
  $clientMutationId: String!
) {
  statusSet: updateProjectV2ItemFieldValue(input: {
    projectId: $projectId
    itemId: $itemId
    fieldId: $fieldId
    value: { singleSelectOptionId: $optionId }
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
    projectV2Item { id project { id } }
  }
}`

const PROJECT_ITEM_ADD_MUTATION = `
mutation SakiProjectItemAdd($projectId: ID!, $issueId: ID!, $clientMutationId: String!) {
  projectItemAdd: addProjectV2ItemById(input: {
    projectId: $projectId
    contentId: $issueId
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
    item { id project { id } }
  }
}`

const POSITION_SET_MUTATION = `
mutation SakiProjectItemPositionSet(
  $projectId: ID!
  $itemId: ID!
  $afterId: ID
  $clientMutationId: String!
) {
  positionSet: updateProjectV2ItemPosition(input: {
    projectId: $projectId
    itemId: $itemId
    afterId: $afterId
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
  }
}`

const ISSUE_STATE_SET_MUTATION = `
mutation SakiIssueStateSet($issueId: ID!, $state: IssueState!, $clientMutationId: String!) {
  issueStateSet: updateIssue(input: {
    id: $issueId
    state: $state
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
    issue { id state repository { id databaseId } }
  }
}`

const ISSUE_CREATE_MUTATION = `
mutation SakiIssueCreate(
  $repositoryId: ID!
  $title: String!
  $body: String!
  $clientMutationId: String!
) {
  issueCreate: createIssue(input: {
    repositoryId: $repositoryId
    title: $title
    body: $body
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
    issue {
      id
      number
      state
      title
      body
      repository { id databaseId owner { id } }
    }
  }
}`

const PULL_REQUEST_CREATE_MUTATION = `
mutation SakiPullRequestCreate(
  $repositoryId: ID!
  $headRef: String!
  $baseRef: String!
  $title: String!
  $body: String!
  $clientMutationId: String!
) {
  pullRequestCreate: createPullRequest(input: {
    repositoryId: $repositoryId
    headRefName: $headRef
    baseRefName: $baseRef
    title: $title
    body: $body
    clientMutationId: $clientMutationId
  }) {
    clientMutationId
    pullRequest {
      id number state title body headRefName headRefOid baseRefName
      repository { id databaseId: fullDatabaseId owner { id } }
    }
  }
}`

const projectItemMutationTargetSchema = z.object({
  id: z.string().min(1),
  project: z.object({ id: z.string().min(1) }).loose(),
}).loose()

const statusSetDataSchema = z.object({
  statusSet: z.object({
    clientMutationId: z.string().min(1),
    projectV2Item: projectItemMutationTargetSchema,
  }).loose(),
}).loose()

const projectItemAddDataSchema = z.object({
  projectItemAdd: z.object({
    clientMutationId: z.string().min(1),
    item: projectItemMutationTargetSchema,
  }).loose(),
}).loose()

const positionSetDataSchema = z.object({
  positionSet: z.object({ clientMutationId: z.string().min(1) }).loose(),
}).loose()

const issueStateSetDataSchema = z.object({
  issueStateSet: z.object({
    clientMutationId: z.string().min(1),
    issue: z.object({
      id: z.string().min(1),
      state: z.enum(['OPEN', 'CLOSED']),
      repository: z.object({
        id: z.string().min(1),
        databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      }).loose(),
    }).loose(),
  }).loose(),
}).loose()

const issueCreateDataSchema = z.object({
  issueCreate: z.object({
    clientMutationId: z.string().min(1),
    issue: z.object({
      id: z.string().min(1),
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      state: z.enum(['OPEN', 'CLOSED']),
      title: z.string(),
      body: z.string(),
      repository: z.object({
        id: z.string().min(1),
        databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        owner: z.object({ id: z.string().min(1) }).loose(),
      }).loose(),
    }).loose(),
  }).loose(),
}).loose()

const pullRequestCreateDataSchema = z.object({
  pullRequestCreate: z.object({
    clientMutationId: z.string().min(1),
    pullRequest: z.object({
      id: z.string().min(1), number: z.number().int().positive(), state: z.literal('OPEN'),
      title: z.string(), body: z.string(), headRefName: z.string(), headRefOid: z.string(), baseRefName: z.string(),
      repository: z.object({ id: z.string().min(1), databaseId: z.union([z.string(), z.number().int().positive()]),
        owner: z.object({ id: z.string().min(1) }).loose() }).loose(),
    }).loose(),
  }).loose(),
}).loose()

/**
 * Make one deterministic Issue-create call per dispatch invocation without an internal retry.
 * @param request - immutable repository, complete text, marker, and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns the created Issue identity needed by later inspection.
 */
export async function createIssue(
  request: GitHubIssueCreateRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubIssueCreateInspectionHint> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'issue-create',
  )
  const data = issueCreateDataSchema.parse(await queryGraphql(
    session.installation,
    ISSUE_CREATE_MUTATION,
    {
      repositoryId: request.repositoryId,
      title: request.title,
      body: request.body,
      clientMutationId: request.operationId,
    },
    signal,
    request.kind,
  ))
  const issue = data.issueCreate.issue
  if (data.issueCreate.clientMutationId !== request.operationId
    || issue.state !== 'OPEN'
    || issue.title !== request.title
    || issue.body !== request.body
    || issue.repository.id !== request.repositoryId
    || String(issue.repository.databaseId) !== request.repositoryDatabaseId
    || issue.repository.owner.id !== request.installation.accountId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
  return githubIssueCreateInspectionHintSchema.parse({
    issueId: issue.id,
    issueNumber: issue.number,
  })
}

/**
 * Make one deterministic Pull Request creation call without an internal retry.
 * @param request - marker-bound exact Repository, refs, head Commit, and complete text.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns created Pull Request identity for later inspection.
 */
export async function createPullRequest(
  request: GitHubPullRequestCreateRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubPullRequestCreateInspectionHint> {
  const session = await GitHubOperationSession.create(request.installation, privateKey, request.repositoryDatabaseId,
    config, signal, queue, 'interactive', 'pull-request-create')
  const data = pullRequestCreateDataSchema.parse(await queryGraphql(session.installation, PULL_REQUEST_CREATE_MUTATION, {
    repositoryId: request.repositoryId, headRef: request.headRef, baseRef: request.baseRef,
    title: request.title, body: request.body, clientMutationId: request.operationId,
  }, signal, request.kind))
  const pullRequest = data.pullRequestCreate.pullRequest
  if (data.pullRequestCreate.clientMutationId !== request.operationId
    || pullRequest.title !== request.title || pullRequest.body !== request.body
    || pullRequest.headRefName !== request.headRef || pullRequest.headRefOid !== request.expectedHeadCommitId
    || pullRequest.baseRefName !== request.baseRef || pullRequest.repository.id !== request.repositoryId
    || String(pullRequest.repository.databaseId) !== request.repositoryDatabaseId
    || pullRequest.repository.owner.id !== request.installation.accountId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
  return githubPullRequestCreateInspectionHintSchema.parse({
    pullRequestId: pullRequest.id, pullRequestNumber: pullRequest.number,
  })
}

/**
 * Make one Project membership call per dispatch invocation without an internal retry.
 * @param request - immutable Issue-selected target and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns after GitHub acknowledges the exact requested call.
 */
export async function addProjectItem(
  request: GitHubProjectItemAddRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<void> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-add',
  )
  const data = projectItemAddDataSchema.parse(await queryGraphql(
    session.installation,
    PROJECT_ITEM_ADD_MUTATION,
    {
      projectId: request.projectId,
      issueId: request.issueId,
      clientMutationId: request.operationId,
    },
    signal,
    request.kind,
  ))
  if (data.projectItemAdd.clientMutationId !== request.operationId
    || data.projectItemAdd.item.project.id !== request.projectId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
}

/**
 * Make one Project-item Status call per dispatch invocation without an internal retry.
 * @param request - immutable exact target and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns after GitHub acknowledges the exact requested call.
 */
export async function setProjectItemStatus(
  request: GitHubProjectItemStatusSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<void> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-status-set',
  )
  const data = statusSetDataSchema.parse(await queryGraphql(
    session.installation,
    STATUS_SET_MUTATION,
    {
      projectId: request.projectId,
      itemId: request.projectItemId,
      fieldId: request.statusFieldId,
      optionId: request.desiredStatusOptionId,
      clientMutationId: request.operationId,
    },
    signal,
    request.kind,
  ))
  if (data.statusSet.clientMutationId !== request.operationId
    || data.statusSet.projectV2Item.id !== request.projectItemId
    || data.statusSet.projectV2Item.project.id !== request.projectId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
}

/**
 * Make one Project-item API-position call per dispatch invocation without an internal retry.
 * @param request - immutable moving item, predecessor, and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns after GitHub acknowledges the requested call; final order requires inspection.
 */
export async function setProjectItemPosition(
  request: GitHubProjectItemPositionSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<void> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-position-set',
  )
  const data = positionSetDataSchema.parse(await queryGraphql(
    session.installation,
    POSITION_SET_MUTATION,
    {
      projectId: request.projectId,
      itemId: request.projectItemId,
      afterId: request.afterItemId,
      clientMutationId: request.operationId,
    },
    signal,
    request.kind,
  ))
  if (data.positionSet.clientMutationId !== request.operationId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
}

/**
 * Make one repository Issue-state call per dispatch invocation without an internal retry.
 * @param request - immutable Issue identity, desired open state, and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns after GitHub acknowledges the exact requested call.
 */
export async function setIssueState(
  request: GitHubIssueStateSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<void> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'issue-state-set',
  )
  const state = request.desiredState === 'open' ? 'OPEN' : 'CLOSED'
  const data = issueStateSetDataSchema.parse(await queryGraphql(
    session.installation,
    ISSUE_STATE_SET_MUTATION,
    {
      issueId: request.issueId,
      state,
      clientMutationId: request.operationId,
    },
    signal,
    request.kind,
  ))
  const issue = data.issueStateSet.issue
  if (data.issueStateSet.clientMutationId !== request.operationId
    || issue.id !== request.issueId
    || issue.state !== state
    || issue.repository.id !== request.repositoryId
    || String(issue.repository.databaseId) !== request.repositoryDatabaseId) {
    throw new GitHubProviderError({ code: 'invalid-external-response', operation: request.kind })
  }
}
