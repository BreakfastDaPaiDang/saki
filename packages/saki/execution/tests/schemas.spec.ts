import { Context } from '@deepseek-ai/cordis'
import Invariants from '@deepseek-ai/dsh-invariants'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '../src/canonical.ts'
import {
  computeProjectInspectionFingerprint,
  inheritedChangeBaselineIdentityMaterial,
  projectInspectionFingerprintMaterial,
  projectInspectionWorkspaceIndependentMaterial,
} from '../src/fingerprint.ts'
import { SakiHostExecution } from '../src/index.ts'
import {
  compareSafeGitRemoteObservations,
  deriveGitHubRepositoryCandidates,
  inheritedChangeBaselineEntrySchema,
  inheritedChangeBaselineSchema,
  isGitObjectId,
  isAbsoluteHostPath,
  isNormalizedRemoteCoordinate,
  isSafeDisplayLocation,
  isSafeGitBranchName,
  isSafeGitRef,
  MAX_DISPLAY_LOCATION_CHARS,
  MAX_GIT_REF_CHARS,
  MAX_INVENTORY_ENTRIES,
  MAX_REMOTE_COORDINATE_CHARS,
  MAX_SAFE_REMOTES,
  projectSelectionProjectionSchema,
  projectSelectionInspectionSchema,
  safeGitRemoteObservationSchema,
  safeGitRemoteObservationKey,
} from '../src/schemas.ts'
import type { ProjectSelectionProjection, SakiHostId } from '../src/types.ts'

const OBSERVED = { entries: 1, pathBytes: 2, gitOutputBytes: 3, hashedBytes: 4, elapsedMs: 5 }
const HOST_ID = 'host-11111111-1111-4111-8111-111111111111' as SakiHostId

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
      observationVersion: 1,
      hostId: HOST_ID,
      displayLocation: 'repo',
      objectFormat: 'sha1',
      head: '1'.repeat(40),
      branch: 'main',
      detached: false,
      locked: false,
      inheritedChangeEntryCount: 0,
      conversionAmbiguous: false,
      remotes: [],
      automaticMutationEligible: true,
      blockingReasons: [],
      fingerprint: { version: 1, digest: '2'.repeat(64) },
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
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, head: '0'.repeat(40) }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, objectFormat: 'sha256', head: '0'.repeat(64),
    }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, head: '1'.repeat(64) }).success).toBe(false)
    expect(isSafeGitBranchName('a'.repeat(MAX_GIT_REF_CHARS - 'refs/heads/'.length))).toBe(true)
    expect(isSafeGitBranchName('a'.repeat(MAX_GIT_REF_CHARS - 'refs/heads/'.length + 1))).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({ ...projection, detached: true }).success).toBe(false)
    expect(projectSelectionProjectionSchema.safeParse({
      ...projection, branch: undefined, detached: true, upstream: 'refs/remotes/origin/main',
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
      ...projection, branch: 'x'.repeat(MAX_GIT_REF_CHARS + 1),
    }).success).toBe(false)
    for (const displayLocation of [
      'repo\nsecret', 'repo\u001b[31m', 'safe\u202ereversed', '/secret/repo', 'C:\\secret\\repo', '..',
    ]) {
      expect(projectSelectionProjectionSchema.safeParse({ ...projection, displayLocation }).success).toBe(false)
      expect(isSafeDisplayLocation(displayLocation)).toBe(false)
    }
    for (const branch of ['-option', 'bad..name', 'bad@{name', 'bad\nname', 'safe\u202ename']) {
      expect(projectSelectionProjectionSchema.safeParse({ ...projection, branch }).success).toBe(false)
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
      projection: { ...inspection.projection, head: '3'.repeat(40) },
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
    const { branch: _branch, ...withoutBranch } = projection
    expect(projectInspectionFingerprintMaterial(
      { ...withoutBranch, detached: true },
      trusted,
    )).not.toHaveProperty('branch')
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
    }
    const ctx = new Context()
    const execution = new TestExecution(ctx)

    await expect(execution.inspectProjectSelection()).resolves.toEqual({ ok: false, reason: 'unavailable' })
    await ctx.fiber.dispose()
  })
})

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
