/** Project-item API-position mutation inspection. @module @breakfastdapaidang/saki-github-app/project-item-position-inspection */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubProjectItemId,
  githubProjectItemPositionSetInspectionSchema,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueFact,
  GitHubProjectItemPositionAnchorFact,
  GitHubProjectItemPositionMembership,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemPositionSetRequest,
  GitHubTargetedProjectItemFact,
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
  graphqlSingleSelectFieldValueSchema,
  graphqlSingleSelectFieldValuesSchema,
  graphqlSingleSelectStatusOptionId,
  graphqlTimestamp as timestamp,
  invalidGraphqlResponse as invalid,
  nextGraphqlCursor,
  queryGraphql,
} from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const POSITION_INSPECTION_QUERY = `
query SakiProjectItemPositionInspection(
  $projectId: ID!
  $repositoryId: ID!
  $issueId: ID!
  $statusFieldId: ID!
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
          __typename id isArchived updatedAt
          project { id updatedAt owner { id } }
          content {
            __typename
            ... on Issue {
              id number state title url updatedAt
              repository { id databaseId owner { id } }
            }
          }
          fieldValues(first: $first) {
            totalCount
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId
                field { ... on ProjectV2SingleSelectField { id } }
              }
            }
            pageInfo { hasNextPage endCursor }
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
  statusField: node(id: $statusFieldId) {
    __typename
    ... on ProjectV2SingleSelectField { id project { id } }
  }
}`

