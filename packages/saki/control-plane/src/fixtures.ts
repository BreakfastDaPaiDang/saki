/**
 * Secret-free access, Project, and GitHub synchronization fixtures for frontend Consumers.
 * @module @breakfastdapaidang/saki-control-plane/fixtures
 */

import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
} from '@breakfastdapaidang/saki-execution'
import type {
  InheritedChangeBaseline,
  ProjectSelectionProjection,
  TrustedProjectSelectionObservation,
  WorkspaceId,
} from '@breakfastdapaidang/saki-execution'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'

import type {
  AccessProjection,
  GitHubAccountId,
  GitHubAppId,
  GitHubInstallationId,
  GitHubIssueId,
  GitHubProjectBoardFingerprint,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
  GitHubSynchronizationConfiguration,
  RegisterDevelopmentProjectIntent,
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
  SakiBoardProjection,
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiControlIntentId,
  SakiConfirmedBoardProjection,
  SakiDevelopmentProjectId,
  SakiDevelopmentWorkspaceProjection,
  SakiGitHubScanAttemptId,
  SakiGitHubSyncCheckpointProjection,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiProjectSelectionInspectionProjection,
  SakiProjectIndexProjection,
  SakiProjectSettingsProjection,
  SakiQuery,
  SakiQueryResult,
  SakiResourceBindingId,
} from './types.ts'

/** Display-only placeholder Principal id used by authenticated fixtures. */
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000001' as import('./types.ts').SakiPrincipalId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002' as import('./types.ts').SakiHostId
const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000003' as SakiDevelopmentProjectId
const BINDING_ID = 'binding-00000000-0000-4000-8000-000000000004' as SakiResourceBindingId
const WORKSPACE_ID = 'workspace-fixture' as WorkspaceId
const INTENT_ID = 'intent-00000000-0000-4000-8000-000000000005' as SakiControlIntentId
const DUPLICATE_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000006' as SakiControlIntentId
const RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000005' as SakiIntentReceiptId
const DUPLICATE_RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000006' as SakiIntentReceiptId
const GITHUB_APP_ID = '12345' as GitHubAppId
const GITHUB_INSTALLATION_ID = '12345678' as GitHubInstallationId
const GITHUB_ACCOUNT_ID = 'O_fixture_account' as GitHubAccountId
const GITHUB_REPOSITORY_ID = 'R_fixture_repository' as GitHubRepositoryId
const GITHUB_REPOSITORY_DATABASE_ID = '87654321' as GitHubRepositoryDatabaseId
const GITHUB_PROJECT_ID = 'PVT_fixture_project' as GitHubProjectId
const GITHUB_STATUS_FIELD_ID = 'PVTSSF_fixture_status' as GitHubProjectFieldId
const GITHUB_ISSUE_ID = 'I_fixture_issue_27' as GitHubIssueId
const GITHUB_PROJECT_ITEM_ID = 'PVTI_fixture_item_27' as GitHubProjectItemId
const ACTIVATION_SCAN_ATTEMPT_ID = 'scan-attempt-00000000-0000-4000-8000-000000000007' as SakiGitHubScanAttemptId
const CONFIRMED_SCAN_ATTEMPT_ID = 'scan-attempt-00000000-0000-4000-8000-000000000008' as SakiGitHubScanAttemptId
const FAILED_SCAN_ATTEMPT_ID = 'scan-attempt-00000000-0000-4000-8000-000000000009' as SakiGitHubScanAttemptId
const BOARD_OBSERVED_AT = 1_787_101_190_000
const BOARD_CONFIRMED_AT = 1_787_101_200_000
const ACTIVE_POLL_INTERVAL_MS = 30_000
const BASELINE_BOUNDS = {
  maxEntries: 10,
  maxPathBytes: 1_024,
  maxGitOutputBytes: 1_024,
  maxFileBytes: 1_024,
  maxTotalFileBytes: 4_096,
  maxCaptureMs: 1_000,
} as const
const TRUSTED_FIXTURE = {
  canonicalWorktreePath: '/fixture/repository',
  canonicalGitDirectory: '/fixture/repository/.git',
  canonicalCommonGitDirectory: '/fixture/repository/.git',
  gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
  comparison: { fileMode: true, symlinks: true, autocrlf: false },
} as const satisfies TrustedProjectSelectionObservation

