/**
 * Secret-free access, Project, and GitHub synchronization fixtures for frontend Consumers.
 * @module @breakfastdapaidang/saki-control-plane/fixtures
 */

import {
  canonicalDigest,
  computeProjectInspectionFingerprint,
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
} from '@breakfastdapaidang/saki-execution'
import type {
  HostOperationId,
  InheritedChangeBaseline,
  ProjectGitChangeFingerprintMaterial,
  ProjectGitStatusObservation,
  ProjectGitStatusSeedMaterial,
  ProjectSelectionProjection,
  SessionId,
  SakiAgentProfileId,
  SakiAgentRunId,
  SakiWorkSessionId,
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
  SakiAgentRunProjection,
  SakiBoardProjection,
  SakiBoardMutationOverlayProjection,
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiControlIntentId,
  SakiConfirmedBoardProjection,
  SakiDevelopmentProjectId,
  SakiDevelopmentWorkspaceProjection,
  SakiGitOperationIntent,
  SakiGitHubScanAttemptId,
  SakiGitHubSyncCheckpointProjection,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiProjectSelectionInspectionProjection,
  SakiProjectChangesProjection,
  SakiProjectDiffProjection,
  SakiProjectIndexProjection,
  SakiProjectSettingsProjection,
  SakiQuery,
  SakiQueryResult,
  SakiResourceBindingId,
  SakiWorkAssignmentId,
  SakiWorkItemDetailProjection,
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
const STAGE_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000010' as SakiControlIntentId
const UNSTAGE_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000011' as SakiControlIntentId
const COMMIT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000012' as SakiControlIntentId
const CURRENT_AGENT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000020' as SakiControlIntentId
const CANCELED_AGENT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000021' as SakiControlIntentId
const RECONCILIATION_AGENT_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000022' as SakiControlIntentId
const CREATE_WORK_ITEM_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000013' as SakiControlIntentId
const MOVE_WORK_ITEM_INTENT_ID = 'intent-00000000-0000-4000-8000-000000000014' as SakiControlIntentId
const CREATE_WORK_ITEM_RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000013' as SakiIntentReceiptId
const MOVE_WORK_ITEM_RECEIPT_ID = 'receipt-00000000-0000-4000-8000-000000000014' as SakiIntentReceiptId
const STAGE_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000010' as HostOperationId
const UNSTAGE_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000011' as HostOperationId
const COMMIT_OPERATION_ID = 'host-operation-00000000-0000-4000-8000-000000000012' as HostOperationId
const AGENT_PROFILE_ID = 'agent-profile-00000000-0000-4000-8000-000000000020' as SakiAgentProfileId
const CURRENT_ASSIGNMENT_ID = 'assignment-00000000-0000-4000-8000-000000000020' as SakiWorkAssignmentId
const CANCELED_ASSIGNMENT_ID = 'assignment-00000000-0000-4000-8000-000000000021' as SakiWorkAssignmentId
const RECONCILIATION_ASSIGNMENT_ID = 'assignment-00000000-0000-4000-8000-000000000022' as SakiWorkAssignmentId
const CURRENT_WORK_SESSION_ID = 'work-session-00000000-0000-4000-8000-000000000020' as SakiWorkSessionId
const CANCELED_WORK_SESSION_ID = 'work-session-00000000-0000-4000-8000-000000000021' as SakiWorkSessionId
const RECONCILIATION_WORK_SESSION_ID = 'work-session-00000000-0000-4000-8000-000000000022' as SakiWorkSessionId
const CURRENT_AGENT_RUN_ID = 'agent-run-00000000-0000-4000-8000-000000000020' as SakiAgentRunId
const CANCELED_AGENT_RUN_ID = 'agent-run-00000000-0000-4000-8000-000000000021' as SakiAgentRunId
const RECONCILIATION_AGENT_RUN_ID = 'agent-run-00000000-0000-4000-8000-000000000022' as SakiAgentRunId
const CURRENT_DSH_SESSION_ID = 'session-00000000-0000-4000-8000-000000000020' as SessionId
const CANCELED_DSH_SESSION_ID = 'session-00000000-0000-4000-8000-000000000021' as SessionId
const RECONCILIATION_DSH_SESSION_ID = 'session-00000000-0000-4000-8000-000000000022' as SessionId
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
    observationVersion: 2,
    hostId: HOST_ID,
    displayLocation: 'repository',
    objectFormat: 'sha1',
    head: { kind: 'commit', objectId: '3'.repeat(40), symbolicRef: 'refs/heads/main' },
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
    objectFormat: CURRENT_SELECTION.objectFormat,
    head: CURRENT_SELECTION.head,
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

const GIT_OBSERVED_AT = 1_787_101_230_000
const FIXTURE_HEAD = {
  kind: 'commit', objectId: '3'.repeat(40), symbolicRef: 'refs/heads/main',
} as const
const DIRTY_INDEX = { kind: 'tree', treeId: '5'.repeat(40) } as const
const DIRTY_WORKTREE = { version: 1, digest: '6'.repeat(64) } as const
const GIT_STATUS_BASE = {
  observationVersion: 1,
  bindingId: BINDING_ID,
  bindingRevision: 0,
  bindingHealth: 'active',
  locked: false,
  objectFormat: 'sha1',
  head: FIXTURE_HEAD,
  branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' },
} as const

function signedGitChange<const T extends ProjectGitChangeFingerprintMaterial>(material: T) {
  return { ...material, fingerprint: computeProjectGitChangeFingerprint(material) }
}

function identifiedGitChange<const T extends ProjectGitStatusSeedMaterial['changes'][number]>(
  seedDigest: string,
  change: T,
) {
  return { id: computeProjectGitChangeId(seedDigest, change), ...change }
}

function signedGitStatus(seed: ProjectGitStatusSeedMaterial): ProjectGitStatusObservation {
  const seedDigest = computeProjectGitStatusSeedDigest(seed)
  const observed = {
    ...seed,
    observedAt: GIT_OBSERVED_AT,
    changes: seed.changes.map(change => identifiedGitChange(seedDigest, change)),
  }
  return { ...observed, fingerprint: computeProjectGitStatusFingerprint(observed) }
}

const CLEAN_GIT_STATUS = signedGitStatus({
  ...GIT_STATUS_BASE,
  upstream: { ref: 'refs/remotes/origin/main', name: 'origin/main', divergence: { ahead: 0, behind: 0 } },
  index: { kind: 'tree', treeId: '4'.repeat(40) },
  worktree: { version: 1, digest: '4'.repeat(64) },
  changes: [],
  structuredMutation: { available: true, blockers: [] },
})

const DIRTY_UNTRACKED_CHANGE_MATERIAL = signedGitChange({
  kind: 'untracked',
  path: 'new.txt',
  indexStatus: 'absent',
  worktreeStatus: 'untracked',
  submodule: { kind: 'not-submodule' },
  worktreeMode: '100644',
  worktreeEvidence: {
    kind: 'regular', mode: '100644', byteLength: 4, contentDigest: '7'.repeat(64),
  },
  attribution: 'unattributed',
})
const DIRTY_STAGED_CHANGE_MATERIAL = signedGitChange({
  kind: 'ordinary',
  path: 'staged.txt',
  indexStatus: 'modified',
  worktreeStatus: 'unchanged',
  submodule: { kind: 'not-submodule' },
  head: { mode: '100644', objectId: '1'.repeat(40) },
  index: { mode: '100644', objectId: '2'.repeat(40) },
  worktreeMode: '100644',
  worktreeEvidence: {
    kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '8'.repeat(64),
  },
  attribution: 'not-inherited',
})
const DIRTY_UNSTAGED_CHANGE_MATERIAL = signedGitChange({
  kind: 'ordinary',
  path: 'unstaged.txt',
  indexStatus: 'unchanged',
  worktreeStatus: 'modified',
  submodule: { kind: 'not-submodule' },
  head: { mode: '100644', objectId: '1'.repeat(40) },
  index: { mode: '100644', objectId: '1'.repeat(40) },
  worktreeMode: '100644',
  worktreeEvidence: {
    kind: 'regular', mode: '100644', byteLength: 9, contentDigest: '9'.repeat(64),
  },
  attribution: 'inherited',
})
const DIRTY_GIT_STATUS_SEED = {
  ...GIT_STATUS_BASE,
  upstream: { ref: 'refs/remotes/origin/main', name: 'origin/main', divergence: { ahead: 1, behind: 0 } },
  index: DIRTY_INDEX,
  worktree: DIRTY_WORKTREE,
  changes: [
    DIRTY_UNTRACKED_CHANGE_MATERIAL,
    DIRTY_STAGED_CHANGE_MATERIAL,
    DIRTY_UNSTAGED_CHANGE_MATERIAL,
  ],
  structuredMutation: { available: true, blockers: [] },
} as const satisfies ProjectGitStatusSeedMaterial
const DIRTY_GIT_STATUS_SEED_DIGEST = computeProjectGitStatusSeedDigest(DIRTY_GIT_STATUS_SEED)
const DIRTY_GIT_STATUS = signedGitStatus(DIRTY_GIT_STATUS_SEED)
const DIRTY_UNTRACKED_CHANGE = identifiedGitChange(DIRTY_GIT_STATUS_SEED_DIGEST, DIRTY_UNTRACKED_CHANGE_MATERIAL)
const DIRTY_STAGED_CHANGE = identifiedGitChange(DIRTY_GIT_STATUS_SEED_DIGEST, DIRTY_STAGED_CHANGE_MATERIAL)
const DIRTY_UNSTAGED_CHANGE = identifiedGitChange(DIRTY_GIT_STATUS_SEED_DIGEST, DIRTY_UNSTAGED_CHANGE_MATERIAL)

const CONFLICTED_GIT_STATUS = signedGitStatus({
  ...GIT_STATUS_BASE,
  index: { kind: 'unmerged', stagesDigest: { version: 1, digest: 'a'.repeat(64) } },
  worktree: { version: 1, digest: 'b'.repeat(64) },
  changes: [signedGitChange({
    kind: 'unmerged',
    path: 'conflicted.txt',
    indexStatus: 'unmerged',
    worktreeStatus: 'present',
    conflict: 'both-modified',
    submodule: { kind: 'not-submodule' },
    stages: {
      base: { mode: '100644', objectId: '1'.repeat(40) },
      ours: { mode: '100644', objectId: '2'.repeat(40) },
      theirs: { mode: '100644', objectId: '3'.repeat(40) },
    },
    worktreeMode: '100644',
    worktreeEvidence: {
      kind: 'regular', mode: '100644', byteLength: 18, contentDigest: 'c'.repeat(64),
    },
    attribution: 'not-inherited',
  })],
  structuredMutation: { available: false, blockers: ['unmerged'] },
})

const GIT_MUTATION_EXPECTATION = {
  projectId: PROJECT_ID,
  expectedRegistryRevision: 1,
  expectedProjectRevision: 0,
  expectedBinding: { id: BINDING_ID, revision: 0 },
  expectedStatus: DIRTY_GIT_STATUS.fingerprint,
  expectedHead: FIXTURE_HEAD,
  expectedIndex: DIRTY_INDEX,
  expectedWorktree: DIRTY_WORKTREE,
} as const

/** Browser-safe Changes and bounded Diff query examples plus path-free mutation Intents. */
export const SAKI_GIT_REQUEST_FIXTURES = Object.freeze({
  changes: { type: 'project-changes', projectId: PROJECT_ID, expectedRegistryRevision: 1 },
  diff: {
    type: 'project-diff',
    projectId: PROJECT_ID,
    expectedRegistryRevision: 1,
    request: {
      expectedStatus: DIRTY_GIT_STATUS.fingerprint,
      changeId: DIRTY_UNSTAGED_CHANGE.id,
      layer: 'unstaged',
    },
  },
  stage: {
    type: 'stage-files',
    intentId: STAGE_INTENT_ID,
    expected: GIT_MUTATION_EXPECTATION,
    changes: [
      { id: DIRTY_UNSTAGED_CHANGE.id, fingerprint: DIRTY_UNSTAGED_CHANGE.fingerprint },
      { id: DIRTY_UNTRACKED_CHANGE.id, fingerprint: DIRTY_UNTRACKED_CHANGE.fingerprint },
    ],
  },
  unstage: {
    type: 'unstage-files',
    intentId: UNSTAGE_INTENT_ID,
    expected: GIT_MUTATION_EXPECTATION,
    changes: [{ id: DIRTY_STAGED_CHANGE.id, fingerprint: DIRTY_STAGED_CHANGE.fingerprint }],
  },
  commit: {
    type: 'create-commit',
    intentId: COMMIT_INTENT_ID,
    expected: GIT_MUTATION_EXPECTATION,
    message: 'Record fixture changes',
  },
} as const satisfies Record<string, SakiQuery | SakiGitOperationIntent>)

const AVAILABLE_GIT_OPERATIONS = {
  stageFiles: { available: true, reasons: [] },
  unstageFiles: { available: true, reasons: [] },
  createCommit: { available: true, reasons: [] },
} as const
const CLEAN_GIT_OPERATIONS = {
  ...AVAILABLE_GIT_OPERATIONS,
  createCommit: { available: false, reasons: ['no-staged-changes'] },
} as const
const CONFLICTED_GIT_OPERATIONS = {
  stageFiles: { available: false, reasons: ['unmerged'] },
  unstageFiles: { available: false, reasons: ['unmerged'] },
  createCommit: { available: false, reasons: ['unmerged'] },
} as const

/** Changes Projection examples for clean, dirty, and conflicted repositories. */
export const SAKI_GIT_CHANGES_PROJECTION_FIXTURES = Object.freeze({
  clean: {
    type: 'project-changes', registryRevision: 1, projectId: PROJECT_ID, projectRevision: 0,
    result: { ok: true, observation: CLEAN_GIT_STATUS },
    gitOperations: CLEAN_GIT_OPERATIONS,
  } as const satisfies SakiProjectChangesProjection,
  dirty: {
    type: 'project-changes', registryRevision: 1, projectId: PROJECT_ID, projectRevision: 0,
    result: { ok: true, observation: DIRTY_GIT_STATUS },
    gitOperations: AVAILABLE_GIT_OPERATIONS,
  } as const satisfies SakiProjectChangesProjection,
  conflict: {
    type: 'project-changes', registryRevision: 1, projectId: PROJECT_ID, projectRevision: 0,
    result: { ok: true, observation: CONFLICTED_GIT_STATUS },
    gitOperations: CONFLICTED_GIT_OPERATIONS,
  } as const satisfies SakiProjectChangesProjection,
})

const DIFF_LINES = [
  'diff --git a/unstaged.txt b/unstaged.txt',
  '--- a/unstaged.txt',
  '+++ b/unstaged.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
] as const
const DIFF_UTF8_BYTES = DIFF_LINES.reduce(
  (bytes, line) => bytes + new TextEncoder().encode(line).byteLength + 1,
  0,
)

/** Bounded file Diff Projection examples for success and stale observation evidence. */
export const SAKI_GIT_DIFF_PROJECTION_FIXTURES = Object.freeze({
  success: {
    type: 'project-diff',
    registryRevision: 1,
    projectId: PROJECT_ID,
    projectRevision: 0,
    result: {
      ok: true,
      page: {
        pageVersion: 1,
        observation: DIRTY_GIT_STATUS.fingerprint,
        changeId: DIRTY_UNSTAGED_CHANGE.id,
        layer: 'unstaged',
        patchFingerprint: { version: 1, digest: 'd'.repeat(64) },
        range: { startLine: 0, endLineExclusive: DIFF_LINES.length, totalLines: DIFF_LINES.length },
        lines: DIFF_LINES,
        pageUtf8Bytes: DIFF_UTF8_BYTES,
        totalUtf8Bytes: DIFF_UTF8_BYTES,
        omittedBeforeLines: 0,
        omittedAfterLines: 0,
        truncated: false,
      },
    },
  } as const satisfies SakiProjectDiffProjection,
  stale: {
    type: 'project-diff',
    registryRevision: 1,
    projectId: PROJECT_ID,
    projectRevision: 0,
    result: { ok: false, reason: 'observation-stale' },
  } as const satisfies SakiProjectDiffProjection,
})

const STAGE_OPERATION = {
  id: STAGE_OPERATION_ID, type: 'stage-files', revision: 4,
} as const
const UNSTAGE_OPERATION = {
  id: UNSTAGE_OPERATION_ID, type: 'unstage-files', revision: 4,
} as const
const COMMIT_OPERATION = {
  id: COMMIT_OPERATION_ID, type: 'commit', revision: 4,
} as const
const GIT_COMMIT_SIGNATURE = {
  name: 'Fixture Operator',
  email: 'fixture@example.test',
  timestamp: 1_787_101_240,
  timezone: '+0800',
  source: 'git-config',
} as const

/** Terminal structured-operation examples for success, conflict, failure, cancellation, and unknown effect. */
export const SAKI_GIT_OPERATION_RESULT_FIXTURES = Object.freeze({
  stageSuccess: {
    ok: true,
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000010' as SakiIntentReceiptId,
      intentId: STAGE_INTENT_ID,
      type: 'stage-files',
      projectId: PROJECT_ID,
      state: 'succeeded',
      operation: { ...STAGE_OPERATION, state: 'succeeded' },
      result: {
        type: 'stage-files',
        changes: [
          { id: DIRTY_UNSTAGED_CHANGE.id, fingerprint: DIRTY_UNSTAGED_CHANGE.fingerprint, path: 'unstaged.txt' },
          { id: DIRTY_UNTRACKED_CHANGE.id, fingerprint: DIRTY_UNTRACKED_CHANGE.fingerprint, path: 'new.txt' },
        ],
        resultingIndex: { kind: 'tree', treeId: 'e'.repeat(40) },
      },
    },
  },
  unstageSuccess: {
    ok: true,
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000011' as SakiIntentReceiptId,
      intentId: UNSTAGE_INTENT_ID,
      type: 'unstage-files',
      projectId: PROJECT_ID,
      state: 'succeeded',
      operation: { ...UNSTAGE_OPERATION, state: 'succeeded' },
      result: {
        type: 'unstage-files',
        changes: [{ id: DIRTY_STAGED_CHANGE.id, fingerprint: DIRTY_STAGED_CHANGE.fingerprint, path: 'staged.txt' }],
        resultingIndex: { kind: 'tree', treeId: 'f'.repeat(40) },
      },
    },
  },
  commitSuccess: {
    ok: true,
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000012' as SakiIntentReceiptId,
      intentId: COMMIT_INTENT_ID,
      type: 'create-commit',
      projectId: PROJECT_ID,
      state: 'succeeded',
      operation: { ...COMMIT_OPERATION, state: 'succeeded' },
      result: {
        type: 'commit',
        commitId: 'a'.repeat(40),
        treeId: 'e'.repeat(40),
        parent: { kind: 'commit', objectId: FIXTURE_HEAD.objectId },
        target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
        author: GIT_COMMIT_SIGNATURE,
        committer: GIT_COMMIT_SIGNATURE,
      },
    },
  },
  conflict: {
    ok: false,
    reason: 'conflict',
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000013' as SakiIntentReceiptId,
      intentId: 'intent-00000000-0000-4000-8000-000000000013' as SakiControlIntentId,
      type: 'stage-files',
      projectId: PROJECT_ID,
      state: 'conflict',
      reason: 'expected-evidence',
    },
  },
  failure: {
    ok: false,
    reason: 'failure',
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000014' as SakiIntentReceiptId,
      intentId: 'intent-00000000-0000-4000-8000-000000000014' as SakiControlIntentId,
      type: 'stage-files',
      projectId: PROJECT_ID,
      state: 'failed',
      reason: 'invalid-selection',
      operation: { ...STAGE_OPERATION, state: 'failed' },
    },
  },
  cancellation: {
    ok: false,
    reason: 'canceled',
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000015' as SakiIntentReceiptId,
      intentId: 'intent-00000000-0000-4000-8000-000000000015' as SakiControlIntentId,
      type: 'unstage-files',
      projectId: PROJECT_ID,
      state: 'canceled',
      reason: 'source-canceled',
      operation: { ...UNSTAGE_OPERATION, state: 'canceled' },
    },
  },
  unknownOutcome: {
    ok: false,
    reason: 'reconciliation-required',
    receipt: {
      id: 'receipt-00000000-0000-4000-8000-000000000016' as SakiIntentReceiptId,
      intentId: 'intent-00000000-0000-4000-8000-000000000016' as SakiControlIntentId,
      type: 'create-commit',
      projectId: PROJECT_ID,
      state: 'reconciliation-required',
      reason: 'effect-unknown',
      operation: { ...COMMIT_OPERATION, state: 'reconciliation-required' },
    },
  },
} as const satisfies Record<string, SakiIntentReceipt<'stage-files' | 'unstage-files' | 'create-commit'>>)

