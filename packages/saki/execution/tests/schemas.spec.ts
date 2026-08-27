import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '../src/canonical.ts'
import {
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
  commitHostOperationResultSchema,
  hostOperationPreparationSchema,
  hostOperationRequestSchema,
  hostOperationSnapshotSchema,
  hostOperationStartResultSchema,
  MAX_PROJECT_GIT_DIFF_CURSOR_CHARS,
  MAX_PROJECT_GIT_DIFF_LINE_UTF8_BYTES,
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
  projectGitDiffCursorSchema,
  projectGitDiffPageSchema,
  readProjectDiffOperationRequestSchema,
  readProjectDiffRequestSchema,
  readProjectDiffResultSchema,
  projectSelectionProjectionSchema,
  projectSelectionInspectionSchema,
  safeGitRemoteObservationSchema,
  safeGitRemoteObservationKey,
} from '../src/schemas.ts'
import type {
  ActiveHostProjectBinding,
  ProjectGitChangeId,
  ProjectGitDiffCursor,
  ProjectGitStatusObservation,
  ProjectSelectionProjection,
  SakiHostId,
  SakiResourceBindingId,
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
    expect(inspectProjectResultSchema.safeParse({ ok: true, observation }).success).toBe(false)
    expect(projectGitStatusFingerprintMaterial(observation)).toEqual(observationFingerprintMaterial)
    expect(isRepositoryRelativeGitPath('line\nname.txt')).toBe(true)
    expect(compareRepositoryRelativeGitPaths('\ue000', '\u{10000}')).toBeLessThan(0)
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

  it('keeps Host Operation requests path-free and durable lifecycle evidence closed', () => {
    const { baseline, binding, observation } = boundStatusFixture()
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
    expect(commitHostOperationResultSchema.safeParse({ ...commitResult, treeId: 'b'.repeat(64) }).success).toBe(false)
    expect(commitHostOperationResultSchema.safeParse({ ...commitResult, postObservation: observation }).success).toBe(false)
    expect(commitHostOperationResultSchema.safeParse({
      ...commitResult,
      target: { kind: 'symbolic-ref', ref: 'refs/remotes/origin/main' },
    }).success).toBe(false)
  })

  it('registers the stateless package invariant companion', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(Invariants)

    expect(ctx.invariants).toBeDefined()
    await fiber.dispose()
  })

  it('constructs a Host Execution provider through the service seam', async () => {
    class TestExecution extends SakiHostExecution {
      async inspectProjectSelection(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async inspectProject(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async readDiff(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async prepareOperation(): Promise<{ readonly ok: false; readonly reason: 'unavailable' }> {
        return { ok: false, reason: 'unavailable' }
      }

      async startOperation(): Promise<never> { throw new Error('unavailable') }
      async inspectOperation(): Promise<never> { throw new Error('unavailable') }
      async cancelOperation(): Promise<never> { throw new Error('unavailable') }
      onChanged(): () => void { return () => undefined }
    }
    const ctx = new Context()
    const execution = new TestExecution(ctx)

    await expect(execution.inspectProjectSelection()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.inspectProject()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.readDiff()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await expect(execution.prepareOperation()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await ctx.fiber.dispose()
  })
})

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
