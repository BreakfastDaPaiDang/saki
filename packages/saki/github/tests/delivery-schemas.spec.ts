import { describe, expect, it } from 'vitest'
import {
  GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT,
  GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT,
  githubCheckRunId,
  githubCheckRunFactSchema,
  githubBranchHeadFactSchema,
  githubBranchHeadReadRequestSchema,
  githubCommitCiFactSchema,
  githubCommitCiReadRequestSchema,
  githubCommitId,
  githubPublicCommitReadRequestSchema,
  githubCommitStatusId,
  githubExternalOperationId,
  githubMilestoneFactSchema,
  githubMilestoneId,
  githubMilestoneReadRequestSchema,
  githubPullRequestAssociationFactSchema,
  githubPullRequestAssociationReadRequestSchema,
  githubPullRequestCreateInspectionSchema,
  githubPullRequestCreateMarkerId,
  githubPullRequestCreateRequestSchema,
  githubPullRequestCreateTextPreparationSchema,
  githubPullRequestFactSchema,
  githubPullRequestId,
  githubPullRequestReviewId,
  githubPullRequestReviewsFactSchema,
  githubPullRequestReviewsReadRequestSchema,
  githubPullRequestReadRequestSchema,
  githubRepositoryId,
  githubWorkflowRunId,
  githubWorkflowId,
} from '../src/index.ts'
import {
  INSTALLATION_PROFILE,
  ISSUE,
  OBSERVED_AT,
  REPOSITORY_DATABASE_ID,
  REPOSITORY_ID,
} from './fixtures.ts'

const HEAD_COMMIT_ID = githubCommitId('a'.repeat(40))
const BASE_COMMIT_ID = githubCommitId('b'.repeat(40))
const PULL_REQUEST_ID = githubPullRequestId('PR_delivery')
const MARKER_ID = githubPullRequestCreateMarkerId(`pull-request-marker-${'1'.repeat(64)}`)
const MARKER_SUFFIX = `\n<!-- saki-pull-request:${MARKER_ID} -->\n`
const repository = {
  installation: INSTALLATION_PROFILE,
  repositoryId: REPOSITORY_ID,
  repositoryDatabaseId: REPOSITORY_DATABASE_ID,
}
const pullRequest = {
  id: PULL_REQUEST_ID,
  repositoryId: REPOSITORY_ID,
  number: 75,
  state: 'open',
  merged: false,
  draft: false,
  title: 'Deliver issue 32',
  url: 'https://github.com/breakfast/saki/pull/75',
  head: { repositoryId: REPOSITORY_ID, ref: 'feature/issue-32', commitId: HEAD_COMMIT_ID },
  base: { repositoryId: REPOSITORY_ID, ref: 'master', commitId: BASE_COMMIT_ID },
  authorAccountId: INSTALLATION_PROFILE.accountId,
  updatedAt: OBSERVED_AT - 1,
  observedAt: OBSERVED_AT,
} as const

function preparePullRequestText(title: string, body: string) {
  return githubPullRequestCreateTextPreparationSchema.safeParse({ markerId: MARKER_ID, title, body })
}

function pullRequestBodySourceAtCompleteBytes(targetBytes: number, multibyte = false): string {
  const sourceBytes = targetBytes - Buffer.byteLength(MARKER_SUFFIX, 'utf8')
  const source = 'x'.repeat(sourceBytes)
  return multibyte ? `${source.slice(0, -3)}界` : source
}