function signedBaseline<const T extends {
  readonly formatVersion: 1
  readonly bounds: object
  readonly observed: { readonly elapsedMs: number }
  readonly entries: readonly object[]
}>(material: T): T & { readonly digest: string } {
  return {
    ...material,
    digest: canonicalDigest('saki/inherited-baseline/v1', {
      formatVersion: material.formatVersion,
      bounds: material.bounds,
      observed: { ...material.observed, elapsedMs: 0 },
      entries: material.entries,
    }),
  }
}

const CLEAN_BASELINE = signedBaseline({
  kind: 'complete',
  formatVersion: 1,
  capturedAt: 1_787_101_200_000,
  bounds: BASELINE_BOUNDS,
  observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 2 },
  entries: [],
} as const) satisfies InheritedChangeBaseline

const DIRTY_ENTRY_MATERIAL = {
  formatVersion: 1,
  pathDigest: '1'.repeat(64),
  statusKind: 'untracked',
  worktree: {
    kind: 'regular',
    mode: '100644',
    byteLength: 6,
    contentDigest: '2'.repeat(64),
  },
} as const
const DIRTY_ENTRY = {
  ...DIRTY_ENTRY_MATERIAL,
  digest: canonicalDigest('saki/inherited-entry/v1', DIRTY_ENTRY_MATERIAL),
}
const DIRTY_BASELINE = signedBaseline({
  kind: 'complete',
  formatVersion: 1,
  capturedAt: 1_787_101_200_000,
  bounds: BASELINE_BOUNDS,
  observed: { entries: 1, pathBytes: 11, gitOutputBytes: 0, hashedBytes: 6, elapsedMs: 3 },
  entries: [DIRTY_ENTRY],
} as const) satisfies InheritedChangeBaseline

function selection(
  baseline: InheritedChangeBaseline,
  workspaceId?: WorkspaceId,
): ProjectSelectionProjection {
  const material = {
    observationVersion: 1,
    hostId: HOST_ID,
    displayLocation: 'repository',
    objectFormat: 'sha1',
    head: '3'.repeat(40),
    branch: 'main',
    detached: false,
    locked: false,
    inheritedChangeEntryCount: baseline.observed.entries,
    conversionAmbiguous: false,
    remotes: [{ transport: 'https', coordinate: 'example.invalid/team/repository' }],
    ...(workspaceId === undefined ? {} : { workspaceId }),
    automaticMutationEligible: baseline.observed.entries === 0,
    blockingReasons: baseline.observed.entries === 0 ? [] : ['dirty'],
    baseline,
  } as const satisfies Omit<ProjectSelectionProjection, 'fingerprint'>
  return {
    ...material,
    fingerprint: computeProjectInspectionFingerprint(material, TRUSTED_FIXTURE),
  }
}

const CLEAN_SELECTION = selection(CLEAN_BASELINE)
const CURRENT_SELECTION = selection(CLEAN_BASELINE, WORKSPACE_ID)
const DIRTY_SELECTION = selection(DIRTY_BASELINE)

