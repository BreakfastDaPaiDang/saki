import {
  GITHUB_INSTALLATION_REPOSITORY_LIMIT,
  GitHubProviderError,
  githubAccountId,
  githubAppId,
  githubInstallationId,
} from '@breakfastdapaidang/saki-github'
import type { GitHubInstallationProfile } from '@breakfastdapaidang/saki-github'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/index.ts'
import { inspectInstallation, readInstallation } from '../src/installation.ts'
import { GitHubOperationSession } from '../src/operation-session.ts'
import { InstallationPriorityQueue } from '../src/priority-queue.ts'

const RATE_HEADERS = {
  'x-ratelimit-limit': '5,000',
  'x-ratelimit-used': '1',
  'x-ratelimit-remaining': '4,999',
  'x-ratelimit-reset': '1893553445',
  'x-ratelimit-resource': 'core',
}

const PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'write',
  metadata: 'read',
  organization_projects: 'write',
  pull_requests: 'write',
  statuses: 'read',
} as const

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

function installation(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 98_765,
    account: {
      node_id: 'O_kgDOBoundAccount',
      login: 'BreakfastDaPaiDang',
      type: 'Organization',
    },
    repository_selection: 'selected',
    permissions: PERMISSIONS,
    suspended_at: null,
    ...overrides,
  }
}

function repositoryPage(totalCount: number, ids: readonly string[]): Record<string, unknown> {
  return {
    total_count: totalCount,
    repositories: ids.map(node_id => ({ node_id })),
  }
}

function sessionWith(
  installationData: unknown,
  pages: readonly unknown[] = [repositoryPage(1, ['R_kgDOBoundRepository'])],
): GitHubOperationSession {
  let page = 0
  return {
    app: {
      request: vi.fn().mockResolvedValue({ data: installationData, headers: RATE_HEADERS }),
    },
    installation: {
      request: vi.fn(async () => ({ data: pages[page++], headers: RATE_HEADERS })),
    },
    token: {
      expiresAt: Date.parse('2030-01-02T03:04:05Z'),
      permissions: PERMISSIONS,
      repositorySelection: 'selected',
    },
  } as unknown as GitHubOperationSession
}

async function failureOf(
  session: GitHubOperationSession,
  config: ResolvedConfig = CONFIG,
): Promise<GitHubProviderError['failure']> {
  const error = await inspectInstallation(session, PROFILE, config, new AbortController().signal)
    .catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(GitHubProviderError)
  return (error as GitHubProviderError).failure
}

