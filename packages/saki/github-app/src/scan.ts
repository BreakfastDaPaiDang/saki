/** Complete staged GitHub Project Board scanning. @module @breakfastdapaidang/saki-github-app/scan */

import { z } from 'zod'
import {
  computeGitHubProjectBoardFingerprint,
  GITHUB_PROJECT_BOARD_FIELD_LIMIT,
  GitHubProviderError,
  githubAccountId,
  githubIssueId,
  githubProjectBoardScanCandidateSchema,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubPullRequestId,
  githubRepositoryDatabaseId,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubGraphqlRateObservation,
  GitHubInstallationFact,
  GitHubIssueFact,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectBoardUpdateFence,
  GitHubProjectFact,
  GitHubProjectFieldFact,
  GitHubProjectItemContent,
  GitHubProjectItemFact,
  GitHubRateObservation,
  GitHubRepositoryFact,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import {
  graphqlIssueNodeSchema,
  graphqlProjectNodeSchema,
  graphqlRepositoryNodeSchema,
  queryGraphql,
} from './graphql.ts'
import { inspectInstallation } from './installation.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'
import { appendGitHubRateObservation } from './rate-observations.ts'

const FENCE_QUERY = `
query SakiProjectBoardFence($projectId: ID!, $repositoryId: ID!) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id number title closed url updatedAt
      owner { ... on Organization { id } ... on User { id } }
      items(archivedStates: [ARCHIVED, NOT_ARCHIVED]) { totalCount }
    }
  }
  repository: node(id: $repositoryId) {
    __typename
    ... on Repository {
      id databaseId: fullDatabaseId nameWithOwner visibility url updatedAt owner { id }
      issues(states: OPEN) { totalCount }
    }
  }
  rateLimit { cost limit used remaining resetAt }
}`

const FIELDS_QUERY = `
query SakiProjectFields($projectId: ID!, $first: Int!, $after: String) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id
      fields(first: $first, after: $after) {
        totalCount
        nodes {
          __typename
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2IterationField { id name dataType }
          ... on ProjectV2MultiSelectField { id name dataType }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { cost limit used remaining resetAt }
}`

const ITEMS_QUERY = `
query SakiProjectItems($projectId: ID!, $first: Int!, $after: String) {
  project: node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id
      items(first: $first, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED], orderBy: { field: POSITION, direction: ASC }) {
        nodes {
          id isArchived updatedAt
          content {
            __typename
            ... on Issue { id number state title url updatedAt repository { id databaseId: fullDatabaseId } }
            ... on PullRequest { id url repository { id } }
            ... on DraftIssue { title }
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
  rateLimit { cost limit used remaining resetAt }
}`

const ITEM_FIELD_VALUES_QUERY = `
query SakiProjectItemFieldValues($itemId: ID!, $first: Int!, $after: String) {
  item: node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
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
  rateLimit { cost limit used remaining resetAt }
}`

const OPEN_ISSUES_QUERY = `
query SakiOpenIssues($repositoryId: ID!, $first: Int!, $after: String) {
  repository: node(id: $repositoryId) {
    __typename
    ... on Repository {
      id
      databaseId: fullDatabaseId
      issues(states: OPEN, first: $first, after: $after, orderBy: { field: CREATED_AT, direction: ASC }) {
        nodes { id number state title url updatedAt repository { id databaseId: fullDatabaseId } }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
  rateLimit { cost limit used remaining resetAt }
}`

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).nullable(),
}).loose()

const rateSchema = z.object({
  cost: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  used: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  remaining: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  resetAt: z.iso.datetime(),
}).loose().superRefine((rate, ctx) => {
  if (rate.used > rate.limit || rate.remaining > rate.limit || rate.used !== rate.limit - rate.remaining) {
    ctx.addIssue({ code: 'custom', message: 'primary rate counters must partition the reported limit' })
  }
})

const repositoryNodeSchema = graphqlRepositoryNodeSchema.extend({
  __typename: z.literal('Repository'),
  issues: z.object({ totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).loose(),
}).loose()

const projectNodeSchema = graphqlProjectNodeSchema.extend({
  __typename: z.literal('ProjectV2'),
  items: z.object({ totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).loose(),
}).loose()

const fenceDataSchema = z.object({
  project: projectNodeSchema,
  repository: repositoryNodeSchema,
  rateLimit: rateSchema,
}).loose()

const fieldSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  dataType: z.string().min(1).optional(),
  options: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).loose()).optional(),
}).loose()

