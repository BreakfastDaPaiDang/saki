import { Context } from '@deepseek-ai/cordis'
import type { GitHubProjectItemAddInspection } from '@breakfastdapaidang/saki-github'
import { afterEach, expect, it, vi } from 'vitest'
import {
  INSTALLATION_PROFILE,
  ISSUE,
  PROJECT_ITEM_ADD_REQUEST,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import type { Config } from '../src/index.ts'
import { expectedProjectReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const OBSERVED_AT = 1_800_000_000_000
const PROJECT_UPDATED_AT = new Date(OBSERVED_AT - 500).toISOString()
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('inspects absent Project membership once without a Project item id', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (url.pathname.includes('/access_tokens')) {
      tokenBody = body
      return inspectionAuthentication()
    }
    graphqlBodies.push(body)
    return json({ data: inspectionData([positionItem('PVTI_other', 'I_other')]) })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, { pageSize: 2 })

  try {
    const inspection = await ctx.sakiGitHub.inspectMutation<'project-item-add'>(
      PROJECT_ITEM_ADD_REQUEST,
      new AbortController().signal,
    )

    expect(tokenBody).toMatchObject({
      permissions: expectedProjectReadPermissions,
      repository_ids: [Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('query SakiProjectItemAddInspection'))
    expect(graphqlBodies.every(body => !String(body.query).includes('mutation'))).toBe(true)
    expect(graphqlBodies.every(body => !String(body.query).includes('rateLimit'))).toBe(true)
    expect(graphqlBodies[0]?.variables).toEqual({
      projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
      repositoryId: PROJECT_ITEM_ADD_REQUEST.repositoryId,
      issueId: PROJECT_ITEM_ADD_REQUEST.issueId,
      first: 2,
      after: null,
    })
    expect(inspection).toMatchObject({
      snapshot: {
        repositoryId: PROJECT_ITEM_ADD_REQUEST.repositoryId,
        repositoryDatabaseId: PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId,
        projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
        issue: { id: PROJECT_ITEM_ADD_REQUEST.issueId },
        membership: { state: 'absent' },
      },
    })
    expect(Object.keys(inspection).sort()).toEqual([
      'observedAt',
      'snapshot',
    ])
    expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('retains the unique active membership identity and archive state', async () => {
  const nodes = [
    positionItem('PVTI_before', 'I_before'),
    positionItem('PVTI_target', PROJECT_ITEM_ADD_REQUEST.issueId),
    positionItem('PVTI_after', 'I_after'),
  ]

  const inspection = await runInspection([inspectionData(nodes)])

  expect(inspection.snapshot.membership).toEqual({
    state: 'present',
    item: {
      id: 'PVTI_target',
      projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
      issueId: PROJECT_ITEM_ADD_REQUEST.issueId,
      archived: false,
    },
  })
})

it('returns a typed conflict when one Project contains duplicate Issue memberships', async () => {
  const nodes = [
    positionItem('PVTI_duplicate_a', PROJECT_ITEM_ADD_REQUEST.issueId),
    positionItem('PVTI_duplicate_b', PROJECT_ITEM_ADD_REQUEST.issueId),
  ]

  const inspection = await runInspection([inspectionData(nodes)])

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'duplicate-conflict',
    items: [
      { id: 'PVTI_duplicate_a' },
      { id: 'PVTI_duplicate_b' },
    ],
  })
})

it('traverses every Project position page once', async () => {
  const before = positionItem('PVTI_before', 'I_before')
  const target = positionItem('PVTI_target', PROJECT_ITEM_ADD_REQUEST.issueId)
  const after = positionItem('PVTI_after', 'I_after')
  const firstPage = inspectionData([before, target], {
    totalCount: 3,
    hasNextPage: true,
    endCursor: 'cursor-1',
  })
  const lastPage = inspectionData([after], { totalCount: 3 })

  const inspection = await runInspection([firstPage, lastPage])

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: {
      id: 'PVTI_target',
    },
  })
})

it('retains archived membership without treating the add acknowledgement as an unarchive', async () => {
  const draft = positionItem('PVTI_draft', 'unused')
  draft.content = { __typename: 'DraftIssue' }
  const target = positionItem('PVTI_target', PROJECT_ITEM_ADD_REQUEST.issueId)
  target.isArchived = true

  const inspection = await runInspection([inspectionData([draft, target])])

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: { id: 'PVTI_target', archived: true },
  })
})

