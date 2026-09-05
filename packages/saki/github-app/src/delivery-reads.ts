/** Targeted Product App delivery reads. @module @breakfastdapaidang/saki-github-app/delivery-reads */

import { z } from 'zod'
import {
  githubAccountId,
  githubCheckRunId,
  githubBranchHeadFactSchema,
  githubCommitCiFactSchema,
  githubCommitId,
  githubCommitStatusId,
  githubIssueFactSchema,
  githubMilestoneFactSchema,
  githubPullRequestAssociationFactSchema,
  githubPullRequestFactSchema,
  githubPullRequestId,
  githubPullRequestReviewId,
  githubPullRequestReviewsFactSchema,
  githubWorkflowRunId,
  githubWorkflowId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubCommitCiFact,
  GitHubBranchHeadFact,
  GitHubBranchHeadReadRequest,
  GitHubCommitCiReadRequest,
  GitHubIssueFact,
  GitHubMilestoneFact,
  GitHubMilestoneReadRequest,
  GitHubPullRequestAssociationFact,
  GitHubPullRequestAssociationReadRequest,
  GitHubPullRequestFact,
  GitHubPullRequestReadRequest,
  GitHubPullRequestReviewFact,
  GitHubPullRequestReviewsFact,
  GitHubPullRequestReviewsReadRequest,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { queryGraphql } from './graphql.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'
import { parseNextLinkTarget } from './rest-link.ts'
import {
  createSession,
  httpStatus,
  invalid,
  notFound,
  repositoryCoordinates,
  repositoryFromSession,
  timestamp,
} from './reads.ts'

const rateLimitSchema = z.object({
  cost: z.number().int().nonnegative(), limit: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(), resetAt: z.iso.datetime(),
}).loose()
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable() }).loose()
const repositoryIdentitySchema = z.object({
  id: z.string().min(1), databaseId: z.union([z.string(), z.number().int().positive()]),
}).loose()
const pullRequestNodeSchema = z.object({
  __typename: z.literal('PullRequest'), id: z.string().min(1),
  number: z.number().int().positive(), state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  merged: z.boolean(), isDraft: z.boolean(),
  title: z.string(), url: z.url(), headRefName: z.string(), headRefOid: z.string(),
  baseRefName: z.string(), baseRefOid: z.string(),
  headRepository: z.object({ id: z.string().min(1) }).loose(),
  baseRepository: z.object({ id: z.string().min(1) }).loose(),
  repository: z.object({
    id: z.string().min(1), owner: z.object({ id: z.string().min(1) }).loose(),
  }).loose(),
  author: z.object({ id: z.string().min(1) }).loose().nullable(), updatedAt: z.iso.datetime(),
}).loose()
const exactPullRequestDataSchema = z.object({ node: pullRequestNodeSchema.nullable(), rateLimit: rateLimitSchema }).loose()
const pullRequestReviewNodeSchema = z.object({
  id: z.string().min(1), state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING']),
  url: z.url(), submittedAt: z.iso.datetime().nullable(), updatedAt: z.iso.datetime(),
  author: z.object({ id: z.string().min(1) }).loose().nullable(),
  commit: z.object({ oid: z.string().min(1) }).loose().nullable(),
}).loose()
const reviewPullRequestNodeSchema = z.object({
  __typename: z.literal('PullRequest'), id: z.string().min(1), number: z.number().int().positive(),
  headRefOid: z.string().min(1), updatedAt: z.iso.datetime(),
  repository: z.object({
    id: z.string().min(1), owner: z.object({ id: z.string().min(1) }).loose(),
  }).loose(),
  reviews: z.object({
    totalCount: z.number().int().nonnegative(), nodes: z.array(pullRequestReviewNodeSchema), pageInfo: pageInfoSchema,
  }).loose(),
}).loose()
const pullRequestReviewsDataSchema = z.object({
  node: reviewPullRequestNodeSchema.nullable(), rateLimit: rateLimitSchema,
}).loose()
const associationDataSchema = z.object({
  node: repositoryIdentitySchema.extend({
    __typename: z.literal('Repository'),
    owner: z.object({ id: z.string().min(1) }).loose(),
    pullRequests: z.object({
      totalCount: z.number().int().nonnegative(), nodes: z.array(pullRequestNodeSchema), pageInfo: pageInfoSchema,
    }).loose(),
  }).loose().nullable(),
  rateLimit: rateLimitSchema,
}).loose()
const issueNodeSchema = z.object({
  __typename: z.literal('Issue'), id: z.string().min(1), number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED']), title: z.string(), url: z.url(), updatedAt: z.iso.datetime(),
  repository: repositoryIdentitySchema,
}).loose()
const milestoneNodeSchema = z.object({
  __typename: z.literal('Milestone'), id: z.string().min(1), number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED']), title: z.string(), description: z.string().nullable(),
  dueOn: z.iso.datetime().nullable(), url: z.url(), updatedAt: z.iso.datetime(),
  repository: repositoryIdentitySchema.extend({ owner: z.object({ id: z.string().min(1) }).loose() }),
  issues: z.object({
    totalCount: z.number().int().nonnegative(), nodes: z.array(issueNodeSchema), pageInfo: pageInfoSchema,
  }).loose(),
}).loose()
const milestoneDataSchema = z.object({ node: milestoneNodeSchema.nullable(), rateLimit: rateLimitSchema }).loose()

