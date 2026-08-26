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
} from '../src/index.ts'
import type {
  GitHubInstallationFact,
  GitHubInstallationReadRequest,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
} from '../src/index.ts'

export const OBSERVED_AT = 1_800_000_000_000
const ACCOUNT_ID = githubAccountId('O_account')
const INSTALLATION_ID = githubInstallationId('12345')
export const REPOSITORY_ID = githubRepositoryId('R_repository')
export const REPOSITORY_DATABASE_ID = githubRepositoryDatabaseId('67890')
export const PROJECT_ID = githubProjectId('P_project')
export const STATUS_FIELD_ID = githubProjectFieldId('PVTF_status')
export const INBOX_OPTION_ID = githubProjectOptionId('option-inbox')
export const READY_OPTION_ID = githubProjectOptionId('option-ready')
const ISSUE_ID = githubIssueId('I_issue')
const ITEM_ID = githubProjectItemId('PVTI_item')

export const INSTALLATION_PROFILE = {
  appId: githubAppId('1234'),
  installationId: INSTALLATION_ID,
  accountId: ACCOUNT_ID,
  privateKeyRef: credentialRef('SAKI_GITHUB_APP_PRIVATE_KEY'),
} as const

export const INSTALLATION_REQUEST: GitHubInstallationReadRequest = {
  kind: 'installation',
  installation: INSTALLATION_PROFILE,
}

export const SCAN_REQUEST: GitHubProjectBoardScanRequest = {
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

export const INSTALLATION: GitHubInstallationFact = {
  installationId: INSTALLATION_ID,
  account: { id: ACCOUNT_ID, login: 'breakfast', type: 'organization' },
  repositorySelection: 'selected',
  permissions: {
    repository: [
      { name: 'contents', access: 'read' },
      { name: 'issues', access: 'write' },
      { name: 'metadata', access: 'read' },
    ],
    organization: [{ name: 'projects', access: 'write' }],
  },
  accessibleRepositoryIds: [REPOSITORY_ID],
  tokenExpiresAt: OBSERVED_AT + 3_600_000,
  observedAt: OBSERVED_AT,
}

export const ISSUE = {
  id: ISSUE_ID,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  number: 27,
  state: 'open',
  title: 'Project one GitHub board',
  url: 'https://github.com/breakfast/saki/issues/27',
  updatedAt: OBSERVED_AT - 1_000,
} as const

export const SCAN_WITHOUT_FINGERPRINT: GitHubProjectBoardFingerprintSource = {
  kind: 'project-board',
  formatVersion: 1,
  installation: INSTALLATION,
  repository: {
    id: REPOSITORY_ID,
    databaseId: REPOSITORY_DATABASE_ID,
    ownerAccountId: ACCOUNT_ID,
    nameWithOwner: 'breakfast/saki',
    visibility: 'private',
    url: 'https://github.com/breakfast/saki',
    updatedAt: OBSERVED_AT - 500,
    observedAt: OBSERVED_AT,
  },
  project: {
    id: PROJECT_ID,
    ownerAccountId: ACCOUNT_ID,
    number: 1,
    title: 'Saki',
    closed: false,
    url: 'https://github.com/orgs/breakfast/projects/1',
    updatedAt: OBSERVED_AT - 500,
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
    updatedAt: OBSERVED_AT - 500,
  }],
  openIssues: [ISSUE],
  fences: {
    before: {
      projectUpdatedAt: OBSERVED_AT - 500,
      repositoryUpdatedAt: OBSERVED_AT - 500,
      projectItemCount: 1,
      openIssueCount: 1,
    },
    after: {
      projectUpdatedAt: OBSERVED_AT - 500,
      repositoryUpdatedAt: OBSERVED_AT - 500,
      projectItemCount: 1,
      openIssueCount: 1,
    },
  },
  rateObservations: [{
    kind: 'graphql',
    cost: 1,
    limit: 5_000,
    used: 1,
    remaining: 4_999,
    resetAt: OBSERVED_AT + 3_600_000,
    observedAt: OBSERVED_AT,
  }],
  observedAt: OBSERVED_AT,
}

export const COMPLETE_SCAN: GitHubProjectBoardScanCandidate = {
  ...SCAN_WITHOUT_FINGERPRINT,
  fingerprint: computeGitHubProjectBoardFingerprint(SCAN_WITHOUT_FINGERPRINT),
}
