/** Exact-marker Issue-create mutation inspection. @module @breakfastdapaidang/saki-github-app/issue-create-inspection */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubIssueCreateInspectionSchema,
  githubIssueId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueCreateInspection,
  GitHubIssueCreateInspectionOutcome,
  GitHubIssueCreateRequest,
  GitHubIssueCreateSnapshot,
  GitHubIssueFact,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { queryGraphql } from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'
import { parseNextLinkTarget } from './rest-link.ts'

const REPOSITORY_QUERY = `
query SakiIssueCreateRepository($repositoryId: ID!) {
  repository: node(id: $repositoryId) {
    __typename
    ... on Repository { id databaseId nameWithOwner owner { id } }
  }
}`

const repositoryDataSchema = z.object({
  repository: z.object({
    __typename: z.literal('Repository'),
    id: z.string().min(1),
    databaseId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(201),
    owner: z.object({ id: z.string().min(1) }).loose(),
  }).loose().nullable(),
}).loose()

const restIssueEntrySchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node_id: z.string().min(1).max(1_024).regex(/^[^\u0000-\u001f\u007f]+$/u),
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['open', 'closed']),
  title: z.string().min(1).max(4_096).regex(/^[^\u0000\u007f]*$/u)
    .refine(value => value.isWellFormed()),
  body: z.string().refine(value => value.isWellFormed()).nullable(),
  html_url: z.url(),
  updated_at: z.iso.datetime(),
  pull_request: z.object({}).loose().optional(),
}).loose()

const restIssuePageSchema = z.array(restIssueEntrySchema)

interface RepositoryCoordinates {
  readonly owner: string
  readonly repo: string
}

interface InspectionState {
  readonly request: GitHubIssueCreateRequest
  readonly session: GitHubOperationSession
  readonly config: ResolvedConfig
  readonly signal: AbortSignal
  readonly repository: RepositoryCoordinates
}

type IssueCreateMarkerMatch =
  | { readonly kind: 'issue'; readonly issue: GitHubIssueFact }
  | { readonly kind: 'pull-request' }

type IssueCreateHintObservation = 'marker-removed' | 'identity-conflict'

interface Traversal {
  readonly firstMarkerMatch: IssueCreateMarkerMatch | undefined
  readonly hintObservation: IssueCreateHintObservation | undefined
  readonly markerOccurrences: number
  readonly completed: boolean
}

/**
 * Inspect one Issue-create marker through one bounded REST Issues traversal.
 * @param request - immutable Issue-create request and optional reconciliation hint.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated pagination and HTTP limits.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns durable-safe marker classification.
 */