it.each([
  ['Project', 'project'],
  ['Repository', 'repository'],
  ['Issue', 'issue'],
] as const)('rejects a missing %s target', async (resource, key) => {
  const data = inspectionData([])
  data[key] = null

  await expect(runInspection([data])).rejects.toMatchObject({
    failure: { code: 'not-found', resource },
  })
})

it.each([
  ['Project owner', (data: Record<string, unknown>) => {
    object(object(data.project).owner).id = 'O_other'
  }],
  ['Repository database id', (data: Record<string, unknown>) => {
    object(data.repository).databaseId = 6_789
  }],
  ['Issue Repository owner', (data: Record<string, unknown>) => {
    object(object(object(data.issue).repository).owner).id = 'O_other'
  }],
] as const)('rejects mismatched %s ownership', async (_subject, mutate) => {
  const data = inspectionData([])
  mutate(data)

  await expect(runInspection([data])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-target' },
  })
})

it.each([
  ['Project ownership', (item: Record<string, unknown>) => {
    object(item.project).id = 'P_other'
  }],
  ['Issue Repository ownership', (item: Record<string, unknown>) => {
    object(object(item.content).repository).id = 'R_other'
  }],
] as const)('rejects mismatched target-item %s', async (_subject, mutate) => {
  const item = positionItem('PVTI_target', PROJECT_ITEM_ADD_REQUEST.issueId)
  mutate(item)

  await expect(runInspection([inspectionData([item])])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-membership' },
  })
})

it('rejects a Project revision change within one paginated pass', async () => {
  const first = inspectionData([positionItem('PVTI_first', 'I_other')], {
    totalCount: 2,
    hasNextPage: true,
    endCursor: 'cursor-1',
  })
  const second = inspectionData([positionItem('PVTI_second', 'I_other_2')], { totalCount: 2 })
  object(second.project).updatedAt = '2031-01-02T03:04:05Z'

  await expect(runInspection([first, second])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-stability' },
  })
})

it('rejects an Issue revision change within one paginated pass', async () => {
  const first = inspectionData([positionItem('PVTI_first', 'I_other')], {
    totalCount: 2,
    hasNextPage: true,
    endCursor: 'cursor-1',
  })
  const second = inspectionData([positionItem('PVTI_second', 'I_other_2')], { totalCount: 2 })
  object(second.issue).title = 'Changed between pages'

  await expect(runInspection([first, second])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-stability' },
  })
})

it.each([
  ['changed total count', [
    inspectionData([positionItem('PVTI_first', 'I_other')], {
      totalCount: 2,
      hasNextPage: true,
      endCursor: 'cursor-1',
    }),
    inspectionData([positionItem('PVTI_second', 'I_other_2')], { totalCount: 3 }),
  ], {}],
  ['duplicate item id', [
    inspectionData([positionItem('PVTI_same', 'I_other')], {
      totalCount: 2,
      hasNextPage: true,
      endCursor: 'cursor-1',
    }),
    inspectionData([positionItem('PVTI_same', 'I_other_2')], { totalCount: 2 }),
  ], {}],
  ['more nodes than configured', [
    inspectionData([
      positionItem('PVTI_first', 'I_other'),
      positionItem('PVTI_second', 'I_other_2'),
    ], { totalCount: 1 }),
  ], { maxItems: 1 }],
  ['cursor after complete count', [
    inspectionData([positionItem('PVTI_first', 'I_other')], {
      totalCount: 1,
      hasNextPage: true,
      endCursor: 'cursor-1',
    }),
  ], {}],
  ['incomplete terminal page', [
    inspectionData([positionItem('PVTI_first', 'I_other')], { totalCount: 2 }),
  ], {}],
  ['page budget exhaustion', [
    inspectionData([positionItem('PVTI_first', 'I_other')], {
      totalCount: 2,
      hasNextPage: true,
      endCursor: 'cursor-1',
    }),
  ], { maxPages: 1 }],
  ['missing forward cursor', [
    inspectionData([positionItem('PVTI_first', 'I_other')], {
      totalCount: 2,
      hasNextPage: true,
      endCursor: null,
    }),
  ], {}],
] as const)('rejects membership pagination with %s', async (_subject, responses, config) => {
  await expect(runInspection(responses, config)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-membership' },
  })
})

