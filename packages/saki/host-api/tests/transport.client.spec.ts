import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ProjectGitChangeId } from '@breakfastdapaidang/saki-execution'
import { describe, expect, it, vi } from 'vitest'
import SakiHostClientService from '../src/client/index.ts'
import {
  sakiAcceptBranchDeliveryIntentSchema,
  sakiAnswerInterventionIntentSchema,
  sakiAssociateBranchDeliveryPullRequestIntentSchema,
  sakiConfigureGitHubSynchronizationIntentSchema,
  sakiCreateCommitIntentSchema,
  sakiCreateBranchDeliveryPullRequestIntentSchema,
  sakiCreateWorkItemIntentSchema,
  sakiGiveWorkItemToAgentIntentSchema,
  sakiMoveWorkItemIntentSchema,
  sakiMarkBranchDeliveryInReviewIntentSchema,
  sakiFinalizeMilestoneDeliveryIntentSchema,
  sakiSaveMilestoneDeliveryIntentSchema,
  sakiPushBranchDeliveryIntentSchema,
  sakiQueryRequestSchema,
  sakiRegisterDevelopmentProjectIntentSchema,
  sakiStageFilesIntentSchema,
  sakiSaveBranchDeliveryIntentSchema,
  sakiUnstageFilesIntentSchema,
} from '../src/wire.ts'

const HOST_ID = 'host-11111111-1111-4111-8111-111111111111'
const parsedProjectQuery = sakiQueryRequestSchema.parse({
  type: 'project-settings',
  projectId: 'project-22222222-2222-4222-8222-222222222222',
})
if (parsedProjectQuery.type !== 'project-settings') {
  throw new Error('expected Project Settings query fixture')
}
const PROJECT_ID = parsedProjectQuery.projectId

