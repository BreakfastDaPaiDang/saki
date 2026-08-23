/** Strict durable and wire-compatible schemas for Host inspection values. @module @breakfastdapaidang/saki-execution/schemas */

import { z } from 'zod'
import type {
  InheritedChangeBaseline,
  InheritedChangeBaselineEntry,
  InheritedCurrentWorktreeEvidence,
  InspectProjectSelectionResult,
  ProjectInspectionFingerprint,
  ProjectSelectionInspection,
  ProjectSelectionProjection,
  SafeGitRemoteObservation,
} from './types.ts'
import { canonicalDigest } from './canonical.ts'
import { computeProjectInspectionFingerprint } from './fingerprint.ts'

const digest = z.string().regex(/^[0-9a-f]{64}$/)

/**
 * Test one value against the closed nonzero Git object-id vocabulary.
 * @param value - candidate lower-case hexadecimal object id.
 * @param objectFormat - optional repository object format that fixes the required width.
 * @returns whether the value is a nonzero SHA-1 or SHA-256 Git object id of the requested format.
 */
export function isGitObjectId(value: string, objectFormat?: 'sha1' | 'sha256'): boolean {
  const expectedWidth = objectFormat === undefined ? undefined : objectFormat === 'sha1' ? 40 : 64
  return (expectedWidth === undefined ? value.length === 40 || value.length === 64 : value.length === expectedWidth)
    && /^[0-9a-f]+$/u.test(value)
    && !/^0+$/u.test(value)
}

const gitObject = z.string().refine(value => isGitObjectId(value))
const gitMode = z.enum(['000000', '100644', '100755', '120000', '160000'])
const hostId = z.string().regex(/^host-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const nonnegative = z.number().int().nonnegative()
const positive = z.number().int().positive()

/** Maximum browser-safe display label length. */
export const MAX_DISPLAY_LOCATION_CHARS = 512
/** Maximum projected Git ref length. */
export const MAX_GIT_REF_CHARS = 4_096
/** Maximum normalized remote coordinate length. */
export const MAX_REMOTE_COORDINATE_CHARS = 4_096
/** Maximum number of safe remote observations. */
export const MAX_SAFE_REMOTES = 256
/** Maximum trusted Host path length retained durably. */
export const MAX_TRUSTED_PATH_CHARS = 32_768
/** Fixed protocol ceiling for retained baseline entries. */
export const MAX_INHERITED_BASELINE_ENTRIES = 10_000
/** Fixed protocol ceiling for complete repository inventory membership. */
export const MAX_INVENTORY_ENTRIES = 100_000

const unsafeDisplayCodePoint = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Applied baseline capture bounds. */
export const inheritedChangeBaselineBoundsSchema = z.object({
  maxEntries: positive.max(MAX_INHERITED_BASELINE_ENTRIES),
  maxPathBytes: positive,
  maxGitOutputBytes: positive,
  maxFileBytes: positive,
  maxTotalFileBytes: positive,
  maxCaptureMs: positive,
}).strict()

/** Observed capture resource totals. */
export const inheritedChangeBaselineObservedLimitsSchema = z.object({
  entries: nonnegative.max(MAX_INVENTORY_ENTRIES),
  pathBytes: nonnegative,
  gitOutputBytes: nonnegative,
  hashedBytes: nonnegative,
  elapsedMs: nonnegative,
}).strict()

const regularWorktreeEvidenceSchema = z.object({
  kind: z.literal('regular'),
  mode: z.enum(['100644', '100755']),
  byteLength: nonnegative,
  contentDigest: digest,
}).strict()
const symlinkWorktreeEvidenceSchema = z.object({ kind: z.literal('symlink'), targetDigest: digest }).strict()
const submoduleWorktreeEvidenceSchema = z.object({ kind: z.literal('submodule'), objectId: gitObject }).strict()
const missingWorktreeEvidenceSchema = z.object({ kind: z.literal('missing') }).strict()

/** One closed current-worktree evidence variant. */
export const inheritedCurrentWorktreeEvidenceSchema: z.ZodType<InheritedCurrentWorktreeEvidence> = z.discriminatedUnion('kind', [
  regularWorktreeEvidenceSchema,
  symlinkWorktreeEvidenceSchema,
  submoduleWorktreeEvidenceSchema,
  missingWorktreeEvidenceSchema,
])

const gitObjectEvidenceSchema = z.object({
  kind: z.literal('object'),
  mode: gitMode.exclude(['000000']),
  objectId: gitObject,
}).strict()
const gitObjectSlotSchema = z.discriminatedUnion('kind', [gitObjectEvidenceSchema, missingWorktreeEvidenceSchema])

const baselineEntryBase = {
  formatVersion: z.literal(1),
  pathDigest: digest,
  digest,
} as const

const structuralBaselineEntrySchema = z.discriminatedUnion('statusKind', [
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('tracked'),
    head: gitObjectSlotSchema,
    index: gitObjectSlotSchema,
    worktree: inheritedCurrentWorktreeEvidenceSchema,
  }).strict().refine(value => value.head.kind === 'object' || value.index.kind === 'object'),
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('untracked'),
    worktree: z.discriminatedUnion('kind', [regularWorktreeEvidenceSchema, symlinkWorktreeEvidenceSchema]),
  }).strict(),
  z.object({
    ...baselineEntryBase,
    statusKind: z.literal('unmerged'),
    head: gitObjectSlotSchema,
    stages: z.tuple([gitObjectSlotSchema, gitObjectSlotSchema, gitObjectSlotSchema]),
    worktree: inheritedCurrentWorktreeEvidenceSchema,
  }).strict().refine(value => value.stages.some(stage => stage.kind === 'object')),
])

