import { describe, expect, it } from 'vitest'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import type {
  GitHubCommitId,
  GitHubCommitStatusId,
  GitHubIssueId,
  GitHubMilestoneId,
  GitHubProjectId,
  GitHubPullRequestId,
  GitHubReleaseId,
  GitHubReleaseTagName,
  GitHubRepositoryDatabaseId,
  GitHubRepositoryId,
} from '@breakfastdapaidang/saki-github'
import type {
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiControlIntentId,
} from '../src/types.ts'
import {
  evaluateReleaseEvidencePolicyV1,
  RELEASE_EVIDENCE_POLICY_V1,
  releaseEvidencePolicyV1EvidenceSchema,
  type ReleaseEvidencePolicyV1Evidence,
  type ReleaseEvidencePolicyV1Input,
  type ReleaseEvidencePolicyV1Snapshot,
} from '../src/release-evidence-policy.ts'

const REPOSITORY_ID = 'R_release' as GitHubRepositoryId
const UPSTREAM_REPOSITORY_ID = 'R_upstream' as GitHubRepositoryId
const PROJECT_ID = 'P_release' as GitHubProjectId
const MILESTONE_ID = 'M_release' as GitHubMilestoneId
const ISSUE_ID = 'I_release' as GitHubIssueId
const REPOSITORY_DATABASE_ID = '12' as GitHubRepositoryDatabaseId
const UPSTREAM_REPOSITORY_DATABASE_ID = '34' as GitHubRepositoryDatabaseId
const WORK_ITEM_ID = `work-item-${'d'.repeat(64)}` as SakiBoardWorkItemId
const COMMIT_ID = '1234567890abcdef1234567890abcdef12345678' as GitHubCommitId
const TAG_NAME = 'saki-v0.1.0' as GitHubReleaseTagName

