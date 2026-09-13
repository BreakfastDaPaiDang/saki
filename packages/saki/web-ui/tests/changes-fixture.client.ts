/** Canonical status evidence and independently controllable Git transport for browser tests. */
import { vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { computeProjectGitChangeFingerprint, computeProjectGitChangeId, computeProjectGitStatusSeedDigest, computeProjectGitStatusFingerprint } from '@breakfastdapaidang/saki-execution'
import { sakiProjectChangesResultSchema, sakiCreateCommitResultSchema, sakiStageFilesResultSchema, sakiUnstageFilesResultSchema } from '@breakfastdapaidang/saki-host-api/wire'
import { ChangesController } from '../src/client/changes-controller.ts'
import type { ChangesIntent } from '../src/client/changes-state.ts'
import { createChangesStore } from '../src/client/changes-state.ts'
import { initialPlanningAddress } from '../src/client/planning-state.ts'
import type { PlanningProject, PlanningSnapshot } from '../src/client/planning-controller.ts'
import { AUTH, BOARD, PROJECT_ID } from './planning-fixture.client.ts'
import { WORK_INDEX } from './work-fixture.client.ts'

const bindingId = 'binding-0a1b2c3d-0000-4000-8000-000000000001' as const
const rowMaterial = {
  path: 'src/example.ts', kind: 'ordinary', indexStatus: 'modified', worktreeStatus: 'modified',
  submodule: { kind: 'not-submodule' }, head: { mode: '100644', objectId: 'a'.repeat(40) },
  index: { mode: '100644', objectId: 'b'.repeat(40) }, worktreeMode: '100644',
  worktreeEvidence: { kind: 'regular', mode: '100644', byteLength: 2, contentDigest: 'c'.repeat(64) }, attribution: 'not-inherited',
} as const
const change = { ...rowMaterial, fingerprint: computeProjectGitChangeFingerprint(rowMaterial) }
const seed = {
  observationVersion: 1, bindingId, bindingRevision: 1, bindingHealth: 'active', locked: false, objectFormat: 'sha1',
  head: { kind: 'commit', objectId: 'a'.repeat(40), symbolicRef: 'refs/heads/main' },
  branch: { kind: 'attached', ref: 'refs/heads/main', name: 'main' }, index: { kind: 'tree', treeId: 'b'.repeat(40) },
  worktree: { version: 1, digest: 'd'.repeat(64) }, changes: [change], structuredMutation: { available: true, blockers: [] },
} as const
const typedSeed = { ...seed, bindingId: bindingId as ChangesIntent['expected']['expectedBinding']['id'] }
const observed = { ...typedSeed, observedAt: 1,
  changes: [{ ...change, id: computeProjectGitChangeId(computeProjectGitStatusSeedDigest(typedSeed), change) }],
}
export const CHANGES = sakiProjectChangesResultSchema.parse({ ok: true, projection: {
  type: 'project-changes', registryRevision: 1, projectId: PROJECT_ID, projectRevision: 2,
  result: { ok: true, observation: { ...observed, fingerprint: computeProjectGitStatusFingerprint(observed) } },
  gitOperations: { stageFiles: { available: true, reasons: [] }, unstageFiles: { available: true, reasons: [] },
    createCommit: { available: true, reasons: [] } },
} })
const emptyRead = { value: null, loading: false, failure: null }
export const CHANGES_PROJECT: PlanningProject = {
  id: PROJECT_ID, address: { ...initialPlanningAddress(), view: 'changes' }, board: { ...emptyRead, value: BOARD },
  detail: emptyRead, milestone: emptyRead, milestones: emptyRead, mapping: emptyRead, mappingResult: null, moves: [], focusVersion: 0,
}
export function gitSuccess(intent: ChangesIntent) {
  const identity = { id: `receipt-${intent.intentId.slice(7)}`, intentId: intent.intentId, type: intent.type, projectId: intent.expected.projectId, state: 'succeeded' }
  const operation = { id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', type: intent.type, revision: 1, state: 'succeeded' }
  if (intent.type === 'create-commit') {
    const signature = { name: 'Operator', email: 'operator@example.test', timestamp: 1, timezone: '+0000', source: 'git-config' }
    return sakiCreateCommitResultSchema.parse({ ok: true, receipt: { ...identity, operation: { ...operation, type: 'commit' }, result: {
      type: 'commit', commitId: 'e'.repeat(40), treeId: 'b'.repeat(40), parent: { kind: 'commit', objectId: 'a'.repeat(40) },
      target: { kind: 'symbolic-ref', ref: 'refs/heads/main' }, author: signature, committer: signature,
    } } })
  }
  const schema = intent.type === 'stage-files' ? sakiStageFilesResultSchema : sakiUnstageFilesResultSchema
  return schema.parse({ ok: true, receipt: { ...identity, operation, result: {
    type: intent.type, resultingIndex: { kind: 'tree', treeId: 'f'.repeat(40) }, changes: intent.changes.map(change => ({ ...change, path: rowMaterial.path })),
  } } })
}
type Api = ConstructorParameters<typeof ChangesController>[0]
export function changesFixture(interaction = createChangesStore().create()) {
  const authority = createSnapshotStore<PlanningSnapshot>({ access: AUTH, offline: false, project: CHANGES_PROJECT })
  const api = {
    queryProjectIndex: vi.fn<Api['queryProjectIndex']>().mockResolvedValue(WORK_INDEX),
    queryProjectChanges: vi.fn<Api['queryProjectChanges']>().mockResolvedValue(CHANGES),
    readProjectDiff: vi.fn<Api['readProjectDiff']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    stageFiles: vi.fn<Api['stageFiles']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    unstageFiles: vi.fn<Api['unstageFiles']>().mockResolvedValue({ ok: false, reason: 'unavailable' }),
    createCommit: vi.fn<Api['createCommit']>().mockImplementation(async intent => sakiCreateCommitResultSchema.parse(gitSuccess(intent))),
  } satisfies Api
  const controller = new ChangesController(api, authority, interaction)
  return { api, controller, authority, interaction, start: async () => {
    controller.start()
    await vi.waitFor(() => { if (controller.getSnapshot().read.value === null) throw new Error('Git read pending') })
  } }
}
