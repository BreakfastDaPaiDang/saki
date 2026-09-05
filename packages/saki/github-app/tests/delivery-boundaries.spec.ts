import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubAccountId, githubAppId, githubCommitId, githubExternalOperationId, githubInstallationId,
  githubMilestoneId, githubPullRequestCreateMarkerId, githubPullRequestId, githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type { GitHubReadRequest } from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, expectedPullRequestReadPermissions, expectedPullRequestWritePermissions,
  json, privateKey, TestCredentials } from './harness.ts'

const repositoryId = githubRepositoryId('R_delivery')
const commitId = githubCommitId('a'.repeat(40))
const profile = { appId: githubAppId('12345'), installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_delivery'), privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY') }
const shared = { installation: profile, repositoryId, repositoryDatabaseId: githubRepositoryDatabaseId('4242') }
const rateLimit = { cost: 1, limit: 5_000, remaining: 4_999, resetAt: '2030-01-02T03:04:05Z' }
const date = '2026-09-03T07:00:00Z'
const markerId = githubPullRequestCreateMarkerId(`pull-request-marker-${'3'.repeat(64)}`)
const createRequest = { ...shared, kind: 'pull-request-create' as const,
  operationId: githubExternalOperationId('operation:pr:boundary'), markerId,
  headRef: 'feature/delivery', baseRef: 'master', expectedHeadCommitId: commitId,
  title: 'Delivery', body: `Delivery\n\n<!-- saki-pull-request:${markerId} -->\n` }

