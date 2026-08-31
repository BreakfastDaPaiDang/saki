import { Context } from '@deepseek-ai/cordis'
import { githubProjectItemId } from '@breakfastdapaidang/saki-github'
import type { GitHubProjectItemStatusSetInspection } from '@breakfastdapaidang/saki-github'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ISSUE,
  STATUS_SET_REQUEST,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import { expectedProjectReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const OBSERVED_AT = 1_800_000_000_000
const PROJECT_UPDATED_AT = '2027-01-15T08:00:00Z'
const ITEM_UPDATED_AT = '2027-01-15T07:59:00Z'
const BEFORE_ITEM_ID = githubProjectItemId('PVTI_before')
const AFTER_ITEM_ID = githubProjectItemId('PVTI_after')
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('inspects the exact Work Item and its stable API-order neighbors without a Board scan', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as {
      readonly query?: unknown
      readonly variables?: Readonly<Record<string, unknown>>
    }
    if (url.pathname === `/app/installations/${STATUS_SET_REQUEST.installation.installationId}/access_tokens`) {
      tokenBody = body
      return json({
        token: 'ghs_status_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedProjectReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(STATUS_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    if (url.pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
    graphqlBodies.push(body)
    const query = String(body.query)
    if (query.includes('query SakiProjectItemPosition')) {
      const secondPage = body.variables?.after === 'position:2'
      return graphql(secondPage
        ? positionData([{ id: AFTER_ITEM_ID, content: { __typename: 'DraftIssue' } }], false, null, {}, 3)
        : positionData([
          { id: BEFORE_ITEM_ID, content: { __typename: 'PullRequest' } },
          { id: STATUS_SET_REQUEST.projectItemId, content: { __typename: 'Issue', id: STATUS_SET_REQUEST.issueId } },
        ], true, 'position:2', {}, 3))
    }
    if (query.includes('query SakiTargetedWorkItem')) return graphql(targetData())
    throw new Error('unexpected GitHub GraphQL document')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, { pageSize: 2 })

  try {
    const inspection = await ctx.sakiGitHub.inspectMutation<'project-item-status-set'>(
      STATUS_SET_REQUEST,
      new AbortController().signal,
    )
    const snapshot = {
      repositoryId: STATUS_SET_REQUEST.repositoryId,
      repositoryDatabaseId: STATUS_SET_REQUEST.repositoryDatabaseId,
      projectId: STATUS_SET_REQUEST.projectId,
      statusFieldId: STATUS_SET_REQUEST.statusFieldId,
      issue: ISSUE,
      membership: {
        state: 'present' as const,
        item: {
          id: STATUS_SET_REQUEST.projectItemId,
          projectId: STATUS_SET_REQUEST.projectId,
          issueId: STATUS_SET_REQUEST.issueId,
          statusOptionId: STATUS_SET_REQUEST.desiredStatusOptionId,
          archived: false,
          apiOrder: 1,
          totalCount: 3,
          previousItemId: BEFORE_ITEM_ID,
          nextItemId: AFTER_ITEM_ID,
          updatedAt: Date.parse(ITEM_UPDATED_AT),
        },
      },
    }
    expect(tokenBody).toMatchObject({
      permissions: expectedProjectReadPermissions,
      repository_ids: [Number(STATUS_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(3)
    expect(graphqlBodies.map(body => String(body.query))).toEqual([
      expect.stringContaining('query SakiProjectItemPosition'),
      expect.stringContaining('query SakiProjectItemPosition'),
      expect.stringContaining('query SakiTargetedWorkItem'),
    ])
    expect(graphqlBodies.every(body => !String(body.query).includes('rateLimit'))).toBe(true)
    expect(graphqlBodies
      .filter(body => String(body.query).includes('query SakiTargetedWorkItem'))
      .map(body => body.variables))
      .toMatchObject([{ statusFieldId: STATUS_SET_REQUEST.statusFieldId }])
    expect(graphqlBodies
      .filter(body => String(body.query).includes('query SakiTargetedWorkItem'))
      .every(body => !String(body.query).includes('fullDatabaseId'))).toBe(true)
    expect(inspection).toMatchObject({
      snapshot,
      observedAt: OBSERVED_AT,
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

it('reports a completely traversed missing membership without treating it as a Board checkpoint', async () => {
  const inspection = await runInspection({
    positionPages: [positionData([
      { id: BEFORE_ITEM_ID, content: { __typename: 'PullRequest' } },
    ], false, null)],
    target: targetData({ item: null }),
  })

  expect(inspection.snapshot.membership).toEqual({ state: 'absent' })
  expect(inspection.snapshot.issue).toEqual(ISSUE)
  expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
})

it('ignores the recorded item id when it belongs to another Project', async () => {
  const inspection = await runInspection({
    positionPages: [positionData([], false, null)],
    target: targetData({
      item: targetItem({
        project: { id: 'P_other', updatedAt: PROJECT_UPDATED_AT },
      }),
    }),
  })

  expect(inspection.snapshot.membership).toEqual({ state: 'absent' })
})

it('finds a re-added Issue under its current Project item id', async () => {
  const currentItemId = githubProjectItemId('PVTI_readded')
  const inspection = await runInspection({
    positionPages: [positionData([
      { id: currentItemId, content: { __typename: 'Issue', id: STATUS_SET_REQUEST.issueId } },
    ], false, null)],
    target: targetData({ item: targetItem({ id: currentItemId }) }),
  })

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: { id: currentItemId, apiOrder: 0 },
  })
})

it('does not turn a bounded position traversal into an absent observation', async () => {
  await expect(runInspection({
    positionPages: [positionData([], true, 'position:next', {}, 1)],
    target: targetData({ item: null }),
    config: { maxPages: 1 },
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-position' },
  })
})

it('rejects a position connection that ends before its reported total count', async () => {
  await expect(runInspection({
    positionPages: [positionData([], false, null, {}, 1)],
    target: targetData({ item: null }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-position' },
  })
})

it('rejects a position total that changes between pages', async () => {
  await expect(runInspection({
    positionPages: [
      positionData([targetPositionItem()], true, 'position:next', {}, 2),
      positionData([{ id: AFTER_ITEM_ID, content: null }], false, null, {}, 3),
    ],
    target: targetData(),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-position' },
  })
})

it('rejects a position page that promises more pages after reaching its reported total', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], true, 'position:next', {}, 1)],
    target: targetData(),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-position' },
  })
})

it('rejects a Project revision change between position traversal and target detail', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      project: {
        __typename: 'ProjectV2',
        id: STATUS_SET_REQUEST.projectId,
        updatedAt: '2027-01-15T08:00:01Z',
      },
    }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-stability' },
  })
})

it('paginates the target field values before selecting Status', async () => {
  const inspection = await runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      item: targetItem({
        fieldValues: fieldValues(2, [statusValue()], true, 'field:next'),
      }),
    }),
    fieldValuePages: [fieldValuesData([
      { __typename: 'ProjectV2ItemFieldTextValue', field: { id: 'PVTF_other' } },
    ], 2, false, null)],
  })

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: { statusOptionId: STATUS_SET_REQUEST.desiredStatusOptionId },
  })
})

