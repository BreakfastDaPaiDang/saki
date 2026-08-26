import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import {
  GitHubProviderError,
  SakiGitHub,
  githubProjectBoardScanCandidateSchema,
  githubProjectBoardScanRequestSchema,
} from '../src/index.ts'
import type { GitHubReadMap, GitHubScanMap } from '../src/index.ts'
import { runGitHubProviderContract } from './contract.ts'
import {
  COMPLETE_SCAN,
  INSTALLATION,
  INSTALLATION_REQUEST,
  SCAN_REQUEST,
} from './fixtures.ts'

class FakeGitHub extends SakiGitHub {
  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    if (request.kind === 'installation') {
      return structuredClone(INSTALLATION)
    }
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    const admitted = githubProjectBoardScanRequestSchema.parse(request)
    const status = COMPLETE_SCAN.fields.find(field => field.id === admitted.statusFieldId)
    if (status?.kind !== 'single-select') {
      throw new GitHubProviderError({
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: admitted.statusFieldId,
      })
    }
    const missingRequiredStatusOptionIds = admitted.requiredStatusOptionIds.filter(
      id => !status.options.some(option => option.id === id),
    )
    if (missingRequiredStatusOptionIds.length > 0) {
      throw new GitHubProviderError({
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: admitted.statusFieldId,
        missingRequiredStatusOptionIds,
      })
    }
    return structuredClone(COMPLETE_SCAN)
  }
}

it('reads one complete single-page Project board scan through the public service', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  const result = await github.scan(SCAN_REQUEST, new AbortController().signal)

  expect(githubProjectBoardScanCandidateSchema.parse(result)).toEqual(COMPLETE_SCAN)
  expect(result.items[0]?.content.kind).toBe('issue')
  await ctx.fiber.dispose()
})

runGitHubProviderContract('fake', async () => {
  const ctx = new Context()
  return {
    github: new FakeGitHub(ctx),
    installationRequest: INSTALLATION_REQUEST,
    scanRequest: SCAN_REQUEST,
    expectedInstallation: INSTALLATION,
    expectedScan: COMPLETE_SCAN,
    dispose: () => ctx.fiber.dispose(),
  }
})