/** Browser-originated Project query and Intent examples. */
export const SAKI_PROJECT_REQUEST_FIXTURES = Object.freeze({
  cleanInspection: {
    type: 'inspect-project-selection', hostId: HOST_ID, directoryLocator: 'selected-directory',
  },
  invalidDirectoryInspection: {
    type: 'inspect-project-selection', hostId: HOST_ID, directoryLocator: 'missing-directory',
  },
  projectIndex: { type: 'project-index' },
  developmentWorkspace: {
    type: 'development-workspace', projectId: PROJECT_ID, expectedRegistryRevision: 1,
  },
  registration: {
    type: 'register-development-project',
    intentId: INTENT_ID,
    projectTitle: 'Fixture project',
    hostId: HOST_ID,
    directoryLocator: 'selected-directory',
    expectedRegistryRevision: 0,
    confirmedFingerprint: CLEAN_SELECTION.fingerprint,
    confirmedBaseline: CLEAN_SELECTION.baseline,
  },
  projectSettings: { type: 'project-settings', projectId: PROJECT_ID },
  cachedBoard: { type: 'board', projectId: PROJECT_ID, refresh: 'cached' },
  interactiveBoard: { type: 'board', projectId: PROJECT_ID, refresh: 'interactive' },
} as const satisfies Record<string, SakiQuery | RegisterDevelopmentProjectIntent>)

const PROJECT_SUMMARY = {
  id: PROJECT_ID,
  revision: 0,
  projectTitle: 'Fixture project',
  binding: {
    id: BINDING_ID,
    revision: 0,
    health: 'active',
    hostId: HOST_ID,
    displayLocation: CURRENT_SELECTION.displayLocation,
    head: CURRENT_SELECTION.head,
    branch: 'main',
    detached: CURRENT_SELECTION.detached,
    inheritedChangeEntryCount: 0,
    baseline: 'complete',
    automaticMutationEligible: true,
    configurationGaps: [],
  },
} as const

/** Browser-safe Project selection, index, and workspace Projection examples. */
export const SAKI_PROJECT_PROJECTION_FIXTURES = Object.freeze({
  cleanSelection: CLEAN_SELECTION,
  dirtySelection: DIRTY_SELECTION,
  cleanInspection: {
    type: 'inspect-project-selection', result: { ok: true, selection: CLEAN_SELECTION },
  } as const satisfies SakiProjectSelectionInspectionProjection,
  dirtyInspection: {
    type: 'inspect-project-selection', result: { ok: true, selection: DIRTY_SELECTION },
  } as const satisfies SakiProjectSelectionInspectionProjection,
  invalidDirectoryInspection: {
    type: 'inspect-project-selection', result: { ok: false, reason: 'missing' },
  } as const satisfies SakiProjectSelectionInspectionProjection,
  projectIndex: {
    type: 'project-index', revision: 1, hosts: [{ id: HOST_ID, revision: 0, state: 'enrolled' }],
    projects: [PROJECT_SUMMARY],
  } as const satisfies SakiProjectIndexProjection,
  developmentWorkspace: {
    type: 'development-workspace',
    registryRevision: 1,
    project: PROJECT_SUMMARY,
    currentSelection: CURRENT_SELECTION,
    recovery: { state: 'ready', reasons: [] },
  } as const satisfies SakiDevelopmentWorkspaceProjection,
})

const GITHUB_STATUS_OPTION_IDS = {
  inbox: 'option-inbox' as GitHubProjectOptionId,
  backlog: 'option-backlog' as GitHubProjectOptionId,
  ready: 'option-ready' as GitHubProjectOptionId,
  inProgress: 'option-in-progress' as GitHubProjectOptionId,
  inReview: 'option-in-review' as GitHubProjectOptionId,
  done: 'option-done' as GitHubProjectOptionId,
  canceled: 'option-canceled' as GitHubProjectOptionId,
} as const

const ACTIVE_GITHUB_CONFIGURATION = {
  appId: GITHUB_APP_ID,
  githubInstallationId: GITHUB_INSTALLATION_ID,
  accountNodeId: GITHUB_ACCOUNT_ID,
  repositoryNodeId: GITHUB_REPOSITORY_ID,
  repositoryDatabaseId: GITHUB_REPOSITORY_DATABASE_ID,
  projectNodeId: GITHUB_PROJECT_ID,
  credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY' as CredentialRef,
  statusFieldNodeId: GITHUB_STATUS_FIELD_ID,
  statusOptionNodeIds: GITHUB_STATUS_OPTION_IDS,
  activePollIntervalMs: ACTIVE_POLL_INTERVAL_MS,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
} as const satisfies GitHubSynchronizationConfiguration