it('retains a present membership whose Status value is absent', async () => {
  const inspection = await runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({ item: targetItem({ fieldValues: fieldValues(0, [], false, null) }) }),
  })

  expect(inspection.snapshot.membership).toMatchObject({ state: 'present' })
  if (inspection.snapshot.membership.state !== 'present') throw new Error('expected present membership')
  expect(inspection.snapshot.membership.item).not.toHaveProperty('statusOptionId')
})

it('rejects duplicate Status values for the targeted item', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      item: targetItem({ fieldValues: fieldValues(2, [statusValue(), statusValue()], false, null) }),
    }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-status' },
  })
})

it('rejects an incomplete target field-value connection', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      item: targetItem({ fieldValues: fieldValues(2, [statusValue()], false, null) }),
    }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'targeted-work-item-field-values' },
  })
})

it.each([
  ['expected item contains another Issue', {
    positionPages: [positionData([{
      id: STATUS_SET_REQUEST.projectItemId,
      content: { __typename: 'Issue', id: 'I_other' },
    }], false, null)],
    target: targetData(),
  }, 'targeted-work-item-membership'],
  ['Issue appears in more than one Project item', {
    positionPages: [positionData([
      targetPositionItem(),
      { id: 'PVTI_duplicate_membership', content: { __typename: 'Issue', id: STATUS_SET_REQUEST.issueId } },
    ], false, null)],
    target: targetData(),
  }, 'targeted-work-item-membership'],
  ['connection omits a membership returned by exact item detail', {
    positionPages: [positionData([], false, null)],
    target: targetData(),
  }, 'targeted-work-item-membership'],
  ['present membership has no exact item detail', {
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({ item: null }),
  }, 'targeted-work-item'],
  ['present membership detail identifies another item', {
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({ item: targetItem({ id: 'PVTI_other' }) }),
  }, 'targeted-work-item'],
] as const)('rejects membership conflict when %s', async (_description, scenario, operation) => {
  await expect(runInspection(scenario)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation },
  })
})

