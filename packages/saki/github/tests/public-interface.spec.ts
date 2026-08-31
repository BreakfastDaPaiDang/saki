import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import {
  GitHubProviderError,
  SakiGitHub,
  githubIssueCreateInspectionHintSchema,
  githubProjectBoardScanCandidateSchema,
  githubProjectBoardScanRequestSchema,
  githubProjectItemAddInspectionSchema,
  githubProjectItemPositionSetInspectionSchema,
  githubIssueStateSetInspectionSchema,
  githubIssueCreateInspectionSchema,
  githubIssueCreateRequestSchema,
  githubProjectItemStatusSetInspectionSchema,
} from '../src/index.ts'
import type { GitHubMutationMap, GitHubReadMap, GitHubScanMap } from '../src/index.ts'
import { runGitHubProviderContract } from './contract.ts'
import {
  COMPLETE_SCAN,
  INSTALLATION,
  INSTALLATION_REQUEST,
  ISSUE_STATE_SET_INSPECTION,
  ISSUE_STATE_SET_REQUEST,
  ISSUE_CREATE_INSPECTION,
  ISSUE_CREATE_RESULT,
  ISSUE_CREATE_REQUEST,
  POSITION_SET_INSPECTION,
  POSITION_SET_REQUEST,
  PROJECT_ITEM_ADD_INSPECTION,
  PROJECT_ITEM_ADD_REQUEST,
  SCAN_REQUEST,
  STATUS_SET_INSPECTION,
  STATUS_SET_REQUEST,
} from './fixtures.ts'

class FakeGitHub extends SakiGitHub {
  override async read<K extends keyof GitHubReadMap>(
    request: GitHubReadMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubReadMap[K]['result']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    if (request.kind === 'installation') {
      return structuredClone(INSTALLATION)
    }
    throw new GitHubProviderError({ code: 'not-found', resource: request.kind })
  }

  override async scan<K extends keyof GitHubScanMap>(
    request: GitHubScanMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubScanMap[K]['result']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    const admitted = githubProjectBoardScanRequestSchema.parse(request)
    const status = COMPLETE_SCAN.fields.find(field => field.id === admitted.statusFieldId)
    if (status?.kind !== 'single-select') {
      throw new GitHubProviderError({
        code: 'mapping-mismatch',
        reason: 'field-missing-or-not-single-select',
        statusFieldId: admitted.statusFieldId,
      })
    }
    const missingRequiredStatusOptionIds = admitted.requiredStatusOptionIds.filter(
      id => !status.options.some(option => option.id === id),
    )
    if (missingRequiredStatusOptionIds.length > 0) {
      throw new GitHubProviderError({
        code: 'mapping-mismatch',
        reason: 'required-options-missing',
        statusFieldId: admitted.statusFieldId,
        missingRequiredStatusOptionIds,
      })
    }
    return structuredClone(COMPLETE_SCAN)
  }

  override async dispatch<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['result']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    if (request.kind === 'project-item-add') {
      return undefined
    }
    if (request.kind === 'issue-create') {
      githubIssueCreateRequestSchema.parse(request)
      return structuredClone(githubIssueCreateInspectionHintSchema.parse(ISSUE_CREATE_RESULT))
    }
    if (request.kind === 'project-item-position-set') {
      return undefined
    }
    if (request.kind === 'issue-state-set') {
      return undefined
    }
    return undefined
  }

  override async inspectMutation<K extends keyof GitHubMutationMap>(
    request: GitHubMutationMap[K]['request'],
    signal: AbortSignal,
  ): Promise<GitHubMutationMap[K]['inspection']> {
    if (signal.aborted) throw new GitHubProviderError({ code: 'cancelled' })
    if (request.kind === 'project-item-add') {
      return structuredClone(githubProjectItemAddInspectionSchema.parse(PROJECT_ITEM_ADD_INSPECTION))
    }
    if (request.kind === 'issue-create') {
      githubIssueCreateRequestSchema.parse(request)
      return structuredClone(githubIssueCreateInspectionSchema.parse(ISSUE_CREATE_INSPECTION))
    }
    if (request.kind === 'project-item-position-set') {
      return structuredClone(githubProjectItemPositionSetInspectionSchema.parse(POSITION_SET_INSPECTION))
    }
    if (request.kind === 'issue-state-set') {
      return structuredClone(githubIssueStateSetInspectionSchema.parse(ISSUE_STATE_SET_INSPECTION))
    }
    return structuredClone(githubProjectItemStatusSetInspectionSchema.parse(STATUS_SET_INSPECTION))
  }
}