/** Protected structured Git query examples, including a stale Registry observation. */
export const SAKI_GIT_QUERY_RESULT_FIXTURES = Object.freeze({
  clean: { ok: true, projection: SAKI_GIT_CHANGES_PROJECTION_FIXTURES.clean },
  dirty: { ok: true, projection: SAKI_GIT_CHANGES_PROJECTION_FIXTURES.dirty },
  stale: { ok: false, reason: 'stale' },
  conflict: { ok: true, projection: SAKI_GIT_CHANGES_PROJECTION_FIXTURES.conflict },
  diff: { ok: true, projection: SAKI_GIT_DIFF_PROJECTION_FIXTURES.success },
} as const satisfies Record<string, SakiQueryResult>)

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
    latestNonTerminalStatus: 'ready',
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

/** Durable Work Item mutation overlays layered over a complete Board checkpoint. */
export const SAKI_BOARD_MUTATION_OVERLAY_FIXTURES = Object.freeze({
  optimisticMove: {
    state: 'optimistic',
    intentId: MOVE_WORK_ITEM_INTENT_ID,
    type: 'move-work-item',
    workItemId: BOARD_WORK_ITEM_ID,
    targetStatus: 'in-progress',
  },
  targetedConfirmed: {
    state: 'targeted-confirmed',
    intentId: MOVE_WORK_ITEM_INTENT_ID,
    type: 'move-work-item',
    workItem: {
      ...CONFIRMED_BOARD.items[0],
      status: 'in-progress',
      latestNonTerminalStatus: 'in-progress',
      remoteFingerprint: `remote-fingerprint-${'7'.repeat(64)}` as SakiBoardRemoteFingerprint,
    },
    confirmedAt: BOARD_CONFIRMED_AT + 10_000,
  },
  conflict: {
    state: 'conflict',
    intentId: MOVE_WORK_ITEM_INTENT_ID,
    type: 'move-work-item',
    reason: 'stale-remote',
    workItem: {
      ...CONFIRMED_BOARD.items[0],
      status: 'backlog',
      latestNonTerminalStatus: 'backlog',
      remoteFingerprint: `remote-fingerprint-${'8'.repeat(64)}` as SakiBoardRemoteFingerprint,
    },
    confirmedAt: BOARD_CONFIRMED_AT + 10_000,
  },
  partialFailure: {
    state: 'partial-failure',
    intentId: CREATE_WORK_ITEM_INTENT_ID,
    type: 'create-work-item',
    workItemId: BOARD_WORK_ITEM_ID,
    stage: 'project-item-add',
    recoveryAction: { kind: 'resume-intent' },
  },
  reconciliationRequired: {
    state: 'reconciliation-required',
    intentId: CREATE_WORK_ITEM_INTENT_ID,
    type: 'create-work-item',
    stage: 'issue-create',
    reason: 'marker-ambiguous',
  },
  repairRequired: {
    state: 'repair-required',
    workItemId: BOARD_WORK_ITEM_ID,
    reason: 'external-close',
    action: 'move-with-actor',
    suggestedStatus: 'done',
  },
} as const satisfies Record<string, SakiBoardMutationOverlayProjection>)

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
    reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
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
      reasons: ['synchronization-unconfigured', 'checkpoint-unavailable'],
    },
    mutationOverlays: [],
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
      ],
    },
    mutationOverlays: [],
  } as const satisfies SakiBoardProjection,
  mappingRevalidation: {
    type: 'board',
    projectId: PROJECT_ID,
    state: 'confirmed',
    synchronizationRevision: 2,
    confirmed: CONFIRMED_BOARD,
    ...PENDING_SYNCHRONIZATION_EVIDENCE_FIXTURE,
    mutationOverlays: [],
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
    effectiveMutationAvailability: { available: true, reasons: [] },
    mutationOverlays: [],
  } as const satisfies SakiBoardProjection,
})

