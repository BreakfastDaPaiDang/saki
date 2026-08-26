import { describe, expect, it } from 'vitest'
import {
  GITHUB_RATE_OBSERVATION_LIMIT,
  GITHUB_TAG_PEEL_DEPTH_LIMIT,
  GitHubProviderError,
  computeGitHubProjectBoardFingerprint,
  githubAccountId,
  githubAccountIdSchema,
  githubAppId,
  githubAppIdSchema,
  githubCommitComparisonFactSchema,
  githubCommitFactSchema,
  githubCommitId,
  githubCommitIdSchema,
  githubCommitReadRequestSchema,
  githubCompareCommitsReadRequestSchema,
  githubExternalOperationId,
  githubExternalOperationIdSchema,
  githubFailureSchema,
  githubInstallationFactSchema,
  githubInstallationId,
  githubInstallationIdSchema,
  githubInstallationProfileSchema,
  githubInstallationReadRequestSchema,
  githubIssueId,
  githubIssueIdSchema,
  githubIssueReadRequestSchema,
  githubMutationIdentitySchema,
  githubMutationInspectionSchema,
  githubMutationKind,
  githubMutationKindSchema,
  githubProjectBoardScanCandidateSchema,
  githubProjectBoardScanRequestSchema,
  githubProjectFactSchema,
  githubProjectFieldFactSchema,
  githubProjectFieldId,
  githubProjectFieldIdSchema,
  githubProjectId,
  githubProjectIdSchema,
  githubProjectItemContentSchema,
  githubProjectItemId,
  githubProjectItemIdSchema,
  githubProjectOptionId,
  githubProjectOptionIdSchema,
  githubProjectReadRequestSchema,
  githubPullRequestId,
  githubPullRequestIdSchema,
  githubRateObservationSchema,
  githubReleaseByTagObservationSchema,
  githubReleaseByTagReadRequestSchema,
  githubReleaseFactSchema,
  githubReleaseId,
  githubReleaseIdSchema,
  githubReleaseTagName,
  githubReleaseTagNameSchema,
  githubRepositoryDatabaseId,
  githubRepositoryDatabaseIdSchema,
  githubRepositoryFactSchema,
  githubRepositoryId,
  githubRepositoryIdSchema,
  githubRepositoryReadRequestSchema,
  githubTagObjectFactSchema,
  githubTagObjectId,
  githubTagObjectIdSchema,
  githubTagObjectReadRequestSchema,
  githubTagPeelFactSchema,
  githubTagReferenceFactSchema,
  githubTagReferenceReadRequestSchema,
  githubTagTargetSchema,
} from '../src/index.ts'
import type {
  GitHubFailure,
  GitHubProjectBoardFingerprintSource,
  GitHubProjectBoardScanCandidate,
  GitHubProjectItemContent,
} from '../src/index.ts'
import {
  COMPLETE_SCAN,
  INBOX_OPTION_ID,
  INSTALLATION,
  INSTALLATION_PROFILE,
  INSTALLATION_REQUEST,
  ISSUE,
  OBSERVED_AT,
  PROJECT_ID,
  READY_OPTION_ID,
  REPOSITORY_DATABASE_ID,
  REPOSITORY_ID,
  SCAN_REQUEST,
  SCAN_WITHOUT_FINGERPRINT,
  STATUS_FIELD_ID,
} from './fixtures.ts'

const COMMIT_ID = githubCommitId('1'.repeat(40))
const OTHER_COMMIT_ID = githubCommitId('2'.repeat(64))
const TAG_NAME = githubReleaseTagName('saki-v0.1.0')
const TAG_ID = githubTagObjectId('T_tag')
const NEXT_TAG_ID = githubTagObjectId('T_next')