it.each([
  ['field is absent', null],
  ['node is not a single-select field', { __typename: 'ProjectV2Field', id: STATUS_SET_REQUEST.statusFieldId }],
  ['field belongs to another Project', {
    __typename: 'ProjectV2SingleSelectField',
    id: STATUS_SET_REQUEST.statusFieldId,
    project: { id: 'P_other' },
    options: [{ id: STATUS_SET_REQUEST.desiredStatusOptionId }],
  }],
] as const)('reports mapping damage when the Status %s', async (_description, statusField) => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({ statusField }),
  })).rejects.toMatchObject({
    failure: {
      code: 'mapping-mismatch',
      reason: 'field-missing-or-not-single-select',
      statusFieldId: STATUS_SET_REQUEST.statusFieldId,
    },
  })
})

it('reports mapping damage when the desired Status option is absent', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({ statusField: targetStatusField({ options: [{ id: 'OPTION_other' }] }) }),
  })).rejects.toMatchObject({
    failure: {
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: STATUS_SET_REQUEST.statusFieldId,
      missingRequiredStatusOptionIds: [STATUS_SET_REQUEST.desiredStatusOptionId],
    },
  })
})

it('rejects duplicate option identities in the targeted Status field', async () => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      statusField: targetStatusField({
        options: [
          { id: STATUS_SET_REQUEST.desiredStatusOptionId },
          { id: STATUS_SET_REQUEST.desiredStatusOptionId },
        ],
      }),
    }),
  })).rejects.toMatchObject({
    failure: {
      code: 'invalid-external-response',
      operation: 'targeted-work-item-status-field',
    },
  })
})