describe('delivery GitHub response boundaries', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  async function provider(respond: (url: URL, request: Request) => Response | Promise<Response>,
    config: { pageSize?: number; maxPages?: number; maxItems?: number } = {},
    permissions: Readonly<Record<string, 'read' | 'write' | 'admin'>> = expectedReadPermissions): Promise<Context> {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname === '/app/installations/98765/access_tokens') return json({
        token: 'ghs_delivery', expires_at: '2030-01-02T03:04:05Z', permissions,
        repository_selection: 'selected', repositories: [{ id: 4_242 }],
      }, { status: 201 })
      return respond(url, request)
    }))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, config)
    return ctx
  }

  it.each([
    ['no marker and no hint', 'absent-complete'],
    ['known PR absent', 'known-pull-request-absent'],
    ['marker removed', 'marker-removed'],
    ['marker removed and head changed', 'identity-conflict'],
    ['hint number changed', 'identity-conflict'],
    ['marker matches another identity', 'identity-conflict'],
    ['duplicate marker in body', 'multiple-matches'],
    ['duplicate numeric identity', 'incomplete'],
    ['duplicate node identity', 'incomplete'],
    ['duplicate PR number', 'incomplete'],
    ['item cap', 'incomplete'],
    ['page cap', 'incomplete'],
    ['malformed link', 'incomplete'],
    ['foreign link', 'incomplete'],
    ['invalid target', 'incomplete'],
    ['nullable external fields', 'unique-pull-request'],
  ] as const)('classifies PR creation recovery: %s', async (mode, state) => {
    const pull = restPull()
    let entries = [pull]
    let link: string | undefined
    if (mode === 'no marker and no hint' || mode === 'marker removed' || mode === 'marker removed and head changed') pull.body = null
    if (mode === 'known PR absent') entries = []
    if (mode === 'marker removed and head changed') pull.head.sha = 'b'.repeat(40)
    if (mode === 'hint number changed') { pull.body = null; pull.number = 76 }
    if (mode === 'marker matches another identity') { pull.node_id = 'PR_76'; pull.number = 76 }
    if (mode === 'duplicate marker in body') pull.body = `${pull.body}\n${pull.body}`
    if (mode.startsWith('duplicate ') && mode !== 'duplicate marker in body') {
      const second = { ...pull, id: 76, node_id: 'PR_76', number: 76 }
      if (mode === 'duplicate numeric identity') second.id = 75
      if (mode === 'duplicate node identity') second.node_id = 'PR_75'
      if (mode === 'duplicate PR number') second.number = 75
      entries.push(second)
    }
    if (mode === 'item cap') entries.push({ ...pull, id: 76, node_id: 'PR_76', number: 76 })
    if (mode === 'page cap') link = '<https://api.github.com/repos/BreakfastDaPaiDang/saki/pulls?page=2&per_page=2>; rel="next"'
    if (mode === 'malformed link') link = 'not a Link header'
    if (mode === 'foreign link') link = '<https://foreign.example/pulls?page=2&per_page=2>; rel="next"'
    if (mode === 'invalid target') link = '<not-a-url>; rel="next"'
    if (mode === 'nullable external fields') { pull.draft = null; pull.user = null }
    const ctx = await provider(url => url.pathname === '/graphql'
      ? json({ data: { repository: repository() } })
      : json(entries, link === undefined ? {} : { headers: { link } }),
    { pageSize: 2, maxPages: 1, maxItems: mode === 'item cap' ? 1 : 4 }, expectedPullRequestReadPermissions)
    const hint = mode === 'no marker and no hint' || mode === 'nullable external fields' ? {}
      : { inspectionHint: { pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75 } }
    await expect(ctx.sakiGitHub.inspectMutation({ ...createRequest, ...hint }, new AbortController().signal))
      .resolves.toMatchObject({ snapshot: { outcome: { state } } })
  })

  it.each(['missing repository', 'foreign repository', 'pre-epoch update'] as const)(
    'rejects unusable PR creation recovery response: %s', async (mode) => {
      const repo = repository()
      if (mode === 'foreign repository') repo.id = 'R_foreign'
      const pull = restPull()
      if (mode === 'pre-epoch update') pull.updated_at = '1960-01-01T00:00:00Z'
      const ctx = await provider(url => url.pathname === '/graphql'
        ? json({ data: { repository: mode === 'missing repository' ? null : repo } }) : json([pull]),
      {}, expectedPullRequestReadPermissions)
      await expect(ctx.sakiGitHub.inspectMutation(createRequest, new AbortController().signal)).rejects.toMatchObject({
        failure: { code: mode === 'missing repository' ? 'not-found' : 'invalid-external-response' },
      })
    })

  it('rejects a mismatching mutation acknowledgement without sending a second mutation', async () => {
    let calls = 0
    const ctx = await provider(() => {
      calls += 1
      return json({ data: { pullRequestCreate: { clientMutationId: 'another-operation', pullRequest: {
        id: 'PR_75', number: 75, state: 'OPEN', title: createRequest.title, body: createRequest.body,
        headRefName: createRequest.headRef, headRefOid: commitId, baseRefName: createRequest.baseRef,
        repository: repository(),
      } } } })
    }, {}, expectedPullRequestWritePermissions)
    await expect(ctx.sakiGitHub.dispatch(createRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'pull-request-create' },
    })
    expect(calls).toBe(1)
  })

  it.each(['pull-request', 'pull-request-reviews', 'pull-request-association', 'milestone'] as const)(
    'reports an externally missing %s', async (kind) => {
      const ctx = await provider(() => json({ data: { node: null, rateLimit } }))
      await expect(ctx.sakiGitHub.read(readRequest(kind), new AbortController().signal))
        .rejects.toMatchObject({ failure: { code: 'not-found' } })
    })

  it.each(['wrong ref', 'forbidden'] as const)('does not treat %s as remote branch absence', async (mode) => {
    const ctx = await provider(url => url.pathname === '/graphql'
      ? json({ data: { node: repository(), rateLimit } })
      : mode === 'forbidden' ? json({ message: 'Forbidden' }, { status: 403 })
        : json({ ref: 'refs/heads/foreign', object: { type: 'commit', sha: commitId } }))
    await expect(ctx.sakiGitHub.read({ ...shared, kind: 'branch-head', branch: 'feature/delivery' },
      new AbortController().signal)).rejects.toMatchObject({ failure: {
      code: mode === 'forbidden' ? 'permanent-rejection' : 'invalid-external-response',
    } })
  })

  it.each(['base repository', 'missing author'] as const)('handles PR %s', async (mode) => {
    const pull = graphqlPull()
    if (mode === 'base repository') pull.baseRepository.id = 'R_foreign'
    else pull.author = null
    const ctx = await provider(() => json({ data: { node: pull, rateLimit } }))
    const result = ctx.sakiGitHub.read(readRequest('pull-request'), new AbortController().signal)
    if (mode === 'base repository') await expect(result).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    else expect(await result).not.toHaveProperty('authorAccountId')
  })

  it.each(['empty', 'count drift', 'oversized page', 'item cap', 'missing item', 'missing cursor'] as const)(
    'handles association completeness: %s', async (mode) => {
      let page = 0
      const ctx = await provider(() => {
        page += 1
        const totalCount = mode === 'empty' ? 0 : mode === 'count drift' && page > 1 ? 3 : 2
        return json({ data: { node: { ...repository(), pullRequests: { totalCount,
          nodes: mode === 'empty' ? [] : mode === 'oversized page' ? [graphqlPull(), graphqlPull()] : [graphqlPull()],
          pageInfo: { hasNextPage: mode !== 'empty' && mode !== 'missing item',
            endCursor: mode === 'missing cursor' ? null : `page-${page}` },
        } }, rateLimit } })
      }, { pageSize: 1, maxPages: 3, maxItems: mode === 'item cap' ? 1 : 3 })
      const result = ctx.sakiGitHub.read(readRequest('pull-request-association'), new AbortController().signal)
      if (mode === 'empty') await expect(result).resolves.toMatchObject({ state: 'absent' })
      else await expect(result).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    })

  it.each(['nullable metadata', 'wrong identity', 'metadata drift', 'count drift', 'oversized page', 'item cap', 'missing item'] as const)(
    'handles Milestone completeness: %s', async (mode) => {
      let page = 0
      const ctx = await provider(() => {
        page += 1
        return json({ data: { node: { __typename: 'Milestone', id: mode === 'wrong identity' ? 'MI_other' : 'MI_delivery',
          number: 1, state: 'OPEN', title: mode === 'metadata drift' && page > 1 ? 'changed' : '0.1.0',
          description: null, dueOn: null, url: 'https://github.com/BreakfastDaPaiDang/saki/milestone/1',
          updatedAt: date, repository: repository(), issues: {
            totalCount: mode === 'nullable metadata' ? 0 : mode === 'count drift' && page > 1 ? 3 : 2,
            nodes: mode === 'nullable metadata' ? [] : mode === 'oversized page' ? [issue(1), issue(2)] : [issue(page)],
            pageInfo: { hasNextPage: mode !== 'nullable metadata' && mode !== 'missing item', endCursor: `page-${page}` },
          } }, rateLimit } })
      }, { pageSize: 1, maxPages: 3, maxItems: mode === 'item cap' ? 1 : 3 })
      const result = ctx.sakiGitHub.read(readRequest('milestone'), new AbortController().signal)
      if (mode === 'nullable metadata') {
        const fact = await result
        expect(fact).toMatchObject({ issues: [] })
        expect(fact).not.toHaveProperty('description')
        expect(fact).not.toHaveProperty('dueOn')
      } else await expect(result).rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
    })

  it.each(['workflow', 'check', 'status'] as const)('retains pending and nullable %s CI facts through pagination', async (source) => {
    const ctx = await provider((url) => {
      if (url.pathname === '/graphql') return json({ data: { node: repository(), rateLimit } })
      const active = ciSource(url) === source
      const page = Number(url.searchParams.get('page'))
      const data = ciPage(ciSource(url), active ? page : 0, active ? 2 : 0)
      return json(data, active && page === 1 ? { headers: { link: nextLink(url, 2, 1) } } : {})
    }, { pageSize: 1 })
    const result = await ctx.sakiGitHub.read({ ...shared, kind: 'commit-ci', commitId }, new AbortController().signal)
    expect(result).toMatchObject({ [source === 'workflow' ? 'workflowRuns' : source === 'check' ? 'checkRuns' : 'commitStatuses']:
      [{ id: '1' }, { id: '2' }] })
  })

  it.each((['workflow', 'check', 'status'] as const).flatMap(source => (
    ['count drift', 'total cap', 'oversized page', 'wrong commit', 'missing item', 'page cap', 'malformed link', 'foreign link', 'invalid target'] as const
  ).map(mode => ({ source, mode }))))('rejects incomplete CI $source: $mode', async ({ source, mode }) => {
    const ctx = await provider((url) => {
      if (url.pathname === '/graphql') return json({ data: { node: repository(), rateLimit } })
      const actualSource = ciSource(url)
      if (actualSource !== source) return json(ciPage(actualSource, 0, 0))
      const page = Number(url.searchParams.get('page'))
      const data = ciPage(source, page, mode === 'total cap' ? 4 : mode === 'count drift' && page > 1 ? 3 : 2,
        mode === 'wrong commit' ? 'b'.repeat(40) : commitId, mode === 'oversized page')
      let link: string | undefined = mode === 'missing item' || mode === 'total cap' ? undefined : nextLink(url, page + 1, 1)
      if (mode === 'malformed link') link = 'invalid'
      if (mode === 'foreign link') link = '<https://foreign.example?page=2&per_page=1>; rel="next"'
      if (mode === 'invalid target') link = '<not-a-url>; rel="next"'
      return json(data, link === undefined ? {} : { headers: { link } })
    }, { pageSize: 1, maxItems: 3, maxPages: mode === 'page cap' ? 1 : 3 })
    await expect(ctx.sakiGitHub.read({ ...shared, kind: 'commit-ci', commitId }, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response' } })
  })
})