const workflowRunSchema = z.object({
  id: z.number().int().positive(), workflow_id: z.number().int().positive(), name: z.string(), event: z.string(),
  run_number: z.number().int().positive(), run_attempt: z.number().int().positive(),
  status: z.string(), conclusion: z.string().nullable(), html_url: z.url(), created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(), head_sha: z.string(),
}).loose()
const workflowPageSchema = z.object({ total_count: z.number().int().nonnegative(), workflow_runs: z.array(workflowRunSchema) }).loose()
const checkRunSchema = z.object({
  id: z.number().int().positive(), name: z.string(), status: z.string(), conclusion: z.string().nullable(),
  html_url: z.url(), started_at: z.iso.datetime().nullable(), completed_at: z.iso.datetime().nullable(), head_sha: z.string(),
}).loose()
const checkPageSchema = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkRunSchema) }).loose()
const commitStatusSchema = z.object({
  id: z.number().int().positive(), context: z.string(), state: z.enum(['error', 'failure', 'pending', 'success']),
  target_url: z.url().nullable(), created_at: z.iso.datetime(), updated_at: z.iso.datetime(), sha: z.string(),
}).loose()
const combinedStatusSchema = z.object({
  total_count: z.number().int().nonnegative(), sha: z.string(), statuses: z.array(commitStatusSchema),
}).loose()
const branchReferenceSchema = z.object({
  ref: z.string(), object: z.object({ type: z.literal('commit'), sha: z.string() }).loose(),
}).loose()
const REVIEW_STATES = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'commented',
  DISMISSED: 'dismissed',
  PENDING: 'pending',
} as const satisfies Record<z.infer<typeof pullRequestReviewNodeSchema>['state'], GitHubPullRequestReviewFact['state']>

const PULL_REQUEST_QUERY = `
query SakiPullRequest($pullRequestId: ID!) {
  node(id: $pullRequestId) {
    __typename
    ... on PullRequest {
      id number state merged isDraft title url updatedAt headRefName headRefOid baseRefName baseRefOid
      headRepository { id } baseRepository { id } repository { id owner { id } } author { id }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const PULL_REQUEST_REVIEWS_QUERY = `