it.each([
  ['Project is absent', {
    positionPages: [{ ...positionData([], false, null), project: null }],
    target: targetData(),
  }, { code: 'not-found', resource: 'Project' }],
  ['Project id changes', {
    positionPages: [positionData([], false, null, { id: 'P_other' })],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
  ['Project revision changes between pages', {
    positionPages: [
      positionData([], true, 'position:next', {}, 1),
      positionData([], false, null, { updatedAt: '2027-01-15T08:00:01Z' }, 1),
    ],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-stability' }],
  ['Project item id repeats', {
    positionPages: [positionData([
      { id: BEFORE_ITEM_ID, content: null },
      { id: BEFORE_ITEM_ID, content: null },
    ], false, null)],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
  ['Issue content omits its id', {
    positionPages: [positionData([{ id: BEFORE_ITEM_ID, content: { __typename: 'Issue' } }], false, null)],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
  ['item bound is exceeded', {
    positionPages: [positionData([
      { id: BEFORE_ITEM_ID, content: null },
      { id: AFTER_ITEM_ID, content: null },
    ], false, null, {}, 1)],
    target: targetData(),
    config: { maxItems: 1 },
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
  ['next cursor is missing', {
    positionPages: [positionData([], true, null)],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
  ['next cursor repeats', {
    positionPages: [
      positionData([], true, 'position:repeat', {}, 1),
      positionData([], true, 'position:repeat', {}, 1),
    ],
    target: targetData(),
  }, { code: 'invalid-external-response', operation: 'targeted-work-item-position' }],
] as const)('rejects an incomplete position observation when %s', async (_description, scenario, failure) => {
  await expect(runInspection(scenario)).rejects.toMatchObject({ failure })
})

it.each([
  ['Project is absent', targetData({ project: null }), { code: 'not-found', resource: 'Project' }],
  ['Issue is absent', targetData({ issue: null }), { code: 'not-found', resource: 'Issue' }],
  ['Issue ownership changes', targetData({
    issue: targetIssue({
      repository: { id: 'R_other', databaseId: Number(STATUS_SET_REQUEST.repositoryDatabaseId) },
    }),
  }), { code: 'invalid-external-response', operation: 'targeted-work-item' }],
] as const)('rejects targeted detail when %s', async (_description, target, failure) => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target,
  })).rejects.toMatchObject({ failure })
})

it.each([
  ['reported field count exceeds the configured bound', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(2, [], false, null) }) }),
    config: { maxFieldValues: 1 },
  }, 'targeted-work-item-field-values'],
  ['first field page contains more values than reported', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(0, [statusValue()], false, null) }) }),
  }, 'targeted-work-item-field-values'],
  ['field pagination exceeds the page bound', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(2, [statusValue()], true, 'field:next') }) }),
    config: { maxPages: 1 },
  }, 'targeted-work-item-field-values'],
  ['item revision changes between field pages', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(2, [statusValue()], true, 'field:next') }) }),
    fieldValuePages: [fieldValuesData([], 2, false, null, { updatedAt: '2027-01-15T07:59:01Z' })],
  }, 'targeted-work-item-stability'],
  ['later field page exceeds the reported total', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(1, [], true, 'field:next') }) }),
    fieldValuePages: [fieldValuesData([statusValue(), statusValue()], 1, false, null)],
  }, 'targeted-work-item-field-values'],
  ['field next cursor is missing', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(1, [], true, null) }) }),
  }, 'targeted-work-item-field-values'],
  ['field next cursor repeats', {
    target: targetData({ item: targetItem({ fieldValues: fieldValues(2, [], true, 'field:repeat') }) }),
    fieldValuePages: [fieldValuesData([], 2, true, 'field:repeat')],
  }, 'targeted-work-item-field-values'],
] satisfies ReadonlyArray<readonly [
  string,
  Omit<InspectionScenario, 'positionPages'>,
  string,
]>)('rejects Status inspection when %s', async (
  _description: string,
  partial: Omit<InspectionScenario, 'positionPages'>,
  operation: string,
) => {
  await expect(runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: partial.target,
    fieldValuePages: partial.fieldValuePages,
    config: partial.config,
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation },
  })
})

it('treats a null Status option as an absent Status value', async () => {
  const inspection = await runInspection({
    positionPages: [positionData([targetPositionItem()], false, null)],
    target: targetData({
      item: targetItem({ fieldValues: fieldValues(1, [statusValue({ optionId: null })], false, null) }),
    }),
  })

  expect(inspection.snapshot.membership).toMatchObject({ state: 'present' })
  if (inspection.snapshot.membership.state !== 'present') throw new Error('expected present membership')
  expect(inspection.snapshot.membership.item).not.toHaveProperty('statusOptionId')
})

