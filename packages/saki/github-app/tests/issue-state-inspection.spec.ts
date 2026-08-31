import { Context } from '@deepseek-ai/cordis'
import type { GitHubIssueStateSetInspection } from '@breakfastdapaidang/saki-github'
import { afterEach, expect, it, vi } from 'vitest'
import { ISSUE, ISSUE_STATE_SET_REQUEST, OBSERVED_AT } from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import { expectedIssueReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('inspects one exact Issue state once without dispatching a mutation', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (new URL(request.url).pathname.includes('/access_tokens')) {
      tokenBody = body
      return json({
        token: 'ghs_issue_state_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedIssueReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    graphqlBodies.push(body)
    return json({ data: issueObservation() })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    const inspection = await ctx.sakiGitHub.inspectMutation<'issue-state-set'>(
      ISSUE_STATE_SET_REQUEST,
      new AbortController().signal,
    )
    const snapshot = {
      issue: ISSUE,
    }
    expect(tokenBody).toMatchObject({
      permissions: expectedIssueReadPermissions,
      repository_ids: [Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies.every(body => String(body.query).includes('query SakiIssueStateInspection'))).toBe(true)
    expect(graphqlBodies.every(body => !String(body.query).includes('mutation '))).toBe(true)
    expect(graphqlBodies.every(body => !String(body.query).includes('rateLimit'))).toBe(true)
    expect(inspection).toEqual({
      snapshot,
      observedAt: OBSERVED_AT,
    })
    expect(inspection.snapshot).not.toHaveProperty('repositoryId')
    expect(inspection.snapshot).not.toHaveProperty('repositoryDatabaseId')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('admits a stable closed Issue observation for lost-ack recovery', async () => {
  const inspection = await runIssueStateInspection(() => issueObservation('CLOSED'))

  expect(inspection.snapshot.issue).toMatchObject({
    id: ISSUE_STATE_SET_REQUEST.issueId,
    state: 'closed',
    repositoryId: ISSUE_STATE_SET_REQUEST.repositoryId,
    repositoryDatabaseId: ISSUE_STATE_SET_REQUEST.repositoryDatabaseId,
  })
})

it('rejects an Issue whose Repository ownership differs from the frozen target', async () => {
  const response = issueObservation('OPEN') as {
    issue: { repository: { id: string } }
  }
  response.issue.repository.id = 'R_other'

  await expect(runIssueStateInspection(() => response)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'issue-state-target' },
  })
})

it.each([
  ['Repository', 'repository'],
  ['Issue', 'issue'],
] as const)('returns a typed not-found failure when the %s node is absent', async (resource, field) => {
  const response = issueObservation() as Record<string, unknown>
  response[field] = null

  await expect(runIssueStateInspection(() => response)).rejects.toMatchObject({
    failure: { code: 'not-found', resource },
  })
})

it('rejects a pre-epoch Issue revision timestamp', async () => {
  const response = issueObservation() as { issue: { updatedAt: string } }
  response.issue.updatedAt = '0000-01-01T00:00:00.000Z'

  await expect(runIssueStateInspection(() => response)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'timestamp' },
  })
})

function issueObservation(state: 'OPEN' | 'CLOSED' = 'OPEN'): unknown {
  return {
    repository: {
      __typename: 'Repository',
      id: ISSUE_STATE_SET_REQUEST.repositoryId,
      databaseId: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId),
      owner: { id: ISSUE_STATE_SET_REQUEST.installation.accountId },
    },
    issue: {
      __typename: 'Issue',
      id: ISSUE_STATE_SET_REQUEST.issueId,
      number: ISSUE.number,
      state,
      title: ISSUE.title,
      url: ISSUE.url,
      updatedAt: new Date(ISSUE.updatedAt).toISOString(),
      repository: {
        id: ISSUE_STATE_SET_REQUEST.repositoryId,
        databaseId: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId),
        owner: { id: ISSUE_STATE_SET_REQUEST.installation.accountId },
      },
    },
  }
}

async function runIssueStateInspection(
  observation: () => unknown,
): Promise<GitHubIssueStateSetInspection> {
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) {
      return json({
        token: 'ghs_issue_state_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedIssueReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    return json({ data: observation() })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    return await ctx.sakiGitHub.inspectMutation<'issue-state-set'>(
      ISSUE_STATE_SET_REQUEST,
      new AbortController().signal,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}
