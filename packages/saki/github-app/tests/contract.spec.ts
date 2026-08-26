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
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
} from '@breakfastdapaidang/saki-github'
import { vi } from 'vitest'
import { runGitHubProviderContract } from '../../github/tests/contract.ts'
import SakiGitHubApp from '../src/index.ts'
import { expectedReadPermissions, json, privateKey, TestCredentials } from './harness.ts'

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
    REST_RATE_OBSERVATION,
    ...Array.from({ length: 10 }, () => GRAPHQL_RATE_OBSERVATION),
  ],
  observedAt: OBSERVED_AT,
}

const EXPECTED_SCAN: GitHubProjectBoardScanCandidate = {
  ...SCAN_SOURCE,
  fingerprint: computeGitHubProjectBoardFingerprint(SCAN_SOURCE),
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
    return json({
      token: 'ghs_contract_fixture',
      expires_at: new Date(TOKEN_EXPIRES_AT).toISOString(),
      permissions: expectedReadPermissions,
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
  if (url.pathname !== '/graphql') {
    throw new Error(`unexpected GitHub request: ${request.method} ${url.pathname}`)
  }
  const body = JSON.parse(await request.text()) as { readonly query?: unknown }
  const query = String(body.query)
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
      databaseId: REPOSITORY_DATABASE_ID,
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
            repository: { id: REPOSITORY_ID, databaseId: REPOSITORY_DATABASE_ID },
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
      databaseId: REPOSITORY_DATABASE_ID,
      issues: {
        nodes: [{
          id: ISSUE_ID,
          number: 27,
          state: 'OPEN',
          title: 'Project one GitHub board',
          url: 'https://github.com/breakfast/saki/issues/27',
          updatedAt: new Date(UPDATED_AT).toISOString(),
          repository: { id: REPOSITORY_ID, databaseId: REPOSITORY_DATABASE_ID },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    rateLimit: RATE_LIMIT,
  }
}
