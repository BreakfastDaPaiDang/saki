/** Exact-marker Pull Request creation inspection. @module @breakfastdapaidang/saki-github-app/pull-request-create-inspection */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubAccountId,
  githubCommitId,
  githubPullRequestCreateInspectionSchema,
  githubPullRequestFactSchema,
  githubPullRequestId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubPullRequestCreateInspection,
  GitHubPullRequestCreateInspectionOutcome,
  GitHubPullRequestCreateRequest,
  GitHubPullRequestFact,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { queryGraphql } from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'
import { parseNextLinkTarget } from './rest-link.ts'

const REPOSITORY_QUERY = `
query SakiPullRequestCreateRepository($repositoryId: ID!) {
  repository: node(id: $repositoryId) {
    __typename
    ... on Repository { id databaseId: fullDatabaseId nameWithOwner owner { id } }
  }
}`
const repositoryDataSchema = z.object({ repository: z.object({
  __typename: z.literal('Repository'), id: z.string().min(1),
  databaseId: z.union([z.string(), z.number().int().positive()]),
  nameWithOwner: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u).max(201),
  owner: z.object({ id: z.string().min(1) }).loose(),
}).loose().nullable() }).loose()
const pullSchema = z.object({
  id: z.number().int().positive(), node_id: z.string().min(1), number: z.number().int().positive(),
  state: z.enum(['open', 'closed']), title: z.string(), body: z.string().nullable(), html_url: z.url(),
  draft: z.boolean().nullable(), merged_at: z.iso.datetime().nullable(), updated_at: z.iso.datetime(),
  user: z.object({ node_id: z.string().min(1) }).loose().nullable(),
  head: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ node_id: z.string().min(1) }).loose() }).loose(),
  base: z.object({ ref: z.string(), sha: z.string(), repo: z.object({ node_id: z.string().min(1) }).loose() }).loose(),
}).loose()

interface Coordinates { readonly owner: string; readonly repo: string }
interface Traversal {
  readonly markerMatches: readonly GitHubPullRequestFact[]
  readonly hintObservation: 'marker-removed' | 'identity-conflict' | undefined
  readonly markerOccurrences: number
  readonly completed: boolean
}

/**
 * Inspect one Pull Request creation through a complete bounded marker traversal.
 * @param request - immutable marker-bound Pull Request creation request and optional known identity.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated traversal and HTTP bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns durable-safe marker and identity classification.
 */
export async function inspectPullRequestCreate(request: GitHubPullRequestCreateRequest, privateKey: string,
  config: ResolvedConfig, signal: AbortSignal, queue: InstallationPriorityQueue): Promise<GitHubPullRequestCreateInspection> {
  const session = await GitHubOperationSession.create(request.installation, privateKey, request.repositoryDatabaseId,
    config, signal, queue, 'interactive', 'pull-request-create-inspection')
  const repository = await coordinates(request, session, signal)
  const traversal = await traverse(request, session, repository, config, signal)
  return githubPullRequestCreateInspectionSchema.parse({
    snapshot: { repositoryId: request.repositoryId, repositoryDatabaseId: request.repositoryDatabaseId,
      outcome: classify(request, traversal) }, observedAt: Date.now(),
  })
}

async function coordinates(request: GitHubPullRequestCreateRequest, session: GitHubOperationSession,
  signal: AbortSignal): Promise<Coordinates> {
  const data = repositoryDataSchema.parse(await queryGraphql(session.installation, REPOSITORY_QUERY,
    { repositoryId: request.repositoryId }, signal, 'pull-request-create-repository'))
  if (data.repository === null) throw new GitHubProviderError({ code: 'not-found', resource: 'Repository' })
  if (data.repository.id !== request.repositoryId || String(data.repository.databaseId) !== request.repositoryDatabaseId
    || data.repository.owner.id !== request.installation.accountId) invalid('pull-request-create-repository')
  const separator = data.repository.nameWithOwner.indexOf('/')
  return { owner: data.repository.nameWithOwner.slice(0, separator), repo: data.repository.nameWithOwner.slice(separator + 1) }
}