describe('GitHub delivery request admission', () => {
  it('admits exact PR, association, CI, and Milestone reads', () => {
    const cases = [
      [githubPublicCommitReadRequestSchema, {
        kind: 'public-commit', repositoryId: REPOSITORY_ID,
        repositoryDatabaseId: REPOSITORY_DATABASE_ID,
        repositoryNameWithOwner: 'deepseek-ai/deepseek-harness', commitId: HEAD_COMMIT_ID,
      }],
      [githubPullRequestReadRequestSchema, {
        kind: 'pull-request', ...repository, pullRequestId: PULL_REQUEST_ID, pullRequestNumber: 75,
      }],
      [githubPullRequestAssociationReadRequestSchema, {
        kind: 'pull-request-association', ...repository,
        headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: HEAD_COMMIT_ID,
      }],
      [githubCommitCiReadRequestSchema, {
        kind: 'commit-ci', ...repository, commitId: HEAD_COMMIT_ID,
      }],
      [githubMilestoneReadRequestSchema, {
        kind: 'milestone', ...repository,
        milestoneId: githubMilestoneId('MI_010'), milestoneNumber: 1,
      }],
      [githubBranchHeadReadRequestSchema, {
        kind: 'branch-head', ...repository, branch: 'feature/issue-32',
      }],
    ] as const
    for (const [schema, value] of cases) expect(schema.parse(value)).toEqual(value)
    expect(githubPublicCommitReadRequestSchema.safeParse({
      kind: 'public-commit', ...repository,
      repositoryNameWithOwner: 'deepseek-ai/deepseek-harness', commitId: HEAD_COMMIT_ID,
    }).success).toBe(false)
    expect(githubPullRequestAssociationReadRequestSchema.safeParse({
      kind: 'pull-request-association', ...repository,
      headRef: 'bad\0ref', baseRef: 'master', expectedHeadCommitId: HEAD_COMMIT_ID,
    }).success).toBe(false)
  })

  it('admits only a marker-bound complete PR-create request', () => {
    const request = {
      kind: 'pull-request-create' as const,
      operationId: githubExternalOperationId('operation:pull-request:32'),
      ...repository,
      markerId: MARKER_ID,
      headRef: 'feature/issue-32',
      baseRef: 'master',
      expectedHeadCommitId: HEAD_COMMIT_ID,
      title: 'Deliver issue 32',
      body: `Implements the delivery slice.\n\n<!-- saki-pull-request:${MARKER_ID} -->\n`,
    }
    expect(githubPullRequestCreateRequestSchema.parse(request)).toEqual(request)
    expect(githubPullRequestCreateRequestSchema.safeParse({
      ...request,
      body: 'Marker omitted.\n',
    }).success).toBe(false)
    expect(githubPullRequestCreateRequestSchema.safeParse({
      ...request,
      body: `Wrong marker.\n\n<!-- saki-pull-request:pull-request-marker-${'2'.repeat(64)} -->\n`,
    }).success).toBe(false)
    expect(githubPullRequestCreateRequestSchema.safeParse({
      ...request,
      baseRef: request.headRef,
    }).success).toBe(false)
  })

  it('bounds the complete rendered PR body rather than only its source text', () => {
    const exact = pullRequestBodySourceAtCompleteBytes(GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT)
    const exactMultibyte = pullRequestBodySourceAtCompleteBytes(
      GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT,
      true,
    )
    const preparedExact = githubPullRequestCreateTextPreparationSchema.parse({
      markerId: MARKER_ID,
      title: 'Deliver issue 32',
      body: exact,
    })
    const preparedExactMultibyte = githubPullRequestCreateTextPreparationSchema.parse({
      markerId: MARKER_ID,
      title: 'Deliver issue 32',
      body: exactMultibyte,
    })

    expect(Buffer.byteLength(preparedExact.body, 'utf8'))
      .toBe(GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT)
    expect(Buffer.byteLength(preparedExactMultibyte.body, 'utf8'))
      .toBe(GITHUB_PULL_REQUEST_CREATE_BODY_UTF8_LIMIT)
    expect(preparePullRequestText('Deliver issue 32', `${exact}x`).success).toBe(false)
  })

  it('prepares trimmed source text with one exact final marker', () => {
    expect(githubPullRequestCreateTextPreparationSchema.parse({
      markerId: MARKER_ID,
      title: 'Deliver issue 32',
      body: 'Body with trailing whitespace. \r\n\t',
    })).toEqual({
      markerId: MARKER_ID,
      title: 'Deliver issue 32',
      body: `Body with trailing whitespace.\n<!-- saki-pull-request:${MARKER_ID} -->\n`,
    })
  })

  it('admits title boundaries by UTF-8 bytes, including multibyte text', () => {
    const exactAscii = 'x'.repeat(GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT)
    const exactMultibyte = `${'界'.repeat(341)}x`
    expect(Buffer.byteLength(exactMultibyte, 'utf8')).toBe(GITHUB_PULL_REQUEST_CREATE_TITLE_UTF8_LIMIT)

    expect(preparePullRequestText(exactAscii, 'Body').success).toBe(true)
    expect(preparePullRequestText(exactMultibyte, 'Body').success).toBe(true)
    expect(preparePullRequestText(`${exactAscii}x`, 'Body').success).toBe(false)
    expect(preparePullRequestText(`${exactMultibyte}x`, 'Body').success).toBe(false)
  })

  it.each([
    ['blank title', '   ', 'Body'],
    ['title newline', 'Title\ncontinued', 'Body'],
    ['title carriage return', 'Title\rcontinued', 'Body'],
    ['title NUL', 'Title\0continued', 'Body'],
    ['title DEL', 'Title\x7fcontinued', 'Body'],
    ['title malformed Unicode', 'Title\ud800', 'Body'],
    ['body carriage return', 'Title', 'Body\rcontinued'],
    ['body NUL', 'Title', 'Body\0continued'],
    ['body DEL', 'Title', 'Body\x7fcontinued'],
    ['body malformed Unicode', 'Title', 'Body\ud800'],
    ['duplicate marker', 'Title', `Body\n<!-- saki-pull-request:${MARKER_ID} -->`],
  ])('rejects %s before Pull Request dispatch', (_case, title, body) => {
    expect(preparePullRequestText(title, body).success).toBe(false)
  })

  it('admits an exact branch head or explicit absence', () => {
    expect(githubBranchHeadFactSchema.parse({
      state: 'present', repositoryId: REPOSITORY_ID, branch: 'feature/issue-32',
      commitId: HEAD_COMMIT_ID, observedAt: OBSERVED_AT,
    })).toMatchObject({ state: 'present', commitId: HEAD_COMMIT_ID })
    expect(githubBranchHeadFactSchema.parse({
      state: 'absent', repositoryId: REPOSITORY_ID, branch: 'feature/issue-32', observedAt: OBSERVED_AT,
    })).toMatchObject({ state: 'absent' })
  })
})

