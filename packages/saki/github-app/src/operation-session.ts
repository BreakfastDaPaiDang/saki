/** Operation-scoped Product App authentication and bounded HTTP clients. @module @breakfastdapaidang/saki-github-app/operation-session */

import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/core'
import { z } from 'zod'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type {
  GitHubInstallationProfile,
  GitHubRepositoryDatabaseId,
} from '@breakfastdapaidang/saki-github'
import { GitHubProviderError } from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { GitHubResponseLimitError } from './errors.ts'
import type { GitHubRequestPriority, InstallationPriorityQueue } from './priority-queue.ts'

const REQUEST_TIMEOUT_CODE = 'SAKI_GITHUB_REQUEST_TIMEOUT'

const authenticationSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.iso.datetime(),
  permissions: z.record(z.string(), z.enum(['read', 'write', 'admin'])),
  repositorySelection: z.enum(['all', 'selected']),
  repositoryIds: z.array(z.union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z.bigint().positive(),
  ])).max(500).optional(),
}).loose()

/** Complete Product App permission profile for existing read operations. */
const READ_PERMISSIONS = Object.freeze({
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'read',
  metadata: 'read',
  organization_projects: 'read',
  pull_requests: 'read',
  statuses: 'read',
})

/** Minimal Product App permission profile for Project mutations. */
const PROJECT_WRITE_PERMISSIONS = Object.freeze({
  metadata: 'read',
  organization_projects: 'write',
})

/** Minimal Product App permission profile for Issue mutations. */
const ISSUE_WRITE_PERMISSIONS = Object.freeze({
  issues: 'write',
  metadata: 'read',
})

/** Minimal Product App permission profile for Issue inspections. */
const ISSUE_READ_PERMISSIONS = Object.freeze({
  issues: 'read',
  metadata: 'read',
})

/** Minimal Product App permission profile for Pull Request creation. */
const PULL_REQUEST_WRITE_PERMISSIONS = Object.freeze({
  metadata: 'read',
  pull_requests: 'write',
})

/** Minimal Product App permission profile for Pull Request inspection. */
const PULL_REQUEST_READ_PERMISSIONS = Object.freeze({
  metadata: 'read',
  pull_requests: 'read',
})

/** Minimal Product App permission profile for Project inspections. */
const PROJECT_READ_PERMISSIONS = Object.freeze({
  issues: 'read',
  metadata: 'read',
  organization_projects: 'read',
})

/** Closed operation purpose used to select provider-owned token permissions. */
type GitHubOperationPurpose =
  | 'read'
  | 'issue-create'
  | 'issue-create-inspection'
  | 'pull-request-create'
  | 'pull-request-create-inspection'
  | 'project-item-add'
  | 'project-item-add-inspection'
  | 'project-item-position-set'
  | 'project-item-status-set'
  | 'project-item-status-inspection'
  | 'issue-state-set'
  | 'issue-state-inspection'
  | 'project-item-position-inspection'

const PRODUCT_APP_OPERATION_PERMISSIONS = {
  read: READ_PERMISSIONS,
  'issue-create': ISSUE_WRITE_PERMISSIONS,
  'issue-create-inspection': ISSUE_READ_PERMISSIONS,
  'pull-request-create': PULL_REQUEST_WRITE_PERMISSIONS,
  'pull-request-create-inspection': PULL_REQUEST_READ_PERMISSIONS,
  'project-item-add': PROJECT_WRITE_PERMISSIONS,
  'project-item-add-inspection': PROJECT_READ_PERMISSIONS,
  'project-item-position-set': PROJECT_WRITE_PERMISSIONS,
  'project-item-status-set': PROJECT_WRITE_PERMISSIONS,
  'project-item-status-inspection': PROJECT_READ_PERMISSIONS,
  'issue-state-set': ISSUE_WRITE_PERMISSIONS,
  'issue-state-inspection': ISSUE_READ_PERMISSIONS,
  'project-item-position-inspection': PROJECT_READ_PERMISSIONS,
} satisfies Record<GitHubOperationPurpose, Readonly<Record<string, 'read' | 'write' | 'admin'>>>

/** Validated installation-token metadata retained without the token. */
export interface InstallationTokenFact {
  /** Token expiry in epoch milliseconds. */
  readonly expiresAt: number
  /** Permissions reported for the downscoped token. */
  readonly permissions: Readonly<Record<string, string>>
  /** Repository-selection mode reported by GitHub. */
  readonly repositorySelection: 'all' | 'selected'
}

/** App-JWT and installation-token clients whose credentials live for one operation. */
export class GitHubOperationSession {
  /** App-JWT client used only for installation inspection. */
  readonly app: Octokit
  /** Short-lived installation-token client used for operation requests. */
  readonly installation: Octokit
  /** Safe metadata retained from the admitted installation-token response. */
  readonly token: InstallationTokenFact

  private constructor(app: Octokit, installation: Octokit, token: InstallationTokenFact) {
    this.app = app
    this.installation = installation
    this.token = token
  }