/** One exact-path-digest baseline entry. */
export const inheritedChangeBaselineEntrySchema: z.ZodType<InheritedChangeBaselineEntry> =
  structuralBaselineEntrySchema.superRefine((value, context) => {
    if (value.statusKind !== 'untracked' && value.worktree.kind === 'submodule') {
      const slots = value.statusKind === 'tracked'
        ? [value.head, value.index]
        : [value.head, ...value.stages]
      if (!slots.some(slot => slot.kind === 'object' && slot.mode === '160000')) {
        context.addIssue({ code: 'custom', message: 'submodule worktree evidence lacks a gitlink slot' })
      }
    }
    const { digest: actual, ...material } = value
    if (canonicalDigest('saki/inherited-entry/v1', material) !== actual) {
      context.addIssue({ code: 'custom', message: 'baseline entry digest disagrees with retained evidence' })
    }
  })

const completeInheritedChangeBaselineSchema = z.object({
  kind: z.literal('complete'),
  formatVersion: z.literal(1),
  capturedAt: nonnegative,
  bounds: inheritedChangeBaselineBoundsSchema,
  observed: inheritedChangeBaselineObservedLimitsSchema,
  entries: z.array(inheritedChangeBaselineEntrySchema).max(MAX_INHERITED_BASELINE_ENTRIES),
  digest,
}).strict().superRefine((value, context) => {
  const withinBounds = value.observed.entries === value.entries.length
      && value.observed.entries <= value.bounds.maxEntries
      && value.observed.pathBytes <= value.bounds.maxPathBytes
      && value.observed.gitOutputBytes <= value.bounds.maxGitOutputBytes
      && value.observed.hashedBytes <= value.bounds.maxTotalFileBytes
      && value.observed.elapsedMs <= value.bounds.maxCaptureMs
  if (!withinBounds) context.addIssue({ code: 'custom', message: 'baseline observations exceed applied bounds' })
  const pathDigests = new Set(value.entries.map(entry => entry.pathDigest))
  if (pathDigests.size !== value.entries.length) {
    context.addIssue({ code: 'custom', message: 'baseline contains duplicate path identity' })
  }
  const regularBytes = value.entries.reduce((total, entry) => total
      + (entry.worktree.kind === 'regular' ? entry.worktree.byteLength : 0), 0)
  if (value.entries.some(entry => entry.worktree.kind === 'regular'
      && entry.worktree.byteLength > value.bounds.maxFileBytes)
      || regularBytes > value.observed.hashedBytes) {
    context.addIssue({ code: 'custom', message: 'baseline retained bytes disagree with observations' })
  }
  const objectWidths = new Set(value.entries.flatMap((entry) => {
    const slots = entry.statusKind === 'tracked'
      ? [entry.head, entry.index]
      : entry.statusKind === 'unmerged' ? [entry.head, ...entry.stages] : []
    return [
      ...slots.flatMap(slot => slot.kind === 'object' ? [slot.objectId.length] : []),
      ...(entry.worktree.kind === 'submodule' ? [entry.worktree.objectId.length] : []),
    ]
  }))
  if (objectWidths.size > 1) {
    context.addIssue({ code: 'custom', message: 'baseline contains mixed Git object formats' })
  }
  const expectedDigest = canonicalDigest('saki/inherited-baseline/v1', {
    formatVersion: value.formatVersion,
    bounds: value.bounds,
    observed: { ...value.observed, elapsedMs: 0 },
    entries: value.entries,
  })
  if (expectedDigest !== value.digest) {
    context.addIssue({ code: 'custom', message: 'baseline digest disagrees with retained evidence' })
  }
})

