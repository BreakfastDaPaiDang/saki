/** Targeted Product App Status inspection. @module @breakfastdapaidang/saki-github-app/project-item-status-inspection */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubIssueId,
  githubProjectItemId,
  githubProjectItemStatusSetInspectionSchema,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueFact,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import {
  graphqlConnectionSchema,
  graphqlIssueFact,
  graphqlIssueNodeSchema,
  graphqlNotFound as notFound,
  graphqlNumericRepositoryIdentitySchema,
  graphqlProjectRevisionNodeSchema,
  graphqlProjectRevisionSchema,
  graphqlSingleSelectFieldValueSchema,
  graphqlSingleSelectFieldValuesSchema,
  graphqlSingleSelectStatusOptionId,
  graphqlTimestamp as timestamp,
  invalidGraphqlResponse as invalid,
  nextGraphqlCursor as nextCursor,
  queryGraphql,
} from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const POSITION_QUERY = `
query SakiProjectItemPosition($projectId: ID!, $first: Int!, $after: String) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id updatedAt
      items(first: $first, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED], orderBy: { field: POSITION, direction: ASC }) {
        totalCount
        nodes {
          id
          content { __typename ... on Issue { id } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`

const TARGET_QUERY = `
query SakiTargetedWorkItem($projectId: ID!, $issueId: ID!, $itemId: ID!, $statusFieldId: ID!, $first: Int!) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 { id updatedAt }
  }
  issue: node(id: $issueId) {
    __typename
    ... on Issue { id number state title url updatedAt repository { id databaseId } }
  }
  item: node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id isArchived updatedAt
      project { id updatedAt }
      content { __typename ... on Issue { id updatedAt } }
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
  }
  statusField: node(id: $statusFieldId) {
    __typename
    ... on ProjectV2SingleSelectField {
      id
      project { id }
      options { id }
    }
  }
}`

