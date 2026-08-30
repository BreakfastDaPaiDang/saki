/** Closed runtime leaves for the exact Saki control-plane v4 migration source. */

import { z } from 'zod'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  GitHubAccountId,
  GitHubAppId,
  GitHubInstallationId,
  GitHubIssueId,
  GitHubProjectFieldId,
  GitHubProjectId,
  GitHubProjectItemId,
  GitHubProjectOptionId,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiBootstrapChallengeId,
  SakiBuildId,
  SakiBrowserSessionId,
  SakiControlIntentId,
  SakiDevelopmentProjectId,
  SakiGitHubScanAttemptId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiIntentReceiptId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiStorageGenerationId,
} from './types.ts'
import { v4CanonicalDigest } from './migration-v4-canonical.ts'

/* Historical source validation intentionally duplicates the v4 producer grammar. */
/* jscpd:ignore-start */
const V4_CONTROL_STATE_KEY = 'control-state' as const
const V4_DEVELOPMENT_PROJECT_REGISTRY_KEY = 'development-project-registry' as const
const V4_STORAGE_GENERATION_KEY = 'storage-generation' as const
const V4_MAX_DISPLAY_LOCATION_CHARS = 512
const V4_MAX_GIT_REF_CHARS = 4_096
const V4_MAX_REMOTE_COORDINATE_CHARS = 4_096
const V4_MAX_SAFE_REMOTES = 256
const V4_MAX_TRUSTED_PATH_CHARS = 32_768
const V4_MAX_INHERITED_BASELINE_ENTRIES = 10_000
const V4_MAX_INVENTORY_ENTRIES = 100_000
const V4_SAKI_BOARD_WORK_ITEM_LIMIT = 10_000
const V4_SAKI_GITHUB_MAPPING_ISSUE_LIMIT = 10_007
const V4_SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT = 200_000

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CHILD_ORDINAL_PATTERN = '(?:0|[1-9][0-9]*)'

const brandedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-${UUID_PATTERN}$`))
  .transform(value => value as T)
const accessChildId = <T extends string>(kind: 'challenge' | 'session') => z.string()
  .regex(new RegExp(`^access-${UUID_PATTERN}:${kind}:${CHILD_ORDINAL_PATTERN}$`))
  .transform(value => value as T)
const digestId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-[0-9a-f]{64}$`))
  .transform(value => value as T)

const v4InstallationIdSchema = brandedId<SakiInstallationId>('installation')
const v4StorageGenerationIdSchema = brandedId<SakiStorageGenerationId>('storage-generation')
const v4HostIdSchema = brandedId<SakiHostId>('host')
const v4PrincipalIdSchema = brandedId<SakiPrincipalId>('principal')
const v4GrantIdSchema = brandedId<SakiGrantId>('grant')
const v4InstallationAccessIdSchema = brandedId<SakiInstallationAccessId>('access')
const v4BootstrapChallengeIdSchema = accessChildId<SakiBootstrapChallengeId>('challenge')
const v4BrowserSessionIdSchema = accessChildId<SakiBrowserSessionId>('session')
const v4DevelopmentProjectIdSchema = brandedId<SakiDevelopmentProjectId>('project')
const v4ResourceBindingIdSchema = brandedId<SakiResourceBindingId>('binding')
const v4ControlIntentIdSchema = brandedId<SakiControlIntentId>('intent')
const v4IntentReceiptIdSchema = brandedId<SakiIntentReceiptId>('receipt')
const v4BoardWorkItemIdSchema = digestId<SakiBoardWorkItemId>('work-item')
const v4GitHubScanAttemptIdSchema = brandedId<SakiGitHubScanAttemptId>('scan-attempt')
const v4BoardRemoteFingerprintSchema = digestId<SakiBoardRemoteFingerprint>('remote-fingerprint')
const v4WorkspaceIdSchema = z.string().transform(value => value as WorkspaceId)
const v4BuildIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
  .transform(value => value as SakiBuildId)

const githubNodeId = <T extends string>() => z.string().min(1).max(1_024)
  .regex(/^[^\u0000-\u001f\u007f]+$/u)
  .transform(value => value as T)