const AGENT_PROFILE_PROJECTION = {
  id: AGENT_PROFILE_ID,
  version: 1,
  agentPresetId: 'development',
} as const

const AGENT_MODEL_PROJECTION = {
  provider: 'controllable-fake',
  model: 'fixture-model',
} as const

/** Browser-safe current and recent manual Agent Run summaries. */
export const SAKI_AGENT_RUN_PROJECTION_FIXTURES = Object.freeze({
  running: {
    id: CURRENT_AGENT_RUN_ID,
    revision: 2,
    assignmentId: CURRENT_ASSIGNMENT_ID,
    workSessionId: CURRENT_WORK_SESSION_ID,
    sessionId: CURRENT_DSH_SESSION_ID,
    source: {
      kind: 'manual-give-to-agent',
      intentId: CURRENT_AGENT_INTENT_ID,
      projectId: PROJECT_ID,
      workItemId: BOARD_WORK_ITEM_ID,
    },
    profile: AGENT_PROFILE_PROJECTION,
    model: AGENT_MODEL_PROJECTION,
    state: 'running',
    recovery: { state: 'resumable' },
    createdAt: BOARD_CONFIRMED_AT + 20_000,
    updatedAt: BOARD_CONFIRMED_AT + 40_000,
  } as const satisfies SakiAgentRunProjection,
  canceled: {
    id: CANCELED_AGENT_RUN_ID,
    revision: 3,
    assignmentId: CANCELED_ASSIGNMENT_ID,
    workSessionId: CANCELED_WORK_SESSION_ID,
    sessionId: CANCELED_DSH_SESSION_ID,
    source: {
      kind: 'manual-give-to-agent',
      intentId: CANCELED_AGENT_INTENT_ID,
      projectId: PROJECT_ID,
      workItemId: BOARD_WORK_ITEM_ID,
    },
    profile: AGENT_PROFILE_PROJECTION,
    model: AGENT_MODEL_PROJECTION,
    state: 'canceled',
    recovery: { state: 'terminal', reason: 'authority-revoked' },
    createdAt: BOARD_CONFIRMED_AT - 80_000,
    updatedAt: BOARD_CONFIRMED_AT - 70_000,
  } as const satisfies SakiAgentRunProjection,
  reconciliationRequired: {
    id: RECONCILIATION_AGENT_RUN_ID,
    revision: 4,
    assignmentId: RECONCILIATION_ASSIGNMENT_ID,
    workSessionId: RECONCILIATION_WORK_SESSION_ID,
    sessionId: RECONCILIATION_DSH_SESSION_ID,
    source: {
      kind: 'manual-give-to-agent',
      intentId: RECONCILIATION_AGENT_INTENT_ID,
      projectId: PROJECT_ID,
      workItemId: BOARD_WORK_ITEM_ID,
    },
    profile: AGENT_PROFILE_PROJECTION,
    model: AGENT_MODEL_PROJECTION,
    state: 'reconciliation-required',
    recovery: { state: 'required', reason: 'effect-unknown' },
    createdAt: BOARD_CONFIRMED_AT - 40_000,
    updatedAt: BOARD_CONFIRMED_AT - 20_000,
  } as const satisfies SakiAgentRunProjection,
})

