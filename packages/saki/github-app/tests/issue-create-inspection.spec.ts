import { Context } from '@deepseek-ai/cordis'
import type { GitHubIssueCreateRequest } from '@breakfastdapaidang/saki-github'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ISSUE,
  ISSUE_CREATE_REQUEST,
  OBSERVED_AT,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import { expectedIssueReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('inspects a unique closed Issue by exact marker with one complete read-only traversal', async () => {
  const result = await runInspection(() => ({ entries: [issueEntry({ state: 'closed' })] }))
  const { inspection } = result

  expect(result.tokenBody).toMatchObject({
    permissions: expectedIssueReadPermissions,
    repository_ids: [Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId)],
  })
  expect(result.graphqlBodies).toHaveLength(1)
  expect(result.graphqlBodies[0]?.query).toEqual(expect.stringContaining('query SakiIssueCreateRepository'))
  expect(result.graphqlBodies[0]?.query).not.toEqual(expect.stringContaining('mutation '))
  expect(result.graphqlBodies[0]?.query).not.toEqual(expect.stringContaining('rateLimit'))
  expect(result.restRequests).toHaveLength(1)
  for (const request of result.restRequests) {
    const url = new URL(request.url)
    expect(url.pathname).toBe('/repos/breakfast/saki/issues')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      state: 'all',
      sort: 'created',
      direction: 'asc',
      per_page: '50',
      page: '1',
    })
    expect(request.headers.get('accept')).toContain('application/vnd.github.raw+json')
  }
  expect(inspection.snapshot).toMatchObject({
    repositoryId: ISSUE_CREATE_REQUEST.repositoryId,
    repositoryDatabaseId: ISSUE_CREATE_REQUEST.repositoryDatabaseId,
    outcome: {
      state: 'unique-issue',
      issue: { id: ISSUE.id, number: ISSUE.number, state: 'closed' },
    },
  })
  expect(inspection.snapshot).not.toHaveProperty('markerId')
  expect(inspection.snapshot).not.toHaveProperty('inspectionHint')
  expect(Object.keys(inspection).sort()).toEqual([
    'observedAt',
    'snapshot',
  ])
  expect(JSON.stringify(inspection)).not.toContain(ISSUE_CREATE_REQUEST.body)
  expect(JSON.stringify(inspection)).not.toContain('ghs_issue_create_inspection_fixture')
})

it.each([
  ['complete absence', () => [] as unknown[], 'absent-complete'],
  ['a pull request marker', () => [issueEntry({ nodeId: 'PR_entry', pullRequest: true })], 'pull-request-marker-match'],
  ['one body containing the marker twice', () => [issueEntry({
    body: `${ISSUE_CREATE_REQUEST.body}${exactMarker()}\n`,
  })], 'multiple-matches'],
  ['two marker-bearing entries', () => [
    issueEntry(),
    issueEntry({ id: 124, nodeId: 'I_other', number: ISSUE.number + 1, url: `${ISSUE.url}-other` }),
  ], 'multiple-matches'],
] as const)('classifies %s without dispatching', async (_subject, entries, expectedState) => {
  const { inspection, graphqlBodies } = await runInspection(() => ({ entries: entries() }))

  expect(inspection.snapshot.outcome).toEqual({ state: expectedState })
  expect(graphqlBodies.every(body => !String(body.query).includes('mutation '))).toBe(true)
})

it('returns identity-conflict when the marker-bearing Issue reuses the hinted id at another number', async () => {
  const request = {
    ...ISSUE_CREATE_REQUEST,
    inspectionHint: { issueId: ISSUE.id, issueNumber: ISSUE.number },
  }
  const { inspection } = await runInspection(() => ({
    entries: [issueEntry({ number: ISSUE.number + 1 })],
  }), { request })

  expect(inspection.snapshot.outcome).toEqual({ state: 'identity-conflict' })
})

it.each([
  ['marker removed', [issueEntry({ body: 'marker removed\n' })], 'marker-removed'],
  ['known Issue absent', [], 'known-issue-absent'],
  ['marker moved to another Issue', [issueEntry({ id: 124, nodeId: 'I_other', number: ISSUE.number + 1 })], 'identity-conflict'],
] as const)('classifies a known-Issue hint when the %s', async (_subject, entries, expectedState) => {
  const request = {
    ...ISSUE_CREATE_REQUEST,
    inspectionHint: { issueId: ISSUE.id, issueNumber: ISSUE.number },
  }
  const { inspection } = await runInspection(() => ({ entries: [...entries] }), { request })

  expect(inspection.snapshot.outcome).toEqual({ state: expectedState })
})

