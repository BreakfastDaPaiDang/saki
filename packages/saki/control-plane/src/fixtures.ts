/** Secret-free access and Project fixtures for frontend Consumers. @module @breakfastdapaidang/saki-control-plane/fixtures */

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

import type {
  AccessProjection,
  RegisterDevelopmentProjectIntent,
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiDevelopmentWorkspaceProjection,
  SakiIntentReceipt,
  SakiIntentReceiptId,
  SakiProjectSelectionInspectionProjection,
  SakiProjectIndexProjection,
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