/** Entire complete-or-unavailable baseline result. */
export const inheritedChangeBaselineSchema: z.ZodType<InheritedChangeBaseline> = z.discriminatedUnion('kind', [
  completeInheritedChangeBaselineSchema,
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'entry-limit', 'path-limit', 'git-output-limit', 'file-limit', 'hash-limit', 'time-limit',
      'invalid-utf8', 'duplicate-path', 'unsupported-state', 'unstable-content', 'io-failure',
    ]),
    observed: inheritedChangeBaselineObservedLimitsSchema,
  }).strict(),
])

/** Versioned inspection digest. */
export const projectInspectionFingerprintSchema: z.ZodType<ProjectInspectionFingerprint> = z.object({
  version: z.literal(1),
  digest,
}).strict()

/** One safe, normalized remote observation. */
export const safeGitRemoteObservationSchema = z.object({
  transport: z.enum(['https', 'ssh', 'file', 'other']),
  coordinate: z.string().min(1).max(MAX_REMOTE_COORDINATE_CHARS).optional(),
}).strict().superRefine((value, context) => {
  if (value.coordinate !== undefined
    && (value.transport === 'file' || value.transport === 'other'
      || !isNormalizedRemoteCoordinate(value.coordinate))) {
    context.addIssue({ code: 'custom', message: 'remote coordinate is not normalized' })
  }
})

