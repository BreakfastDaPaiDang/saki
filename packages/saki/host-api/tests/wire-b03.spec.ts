import { describe, expect, it } from 'vitest'
import { SAKI_PROJECT_PROJECTION_FIXTURES } from '@breakfastdapaidang/saki-control-plane/src/fixtures.ts'
import {
  canonicalDigest,
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  type ProjectGitStatusObservation,
  type ProjectGitStatusSeedMaterial,
  type SakiResourceBindingId,
} from '@breakfastdapaidang/saki-execution'
import {
  sakiAccessProjectionSchema,
  sakiDevelopmentWorkspaceResultSchema,
  sakiInspectProjectSelectionResultSchema,
  sakiIntentRequestSchema,
  sakiIntentResultSchema,
  sakiProjectDiffResultSchema,
  sakiProjectIndexResultSchema,
  sakiProjectChangesResultSchema,
  sakiQueryRequestSchema,
  sakiRegisterDevelopmentProjectIntentSchema,
} from '../src/wire.ts'

const DIGEST = '1'.repeat(64)
const HOST = 'host-11111111-1111-4111-8111-111111111111'
const PROJECT = 'project-22222222-2222-4222-8222-222222222222'
const BINDING = 'binding-33333333-3333-4333-8333-333333333333' as SakiResourceBindingId

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

  it('admits only revision-fenced Project status and opaque Diff requests', () => {
    const status = {
      type: 'project-changes',
      projectId: PROJECT,
      expectedRegistryRevision: 7,
    } as const
    const diff = {
      type: 'project-diff',
      projectId: PROJECT,
      expectedRegistryRevision: 7,
      request: {
        expectedStatus: { version: 1, digest: DIGEST },
        changeId: `git-change-${DIGEST}`,
        layer: 'unstaged',
      },
    } as const

    expect(sakiQueryRequestSchema.parse(status)).toEqual(status)
    expect(sakiQueryRequestSchema.parse(diff)).toEqual(diff)
    for (const reserved of [
      { binding: { id: BINDING } },
      { path: 'src/private.ts' },
      { cwd: 'D:/trusted' },
      { argv: ['diff'] },
      { expectedInspection: { trusted: {} } },
    ]) {
      expect(sakiQueryRequestSchema.safeParse({ ...status, ...reserved }).success).toBe(false)
      expect(sakiQueryRequestSchema.safeParse({
        ...diff,
        request: { ...diff.request, ...reserved },
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
      confirmedFingerprint: { version: 2, digest: DIGEST },
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
            objectFormat: 'sha1',
            head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
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
          binding: {
            ...index.projection.projects[0].binding,
            head: { kind: 'commit' as const, objectId: '2'.repeat(40) },
          },
        }],
      },
    }
    expect(sakiProjectIndexResultSchema.parse(detached)).toEqual(detached)
    const unborn = {
      ...index,
      projection: {
        ...index.projection,
        projects: [{
          ...index.projection.projects[0],
          binding: {
            ...index.projection.projects[0].binding,
            head: { kind: 'unborn' as const, symbolicRef: 'refs/heads/initial' },
          },
        }],
      },
    }
    expect(sakiProjectIndexResultSchema.parse(unborn)).toEqual(unborn)
    const sha256 = {
      ...index,
      projection: {
        ...index.projection,
        projects: [{
          ...index.projection.projects[0],
          binding: {
            ...index.projection.projects[0].binding,
            objectFormat: 'sha256' as const,
            head: { kind: 'commit' as const, objectId: '3'.repeat(64) },
          },
        }],
      },
    }
    expect(sakiProjectIndexResultSchema.parse(sha256)).toEqual(sha256)
    for (const binding of [
      { ...index.projection.projects[0].binding, head: { kind: 'commit', objectId: '1'.repeat(64) } },
      { ...index.projection.projects[0].binding, objectFormat: 'sha256' },
      {
        ...index.projection.projects[0].binding,
        head: { kind: 'unborn', symbolicRef: 'refs/heads/initial', objectId: '1'.repeat(40) },
      },
      { ...index.projection.projects[0].binding, branch: 'main' },
      { ...index.projection.projects[0].binding, detached: false },
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
    expect(sakiDevelopmentWorkspaceResultSchema.parse({
      ok: true,
      projection: SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace,
    })).toEqual({ ok: true, projection: SAKI_PROJECT_PROJECTION_FIXTURES.developmentWorkspace })
    expect(sakiDevelopmentWorkspaceResultSchema.safeParse({
      ...workspace,
      projection: {
        ...workspace.projection,
        recovery: { state: 'blocked', reasons: ['dirty', 'dirty'] },
      },
    }).success).toBe(false)
  })

  it('validates complete Project status observations through the execution schema', () => {
    const material = {
      observationVersion: 1 as const,
      observedAt: 1,
      bindingId: BINDING,
      bindingRevision: 2,
      bindingHealth: 'active' as const,
      locked: false,
      objectFormat: 'sha1' as const,
      head: { kind: 'commit' as const, objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
      branch: { kind: 'attached' as const, ref: 'refs/heads/main', name: 'main' },
      upstream: {
        ref: 'refs/remotes/origin/main',
        name: 'origin/main',
        divergence: { ahead: 0, behind: 0 },
      },
      index: { kind: 'tree' as const, treeId: '2'.repeat(40) },
      worktree: { version: 1 as const, digest: '3'.repeat(64) },
      changes: [],
      structuredMutation: { available: true as const, blockers: [] as const },
    } satisfies Omit<ProjectGitStatusObservation, 'fingerprint'>
    const status = {
      ok: true,
      projection: {
        type: 'project-changes',
        registryRevision: 7,
        projectId: PROJECT,
        projectRevision: 3,
        result: {
          ok: true,
          observation: { ...material, fingerprint: computeProjectGitStatusFingerprint(material) },
        },
        gitOperations: {
          stageFiles: { available: true, reasons: [] },
          unstageFiles: { available: true, reasons: [] },
          createCommit: { available: false, reasons: ['no-staged-changes'] },
        },
      },
    } as const

    expect(sakiProjectChangesResultSchema.parse(status)).toEqual(status)
    const stagedChangeMaterial = {
      path: 'staged.txt',
      kind: 'ordinary' as const,
      indexStatus: 'modified' as const,
      worktreeStatus: 'unchanged' as const,
      submodule: { kind: 'not-submodule' as const },
      head: { mode: '100644' as const, objectId: '4'.repeat(40) },
      index: { mode: '100644' as const, objectId: '5'.repeat(40) },
      worktreeMode: '100644' as const,
      worktreeEvidence: {
        kind: 'regular' as const,
        mode: '100644' as const,
        byteLength: 1,
        contentDigest: '6'.repeat(64),
      },
      attribution: 'unattributed' as const,
    }
    const stagedChange = {
      ...stagedChangeMaterial,
      fingerprint: computeProjectGitChangeFingerprint(stagedChangeMaterial),
    }
    const { observedAt, ...statusSeedWithoutTime } = material
    const statusSeed = {
      ...statusSeedWithoutTime,
      changes: [stagedChange],
    } satisfies ProjectGitStatusSeedMaterial
    const stagedObservationMaterial = {
      ...statusSeed,
      observedAt,
      changes: [{
        id: computeProjectGitChangeId(computeProjectGitStatusSeedDigest(statusSeed), stagedChange),
        ...stagedChange,
      }],
    }
    const staged = {
      ...status,
      projection: {
        ...status.projection,
        result: {
          ok: true as const,
          observation: {
            ...stagedObservationMaterial,
            fingerprint: computeProjectGitStatusFingerprint(stagedObservationMaterial),
          },
        },
        gitOperations: {
          stageFiles: { available: true as const, reasons: [] as const },
          unstageFiles: { available: true as const, reasons: [] as const },
          createCommit: { available: true as const, reasons: [] as const },
        },
      },
    }
    expect(sakiProjectChangesResultSchema.parse(staged)).toEqual(staged)

    const blockedObservationMaterial = {
      ...material,
      structuredMutation: { available: false as const, blockers: ['index-flags'] as const },
    }
    const blocked = {
      ...status,
      projection: {
        ...status.projection,
        result: {
          ok: true as const,
          observation: {
            ...blockedObservationMaterial,
            fingerprint: computeProjectGitStatusFingerprint(blockedObservationMaterial),
          },
        },
        gitOperations: {
          stageFiles: { available: false as const, reasons: ['index-flags'] as const },
          unstageFiles: { available: false as const, reasons: ['index-flags'] as const },
          createCommit: { available: false as const, reasons: ['index-flags'] as const },
        },
      },
    }
    expect(sakiProjectChangesResultSchema.parse(blocked)).toEqual(blocked)
    const { upstream: _upstream, ...attached } = material
    const detachedMaterial = {
      ...attached,
      head: { kind: 'commit' as const, objectId: material.head.objectId },
      branch: { kind: 'detached' as const },
    }
    const detached = {
      ...status,
      projection: {
        ...status.projection,
        result: {
          ok: true as const,
          observation: {
            ...detachedMaterial,
            fingerprint: computeProjectGitStatusFingerprint(detachedMaterial),
          },
        },
        gitOperations: {
          ...status.projection.gitOperations,
          createCommit: {
            available: false as const,
            reasons: ['detached-head', 'no-staged-changes'] as const,
          },
        },
      },
    }
    expect(sakiProjectChangesResultSchema.parse(detached)).toEqual(detached)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...detached,
      projection: {
        ...detached.projection,
        gitOperations: {
          ...detached.projection.gitOperations,
          stageFiles: { available: false, reasons: ['detached-head'] },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...detached,
      projection: {
        ...detached.projection,
        gitOperations: {
          ...detached.projection.gitOperations,
          createCommit: { available: true, reasons: [] },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...status,
      projection: {
        ...status.projection,
        result: {
          ok: true,
          observation: {
            ...status.projection.result.observation,
            fingerprint: { version: 1, digest: '0'.repeat(64) },
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...status,
      projection: { ...status.projection, expectedInspection: { trusted: { canonicalWorktreePath: 'D:/secret' } } },
    }).success).toBe(false)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...status,
      projection: {
        ...status.projection,
        result: { ...status.projection.result, preEffectBaseline: completeBaseline },
      },
    }).success).toBe(false)
  })

  it('validates bounded Project Diff pages through the execution schema', () => {
    const changeId = `git-change-${DIGEST}`
    const lines = ['diff --git a/file b/file', '--- a/file', '+++ b/file'] as const
    const pageUtf8Bytes = lines.reduce(
      (bytes, line) => bytes + new TextEncoder().encode(line).byteLength + 1,
      0,
    )
    const diff = {
      ok: true,
      projection: {
        type: 'project-diff',
        registryRevision: 7,
        projectId: PROJECT,
        projectRevision: 3,
        result: {
          ok: true,
          page: {
            pageVersion: 1,
            observation: { version: 1, digest: '4'.repeat(64) },
            changeId,
            layer: 'unstaged',
            patchFingerprint: { version: 1, digest: '5'.repeat(64) },
            range: { startLine: 0, endLineExclusive: lines.length, totalLines: lines.length },
            lines,
            pageUtf8Bytes,
            totalUtf8Bytes: pageUtf8Bytes,
            omittedBeforeLines: 0,
            omittedAfterLines: 0,
            truncated: false,
          },
        },
      },
    } as const

    expect(sakiProjectDiffResultSchema.parse(diff)).toEqual(diff)
    expect(sakiProjectDiffResultSchema.safeParse({
      ...diff,
      projection: {
        ...diff.projection,
        result: {
          ok: true,
          page: { ...diff.projection.result.page, pageUtf8Bytes: pageUtf8Bytes + 1 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectDiffResultSchema.safeParse({
      ...diff,
      projection: { ...diff.projection, canonicalWorktreePath: 'D:/secret' },
    }).success).toBe(false)
    expect(sakiProjectDiffResultSchema.parse({ ok: false, reason: 'binding-unavailable' }))
      .toEqual({ ok: false, reason: 'binding-unavailable' })
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
