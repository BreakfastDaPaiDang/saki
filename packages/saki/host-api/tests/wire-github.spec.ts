import { describe, expect, it } from 'vitest'
import {
  SAKI_BOARD_WORK_ITEM_LIMIT,
  SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
  SAKI_GITHUB_MAPPING_ISSUE_LIMIT,
} from '@breakfastdapaidang/saki-control-plane/constants'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  sakiBoardResultSchema,
  sakiConfigureGitHubSynchronizationIntentSchema,
  sakiConfigureGitHubSynchronizationResultSchema,
  sakiProjectSettingsResultSchema,
  sakiQueryRequestSchema,
} from '../src/wire.ts'

const PROJECT = 'project-22222222-2222-4222-8222-222222222222'
const INTENT = 'intent-33333333-3333-4333-8333-333333333333'
const ATTEMPT = 'scan-attempt-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const REMOTE_FINGERPRINT = `remote-fingerprint-${'c'.repeat(64)}`
const workItemId = (repositoryId: string, issueId: string) => `work-item-${canonicalDigest(
  'saki/board-work-item/v1',
  { repositoryId, issueId },
)}`

function unreadOversizedArray(length: number) {
  let elementRead = false
  const candidate = new Proxy(new Array<unknown>(length), {
    get(target, property, receiver): unknown {
      if (typeof property === 'string' && /^[0-9]+$/u.test(property)) elementRead = true
      return Reflect.get(target, property, receiver) as unknown
    },
  })
  return { candidate, elementRead: () => elementRead }
}

const CONFIGURATION = {
  appId: '123456',
  githubInstallationId: '12345678',
  accountNodeId: 'O_saki_account',
  repositoryNodeId: 'R_saki_repository',
  repositoryDatabaseId: '87654321',
  projectNodeId: 'PVT_saki_project',
  credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY',
  statusFieldNodeId: 'PVTSSF_saki_status',
  statusOptionNodeIds: {
    inbox: 'option-inbox',
    backlog: 'option-backlog',
    ready: 'option-ready',
    inProgress: 'option-in-progress',
    inReview: 'option-in-review',
    done: 'option-done',
    canceled: 'option-canceled',
  },
  activePollIntervalMs: 30_000,
  backgroundPollIntervalMs: 300_000,
  rateLimitReserve: 500,
} as const
const CHECKPOINT = {
  generation: 1,
  configurationRevision: 1,
  attemptId: ATTEMPT,
  installationId: CONFIGURATION.githubInstallationId,
  repositoryId: CONFIGURATION.repositoryNodeId,
  projectId: CONFIGURATION.projectNodeId,
  statusFieldId: CONFIGURATION.statusFieldNodeId,
  sourceFingerprint: { version: 1, digest: 'd'.repeat(64) },
  observedAt: 100,
  confirmedAt: 110,
  rateLimit: {
    state: 'available',
    observedAt: 100,
    minimumRemaining: 4_000,
    resetAt: 1_000,
  },
} as const
const WORK_ITEM = workItemId(CONFIGURATION.repositoryNodeId, 'I_saki_issue_27')
const CONFIRMED_BOARD = {
  generation: 1,
  configurationRevision: 1,
  repository: {
    id: CONFIGURATION.repositoryNodeId,
    nameWithOwner: 'BreakfastDaPaiDang/saki',
    url: 'https://github.com/BreakfastDaPaiDang/saki',
  },
  project: {
    id: CONFIGURATION.projectNodeId,
    title: 'Saki 0.1.0',
    url: 'https://github.com/orgs/BreakfastDaPaiDang/projects/1',
  },
  items: [{
    id: WORK_ITEM,
    title: 'Project settings and Board projection',
    issueNumber: 27,
    url: 'https://github.com/BreakfastDaPaiDang/saki/issues/27',
    issueState: 'open',
    status: 'in-progress',
    latestNonTerminalStatus: 'in-progress',
    order: 0,
    archived: false,
    notInProject: false,
    updatedAt: 100,
    source: {
      kind: 'github-issue',
      repositoryId: CONFIGURATION.repositoryNodeId,
      issueId: 'I_saki_issue_27',
      projectItemId: 'PVTI_saki_item_27',
      apiOrder: 0,
    },
    remoteFingerprint: REMOTE_FINGERPRINT,
  }],
} as const
const CONFIRMED_BOARD_RESULT = {
  ok: true,
  projection: {
    type: 'board',
    projectId: PROJECT,
    state: 'confirmed',
    synchronizationRevision: 1,
    confirmed: CONFIRMED_BOARD,
    checkpoint: CHECKPOINT,
    mapping: { state: 'valid', configurationRevision: 1, validatedAt: 110 },
    freshness: { state: 'fresh', confirmedAt: 110, staleAt: 30_110, ageMs: 0 },
    scan: { state: 'idle' },
    effectiveMutationAvailability: { available: true, reasons: [] },
    mutationOverlays: [],
  },
} as const
const UNCONFIGURED_SYNCHRONIZATION_EVIDENCE = {
  mapping: { state: 'unconfigured' },
  freshness: { state: 'unavailable' },
  scan: { state: 'idle' },
  effectiveMutationAvailability: {
    available: false,
    reasons: ['synchronization-unconfigured', 'checkpoint-unavailable'],
  },
} as const
const SAVED_SYNCHRONIZATION_EVIDENCE = {
  mapping: { state: 'revalidation-required', configurationRevision: 1 },
  freshness: { state: 'unavailable' },
  scan: {
    state: 'scheduled',
    priority: 'background',
    reason: 'configuration',
    attemptAt: 123,
  },
  effectiveMutationAvailability: {
    available: false,
    reasons: [
      'configuration-not-activated',
      'mapping-revalidation-required',
      'checkpoint-unavailable',
    ],
  },
} as const
const CONFIRMED_SYNCHRONIZATION_EVIDENCE = {
  checkpoint: CHECKPOINT,
  mapping: { state: 'valid', configurationRevision: 1, validatedAt: 110 },
  freshness: { state: 'fresh', confirmedAt: 110, staleAt: 30_110, ageMs: 0 },
  scan: { state: 'idle' },
  effectiveMutationAvailability: { available: true, reasons: [] },
} as const