describe('ReleaseEvidencePolicyV1', () => {
  it('publishes one immutable fact only after a matching final reread', () => {
    const result = evaluateReleaseEvidencePolicyV1(validInput())

    expect(result).toMatchObject({
      ok: true,
      evidence: {
        policy: RELEASE_EVIDENCE_POLICY_V1,
        projectId: PROJECT_ID,
        boardGeneration: 8,
        milestoneId: MILESTONE_ID,
        workItems: [{ workItemId: WORK_ITEM_ID, status: 'done' }],
        deliveries: [{
          workItemId: WORK_ITEM_ID,
          commitId: COMMIT_ID,
          headRef: 'refs/heads/feature/b10',
          baseRef: 'refs/heads/master',
        }],
        upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
        upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
        upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
        confirmedAt: 3_000,
      },
    })
    if (!result.ok) throw new Error('valid release evidence was rejected')
    expect(result.evidence.evaluationDigest).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('accepts an unchanged fresh Board reread with a newer generation', () => {
    const input = validInput()
    const board = input.finalReread.board.confirmed
    if (board === undefined) throw new Error('fixture Board is missing')

    const result = evaluateReleaseEvidencePolicyV1({
      ...input,
      finalReread: {
        ...input.finalReread,
        board: {
          confirmed: {
            ...board,
            value: { ...board.value, generation: board.value.generation + 1 },
          },
        },
      },
    })

    expect(result).toMatchObject({ ok: true, evidence: { boardGeneration: 9 } })
    if (!result.ok) throw new Error('unchanged fresh Board reread was rejected')
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse({
      ...result.evidence,
      boardGeneration: result.evidence.boardGeneration - 1,
    }).success).toBe(false)
  })

  it('rejects a final reread that predates evaluation', () => {
    const input = validInput()
    expect(() => evaluateReleaseEvidencePolicyV1({
      ...input,
      finalReread: { ...input.finalReread, capturedAt: input.evaluatedAt - 1 },
    })).toThrow('release evidence evaluation timestamps are not monotonic')
  })

  it('rejects an invalid observation freshness budget', () => {
    expect(() => evaluateReleaseEvidencePolicyV1({
      ...validInput(),
      maxObservationAgeMs: 0,
    })).toThrow('release evidence freshness must be one positive safe integer')
  })

  it('fails closed when a source disappears only during the final reread', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      finalReread: { ...input.finalReread, releaseCommit: {} },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'source-unavailable', pass: 'final-reread', source: 'release-commit' }],
    })
  })

  it('requires a fresh post-Intent Board checkpoint', () => {
    const input = validInput()
    const board = input.evaluation.board.confirmed
    if (board === undefined) throw new Error('fixture Board is missing')

    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        board: { confirmed: { ...board, observedAt: input.preparedAt - 1 } },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'source-stale', pass: 'evaluation', source: 'board' }],
    })
  })

  it('preserves a confirmed fact but rejects a newer source failure', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        milestone: {
          ...input.evaluation.milestone,
          failure: { failure: { code: 'transient-transport' }, failedAt: 1_950 },
        },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'source-failed', pass: 'evaluation', source: 'milestone' }],
    })
  })

  it('rejects a targeted fact invalidated after its last confirmation', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        board: { ...input.evaluation.board, invalidatedAt: 1_950 },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'source-invalidated', pass: 'evaluation', source: 'board' }],
    })
  })

  it('rejects an incomplete Milestone-to-Board mapping', () => {
    const input = validInput()
    const board = input.evaluation.board.confirmed
    if (board === undefined) throw new Error('fixture Board is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        board: { confirmed: { ...board, value: { ...board.value, items: [] } } },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'scope-unmapped', issueId: ISSUE_ID }],
    })
  })

  it('does not map a same-id Milestone issue from another repository', () => {
    const input = validInput()
    const milestone = input.evaluation.milestone.confirmed
    if (milestone === undefined) throw new Error('fixture Milestone is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        milestone: {
          confirmed: {
            ...milestone,
            value: {
              ...milestone.value,
              issues: milestone.value.issues.map(issue => ({
                ...issue,
                repositoryId: UPSTREAM_REPOSITORY_ID,
              })),
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'scope-unmapped', issueId: ISSUE_ID }],
    })
  })

  it('rejects every nonterminal Work Item in the complete scope', () => {
    const input = validInput()
    const board = input.evaluation.board.confirmed
    if (board === undefined) throw new Error('fixture Board is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        board: {
          confirmed: {
            ...board,
            value: {
              ...board.value,
              items: board.value.items.map(item => ({ ...item, status: 'in-review' as const })),
            },
          },
        },
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'work-item-nonterminal', workItemId: WORK_ITEM_ID }],
    })
  })

  it('rejects a closed or empty mismatched Milestone scope', () => {
    const input = validInput()
    const milestone = input.evaluation.milestone.confirmed
    if (milestone === undefined) throw new Error('fixture Milestone is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        milestone: {
          confirmed: {
            ...milestone,
            value: { ...milestone.value, number: 2, state: 'closed', issues: [] },
          },
        },
      },
    })).toEqual({
      ok: false,
      blockages: [
        { kind: 'milestone-target-mismatch' },
        { kind: 'milestone-closed' },
        { kind: 'scope-empty' },
      ],
    })
  })

  it('accepts a terminal canceled item without inventing a Branch Delivery', () => {
    const input = validInput()
    const asCanceled = (snapshot: ReleaseEvidencePolicyV1Snapshot): ReleaseEvidencePolicyV1Snapshot => {
      const board = snapshot.board.confirmed
      if (board === undefined) throw new Error('fixture Board is missing')
      return {
        ...snapshot,
        board: {
          confirmed: {
            ...board,
            value: {
              ...board.value,
              items: board.value.items.map(item => ({ ...item, status: 'canceled' as const })),
            },
          },
        },
        deliveries: [],
      }
    }
    const result = evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: asCanceled(input.evaluation),
      finalReread: asCanceled(input.finalReread),
    })
    expect(result).toMatchObject({ ok: true, evidence: { workItems: [{ status: 'canceled' }], deliveries: [] } })
  })

  it('accepts a Done item without inventing a Branch Delivery', () => {
    const input = validInput()
    const withoutDeliveries = (snapshot: ReleaseEvidencePolicyV1Snapshot): ReleaseEvidencePolicyV1Snapshot => ({
      ...snapshot,
      deliveries: [],
    })
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: withoutDeliveries(input.evaluation),
      finalReread: withoutDeliveries(input.finalReread),
    })).toMatchObject({
      ok: true,
      evidence: { workItems: [{ status: 'done' }], deliveries: [] },
    })
  })

  it('matches GitHub branch names against canonical Branch Delivery refs', () => {
    const input = validInput()
    expect(input.evaluation.deliveries[0]).toMatchObject({
      headRef: 'refs/heads/feature/b10',
      baseRef: 'refs/heads/master',
    })
    expect(evaluateReleaseEvidencePolicyV1(input)).toMatchObject({ ok: true })
  })

  it('rejects duplicate Delivery ownership for one Work Item', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: [...input.evaluation.deliveries, ...input.evaluation.deliveries],
      },
    })).toMatchObject({
      ok: false,
      blockages: [{ kind: 'delivery-duplicate', workItemId: WORK_ITEM_ID }],
    })
  })

  it('requires a current human acceptance for a Done item that has a Delivery', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: input.evaluation.deliveries.map(delivery => ({ ...delivery, acceptance: undefined })),
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'delivery-not-accepted', workItemId: WORK_ITEM_ID }],
    })
  })

  it('fails closed when one Delivery source has no confirmed fact', () => {
    const input = validInput()
    const current = input.evaluation.deliveries[0]
    if (current === undefined) throw new Error('fixture Delivery is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: [{ ...current, pullRequest: {} }],
      },
    })).toEqual({
      ok: false,
      blockages: [{
        kind: 'source-unavailable',
        pass: 'evaluation',
        source: `delivery:${current.deliveryId}:pull-request`,
      }],
    })
  })

  it('fails closed when current exact-Commit CI is unsuccessful', () => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: input.evaluation.deliveries.map(delivery => ({
          ...delivery,
          ci: successfulCi(1_900, 'failure'),
        })),
      },
    })).toEqual({
      ok: false,
      blockages: [{ kind: 'delivery-ci-not-successful', workItemId: WORK_ITEM_ID }],
    })
  })

  it('requires the accepted Pull Request and ancestry to match the exact Delivery', () => {
    const input = validInput()
    const current = input.evaluation.deliveries[0]
    if (current === undefined || current.pullRequest.confirmed === undefined
      || current.ancestry.confirmed === undefined) throw new Error('fixture Delivery evidence is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: [{
          ...current,
          pullRequest: {
            confirmed: {
              ...current.pullRequest.confirmed,
              value: { ...current.pullRequest.confirmed.value, state: 'closed', merged: false },
            },
          },
          ancestry: {
            confirmed: {
              ...current.ancestry.confirmed,
              value: { ...current.ancestry.confirmed.value, status: 'diverged' },
            },
          },
        }],
      },
    })).toEqual({
      ok: false,
      blockages: [
        { kind: 'delivery-pr-mismatch', workItemId: WORK_ITEM_ID },
        { kind: 'delivery-ancestry-mismatch', workItemId: WORK_ITEM_ID },
      ],
    })
  })

  it('rejects an annotated-tag chain that is disconnected from its reference', () => {
    const input = validInput()
    const tag = input.evaluation.tag.confirmed
    if (tag === undefined) throw new Error('fixture tag is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        tag: {
          confirmed: {
            ...tag,
            value: {
              ...tag.value,
              reference: {
                ...tag.value.reference,
                target: { kind: 'tag', id: 'T_disconnected' as never },
              },
              peel: {
                ...tag.value.peel,
                tagObjects: [{ id: 'T_chain' as never, target: { kind: 'commit', id: COMMIT_ID } }],
              },
            },
          },
        },
      },
    })).toEqual({ ok: false, blockages: [{ kind: 'tag-mismatch' }] })
  })

  it('requires the tag reference itself to match the fixed release target', () => {
    const input = validInput()
    const tag = input.evaluation.tag.confirmed
    if (tag === undefined) throw new Error('fixture tag is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        tag: {
          confirmed: {
            ...tag,
            value: {
              ...tag.value,
              reference: { ...tag.value.reference, ref: 'refs/tags/not-the-release' },
            },
          },
        },
      },
    })).toEqual({ ok: false, blockages: [{ kind: 'tag-mismatch' }] })
  })

  it('accepts a contiguous annotated-tag chain that peels to the release Commit', () => {
    const input = validInput()
    const withAnnotatedTag = (snapshot: ReleaseEvidencePolicyV1Snapshot): ReleaseEvidencePolicyV1Snapshot => {
      const tag = snapshot.tag.confirmed
      if (tag === undefined) throw new Error('fixture tag is missing')
      const tagId = 'T_release' as never
      return {
        ...snapshot,
        tag: {
          confirmed: {
            ...tag,
            value: {
              reference: { ...tag.value.reference, target: { kind: 'tag', id: tagId } },
              peel: {
                ...tag.value.peel,
                tagObjects: [{ id: tagId, target: { kind: 'commit', id: COMMIT_ID } }],
              },
            },
          },
        },
      }
    }
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: withAnnotatedTag(input.evaluation),
      finalReread: withAnnotatedTag(input.finalReread),
    })).toMatchObject({ ok: true })
  })

  it('requires a published Release and exact release and upstream Commits', () => {
    const input = validInput()
    const release = input.evaluation.release.confirmed
    const releaseCommit = input.evaluation.releaseCommit.confirmed
    const upstreamCommit = input.evaluation.upstreamCommit.confirmed
    if (release === undefined || releaseCommit === undefined || upstreamCommit === undefined) {
      throw new Error('fixture release evidence is missing')
    }
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        release: {
          confirmed: {
            ...release,
            value: {
              kind: 'absent',
              repositoryId: REPOSITORY_ID,
              tagName: TAG_NAME,
              observedAt: release.observedAt,
            },
          },
        },
        releaseCommit: {
          confirmed: {
            ...releaseCommit,
            value: { ...releaseCommit.value, id: '2'.repeat(40) as GitHubCommitId },
          },
        },
        upstreamCommit: {
          confirmed: {
            ...upstreamCommit,
            value: { ...upstreamCommit.value, repositoryId: REPOSITORY_ID },
          },
        },
      },
    })).toEqual({
      ok: false,
      blockages: [
        { kind: 'release-mismatch' },
        { kind: 'release-commit-mismatch' },
        { kind: 'upstream-commit-mismatch' },
      ],
    })
  })

  it('requires the upstream baseline to be an ancestor of the release Commit', () => {
    const input = validInput()
    const ancestry = input.evaluation.upstreamAncestry.confirmed
    if (ancestry === undefined) throw new Error('fixture ancestry is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        upstreamAncestry: {
          confirmed: { ...ancestry, value: { ...ancestry.value, status: 'diverged' } },
        },
      },
    })).toEqual({ ok: false, blockages: [{ kind: 'upstream-ancestry-mismatch' }] })
  })

  it('rejects semantic drift in the final reread', () => {
    const input = validInput()
    const milestone = input.finalReread.milestone.confirmed
    if (milestone === undefined) throw new Error('fixture Milestone is missing')
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      finalReread: {
        ...input.finalReread,
        milestone: {
          confirmed: {
            ...milestone,
            value: { ...milestone.value, title: 'changed externally', updatedAt: 2_950 },
          },
        },
      },
    })).toEqual({ ok: false, blockages: [{ kind: 'final-reread-mismatch' }] })
  })

  it.each(['headRef', 'baseRef'] as const)('rejects a non-branch %s in observed delivery facts', (field) => {
    const input = validInput()
    expect(evaluateReleaseEvidencePolicyV1({
      ...input,
      evaluation: {
        ...input.evaluation,
        deliveries: input.evaluation.deliveries.map(item => ({ ...item, [field]: 'refs/tags/release' })),
      },
    })).toMatchObject({ ok: false, blockages: [{ kind: 'delivery-pr-mismatch', workItemId: WORK_ITEM_ID }] })
  })

  it.each<readonly [string, (evidence: ReleaseEvidencePolicyV1Evidence) => ReleaseEvidencePolicyV1Evidence]>([
    ['an issue from another repository', evidence => ({
      ...evidence,
      milestone: {
        ...evidence.milestone,
        issues: evidence.milestone.issues.map(issue => ({ ...issue, repositoryId: UPSTREAM_REPOSITORY_ID })),
      },
    })],
    ['duplicate Milestone issues', evidence => ({
      ...evidence,
      milestone: { ...evidence.milestone, issues: [...evidence.milestone.issues, ...evidence.milestone.issues] },
    })],
    ['duplicate Work Items', evidence => ({ ...evidence, workItems: [...evidence.workItems, ...evidence.workItems] })],
    ['two Work Items mapped to one issue', evidence => ({
      ...evidence,
      workItems: [
        ...evidence.workItems,
        ...evidence.workItems.map(item => ({ ...item, workItemId: `work-item-${'f'.repeat(64)}` as SakiBoardWorkItemId })),
      ],
    })],
    ['a Work Item outside the Milestone', evidence => ({
      ...evidence,
      workItems: evidence.workItems.map(item => ({ ...item, issueId: 'I_outside' as GitHubIssueId })),
    })],
    ['an unmapped Milestone issue', evidence => ({ ...evidence, workItems: [] })],
    ['a closed unmerged pull request', evidence => ({
      ...evidence,
      deliveries: evidence.deliveries.map(item => ({
        ...item,
        pullRequest: { ...item.pullRequest, state: 'closed', merged: false },
      })),
    })],
  ])('rejects persisted evidence with %s even when both digests match', (_name, corrupt) => {
    const result = evaluateReleaseEvidencePolicyV1(validInput())
    if (!result.ok) throw new Error('valid release evidence was rejected')
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(result.evidence).success).toBe(true)
    const changed = corrupt(result.evidence)
    const parsed = releaseEvidencePolicyV1EvidenceSchema.safeParse(redigestEvidence({
      ...changed,
      scopeFingerprint: canonicalDigest(
        'saki/release-evidence-milestone-scope/v1', stripObservationTimes(changed.milestone.issues),
      ),
    }))
    expect(parsed.success).toBe(false)
    if (parsed.success) throw new Error('inconsistent evidence was accepted')
    const messages = parsed.error.issues.map(issue => issue.message)
    expect(messages).toContain('Release Evidence facts disagree')
    expect(messages).not.toContain('Release Evidence digest does not match its facts')
  })

  it('rejects tampering with an embedded evidence digest or Milestone identity', () => {
    const result = evaluateReleaseEvidencePolicyV1(validInput())
    if (!result.ok) throw new Error('valid release evidence was rejected')
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse({
      ...result.evidence,
      evaluationDigest: '0'.repeat(64),
      milestoneNumber: result.evidence.milestoneNumber + 1,
    }).success).toBe(false)
  })

  it('rejects relationally invalid embedded evidence even with a recomputed digest', () => {
    const result = evaluateReleaseEvidencePolicyV1(validInput())
    if (!result.ok) throw new Error('valid release evidence was rejected')
    const invalidTag = redigestEvidence({
      ...result.evidence,
      tag: {
        ...result.evidence.tag,
        peel: { ...result.evidence.tag.peel, commitId: 'f'.repeat(40) as GitHubCommitId },
      },
    })
    const invalidCi = redigestEvidence({
      ...result.evidence,
      deliveries: result.evidence.deliveries.map(delivery => ({
        ...delivery,
        ci: {
          ...delivery.ci,
          commitStatuses: delivery.ci.commitStatuses.map(status => ({ ...status, state: 'failure' as const })),
        },
      })),
    })
    const invalidHeadRef = redigestEvidence({
      ...result.evidence,
      deliveries: result.evidence.deliveries.map(delivery => ({
        ...delivery,
        pullRequest: {
          ...delivery.pullRequest,
          head: { ...delivery.pullRequest.head, ref: 'different-head' },
        },
      })),
    })
    const invalidBaseRef = redigestEvidence({
      ...result.evidence,
      deliveries: result.evidence.deliveries.map(delivery => ({
        ...delivery,
        pullRequest: {
          ...delivery.pullRequest,
          base: { ...delivery.pullRequest.base, ref: 'different-base' },
        },
      })),
    })
    const invalidUpstreamRepository = redigestEvidence({
      ...result.evidence,
      upstreamCommit: { ...result.evidence.upstreamCommit, repositoryId: REPOSITORY_ID },
    })

    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(invalidTag).success).toBe(false)
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(invalidCi).success).toBe(false)
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(invalidHeadRef).success).toBe(false)
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(invalidBaseRef).success).toBe(false)
    expect(releaseEvidencePolicyV1EvidenceSchema.safeParse(invalidUpstreamRepository).success).toBe(false)
  })
})

