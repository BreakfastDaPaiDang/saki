import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import { canonicalDigest } from '../src/canonical.ts'
import {
  computeStartAgentRunPayloadDigest,
  computeProjectGitChangeFingerprint,
  computeProjectGitChangeId,
  computeProjectGitStatusFingerprint,
  computeProjectGitStatusSeedDigest,
  computeProjectInspectionFingerprint,
  inheritedChangeBaselineIdentityMaterial,
  projectGitStatusFingerprintMaterial,
  projectInspectionFingerprintMaterial,
  projectInspectionWorkspaceIndependentMaterial,
} from '../src/fingerprint.ts'
import { HostOperationAcceptance, SakiHostExecution } from '../src/index.ts'
import {
  compareRepositoryRelativeGitPaths,
  compareSafeGitRemoteObservations,
  deriveGitHubRepositoryCandidates,
  inheritedChangeBaselineEntrySchema,
  inheritedChangeBaselineSchema,
  activeHostProjectBindingSchema,
  inspectProjectRequestSchema,
  inspectProjectResultSchema,
  inspectProjectCommitRequestSchema,
  inspectProjectCommitResultSchema,
  commitHostOperationResultSchema,
  inspectInterventionOpeningRequestSchema,
  interventionOpeningEvidenceSchema,
  hostOperationPreparationSchema,
  hostOperationRequestSchema,
  hostOperationRequestV2Schema,
  hostOperationSnapshotSchema,
  hostOperationStartResultSchema,
  MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES,
  MAX_HOST_OPERATION_SELECTED_CHANGES,
  MAX_PROJECT_GIT_DIFF_CURSOR_CHARS,
  MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES,
  MAX_PROJECT_GIT_STATUS_CHANGES,
  MAX_PROJECT_GIT_STATUS_PATH_BYTES,
  isGitObjectId,
  isAbsoluteHostPath,
  isNormalizedRemoteCoordinate,
  isRepositoryRelativeGitPath,
  isSafeDisplayLocation,
  isSafeGitBranchName,
  isSafeGitRef,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_GIT_REF_CHARS,
  MAX_INVENTORY_ENTRIES,
  MAX_REMOTE_COORDINATE_CHARS,
  MAX_SAFE_REMOTES,
  projectGitStatusObservationSchema,
  projectGitChangeSchema,
  projectGitDiffCursorSchema,
  projectGitDiffPageSchema,
  readProjectDiffOperationRequestSchema,
  readProjectDiffRequestSchema,
  readProjectDiffResultSchema,
  projectSelectionProjectionSchema,
  projectSelectionInspectionSchema,
  pushBranchHostOperationRequestSchema,
  pushBranchHostOperationResultSchema,
  safeGitRemoteObservationSchema,
  safeGitRemoteObservationKey,
  sakiInterventionAnswerMessageSourceSchema,
  stageFilesHostOperationResultSchema,
  startAgentRunHostOperationRequestV2Schema,
  startAgentRunHostOperationRequestSchema,
  startAgentRunHostOperationResultSchema,
} from '../src/schemas.ts'
import type {
  ActiveHostProjectBinding,
  ProjectGitChangeId,
  ProjectGitDiffCursor,
  ProjectGitStatusObservation,
  ProjectSelectionProjection,
  SakiHostId,
  SakiResourceBindingId,
  StartAgentRunInputMessage,
} from '../src/types.ts'
import type {
  ProjectGitChangeFingerprintMaterial,
  ProjectGitStatusSeedMaterial,
} from '../src/fingerprint.ts'

const OBSERVED = { entries: 1, pathBytes: 2, gitOutputBytes: 3, hashedBytes: 4, elapsedMs: 5 }
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId
const BINDING_ID = 'binding-11111111-1111-4111-8111-111111111111' as SakiResourceBindingId

