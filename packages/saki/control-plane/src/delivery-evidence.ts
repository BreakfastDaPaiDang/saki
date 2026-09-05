/** Pure policy helpers for exact-Commit delivery evidence. @module @breakfastdapaidang/saki-control-plane/src/delivery-evidence */

import type {
  GitHubCommitCiFact,
  GitHubWorkflowRunFact,
} from '@breakfastdapaidang/saki-github'

/** Product-level state derived from one complete exact-Commit CI observation. */
export interface SakiCommitCiSummary {
  readonly state: 'pending' | 'successful' | 'failed' | 'canceled' | 'unavailable'
  readonly signalCount: number
  readonly observedAt: number
}

/**
 * Derive the current CI state without treating an empty result as success.
 * @param fact - complete raw Actions, Checks, and commit-status facts for one Commit.
 * @returns one closed product state and the number of current signals considered.
 */
export function summarizeCommitCi(fact: GitHubCommitCiFact): SakiCommitCiSummary {
  const workflowRuns = currentWorkflowRuns(fact.workflowRuns)
  const signalCount = workflowRuns.length + fact.checkRuns.length + fact.commitStatuses.length
  const summary = { signalCount, observedAt: fact.observedAt }
  if (signalCount === 0) return { state: 'unavailable', ...summary }

  const conclusions = [
    ...workflowRuns.map(run => run.status === 'completed' ? run.conclusion : undefined),
    ...fact.checkRuns.map(run => run.status === 'completed' ? run.conclusion : undefined),
  ]
  const failed = conclusions.some(conclusion => conclusion !== undefined
    && conclusion !== 'success'
    && conclusion !== 'neutral'
    && conclusion !== 'skipped'
    && conclusion !== 'cancelled')
    || fact.commitStatuses.some(status => status.state === 'error' || status.state === 'failure')
  if (failed) return { state: 'failed', ...summary }

  const canceled = conclusions.some(conclusion => conclusion === 'cancelled')
  if (canceled) return { state: 'canceled', ...summary }

  const pending = conclusions.some(conclusion => conclusion === undefined)
    || fact.commitStatuses.some(status => status.state === 'pending')
  return { state: pending ? 'pending' : 'successful', ...summary }
}

function currentWorkflowRuns(runs: readonly GitHubWorkflowRunFact[]): readonly GitHubWorkflowRunFact[] {
  const selected = new Map<string, GitHubWorkflowRunFact>()
  for (const run of runs) {
    const key = `${String(run.workflowId)}\0${run.event}`
    const current = selected.get(key)
    if (current === undefined || compareWorkflowRuns(current, run) < 0) selected.set(key, run)
  }
  return [...selected.values()]
}

function compareWorkflowRuns(left: GitHubWorkflowRunFact, right: GitHubWorkflowRunFact): number {
  return left.runNumber - right.runNumber
    || left.runAttempt - right.runAttempt
    || left.updatedAt - right.updatedAt
    || String(left.id).localeCompare(String(right.id))
}