const githubPositiveDecimalId = <T extends string>() => z.string()
  .regex(/^[1-9][0-9]*$/u)
  .max(40)
  .transform(value => value as T)

const v4GitHubAppIdSchema = githubPositiveDecimalId<GitHubAppId>()
const v4GitHubInstallationIdSchema = githubPositiveDecimalId<GitHubInstallationId>()
const v4GitHubAccountIdSchema = githubNodeId<GitHubAccountId>()
const v4GitHubRepositoryIdSchema = githubNodeId<GitHubRepositoryId>()
const v4GitHubRepositoryDatabaseIdSchema = githubPositiveDecimalId<GitHubRepositoryDatabaseId>()
const v4GitHubProjectIdSchema = githubNodeId<GitHubProjectId>()
const v4GitHubProjectFieldIdSchema = githubNodeId<GitHubProjectFieldId>()
const v4GitHubProjectOptionIdSchema = githubNodeId<GitHubProjectOptionId>()
const v4GitHubProjectItemIdSchema = githubNodeId<GitHubProjectItemId>()
const v4GitHubIssueIdSchema = githubNodeId<GitHubIssueId>()

const nonnegative = z.number().int().nonnegative()
const positive = z.number().int().positive()
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const v4RevisionSchema = nonnegative
const v4TimestampSchema = nonnegative
const v4DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u)

const unsafeDisplayCodePoint = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

function isGitObjectId(value: string): boolean {
  return (value.length === 40 || value.length === 64)
    && /^[0-9a-f]+$/u.test(value)
    && !/^0+$/u.test(value)
}

