import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GITHUB_TAG_PEEL_DEPTH_LIMIT,
  GitHubProviderError,
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryFactSchema,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type { GitHubProjectBoardScanRequest } from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const REST_RATE_HEADERS = {
  'x-ratelimit-limit': '5,000',
  'x-ratelimit-used': '1',
  'x-ratelimit-remaining': '4,999',
  'x-ratelimit-reset': '1893553445',
  'x-ratelimit-resource': 'core',
}

describe('Saki Product GitHub App provider', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('caps tag peeling at the Service fact limit during config admission', async () => {
    const exact = new Context()
    contexts.push(exact)
    new TestCredentials(exact, privateKey, true)
    await exact.plugin(SakiGitHubApp, {
      tagPeelDepth: GITHUB_TAG_PEEL_DEPTH_LIMIT,
    })

    const excessive = new Context()
    contexts.push(excessive)
    new TestCredentials(excessive, privateKey, true)
    let rejected = false
    try {
      await excessive.plugin(SakiGitHubApp, {
        tagPeelDepth: GITHUB_TAG_PEEL_DEPTH_LIMIT + 1,
      })
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })

  it('rejects a Product App key outside local-user trust without exposing private material', async () => {
    const secret = '-----BEGIN PRIVATE KEY-----\nprivate-fixture-must-not-leak\n-----END PRIVATE KEY-----'
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, secret, false)
    await ctx.plugin(SakiGitHubApp, {})

    let failure: unknown
    try {
      await ctx.sakiGitHub.read({
        kind: 'installation',
        installation: {
          appId: githubAppId('12345'),
          installationId: githubInstallationId('98765'),
          accountId: githubAccountId('O_kgDOBoundAccount'),
          privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
        },
      }, new AbortController().signal)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(GitHubProviderError)
    expect((failure as GitHubProviderError).failure.code).toBe('auth-unavailable')
    expect(JSON.stringify(failure)).not.toContain(secret)
    expect(String(failure)).not.toContain('private-fixture-must-not-leak')
  })

  it('translates a pre-cancelled operation without exposing its private abort reason', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})
    const controller = new AbortController()
    controller.abort(new Error('private caller cancellation reason'))

    let failure: unknown
    try {
      await ctx.sakiGitHub.read({
        kind: 'installation',
        installation: {
          appId: githubAppId('12345'),
          installationId: githubInstallationId('98765'),
          accountId: githubAccountId('O_kgDOBoundAccount'),
          privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
        },
      }, controller.signal)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(GitHubProviderError)
    expect((failure as GitHubProviderError).failure).toEqual({ code: 'cancelled' })
    expect(String(failure)).not.toContain('private caller cancellation reason')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns the closed cancellation failure when called after disposal', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})
    const provider = ctx.sakiGitHub
    await ctx.fiber.dispose()

    await expect(provider.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'cancelled' },
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not resolve a private key while a complete scan waits for global admission', async () => {
    const fetchStarted = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      fetchStarted()
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      })
    }))
    const ctx = new Context()
    contexts.push(ctx)
    const credentials = new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { maxConcurrentScans: 1 })
    const request: GitHubProjectBoardScanRequest = {
      kind: 'project-board',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      projectId: githubProjectId('PVT_kwDOBoard'),
      repositoryId: githubRepositoryId('R_kgDOBoundRepository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('4242'),
      statusFieldId: githubProjectFieldId('PVTF_status'),
      requiredStatusOptionIds: [githubProjectOptionId('OPT_ready')],
      priority: 'background',
      rateLimitReserve: 500,
    }
    const firstController = new AbortController()
    const secondController = new AbortController()
    const first = ctx.sakiGitHub.scan(request, firstController.signal)
    await vi.waitFor(() => { expect(fetchStarted).toHaveBeenCalledTimes(1) })
    const second = ctx.sakiGitHub.scan(request, secondController.signal)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    expect(credentials.resolveCalls).toBe(1)

    secondController.abort()
    await expect(second).rejects.toMatchObject({ failure: { code: 'cancelled' } })
    firstController.abort()
    await expect(first).rejects.toMatchObject({ failure: { code: 'cancelled' } })
  })

  it('classifies an elapsed request deadline as a transient transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('request aborted')) }, { once: true })
      })
    }))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { requestTimeoutMs: 1 })

    await expect(ctx.sakiGitHub.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'transient-transport' },
    })
  })

  it('cancels an unbounded response stream as soon as the byte limit is exceeded', async () => {
    let pulls = 0
    let cancelled = false
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(6))
        if (pulls === 3) controller.close()
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 }), { status: 201 })))
    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { maxResponseBytes: 10 })

    await expect(ctx.sakiGitHub.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
    expect(cancelled).toBe(true)
    expect(pulls).toBe(2)
  })

  it('obtains a short-lived read-only token and projects strict installation facts', async () => {
    const tokenBodies: unknown[] = []
    let suspendedAt: string | null = null
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname === '/app/installations/98765/access_tokens') {
        tokenBodies.push(JSON.parse(await request.text()) as unknown)
        return json({
          token: 'ghs_short_lived_fixture',
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/app/installations/98765') {
        return json({
          id: 98_765,
          account: {
            id: 111,
            node_id: 'O_kgDOBoundAccount',
            login: 'BreakfastDaPaiDang',
            type: 'Organization',
          },
          repository_selection: 'selected',
          permissions: {
            actions: 'read',
            checks: 'read',
            contents: 'read',
            issues: 'write',
            metadata: 'read',
            organization_projects: 'write',
            pull_requests: 'write',
            statuses: 'read',
          },
          suspended_at: suspendedAt,
        }, { headers: REST_RATE_HEADERS })
      }
      if (pathname === '/installation/repositories') {
        return json({
          total_count: 1,
          repositories: [{ id: 4_242, node_id: 'R_kgDOBoundRepository' }],
        }, {
          headers: REST_RATE_HEADERS,
        })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})

    const fact = await ctx.sakiGitHub.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)

    expect(fact).toMatchObject({
      installationId: '98765',
      account: {
        id: 'O_kgDOBoundAccount',
        login: 'BreakfastDaPaiDang',
        type: 'organization',
      },
      repositorySelection: 'selected',
      accessibleRepositoryIds: ['R_kgDOBoundRepository'],
      tokenExpiresAt: Date.parse('2030-01-02T03:04:05Z'),
    })
    expect(tokenBodies).toEqual([{ permissions: expectedReadPermissions }])
    expect(JSON.stringify(tokenBodies)).not.toContain('write')
    expect(JSON.stringify(tokenBodies)).not.toContain('workflows')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    suspendedAt = '2026-08-26T08:30:00Z'
    await expect(ctx.sakiGitHub.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'auth-unavailable' },
    })
  })

  it('binds an exact Repository read token to the configured Repository database id', async () => {
    const tokenBodies: unknown[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname === '/app/installations/98765/access_tokens') {
        tokenBodies.push(JSON.parse(await request.text()) as unknown)
        return json({
          token: 'ghs_repository_fixture',
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/graphql') {
        const body = JSON.parse(await request.text()) as { query?: unknown; variables?: unknown }
        expect(body.query).toEqual(expect.stringContaining('query SakiRepository'))
        expect(body.query).toEqual(expect.stringContaining('databaseId: fullDatabaseId'))
        expect(body.variables).toEqual({ repositoryId: 'R_kgDOBoundRepository' })
        return json({
          data: {
            node: {
              __typename: 'Repository',
              id: 'R_kgDOBoundRepository',
              databaseId: '4242',
              nameWithOwner: 'BreakfastDaPaiDang/saki',
              visibility: 'PUBLIC',
              url: 'https://github.com/BreakfastDaPaiDang/saki',
              updatedAt: '2026-08-26T08:00:00Z',
              owner: { id: 'O_kgDOBoundAccount' },
            },
            rateLimit: {
              cost: 1,
              limit: 5_000,
              remaining: 4_999,
              resetAt: '2026-08-26T09:00:00Z',
            },
          },
        })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})

    const fact = githubRepositoryFactSchema.parse(await ctx.sakiGitHub.read({
      kind: 'repository',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      repositoryId: githubRepositoryId('R_kgDOBoundRepository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('4242'),
    }, new AbortController().signal))

    expect(fact).toEqual({
      id: 'R_kgDOBoundRepository',
      databaseId: '4242',
      ownerAccountId: 'O_kgDOBoundAccount',
      nameWithOwner: 'BreakfastDaPaiDang/saki',
      visibility: 'public',
      url: 'https://github.com/BreakfastDaPaiDang/saki',
      updatedAt: Date.parse('2026-08-26T08:00:00Z'),
      observedAt: fact.observedAt,
    })
    expect(fact.observedAt).toBeTypeOf('number')
    expect(tokenBodies).toEqual([{
      permissions: expectedReadPermissions,
      repository_ids: [4_242],
    }])
  })

  it('classifies GraphQL HTTP 200 primary and secondary limit envelopes', async () => {
    let secondary = false
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_rate_limited_fixture',
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/graphql') {
        return json({
          errors: [{ message: secondary ? 'You have exceeded a secondary rate limit' : 'API rate limit exceeded' }],
        }, {
          headers: secondary ? {
            'x-github-request-id': 'SAFE-SECONDARY-REQUEST',
            'x-ratelimit-remaining': '4,999',
            'x-ratelimit-reset': '1893553445',
          } : {
            'x-github-request-id': 'SAFE-RATE-REQUEST',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': '1893553445',
          },
        })
      }
      throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
    }))

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})
    const request = {
      kind: 'repository',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      repositoryId: githubRepositoryId('R_kgDOBoundRepository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('4242'),
    } as const

    await expect(ctx.sakiGitHub.read(request, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'primary-rate-limit',
        resetAt: 1_893_553_445_000,
        requestId: 'SAFE-RATE-REQUEST',
      },
    })
    secondary = true
    await expect(ctx.sakiGitHub.read(request, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'secondary-rate-limit',
        requestId: 'SAFE-SECONDARY-REQUEST',
      },
    })
  })

  it('classifies an HTTP 429 with exhausted primary quota as a primary limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json({
      message: 'API rate limit exceeded',
    }, {
      status: 429,
      headers: {
        'x-github-request-id': 'SAFE-REST-RATE-REQUEST',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1893553445',
      },
    })))

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})

    await expect(ctx.sakiGitHub.read({
      kind: 'installation',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'primary-rate-limit',
        resetAt: 1_893_553_445_000,
        requestId: 'SAFE-REST-RATE-REQUEST',
      },
    })
  })

  it('rejects a token response that exceeds the requested read-only permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname !== '/app/installations/98765/access_tokens') {
        throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
      }
      return json({
        token: 'ghs_overprivileged_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: { ...expectedReadPermissions, contents: 'write' },
        repository_selection: 'selected',
        repositories: [{ id: 4_242 }],
      }, { status: 201 })
    }))

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})

    await expect(ctx.sakiGitHub.read({
      kind: 'repository',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      repositoryId: githubRepositoryId('R_kgDOBoundRepository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('4242'),
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'permission-mismatch',
        permission: 'contents',
        required: 'read',
        observed: 'write',
      },
    })
  })

  it('returns one complete validated Project Board candidate through the real Octokit boundary', async () => {
    let fenceReads = 0
    let reportedItemCount = 2
    let reportedFieldCount = 2
    let reportedFirstItemFieldValueCount = 2
    let firstItemFieldValuePages = 2
    let rateRemaining = 4_999
    let rateUsed: number | undefined
    let itemPassReads = 0
    let changeStatusBetweenPasses = false
    let substituteOpenIssueTitle = false
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      const { pathname } = new URL(request.url)
      if (pathname === '/app/installations/98765/access_tokens') {
        return json({
          token: 'ghs_scan_fixture',
          expires_at: '2030-01-02T03:04:05Z',
          permissions: expectedReadPermissions,
          repository_selection: 'selected',
          repositories: [{ id: 4_242 }],
        }, { status: 201 })
      }
      if (pathname === '/app/installations/98765') {
        return json({
          id: 98_765,
          account: {
            id: 111,
            node_id: 'O_kgDOBoundAccount',
            login: 'BreakfastDaPaiDang',
            type: 'Organization',
          },
          repository_selection: 'selected',
          permissions: {
            actions: 'read',
            checks: 'read',
            contents: 'read',
            issues: 'write',
            metadata: 'read',
            organization_projects: 'write',
            pull_requests: 'write',
            statuses: 'read',
          },
          suspended_at: null,
        }, { headers: REST_RATE_HEADERS })
      }
      if (pathname === '/installation/repositories') {
        return json({
          total_count: 1,
          repositories: [{ id: 4_242, node_id: 'R_kgDOBoundRepository' }],
        }, { headers: REST_RATE_HEADERS })
      }
      if (pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${pathname}`)
      const body = JSON.parse(await request.text()) as { query?: unknown; variables?: unknown }
      const query = String(body.query)
      expect(query).not.toContain('fullDatabaseId')
      const rateLimit = {
        cost: 1,
        limit: 5_000,
        used: rateUsed ?? 5_000 - rateRemaining,
        remaining: rateRemaining,
        resetAt: '2026-08-26T09:00:00Z',
      }
      if (query.includes('query SakiProjectBoardFence')) {
        expect(query).toContain('items(archivedStates: [ARCHIVED, NOT_ARCHIVED])')
        expect(query).toContain('databaseId')
        fenceReads += 1
        return json({ data: {
          project: {
            __typename: 'ProjectV2',
            id: 'PVT_kwDOBoard',
            number: 1,
            title: 'Saki 0.1.0',
            closed: false,
            url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
            updatedAt: '2026-08-26T08:00:00Z',
            owner: { id: 'O_kgDOBoundAccount' },
            items: { totalCount: reportedItemCount },
          },
          repository: {
            __typename: 'Repository',
            id: 'R_kgDOBoundRepository',
            databaseId: 4_242,
            nameWithOwner: 'BreakfastDaPaiDang/saki',
            visibility: 'PUBLIC',
            url: 'https://github.com/BreakfastDaPaiDang/saki',
            updatedAt: '2026-08-26T08:00:00Z',
            owner: { id: 'O_kgDOBoundAccount' },
            issues: { totalCount: 2 },
          },
          rateLimit,
        } })
      }
      if (query.includes('query SakiProjectFields')) {
        const after = (body.variables as { after?: unknown }).after
        const firstPage = after === null
        return json({ data: {
          project: {
            __typename: 'ProjectV2',
            id: 'PVT_kwDOBoard',
            fields: {
              totalCount: reportedFieldCount,
              nodes: firstPage ? [{
                __typename: 'ProjectV2SingleSelectField',
                id: 'PVTF_status',
                name: 'Status',
                options: [
                  { id: 'OPT_inbox', name: 'Inbox' },
                  { id: 'OPT_backlog', name: 'Backlog' },
                  { id: 'OPT_ready', name: 'Ready' },
                  { id: 'OPT_progress', name: 'In progress' },
                  { id: 'OPT_review', name: 'In review' },
                  { id: 'OPT_done', name: 'Done' },
                  { id: 'OPT_canceled', name: 'Canceled' },
                ],
              }] : [{
                __typename: 'ProjectV2Field',
                id: 'PVTF_title',
                name: 'Title',
                dataType: 'TITLE',
              }],
              pageInfo: firstPage
                ? { hasNextPage: true, endCursor: 'fields-page-1' }
                : { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        } })
      }
      if (query.includes('query SakiProjectItems')) {
        expect(query).toContain(
          'items(first: $first, after: $after, archivedStates: [ARCHIVED, NOT_ARCHIVED], '
          + 'orderBy: { field: POSITION, direction: ASC })',
        )
        const after = (body.variables as { after?: unknown }).after
        const firstPage = after === null
        if (firstPage) itemPassReads += 1
        return json({ data: {
          project: {
            __typename: 'ProjectV2',
            id: 'PVT_kwDOBoard',
            items: {
              nodes: firstPage ? [{
                id: 'PVTI_issue',
                isArchived: false,
                updatedAt: '2026-08-26T08:01:00Z',
                content: {
                  __typename: 'Issue',
                  id: 'I_kwDOIssueOne',
                  number: 27,
                  state: 'OPEN',
                  title: 'Publish a read-only Board',
                  url: 'https://github.com/BreakfastDaPaiDang/saki/issues/27',
                  updatedAt: '2026-08-26T08:01:00Z',
                  repository: { id: 'R_kgDOBoundRepository', databaseId: 4_242 },
                },
                fieldValues: {
                  totalCount: reportedFirstItemFieldValueCount,
                  nodes: [{
                    __typename: 'ProjectV2ItemFieldSingleSelectValue',
                    optionId: changeStatusBetweenPasses && itemPassReads % 2 === 0 ? 'OPT_done' : 'OPT_ready',
                    field: { __typename: 'ProjectV2SingleSelectField', id: 'PVTF_status' },
                  }],
                  pageInfo: { hasNextPage: true, endCursor: 'field-values-page-1' },
                },
              }] : [{
                id: 'PVTI_draft',
                isArchived: true,
                updatedAt: '2026-08-26T08:02:00Z',
                content: { __typename: 'DraftIssue', title: 'Raw draft' },
                fieldValues: {
                  totalCount: 0,
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }],
              pageInfo: firstPage
                ? { hasNextPage: true, endCursor: 'items-page-1' }
                : { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        } })
      }
      if (query.includes('query SakiProjectItemFieldValues')) {
        const after = (body.variables as { after?: unknown }).after
        const secondPage = after === 'field-values-page-1'
        if (!secondPage && after !== 'field-values-page-2') {
          throw new Error(`unexpected field-value cursor: ${String(after)}`)
        }
        return json({ data: {
          item: {
            __typename: 'ProjectV2Item',
            id: 'PVTI_issue',
            fieldValues: {
              totalCount: reportedFirstItemFieldValueCount,
              nodes: [{ __typename: 'ProjectV2ItemFieldTextValue' }],
              pageInfo: secondPage && firstItemFieldValuePages === 3
                ? { hasNextPage: true, endCursor: 'field-values-page-2' }
                : { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        } })
      }
      if (query.includes('query SakiOpenIssues')) {
        const after = (body.variables as { after?: unknown }).after
        const firstPage = after === null
        return json({ data: {
          repository: {
            __typename: 'Repository',
            id: 'R_kgDOBoundRepository',
            databaseId: 4_242,
            issues: {
              nodes: firstPage ? [{
                id: 'I_kwDOIssueOne',
                number: 27,
                state: 'OPEN',
                title: substituteOpenIssueTitle ? 'Substituted Issue title' : 'Publish a read-only Board',
                url: 'https://github.com/BreakfastDaPaiDang/saki/issues/27',
                updatedAt: '2026-08-26T08:01:00Z',
                repository: { id: 'R_kgDOBoundRepository', databaseId: 4_242 },
              }] : [{
                id: 'I_kwDOUnjoined',
                number: 64,
                state: 'OPEN',
                title: 'Unjoined Inbox work',
                url: 'https://github.com/BreakfastDaPaiDang/saki/issues/64',
                updatedAt: '2026-08-26T08:03:00Z',
                repository: { id: 'R_kgDOBoundRepository', databaseId: 4_242 },
              }],
              pageInfo: firstPage
                ? { hasNextPage: true, endCursor: 'issues-page-1' }
                : { hasNextPage: false, endCursor: null },
            },
          },
          rateLimit,
        } })
      }
      throw new Error(`unexpected GraphQL document: ${query}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const ctx = new Context()
    contexts.push(ctx)
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, { pageSize: 1, maxPages: 2 })

    const scanRequest: GitHubProjectBoardScanRequest = {
      kind: 'project-board',
      installation: {
        appId: githubAppId('12345'),
        installationId: githubInstallationId('98765'),
        accountId: githubAccountId('O_kgDOBoundAccount'),
        privateKeyRef: credentialRef('SAKI_PRODUCT_APP_PRIVATE_KEY'),
      },
      projectId: githubProjectId('PVT_kwDOBoard'),
      repositoryId: githubRepositoryId('R_kgDOBoundRepository'),
      repositoryDatabaseId: githubRepositoryDatabaseId('4242'),
      statusFieldId: githubProjectFieldId('PVTF_status'),
      requiredStatusOptionIds: [
        'OPT_inbox',
        'OPT_backlog',
        'OPT_ready',
        'OPT_progress',
        'OPT_review',
        'OPT_done',
        'OPT_canceled',
      ].map(githubProjectOptionId),
      priority: 'interactive',
      rateLimitReserve: 500,
    }
    const candidate = await ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)

    expect(fenceReads).toBe(4)
    expect(itemPassReads).toBe(2)
    expect(candidate).toMatchObject({
      kind: 'project-board',
      formatVersion: 1,
      project: { id: 'PVT_kwDOBoard', title: 'Saki 0.1.0' },
      repository: { id: 'R_kgDOBoundRepository', databaseId: '4242' },
      statusFieldId: 'PVTF_status',
      items: [
        { id: 'PVTI_issue', apiOrder: 0, statusOptionId: 'OPT_ready', content: { kind: 'issue' } },
        { id: 'PVTI_draft', apiOrder: 1, archived: true, content: { kind: 'draft-issue', title: 'Raw draft' } },
      ],
      openIssues: [
        { id: 'I_kwDOIssueOne', number: 27 },
        { id: 'I_kwDOUnjoined', number: 64 },
      ],
    })
    expect(candidate.fingerprint.version).toBe(1)
    expect(candidate.fingerprint.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(candidate.rateObservations).toHaveLength(19)
    expect(candidate.rateObservations.slice(0, 1).map((observation) => {
      const { observedAt: _observedAt, ...stable } = observation
      return stable
    })).toEqual([
      {
        kind: 'rest',
        resource: 'core',
        limit: 5_000,
        used: 1,
        remaining: 4_999,
        resetAt: 1_893_553_445_000,
      },
    ])
    expect(candidate.rateObservations.slice(1).every(observation => observation.kind === 'graphql')).toBe(true)

    substituteOpenIssueTitle = true
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'project-board' },
    })
    substituteOpenIssueTitle = false

    itemPassReads = 0
    changeStatusBetweenPasses = true
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'project-board-stability' },
    })
    changeStatusBetweenPasses = false

    await expect(ctx.sakiGitHub.scan({
      ...scanRequest,
      statusFieldId: githubProjectFieldId('PVTF_missing'),
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: 'PVTF_missing',
      },
    })
    await expect(ctx.sakiGitHub.scan({
      ...scanRequest,
      requiredStatusOptionIds: [githubProjectOptionId('OPT_missing')],
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: 'PVTF_status',
        missingRequiredStatusOptionIds: ['OPT_missing'],
      },
    })

    rateUsed = 5_001
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
    rateUsed = undefined

    reportedFieldCount = 3
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
    reportedFieldCount = 2

    reportedFirstItemFieldValueCount = 3
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
    reportedFirstItemFieldValueCount = 2

    reportedFirstItemFieldValueCount = 3
    firstItemFieldValuePages = 3
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })
    reportedFirstItemFieldValueCount = 2
    firstItemFieldValuePages = 2

    reportedItemCount = 3
    await expect(ctx.sakiGitHub.scan(scanRequest, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response' },
    })

    reportedItemCount = 2
    rateRemaining = 500
    await expect(ctx.sakiGitHub.scan({ ...scanRequest, priority: 'background' }, new AbortController().signal))
      .rejects.toMatchObject({
        failure: {
          code: 'primary-rate-limit',
          resetAt: Date.parse('2026-08-26T09:00:00Z'),
        },
      })

    rateRemaining = 499
    await expect(ctx.sakiGitHub.scan({ ...scanRequest, priority: 'background' }, new AbortController().signal))
      .rejects.toMatchObject({
        failure: {
          code: 'primary-rate-limit',
          resetAt: Date.parse('2026-08-26T09:00:00Z'),
        },
      })
  })
})
