/** Saki Product GitHub App Provider. @module @breakfastdapaidang/saki-github-app */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
} from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT,
  GITHUB_TAG_PEEL_DEPTH_LIMIT,
  GitHubProviderError,
  SakiGitHub,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubMutationMap,
  GitHubReadMap,
  GitHubScanMap,
} from '@breakfastdapaidang/saki-github'
import { translateGitHubError } from './errors.ts'
import { readInstallation } from './installation.ts'
import {
  readBranchSafety,
  readCommit,
  readCompareCommits,
  readIssue,
  readIssueDetail,
  readProject,
  readReleaseByTag,
  readRepository,
  readTagObject,
  readTagReference,
} from './reads.ts'
import { InstallationPriorityQueue } from './priority-queue.ts'
import { inspectProjectItemStatus } from './project-item-status-inspection.ts'
import { inspectProjectItemAdd } from './project-item-add-inspection.ts'
import { inspectIssueState } from './issue-state-inspection.ts'
import { inspectIssueCreate } from './issue-create-inspection.ts'
import { inspectProjectItemPosition } from './project-item-position-inspection.ts'
import { addProjectItem, createIssue, setIssueState, setProjectItemPosition, setProjectItemStatus } from './mutations.ts'
import { scanProjectBoard } from './scan.ts'
import { ScanConcurrencyGate } from './scan-gate.ts'

/** Validated Product App request and scan resource limits. */
export interface Config {
  /** Items requested per GitHub connection page; defaults to 50 within 1..100. */
  pageSize?: number
  /** Pages traversed for one connection; defaults to 1,000 within 1..10,000. */
  maxPages?: number
  /** Project items or open Issues admitted per collection; defaults to 20,000 within 1..100,000. */
  maxItems?: number
  /** Item field values admitted across one scan; defaults to 100,000 within 1..1,000,000. */
  maxFieldValues?: number
  /** Bytes admitted from one HTTP response; defaults to 16 MiB within the safe-integer range. */
  maxResponseBytes?: number
  /** Wall-clock milliseconds per GitHub request; defaults to 30,000 within the timer range. */
  requestTimeoutMs?: number
  /** Annotated-tag objects admitted by one recursive peel; defaults to 32 within 1..100. */
  tagPeelDepth?: number
  /** Complete Project scans active across installations; defaults to 2 within 1..1,000. */
  maxConcurrentScans?: number
}

/** Complete provider configuration after Cordis applies defaults. */
export type ResolvedConfig = Required<Config>

/** Product App Provider using short-lived, operation-scoped installation authentication. */
export class SakiGitHubApp extends SakiGitHub {
  static inject = ['credentials']
  static Config: z<Config> = z.object({
    pageSize: z.natural().min(1).max(100).default(50),
    maxPages: z.natural().min(1).max(10_000).default(1_000),
    maxItems: z.natural().min(1).max(GITHUB_PROJECT_BOARD_SCAN_COLLECTION_LIMIT).default(20_000),
    maxFieldValues: z.natural().min(1).max(1_000_000).default(100_000),
    maxResponseBytes: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(16 * 1024 * 1024),
    requestTimeoutMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
    tagPeelDepth: z.natural().min(1).max(GITHUB_TAG_PEEL_DEPTH_LIMIT).default(32),
    maxConcurrentScans: z.natural().min(1).max(1_000).default(2),
  })

  private readonly lifetime = new AbortController()
  private readonly active = new Set<Promise<unknown>>()
  private readonly installationQueues = new Map<string, InstallationPriorityQueue>()
  private readonly scanGate: ScanConcurrencyGate