describe('Saki browser Host client', () => {
  it('requires an active Connection carrier', () => {
    expect(() => new SakiHostClientService(new Context())).toThrow('active Connection carrier')
  })

  it('queries and submits every Branch Delivery operation through the safe wire', async () => {
    const call = vi.fn(async (_channel: string, endpoint: string) => ({
      ok: true as const,
      value: endpoint === 'control/query'
        ? { ok: false, reason: 'not-found' }
        : { ok: false, reason: 'unavailable' },
    }))
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const workItemId = `work-item-${'3'.repeat(64)}`
    const deliveryId = `branch-delivery-${'4'.repeat(64)}`
    const fingerprint = `remote-fingerprint-${'5'.repeat(64)}`
    const save = sakiSaveBranchDeliveryIntentSchema.parse({
      type: 'save-branch-delivery',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectId: PROJECT_ID,
      workItemId,
      expected: {
        deliveryRevision: null,
        registryRevision: 1,
        projectRevision: 2,
        binding: { id: 'binding-66666666-6666-4666-8666-666666666666', revision: 3 },
        synchronizationRevision: 4,
        mappingRevision: 4,
        workItemRemoteFingerprint: fingerprint,
      },
      commitId: '7'.repeat(40),
      headRef: 'refs/heads/saki/issue-32',
      baseRef: 'refs/heads/master',
    })
    const intents = [
      save,
      sakiPushBranchDeliveryIntentSchema.parse({
        type: 'push-branch-delivery',
        intentId: 'intent-22222222-2222-4222-8222-222222222222',
        deliveryId,
        expectedDeliveryRevision: 0,
      }),
      sakiCreateBranchDeliveryPullRequestIntentSchema.parse({
        type: 'create-branch-delivery-pull-request',
        intentId: 'intent-33333333-3333-4333-8333-333333333333',
        deliveryId,
        expectedDeliveryRevision: 0,
        title: 'Deliver issue 32',
        body: 'Exact delivery evidence.',
      }),
      sakiAssociateBranchDeliveryPullRequestIntentSchema.parse({
        type: 'associate-branch-delivery-pull-request',
        intentId: 'intent-44444444-4444-4444-8444-444444444444',
        deliveryId,
        expectedDeliveryRevision: 0,
        pullRequestId: 'PR_issue_32',
        pullRequestNumber: 32,
      }),
      sakiMarkBranchDeliveryInReviewIntentSchema.parse({
        type: 'mark-branch-delivery-in-review',
        intentId: 'intent-55555555-5555-4555-8555-555555555555',
        deliveryId,
        expectedDeliveryRevision: 0,
        expectedWorkItemRemoteFingerprint: fingerprint,
      }),
      sakiAcceptBranchDeliveryIntentSchema.parse({
        type: 'accept-branch-delivery',
        intentId: 'intent-66666666-6666-4666-8666-666666666666',
        deliveryId,
        expectedDeliveryRevision: 0,
        expectedWorkItemRemoteFingerprint: fingerprint,
      }),
    ] as const

    await ctx.sakiHostClient.queryBranchDelivery(PROJECT_ID, save.workItemId, 'interactive')
    await ctx.sakiHostClient.saveBranchDelivery(intents[0], 'delivery-token')
    await ctx.sakiHostClient.pushBranchDelivery(intents[1], 'delivery-token')
    await ctx.sakiHostClient.createBranchDeliveryPullRequest(intents[2], 'delivery-token')
    await ctx.sakiHostClient.associateBranchDeliveryPullRequest(intents[3], 'delivery-token')
    await ctx.sakiHostClient.markBranchDeliveryInReview(intents[4], 'delivery-token')
    await ctx.sakiHostClient.acceptBranchDelivery(intents[5], 'delivery-token')

    expect(call.mock.calls[0]).toEqual(['/saki', 'control/query', {
      type: 'branch-delivery', projectId: PROJECT_ID, workItemId: save.workItemId, refresh: 'interactive',
    }, { credentials: 'same-origin' }])
    for (const [index, intent] of intents.entries()) {
      expect(call.mock.calls[index + 1]).toEqual(['/saki', 'control/submit', intent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'delivery-token' },
      }])
    }
    await fiber.dispose()
  })

  it('queries and submits Milestone Delivery operations through the safe wire', async () => {
    const call = vi.fn(async (_channel: string, endpoint: string) => ({
      ok: true as const,
      value: endpoint === 'control/query'
        ? { ok: false, reason: 'not-found' }
        : { ok: false, reason: 'unavailable' },
    }))
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const release = {
      repositoryId: 'R_saki',
      projectId: 'P_saki',
      milestoneId: 'M_release_010',
      milestoneNumber: 1,
      tagName: 'saki-v0.1.0',
      releaseCommitId: '3'.repeat(40),
      upstreamRepositoryId: 'R_upstream',
      upstreamRepositoryDatabaseId: '321',
      upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
      upstreamCommitId: '4'.repeat(40),
    }
    const save = sakiSaveMilestoneDeliveryIntentSchema.parse({
      type: 'save-milestone-delivery',
      intentId: 'intent-77777777-7777-4777-8777-777777777777',
      projectId: PROJECT_ID,
      expectedDeliveryRevision: null,
      expectedRegistryRevision: 5,
      expectedProjectRevision: 3,
      phase: 'planned',
      release,
    })
    const finalize = sakiFinalizeMilestoneDeliveryIntentSchema.parse({
      type: 'finalize-milestone-delivery',
      intentId: 'intent-88888888-8888-4888-8888-888888888888',
      deliveryId: `milestone-delivery-${'2'.repeat(64)}`,
      expectedDeliveryRevision: 2,
      release,
    })

    await ctx.sakiHostClient.queryMilestoneView(PROJECT_ID, save.release.milestoneId, 'interactive')
    await ctx.sakiHostClient.saveMilestoneDelivery(save, 'milestone-token')
    await ctx.sakiHostClient.finalizeMilestoneDelivery(finalize, 'milestone-token')

    expect(call.mock.calls).toEqual([
      ['/saki', 'control/query', {
        type: 'milestone-view', projectId: PROJECT_ID, milestoneId: save.release.milestoneId, refresh: 'interactive',
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/submit', save, {
        credentials: 'same-origin', headers: { 'x-saki-request-token': 'milestone-token' },
      }],
      ['/saki', 'control/submit', finalize, {
        credentials: 'same-origin', headers: { 'x-saki-request-token': 'milestone-token' },
      }],
    ])
    await fiber.dispose()
  })

  it('submits Work Item and manual Agent Intents with the mutation request token', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true, value: { ok: false, reason: 'unavailable' } })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const createIntent = sakiCreateWorkItemIntentSchema.parse({
      type: 'create-work-item',
      intentId: 'intent-11111111-1111-4111-8111-111111111111',
      projectId: PROJECT_ID,
      expected: { projectRevision: 2, synchronizationRevision: 3, mappingRevision: 3 },
      title: 'Client Work Item',
      intendedOutcome: 'The Work Item is created.',
      acceptanceCriteria: ['The targeted observation confirms it.'],
    })
    const moveIntent = sakiMoveWorkItemIntentSchema.parse({
      type: 'move-work-item',
      intentId: 'intent-22222222-2222-4222-8222-222222222222',
      projectId: PROJECT_ID,
      workItemId: `work-item-${'3'.repeat(64)}`,
      expectedRemoteFingerprint: `remote-fingerprint-${'4'.repeat(64)}`,
      targetStatus: 'done',
    })
    const giveIntent = sakiGiveWorkItemToAgentIntentSchema.parse({
      type: 'give-work-item-to-agent',
      intentId: 'intent-33333333-3333-4333-8333-333333333333',
      projectId: PROJECT_ID,
      workItemId: `work-item-${'3'.repeat(64)}`,
      expectedProjectRevision: 2,
      expectedRemoteFingerprint: `remote-fingerprint-${'4'.repeat(64)}`,
    })
    const answerIntent = sakiAnswerInterventionIntentSchema.parse({
      type: 'answer-intervention',
      intentId: 'intent-44444444-4444-4444-8444-444444444444',
      interventionId: 'intervention-55555555-5555-4555-8555-555555555555',
      expectedInterventionRevision: 3,
      answer: { kind: 'text', text: 'Continue with the public projection.' },
    })

    await ctx.sakiHostClient.createWorkItem(createIntent, 'work-item-token')
    await ctx.sakiHostClient.moveWorkItem(moveIntent, 'work-item-token')
    await ctx.sakiHostClient.giveWorkItemToAgent(giveIntent, 'work-item-token')
    await ctx.sakiHostClient.answerIntervention(answerIntent, 'work-item-token')

    expect(call.mock.calls).toEqual([
      ['/saki', 'control/submit', createIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'work-item-token' },
      }],
      ['/saki', 'control/submit', moveIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'work-item-token' },
      }],
      ['/saki', 'control/submit', giveIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'work-item-token' },
      }],
      ['/saki', 'control/submit', answerIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'work-item-token' },
      }],
    ])
    await fiber.dispose()
  })

  it('uses same-origin credentials and sends request tokens only on mutations', async () => {
    const call = vi.fn(async (_channel: string, endpoint: string) => ({
      ok: true as const,
      value: endpoint === 'access/read'
        ? { kind: 'session-required', message: 'A local browser session is required.' }
        : endpoint === 'control/query'
          ? { ok: false, reason: 'unavailable' }
          : endpoint === 'control/submit'
            ? { ok: false, reason: 'unavailable' }
            : { ok: true },
    }))
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const workspaceQuery = sakiQueryRequestSchema.parse({
      type: 'development-workspace',
      projectId: PROJECT_ID,
      expectedRegistryRevision: 7,
    })
    if (workspaceQuery.type !== 'development-workspace') {
      throw new Error('expected Development Workspace query fixture')
    }
    const intent = sakiRegisterDevelopmentProjectIntentSchema.parse({
      type: 'register-development-project',
      intentId: 'intent-33333333-3333-4333-8333-333333333333',
      projectTitle: 'Client project',
      hostId: HOST_ID,
      directoryLocator: 'D:/repository',
      expectedRegistryRevision: 7,
      confirmedFingerprint: { version: 2, digest: '3'.repeat(64) },
      confirmedBaseline: {
        kind: 'unavailable',
        reason: 'io-failure',
        observed: { entries: 0, pathBytes: 0, gitOutputBytes: 0, hashedBytes: 0, elapsedMs: 0 },
      },
    })
    const githubIntent = sakiConfigureGitHubSynchronizationIntentSchema.parse({
      type: 'configure-github-synchronization',
      intentId: 'intent-44444444-4444-4444-8444-444444444444',
      projectId: PROJECT_ID,
      expectedSynchronizationRevision: 0,
      patch: { activePollIntervalMs: 45_000 },
    })
    const expectedGit = {
      projectId: PROJECT_ID,
      expectedRegistryRevision: 7,
      expectedProjectRevision: 3,
      expectedBinding: { id: 'binding-55555555-5555-4555-8555-555555555555', revision: 2 },
      expectedStatus: { version: 1 as const, digest: '5'.repeat(64) },
      expectedHead: { kind: 'commit' as const, objectId: '6'.repeat(40) },
      expectedIndex: { kind: 'tree' as const, treeId: '7'.repeat(40) },
      expectedWorktree: { version: 1 as const, digest: '8'.repeat(64) },
    }
    const selectedChange = {
      id: `git-change-${'9'.repeat(64)}`,
      fingerprint: { version: 1 as const, digest: 'a'.repeat(64) },
    }
    const stageIntent = sakiStageFilesIntentSchema.parse({
      type: 'stage-files',
      intentId: 'intent-66666666-6666-4666-8666-666666666666',
      expected: expectedGit,
      changes: [selectedChange],
    })
    const unstageIntent = sakiUnstageFilesIntentSchema.parse({
      type: 'unstage-files',
      intentId: 'intent-77777777-7777-4777-8777-777777777777',
      expected: expectedGit,
      changes: [selectedChange],
    })
    const commitIntent = sakiCreateCommitIntentSchema.parse({
      type: 'create-commit',
      intentId: 'intent-88888888-8888-4888-8888-888888888888',
      expected: expectedGit,
      message: 'client commit',
    })

    await ctx.sakiHostClient.readAccess()
    await ctx.sakiHostClient.queryProjectIndex()
    await ctx.sakiHostClient.queryMyWork()
    await ctx.sakiHostClient.queryAttention()
    await ctx.sakiHostClient.inspectProjectSelection(intent.hostId, 'D:/repository')
    await ctx.sakiHostClient.queryDevelopmentWorkspace(workspaceQuery.projectId, 7)
    await ctx.sakiHostClient.queryProjectChanges(PROJECT_ID, 7)
    await ctx.sakiHostClient.readProjectDiff(PROJECT_ID, 7, {
      expectedStatus: { version: 1, digest: '4'.repeat(64) },
      changeId: `git-change-${'5'.repeat(64)}` as ProjectGitChangeId,
      layer: 'unstaged',
    })
    await ctx.sakiHostClient.queryProjectSettings(PROJECT_ID)
    await ctx.sakiHostClient.queryBoard(PROJECT_ID, 'cached')
    await ctx.sakiHostClient.queryBoard(PROJECT_ID, 'interactive')
    await ctx.sakiHostClient.logout('request-token')
    await ctx.sakiHostClient.registerDevelopmentProject(intent, 'request-token')
    await ctx.sakiHostClient.configureGitHubSynchronization(githubIntent, 'request-token')
    await ctx.sakiHostClient.stageFiles(stageIntent, 'request-token')
    await ctx.sakiHostClient.unstageFiles(unstageIntent, 'request-token')
    await ctx.sakiHostClient.createCommit(commitIntent, 'request-token')

    expect(call.mock.calls).toEqual([
      ['/saki', 'access/read', {}, { credentials: 'same-origin' }],
      ['/saki', 'control/query', { type: 'project-index' }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', { type: 'my-work' }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', { type: 'attention' }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'inspect-project-selection',
        hostId: HOST_ID,
        directoryLocator: 'D:/repository',
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'development-workspace',
        projectId: PROJECT_ID,
        expectedRegistryRevision: 7,
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'project-changes',
        projectId: PROJECT_ID,
        expectedRegistryRevision: 7,
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'project-diff',
        projectId: PROJECT_ID,
        expectedRegistryRevision: 7,
        request: {
          expectedStatus: { version: 1, digest: '4'.repeat(64) },
          changeId: `git-change-${'5'.repeat(64)}`,
          layer: 'unstaged',
        },
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'project-settings',
        projectId: PROJECT_ID,
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'board',
        projectId: PROJECT_ID,
        refresh: 'cached',
      }, { credentials: 'same-origin' }],
      ['/saki', 'control/query', {
        type: 'board',
        projectId: PROJECT_ID,
        refresh: 'interactive',
      }, { credentials: 'same-origin' }],
      ['/saki', 'access/logout', {}, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', intent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', githubIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', stageIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', unstageIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
      ['/saki', 'control/submit', commitIntent, {
        credentials: 'same-origin',
        headers: { 'x-saki-request-token': 'request-token' },
      }],
    ])
    await fiber.dispose()
  })

  it('exchanges a launcher secret with caller cancellation and rejects carrier errors', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { ok: false, reason: 'unavailable' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'disconnected', message: 'offline', details: {} } })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)
    const controller = new AbortController()

    expect(await ctx.sakiHostClient.exchangeBootstrap('launcher-secret', controller.signal))
      .toEqual({ ok: false, reason: 'unavailable' })
    expect(call).toHaveBeenNthCalledWith(1, '/saki', 'access/exchange', { secret: 'launcher-secret' }, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
    await expect(ctx.sakiHostClient.queryProjectIndex()).rejects.toThrow(
      'Saki Host request failed: disconnected',
    )
    await fiber.dispose()
  })

  it('rejects a result for a different protected query or Control Intent kind', async () => {
    const call = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          projection: {
            type: 'inspect-project-selection',
            result: { ok: false, reason: 'missing' },
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          projection: {
            type: 'project-index',
            revision: 0,
            hosts: [],
            projects: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          projection: {
            type: 'project-index',
            revision: 0,
            hosts: [],
            projects: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          ok: true,
          receipt: {
            id: 'receipt-55555555-5555-4555-8555-555555555555',
            intentId: 'intent-55555555-5555-4555-8555-555555555555',
            state: 'confirmed',
            projectId: PROJECT_ID,
            resourceBindingId: 'binding-66666666-6666-4666-8666-666666666666',
            registryRevision: 1,
          },
        },
      })
    const ctx = new Context()
    ctx.provide('connection', { rpc: { call } } as unknown as ConnectionHandle)
    const fiber = await ctx.plugin(SakiHostClientService)

    await expect(ctx.sakiHostClient.queryProjectIndex()).rejects.toThrow()
    await expect(ctx.sakiHostClient.queryBoard(PROJECT_ID, 'cached')).rejects.toThrow()
    await expect(ctx.sakiHostClient.queryProjectChanges(PROJECT_ID, 0)).rejects.toThrow()
    const githubIntent = sakiConfigureGitHubSynchronizationIntentSchema.parse({
      type: 'configure-github-synchronization',
      intentId: 'intent-55555555-5555-4555-8555-555555555555',
      projectId: PROJECT_ID,
      expectedSynchronizationRevision: 0,
      patch: { activePollIntervalMs: 45_000 },
    })
    await expect(ctx.sakiHostClient.configureGitHubSynchronization(githubIntent, 'request-token')).rejects.toThrow()

    await fiber.dispose()
  })
})