query SakiPullRequestReviews($pullRequestId: ID!, $first: Int!, $after: String) {
  node(id: $pullRequestId) {
    __typename
    ... on PullRequest {
      id number headRefOid updatedAt repository { id owner { id } }
      reviews(first: $first, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id state url submittedAt updatedAt author { id } commit { oid } }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const ASSOCIATION_QUERY = `
query SakiPullRequestAssociation($repositoryId: ID!, $headRef: String!, $baseRef: String!, $first: Int!, $after: String) {
  node(id: $repositoryId) {
    __typename
    ... on Repository {
      id databaseId: fullDatabaseId owner { id }
      pullRequests(headRefName: $headRef, baseRefName: $baseRef, states: [OPEN], first: $first, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes {
          id number state merged isDraft title url updatedAt headRefName headRefOid baseRefName baseRefOid
          headRepository { id } baseRepository { id } repository { id owner { id } } author { id }
        }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const MILESTONE_QUERY = `
query SakiMilestone($milestoneId: ID!, $first: Int!, $after: String) {
  node(id: $milestoneId) {
    __typename
    ... on Milestone {
      id number state title description dueOn url updatedAt repository { id databaseId: fullDatabaseId owner { id } }
      issues(first: $first, after: $after) {
        totalCount pageInfo { hasNextPage endCursor }
        nodes { id number state title url updatedAt repository { id databaseId: fullDatabaseId } }
      }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

/**
 * Read the exact remote Commit at one branch, or prove the branch absent.
 * @param request - exact Repository and branch identity.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns exact branch-head Commit or explicit absence.
 */
export async function readBranchHead(
  request: GitHubBranchHeadReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubBranchHeadFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  try {
    const response = await session.installation.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
      owner, repo, ref: `heads/${request.branch}`, request: { signal },
    })
    const reference = branchReferenceSchema.parse(response.data)
    if (reference.ref !== `refs/heads/${request.branch}`) invalid(request.kind)
    return githubBranchHeadFactSchema.parse({ state: 'present', repositoryId: request.repositoryId,
      branch: request.branch, commitId: githubCommitId(reference.object.sha), observedAt: Date.now() })
  } catch (error) {
    if (httpStatus(error) === 404) return githubBranchHeadFactSchema.parse({
      state: 'absent', repositoryId: request.repositoryId, branch: request.branch, observedAt: Date.now(),
    })
    throw error
  }
}

/**
 * Read one exact Pull Request.
 * @param request - exact Repository, Pull Request node id, and number.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns repository-bound Pull Request fact.
 */
export async function readPullRequest(
  request: GitHubPullRequestReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubPullRequestFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const data = exactPullRequestDataSchema.parse(await queryGraphql(
    session.installation,
    PULL_REQUEST_QUERY,
    { pullRequestId: request.pullRequestId },
    signal,
    request.kind,
  ))
  if (data.node === null) notFound(request.kind)
  const fact = pullRequestFact(data.node, Date.now())
  if (fact.id !== request.pullRequestId
    || fact.number !== request.pullRequestNumber
    || fact.repositoryId !== request.repositoryId
    || data.node.repository.owner.id !== request.installation.accountId) invalid('pull-request-identity')
  return fact
}

/**
 * Read every review for one exact Pull Request through a stable paginated identity.
 * @param request - exact Repository and Pull Request identity.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns complete bounded raw review facts without acceptance authority.
 */
export async function readPullRequestReviews(
  request: GitHubPullRequestReviewsReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubPullRequestReviewsFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const reviews: GitHubPullRequestReviewFact[] = []
  const reviewIds = new Set<string>()
  let target: z.infer<typeof reviewPullRequestNodeSchema> | undefined
  let totalCount: number | undefined
  let after: string | null = null
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    const data = pullRequestReviewsDataSchema.parse(await queryGraphql(
      session.installation,
      PULL_REQUEST_REVIEWS_QUERY,
      { pullRequestId: request.pullRequestId, first: config.pageSize, after },
      signal,
      request.kind,
    ))
    if (data.node === null) notFound(request.kind)
    if (data.node.id !== request.pullRequestId
      || data.node.number !== request.pullRequestNumber
      || data.node.repository.id !== request.repositoryId
      || data.node.repository.owner.id !== request.installation.accountId) invalid(request.kind)
    target ??= data.node
    if (!sameReviewPullRequest(target, data.node)) invalid(request.kind)
    totalCount ??= data.node.reviews.totalCount
    if (data.node.reviews.totalCount !== totalCount
      || totalCount > config.maxItems
      || data.node.reviews.nodes.length > config.pageSize) invalid(request.kind)
    for (const node of data.node.reviews.nodes) {
      if (reviews.length >= config.maxItems || reviewIds.has(node.id)) invalid(request.kind)
      reviewIds.add(node.id)
      reviews.push({
        id: githubPullRequestReviewId(node.id),
        ...(node.author === null ? {} : { authorAccountId: githubAccountId(node.author.id) }),
        state: REVIEW_STATES[node.state],
        ...(node.commit === null ? {} : { commitId: githubCommitId(node.commit.oid) }),
        url: node.url,
        ...(node.submittedAt === null ? {} : { submittedAt: timestamp(node.submittedAt) }),
        updatedAt: timestamp(node.updatedAt),
      })
    }
    after = nextCursor(data.node.reviews.pageInfo, page, config.maxPages, request.kind, cursors)
    if (after === null) break
  }
  if (reviews.length !== totalCount) invalid(request.kind)
  return githubPullRequestReviewsFactSchema.parse({
    repositoryId: request.repositoryId,
    pullRequestId: request.pullRequestId,
    pullRequestNumber: request.pullRequestNumber,
    headCommitId: githubCommitId(target.headRefOid),
    pullRequestUpdatedAt: timestamp(target.updatedAt),
    reviews,
    observedAt: Date.now(),
  })
}

/**
 * Read every open Pull Request matching one exact head/base association.
 * @param request - exact Repository and same-Repository branch pair.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns complete absent, unique, or duplicate association fact.
 */
export async function readPullRequestAssociation(
  request: GitHubPullRequestAssociationReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubPullRequestAssociationFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const facts: GitHubPullRequestFact[] = []
  let after: string | null = null
  let totalCount: number | undefined
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    const data = associationDataSchema.parse(await queryGraphql(session.installation, ASSOCIATION_QUERY, {
      repositoryId: request.repositoryId, headRef: request.headRef, baseRef: request.baseRef,
      first: config.pageSize, after,
    }, signal, request.kind))
    if (data.node === null) notFound('Repository')
    assertRepository(data.node, request.repositoryId, request.repositoryDatabaseId, request.kind)
    if (data.node.owner.id !== request.installation.accountId) invalid(request.kind)
    const connection = data.node.pullRequests
    totalCount ??= connection.totalCount
    if (connection.totalCount !== totalCount || connection.nodes.length > config.pageSize) invalid(request.kind)
    for (const node of connection.nodes) {
      if (facts.length >= config.maxItems) invalid(request.kind)
      const fact = pullRequestFact(node, Date.now())
      if (fact.repositoryId !== request.repositoryId
        || fact.head.repositoryId !== request.repositoryId
        || fact.head.ref !== request.headRef
        || fact.head.commitId !== request.expectedHeadCommitId
        || fact.base.ref !== request.baseRef) invalid(request.kind)
      facts.push(fact)
    }
    after = nextCursor(connection.pageInfo, page, config.maxPages, request.kind, cursors)
    if (after === null) break
  }
  if (facts.length !== totalCount) invalid(request.kind)
  const observedAt = Date.now()
  return githubPullRequestAssociationFactSchema.parse(facts.length === 0
    ? { state: 'absent', repositoryId: request.repositoryId, headRef: request.headRef, baseRef: request.baseRef, expectedHeadCommitId: request.expectedHeadCommitId, observedAt }
    : facts.length === 1
      ? { state: 'unique', pullRequest: facts[0], observedAt }
      : { state: 'duplicate-conflict', pullRequests: facts, observedAt })
}

/**
 * Read raw GitHub Actions, check-run, and commit-status facts for one exact Commit.
 * @param request - exact Repository and Commit identity.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns complete source-preserving CI facts without a product verdict.
 */
export async function readCommitCi(
  request: GitHubCommitCiReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubCommitCiFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  const workflowRuns: Array<Record<string, unknown>> = []
  const checkRuns: Array<Record<string, unknown>> = []
  const commitStatuses: Array<Record<string, unknown>> = []
  let workflowTotal: number | undefined
  for (let page = 1; ; page += 1) {
    const response = await session.installation.request('GET /repos/{owner}/{repo}/actions/runs', {
      owner, repo, head_sha: request.commitId, per_page: config.pageSize, page, request: { signal },
    })
    const data = workflowPageSchema.parse(response.data)
    workflowTotal ??= data.total_count
    if (data.total_count !== workflowTotal || data.total_count > Math.min(config.maxItems, 1_000)
      || data.workflow_runs.length > config.pageSize) invalid(request.kind)
    for (const run of data.workflow_runs) {
      if (run.head_sha !== request.commitId || workflowRuns.length >= config.maxItems) invalid(request.kind)
      workflowRuns.push({ id: githubWorkflowRunId(String(run.id)), workflowId: githubWorkflowId(String(run.workflow_id)),
        name: run.name, event: run.event, runNumber: run.run_number,
        runAttempt: run.run_attempt,
        status: normalize(run.status),
        ...(run.conclusion === null ? {} : { conclusion: normalize(run.conclusion) }),
        url: run.html_url, createdAt: timestamp(run.created_at), updatedAt: timestamp(run.updated_at) })
    }
    const next = nextRestPage(response.headers.link, page, config.pageSize,
      `/repos/${owner}/${repo}/actions/runs`)
    if (next === 'invalid' || (next && page >= config.maxPages)) invalid(request.kind)
    if (!next) break
  }
  if (workflowRuns.length !== workflowTotal) invalid(request.kind)
  let checkTotal: number | undefined
  for (let page = 1; ; page += 1) {
    const response = await session.installation.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
      owner, repo, ref: request.commitId, per_page: config.pageSize, page,
      filter: 'latest', headers: { accept: 'application/vnd.github+json' }, request: { signal },
    })
    const data = checkPageSchema.parse(response.data)
    checkTotal ??= data.total_count
    if (data.total_count !== checkTotal || data.total_count > Math.min(config.maxItems, 1_000)
      || data.check_runs.length > config.pageSize) invalid(request.kind)
    for (const run of data.check_runs) {
      if (run.head_sha !== request.commitId || checkRuns.length >= config.maxItems) invalid(request.kind)
      checkRuns.push({ id: githubCheckRunId(String(run.id)), name: run.name, status: normalize(run.status),
        ...(run.conclusion === null ? {} : { conclusion: normalize(run.conclusion) }), url: run.html_url,
        ...(run.started_at === null ? {} : { startedAt: timestamp(run.started_at) }),
        ...(run.completed_at === null ? {} : { completedAt: timestamp(run.completed_at) }) })
    }
    const next = nextRestPage(response.headers.link, page, config.pageSize,
      `/repos/${owner}/${repo}/commits/${request.commitId}/check-runs`)
    if (next === 'invalid' || (next && page >= config.maxPages)) invalid(request.kind)
    if (!next) break
  }
  if (checkRuns.length !== checkTotal) invalid(request.kind)
  let statusTotal: number | undefined
  for (let page = 1; ; page += 1) {
    const response = await session.installation.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
      owner, repo, ref: request.commitId, per_page: config.pageSize, page, request: { signal },
    })
    const data = combinedStatusSchema.parse(response.data)
    statusTotal ??= data.total_count
    if (data.sha !== request.commitId || data.total_count !== statusTotal
      || data.total_count > config.maxItems || data.statuses.length > config.pageSize) invalid(request.kind)
    for (const status of data.statuses) {
      if (status.sha !== request.commitId || commitStatuses.length >= config.maxItems) invalid(request.kind)
      commitStatuses.push({ id: githubCommitStatusId(String(status.id)), context: status.context, state: status.state,
        ...(status.target_url === null ? {} : { targetUrl: status.target_url }),
        createdAt: timestamp(status.created_at), updatedAt: timestamp(status.updated_at) })
    }
    const next = nextRestPage(response.headers.link, page, config.pageSize,
      `/repos/${owner}/${repo}/commits/${request.commitId}/status`)
    if (next === 'invalid' || (next && page >= config.maxPages)) invalid(request.kind)
    if (!next) break
  }
  if (commitStatuses.length !== statusTotal) invalid(request.kind)
  return githubCommitCiFactSchema.parse({ repositoryId: request.repositoryId, commitId: request.commitId,
    workflowRuns, checkRuns, commitStatuses, observedAt: Date.now() })
}