const UPDATED_GITHUB_CONFIGURATION = {
  ...ACTIVE_GITHUB_CONFIGURATION,
  activePollIntervalMs: 45_000,
} as const satisfies GitHubSynchronizationConfiguration

const CHECKPOINT = {
  generation: 1,
  configurationRevision: 1,
  attemptId: CONFIRMED_SCAN_ATTEMPT_ID,
  installationId: GITHUB_INSTALLATION_ID,
  repositoryId: GITHUB_REPOSITORY_ID,
  projectId: GITHUB_PROJECT_ID,
  statusFieldId: GITHUB_STATUS_FIELD_ID,
  sourceFingerprint: { version: 1, digest: '5'.repeat(64) } as GitHubProjectBoardFingerprint,
  observedAt: BOARD_OBSERVED_AT,
  confirmedAt: BOARD_CONFIRMED_AT,
  rateLimit: {
    state: 'available',
    observedAt: BOARD_OBSERVED_AT,
    minimumRemaining: 4_900,
    resetAt: BOARD_CONFIRMED_AT + 60_000,
  },
} as const satisfies SakiGitHubSyncCheckpointProjection

const BOARD_WORK_ITEM_ID = `work-item-${canonicalDigest('saki/board-work-item/v1', {
  repositoryId: GITHUB_REPOSITORY_ID,
  issueId: GITHUB_ISSUE_ID,
})}` as SakiBoardWorkItemId

const BOARD_REMOTE_FINGERPRINT = `remote-fingerprint-${canonicalDigest('saki/board-remote-fingerprint/v1', {
  membership: { state: 'joined', projectItemId: GITHUB_PROJECT_ITEM_ID },
  statusOptionId: GITHUB_STATUS_OPTION_IDS.ready,
  archived: false,
  issueState: 'open',
  apiOrder: 0,
  previousProjectItemId: undefined,
  nextProjectItemId: undefined,
})}` as SakiBoardRemoteFingerprint

const CONFIRMED_BOARD = {
  generation: 1,
  configurationRevision: 1,
  repository: {
    id: GITHUB_REPOSITORY_ID,
    nameWithOwner: 'BreakfastDaPaiDang/saki',
    url: 'https://github.example.invalid/BreakfastDaPaiDang/saki',
  },
  project: {
    id: GITHUB_PROJECT_ID,
    title: 'Saki 0.1.0',
    url: 'https://github.example.invalid/orgs/BreakfastDaPaiDang/projects/1',
  },
  items: [{
    id: BOARD_WORK_ITEM_ID,
    title: 'Ship the read-only GitHub Board projection',
    issueNumber: 27,
    url: 'https://github.example.invalid/BreakfastDaPaiDang/saki/issues/27',
    issueState: 'open',
    status: 'ready',
    order: 0,
    archived: false,
    notInProject: false,
    updatedAt: BOARD_OBSERVED_AT,
    source: {
      kind: 'github-issue',
      repositoryId: GITHUB_REPOSITORY_ID,
      issueId: GITHUB_ISSUE_ID,
      projectItemId: GITHUB_PROJECT_ITEM_ID,
      apiOrder: 0,
    },
    remoteFingerprint: BOARD_REMOTE_FINGERPRINT,
  }],
} as const satisfies SakiConfirmedBoardProjection

const ACTIVE_SYNCHRONIZATION_CONFIGURATION = {
  revision: 1,
  configuration: ACTIVE_GITHUB_CONFIGURATION,
  activatedAt: BOARD_CONFIRMED_AT,
} as const

const SAVED_PENDING_CONFIGURATION = {
  revision: 2,
  changedFields: ['activePollIntervalMs'],
  state: 'saved',
  configuration: UPDATED_GITHUB_CONFIGURATION,
  savedAt: BOARD_CONFIRMED_AT + 5_000,
} as const

const ACTIVATING_PENDING_CONFIGURATION = {
  ...SAVED_PENDING_CONFIGURATION,
  state: 'activating',
} as const