/** Browser-safe inspection Projection. */
// Zod optional outputs include explicit `undefined`; JSON omits that value and
// the public interface intentionally models absence only.
export const projectSelectionProjectionSchema = z.object({
  observationVersion: z.literal(1),
  hostId: hostId.transform(value => value as ProjectSelectionProjection['hostId']),
  displayLocation: z.string().min(1).max(MAX_DISPLAY_LOCATION_CHARS).refine(isSafeDisplayLocation),
  objectFormat: z.enum(['sha1', 'sha256']),
  head: gitObject,
  branch: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitBranchName).optional(),
  detached: z.boolean(),
  upstream: z.string().min(1).max(MAX_GIT_REF_CHARS).refine(isSafeGitRef).optional(),
  locked: z.boolean(),
  inheritedChangeEntryCount: nonnegative.max(MAX_INVENTORY_ENTRIES),
  conversionAmbiguous: z.boolean(),
  remotes: z.array(safeGitRemoteObservationSchema).max(MAX_SAFE_REMOTES),
  githubRepositoryCandidates: z.array(z.string().min(1).max(MAX_REMOTE_COORDINATE_CHARS))
    .max(MAX_SAFE_REMOTES).optional(),
  workspaceId: z.string().transform(value => value as NonNullable<ProjectSelectionProjection['workspaceId']>).optional(),
  automaticMutationEligible: z.boolean(),
  blockingReasons: z.array(z.enum(['dirty', 'baseline-unavailable', 'conversion-ambiguous', 'locked'])).max(4),
  fingerprint: projectInspectionFingerprintSchema,
  baseline: inheritedChangeBaselineSchema,
}).strict().superRefine((value, context) => {
  const expectedObjectLength = value.objectFormat === 'sha1' ? 40 : 64
  if (value.head.length !== expectedObjectLength) {
    context.addIssue({ code: 'custom', message: 'HEAD does not match object format', path: ['head'] })
  }
  if (value.detached === (value.branch !== undefined)) {
    context.addIssue({ code: 'custom', message: 'branch and detached state disagree', path: ['branch'] })
  }
  if (value.upstream !== undefined && (value.detached || value.branch === undefined)) {
    context.addIssue({ code: 'custom', message: 'upstream requires an attached branch', path: ['upstream'] })
  }
  const expectedReasons = [
    ...(value.inheritedChangeEntryCount > 0 ? ['dirty' as const] : []),
    ...(value.baseline.kind === 'unavailable' ? ['baseline-unavailable' as const] : []),
    ...(value.conversionAmbiguous ? ['conversion-ambiguous' as const] : []),
    ...(value.locked ? ['locked' as const] : []),
  ]
  if (value.automaticMutationEligible !== (expectedReasons.length === 0)
    || expectedReasons.length !== value.blockingReasons.length
    || expectedReasons.some((reason, index) => value.blockingReasons[index] !== reason)) {
    context.addIssue({ code: 'custom', message: 'automatic mutation eligibility disagrees with blocking evidence' })
  }
  if (value.inheritedChangeEntryCount !== value.baseline.observed.entries) {
    context.addIssue({ code: 'custom', message: 'inherited-change count disagrees with baseline observations' })
  }
  if (value.baseline.kind === 'complete') {
    for (const [index, entry] of value.baseline.entries.entries()) {
      const slots = entry.statusKind === 'tracked'
        ? [entry.head, entry.index]
        : entry.statusKind === 'unmerged' ? [entry.head, ...entry.stages] : []
      const objects = [
        ...slots.flatMap(slot => slot.kind === 'object' ? [slot.objectId] : []),
        ...(entry.worktree.kind === 'submodule' ? [entry.worktree.objectId] : []),
      ]
      if (objects.some(object => object.length !== expectedObjectLength)) {
        context.addIssue({ code: 'custom', message: 'baseline object does not match object format', path: ['baseline', 'entries', index] })
      }
    }
  }
  const remoteKeys = value.remotes.map(safeGitRemoteObservationKey)
  if (new Set(remoteKeys).size !== remoteKeys.length
    || value.remotes.some((remote, index) => {
      const previous = value.remotes.at(index - 1)
      return index > 0 && previous !== undefined && compareSafeGitRemoteObservations(previous, remote) > 0
    })) {
    context.addIssue({ code: 'custom', message: 'remote observations are not unique and canonical' })
  }
  const expectedCandidates = deriveGitHubRepositoryCandidates(value.remotes)
  const candidates = value.githubRepositoryCandidates
  if (expectedCandidates.length === 0
    ? candidates !== undefined
    : candidates === undefined
      || candidates.length !== expectedCandidates.length
      || candidates.some((candidate, index) => candidate !== expectedCandidates[index])) {
    context.addIssue({ code: 'custom', message: 'GitHub repository candidates disagree with remote observations' })
  }
}) as unknown as z.ZodType<ProjectSelectionProjection>

