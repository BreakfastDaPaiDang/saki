import { describe, expect, it } from 'vitest'
import type {
  GitHubProjectItemFact,
  GitHubTargetedWorkItemSnapshot,
} from '@breakfastdapaidang/saki-github'
import {
  githubIssueId,
  githubProjectFieldId,
  githubProjectId,
  githubProjectItemId,
  githubProjectOptionId,
  githubRepositoryDatabaseId,
  githubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import {
  joinedBoardRemoteFingerprint,
  targetedBoardRemoteFingerprint,
  unjoinedBoardRemoteFingerprint,
} from '../src/work-item-mapping.ts'

const ISSUE = {
  id: githubIssueId('I_issue'),
  repositoryId: githubRepositoryId('R_repo'),
  repositoryDatabaseId: githubRepositoryDatabaseId('7'),
  number: 12,
  state: 'open',
  title: 'Preserve one mapping rule',
  url: 'https://github.com/example/repo/issues/12',
  updatedAt: 100,
} as const

const ITEMS = [
  {
    id: githubProjectItemId('PVTI_previous'),
    projectId: githubProjectId('P_project'),
    content: { kind: 'redacted' },
    archived: false,
    apiOrder: 0,
    updatedAt: 90,
  },
  {
    id: githubProjectItemId('PVTI_issue'),
    projectId: githubProjectId('P_project'),
    content: { kind: 'issue', issue: ISSUE },
    statusOptionId: githubProjectOptionId('O_ready'),
    archived: false,
    apiOrder: 1,
    updatedAt: 100,
  },
  {
    id: githubProjectItemId('PVTI_next'),
    projectId: githubProjectId('P_project'),
    content: { kind: 'draft-issue', title: 'Unmanaged neighbor' },
    archived: false,
    apiOrder: 2,
    updatedAt: 95,
  },
] as const satisfies readonly GitHubProjectItemFact[]

describe('Work Item remote fingerprint mapping', () => {
  it('gives a targeted joined observation the same identity as a complete Board scan', () => {
    const snapshot = {
      repositoryId: ISSUE.repositoryId,
      repositoryDatabaseId: ISSUE.repositoryDatabaseId,
      projectId: ITEMS[1].projectId,
      statusFieldId: githubProjectFieldId('F_status'),
      issue: ISSUE,
      membership: {
        state: 'present',
        item: {
          id: ITEMS[1].id,
          projectId: ITEMS[1].projectId,
          issueId: ISSUE.id,
          statusOptionId: ITEMS[1].statusOptionId,
          archived: ITEMS[1].archived,
          apiOrder: ITEMS[1].apiOrder,
          totalCount: ITEMS.length,
          previousItemId: ITEMS[0].id,
          nextItemId: ITEMS[2].id,
          updatedAt: ITEMS[1].updatedAt,
        },
      },
    } as const satisfies GitHubTargetedWorkItemSnapshot

    expect(targetedBoardRemoteFingerprint(snapshot)).toBe(
      joinedBoardRemoteFingerprint(ITEMS, ITEMS[1], ISSUE.state),
    )
  })

  it('gives a targeted absent observation the same Inbox identity as a complete Board scan', () => {
    const snapshot = {
      repositoryId: ISSUE.repositoryId,
      repositoryDatabaseId: ISSUE.repositoryDatabaseId,
      projectId: githubProjectId('P_project'),
      statusFieldId: githubProjectFieldId('F_status'),
      issue: ISSUE,
      membership: { state: 'absent' },
    } as const satisfies GitHubTargetedWorkItemSnapshot

    expect(targetedBoardRemoteFingerprint(snapshot)).toBe(
      unjoinedBoardRemoteFingerprint(ISSUE.repositoryId, ISSUE.id, ISSUE.state),
    )
  })
})