it.each([
  ['page limit', { maxPages: 1, pageSize: 1 }, () => ({
    entries: [issueEntry({ body: null })],
    link: nextLink(2, 1),
  })],
  ['item limit', { maxItems: 1 }, () => ({
    entries: [issueEntry({ body: null }), issueEntry({ id: 124, nodeId: 'I_other', number: 28, body: null })],
  })],
  ['invalid pagination', {}, () => ({
    entries: [issueEntry({ body: null })],
    link: nextLink(3, 50),
  })],
] as const)('returns an incomplete classification at the %s boundary', async (_subject, config, page) => {
  const { inspection } = await runInspection(page, { config })

  expect(inspection.snapshot.outcome).toEqual({ state: 'incomplete' })
})

it('classifies a duplicate entry as incomplete instead of marker multiplicity', async () => {
  const duplicate = issueEntry({ body: null })
  const { inspection } = await runInspection(() => ({ entries: [duplicate, duplicate] }))

  expect(inspection.snapshot.outcome).toEqual({ state: 'incomplete' })
})

it('follows only a proved next page while issuing the provider-owned fixed route', async () => {
  const { inspection, restRequests } = await runInspection((_call, url) => {
    const page = Number(url.searchParams.get('page'))
    return page === 1
      ? {
        entries: [issueEntry({ body: null })],
        link: '<https://api.github.com/repos/breakfast/saki/issues?per_page=1&page=2>; rel=next',
      }
      : { entries: [issueEntry({ id: 124, nodeId: 'I_other', number: 28 })] }
  }, { config: { pageSize: 1 } })

  expect(inspection.snapshot.outcome.state).toBe('unique-issue')
  expect(restRequests.map(request => new URL(request.url).searchParams.get('page'))).toEqual(['1', '2'])
})

it.each([
  ['a non-next relation', '<https://api.github.com/repositories/67890/issues?per_page=50&page=1>; rel="last"'],
  ['an unrelated attribute', '<https://api.github.com/repositories/67890/issues?per_page=50&page=1>; title="last"'],
  ['an empty relation', '<https://api.github.com/repositories/67890/issues?per_page=50&page=1>; rel=""'],
] as const)('treats Link with %s as terminal', async (_subject, link) => {
  const { inspection } = await runInspection(() => ({ entries: [], link }))

  expect(inspection.snapshot.outcome.state).toBe('absent-complete')
})

it.each([
  ['malformed segment', 'not-a-link'],
  ['malformed attribute', '<https://api.github.com/repositories/67890/issues?per_page=50&page=2>; broken'],
  ['duplicate rel', '<https://api.github.com/repositories/67890/issues?per_page=50&page=2>; rel="next"; rel="last"'],
  ['two next links', `${nextLink(2, 50)}, ${nextLink(2, 50)}`],
  ['invalid URL', '<not a url>; rel="next"'],
  ['non-HTTPS URL', '<http://api.github.com/repositories/67890/issues?per_page=50&page=2>; rel="next"'],
  ['other host', '<https://example.com/repositories/67890/issues?per_page=50&page=2>; rel="next"'],
  ['credentials', '<https://user:pass@api.github.com/repositories/67890/issues?per_page=50&page=2>; rel="next"'],
  ['fragment', '<https://api.github.com/repositories/67890/issues?per_page=50&page=2#private>; rel="next"'],
  ['other path', '<https://api.github.com/repos/breakfast/other/issues?per_page=50&page=2>; rel="next"'],
  ['duplicate page', '<https://api.github.com/repositories/67890/issues?per_page=50&page=2&page=2>; rel="next"'],
  ['missing per-page', '<https://api.github.com/repositories/67890/issues?page=2>; rel="next"'],
  ['skipped page', '<https://api.github.com/repositories/67890/issues?per_page=50&page=3>; rel="next"'],
  ['other per-page', '<https://api.github.com/repositories/67890/issues?per_page=51&page=2>; rel="next"'],
  ['other state', '<https://api.github.com/repositories/67890/issues?state=open&per_page=50&page=2>; rel="next"'],
  ['duplicate sort', '<https://api.github.com/repositories/67890/issues?sort=created&sort=created&per_page=50&page=2>; rel="next"'],
  ['other direction', '<https://api.github.com/repositories/67890/issues?direction=desc&per_page=50&page=2>; rel="next"'],
] as const)('returns pagination-incomplete evidence for %s', async (_subject, link) => {
  const { inspection } = await runInspection(() => ({ entries: [], link }))

  expect(inspection.snapshot.outcome).toEqual({ state: 'incomplete' })
})

it('uses exact marker matching and does not accept a similar comment', async () => {
  const { inspection } = await runInspection(() => ({
    entries: [issueEntry({ body: `<!-- saki-work-item:${ISSUE_CREATE_REQUEST.markerId}-suffix -->\n` })],
  }))

  expect(inspection.snapshot.outcome.state).toBe('absent-complete')
})