/** Trusted path observation retained outside browser JSON. */
export const trustedProjectSelectionObservationSchema = z.object({
  canonicalWorktreePath: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  canonicalGitDirectory: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  canonicalCommonGitDirectory: z.string().min(1).max(MAX_TRUSTED_PATH_CHARS).refine(isAbsoluteHostPath),
  gitDirectoryIdentity: z.object({ version: z.literal(1), digest }).strict(),
  commonGitDirectoryIdentity: z.object({ version: z.literal(1), digest }).strict(),
  comparison: z.object({
    fileMode: z.boolean(),
    symlinks: z.boolean(),
    autocrlf: z.boolean(),
  }).strict(),
}).strict()

/** Complete in-process inspection value. */
export const projectSelectionInspectionSchema: z.ZodType<ProjectSelectionInspection> = z.object({
  projection: projectSelectionProjectionSchema,
  trusted: trustedProjectSelectionObservationSchema,
}).strict().superRefine((value, context) => {
  const expected = computeProjectInspectionFingerprint(value.projection, value.trusted)
  if (expected.digest !== value.projection.fingerprint.digest) {
    context.addIssue({
      code: 'custom',
      message: 'inspection fingerprint disagrees with retained evidence',
      path: ['projection', 'fingerprint'],
    })
  }
})

/** Closed Host inspection result. */
export const inspectProjectSelectionResultSchema: z.ZodType<InspectProjectSelectionResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), inspection: projectSelectionInspectionSchema }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum([
    'missing', 'not-directory', 'not-git', 'bare', 'prunable', 'ambiguous', 'malformed', 'unavailable',
  ]) }).strict(),
])

/**
 * Test whether a remote coordinate is the canonical credential-free form.
 * @param value - candidate `authority/repository-path` string.
 * @returns whether the value satisfies the closed normalized grammar.
 */
export function isNormalizedRemoteCoordinate(value: string): boolean {
  if (value.length === 0 || value.length > MAX_REMOTE_COORDINATE_CHARS
    || /[\s\\@?#]/u.test(value)) return false
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return false
  const authority = value.slice(0, slash)
  const path = value.slice(slash + 1)
  if (!normalizedAuthority(authority) || path.endsWith('.git')) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && /^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-F]{2})+$/u.test(segment))
}

/**
 * Test the cross-platform structural forms admitted for a trusted absolute Host path.
 * Same-Host canonical identity and realpath checks remain execution-provider observations.
 * @param value - candidate POSIX, Windows drive, or Windows UNC absolute path.
 * @returns whether the value is absolute, NUL-free, and free of noncanonical path segments.
 */
export function isAbsoluteHostPath(value: string): boolean {
  if (value === '' || value.includes('\0')) return false
  if (value.startsWith('/')) {
    if (value === '/') return true
    return value.slice(1).split('/').every(component => component !== '' && component !== '.' && component !== '..')
  }
  if (/^[A-Za-z]:\\/u.test(value)) {
    if (value.includes('/')) return false
    const tail = value.slice(3)
    return tail === '' || tail.split('\\').every(component => component !== '' && component !== '.' && component !== '..')
  }
  if (value.startsWith('\\\\') && !value.includes('/')) {
    const shareRootWithSeparator = value.endsWith('\\')
    const components = value.slice(2, shareRootWithSeparator ? -1 : undefined).split('\\')
    return components.length >= 2
      && (!shareRootWithSeparator || components.length === 2)
      && components[0] !== '?'
      && components.every(component => component !== '' && component !== '.' && component !== '..')
  }
  return false
}

/**
 * Produce the unique canonical tuple key for one safe remote observation.
 * @param value - structurally valid credential-free remote observation.
 * @returns transport and optional coordinate framed without ambiguity.
 */
export function safeGitRemoteObservationKey(value: {
  readonly transport: SafeGitRemoteObservation['transport']
  readonly coordinate?: string | undefined
}): string {
  return `${value.transport}\0${value.coordinate === undefined ? '0' : `1${value.coordinate}`}`
}

/**
 * Derive canonical public-GitHub repository candidates from safe remotes.
 * @param remotes - unique sanitized remote observations from one worktree.
 * @returns sorted unique lowercase `github.com/owner/repository` coordinates.
 */
