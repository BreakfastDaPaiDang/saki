import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  computeGitHubProjectBoardFingerprint,
  githubAccountId,
  githubAppId,
  githubInstallationId,
  githubIssueId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubInstallationFact,
  GitHubInstallationReadRequest,
  GitHubIssueStateSetInspection,
  GitHubIssueCreateInspectionHint,
  GitHubIssueCreateInspection,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectItemAddInspection,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemStatusSetInspection,
  GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import { vi } from 'vitest'
import { runGitHubProviderContract } from '../../github/tests/contract.ts'
import {
  ISSUE_STATE_SET_REQUEST,
  ISSUE_CREATE_REQUEST,
  POSITION_SET_REQUEST,
  PROJECT_ITEM_ADD_REQUEST,
  STATUS_SET_REQUEST,
} from '../../github/tests/fixtures.ts'
import SakiGitHubApp from '../src/index.ts'
import {
  expectedIssueReadPermissions,
  expectedIssueWritePermissions,
  expectedProjectReadPermissions,
  expectedProjectWritePermissions,
  expectedReadPermissions,
  json,
  privateKey,
  TestCredentials,
} from './harness.ts'

const OBSERVED_AT = 1_800_000_000_000
const TOKEN_EXPIRES_AT = OBSERVED_AT + 3_600_000
const UPDATED_AT = OBSERVED_AT - 1_000
const ACCOUNT_ID = githubAccountId('O_account')
const INSTALLATION_ID = githubInstallationId('12345')
const REPOSITORY_ID = githubRepositoryId('R_repository')
const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('67890')
const PROJECT_ID = githubProjectId('P_project')
const STATUS_FIELD_ID = githubProjectFieldId('PVTF_status')
const INBOX_OPTION_ID = githubProjectOptionId('option-inbox')
const READY_OPTION_ID = githubProjectOptionId('option-ready')
const ISSUE_ID = githubIssueId('I_issue')
const ITEM_ID = githubProjectItemId('PVTI_item')
const INSTALLATION_PROFILE = {
  appId: githubAppId('1234'),
  installationId: INSTALLATION_ID,
  accountId: ACCOUNT_ID,
  privateKeyRef: credentialRef('SAKI_GITHUB_APP_PRIVATE_KEY'),
} as const

const INSTALLATION_REQUEST: GitHubInstallationReadRequest = {
  kind: 'installation',
  installation: INSTALLATION_PROFILE,
}

const SCAN_REQUEST: GitHubProjectBoardScanRequest = {
  kind: 'project-board',
  installation: INSTALLATION_PROFILE,
  projectId: PROJECT_ID,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  statusFieldId: STATUS_FIELD_ID,
  requiredStatusOptionIds: [INBOX_OPTION_ID, READY_OPTION_ID],
  priority: 'interactive',
  rateLimitReserve: 500,
}

const EXPECTED_INSTALLATION: GitHubInstallationFact = {
  installationId: INSTALLATION_ID,
  account: { id: ACCOUNT_ID, login: 'breakfast', type: 'organization' },
  repositorySelection: 'selected',
  permissions: {
    repository: [
      { name: 'actions', access: 'read' },
      { name: 'checks', access: 'read' },
      { name: 'contents', access: 'read' },
      { name: 'issues', access: 'write' },
      { name: 'metadata', access: 'read' },
      { name: 'pull_requests', access: 'write' },
      { name: 'statuses', access: 'read' },
    ],
    organization: [{ name: 'organization_projects', access: 'write' }],
  },
  accessibleRepositoryIds: [REPOSITORY_ID],
  tokenExpiresAt: TOKEN_EXPIRES_AT,
  observedAt: OBSERVED_AT,
}

const ISSUE = {
  id: ISSUE_ID,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  number: 27,
  state: 'open',
  title: 'Project one GitHub board',
  url: 'https://github.com/breakfast/saki/issues/27',
  updatedAt: UPDATED_AT,
} as const

const POSITION_PREDECESSOR_ISSUE = {
  ...ISSUE,
  id: githubIssueId('I_previous'),
  number: ISSUE.number + 1,
  title: 'Previous Work Item',
  url: 'https://github.com/breakfast/saki/issues/28',
}