function validInput(): ReleaseEvidencePolicyV1Input {
  return {
    preparedAt: 1_000,
    evaluatedAt: 2_000,
    maxObservationAgeMs: 1_000,
    expected: {
      repositoryId: REPOSITORY_ID,
      projectId: PROJECT_ID,
      milestoneId: MILESTONE_ID,
      milestoneNumber: 1,
      tagName: TAG_NAME,
      releaseCommitId: COMMIT_ID,
      upstreamRepositoryId: UPSTREAM_REPOSITORY_ID,
      upstreamRepositoryDatabaseId: UPSTREAM_REPOSITORY_DATABASE_ID,
      upstreamRepositoryNameWithOwner: 'deepseek-ai/deepseek-harness',
      upstreamCommitId: COMMIT_ID,
    },
    evaluation: snapshot(1_900, 2_000),
    finalReread: snapshot(2_900, 3_000),
  }
}

function snapshot(observedAt: number, capturedAt: number): ReleaseEvidencePolicyV1Snapshot {
  return {
    capturedAt,
    board: {
      confirmed: {
        observedAt,
        value: {
          repositoryId: REPOSITORY_ID,
          projectId: PROJECT_ID,
          generation: 8,
          sourceFingerprint: { version: 1, digest: 'a'.repeat(64) },
          items: [{
            workItemId: WORK_ITEM_ID,
            issueId: ISSUE_ID,
            status: 'done',
            remoteFingerprint: `remote-fingerprint-${'b'.repeat(64)}` as SakiBoardRemoteFingerprint,
          }],
        },
      },
    },
    milestone: {
      confirmed: {
        observedAt,
        value: {
          id: MILESTONE_ID,
          repositoryId: REPOSITORY_ID,
          number: 1,
          state: 'open',
          title: '0.1.0',
          url: 'https://github.com/o/r/milestone/1',
          updatedAt: 900,
          issues: [{
            id: ISSUE_ID,
            repositoryId: REPOSITORY_ID,
            repositoryDatabaseId: REPOSITORY_DATABASE_ID,
            number: 32,
            state: 'closed',
            title: 'Deliver B10',
            url: 'https://github.com/o/r/issues/32',
            updatedAt: 800,
          }],
          observedAt,
        },
      },
    },
    deliveries: [delivery(observedAt)],
    tag: {
      confirmed: {
        observedAt,
        value: {
          reference: {
            repositoryId: REPOSITORY_ID,
            tagName: TAG_NAME,
            ref: `refs/tags/${TAG_NAME}`,
            target: { kind: 'commit', id: COMMIT_ID },
            observedAt,
          },
          peel: {
            repositoryId: REPOSITORY_ID,
            tagObjects: [],
            commitId: COMMIT_ID,
            observedAt,
          },
        },
      },
    },
    release: {
      confirmed: {
        observedAt,
        value: {
          kind: 'present',
          release: {
            id: 'REL_release' as GitHubReleaseId,
            repositoryId: REPOSITORY_ID,
            tagName: TAG_NAME,
            targetCommitish: 'ignored-branch-name',
            draft: false,
            prerelease: false,
            url: 'https://github.com/o/r/releases/tag/saki-v0.1.0',
            publishedAt: 1_700,
            observedAt,
          },
        },
      },
    },
    releaseCommit: {
      confirmed: {
        observedAt,
        value: {
          id: COMMIT_ID,
          repositoryId: REPOSITORY_ID,
          url: `https://github.com/o/r/commit/${COMMIT_ID}`,
          committedAt: 1_500,
          observedAt,
        },
      },
    },
    upstreamCommit: {
      confirmed: {
        observedAt,
        value: {
          id: COMMIT_ID,
          repositoryId: UPSTREAM_REPOSITORY_ID,
          url: `https://github.com/upstream/r/commit/${COMMIT_ID}`,
          committedAt: 1_500,
          observedAt,
        },
      },
    },
    upstreamAncestry: comparison(observedAt),
  }
}

