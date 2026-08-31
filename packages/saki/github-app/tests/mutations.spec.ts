import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ISSUE,
  ISSUE_CREATE_REQUEST,
  ISSUE_STATE_SET_REQUEST,
  POSITION_SET_REQUEST,
  PROJECT_ITEM_ADD_REQUEST,
  STATUS_SET_REQUEST,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import {
  expectedIssueWritePermissions,
  expectedProjectWritePermissions,
  json,
  privateKey,
  TestCredentials,
} from './harness.ts'

const OBSERVED_AT = 1_800_000_000_000

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('dispatches one Project membership mutation without retrying or inspecting', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (url.pathname.includes('/access_tokens')) {
      tokenBody = body
      return projectItemAddAuthentication()
    }
    if (url.pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
    graphqlBodies.push(body)
    return json({
      data: {
        projectItemAdd: {
          clientMutationId: PROJECT_ITEM_ADD_REQUEST.operationId,
          item: {
            id: 'PVTI_item',
            project: { id: PROJECT_ITEM_ADD_REQUEST.projectId },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})

  try {
    const result = await ctx.sakiGitHub.dispatch(PROJECT_ITEM_ADD_REQUEST, new AbortController().signal)

    expect(tokenBody).toMatchObject({
      permissions: expectedProjectWritePermissions,
      repository_ids: [Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('mutation SakiProjectItemAdd'))
    expect(graphqlBodies[0]?.query).not.toEqual(expect.stringMatching(/\brateLimit\b/u))
    expect(graphqlBodies[0]).toMatchObject({
      variables: {
        projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
        issueId: PROJECT_ITEM_ADD_REQUEST.issueId,
        clientMutationId: PROJECT_ITEM_ADD_REQUEST.operationId,
      },
    })
    expect(result).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  ['client mutation id', {
    clientMutationId: 'operation:other',
    item: { id: 'PVTI_item', project: { id: PROJECT_ITEM_ADD_REQUEST.projectId } },
  }],
  ['Project id', {
    clientMutationId: PROJECT_ITEM_ADD_REQUEST.operationId,
    item: { id: 'PVTI_item', project: { id: 'P_other' } },
  }],
  ['missing Project item', {
    clientMutationId: PROJECT_ITEM_ADD_REQUEST.operationId,
    item: null,
  }],
] as const)('rejects a mismatched Project membership %s acknowledgement', async (_subject, projectItemAdd) => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return projectItemAddAuthentication()
    graphqlCalls += 1
    return json({ data: { projectItemAdd } })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(PROJECT_ITEM_ADD_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({
        failure: { code: 'invalid-external-response', operation: 'project-item-add' },
      })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not retry a Project membership mutation after a transport failure', async () => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return projectItemAddAuthentication()
    graphqlCalls += 1
    throw new TypeError('private transport failure')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(PROJECT_ITEM_ADD_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'transient-transport' } })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('dispatches one exact Project item Status mutation without retrying or inspecting', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (url.pathname === `/app/installations/${STATUS_SET_REQUEST.installation.installationId}/access_tokens`) {
      tokenBody = body
      return json({
        token: 'ghs_status_set_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedProjectWritePermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(STATUS_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    if (url.pathname !== '/graphql') throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
    graphqlBodies.push(body)
    return json({
      data: {
        statusSet: {
          clientMutationId: STATUS_SET_REQUEST.operationId,
          projectV2Item: {
            id: STATUS_SET_REQUEST.projectItemId,
            project: { id: STATUS_SET_REQUEST.projectId },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})

  try {
    const result = await ctx.sakiGitHub.dispatch(STATUS_SET_REQUEST, new AbortController().signal)

    expect(tokenBody).toMatchObject({
      permissions: expectedProjectWritePermissions,
      repository_ids: [Number(STATUS_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('mutation SakiProjectItemStatusSet'))
    expect(graphqlBodies[0]?.query).not.toEqual(expect.stringMatching(/\brateLimit\b/u))
    expect(graphqlBodies[0]).toMatchObject({
      variables: {
        projectId: STATUS_SET_REQUEST.projectId,
        itemId: STATUS_SET_REQUEST.projectItemId,
        fieldId: STATUS_SET_REQUEST.statusFieldId,
        optionId: STATUS_SET_REQUEST.desiredStatusOptionId,
        clientMutationId: STATUS_SET_REQUEST.operationId,
      },
    })
    expect(result).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('dispatches one exact Project item API-position mutation without retrying or inspecting', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (new URL(request.url).pathname.includes('/access_tokens')) {
      tokenBody = body
      return json({
        token: 'ghs_position_set_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedProjectWritePermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(POSITION_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    graphqlBodies.push(body)
    return json({ data: { positionSet: { clientMutationId: POSITION_SET_REQUEST.operationId } } })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    const result = await ctx.sakiGitHub.dispatch(POSITION_SET_REQUEST, new AbortController().signal)

    expect(tokenBody).toMatchObject({
      permissions: expectedProjectWritePermissions,
      repository_ids: [Number(POSITION_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('mutation SakiProjectItemPositionSet'))
    expect(graphqlBodies[0]?.query).not.toEqual(expect.stringMatching(/\brateLimit\b/u))
    expect(graphqlBodies[0]).toMatchObject({
      variables: {
        projectId: POSITION_SET_REQUEST.projectId,
        itemId: POSITION_SET_REQUEST.projectItemId,
        afterId: POSITION_SET_REQUEST.afterItemId,
        clientMutationId: POSITION_SET_REQUEST.operationId,
      },
    })
    expect(result).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('dispatches one exact Issue-state mutation and validates Repository ownership', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (new URL(request.url).pathname.includes('/access_tokens')) {
      tokenBody = body
      return json({
        token: 'ghs_issue_state_set_fixture',
        expires_at: '2030-01-02T03:04:05Z',
        permissions: expectedIssueWritePermissions,
        repository_selection: 'selected',
        repositories: [{ id: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId) }],
      }, { status: 201 })
    }
    graphqlBodies.push(body)
    return json({
      data: {
        issueStateSet: {
          clientMutationId: ISSUE_STATE_SET_REQUEST.operationId,
          issue: {
            id: ISSUE_STATE_SET_REQUEST.issueId,
            state: 'CLOSED',
            repository: {
              id: ISSUE_STATE_SET_REQUEST.repositoryId,
              databaseId: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId),
            },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    const result = await ctx.sakiGitHub.dispatch(ISSUE_STATE_SET_REQUEST, new AbortController().signal)

    expect(tokenBody).toMatchObject({
      permissions: expectedIssueWritePermissions,
      repository_ids: [Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('mutation SakiIssueStateSet'))
    expect(graphqlBodies[0]?.query).not.toEqual(expect.stringMatching(/\brateLimit\b/u))
    expect(graphqlBodies[0]).toMatchObject({
      variables: {
        issueId: ISSUE_STATE_SET_REQUEST.issueId,
        state: 'CLOSED',
        clientMutationId: ISSUE_STATE_SET_REQUEST.operationId,
      },
    })
    expect(result).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('maps the open Issue state to the GraphQL enum without retrying', async () => {
  const request = { ...ISSUE_STATE_SET_REQUEST, desiredState: 'open' as const }
  let graphqlBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const externalRequest = new Request(input, init)
    if (new URL(externalRequest.url).pathname.includes('/access_tokens')) return issueStateAuthentication()
    graphqlBody = JSON.parse(await externalRequest.text()) as Record<string, unknown>
    return json({
      data: {
        issueStateSet: {
          clientMutationId: request.operationId,
          issue: {
            id: request.issueId,
            state: 'OPEN',
            repository: {
              id: request.repositoryId,
              databaseId: Number(request.repositoryDatabaseId),
            },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    const result = await ctx.sakiGitHub.dispatch(request, new AbortController().signal)

    expect(graphqlBody).toMatchObject({ variables: { state: 'OPEN' } })
    expect(result).toBeUndefined()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects a mismatched API-position acknowledgement after one dispatch', async () => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return positionAuthentication()
    graphqlCalls += 1
    return json({ data: { positionSet: { clientMutationId: 'operation:other' } } })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(POSITION_SET_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({
        failure: { code: 'invalid-external-response', operation: 'project-item-position-set' },
      })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('rejects a mismatched Issue Repository acknowledgement after one dispatch', async () => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return issueStateAuthentication()
    graphqlCalls += 1
    return json({
      data: {
        issueStateSet: {
          clientMutationId: ISSUE_STATE_SET_REQUEST.operationId,
          issue: {
            id: ISSUE_STATE_SET_REQUEST.issueId,
            state: 'CLOSED',
            repository: { id: 'R_other', databaseId: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId) },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(ISSUE_STATE_SET_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'issue-state-set' } })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  ['API-position', POSITION_SET_REQUEST, positionAuthentication],
  ['Issue-state', ISSUE_STATE_SET_REQUEST, issueStateAuthentication],
] as const)('does not retry an %s mutation after a transport failure', async (_subject, request, authenticate) => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const externalRequest = new Request(input)
    if (new URL(externalRequest.url).pathname.includes('/access_tokens')) return authenticate()
    graphqlCalls += 1
    throw new TypeError('private transport failure')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(request, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'transient-transport' } })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  ['client mutation id', { clientMutationId: 'operation:other' }, {}],
  ['Project item id', {}, { id: 'PVTI_other' }],
  ['Project id', {}, { project: { id: 'P_other' } }],
] as const)('rejects a mismatched %s acknowledgement', async (_subject, statusOverride, itemOverride) => {
  let graphqlCalls = 0
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.pathname.includes('/access_tokens')) return statusAuthentication()
    graphqlCalls += 1
    return json({
      data: {
        statusSet: {
          clientMutationId: STATUS_SET_REQUEST.operationId,
          projectV2Item: {
            id: STATUS_SET_REQUEST.projectItemId,
            project: { id: STATUS_SET_REQUEST.projectId },
            ...itemOverride,
          },
          ...statusOverride,
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(STATUS_SET_REQUEST, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'invalid-external-response', operation: 'project-item-status-set' },
    })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not retry a Status mutation after a transport failure', async () => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    if (new URL(request.url).pathname.includes('/access_tokens')) return statusAuthentication()
    graphqlCalls += 1
    throw new TypeError('private transport failure')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(STATUS_SET_REQUEST, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'transient-transport' },
    })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('dispatches one exact Issue-create mutation and exposes only its inspection hint', async () => {
  const graphqlBodies: Array<Record<string, unknown>> = []
  let tokenBody: Record<string, unknown> | undefined
  vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = JSON.parse(await request.text()) as Record<string, unknown>
    if (url.pathname.includes('/access_tokens')) {
      tokenBody = body
      return issueCreateAuthentication()
    }
    graphqlBodies.push(body)
    return json({
      data: {
        issueCreate: {
          clientMutationId: ISSUE_CREATE_REQUEST.operationId,
          issue: {
            id: ISSUE.id,
            number: ISSUE.number,
            state: 'OPEN',
            title: ISSUE_CREATE_REQUEST.title,
            body: ISSUE_CREATE_REQUEST.body,
            url: ISSUE.url,
            updatedAt: '2027-01-15T08:00:00Z',
            repository: {
              id: ISSUE_CREATE_REQUEST.repositoryId,
              databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
              owner: { id: ISSUE_CREATE_REQUEST.installation.accountId },
            },
          },
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})

  try {
    const request = {
      ...ISSUE_CREATE_REQUEST,
      inspectionHint: { issueId: ISSUE.id, issueNumber: ISSUE.number },
    }
    const result = await ctx.sakiGitHub.dispatch(request, new AbortController().signal)

    expect(tokenBody).toMatchObject({
      permissions: expectedIssueWritePermissions,
      repository_ids: [Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId)],
    })
    expect(graphqlBodies).toHaveLength(1)
    expect(graphqlBodies[0]?.query).toEqual(expect.stringContaining('mutation SakiIssueCreate'))
    expect(graphqlBodies[0]?.query).not.toEqual(expect.stringMatching(/\brateLimit\b/u))
    expect(graphqlBodies[0]).toMatchObject({
      variables: {
        repositoryId: ISSUE_CREATE_REQUEST.repositoryId,
        title: ISSUE_CREATE_REQUEST.title,
        body: ISSUE_CREATE_REQUEST.body,
        clientMutationId: ISSUE_CREATE_REQUEST.operationId,
      },
    })
    expect((graphqlBodies[0]?.variables as Record<string, unknown>)).not.toHaveProperty('inspectionHint')
    expect(result).toEqual({ issueId: ISSUE.id, issueNumber: ISSUE.number })
    expect(JSON.stringify(result)).not.toContain(ISSUE_CREATE_REQUEST.body)
    expect(JSON.stringify(result)).not.toContain('ghs_issue_create_fixture')
  } finally {
    await ctx.fiber.dispose()
  }
})

it.each([
  ['client mutation id', { clientMutationId: 'operation:other' }, {}],
  ['missing Issue', { issue: null }, {}],
  ['empty Issue id', {}, { id: '' }],
  ['invalid Issue number', {}, { number: 0 }],
  ['Issue state', {}, { state: 'CLOSED' }],
  ['Issue title', {}, { title: 'rewritten title' }],
  ['Issue body', {}, { body: 'rewritten body' }],
  ['Repository id', {}, { repository: {
    id: 'R_other',
    databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
    owner: { id: ISSUE_CREATE_REQUEST.installation.accountId },
  } }],
  ['Repository database id', {}, { repository: {
    id: ISSUE_CREATE_REQUEST.repositoryId,
    databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId) + 1,
    owner: { id: ISSUE_CREATE_REQUEST.installation.accountId },
  } }],
  ['Repository owner', {}, { repository: {
    id: ISSUE_CREATE_REQUEST.repositoryId,
    databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
    owner: { id: 'O_other' },
  } }],
] as const)('rejects a mismatched Issue-create %s acknowledgement without retry', async (
  _subject,
  payloadOverride,
  issueOverride,
) => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return issueCreateAuthentication()
    graphqlCalls += 1
    return json({
      data: {
        issueCreate: {
          clientMutationId: ISSUE_CREATE_REQUEST.operationId,
          issue: {
            id: ISSUE.id,
            number: ISSUE.number,
            state: 'OPEN',
            title: ISSUE_CREATE_REQUEST.title,
            body: ISSUE_CREATE_REQUEST.body,
            url: ISSUE.url,
            updatedAt: '2027-01-15T08:00:00Z',
            repository: {
              id: ISSUE_CREATE_REQUEST.repositoryId,
              databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
              owner: { id: ISSUE_CREATE_REQUEST.installation.accountId },
            },
            ...issueOverride,
          },
          ...payloadOverride,
        },
      },
    })
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(ISSUE_CREATE_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'invalid-external-response', operation: 'issue-create' } })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('does not retry Issue-create after a transport failure', async () => {
  let graphqlCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request): Promise<Response> => {
    const request = new Request(input)
    if (new URL(request.url).pathname.includes('/access_tokens')) return issueCreateAuthentication()
    graphqlCalls += 1
    throw new TypeError('private transport failure')
  }))
  const ctx = new Context()
  new TestCredentials(ctx, privateKey, true)
  await ctx.plugin(SakiGitHubApp, {})
  try {
    await expect(ctx.sakiGitHub.dispatch(ISSUE_CREATE_REQUEST, new AbortController().signal))
      .rejects.toMatchObject({ failure: { code: 'transient-transport' } })
    expect(graphqlCalls).toBe(1)
  } finally {
    await ctx.fiber.dispose()
  }
})

function statusAuthentication(): Response {
  return json({
    token: 'ghs_status_set_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedProjectWritePermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(STATUS_SET_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}

function projectItemAddAuthentication(): Response {
  return json({
    token: 'ghs_project_item_add_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedProjectWritePermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}

function positionAuthentication(): Response {
  return json({
    token: 'ghs_position_set_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedProjectWritePermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(POSITION_SET_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}

function issueStateAuthentication(): Response {
  return json({
    token: 'ghs_issue_state_set_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedIssueWritePermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}

function issueCreateAuthentication(): Response {
  return json({
    token: 'ghs_issue_create_fixture',
    expires_at: '2030-01-02T03:04:05Z',
    permissions: expectedIssueWritePermissions,
    repository_selection: 'selected',
    repositories: [{ id: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId) }],
  }, { status: 201 })
}
