import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  computeGitHubProjectBoardFingerprint,
  githubAccountId,
  githubAppId,
  githubExternalOperationId,
  githubInstallationId,
  githubIssueId,
  githubIssueCreateMarkerId,
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
  GitHubIssueStateSetRequest,
  GitHubIssueStateSetInspection,
  GitHubIssueCreateInspectionHint,
  GitHubIssueCreateInspection,
  GitHubIssueCreateRequest,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectItemAddRequest,
  GitHubProjectItemAddInspection,
  GitHubProjectItemPositionSetRequest,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  GitHubTargetedWorkItemSnapshot,
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
const PREVIOUS_ISSUE_ID = githubIssueId('I_previous')
const ITEM_ID = githubProjectItemId('PVTI_item')
export const PREVIOUS_ITEM_ID = githubProjectItemId('PVTI_previous')
export const ISSUE_CREATE_MARKER_ID = githubIssueCreateMarkerId(`work-item-marker-${'1'.repeat(64)}`)

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

const PREVIOUS_ISSUE = {
  ...ISSUE,
  id: PREVIOUS_ISSUE_ID,
  number: ISSUE.number + 1,
  title: 'Previous Work Item',
  url: 'https://github.example/owner/repo/issues/28',
}

export const COMPLETE_SCAN: GitHubProjectBoardScanCandidate = {
  ...SCAN_WITHOUT_FINGERPRINT,
  fingerprint: computeGitHubProjectBoardFingerprint(SCAN_WITHOUT_FINGERPRINT),
}

export const STATUS_SET_REQUEST: GitHubProjectItemStatusSetRequest = {
  kind: 'project-item-status-set',
  operationId: githubExternalOperationId('operation:status:27'),
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  projectItemId: ITEM_ID,
  statusFieldId: STATUS_FIELD_ID,
  desiredStatusOptionId: INBOX_OPTION_ID,
}

export const PROJECT_ITEM_ADD_REQUEST: GitHubProjectItemAddRequest = {
  kind: 'project-item-add',
  operationId: githubExternalOperationId('operation:add:27'),
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
}

export const POSITION_SET_REQUEST: GitHubProjectItemPositionSetRequest = {
  kind: 'project-item-position-set',
  operationId: githubExternalOperationId('operation:position:27'),
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  projectItemId: ITEM_ID,
  statusFieldId: STATUS_FIELD_ID,
  afterItemId: PREVIOUS_ITEM_ID,
}

export const ISSUE_STATE_SET_REQUEST: GitHubIssueStateSetRequest = {
  kind: 'issue-state-set',
  operationId: githubExternalOperationId('operation:issue-state:27'),
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  issueId: ISSUE_ID,
  desiredState: 'closed',
}

export const ISSUE_CREATE_REQUEST: GitHubIssueCreateRequest = {
  kind: 'issue-create',
  operationId: githubExternalOperationId('operation:issue-create:27'),
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  title: ISSUE.title,
  body: `Create the tracked Work Item.\n\n<!-- saki-work-item:${ISSUE_CREATE_MARKER_ID} -->\n`,
  markerId: ISSUE_CREATE_MARKER_ID,
}

export const ISSUE_CREATE_RESULT: GitHubIssueCreateInspectionHint = {
  issueId: ISSUE.id,
  issueNumber: ISSUE.number,
}

const ISSUE_CREATE_SNAPSHOT: GitHubIssueCreateInspection['snapshot'] = {
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  outcome: { state: 'unique-issue', issue: ISSUE },
}

export const ISSUE_CREATE_INSPECTION: GitHubIssueCreateInspection = {
  snapshot: ISSUE_CREATE_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const POSITION_SET_SNAPSHOT: GitHubProjectItemPositionSetInspection['snapshot'] = {
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  statusFieldId: STATUS_FIELD_ID,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: ITEM_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      statusOptionId: READY_OPTION_ID,
      archived: false,
      apiOrder: 1,
      totalCount: 2,
      previousItemId: PREVIOUS_ITEM_ID,
      nextItemId: null,
      updatedAt: OBSERVED_AT - 500,
    },
  },
  after: {
    state: 'present',
    item: {
      id: PREVIOUS_ITEM_ID,
      projectId: PROJECT_ID,
      issue: PREVIOUS_ISSUE,
      statusOptionId: READY_OPTION_ID,
      archived: false,
      apiOrder: 0,
      totalCount: 2,
      previousItemId: null,
      nextItemId: ITEM_ID,
      updatedAt: OBSERVED_AT - 500,
    },
  },
}

export const POSITION_SET_INSPECTION: GitHubProjectItemPositionSetInspection = {
  snapshot: POSITION_SET_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

const ISSUE_STATE_SNAPSHOT = {
  issue: ISSUE,
}
export const ISSUE_STATE_SET_INSPECTION: GitHubIssueStateSetInspection = {
  snapshot: ISSUE_STATE_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

export const PROJECT_ITEM_ADD_SNAPSHOT: GitHubProjectItemAddInspection['snapshot'] = {
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: ITEM_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      archived: false,
    },
  },
}

export const PROJECT_ITEM_ADD_INSPECTION: GitHubProjectItemAddInspection = {
  snapshot: PROJECT_ITEM_ADD_SNAPSHOT,
  observedAt: OBSERVED_AT,
}

export const TARGETED_SNAPSHOT: GitHubTargetedWorkItemSnapshot = {
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
  projectId: PROJECT_ID,
  statusFieldId: STATUS_FIELD_ID,
  issue: ISSUE,
  membership: {
    state: 'present',
    item: {
      id: ITEM_ID,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
      statusOptionId: READY_OPTION_ID,
      archived: false,
      apiOrder: 0,
      totalCount: 1,
      previousItemId: null,
      nextItemId: null,
      updatedAt: OBSERVED_AT - 500,
    },
  },
}

export const STATUS_SET_INSPECTION: GitHubProjectItemStatusSetInspection = {
  snapshot: TARGETED_SNAPSHOT,
  observedAt: OBSERVED_AT,
}