describe('GitHub id and request admission', () => {
  it('constructs every branded external identity through its owning package', () => {
    const cases: ReadonlyArray<readonly [(value: string) => string, string, { parse(value: unknown): string }]> = [
      [githubAppId, '8', githubAppIdSchema],
      [githubInstallationId, '9', githubInstallationIdSchema],
      [githubAccountId, 'O_account', githubAccountIdSchema],
      [githubRepositoryId, 'R_repository', githubRepositoryIdSchema],
      [githubRepositoryDatabaseId, '10', githubRepositoryDatabaseIdSchema],
      [githubProjectId, 'P_project', githubProjectIdSchema],
      [githubProjectFieldId, 'F_field', githubProjectFieldIdSchema],
      [githubProjectOptionId, 'option', githubProjectOptionIdSchema],
      [githubProjectItemId, 'I_item', githubProjectItemIdSchema],
      [githubIssueId, 'I_issue', githubIssueIdSchema],
      [githubPullRequestId, 'PR_pull', githubPullRequestIdSchema],
      [githubTagObjectId, 'T_tag', githubTagObjectIdSchema],
      [githubReleaseId, 'REL_release', githubReleaseIdSchema],
      [githubCommitId, 'a'.repeat(40), githubCommitIdSchema],
      [githubReleaseTagName, 'saki-v1.0.0-rc.1', githubReleaseTagNameSchema],
      [githubExternalOperationId, 'operation:one', githubExternalOperationIdSchema],
      [githubMutationKind, 'project-item-update', githubMutationKindSchema],
    ]
    for (const [construct, value, schema] of cases) {
      expect(construct(value)).toBe(value)
      expect(schema.parse(value)).toBe(value)
    }
  })

  it('rejects malformed node, decimal, Git object, tag, and operation identities', () => {
    expect(() => githubAccountId('bad\0node')).toThrow()
    expect(() => githubAppId('01')).toThrow()
    expect(() => githubInstallationId('0')).toThrow()
    expect(() => githubRepositoryDatabaseId('01')).toThrow()
    expect(() => githubCommitId('0'.repeat(40))).toThrow('all zeroes')
    expect(() => githubCommitId('A'.repeat(40))).toThrow()
    expect(() => githubReleaseTagName('v0.1.0')).toThrow()
    expect(() => githubExternalOperationId('bad operation')).toThrow()
    expect(() => githubMutationKind('BadKind')).toThrow()
  })

  it('admits every read and scan request without accepting unknown fields', () => {
    const repository = {
      installation: INSTALLATION_PROFILE,
      repositoryId: REPOSITORY_ID,
      repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    }
    const values: ReadonlyArray<readonly [{ parse(value: unknown): unknown }, object]> = [
      [githubInstallationReadRequestSchema, INSTALLATION_REQUEST],
      [githubRepositoryReadRequestSchema, { kind: 'repository', ...repository }],
      [githubIssueReadRequestSchema, { kind: 'issue', ...repository, issueId: ISSUE.id }],
      [githubProjectReadRequestSchema, { kind: 'project', installation: INSTALLATION_PROFILE, projectId: PROJECT_ID }],
      [githubTagReferenceReadRequestSchema, { kind: 'tag-reference', ...repository, tagName: TAG_NAME }],
      [githubTagObjectReadRequestSchema, {
        kind: 'tag-object', ...repository, target: { kind: 'tag', id: TAG_ID },
      }],
      [githubReleaseByTagReadRequestSchema, { kind: 'release-by-tag', ...repository, tagName: TAG_NAME }],
      [githubCommitReadRequestSchema, { kind: 'commit', ...repository, commitId: COMMIT_ID }],
      [githubCompareCommitsReadRequestSchema, {
        kind: 'compare-commits', ...repository, baseCommitId: COMMIT_ID, headCommitId: OTHER_COMMIT_ID,
      }],
      [githubProjectBoardScanRequestSchema, SCAN_REQUEST],
    ]
    for (const [schema, value] of values) expect(schema.parse(value)).toEqual(value)
    expect(githubInstallationProfileSchema.safeParse({ ...INSTALLATION_PROFILE, token: 'secret' }).success).toBe(false)
    expect(githubProjectBoardScanRequestSchema.safeParse({
      ...SCAN_REQUEST,
      requiredStatusOptionIds: [INBOX_OPTION_ID, INBOX_OPTION_ID],
    }).success).toBe(false)
    expect(githubProjectBoardScanRequestSchema.safeParse({
      ...SCAN_REQUEST,
      rateLimitReserve: -1,
    }).success).toBe(false)
  })
})