/** Assigned Work Item detail with one current Run and bounded recent execution history. */
export const SAKI_WORK_ITEM_DETAIL_PROJECTION_FIXTURE = Object.freeze({
  type: 'work-item-detail',
  projectId: PROJECT_ID,
  workItemId: BOARD_WORK_ITEM_ID,
  definition: {
    title: 'Ship the read-only GitHub Board projection',
    url: 'https://github.example.invalid/BreakfastDaPaiDang/saki/issues/27',
    number: 27,
    status: 'in-progress',
    intendedOutcome: 'Expose one recoverable Work Item execution view to the Host Operator.',
    acceptanceCriteria: [
      'The current Agent Run links to the primary Work Session.',
      'Recent terminal and reconciliation states remain display-safe.',
    ],
    blockage: [],
  },
  assignment: {
    id: CURRENT_ASSIGNMENT_ID,
    revision: 1,
    state: 'active',
    primaryWorkSessionId: CURRENT_WORK_SESSION_ID,
    createdAt: BOARD_CONFIRMED_AT + 20_000,
    updatedAt: BOARD_CONFIRMED_AT + 40_000,
  },
  primaryWorkSession: {
    id: CURRENT_WORK_SESSION_ID,
    revision: 1,
    state: 'open',
    createdAt: BOARD_CONFIRMED_AT + 20_000,
    updatedAt: BOARD_CONFIRMED_AT + 40_000,
  },
  currentAgentRun: SAKI_AGENT_RUN_PROJECTION_FIXTURES.running,
  recentAgentRuns: [
    SAKI_AGENT_RUN_PROJECTION_FIXTURES.reconciliationRequired,
    SAKI_AGENT_RUN_PROJECTION_FIXTURES.canceled,
  ],
} as const satisfies SakiWorkItemDetailProjection)

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
        reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
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
      effectiveMutationAvailability: { available: true, reasons: [] },
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

