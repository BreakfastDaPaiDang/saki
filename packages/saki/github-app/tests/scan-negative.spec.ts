import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  GITHUB_PROJECT_BOARD_FIELD_LIMIT,
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type { GitHubProjectBoardScanRequest } from '@breakfastdapaidang/saki-github'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/index.ts'
import { GitHubOperationSession } from '../src/operation-session.ts'
import { InstallationPriorityQueue } from '../src/priority-queue.ts'
import { scanProjectBoard } from '../src/scan.ts'

const RATE_HEADERS = {
  'x-ratelimit-limit': '5,000',
  'x-ratelimit-used': '1',
  'x-ratelimit-remaining': '4,999',
  'x-ratelimit-reset': '1893553445',
  'x-ratelimit-resource': 'core',
}

const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: '2026-08-26T09:00:00Z',
}

const INSTALLATION_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'write',
  metadata: 'read',
  organization_projects: 'write',
  pull_requests: 'write',
  statuses: 'read',
} as const

const REQUEST: GitHubProjectBoardScanRequest = {
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
  priority: 'interactive',
  rateLimitReserve: 500,
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

const PAGE_END = { hasNextPage: false, endCursor: null }

function fenceData(options: {
  readonly projectId?: string
  readonly repositoryId?: string
  readonly repositoryDatabaseId?: string
  readonly projectUpdatedAt?: string
  readonly repositoryUpdatedAt?: string
  readonly itemCount?: number
  readonly issueCount?: number
} = {}): Record<string, unknown> {
  return {
    project: {
      __typename: 'ProjectV2',
      id: options.projectId ?? REQUEST.projectId,
      number: 1,
      title: 'Saki 0.1.0',
      closed: false,
      url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
      updatedAt: options.projectUpdatedAt ?? '2026-08-26T08:00:00Z',
      owner: { id: 'O_kgDOBoundAccount' },
      items: { totalCount: options.itemCount ?? 0 },
    },
    repository: {
      __typename: 'Repository',
      id: options.repositoryId ?? REQUEST.repositoryId,
      databaseId: options.repositoryDatabaseId ?? REQUEST.repositoryDatabaseId,
      nameWithOwner: 'BreakfastDaPaiDang/saki',
      visibility: 'PUBLIC',
      url: 'https://github.com/BreakfastDaPaiDang/saki',
      updatedAt: options.repositoryUpdatedAt ?? '2026-08-26T08:00:00Z',
      owner: { id: 'O_kgDOBoundAccount' },
      issues: { totalCount: options.issueCount ?? 0 },
    },
    rateLimit: RATE_LIMIT,
  }
}

function statusField(options: unknown = [{ id: 'OPT_ready', name: 'Ready' }]): Record<string, unknown> {
  return {
    __typename: 'ProjectV2SingleSelectField',
    id: REQUEST.statusFieldId,
    name: 'Status',
    options,
  }
}

function fieldsData(
  nodes: readonly unknown[] = [statusField()],
  totalCount = nodes.length,
  pageInfo: Readonly<Record<string, unknown>> = PAGE_END,
  projectId: string = REQUEST.projectId,
): Record<string, unknown> {
  return {
    project: {
      __typename: 'ProjectV2',
      id: projectId,
      fields: { totalCount, nodes, pageInfo },
    },
    rateLimit: RATE_LIMIT,
  }
}

function item(
  id: string,
  content: unknown = null,
  fieldValues: Readonly<Record<string, unknown>> = { totalCount: 0, nodes: [], pageInfo: PAGE_END },
): Record<string, unknown> {
  return {
    id,
    isArchived: false,
    updatedAt: '2026-08-26T08:02:00Z',
    content,
    fieldValues,
  }
}

function itemsData(
  nodes: readonly unknown[] = [],
  pageInfo: Readonly<Record<string, unknown>> = PAGE_END,
  projectId: string = REQUEST.projectId,
): Record<string, unknown> {
  return {
    project: { __typename: 'ProjectV2', id: projectId, items: { nodes, pageInfo } },
    rateLimit: RATE_LIMIT,
  }
}

function fieldValuesData(
  totalCount: number,
  nodes: readonly unknown[],
  pageInfo: Readonly<Record<string, unknown>> = PAGE_END,
  itemId = 'PVTI_one',
): Record<string, unknown> {
  return {
    item: {
      __typename: 'ProjectV2Item',
      id: itemId,
      fieldValues: { totalCount, nodes, pageInfo },
    },
    rateLimit: RATE_LIMIT,
  }
}

function issue(id: string, number: number): Record<string, unknown> {
  return {
    id,
    number,
    state: 'OPEN',
    title: `Issue ${number}`,
    url: `https://github.com/BreakfastDaPaiDang/saki/issues/${number}`,
    updatedAt: '2026-08-26T08:03:00Z',
    repository: { id: REQUEST.repositoryId, databaseId: REQUEST.repositoryDatabaseId },
  }
}

function issuesData(
  nodes: readonly unknown[] = [],
  pageInfo: Readonly<Record<string, unknown>> = PAGE_END,
  repositoryId: string = REQUEST.repositoryId,
  repositoryDatabaseId: string = REQUEST.repositoryDatabaseId,
): Record<string, unknown> {
  return {
    repository: {
      __typename: 'Repository',
      id: repositoryId,
      databaseId: repositoryDatabaseId,
      issues: { nodes, pageInfo },
    },
    rateLimit: RATE_LIMIT,
  }
}

function pass(
  options: {
    readonly fields?: unknown
    readonly items?: unknown
    readonly issues?: unknown
    readonly before?: unknown
    readonly after?: unknown
  } = {},
): readonly unknown[] {
  return [
    options.before ?? fenceData(),
    options.fields ?? fieldsData(),
    options.items ?? itemsData(),
    options.issues ?? issuesData(),
    options.after ?? fenceData(),
  ]
}

function installSession(graphqlResponses: readonly unknown[]): void {
  const pending = [...graphqlResponses]
  const installationRequest = vi.fn(async (route: string) => {
    if (route === 'GET /installation/repositories') {
      return {
        data: { total_count: 1, repositories: [{ node_id: REQUEST.repositoryId }] },
        headers: RATE_HEADERS,
      }
    }
    const data = pending.shift()
    if (data === undefined) throw new Error('unexpected GraphQL request')
    return { data: { data }, headers: {} }
  })
  vi.spyOn(GitHubOperationSession, 'create').mockResolvedValue({
    app: {
      request: vi.fn().mockResolvedValue({
        data: {
          id: 98_765,
          account: { node_id: 'O_kgDOBoundAccount', login: 'BreakfastDaPaiDang', type: 'Organization' },
          repository_selection: 'selected',
          permissions: INSTALLATION_PERMISSIONS,
          suspended_at: null,
        },
        headers: RATE_HEADERS,
      }),
    },
    installation: { request: installationRequest },
    token: {
      expiresAt: Date.parse('2030-01-02T03:04:05Z'),
      permissions: {},
      repositorySelection: 'selected',
    },
  } as unknown as GitHubOperationSession)
}

async function scan(
  responses: readonly unknown[],
  config: ResolvedConfig = CONFIG,
): Promise<unknown> {
  installSession(responses)
  return await scanProjectBoard(
    REQUEST,
    'private-key-fixture',
    config,
    new AbortController().signal,
    new InstallationPriorityQueue(),
  )
}

function expectInvalid(promise: Promise<unknown>, operation: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation },
  })
}

