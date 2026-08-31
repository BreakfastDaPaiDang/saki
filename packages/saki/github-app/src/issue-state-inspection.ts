/** Repository-bound Issue-state mutation inspection. @module @breakfastdapaidang/saki-github-app/issue-state-inspection */

import { z } from 'zod'
import { githubIssueStateSetInspectionSchema } from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueStateSetInspection,
  GitHubIssueStateSetRequest,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import {
  graphqlIssueFact,
  graphqlNotFound as notFound,
  graphqlOwnedIssueNodeSchema,
  graphqlOwnedNumericRepositoryIdentitySchema,
  invalidGraphqlResponse as invalid,
  queryGraphql,
} from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const ISSUE_STATE_INSPECTION_QUERY = `
query SakiIssueStateInspection($repositoryId: ID!, $issueId: ID!) {
  repository: node(id: $repositoryId) {
    __typename
    ... on Repository { id databaseId owner { id } }
  }
  issue: node(id: $issueId) {
    __typename
    ... on Issue {
      id number state title url updatedAt
      repository { id databaseId owner { id } }
    }
  }
}`

const repositorySchema = graphqlOwnedNumericRepositoryIdentitySchema.extend({
  __typename: z.literal('Repository'),
}).loose()

const issueSchema = graphqlOwnedIssueNodeSchema.extend({
  __typename: z.literal('Issue'),
}).loose()

const inspectionDataSchema = z.object({
  repository: repositorySchema.nullable(),
  issue: issueSchema.nullable(),
}).loose()

interface InspectionState {
  readonly request: GitHubIssueStateSetRequest
  readonly session: GitHubOperationSession
  readonly signal: AbortSignal
}

/**
 * Inspect one exact repository Issue without performing a mutation.
 * @param request - immutable Issue-state mutation request.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns repository-bound Issue facts from one exact read.
 */
export async function inspectIssueState(
  request: GitHubIssueStateSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubIssueStateSetInspection> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'issue-state-inspection',
  )
  const state: InspectionState = { request, session, signal }
  const snapshot = await readIssueState(state)
  return githubIssueStateSetInspectionSchema.parse({
    snapshot,
    observedAt: Date.now(),
  })
}

async function readIssueState(state: InspectionState): Promise<GitHubIssueStateSetInspection['snapshot']> {
  const data = inspectionDataSchema.parse(await queryGraphql(
    state.session.installation,
    ISSUE_STATE_INSPECTION_QUERY,
    { repositoryId: state.request.repositoryId, issueId: state.request.issueId },
    state.signal,
    'issue-state-inspection',
  ))
  if (data.repository === null) notFound('Repository')
  if (data.issue === null) notFound('Issue')
  const expected = JSON.stringify([
    state.request.repositoryId,
    state.request.repositoryDatabaseId,
    state.request.installation.accountId,
    state.request.issueId,
    state.request.repositoryId,
    state.request.repositoryDatabaseId,
    state.request.installation.accountId,
  ])
  const observed = JSON.stringify([
    data.repository.id,
    String(data.repository.databaseId),
    data.repository.owner.id,
    data.issue.id,
    data.issue.repository.id,
    String(data.issue.repository.databaseId),
    data.issue.repository.owner.id,
  ])
  if (observed !== expected) invalid('issue-state-target')
  return {
    issue: graphqlIssueFact(data.issue, 'issue-state-inspection'),
  }
}
