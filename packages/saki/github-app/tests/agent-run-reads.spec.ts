import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT,
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubIssueId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const repositoryId = githubRepositoryId('R_kgDOBoundRepository')
const repositoryDatabaseId = githubRepositoryDatabaseId('4242')
const profile = {
  appId: githubAppId('12345'),
  installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_kgDOBoundAccount'),
  privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
}
const rateLimit = {
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: '2026-08-26T09:00:00Z',
}

describe('Agent Run targeted GitHub reads', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('reads the complete exact Issue body without admitting an oversized partial body', async () => {
    const tokenBodies: unknown[] = []
    let detailRead = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const pathname = new URL(request.url).pathname
      if (pathname === '/app/installations/98765/access_tokens') {
        tokenBodies.push(JSON.parse(await request.text()) as unknown)
        return installationToken(`ghs_issue_detail_${tokenBodies.length}`)
      }
      if (pathname === '/graphql') {
        const body = JSON.parse(await request.text()) as { query?: unknown; variables?: unknown }
        expect(String(body.query)).toContain('query SakiIssueDetail')
        expect(body.variables).toEqual({ issueId: 'I_kwDOIssueThirty' })
        detailRead += 1
        return json({ data: {
          node: {
            __typename: 'Issue',
            id: 'I_kwDOIssueThirty',
            number: 30,
            state: 'OPEN',
            title: 'Give a Work Item to an Agent',
            body: detailRead === 1
              ? '## Acceptance criteria\n\n- Start one durable Agent Run.\n'
              : 'x'.repeat(GITHUB_ISSUE_DETAIL_BODY_UTF8_LIMIT + 1),
            url: 'https://github.com/BreakfastDaPaiDang/saki/issues/30',
            updatedAt: '2026-08-26T08:01:00Z',
            repository: { id: repositoryId, databaseId: '4242' },
          },
          rateLimit,
        } })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    }))

    const ctx = await productApp(contexts)
    const request = {
      kind: 'issue-detail' as const,
      installation: profile,
      repositoryId,
      repositoryDatabaseId,
      issueId: githubIssueId('I_kwDOIssueThirty'),
    }
    await expect(ctx.sakiGitHub.read(request, new AbortController().signal)).resolves.toMatchObject({
      id: 'I_kwDOIssueThirty',
      number: 30,
      body: '## Acceptance criteria\n\n- Start one durable Agent Run.\n',
    })
    await expect(ctx.sakiGitHub.read(request, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'issue-detail' },
    })
    expect(tokenBodies).toEqual([
      { permissions: expectedReadPermissions, repository_ids: [4_242] },
      { permissions: expectedReadPermissions, repository_ids: [4_242] },
    ])
    expect(JSON.stringify(tokenBodies)).not.toContain('administration')
  })

  it('classifies existing and missing branches without Administration permission', async () => {
    const tokenBodies: unknown[] = []
    const restPaths: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname === '/app/installations/98765/access_tokens') {
        tokenBodies.push(JSON.parse(await request.text()) as unknown)
        return installationToken(`ghs_branch_safety_${tokenBodies.length}`)
      }
      if (pathname === '/graphql') return repositoryResponse()
      restPaths.push(pathname)
      const branch = pathname.split('/').at(-1)
      if (pathname.includes('/rules/branches/')) {
        return json(branch === 'missing-with-rules' ? [{ type: 'required_status_checks' }] : [])
      }
      if (branch === 'existing-safe') return json({ name: branch, protected: false })
      if (branch === 'existing-protected') return json({ name: branch, protected: true })
      if (branch?.startsWith('missing-') === true) return json({ message: 'Not Found' }, { status: 404 })
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    }))

    const ctx = await productApp(contexts)
    const read = async (branch: string) => await ctx.sakiGitHub.read({
      kind: 'branch-safety',
      installation: profile,
      repositoryId,
      repositoryDatabaseId,
      branch,
    }, new AbortController().signal)

    await expect(read('existing-safe')).resolves.toMatchObject({ kind: 'safe', branchExists: true })
    await expect(read('existing-protected')).resolves.toMatchObject({ kind: 'protected', branchExists: true })
    await expect(read('missing-with-rules')).resolves.toMatchObject({ kind: 'protected', branchExists: false })
    await expect(read('missing-without-rules')).resolves.toMatchObject({
      kind: 'legacy-protection-unknown',
      branchExists: false,
    })

    expect(restPaths).toEqual([
      '/repos/BreakfastDaPaiDang/saki/branches/existing-safe',
      '/repos/BreakfastDaPaiDang/saki/branches/existing-protected',
      '/repos/BreakfastDaPaiDang/saki/branches/missing-with-rules',
      '/repos/BreakfastDaPaiDang/saki/rules/branches/missing-with-rules',
      '/repos/BreakfastDaPaiDang/saki/branches/missing-without-rules',
      '/repos/BreakfastDaPaiDang/saki/rules/branches/missing-without-rules',
    ])
    expect(tokenBodies).toHaveLength(4)
    expect(JSON.stringify(tokenBodies)).not.toContain('administration')
  })

  it('rejects a branch response for a different exact name', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      if (pathname === '/app/installations/98765/access_tokens') return installationToken('ghs_branch_mismatch')
      if (pathname === '/graphql') return repositoryResponse()
      if (pathname.endsWith('/branches/expected')) return json({ name: 'different', protected: false })
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    }))

    const ctx = await productApp(contexts)
    await expect(ctx.sakiGitHub.read({
      kind: 'branch-safety',
      installation: profile,
      repositoryId,
      repositoryDatabaseId,
      branch: 'expected',
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'branch-safety' },
    })
  })
})

async function productApp(contexts: Context[]): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  return ctx
}

function installationToken(token: string): Response {
  return json({
    token,
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedReadPermissions,
    repository_selection: 'selected',
    repositories: [{ id: 4_242 }],
  }, { status: 201 })
}

function repositoryResponse(): Response {
  return json({ data: {
    node: {
      __typename: 'Repository',
      id: repositoryId,
      databaseId: '4242',
      nameWithOwner: 'BreakfastDaPaiDang/saki',
      visibility: 'PUBLIC',
      url: 'https://github.com/BreakfastDaPaiDang/saki',
      updatedAt: '2026-08-26T08:00:00Z',
      owner: { id: 'O_kgDOBoundAccount' },
    },
    rateLimit,
  } })
}