describe('GitHub delivery facts', () => {
  it('allows incomplete check timestamps but rejects completion before start', () => {
    const check = {
      id: githubCheckRunId('201'), name: 'CI', status: 'completed', conclusion: 'success',
      url: 'https://github.com/breakfast/saki/runs/201',
    }
    for (const timestamps of [{}, { startedAt: 2 }, { completedAt: 1 }, { startedAt: 2, completedAt: 2 }]) {
      expect(githubCheckRunFactSchema.parse({ ...check, ...timestamps })).toEqual({ ...check, ...timestamps })
    }
    expect(githubCheckRunFactSchema.safeParse({ ...check, startedAt: 2, completedAt: 1 }).success).toBe(false)
  })

  it('admits one exact Pull Request review collection without inventing nullable fields', () => {
    const request = {
      kind: 'pull-request-reviews' as const,
      ...repository,
      pullRequestId: PULL_REQUEST_ID,
      pullRequestNumber: 75,
    }
    expect(githubPullRequestReviewsReadRequestSchema.parse(request)).toEqual(request)

    const fact = {
      repositoryId: REPOSITORY_ID,
      pullRequestId: PULL_REQUEST_ID,
      pullRequestNumber: 75,
      headCommitId: HEAD_COMMIT_ID,
      pullRequestUpdatedAt: OBSERVED_AT - 1,
      reviews: [{
        id: githubPullRequestReviewId('PRR_review'),
        state: 'pending',
        url: 'https://github.com/breakfast/saki/pull/75#pullrequestreview-1',
        updatedAt: OBSERVED_AT - 1,
      }],
      observedAt: OBSERVED_AT,
    } as const
    expect(githubPullRequestReviewsFactSchema.parse(fact)).toEqual(fact)
    expect(githubPullRequestReviewsFactSchema.safeParse({
      ...fact,
      reviews: [fact.reviews[0], fact.reviews[0]],
    }).success).toBe(false)
    expect(githubPullRequestReviewsFactSchema.safeParse({
      ...fact,
      reviews: [{ ...fact.reviews[0], url: 'https://token@example.test/review' }],
    }).success).toBe(false)
    expect(githubPullRequestReviewsReadRequestSchema.safeParse({ ...request, extra: true }).success).toBe(false)
  })

  it('keeps a PR bound to exact Repository, refs, and commits', () => {
    expect(githubPullRequestFactSchema.parse(pullRequest)).toEqual(pullRequest)
    expect(githubPullRequestFactSchema.safeParse({
      ...pullRequest,
      base: { ...pullRequest.base, repositoryId: githubRepositoryId('R_foreign') },
    }).success).toBe(false)
    expect(githubPullRequestFactSchema.safeParse({ ...pullRequest, merged: true, state: 'open' }).success).toBe(false)
  })

  it('classifies complete PR association without hiding duplicate candidates', () => {
    expect(githubPullRequestAssociationFactSchema.parse({
      state: 'unique', pullRequest, observedAt: OBSERVED_AT,
    })).toMatchObject({ state: 'unique' })
    expect(githubPullRequestAssociationFactSchema.parse({
      state: 'absent', repositoryId: REPOSITORY_ID,
      headRef: 'feature/issue-32', baseRef: 'master', expectedHeadCommitId: HEAD_COMMIT_ID,
      observedAt: OBSERVED_AT,
    })).toMatchObject({ state: 'absent' })
    expect(githubPullRequestAssociationFactSchema.safeParse({
      state: 'duplicate-conflict', pullRequests: [pullRequest], observedAt: OBSERVED_AT,
    }).success).toBe(false)
  })

  it('admits raw CI sources while preserving exact Commit identity', () => {
    const ci = {
      repositoryId: REPOSITORY_ID,
      commitId: HEAD_COMMIT_ID,
      workflowRuns: [{
        id: githubWorkflowRunId('101'), workflowId: githubWorkflowId('11'), name: 'CI', event: 'pull_request',
        runNumber: 32, runAttempt: 1,
        status: 'completed', conclusion: 'success',
        url: 'https://github.com/breakfast/saki/actions/runs/101',
        createdAt: OBSERVED_AT - 2, updatedAt: OBSERVED_AT - 1,
      }],
      checkRuns: [{
        id: githubCheckRunId('201'), name: 'all checks passed', status: 'completed', conclusion: 'success',
        url: 'https://github.com/breakfast/saki/runs/201',
        startedAt: OBSERVED_AT - 2, completedAt: OBSERVED_AT - 1,
      }],
      commitStatuses: [{
        id: githubCommitStatusId('301'), context: 'external/ci', state: 'success',
        targetUrl: 'https://ci.example.test/build/301',
        createdAt: OBSERVED_AT - 2, updatedAt: OBSERVED_AT - 1,
      }],
      observedAt: OBSERVED_AT,
    } as const
    expect(githubCommitCiFactSchema.parse(ci)).toEqual(ci)
    expect(githubCommitCiFactSchema.safeParse({ ...ci, workflowRuns: [ci.workflowRuns[0], ci.workflowRuns[0]] }).success)
      .toBe(false)
  })

  it('admits a complete Milestone Issue scope and rejects foreign Issues', () => {
    const milestone = {
      id: githubMilestoneId('MI_010'), repositoryId: REPOSITORY_ID, number: 1,
      state: 'open', title: '0.1.0', description: 'First release',
      dueOn: OBSERVED_AT + 1_000, url: 'https://github.com/breakfast/saki/milestone/1',
      updatedAt: OBSERVED_AT - 1, issues: [ISSUE], observedAt: OBSERVED_AT,
    } as const
    expect(githubMilestoneFactSchema.parse(milestone)).toEqual(milestone)
    expect(githubMilestoneFactSchema.safeParse({
      ...milestone,
      issues: [{ ...ISSUE, repositoryId: githubRepositoryId('R_foreign') }],
    }).success).toBe(false)
    expect(githubMilestoneFactSchema.safeParse({ ...milestone, issues: [ISSUE, ISSUE] }).success).toBe(false)
  })

  it('admits only repository-bound PR-create inspection outcomes', () => {
    const base = {
      snapshot: {
        repositoryId: REPOSITORY_ID,
        repositoryDatabaseId: REPOSITORY_DATABASE_ID,
        outcome: { state: 'unique-pull-request', pullRequest },
      },
      observedAt: OBSERVED_AT,
    } as const
    expect(githubPullRequestCreateInspectionSchema.parse(base)).toEqual(base)
    expect(githubPullRequestCreateInspectionSchema.safeParse({
      ...base,
      snapshot: { ...base.snapshot, repositoryId: githubRepositoryId('R_foreign') },
    }).success).toBe(false)
    for (const state of [
      'absent-complete', 'marker-removed', 'known-pull-request-absent',
      'identity-conflict', 'multiple-matches', 'incomplete',
    ] as const) {
      expect(githubPullRequestCreateInspectionSchema.parse({
        ...base,
        snapshot: { ...base.snapshot, outcome: { state } },
      })).toMatchObject({ snapshot: { outcome: { state } } })
    }
  })
})