const fieldsDataSchema = z.object({
  project: z.object({
    __typename: z.literal('ProjectV2'),
    id: z.string().min(1),
    fields: z.object({
      totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      nodes: z.array(fieldSchema),
      pageInfo: pageInfoSchema,
    }).loose(),
  }).loose(),
  rateLimit: rateSchema,
}).loose()

const fieldValueSchema = z.object({
  __typename: z.string().min(1),
  optionId: z.string().min(1).nullable().optional(),
  field: z.object({ __typename: z.string().min(1).optional(), id: z.string().min(1) }).loose().nullable().optional(),
}).loose()

const fieldValuesConnectionSchema = z.object({
  totalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nodes: z.array(fieldValueSchema),
  pageInfo: pageInfoSchema,
}).loose()

const contentSchema = z.object({
  __typename: z.string().min(1),
  id: z.string().min(1).optional(),
  number: z.number().int().positive().optional(),
  state: z.enum(['OPEN', 'CLOSED']).optional(),
  title: z.string().min(1).optional(),
  url: z.url().optional(),
  updatedAt: z.iso.datetime().optional(),
  repository: z.object({
    id: z.string().min(1),
    databaseId: githubRepositoryDatabaseIdSchema.optional(),
  }).loose().nullable().optional(),
}).loose()

const itemSchema = z.object({
  id: z.string().min(1),
  isArchived: z.boolean(),
  updatedAt: z.iso.datetime(),
  content: contentSchema.nullable(),
  fieldValues: fieldValuesConnectionSchema,
}).loose()

const itemsDataSchema = z.object({
  project: z.object({
    __typename: z.literal('ProjectV2'),
    id: z.string().min(1),
    items: z.object({ nodes: z.array(itemSchema), pageInfo: pageInfoSchema }).loose(),
  }).loose(),
  rateLimit: rateSchema,
}).loose()

const itemFieldValuesDataSchema = z.object({
  item: z.object({
    __typename: z.literal('ProjectV2Item'),
    id: z.string().min(1),
    fieldValues: fieldValuesConnectionSchema,
  }).loose(),
  rateLimit: rateSchema,
}).loose()

const issueNodeSchema = graphqlIssueNodeSchema

const openIssuesDataSchema = z.object({
  repository: z.object({
    __typename: z.literal('Repository'),
    id: z.string().min(1),
    databaseId: githubRepositoryDatabaseIdSchema,
    issues: z.object({ nodes: z.array(issueNodeSchema), pageInfo: pageInfoSchema }).loose(),
  }).loose(),
  rateLimit: rateSchema,
}).loose()

interface ScanState {
  readonly request: GitHubProjectBoardScanRequest
  readonly session: GitHubOperationSession
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
  readonly rates: GitHubRateObservation[]
  fieldValueCount: number
}

/**
 * Read two complete fenced Board passes and admit the second only when both
 * semantic fingerprints match.
 * @param request - exact Project, Repository, Status field, and option identities.
 * @param privateKey - operation-scoped private key.
 * @param config - validated pagination and rate limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation request scheduler.
 * @returns the second complete candidate after cross-pass stability validation.
 */
export async function scanProjectBoard(
  request: GitHubProjectBoardScanRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubProjectBoardScanCandidate> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    request.priority,
  )
  const installationInspection = await inspectInstallation(session, request.installation, config, signal)
  const installation = installationInspection.fact
  const state: ScanState = {
    request,
    session,
    config,
    signal,
    rates: [...installationInspection.rateObservations],
    fieldValueCount: 0,
  }
  const first = await readProjectBoardPass(state, installation)
  const second = await readProjectBoardPass(state, installation)
  if (first.fingerprint.digest !== second.fingerprint.digest) invalid('project-board-stability')
  return second
}