const REST_RATE_OBSERVATION = {
  kind: 'rest',
  resource: 'core',
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: TOKEN_EXPIRES_AT,
  observedAt: OBSERVED_AT,
} as const

const GRAPHQL_RATE_OBSERVATION = {
  kind: 'graphql',
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: TOKEN_EXPIRES_AT,
  observedAt: OBSERVED_AT,
} as const

const SCAN_SOURCE: GitHubProjectBoardFingerprintSource = {
  kind: 'project-board',
  formatVersion: 1,
  installation: EXPECTED_INSTALLATION,
  repository: {
    id: REPOSITORY_ID,
    databaseId: REPOSITORY_DATABASE_ID,
    ownerAccountId: ACCOUNT_ID,
    nameWithOwner: 'breakfast/saki',
    visibility: 'private',
    url: 'https://github.com/breakfast/saki',
    updatedAt: UPDATED_AT,
    observedAt: OBSERVED_AT,
  },
  project: {
    id: PROJECT_ID,
    ownerAccountId: ACCOUNT_ID,
    number: 1,
    title: 'Saki',
    closed: false,
    url: 'https://github.com/orgs/breakfast/projects/1',
    updatedAt: UPDATED_AT,
    observedAt: OBSERVED_AT,
  },
  statusFieldId: STATUS_FIELD_ID,
  fields: [{
    kind: 'single-select',
    id: STATUS_FIELD_ID,
    name: 'Status',
    options: [
      { id: INBOX_OPTION_ID, name: 'Inbox' },
      { id: READY_OPTION_ID, name: 'Ready' },
    ],
  }],
  items: [{
    id: ITEM_ID,
    projectId: PROJECT_ID,
    content: { kind: 'issue', issue: ISSUE },
    statusOptionId: READY_OPTION_ID,
    archived: false,
    apiOrder: 0,
    updatedAt: UPDATED_AT,
  }],
  openIssues: [ISSUE],
  fences: {
    before: {
      projectUpdatedAt: UPDATED_AT,
      repositoryUpdatedAt: UPDATED_AT,
      projectItemCount: 1,
      openIssueCount: 1,
    },
    after: {
      projectUpdatedAt: UPDATED_AT,
      repositoryUpdatedAt: UPDATED_AT,
      projectItemCount: 1,
      openIssueCount: 1,
    },
  },
  rateObservations: [
    REST_RATE_OBSERVATION,
    ...Array.from({ length: 10 }, () => GRAPHQL_RATE_OBSERVATION),
  ],
  observedAt: OBSERVED_AT,
}

const EXPECTED_SCAN: GitHubProjectBoardScanCandidate = {
  ...SCAN_SOURCE,
  fingerprint: computeGitHubProjectBoardFingerprint(SCAN_SOURCE),
}

const EXPECTED_ISSUE_CREATE_RESULT: GitHubIssueCreateInspectionHint = {
  issueId: ISSUE.id,
  issueNumber: ISSUE.number,
}

const TARGETED_SNAPSHOT: GitHubTargetedWorkItemSnapshot = {
  repositoryId: STATUS_SET_REQUEST.repositoryId,
  repositoryDatabaseId: STATUS_SET_REQUEST.repositoryDatabaseId,
  projectId: STATUS_SET_REQUEST.projectId,
  statusFieldId: STATUS_SET_REQUEST.statusFieldId,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: STATUS_SET_REQUEST.projectItemId,
      projectId: STATUS_SET_REQUEST.projectId,
      issueId: STATUS_SET_REQUEST.issueId,
      statusOptionId: STATUS_SET_REQUEST.desiredStatusOptionId,
      archived: false,
      apiOrder: 0,
      totalCount: 1,
      previousItemId: null,
      nextItemId: null,
      updatedAt: UPDATED_AT,
    },
  },
}

