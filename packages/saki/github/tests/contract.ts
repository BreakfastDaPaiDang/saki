import { describe, expect, it } from 'vitest'
import {
  GitHubProviderError,
  computeGitHubProjectBoardFingerprint,
  githubFailureSchema,
  githubInstallationFactSchema,
  githubIssueStateSetInspectionSchema,
  githubIssueCreateInspectionHintSchema,
  githubIssueCreateInspectionSchema,
  githubProjectBoardScanCandidateSchema,
  githubProjectFieldId,
  githubProjectItemAddInspectionSchema,
  githubProjectItemPositionSetInspectionSchema,
  githubProjectItemStatusSetInspectionSchema,
  githubProjectOptionId,
} from '../src/index.ts'
import type {
  GitHubInstallationFact,
  GitHubInstallationReadRequest,
  GitHubIssueStateSetInspection,
  GitHubIssueStateSetRequest,
  GitHubIssueCreateInspectionHint,
  GitHubIssueCreateInspection,
  GitHubIssueCreateRequest,
  GitHubProjectBoardScanCandidate,
  GitHubProjectBoardScanRequest,
  GitHubProjectItemAddInspection,
  GitHubProjectItemAddRequest,
  GitHubProjectItemPositionSetInspection,
  GitHubProjectItemPositionSetRequest,
  GitHubProjectItemStatusSetInspection,
  GitHubProjectItemStatusSetRequest,
  SakiGitHub,
} from '../src/index.ts'

/** Fresh provider and deterministic public requests used by the reusable contract. */
export interface GitHubProviderContractHarness {
  readonly github: SakiGitHub
  readonly installationRequest: GitHubInstallationReadRequest
  readonly scanRequest: GitHubProjectBoardScanRequest
  readonly expectedInstallation: GitHubInstallationFact
  readonly expectedScan: GitHubProjectBoardScanCandidate
  readonly projectItemAddRequest: GitHubProjectItemAddRequest
  readonly expectedProjectItemAddInspection: GitHubProjectItemAddInspection
  readonly positionRequest: GitHubProjectItemPositionSetRequest
  readonly expectedPositionInspection: GitHubProjectItemPositionSetInspection
  readonly issueStateRequest: GitHubIssueStateSetRequest
  readonly expectedIssueStateInspection: GitHubIssueStateSetInspection
  readonly issueCreateRequest: GitHubIssueCreateRequest
  readonly expectedIssueCreateResult: GitHubIssueCreateInspectionHint
  readonly expectedIssueCreateInspection: GitHubIssueCreateInspection
  readonly mutationRequest: GitHubProjectItemStatusSetRequest
  readonly expectedMutationInspection: GitHubProjectItemStatusSetInspection
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

    it('dispatches one Status call and returns void', async () => {
      const harness = await create()
      try {
        await expect(harness.github.dispatch<'project-item-status-set'>(
          harness.mutationRequest,
          new AbortController().signal,
        )).resolves.toBeUndefined()
      } finally {
        await harness.dispose()
      }
    })

    it('dispatches one Project membership call and returns void', async () => {
      const harness = await create()
      try {
        await expect(harness.github.dispatch<'project-item-add'>(
          harness.projectItemAddRequest,
          new AbortController().signal,
        )).resolves.toBeUndefined()
      } finally {
        await harness.dispose()
      }
    })

    it('dispatches one Project-item position call and returns void', async () => {
      const harness = await create()
      try {
        await expect(harness.github.dispatch<'project-item-position-set'>(
          harness.positionRequest,
          new AbortController().signal,
        )).resolves.toBeUndefined()
      } finally {
        await harness.dispose()
      }
    })

    it('dispatches one Issue-state call and returns void', async () => {
      const harness = await create()
      try {
        await expect(harness.github.dispatch<'issue-state-set'>(
          harness.issueStateRequest,
          new AbortController().signal,
        )).resolves.toBeUndefined()
      } finally {
        await harness.dispose()
      }
    })