async function readProjectBoardPass(
  state: ScanState,
  installation: GitHubInstallationFact,
): Promise<GitHubProjectBoardScanCandidate> {
  state.fieldValueCount = 0
  const before = await readFence(state)
  const fields = await readFields(state)
  validateStatusMapping(state.request, fields)
  const items = await readItems(state)
  const openIssues = await readOpenIssues(state)
  const after = await readFence(state)
  if (!sameFence(before.fence, after.fence)) invalid('project-board-fence')

  const observedAt = Date.now()
  const repository = repositoryFact(before.repository, observedAt)
  const project = projectFact(before.project, observedAt)
  const source: GitHubProjectBoardFingerprintSource = {
    kind: 'project-board',
    formatVersion: 1,
    installation,
    repository,
    project,
    statusFieldId: state.request.statusFieldId,
    fields,
    items,
    openIssues,
    fences: { before: before.fence, after: after.fence },
    rateObservations: [...state.rates],
    observedAt,
  }
  return githubProjectBoardScanCandidateSchema.parse({
    ...source,
    fingerprint: computeGitHubProjectBoardFingerprint(source),
  })
}

async function readFence(state: ScanState): Promise<{
  readonly fence: GitHubProjectBoardUpdateFence
  readonly project: z.infer<typeof projectNodeSchema>
  readonly repository: z.infer<typeof repositoryNodeSchema>
}> {
  const data = fenceDataSchema.parse(await queryGraphql(
    state.session.installation,
    FENCE_QUERY,
    { projectId: state.request.projectId, repositoryId: state.request.repositoryId },
    state.signal,
    'project-board-fence',
  ))
  observeRate(state, data.rateLimit)
  if (data.project.id !== state.request.projectId
    || data.repository.id !== state.request.repositoryId
    || data.repository.databaseId !== state.request.repositoryDatabaseId) invalid('project-board-fence')
  return {
    project: data.project,
    repository: data.repository,
    fence: {
      projectUpdatedAt: timestamp(data.project.updatedAt),
      repositoryUpdatedAt: timestamp(data.repository.updatedAt),
      projectItemCount: data.project.items.totalCount,
      openIssueCount: data.repository.issues.totalCount,
    },
  }
}

async function readFields(state: ScanState): Promise<GitHubProjectFieldFact[]> {
  const fields: GitHubProjectFieldFact[] = []
  let cursor: string | null = null
  let reportedTotal: number | undefined
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('project-fields')
    const data = fieldsDataSchema.parse(await queryGraphql(
      state.session.installation,
      FIELDS_QUERY,
      { projectId: state.request.projectId, first: state.config.pageSize, after: cursor },
      state.signal,
      'project-fields',
    ))
    if (data.project.id !== state.request.projectId) invalid('project-fields')
    observeRate(state, data.rateLimit)
    reportedTotal ??= data.project.fields.totalCount
    if (data.project.fields.totalCount !== reportedTotal
      || reportedTotal > GITHUB_PROJECT_BOARD_FIELD_LIMIT) {
      invalid('project-fields')
    }
    for (const field of data.project.fields.nodes) {
      fields.push(field.__typename === 'ProjectV2SingleSelectField'
        ? {
          kind: 'single-select',
          id: githubProjectFieldId(field.id),
          name: field.name,
          options: (field.options ?? []).map(option => ({
            id: githubProjectOptionId(option.id),
            name: option.name,
          })),
        }
        : {
          kind: 'field',
          id: githubProjectFieldId(field.id),
          name: field.name,
          dataType: field.dataType ?? field.__typename,
        })
    }
    if (fields.length > reportedTotal) invalid('project-fields')
    cursor = nextCursor(data.project.fields.pageInfo, cursors, 'project-fields')
    if (cursor === null) {
      if (fields.length !== reportedTotal) invalid('project-fields')
      return fields
    }
  }
}