const FRESH_BOARD = {
  state: 'fresh',
  confirmedAt: BOARD_CONFIRMED_AT,
  staleAt: BOARD_CONFIRMED_AT + ACTIVE_POLL_INTERVAL_MS,
  ageMs: 10_000,
} as const

const PENDING_SYNCHRONIZATION_EVIDENCE_FIXTURE = {
  checkpoint: CHECKPOINT,
  mapping: { state: 'revalidation-required', configurationRevision: 2 },
  freshness: FRESH_BOARD,
  scan: {
    state: 'scheduled',
    priority: 'interactive',
    reason: 'configuration',
    attemptAt: BOARD_CONFIRMED_AT + 6_000,
  },
  effectiveMutationAvailability: {
    available: false,
    reasons: ['configuration-not-activated', 'mapping-revalidation-required', 'no-concrete-mutation'],
  },
} as const

const STALE_BOARD = {
  state: 'stale',
  confirmedAt: BOARD_CONFIRMED_AT,
  staleAt: BOARD_CONFIRMED_AT + ACTIVE_POLL_INTERVAL_MS,
  ageMs: 45_000,
} as const

/** Board Projection examples spanning initial setup, retained confirmation, revalidation, and failure. */
export const SAKI_BOARD_PROJECTION_FIXTURES = Object.freeze({
  unconfigured: {
    type: 'board',
    projectId: PROJECT_ID,
    state: 'unconfigured',
    synchronizationRevision: 0,
    mapping: { state: 'unconfigured' },
    freshness: { state: 'unavailable' },
    scan: { state: 'idle' },
    effectiveMutationAvailability: {
      available: false,
      reasons: ['synchronization-unconfigured', 'checkpoint-unavailable', 'no-concrete-mutation'],
    },
  } as const satisfies SakiBoardProjection,
  awaitingFirstCheckpoint: {
    type: 'board',
    projectId: PROJECT_ID,
    state: 'awaiting-first-checkpoint',
    synchronizationRevision: 1,
    mapping: { state: 'revalidation-required', configurationRevision: 1 },
    freshness: { state: 'unavailable' },
    scan: {
      state: 'scheduled', priority: 'interactive', reason: 'configuration', attemptAt: BOARD_CONFIRMED_AT,
    },
    effectiveMutationAvailability: {
      available: false,
      reasons: [
        'configuration-not-activated',
        'mapping-revalidation-required',
        'checkpoint-unavailable',
        'no-concrete-mutation',
      ],
    },
  } as const satisfies SakiBoardProjection,
  mappingRevalidation: {
    type: 'board',
    projectId: PROJECT_ID,
    state: 'confirmed',
    synchronizationRevision: 2,
    confirmed: CONFIRMED_BOARD,
    ...PENDING_SYNCHRONIZATION_EVIDENCE_FIXTURE,
  } as const satisfies SakiBoardProjection,
  confirmedStaleFailure: {
    type: 'board',
    projectId: PROJECT_ID,
    state: 'confirmed',
    synchronizationRevision: 1,
    confirmed: CONFIRMED_BOARD,
    checkpoint: CHECKPOINT,
    mapping: { state: 'valid', configurationRevision: 1, validatedAt: BOARD_CONFIRMED_AT },
    failure: {
      attemptId: FAILED_SCAN_ATTEMPT_ID,
      configurationRevision: 1,
      failedAt: BOARD_CONFIRMED_AT + 40_000,
      failure: {
        kind: 'provider',
        failure: { code: 'transient-transport', retryAfterMs: 10_000, requestId: 'fixture-request' },
      },
    },
    freshness: STALE_BOARD,
    scan: {
      state: 'scheduled',
      priority: 'background',
      reason: 'retry',
      attemptAt: BOARD_CONFIRMED_AT + 50_000,
    },
    effectiveMutationAvailability: { available: false, reasons: ['no-concrete-mutation'] },
  } as const satisfies SakiBoardProjection,
})

