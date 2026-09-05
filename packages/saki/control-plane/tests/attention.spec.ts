import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@breakfastdapaidang/saki-execution'
import {
  deriveSakiAttention,
  deriveSakiMyWork,
  deriveSakiPrincipalWork,
  type SakiPrincipalWorkProjectionSources,
} from '../src/attention.ts'
import type { InterventionRequestRecord } from '../src/spec.ts'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiAgentRunId,
  SakiDevelopmentProjectId,
  SakiExecutionDispatchId,
  SakiInterventionRequestId,
  SakiPrincipalId,
  SakiWorkAssignmentId,
  SakiWorkSessionId,
} from '../src/types.ts'

const PRINCIPAL_ID = 'principal-11111111-1111-4111-8111-111111111111' as SakiPrincipalId
const PROJECT_ID = 'project-22222222-2222-4222-8222-222222222222' as SakiDevelopmentProjectId
const OTHER_PROJECT_ID = 'project-dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SakiDevelopmentProjectId
const WORK_ITEM_ID = `work-item-${'3'.repeat(64)}` as SakiBoardWorkItemId
const OTHER_WORK_ITEM_ID = `work-item-${'5'.repeat(64)}` as SakiBoardWorkItemId
const REMOTE_FINGERPRINT = `remote-fingerprint-${'4'.repeat(64)}` as SakiBoardRemoteFingerprint
const OTHER_REMOTE_FINGERPRINT = `remote-fingerprint-${'6'.repeat(64)}` as SakiBoardRemoteFingerprint
const INTERVENTION_ID = 'intervention-55555555-5555-4555-8555-555555555555' as SakiInterventionRequestId
const AGENT_RUN_ID = 'agent-run-66666666-6666-4666-8666-666666666666' as SakiAgentRunId
const WORK_SESSION_ID = 'work-session-77777777-7777-4777-8777-777777777777' as SakiWorkSessionId
const SESSION_ID = 'session-88888888-8888-4888-8888-888888888888' as SessionId
const ASSIGNMENT_ID = 'assignment-99999999-9999-4999-8999-999999999999' as SakiWorkAssignmentId
const LATER_ASSIGNMENT_ID = 'assignment-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SakiWorkAssignmentId
const LATEST_ASSIGNMENT_ID = 'assignment-ffffffff-ffff-4fff-8fff-ffffffffffff' as SakiWorkAssignmentId
const LATER_AGENT_RUN_ID = 'agent-run-dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SakiAgentRunId
const LATEST_AGENT_RUN_ID = 'agent-run-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SakiAgentRunId
const LATER_WORK_SESSION_ID = 'work-session-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as SakiWorkSessionId
const LATEST_WORK_SESSION_ID = 'work-session-ffffffff-ffff-4fff-8fff-ffffffffffff' as SakiWorkSessionId
const FOREIGN_PRINCIPAL_ID = 'principal-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as SakiPrincipalId
const DISPATCH_ID = 'dispatch-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as SakiExecutionDispatchId
const LATER_DISPATCH_ID = 'dispatch-dddddddd-dddd-4ddd-8ddd-dddddddddddd' as SakiExecutionDispatchId
const OTHER_INTERVENTION_ID = 'intervention-cccccccc-cccc-4ccc-8ccc-cccccccccccc' as SakiInterventionRequestId

function sources(
  patch: Partial<SakiPrincipalWorkProjectionSources> = {},
): SakiPrincipalWorkProjectionSources {
  return {
    principalId: PRINCIPAL_ID,
    allowedActions: new Set(['work-item:give-to-agent', 'intervention:answer']),
    projects: [{ id: PROJECT_ID, revision: 7, projectTitle: 'Saki' }],
    githubProjectSyncs: [{
      id: PROJECT_ID,
      confirmedBoard: {
        items: [{
          id: WORK_ITEM_ID,
          title: 'Persist intervention requests',
          issueNumber: 31,
          status: 'ready',
          archived: false,
          notInProject: false,
          updatedAt: 100,
          remoteFingerprint: REMOTE_FINGERPRINT,
        }],
      },
    }],
    workAssignments: [],
    agentRuns: [],
    executionDispatches: [],
    interventions: [],
    giveToAgentAvailability: new Map([[PROJECT_ID, new Map([[WORK_ITEM_ID, { available: true }]])]]),
    ...patch,
  }
}