export async function inspectIssueCreate(
  request: GitHubIssueCreateRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubIssueCreateInspection> {
  const session = await GitHubOperationSession.create(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
    'issue-create-inspection',
  )
  const repository = await readRepositoryCoordinates(request, session, signal)
  const state: InspectionState = { request, session, config, signal, repository }
  const traversal = await readIssues(state)
  const outcome = classifyOutcome(request, traversal)
  const snapshot: GitHubIssueCreateSnapshot = {
    repositoryId: request.repositoryId,
    repositoryDatabaseId: request.repositoryDatabaseId,
    outcome,
  }
  return githubIssueCreateInspectionSchema.parse({
    snapshot,
    observedAt: Date.now(),
  })
}

async function readRepositoryCoordinates(
  request: GitHubIssueCreateRequest,
  session: GitHubOperationSession,
  signal: AbortSignal,
): Promise<RepositoryCoordinates> {
  const data = repositoryDataSchema.parse(await queryGraphql(
    session.installation,
    REPOSITORY_QUERY,
    { repositoryId: request.repositoryId },
    signal,
    'issue-create-repository',
  ))
  if (data.repository === null) {
    throw new GitHubProviderError({ code: 'not-found', resource: 'Repository' })
  }
  if (data.repository.id !== request.repositoryId
    || String(data.repository.databaseId) !== request.repositoryDatabaseId
    || data.repository.owner.id !== request.installation.accountId) {
    invalid('issue-create-repository')
  }
  const separator = data.repository.nameWithOwner.indexOf('/')
  return {
    owner: data.repository.nameWithOwner.slice(0, separator),
    repo: data.repository.nameWithOwner.slice(separator + 1),
  }
}

async function readIssues(state: InspectionState): Promise<Traversal> {
  const numericIds = new Set<number>()
  const nodeIds = new Set<string>()
  const numbers = new Set<number>()
  let firstMarkerMatch: IssueCreateMarkerMatch | undefined
  let hintObservation: IssueCreateHintObservation | undefined
  let markerOccurrences = 0
  for (let page = 1; ; page += 1) {
    const response = await state.session.installation.request('GET /repos/{owner}/{repo}/issues', {
      owner: state.repository.owner,
      repo: state.repository.repo,
      state: 'all',
      sort: 'created',
      direction: 'asc',
      per_page: state.config.pageSize,
      page,
      headers: { accept: 'application/vnd.github.raw+json' },
      request: { signal: state.signal },
    })
    const pageEntries = restIssuePageSchema.parse(response.data)
    for (const entry of pageEntries) {
      if (numericIds.size >= state.config.maxItems) {
        return finishTraversal(false)
      }
      if (numericIds.has(entry.id) || nodeIds.has(entry.node_id) || numbers.has(entry.number)) {
        return finishTraversal(false)
      }
      numericIds.add(entry.id)
      nodeIds.add(entry.node_id)
      numbers.add(entry.number)
      const updatedAt = timestamp(entry.updated_at)
      const occurrences = countOccurrences(
        entry.body ?? '',
        `<!-- saki-work-item:${state.request.markerId} -->`,
      )
      if (occurrences > 0) {
        firstMarkerMatch ??= markerMatch(state.request, entry, updatedAt)
        markerOccurrences += occurrences
      }
      const hint = state.request.inspectionHint
      if (hint !== undefined) {
        const sameId = entry.node_id === hint.issueId
        const sameNumber = entry.number === hint.issueNumber
        if (sameId && sameNumber && entry.pull_request === undefined) {
          hintObservation = 'marker-removed'
        } else if ((sameId || sameNumber) && hintObservation === undefined) {
          hintObservation = 'identity-conflict'
        }
      }
    }
    const nextPage = parseNextPage(
      response.headers.link,
      page,
      state.config.pageSize,
      state.repository,
      state.request.repositoryDatabaseId,
    )
    if (nextPage === 'invalid') return finishTraversal(false)
    if (nextPage === null) return finishTraversal()
    if (page >= state.config.maxPages) return finishTraversal(false)
  }

  function finishTraversal(
    completed = true,
  ): Traversal {
    return {
      firstMarkerMatch,
      hintObservation,
      markerOccurrences,
      completed,
    }
  }
}

function markerMatch(
  request: GitHubIssueCreateRequest,
  entry: z.infer<typeof restIssueEntrySchema>,
  updatedAt: number,
): IssueCreateMarkerMatch {
  const repositoryId = githubRepositoryId(request.repositoryId)
  const repositoryDatabaseId = githubRepositoryDatabaseId(request.repositoryDatabaseId)
  return entry.pull_request === undefined
    ? {
      kind: 'issue',
      issue: {
        id: githubIssueId(entry.node_id),
        repositoryId,
        repositoryDatabaseId,
        number: entry.number,
        state: entry.state,
        title: entry.title,
        url: entry.html_url,
        updatedAt,
      },
    }
    : { kind: 'pull-request' }
}

function classifyOutcome(
  request: GitHubIssueCreateRequest,
  traversal: Traversal,
): GitHubIssueCreateInspectionOutcome {
  if (!traversal.completed) {
    return { state: 'incomplete' }
  }
  if (traversal.markerOccurrences >= 2) {
    return { state: 'multiple-matches' }
  }
  const markerMatch = traversal.firstMarkerMatch
  if (markerMatch !== undefined) {
    if (markerMatch.kind === 'pull-request') {
      return { state: 'pull-request-marker-match' }
    }
    const hint = request.inspectionHint
    if (hint !== undefined
      && (markerMatch.issue.id !== hint.issueId || markerMatch.issue.number !== hint.issueNumber)) {
      return { state: 'identity-conflict' }
    }
    return { state: 'unique-issue', issue: markerMatch.issue }
  }
  const hint = request.inspectionHint
  if (hint === undefined) return { state: 'absent-complete' }
  return traversal.hintObservation === undefined
    ? { state: 'known-issue-absent' }
    : { state: traversal.hintObservation }
}

function countOccurrences(value: string, marker: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const found = value.indexOf(marker, offset)
    if (found < 0) return count
    count += 1
    offset = found + marker.length
  }
}

function parseNextPage(
  link: string | undefined,
  currentPage: number,
  pageSize: number,
  repository: RepositoryCoordinates,
  repositoryDatabaseId: string,
): number | null | 'invalid' {
  const nextTarget = parseNextLinkTarget(link)
  if (nextTarget === null || nextTarget === 'invalid') return nextTarget
  let target: URL
  try {
    target = new URL(nextTarget)
  } catch {
    return 'invalid'
  }
  const namedPath = `/repos/${repository.owner}/${repository.repo}/issues`
  const databasePath = `/repositories/${repositoryDatabaseId}/issues`
  if (target.protocol !== 'https:'
    || target.hostname !== 'api.github.com'
    || target.username !== ''
    || target.password !== ''
    || target.hash !== ''
    || (target.pathname !== namedPath && target.pathname !== databasePath)
    || target.searchParams.getAll('page').length !== 1
    || target.searchParams.getAll('per_page').length !== 1
    || target.searchParams.get('page') !== String(currentPage + 1)
    || target.searchParams.get('per_page') !== String(pageSize)
    || !sameOptionalFilter(target.searchParams, 'state', 'all')
    || !sameOptionalFilter(target.searchParams, 'sort', 'created')
    || !sameOptionalFilter(target.searchParams, 'direction', 'asc')) {
    return 'invalid'
  }
  return currentPage + 1
}

function sameOptionalFilter(parameters: URLSearchParams, name: string, expected: string): boolean {
  const values = parameters.getAll(name)
  return values.length === 0 || (values.length === 1 && values[0] === expected)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('issue-create-inspection')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}
