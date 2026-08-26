import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubAccountId,
  githubAppId,
  githubCommitId,
  githubInstallationId,
  githubIssueId,
  githubProjectId,
  githubReleaseTagName,
  githubRepositoryDatabaseId,
  githubRepositoryId,
  githubTagObjectId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubCommitReadRequest,
  GitHubCompareCommitsReadRequest,
  GitHubIssueReadRequest,
  GitHubProjectReadRequest,
  GitHubReleaseByTagReadRequest,
  GitHubRepositoryReadRequest,
  GitHubTagObjectReadRequest,
  GitHubTagReferenceReadRequest,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/index.ts'
import { GitHubOperationSession } from '../src/operation-session.ts'
import { InstallationPriorityQueue } from '../src/priority-queue.ts'
import {
  readCommit,
  readCompareCommits,
  readIssue,
  readProject,
  readReleaseByTag,
  readRepository,
  readTagObject,
  readTagReference,
} from '../src/reads.ts'

const REPOSITORY_ID = githubRepositoryId('R_kgDOBoundRepository')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('4242')
const ISSUE_ID = githubIssueId('I_kwDOIssueOne')
const PROJECT_ID = githubProjectId('PVT_kwDOBoard')
const TAG_NAME = githubReleaseTagName('saki-v0.1.0')
const TAG_A = githubTagObjectId('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
const TAG_B = githubTagObjectId('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
const COMMIT_A = githubCommitId('cccccccccccccccccccccccccccccccccccccccc')
const COMMIT_B = githubCommitId('dddddddddddddddddddddddddddddddddddddddd')

const INSTALLATION = {
  appId: githubAppId('12345'),
  installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_kgDOBoundAccount'),
  privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
}

const CONFIG: ResolvedConfig = {
  pageSize: 50,
  maxPages: 1_000,
  maxItems: 20_000,
  maxFieldValues: 100_000,
  maxResponseBytes: 1_024,
  requestTimeoutMs: 30_000,
  tagPeelDepth: 32,
  maxConcurrentScans: 2,
}

const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  remaining: 4_999,
  resetAt: '2026-08-26T09:00:00Z',
}

const REPOSITORY_REQUEST: GitHubRepositoryReadRequest = {
  kind: 'repository',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
}

const ISSUE_REQUEST: GitHubIssueReadRequest = {
  kind: 'issue',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  issueId: ISSUE_ID,
}

const PROJECT_REQUEST: GitHubProjectReadRequest = {
  kind: 'project',
  installation: INSTALLATION,
  projectId: PROJECT_ID,
}

const TAG_REFERENCE_REQUEST: GitHubTagReferenceReadRequest = {
  kind: 'tag-reference',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  tagName: TAG_NAME,
}

const TAG_OBJECT_REQUEST: GitHubTagObjectReadRequest = {
  kind: 'tag-object',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  target: { kind: 'tag', id: TAG_A },
}

const RELEASE_REQUEST: GitHubReleaseByTagReadRequest = {
  kind: 'release-by-tag',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  tagName: TAG_NAME,
}

const COMMIT_REQUEST: GitHubCommitReadRequest = {
  kind: 'commit',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  commitId: COMMIT_A,
}

const COMPARE_REQUEST: GitHubCompareCommitsReadRequest = {
  kind: 'compare-commits',
  installation: INSTALLATION,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  baseCommitId: COMMIT_A,
  headCommitId: COMMIT_B,
}

type Outcome =
  | { readonly kind: 'result'; readonly data: unknown }
  | { readonly kind: 'error'; readonly error: unknown }

function result(data: unknown): Outcome { return { kind: 'result', data } }
function failure(error: unknown): Outcome { return { kind: 'error', error } }

function graphql(data: unknown): Outcome {
  return result({ data: { data }, headers: {} })
}

function rest(data: unknown): Outcome {
  return result({ data })
}

function useSession(...outcomes: readonly Outcome[]): void {
  const request = vi.fn()
  for (const outcome of outcomes) {
    if (outcome.kind === 'result') request.mockResolvedValueOnce(outcome.data)
    else request.mockRejectedValueOnce(outcome.error)
  }
  vi.spyOn(GitHubOperationSession, 'create').mockResolvedValue({
    installation: { request },
    token: {
      expiresAt: Date.parse('2030-01-02T03:04:05Z'),
      permissions: {},
      repositorySelection: 'selected',
    },
  } as unknown as GitHubOperationSession)
}

function repositoryNode(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'Repository',
    id: REPOSITORY_ID,
    databaseId: REPOSITORY_DATABASE_ID,
    nameWithOwner: 'BreakfastDaPaiDang/saki',
    visibility: 'PUBLIC',
    url: 'https://github.com/BreakfastDaPaiDang/saki',
    updatedAt: '2026-08-26T08:00:00Z',
    owner: { id: 'O_kgDOBoundAccount' },
    ...overrides,
  }
}