function withWorkItemStatus(
  value: SakiPrincipalWorkProjectionSources,
  status: 'in-progress' | 'in-review' | 'done' | 'canceled',
): SakiPrincipalWorkProjectionSources {
  const sync = value.githubProjectSyncs[0]
  const item = sync?.confirmedBoard?.items[0]
  if (sync === undefined || item === undefined) throw new Error('test source lacks a confirmed Work Item')
  return {
    ...value,
    githubProjectSyncs: [{
      ...sync,
      confirmedBoard: { items: [{ ...item, status }] },
    }],
  }
}

function assignment(ownerPrincipalId: SakiPrincipalId = PRINCIPAL_ID) {
  return {
    id: ASSIGNMENT_ID,
    revision: 2,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    ownerPrincipalId,
    primaryWorkSessionId: WORK_SESSION_ID,
    agentRunId: AGENT_RUN_ID,
    state: 'active' as const,
    createdAt: 140,
    updatedAt: 150,
  }
}

function agentRun(state: 'running' | 'waiting' | 'resume-pending' | 'canceled' | 'reconciliation-required' = 'running') {
  return {
    id: AGENT_RUN_ID,
    revision: 4,
    assignmentId: ASSIGNMENT_ID,
    workSessionId: WORK_SESSION_ID,
    projectId: PROJECT_ID,
    workItemId: WORK_ITEM_ID,
    state,
    updatedAt: 160,
  }
}

type OpenIntervention = Extract<InterventionRequestRecord, { readonly state: 'open' }>

function openIntervention(patch: Partial<OpenIntervention> = {}): OpenIntervention {
  return {
    id: INTERVENTION_ID,
    schemaVersion: 1,
    revision: 3,
    kind: 'text-input',
    projectId: PROJECT_ID,
    owner: { kind: 'agent-run', agentRunId: AGENT_RUN_ID, workSessionId: WORK_SESSION_ID },
    targetPrincipalId: PRINCIPAL_ID,
    subject: { kind: 'agent-run', agentRunId: AGENT_RUN_ID },
    blockingScope: { kind: 'agent-run', agentRunId: AGENT_RUN_ID },
    cause: {
      kind: 'agent-request',
      agentRunId: AGENT_RUN_ID,
      workSessionId: WORK_SESSION_ID,
      sessionId: SESSION_ID,
      toolCallId: ToolCallId('call-fixture'),
    },
    state: 'open',
    openedAt: 121,
    requiredAnswer: { kind: 'text', prompt: 'Which API shape should I use?', maxLength: 2_000 },
    returnAddress: {
      kind: 'agent-run',
      projectId: PROJECT_ID,
      workItemId: WORK_ITEM_ID,
      workSessionId: WORK_SESSION_ID,
      agentRunId: AGENT_RUN_ID,
    },
    createdAt: 120,
    updatedAt: 130,
    ...patch,
  }
}

function executionDispatch(
  state: 'accepted' | 'reconciliation-required',
) {
  return {
    id: DISPATCH_ID,
    revision: 5,
    agentRunId: AGENT_RUN_ID,
    workSessionId: WORK_SESSION_ID,
    state,
    ...(state === 'reconciliation-required' ? { terminalReason: 'effect-unknown' as const } : {}),
    createdAt: 145,
    updatedAt: 175,
  }
}