  /**
   * Authenticate one operation, optionally binding its token to one Repository.
   * @param profile - selected Product App installation and key metadata.
   * @param privateKey - resolved local-user-trust PEM, retained only by this operation.
   * @param repositoryDatabaseId - exact Repository database id for downscoping.
   * @param config - validated provider limits.
   * @param signal - operation lifetime.
   * @param queue - concurrency-one scheduler for this installation.
   * @param priority - operation priority applied independently to each HTTP request.
   * @param purpose - provider-owned permission profile for this operation.
   * @returns authenticated, bounded clients and safe token metadata.
   */
  static async create(
    profile: GitHubInstallationProfile,
    privateKey: string,
    repositoryDatabaseId: GitHubRepositoryDatabaseId | undefined,
    config: ResolvedConfig,
    signal: AbortSignal,
    queue: InstallationPriorityQueue,
    priority: GitHubRequestPriority,
    purpose: GitHubOperationPurpose = 'read',
  ): Promise<GitHubOperationSession> {
    const boundedFetch = createBoundedFetch(config, signal, queue, priority)
    const app = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: profile.appId, privateKey },
      request: { fetch: boundedFetch },
    })
    const repositoryIds = repositoryDatabaseId === undefined
      ? undefined
      : [safeNumericId(repositoryDatabaseId, 'Repository database id')]
    const permissions = permissionsFor(purpose)
    const rawAuthentication: unknown = await app.auth({
      type: 'installation',
      installationId: safeNumericId(profile.installationId, 'installation id'),
      permissions,
      ...(repositoryIds === undefined ? {} : { repositoryIds }),
    })
    const authentication = authenticationSchema.parse(rawAuthentication)
    validateTokenPermissions(authentication.permissions, permissions)
    if (repositoryIds !== undefined && (
      authentication.repositorySelection !== 'selected'
      || authentication.repositoryIds?.length !== 1
      || String(authentication.repositoryIds[0]) !== String(repositoryIds[0])
    )) {
      throw new GitHubProviderError({
        code: 'invalid-external-response',
        operation: 'installation-token-scope',
      })
    }
    const expiresAt = parseTimestamp(authentication.expiresAt)
    if (expiresAt <= Date.now()) throw new GitHubProviderError({ code: 'auth-unavailable' })
    const installation = new Octokit({
      auth: authentication.token,
      request: { fetch: boundedFetch },
    })
    return new GitHubOperationSession(app, installation, {
      expiresAt,
      permissions: Object.freeze({ ...authentication.permissions }),
      repositorySelection: authentication.repositorySelection,
    })
  }
}

function permissionsFor(purpose: GitHubOperationPurpose): Readonly<Record<string, 'read' | 'write' | 'admin'>> {
  return PRODUCT_APP_OPERATION_PERMISSIONS[purpose]
}

function validateTokenPermissions(
  observed: Readonly<Record<string, 'read' | 'write' | 'admin'>>,
  expected: Readonly<Record<string, 'read' | 'write' | 'admin'>>,
): void {
  for (const [permission, required] of Object.entries(expected)) {
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
  const extra = Object.keys(observed).find(permission => !(permission in expected))
  if (extra !== undefined) {
    throw new GitHubProviderError({
      code: 'permission-mismatch',
      permission: extra,
      required: 'none',
      observed: observed[extra],
    })
  }
}

/**
 * Build the provider's timeout-, size-, and queue-bounded transport.
 * @param config - validated provider transport limits.
 * @param signal - lifetime shared by queued and active requests.
 * @param queue - provider-owned request scheduler.
 * @param priority - scheduling class for each request.
 * @returns fetch implementation that buffers only complete bounded responses.
 */
export function createBoundedFetch(
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
  priority: GitHubRequestPriority,
): typeof globalThis.fetch {
  const baseFetch = globalThis.fetch.bind(globalThis)
  return async (input, init) => await queue.run(priority, signal, async () => {
    const requestDeadline = deadline(signal, config.requestTimeoutMs, REQUEST_TIMEOUT_CODE)
    try {
      const initSignal = init?.signal ?? undefined
      const requestSignal = initSignal === undefined
        ? requestDeadline.signal
        : AbortSignal.any([requestDeadline.signal, initSignal])
      const response = await baseFetch(input, { ...init, signal: requestSignal })
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && decimal(contentLength) > config.maxResponseBytes) {
        await cancelBody(response.body)
        throw new GitHubResponseLimitError()
      }
      const bytes = await readBoundedBody(response.body, config.maxResponseBytes, requestSignal)
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      if (!signal.aborted && timeoutOf(requestDeadline.signal, REQUEST_TIMEOUT_CODE) !== undefined) {
        throw new GitHubProviderError({ code: 'transient-transport' })
      }
      throw error
    } finally {
      requestDeadline[Symbol.dispose]()
    }
  })
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > maxBytes) {
        await cancelReader(reader)
        throw new GitHubResponseLimitError()
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (body === null) return
  try {
    await body.cancel()
  } catch {
    // Transport cancellation can race stream closure; the byte-limit rejection remains authoritative.
  }
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Transport cancellation can race stream closure; the byte-limit rejection remains authoritative.
  }
}

/**
 * Convert a validated decimal GitHub id to the SDK's safe numeric domain.
 * @param value - decimal GitHub identifier text.
 * @param name - field name used by the bounded failure diagnostic.
 * @returns positive safe-integer identifier accepted by the SDK.
 */
export function safeNumericId(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} exceeds the GitHub SDK numeric range`)
  return parsed
}

function decimal(value: string): number {
  if (!/^[0-9]+$/.test(value)) return Number.POSITIVE_INFINITY
  return Number(value)
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('GitHub returned an invalid timestamp')
  return parsed
}