function repositoryResponse(overrides: Readonly<Record<string, unknown>> = {}): Outcome {
  return graphql({ node: repositoryNode(overrides), rateLimit: RATE_LIMIT })
}

function issueNode(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: ISSUE_ID,
    number: 27,
    state: 'OPEN',
    title: 'Publish a read-only Board',
    url: 'https://github.com/BreakfastDaPaiDang/saki/issues/27',
    updatedAt: '2026-08-26T08:01:00Z',
    repository: { id: REPOSITORY_ID, databaseId: REPOSITORY_DATABASE_ID },
    ...overrides,
  }
}

function projectNode(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'ProjectV2',
    id: PROJECT_ID,
    number: 1,
    title: 'Saki 0.1.0',
    closed: false,
    url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
    updatedAt: '2026-08-26T08:00:00Z',
    owner: { id: 'O_kgDOBoundAccount' },
    ...overrides,
  }
}

function invoke<T>(operation: () => Promise<T>): Promise<T> {
  return operation()
}

describe('exact GitHub read rejection paths', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('rejects missing and mismatched exact Issue identities', async () => {
    useSession(graphql({ node: null, rateLimit: RATE_LIMIT }))
    await expect(invoke(() => readIssue(ISSUE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue())))
      .rejects.toMatchObject({ failure: { code: 'not-found', resource: 'issue' } })

    useSession(graphql({ node: issueNode({ id: 'I_other' }), rateLimit: RATE_LIMIT }))
    await expect(invoke(() => readIssue(ISSUE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue())))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'issue' } })

    useSession(graphql({ node: issueNode({ repository: { id: 'R_other', databaseId: REPOSITORY_DATABASE_ID } }), rateLimit: RATE_LIMIT }))
    await expect(invoke(() => readIssue(ISSUE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue())))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'issue' } })

    useSession(graphql({ node: issueNode({ repository: { id: REPOSITORY_ID, databaseId: '4243' } }), rateLimit: RATE_LIMIT }))
    await expect(invoke(() => readIssue(ISSUE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue())))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'issue' } })
  })

  it('projects the closed Issue state', async () => {
    useSession(graphql({ node: issueNode({ state: 'CLOSED' }), rateLimit: RATE_LIMIT }))
    await expect(readIssue(ISSUE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .resolves.toMatchObject({ state: 'closed' })
  })

  it('rejects missing, mismatched, and wrong-owner Projects', async () => {
    useSession(graphql({ node: null, rateLimit: RATE_LIMIT }))
    await expect(readProject(PROJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'not-found', resource: 'project' } })

    useSession(graphql({ node: projectNode({ id: 'PVT_other' }), rateLimit: RATE_LIMIT }))
    await expect(readProject(PROJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'project' } })

    useSession(graphql({ node: projectNode({ owner: { id: 'O_other' } }), rateLimit: RATE_LIMIT }))
    await expect(readProject(PROJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({
        failure: { code: 'permission-mismatch', permission: 'project-owner', required: 'read' },
      })
  })

  it('rejects Repository identity substitution', async () => {
    useSession(repositoryResponse({ id: 'R_other' }))
    await expect(readRepository(REPOSITORY_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toThrow('GitHub returned a different Repository identity')

    useSession(repositoryResponse({ databaseId: '4243' }))
    await expect(readRepository(REPOSITORY_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toThrow('GitHub returned a different Repository identity')
  })

  it('rejects a tag-reference name substitution', async () => {
    useSession(repositoryResponse(), rest({ ref: 'refs/tags/other', object: { type: 'commit', sha: COMMIT_A } }))
    await expect(readTagReference(TAG_REFERENCE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'tag-reference' } })
  })

  it('returns an already-terminal Commit without annotated-tag requests', async () => {
    useSession(repositoryResponse())
    await expect(readTagObject(
      { ...TAG_OBJECT_REQUEST, target: { kind: 'commit', id: COMMIT_A } },
      'key',
      CONFIG,
      new AbortController().signal,
      new InstallationPriorityQueue(),
    )).resolves.toMatchObject({ tagObjects: [], commitId: COMMIT_A })
  })

  it('rejects annotated-tag cycles, substitutions, and depth exhaustion', async () => {
    useSession(repositoryResponse(), rest({
      sha: TAG_A,
      object: { type: 'tag', sha: TAG_A },
      tagger: null,
    }))
    await expect(readTagObject(TAG_OBJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'tag-object' } })

    useSession(repositoryResponse(), rest({
      sha: TAG_B,
      object: { type: 'commit', sha: COMMIT_A },
      tagger: null,
    }))
    await expect(readTagObject(TAG_OBJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'tag-object' } })

    useSession(repositoryResponse(), rest({
      sha: TAG_A,
      object: { type: 'tag', sha: TAG_B },
      tagger: null,
    }))
    await expect(readTagObject(
      TAG_OBJECT_REQUEST,
      'key',
      { ...CONFIG, tagPeelDepth: 1 },
      new AbortController().signal,
      new InstallationPriorityQueue(),
    )).rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'tag-object' } })
  })

  it.each([
    ['a null tagger', null],
    ['a null tagger date', { date: null }],
  ])('omits taggedAt for %s', async (_description, tagger) => {
    useSession(repositoryResponse(), rest({
      sha: TAG_A,
      object: { type: 'commit', sha: COMMIT_A },
      tagger,
    }))
    const peel = await readTagObject(TAG_OBJECT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue())
    expect(peel.tagObjects[0]).not.toHaveProperty('taggedAt')
  })

  it('returns an absent Release only for an exact HTTP 404', async () => {
    useSession(repositoryResponse(), failure({ status: 404 }))
    await expect(readReleaseByTag(RELEASE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .resolves.toMatchObject({ kind: 'absent', tagName: TAG_NAME })
  })

  it.each([
    ['a primitive', 'transport'],
    ['null', null],
    ['a missing status', new Error('transport')],
    ['a string status', { status: '404' }],
    ['a fractional status', { status: 404.5 }],
    ['another HTTP status', { status: 500 }],
  ])('does not turn %s failure into an absent Release', async (_description, error) => {
    useSession(repositoryResponse(), failure(error))
    await expect(readReleaseByTag(RELEASE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toBe(error)
  })

  it('rejects a Release tag substitution and admits a null publication time', async () => {
    useSession(repositoryResponse(), rest({
      node_id: 'REL_one',
      tag_name: 'other',
      target_commitish: 'master',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/BreakfastDaPaiDang/saki/releases/tag/other',
      published_at: null,
    }))
    await expect(readReleaseByTag(RELEASE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'release-by-tag' } })

    useSession(repositoryResponse(), rest({
      node_id: 'REL_one',
      tag_name: TAG_NAME,
      target_commitish: 'master',
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/BreakfastDaPaiDang/saki/releases/tag/saki-v0.1.0',
      published_at: null,
    }))
    await expect(readReleaseByTag(RELEASE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .resolves.not.toHaveProperty('release.publishedAt')
  })

  it.each([
    ['a substituted sha', { sha: COMMIT_B, committer: { date: '2026-08-26T07:02:00Z' } }],
    ['a null committer', { sha: COMMIT_A, committer: null }],
    ['a null commit date', { sha: COMMIT_A, committer: { date: null } }],
  ])('rejects Commit evidence with %s', async (_description, fixture) => {
    useSession(repositoryResponse(), rest({
      sha: fixture.sha,
      html_url: `https://github.com/BreakfastDaPaiDang/saki/commit/${fixture.sha}`,
      commit: { committer: fixture.committer },
    }))
    await expect(readCommit(COMMIT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'commit' } })
  })

  it('rejects a syntactically valid pre-epoch Commit timestamp', async () => {
    useSession(repositoryResponse(), rest({
      sha: COMMIT_A,
      html_url: `https://github.com/BreakfastDaPaiDang/saki/commit/${COMMIT_A}`,
      commit: { committer: { date: '0001-01-01T00:00:00Z' } },
    }))
    await expect(readCommit(COMMIT_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .rejects.toThrow('GitHub returned an invalid timestamp')
  })

  it('omits an absent comparison merge base', async () => {
    useSession(repositoryResponse(), rest({
      status: 'diverged',
      ahead_by: 1,
      behind_by: 2,
      merge_base_commit: null,
    }))
    await expect(readCompareCommits(COMPARE_REQUEST, 'key', CONFIG, new AbortController().signal, new InstallationPriorityQueue()))
      .resolves.not.toHaveProperty('mergeBaseCommitId')
  })
})