/** Project Settings Projection examples for saved, activating, and activated synchronization states. */
export const SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES = Object.freeze({
  saved: {
    type: 'project-settings',
    projectId: PROJECT_ID,
    synchronization: {
      revision: 2,
      state: 'saved',
      active: ACTIVE_SYNCHRONIZATION_CONFIGURATION,
      pending: SAVED_PENDING_CONFIGURATION,
      ...PENDING_SYNCHRONIZATION_EVIDENCE_FIXTURE,
    },
  } as const satisfies SakiProjectSettingsProjection,
  activating: {
    type: 'project-settings',
    projectId: PROJECT_ID,
    synchronization: {
      revision: 2,
      state: 'activating',
      active: ACTIVE_SYNCHRONIZATION_CONFIGURATION,
      pending: ACTIVATING_PENDING_CONFIGURATION,
      checkpoint: CHECKPOINT,
      mapping: { state: 'revalidation-required', configurationRevision: 2 },
      freshness: FRESH_BOARD,
      scan: {
        state: 'in-flight',
        attemptId: ACTIVATION_SCAN_ATTEMPT_ID,
        priority: 'interactive',
        configurationRevision: 2,
        startedAt: BOARD_CONFIRMED_AT + 6_000,
        expiresAt: BOARD_CONFIRMED_AT + 306_000,
      },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'mapping-revalidation-required', 'no-concrete-mutation'],
      },
    },
  } as const satisfies SakiProjectSettingsProjection,
  activated: {
    type: 'project-settings',
    projectId: PROJECT_ID,
    synchronization: {
      revision: 1,
      state: 'activated',
      active: ACTIVE_SYNCHRONIZATION_CONFIGURATION,
      checkpoint: CHECKPOINT,
      mapping: { state: 'valid', configurationRevision: 1, validatedAt: BOARD_CONFIRMED_AT },
      freshness: FRESH_BOARD,
      scan: { state: 'idle' },
      effectiveMutationAvailability: { available: false, reasons: ['no-concrete-mutation'] },
    },
  } as const satisfies SakiProjectSettingsProjection,
})

/** Confirmed and duplicate-binding registration receipt examples. */
export const SAKI_PROJECT_RECEIPT_FIXTURES = Object.freeze({
  confirmed: {
    ok: true,
    receipt: {
      id: RECEIPT_ID,
      intentId: INTENT_ID,
      state: 'confirmed',
      projectId: PROJECT_ID,
      resourceBindingId: BINDING_ID,
      registryRevision: 1,
    },
  },
  duplicate: {
    ok: false,
    reason: 'conflict',
    receipt: {
      id: DUPLICATE_RECEIPT_ID,
      intentId: DUPLICATE_INTENT_ID,
      state: 'conflict',
      reason: 'duplicate-binding',
    },
  },
} as const satisfies Record<string, SakiIntentReceipt>)

/** Closed Access fixtures with no Installation or challenge identifiers. */
export const SAKI_ACCESS_FIXTURES = Object.freeze({
  bootstrapRequired: { kind: 'bootstrap-required', message: 'Local bootstrap is required.' },
  sessionRequired: { kind: 'session-required', message: 'A local browser session is required.' },
  unavailable: { kind: 'unavailable', message: 'Local access is temporarily unavailable.' },
  authenticated: {
    kind: 'authenticated',
    principal: { id: PRINCIPAL_ID, displayName: 'Host Operator' },
    expiresAt: 1_787_104_800_000,
    requestToken: '<session-derived-request-token>',
  },
} as const satisfies Record<string, AccessProjection>)

/** Empty authenticated Project-index Projection fixture. */
export const SAKI_EMPTY_PROJECT_INDEX_FIXTURE = Object.freeze({
  type: 'project-index',
  revision: 0,
  hosts: [{ id: HOST_ID, revision: 0, state: 'enrolled' }],
  projects: [],
} as const satisfies SakiProjectIndexProjection)