it.each([
  [ISSUE.id, ISSUE.number + 1],
  ['I_other', ISSUE.number],
] as const)('returns identity-conflict for a known non-marker entry %s/%s', async (nodeId, number) => {
  const request = {
    ...ISSUE_CREATE_REQUEST,
    inspectionHint: { issueId: ISSUE.id, issueNumber: ISSUE.number },
  }
  const { inspection } = await runInspection(() => ({
    entries: [issueEntry({ nodeId, number, body: 'marker removed\n' })],
  }), { request })

  expect(inspection.snapshot.outcome.state).toBe('identity-conflict')
})

it('rejects a pre-epoch REST Issue timestamp', async () => {
  const entry = issueEntry() as { created_at: string }
  entry.created_at = '0000-01-01T00:00:00.000Z'

  await expect(runInspection(() => ({ entries: [entry] }))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'issue-create-inspection' },
  })
})

it('returns a typed not-found failure when the Repository node is absent', async () => {
  await expect(runInspection(() => ({ entries: [] }), { repositoryAbsent: true })).rejects.toMatchObject({
    failure: { code: 'not-found', resource: 'Repository' },
  })
})

it('rejects repository ownership drift before REST traversal', async () => {
  await expect(runInspection(() => ({ entries: [] }), {
    repositoryOverride: { owner: { id: 'O_other' } },
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'issue-create-repository' },
  })
})

interface EntryOptions {
  readonly id?: number
  readonly nodeId?: string
  readonly number?: number
  readonly state?: 'open' | 'closed'
  readonly body?: string | null
  readonly url?: string
  readonly pullRequest?: boolean
}

function issueEntry(options: EntryOptions = {}): Record<string, unknown> {
  return {
    id: options.id ?? 123,
    node_id: options.nodeId ?? ISSUE.id,
    number: options.number ?? ISSUE.number,
    state: options.state ?? 'open',
    title: ISSUE.title,
    body: options.body === undefined ? ISSUE_CREATE_REQUEST.body : options.body,
    html_url: options.url ?? ISSUE.url,
    created_at: new Date(ISSUE.updatedAt - 1_000).toISOString(),
    updated_at: new Date(ISSUE.updatedAt).toISOString(),
    ...(options.pullRequest ? { pull_request: { url: `${ISSUE.url}/pull` } } : {}),
  }
}

function exactMarker(): string {
  return `<!-- saki-work-item:${ISSUE_CREATE_REQUEST.markerId} -->`
}

function nextLink(page: number, perPage: number): string {
  return `<https://api.github.com/repositories/${ISSUE_CREATE_REQUEST.repositoryDatabaseId}/issues?state=all&sort=created&direction=asc&per_page=${perPage}&page=${page}>; rel="next"`
}

interface InspectionPage {
  readonly entries: readonly unknown[]
  readonly link?: string | undefined
}

interface RunOptions {
  readonly request?: GitHubIssueCreateRequest
  readonly config?: Record<string, number>
  readonly repositoryOverride?: Record<string, unknown>
  readonly repositoryAbsent?: boolean
}

async function runInspection(
  page: (restCall: number, url: URL) => InspectionPage,
  options: RunOptions = {},
) {
  const request = options.request ?? ISSUE_CREATE_REQUEST
  const graphqlBodies: Array<Record<string, unknown>> = []
  const restRequests: Request[] = []
  let tokenBody: Record<string, unknown> | undefined
  let restCall = 0
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const externalRequest = new Request(input, init)
    const url = new URL(externalRequest.url)
    if (url.pathname.includes('/access_tokens')) {
      tokenBody = JSON.parse(await externalRequest.text()) as Record<string, unknown>
      return json({
        token: 'ghs_issue_create_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedIssueReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(request.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    if (url.pathname === '/graphql') {
      graphqlBodies.push(JSON.parse(await externalRequest.text()) as Record<string, unknown>)
      return json({ data: repositoryObservation(options.repositoryOverride, options.repositoryAbsent === true) })
    }
    restRequests.push(externalRequest)
    restCall += 1
    const response = page(restCall, url)
    return json(response.entries, {
      headers: {
        ...(response.link === undefined ? {} : { link: response.link }),
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, options.config ?? {})
  try {
    const inspection = await ctx.sakiGitHub.inspectMutation<'issue-create'>(request, new AbortController().signal)
    return { inspection, graphqlBodies, restRequests, tokenBody }
  } finally {
    await ctx.fiber.dispose()
  }
}

function repositoryObservation(
  override: Record<string, unknown> = {},
  absent = false,
): Record<string, unknown> {
  return {
    repository: absent ? null : {
      __typename: 'Repository',
      id: ISSUE_CREATE_REQUEST.repositoryId,
      databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
      nameWithOwner: 'breakfast/saki',
      owner: { id: ISSUE_CREATE_REQUEST.installation.accountId },
      ...override,
    },
  }
}