describe('Saki GitHub Host wire schemas', () => {
  it('requires an explicit cached or interactive Board refresh policy', () => {
    expect(sakiQueryRequestSchema.parse({
      type: 'board',
      projectId: PROJECT,
      refresh: 'cached',
    })).toEqual({
      type: 'board',
      projectId: PROJECT,
      refresh: 'cached',
    })
    expect(sakiQueryRequestSchema.parse({
      type: 'board',
      projectId: PROJECT,
      refresh: 'interactive',
    })).toEqual({
      type: 'board',
      projectId: PROJECT,
      refresh: 'interactive',
    })
    expect(sakiQueryRequestSchema.safeParse({ type: 'board', projectId: PROJECT }).success).toBe(false)
    expect(sakiQueryRequestSchema.safeParse({
      type: 'board',
      projectId: PROJECT,
      refresh: 'manual',
    }).success).toBe(false)
    expect(sakiQueryRequestSchema.safeParse({
      type: 'board',
      projectId: PROJECT,
      refresh: 'cached',
      principalId: 'principal-spoof',
    }).success).toBe(false)
  })

  it('accepts one complete confirmed Board generation', () => {
    expect(sakiBoardResultSchema.parse(CONFIRMED_BOARD_RESULT)).toEqual(CONFIRMED_BOARD_RESULT)
  })

  it('keeps unconfigured and pre-checkpoint Boards free of confirmed material', () => {
    const unconfigured = {
      ok: true,
      projection: {
        type: 'board',
        projectId: PROJECT,
        state: 'unconfigured',
        synchronizationRevision: 0,
        ...UNCONFIGURED_SYNCHRONIZATION_EVIDENCE,
        mutationOverlays: [],
      },
    } as const
    expect(sakiBoardResultSchema.parse(unconfigured)).toEqual(unconfigured)
    expect(sakiBoardResultSchema.safeParse({
      ...unconfigured,
      projection: { ...unconfigured.projection, synchronizationRevision: 1 },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        scan: { state: 'scheduled', priority: 'background', reason: 'startup', attemptAt: 100 },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...unconfigured,
      projection: { ...unconfigured.projection, checkpoint: CHECKPOINT },
    }).success).toBe(false)

    const awaiting = {
      ok: true,
      projection: {
        type: 'board',
        projectId: PROJECT,
        state: 'awaiting-first-checkpoint',
        synchronizationRevision: 1,
        mapping: { state: 'revalidation-required', configurationRevision: 1 },
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 120,
          failure: { kind: 'candidate', reason: 'invalid-candidate' },
        },
        freshness: { state: 'unavailable' },
        scan: { state: 'scheduled', priority: 'interactive', reason: 'interactive', attemptAt: 121 },
        effectiveMutationAvailability: {
          available: false,
          reasons: [
            'configuration-not-activated',
            'mapping-revalidation-required',
            'checkpoint-unavailable',
          ],
        },
        mutationOverlays: [],
      },
    } as const
    expect(sakiBoardResultSchema.parse(awaiting)).toEqual(awaiting)
    expect(sakiBoardResultSchema.safeParse({
      ...awaiting,
      projection: { ...awaiting.projection, confirmed: CONFIRMED_BOARD },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...awaiting,
      projection: { ...awaiting.projection, synchronizationRevision: 0 },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...awaiting,
      projection: {
        ...awaiting.projection,
        mapping: { state: 'valid', configurationRevision: 1, validatedAt: 110 },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...awaiting,
      projection: {
        ...awaiting.projection,
        mapping: { state: 'repair-required', configurationRevision: 1, issues: [] },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 120,
          failure: { kind: 'attempt', reason: 'expired' },
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...awaiting,
      projection: {
        ...awaiting.projection,
        effectiveMutationAvailability: {
          available: false,
          reasons: ['checkpoint-unavailable', 'checkpoint-unavailable'],
        },
      },
    }).success).toBe(false)
  })

  it('rejects impossible Board mutation, mapping, and current-revision evidence', () => {
    const awaiting = {
      type: 'board',
      projectId: PROJECT,
      state: 'awaiting-first-checkpoint',
      synchronizationRevision: 2,
      mapping: { state: 'revalidation-required', configurationRevision: 2 },
      failure: {
        attemptId: ATTEMPT,
        configurationRevision: 2,
        failedAt: 120,
        failure: { kind: 'candidate', reason: 'invalid-candidate' },
      },
      freshness: { state: 'unavailable' },
      scan: { state: 'scheduled', priority: 'interactive', reason: 'retry', attemptAt: 121 },
      effectiveMutationAvailability: {
        available: false,
        reasons: [
          'configuration-not-activated',
          'mapping-revalidation-required',
          'checkpoint-unavailable',
        ],
      },
      mutationOverlays: [],
    } as const
    const parseBoard = (projection: unknown) => sakiBoardResultSchema.safeParse({
      ok: true,
      projection,
    }).success

    expect(parseBoard(awaiting)).toBe(true)
    expect(parseBoard({
      ...awaiting,
      mapping: { state: 'unconfigured' },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'checkpoint-unavailable'],
      },
    })).toBe(false)
    expect(parseBoard({
      ...awaiting,
      failure: { ...awaiting.failure, configurationRevision: 1 },
    })).toBe(false)
    expect(parseBoard({
      ...awaiting,
      scan: {
        state: 'in-flight',
        attemptId: ATTEMPT,
        priority: 'interactive',
        configurationRevision: 1,
        startedAt: 120,
        expiresAt: 130,
      },
    })).toBe(false)
    expect(parseBoard({
      ...awaiting,
      effectiveMutationAvailability: {
        available: false,
        reasons: ['mapping-revalidation-required', 'checkpoint-unavailable'],
      },
    })).toBe(false)
    expect(parseBoard({
      ...CONFIRMED_BOARD_RESULT.projection,
      mapping: { state: 'unconfigured' },
    })).toBe(false)
    expect(parseBoard({
      ...CONFIRMED_BOARD_RESULT.projection,
      failure: { ...awaiting.failure, configurationRevision: 2 },
    })).toBe(false)
    expect(parseBoard({
      ...CONFIRMED_BOARD_RESULT.projection,
      effectiveMutationAvailability: {
        available: false,
        reasons: ['checkpoint-unavailable'],
      },
    })).toBe(false)
  })

  it('rejects mismatched confirmed Board evidence and partial or private material', () => {
    const mismatch = (updates: Record<string, unknown>) => sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: { ...CONFIRMED_BOARD_RESULT.projection, ...updates },
    }).success

    expect(mismatch({
      checkpoint: { ...CHECKPOINT, generation: 2 },
    })).toBe(false)
    expect(mismatch({ synchronizationRevision: 0 })).toBe(false)
    expect(mismatch({
      confirmed: { ...CONFIRMED_BOARD, generation: 0 },
      checkpoint: { ...CHECKPOINT, generation: 0 },
    })).toBe(false)
    expect(mismatch({
      confirmed: { ...CONFIRMED_BOARD, configurationRevision: 0 },
      checkpoint: { ...CHECKPOINT, configurationRevision: 0 },
      mapping: { state: 'valid', configurationRevision: 0, validatedAt: 110 },
    })).toBe(false)
    expect(mismatch({
      mapping: { state: 'valid', configurationRevision: 2, validatedAt: 110 },
    })).toBe(false)
    expect(mismatch({
      mapping: { state: 'valid', configurationRevision: 1, validatedAt: 109 },
    })).toBe(false)
    expect(mismatch({
      checkpoint: { ...CHECKPOINT, observedAt: 111 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'fresh', confirmedAt: 110, staleAt: 110, ageMs: 0 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'fresh', confirmedAt: 110, staleAt: 1_109, ageMs: 0 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'fresh', confirmedAt: 110, staleAt: 86_400_111, ageMs: 0 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'fresh', confirmedAt: 110, staleAt: 30_110, ageMs: 30_000 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'stale', confirmedAt: 111, staleAt: 120, ageMs: 20 },
    })).toBe(false)
    expect(mismatch({
      freshness: { state: 'stale', confirmedAt: 110, staleAt: 30_110, ageMs: 0 },
    })).toBe(false)
    expect(mismatch({
      synchronizationRevision: 1,
      confirmed: { ...CONFIRMED_BOARD, configurationRevision: 2 },
      checkpoint: { ...CHECKPOINT, configurationRevision: 2 },
      mapping: { state: 'revalidation-required', configurationRevision: 1 },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['mapping-revalidation-required'],
      },
    })).toBe(false)
    expect(mismatch({
      mapping: { state: 'revalidation-required', configurationRevision: 1 },
      effectiveMutationAvailability: {
        available: false,
        reasons: ['mapping-revalidation-required'],
      },
    })).toBe(false)
    expect(mismatch({
      confirmed: {
        ...CONFIRMED_BOARD,
        repository: { ...CONFIRMED_BOARD.repository, id: 'R_other_repository' },
      },
    })).toBe(false)
    const saturatedAt = Number.MAX_SAFE_INTEGER
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: {
          ...CHECKPOINT,
          observedAt: saturatedAt,
          confirmedAt: saturatedAt,
          rateLimit: { state: 'unobserved' },
        },
        mapping: { state: 'valid', configurationRevision: 1, validatedAt: saturatedAt },
        freshness: {
          state: 'stale',
          confirmedAt: saturatedAt,
          staleAt: saturatedAt,
          ageMs: 0,
        },
      },
    }).success).toBe(true)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: {
          ...CHECKPOINT,
          observedAt: saturatedAt,
          confirmedAt: saturatedAt,
          rateLimit: { state: 'unobserved' },
        },
        mapping: { state: 'valid', configurationRevision: 1, validatedAt: saturatedAt },
        freshness: {
          state: 'stale',
          confirmedAt: saturatedAt,
          staleAt: saturatedAt,
          ageMs: 1,
        },
      },
    }).success).toBe(false)
    const nearSaturatedAt = saturatedAt - 500
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: {
          ...CHECKPOINT,
          observedAt: nearSaturatedAt,
          confirmedAt: nearSaturatedAt,
          rateLimit: { state: 'unobserved' },
        },
        mapping: { state: 'valid', configurationRevision: 1, validatedAt: nearSaturatedAt },
        freshness: {
          state: 'stale',
          confirmedAt: nearSaturatedAt,
          staleAt: saturatedAt,
          ageMs: 501,
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: {
          ...CHECKPOINT,
          observedAt: saturatedAt,
          confirmedAt: saturatedAt,
          rateLimit: { state: 'unobserved' },
        },
        mapping: { state: 'valid', configurationRevision: 1, validatedAt: saturatedAt },
        freshness: {
          state: 'fresh',
          confirmedAt: saturatedAt,
          staleAt: saturatedAt,
          ageMs: 0,
        },
      },
    }).success).toBe(true)
    expect(mismatch({
      confirmed: {
        ...CONFIRMED_BOARD,
        project: { ...CONFIRMED_BOARD.project, id: 'PVT_other_project' },
      },
    })).toBe(false)
    expect(mismatch({ checkpoint: undefined })).toBe(false)
    expect(mismatch({
      checkpoint: { ...CHECKPOINT, privateKey: 'private-key-sentinel' },
    })).toBe(false)
    expect(mismatch({
      confirmed: { ...CONFIRMED_BOARD, pageInfo: { hasNextPage: true, endCursor: 'cursor-sentinel' } },
    })).toBe(false)
    expect(sakiBoardResultSchema.safeParse({ ok: false, reason: 'not-found' }).success).toBe(true)
    expect(sakiBoardResultSchema.safeParse({ ok: false, reason: 'stale' }).success).toBe(false)
  })

  it('requires complete Project membership and terminal status for archived Board items', () => {
    const item = CONFIRMED_BOARD.items[0]
    const withItem = (candidate: unknown) => sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: [candidate] },
      },
    }).success

    expect(withItem({
      ...item,
      notInProject: true,
      status: 'inbox',
      latestNonTerminalStatus: 'inbox',
      source: { ...item.source, projectItemId: undefined, apiOrder: undefined },
    })).toBe(true)
    expect(withItem({ ...item, notInProject: true, status: 'inbox' })).toBe(false)
    expect(withItem({
      ...item,
      issueState: 'closed',
      notInProject: true,
      status: 'inbox',
      latestNonTerminalStatus: 'inbox',
      source: { ...item.source, projectItemId: undefined, apiOrder: undefined },
    })).toBe(false)
    expect(withItem({
      ...item,
      notInProject: true,
      source: { kind: 'github-issue', repositoryId: item.source.repositoryId, issueId: item.source.issueId },
    })).toBe(false)
    expect(withItem({
      ...item,
      source: { ...item.source, projectItemId: undefined },
    })).toBe(false)
    expect(withItem({ ...item, archived: true })).toBe(false)
    expect(withItem({ ...item, archived: true, status: 'canceled' })).toBe(true)
    expect(withItem({ ...item, status: { state: 'mapping-repair-required', reason: 'missing-status' } })).toBe(false)
    expect(withItem({ ...item, id: `work-item-${'A'.repeat(64)}` })).toBe(false)
    expect(withItem({ ...item, id: `work-item-${'a'.repeat(64)}` })).toBe(false)
    expect(withItem({ ...item, order: 1 })).toBe(false)
    expect(withItem({ ...item, remoteFingerprint: `remote-fingerprint-${'f'.repeat(63)}` })).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: [item, item] },
      },
    }).success).toBe(false)
    expect(withItem({
      ...item,
      source: { ...item.source, repositoryId: 'R_other_repository' },
    })).toBe(false)

    const second = {
      ...item,
      id: workItemId(item.source.repositoryId, 'I_saki_issue_28'),
      issueNumber: 28,
      order: 1,
      source: {
        ...item.source,
        issueId: 'I_saki_issue_28',
        projectItemId: 'PVTI_saki_item_28',
        apiOrder: 1,
      },
    }
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: [second, item] },
      },
    }).success).toBe(false)
    const unjoined = {
      ...item,
      status: 'inbox',
      latestNonTerminalStatus: 'inbox',
      notInProject: true,
      source: {
        kind: 'github-issue',
        repositoryId: item.source.repositoryId,
        issueId: item.source.issueId,
      },
    }
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: [unjoined, second] },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: [item, { ...second, issueNumber: item.issueNumber }] },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: {
          ...CONFIRMED_BOARD,
          items: [item, { ...second, source: { ...second.source, projectItemId: item.source.projectItemId } }],
        },
      },
    }).success).toBe(false)
  })

  it('accepts the complete product Board limit and rejects one item over it', () => {
    const template = CONFIRMED_BOARD.items[0]
    const items = Array.from({ length: SAKI_BOARD_WORK_ITEM_LIMIT + 1 }, (_, index) => {
      const identity = index.toString(16).padStart(64, '0')
      return {
        ...template,
        id: workItemId(template.source.repositoryId, `I_${identity}`),
        issueNumber: index + 1,
        order: index,
        source: {
          ...template.source,
          issueId: `I_${identity}`,
          projectItemId: `PVTI_${identity}`,
          apiOrder: index,
        },
      }
    })
    const parseItems = (candidateItems: readonly unknown[]) => sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        confirmed: { ...CONFIRMED_BOARD, items: candidateItems },
      },
    }).success

    expect(parseItems(items.slice(0, SAKI_BOARD_WORK_ITEM_LIMIT))).toBe(true)
    expect(parseItems(items)).toBe(false)
    const unread = unreadOversizedArray(SAKI_BOARD_WORK_ITEM_LIMIT + 1)
    expect(parseItems(unread.candidate)).toBe(false)
    expect(unread.elementRead()).toBe(false)
  })

  it('accepts every safe scan evidence discriminant without raw provider details', () => {
    const failureCases = [
      { kind: 'provider', failure: { code: 'cancelled' } },
      { kind: 'provider', failure: { code: 'auth-unavailable', credentialRef: 'SAKI_GITHUB_APP_PRIVATE_KEY' } },
      {
        kind: 'provider',
        failure: {
          code: 'permission-mismatch',
          permission: 'issues',
          required: 'write',
          observed: 'read',
          requestId: 'request/1',
        },
      },
      {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'field-missing-or-not-single-select',
          statusFieldId: CONFIGURATION.statusFieldNodeId,
        },
      },
      {
        kind: 'provider',
        failure: {
          code: 'mapping-mismatch',
          reason: 'required-options-missing',
          statusFieldId: CONFIGURATION.statusFieldNodeId,
          missingRequiredStatusOptionIds: [CONFIGURATION.statusOptionNodeIds.ready],
        },
      },
      { kind: 'provider', failure: { code: 'not-found', resource: 'Project', requestId: 'request-2' } },
      { kind: 'provider', failure: { code: 'invalid-external-response', operation: 'ProjectItems' } },
      { kind: 'provider', failure: { code: 'primary-rate-limit', resetAt: 200 } },
      { kind: 'provider', failure: { code: 'secondary-rate-limit', retryAfterMs: 1_000 } },
      { kind: 'provider', failure: { code: 'transient-transport', retryAfterMs: 1_000 } },
      { kind: 'provider', failure: { code: 'permanent-rejection', status: 422 } },
      {
        kind: 'mapping',
        issues: [{
          reason: 'work-item-status-unknown',
          issueId: 'I_saki_issue_27',
          statusOptionId: 'unknown-option',
        }],
      },
      { kind: 'candidate', reason: 'target-mismatch' },
      {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
      },
      {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT,
      },
      { kind: 'attempt', reason: 'expired' },
    ] as const
    for (const failure of failureCases) {
      const repairIssues = failure.kind === 'mapping'
        ? failure.issues
        : failure.kind === 'provider' && failure.failure.code === 'mapping-mismatch'
          ? failure.failure.reason === 'field-missing-or-not-single-select'
            ? [{ reason: 'status-field-missing' as const, statusFieldId: failure.failure.statusFieldId }]
            : failure.failure.missingRequiredStatusOptionIds.map(statusOptionId => ({
              reason: 'status-option-missing' as const,
              status: 'ready' as const,
              statusOptionId,
            }))
          : undefined
      const parsed = sakiBoardResultSchema.parse({
        ...CONFIRMED_BOARD_RESULT,
        projection: {
          ...CONFIRMED_BOARD_RESULT.projection,
          ...(repairIssues === undefined ? {} : {
            mapping: { state: 'repair-required', configurationRevision: 1, issues: repairIssues },
            effectiveMutationAvailability: {
              available: false,
              reasons: ['mapping-repair-required'],
            },
          }),
          failure: { attemptId: ATTEMPT, configurationRevision: 1, failedAt: 200, failure },
        },
      })
      expect(JSON.stringify(parsed)).not.toContain('SAKI_GITHUB_APP_PRIVATE_KEY')
    }
    const parseRepairEvidence = (
      mappingIssues: readonly unknown[],
      failure: unknown,
    ) => sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        mapping: { state: 'repair-required', configurationRevision: 1, issues: mappingIssues },
        failure: { attemptId: ATTEMPT, configurationRevision: 1, failedAt: 200, failure },
        effectiveMutationAvailability: {
          available: false,
          reasons: ['mapping-repair-required'],
        },
      },
    }).success
    const missingIssue = { reason: 'work-item-status-missing' as const, issueId: 'I_missing_one' }
    expect(parseRepairEvidence([missingIssue], {
      kind: 'mapping',
      issues: [missingIssue, { reason: 'work-item-status-missing', issueId: 'I_missing_two' }],
    })).toBe(false)
    expect(parseRepairEvidence([missingIssue], {
      kind: 'mapping',
      issues: [{
        reason: 'work-item-status-unknown',
        issueId: missingIssue.issueId,
        statusOptionId: 'option-unknown',
      }],
    })).toBe(false)
    expect(parseRepairEvidence([missingIssue], {
      kind: 'capacity',
      resource: 'board-work-items',
      limit: SAKI_BOARD_WORK_ITEM_LIMIT,
      observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
    })).toBe(false)
    expect(parseRepairEvidence([
      {
        reason: 'status-option-missing',
        status: 'ready',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.ready,
      },
      {
        reason: 'status-option-missing',
        status: 'ready',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog,
      },
    ], {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: CONFIGURATION.statusFieldNodeId,
        missingRequiredStatusOptionIds: [
          CONFIGURATION.statusOptionNodeIds.ready,
          CONFIGURATION.statusOptionNodeIds.backlog,
        ],
      },
    })).toBe(false)
    expect(parseRepairEvidence([{
      reason: 'status-option-missing',
      status: 'backlog',
      statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog,
    }], {
      kind: 'provider',
      failure: {
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: CONFIGURATION.statusFieldNodeId,
        missingRequiredStatusOptionIds: [CONFIGURATION.statusOptionNodeIds.ready],
      },
    })).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: {
            kind: 'provider',
            failure: { code: 'transient-transport', responseBody: 'private-provider-sentinel' },
          },
        },
      },
    }).success).toBe(false)
    for (const failure of [
      {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT - 1,
        observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
      },
      {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_BOARD_WORK_ITEM_LIMIT,
      },
      {
        kind: 'capacity',
        resource: 'mapping-issues',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_BOARD_WORK_ITEM_LIMIT + 1,
      },
      {
        kind: 'capacity',
        resource: 'board-work-items',
        limit: SAKI_BOARD_WORK_ITEM_LIMIT,
        observed: SAKI_GITHUB_CAPACITY_OBSERVED_LIMIT + 1,
      },
    ]) {
      expect(sakiBoardResultSchema.safeParse({
        ...CONFIRMED_BOARD_RESULT,
        projection: {
          ...CONFIRMED_BOARD_RESULT.projection,
          failure: { attemptId: ATTEMPT, configurationRevision: 1, failedAt: 200, failure },
        },
      }).success).toBe(false)
    }
    const repeatedMappingIssue = {
      reason: 'status-field-missing' as const,
      statusFieldId: CONFIGURATION.statusFieldNodeId,
    }
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        mapping: {
          state: 'repair-required',
          configurationRevision: 1,
          issues: [repeatedMappingIssue, repeatedMappingIssue],
        },
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: { kind: 'mapping', issues: [repeatedMappingIssue, repeatedMappingIssue] },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: ['mapping-repair-required'],
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        mapping: {
          state: 'repair-required',
          configurationRevision: 1,
          issues: [{ reason: 'status-field-missing', statusFieldId: 'PVTSSF_wrong_status' }],
        },
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: {
            kind: 'provider',
            failure: {
              code: 'mapping-mismatch',
              reason: 'field-missing-or-not-single-select',
              statusFieldId: 'PVTSSF_wrong_status',
            },
          },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: ['mapping-repair-required'],
        },
      },
    }).success).toBe(false)
    for (const missingRequiredStatusOptionIds of [
      [],
      [CONFIGURATION.statusOptionNodeIds.ready, CONFIGURATION.statusOptionNodeIds.ready],
    ]) {
      expect(sakiBoardResultSchema.safeParse({
        ...CONFIRMED_BOARD_RESULT,
        projection: {
          ...CONFIRMED_BOARD_RESULT.projection,
          failure: {
            attemptId: ATTEMPT,
            configurationRevision: 1,
            failedAt: 200,
            failure: {
              kind: 'provider',
              failure: {
                code: 'mapping-mismatch',
                reason: 'required-options-missing',
                statusFieldId: CONFIGURATION.statusFieldNodeId,
                missingRequiredStatusOptionIds,
              },
            },
          },
        },
      }).success).toBe(false)
    }
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: { kind: 'mapping', issues: [] },
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        mapping: {
          state: 'repair-required',
          configurationRevision: 1,
          issues: [{ reason: 'status-field-missing', statusFieldId: 'PVTSSF_wrong_status' }],
        },
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: {
            kind: 'provider',
            failure: {
              code: 'mapping-mismatch',
              reason: 'field-missing-or-not-single-select',
              statusFieldId: CONFIGURATION.statusFieldNodeId,
            },
          },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: ['mapping-repair-required'],
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 0,
          failedAt: 200,
          failure: { kind: 'attempt', reason: 'expired' },
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: { ...CHECKPOINT, rateLimit: { state: 'unobserved' } },
        scan: {
          state: 'in-flight',
          attemptId: ATTEMPT,
          priority: 'background',
          configurationRevision: 1,
          startedAt: 200,
          expiresAt: 300,
        },
      },
    }).success).toBe(true)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        scan: {
          state: 'in-flight',
          attemptId: ATTEMPT,
          priority: 'background',
          configurationRevision: 1,
          startedAt: 200,
          expiresAt: 200,
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        scan: {
          state: 'in-flight',
          attemptId: ATTEMPT,
          priority: 'background',
          configurationRevision: 0,
          startedAt: 200,
          expiresAt: 300,
        },
      },
    }).success).toBe(false)
    expect(sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        checkpoint: {
          ...CHECKPOINT,
          rateLimit: { state: 'limited', observedAt: 100, resetAt: 500 },
        },
      },
    }).success).toBe(true)
  })

  it('accepts only a non-empty field-scoped synchronization configuration Intent', () => {
    const intent = {
      type: 'configure-github-synchronization',
      intentId: INTENT,
      projectId: PROJECT,
      expectedSynchronizationRevision: 2,
      patch: { activePollIntervalMs: 45_000 },
    } as const

    expect(sakiConfigureGitHubSynchronizationIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({ ...intent, patch: {} }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { activePollIntervalMs: undefined },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { activePollIntervalMs: 45_000, grantRevision: 7 },
    }).success).toBe(false)
  })

  it('accepts the exact mapping-evidence limit and rejects impossible or oversized lists', () => {
    const itemIssues = Array.from({ length: SAKI_BOARD_WORK_ITEM_LIMIT + 1 }, (_, index) => ({
      reason: 'work-item-status-missing' as const,
      issueId: `I_saki_issue_${index}`,
    }))
    const optionIssues = [
      { reason: 'status-option-missing', status: 'inbox', statusOptionId: CONFIGURATION.statusOptionNodeIds.inbox },
      { reason: 'status-option-missing', status: 'backlog', statusOptionId: CONFIGURATION.statusOptionNodeIds.backlog },
      { reason: 'status-option-missing', status: 'ready', statusOptionId: CONFIGURATION.statusOptionNodeIds.ready },
      {
        reason: 'status-option-missing',
        status: 'in-progress',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.inProgress,
      },
      {
        reason: 'status-option-missing',
        status: 'in-review',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.inReview,
      },
      { reason: 'status-option-missing', status: 'done', statusOptionId: CONFIGURATION.statusOptionNodeIds.done },
      {
        reason: 'status-option-missing',
        status: 'canceled',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.canceled,
      },
    ] as const
    const parseIssues = (candidateIssues: readonly unknown[]) => sakiBoardResultSchema.safeParse({
      ...CONFIRMED_BOARD_RESULT,
      projection: {
        ...CONFIRMED_BOARD_RESULT.projection,
        mapping: { state: 'repair-required', configurationRevision: 1, issues: candidateIssues },
        failure: {
          attemptId: ATTEMPT,
          configurationRevision: 1,
          failedAt: 200,
          failure: { kind: 'mapping', issues: candidateIssues },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: ['mapping-repair-required'],
        },
      },
    }).success

    const complete = [...itemIssues.slice(0, SAKI_BOARD_WORK_ITEM_LIMIT), ...optionIssues]
    expect(complete).toHaveLength(SAKI_GITHUB_MAPPING_ISSUE_LIMIT)
    expect(parseIssues(complete)).toBe(true)
    expect(parseIssues(itemIssues)).toBe(false)
    expect(parseIssues([
      { reason: 'work-item-status-missing', issueId: 'I_same' },
      { reason: 'work-item-status-unknown', issueId: 'I_same', statusOptionId: 'option-unknown' },
    ])).toBe(false)
    expect(parseIssues([
      { reason: 'status-field-missing', statusFieldId: CONFIGURATION.statusFieldNodeId },
      optionIssues[0],
    ])).toBe(false)
    expect(parseIssues([
      optionIssues[0],
      { ...optionIssues[0], statusOptionId: 'option-other-inbox' },
    ])).toBe(false)
    expect(parseIssues([
      optionIssues[0],
      { ...optionIssues[1], statusOptionId: optionIssues[0].statusOptionId },
    ])).toBe(false)
    expect(parseIssues([
      ...optionIssues,
      { ...optionIssues[0], statusOptionId: 'option-extra-inbox' },
    ])).toBe(false)
    expect(parseIssues([
      { reason: 'status-field-missing', statusFieldId: 'PVTSSF_wrong_status' },
    ])).toBe(false)
    const unread = unreadOversizedArray(SAKI_GITHUB_MAPPING_ISSUE_LIMIT + 1)
    expect(parseIssues(unread.candidate)).toBe(false)
    expect(unread.elementRead()).toBe(false)
  }, 30_000)

  it('validates the complete provider-neutral configuration and bounded polling controls', () => {
    const intent = {
      type: 'configure-github-synchronization',
      intentId: INTENT,
      projectId: PROJECT,
      expectedSynchronizationRevision: 0,
      patch: CONFIGURATION,
    } as const

    expect(sakiConfigureGitHubSynchronizationIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { ...CONFIGURATION, appId: 'Iv1.not-a-decimal-app-id' },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { ...CONFIGURATION, repositoryDatabaseId: '0' },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { ...CONFIGURATION, projectNodeId: 'project\nnode' },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: {
        ...CONFIGURATION,
        statusOptionNodeIds: { ...CONFIGURATION.statusOptionNodeIds, done: CONFIGURATION.statusOptionNodeIds.ready },
      },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { ...CONFIGURATION, activePollIntervalMs: 999 },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationIntentSchema.safeParse({
      ...intent,
      patch: { ...CONFIGURATION, rateLimitReserve: 5_001 },
    }).success).toBe(false)
  })

  it('projects saved GitHub settings without admitting credential material or duplicate fields', () => {
    const result = {
      ok: true,
      projection: {
        type: 'project-settings',
        projectId: PROJECT,
        synchronization: {
          revision: 1,
          state: 'saved',
          pending: {
            revision: 1,
            changedFields: Object.keys(CONFIGURATION),
            state: 'saved',
            configuration: CONFIGURATION,
            savedAt: 123,
          },
          ...SAVED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    } as const

    expect(sakiProjectSettingsResultSchema.parse(result)).toEqual(result)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        synchronization: {
          ...result.projection.synchronization,
          pending: {
            ...result.projection.synchronization.pending,
            changedFields: ['activePollIntervalMs', 'activePollIntervalMs'],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        synchronization: {
          ...result.projection.synchronization,
          pending: {
            ...result.projection.synchronization.pending,
            changedFields: ['activePollIntervalMs'],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        synchronization: {
          ...result.projection.synchronization,
          pending: {
            ...result.projection.synchronization.pending,
            configuration: {
              ...result.projection.synchronization.pending.configuration,
              privateKey: 'private-key-sentinel',
            },
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({ ok: false, reason: 'not-found' }).success).toBe(true)
  })

  it('rejects Project Settings evidence outside the current configuration', () => {
    const result = {
      ok: true,
      projection: {
        type: 'project-settings',
        projectId: PROJECT,
        synchronization: {
          revision: 2,
          state: 'activation-failed',
          pending: {
            revision: 2,
            changedFields: Object.keys(CONFIGURATION),
            state: 'activation-failed',
            configuration: CONFIGURATION,
            savedAt: 123,
          },
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          failure: {
            attemptId: ATTEMPT,
            configurationRevision: 2,
            failedAt: 200,
            failure: { kind: 'provider', failure: { code: 'transient-transport' } },
          },
          freshness: { state: 'unavailable' },
          scan: { state: 'scheduled', priority: 'background', reason: 'retry', attemptAt: 300 },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
              'checkpoint-unavailable',
            ],
          },
        },
      },
    } as const
    const parseSettings = (synchronization: unknown) => sakiProjectSettingsResultSchema.safeParse({
      ...result,
      projection: { ...result.projection, synchronization },
    }).success

    expect(sakiProjectSettingsResultSchema.parse(result)).toEqual(result)
    expect(parseSettings({
      ...result.projection.synchronization,
      mapping: { state: 'revalidation-required', configurationRevision: 1 },
    })).toBe(false)
    expect(parseSettings({
      ...result.projection.synchronization,
      failure: { ...result.projection.synchronization.failure, configurationRevision: 1 },
    })).toBe(false)
    expect(parseSettings({
      ...result.projection.synchronization,
      effectiveMutationAvailability: {
        available: false,
        reasons: ['configuration-not-activated', 'mapping-revalidation-required'],
      },
    })).toBe(false)
    expect(parseSettings({
      ...result.projection.synchronization,
      state: 'saved',
      pending: { ...result.projection.synchronization.pending, state: 'saved' },
    })).toBe(false)
    expect(parseSettings({
      ...result.projection.synchronization,
      mapping: {
        state: 'repair-required',
        configurationRevision: 2,
        issues: [{
          reason: 'status-option-missing',
          status: 'backlog',
          statusOptionId: CONFIGURATION.statusOptionNodeIds.ready,
        }],
      },
      failure: {
        ...result.projection.synchronization.failure,
        failure: {
          kind: 'provider',
          failure: {
            code: 'mapping-mismatch',
            reason: 'required-options-missing',
            statusFieldId: CONFIGURATION.statusFieldNodeId,
            missingRequiredStatusOptionIds: [CONFIGURATION.statusOptionNodeIds.ready],
          },
        },
      },
      effectiveMutationAvailability: {
        available: false,
        reasons: [
          'configuration-not-activated',
          'mapping-repair-required',
          'checkpoint-unavailable',
        ],
      },
    })).toBe(false)
    for (const issues of [
      [{ reason: 'status-field-missing' as const, statusFieldId: 'PVTSSF_wrong_status' }],
      [{
        reason: 'status-option-missing' as const,
        status: 'backlog' as const,
        statusOptionId: CONFIGURATION.statusOptionNodeIds.ready,
      }],
      [{
        reason: 'work-item-status-unknown' as const,
        issueId: 'I_saki_issue_27',
        statusOptionId: CONFIGURATION.statusOptionNodeIds.ready,
      }],
    ]) {
      expect(parseSettings({
        ...result.projection.synchronization,
        mapping: { state: 'repair-required', configurationRevision: 2, issues },
        failure: {
          ...result.projection.synchronization.failure,
          failure: { kind: 'mapping', issues },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: [
            'configuration-not-activated',
            'mapping-repair-required',
            'checkpoint-unavailable',
          ],
        },
      })).toBe(false)
    }
    const configuredOptionFailure = (statusOptionId: string) => ({
      kind: 'provider' as const,
      failure: {
        code: 'mapping-mismatch' as const,
        reason: 'required-options-missing' as const,
        statusFieldId: CONFIGURATION.statusFieldNodeId,
        missingRequiredStatusOptionIds: [statusOptionId],
      },
    })
    const configuredOptionRepair = (statusOptionId: string) => ({
      ...result.projection.synchronization,
      mapping: {
        state: 'repair-required' as const,
        configurationRevision: 2,
        issues: [{ reason: 'status-option-missing' as const, status: 'ready' as const, statusOptionId }],
      },
      failure: {
        ...result.projection.synchronization.failure,
        failure: configuredOptionFailure(statusOptionId),
      },
      effectiveMutationAvailability: {
        available: false as const,
        reasons: [
          'configuration-not-activated' as const,
          'mapping-repair-required' as const,
          'checkpoint-unavailable' as const,
        ],
      },
    })
    expect(parseSettings(configuredOptionRepair(CONFIGURATION.statusOptionNodeIds.ready))).toBe(true)
    expect(parseSettings(configuredOptionRepair('option-not-configured'))).toBe(false)
    for (const failure of [
      {
        code: 'mapping-mismatch' as const,
        reason: 'field-missing-or-not-single-select' as const,
        statusFieldId: 'PVTSSF_wrong_status',
      },
      {
        code: 'mapping-mismatch' as const,
        reason: 'required-options-missing' as const,
        statusFieldId: 'PVTSSF_wrong_status',
        missingRequiredStatusOptionIds: [CONFIGURATION.statusOptionNodeIds.ready],
      },
    ]) {
      const issues = failure.reason === 'field-missing-or-not-single-select'
        ? [{ reason: 'status-field-missing' as const, statusFieldId: failure.statusFieldId }]
        : [{
          reason: 'status-option-missing' as const,
          status: 'ready' as const,
          statusOptionId: CONFIGURATION.statusOptionNodeIds.ready,
        }]
      expect(parseSettings({
        ...result.projection.synchronization,
        mapping: {
          state: 'repair-required',
          configurationRevision: 2,
          issues,
        },
        failure: {
          ...result.projection.synchronization.failure,
          failure: { kind: 'provider', failure },
        },
        effectiveMutationAvailability: {
          available: false,
          reasons: [
            'configuration-not-activated',
            'mapping-repair-required',
            'checkpoint-unavailable',
          ],
        },
      })).toBe(false)
    }
  })

  it('requires Project Settings state to agree with active and pending configuration', () => {
    const unconfigured = {
      ok: true,
      projection: {
        type: 'project-settings',
        projectId: PROJECT,
        synchronization: {
          revision: 0,
          state: 'unconfigured',
          ...UNCONFIGURED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    } as const
    expect(sakiProjectSettingsResultSchema.parse(unconfigured)).toEqual(unconfigured)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        synchronization: {
          revision: 1,
          state: 'unconfigured',
          ...UNCONFIGURED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        synchronization: {
          revision: 1,
          state: 'saved',
          mapping: { state: 'revalidation-required', configurationRevision: 1 },
          freshness: { state: 'unavailable' },
          scan: { state: 'idle' },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
              'checkpoint-unavailable',
            ],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        synchronization: {
          ...unconfigured.projection.synchronization,
          failure: {
            attemptId: ATTEMPT,
            configurationRevision: 1,
            failedAt: 200,
            failure: { kind: 'attempt', reason: 'expired' },
          },
        },
      },
    }).success).toBe(false)

    const active = { revision: 1, configuration: CONFIGURATION, activatedAt: 200 } as const
    const activated = {
      ...unconfigured,
      projection: {
        ...unconfigured.projection,
        synchronization: {
          revision: 1,
          state: 'activated',
          active,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    } as const
    expect(sakiProjectSettingsResultSchema.parse(activated)).toEqual(activated)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          freshness: { state: 'fresh', confirmedAt: 110, staleAt: 30_111, ageMs: 0 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          freshness: { state: 'fresh', confirmedAt: 109, staleAt: 30_109, ageMs: 0 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          mapping: { state: 'unconfigured' },
        },
      },
    }).success).toBe(false)
    const saturatedAt = Number.MAX_SAFE_INTEGER
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          checkpoint: {
            ...CHECKPOINT,
            observedAt: saturatedAt,
            confirmedAt: saturatedAt,
            rateLimit: { state: 'unobserved' },
          },
          mapping: { state: 'valid', configurationRevision: 1, validatedAt: saturatedAt },
          freshness: {
            state: 'stale',
            confirmedAt: saturatedAt,
            staleAt: saturatedAt,
            ageMs: 0,
          },
        },
      },
    }).success).toBe(true)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: { ...activated.projection.synchronization, revision: 0 },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          active: { ...active, revision: 0 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          active: { ...active, revision: 2 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          active: {
            ...active,
            configuration: { ...active.configuration, repositoryNodeId: 'R_other_repository' },
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 1,
          state: 'activated',
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    }).success).toBe(false)

    const { checkpoint: _checkpoint, ...evidenceWithoutCheckpoint } = CONFIRMED_SYNCHRONIZATION_EVIDENCE
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 1,
          state: 'activated',
          active,
          ...evidenceWithoutCheckpoint,
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 1,
          state: 'activated',
          active,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          freshness: { state: 'unavailable' },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 1,
          state: 'activated',
          active,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'valid', configurationRevision: 2, validatedAt: 110 },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          ...activated.projection.synchronization,
          mapping: { state: 'valid', configurationRevision: 1, validatedAt: 109 },
        },
      },
    }).success).toBe(false)

    const pending = {
      revision: 2,
      changedFields: ['activePollIntervalMs'],
      state: 'saved',
      configuration: { ...CONFIGURATION, activePollIntervalMs: 45_000 },
      savedAt: 300,
    } as const
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'saved',
          active,
          pending: { ...pending, revision: 0 },
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 1,
          state: 'saved',
          pending: { ...pending, revision: 1 },
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.parse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'saved',
          active,
          pending,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
            ],
          },
        },
      },
    })).toMatchObject({
      projection: { synchronization: { state: 'saved', active, pending } },
    })
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'saved',
          active,
          pending,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          scan: {
            state: 'in-flight',
            attemptId: ATTEMPT,
            priority: 'background',
            configurationRevision: 2,
            startedAt: 301,
            expiresAt: 401,
          },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
            ],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'activation-failed',
          active,
          pending: { ...pending, state: 'activation-failed' },
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          scan: { state: 'scheduled', priority: 'background', reason: 'retry', attemptAt: 400 },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
            ],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'saved',
          active,
          pending: { ...pending, changedFields: ['repositoryNodeId'] },
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
            ],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'activating',
          active,
          pending: { ...pending, state: 'activating' },
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
          mapping: { state: 'revalidation-required', configurationRevision: 2 },
          scan: {
            state: 'in-flight',
            attemptId: ATTEMPT,
            priority: 'background',
            configurationRevision: 2,
            startedAt: 301,
            expiresAt: 401,
          },
          effectiveMutationAvailability: {
            available: false,
            reasons: [
              'configuration-not-activated',
              'mapping-revalidation-required',
            ],
          },
        },
      },
    }).success).toBe(true)
    expect(sakiProjectSettingsResultSchema.safeParse({
      ...activated,
      projection: {
        ...activated.projection,
        synchronization: {
          revision: 2,
          state: 'activating',
          active,
          pending,
          ...CONFIRMED_SYNCHRONIZATION_EVIDENCE,
        },
      },
    }).success).toBe(false)
  })

  it('correlates Project Settings queries and configuration receipt phases', () => {
    expect(sakiQueryRequestSchema.parse({ type: 'project-settings', projectId: PROJECT }))
      .toEqual({ type: 'project-settings', projectId: PROJECT })
    expect(sakiQueryRequestSchema.safeParse({
      type: 'project-settings',
      projectId: PROJECT,
      principalId: 'principal-spoof',
    }).success).toBe(false)

    const saved = {
      ok: true,
      receipt: {
        id: 'receipt-33333333-3333-4333-8333-333333333333',
        intentId: INTENT,
        state: 'saved',
        projectId: PROJECT,
        synchronizationRevision: 1,
        candidateRevision: 1,
      },
    } as const
    expect(sakiConfigureGitHubSynchronizationResultSchema.parse(saved)).toEqual(saved)
    expect(sakiConfigureGitHubSynchronizationResultSchema.safeParse({
      ...saved,
      receipt: { ...saved.receipt, id: 'receipt-44444444-4444-4444-8444-444444444444' },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationResultSchema.safeParse({
      ...saved,
      receipt: { ...saved.receipt, candidateRevision: 2 },
    }).success).toBe(false)
    expect(sakiConfigureGitHubSynchronizationResultSchema.safeParse({
      ok: false,
      reason: 'conflict',
      receipt: {
        id: 'receipt-33333333-3333-4333-8333-333333333333',
        intentId: INTENT,
        state: 'conflict',
        reason: 'configuration-incomplete',
      },
    }).success).toBe(true)
    expect(sakiConfigureGitHubSynchronizationResultSchema.safeParse({
      ok: false,
      reason: 'conflict',
      receipt: {
        id: 'receipt-33333333-3333-4333-8333-333333333333',
        intentId: INTENT,
        state: 'conflict',
        reason: 'configuration-unchanged',
      },
    }).success).toBe(true)
    expect(sakiConfigureGitHubSynchronizationResultSchema.safeParse({
      ok: false,
      reason: 'reconciliation-required',
    }).success).toBe(false)
  })
})