async function readItems(state: ScanState): Promise<GitHubProjectItemFact[]> {
  const items: GitHubProjectItemFact[] = []
  let cursor: string | null = null
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('project-items')
    const data = itemsDataSchema.parse(await queryGraphql(
      state.session.installation,
      ITEMS_QUERY,
      { projectId: state.request.projectId, first: state.config.pageSize, after: cursor },
      state.signal,
      'project-items',
    ))
    if (data.project.id !== state.request.projectId) invalid('project-items')
    observeRate(state, data.rateLimit)
    for (const item of data.project.items.nodes) {
      const values = [...item.fieldValues.nodes]
      const reportedTotal = item.fieldValues.totalCount
      if (reportedTotal > state.config.maxFieldValues - state.fieldValueCount
        || values.length > reportedTotal) invalid('project-item-field-values')
      const valueCursors = new Set<string>()
      let valuePage = 1
      let valueCursor = nextCursor(item.fieldValues.pageInfo, valueCursors, 'project-item-field-values')
      while (valueCursor !== null) {
        valuePage += 1
        if (valuePage > state.config.maxPages) invalid('project-item-field-values')
        const valueData = itemFieldValuesDataSchema.parse(await queryGraphql(
          state.session.installation,
          ITEM_FIELD_VALUES_QUERY,
          { itemId: item.id, first: state.config.pageSize, after: valueCursor },
          state.signal,
          'project-item-field-values',
        ))
        if (valueData.item.id !== item.id) invalid('project-item-field-values')
        observeRate(state, valueData.rateLimit)
        if (valueData.item.fieldValues.totalCount !== reportedTotal) invalid('project-item-field-values')
        values.push(...valueData.item.fieldValues.nodes)
        if (values.length > reportedTotal) invalid('project-item-field-values')
        valueCursor = nextCursor(valueData.item.fieldValues.pageInfo, valueCursors, 'project-item-field-values')
      }
      if (values.length !== reportedTotal) invalid('project-item-field-values')
      state.fieldValueCount += values.length
      items.push({
        id: githubProjectItemId(item.id),
        projectId: state.request.projectId,
        content: projectContent(item.content),
        ...statusValue(values, state.request.statusFieldId),
        archived: item.isArchived,
        apiOrder: items.length,
        updatedAt: timestamp(item.updatedAt),
      })
    }
    if (items.length > state.config.maxItems) invalid('project-items')
    cursor = nextCursor(data.project.items.pageInfo, cursors, 'project-items')
    if (cursor === null) return items
  }
}

async function readOpenIssues(state: ScanState): Promise<GitHubIssueFact[]> {
  const issues: GitHubIssueFact[] = []
  let cursor: string | null = null
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    if (page > state.config.maxPages) invalid('open-issues')
    const data = openIssuesDataSchema.parse(await queryGraphql(
      state.session.installation,
      OPEN_ISSUES_QUERY,
      { repositoryId: state.request.repositoryId, first: state.config.pageSize, after: cursor },
      state.signal,
      'open-issues',
    ))
    if (data.repository.id !== state.request.repositoryId
      || data.repository.databaseId !== state.request.repositoryDatabaseId) invalid('open-issues')
    observeRate(state, data.rateLimit)
    issues.push(...data.repository.issues.nodes.map(issueFact))
    if (issues.length > state.config.maxItems) invalid('open-issues')
    cursor = nextCursor(data.repository.issues.pageInfo, cursors, 'open-issues')
    if (cursor === null) return issues
  }
}

function validateStatusMapping(request: GitHubProjectBoardScanRequest, fields: readonly GitHubProjectFieldFact[]): void {
  const matching = fields.filter(field => field.id === request.statusFieldId)
  if (matching.length !== 1 || matching[0]?.kind !== 'single-select') {
    throw new GitHubProviderError({
      code: 'mapping-mismatch',
      reason: 'field-missing-or-not-single-select',
      statusFieldId: request.statusFieldId,
    })
  }
  const optionIds = matching[0].options.map(option => option.id)
  if (new Set(optionIds).size !== optionIds.length) invalid('configured-status-options')
  const missingRequiredStatusOptionIds = request.requiredStatusOptionIds.filter(
    optionId => !optionIds.includes(optionId),
  )
  if (missingRequiredStatusOptionIds.length > 0) {
    throw new GitHubProviderError({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: request.statusFieldId,
      missingRequiredStatusOptionIds,
    })
  }
}