it('rejects a repeated Project membership cursor', async () => {
  const page = inspectionData([positionItem('PVTI_first', 'I_other')], {
    totalCount: 3,
    hasNextPage: true,
    endCursor: 'cursor-1',
  })
  const repeated = inspectionData([positionItem('PVTI_second', 'I_other_2')], {
    totalCount: 3,
    hasNextPage: true,
    endCursor: 'cursor-1',
  })

  await expect(runInspection([page, repeated])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-membership' },
  })
})

it('rejects a syntactically valid Project timestamp before the JavaScript epoch', async () => {
  const data = inspectionData([])
  object(data.project).updatedAt = '0001-01-02T03:04:05Z'

  await expect(runInspection([data])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'timestamp' },
  })
})

it('rejects an Issue membership node that omits its selected identity', async () => {
  const item = positionItem('PVTI_target', PROJECT_ITEM_ADD_REQUEST.issueId)
  const content = item.content as Record<string, unknown>
  delete content.id

  await expect(runInspection([inspectionData([item])])).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-add-membership' },
  })
})

function inspectionData(
  nodes: readonly unknown[],
  page: Readonly<{
    totalCount?: number
    hasNextPage?: boolean
    endCursor?: string | null
  }> = {},
): Record<string, unknown> {
  return {
    project: {
      __typename: 'ProjectV2',
      id: PROJECT_ITEM_ADD_REQUEST.projectId,
      updatedAt: PROJECT_UPDATED_AT,
      owner: { id: INSTALLATION_PROFILE.accountId },
      items: {
        totalCount: page.totalCount ?? nodes.length,
        nodes,
        pageInfo: {
          hasNextPage: page.hasNextPage ?? false,
          endCursor: page.endCursor ?? null,
        },
      },
    },
    repository: {
      __typename: 'Repository',
      id: PROJECT_ITEM_ADD_REQUEST.repositoryId,
      databaseId: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId),
      owner: { id: INSTALLATION_PROFILE.accountId },
    },
    issue: {
      __typename: 'Issue',
      id: PROJECT_ITEM_ADD_REQUEST.issueId,
      number: ISSUE.number,
      state: 'OPEN',
      title: ISSUE.title,
      url: ISSUE.url,
      updatedAt: new Date(ISSUE.updatedAt).toISOString(),
      repository: {
        id: PROJECT_ITEM_ADD_REQUEST.repositoryId,
        databaseId: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId),
        owner: { id: INSTALLATION_PROFILE.accountId },
      },
    },
  }
}

function positionItem(id: string, issueId: string): Record<string, unknown> {
  return {
    __typename: 'ProjectV2Item',
    id,
    isArchived: false,
    project: {
      id: PROJECT_ITEM_ADD_REQUEST.projectId,
      updatedAt: PROJECT_UPDATED_AT,
      owner: { id: INSTALLATION_PROFILE.accountId },
    },
    content: {
      __typename: 'Issue',
      id: issueId,
      repository: {
        id: PROJECT_ITEM_ADD_REQUEST.repositoryId,
        databaseId: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId),
        owner: { id: INSTALLATION_PROFILE.accountId },
      },
    },
  }
}

function inspectionAuthentication(): Response {
  return json({
    token: 'ghs_project_item_add_inspection_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedProjectReadPermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}

async function runInspection(
  responses: readonly Record<string, unknown>[],
  config: Config = {},
): Promise<GitHubProjectItemAddInspection> {
  let responseIndex = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return inspectionAuthentication()
    const response = responses[responseIndex++]
    if (response === undefined) throw new Error('unexpected Project membership inspection request')
    return json({ data: response })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, { pageSize: 2, ...config })
  try {
    return await ctx.sakiGitHub.inspectMutation<'project-item-add'>(
      PROJECT_ITEM_ADD_REQUEST,
      new AbortController().signal,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object fixture')
  }
  return value as Record<string, unknown>
}
