/** Exact Product App read operations. @module @breakfastdapaidang/saki-github-app/reads */

import { z } from 'zod'
import {
  GitHubProviderError,
  githubBranchSafetyFactSchema,
  githubAccountId,
  githubCommitComparisonFactSchema,
  githubCommitFactSchema,
  githubCommitId,
  githubIssueFactSchema,
  githubIssueDetailFactSchema,
  githubProjectFactSchema,
  githubProjectId,
  githubReleaseByTagObservationSchema,
  githubReleaseId,
  githubRepositoryDatabaseId,
  githubRepositoryFactSchema,
  githubRepositoryId,
  githubTagObjectId,
  githubTagPeelFactSchema,
  githubTagReferenceFactSchema,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubBranchSafetyFact,
  GitHubBranchSafetyReadRequest,
  GitHubCommitComparisonFact,
  GitHubCommitFact,
  GitHubCommitReadRequest,
  GitHubCompareCommitsReadRequest,
  GitHubIssueFact,
  GitHubIssueDetailFact,
  GitHubIssueDetailReadRequest,
  GitHubIssueReadRequest,
  GitHubProjectFact,
  GitHubProjectReadRequest,
  GitHubReleaseByTagObservation,
  GitHubReleaseByTagReadRequest,
  GitHubRepositoryFact,
  GitHubRepositoryReadRequest,
  GitHubTagObjectReadRequest,
  GitHubTagPeelFact,
  GitHubTagReferenceFact,
  GitHubTagReferenceReadRequest,
  GitHubTagTarget,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import {
  graphqlIssueFact,
  graphqlIssueNodeSchema,
  graphqlProjectNodeSchema,
  graphqlRepositoryNodeSchema,
  queryGraphql,
} from './graphql.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

type RepositoryTarget = Pick<GitHubRepositoryReadRequest, 'repositoryId' | 'repositoryDatabaseId'> & {
  readonly kind: string
}

const REPOSITORY_QUERY = `
query SakiRepository($repositoryId: ID!) {
  node(id: $repositoryId) {
    __typename
    ... on Repository {
      id
      databaseId: fullDatabaseId
      nameWithOwner
      visibility
      url
      updatedAt
      owner { id }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const ISSUE_QUERY = `
query SakiIssue($issueId: ID!) {
  node(id: $issueId) {
    __typename
    ... on Issue {
      id number state title url updatedAt
      repository { id databaseId: fullDatabaseId }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const ISSUE_DETAIL_QUERY = `
query SakiIssueDetail($issueId: ID!) {
  node(id: $issueId) {
    __typename
    ... on Issue {
      id number state title body url updatedAt
      repository { id databaseId: fullDatabaseId }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const PROJECT_QUERY = `
query SakiProject($projectId: ID!) {
  node(id: $projectId) {
    __typename
    ... on ProjectV2 {
      id number title closed url updatedAt
      owner { ... on Organization { id } ... on User { id } }
    }
  }
  rateLimit { cost limit remaining resetAt }
}`

const repositoryDataSchema = z.object({
  node: graphqlRepositoryNodeSchema.extend({
    __typename: z.literal('Repository'),
  }).loose().nullable(),
  rateLimit: z.object({
    cost: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    resetAt: z.iso.datetime(),
  }).loose(),
}).loose()

const issueDataSchema = z.object({
  node: graphqlIssueNodeSchema.extend({
    __typename: z.literal('Issue'),
  }).loose().nullable(),
  rateLimit: repositoryDataSchema.shape.rateLimit,
}).loose()

const issueDetailDataSchema = z.object({
  node: graphqlIssueNodeSchema.extend({
    __typename: z.literal('Issue'),
    body: z.string(),
  }).loose().nullable(),
  rateLimit: repositoryDataSchema.shape.rateLimit,
}).loose()

const branchSchema = z.object({
  name: z.string().min(1).max(255),
  protected: z.boolean(),
}).loose()

const activeBranchRulesSchema = z.array(z.object({
  type: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/u),
}).loose()).max(10_000)

const projectDataSchema = z.object({
  node: graphqlProjectNodeSchema.extend({
    __typename: z.literal('ProjectV2'),
  }).loose().nullable(),
  rateLimit: repositoryDataSchema.shape.rateLimit,
}).loose()

const tagReferenceSchema = z.object({
  ref: z.string().min(1),
  object: z.object({
    type: z.enum(['tag', 'commit']),
    sha: z.string().min(1),
  }).loose(),
}).loose()

const tagObjectSchema = z.object({
  sha: z.string().min(1),
  object: z.object({
    type: z.enum(['tag', 'commit']),
    sha: z.string().min(1),
  }).loose(),
  tagger: z.object({ date: z.iso.datetime().nullable() }).loose().nullable(),
}).loose()

const releaseSchema = z.object({
  node_id: z.string().min(1),
  tag_name: z.string().min(1),
  target_commitish: z.string().min(1),
  draft: z.boolean(),
  prerelease: z.boolean(),
  html_url: z.url(),
  published_at: z.iso.datetime().nullable(),
}).loose()

const commitSchema = z.object({
  sha: z.string().min(1),
  html_url: z.url(),
  commit: z.object({
    committer: z.object({ date: z.iso.datetime().nullable() }).loose().nullable(),
  }).loose(),
}).loose()

const comparisonSchema = z.object({
  status: z.enum(['ahead', 'behind', 'identical', 'diverged']),
  ahead_by: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  behind_by: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  merge_base_commit: z.object({ sha: z.string().min(1) }).loose().nullable(),
}).loose()

/**
 * Read one exact Repository through a Repository-bound installation token.
 * @param request - exact Repository identities and installation profile.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - concurrency-one scheduler for the installation.
 * @returns detached Repository facts.
 */
export async function readRepository(
  request: GitHubRepositoryReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubRepositoryFact> {
  const session = await createSession(
    request.installation,
    privateKey,
    request.repositoryDatabaseId,
    config,
    signal,
    queue,
  )
  return await repositoryFromSession(session, request, signal)
}

/**
 * Read one exact Issue through a Repository-bound token.
 * @param request - exact Issue identity.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached exact Issue facts.
 */
export async function readIssue(
  request: GitHubIssueReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubIssueFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const data = issueDataSchema.parse(await queryGraphql(
    session.installation,
    ISSUE_QUERY,
    { issueId: request.issueId },
    signal,
    request.kind,
  ))
  const node = requireMatchingIssueNode(request, data.node)
  return githubIssueFactSchema.parse(issueFact(node))
}

/**
 * Read one exact Issue with its complete bounded Markdown body.
 * @param request - exact Issue identity.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached exact Issue detail.
 */
export async function readIssueDetail(
  request: GitHubIssueDetailReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubIssueDetailFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const data = issueDetailDataSchema.parse(await queryGraphql(
    session.installation,
    ISSUE_DETAIL_QUERY,
    { issueId: request.issueId },
    signal,
    request.kind,
  ))
  const node = requireMatchingIssueNode(request, data.node)
  return githubIssueDetailFactSchema.parse({
    ...graphqlIssueFact(node, request.kind),
    body: node.body,
  })
}

/**
 * Classify one exact branch using effective rules without Administration permission.
 * @param request - exact Repository and branch name.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns fail-closed branch-safety facts.
 */
export async function readBranchSafety(
  request: GitHubBranchSafetyReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubBranchSafetyFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  let rawBranch: unknown
  try {
    rawBranch = (await session.installation.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner,
      repo,
      branch: request.branch,
      request: { signal },
    })).data
  } catch (error) {
    if (httpStatus(error) !== 404) throw error
    return await readMissingBranchSafety(session, request, owner, repo, signal)
  }
  const branch = branchSchema.parse(rawBranch)
  if (branch.name !== request.branch) invalid(request.kind)
  return githubBranchSafetyFactSchema.parse({
    kind: branch.protected ? 'protected' : 'safe',
    branchExists: true,
    observedAt: Date.now(),
  })
}

/**
 * Read one exact Project and verify its configured owner.
 * @param request - exact Project identity.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached exact Project facts.
 */
export async function readProject(
  request: GitHubProjectReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubProjectFact> {
  const session = await createSession(request.installation, privateKey, undefined, config, signal, queue)
  const data = projectDataSchema.parse(await queryGraphql(
    session.installation,
    PROJECT_QUERY,
    { projectId: request.projectId },
    signal,
    request.kind,
  ))
  if (data.node === null) notFound(request.kind)
  if (data.node.id !== request.projectId) invalid(request.kind)
  if (data.node.owner.id !== request.installation.accountId) {
    throw new GitHubProviderError({ code: 'permission-mismatch', permission: 'project-owner', required: 'read' })
  }
  return githubProjectFactSchema.parse({
    id: githubProjectId(data.node.id),
    ownerAccountId: githubAccountId(data.node.owner.id),
    number: data.node.number,
    title: data.node.title,
    closed: data.node.closed,
    url: data.node.url,
    updatedAt: timestamp(data.node.updatedAt),
    observedAt: Date.now(),
  })
}

/**
 * Read one exact Saki release-tag reference without peeling its target.
 * @param request - exact Saki tag reference.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached exact tag target.
 */
export async function readTagReference(
  request: GitHubTagReferenceReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubTagReferenceFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  const raw: unknown = (await session.installation.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
    owner,
    repo,
    ref: `tags/${request.tagName}`,
    request: { signal },
  })).data
  const ref = tagReferenceSchema.parse(raw)
  if (ref.ref !== `refs/tags/${request.tagName}`) invalid(request.kind)
  return githubTagReferenceFactSchema.parse({
    repositoryId: request.repositoryId,
    tagName: request.tagName,
    ref: ref.ref,
    target: tagTarget(ref.object.type, ref.object.sha),
    observedAt: Date.now(),
  })
}

/**
 * Recursively peel an annotated-tag target with cycle and depth checks.
 * @param request - annotated-tag target to peel.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns complete annotated-tag chain and terminal Commit.
 */
export async function readTagObject(
  request: GitHubTagObjectReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubTagPeelFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  if (request.target.kind === 'commit') {
    return githubTagPeelFactSchema.parse({
      repositoryId: request.repositoryId,
      tagObjects: [],
      commitId: request.target.id,
      observedAt: Date.now(),
    })
  }
  const tagObjects: Array<{
    readonly id: ReturnType<typeof githubTagObjectId>
    readonly target: GitHubTagTarget
    readonly taggedAt?: number
  }> = []
  const seen = new Set<string>()
  let target: GitHubTagTarget = request.target
  for (let depth = 0; depth < config.tagPeelDepth; depth += 1) {
    if (target.kind === 'commit') {
      return githubTagPeelFactSchema.parse({
        repositoryId: request.repositoryId,
        tagObjects,
        commitId: target.id,
        observedAt: Date.now(),
      })
    }
    if (seen.has(target.id)) invalid(request.kind)
    seen.add(target.id)
    const raw: unknown = (await session.installation.request('GET /repos/{owner}/{repo}/git/tags/{tag_sha}', {
      owner,
      repo,
      tag_sha: target.id,
      request: { signal },
    })).data
    const tag = tagObjectSchema.parse(raw)
    if (tag.sha !== target.id) invalid(request.kind)
    const next = tagTarget(tag.object.type, tag.object.sha)
    tagObjects.push({
      id: githubTagObjectId(tag.sha),
      target: next,
      ...(tag.tagger?.date === null || tag.tagger === null ? {} : { taggedAt: timestamp(tag.tagger.date) }),
    })
    target = next
  }
  invalid(request.kind)
}

/**
 * Read the Release whose tag name exactly matches the configured Saki tag.
 * @param request - exact Release tag.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached present or absent Release observation.
 */
export async function readReleaseByTag(
  request: GitHubReleaseByTagReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubReleaseByTagObservation> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  let raw: unknown
  try {
    raw = (await session.installation.request('GET /repos/{owner}/{repo}/releases/tags/{tag}', {
      owner,
      repo,
      tag: request.tagName,
      request: { signal },
    })).data
  } catch (error) {
    if (httpStatus(error) !== 404) throw error
    return githubReleaseByTagObservationSchema.parse({
      kind: 'absent',
      repositoryId: request.repositoryId,
      tagName: request.tagName,
      observedAt: Date.now(),
    })
  }
  const release = releaseSchema.parse(raw)
  if (release.tag_name !== request.tagName) invalid(request.kind)
  return githubReleaseByTagObservationSchema.parse({
    kind: 'present',
    release: {
      id: githubReleaseId(release.node_id),
      repositoryId: request.repositoryId,
      tagName: request.tagName,
      targetCommitish: release.target_commitish,
      draft: release.draft,
      prerelease: release.prerelease,
      url: release.html_url,
      ...(release.published_at === null ? {} : { publishedAt: timestamp(release.published_at) }),
      observedAt: Date.now(),
    },
  })
}

/**
 * Read one exact Commit and reject a resolved abbreviation or other object.
 * @param request - exact Commit identity.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached exact Commit facts.
 */
export async function readCommit(
  request: GitHubCommitReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubCommitFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  const raw: unknown = (await session.installation.request('GET /repos/{owner}/{repo}/commits/{ref}', {
    owner,
    repo,
    ref: request.commitId,
    request: { signal },
  })).data
  const commit = commitSchema.parse(raw)
  if (commit.sha !== request.commitId || commit.commit.committer === null || commit.commit.committer.date === null) {
    invalid(request.kind)
  }
  return githubCommitFactSchema.parse({
    id: githubCommitId(commit.sha),
    repositoryId: request.repositoryId,
    url: commit.html_url,
    committedAt: timestamp(commit.commit.committer.date),
    observedAt: Date.now(),
  })
}

/**
 * Compare exact base and head Commits for configured-upstream ancestry.
 * @param request - exact base and head Commits.
 * @param privateKey - operation-scoped private key.
 * @param config - validated provider limits.
 * @param signal - operation lifetime.
 * @param queue - installation request scheduler.
 * @returns detached raw ancestry comparison.
 */
export async function readCompareCommits(
  request: GitHubCompareCommitsReadRequest,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubCommitComparisonFact> {
  const session = await createSession(request.installation, privateKey, request.repositoryDatabaseId, config, signal, queue)
  const repository = await repositoryFromSession(session, request, signal)
  const [owner, repo] = repositoryCoordinates(repository)
  const raw: unknown = (await session.installation.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
    owner,
    repo,
    basehead: `${request.baseCommitId}...${request.headCommitId}`,
    request: { signal },
  })).data
  const comparison = comparisonSchema.parse(raw)
  return githubCommitComparisonFactSchema.parse({
    repositoryId: request.repositoryId,
    baseCommitId: request.baseCommitId,
    headCommitId: request.headCommitId,
    status: comparison.status,
    aheadBy: comparison.ahead_by,
    behindBy: comparison.behind_by,
    ...(comparison.merge_base_commit === null
      ? {}
      : { mergeBaseCommitId: githubCommitId(comparison.merge_base_commit.sha) }),
    observedAt: Date.now(),
  })
}

async function readMissingBranchSafety(
  session: GitHubOperationSession,
  request: GitHubBranchSafetyReadRequest,
  owner: string,
  repo: string,
  signal: AbortSignal,
): Promise<GitHubBranchSafetyFact> {
  const rawRules: unknown = (await session.installation.request(
    'GET /repos/{owner}/{repo}/rules/branches/{branch}',
    {
      owner,
      repo,
      branch: request.branch,
      request: { signal },
    },
  )).data
  const rules = activeBranchRulesSchema.parse(rawRules)
  return githubBranchSafetyFactSchema.parse({
    kind: rules.length === 0 ? 'legacy-protection-unknown' : 'protected',
    branchExists: false,
    observedAt: Date.now(),
  })
}

async function createSession(
  installation: GitHubRepositoryReadRequest['installation'],
  privateKey: string,
  repositoryDatabaseId: GitHubRepositoryReadRequest['repositoryDatabaseId'] | undefined,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubOperationSession> {
  return await GitHubOperationSession.create(
    installation,
    privateKey,
    repositoryDatabaseId,
    config,
    signal,
    queue,
    'interactive',
  )
}

async function repositoryFromSession(
  session: GitHubOperationSession,
  request: RepositoryTarget,
  signal: AbortSignal,
): Promise<GitHubRepositoryFact> {
  const data = repositoryDataSchema.parse(await queryGraphql(
    session.installation,
    REPOSITORY_QUERY,
    { repositoryId: request.repositoryId },
    signal,
    request.kind,
  ))
  if (data.node === null) notFound(request.kind)
  if (data.node.id !== request.repositoryId || data.node.databaseId !== request.repositoryDatabaseId) {
    throw new Error('GitHub returned a different Repository identity')
  }
  return githubRepositoryFactSchema.parse({
    id: githubRepositoryId(data.node.id),
    databaseId: githubRepositoryDatabaseId(data.node.databaseId),
    ownerAccountId: githubAccountId(data.node.owner.id),
    nameWithOwner: data.node.nameWithOwner,
    visibility: data.node.visibility.toLowerCase(),
    url: data.node.url,
    updatedAt: timestamp(data.node.updatedAt),
    observedAt: Date.now(),
  })
}

function issueFact(node: NonNullable<z.infer<typeof issueDataSchema>['node']>): GitHubIssueFact {
  return graphqlIssueFact(node, 'issue')
}

function requireMatchingIssueNode<Node extends NonNullable<z.infer<typeof issueDataSchema>['node']>>(
  request: GitHubIssueReadRequest | GitHubIssueDetailReadRequest,
  node: Node | null,
): Node {
  if (node === null) notFound(request.kind)
  if (node.id !== request.issueId
    || node.repository.id !== request.repositoryId
    || node.repository.databaseId !== request.repositoryDatabaseId) invalid(request.kind)
  return node
}

function tagTarget(type: 'tag' | 'commit', id: string): GitHubTagTarget {
  switch (type) {
    case 'tag': return { kind: 'tag', id: githubTagObjectId(id) }
    case 'commit': return { kind: 'commit', id: githubCommitId(id) }
  }
}

function repositoryCoordinates(repository: GitHubRepositoryFact): readonly [string, string] {
  const separator = repository.nameWithOwner.indexOf('/')
  return [repository.nameWithOwner.slice(0, separator), repository.nameWithOwner.slice(separator + 1)]
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isInteger(status) ? status : undefined
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('GitHub returned an invalid timestamp')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}

function notFound(resource: string): never {
  throw new GitHubProviderError({ code: 'not-found', resource })
}