/** Browser-safe success and recovery receipts for GitHub-backed Work Item sagas. */
export const SAKI_WORK_ITEM_RESULT_FIXTURES = Object.freeze({
  succeeded: {
    ok: true,
    receipt: {
      id: MOVE_WORK_ITEM_RECEIPT_ID,
      intentId: MOVE_WORK_ITEM_INTENT_ID,
      type: 'move-work-item',
      projectId: PROJECT_ID,
      state: 'succeeded',
      workItemId: BOARD_WORK_ITEM_ID,
      issueNumber: 27,
      url: 'https://github.example.invalid/BreakfastDaPaiDang/saki/issues/27',
      remoteFingerprint: `remote-fingerprint-${'7'.repeat(64)}` as SakiBoardRemoteFingerprint,
    },
  },
  prepared: {
    ok: false,
    reason: 'unavailable',
    receipt: {
      id: CREATE_WORK_ITEM_RECEIPT_ID,
      intentId: CREATE_WORK_ITEM_INTENT_ID,
      type: 'create-work-item',
      projectId: PROJECT_ID,
      state: 'prepared',
    },
  },
  conflict: {
    ok: false,
    reason: 'conflict',
    receipt: {
      id: MOVE_WORK_ITEM_RECEIPT_ID,
      intentId: MOVE_WORK_ITEM_INTENT_ID,
      type: 'move-work-item',
      projectId: PROJECT_ID,
      state: 'conflict',
      reason: 'stale-remote',
      workItemId: BOARD_WORK_ITEM_ID,
      remoteFingerprint: `remote-fingerprint-${'8'.repeat(64)}` as SakiBoardRemoteFingerprint,
    },
  },
  partialFailure: {
    ok: false,
    reason: 'unavailable',
    receipt: {
      id: CREATE_WORK_ITEM_RECEIPT_ID,
      intentId: CREATE_WORK_ITEM_INTENT_ID,
      type: 'create-work-item',
      projectId: PROJECT_ID,
      state: 'partial-failure',
      workItemId: BOARD_WORK_ITEM_ID,
      stage: 'project-item-add',
      recoveryAction: { kind: 'resume-intent' },
    },
  },
  reconciliationRequired: {
    ok: false,
    reason: 'reconciliation-required',
    receipt: {
      id: CREATE_WORK_ITEM_RECEIPT_ID,
      intentId: CREATE_WORK_ITEM_INTENT_ID,
      type: 'create-work-item',
      projectId: PROJECT_ID,
      state: 'reconciliation-required',
      reason: 'marker-ambiguous',
      stage: 'issue-create',
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
  workItemSucceeded: SAKI_WORK_ITEM_RESULT_FIXTURES.succeeded,
  workItemConflict: SAKI_WORK_ITEM_RESULT_FIXTURES.conflict,
  workItemPartialFailure: SAKI_WORK_ITEM_RESULT_FIXTURES.partialFailure,
  workItemReconciliationRequired: SAKI_WORK_ITEM_RESULT_FIXTURES.reconciliationRequired,
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
