import { describe, expect, it } from 'vitest'
import {
  GitHubProviderError,
  computeGitHubProjectBoardFingerprint,
  githubFailureSchema,
  githubInstallationFactSchema,
  githubProjectBoardScanCandidateSchema,
  githubProjectFieldId,
  githubProjectOptionId,
} from '../src/index.ts'
import type {
  GitHubInstallationFact,
  GitHubInstallationReadRequest,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  SakiGitHub,
} from '../src/index.ts'

/** Fresh provider and deterministic public requests used by the reusable contract. */
export interface GitHubProviderContractHarness {
  readonly github: SakiGitHub
  readonly installationRequest: GitHubInstallationReadRequest
  readonly scanRequest: GitHubProjectBoardScanRequest
  readonly expectedInstallation: GitHubInstallationFact
  readonly expectedScan: GitHubProjectBoardScanCandidate
  readonly dispose: () => Promise<void>
}

/**
 * Run the provider-neutral read/scan contract against one GitHub provider.
 * @param label - provider label shown by Vitest.
 * @param create - fresh deterministic provider harness for each test.
 */
export function runGitHubProviderContract(
  label: string,
  create: () => Promise<GitHubProviderContractHarness>,
): void {
  describe(`Saki GitHub provider contract: ${label}`, () => {
    it('reads a strict detached installation fact through the public service', async () => {
      const harness = await create()
      try {
        const first = await harness.github.read<'installation'>(
          harness.installationRequest,
          new AbortController().signal,
        )
        expect(githubInstallationFactSchema.parse(first)).toEqual(harness.expectedInstallation)
        mutateAccountLogin(first)
        await expect(harness.github.read<'installation'>(
          harness.installationRequest,
          new AbortController().signal,
        ))
          .resolves.toEqual(harness.expectedInstallation)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict complete detached scan with stable semantic identity', async () => {
      const harness = await create()
      try {
        const scan = await harness.github.scan<'project-board'>(
          harness.scanRequest,
          new AbortController().signal,
        )
        expect(githubProjectBoardScanCandidateSchema.parse(scan)).toEqual(harness.expectedScan)
        expect(JSON.stringify(scan)).not.toContain('cursor')
        const timingChanged = {
          ...scan,
          observedAt: scan.observedAt + 1,
          rateObservations: scan.rateObservations.map(observation => ({
            ...observation,
            observedAt: observation.observedAt + 1,
          })),
        }
        expect(computeGitHubProjectBoardFingerprint(timingChanged)).toEqual(scan.fingerprint)
        const issue = scan.openIssues[0]
        expect(issue).toBeDefined()
        const stateChanged = {
          ...scan,
          openIssues: [{ ...issue!, state: 'closed' as const }],
        }
        expect(computeGitHubProjectBoardFingerprint(stateChanged)).not.toEqual(scan.fingerprint)

        mutateFirstIssueTitle(scan)
        await expect(harness.github.scan<'project-board'>(
          harness.scanRequest,
          new AbortController().signal,
        ))
          .resolves.toEqual(harness.expectedScan)
      } finally {
        await harness.dispose()
      }
    })

    it('rejects a pre-cancelled scan with the closed cancellation failure', async () => {
      const harness = await create()
      try {
        const controller = new AbortController()
        controller.abort(new Error('private cancellation reason'))
        let error: unknown
        try {
          await harness.github.scan(harness.scanRequest, controller.signal)
        } catch (caught: unknown) {
          error = caught
        }
        expect(error).toBeInstanceOf(GitHubProviderError)
        if (!(error instanceof GitHubProviderError)) throw new Error('expected a typed GitHub cancellation')
        expect(error.failure).toEqual({ code: 'cancelled' })
        expect(githubFailureSchema.parse(error.failure)).toEqual({ code: 'cancelled' })
        expect(error.message).not.toContain('private cancellation reason')
      } finally {
        await harness.dispose()
      }
    })

    it('fails when persisted Status field or option ids are not observed exactly', async () => {
      const harness = await create()
      try {
        const wrongField = {
          ...harness.scanRequest,
          statusFieldId: githubProjectFieldId('PVTF_missing'),
        }
        const wrongOptions = {
          ...harness.scanRequest,
          requiredStatusOptionIds: [githubProjectOptionId('option-missing')],
        }
        await expect(harness.github.scan(wrongField, new AbortController().signal)).rejects.toMatchObject({
          name: 'GitHubProviderError',
          failure: {
            code: 'mapping-mismatch',
            reason: 'field-missing-or-not-single-select',
            statusFieldId: 'PVTF_missing',
          },
        })
        await expect(harness.github.scan(wrongOptions, new AbortController().signal)).rejects.toMatchObject({
          name: 'GitHubProviderError',
          failure: {
            code: 'mapping-mismatch',
            reason: 'required-options-missing',
            statusFieldId: harness.scanRequest.statusFieldId,
            missingRequiredStatusOptionIds: ['option-missing'],
          },
        })
      } finally {
        await harness.dispose()
      }
    })
  })
}

function mutateAccountLogin(fact: GitHubInstallationFact): void {
  ;(fact.account as { login: string }).login = 'borrowed mutation'
}

function mutateFirstIssueTitle(scan: GitHubProjectBoardScanCandidate): void {
  const issue = scan.openIssues[0]
  if (issue !== undefined) (issue as { title: string }).title = 'borrowed mutation'
}