const EXPECTED_MUTATION_INSPECTION: GitHubProjectItemStatusSetInspection = {
  snapshot: TARGETED_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const PROJECT_ITEM_ADD_SNAPSHOT: GitHubProjectItemAddInspection['snapshot'] = {
  repositoryId: PROJECT_ITEM_ADD_REQUEST.repositoryId,
  repositoryDatabaseId: PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId,
  projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: ITEM_ID,
      projectId: PROJECT_ITEM_ADD_REQUEST.projectId,
      issueId: PROJECT_ITEM_ADD_REQUEST.issueId,
      archived: false,
      apiOrder: 0,
      totalCount: 1,
      previousItemId: null,
      nextItemId: null,
      updatedAt: UPDATED_AT,
    },
  },
}

const EXPECTED_PROJECT_ITEM_ADD_INSPECTION: GitHubProjectItemAddInspection = {
  snapshot: PROJECT_ITEM_ADD_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const POSITION_SNAPSHOT: GitHubProjectItemPositionSetInspection['snapshot'] = {
  repositoryId: POSITION_SET_REQUEST.repositoryId,
  repositoryDatabaseId: POSITION_SET_REQUEST.repositoryDatabaseId,
  projectId: POSITION_SET_REQUEST.projectId,
  statusFieldId: POSITION_SET_REQUEST.statusFieldId,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: POSITION_SET_REQUEST.projectItemId,
      projectId: POSITION_SET_REQUEST.projectId,
      issueId: POSITION_SET_REQUEST.issueId,
      statusOptionId: READY_OPTION_ID,
      archived: false,
      apiOrder: 1,
      totalCount: 2,
      previousItemId: POSITION_SET_REQUEST.afterItemId,
      nextItemId: null,
      updatedAt: UPDATED_AT,
    },
  },
  after: {
    state: 'present',
    item: {
      id: POSITION_SET_REQUEST.afterItemId!,
      projectId: POSITION_SET_REQUEST.projectId,
      issue: POSITION_PREDECESSOR_ISSUE,
      statusOptionId: READY_OPTION_ID,
      archived: false,
      apiOrder: 0,
      totalCount: 2,
      previousItemId: null,
      nextItemId: POSITION_SET_REQUEST.projectItemId,
      updatedAt: UPDATED_AT,
    },
  },
}
const EXPECTED_POSITION_INSPECTION: GitHubProjectItemPositionSetInspection = {
  snapshot: POSITION_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const ISSUE_STATE_SNAPSHOT = {
  issue: ISSUE,
}
const EXPECTED_ISSUE_STATE_INSPECTION: GitHubIssueStateSetInspection = {
  snapshot: ISSUE_STATE_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const ISSUE_CREATE_SNAPSHOT: GitHubIssueCreateInspection['snapshot'] = {
  repositoryId: ISSUE_CREATE_REQUEST.repositoryId,
  repositoryDatabaseId: ISSUE_CREATE_REQUEST.repositoryDatabaseId,
  outcome: { state: 'unique-issue', issue: ISSUE },
}
const EXPECTED_ISSUE_CREATE_INSPECTION: GitHubIssueCreateInspection = {
  snapshot: ISSUE_CREATE_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

runGitHubProviderContract('Product App Octokit adapter', async () => {
  const ctx = new Context()
  const dateNow = vi.spyOn(Date, 'now').mockReturnValue(OBSERVED_AT)
  vi.stubGlobal('fetch', vi.fn(controlledGitHubFetch))
  try {
    new TestCredentials(ctx, privateKey, true)
    await ctx.plugin(SakiGitHubApp, {})
  } catch (error) {
    dateNow.mockRestore()
    vi.unstubAllGlobals()
    await ctx.fiber.dispose()
    throw error
  }
  return {
    github: ctx.sakiGitHub,
    installationRequest: INSTALLATION_REQUEST,
    scanRequest: SCAN_REQUEST,
    expectedInstallation: EXPECTED_INSTALLATION,
    expectedScan: EXPECTED_SCAN,
    projectItemAddRequest: PROJECT_ITEM_ADD_REQUEST,
    expectedProjectItemAddInspection: EXPECTED_PROJECT_ITEM_ADD_INSPECTION,
    positionRequest: POSITION_SET_REQUEST,
    expectedPositionInspection: EXPECTED_POSITION_INSPECTION,
    issueStateRequest: ISSUE_STATE_SET_REQUEST,
    expectedIssueStateInspection: EXPECTED_ISSUE_STATE_INSPECTION,
    issueCreateRequest: ISSUE_CREATE_REQUEST,
    expectedIssueCreateResult: EXPECTED_ISSUE_CREATE_RESULT,
    expectedIssueCreateInspection: EXPECTED_ISSUE_CREATE_INSPECTION,
    mutationRequest: STATUS_SET_REQUEST,
    expectedMutationInspection: EXPECTED_MUTATION_INSPECTION,
    dispose: async () => {
      await ctx.fiber.dispose()
      dateNow.mockRestore()
      vi.unstubAllGlobals()
    },
  }
})

async function controlledGitHubFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== 'https://api.github.com') throw new Error(`unexpected GitHub origin: ${url.origin}`)
  if (url.pathname === '/app/installations/12345/access_tokens') {
    const tokenRequest = JSON.parse(await request.text()) as {
      readonly permissions?: Readonly<Record<string, unknown>>
    }
    const permissions = tokenRequest.permissions
    if (![
      expectedReadPermissions,
      expectedProjectWritePermissions,
      expectedProjectReadPermissions,
      expectedIssueWritePermissions,
      expectedIssueReadPermissions,
    ]
      .some(expected => JSON.stringify(expected) === JSON.stringify(permissions))) {
      throw new Error(`unexpected Product App token permissions: ${JSON.stringify(permissions)}`)
    }
    return json({
      token: 'ghs_contract_fixture',
      expires_at: new Date(TOKEN_EXPIRES_AT).toISOString(),
      permissions,
      repository_selection: 'selected',
      repositories: [{ id: Number(REPOSITORY_DATABASE_ID) }],
    }, { status: 201 })
  }
  if (url.pathname === '/app/installations/12345') {
    return json({
      id: Number(INSTALLATION_ID),
      account: {
        id: 1,
        node_id: ACCOUNT_ID,
        login: 'breakfast',
        type: 'Organization',
      },
      repository_selection: 'selected',
      permissions: {
        actions: 'read',
        checks: 'read',
        contents: 'read',
        issues: 'write',
        metadata: 'read',
        organization_projects: 'write',
        pull_requests: 'write',
        statuses: 'read',
      },
      suspended_at: null,
    }, { headers: REST_RATE_HEADERS })
  }
  if (url.pathname === '/installation/repositories') {
    return json({
      total_count: 1,
      repositories: [{ id: Number(REPOSITORY_DATABASE_ID), node_id: REPOSITORY_ID }],
    }, { headers: REST_RATE_HEADERS })
  }
  if (url.pathname === '/repos/breakfast/saki/issues') {
    return json([issueCreateRestEntry()], { headers: REST_RATE_HEADERS })
  }
  if (url.pathname !== '/graphql') {
    throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
  }
  const body = JSON.parse(await request.text()) as { readonly query?: unknown }
  const query = String(body.query)
  if (query.includes('mutation SakiProjectItemStatusSet')) {
    return graphqlResponse({
      statusSet: {
        clientMutationId: STATUS_SET_REQUEST.operationId,
        projectV2Item: { id: STATUS_SET_REQUEST.projectItemId, project: { id: STATUS_SET_REQUEST.projectId } },
      },
    })
  }
  if (query.includes('mutation SakiProjectItemPositionSet')) {
    return graphqlResponse({ positionSet: { clientMutationId: POSITION_SET_REQUEST.operationId } })
  }
  if (query.includes('mutation SakiIssueStateSet')) {
    return graphqlResponse({
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
    })
  }
  if (query.includes('mutation SakiProjectItemAdd')) {
    return graphqlResponse({
      projectItemAdd: {
        clientMutationId: PROJECT_ITEM_ADD_REQUEST.operationId,
        item: { id: ITEM_ID, project: { id: PROJECT_ITEM_ADD_REQUEST.projectId } },
      },
    })
  }
  if (query.includes('mutation SakiIssueCreate')) {
    return graphqlResponse({
      issueCreate: {
        clientMutationId: ISSUE_CREATE_REQUEST.operationId,
        issue: {
          id: ISSUE.id,
          number: ISSUE.number,
          state: 'OPEN',
          title: ISSUE_CREATE_REQUEST.title,
          body: ISSUE_CREATE_REQUEST.body,
          url: ISSUE.url,
          updatedAt: new Date(UPDATED_AT).toISOString(),
          repository: {
            id: ISSUE_CREATE_REQUEST.repositoryId,
            databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
            owner: { id: ACCOUNT_ID },
          },
        },
      },
      rateLimit: RATE_LIMIT,
    })
  }
  if (query.includes('query SakiIssueCreateRepository')) {
    return graphqlResponse({
      repository: {
        __typename: 'Repository',
        id: ISSUE_CREATE_REQUEST.repositoryId,
        databaseId: Number(ISSUE_CREATE_REQUEST.repositoryDatabaseId),
        nameWithOwner: 'breakfast/saki',
        owner: { id: ACCOUNT_ID },
      },
      rateLimit: RATE_LIMIT,
    })
  }
  if (query.includes('query SakiProjectItemAddInspection')) {
    return graphqlResponse(projectItemAddInspectionData())
  }
  if (query.includes('query SakiProjectItemPositionInspection')) return graphqlResponse(positionInspectionData())
  if (query.includes('query SakiIssueStateInspection')) return graphqlResponse(issueStateInspectionData())
  if (query.includes('query SakiProjectItemPosition')) return graphqlResponse(targetedPositionData())
  if (query.includes('query SakiTargetedWorkItem')) return graphqlResponse(targetedWorkItemData())
  if (query.includes('query SakiProjectBoardFence')) return graphqlResponse(fenceData())
  if (query.includes('query SakiProjectFields')) return graphqlResponse(fieldsData())
  if (query.includes('query SakiProjectItems')) return graphqlResponse(itemsData())
  if (query.includes('query SakiOpenIssues')) return graphqlResponse(openIssuesData())
  throw new Error('unexpected GitHub GraphQL document')
}

const REST_RATE_HEADERS = {
  'x-ratelimit-limit': '5,000',
  'x-ratelimit-used': '1',
  'x-ratelimit-remaining': '4,999',
  'x-ratelimit-reset': String(TOKEN_EXPIRES_AT / 1_000),
  'x-ratelimit-resource': 'core',
}

const RATE_LIMIT = {
  cost: 1,
  limit: 5_000,
  used: 1,
  remaining: 4_999,
  resetAt: new Date(TOKEN_EXPIRES_AT).toISOString(),
}

function graphqlResponse(data: unknown): Response {
  return json({ data })
}

function issueCreateRestEntry(): Record<string, unknown> {
  return {
    id: 123,
    node_id: ISSUE.id,
    number: ISSUE.number,
    state: ISSUE.state,
    title: ISSUE.title,
    body: ISSUE_CREATE_REQUEST.body,
    html_url: ISSUE.url,
    created_at: new Date(UPDATED_AT - 1_000).toISOString(),
    updated_at: new Date(UPDATED_AT).toISOString(),
  }
}

function fenceData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: PROJECT_ID,
      number: 1,
      title: 'Saki',
      closed: false,
      url: 'https://github.com/orgs/breakfast/projects/1',
      updatedAt: new Date(UPDATED_AT).toISOString(),
      owner: { id: ACCOUNT_ID },
      items: { totalCount: 1 },
    },
    repository: {
      __typename: 'Repository',
      id: REPOSITORY_ID,
      databaseId: Number(REPOSITORY_DATABASE_ID),
      nameWithOwner: 'breakfast/saki',
      visibility: 'PRIVATE',
      url: 'https://github.com/breakfast/saki',
      updatedAt: new Date(UPDATED_AT).toISOString(),
      owner: { id: ACCOUNT_ID },
      issues: { totalCount: 1 },
    },
    rateLimit: RATE_LIMIT,
  }
}