/**
 * Read one exact Milestone and its fully paginated Issue scope.
 * @param request - exact Repository, Milestone node id, and number.
 * @param privateKey - operation-scoped Product App private key.
 * @param config - validated provider bounds.
 * @param signal - operation lifetime.
 * @param queue - per-installation interactive request scheduler.
 * @returns Milestone metadata and complete Issue facts.
 */
export async function readMilestone(
  request: GitHubMilestoneReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubMilestoneFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const issues: GitHubIssueFact[] = []
  let milestone: z.infer<typeof milestoneNodeSchema> | undefined
  let totalCount: number | undefined
  let after: string | null = null
  const cursors = new Set<string>()
  for (let page = 1; ; page += 1) {
    const data = milestoneDataSchema.parse(await queryGraphql(session.installation, MILESTONE_QUERY, {
      milestoneId: request.milestoneId, first: config.pageSize, after,
    }, signal, request.kind))
    if (data.node === null) notFound(request.kind)
    if (data.node.id !== request.milestoneId || data.node.number !== request.milestoneNumber) invalid(request.kind)
    assertRepository(data.node.repository, request.repositoryId, request.repositoryDatabaseId, request.kind)
    if (data.node.repository.owner.id !== request.installation.accountId) invalid(request.kind)
    milestone ??= data.node
    if (!sameMilestone(milestone, data.node)) invalid(request.kind)
    totalCount ??= data.node.issues.totalCount
    if (data.node.issues.totalCount !== totalCount || data.node.issues.nodes.length > config.pageSize) {
      invalid(request.kind)
    }
    for (const node of data.node.issues.nodes) {
      if (issues.length >= config.maxItems) invalid(request.kind)
      assertRepository(node.repository, request.repositoryId, request.repositoryDatabaseId, request.kind)
      issues.push(githubIssueFactSchema.parse({ id: node.id, repositoryId: node.repository.id,
        repositoryDatabaseId: String(node.repository.databaseId), number: node.number,
        state: node.state.toLowerCase(), title: node.title, url: node.url, updatedAt: timestamp(node.updatedAt) }))
    }
    after = nextCursor(data.node.issues.pageInfo, page, config.maxPages, request.kind, cursors)
    if (after === null) break
  }
  if (issues.length !== totalCount) invalid(request.kind)
  return githubMilestoneFactSchema.parse({ id: milestone.id, repositoryId: request.repositoryId, number: milestone.number,
    state: milestone.state.toLowerCase(), title: milestone.title,
    ...(milestone.description === null ? {} : { description: milestone.description }),
    ...(milestone.dueOn === null ? {} : { dueOn: timestamp(milestone.dueOn) }),
    url: milestone.url, updatedAt: timestamp(milestone.updatedAt), issues, observedAt: Date.now() })
}