describe('raw GitHub facts', () => {
  it('admits every raw Project item content kind and rate observation kind', () => {
    const contents = [
      { kind: 'issue', issue: ISSUE },
      { kind: 'pull-request', id: githubPullRequestId('PR_one'), repositoryId: REPOSITORY_ID, url: 'https://github.com/o/r/pull/1' },
      { kind: 'pull-request', id: githubPullRequestId('PR_redacted') },
      { kind: 'draft-issue', title: 'Draft' },
      { kind: 'redacted' },
      { kind: 'other', typeName: 'RepositoryVulnerabilityAlert' },
    ] as const
    for (const content of contents) expect(githubProjectItemContentSchema.parse(content)).toEqual(content)

    const rates = [
      { kind: 'graphql', cost: 1, limit: 5_000, used: 1, remaining: 4_999, resetAt: 2, observedAt: 1 },
      { kind: 'rest', resource: 'core', limit: 5_000, used: 1, remaining: 4_999, resetAt: 2, observedAt: 1 },
      { kind: 'rest', resource: 'core', limit: 5_000, used: 5_000, remaining: 0, resetAt: 2, retryAfterMs: 3, observedAt: 1 },
      { kind: 'secondary-limit', observedAt: 1 },
      { kind: 'secondary-limit', retryAfterMs: 3, observedAt: 1 },
    ] as const
    for (const rate of rates) expect(githubRateObservationSchema.parse(rate)).toEqual(rate)
    for (const rate of [
      { kind: 'graphql', cost: 1, limit: 5_000, used: 5_001, remaining: 0, resetAt: 2, observedAt: 1 },
      { kind: 'graphql', cost: 1, limit: 5_000, used: 1, remaining: 5_000, resetAt: 2, observedAt: 1 },
      { kind: 'rest', resource: 'core', limit: 5_000, used: 5_001, remaining: 0, resetAt: 2, observedAt: 1 },
      { kind: 'rest', resource: 'core', limit: 5_000, used: 1, remaining: 5_000, resetAt: 2, observedAt: 1 },
    ]) {
      expect(githubRateObservationSchema.safeParse(rate).success).toBe(false)
    }
  })

  it('keeps repository URLs credential-free and field kinds closed', () => {
    expect(githubRepositoryFactSchema.parse(COMPLETE_SCAN.repository)).toEqual(COMPLETE_SCAN.repository)
    expect(githubProjectFactSchema.parse(COMPLETE_SCAN.project)).toEqual(COMPLETE_SCAN.project)
    expect(githubProjectFieldFactSchema.parse({
      kind: 'field', id: githubProjectFieldId('F_date'), name: 'Date', dataType: 'DATE',
    })).toMatchObject({ kind: 'field', dataType: 'DATE' })
    for (const url of [
      'http://github.com/o/r',
      'https://user@github.com/o/r',
      'https://user:password@github.com/o/r',
      'https://github.com/o/r#fragment',
    ]) {
      expect(githubRepositoryFactSchema.safeParse({ ...COMPLETE_SCAN.repository, url }).success).toBe(false)
    }
  })

  it('rejects duplicate installation permissions and repository access ids', () => {
    expect(githubInstallationFactSchema.safeParse({
      ...INSTALLATION,
      permissions: { ...INSTALLATION.permissions, repository: [
        INSTALLATION.permissions.repository[0]!, INSTALLATION.permissions.repository[0]!,
      ] },
    }).success).toBe(false)
    expect(githubInstallationFactSchema.safeParse({
      ...INSTALLATION,
      accessibleRepositoryIds: [REPOSITORY_ID, REPOSITORY_ID],
    }).success).toBe(false)
  })

  it('admits exact tags, recursive peeling, Releases, Commits, and compare facts', () => {
    const reference = {
      repositoryId: REPOSITORY_ID,
      tagName: TAG_NAME,
      ref: `refs/tags/${TAG_NAME}`,
      target: { kind: 'tag', id: TAG_ID },
      observedAt: OBSERVED_AT,
    } as const
    expect(githubTagReferenceFactSchema.parse(reference)).toEqual(reference)
    expect(githubTagTargetSchema.parse({ kind: 'commit', id: COMMIT_ID })).toEqual({ kind: 'commit', id: COMMIT_ID })
    expect(githubTagReferenceFactSchema.safeParse({ ...reference, ref: 'refs/tags/saki-vother' }).success).toBe(false)

    const firstTag = { id: TAG_ID, target: { kind: 'tag', id: NEXT_TAG_ID }, taggedAt: 1 } as const
    const secondTag = {
      id: NEXT_TAG_ID,
      target: { kind: 'commit', id: COMMIT_ID },
      url: 'https://github.com/o/r/git/tags/next',
    } as const
    expect(githubTagObjectFactSchema.parse(firstTag)).toEqual(firstTag)
    const peel = { repositoryId: REPOSITORY_ID, tagObjects: [firstTag, secondTag], commitId: COMMIT_ID, observedAt: 2 }
    expect(githubTagPeelFactSchema.parse(peel)).toEqual(peel)
    expect(githubTagPeelFactSchema.parse({ ...peel, tagObjects: [] })).toMatchObject({ tagObjects: [] })
    expect(githubTagPeelFactSchema.safeParse({ ...peel, tagObjects: [firstTag, firstTag] }).success).toBe(false)
    expect(githubTagPeelFactSchema.safeParse({
      ...peel,
      tagObjects: [{ ...firstTag, target: { kind: 'tag', id: githubTagObjectId('T_wrong') } }, secondTag],
    }).success).toBe(false)
    expect(githubTagPeelFactSchema.safeParse({
      ...peel,
      tagObjects: [firstTag, { ...secondTag, target: { kind: 'commit', id: OTHER_COMMIT_ID } }],
    }).success).toBe(false)
    const exactLimitChain = tagChain(GITHUB_TAG_PEEL_DEPTH_LIMIT)
    expect(githubTagPeelFactSchema.parse({
      repositoryId: REPOSITORY_ID,
      tagObjects: exactLimitChain,
      commitId: COMMIT_ID,
      observedAt: 2,
    })).toMatchObject({ tagObjects: exactLimitChain })
    expect(githubTagPeelFactSchema.safeParse({
      repositoryId: REPOSITORY_ID,
      tagObjects: tagChain(GITHUB_TAG_PEEL_DEPTH_LIMIT + 1),
      commitId: COMMIT_ID,
      observedAt: 2,
    }).success).toBe(false)

    const release = {
      id: githubReleaseId('REL_one'), repositoryId: REPOSITORY_ID, tagName: TAG_NAME,
      targetCommitish: 'master', draft: false, prerelease: false,
      url: 'https://github.com/o/r/releases/tag/saki-v0.1.0', publishedAt: 3, observedAt: 4,
    } as const
    expect(githubReleaseFactSchema.parse(release)).toEqual(release)
    expect(githubReleaseByTagObservationSchema.parse({ kind: 'present', release })).toEqual({ kind: 'present', release })
    expect(githubReleaseByTagObservationSchema.parse({
      kind: 'absent', repositoryId: REPOSITORY_ID, tagName: TAG_NAME, observedAt: 4,
    })).toMatchObject({ kind: 'absent' })

    const commit = {
      id: COMMIT_ID, repositoryId: REPOSITORY_ID,
      url: 'https://github.com/o/r/commit/111', committedAt: 1, observedAt: 2,
    }
    expect(githubCommitFactSchema.parse(commit)).toEqual(commit)
    for (const status of ['ahead', 'behind', 'identical', 'diverged'] as const) {
      expect(githubCommitComparisonFactSchema.parse({
        repositoryId: REPOSITORY_ID,
        baseCommitId: COMMIT_ID,
        headCommitId: OTHER_COMMIT_ID,
        status,
        aheadBy: status === 'ahead' ? 1 : 0,
        behindBy: status === 'behind' ? 1 : 0,
        mergeBaseCommitId: COMMIT_ID,
        observedAt: 2,
      })).toMatchObject({ status })
    }
  })
})

