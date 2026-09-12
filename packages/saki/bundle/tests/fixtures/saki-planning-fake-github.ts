/** Controllable external GitHub state for the real K3 browser flow. */
import { readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import {
  GitHubProviderError, computeGitHubProjectBoardFingerprint, githubIssueId,
  githubIssueFactSchema, githubProjectItemFactSchema, githubProjectItemId,
  githubProjectFieldId, githubProjectOptionId, githubProjectBoardScanCandidateSchema,
} from '@breakfastdapaidang/saki-github'
import type {
  GitHubIssueFact, GitHubMutationMap, GitHubReadMap, GitHubScanMap,
  GitHubTargetedProjectItemFact, GitHubProjectItemFact,
} from '@breakfastdapaidang/saki-github'
import {
  SakiBoardSnapshotGitHub, SAKI_BOARD_SNAPSHOT_CONFIGURATION as config,
  SAKI_AGENT_RUN_SNAPSHOT_ISSUE_BODY,
} from './saki-board-fake-github.ts'

const stateSchema = z.object({
  issues: z.array(z.object({ fact: githubIssueFactSchema, body: z.string(), marker: z.string().optional() })),
  items: z.array(githubProjectItemFactSchema),
  replacementField: z.boolean(),
  failAddInspection: z.boolean(),
  operations: z.array(z.string()),
}).strict()
/** Serialized fake remote shared by the Provider child and browser test. */
export type PlanningRemote = z.infer<typeof stateSchema>
const revision = 1_700_000_000_000

function issue(number: number, title: string, state: 'open' | 'closed'): GitHubIssueFact {
  return {
    id: githubIssueId(`I_saki_${String(number)}`), repositoryId: config.repositoryNodeId,
    repositoryDatabaseId: config.repositoryDatabaseId, number, title, state,
    url: `https://github.com/BreakfastDaPaiDang/saki/issues/${String(number)}`, updatedAt: revision + number,
  }
}

/** @returns initial remote Issues and their Project membership, before K2 creation. */
export function initialPlanningRemote(): PlanningRemote {
  const ready = issue(27, 'Publish a read-only GitHub Board Projection', 'open')
  const canceled = issue(29, 'Retired synchronization experiment', 'closed')
  return {
    issues: [
      { fact: ready, body: SAKI_AGENT_RUN_SNAPSHOT_ISSUE_BODY },
      { fact: canceled, body: 'An archived experiment.' },
      { fact: issue(30, 'Unplanned repository issue', 'open'), body: '# Acceptance criteria\n- Join the selected Project before moving to Ready.' },
    ],
    items: [
      { id: githubProjectItemId('PVTI_saki_ready'), projectId: config.projectNodeId, content: { kind: 'issue', issue: ready }, statusOptionId: config.statusOptionNodeIds.ready, archived: false, apiOrder: 0, updatedAt: revision + 27 },
      { id: githubProjectItemId('PVTI_saki_canceled'), projectId: config.projectNodeId, content: { kind: 'issue', issue: canceled }, statusOptionId: config.statusOptionNodeIds.inProgress, archived: true, apiOrder: 1, updatedAt: revision + 29 },
      { id: githubProjectItemId('PVTI_saki_draft'), projectId: config.projectNodeId, content: { kind: 'draft-issue', title: 'Excluded draft card' }, archived: false, apiOrder: 2, updatedAt: revision },
    ],
    replacementField: false, failAddInspection: false, operations: [],
  }
}

/**
 * @param path - exact test-owned sidecar.
 * @returns validated remote state.
 */
export async function readPlanningRemote(path: string): Promise<PlanningRemote> {
  return stateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}
/**
 * @param path - exact test-owned sidecar.
 * @param state - complete replacement.
 * @returns after atomic publication.
 */
export async function writePlanningRemote(path: string, state: PlanningRemote): Promise<void> {
  const value = stateSchema.parse(state)
  await writeFileAtomic(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}
function path(): string {
  const value = process.env.SAKI_PLANNING_BROWSER_STATE
  if (value === undefined) throw new Error('Planning browser Provider requires its remote sidecar')
  return value
}
function scanDiagnostic(event: Readonly<Record<string, unknown>>): void {
  const tracePath = process.env.SAKI_PLANNING_BROWSER_DIAGNOSTICS
  if (tracePath !== undefined) appendFileSync(tracePath, `${JSON.stringify({ at: Date.now(), ...event })}\n`)
}
function fields(state: PlanningRemote) {
  return [{
    kind: 'single-select' as const,
    id: state.replacementField ? githubProjectFieldId('PVTSSF_saki_replacement') : config.statusFieldNodeId,
    name: state.replacementField ? 'Replacement Status' : 'Workflow Status',
    options: Object.entries(config.statusOptionNodeIds).map(([name, id]) => ({
      name, id: state.replacementField ? githubProjectOptionId(`replacement-${id}`) : id,
    })),
  }]
}
function items(state: PlanningRemote): GitHubProjectItemFact[] {
  return state.items.map((item, apiOrder) => ({
    ...item, apiOrder,
    content: item.content.kind === 'issue'
      ? { kind: 'issue', issue: state.issues.find(row => row.fact.id === (item.content.kind === 'issue' ? item.content.issue.id : ''))!.fact }
      : item.content,
  }))
}
function membership(state: PlanningRemote, issueId: string) {
  const all = items(state)
  const index = all.findIndex(item => item.content.kind === 'issue' && item.content.issue.id === issueId)
  const item = all[index]
  if (item === undefined || item.content.kind !== 'issue') return { state: 'absent' as const }
  const fact: GitHubTargetedProjectItemFact = {
    id: item.id, projectId: item.projectId, issueId: item.content.issue.id,
    ...(item.statusOptionId === undefined ? {} : { statusOptionId: item.statusOptionId }), archived: item.archived, apiOrder: index,
    totalCount: all.length, previousItemId: all[index - 1]?.id ?? null,
    nextItemId: all[index + 1]?.id ?? null, updatedAt: item.updatedAt,
  }
  return { state: 'present' as const, item: fact }
}

/** Production control-plane tests replace only this external Provider. */
export default class PlanningGitHub extends SakiBoardSnapshotGitHub {
  /** @inheritdoc */
  override async read<K extends keyof GitHubReadMap>(request: GitHubReadMap[K]['request'], signal: AbortSignal): Promise<GitHubReadMap[K]['result']> {
    signal.throwIfAborted()
    const state = await readPlanningRemote(path())
    if (request.kind === 'project-fields') return { projectId: config.projectNodeId, fields: fields(state), observedAt: Date.now() }
    if (request.kind === 'issue' || request.kind === 'issue-detail') {
      const row = state.issues.find(row => row.fact.id === request.issueId)
      if (row === undefined) throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
      return { ...row.fact, ...(request.kind === 'issue-detail' ? { body: row.body } : {}) }
    }
    return await super.read(request, signal)
  }
  /** @inheritdoc */
  override async scan<K extends keyof GitHubScanMap>(request: GitHubScanMap[K]['request'], signal: AbortSignal): Promise<GitHubScanMap[K]['result']> {
    scanDiagnostic({ phase: 'scan-start' })
    try {
      const base = await super.scan({
        ...request, statusFieldId: config.statusFieldNodeId, requiredStatusOptionIds: Object.values(config.statusOptionNodeIds),
      }, signal)
      const state = await readPlanningRemote(path())
      if (!fields(state).some(field => field.id === request.statusFieldId)) {
        throw new GitHubProviderError({
          code: 'mapping-mismatch', reason: 'field-missing-or-not-single-select',
          statusFieldId: request.statusFieldId,
        })
      }
      const all = items(state)
      const openIssues = state.issues.filter(row => row.fact.state === 'open').map(row => row.fact)
      const fence = { ...base.fences.before, projectItemCount: all.length, openIssueCount: openIssues.length }
      const source = {
        ...base, statusFieldId: request.statusFieldId, fields: fields(state), items: all, openIssues,
        fences: { before: fence, after: fence },
      }
      const result = githubProjectBoardScanCandidateSchema.parse({ ...source, fingerprint: computeGitHubProjectBoardFingerprint(source) })
      scanDiagnostic({ phase: 'scan-complete', issueNumbers: state.issues.map(row => row.fact.number), fingerprint: result.fingerprint })
      return result
    } catch (error) {
      scanDiagnostic({ phase: 'scan-failed', errorType: error instanceof Error ? error.name : typeof error })
      throw error
    }
  }
  /** @inheritdoc */
  override async dispatch<K extends keyof GitHubMutationMap>(request: GitHubMutationMap[K]['request'], signal: AbortSignal): Promise<GitHubMutationMap[K]['result']> {
    signal.throwIfAborted()
    if (request.kind === 'pull-request-create') return await super.dispatch(request, signal)
    const state = await readPlanningRemote(path())
    state.operations.push(request.kind)
    if (request.kind === 'issue-create') {
      const number = 100 + state.issues.length
      const fact = issue(number, request.title, 'open')
      state.issues.push({ fact, body: request.body, marker: request.markerId })
      await writePlanningRemote(path(), state)
      return { issueId: fact.id, issueNumber: fact.number } as GitHubMutationMap[K]['result']
    }
    const row = state.issues.find(row => row.fact.id === request.issueId)
    if (row === undefined) throw new Error('Planning mutation referenced an unknown Issue')
    const index = state.items.findIndex(item => item.content.kind === 'issue' && item.content.issue.id === row.fact.id)
    if (request.kind === 'project-item-add') {
      if (index < 0) state.items.push({ id: githubProjectItemId(`PVTI_planning_${String(row.fact.number)}`), projectId: request.projectId, content: { kind: 'issue', issue: row.fact }, archived: false, apiOrder: state.items.length, updatedAt: revision + state.operations.length })
    } else if (request.kind === 'issue-state-set') {
      row.fact = { ...row.fact, state: request.desiredState, updatedAt: row.fact.updatedAt + 1 }
    } else {
      const item = state.items[index]
      if (item === undefined) throw new Error('Planning mutation referenced absent membership')
      if (request.kind === 'project-item-status-set') state.items[index] = { ...item, statusOptionId: request.desiredStatusOptionId, updatedAt: item.updatedAt + 1 }
      else if (request.kind === 'project-item-position-set') {
        state.items.splice(index, 1)
        const after = request.afterItemId === null ? -1 : state.items.findIndex(item => item.id === request.afterItemId)
        state.items.splice(after + 1, 0, { ...item, updatedAt: item.updatedAt + 1 })
      }
    }
    await writePlanningRemote(path(), state)
    return undefined
  }
  /** @inheritdoc */
  override async inspectMutation<K extends keyof GitHubMutationMap>(request: GitHubMutationMap[K]['request'], signal: AbortSignal): Promise<GitHubMutationMap[K]['inspection']> {
    signal.throwIfAborted()
    if (request.kind === 'pull-request-create') return await super.inspectMutation(request, signal)
    const state = await readPlanningRemote(path())
    if (request.kind === 'project-item-add' && state.failAddInspection) throw new GitHubProviderError({ code: 'transient-transport' })
    const identity = { repositoryId: config.repositoryNodeId, repositoryDatabaseId: config.repositoryDatabaseId }
    const observedAt = Date.now()
    if (request.kind === 'issue-create') {
      const row = state.issues.find(row => row.marker === request.markerId)
      return { snapshot: { ...identity, outcome: row === undefined ? { state: 'absent-complete' } : { state: 'unique-issue', issue: row.fact } }, observedAt } as GitHubMutationMap[K]['inspection']
    }
    const row = state.issues.find(row => row.fact.id === request.issueId)
    if (row === undefined) throw new Error('Planning inspection referenced an unknown Issue')
    if (request.kind === 'issue-state-set') return { snapshot: { issue: row.fact }, observedAt } as GitHubMutationMap[K]['inspection']
    const found = membership(state, request.issueId)
    const snapshot = { ...identity, projectId: config.projectNodeId, issue: row.fact, membership: found }
    if (request.kind === 'project-item-add') {
      const membership = found.state === 'absent' ? found : { state: 'present' as const, item: {
        id: found.item.id, projectId: found.item.projectId, issueId: found.item.issueId, archived: found.item.archived,
      } }
      return { snapshot: { ...snapshot, membership }, observedAt } as GitHubMutationMap[K]['inspection']
    }
    if (request.kind === 'project-item-status-set') return { snapshot: { ...snapshot, statusFieldId: request.statusFieldId }, observedAt } as GitHubMutationMap[K]['inspection']
    const after = state.items.find(item => item.id === request.afterItemId)
    const anchor = after?.content.kind === 'issue' ? membership(state, after.content.issue.id) : undefined
    const anchorFact = anchor?.state === 'present' ? (() => {
      const { issueId, ...item } = anchor.item
      return { ...item, issue: state.issues.find(row => row.fact.id === issueId)!.fact }
    })() : undefined
    return {
      snapshot: { ...snapshot, statusFieldId: request.statusFieldId, after: request.afterItemId === null ? { state: 'top' }
        : anchorFact === undefined ? { state: 'absent', itemId: request.afterItemId }
          : { state: 'present', item: anchorFact } }, observedAt,
    } as GitHubMutationMap[K]['inspection']
  }
}
