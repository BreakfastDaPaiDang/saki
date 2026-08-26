import {
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubRepositoryDatabaseId,
} from '@breakfastdapaidang/saki-github'
import type { GitHubInstallationProfile } from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/index.ts'
import {
  GitHubOperationSession,
  PRODUCT_APP_READ_PERMISSIONS,
} from '../src/operation-session.ts'
import { GitHubResponseLimitError } from '../src/errors.ts'
import { InstallationPriorityQueue } from '../src/priority-queue.ts'
import { json, privateKey } from './harness.ts'

const PROFILE: GitHubInstallationProfile = {
  appId: githubAppId('12345'),
  installationId: githubInstallationId('98765'),
  accountId: githubAccountId('O_kgDOBoundAccount'),
  privateKeyRef: 'SAKI_PRODUCT_APP_PRIVATE_KEY' as GitHubInstallationProfile['privateKeyRef'],
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

function authentication(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    token: 'ghs_operation_session_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: PRODUCT_APP_READ_PERMISSIONS,
    repository_selection: 'selected',
    repositories: [{ id: 4_242 }],
    ...overrides,
  }
}

async function create(
  config: ResolvedConfig = CONFIG,
  profile: GitHubInstallationProfile = PROFILE,
  repositoryDatabaseId = githubRepositoryDatabaseId('4242'),
): Promise<GitHubOperationSession> {
  return await GitHubOperationSession.create(
    profile,
    privateKey,
    repositoryDatabaseId,
    config,
    new AbortController().signal,
    new InstallationPriorityQueue(),
    'interactive',
  )
}

async function expectResponseLimitCause(promise: Promise<unknown>): Promise<void> {
  const error: unknown = await promise.catch((failure: unknown) => failure)
  const cause = typeof error === 'object' && error !== null && 'cause' in error
    ? error.cause
    : undefined
  expect(cause).toBeInstanceOf(GitHubResponseLimitError)
}

describe('GitHub operation session admission', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('rejects expired token metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({
      expires_at: '2020-01-02T03:04:05Z',
    }), { status: 201 })))

    await expect(create()).rejects.toMatchObject({ failure: { code: 'auth-unavailable' } })
  })

  it('attributes a missing requested token permission as no access', async () => {
    const { contents: _contents, ...permissions } = PRODUCT_APP_READ_PERMISSIONS
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({ permissions }), { status: 201 })))

    await expect(create()).rejects.toMatchObject({
      failure: { code: 'permission-mismatch', permission: 'contents', required: 'read', observed: 'none' },
    })
  })

  it('rejects an extra token permission at the exact no-access ceiling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({
      permissions: { ...PRODUCT_APP_READ_PERMISSIONS, workflows: 'read' },
    }), { status: 201 })))

    await expect(create()).rejects.toMatchObject({
      failure: { code: 'permission-mismatch', permission: 'workflows', required: 'none', observed: 'read' },
    })
  })

  it('rejects an all-Repositories token for a Repository-bound operation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({
      repository_selection: 'all',
    }), { status: 201 })))

    await expect(create()).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'installation-token-scope' },
    })
  })

  it.each([
    ['omits Repository ids', undefined],
    ['returns another Repository id', [{ id: 4_243 }]],
    ['adds another Repository id', [{ id: 4_242 }, { id: 4_243 }]],
  ])('rejects a selected token that %s', async (_description, repositories) => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({
      repositories,
    }), { status: 201 })))

    await expect(create()).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'installation-token-scope' },
    })
  })

  it.each([
    ['Repository database id', githubRepositoryDatabaseId('9007199254740992'), PROFILE],
    ['installation id', githubRepositoryDatabaseId('4242'), {
      ...PROFILE,
      installationId: githubInstallationId('9007199254740992'),
    }],
  ])('rejects an unsafe numeric %s before authentication', async (_name, repositoryDatabaseId, profile) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(create(CONFIG, profile, repositoryDatabaseId)).rejects.toThrow('exceeds the GitHub SDK numeric range')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a syntactically valid timestamp before the JavaScript epoch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication({
      expires_at: '0001-01-02T03:04:05Z',
    }), { status: 201 })))

    await expect(create()).rejects.toThrow('GitHub returned an invalid timestamp')
  })

  it('admits a numeric content length below the configured byte limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => json(authentication(), {
      status: 201,
      headers: { 'content-length': '1' },
    })))

    await expect(create()).resolves.toMatchObject({
      token: { repositorySelection: 'selected' },
    })
  })

  it.each(['11', 'not-a-decimal'])(
    'rejects and cancels a response with excessive content-length %s',
    async (contentLength) => {
      let cancelled = false
      const body = new ReadableStream<Uint8Array>({
        cancel() { cancelled = true },
      })
      vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(body, {
        status: 201,
        headers: { 'content-length': contentLength },
      })))

      await expectResponseLimitCause(create({ ...CONFIG, maxResponseBytes: 10 }))
      expect(cancelled).toBe(true)
    },
  )

  it('retains the byte-limit failure when response-body cancellation rejects', async () => {
    const body = new ReadableStream<Uint8Array>({
      cancel() { throw new Error('transport already closed') },
    })
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(body, {
      status: 201,
      headers: { 'content-length': '11' },
    })))

    await expectResponseLimitCause(create({ ...CONFIG, maxResponseBytes: 10 }))
  })

  it('retains the byte-limit failure when reader cancellation rejects', async () => {
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(6))
      },
      cancel() { throw new Error('transport already closed') },
    }, { highWaterMark: 0 })
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(body, { status: 201 })))

    await expectResponseLimitCause(create({ ...CONFIG, maxResponseBytes: 10 }))
    expect(pulls).toBe(2)
  })

  it('admits a null response body before Octokit classifies its HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(null, { status: 500 })))

    await expect(create()).rejects.toMatchObject({ status: 500 })
  })

  it('handles a null response body while rejecting a declared excessive length', async () => {
    vi.stubGlobal('fetch', vi.fn(async (): Promise<Response> => new Response(null, {
      status: 201,
      headers: { 'content-length': '11' },
    })))

    await expectResponseLimitCause(create({ ...CONFIG, maxResponseBytes: 10 }))
  })
})