describe('complete Project-board candidate', () => {
  it('rejects mismatched ownership and inaccessible selected repositories', () => {
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      project: { ...SCAN_WITHOUT_FINGERPRINT.project, ownerAccountId: githubAccountId('O_other') },
    })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      installation: { ...INSTALLATION, accessibleRepositoryIds: [] },
    })
    expectCandidateSuccess({
      ...SCAN_WITHOUT_FINGERPRINT,
      installation: { ...INSTALLATION, repositorySelection: 'all', accessibleRepositoryIds: [] },
    })
  })

  it('rejects duplicate or invalid fields, items, orders, and open Issues', () => {
    const status = SCAN_WITHOUT_FINGERPRINT.fields[0]!
    const item = SCAN_WITHOUT_FINGERPRINT.items[0]!
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, fields: [status, status] })
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, statusFieldId: githubProjectFieldId('F_missing') })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      fields: [{ kind: 'field', id: STATUS_FIELD_ID, name: 'Status', dataType: 'TEXT' }],
    })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      items: [item, { ...item, apiOrder: 1 }],
      fences: withCounts(2, 1),
    })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      items: [item, { ...item, id: githubProjectItemId('PVTI_two'), apiOrder: 0 }],
      fences: withCounts(2, 1),
    })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      items: [{ ...item, projectId: githubProjectId('P_other') }],
    })
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, items: [{ ...item, apiOrder: 2 }] })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      openIssues: [ISSUE, ISSUE],
      fences: withCounts(1, 2),
    })
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, openIssues: [{ ...ISSUE, state: 'closed' }] })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      openIssues: [{ ...ISSUE, repositoryId: githubRepositoryId('R_other') }],
    })
  })

  it.each([
    ['Repository node id', { repositoryId: githubRepositoryId('R_substituted') }],
    ['Repository database id', { repositoryDatabaseId: githubRepositoryDatabaseId('4243') }],
    ['number', { number: ISSUE.number + 1 }],
    ['state', { state: 'closed' as const }],
    ['title', { title: 'Substituted title' }],
    ['URL', { url: 'https://github.com/breakfast/saki/issues/999' }],
    ['update time', { updatedAt: ISSUE.updatedAt + 1 }],
  ])('rejects a conflicting %s for one Issue across Project items and open Issues', (_subject, override) => {
    const retainedItem = SCAN_WITHOUT_FINGERPRINT.items[0]!
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      items: [{
        ...retainedItem,
        content: { kind: 'issue', issue: { ...ISSUE, ...override } },
      }],
    })
  })

  it('rejects distinct configured-Repository Issues with one Issue number', () => {
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      openIssues: [ISSUE, { ...ISSUE, id: githubIssueId('I_substituted') }],
      fences: withCounts(1, 2),
    })
    const retainedItem = SCAN_WITHOUT_FINGERPRINT.items[0]!
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      items: [{
        ...retainedItem,
        content: { kind: 'issue', issue: { ...ISSUE, id: githubIssueId('I_substituted') } },
      }],
    })
  })

  it('rejects each unstable fence member, mismatched bounds, and stale fingerprints', () => {
    for (const after of [
      { ...SCAN_WITHOUT_FINGERPRINT.fences.after, projectUpdatedAt: 1 },
      { ...SCAN_WITHOUT_FINGERPRINT.fences.after, repositoryUpdatedAt: 1 },
      { ...SCAN_WITHOUT_FINGERPRINT.fences.after, projectItemCount: 2 },
      { ...SCAN_WITHOUT_FINGERPRINT.fences.after, openIssueCount: 2 },
    ]) {
      expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, fences: { ...SCAN_WITHOUT_FINGERPRINT.fences, after } })
    }
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, fences: withCounts(2, 1) })
    expectCandidateFailure({ ...SCAN_WITHOUT_FINGERPRINT, fences: withCounts(1, 2) })
    expect(githubProjectBoardScanCandidateSchema.safeParse({
      ...COMPLETE_SCAN,
      fingerprint: { version: 1, digest: 'f'.repeat(64) },
    }).success).toBe(false)
    expect(githubProjectBoardScanCandidateSchema.safeParse({ ...COMPLETE_SCAN, cursor: 'must-not-escape' }).success)
      .toBe(false)
  })

  it('admits the exact rate-observation limit and rejects one more', () => {
    const rateObservations = Array.from({ length: GITHUB_RATE_OBSERVATION_LIMIT }, (_, observedAt) => ({
      kind: 'graphql' as const,
      cost: 1,
      limit: 5_000,
      used: 1,
      remaining: 4_999,
      resetAt: OBSERVED_AT + 3_600_000,
      observedAt,
    }))
    expectCandidateSuccess({ ...SCAN_WITHOUT_FINGERPRINT, rateObservations })
    expectCandidateFailure({
      ...SCAN_WITHOUT_FINGERPRINT,
      rateObservations: [...rateObservations, { ...rateObservations[0]!, observedAt: GITHUB_RATE_OBSERVATION_LIMIT }],
    })
  })

  it('fingerprints every raw content kind and only semantic observations', () => {
    const items = ([
      SCAN_WITHOUT_FINGERPRINT.items[0]!,
      item('PVTI_pr', 1, {
        kind: 'pull-request', id: githubPullRequestId('PR_one'), repositoryId: REPOSITORY_ID,
      }),
      item('PVTI_pr_redacted', 2, { kind: 'pull-request', id: githubPullRequestId('PR_two') }),
      item('PVTI_draft', 3, { kind: 'draft-issue', title: 'Draft' }),
      item('PVTI_redacted', 4, { kind: 'redacted' }),
      item('PVTI_other', 5, { kind: 'other', typeName: 'OtherContent' }),
    ])
    const source: GitHubProjectBoardFingerprintSource = {
      ...SCAN_WITHOUT_FINGERPRINT,
      fields: [
        { kind: 'field', id: githubProjectFieldId('Z_field'), name: 'Z', dataType: 'TEXT' },
        {
          kind: 'single-select', id: STATUS_FIELD_ID, name: 'Status',
          options: [{ id: READY_OPTION_ID, name: 'Ready' }, { id: INBOX_OPTION_ID, name: 'Inbox' }],
        },
        { kind: 'field', id: githubProjectFieldId('Z_field'), name: 'duplicate for equality', dataType: 'TEXT' },
      ],
      items,
      openIssues: [ISSUE, { ...ISSUE, id: githubIssueId('A_issue'), number: 1 }],
      fences: withCounts(items.length, 2),
    }
    expect(computeGitHubProjectBoardFingerprint(source).digest).toMatch(/^[0-9a-f]{64}$/)
    expect(computeGitHubProjectBoardFingerprint({
      ...source,
      fields: [...source.fields].reverse(),
    })).toEqual(computeGitHubProjectBoardFingerprint(source))
    expect(computeGitHubProjectBoardFingerprint({
      ...source,
      openIssues: [...source.openIssues].reverse(),
    })).not.toEqual(computeGitHubProjectBoardFingerprint(source))

    const hostile = item('PVTI_hostile', 0, { kind: 'future' } as unknown as GitHubProjectItemContent)
    expect(() => computeGitHubProjectBoardFingerprint({ ...SCAN_WITHOUT_FINGERPRINT, items: [hostile] }))
      .toThrow('unhandled GitHub Project item content')
  })
})