const POSITION_FIELD_VALUES_QUERY = `
query SakiProjectItemPositionFieldValues($itemId: ID!, $first: Int!, $after: String) {
  item: node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id isArchived updatedAt
      project { id updatedAt owner { id } }
      content {
        __typename
        ... on Issue {
          id number state title url updatedAt
          repository { id databaseId owner { id } }
        }
      }
      fieldValues(first: $first, after: $after) {
        totalCount
        nodes {
          __typename
          ... on ProjectV2ItemFieldSingleSelectValue {
            optionId
            field { ... on ProjectV2SingleSelectField { id } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const positionItemSchema = graphqlProjectItemPositionSchema.extend({
  content: z.object({
    __typename: z.string().min(1),
    id: z.string().min(1).optional(),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    state: z.enum(['OPEN', 'CLOSED']).optional(),
    title: z.string().min(1).optional(),
    url: z.url().optional(),
    updatedAt: z.iso.datetime().optional(),
    repository: graphqlOwnedNumericRepositoryIdentitySchema.optional(),
  }).loose().nullable(),
  fieldValues: graphqlSingleSelectFieldValuesSchema,
}).loose()
const statusFieldSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1).optional(),
  project: z.object({ id: z.string().min(1) }).loose().optional(),
}).loose()
const inspectionPageSchema = z.object({
  project: graphqlOwnedProjectRevisionNodeSchema.extend({
    items: graphqlConnectionSchema(positionItemSchema),
  }).loose().nullable(),
  repository: graphqlOwnedNumericRepositoryNodeSchema.nullable(),
  issue: graphqlOwnedIssueTargetSchema.nullable(),
  statusField: statusFieldSchema.nullable(),
}).loose()
const fieldValuesPageSchema = z.object({
  item: positionItemSchema.nullable(),
}).loose()

interface InspectionState {
  readonly request: GitHubProjectItemPositionSetRequest
  readonly session: GitHubOperationSession
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
}

interface RetainedPosition {
  readonly id: ReturnType<typeof githubProjectItemId>
  readonly issue?: GitHubIssueFact | undefined
  readonly archived: boolean
  readonly updatedAt: number
  readonly fieldValues: z.infer<typeof graphqlSingleSelectFieldValuesSchema>
  readonly revision: string
}

type PositionStatusOption = ReturnType<typeof graphqlSingleSelectStatusOptionId>
type PositionStatusCache = Map<RetainedPosition['id'], PositionStatusOption>

/**
 * Inspect one exact Project-item position across one complete API-order traversal.
 * @param request - immutable moving item, predecessor, and caller-persisted operation id.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated pagination and HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns moving membership, predecessor Work Item facts, and complete-order evidence.
 */
export async function inspectProjectItemPosition(
  request: GitHubProjectItemPositionSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubProjectItemPositionSetInspection> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-position-inspection',
  )
  const state: InspectionState = { request, session, config, signal }
  const snapshot = await readPosition(state)
  return githubProjectItemPositionSetInspectionSchema.parse({
    snapshot,
    observedAt: Date.now(),
  })
}

async function readPosition(
  state: InspectionState,
): Promise<GitHubProjectItemPositionSetInspection['snapshot']> {
  const positions: RetainedPosition[] = []
  let issue: GitHubIssueFact | undefined
  let projectUpdatedAt: number | undefined
  let totalCount: number | undefined
  let cursor: string | null = null
  const cursors = new Set<string>()
  const itemIds = new Set<string>()
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('project-item-position-membership')
    const data = inspectionPageSchema.parse(await queryGraphql(
      state.session.installation,
      POSITION_INSPECTION_QUERY,
      {
        projectId: state.request.projectId,
        repositoryId: state.request.repositoryId,
        issueId: state.request.issueId,
        statusFieldId: state.request.statusFieldId,
        first: state.config.pageSize,
        after: cursor,
      },
      state.signal,
      'project-item-position-membership',
    ))
    const targets = validateOwnersAndTargets(state.request, data)
    validateStatusField(state.request, data.statusField)
    const observedProjectUpdatedAt = timestamp(targets.project.updatedAt)
    projectUpdatedAt ??= observedProjectUpdatedAt
    if (projectUpdatedAt !== observedProjectUpdatedAt) invalid('project-item-position-stability')
    totalCount ??= targets.project.items.totalCount
    if (totalCount !== targets.project.items.totalCount || totalCount > state.config.maxItems) {
      invalid('project-item-position-membership')
    }
    const observedIssue = graphqlIssueFact(targets.issue, 'project-item-position-membership')
    issue ??= observedIssue
    if (JSON.stringify(issue) !== JSON.stringify(observedIssue)) invalid('project-item-position-stability')
    for (const item of targets.project.items.nodes) {
      if (itemIds.has(item.id)) invalid('project-item-position-membership')
      itemIds.add(item.id)
      const retained = retainedPosition(item)
      validatePositionItem(state.request, item, retained.issue, observedIssue, projectUpdatedAt)
      positions.push(retained)
      if (positions.length > state.config.maxItems) invalid('project-item-position-membership')
    }
    cursor = nextGraphqlCursor(
      targets.project.items.pageInfo,
      cursors,
      'project-item-position-membership',
    )
    if (cursor === null) break
    if (positions.length >= totalCount) invalid('project-item-position-membership')
  }
  if (positions.length !== totalCount) {
    invalid('project-item-position-membership')
  }
  const statusCache: PositionStatusCache = new Map()
  const matches: GitHubTargetedProjectItemFact[] = []
  for (const [apiOrder, position] of positions.entries()) {
    if (position.issue?.id === state.request.issueId) {
      matches.push(await membershipFact(state, positions, position, apiOrder, totalCount, statusCache))
    }
  }
  const membership = membershipObservation(matches)
  const after = await afterObservation(state, positions, totalCount, statusCache)
  return {
    repositoryId: state.request.repositoryId,
    repositoryDatabaseId: state.request.repositoryDatabaseId,
    projectId: state.request.projectId,
    statusFieldId: state.request.statusFieldId,
    issue,
    membership,
    after,
  }
}

function membershipObservation(
  matches: readonly GitHubTargetedProjectItemFact[],
): GitHubProjectItemPositionMembership {
  const [first, ...remaining] = matches
  if (first === undefined) return { state: 'absent' }
  if (remaining.length === 0) return { state: 'present', item: first }
  return { state: 'duplicate-conflict', items: [first, ...remaining] }
}

function retainedPosition(item: z.infer<typeof positionItemSchema>): RetainedPosition {
  const issue = item.content?.__typename === 'Issue'
    ? graphqlIssueFact(item.content, 'project-item-position-membership')
    : undefined
  return {
    id: githubProjectItemId(item.id),
    ...(issue === undefined ? {} : { issue }),
    archived: item.isArchived,
    updatedAt: timestamp(item.updatedAt),
    fieldValues: item.fieldValues,
    revision: positionRevision(item),
  }
}

async function afterObservation(
  state: InspectionState,
  positions: readonly RetainedPosition[],
  totalCount: number,
  statusCache: PositionStatusCache,
): Promise<GitHubProjectItemPositionSetInspection['snapshot']['after']> {
  const { request } = state
  if (request.afterItemId === null) return { state: 'top' }
  const position = positions.find(candidate => candidate.id === request.afterItemId)
  if (position === undefined) return { state: 'absent', itemId: request.afterItemId }
  if (position.issue === undefined) invalid('project-item-position-anchor')
  const apiOrder = positions.indexOf(position)
  const statusOptionId = await readPositionStatus(state, position, statusCache)
  const item: GitHubProjectItemPositionAnchorFact = {
    id: position.id,
    projectId: request.projectId,
    issue: position.issue,
    ...(statusOptionId === undefined ? {} : { statusOptionId }),
    archived: position.archived,
    apiOrder,
    totalCount,
    previousItemId: positions[apiOrder - 1]?.id ?? null,
    nextItemId: positions[apiOrder + 1]?.id ?? null,
    updatedAt: position.updatedAt,
  }
  return { state: 'present', item }
}

async function membershipFact(
  state: InspectionState,
  positions: readonly RetainedPosition[],
  position: RetainedPosition,
  apiOrder: number,
  totalCount: number,
  statusCache: PositionStatusCache,
): Promise<GitHubTargetedProjectItemFact> {
  const { request } = state
  const statusOptionId = await readPositionStatus(state, position, statusCache)
  return {
    id: position.id,
    projectId: request.projectId,
    issueId: request.issueId,
    ...(statusOptionId === undefined ? {} : { statusOptionId }),
    archived: position.archived,
    apiOrder,
    totalCount,
    previousItemId: positions[apiOrder - 1]?.id ?? null,
    nextItemId: positions[apiOrder + 1]?.id ?? null,
    updatedAt: position.updatedAt,
  }
}

async function readPositionStatus(
  state: InspectionState,
  position: RetainedPosition,
  cache: PositionStatusCache,
): Promise<PositionStatusOption> {
  if (cache.has(position.id)) return cache.get(position.id)
  const optionId = graphqlSingleSelectStatusOptionId(
    await readAllFieldValues(state, position),
    state.request.statusFieldId,
    'project-item-position-status',
  )
  cache.set(position.id, optionId)
  return optionId
}

async function readAllFieldValues(
  state: InspectionState,
  position: RetainedPosition,
): Promise<z.infer<typeof graphqlSingleSelectFieldValueSchema>[]> {
  const values = [...position.fieldValues.nodes]
  const totalCount = position.fieldValues.totalCount
  if (totalCount > state.config.maxFieldValues || values.length > totalCount) {
    invalid('project-item-position-field-values')
  }
  const cursors = new Set<string>()
  let cursor = nextGraphqlCursor(
    position.fieldValues.pageInfo,
    cursors,
    'project-item-position-field-values',
  )
  let page = 1
  while (cursor !== null) {
    page += 1
    if (page > state.config.maxPages) invalid('project-item-position-field-values')
    const data = fieldValuesPageSchema.parse(await queryGraphql(
      state.session.installation,
      POSITION_FIELD_VALUES_QUERY,
      { itemId: position.id, first: state.config.pageSize, after: cursor },
      state.signal,
      'project-item-position-field-values',
    ))
    if (data.item === null || positionRevision(data.item) !== position.revision) {
      invalid('project-item-position-stability')
    }
    values.push(...data.item.fieldValues.nodes)
    if (values.length > totalCount) invalid('project-item-position-field-values')
    cursor = nextGraphqlCursor(
      data.item.fieldValues.pageInfo,
      cursors,
      'project-item-position-field-values',
    )
  }
  if (values.length !== totalCount) invalid('project-item-position-field-values')
  return values
}

function validateOwnersAndTargets(
  request: GitHubProjectItemPositionSetRequest,
  data: z.infer<typeof inspectionPageSchema>,
): {
  readonly project: NonNullable<typeof data.project>
  readonly repository: NonNullable<typeof data.repository>
  readonly issue: NonNullable<typeof data.issue>
} {
  if (data.project === null) notFound('Project')
  if (data.repository === null) notFound('Repository')
  if (data.issue === null) notFound('Issue')
  if (!graphqlProjectIssueTargetMatches(request, {
    project: data.project,
    repository: data.repository,
    issue: data.issue,
  })) invalid('project-item-position-target')
  return { project: data.project, repository: data.repository, issue: data.issue }
}

function validatePositionItem(
  request: GitHubProjectItemPositionSetRequest,
  item: z.infer<typeof positionItemSchema>,
  itemIssue: GitHubIssueFact | undefined,
  movingIssue: GitHubIssueFact,
  projectUpdatedAt: number,
): void {
  const expectedProject = JSON.stringify([
    request.projectId,
    request.installation.accountId,
    projectUpdatedAt,
  ])
  const observedProject = JSON.stringify([
    item.project.id,
    item.project.owner.id,
    timestamp(item.project.updatedAt),
  ])
  if (observedProject !== expectedProject) {
    invalid('project-item-position-membership')
  }
  if (item.id === request.projectItemId
    && (itemIssue === undefined || JSON.stringify(itemIssue) !== JSON.stringify(movingIssue))) {
    invalid('project-item-position-target')
  }
  if (item.id === request.afterItemId && itemIssue === undefined) return
  if (item.id !== request.projectItemId && item.id !== request.afterItemId) return
  const repository = item.content?.repository
  if (repository === undefined
    || repository.id !== request.repositoryId
    || String(repository.databaseId) !== request.repositoryDatabaseId
    || repository.owner.id !== request.installation.accountId) {
    invalid(item.id === request.projectItemId
      ? 'project-item-position-target'
      : 'project-item-position-anchor')
  }
}

function validateStatusField(
  request: GitHubProjectItemPositionSetRequest,
  field: z.infer<typeof statusFieldSchema> | null,
): void {
  if (field === null
    || field.__typename !== 'ProjectV2SingleSelectField'
    || field.id !== request.statusFieldId
    || field.project?.id !== request.projectId) {
    throw new GitHubProviderError({
      code: 'mapping-mismatch',
      reason: 'field-missing-or-not-single-select',
      statusFieldId: request.statusFieldId,
    })
  }
}

function positionRevision(item: z.infer<typeof positionItemSchema>): string {
  return JSON.stringify([
    item.id,
    item.isArchived,
    item.updatedAt,
    item.project.id,
    item.project.updatedAt,
    item.project.owner.id,
    item.content?.__typename,
    item.content?.id,
    item.content?.updatedAt,
    item.content?.repository?.id,
    item.content?.repository?.databaseId,
    item.fieldValues.totalCount,
  ])
}