function repository() {
  return { __typename: 'Repository', id: String(repositoryId), databaseId: '4242',
    nameWithOwner: 'BreakfastDaPaiDang/saki', visibility: 'PUBLIC',
    url: 'https://github.com/BreakfastDaPaiDang/saki', updatedAt: date, owner: { id: profile.accountId } }
}

function restPull() {
  return { id: 75, node_id: 'PR_75', number: 75, state: 'open', title: createRequest.title,
    body: createRequest.body as string | null, html_url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75',
    draft: false as boolean | null, merged_at: null, updated_at: date, user: { node_id: profile.accountId } as { node_id: string } | null,
    head: { ref: createRequest.headRef, sha: String(commitId), repo: { node_id: repositoryId } },
    base: { ref: createRequest.baseRef, sha: 'b'.repeat(40), repo: { node_id: repositoryId } } }
}

function graphqlPull() {
  return { __typename: 'PullRequest', id: 'PR_75', number: 75, state: 'OPEN', merged: false, isDraft: false,
    title: 'Delivery', url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75', updatedAt: date,
    headRefName: createRequest.headRef, headRefOid: commitId, baseRefName: createRequest.baseRef, baseRefOid: 'b'.repeat(40),
    headRepository: { id: String(repositoryId) }, baseRepository: { id: String(repositoryId) }, repository: repository(),
    author: { id: profile.accountId } as { id: string } | null }
}