describe('closed failures, mutation vocabulary, and invariant companion', () => {
  it('admits every closed safe failure and exposes only admitted data on the typed error', () => {
    const failures: readonly GitHubFailure[] = [
      { code: 'cancelled' },
      { code: 'auth-unavailable' },
      { code: 'auth-unavailable', credentialRef: INSTALLATION_PROFILE.privateKeyRef },
      { code: 'permission-mismatch', permission: 'contents', required: 'none', observed: 'write', requestId: 'request/1' },
      {
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: STATUS_FIELD_ID,
      },
      {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: STATUS_FIELD_ID,
        missingRequiredStatusOptionIds: [INBOX_OPTION_ID, READY_OPTION_ID],
      },
      { code: 'not-found', resource: 'Repository', requestId: 'request/2' },
      { code: 'invalid-external-response', operation: 'project-board', requestId: 'request/3' },
      { code: 'primary-rate-limit', resetAt: 4, requestId: 'request/4' },
      { code: 'secondary-rate-limit', retryAfterMs: 5, requestId: 'request/5' },
      { code: 'transient-transport', retryAfterMs: 6, requestId: 'request/6' },
      { code: 'permanent-rejection', status: 422, requestId: 'request/7' },
    ]
    for (const failure of failures) {
      expect(githubFailureSchema.parse(failure)).toEqual(failure)
      const error = new GitHubProviderError(failure)
      expect(error.name).toBe('GitHubProviderError')
      expect(error.failure).toEqual(failure)
    }
    expect(githubFailureSchema.safeParse({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: STATUS_FIELD_ID,
      missingRequiredStatusOptionIds: [],
    }).success).toBe(false)
    expect(githubFailureSchema.safeParse({
      code: 'mapping-mismatch',
      reason: 'required-options-missing',
      statusFieldId: STATUS_FIELD_ID,
      missingRequiredStatusOptionIds: [INBOX_OPTION_ID, INBOX_OPTION_ID],
    }).success).toBe(false)
    expect(() => new GitHubProviderError({ code: 'cancelled', raw: 'secret' } as never)).toThrow()
  })

  it('keeps mutation identity and inspection states provider-neutral', () => {
    const identity = {
      operationId: githubExternalOperationId('operation:27'),
      kind: githubMutationKind('project-item-update'),
      targetFingerprint: 'a'.repeat(64),
    }
    expect(githubMutationIdentitySchema.parse(identity)).toEqual(identity)
    const inspections = [
      { state: 'pending', identity, observedAt: 1 },
      { state: 'observed', identity, observedAt: 1 },
      { state: 'absent', identity, observedAt: 1 },
      { state: 'unknown', identity, observedAt: 1 },
      { state: 'error', identity, failure: { code: 'cancelled' }, observedAt: 1 },
    ] as const
    for (const inspection of inspections) {
      expect(githubMutationInspectionSchema.parse(inspection)).toEqual(inspection)
    }
  })

})