describe('Principal work projections', () => {
  it('offers one revision-fenced Give-to-Agent action for eligible Ready work', () => {
    const projection = deriveSakiPrincipalWork(sources())

    expect(projection.attention.items).toEqual([])
    expect(projection.myWork.items).toHaveLength(1)
    expect(projection.myWork.items[0]).toMatchObject({
      group: 'ready-to-start',
      returnAddress: { kind: 'work-item', projectId: PROJECT_ID, workItemId: WORK_ITEM_ID },
      recommendation: {
        available: true,
        offer: {
          type: 'give-work-item-to-agent',
          reason: 'ready-for-agent',
          projectId: PROJECT_ID,
          workItemId: WORK_ITEM_ID,
          expectedProjectRevision: 7,
          expectedRemoteFingerprint: REMOTE_FINGERPRINT,
        },
      },
    })
    expect(projection.myWork.items[0]?.recommendation).not.toHaveProperty('intentId')
  })

  it('projects an open target Intervention as Attention and prefers its Answer offer', () => {
    const intervention = openIntervention()
    const { requiredAnswer, returnAddress } = intervention
    const projection = deriveSakiPrincipalWork(sources({
      interventions: [intervention],
    }))

    expect(projection.myWork.items).toHaveLength(1)
    expect(projection.myWork.items[0]).toMatchObject({
      group: 'waiting-for-operator',
      intervention: { id: INTERVENTION_ID, revision: 3, requiredAnswer },
      returnAddress,
      recommendation: {
        available: true,
        offer: {
          type: 'answer-intervention',
          reason: 'response-required',
          interventionId: INTERVENTION_ID,
          expectedInterventionRevision: 3,
          requiredAnswer,
        },
      },
    })
    expect(projection.myWork.items[0]?.intervention?.requiredAnswer).not.toBe(requiredAnswer)
    expect(projection.myWork.items[0]?.returnAddress).not.toBe(returnAddress)
    expect(projection.attention.items).toEqual([{
      source: { kind: 'intervention', id: INTERVENTION_ID, revision: 3 },
      projectId: PROJECT_ID,
      targetPrincipalId: PRINCIPAL_ID,
      severity: 'action-required',
      requiredResponse: requiredAnswer,
      openedAt: 121,
      returnAddress,
    }])
    expect(projection.attention.items[0]?.requiredResponse).not.toBe(requiredAnswer)
    expect(projection.attention.items[0]?.returnAddress).not.toBe(returnAddress)
  })

  it('keeps an open Answer offer when another Intervention on the Work Item needs reconciliation', () => {
    const open = openIntervention()
    const reconciliation = {
      ...openIntervention({ id: OTHER_INTERVENTION_ID }),
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
      reconciliationRequiredAt: 131,
      updatedAt: 131,
    } as const satisfies InterventionRequestRecord

    const projection = deriveSakiPrincipalWork(sources({
      interventions: [open, reconciliation],
    }))

    expect(projection.myWork.items[0]).toMatchObject({
      intervention: { id: INTERVENTION_ID, state: 'open' },
      recommendation: {
        available: true,
        offer: { type: 'answer-intervention', interventionId: INTERVENTION_ID },
      },
    })
  })

  it('scopes same-identity Work Item state to its owning Project', () => {
    const value = sources()
    const sync = value.githubProjectSyncs[0]
    if (sync?.confirmedBoard === undefined) throw new Error('test source lacks a confirmed Board')
    const projection = deriveSakiPrincipalWork({
      ...value,
      projects: [
        ...value.projects,
        { id: OTHER_PROJECT_ID, revision: 9, projectTitle: 'Other Saki checkout' },
      ],
      githubProjectSyncs: [
        sync,
        { id: OTHER_PROJECT_ID, confirmedBoard: sync.confirmedBoard },
      ],
      giveToAgentAvailability: new Map([
        [PROJECT_ID, new Map([[WORK_ITEM_ID, { available: true }]])],
        [OTHER_PROJECT_ID, new Map([[WORK_ITEM_ID, { available: true }]])],
      ]),
      workAssignments: [assignment()],
      agentRuns: [agentRun()],
      interventions: [openIntervention()],
    })
    const byProject = new Map(projection.myWork.items.map(item => [item.project.id, item]))

    expect(byProject.get(PROJECT_ID)).toMatchObject({
      group: 'waiting-for-operator',
      intervention: { id: INTERVENTION_ID },
      recommendation: { available: true, offer: { type: 'answer-intervention' } },
    })
    expect(byProject.get(OTHER_PROJECT_ID)).toMatchObject({
      group: 'ready-to-start',
      recommendation: { available: true, offer: { type: 'give-work-item-to-agent' } },
    })
    expect(byProject.get(OTHER_PROJECT_ID)?.assignment).toBeUndefined()
    expect(byProject.get(OTHER_PROJECT_ID)?.intervention).toBeUndefined()
  })

  it('shows active assigned work only to the Principal that owns it', () => {
    const ownedAssignment = assignment()
    const run = agentRun()
    const owned = deriveSakiPrincipalWork(withWorkItemStatus(sources({
      workAssignments: [ownedAssignment],
      agentRuns: [run],
    }), 'in-progress'))

    expect(owned.myWork.items).toHaveLength(1)
    expect(owned.myWork.items[0]).toMatchObject({
      group: 'active',
      assignment: { id: ASSIGNMENT_ID, revision: 2, ownerPrincipalId: PRINCIPAL_ID, state: 'active' },
      run: { id: AGENT_RUN_ID, revision: 4, state: 'running' },
      returnAddress: {
        kind: 'agent-run',
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        workSessionId: WORK_SESSION_ID,
        agentRunId: AGENT_RUN_ID,
      },
      recommendation: { available: false, reason: 'active-work' },
    })

    const foreign = deriveSakiPrincipalWork(withWorkItemStatus(sources({
      workAssignments: [assignment(FOREIGN_PRINCIPAL_ID)],
      agentRuns: [run],
    }), 'in-progress'))
    expect(foreign.myWork.items).toEqual([])

    const foreignReady = deriveSakiPrincipalWork(sources({
      workAssignments: [assignment(FOREIGN_PRINCIPAL_ID)],
      agentRuns: [run],
    }))
    expect(foreignReady.myWork.items).toEqual([])
  })

  it('prefers an active Run over a later prepared Give attempt regardless of source order', () => {
    const activeAssignment = assignment()
    const activeRun = agentRun()
    const laterPreparedAssignment = {
      ...assignment(),
      id: LATER_ASSIGNMENT_ID,
      revision: 0,
      primaryWorkSessionId: LATER_WORK_SESSION_ID,
      agentRunId: LATER_AGENT_RUN_ID,
      state: 'assigned' as const,
      createdAt: 200,
      updatedAt: 200,
    }
    const laterAllocatedRun = {
      ...agentRun(),
      id: LATER_AGENT_RUN_ID,
      revision: 0,
      assignmentId: LATER_ASSIGNMENT_ID,
      workSessionId: LATER_WORK_SESSION_ID,
      state: 'allocated' as const,
      updatedAt: 200,
    }

    for (const [workAssignments, agentRuns] of [
      [[activeAssignment, laterPreparedAssignment], [activeRun, laterAllocatedRun]],
      [[laterPreparedAssignment, activeAssignment], [laterAllocatedRun, activeRun]],
    ] as const) {
      const projection = deriveSakiPrincipalWork(withWorkItemStatus(sources({
        workAssignments,
        agentRuns,
      }), 'in-progress'))

      expect(projection.myWork.items[0]).toMatchObject({
        group: 'active',
        assignment: { id: ASSIGNMENT_ID, state: 'active' },
        run: { id: AGENT_RUN_ID, state: 'running' },
        returnAddress: {
          kind: 'agent-run',
          workSessionId: WORK_SESSION_ID,
          agentRunId: AGENT_RUN_ID,
        },
      })
    }
  })

  it('keeps an admission-losing prepared Give attempt eligible as Ready work', () => {
    const value = sources()
    const sync = value.githubProjectSyncs[0]
    const item = sync?.confirmedBoard?.items[0]
    if (sync === undefined || item === undefined) throw new Error('test source lacks a confirmed Work Item')
    const preparedAssignment = {
      ...assignment(),
      id: LATER_ASSIGNMENT_ID,
      revision: 0,
      workItemId: OTHER_WORK_ITEM_ID,
      primaryWorkSessionId: LATER_WORK_SESSION_ID,
      agentRunId: LATER_AGENT_RUN_ID,
      state: 'assigned' as const,
      createdAt: 200,
      updatedAt: 200,
    }
    const allocatedRun = {
      ...agentRun(),
      id: LATER_AGENT_RUN_ID,
      revision: 0,
      assignmentId: LATER_ASSIGNMENT_ID,
      workSessionId: LATER_WORK_SESSION_ID,
      workItemId: OTHER_WORK_ITEM_ID,
      state: 'allocated' as const,
      updatedAt: 200,
    }
    const pendingDispatch = {
      ...executionDispatch('accepted'),
      id: LATER_DISPATCH_ID,
      revision: 0,
      agentRunId: LATER_AGENT_RUN_ID,
      workSessionId: LATER_WORK_SESSION_ID,
      state: 'pending' as const,
      createdAt: 200,
      updatedAt: 200,
    }
    for (const ghostRuns of [[allocatedRun], []] as const) {
      const projection = deriveSakiPrincipalWork({
        ...value,
        githubProjectSyncs: [{
          ...sync,
          confirmedBoard: {
            items: [
              { ...item, status: 'in-progress' },
              {
                ...item,
                id: OTHER_WORK_ITEM_ID,
                issueNumber: 32,
                title: 'Automate work claiming',
                remoteFingerprint: OTHER_REMOTE_FINGERPRINT,
              },
            ],
          },
        }],
        workAssignments: [assignment(), preparedAssignment],
        agentRuns: [agentRun(), ...ghostRuns],
        executionDispatches: [executionDispatch('accepted'), pendingDispatch],
        giveToAgentAvailability: new Map([[PROJECT_ID, new Map([
          [WORK_ITEM_ID, { available: true }],
          [OTHER_WORK_ITEM_ID, { available: true }],
        ])]]),
      })
      const byWorkItem = new Map(projection.myWork.items.map(entry => [entry.workItem.id, entry]))

      expect(byWorkItem.get(WORK_ITEM_ID)).toMatchObject({
        group: 'active',
        assignment: { id: ASSIGNMENT_ID },
        run: { id: AGENT_RUN_ID },
      })
      expect(byWorkItem.get(OTHER_WORK_ITEM_ID)).toMatchObject({
        group: 'ready-to-start',
        returnAddress: { kind: 'work-item', workItemId: OTHER_WORK_ITEM_ID },
        recommendation: {
          available: true,
          offer: { type: 'give-work-item-to-agent', workItemId: OTHER_WORK_ITEM_ID },
        },
      })
      expect(byWorkItem.get(OTHER_WORK_ITEM_ID)?.assignment).toBeUndefined()
      expect(byWorkItem.get(OTHER_WORK_ITEM_ID)?.run).toBeUndefined()
    }
  })

  it('retains an allocated startup once its Dispatch owns execution progress', () => {
    const preparedAssignment = { ...assignment(), state: 'assigned' as const }
    const allocatedRun = { ...agentRun(), state: 'allocated' as const }

    for (const state of ['claimed', 'accepted'] as const) {
      const projection = deriveSakiPrincipalWork(sources({
        workAssignments: [preparedAssignment],
        agentRuns: [allocatedRun],
        executionDispatches: [{ ...executionDispatch('accepted'), state }],
      }))

      expect(projection.myWork.items[0]).toMatchObject({
        group: 'active',
        assignment: { id: ASSIGNMENT_ID, state: 'assigned' },
        run: { id: AGENT_RUN_ID, state: 'allocated' },
        returnAddress: { kind: 'agent-run', agentRunId: AGENT_RUN_ID },
        recommendation: { available: false, reason: 'active-work' },
      })
    }
  })

  it('retains Dispatch Attention during the durable reconciliation write prefix', () => {
    const projection = deriveSakiPrincipalWork(sources({
      workAssignments: [{ ...assignment(), state: 'assigned' }],
      agentRuns: [{ ...agentRun(), state: 'allocated' }],
      executionDispatches: [executionDispatch('reconciliation-required')],
    }))

    expect(projection.myWork.items[0]).toMatchObject({
      assignment: { id: ASSIGNMENT_ID },
      run: { id: AGENT_RUN_ID },
    })
    expect(projection.attention.items).toEqual([{
      source: { kind: 'execution-dispatch', id: DISPATCH_ID, revision: 5 },
      projectId: PROJECT_ID,
      targetPrincipalId: PRINCIPAL_ID,
      severity: 'action-required',
      openedAt: 175,
      returnAddress: {
        kind: 'agent-run',
        projectId: PROJECT_ID,
        workItemId: WORK_ITEM_ID,
        workSessionId: WORK_SESSION_ID,
        agentRunId: AGENT_RUN_ID,
      },
    }])
  })

  it('selects canceled history deterministically without treating it as active Ready work', () => {
    const olderCanceled = {
      ...assignment(),
      state: 'canceled' as const,
    }
    const sameTimeCanceled = {
      ...assignment(),
      id: LATER_ASSIGNMENT_ID,
      primaryWorkSessionId: LATER_WORK_SESSION_ID,
      agentRunId: LATER_AGENT_RUN_ID,
      state: 'canceled' as const,
      createdAt: 200,
      updatedAt: 210,
    }
    const latestCanceled = {
      ...assignment(),
      id: LATEST_ASSIGNMENT_ID,
      revision: 3,
      primaryWorkSessionId: LATEST_WORK_SESSION_ID,
      agentRunId: LATEST_AGENT_RUN_ID,
      state: 'canceled' as const,
      createdAt: 200,
      updatedAt: 220,
    }
    const olderCanceledRun = agentRun('canceled')
    const sameTimeCanceledRun = {
      ...agentRun('canceled'),
      id: LATER_AGENT_RUN_ID,
      assignmentId: LATER_ASSIGNMENT_ID,
      workSessionId: LATER_WORK_SESSION_ID,
    }
    const latestCanceledRun = {
      ...agentRun('canceled'),
      id: LATEST_AGENT_RUN_ID,
      assignmentId: LATEST_ASSIGNMENT_ID,
      workSessionId: LATEST_WORK_SESSION_ID,
    }

    for (const [workAssignments, agentRuns] of [
      [
        [olderCanceled, sameTimeCanceled, latestCanceled],
        [olderCanceledRun, sameTimeCanceledRun, latestCanceledRun],
      ],
      [
        [latestCanceled, olderCanceled, sameTimeCanceled],
        [latestCanceledRun, olderCanceledRun, sameTimeCanceledRun],
      ],
    ] as const) {
      const ready = deriveSakiPrincipalWork(sources({
        workAssignments,
        agentRuns,
      }))
      expect(ready.myWork.items[0]).toMatchObject({
        group: 'ready-to-start',
        recommendation: { available: true, offer: { type: 'give-work-item-to-agent' } },
      })
      expect(ready.myWork.items[0]?.assignment).toBeUndefined()
      expect(ready.myWork.items[0]?.run).toBeUndefined()
    }

    const terminal = deriveSakiPrincipalWork(withWorkItemStatus(sources({
      workAssignments: [olderCanceled, sameTimeCanceled, latestCanceled],
      agentRuns: [olderCanceledRun, sameTimeCanceledRun, latestCanceledRun],
    }), 'done'))
    expect(terminal.myWork.items[0]).toMatchObject({
      group: 'recently-finished',
      assignment: { id: LATEST_ASSIGNMENT_ID, state: 'canceled' },
      run: { id: LATEST_AGENT_RUN_ID, state: 'canceled' },
      recommendation: { available: false, reason: 'terminal-work-item' },
    })
  })

  it('keeps In-review work waiting without inventing the B10 acceptance action', () => {
    const projection = deriveSakiPrincipalWork(withWorkItemStatus(sources({
      workAssignments: [assignment()],
      agentRuns: [agentRun()],
    }), 'in-review'))

    expect(projection.myWork.items).toHaveLength(1)
    expect(projection.myWork.items[0]).toMatchObject({
      group: 'waiting-for-operator',
      recommendation: { available: false, reason: 'acceptance-not-available' },
    })
    expect(JSON.stringify(projection.myWork.items[0])).not.toContain('accept-deliverable')
  })

  it('keeps Done and Canceled work terminal without an acceptance offer', () => {
    for (const status of ['done', 'canceled'] as const) {
      const projection = deriveSakiPrincipalWork(withWorkItemStatus(sources({
        workAssignments: [assignment()],
        agentRuns: [agentRun('canceled')],
      }), status))

      expect(projection.myWork.items).toHaveLength(1)
      expect(projection.myWork.items[0]).toMatchObject({
        group: 'recently-finished',
        workItem: { status },
        recommendation: { available: false, reason: 'terminal-work-item' },
      })
      expect(projection.myWork.items[0]?.recommendation.available).toBe(false)
    }
  })

  it('derives Attention from reconciliation-required Assignment and Dispatch records', () => {
    const recoveryAssignment = {
      ...assignment(),
      revision: 3,
      state: 'reconciliation-required' as const,
      updatedAt: 170,
    }
    const projection = deriveSakiPrincipalWork(withWorkItemStatus(sources({
      workAssignments: [recoveryAssignment],
      agentRuns: [agentRun('reconciliation-required')],
      executionDispatches: [executionDispatch('reconciliation-required')],
    }), 'in-progress'))

    expect(projection.myWork.items[0]).toMatchObject({
      group: 'waiting-for-operator',
      recommendation: { available: false, reason: 'reconciliation-required' },
    })
    expect(projection.attention.items).toEqual([
      {
        source: { kind: 'work-assignment', id: ASSIGNMENT_ID, revision: 3 },
        projectId: PROJECT_ID,
        targetPrincipalId: PRINCIPAL_ID,
        severity: 'warning',
        openedAt: 170,
        returnAddress: {
          kind: 'agent-run',
          projectId: PROJECT_ID,
          workItemId: WORK_ITEM_ID,
          workSessionId: WORK_SESSION_ID,
          agentRunId: AGENT_RUN_ID,
        },
      },
      {
        source: { kind: 'execution-dispatch', id: DISPATCH_ID, revision: 5 },
        projectId: PROJECT_ID,
        targetPrincipalId: PRINCIPAL_ID,
        severity: 'action-required',
        openedAt: 175,
        returnAddress: {
          kind: 'agent-run',
          projectId: PROJECT_ID,
          workItemId: WORK_ITEM_ID,
          workSessionId: WORK_SESSION_ID,
          agentRunId: AGENT_RUN_ID,
        },
      },
    ])
    expect(projection.attention.items.every(item => item.requiredResponse === undefined)).toBe(true)
  })

  it('projects only open Interventions targeted to the current Principal', () => {
    const current = openIntervention()
    const foreign = openIntervention({
      id: OTHER_INTERVENTION_ID,
      targetPrincipalId: FOREIGN_PRINCIPAL_ID,
    })
    const opening = {
      ...openIntervention({ id: OTHER_INTERVENTION_ID }),
      state: 'opening' as const,
    } as InterventionRequestRecord
    const projection = deriveSakiPrincipalWork(sources({
      interventions: [foreign, opening, current],
    }))

    expect(projection.attention.items.map(item => item.source.id)).toEqual([INTERVENTION_ID])
    expect(projection.myWork.items[0]).toMatchObject({
      group: 'waiting-for-operator',
      intervention: { id: INTERVENTION_ID },
    })
    expect(deriveSakiAttention(sources({
      projects: [],
      interventions: [current],
    })).items).toEqual([])
  })

  it('surfaces a target Intervention that requires reconciliation without offering an answer', () => {
    const reconciliation = {
      ...openIntervention(),
      state: 'reconciliation-required',
      reason: 'evidence-conflict',
      reconciliationRequiredAt: 131,
      updatedAt: 131,
    } as const satisfies InterventionRequestRecord
    const projection = deriveSakiPrincipalWork(sources({ interventions: [reconciliation] }))

    expect(projection.myWork.items[0]).toMatchObject({
      group: 'waiting-for-operator',
      intervention: { id: INTERVENTION_ID, state: 'reconciliation-required' },
      recommendation: { available: false, reason: 'reconciliation-required' },
    })
    expect(projection.attention.items).toEqual([{
      source: { kind: 'intervention', id: INTERVENTION_ID, revision: 3 },
      projectId: PROJECT_ID,
      targetPrincipalId: PRINCIPAL_ID,
      severity: 'warning',
      openedAt: 121,
      returnAddress: reconciliation.returnAddress,
    }])
  })

  it('preserves explicit unavailable inputs for not-yet-owned policy, budget, and credential facts', () => {
    for (const reason of [
      'automation-policy-unavailable',
      'budget-unavailable',
      'production-credential-unavailable',
    ] as const) {
      const projection = deriveSakiPrincipalWork(sources({
        giveToAgentAvailability: new Map([[
          PROJECT_ID,
          new Map([[WORK_ITEM_ID, { available: false, reason }]]),
        ]]),
      }))
      expect(projection.myWork.items[0]?.recommendation).toEqual({ available: false, reason })
    }
  })

  it('never treats an eligibility input or an Attention entry as current authority', () => {
    const ready = deriveSakiPrincipalWork(sources({
      allowedActions: new Set(),
      giveToAgentAvailability: new Map([[PROJECT_ID, new Map([[WORK_ITEM_ID, { available: true }]])]]),
    }))
    expect(ready.myWork.items[0]?.recommendation).toEqual({ available: false, reason: 'action-denied' })

    const waiting = deriveSakiPrincipalWork(sources({
      allowedActions: new Set(),
      interventions: [openIntervention()],
    }))
    expect(waiting.myWork.items[0]?.recommendation)
      .toEqual({ available: false, reason: 'response-action-denied' })
    expect(waiting.attention.items).toHaveLength(1)
  })

  it('exposes independent My Work and Attention reads over the same pure source snapshot', () => {
    const input = sources({
      interventions: [openIntervention()],
      giveToAgentAvailability: new Map(),
    })

    expect(deriveSakiMyWork(input)).toEqual(deriveSakiPrincipalWork(input).myWork)
    expect(deriveSakiAttention(input)).toEqual(deriveSakiPrincipalWork(input).attention)
    expect(deriveSakiMyWork(sources({ giveToAgentAvailability: new Map() })).items[0]?.recommendation)
      .toEqual({ available: false, reason: 'operation-conditions-unavailable' })
  })

  it('omits Board facts without a current Project, confirmed Board, or Project membership', () => {
    const value = sources()
    const sync = value.githubProjectSyncs[0]
    const item = sync?.confirmedBoard?.items[0]
    if (sync === undefined || item === undefined) throw new Error('test source lacks a confirmed Work Item')

    expect(deriveSakiMyWork({ ...value, projects: [] }).items).toEqual([])
    expect(deriveSakiMyWork(withWorkItemStatus(value, 'in-progress')).items).toEqual([])
    expect(deriveSakiMyWork({
      ...value,
      githubProjectSyncs: [{ id: PROJECT_ID }],
    }).items).toEqual([])
    expect(deriveSakiMyWork({
      ...value,
      githubProjectSyncs: [{ ...sync, confirmedBoard: { items: [{ ...item, archived: true }] } }],
    }).items).toEqual([])
    expect(deriveSakiMyWork({
      ...value,
      githubProjectSyncs: [{ ...sync, confirmedBoard: { items: [{ ...item, notInProject: true }] } }],
    }).items).toEqual([])
  })

  it('omits non-recovery, orphaned, foreign, and non-current-Project Dispatch attention', () => {
    expect(deriveSakiAttention(sources({
      executionDispatches: [executionDispatch('accepted')],
    })).items).toEqual([])
    expect(deriveSakiAttention(sources({
      executionDispatches: [executionDispatch('reconciliation-required')],
    })).items).toEqual([])
    expect(deriveSakiAttention(sources({
      workAssignments: [assignment(FOREIGN_PRINCIPAL_ID)],
      agentRuns: [agentRun()],
      executionDispatches: [executionDispatch('reconciliation-required')],
    })).items).toEqual([])
    expect(deriveSakiAttention(sources({
      projects: [],
      workAssignments: [assignment()],
      agentRuns: [agentRun()],
      executionDispatches: [executionDispatch('reconciliation-required')],
    })).items).toEqual([])
  })
})