function issue(number: number) {
  return { __typename: 'Issue', id: `I_${number}`, number, state: 'OPEN', title: 'Delivery',
    url: `https://github.com/BreakfastDaPaiDang/saki/issues/${number}`, updatedAt: date, repository: repository() }
}

function readRequest(kind: 'pull-request' | 'pull-request-reviews' | 'pull-request-association' | 'milestone'): GitHubReadRequest {
  if (kind === 'milestone') return { ...shared, kind, milestoneId: githubMilestoneId('MI_delivery'), milestoneNumber: 1 }
  if (kind === 'pull-request-association') return { ...shared, kind, headRef: createRequest.headRef, baseRef: createRequest.baseRef, expectedHeadCommitId: commitId }
  return { ...shared, kind, pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75 }
}

function ciSource(url: URL): 'workflow' | 'check' | 'status' {
  return url.pathname.endsWith('/actions/runs') ? 'workflow' : url.pathname.endsWith('/check-runs') ? 'check' : 'status'
}

function ciPage(source: 'workflow' | 'check' | 'status', page: number, total: number, sha: string = commitId, oversized = false) {
  const entries = page === 0 ? [] : [page, ...(oversized ? [page + 1] : [])]
  if (source === 'workflow') return { total_count: total, workflow_runs: entries.map(id => ({
    id, workflow_id: 11, name: 'CI', event: 'push', run_number: id, run_attempt: 1, status: 'in_progress',
    conclusion: null, html_url: `https://github.com/BreakfastDaPaiDang/saki/actions/runs/${id}`,
    created_at: date, updated_at: date, head_sha: sha,
  })) }
  if (source === 'check') return { total_count: total, check_runs: entries.map(id => ({
    id, name: 'CI', status: 'queued', conclusion: null, html_url: `https://github.com/BreakfastDaPaiDang/saki/runs/${id}`,
    started_at: null, completed_at: null, head_sha: sha,
  })) }
  return { total_count: total, sha: commitId, statuses: entries.map(id => ({
    id, context: `ci-${id}`, state: 'pending', target_url: null, created_at: date, updated_at: date, sha,
  })) }
}

function nextLink(url: URL, page: number, pageSize: number): string {
  const next = new URL(url)
  next.searchParams.set('page', String(page))
  next.searchParams.set('per_page', String(pageSize))
  return `<${next}>; rel="next"`
}
