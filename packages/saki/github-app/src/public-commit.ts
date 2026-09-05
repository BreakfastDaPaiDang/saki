/** Credential-free exact Commit reads from one verified public GitHub Repository. */

import { Octokit } from '@octokit/core'
import { z } from 'zod'
import {
  GitHubProviderError,
  githubCommitFactSchema,
  githubCommitId,
  type GitHubCommitFact,
  type GitHubPublicCommitReadRequest,
} from '@breakfastdapaidang/saki-github'
import type { ResolvedConfig } from './index.ts'
import { createBoundedFetch } from './operation-session.ts'
import type { InstallationPriorityQueue } from './priority-queue.ts'

const publicRepositoryResponseSchema = z.looseObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  node_id: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  visibility: z.string(),
})

const commitResponseSchema = z.looseObject({
  sha: z.string(),
  html_url: z.string(),
  committer: z.looseObject({ date: z.string() }).nullable(),
})

/**
 * Verify one public Repository identity, then read an exact full Commit id without credentials.
 * @param request - public Repository canonical name and node/database ids plus the exact Commit id.
 * @param config - validated provider transport limits.
 * @param signal - operation lifetime.
 * @param queue - provider-owned anonymous-request scheduler.
 * @returns detached exact Commit facts.
 */
export async function readPublicCommit(
  request: GitHubPublicCommitReadRequest,
  config: ResolvedConfig,
  signal: AbortSignal,
  queue: InstallationPriorityQueue,
): Promise<GitHubCommitFact> {
  const client = new Octokit({ request: { fetch: createBoundedFetch(config, signal, queue, 'interactive') } })
  const separator = request.repositoryNameWithOwner.indexOf('/')
  const owner = request.repositoryNameWithOwner.slice(0, separator)
  const repo = request.repositoryNameWithOwner.slice(separator + 1)
  const rawRepository: unknown = (await client.request('GET /repos/{owner}/{repo}', {
    owner,
    repo,
    request: { signal },
  })).data
  const repository = publicRepositoryResponseSchema.parse(rawRepository)
  if (repository.node_id !== request.repositoryId
    || String(repository.id) !== request.repositoryDatabaseId
    || repository.full_name !== request.repositoryNameWithOwner
    || repository.private
    || repository.visibility !== 'public') {
    invalid(request.kind)
  }

  const rawCommit: unknown = (await client.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
    owner,
    repo,
    commit_sha: request.commitId,
    request: { signal },
  })).data
  const commit = commitResponseSchema.parse(rawCommit)
  if (commit.sha !== request.commitId || commit.committer === null) invalid(request.kind)
  return githubCommitFactSchema.parse({
    id: githubCommitId(commit.sha),
    repositoryId: request.repositoryId,
    url: commit.html_url,
    committedAt: timestamp(commit.committer.date),
    observedAt: Date.now(),
  })
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) invalid('public-commit')
  return parsed
}

function invalid(operation: string): never {
  throw new GitHubProviderError({ code: 'invalid-external-response', operation })
}