function signed(source: GitHubProjectBoardFingerprintSource): GitHubProjectBoardScanCandidate {
  return { ...source, fingerprint: computeGitHubProjectBoardFingerprint(source) }
}

function expectCandidateFailure(source: GitHubProjectBoardFingerprintSource): void {
  expect(githubProjectBoardScanCandidateSchema.safeParse(signed(source)).success).toBe(false)
}

function expectCandidateSuccess(source: GitHubProjectBoardFingerprintSource): void {
  expect(githubProjectBoardScanCandidateSchema.parse(signed(source))).toEqual(signed(source))
}

function withCounts(projectItemCount: number, openIssueCount: number) {
  const fence = { ...SCAN_WITHOUT_FINGERPRINT.fences.before, projectItemCount, openIssueCount }
  return { before: fence, after: fence }
}

function item(id: string, apiOrder: number, content: GitHubProjectItemContent) {
  return {
    id: githubProjectItemId(id),
    projectId: PROJECT_ID,
    content,
    archived: false,
    apiOrder,
    updatedAt: OBSERVED_AT,
  }
}

function tagChain(length: number) {
  const ids = Array.from({ length }, (_, index) => githubTagObjectId(`T_limit_${index}`))
  return ids.map((id, index) => ({
    id,
    target: index === ids.length - 1
      ? { kind: 'commit' as const, id: COMMIT_ID }
      : { kind: 'tag' as const, id: ids[index + 1]! },
  }))
}