const FIELD_VALUES_QUERY = `
query SakiTargetedProjectItemFieldValues($itemId: ID!, $first: Int!, $after: String) {
  item: node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id updatedAt
      project { id updatedAt }
      content { __typename ... on Issue { id updatedAt } }
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

const positionItemSchema = z.object({
  id: z.string().min(1),
  content: z.object({
    __typename: z.string().min(1),
    id: z.string().min(1).optional(),
  }).loose().nullable(),
}).loose()

const positionDataSchema = z.object({
  project: graphqlProjectRevisionNodeSchema.extend({
    items: graphqlConnectionSchema(positionItemSchema),
  }).loose().nullable(),
}).loose()

const itemRevisionSchema = z.object({
  __typename: z.literal('ProjectV2Item'),
  id: z.string().min(1),
  updatedAt: z.iso.datetime(),
  project: graphqlProjectRevisionSchema,
  content: z.object({
    __typename: z.literal('Issue'),
    id: z.string().min(1),
    updatedAt: z.iso.datetime(),
  }).loose(),
  fieldValues: graphqlSingleSelectFieldValuesSchema,
}).loose()

const targetItemSchema = itemRevisionSchema.extend({ isArchived: z.boolean() }).loose()

const statusFieldNodeSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1).optional(),
  project: z.object({ id: z.string().min(1) }).loose().optional(),
  options: z.array(z.object({ id: z.string().min(1) }).loose()).optional(),
}).loose()

const targetedIssueNodeSchema = graphqlIssueNodeSchema.extend({
  repository: graphqlNumericRepositoryIdentitySchema,
}).loose()

const targetDataSchema = z.object({
  project: graphqlProjectRevisionNodeSchema.nullable(),
  issue: targetedIssueNodeSchema.extend({ __typename: z.literal('Issue') }).loose().nullable(),
  item: targetItemSchema.nullable(),
  statusField: statusFieldNodeSchema.nullable(),
}).loose()

const fieldValuesDataSchema = z.object({
  item: itemRevisionSchema.nullable(),
}).loose()

interface PositionFact {
  readonly id: ReturnType<typeof githubProjectItemId>
  readonly issueId?: ReturnType<typeof githubIssueId> | undefined
}

interface InspectionState {
  readonly request: GitHubProjectItemStatusSetRequest
  readonly session: GitHubOperationSession
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
}

interface PositionInspection {
  readonly items: readonly PositionFact[]
  readonly projectRevision: number
  readonly totalCount: number
}

/**
 * Inspect one Status mutation target without producing a Board scan candidate.
 * @param request - immutable mutation request used for exact target selection.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated pagination and HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns raw Issue, membership, Status, archive, order, and neighbor facts.
 */
export async function inspectProjectItemStatus(
  request: GitHubProjectItemStatusSetRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubProjectItemStatusSetInspection> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'project-item-status-inspection',
  )
  const state: InspectionState = { request, session, config, signal }
  const snapshot = await readTargetedSnapshot(state)
  return githubProjectItemStatusSetInspectionSchema.parse({
    snapshot,
    observedAt: Date.now(),
  })
}

async function readTargetedSnapshot(
  state: InspectionState,
): Promise<GitHubTargetedWorkItemSnapshot> {
  const { request } = state
  const positionInspection = await readPositions(state)
  const positions = positionInspection.items
  const expected = positions.find(item => item.id === request.projectItemId)
  if (expected !== undefined && expected.issueId !== request.issueId) invalid('targeted-work-item-membership')
  const issueMemberships = positions.filter(item => item.issueId === request.issueId)
  if (issueMemberships.length > 1) invalid('targeted-work-item-membership')
  const membership = expected ?? issueMemberships[0]
  const position = membership === undefined ? -1 : positions.indexOf(membership)
  const detail = await readTarget(state, membership?.id ?? request.projectItemId)
  if (detail.projectRevision !== positionInspection.projectRevision) invalid('targeted-work-item-stability')

  if (membership === undefined) {
    if (detail.item !== null && detail.item.project.id === request.projectId) {
      invalid('targeted-work-item-membership')
    }
    return {
      repositoryId: request.repositoryId,
      repositoryDatabaseId: request.repositoryDatabaseId,
      projectId: request.projectId,
      statusFieldId: request.statusFieldId,
      issue: detail.issue,
      membership: { state: 'absent' },
    }
  }
  if (detail.item === null || targetIdentity(detail.item) !== requestedTargetIdentity(request, membership.id)) {
    invalid('targeted-work-item')
  }
  const values = await readAllFieldValues(state, detail.item)
  const statusOptionId = graphqlSingleSelectStatusOptionId(
    values,
    request.statusFieldId,
    'targeted-work-item-status',
  )
  return {
    repositoryId: request.repositoryId,
    repositoryDatabaseId: request.repositoryDatabaseId,
    projectId: request.projectId,
    statusFieldId: request.statusFieldId,
    issue: detail.issue,
    membership: {
      state: 'present',
      item: {
        id: membership.id,
        projectId: request.projectId,
        issueId: request.issueId,
        ...(statusOptionId === undefined ? {} : { statusOptionId }),
        archived: detail.item.isArchived,
        apiOrder: position,
        totalCount: positionInspection.totalCount,
        previousItemId: positions[position - 1]?.id ?? null,
        nextItemId: positions[position + 1]?.id ?? null,
        updatedAt: timestamp(detail.item.updatedAt),
      },
    },
  }
}

async function readPositions(
  state: InspectionState,
): Promise<PositionInspection> {
  const positions: PositionFact[] = []
  let projectRevision: number | undefined
  let cursor: string | null = null
  const cursors = new Set<string>()
  const ids = new Set<string>()
  let totalCount: number | undefined
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('targeted-work-item-position')
    const data = positionDataSchema.parse(await queryGraphql(
      state.session.installation,
      POSITION_QUERY,
      { projectId: state.request.projectId, first: state.config.pageSize, after: cursor },
      state.signal,
      'targeted-work-item-position',
    ))
    if (data.project === null) notFound('Project')
    if (data.project.id !== state.request.projectId) invalid('targeted-work-item-position')
    const observedRevision = timestamp(data.project.updatedAt)
    projectRevision ??= observedRevision
    if (projectRevision !== observedRevision) invalid('targeted-work-item-stability')
    totalCount ??= data.project.items.totalCount
    if (totalCount !== data.project.items.totalCount || totalCount > state.config.maxItems) {
      invalid('targeted-work-item-position')
    }
    for (const item of data.project.items.nodes) {
      if (ids.has(item.id)) invalid('targeted-work-item-position')
      ids.add(item.id)
      const issueId = item.content?.__typename === 'Issue'
        ? item.content.id
        : undefined
      if (item.content?.__typename === 'Issue' && issueId === undefined) invalid('targeted-work-item-position')
      positions.push({
        id: githubProjectItemId(item.id),
        ...(issueId === undefined ? {} : { issueId: githubIssueId(issueId) }),
      })
      if (positions.length > state.config.maxItems) invalid('targeted-work-item-position')
    }
    cursor = nextCursor(data.project.items.pageInfo, cursors, 'targeted-work-item-position')
    if (cursor === null) {
      if (positions.length !== totalCount) invalid('targeted-work-item-position')
      return {
        items: positions,
        projectRevision,
        totalCount,
      }
    }
    if (positions.length >= totalCount) invalid('targeted-work-item-position')
  }
}

async function readTarget(
  state: InspectionState,
  itemId: ReturnType<typeof githubProjectItemId>,
): Promise<{
  readonly projectRevision: number
  readonly issue: GitHubIssueFact
  readonly item: z.infer<typeof targetItemSchema> | null
}> {
  const data = targetDataSchema.parse(await queryGraphql(
    state.session.installation,
    TARGET_QUERY,
    {
      projectId: state.request.projectId,
      issueId: state.request.issueId,
      itemId,
      statusFieldId: state.request.statusFieldId,
      first: state.config.pageSize,
    },
    state.signal,
    'targeted-work-item',
  ))
  if (data.project === null) notFound('Project')
  if (data.issue === null) notFound('Issue')
  validateStatusMapping(state.request, data.statusField)
  const observedIdentity = JSON.stringify([
    data.project.id,
    data.issue.id,
    data.issue.repository.id,
    String(data.issue.repository.databaseId),
  ])
  const expectedIdentity = JSON.stringify([
    state.request.projectId,
    state.request.issueId,
    state.request.repositoryId,
    state.request.repositoryDatabaseId,
  ])
  if (observedIdentity !== expectedIdentity) invalid('targeted-work-item')
  return {
    projectRevision: timestamp(data.project.updatedAt),
    issue: graphqlIssueFact(data.issue, 'targeted-work-item'),
    item: data.item,
  }
}

function validateStatusMapping(
  request: GitHubProjectItemStatusSetRequest,
  field: z.infer<typeof statusFieldNodeSchema> | null,
): void {
  if (field === null
    || field.__typename !== 'ProjectV2SingleSelectField'
    || field.id !== request.statusFieldId
    || field.project?.id !== request.projectId
    || field.options === undefined) {
    throw new GitHubProviderError({
      code: 'mapping-mismatch',
      reason: 'field-missing-or-not-single-select',
      statusFieldId: request.statusFieldId,
    })
  }
  const optionIds = field.options.map(option => option.id)
  if (new Set(optionIds).size !== optionIds.length) invalid('targeted-work-item-status-field')
  if (!optionIds.includes(request.desiredStatusOptionId)) {
    throw new GitHubProviderError({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: request.statusFieldId,
      missingRequiredStatusOptionIds: [request.desiredStatusOptionId],
    })
  }
}

async function readAllFieldValues(
  state: InspectionState,
  item: z.infer<typeof targetItemSchema>,
): Promise<z.infer<typeof graphqlSingleSelectFieldValueSchema>[]> {
  const values = [...item.fieldValues.nodes]
  const total = item.fieldValues.totalCount
  if (total > state.config.maxFieldValues || values.length > total) invalid('targeted-work-item-field-values')
  const cursors = new Set<string>()
  let cursor = nextCursor(item.fieldValues.pageInfo, cursors, 'targeted-work-item-field-values')
  let page = 1
  while (cursor !== null) {
    page += 1
    if (page > state.config.maxPages) invalid('targeted-work-item-field-values')
    const data = fieldValuesDataSchema.parse(await queryGraphql(
      state.session.installation,
      FIELD_VALUES_QUERY,
      { itemId: item.id, first: state.config.pageSize, after: cursor },
      state.signal,
      'targeted-work-item-field-values',
    ))
    if (data.item === null || itemRevision(data.item) !== itemRevision(item)) {
      invalid('targeted-work-item-stability')
    }
    values.push(...data.item.fieldValues.nodes)
    if (values.length > total) invalid('targeted-work-item-field-values')
    cursor = nextCursor(data.item.fieldValues.pageInfo, cursors, 'targeted-work-item-field-values')
  }
  if (values.length !== total) invalid('targeted-work-item-field-values')
  return values
}

function targetIdentity(
  item: Pick<z.infer<typeof targetItemSchema>, 'id' | 'project' | 'content'>,
): string {
  return JSON.stringify([item.id, item.project.id, item.content.id])
}

function requestedTargetIdentity(
  request: GitHubProjectItemStatusSetRequest,
  itemId: string,
): string {
  return JSON.stringify([itemId, request.projectId, request.issueId])
}

function itemRevision(item: z.infer<typeof itemRevisionSchema>): string {
  return JSON.stringify([
    item.id,
    item.updatedAt,
    item.project.id,
    item.project.updatedAt,
    item.content.id,
    item.content.updatedAt,
    item.fieldValues.totalCount,
  ])
}