function pullRequestFact(node: z.infer<typeof pullRequestNodeSchema>, observedAt: number): GitHubPullRequestFact {
  if (node.baseRepository.id !== node.repository.id) invalid('pull-request-base')
  if ((node.state === 'MERGED') !== node.merged) invalid('pull-request-state')
  return githubPullRequestFactSchema.parse({ id: githubPullRequestId(node.id), repositoryId: node.repository.id,
    number: node.number, state: node.state === 'OPEN' ? 'open' : 'closed', merged: node.merged, draft: node.isDraft,
    title: node.title, url: node.url,
    head: { repositoryId: node.headRepository.id, ref: node.headRefName, commitId: githubCommitId(node.headRefOid) },
    base: { repositoryId: node.baseRepository.id, ref: node.baseRefName, commitId: githubCommitId(node.baseRefOid) },
    ...(node.author === null ? {} : { authorAccountId: githubAccountId(node.author.id) }),
    updatedAt: timestamp(node.updatedAt), observedAt })
}

function assertRepository(
  repository: { id: string; databaseId: string | number },
  id: string,
  databaseId: string,
  operation: string,
): void {
  if (repository.id !== id || String(repository.databaseId) !== databaseId) invalid(operation)
}

function nextCursor(
  pageInfo: z.infer<typeof pageInfoSchema>,
  page: number,
  maxPages: number,
  operation: string,
  seen: Set<string>,
): string | null {
  if (!pageInfo.hasNextPage) return null
  if (pageInfo.endCursor === null || page >= maxPages || seen.has(pageInfo.endCursor)) invalid(operation)
  seen.add(pageInfo.endCursor)
  return pageInfo.endCursor
}

