import { describe, expect, it } from 'vitest'
import type {
  GitHubCheckRunId,
  GitHubCommitCiFact,
  GitHubCommitId,
  GitHubCommitStatusId,
  GitHubRepositoryId,
  GitHubWorkflowId,
  GitHubWorkflowRunId,
} from '@breakfastdapaidang/saki-github'
import { summarizeCommitCi } from '../src/delivery-evidence.ts'

const REPOSITORY_ID = 'R_delivery_evidence' as GitHubRepositoryId
const COMMIT_ID = '1234567890abcdef1234567890abcdef12345678' as GitHubCommitId

describe('summarizeCommitCi', () => {
  it('keeps an exact Commit with no emitted signal unavailable', () => {
    expect(summarizeCommitCi(fact())).toEqual({
      state: 'unavailable',
      signalCount: 0,
      observedAt: 1_000,
    })
  })

  it('selects the newest run for each workflow and event', () => {
    expect(summarizeCommitCi(fact({
      workflowRuns: [
        workflowRun({ id: '100', runNumber: 4, conclusion: 'failure', updatedAt: 800 }),
        workflowRun({ id: '101', runNumber: 5, conclusion: 'success', updatedAt: 900 }),
        workflowRun({
          id: '102',
          workflowId: '12',
          event: 'pull_request',
          runNumber: 2,
          conclusion: 'neutral',
          updatedAt: 950,
        }),
      ],
    }))).toEqual({
      state: 'successful',
      signalCount: 2,
      observedAt: 1_000,
    })
  })

  it('orders same-workflow reruns by attempt, update time, and id', () => {
    expect(summarizeCommitCi(fact({
      workflowRuns: [
        workflowRun({ id: '100', runNumber: 5, runAttempt: 1, conclusion: 'failure', updatedAt: 700 }),
        workflowRun({ id: '101', runNumber: 5, runAttempt: 2, conclusion: 'failure', updatedAt: 600 }),
        workflowRun({ id: '102', runNumber: 5, runAttempt: 2, conclusion: 'failure', updatedAt: 800 }),
        workflowRun({ id: '103', runNumber: 5, runAttempt: 2, conclusion: 'success', updatedAt: 800 }),
        workflowRun({ id: '099', runNumber: 4, runAttempt: 9, conclusion: 'failure', updatedAt: 900 }),
      ],
    }))).toMatchObject({ state: 'successful', signalCount: 1 })
  })

  it('reports pending while any selected signal is active', () => {
    expect(summarizeCommitCi(fact({
      workflowRuns: [workflowRun({ status: 'in-progress', conclusion: undefined })],
      commitStatuses: [{
        id: '21' as GitHubCommitStatusId,
        context: 'deployment',
        state: 'success',
        createdAt: 700,
        updatedAt: 800,
      }],
    }))).toMatchObject({ state: 'pending', signalCount: 2 })
  })

  it('keeps an active check run pending', () => {
    expect(summarizeCommitCi(fact({
      checkRuns: [{
        id: '30' as GitHubCheckRunId,
        name: 'build',
        status: 'queued',
        url: 'https://github.com/o/r/runs/30',
      }],
    }))).toMatchObject({ state: 'pending', signalCount: 1 })
  })

  it('gives a failure precedence over pending and canceled signals', () => {
    expect(summarizeCommitCi(fact({
      workflowRuns: [workflowRun({ status: 'in-progress', conclusion: undefined })],
      checkRuns: [{
        id: '31' as GitHubCheckRunId,
        name: 'lint',
        status: 'completed',
        conclusion: 'cancelled',
        startedAt: 600,
        completedAt: 700,
        url: 'https://github.com/o/r/runs/31',
      }],
      commitStatuses: [{
        id: '41' as GitHubCommitStatusId,
        context: 'security',
        state: 'error',
        createdAt: 800,
        updatedAt: 900,
      }],
    }))).toMatchObject({ state: 'failed', signalCount: 3 })
  })

  it('distinguishes cancellation when no failure-like signal exists', () => {
    expect(summarizeCommitCi(fact({
      checkRuns: [{
        id: '32' as GitHubCheckRunId,
        name: 'build',
        status: 'completed',
        conclusion: 'cancelled',
        startedAt: 600,
        completedAt: 700,
        url: 'https://github.com/o/r/runs/32',
      }],
    }))).toMatchObject({ state: 'canceled', signalCount: 1 })
  })

  it.each(['action-required', 'failure', 'stale', 'startup-failure', 'timed-out'] as const)(
    'treats the %s conclusion as failed',
    (conclusion) => {
      expect(summarizeCommitCi(fact({ workflowRuns: [workflowRun({ conclusion })] })))
        .toMatchObject({ state: 'failed' })
    },
  )

  it('accepts only terminal success, neutral, or skipped signals', () => {
    expect(summarizeCommitCi(fact({
      workflowRuns: [workflowRun({ conclusion: 'success' })],
      checkRuns: [{
        id: '33' as GitHubCheckRunId,
        name: 'optional',
        status: 'completed',
        conclusion: 'skipped',
        startedAt: 600,
        completedAt: 700,
        url: 'https://github.com/o/r/runs/33',
      }],
      commitStatuses: [{
        id: '42' as GitHubCommitStatusId,
        context: 'coverage',
        state: 'success',
        createdAt: 800,
        updatedAt: 900,
      }],
    }))).toEqual({
      state: 'successful',
      signalCount: 3,
      observedAt: 1_000,
    })
  })
})

function fact(values: Partial<GitHubCommitCiFact> = {}): GitHubCommitCiFact {
  return {
    repositoryId: REPOSITORY_ID,
    commitId: COMMIT_ID,
    workflowRuns: [],
    checkRuns: [],
    commitStatuses: [],
    observedAt: 1_000,
    ...values,
  }
}

function workflowRun(values: {
  readonly id?: string
  readonly workflowId?: string
  readonly event?: string
  readonly runNumber?: number
  readonly runAttempt?: number
  readonly status?: 'queued' | 'in-progress' | 'completed' | 'pending' | 'requested' | 'waiting'
  readonly conclusion?: GitHubCommitCiFact['workflowRuns'][number]['conclusion']
  readonly updatedAt?: number
} = {}): GitHubCommitCiFact['workflowRuns'][number] {
  const status = values.status ?? 'completed'
  return {
    id: (values.id ?? '100') as GitHubWorkflowRunId,
    workflowId: (values.workflowId ?? '11') as GitHubWorkflowId,
    name: 'CI',
    event: values.event ?? 'push',
    runNumber: values.runNumber ?? 1,
    runAttempt: values.runAttempt ?? 1,
    status,
    ...(values.conclusion === undefined ? {} : { conclusion: values.conclusion }),
    url: `https://github.com/o/r/actions/runs/${values.id ?? '100'}`,
    createdAt: 500,
    updatedAt: values.updatedAt ?? 700,
  }
}