describe('complete Project Board scan rejection paths', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    ['Project id', { projectId: 'PVT_other' }],
    ['Repository id', { repositoryId: 'R_other' }],
    ['Repository database id', { repositoryDatabaseId: '4243' }],
  ])('rejects a substituted fence %s', async (_description, override) => {
    await expectInvalid(scan([fenceData(override)]), 'project-board-fence')
  })

  it('rejects a substituted Project on a fields page', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData(undefined, undefined, undefined, 'PVT_other'),
    ]), 'project-fields')
  })

  it('rejects a before/after fence change within one pass', async () => {
    await expectInvalid(scan(pass({
      after: fenceData({ projectUpdatedAt: '2026-08-26T08:00:01Z' }),
    })), 'project-board-fence')
  })

  it('rejects field traversal past the page cap', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField()], 2, { hasNextPage: true, endCursor: 'fields-1' }),
    ], { ...CONFIG, maxPages: 1 }), 'project-fields')
  })

  it('rejects a changed field count', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField()], 2, { hasNextPage: true, endCursor: 'fields-1' }),
      fieldsData([{ __typename: 'ProjectV2Field', id: 'PVTF_other', name: 'Other', dataType: 'TEXT' }], 3),
    ]), 'project-fields')
  })

  it('rejects Project fields above the fixed candidate admission limit', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([], GITHUB_PROJECT_BOARD_FIELD_LIMIT + 1),
    ]), 'project-fields')
  })

  it('does not apply the Project-item cap to Project field enumeration', async () => {
    const fields = fieldsData([
      statusField(),
      { __typename: 'ProjectV2Field', id: 'PVTF_other', name: 'Other', dataType: 'TEXT' },
    ], 2)
    const responses = pass({ fields })

    await expect(scan([...responses, ...responses], { ...CONFIG, maxItems: 1 }))
      .resolves.toMatchObject({ fields: [{ id: REQUEST.statusFieldId }, { id: 'PVTF_other' }] })
  })

  it('projects absent field options and data types before mapping validation', async () => {
    await expect(scan([
      fenceData(),
      fieldsData([{
        __typename: 'ProjectV2SingleSelectField',
        id: REQUEST.statusFieldId,
        name: 'Status',
      }]),
    ])).rejects.toMatchObject({
      failure: { code: 'mapping-mismatch', reason: 'required-options-missing' },
    })

    const fields = fieldsData([
      statusField(),
      { __typename: 'ProjectV2Field', id: 'PVTF_text', name: 'Text' },
    ])
    const responses = pass({ fields })
    installSession([...responses, ...responses])
    const candidate = await scanProjectBoard(
      REQUEST,
      'key',
      CONFIG,
      new AbortController().signal,
      new InstallationPriorityQueue(),
    )
    expect(candidate.fields).toContainEqual(expect.objectContaining({
      kind: 'field', id: 'PVTF_text', dataType: 'ProjectV2Field',
    }))
  })

  it('rejects more field nodes than the reported total', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField()], 0),
    ]), 'project-fields')
  })

  it('rejects item traversal past the page cap', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData(),
      itemsData([], { hasNextPage: true, endCursor: 'items-1' }),
    ], { ...CONFIG, maxPages: 1 }), 'project-items')
  })

  it('rejects a substituted Project on an items page', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData(),
      itemsData(undefined, undefined, 'PVT_other'),
    ]), 'project-items')
  })

  it('rejects field-value totals above the scan cap or below the returned node count', async () => {
    await expectInvalid(scan([
      fenceData({ itemCount: 1 }),
      fieldsData(),
      itemsData([item('PVTI_one', null, { totalCount: 2, nodes: [], pageInfo: PAGE_END })]),
    ], { ...CONFIG, maxFieldValues: 1 }), 'project-item-field-values')

    await expectInvalid(scan([
      fenceData({ itemCount: 1 }),
      fieldsData(),
      itemsData([item('PVTI_one', null, {
        totalCount: 0,
        nodes: [{ __typename: 'OtherValue' }],
        pageInfo: PAGE_END,
      })]),
    ]), 'project-item-field-values')
  })

  it('rejects nested field-value total drift and overshoot', async () => {
    const initial = itemsData([item('PVTI_one', null, {
      totalCount: 1,
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'values-1' },
    })])
    await expectInvalid(scan([
      fenceData({ itemCount: 1 }), fieldsData(), initial,
      fieldValuesData(2, [{ __typename: 'OtherValue' }]),
    ]), 'project-item-field-values')

    await expectInvalid(scan([
      fenceData({ itemCount: 1 }), fieldsData(), initial,
      fieldValuesData(1, [{ __typename: 'OtherOne' }, { __typename: 'OtherTwo' }]),
    ]), 'project-item-field-values')
  })

  it('rejects a substituted Project item on a nested field-values page', async () => {
    const initial = itemsData([item('PVTI_one', null, {
      totalCount: 1,
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'values-1' },
    })])
    await expectInvalid(scan([
      fenceData({ itemCount: 1 }),
      fieldsData(),
      initial,
      fieldValuesData(1, [{ __typename: 'OtherValue' }], undefined, 'PVTI_other'),
    ]), 'project-item-field-values')
  })

  it('rejects Project items above the item cap', async () => {
    await expectInvalid(scan([
      fenceData({ itemCount: 2 }),
      fieldsData(),
      itemsData([item('PVTI_one'), item('PVTI_two')]),
    ], { ...CONFIG, maxItems: 1 }), 'project-items')
  })

  it('rejects open-Issue traversal past the page cap and item cap', async () => {
    await expectInvalid(scan([
      fenceData({ issueCount: 1 }),
      fieldsData(),
      itemsData(),
      issuesData([issue('I_one', 1)], { hasNextPage: true, endCursor: 'issues-1' }),
    ], { ...CONFIG, maxPages: 1 }), 'open-issues')

    await expectInvalid(scan([
      fenceData({ issueCount: 2 }),
      fieldsData(),
      itemsData(),
      issuesData([issue('I_one', 1), issue('I_two', 2)]),
    ], { ...CONFIG, maxItems: 1 }), 'open-issues')
  })

  it.each([
    ['node id', 'R_other', REQUEST.repositoryDatabaseId],
    ['database id', REQUEST.repositoryId, '4243'],
  ])('rejects a substituted Repository %s on an open-Issues page', async (
    _description,
    repositoryId,
    repositoryDatabaseId,
  ) => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData(),
      itemsData(),
      issuesData(undefined, undefined, repositoryId, repositoryDatabaseId),
    ]), 'open-issues')
  })

  it('rejects duplicate configured options and duplicate item Status values', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField([
        { id: 'OPT_ready', name: 'Ready' },
        { id: 'OPT_ready', name: 'Ready duplicate' },
      ])]),
    ]), 'configured-status-options')

    const statusValue = {
      __typename: 'ProjectV2ItemFieldSingleSelectValue',
      optionId: 'OPT_ready',
      field: { id: REQUEST.statusFieldId },
    }
    await expectInvalid(scan([
      fenceData({ itemCount: 1 }),
      fieldsData(),
      itemsData([item('PVTI_one', null, {
        totalCount: 2,
        nodes: [statusValue, statusValue],
        pageInfo: PAGE_END,
      })]),
    ]), 'project-item-status')
  })

  it('projects every admitted non-Issue content variant in both stable passes', async () => {
    const nodes = [
      item('PVTI_redacted'),
      item('PVTI_pr_empty', { __typename: 'PullRequest', id: 'PR_empty' }),
      item('PVTI_pr_null', { __typename: 'PullRequest', id: 'PR_null', repository: null }),
      item('PVTI_pr_full', {
        __typename: 'PullRequest',
        id: 'PR_full',
        repository: { id: REQUEST.repositoryId },
        url: 'https://github.com/BreakfastDaPaiDang/saki/pull/1',
      }),
      item('PVTI_draft', { __typename: 'DraftIssue', title: 'Draft' }),
      item('PVTI_other', { __typename: 'FutureContent' }),
    ]
    const onePass = pass({
      before: fenceData({ itemCount: nodes.length }),
      items: itemsData(nodes),
      after: fenceData({ itemCount: nodes.length }),
    })
    const candidate = await scan([...onePass, ...onePass])
    expect(candidate).toMatchObject({
      items: [
        { content: { kind: 'redacted' } },
        { content: { kind: 'pull-request', id: 'PR_empty' } },
        { content: { kind: 'pull-request', id: 'PR_null' } },
        { content: { kind: 'pull-request', id: 'PR_full', repositoryId: REQUEST.repositoryId } },
        { content: { kind: 'draft-issue', title: 'Draft' } },
        { content: { kind: 'other', typeName: 'FutureContent' } },
      ],
    })
  })

  it.each([
    ['Pull Request id', { __typename: 'PullRequest' }],
    ['Draft Issue title', { __typename: 'DraftIssue' }],
  ])('rejects missing %s content', async (_description, content) => {
    await expectInvalid(scan([
      fenceData({ itemCount: 1 }),
      fieldsData(),
      itemsData([item('PVTI_one', content)]),
    ]), 'project-item-content')
  })

  it('rejects missing and repeated pagination cursors', async () => {
    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField()], 1, { hasNextPage: true, endCursor: null }),
    ]), 'project-fields')

    await expectInvalid(scan([
      fenceData(),
      fieldsData([statusField()], 2, { hasNextPage: true, endCursor: 'fields-1' }),
      fieldsData([{ __typename: 'ProjectV2Field', id: 'PVTF_other', name: 'Other', dataType: 'TEXT' }], 2, {
        hasNextPage: true,
        endCursor: 'fields-1',
      }),
    ]), 'project-fields')
  })

  it('rejects a syntactically valid pre-epoch fence timestamp', async () => {
    await expectInvalid(scan([
      fenceData({ projectUpdatedAt: '0001-01-01T00:00:00Z' }),
    ]), 'timestamp')
  })
})