function delivery(observedAt: number): ReleaseEvidencePolicyV1Snapshot['deliveries'][number] {
  return {
    deliveryId: `branch-delivery-${'e'.repeat(64)}`,
    revision: 3,
    workItemId: WORK_ITEM_ID,
    repositoryId: REPOSITORY_ID,
    commitId: COMMIT_ID,
    headRef: 'refs/heads/feature/b10',
    baseRef: 'refs/heads/master',
    pullRequest: {
      confirmed: {
        observedAt,
        value: {
          id: 'PR_release' as GitHubPullRequestId,
          repositoryId: REPOSITORY_ID,
          number: 72,
          state: 'open',
          merged: false,
          draft: true,
          title: 'B10',
          url: 'https://github.com/o/r/pull/72',
          head: { repositoryId: REPOSITORY_ID, ref: 'feature/b10', commitId: COMMIT_ID },
          base: { repositoryId: REPOSITORY_ID, ref: 'master', commitId: COMMIT_ID },
          updatedAt: 1_800,
          observedAt,
        },
      },
    },
    ci: successfulCi(observedAt, 'success'),
    ancestry: comparison(observedAt),
    acceptance: {
      deliveryRevision: 3,
      acceptedAt: 1_850,
      intentId: 'intent-00000000-0000-4000-8000-000000000032' as SakiControlIntentId,
      actorDigest: 'c'.repeat(64),
    },
  }
}