function nextRestPage(
  link: string | undefined,
  currentPage: number,
  pageSize: number,
  expectedPath: string,
): boolean | 'invalid' {
  const nextTarget = parseNextLinkTarget(link)
  if (nextTarget === null) return false
  if (nextTarget === 'invalid') return 'invalid'
  let target: URL
  let decodedPath: string
  try {
    target = new URL(nextTarget)
    decodedPath = decodeURIComponent(target.pathname)
  } catch {
    return 'invalid'
  }
  if (target.protocol !== 'https:' || target.hostname !== 'api.github.com'
    || target.username !== '' || target.password !== '' || target.hash !== ''
    || decodedPath !== expectedPath
    || target.searchParams.getAll('page').length !== 1
    || target.searchParams.getAll('per_page').length !== 1
    || target.searchParams.get('page') !== String(currentPage + 1)
    || target.searchParams.get('per_page') !== String(pageSize)) return 'invalid'
  return true
}

function normalize(value: string): string {
  return value.replaceAll('_', '-').toLowerCase()
}

function sameMilestone(left: z.infer<typeof milestoneNodeSchema>, right: z.infer<typeof milestoneNodeSchema>): boolean {
  return left.state === right.state
    && left.title === right.title && left.description === right.description && left.dueOn === right.dueOn
    && left.url === right.url && left.updatedAt === right.updatedAt
}

function sameReviewPullRequest(
  left: z.infer<typeof reviewPullRequestNodeSchema>,
  right: z.infer<typeof reviewPullRequestNodeSchema>,
): boolean {
  return left.headRefOid === right.headRefOid && left.updatedAt === right.updatedAt
}