it('rejects a syntactically valid Project timestamp before the JavaScript epoch', async () => {
  await expect(runInspection({
    positionPages: [positionData([], false, null, { updatedAt: '0001-01-02T03:04:05Z' })],
    target: targetData({ item: null }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'timestamp' },
  })
})

interface InspectionScenario {
  readonly positionPages: readonly Record<string, unknown>[]
  readonly target: Record<string, unknown>
  readonly fieldValuePages?: readonly Record<string, unknown>[] | undefined
  readonly config?: Readonly<{
    pageSize?: number
    maxPages?: number
    maxItems?: number
    maxFieldValues?: number
  }> | undefined
}

async function runInspection(scenario: InspectionScenario): Promise<GitHubProjectItemStatusSetInspection> {
  let positionPage = 0
  let fieldValuePage = 0
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as { readonly query?: unknown }
    if (url.pathname.includes('/access_tokens')) return inspectionAuthentication()
    const query = String(body.query)
    if (query.includes('query SakiProjectItemPosition')) {
      const data = scenario.positionPages[positionPage++]
      if (data === undefined) throw new Error('unexpected targeted position page')
      return graphql(data)
    }
    if (query.includes('query SakiTargetedWorkItem')) {
      return graphql(scenario.target)
    }
    if (query.includes('query SakiTargetedProjectItemFieldValues')) {
      const data = scenario.fieldValuePages?.[fieldValuePage++]
      if (data === undefined) throw new Error('unexpected targeted field-value page')
      return graphql(data)
    }
    throw new Error('unexpected GitHub GraphQL document')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, { pageSize: 2, ...scenario.config })
  try {
    return await ctx.sakiGitHub.inspectMutation<'project-item-status-set'>(
      STATUS_SET_REQUEST,
      new AbortController().signal,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

function graphql(data: unknown): Response {
  return json({ data })
}

function positionData(
  nodes: readonly unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  projectOverride: Readonly<Record<string, unknown>> = {},
  totalCount: number = nodes.length,
): Record<string, unknown> {
  return {
    project: {
      __typename: 'ProjectV2',
      id: STATUS_SET_REQUEST.projectId,
      updatedAt: PROJECT_UPDATED_AT,
      items: { totalCount, nodes, pageInfo: { hasNextPage, endCursor } },
      ...projectOverride,
    },
  }
}

function targetData(override: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    project: {
      __typename: 'ProjectV2',
      id: STATUS_SET_REQUEST.projectId,
      updatedAt: PROJECT_UPDATED_AT,
    },
    issue: {
      __typename: 'Issue',
      id: STATUS_SET_REQUEST.issueId,
      number: ISSUE.number,
      state: 'OPEN',
      title: ISSUE.title,
      url: ISSUE.url,
      updatedAt: new Date(ISSUE.updatedAt).toISOString(),
      repository: {
        id: STATUS_SET_REQUEST.repositoryId,
        databaseId: Number(STATUS_SET_REQUEST.repositoryDatabaseId),
      },
    },
    item: targetItem(),
    statusField: targetStatusField(),
    ...override,
  }
}

function targetStatusField(override: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'ProjectV2SingleSelectField',
    id: STATUS_SET_REQUEST.statusFieldId,
    project: { id: STATUS_SET_REQUEST.projectId },
    options: [{ id: STATUS_SET_REQUEST.desiredStatusOptionId }],
    ...override,
  }
}

function targetItem(override: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'ProjectV2Item',
    id: STATUS_SET_REQUEST.projectItemId,
    isArchived: false,
    updatedAt: ITEM_UPDATED_AT,
    project: { id: STATUS_SET_REQUEST.projectId, updatedAt: PROJECT_UPDATED_AT },
    content: {
      __typename: 'Issue',
      id: STATUS_SET_REQUEST.issueId,
      updatedAt: new Date(ISSUE.updatedAt).toISOString(),
    },
    fieldValues: fieldValues(1, [statusValue()], false, null),
    ...override,
  }
}

function targetPositionItem(): Record<string, unknown> {
  return {
    id: STATUS_SET_REQUEST.projectItemId,
    content: { __typename: 'Issue', id: STATUS_SET_REQUEST.issueId },
  }
}

function statusValue(override: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'ProjectV2ItemFieldSingleSelectValue',
    optionId: STATUS_SET_REQUEST.desiredStatusOptionId,
    field: { __typename: 'ProjectV2SingleSelectField', id: STATUS_SET_REQUEST.statusFieldId },
    ...override,
  }
}

function targetIssue(override: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: STATUS_SET_REQUEST.issueId,
    number: ISSUE.number,
    state: 'OPEN',
    title: ISSUE.title,
    url: ISSUE.url,
    updatedAt: new Date(ISSUE.updatedAt).toISOString(),
    repository: {
      id: STATUS_SET_REQUEST.repositoryId,
      databaseId: Number(STATUS_SET_REQUEST.repositoryDatabaseId),
    },
    ...override,
  }
}

function fieldValues(
  totalCount: number,
  nodes: readonly unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
): Record<string, unknown> {
  return { totalCount, nodes, pageInfo: { hasNextPage, endCursor } }
}

function fieldValuesData(
  nodes: readonly unknown[],
  totalCount: number,
  hasNextPage: boolean,
  endCursor: string | null,
  itemOverride: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    item: targetItem({
      fieldValues: fieldValues(totalCount, nodes, hasNextPage, endCursor),
      ...itemOverride,
    }),
  }
}

function inspectionAuthentication(): Response {
  return json({
    token: 'ghs_status_inspection_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedProjectReadPermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(STATUS_SET_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}