export function deriveGitHubRepositoryCandidates(
  remotes: readonly {
    readonly transport: SafeGitRemoteObservation['transport']
    readonly coordinate?: string | undefined
  }[],
): string[] {
  const candidates = new Set<string>()
  for (const remote of remotes) {
    if ((remote.transport !== 'https' && remote.transport !== 'ssh') || remote.coordinate === undefined) continue
    const match = /^(?:github\.com(?::[1-9][0-9]{0,4})?|ssh\.github\.com:443)\/([^/]+)\/([^/]+)$/u
      .exec(remote.coordinate)
    if (match === null) continue
    if (remote.transport !== 'ssh' && remote.coordinate.startsWith('ssh.github.com:')) continue
    const candidate = `github.com/${match[1]}/${match[2]}`.toLowerCase()
    if (isNormalizedRemoteCoordinate(candidate)) candidates.add(candidate)
  }
  return [...candidates].sort()
}

/**
 * Compare safe remote observations by their protocol-owned canonical tuple.
 * @param left - first remote observation.
 * @param right - second remote observation.
 * @returns negative, zero, or positive deterministic ordering result.
 */
export function compareSafeGitRemoteObservations(
  left: { readonly transport: SafeGitRemoteObservation['transport']; readonly coordinate?: string | undefined },
  right: { readonly transport: SafeGitRemoteObservation['transport']; readonly coordinate?: string | undefined },
): number {
  const leftKey = safeGitRemoteObservationKey(left)
  const rightKey = safeGitRemoteObservationKey(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/**
 * Test whether a repository label is safe for direct browser display.
 * @param value - candidate non-authoritative display label.
 * @returns whether the label excludes control and formatting code points.
 */
export function isSafeDisplayLocation(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_DISPLAY_LOCATION_CHARS
    && !unsafeDisplayCodePoint.test(value)
    && !/[\\/:]/u.test(value)
    && value !== '.'
    && value !== '..'
}

/**
 * Test whether a short local branch name satisfies Git ref and display rules.
 * @param value - candidate branch name without the `refs/heads/` prefix.
 * @returns whether the value is a safe one-level-or-deeper branch name.
 */
export function isSafeGitBranchName(value: string): boolean {
  return value.length <= MAX_GIT_REF_CHARS - 'refs/heads/'.length
    && !value.startsWith('-')
    && validGitRefName(value)
}

/**
 * Test whether a full Git ref satisfies the closed projected ref grammar.
 * @param value - candidate full ref such as `refs/remotes/origin/main`.
 * @returns whether the value is a safe canonical full ref.
 */
export function isSafeGitRef(value: string): boolean {
  return value.startsWith('refs/') && value.slice('refs/'.length).includes('/')
    && validGitRefName(value)
}

function validGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > MAX_GIT_REF_CHARS
    || unsafeDisplayCodePoint.test(value)
    || /[\u0000-\u0020\u007f~^:?*\\]/u.test(value)
    || value.includes('[')
    || value === '@'
    || value.includes('..')
    || value.includes('@{')
    || value.startsWith('/')
    || value.endsWith('/')
    || value.endsWith('.')
    || value.includes('//')) return false
  return value.split('/').every(component => component.length > 0
    && !component.startsWith('.')
    && !component.endsWith('.lock'))
}

function normalizedAuthority(authority: string): boolean {
  if (authority.startsWith('[')) {
    if (!/^\[[0-9a-f:.]+\](?::[1-9][0-9]{0,4})?$/u.test(authority)) return false
    try {
      const url = new URL(`https://${authority}/`)
      return url.host === authority && validPort(url.port)
    } catch {
      return false
    }
  }
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/u.exec(authority)
  if (match === null || !validPort(match[2] ?? '')) return false
  const host = match[1]
  return host !== undefined
    && host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))
}

function validPort(port: string): boolean {
  return port === '' || (String(Number(port)) === port && Number(port) >= 1 && Number(port) <= 65_535)
}