/** Stable access mutation fixtures; cookie material is deliberately absent. */
export const SAKI_ACCESS_RESULT_FIXTURES = Object.freeze({
  exchangeConfirmed: { ok: true, access: SAKI_ACCESS_FIXTURES.authenticated },
  exchangeConflict: { ok: false, reason: 'unavailable' },
  replay: { ok: false, reason: 'unavailable' },
  originRejected: { ok: false, reason: 'unavailable' },
  requestTokenRejected: { ok: false, reason: 'unavailable' },
  logoutConfirmed: { ok: true },
} as const satisfies Record<string, SakiAccessExchangeResult | SakiAccessLogoutResult>)

/** Protected query and Intent-denial fixtures. */
export const SAKI_CONTROL_RESULT_FIXTURES = Object.freeze({
  emptyProjectIndex: { ok: true, projection: SAKI_EMPTY_PROJECT_INDEX_FIXTURE },
  cleanInspection: { ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanInspection },
  dirtyInspection: { ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.dirtyInspection },
  invalidDirectory: { ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.invalidDirectoryInspection },
  projectIndex: { ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.projectIndex },
  developmentWorkspace: { ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace },
  confirmedBoard: { ok: true, projection: SAKI_BOARD_PROJECTION_FIXTURES.confirmedStaleFailure },
  mappingRevalidationBoard: { ok: true, projection: SAKI_BOARD_PROJECTION_FIXTURES.mappingRevalidation },
  savedProjectSettings: { ok: true, projection: SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.saved },
  activatingProjectSettings: { ok: true, projection: SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activating },
  activatedProjectSettings: { ok: true, projection: SAKI_PROJECT_SETTINGS_PROJECTION_FIXTURES.activated },
  registrationConfirmed: SAKI_PROJECT_RECEIPT_FIXTURES.confirmed,
  duplicateRegistration: SAKI_PROJECT_RECEIPT_FIXTURES.duplicate,
  currentGrantDenied: { ok: false, reason: 'denied' },
  intentDenied: { ok: false, reason: 'denied' },
} as const satisfies Record<string, SakiQueryResult | SakiIntentReceipt>)

/** Redacted lifecycle fixtures for durable access-state presentation tests. */
export const SAKI_ACCESS_LIFECYCLE_FIXTURES = Object.freeze({
  challenges: ['issued', 'consumed', 'expired', 'revoked'],
  sessions: ['active', 'expired', 'revoked', 'restart-restored', 'principal-unavailable', 'current-grant-denied'],
  exchange: ['in-progress', 'confirmed', 'conflict'],
} as const)

/** Redacted durable-record fixtures with identities, revisions, server times, and no verifier bytes. */
export const SAKI_SECURITY_RECORD_FIXTURES = Object.freeze({
  challenges: {
    issued: {
      id: 'challenge-issued', revision: 0, state: 'issued', issuedAt: 1_787_101_200_000,
      expiresAt: 1_787_102_100_000, verifier: { algorithm: 'sha-256', redacted: true },
    },
    consumed: {
      id: 'challenge-consumed', revision: 1, state: 'consumed', terminalAt: 1_787_101_260_000,
      browserSessionId: 'browser-session-active', verifier: { algorithm: 'sha-256', redacted: true },
    },
    expired: {
      id: 'challenge-expired', revision: 1, state: 'expired', terminalAt: 1_787_102_100_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
    revoked: {
      id: 'challenge-revoked', revision: 1, state: 'revoked', terminalAt: 1_787_101_230_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
  },
  sessions: {
    active: {
      id: 'browser-session-active', revision: 0, state: 'active', createdAt: 1_787_101_260_000,
      expiresAt: 1_787_144_460_000, verifier: { algorithm: 'sha-256', redacted: true },
    },
    expired: {
      id: 'browser-session-expired', revision: 1, state: 'expired', terminalAt: 1_787_144_460_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
    revoked: {
      id: 'browser-session-revoked', revision: 1, state: 'revoked', terminalAt: 1_787_101_320_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
  },
} as const)