describe('Product App installation inspection', () => {
  it('creates an unscoped operation session for the public installation read', async () => {
    const session = sessionWith(installation())
    const create = vi.spyOn(GitHubOperationSession, 'create').mockResolvedValue(session)

    await expect(readInstallation(
      PROFILE,
      'private-key-fixture',
      CONFIG,
      new AbortController().signal,
      new InstallationPriorityQueue(),
    )).resolves.toMatchObject({ installationId: '98765' })
    expect(create).toHaveBeenCalledWith(
      PROFILE,
      'private-key-fixture',
      undefined,
      CONFIG,
      expect.any(AbortSignal),
      expect.any(InstallationPriorityQueue),
      'interactive',
    )
    create.mockRestore()
  })

  it('rejects a response for another installation identity', async () => {
    await expect(failureOf(sessionWith(installation({ id: 98_766 }))))
      .resolves.toEqual({ code: 'invalid-external-response', operation: 'installation' })
  })

  it('rejects a response for another account identity', async () => {
    await expect(failureOf(sessionWith(installation({
      account: { node_id: 'O_other', login: 'Other', type: 'Organization' },
    })))).resolves.toEqual({
      code: 'permission-mismatch',
      permission: 'installation-account',
      required: 'read',
    })
  })

  it('rejects a suspended installation with an invalid timestamp before authorization', async () => {
    await expect(failureOf(sessionWith(installation({ suspended_at: '0001-01-01T00:00:00Z' }))))
      .resolves.toEqual({ code: 'invalid-external-response', operation: 'installation' })
  })

  it('rejects a suspended installation after admitting its timestamp', async () => {
    await expect(failureOf(sessionWith(installation({ suspended_at: '2026-08-26T08:30:00Z' }))))
      .resolves.toEqual({ code: 'auth-unavailable' })
  })

  it('attributes missing, mismatched, and extra permissions exactly', async () => {
    const { contents: _contents, ...missingContents } = PERMISSIONS
    await expect(failureOf(sessionWith(installation({ permissions: missingContents }))))
      .resolves.toEqual({
        code: 'permission-mismatch',
        permission: 'contents',
        required: 'read',
        observed: 'none',
      })
    await expect(failureOf(sessionWith(installation({ permissions: { ...PERMISSIONS, issues: 'read' } }))))
      .resolves.toEqual({
        code: 'permission-mismatch',
        permission: 'issues',
        required: 'write',
        observed: 'read',
      })
    await expect(failureOf(sessionWith(installation({ permissions: { ...PERMISSIONS, workflows: 'read' } }))))
      .resolves.toEqual({
        code: 'permission-mismatch',
        permission: 'workflows',
        required: 'none',
        observed: 'read',
      })
  })

  it('rejects traversal beyond the configured page cap', async () => {
    await expect(failureOf(
      sessionWith(installation(), [repositoryPage(2, ['R_one'])]),
      { ...CONFIG, pageSize: 1, maxPages: 1 },
    )).resolves.toEqual({ code: 'invalid-external-response', operation: 'installation-repositories' })
  })

  it('rejects a total count that changes between Repository pages', async () => {
    await expect(failureOf(
      sessionWith(installation(), [repositoryPage(2, ['R_one']), repositoryPage(3, ['R_two'])]),
      { ...CONFIG, pageSize: 1 },
    )).resolves.toEqual({ code: 'invalid-external-response', operation: 'installation-repositories' })
  })

  it('does not apply the Project-item cap to installation Repository enumeration', async () => {
    const inspection = await inspectInstallation(
      sessionWith(installation(), [repositoryPage(2, ['R_one', 'R_two'])]),
      PROFILE,
      { ...CONFIG, maxItems: 1 },
      new AbortController().signal,
    )

    expect(inspection.fact.accessibleRepositoryIds).toEqual(['R_one', 'R_two'])
  })

  it('rejects Repository access above the fixed installation admission limit', async () => {
    await expect(failureOf(
      sessionWith(installation(), [repositoryPage(GITHUB_INSTALLATION_REPOSITORY_LIMIT + 1, [])]),
    )).resolves.toEqual({ code: 'invalid-external-response', operation: 'installation-repositories' })
  })

  it('accepts an exact full page when its count completes the connection', async () => {
    const inspection = await inspectInstallation(
      sessionWith(installation({ account: {
        node_id: 'O_kgDOBoundAccount',
        login: 'BreakfastDaPaiDang',
        type: 'User',
      } }), [repositoryPage(1, ['R_one'])]),
      PROFILE,
      { ...CONFIG, pageSize: 1 },
      new AbortController().signal,
    )

    expect(inspection.fact.account.type).toBe('user')
    expect(inspection.fact.accessibleRepositoryIds).toEqual(['R_one'])

    const organization = await inspectInstallation(
      sessionWith(installation()),
      PROFILE,
      CONFIG,
      new AbortController().signal,
    )
    expect(organization.fact.account.type).toBe('organization')
  })

  it('rejects an incomplete Repository connection after its short final page', async () => {
    await expect(failureOf(
      sessionWith(installation(), [repositoryPage(2, ['R_one'])]),
    )).resolves.toEqual({ code: 'invalid-external-response', operation: 'installation-repositories' })
  })
})