function fieldsData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: PROJECT_ID,
      fields: {
        totalCount: 1,
        nodes: [{
          __typename: 'ProjectV2SingleSelectField',
          id: STATUS_FIELD_ID,
          name: 'Status',
          options: [
            { id: INBOX_OPTION_ID, name: 'Inbox' },
            { id: READY_OPTION_ID, name: 'Ready' },
          ],
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}

function itemsData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: PROJECT_ID,
      items: {
        totalCount: 1,
        nodes: [{
          id: ITEM_ID,
          isArchived: false,
          updatedAt: new Date(UPDATED_AT).toISOString(),
          content: {
            __typename: 'Issue',
            id: ISSUE_ID,
            number: 27,
            state: 'OPEN',
            title: 'Project one GitHub board',
            url: 'https://github.com/breakfast/saki/issues/27',
            updatedAt: new Date(UPDATED_AT).toISOString(),
            repository: { id: REPOSITORY_ID, databaseId: Number(REPOSITORY_DATABASE_ID) },
          },
          fieldValues: {
            totalCount: 1,
            nodes: [{
              __typename: 'ProjectV2ItemFieldSingleSelectValue',
              optionId: READY_OPTION_ID,
              field: { __typename: 'ProjectV2SingleSelectField', id: STATUS_FIELD_ID },
            }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}

function openIssuesData(): unknown {
  return {
    repository: {
      __typename: 'Repository',
      id: REPOSITORY_ID,
      databaseId: Number(REPOSITORY_DATABASE_ID),
      issues: {
        nodes: [{
          id: ISSUE_ID,
          number: 27,
          state: 'OPEN',
          title: 'Project one GitHub board',
          url: 'https://github.com/breakfast/saki/issues/27',
          updatedAt: new Date(UPDATED_AT).toISOString(),
          repository: { id: REPOSITORY_ID, databaseId: Number(REPOSITORY_DATABASE_ID) },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}

function projectItemAddInspectionData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: PROJECT_ITEM_ADD_REQUEST.projectId,
      updatedAt: new Date(UPDATED_AT).toISOString(),
      owner: { id: ACCOUNT_ID },
      items: {
        totalCount: 1,
        nodes: [{
          __typename: 'ProjectV2Item',
          id: ITEM_ID,
          isArchived: false,
          updatedAt: new Date(UPDATED_AT).toISOString(),
          project: {
            id: PROJECT_ITEM_ADD_REQUEST.projectId,
            updatedAt: new Date(UPDATED_AT).toISOString(),
            owner: { id: ACCOUNT_ID },
          },
          content: {
            __typename: 'Issue',
            id: PROJECT_ITEM_ADD_REQUEST.issueId,
            repository: {
              id: PROJECT_ITEM_ADD_REQUEST.repositoryId,
              databaseId: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId),
              owner: { id: ACCOUNT_ID },
            },
          },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    repository: {
      __typename: 'Repository',
      id: PROJECT_ITEM_ADD_REQUEST.repositoryId,
      databaseId: Number(PROJECT_ITEM_ADD_REQUEST.repositoryDatabaseId),
      owner: { id: ACCOUNT_ID },
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
        owner: { id: ACCOUNT_ID },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}

function positionInspectionData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: POSITION_SET_REQUEST.projectId,
      updatedAt: new Date(UPDATED_AT).toISOString(),
      owner: { id: ACCOUNT_ID },
      items: {
        totalCount: 2,
        nodes: [
          {
            __typename: 'ProjectV2Item',
            id: POSITION_SET_REQUEST.afterItemId,
            isArchived: false,
            updatedAt: new Date(UPDATED_AT).toISOString(),
            project: {
              id: POSITION_SET_REQUEST.projectId,
              updatedAt: new Date(UPDATED_AT).toISOString(),
              owner: { id: ACCOUNT_ID },
            },
            content: {
              __typename: 'Issue',
              id: POSITION_PREDECESSOR_ISSUE.id,
              number: POSITION_PREDECESSOR_ISSUE.number,
              state: 'OPEN',
              title: POSITION_PREDECESSOR_ISSUE.title,
              url: POSITION_PREDECESSOR_ISSUE.url,
              updatedAt: new Date(POSITION_PREDECESSOR_ISSUE.updatedAt).toISOString(),
              repository: {
                id: POSITION_SET_REQUEST.repositoryId,
                databaseId: Number(POSITION_SET_REQUEST.repositoryDatabaseId),
                owner: { id: ACCOUNT_ID },
              },
            },
            fieldValues: {
              totalCount: 1,
              nodes: [{
                __typename: 'ProjectV2ItemFieldSingleSelectValue',
                optionId: READY_OPTION_ID,
                field: { id: POSITION_SET_REQUEST.statusFieldId },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          {
            __typename: 'ProjectV2Item',
            id: POSITION_SET_REQUEST.projectItemId,
            isArchived: false,
            updatedAt: new Date(UPDATED_AT).toISOString(),
            project: {
              id: POSITION_SET_REQUEST.projectId,
              updatedAt: new Date(UPDATED_AT).toISOString(),
              owner: { id: ACCOUNT_ID },
            },
            content: {
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
                owner: { id: ACCOUNT_ID },
              },
            },
            fieldValues: {
              totalCount: 1,
              nodes: [{
                __typename: 'ProjectV2ItemFieldSingleSelectValue',
                optionId: READY_OPTION_ID,
                field: { id: POSITION_SET_REQUEST.statusFieldId },
              }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    repository: {
      __typename: 'Repository',
      id: POSITION_SET_REQUEST.repositoryId,
      databaseId: Number(POSITION_SET_REQUEST.repositoryDatabaseId),
      owner: { id: ACCOUNT_ID },
    },
    issue: issueInspectionNode(),
    statusField: {
      __typename: 'ProjectV2SingleSelectField',
      id: POSITION_SET_REQUEST.statusFieldId,
      project: { id: POSITION_SET_REQUEST.projectId },
    },
    rateLimit: RATE_LIMIT,
  }
}

function issueStateInspectionData(): unknown {
  return {
    repository: {
      __typename: 'Repository',
      id: ISSUE_STATE_SET_REQUEST.repositoryId,
      databaseId: Number(ISSUE_STATE_SET_REQUEST.repositoryDatabaseId),
      owner: { id: ACCOUNT_ID },
    },
    issue: issueInspectionNode(),
    rateLimit: RATE_LIMIT,
  }
}

function issueInspectionNode(): unknown {
  return {
    __typename: 'Issue',
    id: ISSUE.id,
    number: ISSUE.number,
    state: 'OPEN',
    title: ISSUE.title,
    url: ISSUE.url,
    updatedAt: new Date(ISSUE.updatedAt).toISOString(),
    repository: {
      id: ISSUE.repositoryId,
      databaseId: Number(ISSUE.repositoryDatabaseId),
      owner: { id: ACCOUNT_ID },
    },
  }
}

function targetedPositionData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: STATUS_SET_REQUEST.projectId,
      updatedAt: new Date(UPDATED_AT).toISOString(),
      items: {
        totalCount: 1,
        nodes: [{
          id: STATUS_SET_REQUEST.projectItemId,
          content: { __typename: 'Issue', id: STATUS_SET_REQUEST.issueId },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}

function targetedWorkItemData(): unknown {
  return {
    project: {
      __typename: 'ProjectV2',
      id: STATUS_SET_REQUEST.projectId,
      updatedAt: new Date(UPDATED_AT).toISOString(),
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
    item: {
      __typename: 'ProjectV2Item',
      id: STATUS_SET_REQUEST.projectItemId,
      isArchived: false,
      updatedAt: new Date(UPDATED_AT).toISOString(),
      project: { id: STATUS_SET_REQUEST.projectId, updatedAt: new Date(UPDATED_AT).toISOString() },
      content: {
        __typename: 'Issue', id: STATUS_SET_REQUEST.issueId, updatedAt: new Date(ISSUE.updatedAt).toISOString(),
      },
      fieldValues: {
        totalCount: 1,
        nodes: [{
          __typename: 'ProjectV2ItemFieldSingleSelectValue',
          optionId: STATUS_SET_REQUEST.desiredStatusOptionId,
          field: { id: STATUS_SET_REQUEST.statusFieldId },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    statusField: {
      __typename: 'ProjectV2SingleSelectField',
      id: STATUS_SET_REQUEST.statusFieldId,
      project: { id: STATUS_SET_REQUEST.projectId },
      options: [{ id: STATUS_SET_REQUEST.desiredStatusOptionId }],
    },
    rateLimit: RATE_LIMIT,
  }
}
