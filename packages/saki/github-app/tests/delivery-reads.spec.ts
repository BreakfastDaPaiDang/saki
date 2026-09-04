import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubAccountId,
  githubAppId,
  githubCommitId,
  githubInstallationId,
  githubMilestoneId,
  githubPullRequestId,
  githubPullRequestReviewId,
  githubPullRequestReviewsFactSchema,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const repositoryId = githubRepositoryId('R_delivery')
const repositoryDatabaseId = githubRepositoryDatabaseId('4242')
const headCommitId = githubCommitId('a'.repeat(40))
const baseCommitId = githubCommitId('b'.repeat(40))
const profile = {
  appId: githubAppId('12345'),
  installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_delivery'),
  privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
}
const rateLimit = { cost: 1, limit: 5_000, used: 1, remaining: 4_999, resetAt: '2026-09-03T08:00:00Z' }

describe('Saki Product GitHub App delivery reads', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('reads every review for one exact Pull Request and omits nullable external fields', async () => {
    let page = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_delivery', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions, repository_selection: 'selected', repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (url.pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
      const body = JSON.parse(await request.text()) as { query: string; variables: Record<string, unknown> }
      expect(body.query).toContain('SakiPullRequestReviews')
      expect(body.variables).toMatchObject({ pullRequestId: 'PR_75', first: 1 })
      page += 1
      return json({ data: {
        node: {
          __typename: 'PullRequest', id: 'PR_75', number: 75,
          headRefOid: headCommitId, updatedAt: '2026-09-03T07:00:00Z',
          repository: { id: repositoryId, owner: { id: profile.accountId } },
          reviews: {
            totalCount: 2,
            nodes: page === 1
              ? [{
                id: 'PRR_1', state: 'APPROVED', url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75#pullrequestreview-1',
                author: { id: profile.accountId }, commit: { oid: headCommitId },
                submittedAt: '2026-09-03T06:59:00Z', updatedAt: '2026-09-03T07:00:00Z',
              }]
              : [{
                id: 'PRR_2', state: 'PENDING', url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75#pullrequestreview-2',
                author: null, commit: null, submittedAt: null, updatedAt: '2026-09-03T07:00:00Z',
              }],
            pageInfo: page === 1
              ? { hasNextPage: true, endCursor: 'reviews-next' }
              : { hasNextPage: false, endCursor: null },
          },
        },
        rateLimit,
      } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { pageSize: 1 })

    const fact = githubPullRequestReviewsFactSchema.parse(await ctx.sakiGitHub.read({
      kind: 'pull-request-reviews', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75,
    }, new AbortController().signal))
    expect(fact).toMatchObject({
      repositoryId,
      pullRequestId: 'PR_75',
      pullRequestNumber: 75,
      headCommitId,
      reviews: [{
        id: githubPullRequestReviewId('PRR_1'), state: 'approved',
        authorAccountId: profile.accountId, commitId: headCommitId,
      }, {
        id: githubPullRequestReviewId('PRR_2'), state: 'pending',
      }],
    })
    const pendingReview = fact.reviews[1]
    expect(pendingReview).toBeDefined()
    if (pendingReview === undefined) throw new Error('second review fixture is missing')
    expect(Object.hasOwn(pendingReview, 'authorAccountId')).toBe(false)
    expect(Object.hasOwn(pendingReview, 'commitId')).toBe(false)
    expect(Object.hasOwn(pendingReview, 'submittedAt')).toBe(false)
    expect(page).toBe(2)
  })

  it.each([
    'pull-request-id-mismatch',
    'pull-request-number-mismatch',
    'repository-mismatch',
    'owner-mismatch',
    'head-drift',
    'metadata-drift',
    'total-count-drift',
    'missing-item',
    'cursor-loop',
    'page-cap',
    'oversized-page',
    'item-cap',
    'duplicate-review',
  ] as const)('rejects incomplete Pull Request review traversal: %s', async (mode) => {
    let page = 0
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_delivery', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions, repository_selection: 'selected', repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (url.pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
      page += 1
      const secondPage = page > 1
      const hasNextPage = mode === 'cursor-loop'
        || (!secondPage && mode !== 'item-cap' && mode !== 'missing-item')
      return json({ data: {
        node: {
          __typename: 'PullRequest',
          id: mode === 'pull-request-id-mismatch' ? 'PR_76' : 'PR_75',
          number: mode === 'pull-request-number-mismatch' ? 76 : 75,
          headRefOid: mode === 'head-drift' && secondPage ? baseCommitId : headCommitId,
          updatedAt: mode === 'metadata-drift' && secondPage
            ? '2026-09-03T07:01:00Z'
            : '2026-09-03T07:00:00Z',
          repository: {
            id: mode === 'repository-mismatch' ? 'R_foreign' : repositoryId,
            owner: { id: mode === 'owner-mismatch' ? 'O_foreign' : profile.accountId },
          },
          reviews: {
            totalCount: mode === 'item-cap' ? 2 : mode === 'total-count-drift' && secondPage ? 3 : 2,
            nodes: [{
              id: mode === 'duplicate-review' ? 'PRR_1' : `PRR_${page}`,
              state: 'COMMENTED',
              url: `https://github.com/BreakfastDaPaiDang/saki/pull/75#pullrequestreview-${page}`,
              author: null,
              commit: null,
              submittedAt: '2026-09-03T06:59:00Z',
              updatedAt: '2026-09-03T07:00:00Z',
            }, ...(mode === 'oversized-page' ? [{
              id: 'PRR_extra', state: 'DISMISSED',
              url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75#pullrequestreview-extra',
              author: null, commit: null, submittedAt: null, updatedAt: '2026-09-03T07:00:00Z',
            }] : [])],
            pageInfo: {
              hasNextPage,
              endCursor: hasNextPage ? (mode === 'cursor-loop' ? 'same-cursor' : 'reviews-next') : null,
            },
          },
        },
        rateLimit,
      } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {
      pageSize: 1,
      maxPages: mode === 'page-cap' ? 1 : 3,
      maxItems: mode === 'item-cap' ? 1 : 3,
    })

    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request-reviews', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75,
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
  })

  it('reads exact PR, complete association, raw commit CI, and fully paginated Milestone scope', async () => {
    let associationPage = 0
    let associationConflict: 'none' | 'stale' | 'foreign' = 'none'
    let associationTotal = 2
    let milestonePage = 0
    let observedOwner = profile.accountId
    let statusPage = 0
    let statusMode: 'complete' | 'missing-link' | 'count-drift' = 'complete'
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_delivery', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions, repository_selection: 'selected', repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (url.pathname === '/graphql') {
        const body = JSON.parse(await request.text()) as { query: string; variables: Record<string, unknown> }
        if (body.query.includes('SakiRepository')) return json({ data: {
          node: {
            __typename: 'Repository', id: repositoryId, databaseId: '4242',
            nameWithOwner: 'BreakfastDaPaiDang/saki', visibility: 'PUBLIC',
            url: 'https://github.com/BreakfastDaPaiDang/saki', updatedAt: '2026-09-03T07:00:00Z',
            owner: { id: observedOwner },
          }, rateLimit,
        } })
        if (body.query.includes('SakiPullRequest(')) {
          const pullRequestId = String(body.variables.pullRequestId)
          const number = Number(pullRequestId.slice('PR_'.length))
          return json({ data: {
            node: pullRequestNode(number, number >= 77 ? 'MERGED' : number === 76 ? 'CLOSED' : 'OPEN', number === 77, observedOwner),
            rateLimit,
          } })
        }
        if (body.query.includes('SakiPullRequestAssociation')) {
          associationPage += 1
          const associationNode = pullRequestNode(associationPage === 1 ? 75 : 76, 'OPEN', false, observedOwner)
          if (associationConflict === 'stale') associationNode.headRefOid = 'c'.repeat(40)
          if (associationConflict === 'foreign') associationNode.headRepository = { id: 'R_foreign' }
          return json({ data: {
            node: {
              __typename: 'Repository', id: repositoryId, databaseId: '4242',
              owner: { id: observedOwner },
              pullRequests: associationPage === 1
                ? { totalCount: associationTotal, nodes: [associationNode], pageInfo: {
                  hasNextPage: associationTotal > 1, endCursor: associationTotal > 1 ? 'next' : null,
                } }
                : { totalCount: associationTotal, nodes: [associationNode], pageInfo: { hasNextPage: false, endCursor: null } },
            }, rateLimit,
          } })
        }
        if (body.query.includes('SakiMilestone')) {
          milestonePage += 1
          return json({ data: {
            node: {
              __typename: 'Milestone', id: 'MI_delivery', number: 1, state: 'OPEN', title: '0.1.0',
              description: 'First release', dueOn: '2026-09-10T00:00:00Z',
              url: 'https://github.com/BreakfastDaPaiDang/saki/milestone/1', updatedAt: '2026-09-03T07:00:00Z',
              repository: { id: repositoryId, databaseId: '4242', owner: { id: observedOwner } },
              issues: milestonePage === 1
                ? { totalCount: 2, nodes: [issueNode(31)], pageInfo: { hasNextPage: true, endCursor: 'next' } }
                : { totalCount: 2, nodes: [issueNode(32)], pageInfo: { hasNextPage: false, endCursor: null } },
            }, rateLimit,
          } })
        }
        throw new Error(`unexpected GraphQL document: ${body.query}`)
      }
      if (url.pathname.endsWith('/actions/runs')) return json({ total_count: 1, workflow_runs: [{
        id: 101, workflow_id: 11, name: 'CI', event: 'pull_request', run_number: 32, run_attempt: 1,
        status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/BreakfastDaPaiDang/saki/actions/runs/101',
        created_at: '2026-09-03T07:00:00Z', updated_at: '2026-09-03T07:01:00Z', head_sha: headCommitId,
      }] })
      if (url.pathname.endsWith(`/commits/${headCommitId}/check-runs`)) return json({ total_count: 1, check_runs: [{
        id: 201, name: 'all checks passed', status: 'completed', conclusion: 'success',
        html_url: 'https://github.com/BreakfastDaPaiDang/saki/runs/201',
        started_at: '2026-09-03T07:00:00Z', completed_at: '2026-09-03T07:01:00Z', head_sha: headCommitId,
      }] })
      if (url.pathname.endsWith(`/commits/${headCommitId}/status`)) {
        statusPage += 1
        const totalCount = statusMode === 'count-drift' && statusPage === 2 ? 3 : 2
        return json({ total_count: totalCount, sha: headCommitId, statuses: [{
          id: statusPage === 1 ? 301 : 302,
          context: statusPage === 1 ? 'external/ci' : 'external/security', state: 'success',
          target_url: `https://ci.example.test/${statusPage === 1 ? 301 : 302}`,
          created_at: '2026-09-03T07:00:00Z', updated_at: '2026-09-03T07:01:00Z', sha: headCommitId,
        }] }, statusPage === 1 && statusMode !== 'missing-link' ? { headers: {
          link: `<https://api.github.com/repos/BreakfastDaPaiDang/saki/commits/${headCommitId}/status?page=2&per_page=1>; rel="next"`,
        } } : {})
      }
      if (url.pathname.includes('/git/ref/')) {
        if (decodeURIComponent(url.pathname).endsWith('/git/ref/heads/missing')) {
          return json({ message: 'Not Found' }, { status: 404 })
        }
        expect(decodeURIComponent(url.pathname))
          .toBe('/repos/BreakfastDaPaiDang/saki/git/ref/heads/feature/issue-32')
        return json({ ref: 'refs/heads/feature/issue-32', object: { type: 'commit', sha: headCommitId } })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { pageSize: 1 })
    const signal = new AbortController().signal

    await expect(ctx.sakiGitHub.read({
      kind: 'branch-head', installation: profile, repositoryId, repositoryDatabaseId, branch: 'feature/issue-32',
    }, signal)).resolves.toMatchObject({ state: 'present', commitId: headCommitId })
    await expect(ctx.sakiGitHub.read({
      kind: 'branch-head', installation: profile, repositoryId, repositoryDatabaseId, branch: 'missing',
    }, signal)).resolves.toMatchObject({ state: 'absent', branch: 'missing' })
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75,
    }, signal)).resolves.toMatchObject({ id: 'PR_75', number: 75, head: { commitId: headCommitId } })
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_77'), pullRequestNumber: 77,
    }, signal)).resolves.toMatchObject({ id: 'PR_77', state: 'closed', merged: true })
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_76'), pullRequestNumber: 76,
    }, signal)).resolves.toMatchObject({ id: 'PR_76', state: 'closed', merged: false })
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request', installation: profile, repositoryId, repositoryDatabaseId,
      pullRequestId: githubPullRequestId('PR_78'), pullRequestNumber: 78,
    }, signal)).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request-association', installation: profile, repositoryId, repositoryDatabaseId,
      headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: headCommitId,
    }, signal)).resolves.toMatchObject({ state: 'duplicate-conflict', pullRequests: [{ number: 75 }, { number: 76 }] })
    expect(associationPage).toBe(2)
    associationPage = 0
    associationTotal = 1
    await expect(ctx.sakiGitHub.read({
      kind: 'pull-request-association', installation: profile, repositoryId, repositoryDatabaseId,
      headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: headCommitId,
    }, signal)).resolves.toMatchObject({ state: 'unique', pullRequest: { number: 75 } })
    for (const conflict of ['stale', 'foreign'] as const) {
      associationPage = 0
      associationConflict = conflict
      await expect(ctx.sakiGitHub.read({
        kind: 'pull-request-association', installation: profile, repositoryId, repositoryDatabaseId,
        headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: headCommitId,
      }, signal)).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    }
    associationTotal = 2
    associationConflict = 'none'
    const ci = await ctx.sakiGitHub.read({
      kind: 'commit-ci', installation: profile, repositoryId, repositoryDatabaseId, commitId: headCommitId,
    }, signal)
    expect(ci).toMatchObject({
      commitId: headCommitId, workflowRuns: [{ id: '101' }], checkRuns: [{ id: '201' }],
      commitStatuses: [{ id: '301' }, { id: '302' }],
    })
    for (const mode of ['missing-link', 'count-drift'] as const) {
      statusPage = 0
      statusMode = mode
      await expect(ctx.sakiGitHub.read({
        kind: 'commit-ci', installation: profile, repositoryId, repositoryDatabaseId, commitId: headCommitId,
      }, signal)).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    }
    statusMode = 'complete'
    await expect(ctx.sakiGitHub.read({
      kind: 'milestone', installation: profile, repositoryId, repositoryDatabaseId,
      milestoneId: githubMilestoneId('MI_delivery'), milestoneNumber: 1,
    }, signal)).resolves.toMatchObject({ number: 1, issues: [{ number: 31 }, { number: 32 }] })
    expect(milestonePage).toBe(2)

    observedOwner = githubAccountId('O_foreign')
    const ownerMismatchRequests = [
      { kind: 'branch-head' as const, installation: profile, repositoryId, repositoryDatabaseId,
        branch: 'feature/issue-32' },
      { kind: 'pull-request' as const, installation: profile, repositoryId, repositoryDatabaseId,
        pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75 },
      { kind: 'pull-request-association' as const, installation: profile, repositoryId, repositoryDatabaseId,
        headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: headCommitId },
      { kind: 'commit-ci' as const, installation: profile, repositoryId, repositoryDatabaseId, commitId: headCommitId },
      { kind: 'milestone' as const, installation: profile, repositoryId, repositoryDatabaseId,
        milestoneId: githubMilestoneId('MI_delivery'), milestoneNumber: 1 },
    ]
    for (const ownerMismatchRequest of ownerMismatchRequests) {
      associationPage = 0
      milestonePage = 0
      await expect(ctx.sakiGitHub.read(ownerMismatchRequest, signal))
        .rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    }
  })

  it('rejects a Milestone Issue with a different Repository database identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_delivery', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions, repository_selection: 'selected', repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (url.pathname === '/graphql') return json({ data: {
        node: {
          __typename: 'Milestone', id: 'MI_delivery', number: 1, state: 'OPEN', title: '0.1.0',
          description: null, dueOn: null,
          url: 'https://github.com/BreakfastDaPaiDang/saki/milestone/1', updatedAt: '2026-09-03T07:00:00Z',
          repository: { id: repositoryId, databaseId: '4242', owner: { id: profile.accountId } },
          issues: { totalCount: 1, nodes: [{ ...issueNode(31), repository: {
            id: repositoryId, databaseId: '4243',
          } }], pageInfo: { hasNextPage: false, endCursor: null } },
        },
        rateLimit,
      } })
      throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
    }))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp)

    await expect(ctx.sakiGitHub.read({
      kind: 'milestone', installation: profile, repositoryId, repositoryDatabaseId,
      milestoneId: githubMilestoneId('MI_delivery'), milestoneNumber: 1,
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'milestone' },
    })
  })
})

function pullRequestNode(
  number: number,
  state: 'OPEN' | 'CLOSED' | 'MERGED' = 'OPEN',
  merged = false,
  ownerAccountId = profile.accountId,
): Record<string, unknown> {
  return {
    __typename: 'PullRequest', id: `PR_${number}`, number, state, merged, isDraft: false,
    title: `Delivery ${number}`, url: `https://github.com/BreakfastDaPaiDang/saki/pull/${number}`,
    headRefName: 'feature/issue-32', headRefOid: headCommitId,
    baseRefName: 'master', baseRefOid: baseCommitId,
    headRepository: { id: repositoryId }, baseRepository: { id: repositoryId },
    repository: { id: repositoryId, owner: { id: ownerAccountId } },
    author: { id: profile.accountId }, updatedAt: '2026-09-03T07:00:00Z',
  }
}

function issueNode(number: number): Record<string, unknown> {
  return {
    __typename: 'Issue', id: `I_${number}`, number, state: 'OPEN', title: `Issue ${number}`,
    url: `https://github.com/BreakfastDaPaiDang/saki/issues/${number}`,
    updatedAt: '2026-09-03T07:00:00Z', repository: { id: repositoryId, databaseId: '4242' },
  }
}
