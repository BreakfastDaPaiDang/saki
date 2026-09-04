import { Context } from '@deepseek-ai/cordis'
import {
  githubCommitId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SakiGitHubApp from '../src/index.ts'
import { json, privateKey, TestCredentials } from './harness.ts'

const REPOSITORY_ID = githubRepositoryId('R_kgDOOfficialUpstream')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('9001')
const COMMIT_ID = githubCommitId('a'.repeat(40))
const REQUEST = {
  kind: 'public-commit' as const,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  repositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
  commitId: COMMIT_ID,
}

describe('public exact Commit read', () => {
  const contexts: Context[] = []

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  })

  it('verifies the public Repository identity before reading the exact Commit without a credential', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_788_230_400_000)
    const paths: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init)
      expect(request.headers.get('authorization')).toBeNull()
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path === '/repos/deepseek-ai/deepseek-harness') return json(repository())
      if (path === `/repos/deepseek-ai/deepseek-harness/git/commits/${COMMIT_ID}`) return json(commit())
      throw new Error(`unexpected GitHub request: ${request.method} ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const { github, credentials } = await provider(contexts)

    await expect(github.read(REQUEST, new AbortController().signal)).resolves.toEqual({
      id: COMMIT_ID,
      repositoryId: REPOSITORY_ID,
      url: `https://github.com/deepseek-ai/deepseek-harness/commit/${COMMIT_ID}`,
      committedAt: Date.parse('2026-09-01T01:02:03Z'),
      observedAt: 1_788_230_400_000,
    })
    expect(paths).toEqual([
      '/repos/deepseek-ai/deepseek-harness',
      `/repos/deepseek-ai/deepseek-harness/git/commits/${COMMIT_ID}`,
    ])
    expect(credentials.resolveCalls).toBe(0)
  })

  it.each([
    ['node identity', { node_id: 'R_other' }],
    ['database identity', { id: 9002 }],
    ['canonical name', { full_name: 'deepseek-ai/renamed-harness' }],
    ['visibility', { private: true, visibility: 'private' }],
  ])('rejects a mismatched public Repository %s', async (_label, override) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(repository(override))))
    const { github } = await provider(contexts)

    await expect(github.read(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'public-commit' },
    })
  })

  it.each([
    ['resolved abbreviation', { sha: 'b'.repeat(40) }],
    ['missing committer', { committer: null }],
    ['malformed commit time', { committer: { date: 'not-a-date' } }],
    ['pre-epoch commit time', { committer: { date: '1969-12-31T23:59:59Z' } }],
  ])('rejects an inexact Commit response: %s', async (_label, override) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(new Request(input).url).pathname
      return path === '/repos/deepseek-ai/deepseek-harness' ? json(repository()) : json(commit(override))
    }))
    const { github } = await provider(contexts)

    await expect(github.read(REQUEST, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'public-commit' },
    })
  })
})

async function provider(contexts: Context[]): Promise<{
  readonly github: SakiGitHubApp
  readonly credentials: TestCredentials
}> {
  const ctx = new Context()
  contexts.push(ctx)
  const credentials = new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp)
  return { github: ctx.sakiGitHub as SakiGitHubApp, credentials }
}

function repository(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 9_001,
    node_id: REPOSITORY_ID,
    full_name: 'deepseek-ai/deepseek-harness',
    private: false,
    visibility: 'public',
    ...overrides,
  }
}

function commit(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    sha: COMMIT_ID,
    html_url: `https://github.com/deepseek-ai/deepseek-harness/commit/${COMMIT_ID}`,
    committer: { date: '2026-09-01T01:02:03Z' },
    ...overrides,
  }
}
