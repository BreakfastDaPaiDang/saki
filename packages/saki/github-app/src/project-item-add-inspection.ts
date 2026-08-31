/** Issue-selected Project membership inspection. @module @breakfastdapaidang/saki-github-app/project-item-add-inspection */

import { z } from 'zod'
import {
  githubIssueId,
  githubProjectItemAddInspectionSchema,
  githubProjectItemId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueFact,
  GitHubProjectItemAddInspection,
  GitHubProjectItemAddMembership,
  GitHubProjectItemAddRequest,
  GitHubProjectMembershipItemFact,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import {
  graphqlConnectionSchema,
  graphqlIssueFact,
  graphqlNotFound as notFound,
  graphqlOwnedIssueTargetSchema,
  graphqlOwnedNumericRepositoryIdentitySchema,
  graphqlOwnedNumericRepositoryNodeSchema,
  graphqlOwnedProjectRevisionNodeSchema,
  graphqlProjectItemPositionSchema,
  graphqlProjectIssueTargetMatches,
  graphqlTimestamp as timestamp,
  invalidGraphqlResponse as invalid,
  nextGraphqlCursor,
  queryGraphql,
} from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const PROJECT_ITEM_ADD_INSPECTION_QUERY = `
query SakiProjectItemAddInspection(
  $projectId: ID!
  $repositoryId: ID!
  $issueId: ID!
  $first: Int!
  $after: String
) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id updatedAt owner { id }
      items(first: $first, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED], orderBy: { field: POSITION, direction: ASC }) {
        totalCount
        nodes {
          __typename id isArchived
          project { id updatedAt owner { id } }
          content {
            __typename
            ... on Issue { id repository { id databaseId owner { id } } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
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

const positionItemSchema = graphqlProjectItemPositionSchema.omit({ updatedAt: true }).extend({
  content: z.object({
    __typename: z.string().min(1),
    id: z.string().min(1).optional(),
    repository: graphqlOwnedNumericRepositoryIdentitySchema.optional(),
  }).loose().nullable(),
}).loose()
const inspectionPageSchema = z.object({
  project: graphqlOwnedProjectRevisionNodeSchema.extend({
    items: graphqlConnectionSchema(positionItemSchema),
  }).loose().nullable(),
  repository: graphqlOwnedNumericRepositoryNodeSchema.nullable(),
  issue: graphqlOwnedIssueTargetSchema.nullable(),
}).loose()

interface InspectionState {
  readonly request: GitHubProjectItemAddRequest
  readonly session: GitHubOperationSession
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
}

interface RetainedPosition {
  readonly id: ReturnType<typeof githubProjectItemId>
  readonly issueId?: ReturnType<typeof githubIssueId> | undefined
  readonly archived: boolean
}

/**
 * Inspect Project membership by immutable Issue identity without requiring a mutation acknowledgement.
 * @param request - immutable Project membership mutation request.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated pagination and HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns absent, unique-present, or duplicate-conflict membership from one complete traversal.
 */
export async function inspectProjectItemAdd(
  request: GitHubProjectItemAddRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubProjectItemAddInspection> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-add-inspection',
  )
  const state: InspectionState = { request, session, config, signal }
  const snapshot = await readProjectMembership(state)
  return githubProjectItemAddInspectionSchema.parse({
    snapshot,
    observedAt: Date.now(),
  })
}

async function readProjectMembership(
  state: InspectionState,
): Promise<GitHubProjectItemAddInspection['snapshot']> {
  // Complete membership and position traversals retain different evidence immediately after this local setup.
  /* jscpd:ignore-start */
  const positions: RetainedPosition[] = []
  let issue: GitHubIssueFact | undefined
  let projectRevision: number | undefined
  let totalCount: number | undefined
  let cursor: string | null = null
  const cursors = new Set<string>()
  const itemIds = new Set<string>()
  /* jscpd:ignore-end */
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('project-item-add-membership')
    const data = inspectionPageSchema.parse(await queryGraphql(
      state.session.installation,
      PROJECT_ITEM_ADD_INSPECTION_QUERY,
      {
        projectId: state.request.projectId,
        repositoryId: state.request.repositoryId,
        issueId: state.request.issueId,
        first: state.config.pageSize,
        after: cursor,
      },
      state.signal,
      'project-item-add-membership',
    ))
    const targets = validateOwnersAndTargets(state.request, data)
    const project = targets.project
    const observedRevision = timestamp(project.updatedAt)
    projectRevision ??= observedRevision
    if (projectRevision !== observedRevision) invalid('project-item-add-stability')
    totalCount ??= project.items.totalCount
    if (totalCount !== project.items.totalCount || totalCount > state.config.maxItems) {
      invalid('project-item-add-membership')
    }
    const observedIssue = graphqlIssueFact(targets.issue, 'project-item-add-membership')
    issue ??= observedIssue
    if (!sameIssue(issue, observedIssue)) invalid('project-item-add-stability')
    for (const item of project.items.nodes) {
      if (itemIds.has(item.id)) invalid('project-item-add-membership')
      itemIds.add(item.id)
      validatePositionItem(state.request, item, projectRevision)
      positions.push({
        id: githubProjectItemId(item.id),
        ...(item.content?.__typename === 'Issue' && item.content.id !== undefined
          ? { issueId: githubIssueId(item.content.id) }
          : {}),
        archived: item.isArchived,
      })
      if (positions.length > state.config.maxItems) invalid('project-item-add-membership')
    }
    cursor = nextGraphqlCursor(project.items.pageInfo, cursors, 'project-item-add-membership')
    if (cursor === null) break
    if (positions.length >= totalCount) invalid('project-item-add-membership')
  }
  if (positions.length !== totalCount) invalid('project-item-add-membership')
  const matches = positions
    .filter(position => position.issueId === state.request.issueId)
    .map(position => projectMembershipFact(state.request, position))
  let membership: GitHubProjectItemAddMembership
  const [first, ...remaining] = matches
  if (first === undefined) {
    membership = { state: 'absent' }
  } else if (remaining.length === 0) {
    membership = { state: 'present', item: first }
  } else {
    membership = { state: 'duplicate-conflict', items: [first, ...remaining] }
  }
  return {
    repositoryId: state.request.repositoryId,
    repositoryDatabaseId: state.request.repositoryDatabaseId,
    projectId: state.request.projectId,
    issue,
    membership,
  }
}

function validateOwnersAndTargets(
  request: GitHubProjectItemAddRequest,
  data: z.infer<typeof inspectionPageSchema>,
): {
  readonly project: NonNullable<typeof data.project>
  readonly repository: NonNullable<typeof data.repository>
  readonly issue: NonNullable<typeof data.issue>
} {
  // Zod null narrowing stays local so each inspector preserves its operation-specific inferred result type.
  /* jscpd:ignore-start */
  if (data.project === null) notFound('Project')
  if (data.repository === null) notFound('Repository')
  if (data.issue === null) notFound('Issue')
  if (!graphqlProjectIssueTargetMatches(request, {
    project: data.project,
    repository: data.repository,
    issue: data.issue,
  })) invalid('project-item-add-target')
  /* jscpd:ignore-end */
  return { project: data.project, repository: data.repository, issue: data.issue }
}

function validatePositionItem(
  request: GitHubProjectItemAddRequest,
  item: z.infer<typeof positionItemSchema>,
  projectRevision: number,
): void {
  if (item.project.id !== request.projectId
    || item.project.owner.id !== request.installation.accountId
    || timestamp(item.project.updatedAt) !== projectRevision) {
    invalid('project-item-add-membership')
  }
  if (item.content?.__typename === 'Issue' && item.content.id === undefined) {
    invalid('project-item-add-membership')
  }
  if (item.content?.__typename !== 'Issue' || item.content.id !== request.issueId) return
  if (item.content.repository === undefined
    || item.content.repository.id !== request.repositoryId
    || String(item.content.repository.databaseId) !== request.repositoryDatabaseId
    || item.content.repository.owner.id !== request.installation.accountId) {
    invalid('project-item-add-membership')
  }
}

function projectMembershipFact(
  request: GitHubProjectItemAddRequest,
  position: RetainedPosition,
): GitHubProjectMembershipItemFact {
  return {
    id: position.id,
    projectId: request.projectId,
    issueId: request.issueId,
    archived: position.archived,
  }
}

function sameIssue(left: GitHubIssueFact, right: GitHubIssueFact): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
