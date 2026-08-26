import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  sakiAccessProjectionSchema,
  sakiDevelopmentWorkspaceResultSchema,
  sakiInspectProjectSelectionResultSchema,
  sakiIntentRequestSchema,
  sakiIntentResultSchema,
  sakiProjectIndexResultSchema,
  sakiQueryRequestSchema,
  sakiRegisterDevelopmentProjectIntentSchema,
} from '../src/wire.ts'

const DIGEST = '1'.repeat(64)
const HOST = 'host-11111111-1111-4111-8111-111111111111'
const PROJECT = 'project-22222222-2222-4222-8222-222222222222'
const BINDING = 'binding-33333333-3333-4333-8333-333333333333'

const baselineMaterial = {
  formatVersion: 1,
  bounds: {
    maxEntries: 1,
    maxPathBytes: 1,
    maxGitOutputBytes: 1,
    maxFileBytes: 1,
    maxTotalFileBytes: 1,
    maxCaptureMs: 1,
  },
  observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
  entries: [],
} as const
const completeBaseline = {
  kind: 'complete',
  capturedAt: 1,
  ...baselineMaterial,
  digest: canonicalDigest('saki/inherited-baseline/v1', baselineMaterial),
} as const

describe('Saki Host wire schemas', () => {
  it('admits only selected Host plus an untrusted locator for inspection', () => {
    expect(sakiQueryRequestSchema.parse({
      type: 'inspect-project-selection',
      hostId: HOST,
      directoryLocator: 'D:/repo',
    })).toEqual({ type: 'inspect-project-selection', hostId: HOST, directoryLocator: 'D:/repo' })

    for (const reserved of [
      { principalId: 'principal-spoof' },
      { actor: { kind: 'human' } },
      { grant: { revision: 0 } },
      { canonicalPath: 'D:/trusted' },
      { gitDirectory: 'D:/trusted/.git' },
      { workspaceId: 'caller-workspace' },
      { authenticationContext: {} },
    ]) {
      expect(sakiQueryRequestSchema.safeParse({
        type: 'inspect-project-selection', hostId: HOST, directoryLocator: 'D:/repo', ...reserved,
      }).success).toBe(false)
    }
  })

  it('requires the bounded title and exact confirmed baseline for registration', () => {
    const request = {
      type: 'register-development-project',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectTitle: 'Project title',
      hostId: HOST,
      directoryLocator: 'D:/repo',
      expectedRegistryRevision: 0,
      confirmedFingerprint: { version: 1, digest: DIGEST },
      confirmedBaseline: completeBaseline,
    }
    expect(sakiIntentRequestSchema.parse(request)).toEqual(request)
    expect(sakiRegisterDevelopmentProjectIntentSchema.parse({
      ...request,
      projectTitle: '  Project title  ',
    }).projectTitle)
      .toBe('  Project title  ')
    expect(sakiIntentRequestSchema.safeParse({ ...request, projectTitle: '' }).success).toBe(false)
    expect(sakiIntentRequestSchema.safeParse({ ...request, projectTitle: 'x'.repeat(201) }).success).toBe(false)
    expect(sakiIntentRequestSchema.safeParse({ ...request, confirmedBaseline: {
      kind: 'unavailable',
      reason: 'file-limit',
      observed: completeBaseline.observed,
      entries: [],
      digest: DIGEST,
    } }).success).toBe(false)
    expect(sakiIntentRequestSchema.safeParse({ ...request, grantRevision: 1 }).success).toBe(false)
  })

  it('keeps unauthenticated Access messages closed', () => {
    expect(sakiAccessProjectionSchema.parse({
      kind: 'session-required',
      message: 'A local browser session is required.',
    })).toEqual({ kind: 'session-required', message: 'A local browser session is required.' })
    expect(sakiAccessProjectionSchema.safeParse({
      kind: 'session-required',
      message: 'C:/authority-sentinel',
    }).success).toBe(false)
  })

  it('correlates every query request with one exact result vocabulary', () => {
    const index = {
      ok: true,
      projection: {
        type: 'project-index',
        revision: 1,
        hosts: [{ id: HOST, revision: 0, state: 'enrolled' }],
        projects: [{
          id: PROJECT,
          revision: 0,
          projectTitle: 'Project title',
          binding: {
            id: BINDING,
            revision: 0,
            health: 'active',
            hostId: HOST,
            displayLocation: 'repository',
            head: '1'.repeat(40),
            branch: 'main',
            detached: false,
            inheritedChangeEntryCount: 0,
            baseline: 'complete',
            automaticMutationEligible: true,
            configurationGaps: [],
          },
        }],
      },
    } as const
    expect(sakiProjectIndexResultSchema.parse(index)).toEqual(index)
    expect(sakiInspectProjectSelectionResultSchema.safeParse(index).success).toBe(false)
    expect(sakiDevelopmentWorkspaceResultSchema.safeParse(index).success).toBe(false)
    expect(sakiProjectIndexResultSchema.safeParse({ ok: false, reason: 'not-found' }).success).toBe(false)
    expect(sakiDevelopmentWorkspaceResultSchema.safeParse({ ok: false, reason: 'not-found' }).success).toBe(true)
    expect(sakiProjectIndexResultSchema.safeParse({
      ...index,
      projection: {
        ...index.projection,
        projects: [{
          ...index.projection.projects[0],
          binding: { ...index.projection.projects[0].binding, displayLocation: 'C:/authority-sentinel' },
        }],
      },
    }).success).toBe(false)

    const detached = {
      ...index,
      projection: {
        ...index.projection,
        projects: [{
          ...index.projection.projects[0],
          binding: { ...index.projection.projects[0].binding, branch: undefined, detached: true },
        }],
      },
    }
    expect(sakiProjectIndexResultSchema.parse(detached)).toEqual(detached)
    for (const binding of [
      { ...index.projection.projects[0].binding, branch: undefined },
      { ...index.projection.projects[0].binding, detached: true },
      { ...index.projection.projects[0].binding, configurationGaps: ['binding-missing', 'binding-missing'] },
      { ...index.projection.projects[0].binding, health: 'missing' },
    ]) {
      expect(sakiProjectIndexResultSchema.safeParse({
        ...index,
        projection: {
          ...index.projection,
          projects: [{ ...index.projection.projects[0], binding }],
        },
      }).success).toBe(false)
    }

    const workspace = {
      ok: true,
      projection: {
        type: 'development-workspace',
        registryRevision: 1,
        project: index.projection.projects[0],
        recovery: { state: 'ready', reasons: [] },
      },
    } as const
    expect(sakiDevelopmentWorkspaceResultSchema.parse(workspace)).toEqual(workspace)
    expect(sakiDevelopmentWorkspaceResultSchema.safeParse({
      ...workspace,
      projection: {
        ...workspace.projection,
        recovery: { state: 'blocked', reasons: ['dirty', 'dirty'] },
      },
    }).success).toBe(false)
  })

  it('keeps registration receipts derived and phase-specific', () => {
    const confirmed = {
      ok: true,
      receipt: {
        id: 'receipt-44444444-4444-4444-8444-444444444444',
        intentId: 'intent-44444444-4444-4444-8444-444444444444',
        state: 'confirmed',
        projectId: PROJECT,
        resourceBindingId: BINDING,
        registryRevision: 1,
      },
    } as const
    expect(sakiIntentResultSchema.parse(confirmed)).toEqual(confirmed)
    expect(sakiIntentResultSchema.safeParse({
      ...confirmed,
      receipt: { ...confirmed.receipt, id: 'receipt-55555555-5555-4555-8555-555555555555' },
    }).success).toBe(false)
    expect(sakiIntentResultSchema.safeParse({
      ...confirmed,
      receipt: { ...confirmed.receipt, registryRevision: 0 },
    }).success).toBe(false)
    expect(sakiIntentResultSchema.safeParse({
      ok: false,
      reason: 'unavailable',
      receipt: {
        id: 'receipt-44444444-4444-4444-8444-444444444444',
        intentId: 'intent-44444444-4444-4444-8444-444444444444',
        state: 'prepared',
        projectId: PROJECT,
      },
    }).success).toBe(false)
    expect(sakiIntentResultSchema.safeParse({
      ok: false,
      reason: 'reconciliation-required',
      receipt: {
        id: 'receipt-44444444-4444-4444-8444-444444444444',
        intentId: 'intent-44444444-4444-4444-8444-444444444444',
        state: 'reconciliation-required',
        projectId: PROJECT,
        reason: 'observation',
      },
    }).success).toBe(false)

    for (const result of [
      {
        ok: false,
        reason: 'unavailable',
        receipt: {
          id: 'receipt-55555555-5555-4555-8555-555555555555',
          intentId: 'intent-55555555-5555-4555-8555-555555555555',
          state: 'prepared',
        },
      },
      {
        ok: false,
        reason: 'conflict',
        receipt: {
          id: 'receipt-55555555-5555-4555-8555-555555555555',
          intentId: 'intent-55555555-5555-4555-8555-555555555555',
          state: 'conflict',
          reason: 'expected-revision',
        },
      },
      {
        ok: false,
        reason: 'failure',
        receipt: {
          id: 'receipt-55555555-5555-4555-8555-555555555555',
          intentId: 'intent-55555555-5555-4555-8555-555555555555',
          state: 'failure',
          reason: 'authority',
        },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          id: 'receipt-55555555-5555-4555-8555-555555555555',
          intentId: 'intent-55555555-5555-4555-8555-555555555555',
          state: 'reconciliation-required',
          reason: 'observation',
        },
      },
    ] as const) {
      expect(sakiIntentResultSchema.parse(result)).toEqual(result)
      expect(sakiIntentResultSchema.safeParse({
        ...result,
        receipt: { ...result.receipt, intentId: 'intent-66666666-6666-4666-8666-666666666666' },
      }).success).toBe(false)
    }
  })
})