const gitObject = z.string().refine(isGitObjectId)
const gitMode = z.enum(['000000', '100644', '100755', '120000', '160000'])
const baselineBoundsSchema = z.object({
  maxEntries: positive.max(V4_MAX_INHERITED_BASELINE_ENTRIES),
  maxPathBytes: positive,
  maxGitOutputBytes: positive,
  maxFileBytes: positive,
  maxTotalFileBytes: positive,
  maxCaptureMs: positive,
}).strict()
const baselineObservedSchema = z.object({
  entries: nonnegative.max(V4_MAX_INVENTORY_ENTRIES),
  pathBytes: nonnegative,
  gitOutputBytes: nonnegative,
  hashedBytes: nonnegative,
  elapsedMs: nonnegative,
}).strict()
const regularWorktreeEvidenceSchema = z.object({
  kind: z.literal('regular'),
  mode: z.enum(['100644', '100755']),
  byteLength: nonnegative,
  contentDigest: v4DigestSchema,
}).strict()
const symlinkWorktreeEvidenceSchema = z.object({
  kind: z.literal('symlink'),
  targetDigest: v4DigestSchema,
}).strict()
const submoduleWorktreeEvidenceSchema = z.object({ kind: z.literal('submodule'), objectId: gitObject }).strict()
const missingWorktreeEvidenceSchema = z.object({ kind: z.literal('missing') }).strict()
const inheritedCurrentWorktreeEvidenceSchema = z.discriminatedUnion('kind', [
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
  pathDigest: v4DigestSchema,
  digest: v4DigestSchema,
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
const baselineEntrySchema = structuralBaselineEntrySchema.superRefine((value, context) => {
  if (value.statusKind !== 'untracked' && value.worktree.kind === 'submodule') {
    const slots = value.statusKind === 'tracked' ? [value.head, value.index] : [value.head, ...value.stages]
    if (!slots.some(slot => slot.kind === 'object' && slot.mode === '160000')) {
      context.addIssue({ code: 'custom', message: 'submodule worktree evidence lacks a gitlink slot' })
    }
  }
  const { digest: actual, ...material } = value
  if (v4CanonicalDigest('saki/inherited-entry/v1', material) !== actual) {
    context.addIssue({ code: 'custom', message: 'baseline entry digest disagrees with retained evidence' })
  }
})
const completeBaselineSchema = z.object({
  kind: z.literal('complete'),
  formatVersion: z.literal(1),
  capturedAt: nonnegative,
  bounds: baselineBoundsSchema,
  observed: baselineObservedSchema,
  entries: z.array(baselineEntrySchema).max(V4_MAX_INHERITED_BASELINE_ENTRIES),
  digest: v4DigestSchema,
}).strict().superRefine((value, context) => {
  const withinBounds = value.observed.entries === value.entries.length
    && value.observed.entries <= value.bounds.maxEntries
    && value.observed.pathBytes <= value.bounds.maxPathBytes
    && value.observed.gitOutputBytes <= value.bounds.maxGitOutputBytes
    && value.observed.hashedBytes <= value.bounds.maxTotalFileBytes
    && value.observed.elapsedMs <= value.bounds.maxCaptureMs
  if (!withinBounds) context.addIssue({ code: 'custom', message: 'baseline observations exceed applied bounds' })
  if (new Set(value.entries.map(entry => entry.pathDigest)).size !== value.entries.length) {
    context.addIssue({ code: 'custom', message: 'baseline contains duplicate path identity' })
  }
  const regularBytes = value.entries.reduce((total, entry) => total
    + (entry.worktree.kind === 'regular' ? entry.worktree.byteLength : 0), 0)
  if (value.entries.some(entry => entry.worktree.kind === 'regular'
    && entry.worktree.byteLength > value.bounds.maxFileBytes) || regularBytes > value.observed.hashedBytes) {
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
  if (objectWidths.size > 1) context.addIssue({ code: 'custom', message: 'baseline contains mixed Git object formats' })
  const expectedDigest = v4CanonicalDigest('saki/inherited-baseline/v1', {
    formatVersion: value.formatVersion,
    bounds: value.bounds,
    observed: { ...value.observed, elapsedMs: 0 },
    entries: value.entries,
  })
  if (expectedDigest !== value.digest) {
    context.addIssue({ code: 'custom', message: 'baseline digest disagrees with retained evidence' })
  }
})

const v4InheritedChangeBaselineSchema = z.discriminatedUnion('kind', [
  completeBaselineSchema,
  z.object({
    kind: z.literal('unavailable'),
    reason: z.enum([
      'entry-limit', 'path-limit', 'git-output-limit', 'file-limit', 'hash-limit', 'time-limit',
      'invalid-utf8', 'duplicate-path', 'unsupported-state', 'unstable-content', 'io-failure',
    ]),
    observed: baselineObservedSchema,
  }).strict(),
])

function v4InheritedChangeBaselineIdentityMaterial(
  baseline: z.infer<typeof v4InheritedChangeBaselineSchema>,
) {
  const { elapsedMs: _elapsedMs, ...observed } = baseline.observed
  if (baseline.kind === 'unavailable') return { kind: baseline.kind, reason: baseline.reason, observed }
  return {
    kind: baseline.kind,
    formatVersion: baseline.formatVersion,
    bounds: baseline.bounds,
    observed,
    entries: baseline.entries,
    digest: baseline.digest,
  }
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

function isNormalizedRemoteCoordinate(value: string): boolean {
  if (value.length === 0 || value.length > V4_MAX_REMOTE_COORDINATE_CHARS || /[\s\\@?#]/u.test(value)) return false
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return false
  const authority = value.slice(0, slash)
  const path = value.slice(slash + 1)
  if (!normalizedAuthority(authority) || path.endsWith('.git')) return false
  return path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && /^(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-F]{2})+$/u.test(segment))
}

function v4IsAbsoluteHostPath(value: string): boolean {
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

function v4IsSafeDisplayLocation(value: string): boolean {
  return value.length > 0
    && value.length <= V4_MAX_DISPLAY_LOCATION_CHARS
    && !unsafeDisplayCodePoint.test(value)
    && !/[\\/:]/u.test(value)
    && value !== '.'
    && value !== '..'
}

function validGitRefName(value: string): boolean {
  if (value.length === 0 || value.length > V4_MAX_GIT_REF_CHARS
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

function v4IsSafeGitBranchName(value: string): boolean {
  return value.length <= V4_MAX_GIT_REF_CHARS - 'refs/heads/'.length
    && !value.startsWith('-')
    && validGitRefName(value)
}

function v4IsSafeGitRef(value: string): boolean {
  return value.startsWith('refs/') && value.slice('refs/'.length).includes('/') && validGitRefName(value)
}

const v4SafeGitRemoteObservationSchema = z.object({
  transport: z.enum(['https', 'ssh', 'file', 'other']),
  coordinate: z.string().min(1).max(V4_MAX_REMOTE_COORDINATE_CHARS).optional(),
}).strict().superRefine((value, context) => {
  if (value.coordinate !== undefined
    && (value.transport === 'file' || value.transport === 'other'
      || !isNormalizedRemoteCoordinate(value.coordinate))) {
    context.addIssue({ code: 'custom', message: 'remote coordinate is not normalized' })
  }
})

function v4SafeGitRemoteObservationKey(value: z.infer<typeof v4SafeGitRemoteObservationSchema>): string {
  return `${value.transport}\0${value.coordinate === undefined ? '0' : `1${value.coordinate}`}`
}

function v4DeriveGitHubRepositoryCandidates(
  remotes: readonly z.infer<typeof v4SafeGitRemoteObservationSchema>[],
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

function v4CompareSafeGitRemoteObservations(
  left: z.infer<typeof v4SafeGitRemoteObservationSchema>,
  right: z.infer<typeof v4SafeGitRemoteObservationSchema>,
): number {
  const leftKey = v4SafeGitRemoteObservationKey(left)
  const rightKey = v4SafeGitRemoteObservationKey(right)
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

const v4TrustedProjectSelectionObservationSchema = z.object({
  canonicalWorktreePath: z.string().min(1).max(V4_MAX_TRUSTED_PATH_CHARS).refine(v4IsAbsoluteHostPath),
  canonicalGitDirectory: z.string().min(1).max(V4_MAX_TRUSTED_PATH_CHARS).refine(v4IsAbsoluteHostPath),
  canonicalCommonGitDirectory: z.string().min(1).max(V4_MAX_TRUSTED_PATH_CHARS).refine(v4IsAbsoluteHostPath),
  gitDirectoryIdentity: z.object({ version: z.literal(1), digest: v4DigestSchema }).strict(),
  commonGitDirectoryIdentity: z.object({ version: z.literal(1), digest: v4DigestSchema }).strict(),
  comparison: z.object({
    fileMode: z.boolean(),
    symlinks: z.boolean(),
    autocrlf: z.boolean(),
  }).strict(),
}).strict()

const V4_HOST_OPERATOR_ACTIONS = [
  'inspect-project-selection',
  'project-index:read',
  'development-workspace:read',
  'development-project:register',
  'board:read',
  'project-settings:read',
  'github-synchronization:configure',
] as const

const v4ControlStateRecordSchema = z.object({
  schemaVersion: z.literal(2),
  revision: v4RevisionSchema,
  phase: z.enum(['provisioning', 'ready']),
  installationId: v4InstallationIdSchema,
  initialHostId: v4HostIdSchema,
  hostOperatorPrincipalId: v4PrincipalIdSchema,
  hostOperatorGrantId: v4GrantIdSchema,
  installationAccessId: v4InstallationAccessIdSchema,
}).strict()

const v4InstallationRecordSchema = z.object({
  id: v4InstallationIdSchema,
  revision: v4RevisionSchema,
  state: z.enum(['active', 'retired']),
  currentHostId: v4HostIdSchema,
}).strict()

const v4HostRecordSchema = z.object({
  id: v4HostIdSchema,
  revision: v4RevisionSchema,
  installationId: v4InstallationIdSchema,
  state: z.enum(['enrolled', 'retired']),
}).strict()

const v4PrincipalRecordSchema = z.object({
  id: v4PrincipalIdSchema,
  revision: v4RevisionSchema,
  kind: z.enum(['human', 'automation']),
  displayName: z.string().min(1),
  state: z.enum(['active', 'retired']),
}).strict()

const v4GrantRecordSchema = z.object({
  id: v4GrantIdSchema,
  revision: v4RevisionSchema,
  installationId: v4InstallationIdSchema,
  principalId: v4PrincipalIdSchema,
  state: z.enum(['active', 'revoked']),
  scope: z.object({ kind: z.literal('installation'), installationId: v4InstallationIdSchema }).strict(),
  actions: z.array(z.enum(V4_HOST_OPERATOR_ACTIONS)),
}).strict()

const v4BootstrapChallengeRecordSchema = z.object({
  id: v4BootstrapChallengeIdSchema,
  ordinal: nonnegative,
  revision: v4RevisionSchema,
  purpose: z.enum(['initial-bootstrap', 'local-reauthentication']),
  installationId: v4InstallationIdSchema,
  hostId: v4HostIdSchema,
  principalId: v4PrincipalIdSchema,
  verifierDigest: v4DigestSchema,
  issuedAt: v4TimestampSchema,
  expiresAt: v4TimestampSchema,
  state: z.enum(['issued', 'consumed', 'expired', 'revoked']),
  terminalAt: v4TimestampSchema.optional(),
  browserSessionId: v4BrowserSessionIdSchema.optional(),
  storageGenerationId: v4StorageGenerationIdSchema,
}).strict()

const v4BrowserSessionRecordSchema = z.object({
  id: v4BrowserSessionIdSchema,
  ordinal: nonnegative,
  revision: v4RevisionSchema,
  installationId: v4InstallationIdSchema,
  principalId: v4PrincipalIdSchema,
  cookieDigest: v4DigestSchema,
  createdAt: v4TimestampSchema,
  expiresAt: v4TimestampSchema,
  state: z.enum(['active', 'expired', 'revoked']),
  terminalAt: v4TimestampSchema.optional(),
  storageGenerationId: v4StorageGenerationIdSchema,
}).strict()

const v4BootstrapCompletionRecordSchema = z.object({
  challengeId: v4BootstrapChallengeIdSchema,
  sessionId: v4BrowserSessionIdSchema,
  hostId: v4HostIdSchema,
  principalId: v4PrincipalIdSchema,
  completedAt: v4TimestampSchema,
}).strict()

const v4InstallationAccessRecordSchema = z.object({
  id: v4InstallationAccessIdSchema,
  schemaVersion: z.literal(2),
  revision: v4RevisionSchema,
  installationId: v4InstallationIdSchema,
  nextChallengeOrdinal: nonnegative,
  nextSessionOrdinal: nonnegative,
  bootstrapCompletion: v4BootstrapCompletionRecordSchema.optional(),
  requestTokenDerivation: z.object({
    version: z.literal(1),
    domain: z.literal('saki/browser-request-token'),
  }).strict(),
  challenges: z.array(v4BootstrapChallengeRecordSchema),
  sessions: z.array(v4BrowserSessionRecordSchema),
}).strict()

const v4RegistrationActorSchema = z.object({
  installationId: v4InstallationIdSchema,
  hostId: v4HostIdSchema,
  principalId: v4PrincipalIdSchema,
  principalRevision: v4RevisionSchema,
  grantId: v4GrantIdSchema,
  grantRevision: v4RevisionSchema,
  storageGenerationId: v4StorageGenerationIdSchema,
}).strict()

const githubSafeName = z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f]+$/u)
const githubSafeRequestId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const githubCredentialRefSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
const standardGitHubFailureSchema = z.discriminatedUnion('code', [
  z.object({ code: z.literal('cancelled') }).strict(),
  z.object({ code: z.literal('auth-unavailable'), credentialRef: githubCredentialRefSchema.optional() }).strict(),
  z.object({
    code: z.literal('permission-mismatch'),
    permission: githubSafeName,
    required: z.enum(['none', 'read', 'write', 'admin']),
    observed: z.enum(['none', 'read', 'write', 'admin']).optional(),
    requestId: githubSafeRequestId.optional(),
  }).strict(),
  z.object({ code: z.literal('not-found'), resource: githubSafeName, requestId: githubSafeRequestId.optional() }).strict(),
  z.object({
    code: z.literal('invalid-external-response'),
    operation: githubSafeName,
    requestId: githubSafeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('primary-rate-limit'),
    resetAt: safeInteger.optional(),
    requestId: githubSafeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('secondary-rate-limit'),
    retryAfterMs: safeInteger.optional(),
    requestId: githubSafeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('transient-transport'),
    retryAfterMs: safeInteger.optional(),
    requestId: githubSafeRequestId.optional(),
  }).strict(),
  z.object({
    code: z.literal('permanent-rejection'),
    status: z.number().int().min(100).max(599).optional(),
    requestId: githubSafeRequestId.optional(),
  }).strict(),
])
const mappingMismatchFailureSchema = z.discriminatedUnion('reason', [
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('field-missing-or-not-single-select'),
    statusFieldId: v4GitHubProjectFieldIdSchema,
  }).strict(),
  z.object({
    code: z.literal('mapping-mismatch'),
    reason: z.literal('required-options-missing'),
    statusFieldId: v4GitHubProjectFieldIdSchema,
    missingRequiredStatusOptionIds: z.array(v4GitHubProjectOptionIdSchema).min(1).max(100)
      .superRefine((ids, context) => {
        if (new Set(ids).size !== ids.length) {
          context.addIssue({ code: 'custom', message: 'missing required Status option id must not repeat' })
        }
      }),
  }).strict(),
])

const v4GitHubFailureSchema = z.union([standardGitHubFailureSchema, mappingMismatchFailureSchema])
const v4GitHubProjectBoardFingerprintSchema = z.object({
  version: z.literal(1),
  digest: v4DigestSchema,
}).strict()

/** Complete runtime leaf pack retained by the exact v4 source reader. */
export const v4Source = Object.freeze({
  V4_CONTROL_STATE_KEY,
  V4_DEVELOPMENT_PROJECT_REGISTRY_KEY,
  V4_STORAGE_GENERATION_KEY,
  V4_HOST_OPERATOR_ACTIONS,
  V4_MAX_DISPLAY_LOCATION_CHARS,
  V4_MAX_GIT_REF_CHARS,
  V4_MAX_INVENTORY_ENTRIES,
  V4_MAX_REMOTE_COORDINATE_CHARS,
  V4_MAX_SAFE_REMOTES,
  V4_MAX_TRUSTED_PATH_CHARS,
  V4_SAKI_BOARD_WORK_ITEM_LIMIT,
  V4_SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  V4_SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
  v4BoardRemoteFingerprintSchema,
  v4BoardWorkItemIdSchema,
  v4BuildIdSchema,
  v4CompareSafeGitRemoteObservations,
  v4ControlIntentIdSchema,
  v4ControlStateRecordSchema,
  v4DeriveGitHubRepositoryCandidates,
  v4DevelopmentProjectIdSchema,
  v4DigestSchema,
  v4GitHubAccountIdSchema,
  v4GitHubAppIdSchema,
  v4GitHubFailureSchema,
  v4GitHubInstallationIdSchema,
  v4GitHubIssueIdSchema,
  v4GitHubProjectBoardFingerprintSchema,
  v4GitHubProjectFieldIdSchema,
  v4GitHubProjectIdSchema,
  v4GitHubProjectItemIdSchema,
  v4GitHubProjectOptionIdSchema,
  v4GitHubRepositoryDatabaseIdSchema,
  v4GitHubRepositoryIdSchema,
  v4GitHubScanAttemptIdSchema,
  v4GrantRecordSchema,
  v4HostIdSchema,
  v4HostRecordSchema,
  v4InheritedChangeBaselineIdentityMaterial,
  v4InheritedChangeBaselineSchema,
  v4InstallationAccessRecordSchema,
  v4InstallationIdSchema,
  v4InstallationRecordSchema,
  v4IntentReceiptIdSchema,
  v4IsAbsoluteHostPath,
  v4IsSafeDisplayLocation,
  v4IsSafeGitBranchName,
  v4IsSafeGitRef,
  v4PrincipalRecordSchema,
  v4RegistrationActorSchema,
  v4ResourceBindingIdSchema,
  v4SafeGitRemoteObservationKey,
  v4SafeGitRemoteObservationSchema,
  v4TrustedProjectSelectionObservationSchema,
  v4StorageGenerationIdSchema,
  v4WorkspaceIdSchema,
})
/* jscpd:ignore-end */