function successfulCi(
  observedAt: number,
  state: 'success' | 'failure',
): ReleaseEvidencePolicyV1Snapshot['deliveries'][number]['ci'] {
  return {
    confirmed: {
      observedAt,
      value: {
        repositoryId: REPOSITORY_ID,
        commitId: COMMIT_ID,
        workflowRuns: [],
        checkRuns: [],
        commitStatuses: [{
          id: '1' as GitHubCommitStatusId,
          context: 'CI',
          state,
          createdAt: 1_600,
          updatedAt: 1_700,
        }],
        observedAt,
      },
    },
  }
}

function comparison(observedAt: number): ReleaseEvidencePolicyV1Snapshot['upstreamAncestry'] {
  return {
    confirmed: {
      observedAt,
      value: {
        repositoryId: REPOSITORY_ID,
        baseCommitId: COMMIT_ID,
        headCommitId: COMMIT_ID,
        status: 'identical',
        aheadBy: 0,
        behindBy: 0,
        mergeBaseCommitId: COMMIT_ID,
        observedAt,
      },
    },
  }
}

function redigestEvidence(evidence: ReleaseEvidencePolicyV1Evidence): ReleaseEvidencePolicyV1Evidence {
  const { policy: _policy, evaluationDigest: _evaluationDigest, confirmedAt: _confirmedAt, ...evaluated } = evidence
  return {
    ...evidence,
    evaluationDigest: canonicalDigest('saki/release-evidence-policy/v1', stripObservationTimes(evaluated)),
  }
}

function stripObservationTimes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => stripObservationTimes(item))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'observedAt')
    .map(([key, item]) => [key, stripObservationTimes(item)]))
}
