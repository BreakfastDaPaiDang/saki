import { Context } from '@deepseek-ai/cordis'
import {
  githubIssueId,
  githubProjectItemId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueFact,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemPositionSetRequest,
} from '@breakfastdapaidang/saki-github'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ISSUE,
  OBSERVED_AT,
  POSITION_SET_REQUEST,
  PREVIOUS_ITEM_ID,
  READY_OPTION_ID,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import { expectedProjectReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

const PROJECT_UPDATED_AT = OBSERVED_AT - 500
const PREVIOUS_ISSUE = {
  ...ISSUE,
  id: githubIssueId('I_previous'),
  number: ISSUE.number + 1,
  title: 'Previous Work Item',
  url: 'https://github.example/owner/repo/issues/28',
  updatedAt: PROJECT_UPDATED_AT,
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('inspects the moving item and predecessor across one complete ordered Project traversal', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (new URL(request.url).pathname.includes('/access_tokens')) {
      tokenBody = body
      return json({
        token: 'ghs_position_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedProjectReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(POSITION_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    graphqlBodies.push(body)
    const after = (body.variables as { after?: unknown }).after
    return json({ data: positionObservation(after === null ? 0 : 1) })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, { pageSize: 1, maxPages: 2 })
  try {
    const inspection = await ctx.sakiGitHub.inspectMutation<'project-item-position-set'>(
      POSITION_SET_REQUEST,
      new AbortController().signal,
    )
    const snapshot = {
      repositoryId: POSITION_SET_REQUEST.repositoryId,
      repositoryDatabaseId: POSITION_SET_REQUEST.repositoryDatabaseId,
      projectId: POSITION_SET_REQUEST.projectId,
      statusFieldId: POSITION_SET_REQUEST.statusFieldId,
      issue: ISSUE,
      membership: {
        state: 'present' as const,
        item: {
          id: POSITION_SET_REQUEST.projectItemId,
          projectId: POSITION_SET_REQUEST.projectId,
          issueId: POSITION_SET_REQUEST.issueId,
          statusOptionId: READY_OPTION_ID,
          archived: false,
          apiOrder: 1,
          totalCount: 2,
          previousItemId: PREVIOUS_ITEM_ID,
          nextItemId: null,
          updatedAt: ISSUE.updatedAt,
        },
      },
      after: {
        state: 'present' as const,
        item: {
          id: PREVIOUS_ITEM_ID,
          projectId: POSITION_SET_REQUEST.projectId,
          issue: PREVIOUS_ISSUE,
          statusOptionId: READY_OPTION_ID,
          archived: false,
          apiOrder: 0,
          totalCount: 2,
          previousItemId: null,
          nextItemId: POSITION_SET_REQUEST.projectItemId,
          updatedAt: PROJECT_UPDATED_AT,
        },
      },
    }
    expect(tokenBody).toMatchObject({
      permissions: expectedProjectReadPermissions,
      repository_ids: [Number(POSITION_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(2)
    expect(graphqlBodies.every(body => String(body.query).includes('query SakiProjectItemPositionInspection'))).toBe(true)
    expect(graphqlBodies.every(body => !String(body.query).includes('mutation '))).toBe(true)
    expect(graphqlBodies.every(body => !String(body.query).includes('rateLimit'))).toBe(true)
    expect(inspection).toEqual({
      snapshot,
      observedAt: OBSERVED_AT,
    })
    expect(inspection.snapshot).not.toHaveProperty('target')
    expect(Object.keys(inspection).sort()).toEqual([
      'observedAt',
      'snapshot',
    ])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('returns explicit absent moving-membership and predecessor observations', async () => {
  const inspection = await runPositionInspection(() => onePageObservation([]))

  expect(inspection.snapshot.membership).toEqual({ state: 'absent' })
  expect(inspection.snapshot.after).toEqual({ state: 'absent', itemId: PREVIOUS_ITEM_ID })
})

it('retains duplicate Issue memberships as an ordered reconciliation fact', async () => {
  const duplicateId = githubProjectItemId('PVTI_duplicate')
  const request: GitHubProjectItemPositionSetRequest = {
    ...POSITION_SET_REQUEST,
    afterItemId: duplicateId,
  }
  const inspection = await runConfiguredPositionInspection(() => onePageObservation([
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
    movingNode(duplicateId, POSITION_SET_REQUEST.issueId),
  ]), { request })

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'duplicate-conflict',
    items: [
      { id: POSITION_SET_REQUEST.projectItemId, statusOptionId: READY_OPTION_ID, apiOrder: 0, totalCount: 2 },
      { id: duplicateId, statusOptionId: READY_OPTION_ID, apiOrder: 1, totalCount: 2 },
    ],
  })
  expect(inspection.snapshot.after).toMatchObject({
    state: 'present',
    item: { id: duplicateId, statusOptionId: READY_OPTION_ID },
  })
})

it('retains a moving membership without a selected Status option', async () => {
  const moving = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    fieldValues: Record<string, unknown>
  }
  moving.fieldValues = fieldValues([])
  const inspection = await runPositionInspection(() => onePageObservation([
    anchorNode(PREVIOUS_ITEM_ID),
    moving,
  ]))

  expect(inspection.snapshot.membership.state).toBe('present')
  if (inspection.snapshot.membership.state !== 'present') throw new Error('expected present membership')
  expect(inspection.snapshot.membership.item).not.toHaveProperty('statusOptionId')
})

it('paginates moving membership field values before retaining its Status option', async () => {
  const moving = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    fieldValues: Record<string, unknown>
  }
  moving.fieldValues = {
    totalCount: 2,
    nodes: [{ __typename: 'ProjectV2ItemFieldTextValue' }],
    pageInfo: { hasNextPage: true, endCursor: 'moving-field:next' },
  }
  const continued = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    fieldValues: Record<string, unknown>
  }
  continued.fieldValues = {
    totalCount: 2,
    nodes: [statusValue()],
    pageInfo: { hasNextPage: false, endCursor: null },
  }
  const request: GitHubProjectItemPositionSetRequest = { ...POSITION_SET_REQUEST, afterItemId: null }

  const inspection = await runConfiguredPositionInspection(() => onePageObservation([moving]), {
    request,
    fieldValuesObservation: () => ({ item: continued }),
  })

  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: { statusOptionId: READY_OPTION_ID },
  })
})

it('rejects a frozen moving item that belongs to another Issue', async () => {
  await expect(runPositionInspection(() => onePageObservation([
    anchorNode(PREVIOUS_ITEM_ID),
    movingNode(POSITION_SET_REQUEST.projectItemId, githubIssueId('I_other')),
  ]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-target' },
  })
})

it('retains the explicit top target and first-position moving membership', async () => {
  const request: GitHubProjectItemPositionSetRequest = {
    ...POSITION_SET_REQUEST,
    afterItemId: null,
  }
  const inspection = await runConfiguredPositionInspection(() => onePageObservation([
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
    anchorNode(PREVIOUS_ITEM_ID),
  ]), { request })

  expect(inspection.snapshot.after).toEqual({ state: 'top' })
  expect(inspection.snapshot.membership).toMatchObject({
    state: 'present',
    item: { apiOrder: 0, previousItemId: null, nextItemId: PREVIOUS_ITEM_ID },
  })
})

it('retains a final-position predecessor without inventing a next item', async () => {
  const request: GitHubProjectItemPositionSetRequest = {
    ...POSITION_SET_REQUEST,
    afterItemId: PREVIOUS_ITEM_ID,
  }
  const inspection = await runConfiguredPositionInspection(() => onePageObservation([
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
    anchorNode(PREVIOUS_ITEM_ID),
  ]), { request })

  expect(inspection.snapshot.after).toMatchObject({
    state: 'present',
    item: { apiOrder: 1, previousItemId: POSITION_SET_REQUEST.projectItemId, nextItemId: null },
  })
})

it('paginates predecessor field values before retaining its Status option', async () => {
  const anchor = anchorNode(PREVIOUS_ITEM_ID) as {
    fieldValues: Record<string, unknown>
  }
  anchor.fieldValues = {
    totalCount: 2,
    nodes: [{ __typename: 'ProjectV2ItemFieldTextValue' }],
    pageInfo: { hasNextPage: true, endCursor: 'field:next' },
  }
  const continued = anchorNode(PREVIOUS_ITEM_ID) as {
    fieldValues: Record<string, unknown>
  }
  continued.fieldValues = {
    totalCount: 2,
    nodes: [statusValue()],
    pageInfo: { hasNextPage: false, endCursor: null },
  }

  const inspection = await runConfiguredPositionInspection(() => onePageObservation([
    anchor,
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
  ]), {
    fieldValuesObservation: () => ({ item: continued }),
  })

  expect(inspection.snapshot.after).toMatchObject({
    state: 'present',
    item: { statusOptionId: READY_OPTION_ID },
  })
})

it.each([
  ['a non-Issue predecessor', () => {
    const anchor = anchorNode(PREVIOUS_ITEM_ID) as { content: unknown }
    anchor.content = { __typename: 'DraftIssue' }
    return onePageObservation([anchor])
  }, { code: 'invalid-external-response', operation: 'project-item-position-anchor' }],
  ['an invalid Status field mapping', () => {
    const response = onePageObservation([]) as { statusField: unknown }
    response.statusField = null
    return response
  }, {
    code: 'mapping-mismatch',
    reason: 'field-missing-or-not-single-select',
    statusFieldId: POSITION_SET_REQUEST.statusFieldId,
  }],
] as const)('rejects position inspection with %s', async (_subject, observation, failure) => {
  await expect(runPositionInspection(observation)).rejects.toMatchObject({ failure })
})

it('rejects duplicate or incomplete predecessor Status values', async () => {
  const duplicate = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  duplicate.fieldValues = fieldValues([statusValue(), statusValue()])
  await expect(runPositionInspection(() => onePageObservation([duplicate]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-status' },
  })

  const incomplete = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  incomplete.fieldValues = {
    totalCount: 2,
    nodes: [statusValue()],
    pageInfo: { hasNextPage: false, endCursor: null },
  }
  await expect(runPositionInspection(() => onePageObservation([incomplete]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-field-values' },
  })
})

it('retains a predecessor without a selected Status option', async () => {
  const anchor = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  anchor.fieldValues = fieldValues([])
  const inspection = await runPositionInspection(() => onePageObservation([anchor]))
  const after = inspection.snapshot.after

  expect(after.state).toBe('present')
  if (after.state !== 'present') throw new Error('expected present predecessor')
  expect(after.item).not.toHaveProperty('statusOptionId')

  anchor.fieldValues = fieldValues([statusValue(null)])
  const nullOption = await runPositionInspection(() => onePageObservation([anchor]))
  const nullAfter = nullOption.snapshot.after
  expect(nullAfter.state).toBe('present')
  if (nullAfter.state !== 'present') throw new Error('expected present predecessor')
  expect(nullAfter.item).not.toHaveProperty('statusOptionId')
})

it('enforces predecessor field-value bounds before and during pagination', async () => {
  const overBound = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  overBound.fieldValues = fieldValues([statusValue(), { __typename: 'ProjectV2ItemFieldTextValue' }])
  await expect(runConfiguredPositionInspection(() => onePageObservation([overBound]), {
    config: { maxFieldValues: 1 },
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-field-values' },
  })

  const overReported = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  overReported.fieldValues = {
    totalCount: 0,
    nodes: [statusValue()],
    pageInfo: { hasNextPage: false, endCursor: null },
  }
  await expect(runPositionInspection(() => onePageObservation([overReported]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-field-values' },
  })

  const pageBound = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  pageBound.fieldValues = {
    totalCount: 2,
    nodes: [statusValue()],
    pageInfo: { hasNextPage: true, endCursor: 'field:next' },
  }
  await expect(runConfiguredPositionInspection(() => onePageObservation([pageBound]), {
    config: { maxPages: 1 },
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-field-values' },
  })

  const laterOverflow = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  laterOverflow.fieldValues = {
    totalCount: 1,
    nodes: [],
    pageInfo: { hasNextPage: true, endCursor: 'field:next' },
  }
  const continuation = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  continuation.fieldValues = {
    totalCount: 1,
    nodes: [statusValue(), { __typename: 'ProjectV2ItemFieldTextValue' }],
    pageInfo: { hasNextPage: false, endCursor: null },
  }
  await expect(runConfiguredPositionInspection(() => onePageObservation([laterOverflow]), {
    fieldValuesObservation: () => ({ item: continuation }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-field-values' },
  })
})

it.each([
  ['an absent continuation item', (): unknown => null],
  ['a changed continuation item', (): unknown => {
    const changed = anchorNode(PREVIOUS_ITEM_ID) as {
      updatedAt: string
      fieldValues: Record<string, unknown>
    }
    changed.updatedAt = new Date(PROJECT_UPDATED_AT + 1).toISOString()
    changed.fieldValues = {
      totalCount: 2,
      nodes: [statusValue()],
      pageInfo: { hasNextPage: false, endCursor: null },
    }
    return changed
  }],
] as const)('rejects predecessor field pagination with %s', async (_subject: string, item: () => unknown) => {
  const anchor = anchorNode(PREVIOUS_ITEM_ID) as { fieldValues: Record<string, unknown> }
  anchor.fieldValues = {
    totalCount: 2,
    nodes: [{ __typename: 'ProjectV2ItemFieldTextValue' }],
    pageInfo: { hasNextPage: true, endCursor: 'field:next' },
  }
  await expect(runConfiguredPositionInspection(() => onePageObservation([anchor]), {
    fieldValuesObservation: () => ({ item: item() }),
  })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-stability' },
  })
})

it('distinguishes raw predecessor and moving-item Repository ownership failures', async () => {
  const anchor = anchorNode(PREVIOUS_ITEM_ID) as { content: { repository: { owner: { id: string } } } }
  anchor.content.repository.owner.id = 'O_other'
  await expect(runPositionInspection(() => onePageObservation([anchor]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-anchor' },
  })

  const moving = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    content: { repository: { owner: { id: string } } }
  }
  moving.content.repository.owner.id = 'O_other'
  await expect(runPositionInspection(() => onePageObservation([moving]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-target' },
  })
})

it.each([
  ['Project', 'project'],
  ['Repository', 'repository'],
  ['Issue', 'issue'],
] as const)('returns a typed not-found failure when the %s node is absent', async (resource, field) => {
  const response = onePageObservation([]) as Record<string, unknown>
  response[field] = null

  await expect(runPositionInspection(() => response)).rejects.toMatchObject({
    failure: { code: 'not-found', resource },
  })
})

it('rejects a top-level target outside the frozen Project, Repository, or Issue', async () => {
  const response = onePageObservation([]) as { project: { id: string } }
  response.project.id = 'PVT_other'

  await expect(runPositionInspection(() => response)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-target' },
  })
})

it('rejects Project revision drift between pages of one traversal', async () => {
  let read = 0
  await expect(runConfiguredPositionInspection(() => {
    read += 1
    const response = positionObservation(read === 1 ? 0 : 1) as { project: { updatedAt: string } }
    if (read === 2) response.project.updatedAt = new Date(PROJECT_UPDATED_AT + 1).toISOString()
    return response
  }, { config: { pageSize: 1, maxPages: 2 } })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-stability' },
  })
})

it('rejects Issue revision drift between pages of one traversal', async () => {
  let read = 0
  await expect(runConfiguredPositionInspection(() => {
    read += 1
    const response = positionObservation(read === 1 ? 0 : 1) as { issue: { state: string } }
    if (read === 2) response.issue.state = 'CLOSED'
    return response
  }, { config: { pageSize: 1, maxPages: 2 } })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-stability' },
  })
})

it('rejects a changing or over-budget Project item total', async () => {
  let read = 0
  await expect(runConfiguredPositionInspection(() => {
    read += 1
    const response = positionObservation(read === 1 ? 0 : 1) as { project: { items: { totalCount: number } } }
    if (read === 2) response.project.items.totalCount = 3
    return response
  }, { config: { pageSize: 1, maxPages: 2 } })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  await expect(runConfiguredPositionInspection(() => onePageObservation([
    anchorNode(PREVIOUS_ITEM_ID),
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
  ]), { config: { maxItems: 1 } })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })
})

it('rejects duplicate item ids and node counts beyond the configured item budget', async () => {
  await expect(runPositionInspection(() => onePageObservation([
    anchorNode(PREVIOUS_ITEM_ID),
    anchorNode(PREVIOUS_ITEM_ID),
  ]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const response = onePageObservation([
    anchorNode(PREVIOUS_ITEM_ID),
    movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId),
  ]) as { project: { items: { totalCount: number } } }
  response.project.items.totalCount = 1
  await expect(runConfiguredPositionInspection(() => response, { config: { maxItems: 1 } }))
    .rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
    })
})

it('rejects incomplete traversal counts and pagination beyond the page budget', async () => {
  const incomplete = onePageObservation([anchorNode(PREVIOUS_ITEM_ID)]) as {
    project: { items: { totalCount: number } }
  }
  incomplete.project.items.totalCount = 2
  await expect(runPositionInspection(() => incomplete)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const paged = positionObservation(0)
  await expect(runConfiguredPositionInspection(() => paged, { config: { pageSize: 1, maxPages: 1 } }))
    .rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
    })
})

it('rejects missing, repeated, and semantically premature cursors', async () => {
  const missing = positionObservation(0) as { project: { items: { pageInfo: { endCursor: string | null } } } }
  missing.project.items.pageInfo.endCursor = null
  await expect(runPositionInspection(() => missing)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  let repeatedRead = 0
  await expect(runConfiguredPositionInspection(() => {
    repeatedRead += 1
    const response = positionObservation(repeatedRead === 1 ? 0 : 1) as {
      project: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    response.project.items.pageInfo = { hasNextPage: true, endCursor: 'page-1' }
    return response
  }, { config: { pageSize: 1, maxPages: 3 } })).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const premature = onePageObservation([anchorNode(PREVIOUS_ITEM_ID)]) as {
    project: { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
  }
  premature.project.items.pageInfo = { hasNextPage: true, endCursor: 'page-1' }
  await expect(runPositionInspection(() => premature)).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })
})

it('rejects malformed Project-item parent and Issue ownership facts', async () => {
  const wrongProject = anchorNode(PREVIOUS_ITEM_ID) as { project: { id: string } }
  wrongProject.project.id = 'PVT_other'
  await expect(runPositionInspection(() => onePageObservation([wrongProject]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const missingIssueId = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    content: { id?: string }
  }
  delete missingIssueId.content.id
  await expect(runPositionInspection(() => onePageObservation([missingIssueId]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const missingRepository = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    content: { repository?: unknown }
  }
  delete missingRepository.content.repository
  await expect(runPositionInspection(() => onePageObservation([missingRepository]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-membership' },
  })

  const wrongRepository = movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId) as {
    content: { repository: { id: string } }
  }
  wrongRepository.content.repository.id = 'R_other'
  await expect(runPositionInspection(() => onePageObservation([wrongRepository]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'project-item-position-target' },
  })
})

it('rejects a pre-epoch Project or item revision timestamp', async () => {
  const item = anchorNode(PREVIOUS_ITEM_ID) as { updatedAt: string }
  item.updatedAt = '0000-01-01T00:00:00.000Z'

  await expect(runPositionInspection(() => onePageObservation([item]))).rejects.toMatchObject({
    failure: { code: 'invalid-external-response', operation: 'timestamp' },
  })
})

function positionObservation(page: 0 | 1): unknown {
  const node = page === 0
    ? anchorNode(PREVIOUS_ITEM_ID)
    : movingNode(POSITION_SET_REQUEST.projectItemId, POSITION_SET_REQUEST.issueId)
  return {
    project: {
      __typename: 'ProjectV2',
      id: POSITION_SET_REQUEST.projectId,
      updatedAt: new Date(PROJECT_UPDATED_AT).toISOString(),
      owner: { id: POSITION_SET_REQUEST.installation.accountId },
      items: {
        totalCount: 2,
        nodes: [node],
        pageInfo: page === 0
          ? { hasNextPage: true, endCursor: 'page-1' }
          : { hasNextPage: false, endCursor: null },
      },
    },
    repository: {
      __typename: 'Repository',
      id: POSITION_SET_REQUEST.repositoryId,
      databaseId: Number(POSITION_SET_REQUEST.repositoryDatabaseId),
      owner: { id: POSITION_SET_REQUEST.installation.accountId },
    },
    issue: {
      __typename: 'Issue',
      id: POSITION_SET_REQUEST.issueId,
      number: ISSUE.number,
      state: 'OPEN',
      title: ISSUE.title,
      url: ISSUE.url,
      updatedAt: new Date(ISSUE.updatedAt).toISOString(),
      repository: {
        id: POSITION_SET_REQUEST.repositoryId,
        databaseId: Number(POSITION_SET_REQUEST.repositoryDatabaseId),
        owner: { id: POSITION_SET_REQUEST.installation.accountId },
      },
    },
    statusField: {
      __typename: 'ProjectV2SingleSelectField',
      id: POSITION_SET_REQUEST.statusFieldId,
      project: { id: POSITION_SET_REQUEST.projectId },
    },
  }
}

async function runPositionInspection(
  observation: () => unknown,
): Promise<GitHubProjectItemPositionSetInspection> {
  return runConfiguredPositionInspection(observation, {})
}

async function runConfiguredPositionInspection(
  observation: () => unknown,
  options: {
    readonly request?: GitHubProjectItemPositionSetRequest
    readonly config?: {
      readonly pageSize?: number
      readonly maxPages?: number
      readonly maxItems?: number
      readonly maxFieldValues?: number
    }
    readonly fieldValuesObservation?: (() => unknown) | undefined
  },
): Promise<GitHubProjectItemPositionSetInspection> {
  const request = options.request ?? POSITION_SET_REQUEST
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const externalRequest = new Request(input, init)
    if (new URL(externalRequest.url).pathname.includes('/access_tokens')) {
      return json({
        token: 'ghs_position_inspection_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedProjectReadPermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(request.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    const body = JSON.parse(await externalRequest.text()) as { readonly query?: unknown }
    if (String(body.query).includes('query SakiProjectItemPositionFieldValues')) {
      if (options.fieldValuesObservation === undefined) {
        throw new Error('unexpected predecessor field-value page')
      }
      return json({ data: options.fieldValuesObservation() })
    }
    return json({ data: observation() })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, options.config ?? {})
  try {
    return await ctx.sakiGitHub.inspectMutation<'project-item-position-set'>(
      request,
      new AbortController().signal,
    )
  } finally {
    await ctx.fiber.dispose()
  }
}

function onePageObservation(nodes: readonly unknown[]): unknown {
  const base = positionObservation(1) as {
    project: { items: { totalCount: number; nodes: unknown[]; pageInfo: unknown } }
  }
  return {
    ...base,
    project: {
      ...base.project,
      items: {
        totalCount: nodes.length,
        nodes: [...nodes],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  }
}

function anchorNode(id: ReturnType<typeof githubProjectItemId>): unknown {
  const issue = id === PREVIOUS_ITEM_ID
    ? PREVIOUS_ISSUE
    : {
      ...PREVIOUS_ISSUE,
      id: githubIssueId(`I_${id}`),
      title: `Work Item ${id}`,
      url: `https://github.example/owner/repo/issues/${encodeURIComponent(id)}`,
    }
  return {
    __typename: 'ProjectV2Item',
    id,
    isArchived: false,
    updatedAt: new Date(PROJECT_UPDATED_AT).toISOString(),
    project: {
      id: POSITION_SET_REQUEST.projectId,
      updatedAt: new Date(PROJECT_UPDATED_AT).toISOString(),
      owner: { id: POSITION_SET_REQUEST.installation.accountId },
    },
    content: issueNode(issue),
    fieldValues: fieldValues([statusValue()]),
  }
}

function movingNode(
  id: ReturnType<typeof githubProjectItemId>,
  issueId: ReturnType<typeof githubIssueId>,
): unknown {
  return {
    __typename: 'ProjectV2Item',
    id,
    isArchived: false,
    updatedAt: new Date(ISSUE.updatedAt).toISOString(),
    project: {
      id: POSITION_SET_REQUEST.projectId,
      updatedAt: new Date(PROJECT_UPDATED_AT).toISOString(),
      owner: { id: POSITION_SET_REQUEST.installation.accountId },
    },
    content: issueNode({ ...ISSUE, id: issueId }),
    fieldValues: fieldValues([statusValue()]),
  }
}

function issueNode(issue: GitHubIssueFact): Record<string, unknown> {
  return {
    __typename: 'Issue',
    id: issue.id,
    number: issue.number,
    state: issue.state.toUpperCase(),
    title: issue.title,
    url: issue.url,
    updatedAt: new Date(issue.updatedAt).toISOString(),
    repository: {
      id: POSITION_SET_REQUEST.repositoryId,
      databaseId: Number(POSITION_SET_REQUEST.repositoryDatabaseId),
      owner: { id: POSITION_SET_REQUEST.installation.accountId },
    },
  }
}

function fieldValues(nodes: readonly unknown[]): Record<string, unknown> {
  return {
    totalCount: nodes.length,
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  }
}

function statusValue(optionId: string | null = READY_OPTION_ID): Record<string, unknown> {
  return {
    __typename: 'ProjectV2ItemFieldSingleSelectValue',
    optionId,
    field: { id: POSITION_SET_REQUEST.statusFieldId },
  }
}