  /** @param ctx - Host context carrying the credential-reference provider. @param config - resolved limits. */
  constructor(ctx: Context, private readonly config: ResolvedConfig) {
    super(ctx)
    this.scanGate = new ScanConcurrencyGate(config.maxConcurrentScans)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Saki Product GitHub App Provider disposed'))
      await Promise.allSettled([...this.active])
    }, 'saki-github-app: abort and drain active operations')
  }

  /** @inheritdoc */
  override read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    return this.runOwned(signal, async (operationSignal) => {
      const admitted = request
      try {
        operationSignal.throwIfAborted()
        const privateKey = await this.resolvePrivateKey(admitted.installation.privateKeyRef)
        const queue = this.queueFor(admitted.installation.installationId)
        if (admitted.kind === 'installation') {
          return await readInstallation(admitted.installation, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'repository') {
          return await readRepository(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'issue') {
          return await readIssue(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'issue-detail') {
          return await readIssueDetail(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'branch-safety') {
          return await readBranchSafety(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'project') {
          return await readProject(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'tag-reference') {
          return await readTagReference(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'tag-object') {
          return await readTagObject(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'release-by-tag') {
          return await readReleaseByTag(admitted, privateKey, this.config, operationSignal, queue)
        }
        if (admitted.kind === 'commit') {
          return await readCommit(admitted, privateKey, this.config, operationSignal, queue)
        }
        return await readCompareCommits(admitted, privateKey, this.config, operationSignal, queue)
      } catch (error) {
        throw translateGitHubError(error, admitted.kind, operationSignal)
      }
    })
  }

  /** @inheritdoc */
  override scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    return this.runOwned(signal, async (operationSignal) => {
      try {
        operationSignal.throwIfAborted()
        return await this.scanGate.run(operationSignal, async () => {
          const privateKey = await this.resolvePrivateKey(request.installation.privateKeyRef)
          const queue = this.queueFor(request.installation.installationId)
          return await scanProjectBoard(request, privateKey, this.config, operationSignal, queue)
        })
      } catch (error) {
        throw translateGitHubError(error, request.kind, operationSignal)
      }
    })
  }

  /** @inheritdoc */
  override dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']> {
    return this.runOwned(signal, async (operationSignal) => {
      try {
        operationSignal.throwIfAborted()
        const privateKey = await this.resolvePrivateKey(request.installation.privateKeyRef)
        const queue = this.queueFor(request.installation.installationId)
        if (request.kind === 'issue-create') {
          return await createIssue(request, privateKey, this.config, operationSignal, queue)
        }
        if (request.kind === 'project-item-add') {
          await addProjectItem(request, privateKey, this.config, operationSignal, queue)
          return
        }
        if (request.kind === 'project-item-position-set') {
          await setProjectItemPosition(request, privateKey, this.config, operationSignal, queue)
          return
        }
        if (request.kind === 'issue-state-set') {
          await setIssueState(request, privateKey, this.config, operationSignal, queue)
          return
        }
        await setProjectItemStatus(request, privateKey, this.config, operationSignal, queue)
      } catch (error) {
        throw translateGitHubError(error, request.kind, operationSignal)
      }
    })
  }

  /** @inheritdoc */
  override inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    // Keep the public generic request/result narrowing visible; `runOwned` already owns the shared lifecycle.
    /* jscpd:ignore-start */
    return this.runOwned(signal, async (operationSignal) => {
      try {
        operationSignal.throwIfAborted()
        const privateKey = await this.resolvePrivateKey(request.installation.privateKeyRef)
        const queue = this.queueFor(request.installation.installationId)
        /* jscpd:ignore-end */
        if (request.kind === 'issue-create') {
          return await inspectIssueCreate(request, privateKey, this.config, operationSignal, queue)
        }
        if (request.kind === 'project-item-add') {
          return await inspectProjectItemAdd(request, privateKey, this.config, operationSignal, queue)
        }
        if (request.kind === 'issue-state-set') {
          return await inspectIssueState(request, privateKey, this.config, operationSignal, queue)
        }
        if (request.kind === 'project-item-position-set') {
          return await inspectProjectItemPosition(request, privateKey, this.config, operationSignal, queue)
        }
        return await inspectProjectItemStatus(request, privateKey, this.config, operationSignal, queue)
      } catch (error) {
        throw translateGitHubError(error, request.kind, operationSignal)
      }
    })
  }

  private async resolvePrivateKey(ref: CredentialRef): Promise<string> {
    try {
      const credential = await this.ctx.credentials.resolveRequired(
        ref,
        CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
      )
      return credential.value
    } catch {
      throw new GitHubProviderError({ code: 'auth-unavailable', credentialRef: ref })
    }
  }

  private runOwned<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const operationSignal = AbortSignal.any([signal, this.lifetime.signal])
    const result = Promise.resolve().then(async () => await operation(operationSignal))
    const tracked = result.finally(() => { this.active.delete(tracked) })
    this.active.add(tracked)
    return tracked
  }

  private queueFor(installationId: string): InstallationPriorityQueue {
    const existing = this.installationQueues.get(installationId)
    if (existing !== undefined) return existing
    const created = new InstallationPriorityQueue()
    this.installationQueues.set(installationId, created)
    return created
  }
}

export default SakiGitHubApp
