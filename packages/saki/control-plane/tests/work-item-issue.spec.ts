import { describe, expect, it } from 'vitest'
import { GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT } from '@breakfastdapaidang/saki-github'
import { createWorkItemIntentSchema } from '../src/spec.ts'
import { renderGitHubWorkItemIssueBody } from '../src/work-item-issue.ts'

const MARKER_ID = `work-item-marker-${'a'.repeat(64)}`

function createIntentAtBodyBytes(targetBytes: number, multibyte = false) {
  const acceptanceCriteria = Array.from({ length: 15 }, () => 'x')
  const content = { intendedOutcome: 'x', acceptanceCriteria, markerId: MARKER_ID }
  let remaining = targetBytes - Buffer.byteLength(renderGitHubWorkItemIssueBody(content), 'utf8')
  for (let index = 0; index < acceptanceCriteria.length && remaining > 0; index += 1) {
    const appended = 'x'.repeat(Math.min(4_095, remaining))
    acceptanceCriteria[index] = `${acceptanceCriteria[index] ?? ''}${appended}`
    remaining -= appended.length
  }
  if (remaining !== 0) throw new Error('test body target exceeds the structured input capacity')
  if (multibyte) {
    const index = acceptanceCriteria.findIndex(criterion => criterion.length >= 3)
    if (index < 0) throw new Error('test body lacks replaceable ASCII content')
    acceptanceCriteria[index] = `${acceptanceCriteria[index]!.slice(0, -3)}界`
  }
  return {
    type: 'create-work-item' as const,
    intentId: 'intent-00000000-0000-4000-8000-000000000001',
    projectId: 'project-00000000-0000-4000-8000-000000000001',
    expected: { projectRevision: 1, synchronizationRevision: 1, mappingRevision: 1 },
    title: 'Bound the complete body',
    intendedOutcome: content.intendedOutcome,
    acceptanceCriteria,
  }
}

describe('GitHub Work Item Issue body', () => {
  it('renders deterministic Markdown with one final hidden recovery marker', () => {
    expect(renderGitHubWorkItemIssueBody({
      intendedOutcome: 'Ship the recoverable path.\r\nKeep it observable.',
      acceptanceCriteria: ['First line\rsecond line', 'One exact Issue exists.'],
      markerId: MARKER_ID,
    })).toBe([
      '## Intended outcome',
      '',
      'Ship the recoverable path.',
      'Keep it observable.',
      '',
      '## Acceptance criteria',
      '',
      '- [ ] First line',
      '    second line',
      '- [ ] One exact Issue exists.',
      '',
      `<!-- saki-work-item:${MARKER_ID} -->`,
      '',
    ].join('\n'))
  })

  it('rejects the complete rendered UTF-8 body above the product-owned bound', () => {
    const base = {
      type: 'create-work-item' as const,
      intentId: 'intent-00000000-0000-4000-8000-000000000001',
      projectId: 'project-00000000-0000-4000-8000-000000000001',
      expected: { projectRevision: 1, synchronizationRevision: 1, mappingRevision: 1 },
      title: 'Bound the complete body',
      intendedOutcome: '界'.repeat(4_096),
      acceptanceCriteria: Array.from({ length: 50 }, () => '界'.repeat(4_096)),
    }

    expect(Buffer.byteLength(renderGitHubWorkItemIssueBody({
      intendedOutcome: base.intendedOutcome,
      acceptanceCriteria: base.acceptanceCriteria,
      markerId: MARKER_ID,
    }), 'utf8')).toBeGreaterThan(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT)
    expect(createWorkItemIntentSchema.safeParse(base)).toMatchObject({ success: false })
  })

  it('accepts the exact byte limit and rejects one byte more, including multibyte content', () => {
    const exact = createIntentAtBodyBytes(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT)
    const exactMultibyte = createIntentAtBodyBytes(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT, true)
    const oversized = createIntentAtBodyBytes(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT + 1)

    expect(createWorkItemIntentSchema.safeParse(exact).success).toBe(true)
    expect(createWorkItemIntentSchema.safeParse(exactMultibyte).success).toBe(true)
    expect(createWorkItemIntentSchema.safeParse(oversized).success).toBe(false)
  })
})