    it('dispatches one Issue-create call and returns a detached inspection hint', async () => {
      const harness = await create()
      try {
        const result = await harness.github.dispatch<'issue-create'>(
          harness.issueCreateRequest,
          new AbortController().signal,
        )
        expect(githubIssueCreateInspectionHintSchema.parse(result)).toEqual(harness.expectedIssueCreateResult)
        ;(result as { issueNumber: number }).issueNumber += 1
        await expect(harness.github.dispatch<'issue-create'>(
          harness.issueCreateRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedIssueCreateResult)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict detached targeted inspection without scan state', async () => {
      const harness = await create()
      try {
        const inspection = await harness.github.inspectMutation<'project-item-status-set'>(
          harness.mutationRequest,
          new AbortController().signal,
        )
        expect(githubProjectItemStatusSetInspectionSchema.parse(inspection))
          .toEqual(harness.expectedMutationInspection)
        expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
        ;(inspection.snapshot.issue as { title: string }).title = 'borrowed mutation'
        await expect(harness.github.inspectMutation<'project-item-status-set'>(
          harness.mutationRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedMutationInspection)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict detached Project membership inspection without scan state', async () => {
      const harness = await create()
      try {
        const inspection = await harness.github.inspectMutation<'project-item-add'>(
          harness.projectItemAddRequest,
          new AbortController().signal,
        )
        expect(githubProjectItemAddInspectionSchema.parse(inspection))
          .toEqual(harness.expectedProjectItemAddInspection)
        expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
        ;(inspection.snapshot.issue as { title: string }).title = 'borrowed mutation'
        await expect(harness.github.inspectMutation<'project-item-add'>(
          harness.projectItemAddRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedProjectItemAddInspection)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict detached Project-item position inspection without scan state', async () => {
      const harness = await create()
      try {
        const inspection = await harness.github.inspectMutation<'project-item-position-set'>(
          harness.positionRequest,
          new AbortController().signal,
        )
        expect(githubProjectItemPositionSetInspectionSchema.parse(inspection))
          .toEqual(harness.expectedPositionInspection)
        expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
        ;(inspection.snapshot.issue as { title: string }).title = 'borrowed mutation'
        await expect(harness.github.inspectMutation<'project-item-position-set'>(
          harness.positionRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedPositionInspection)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict detached Issue-state inspection without scan state', async () => {
      const harness = await create()
      try {
        const inspection = await harness.github.inspectMutation<'issue-state-set'>(
          harness.issueStateRequest,
          new AbortController().signal,
        )
        expect(githubIssueStateSetInspectionSchema.parse(inspection))
          .toEqual(harness.expectedIssueStateInspection)
        expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
        ;(inspection.snapshot.issue as { title: string }).title = 'borrowed mutation'
        await expect(harness.github.inspectMutation<'issue-state-set'>(
          harness.issueStateRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedIssueStateInspection)
      } finally {
        await harness.dispose()
      }
    })

    it('returns one strict detached Issue-create marker inspection without provider payloads', async () => {
      const harness = await create()
      try {
        const inspection = await harness.github.inspectMutation<'issue-create'>(
          harness.issueCreateRequest,
          new AbortController().signal,
        )
        expect(githubIssueCreateInspectionSchema.parse(inspection))
          .toEqual(harness.expectedIssueCreateInspection)
        expect(JSON.stringify(inspection)).not.toMatch(/body|header|cursor|token/u)
        if (inspection.snapshot.outcome.state === 'unique-issue') {
          ;(inspection.snapshot.outcome.issue as { title: string }).title = 'borrowed mutation'
        }
        await expect(harness.github.inspectMutation<'issue-create'>(
          harness.issueCreateRequest,
          new AbortController().signal,
        )).resolves.toEqual(harness.expectedIssueCreateInspection)
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