async function traverse(request: GitHubPullRequestCreateRequest, session: GitHubOperationSession,
  repository: Coordinates, config: ResolvedConfig, signal: AbortSignal): Promise<Traversal> {
  const ids = new Set<number>()
  const nodeIds = new Set<string>()
  const numbers = new Set<number>()
  const markerMatches: GitHubPullRequestFact[] = []
  let markerOccurrences = 0
  let hintObservation: Traversal['hintObservation']
  for (let page = 1; ; page += 1) {
    const response = await session.installation.request('GET /repos/{owner}/{repo}/pulls', {
      owner: repository.owner, repo: repository.repo, state: 'all',
      head: `${repository.owner}:${request.headRef}`, base: request.baseRef,
      sort: 'created', direction: 'asc', per_page: config.pageSize, page,
      headers: { accept: 'application/vnd.github.raw+json' }, request: { signal },
    })
    const entries = z.array(pullSchema).parse(response.data)
    for (const entry of entries) {
      if (ids.size >= config.maxItems || ids.has(entry.id) || nodeIds.has(entry.node_id) || numbers.has(entry.number)) {
        return { markerMatches, hintObservation, markerOccurrences, completed: false }
      }
      ids.add(entry.id); nodeIds.add(entry.node_id); numbers.add(entry.number)
      const fact = pullFact(request, entry)
      const occurrences = count(entry.body ?? '', `<!-- saki-pull-request:${request.markerId} -->`)
      if (occurrences > 0) markerMatches.push(fact)
      markerOccurrences += occurrences
      const hint = request.inspectionHint
      if (hint !== undefined) {
        const sameId = fact.id === hint.pullRequestId
        const sameNumber = fact.number === hint.pullRequestNumber
        if (sameId && sameNumber && occurrences === 0) {
          hintObservation = matchesRequest(request, fact) ? 'marker-removed' : 'identity-conflict'
        }
        else if ((sameId || sameNumber) && !(sameId && sameNumber)) hintObservation = 'identity-conflict'
      }
    }
    const next = nextPage(response.headers.link, page, config.pageSize, repository)
    if (next === 'invalid' || (next !== null && page >= config.maxPages)) {
      return { markerMatches, hintObservation, markerOccurrences, completed: false }
    }
    if (next === null) return { markerMatches, hintObservation, markerOccurrences, completed: true }
  }
}

function pullFact(request: GitHubPullRequestCreateRequest, entry: z.infer<typeof pullSchema>): GitHubPullRequestFact {
  return githubPullRequestFactSchema.parse({ id: githubPullRequestId(entry.node_id), repositoryId: request.repositoryId,
    number: entry.number, state: entry.state, merged: entry.merged_at !== null, draft: entry.draft ?? false,
    title: entry.title, url: entry.html_url,
    head: { repositoryId: entry.head.repo.node_id, ref: entry.head.ref, commitId: githubCommitId(entry.head.sha) },
    base: { repositoryId: entry.base.repo.node_id, ref: entry.base.ref, commitId: githubCommitId(entry.base.sha) },
    ...(entry.user === null ? {} : { authorAccountId: githubAccountId(entry.user.node_id) }),
    updatedAt: time(entry.updated_at), observedAt: Date.now() })
}

function classify(request: GitHubPullRequestCreateRequest, traversal: Traversal): GitHubPullRequestCreateInspectionOutcome {
  if (!traversal.completed) return { state: 'incomplete' }
  if (traversal.markerOccurrences > 1 || traversal.markerMatches.length > 1) return { state: 'multiple-matches' }
  const match = traversal.markerMatches[0]
  if (match !== undefined) {
    const hint = request.inspectionHint
    if (!matchesRequest(request, match)
      || (hint !== undefined && (match.id !== hint.pullRequestId || match.number !== hint.pullRequestNumber))) {
      return { state: 'identity-conflict' }
    }
    return { state: 'unique-pull-request', pullRequest: match }
  }
  if (request.inspectionHint === undefined) return { state: 'absent-complete' }
  return traversal.hintObservation === undefined ? { state: 'known-pull-request-absent' }
    : { state: traversal.hintObservation }
}

function matchesRequest(request: GitHubPullRequestCreateRequest, pullRequest: GitHubPullRequestFact): boolean {
  return pullRequest.head.repositoryId === request.repositoryId
    && pullRequest.head.ref === request.headRef
    && pullRequest.head.commitId === request.expectedHeadCommitId
    && pullRequest.base.repositoryId === request.repositoryId
    && pullRequest.base.ref === request.baseRef
}

function count(value: string, marker: string): number {
  let result = 0
  for (let offset = 0; ; ) {
    const found = value.indexOf(marker, offset)
    if (found < 0) return result
    result += 1
    offset = found + marker.length
  }
}

function nextPage(link: string | undefined, current: number, pageSize: number,
  repository: Coordinates): number | null | 'invalid' {
  const nextTarget = parseNextLinkTarget(link)
  if (nextTarget === null || nextTarget === 'invalid') return nextTarget
  let target: URL
  try { target = new URL(nextTarget) } catch { return 'invalid' }
  if (target.protocol !== 'https:' || target.hostname !== 'api.github.com'
    || target.username !== '' || target.password !== '' || target.hash !== ''
    || target.pathname !== `/repos/${repository.owner}/${repository.repo}/pulls`
    || target.searchParams.getAll('page').length !== 1
    || target.searchParams.getAll('per_page').length !== 1
    || target.searchParams.get('page') !== String(current + 1)
    || target.searchParams.get('per_page') !== String(pageSize)) return 'invalid'
  return current + 1
}

function time(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('pull-request-create-inspection')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}