function statusValue(
  values: readonly z.infer<typeof fieldValueSchema>[],
  statusFieldId: string,
): { readonly statusOptionId?: ReturnType<typeof githubProjectOptionId> } {
  const matches = values.filter(value => value.__typename === 'ProjectV2ItemFieldSingleSelectValue'
    && value.field?.id === statusFieldId)
  if (matches.length > 1) invalid('project-item-status')
  const optionId = matches[0]?.optionId
  return optionId === undefined || optionId === null ? {} : { statusOptionId: githubProjectOptionId(optionId) }
}

function projectContent(content: z.infer<typeof contentSchema> | null): GitHubProjectItemContent {
  if (content === null) return { kind: 'redacted' }
  switch (content.__typename) {
    case 'Issue':
      return { kind: 'issue', issue: issueFact(issueContent(content)) }
    case 'PullRequest':
      if (content.id === undefined) invalid('project-item-content')
      return {
        kind: 'pull-request',
        id: githubPullRequestId(content.id),
        ...(content.repository === undefined || content.repository === null
          ? {}
          : { repositoryId: githubRepositoryId(content.repository.id) }),
        ...(content.url === undefined ? {} : { url: content.url }),
      }
    case 'DraftIssue':
      if (content.title === undefined) invalid('project-item-content')
      return { kind: 'draft-issue', title: content.title }
    default:
      return { kind: 'other', typeName: content.__typename }
  }
}

function issueContent(content: z.infer<typeof contentSchema>): z.infer<typeof issueNodeSchema> {
  return issueNodeSchema.parse(content)
}

function issueFact(issue: z.infer<typeof issueNodeSchema>): GitHubIssueFact {
  return {
    id: githubIssueId(issue.id),
    repositoryId: githubRepositoryId(issue.repository.id),
    repositoryDatabaseId: githubRepositoryDatabaseId(issue.repository.databaseId),
    number: issue.number,
    state: issue.state.toLowerCase() as 'open' | 'closed',
    title: issue.title,
    url: issue.url,
    updatedAt: timestamp(issue.updatedAt),
  }
}

function repositoryFact(node: z.infer<typeof repositoryNodeSchema>, observedAt: number): GitHubRepositoryFact {
  return {
    id: githubRepositoryId(node.id),
    databaseId: githubRepositoryDatabaseId(node.databaseId),
    ownerAccountId: githubAccountId(node.owner.id),
    nameWithOwner: node.nameWithOwner,
    visibility: node.visibility.toLowerCase() as 'public' | 'private' | 'internal',
    url: node.url,
    updatedAt: timestamp(node.updatedAt),
    observedAt,
  }
}

function projectFact(node: z.infer<typeof projectNodeSchema>, observedAt: number): GitHubProjectFact {
  return {
    id: githubProjectId(node.id),
    ownerAccountId: githubAccountId(node.owner.id),
    number: node.number,
    title: node.title,
    closed: node.closed,
    url: node.url,
    updatedAt: timestamp(node.updatedAt),
    observedAt,
  }
}

function observeRate(state: ScanState, rate: z.infer<typeof rateSchema>): void {
  const observation: GitHubGraphqlRateObservation = {
    kind: 'graphql',
    cost: rate.cost,
    limit: rate.limit,
    used: rate.used,
    remaining: rate.remaining,
    resetAt: timestamp(rate.resetAt),
    observedAt: Date.now(),
  }
  appendGitHubRateObservation(state.rates, observation)
  if (state.request.priority === 'background' && rate.remaining <= state.request.rateLimitReserve) {
    throw new GitHubProviderError({ code: 'primary-rate-limit', resetAt: observation.resetAt })
  }
}

function nextCursor(
  pageInfo: z.infer<typeof pageInfoSchema>,
  seen: Set<string>,
  operation: string,
): string | null {
  if (!pageInfo.hasNextPage) return null
  if (pageInfo.endCursor === null || seen.has(pageInfo.endCursor)) invalid(operation)
  seen.add(pageInfo.endCursor)
  return pageInfo.endCursor
}

function sameFence(left: GitHubProjectBoardUpdateFence, right: GitHubProjectBoardUpdateFence): boolean {
  return left.projectUpdatedAt === right.projectUpdatedAt
    && left.repositoryUpdatedAt === right.repositoryUpdatedAt
    && left.projectItemCount === right.projectItemCount
    && left.openIssueCount === right.openIssueCount
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('timestamp')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}