it('reads one complete single-page Project board scan through the public service', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  const result = await github.scan(SCAN_REQUEST, new AbortController().signal)

  expect(githubProjectBoardScanCandidateSchema.parse(result)).toEqual(COMPLETE_SCAN)
  expect(result.items[0]?.content.kind).toBe('issue')
  await ctx.fiber.dispose()
})

it('dispatches one Project item Status mutation through the public service', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  await expect(github.dispatch(STATUS_SET_REQUEST, new AbortController().signal)).resolves.toBeUndefined()
  await ctx.fiber.dispose()
})

it('dispatches one Project membership mutation without a pre-existing item id', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  await expect(github.dispatch<'project-item-add'>(
    PROJECT_ITEM_ADD_REQUEST,
    new AbortController().signal,
  )).resolves.toBeUndefined()

  expect(PROJECT_ITEM_ADD_REQUEST).not.toHaveProperty('projectItemId')
  await ctx.fiber.dispose()
})

it('inspects one targeted Work Item without publishing a complete Board checkpoint', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  const inspection = await github.inspectMutation(STATUS_SET_REQUEST, new AbortController().signal)

  expect(inspection).toMatchObject({
    snapshot: {
      repositoryId: STATUS_SET_REQUEST.repositoryId,
      repositoryDatabaseId: STATUS_SET_REQUEST.repositoryDatabaseId,
      projectId: STATUS_SET_REQUEST.projectId,
      statusFieldId: STATUS_SET_REQUEST.statusFieldId,
      issue: { id: STATUS_SET_REQUEST.issueId, state: 'open' },
      membership: {
        state: 'present',
        item: {
          id: STATUS_SET_REQUEST.projectItemId,
          statusOptionId: SCAN_REQUEST.requiredStatusOptionIds[1],
          archived: false,
          apiOrder: 0,
        },
      },
    },
  })
  expect(Object.keys(inspection).sort()).toEqual([
    'observedAt',
    'snapshot',
  ])
  expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
  await ctx.fiber.dispose()
})

it('inspects Project membership by Issue identity before an add has an item id', async () => {
  const ctx = new Context()
  const github = new FakeGitHub(ctx)

  const inspection = await github.inspectMutation<'project-item-add'>(
    PROJECT_ITEM_ADD_REQUEST,
    new AbortController().signal,
  )

  expect(inspection).toEqual(PROJECT_ITEM_ADD_INSPECTION)
  expect(JSON.stringify(inspection)).not.toMatch(/checkpoint|generation|cursor/u)
  await ctx.fiber.dispose()
})

runGitHubProviderContract('fake', async () => {
  const ctx = new Context()
  return {
    github: new FakeGitHub(ctx),
    installationRequest: INSTALLATION_REQUEST,
    scanRequest: SCAN_REQUEST,
    expectedInstallation: INSTALLATION,
    expectedScan: COMPLETE_SCAN,
    projectItemAddRequest: PROJECT_ITEM_ADD_REQUEST,
    expectedProjectItemAddInspection: PROJECT_ITEM_ADD_INSPECTION,
    positionRequest: POSITION_SET_REQUEST,
    expectedPositionInspection: POSITION_SET_INSPECTION,
    issueStateRequest: ISSUE_STATE_SET_REQUEST,
    expectedIssueStateInspection: ISSUE_STATE_SET_INSPECTION,
    issueCreateRequest: ISSUE_CREATE_REQUEST,
    expectedIssueCreateResult: ISSUE_CREATE_RESULT,
    expectedIssueCreateInspection: ISSUE_CREATE_INSPECTION,
    mutationRequest: STATUS_SET_REQUEST,
    expectedMutationInspection: STATUS_SET_INSPECTION,
    dispose: () => ctx.fiber.dispose(),
  }
})
