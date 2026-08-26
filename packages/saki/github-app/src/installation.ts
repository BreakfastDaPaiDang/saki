/** Product App installation inspection and permission projection. @module @breakfastdapaidang/saki-github-app/installation */

import { z } from 'zod'
import {
  GITHUB_INSTALLATION_REPOSITORY_LIMIT,
  GitHubProviderError,
  githubAccountId,
  githubInstallationFactSchema,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubInstallationFact,
  GitHubInstallationProfile,
  GitHubPermissionFact,
  GitHubRestRateObservation,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { githubRestRateObservation } from './errors.ts'
import { GitHubOperationSession } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'
import { appendGitHubRateObservation } from './rate-observations.ts'

const access = z.enum(['read', 'write', 'admin'])
const installationSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  account: z.object({
    node_id: z.string().min(1),
    login: z.string().min(1),
    type: z.enum(['Organization', 'User']),
  }).loose(),
  repository_selection: z.enum(['all', 'selected']),
  permissions: z.record(z.string(), access),
  suspended_at: z.string().nullable(),
}).loose()

const repositoriesSchema = z.object({
  total_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  repositories: z.array(z.object({
    node_id: z.string().min(1),
  }).loose()),
}).loose()

const REQUIRED_INSTALLATION_PERMISSIONS = Object.freeze({
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'write',
  metadata: 'read',
  organization_projects: 'write',
  pull_requests: 'write',
  statuses: 'read',
} satisfies Record<string, 'read' | 'write' | 'admin'>)

const ORGANIZATION_PERMISSION_NAMES = new Set(['organization_projects'])

/** Complete installation inspection and its installation-token REST rate facts. */
export interface GitHubInstallationInspection {
  /** Detached installation fact. */
  readonly fact: GitHubInstallationFact
  /** One observation for each successful installation-token REST read in request order. */
  readonly rateObservations: readonly GitHubRestRateObservation[]
}

/**
 * Inspect and validate the configured Product App installation.
 * @param profile - caller-selected installation identity.
 * @param privateKey - operation-scoped private key.
 * @param config - validated request and pagination limits.
 * @param signal - operation lifetime.
 * @param queue - concurrency-one scheduler for the installation.
 * @returns detached safe installation facts.
 */
export async function readInstallation(
  profile: GitHubInstallationProfile,
  privateKey: string,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubInstallationFact> {
  const session = await GitHubOperationSession.create(profile, privateKey, undefined, config, signal, queue, 'interactive')
  return (await inspectInstallation(session, profile, config, signal)).fact
}

/**
 * Validate installation identity, exact permission ceiling, suspension, and
 * complete Repository access using an already downscoped operation session.
 * @param session - operation-scoped Product App clients.
 * @param profile - selected installation identity.
 * @param config - validated pagination limits.
 * @param signal - operation lifetime.
 * @returns detached safe installation facts and installation-token REST rate observations.
 */
export async function inspectInstallation(
  session: GitHubOperationSession,
  profile: GitHubInstallationProfile,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<GitHubInstallationInspection> {
  const installationResponse = await session.app.request('GET /app/installations/{installation_id}', {
    installation_id: Number(profile.installationId),
    request: { signal },
  })
  const installation = installationSchema.parse(installationResponse.data)
  const rateObservations: GitHubRestRateObservation[] = []
  if (String(installation.id) !== profile.installationId) invalid('installation')
  if (installation.account.node_id !== profile.accountId) {
    throw new GitHubProviderError({
      code: 'permission-mismatch',
      permission: 'installation-account',
      required: 'read',
    })
  }
  if (installation.suspended_at !== null) {
    timestamp(installation.suspended_at)
    throw new GitHubProviderError({ code: 'auth-unavailable' })
  }
  validatePermissions(installation.permissions)

  const accessibleRepositoryIds: ReturnType<typeof githubRepositoryId>[] = []
  let page = 1
  let reportedTotal: number | undefined
  while (true) {
    if (page > config.maxPages) invalid('installation-repositories')
    const pageResponse = await session.installation.request('GET /installation/repositories', {
      per_page: config.pageSize,
      page,
      request: { signal },
    })
    const parsed = repositoriesSchema.parse(pageResponse.data)
    appendGitHubRateObservation(
      rateObservations,
      githubRestRateObservation(pageResponse.headers, 'installation-repositories'),
    )
    reportedTotal ??= parsed.total_count
    if (reportedTotal !== parsed.total_count
      || reportedTotal > GITHUB_INSTALLATION_REPOSITORY_LIMIT) {
      invalid('installation-repositories')
    }
    for (const repository of parsed.repositories) accessibleRepositoryIds.push(githubRepositoryId(repository.node_id))
    if (accessibleRepositoryIds.length > GITHUB_INSTALLATION_REPOSITORY_LIMIT) {
      invalid('installation-repositories')
    }
    if (parsed.repositories.length < config.pageSize || accessibleRepositoryIds.length === reportedTotal) break
    page += 1
  }
  if (accessibleRepositoryIds.length !== reportedTotal) invalid('installation-repositories')

  const repository: GitHubPermissionFact[] = []
  const organization: GitHubPermissionFact[] = []
  for (const [name, granted] of Object.entries(installation.permissions).sort(([left], [right]) => left.localeCompare(right))) {
    const target = ORGANIZATION_PERMISSION_NAMES.has(name) ? organization : repository
    target.push({ name, access: granted })
  }
  const observedAt = Date.now()
  const fact = githubInstallationFactSchema.parse({
    installationId: profile.installationId,
    account: {
      id: githubAccountId(installation.account.node_id),
      login: installation.account.login,
      type: installation.account.type === 'Organization' ? 'organization' : 'user',
    },
    repositorySelection: installation.repository_selection,
    permissions: { repository, organization },
    accessibleRepositoryIds,
    tokenExpiresAt: session.token.expiresAt,
    observedAt,
  }) as GitHubInstallationFact
  return { fact, rateObservations }
}

function validatePermissions(observed: Readonly<Record<string, 'read' | 'write' | 'admin'>>): void {
  for (const [permission, required] of Object.entries(REQUIRED_INSTALLATION_PERMISSIONS)) {
    const granted = observed[permission]
    if (granted !== required) {
      throw new GitHubProviderError({
        code: 'permission-mismatch',
        permission,
        required,
        observed: granted ?? 'none',
      })
    }
  }
  const extra = Object.keys(observed).find(permission => !(permission in REQUIRED_INSTALLATION_PERMISSIONS))
  if (extra !== undefined) {
    throw new GitHubProviderError({
      code: 'permission-mismatch',
      permission: extra,
      required: 'none',
      observed: observed[extra],
    })
  }
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('installation')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}
