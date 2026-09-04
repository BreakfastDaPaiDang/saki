import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  githubAccountId, githubAppId, githubCommitId, githubExternalOperationId, githubInstallationId,
  githubPullRequestCreateMarkerId, githubPullRequestId, githubRepositoryDatabaseId, githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import {
  expectedPullRequestReadPermissions, expectedPullRequestWritePermissions, json, privateKey, TestCredentials,
} from './harness.ts'

describe('Saki Product GitHub App Pull Request create recovery', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('dispatches once and inspects the exact marker through a complete traversal', async () => {
    const repositoryId = githubRepositoryId('R_delivery')
    const repositoryDatabaseId = githubRepositoryDatabaseId('4242')
    const headCommitId = githubCommitId('a'.repeat(40))
    const markerId = githubPullRequestCreateMarkerId(`pull-request-marker-${'1'.repeat(64)}`)
    const request = {
      kind: 'pull-request-create' as const,
      operationId: githubExternalOperationId('operation:pr:32'),
      installation: {
        appId: githubAppId('12345'), installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_delivery'), privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      repositoryId, repositoryDatabaseId, markerId, headRef: 'feature/issue-32', baseRef: 'master',
      expectedHeadCommitId: headCommitId, title: 'Deliver issue 32',
      body: `Delivery body.\n\n<!-- saki-pull-request:${markerId} -->\n`,
      inspectionHint: { pullRequestId: githubPullRequestId('PR_75'), pullRequestNumber: 75 },
    }
    let tokens = 0
    let changedTarget: 'none' | 'head' | 'base' = 'none'
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const httpRequest = new Request(input, init)
      const url = new URL(httpRequest.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        tokens += 1
        return json({ token: `ghs_pr_${tokens}`, expires_at: '2030-01-02T03:04:05Z',
          permissions: tokens === 1 ? expectedPullRequestWritePermissions : expectedPullRequestReadPermissions,
          repository_selection: 'selected', repositories: [{ id: 4_242 }] }, { status: 201 })
      }
      if (url.pathname === '/graphql') {
        const body = JSON.parse(await httpRequest.text()) as { query: string; variables: Record<string, unknown> }
        if (body.query.includes('mutation SakiPullRequestCreate(')) {
          expect(body.variables).toEqual({
            repositoryId, headRef: request.headRef, baseRef: request.baseRef,
            title: request.title, body: request.body, clientMutationId: request.operationId,
          })
          return json({ data: { pullRequestCreate: {
            clientMutationId: request.operationId,
            pullRequest: { id: 'PR_75', number: 75, state: 'OPEN', title: request.title, body: request.body,
              headRefName: request.headRef, headRefOid: request.expectedHeadCommitId, baseRefName: request.baseRef,
              repository: { id: repositoryId, databaseId: '4242', owner: { id: request.installation.accountId } } },
          } } })
        }
        if (body.query.includes('SakiPullRequestCreateRepository')) return json({ data: { repository: {
          __typename: 'Repository', id: repositoryId, databaseId: '4242',
          nameWithOwner: 'BreakfastDaPaiDang/saki', owner: { id: request.installation.accountId },
        } } })
      }
      if (url.pathname.endsWith('/pulls')) {
        expect(url.searchParams.get('head')).toBe('BreakfastDaPaiDang:feature/issue-32')
        expect(url.searchParams.get('base')).toBe('master')
        if (url.searchParams.get('page') === '1') return json([{
          id: 74, node_id: 'PR_74', number: 74, state: 'closed', title: 'Unrelated', body: 'No marker.\n',
          html_url: 'https://github.com/BreakfastDaPaiDang/saki/pull/74', draft: false,
          merged_at: '2026-09-02T08:00:00Z', updated_at: '2026-09-02T08:00:00Z',
          user: { node_id: request.installation.accountId },
          head: { ref: request.headRef, sha: 'd'.repeat(40), repo: { node_id: repositoryId } },
          base: { ref: 'master', sha: 'b'.repeat(40), repo: { node_id: repositoryId } },
        }], { headers: { link: '<https://api.github.com/repos/BreakfastDaPaiDang/saki/pulls?page=2&per_page=1>; rel="next"' } })
        return json([{
          id: 75, node_id: 'PR_75', number: 75, state: 'open', title: request.title, body: request.body,
          html_url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75', draft: false, merged_at: null,
          updated_at: '2026-09-03T08:00:00Z', user: { node_id: request.installation.accountId },
          head: { ref: request.headRef, sha: changedTarget === 'head' ? 'c'.repeat(40) : headCommitId,
            repo: { node_id: repositoryId } },
          base: { ref: changedTarget === 'base' ? 'release' : request.baseRef,
            sha: 'b'.repeat(40), repo: { node_id: repositoryId } },
        }])
      }
      throw new Error(`unexpected request: ${httpRequest.method} ${url.pathname}`)
    }))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { pageSize: 1 })
    const signal = new AbortController().signal
    const hint = await ctx.sakiGitHub.dispatch(request, signal)
    expect(hint).toEqual({ pullRequestId: 'PR_75', pullRequestNumber: 75 })
    await expect(ctx.sakiGitHub.inspectMutation(request, signal)).resolves.toMatchObject({
      snapshot: { outcome: { state: 'unique-pull-request', pullRequest: { id: 'PR_75', number: 75 } } },
    })
    changedTarget = 'head'
    await expect(ctx.sakiGitHub.inspectMutation(request, signal)).resolves.toMatchObject({
      snapshot: { outcome: { state: 'identity-conflict' } },
    })
    changedTarget = 'base'
    await expect(ctx.sakiGitHub.inspectMutation(request, signal)).resolves.toMatchObject({
      snapshot: { outcome: { state: 'identity-conflict' } },
    })
  })

  it('limits recovery traversal to the exact same-Repository head and base association', async () => {
    const repositoryId = githubRepositoryId('R_delivery')
    const repositoryDatabaseId = githubRepositoryDatabaseId('4242')
    const headCommitId = githubCommitId('a'.repeat(40))
    const markerId = githubPullRequestCreateMarkerId(`pull-request-marker-${'2'.repeat(64)}`)
    const request = {
      kind: 'pull-request-create' as const,
      operationId: githubExternalOperationId('operation:pr:historical'),
      installation: {
        appId: githubAppId('12345'), installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_delivery'), privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      repositoryId, repositoryDatabaseId, markerId, headRef: 'feature/issue-32', baseRef: 'master',
      expectedHeadCommitId: headCommitId, title: 'Deliver issue 32',
      body: `Delivery body.\n\n<!-- saki-pull-request:${markerId} -->\n`,
    }
    const requestedQueries: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const httpRequest = new Request(input, init)
      const url = new URL(httpRequest.url)
      if (url.pathname === '/app/installations/98765/access_tokens') {
        return json({ token: 'ghs_pr_read', expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedPullRequestReadPermissions,
          repository_selection: 'selected', repositories: [{ id: 4_242 }] }, { status: 201 })
      }
      if (url.pathname === '/graphql') return json({ data: { repository: {
        __typename: 'Repository', id: repositoryId, databaseId: '4242',
        nameWithOwner: 'BreakfastDaPaiDang/saki', owner: { id: request.installation.accountId },
      } } })
      if (url.pathname.endsWith('/pulls')) {
        requestedQueries.push(url.search)
        const exactAssociation = url.searchParams.get('state') === 'all'
          && url.searchParams.get('head') === 'BreakfastDaPaiDang:feature/issue-32'
          && url.searchParams.get('base') === 'master'
        if (exactAssociation) return json([{
          id: 75, node_id: 'PR_75', number: 75, state: 'open', title: request.title, body: request.body,
          html_url: 'https://github.com/BreakfastDaPaiDang/saki/pull/75', draft: false, merged_at: null,
          updated_at: '2026-09-03T08:00:00Z', user: { node_id: request.installation.accountId },
          head: { ref: request.headRef, sha: headCommitId, repo: { node_id: repositoryId } },
          base: { ref: request.baseRef, sha: 'b'.repeat(40), repo: { node_id: repositoryId } },
        }])
        return json([74, 73].map(number => ({
          id: number, node_id: `PR_${number}`, number, state: 'closed', title: 'Unrelated', body: 'No marker.\n',
          html_url: `https://github.com/BreakfastDaPaiDang/saki/pull/${number}`, draft: false,
          merged_at: '2026-09-02T08:00:00Z', updated_at: '2026-09-02T08:00:00Z',
          user: { node_id: request.installation.accountId },
          head: { ref: 'feature/other', sha: 'd'.repeat(40), repo: { node_id: repositoryId } },
          base: { ref: request.baseRef, sha: 'b'.repeat(40), repo: { node_id: repositoryId } },
        })))
      }
      throw new Error(`unexpected request: ${httpRequest.method} ${url.pathname}`)
    }))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { maxItems: 1 })

    await expect(ctx.sakiGitHub.inspectMutation(request, new AbortController().signal)).resolves.toMatchObject({
      snapshot: { outcome: { state: 'unique-pull-request', pullRequest: { id: 'PR_75', number: 75 } } },
    })
    expect(requestedQueries).toHaveLength(1)
  })
})