describe('InheritedChangeBaseline schemas', () => {
  it('admits only structural absolute Host path forms for trusted observations', () => {
    for (const value of [
      '/', '/repo/line\nname', 'C:\\', 'C:\\repo\\git', '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\repo',
    ]) {
      expect(isAbsoluteHostPath(value)).toBe(true)
    }
    for (const value of [
      'repo', '../repo', 'C:relative', '\\rooted', '/repo/../other', 'C:\\repo\\.\\git',
      'C:\\repo/mixed',
      '\\\\server\\share\\repo\\', '\\\\?\\C:\\repo', '\\\\?\\UNC\\server\\share',
      '\\\\.\\pipe\\x', '/repo\0secret',
    ]) {
      expect(isAbsoluteHostPath(value)).toBe(false)
    }
  })

  it('keeps the unavailable arm to its reason and observed limits', () => {
    const baseline = { kind: 'unavailable', reason: 'file-limit', observed: OBSERVED } as const

    expect(inheritedChangeBaselineSchema.parse(baseline)).toEqual(baseline)
    expect(inheritedChangeBaselineSchema.safeParse({ ...baseline, formatVersion: 1 }).success).toBe(false)
    expect(inheritedChangeBaselineSchema.safeParse({
      ...baseline,
      bounds: {
        maxEntries: 1,
        maxPathBytes: 1,
        maxGitOutputBytes: 1,
        maxFileBytes: 1,
        maxTotalFileBytes: 1,
        maxCaptureMs: 1,
      },
    }).success).toBe(false)
  })

  it('keeps membership-specific baseline entry evidence closed', () => {
    const common = {
      formatVersion: 1,
      pathDigest: '1'.repeat(64),
    } as const
    const regular = {
      kind: 'regular', mode: '100644', byteLength: 1, contentDigest: '3'.repeat(64),
    } as const
    const tracked = signedEntry({
      ...common,
      statusKind: 'tracked',
      head: { kind: 'object', mode: '100644', objectId: '4'.repeat(40) },
      index: { kind: 'object', mode: '100644', objectId: '5'.repeat(40) },
      worktree: regular,
    } as const)
    const untracked = signedEntry({
      ...common,
      statusKind: 'untracked',
      worktree: regular,
    } as const)
    const unmergedMaterial = {
      ...common,
      statusKind: 'unmerged',
      head: { kind: 'object', mode: '100644', objectId: '4'.repeat(40) },
      stages: [
        { kind: 'object', mode: '100644', objectId: '4'.repeat(40) },
        { kind: 'object', mode: '100644', objectId: '5'.repeat(40) },
        { kind: 'missing' },
      ],
      worktree: regular,
    } as const
    const unmerged = signedEntry(unmergedMaterial)

    expect(inheritedChangeBaselineEntrySchema.safeParse(tracked).success).toBe(true)
    expect(inheritedChangeBaselineEntrySchema.safeParse(untracked).success).toBe(true)
    expect(inheritedChangeBaselineEntrySchema.safeParse(unmerged).success).toBe(true)
    for (const occupied of [[0], [1], [2], [0, 1], [0, 2], [1, 2], [0, 1, 2]]) {
      const stages = [0, 1, 2].map(index => occupied.includes(index)
        ? { kind: 'object', mode: '100644', objectId: `${index + 4}`.repeat(40) }
        : { kind: 'missing' })
      expect(inheritedChangeBaselineEntrySchema.safeParse(signedEntry({ ...unmergedMaterial, stages })).success).toBe(true)
    }
    expect(inheritedChangeBaselineEntrySchema.safeParse({
      ...unmerged, stages: [{ kind: 'missing' }, { kind: 'missing' }, { kind: 'missing' }],
    }).success).toBe(false)
    expect(inheritedChangeBaselineEntrySchema.safeParse({
      ...tracked, head: { kind: 'missing' }, index: { kind: 'missing' },
    }).success).toBe(false)
    expect(inheritedChangeBaselineEntrySchema.safeParse({ ...untracked, index: tracked.index }).success).toBe(false)
    expect(inheritedChangeBaselineEntrySchema.safeParse({
      ...untracked, worktree: { ...regular, mode: '040000' },
    }).success).toBe(false)
    expect(inheritedChangeBaselineEntrySchema.safeParse({ ...unmerged, stages: undefined }).success).toBe(false)
    const nonGitlinkSubmodule = signedEntry({
      ...common,
      statusKind: 'tracked',
      head: { kind: 'object', mode: '100644', objectId: '4'.repeat(40) },
      index: { kind: 'object', mode: '100644', objectId: '5'.repeat(40) },
      worktree: { kind: 'submodule', objectId: '6'.repeat(40) },
    } as const)
    expect(inheritedChangeBaselineEntrySchema.safeParse(nonGitlinkSubmodule).success).toBe(false)
    const { digest: _trackedDigest, ...trackedMaterial } = tracked
    const unmergedSubmodule = signedEntry({
      ...unmergedMaterial,
      stages: [
        { kind: 'object', mode: '160000', objectId: '4'.repeat(40) },
        { kind: 'missing' },
        { kind: 'missing' },
      ],
      worktree: { kind: 'submodule', objectId: '6'.repeat(40) },
    } as const)
    expect(inheritedChangeBaselineEntrySchema.safeParse(unmergedSubmodule).success).toBe(true)
    expect(inheritedChangeBaselineEntrySchema.safeParse(signedEntry({
      ...trackedMaterial,
      head: { kind: 'missing' },
      index: { kind: 'object', mode: '100644', objectId: '5'.repeat(40) },
    })).success).toBe(true)
    for (const width of [40, 64]) {
      expect(inheritedChangeBaselineEntrySchema.safeParse(signedEntry({
        ...trackedMaterial,
        head: { kind: 'object', mode: '100644', objectId: '0'.repeat(width) },
        index: { kind: 'object', mode: '100644', objectId: '1'.repeat(width) },
      })).success).toBe(false)
    }
  })

  it('cross-checks projection identity, eligibility, and complete baseline observations', () => {
    const projection = {
      observationVersion: 2,
      hostId: HOST_ID,
      displayLocation: 'repo',
      objectFormat: 'sha1',
      head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
      locked: false,
      inheritedChangeEntryCount: 0,
      conversionAmbiguous: false,
      remotes: [],
      automaticMutationEligible: true,
      blockingReasons: [],
      fingerprint: { version: 2, digest: '2'.repeat(64) },
      baseline: signedBaseline({
        kind: 'complete',
        formatVersion: 1,
        capturedAt: 1,
        bounds: {
          maxEntries: 1, maxPathBytes: 1, maxGitOutputBytes: 1,
          maxFileBytes: 1, maxTotalFileBytes: 1, maxCaptureMs: 1,
        },
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 1, hashedBytes: 0, elapsedMs: 0 },
        entries: [],
      }),
    } as const satisfies ProjectSelectionProjection

    expect(projectSelectionProjectionSchema.safeParse(projection).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, head: { ...projection.head, objectId: '0'.repeat(40) },
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, objectFormat: 'sha256', head: { ...projection.head, objectId: '0'.repeat(64) },
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, head: { ...projection.head, objectId: '1'.repeat(64) },
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, head: { kind: 'unborn', symbolicRef: 'refs/heads/main' },
    }).success).toBe(true)
    expect(isSafeGitBranchName('a'.repeat(MAX_GIT_REF_CHARS - 'refs/heads/'.length))).toBe(true)
    expect(isSafeGitBranchName('a'.repeat(MAX_GIT_REF_CHARS - 'refs/heads/'.length + 1))).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, head: { kind: 'commit', objectId: '1'.repeat(40) },
    }).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      head: { kind: 'commit', objectId: '1'.repeat(40) },
      upstream: 'refs/remotes/origin/main',
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, automaticMutationEligible: false }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      locked: true,
      automaticMutationEligible: false,
      blockingReasons: ['locked'],
    }).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      conversionAmbiguous: true,
      automaticMutationEligible: false,
      blockingReasons: ['conversion-ambiguous'],
    }).success).toBe(true)
    const unavailableBaseline = {
      kind: 'unavailable',
      reason: 'io-failure',
      observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
    } as const
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      automaticMutationEligible: false,
      blockingReasons: ['baseline-unavailable'],
      baseline: unavailableBaseline,
    }).success).toBe(true)
    expect(inheritedChangeBaselineIdentityMaterial(unavailableBaseline)).toEqual({
      kind: 'unavailable',
      reason: 'io-failure',
      observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0 },
    })
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, inheritedChangeEntryCount: 1, automaticMutationEligible: false, blockingReasons: ['dirty'],
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      baseline: signedBaseline({
        ...projection.baseline,
        observed: { ...projection.baseline.observed, entries: 1 },
      }),
    }).success).toBe(false)

    const submoduleEntryMaterial = {
      formatVersion: 1,
      pathDigest: '4'.repeat(64),
      statusKind: 'tracked',
      head: { kind: 'object', mode: '160000', objectId: '6'.repeat(40) },
      index: { kind: 'object', mode: '160000', objectId: '6'.repeat(40) },
      worktree: { kind: 'submodule', objectId: '7'.repeat(40) },
    } as const
    const submoduleEntry = signedEntry(submoduleEntryMaterial)
    const submoduleBaseline = signedBaseline({
      ...projection.baseline,
      observed: { ...projection.baseline.observed, entries: 1 },
      entries: [submoduleEntry],
    })
    const submoduleProjection = {
      ...projection,
      inheritedChangeEntryCount: 1,
      automaticMutationEligible: false,
      blockingReasons: ['dirty'],
      baseline: submoduleBaseline,
    } as const
    expect(projectSelectionProjectionSchema.safeParse(submoduleProjection).success).toBe(true)
    const unmergedEntry = signedEntry({
      formatVersion: 1,
      pathDigest: '8'.repeat(64),
      statusKind: 'unmerged',
      head: { kind: 'missing' },
      stages: [
        { kind: 'object', mode: '100644', objectId: '6'.repeat(40) },
        { kind: 'missing' },
        { kind: 'missing' },
      ],
      worktree: { kind: 'regular', mode: '100644', byteLength: 0, contentDigest: '9'.repeat(64) },
    } as const)
    expect(projectSelectionProjectionSchema.safeParse({
      ...submoduleProjection,
      baseline: signedBaseline({
        ...submoduleProjection.baseline,
        entries: [unmergedEntry],
      }),
    }).success).toBe(true)
    const untrackedEntry = signedEntry({
      formatVersion: 1,
      pathDigest: 'a'.repeat(64),
      statusKind: 'untracked',
      worktree: { kind: 'symlink', targetDigest: 'b'.repeat(64) },
    } as const)
    expect(projectSelectionProjectionSchema.safeParse({
      ...submoduleProjection,
      baseline: signedBaseline({
        ...submoduleProjection.baseline,
        entries: [untrackedEntry],
      }),
    }).success).toBe(true)
    const wrongWidthEntry = signedEntry({
      ...submoduleEntryMaterial,
      worktree: { kind: 'submodule', objectId: '7'.repeat(64) },
    } as const)
    expect(projectSelectionProjectionSchema.safeParse({
      ...submoduleProjection,
      baseline: signedBaseline({
        ...submoduleProjection.baseline,
        entries: [wrongWidthEntry],
      }),
    }).success).toBe(false)

    expect(projectSelectionProjectionSchema.safeParse({ ...projection, workspaceId: '' }).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, displayLocation: 'x'.repeat(MAX_DISPLAY_LOCATION_CHARS + 1),
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      head: { ...projection.head, symbolicRef: `refs/heads/${'x'.repeat(MAX_GIT_REF_CHARS)}` },
    }).success).toBe(false)
    for (const displayLocation of [
      'repo\nsecret', 'repo\u001b[31m', 'safe\u202ereversed', '/secret/repo', 'C:\\secret\\repo', '..',
    ]) {
      expect(projectSelectionProjectionSchema.safeParse({ ...projection, displayLocation }).success).toBe(false)
      expect(isSafeDisplayLocation(displayLocation)).toBe(false)
    }
    for (const branch of ['-option', 'bad..name', 'bad@{name', 'bad\nname', 'safe\u202ename']) {
      expect(projectSelectionProjectionSchema.safeParse({
        ...projection, head: { ...projection.head, symbolicRef: `refs/heads/${branch}` },
      }).success).toBe(false)
      expect(isSafeGitBranchName(branch)).toBe(false)
    }
    for (const upstream of ['main', 'refs/heads/bad.lock', 'refs/heads/bad\nname', 'refs/heads/safe\u202ename']) {
      expect(projectSelectionProjectionSchema.safeParse({ ...projection, upstream }).success).toBe(false)
      expect(isSafeGitRef(upstream)).toBe(false)
    }
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      remotes: Array.from({ length: MAX_SAFE_REMOTES + 1 }, () => ({ transport: 'other' as const })),
    }).success).toBe(false)
    const canonicalRemotes = [
      { transport: 'https' as const, coordinate: 'example.com/org/one' },
      { transport: 'ssh' as const, coordinate: 'example.com/org/two' },
    ]
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, remotes: canonicalRemotes }).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, remotes: [...canonicalRemotes].reverse() }).success)
      .toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, remotes: [canonicalRemotes[0], canonicalRemotes[0]] }).success)
      .toBe(false)
    const githubRemotes = [
      { transport: 'https' as const, coordinate: 'github.com/Org/Repo' },
      { transport: 'ssh' as const, coordinate: 'github.com:22/org/repo' },
      { transport: 'ssh' as const, coordinate: 'ssh.github.com:443/ORG/REPO' },
    ]
    expect(deriveGitHubRepositoryCandidates(githubRemotes)).toEqual(['github.com/org/repo'])
    expect(deriveGitHubRepositoryCandidates([
      { transport: 'ssh', coordinate: 'github.com/zeta/repo' },
      { transport: 'https', coordinate: 'example.com/org/repo' },
      { transport: 'https', coordinate: 'github.com/alpha/repo' },
    ])).toEqual(['github.com/alpha/repo', 'github.com/zeta/repo'])
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      remotes: githubRemotes,
      githubRepositoryCandidates: ['github.com/org/repo'],
    }).success).toBe(true)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, remotes: githubRemotes }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      remotes: githubRemotes,
      githubRepositoryCandidates: [],
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      githubRepositoryCandidates: ['github.com/org/repo'],
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      inheritedChangeEntryCount: MAX_INVENTORY_ENTRIES + 1,
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection,
      blockingReasons: Array.from({ length: 5 }, () => 'dirty'),
    }).success).toBe(false)

    const trusted = {
      canonicalWorktreePath: 'C:\\repo',
      canonicalGitDirectory: 'C:\\repo\\.git',
      canonicalCommonGitDirectory: 'C:\\repo\\.git',
      gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      comparison: { fileMode: false, symlinks: false, autocrlf: true },
    } as const
    const inspection = {
      projection: {
        ...projection,
        fingerprint: computeProjectInspectionFingerprint(projection, trusted),
      },
      trusted,
    }
    expect(projectSelectionInspectionSchema.safeParse(inspection).success).toBe(true)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      projection: {
        ...inspection.projection,
        head: { ...inspection.projection.head, objectId: '3'.repeat(40) },
      },
    }).success).toBe(false)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      trusted: {
        ...inspection.trusted,
        comparison: { ...inspection.trusted.comparison, autocrlf: false },
      },
    }).success).toBe(false)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      trusted: {
        ...inspection.trusted,
        gitDirectoryIdentity: { version: 1, digest: '5'.repeat(64) },
      },
    }).success).toBe(false)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      projection: { ...inspection.projection, workspaceId: 'workspace-replaced' },
    }).success).toBe(false)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      projection: { ...inspection.projection, displayLocation: 'another-repository' },
    }).success).toBe(false)
    const changedBaseline = signedBaseline({
      ...inspection.projection.baseline,
      bounds: { ...inspection.projection.baseline.bounds, maxPathBytes: 2 },
    })
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      projection: { ...inspection.projection, baseline: changedBaseline },
    }).success).toBe(false)
    expect(projectSelectionInspectionSchema.safeParse({
      ...inspection,
      projection: {
        ...inspection.projection,
        baseline: {
          ...inspection.projection.baseline,
          capturedAt: 2,
          observed: { ...inspection.projection.baseline.observed, elapsedMs: 1 },
        },
      },
    }).success).toBe(true)

    const workspaceProjection = {
      ...projection,
      upstream: 'refs/remotes/origin/main',
      workspaceId: WorkspaceId('workspace-current'),
    }
    const fingerprintMaterial = projectInspectionFingerprintMaterial(workspaceProjection, trusted)
    expect(fingerprintMaterial).toMatchObject({
      upstream: 'refs/remotes/origin/main',
      workspace: { kind: 'present', workspaceId: 'workspace-current' },
    })
    expect(fingerprintMaterial).not.toHaveProperty('githubRepositoryCandidates')
    expect(projectInspectionFingerprintMaterial({
      ...workspaceProjection,
      remotes: githubRemotes,
      githubRepositoryCandidates: ['github.com/org/repo'],
    }, trusted)).toHaveProperty('githubRepositoryCandidates', ['github.com/org/repo'])
    expect(projectInspectionWorkspaceIndependentMaterial(workspaceProjection, trusted))
      .not.toHaveProperty('workspace')
    expect(projectInspectionFingerprintMaterial({
      ...projection,
      head: { kind: 'commit', objectId: projection.head.objectId },
    }, trusted).head).not.toHaveProperty('symbolicRef')
  })

  it('derives GitHub candidates only from transport-compatible normalized coordinates', () => {
    const sshGithubCoordinate = 'ssh.github.com:443/org/repo'
    expect(deriveGitHubRepositoryCandidates([
      { transport: 'https', coordinate: sshGithubCoordinate },
    ])).toEqual([])
    expect(deriveGitHubRepositoryCandidates([
      { transport: 'ssh', coordinate: sshGithubCoordinate },
    ])).toEqual(['github.com/org/repo'])

    const escapedCoordinate = 'github.com/org/repo%2Fpart'
    expect(isNormalizedRemoteCoordinate(escapedCoordinate)).toBe(true)
    expect(deriveGitHubRepositoryCandidates([
      { transport: 'https', coordinate: escapedCoordinate },
    ])).toEqual([])
  })

  it('rejects impossible retained byte totals and duplicate path identities', () => {
    const entry = signedEntry({
      formatVersion: 1,
      pathDigest: '1'.repeat(64),
      statusKind: 'untracked',
      worktree: { kind: 'regular', mode: '100644', byteLength: 2, contentDigest: '3'.repeat(64) },
    } as const)
    const baseline = signedBaseline({
      kind: 'complete',
      formatVersion: 1,
      capturedAt: 1,
      bounds: {
        maxEntries: 2, maxPathBytes: 10, maxGitOutputBytes: 10,
        maxFileBytes: 2, maxTotalFileBytes: 4, maxCaptureMs: 10,
      },
      observed: { entries: 1, pathBytes: 1, gitOutputBytes: 1, hashedBytes: 2, elapsedMs: 1 },
      entries: [entry],
    } as const)

    expect(inheritedChangeBaselineSchema.safeParse(baseline).success).toBe(true)
    const oversizedEntry = signedEntry({
      formatVersion: 1,
      pathDigest: entry.pathDigest,
      statusKind: 'untracked',
      worktree: { ...entry.worktree, byteLength: 3 },
    } as const)
    expect(inheritedChangeBaselineSchema.safeParse(signedBaseline({
      ...baseline,
      entries: [oversizedEntry],
      observed: { ...baseline.observed, hashedBytes: 3 },
    })).success).toBe(false)
    expect(inheritedChangeBaselineSchema.safeParse(signedBaseline({
      ...baseline, observed: { ...baseline.observed, hashedBytes: 1 },
    })).success).toBe(false)
    expect(inheritedChangeBaselineSchema.safeParse(signedBaseline({
      ...baseline,
      observed: { ...baseline.observed, entries: 2, hashedBytes: 4 },
      entries: [entry, entry],
    })).success).toBe(false)
    expect(inheritedChangeBaselineEntrySchema.safeParse({ ...entry, digest: '0'.repeat(64) }).success).toBe(false)
    expect(inheritedChangeBaselineSchema.safeParse({ ...baseline, digest: '0'.repeat(64) }).success).toBe(false)
  })

  it('rejects a re-signed baseline that mixes Git object formats', () => {
    const entry = signedEntry({
      formatVersion: 1,
      pathDigest: '1'.repeat(64),
      statusKind: 'tracked',
      head: { kind: 'object', mode: '100644', objectId: '2'.repeat(40) },
      index: { kind: 'object', mode: '100644', objectId: '3'.repeat(64) },
      worktree: { kind: 'missing' },
    } as const)
    const baseline = signedBaseline({
      kind: 'complete',
      formatVersion: 1,
      capturedAt: 1,
      bounds: {
        maxEntries: 1, maxPathBytes: 1, maxGitOutputBytes: 1,
        maxFileBytes: 1, maxTotalFileBytes: 1, maxCaptureMs: 1,
      },
      observed: { entries: 1, pathBytes: 1, gitOutputBytes: 1, hashedBytes: 0, elapsedMs: 1 },
      entries: [entry],
    } as const)

    expect(inheritedChangeBaselineEntrySchema.safeParse(entry).success).toBe(true)
    expect(inheritedChangeBaselineSchema.safeParse(baseline).success).toBe(false)
  })

  it('accepts only canonical credential-free remote coordinates', () => {
    expect(isGitObjectId('1'.repeat(40), 'sha1')).toBe(true)
    expect(isGitObjectId('1'.repeat(64), 'sha256')).toBe(true)
    expect(isGitObjectId('1'.repeat(64), 'sha1')).toBe(false)
    for (const remote of [
      { transport: 'https', coordinate: 'example.com/org/repo' },
      { transport: 'ssh', coordinate: '[2001:db8::1]:2222/org/repo' },
      { transport: 'file' },
      { transport: 'other' },
    ]) expect(safeGitRemoteObservationSchema.safeParse(remote).success).toBe(true)

    for (const coordinate of [
      'https://example.com/org/repo',
      'example.com',
      '[zz]/org/repo',
      '[:::]/org/repo',
      'user@example.com/org/repo',
      'example.com/org/repo?token=secret',
      'example.com/org/../secret',
      'example.com:00022/org/repo',
      'example.com:65536/org/repo',
      'EXAMPLE.com/org/repo',
      'a.-b.com/org/repo',
      'a.b-.com/org/repo',
      'example.com/org/repo.git',
      'example.com/org/%aa',
      `example.com/org/${'x'.repeat(MAX_REMOTE_COORDINATE_CHARS)}`,
    ]) {
      expect(safeGitRemoteObservationSchema.safeParse({ transport: 'ssh', coordinate }).success).toBe(false)
    }
    expect(safeGitRemoteObservationSchema.safeParse({ transport: 'file', coordinate: 'example.com/org/repo' }).success)
      .toBe(false)
    expect(isNormalizedRemoteCoordinate('example.com/org/repo')).toBe(true)
    expect(safeGitRemoteObservationKey({ transport: 'file' })).toBe('file\0' + '0')
    expect(compareSafeGitRemoteObservations({ transport: 'file' }, { transport: 'https' })).toBeLessThan(0)
    expect(compareSafeGitRemoteObservations({ transport: 'https' }, { transport: 'file' })).toBeGreaterThan(0)
    expect(compareSafeGitRemoteObservations({ transport: 'file' }, { transport: 'file' })).toBe(0)
  })

  it('keeps bound project status canonical, attributable, and closed', () => {
    const {
      baseline,
      binding,
      expectedInspection,
      observation,
      projectionWithoutFingerprint,
      statusSeed,
      trackedChange,
      trusted,
      untrackedChange,
    } = boundStatusFixture()
    const {
      fingerprint: _fingerprint,
      observedAt: _observedAt,
      ...observationFingerprintMaterial
    } = observation
    const { fingerprint: _trackedFingerprint, ...trackedMaterial } = trackedChange

    expect(activeHostProjectBindingSchema.parse(binding)).toEqual(binding)
    expect(inspectProjectRequestSchema.parse({ binding })).toEqual({ binding })
    const commitId = 'a'.repeat(40)
    expect(inspectProjectCommitRequestSchema.parse({ binding, commitId })).toEqual({ binding, commitId })
    expect(inspectProjectCommitRequestSchema.safeParse({ binding, commitId: 'a'.repeat(64) }).success).toBe(false)
    expect(inspectProjectCommitRequestSchema.safeParse({ binding, commitId: 'HEAD' }).success).toBe(false)
    expect(inspectProjectCommitResultSchema.parse({ ok: true, commitId })).toEqual({ ok: true, commitId })
    expect(inspectProjectCommitResultSchema.parse({ ok: false, reason: 'commit-missing' }))
      .toEqual({ ok: false, reason: 'commit-missing' })
    expect(projectGitStatusObservationSchema.parse(observation)).toEqual(observation)
    expect(inspectProjectResultSchema.parse({ ok: true, observation, preEffectBaseline: baseline }))
      .toEqual({ ok: true, observation, preEffectBaseline: baseline })
    const unavailableBaseline = { kind: 'unavailable', reason: 'file-limit', observed: OBSERVED } as const
    expect(inspectProjectResultSchema.parse({
      ok: true,
      observation: signedStatus({
        ...statusSeed,
        structuredMutation: { available: false, blockers: ['baseline-unavailable'] },
      }),
      preEffectBaseline: unavailableBaseline,
    })).toBeDefined()
    expect(inspectProjectResultSchema.safeParse({
      ok: true,
      observation,
      preEffectBaseline: unavailableBaseline,
    }).success).toBe(false)
    expect(inspectProjectResultSchema.safeParse({ ok: true, observation }).success).toBe(false)
    expect(projectGitStatusFingerprintMaterial(observation)).toEqual(observationFingerprintMaterial)
    expect(isRepositoryRelativeGitPath('line\nname.txt')).toBe(true)
    expect(compareRepositoryRelativeGitPaths('\ue000', '\u{10000}')).toBeLessThan(0)
    expect(compareRepositoryRelativeGitPaths('a', 'aa')).toBeLessThan(0)
    expect(compareRepositoryRelativeGitPaths('aa', 'a')).toBeGreaterThan(0)
    expect(signedStatus(statusSeed)).toEqual(observation)
    const laterObservation = { ...observation, observedAt: observation.observedAt + 1 }
    expect(projectGitStatusObservationSchema.parse(laterObservation)).toEqual(laterObservation)
    expect(laterObservation.fingerprint).toEqual(observation.fingerprint)
    expect(laterObservation.changes.map(change => change.id)).toEqual(observation.changes.map(change => change.id))
    const changedObservation = signedStatus({
      ...statusSeed,
      worktree: { version: 1, digest: '7'.repeat(64) },
    })
    expect(changedObservation.changes.map(change => change.id)).not.toEqual(
      observation.changes.map(change => change.id),
    )
    const unknownObservation = signedStatus({
      ...statusSeed,
      changes: [signedChange({
        ...trackedMaterial,
        worktreeEvidence: { kind: 'unavailable', reason: 'io-failure' },
        attribution: 'unattributed',
      })],
      structuredMutation: { available: false, blockers: ['current-unavailable'] },
    })
    expect(projectGitStatusObservationSchema.safeParse(unknownObservation).success).toBe(true)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [signedChange({
        ...trackedMaterial,
        worktreeEvidence: { kind: 'unavailable', reason: 'io-failure' },
        attribution: 'unattributed',
      })],
      structuredMutation: { available: true, blockers: [] },
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      structuredMutation: { available: false, blockers: ['current-unavailable'] },
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      locked: true,
      structuredMutation: { available: false, blockers: ['locked'] },
    })).success).toBe(true)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      structuredMutation: { available: false, blockers: ['index-flags'] },
    })).success).toBe(true)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      structuredMutation: {
        available: false,
        blockers: ['locked', 'baseline-unavailable'],
      },
    })).success).toBe(false)
    for (const path of [
      '', '/absolute', 'C:/authority-sentinel', 'C:\\authority-sentinel', '\\\\server\\share',
      '\\rooted', 'parent/../secret', 'double//segment', 'nul\0secret', '\ud800',
    ]) {
      expect(isRepositoryRelativeGitPath(path)).toBe(false)
      expect(projectGitStatusObservationSchema.safeParse(signedStatus({
        ...statusSeed,
        changes: [{ ...trackedChange, path }],
      })).success).toBe(false)
    }
    expect(activeHostProjectBindingSchema.safeParse({
      ...binding,
      health: 'repair-required',
    }).success).toBe(false)
    expect(activeHostProjectBindingSchema.safeParse({
      ...binding,
      id: 'resource-binding-11111111-1111-4111-8111-111111111111',
    }).success).toBe(false)
    expect(activeHostProjectBindingSchema.safeParse({
      ...binding,
      workspaceId: WorkspaceId('workspace-other'),
    }).success).toBe(true)
    expect(activeHostProjectBindingSchema.safeParse({
      ...binding,
      inheritedChangeBaseline: signedBaseline({
        ...baseline,
        bounds: { ...baseline.bounds, maxPathBytes: 21 },
      }),
    }).success).toBe(false)
    expect(activeHostProjectBindingSchema.safeParse({
      ...binding,
      expectedInspection: {
        ...expectedInspection,
        projection: signedInspection(
          {
            ...projectionWithoutFingerprint,
            hostId: 'host-22222222-2222-4222-8222-222222222222' as SakiHostId,
          },
          trusted,
        ),
      },
    }).success).toBe(false)
    const wrongIdMaterial = {
      ...observation,
      changes: [{
        ...observation.changes[0]!,
        id: `git-change-${'0'.repeat(64)}` as ProjectGitChangeId,
      }],
    }
    const { fingerprint: _wrongFingerprint, ...wrongIdObservation } = wrongIdMaterial
    expect(projectGitStatusObservationSchema.safeParse({
      ...wrongIdObservation,
      fingerprint: computeProjectGitStatusFingerprint(wrongIdObservation),
    }).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [...statusSeed.changes].reverse(),
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [trackedChange, trackedChange],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [{ ...untrackedChange, worktreeEvidence: { kind: 'missing' } }],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [signedChange({ ...trackedMaterial, worktreeMode: '120000' })],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [signedChange({ ...trackedMaterial, worktreeStatus: 'type-changed' })],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [signedChange({ ...trackedMaterial, worktreeStatus: 'unchanged', worktreeMode: '100755' })],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse(signedStatus({
      ...statusSeed,
      changes: [signedChange({ ...untrackedChange, worktreeMode: '120000' })],
    })).success).toBe(false)
    expect(projectGitStatusObservationSchema.safeParse({
      ...observation,
      fingerprint: { version: 1, digest: '0'.repeat(64) },
    }).success).toBe(false)
    for (const reason of [
      'binding-stale', 'missing', 'malformed', 'limit', 'invalid-path', 'ambiguous', 'unavailable',
    ]) {
      expect(inspectProjectResultSchema.safeParse({ ok: false, reason }).success).toBe(true)
    }
    expect(inspectProjectResultSchema.safeParse({ ok: false, reason: 'other' }).success).toBe(false)
    expect(inspectProjectResultSchema.safeParse({ ok: false, reason: 'missing', detail: 'C:\\secret' }).success)
      .toBe(false)
    expect(inspectProjectRequestSchema.safeParse({ binding, argv: ['status'] }).success).toBe(false)
  })

  it('cross-checks ordinary, untracked, unmerged, and gitlink change evidence', () => {
    const { trackedChange, untrackedChange } = boundStatusFixture()
    const { fingerprint: _trackedFingerprint, ...ordinary } = trackedChange
    const { fingerprint: _untrackedFingerprint, ...untracked } = untrackedChange
    const missingSlot = { mode: '000000' as const, objectId: '0'.repeat(40) }
    const regularSlot = { mode: '100644' as const, objectId: '1'.repeat(40) }
    const regularEvidence = {
      kind: 'regular' as const,
      mode: '100644' as const,
      byteLength: 1,
      contentDigest: '2'.repeat(64),
    }

    const validOrdinaryRows = [
      {
        ...ordinary,
        path: 'staged-addition.txt',
        indexStatus: 'added' as const,
        worktreeStatus: 'unchanged' as const,
        head: missingSlot,
        index: regularSlot,
        worktreeEvidence: regularEvidence,
      },
      {
        ...ordinary,
        path: 'staged-deletion.txt',
        indexStatus: 'deleted' as const,
        worktreeStatus: 'unchanged' as const,
        index: missingSlot,
        worktreeMode: '000000' as const,
        worktreeEvidence: { kind: 'missing' as const },
      },
      {
        ...ordinary,
        path: 'intent-to-add.txt',
        indexStatus: 'unchanged' as const,
        worktreeStatus: 'added' as const,
        head: missingSlot,
        index: missingSlot,
        worktreeEvidence: regularEvidence,
      },
      {
        ...ordinary,
        path: 'submodule',
        indexStatus: 'modified' as const,
        worktreeStatus: 'unchanged' as const,
        submodule: { kind: 'submodule' as const, commit: 'unchanged' as const },
        head: { mode: '160000' as const, objectId: '1'.repeat(40) },
        index: { mode: '160000' as const, objectId: '2'.repeat(40) },
        worktreeMode: '160000' as const,
        worktreeEvidence: { kind: 'submodule' as const, objectId: '2'.repeat(40) },
      },
      {
        ...ordinary,
        path: 'type-change',
        indexStatus: 'type-changed' as const,
        worktreeStatus: 'unchanged' as const,
        index: { mode: '120000' as const, objectId: '2'.repeat(40) },
        worktreeMode: '120000' as const,
        worktreeEvidence: { kind: 'symlink' as const, targetDigest: '3'.repeat(64) },
      },
    ]
    for (const row of validOrdinaryRows) {
      expect(projectGitChangeSchema.safeParse(retainedChange(row)).success).toBe(true)
    }

    const invalidOrdinaryRows = [
      {
        ...ordinary,
        path: 'clean.txt',
        indexStatus: 'unchanged' as const,
        worktreeStatus: 'unchanged' as const,
        index: ordinary.head,
      },
      { ...ordinary, path: 'wrong-deletion.txt', worktreeStatus: 'deleted' as const },
      { ...ordinary, path: 'wrong-presence.txt', worktreeEvidence: { kind: 'missing' as const } },
      { ...ordinary, path: 'wrong-index.txt', indexStatus: 'added' as const },
      {
        ...ordinary,
        path: 'missing-modified.txt',
        indexStatus: 'modified' as const,
        worktreeStatus: 'added' as const,
        head: missingSlot,
        index: missingSlot,
        worktreeEvidence: regularEvidence,
      },
      {
        ...ordinary,
        path: 'unreported-submodule',
        indexStatus: 'modified' as const,
        worktreeStatus: 'unchanged' as const,
        head: { mode: '160000' as const, objectId: '1'.repeat(40) },
        index: { mode: '160000' as const, objectId: '2'.repeat(40) },
        worktreeMode: '160000' as const,
        worktreeEvidence: { kind: 'submodule' as const, objectId: '2'.repeat(40) },
      },
      {
        ...validOrdinaryRows[2]!,
        path: 'wrong-submodule-commit',
        submodule: { kind: 'submodule' as const, commit: 'changed' as const },
      },
    ]
    for (const row of invalidOrdinaryRows) {
      expect(projectGitChangeSchema.safeParse(retainedChange(row)).success).toBe(false)
    }

    for (const row of [
      {
        ...untracked,
        path: 'link',
        worktreeMode: '120000' as const,
        worktreeEvidence: { kind: 'symlink' as const, targetDigest: '3'.repeat(64) },
      },
      {
        ...untracked,
        path: 'unknown',
        worktreeMode: 'unknown' as const,
        worktreeEvidence: { kind: 'unavailable' as const, reason: 'io-failure' as const },
      },
    ]) {
      expect(projectGitChangeSchema.safeParse(retainedChange(row)).success).toBe(true)
    }
    expect(projectGitChangeSchema.safeParse(retainedChange({
      ...untracked,
      path: 'impossible-submodule',
      worktreeMode: 'unknown',
      worktreeEvidence: { kind: 'submodule', objectId: '4'.repeat(40) },
    })).success).toBe(false)

    const unmerged = {
      path: 'conflict.txt',
      kind: 'unmerged' as const,
      indexStatus: 'unmerged' as const,
      worktreeStatus: 'present' as const,
      conflict: 'both-modified' as const,
      submodule: { kind: 'not-submodule' as const },
      stages: { base: regularSlot, ours: regularSlot, theirs: regularSlot },
      worktreeMode: '100644' as const,
      worktreeEvidence: regularEvidence,
      attribution: 'unattributed' as const,
    }
    const addedByUs = {
      ...unmerged,
      path: 'added-by-us.txt',
      conflict: 'added-by-us' as const,
      stages: { base: missingSlot, ours: regularSlot, theirs: missingSlot },
    }
    const submoduleConflict = {
      ...unmerged,
      path: 'submodule-conflict',
      submodule: { kind: 'submodule' as const, commit: 'unknown' as const },
      stages: {
        base: { mode: '160000' as const, objectId: '1'.repeat(40) },
        ours: { mode: '160000' as const, objectId: '2'.repeat(40) },
        theirs: { mode: '160000' as const, objectId: '3'.repeat(40) },
      },
      worktreeMode: '160000' as const,
      worktreeEvidence: { kind: 'submodule' as const, objectId: '2'.repeat(40) },
    }
    for (const row of [unmerged, addedByUs, submoduleConflict]) {
      expect(projectGitChangeSchema.safeParse(retainedChange(row)).success).toBe(true)
    }
    for (const row of [
      { ...unmerged, path: 'wrong-mode.txt', worktreeStatus: 'absent' as const },
      { ...unmerged, path: 'wrong-evidence.txt', worktreeEvidence: { kind: 'missing' as const } },
      { ...unmerged, path: 'wrong-conflict.txt', conflict: 'both-added' as const },
      {
        ...unmerged,
        path: 'unreported-gitlink',
        stages: {
          ...unmerged.stages,
          base: { mode: '160000' as const, objectId: '1'.repeat(40) },
        },
      },
      {
        ...submoduleConflict,
        path: 'wrong-conflict-submodule-state',
        submodule: { kind: 'submodule' as const, commit: 'changed' as const },
      },
    ]) {
      expect(projectGitChangeSchema.safeParse(retainedChange(row)).success).toBe(false)
    }
  })

  it('rejects cross-row status contradictions and mixed object formats', () => {
    const { statusSeed, trackedChange } = boundStatusFixture()
    const { upstream: _upstream, ...withoutUpstream } = statusSeed
    const { fingerprint: _fingerprint, ...ordinary } = trackedChange
    const unmerged = signedChange({
      path: 'conflict.txt',
      kind: 'unmerged',
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
        kind: 'regular', mode: '100644', byteLength: 1, contentDigest: '4'.repeat(64),
      },
      attribution: 'unattributed',
    } as const)
    const invalidStatusSeeds: readonly ProjectGitStatusSeedMaterial[] = [
      {
        ...statusSeed,
        changes: [],
        branch: { kind: 'attached', ref: 'refs/heads/other', name: 'other' },
      },
      {
        ...withoutUpstream,
        changes: [],
        branch: { kind: 'detached' },
      },
      {
        ...statusSeed,
        changes: [],
        head: { kind: 'commit', objectId: '1'.repeat(40) },
        branch: { kind: 'detached' },
      },
      {
        ...statusSeed,
        changes: [],
        objectFormat: 'sha256',
        head: { kind: 'commit', objectId: '1'.repeat(64), symbolicRef: 'refs/heads/main' },
      },
      {
        ...statusSeed,
        changes: [],
        index: { kind: 'unmerged', stagesDigest: { version: 1, digest: 'f'.repeat(64) } },
        structuredMutation: { available: false, blockers: ['unmerged'] },
      },
      {
        ...statusSeed,
        changes: [unmerged],
      },
      {
        ...statusSeed,
        changes: [signedChange({ ...ordinary, index: { ...ordinary.index, objectId: '2'.repeat(64) } })],
      },
      {
        ...statusSeed,
        changes: [signedChange({
          ...ordinary,
          path: 'wrong-missing-slot.txt',
          indexStatus: 'deleted',
          worktreeStatus: 'unchanged',
          index: { mode: '000000', objectId: '2'.repeat(40) },
          worktreeMode: '000000',
          worktreeEvidence: { kind: 'missing' },
        })],
      },
      {
        ...statusSeed,
        changes: [signedChange({
          ...ordinary,
          path: 'wrong-submodule-width',
          indexStatus: 'modified',
          worktreeStatus: 'unchanged',
          submodule: { kind: 'submodule', commit: 'unchanged' },
          head: { mode: '160000', objectId: '1'.repeat(40) },
          index: { mode: '160000', objectId: '2'.repeat(40) },
          worktreeMode: '160000',
          worktreeEvidence: { kind: 'submodule', objectId: '2'.repeat(64) },
        })],
      },
    ]
    for (const seed of invalidStatusSeeds) {
      expect(projectGitStatusObservationSchema.safeParse(signedStatus(seed)).success).toBe(false)
    }

  })

  it('rejects an oversized raw status row array before reading an element', () => {
    const { observation } = boundStatusFixture()
    const changes: unknown[] = []
    changes.length = MAX_PROJECT_GIT_STATUS_CHANGES + 1
    let elementReads = 0
    Object.defineProperty(changes, '0', {
      configurable: true,
      get() {
        elementReads += 1
        throw new Error('status row limit read an element')
      },
    })

    const result = projectGitStatusObservationSchema.safeParse({ ...observation, changes })

    expect(elementReads).toBe(0)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('oversized status row array passed validation')
    expect(result.error.issues.map(({ code, path, message }) => ({ code, path, message }))).toEqual([{
      code: 'custom',
      path: ['changes'],
      message: 'status changes exceed the protocol row limit',
    }])
  })

  it('lets the exact status row limit reach path preflight', () => {
    const { observation } = boundStatusFixture()
    const changes: unknown[] = []
    changes.length = MAX_PROJECT_GIT_STATUS_CHANGES
    const reachedPathPreflight = new Error('exact status row limit reached path preflight')
    Object.defineProperty(changes, '0', {
      configurable: true,
      get() {
        throw reachedPathPreflight
      },
    })

    expect(() => projectGitStatusObservationSchema.safeParse({ ...observation, changes }))
      .toThrow(reachedPathPreflight)
  })

  it('rejects an individually oversized raw status path before UTF-8 encoding', () => {
    const { observation } = boundStatusFixture()
    const path = 'a'.repeat(MAX_PROJECT_GIT_STATUS_PATH_BYTES + 1)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      const result = projectGitStatusObservationSchema.safeParse({
        ...observation,
        changes: [{ ...observation.changes[0]!, path }],
      })

      expect(encode.mock.calls.some(([value]) => value === path)).toBe(false)
      expect(result.success).toBe(false)
      if (result.success) throw new Error('oversized status path passed validation')
      expect(result.error.issues.map(({ code, path: issuePath, message }) => ({
        code, path: issuePath, message,
      }))).toEqual([{
        code: 'custom',
        path: ['changes'],
        message: 'status paths exceed the protocol byte limit',
      }])
    } finally {
      encode.mockRestore()
    }
  }, 15_000)

  it('lets an exact status path byte budget reach complete row validation', () => {
    const { observation } = boundStatusFixture()
    const path = 'a'.repeat(MAX_PROJECT_GIT_STATUS_PATH_BYTES)

    const result = projectGitStatusObservationSchema.safeParse({
      ...observation,
      changes: [{ ...observation.changes[0]!, path }],
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('stale exact-budget status row passed validation')
    const messages = result.error.issues.map(({ message }) => message)
    expect(messages).toContain('change fingerprint disagrees with row evidence')
    expect(messages).not.toContain('status paths exceed the protocol byte limit')
  }, 30_000)

  it('leaves malformed status rows to structural validation after path-budget preflight', () => {
    const { observation } = boundStatusFixture()
    const result = projectGitStatusObservationSchema.safeParse({
      ...observation,
      changes: [null, {}, { path: 1 }],
    })

    expect(result.success).toBe(false)
    if (result.success) throw new Error('malformed status rows passed validation')
    expect(result.error.issues.map(({ message }) => message))
      .not.toContain('status paths exceed the protocol byte limit')
  })

  it('enforces the aggregate UTF-8 status-path byte limit before later rows and derived evidence', () => {
    const { observation } = boundStatusFixture()
    const longPath = `a${'\u0800'.repeat(Math.floor(MAX_PROJECT_GIT_STATUS_PATH_BYTES / 6) + 1)}`
    const unreadable = { ...observation.changes[0]! }
    let laterPathReads = 0
    Object.defineProperty(unreadable, 'path', {
      configurable: true,
      enumerable: true,
      get() {
        laterPathReads += 1
        throw new Error('status path budget read past its first overflow')
      },
    })

    const result = projectGitStatusObservationSchema.safeParse({
      ...observation,
      changes: [
        { ...observation.changes[0]!, path: `${longPath}a` },
        {
          ...observation.changes[0]!,
          id: `git-change-${'e'.repeat(64)}`,
          path: `${longPath}b`,
        },
        unreadable,
      ],
    })

    expect(laterPathReads).toBe(0)
    expect(result.success).toBe(false)
    if (result.success) throw new Error('aggregate status path budget passed validation')
    expect(result.error.issues.map(({ code, path, message }) => ({ code, path, message }))).toEqual([{
      code: 'custom',
      path: ['changes'],
      message: 'status paths exceed the protocol byte limit',
    }])
  }, 15_000)

  it('keeps paginated project Diff requests opaque and result pages internally consistent', () => {
    const { binding, observation } = boundStatusFixture()
    const changeId = observation.changes[0]!.id
    const cursor = 'eyJ2IjoxLCJuZXh0TGluZSI6MX0' as ProjectGitDiffCursor
    const request = {
      expectedStatus: observation.fingerprint,
      changeId,
      layer: 'staged',
    } as const
    const lines = ['diff --git a/file b/file', '--- a/file', '+++ b/file'] as const
    const pageUtf8Bytes = diffLineBytes(lines)
    const page = {
      pageVersion: 1,
      observation: observation.fingerprint,
      changeId,
      layer: 'staged',
      patchFingerprint: { version: 1, digest: '7'.repeat(64) },
      range: { startLine: 0, endLineExclusive: lines.length, totalLines: lines.length },
      lines,
      pageUtf8Bytes,
      totalUtf8Bytes: pageUtf8Bytes,
      omittedBeforeLines: 0,
      omittedAfterLines: 0,
      truncated: false,
    } as const

    expect(readProjectDiffRequestSchema.parse(request)).toEqual(request)
    expect(readProjectDiffOperationRequestSchema.parse({ binding, request })).toEqual({ binding, request })
    expect(readProjectDiffRequestSchema.parse({ ...request, layer: 'conflict' })).toEqual({ ...request, layer: 'conflict' })
    expect(projectGitDiffPageSchema.parse(page)).toEqual(page)
    expect(readProjectDiffResultSchema.parse({ ok: true, page })).toEqual({ ok: true, page })
    expect(projectGitDiffCursorSchema.parse(cursor)).toBe(cursor)

    for (const forbidden of [
      { binding },
      { path: 'file' },
      { argv: ['diff'] },
      { cwd: 'C:\\repo' },
      { env: { GIT_DIR: 'C:\\repo\\.git' } },
    ]) {
      expect(readProjectDiffRequestSchema.safeParse({ ...request, ...forbidden }).success).toBe(false)
    }
    expect(projectGitDiffCursorSchema.safeParse('not/base64url=').success).toBe(false)
    expect(projectGitDiffCursorSchema.safeParse('x'.repeat(MAX_PROJECT_GIT_DIFF_CURSOR_CHARS + 1)).success).toBe(false)
    const embeddedLine = 'embedded\nline'
    const embeddedLineBytes = diffLineBytes([embeddedLine])
    expect(projectGitDiffPageSchema.safeParse({
      ...page,
      range: { startLine: 0, endLineExclusive: 1, totalLines: 1 },
      lines: [embeddedLine],
      pageUtf8Bytes: embeddedLineBytes,
      totalUtf8Bytes: embeddedLineBytes,
    }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({
      ...page,
      lines: ['x'.repeat(MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES)],
      range: { startLine: 0, endLineExclusive: 1, totalLines: 1 },
      pageUtf8Bytes: MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES + 1,
      totalUtf8Bytes: MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES + 1,
    }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({ ...page, pageUtf8Bytes: pageUtf8Bytes - 1 }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({
      ...page,
      omittedBeforeLines: 1,
      totalUtf8Bytes: pageUtf8Bytes + 1,
      truncated: true,
    }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({ ...page, totalUtf8Bytes: pageUtf8Bytes + 1 }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({ ...page, truncated: true }).success).toBe(false)
    expect(projectGitDiffPageSchema.safeParse({
      ...page,
      range: { startLine: 1, endLineExclusive: 2, totalLines: 3 },
      lines: [lines[1]],
      pageUtf8Bytes: diffLineBytes([lines[1]]),
      omittedBeforeLines: 1,
      omittedAfterLines: 1,
      truncated: true,
    }).success).toBe(false)
    const middlePage = {
      ...page,
      range: { startLine: 1, endLineExclusive: 2, totalLines: 3 },
      lines: [lines[1]],
      pageUtf8Bytes: diffLineBytes([lines[1]]),
      omittedBeforeLines: 1,
      omittedAfterLines: 1,
      truncated: true,
      nextCursor: cursor,
    } as const
    expect(projectGitDiffPageSchema.parse(middlePage)).toEqual(middlePage)
    expect(projectGitDiffPageSchema.safeParse({ ...page, nextCursor: cursor }).success).toBe(false)
    for (const reason of [
      'binding-stale', 'observation-stale', 'change-missing', 'change-ambiguous', 'layer-missing',
      'invalid-cursor', 'cursor-stale', 'total-bytes', 'total-lines', 'line-bytes', 'time',
      'untracked', 'conflict', 'binary', 'command-length', 'invalid-utf8', 'malformed', 'ambiguous', 'unavailable',
    ]) {
      expect(readProjectDiffResultSchema.safeParse({ ok: false, reason }).success).toBe(true)
    }
    expect(readProjectDiffResultSchema.safeParse({ ok: false, reason: 'other' }).success).toBe(false)
    expect(readProjectDiffResultSchema.safeParse({ ok: false, reason: 'unavailable', path: 'C:\\secret' }).success)
      .toBe(false)
  })

  it('admits one complete dispatch-sourced StartAgentRun request and result', () => {
    const { request, result } = startAgentRunFixture()

    expect(startAgentRunHostOperationRequestSchema.parse(request)).toEqual(request)
    expect(hostOperationRequestSchema.parse(request)).toEqual(request)
    expect(startAgentRunHostOperationResultSchema.parse(result)).toEqual(result)
  })

  it('admits one exact PushBranch request and result while keeping the v2 request union frozen', () => {
    const { request, result } = pushBranchFixture()

    expect(pushBranchHostOperationRequestSchema.parse(request)).toEqual(request)
    expect(hostOperationRequestSchema.parse(request)).toEqual(request)
    expect(hostOperationRequestV2Schema.safeParse(request).success).toBe(false)
    expect(pushBranchHostOperationResultSchema.parse(result)).toEqual(result)
  })

  it('rejects non-canonical GitHub repository coordinates in a PushBranch request', () => {
    const { request } = pushBranchFixture()

    expect(pushBranchHostOperationRequestSchema.safeParse({
      ...request,
      expected: { ...request.expected, repository: { nameWithOwner: 'owner/.' } },
    }).success).toBe(false)
  })

  it('requires SHA-256 commit identities for Push and lookup in a SHA-256 Binding', () => {
    const { binding, request } = pushBranchFixture()
    const head = binding.expectedInspection.projection.head
    if (head.kind !== 'commit') throw new Error('expected a committed Binding HEAD')
    const sha256Binding = {
      ...binding,
      expectedInspection: {
        ...binding.expectedInspection,
        projection: signedInspection({
          ...binding.expectedInspection.projection,
          objectFormat: 'sha256',
          head: { ...head, objectId: 'a'.repeat(64) },
        }, binding.expectedInspection.trusted),
      },
    }
    for (const width of [40, 64]) {
      const commitId = 'a'.repeat(width)
      expect(pushBranchHostOperationRequestSchema.safeParse({
        ...request,
        expected: { ...request.expected, binding: sha256Binding, commitId },
      }).success).toBe(width === 64)
      expect(inspectProjectCommitRequestSchema.safeParse({ binding: sha256Binding, commitId }).success)
        .toBe(width === 64)
    }
  })

  it('keeps PushBranch transport and credential authority Host-owned', () => {
    const { request } = pushBranchFixture()

    expect(pushBranchHostOperationRequestSchema.safeParse({
      ...request,
      url: 'https://github.com/BreakfastDaPaiDang/saki.git',
    }).success).toBe(false)
    expect(pushBranchHostOperationRequestSchema.safeParse({
      ...request,
      credential: { helperId: 'caller-helper' },
    }).success).toBe(false)
  })

  it('requires PushBranch refs and object ids to match their closed Git identities', () => {
    const { request, result } = pushBranchFixture()

    expect(pushBranchHostOperationRequestSchema.safeParse({ ...request, targetRef: 'refs/tags/v1' }).success)
      .toBe(false)
    expect(pushBranchHostOperationRequestSchema.safeParse({
      ...request,
      expected: { ...request.expected, commitId: '1'.repeat(64) },
    }).success).toBe(false)
    expect(pushBranchHostOperationResultSchema.safeParse({
      ...result,
      previous: { kind: 'commit', objectId: '2'.repeat(64) },
    }).success).toBe(false)
    expect(pushBranchHostOperationResultSchema.safeParse({
      ...result,
      credential: { helperId: 'manager', password: 'secret' },
    }).success).toBe(false)
    expect(pushBranchHostOperationResultSchema.safeParse({
      ...result,
      credential: { helperId: 'git credential manager' },
    }).success).toBe(false)
    expect(pushBranchHostOperationResultSchema.safeParse({
      ...result,
      credential: { helperId: 'caller-helper' },
    }).success).toBe(false)
  })

  it('correlates a succeeded PushBranch snapshot with its reference and result', () => {
    const { binding, request, result } = pushBranchFixture()
    const snapshot = {
      operation: {
        id: 'host-operation-33333333-3333-4333-8333-333333333333',
        hostId: binding.hostId,
        type: 'push-branch',
      },
      revision: 1,
      source: request.source,
      requestFingerprint: { version: 1, digest: '8'.repeat(64) },
      bindingId: binding.id,
      bindingRevision: binding.revision,
      preparedAt: 10,
      updatedAt: 12,
      state: 'succeeded',
      admission: { kind: 'accepted', revision: 1, acceptedAt: 11 },
      completedAt: 12,
      result: { ...result, previous: { kind: 'absent' } },
    } as const

    expect(hostOperationSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      operation: { ...snapshot.operation, type: 'commit' },
    }).success).toBe(false)
  })

  it('admits one attributed Intervention answer through StartAgentRun while preserving the exact v2 request schema', () => {
    const { request } = startAgentRunFixture()
    const sourceInput = {
      kind: 'saki-intervention-answer',
      interventionId: 'intervention-88888888-8888-4888-8888-888888888888',
      answerIntentId: 'intent-99999999-9999-4999-8999-999999999999',
      dispatchId: request.source.dispatchId,
      agentRunId: request.run.agentRunId,
      workSessionId: request.run.workSessionId,
      actor: {
        installationId: 'installation-11111111-1111-4111-8111-111111111111',
        storageGenerationId: 'storage-generation-22222222-2222-4222-8222-222222222222',
        hostId: request.expected.binding.hostId,
        principalId: 'principal-33333333-3333-4333-8333-333333333333',
        principalRevision: 4,
        grantId: 'grant-44444444-4444-4444-8444-444444444444',
        grantRevision: 5,
      },
    } as const
    const source = sakiInterventionAnswerMessageSourceSchema.parse(sourceInput)
    const input = { ...request.run.input, source }
    const answerRequest = {
      ...request,
      source: { ...request.source, payloadDigest: computeStartAgentRunPayloadDigest(input) },
      run: { ...request.run, input },
    }

    expect(source).toEqual(sourceInput)
    expect(startAgentRunHostOperationRequestSchema.parse(answerRequest)).toEqual(answerRequest)
    expect(hostOperationRequestSchema.parse(answerRequest)).toEqual(answerRequest)
    expect(startAgentRunHostOperationRequestV2Schema.safeParse(answerRequest).success).toBe(false)
  })

  it('bounds Intervention-opening inspection to stable coordinates and closed evidence', () => {
    const request = {
      hostId: HOST_ID,
      sessionId: 'session-55555555-5555-4555-8555-555555555555',
      callId: 'request-intervention-1',
      interventionId: 'intervention-66666666-6666-4666-8666-666666666666',
      expectedQuestion: 'Which exact path should this Agent Run take?',
      expectedToolResult: {
        content: [{
          type: 'text',
          text: '{"interventionId":"intervention-66666666-6666-4666-8666-666666666666"}',
        }],
      },
    }
    expect(inspectInterventionOpeningRequestSchema.parse(request)).toEqual(request)
    for (const evidence of [
      { kind: 'absent' },
      { kind: 'pending' },
      { kind: 'confirmed', turn: 1, step: 2 },
      { kind: 'conflict' },
    ]) {
      expect(interventionOpeningEvidenceSchema.safeParse(evidence).success).toBe(true)
    }
    expect(interventionOpeningEvidenceSchema.safeParse({ kind: 'confirmed', turn: 0, step: 1 }).success).toBe(false)
  })

  it('keeps Dispatch claims out of immutable StartAgentRun input and correlates every stable id', () => {
    const { request } = startAgentRunFixture()
    const change = boundStatusFixture().observation.changes[0]!
    const operation = { source: request.source, expected: request.expected }
    const snapshot = {
      operation: {
        id: 'host-operation-99999999-9999-4999-8999-999999999999',
        hostId: request.expected.binding.hostId,
        type: 'start-agent-run',
      },
      revision: 0,
      source: request.source,
      requestFingerprint: { version: 1, digest: '9'.repeat(64) },
      bindingId: request.expected.binding.id,
      bindingRevision: request.expected.binding.revision,
      preparedAt: 1,
      updatedAt: 1,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as const

    expect(startAgentRunHostOperationRequestSchema.safeParse({
      ...request,
      source: { ...request.source, claimId: 'claim-sentinel', fencingToken: 3 },
    }).success).toBe(false)
    for (const [field, mismatch] of [
      ['dispatchId', 'dispatch-88888888-8888-4888-8888-888888888888'],
      ['agentRunId', 'agent-run-88888888-8888-4888-8888-888888888888'],
      ['workSessionId', 'work-session-88888888-8888-4888-8888-888888888888'],
    ] as const) {
      expect(startAgentRunHostOperationRequestSchema.safeParse({
        ...request,
        run: {
          ...request.run,
          input: {
            ...request.run.input,
            source: {
              ...request.run.input.source,
              [field]: mismatch,
            },
          },
        },
      }).success, field).toBe(false)
    }
    expect(startAgentRunHostOperationRequestSchema.safeParse({
      ...request,
      source: { ...request.source, payloadDigest: '0'.repeat(64) },
    }).success).toBe(false)
    expect(hostOperationRequestSchema.safeParse({
      ...operation,
      type: 'stage-files',
      changes: [{ id: change.id, fingerprint: change.fingerprint }],
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      operation: { ...snapshot.operation, type: 'stage-files' },
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      source: {
        kind: 'control-intent',
        intentId: 'intent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        intentRevision: 0,
        payloadDigest: 'a'.repeat(64),
      },
    }).success).toBe(false)
  })

  it('keeps Host Operation requests path-free and durable lifecycle evidence closed', () => {
    const { baseline, binding, observation, projectionWithoutFingerprint } = boundStatusFixture()
    const trackedChange = observation.changes[0]!
    const source = {
      kind: 'control-intent',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      intentRevision: 0,
      payloadDigest: '7'.repeat(64),
    } as const
    const expected = {
      binding,
      status: observation.fingerprint,
      head: observation.head,
      index: observation.index,
      worktree: observation.worktree,
      preEffectBaseline: baseline,
    } as const
    const selection = [{ id: trackedChange.id, fingerprint: trackedChange.fingerprint }] as const
    const request = { type: 'stage-files', source, expected, changes: selection } as const

    expect(hostOperationRequestSchema.parse(request)).toEqual(request)
    expect(hostOperationRequestSchema.safeParse({ ...request, path: trackedChange.path }).success).toBe(false)
    expect(hostOperationRequestSchema.safeParse({ ...request, changes: [...selection, ...selection] }).success).toBe(false)
    expect(hostOperationRequestSchema.safeParse({
      ...request,
      expected: { ...expected, index: { kind: 'unmerged' } },
    }).success).toBe(false)
    expect(hostOperationRequestSchema.safeParse({
      ...request,
      expected: { ...expected, preEffectBaseline: { kind: 'unavailable', reason: 'io-failure', observed: OBSERVED } },
    }).success).toBe(false)
    expect(hostOperationRequestSchema.safeParse({ ...request, source: { ...source, currentRevision: 1 } }).success)
      .toBe(false)
    expect(hostOperationRequestSchema.safeParse({ type: 'commit', source, expected, message: 'subject' }).success)
      .toBe(true)
    expect(hostOperationRequestSchema.safeParse({ type: 'commit', source, expected, message: '' }).success).toBe(false)
    for (const message of ['bad\uD800', '\uDC00bad']) {
      expect(hostOperationRequestSchema.safeParse({ type: 'commit', source, expected, message }).success).toBe(false)
    }
    const sha256Projection = {
      ...projectionWithoutFingerprint,
      objectFormat: 'sha256' as const,
      head: { kind: 'commit' as const, objectId: '1'.repeat(64), symbolicRef: 'refs/heads/main' },
    }
    const sha256Binding = {
      ...binding,
      expectedInspection: {
        ...binding.expectedInspection,
        projection: signedInspection(sha256Projection, binding.expectedInspection.trusted),
      },
    }
    expect(hostOperationRequestSchema.safeParse({
      ...request,
      expected: { ...expected, binding: sha256Binding },
    }).success).toBe(false)

    const operation = {
      id: 'host-operation-33333333-3333-4333-8333-333333333333',
      hostId: HOST_ID,
      type: 'stage-files',
    } as const
    const preparation = {
      operation,
      preparationRevision: 0,
      requestFingerprint: { version: 1, digest: '8'.repeat(64) },
    } as const
    const snapshot = {
      operation,
      revision: 0,
      source,
      requestFingerprint: preparation.requestFingerprint,
      bindingId: binding.id,
      bindingRevision: binding.revision,
      preparedAt: 10,
      updatedAt: 10,
      state: 'prepared',
      admission: { kind: 'not-accepted' },
    } as const
    expect(hostOperationPreparationSchema.parse(preparation)).toEqual(preparation)
    expect(hostOperationSnapshotSchema.parse(snapshot)).toEqual(snapshot)
    expect(hostOperationSnapshotSchema.safeParse({ ...snapshot, acceptance: {} }).success).toBe(false)
    expect(hostOperationStartResultSchema.parse({ ok: false, reason: 'not-current', snapshot }))
      .toEqual({ ok: false, reason: 'not-current', snapshot })
    expect(hostOperationStartResultSchema.parse({ ok: false, reason: 'busy', snapshot }))
      .toEqual({ ok: false, reason: 'busy', snapshot })
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      state: 'failed',
      completedAt: 10,
      failure: { reason: 'busy' },
      effect: 'none',
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      state: 'reconciliation-required',
      observedAt: 11,
      reason: 'effect-unknown',
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({ ...snapshot, updatedAt: snapshot.preparedAt - 1 }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      state: 'accepted',
      admission: { kind: 'accepted', revision: 1, acceptedAt: snapshot.preparedAt - 1 },
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      state: 'publishing',
      updatedAt: 14,
      admission: { kind: 'accepted', revision: 1, acceptedAt: 11 },
      plannedAt: 13,
      effectPlannedAt: 12,
      publishingAt: 14,
    }).success).toBe(false)
    for (const current of [
      {
        ...snapshot,
        state: 'planning' as const,
        updatedAt: 11,
        admission: { kind: 'accepted' as const, revision: 1, acceptedAt: 10 },
        plannedAt: 11,
      },
      {
        ...snapshot,
        state: 'reconciliation-required' as const,
        updatedAt: 11,
        admission: { kind: 'accepted' as const, revision: 1, acceptedAt: 10 },
        observedAt: 11,
        reason: 'effect-unknown' as const,
      },
    ]) {
      expect(hostOperationSnapshotSchema.parse(current)).toEqual(current)
    }

    class TestAcceptance extends HostOperationAcceptance {
      constructor(created = true) {
        super()
        if (!created) throw new Error('not created')
      }
    }
    expect(JSON.stringify(new TestAcceptance())).toBe('{}')

    const commitResult = {
      type: 'commit',
      commitId: '9'.repeat(40),
      treeId: 'a'.repeat(40),
      parent: { kind: 'commit', objectId: '1'.repeat(40) },
      target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
      author: { name: 'Test User', email: 'foo', timestamp: 1, timezone: '+0800', source: 'git-config' },
      committer: { name: 'Test User', email: 'a b@c', timestamp: 1, timezone: '+0800', source: 'git-config' },
    } as const
    expect(commitHostOperationResultSchema.parse(commitResult)).toEqual(commitResult)
    expect(commitHostOperationResultSchema.parse({ ...commitResult, parent: { kind: 'none' } }))
      .toEqual({ ...commitResult, parent: { kind: 'none' } })
    expect(commitHostOperationResultSchema.safeParse({ ...commitResult, treeId: 'b'.repeat(64) }).success).toBe(false)
    expect(commitHostOperationResultSchema.safeParse({ ...commitResult, postObservation: observation }).success).toBe(false)
    expect(commitHostOperationResultSchema.safeParse({
      ...commitResult,
      target: { kind: 'symbolic-ref', ref: 'refs/remotes/origin/main' },
    }).success).toBe(false)
    const appliedChange = {
      id: trackedChange.id,
      fingerprint: trackedChange.fingerprint,
      path: trackedChange.path,
    }
    const stageResult = {
      type: 'stage-files' as const,
      changes: [appliedChange],
      resultingIndex: { kind: 'tree' as const, treeId: 'b'.repeat(40) },
    }
    expect(stageFilesHostOperationResultSchema.parse(stageResult)).toEqual(stageResult)
    expect(stageFilesHostOperationResultSchema.safeParse({
      ...stageResult,
      changes: [appliedChange, { ...appliedChange, id: `git-change-${'e'.repeat(64)}` }],
    }).success).toBe(false)
    expect(stageFilesHostOperationResultSchema.safeParse({
      ...stageResult,
      changes: [appliedChange, { ...appliedChange, path: 'other.txt' }],
    }).success).toBe(false)
    expect(hostOperationSnapshotSchema.safeParse({
      ...snapshot,
      state: 'succeeded',
      revision: 1,
      updatedAt: 12,
      admission: { kind: 'accepted', revision: 1, acceptedAt: 11 },
      completedAt: 12,
      result: { ...stageResult, type: 'unstage-files' },
    }).success).toBe(false)
  })

  it('rejects an oversized raw Host Operation selection before reading an element', () => {
    const { baseline, binding, observation } = boundStatusFixture()
    const changes: unknown[] = []
    changes.length = MAX_HOST_OPERATION_SELECTED_CHANGES + 1
    let elementReads = 0
    Object.defineProperty(changes, '0', {
      configurable: true,
      get() {
        elementReads += 1
        throw new Error('Host Operation selection limit read an element')
      },
    })

    const result = hostOperationRequestSchema.safeParse({
      type: 'stage-files',
      source: {
        kind: 'control-intent',
        intentId: 'intent-22222222-2222-4222-8222-222222222222',
        intentRevision: 0,
        payloadDigest: '7'.repeat(64),
      },
      expected: {
        binding,
        status: observation.fingerprint,
        head: observation.head,
        index: observation.index,
        worktree: observation.worktree,
        preEffectBaseline: baseline,
      },
      changes,
    })

    expect(elementReads).toBe(0)
    expect(result.success).toBe(false)
  })

  it('rejects an oversized raw Commit message before UTF-8 encoding', () => {
    const { baseline, binding, observation } = boundStatusFixture()
    const message = 'a'.repeat(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES + 1)
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')
    try {
      const result = hostOperationRequestSchema.safeParse({
        type: 'commit',
        source: {
          kind: 'control-intent',
          intentId: 'intent-22222222-2222-4222-8222-222222222222',
          intentRevision: 0,
          payloadDigest: '7'.repeat(64),
        },
        expected: {
          binding,
          status: observation.fingerprint,
          head: observation.head,
          index: observation.index,
          worktree: observation.worktree,
          preEffectBaseline: baseline,
        },
        message,
      })

      expect(encode.mock.calls.some(([value]) => value === message)).toBe(false)
      expect(result.success).toBe(false)

      const multibyteMessage = '\u0800'.repeat(
        Math.floor(MAX_HOST_OPERATION_COMMIT_MESSAGE_UTF8_BYTES / 3) + 1,
      )
      const multibyteResult = hostOperationRequestSchema.safeParse({
        type: 'commit',
        source: {
          kind: 'control-intent',
          intentId: 'intent-22222222-2222-4222-8222-222222222222',
          intentRevision: 0,
          payloadDigest: '7'.repeat(64),
        },
        expected: {
          binding,
          status: observation.fingerprint,
          head: observation.head,
          index: observation.index,
          worktree: observation.worktree,
          preEffectBaseline: baseline,
        },
        message: multibyteMessage,
      })
      expect(encode.mock.calls.some(([value]) => value === multibyteMessage)).toBe(true)
      expect(multibyteResult.success).toBe(false)
    } finally {
      encode.mockRestore()
    }
  })

  it('rejects an oversized raw Host Operation result before reading an element', () => {
    const changes: unknown[] = []
    changes.length = MAX_HOST_OPERATION_SELECTED_CHANGES + 1
    let elementReads = 0
    Object.defineProperty(changes, '0', {
      configurable: true,
      get() {
        elementReads += 1
        throw new Error('Host Operation result limit read an element')
      },
    })

    const result = stageFilesHostOperationResultSchema.safeParse({
      type: 'stage-files',
      changes,
      resultingIndex: { kind: 'tree', treeId: 'b'.repeat(40) },
    })

    expect(elementReads).toBe(0)
    expect(result.success).toBe(false)
  })

  it('enforces the aggregate UTF-8 path budget across one Host Operation result', () => {
    const { observation } = boundStatusFixture()
    const firstPathLength = Math.floor(MAX_PROJECT_GIT_STATUS_PATH_BYTES / 2)
    const secondPathLength = MAX_PROJECT_GIT_STATUS_PATH_BYTES - firstPathLength
    const changes = [
      {
        id: observation.changes[0]!.id,
        fingerprint: observation.changes[0]!.fingerprint,
        path: `a${'x'.repeat(firstPathLength - 1)}`,
      },
      {
        id: observation.changes[1]!.id,
        fingerprint: observation.changes[1]!.fingerprint,
        path: `b${'y'.repeat(secondPathLength - 1)}`,
      },
    ] as const
    const result = {
      type: 'stage-files' as const,
      changes,
      resultingIndex: { kind: 'tree' as const, treeId: 'b'.repeat(40) },
    }

    expect(stageFilesHostOperationResultSchema.safeParse(result).success).toBe(true)
    expect(stageFilesHostOperationResultSchema.safeParse({
      ...result,
      changes: [changes[0], { ...changes[1], path: `${changes[1].path}z` }],
    }).success).toBe(false)
  }, 15_000)


  it('constructs a Host Execution provider through the service seam', async () => {
    class TestExecution extends SakiHostExecution {
      async inspectProjectSelection(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async inspectProject(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async inspectProjectCommit(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async readDiff(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async inspectInterventionOpening(): Promise<{ readonly kind: 'absent' }> {
        return { kind: 'absent' }
      }

      async prepareOperation(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async startOperation(): Promise<never> { throw new Error('unavailable') }
      async resumeAgentRun(): Promise<never> { throw new Error('unavailable') }
      async inspectOperation(): Promise<never> { throw new Error('unavailable') }
      async cancelOperation(): Promise<never> { throw new Error('unavailable') }
      onChanged(): () => void { return () => undefined }
    }
    const ctx = new Context()
    const execution = new TestExecution(ctx)

    await expect(execution.inspectProjectSelection()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.inspectProject()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.inspectProjectCommit()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.readDiff()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.inspectInterventionOpening()).resolves.toEqual({ kind: 'absent' })
    await expect(execution.prepareOperation()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await ctx.fiber.dispose()
  })
})

function pushBranchFixture() {
  const { binding } = boundStatusFixture()
  const request = {
    type: 'push-branch',
    source: {
      kind: 'control-intent',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      intentRevision: 0,
      payloadDigest: '7'.repeat(64),
    },
    expected: {
      binding,
      commitId: '1'.repeat(40),
      repository: { nameWithOwner: 'BreakfastDaPaiDang/saki' },
    },
    targetRef: 'refs/heads/main',
  } as const
  return {
    binding,
    request,
    result: {
      type: 'push-branch',
      repository: request.expected.repository,
      targetRef: request.targetRef,
      commitId: request.expected.commitId,
      previous: { kind: 'commit', objectId: '2'.repeat(40) },
      credential: { helperId: 'git-credential-manager' },
    } as const,
  }
}

function boundStatusFixture() {
  const baseline = signedBaseline({
    kind: 'complete',
    formatVersion: 1,
    capturedAt: 1,
    bounds: {
      maxEntries: 2, maxPathBytes: 20, maxGitOutputBytes: 20,
      maxFileBytes: 20, maxTotalFileBytes: 20, maxCaptureMs: 20,
    },
    observed: { entries: 0, pathBytes: 0, gitOutputBytes: 1, hashedBytes: 0, elapsedMs: 1 },
    entries: [],
  } as const)
  const trusted = {
    canonicalWorktreePath: 'C:\\repo',
    canonicalGitDirectory: 'C:\\repo\\.git',
    canonicalCommonGitDirectory: 'C:\\repo\\.git',
    gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
    commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
    comparison: { fileMode: false, symlinks: false, autocrlf: true },
  } as const
  const projectionWithoutFingerprint = {
    observationVersion: 2,
    hostId: HOST_ID,
    displayLocation: 'repo',
    objectFormat: 'sha1',
    head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
    locked: false,
    inheritedChangeEntryCount: 0,
    conversionAmbiguous: false,
    remotes: [],
    automaticMutationEligible: true,
    blockingReasons: [],
    baseline,
  } as const
  const expectedInspection = {
    projection: signedInspection(projectionWithoutFingerprint, trusted),
    trusted,
  } as const
  const binding = {
    id: BINDING_ID,
    revision: 2,
    health: 'active',
    hostId: HOST_ID,
    workspaceId: WorkspaceId('workspace-status'),
    expectedInspection,
    inheritedChangeBaseline: baseline,
  } as const satisfies ActiveHostProjectBinding
  const trackedChange = signedChange({
    path: 'line\nname.txt',
    kind: 'ordinary',
    indexStatus: 'modified',
    worktreeStatus: 'modified',
    submodule: { kind: 'not-submodule' },
    head: { mode: '100644', objectId: '1'.repeat(40) },
    index: { mode: '100644', objectId: '2'.repeat(40) },
    worktreeMode: '100644',
    worktreeEvidence: {
      kind: 'regular', mode: '100644', byteLength: 7, contentDigest: '3'.repeat(64),
    },
    attribution: 'unattributed',
  } as const)
  const untrackedChange = signedChange({
    path: 'untracked.txt',
    kind: 'untracked',
    indexStatus: 'absent',
    worktreeStatus: 'untracked',
    submodule: { kind: 'not-submodule' },
    worktreeMode: '100644',
    worktreeEvidence: {
      kind: 'regular', mode: '100644', byteLength: 3, contentDigest: '4'.repeat(64),
    },
    attribution: 'not-inherited',
  } as const)
  const statusSeed = {
    observationVersion: 1,
    bindingId: BINDING_ID,
    bindingRevision: 2,
    bindingHealth: 'active',
    locked: false,
    objectFormat: 'sha1',
    head: { kind: 'commit', objectId: '1'.repeat(40), symbolicRef: 'refs/heads/main' },
    branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' },
    upstream: {
      ref: 'refs/remotes/origin/main',
      name: 'origin/main',
      divergence: { ahead: 2, behind: 1 },
    },
    index: { kind: 'tree', treeId: '5'.repeat(40) },
    worktree: { version: 1, digest: '6'.repeat(64) },
    changes: [trackedChange, untrackedChange],
    structuredMutation: { available: true, blockers: [] },
  } as const satisfies ProjectGitStatusSeedMaterial
  return {
    baseline,
    binding,
    expectedInspection,
    observation: signedStatus(statusSeed),
    projectionWithoutFingerprint,
    statusSeed,
    trackedChange,
    trusted,
    untrackedChange,
  }
}

function startAgentRunFixture() {
  const { baseline, binding, observation } = boundStatusFixture()
  const dispatchId = 'dispatch-22222222-2222-4222-8222-222222222222'
  const agentRunId = 'agent-run-33333333-3333-4333-8333-333333333333'
  const workSessionId = 'work-session-44444444-4444-4444-8444-444444444444'
  const sessionId = 'session-55555555-5555-4555-8555-555555555555'
  const input = {
    id: MessageId('66666666-6666-4666-8666-666666666666'),
    role: 'user',
    content: [{ type: 'text', text: 'Implement the frozen Work Item definition.' }],
    source: { kind: 'saki-agent-run', dispatchId, agentRunId, workSessionId },
  } as StartAgentRunInputMessage
  const request = {
    type: 'start-agent-run',
    source: {
      kind: 'execution-dispatch',
      dispatchId,
      payloadDigest: computeStartAgentRunPayloadDigest(input),
    },
    expected: {
      binding,
      status: observation.fingerprint,
      head: observation.head,
      index: observation.index,
      worktree: observation.worktree,
      preEffectBaseline: baseline,
    },
    run: {
      agentRunId,
      workSessionId,
      sessionId,
      profile: {
        id: 'agent-profile-77777777-7777-4777-8777-777777777777',
        version: 1,
        agentPresetId: 'standard',
        modelRoute: { provider: 'fake', model: 'fake-model' },
      },
      input,
    },
  } as const
  return {
    request,
    result: {
      type: 'start-agent-run',
      agentRunId,
      workSessionId,
      sessionId,
      inputMessageId: input.id,
    } as const,
  }
}

function diffLineBytes(lines: readonly string[]): number {
  const encoder = new TextEncoder()
  return lines.reduce((bytes, line) => bytes + encoder.encode(line).byteLength + 1, 0)
}

function signedInspection(
  projection: Omit<ProjectSelectionProjection, 'fingerprint'>,
  trusted: Parameters<typeof computeProjectInspectionFingerprint>[1],
): ProjectSelectionProjection {
  return { ...projection, fingerprint: computeProjectInspectionFingerprint(projection, trusted) }
}

function signedEntry<const T extends object>(material: T): T & { readonly digest: string } {
  return { ...material, digest: canonicalDigest('saki/inherited-entry/v1', material) }
}

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

function signedStatus(seed: ProjectGitStatusSeedMaterial): ProjectGitStatusObservation {
  const statusSeedDigest = computeProjectGitStatusSeedDigest(seed)
  const material = {
    ...seed,
    changes: seed.changes.map(change => ({
      id: computeProjectGitChangeId(statusSeedDigest, change),
      ...change,
    })),
  }
  const observed = { ...material, observedAt: 1 }
  return { ...observed, fingerprint: computeProjectGitStatusFingerprint(observed) }
}

function signedChange<const T extends ProjectGitChangeFingerprintMaterial>(material: T) {
  return { ...material, fingerprint: computeProjectGitChangeFingerprint(material) }
}

function retainedChange<const T extends ProjectGitChangeFingerprintMaterial>(material: T) {
  return { id: `git-change-${'f'.repeat(64)}`, ...signedChange(material) }
}
