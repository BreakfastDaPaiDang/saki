import { expect, it } from 'vitest'
import {
  GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT,
  GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT,
  githubIssueCreateInspectionHintSchema,
  githubIssueCreateInspectionSchema,
  githubIssueCreateMarkerId,
  githubIssueCreateRequestSchema,
} from '../src/index.ts'
import {
  ISSUE,
  ISSUE_CREATE_INSPECTION,
  ISSUE_CREATE_MARKER_ID,
  ISSUE_CREATE_RESULT,
  ISSUE_CREATE_REQUEST,
} from './fixtures.ts'

it('admits one strict Issue-create request, result, and marker inspection', () => {
  expect(githubIssueCreateRequestSchema.parse(ISSUE_CREATE_REQUEST)).toEqual(ISSUE_CREATE_REQUEST)
  expect(githubIssueCreateInspectionHintSchema.parse(ISSUE_CREATE_RESULT)).toEqual(ISSUE_CREATE_RESULT)
  expect(githubIssueCreateInspectionSchema.parse(ISSUE_CREATE_INSPECTION)).toEqual(ISSUE_CREATE_INSPECTION)
})

it('keeps a known-Issue inspection hint separate from the persisted operation id', () => {
  const hinted = githubIssueCreateRequestSchema.parse({
    ...ISSUE_CREATE_REQUEST,
    inspectionHint: { issueId: ISSUE.id, issueNumber: ISSUE.number },
  })

  expect(hinted.operationId).toEqual(ISSUE_CREATE_REQUEST.operationId)
  expect(hinted.inspectionHint).toEqual({ issueId: ISSUE.id, issueNumber: ISSUE.number })
})

it('rejects Issue-create text outside the complete UTF-8 and marker structure limits', () => {
  const marker = `<!-- saki-work-item:${ISSUE_CREATE_MARKER_ID} -->`
  const invalidBodies = [
    'missing marker\n',
    `${ISSUE_CREATE_REQUEST.body}${marker}\n`,
    ISSUE_CREATE_REQUEST.body.replace('\n', '\r\n'),
    `${'界'.repeat(Math.floor(GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT / 3) + 1)}\n${marker}\n`,
    `${String.fromCharCode(0xd800)}\n${marker}\n`,
  ]
  for (const body of invalidBodies) {
    expect(githubIssueCreateRequestSchema.safeParse({ ...ISSUE_CREATE_REQUEST, body }).success).toBe(false)
  }
  expect(githubIssueCreateRequestSchema.safeParse({
    ...ISSUE_CREATE_REQUEST,
    title: '界'.repeat(Math.floor(GITHUB_ISSUE_CREATE_TITLE_UTF8_LIMIT / 3) + 1),
  }).success).toBe(false)
  expect(githubIssueCreateRequestSchema.safeParse({
    ...ISSUE_CREATE_REQUEST,
    title: String.fromCharCode(0xd800),
  }).success).toBe(false)
  for (const title of ['   ', 'two\nlines', 'nul\0title']) {
    expect(githubIssueCreateRequestSchema.safeParse({ ...ISSUE_CREATE_REQUEST, title }).success).toBe(false)
  }
  for (const body of [
    ISSUE_CREATE_REQUEST.body.replace('Create', 'Create\0'),
    ISSUE_CREATE_REQUEST.body.replace('Create', `Create${String.fromCharCode(0x7f)}`),
  ]) {
    expect(githubIssueCreateRequestSchema.safeParse({ ...ISSUE_CREATE_REQUEST, body }).success).toBe(false)
  }
  expect(() => githubIssueCreateMarkerId('predictable-marker')).toThrow()
})

it('rejects provider payloads and removed targeted-fingerprint fields', () => {
  expect(githubIssueCreateRequestSchema.safeParse({
    ...ISSUE_CREATE_REQUEST,
    priority: 'interactive',
  }).success).toBe(false)
  expect(githubIssueCreateInspectionHintSchema.safeParse({
    ...ISSUE_CREATE_RESULT,
    rawResponse: { token: 'secret' },
  }).success).toBe(false)
  for (const removed of [
    { semanticFence: { version: 1 } },
    { fingerprint: { version: 1, digest: 'f'.repeat(64) } },
    { rawResponse: { token: 'secret' } },
  ]) {
    expect(githubIssueCreateInspectionSchema.safeParse({
      ...ISSUE_CREATE_INSPECTION,
      ...removed,
    }).success).toBe(false)
  }
  for (const echo of [
    { markerId: ISSUE_CREATE_REQUEST.markerId },
    { inspectionHint: ISSUE_CREATE_RESULT },
  ]) {
    expect(githubIssueCreateInspectionSchema.safeParse({
      ...ISSUE_CREATE_INSPECTION,
      snapshot: { ...ISSUE_CREATE_INSPECTION.snapshot, ...echo },
    }).success).toBe(false)
  }
})

it('admits state-only non-success outcomes and rejects diagnostic payloads', () => {
  for (const state of [
    'absent-complete',
    'pull-request-marker-match',
    'marker-removed',
    'known-issue-absent',
    'identity-conflict',
    'multiple-matches',
    'incomplete',
  ]) {
    const inspection = {
      ...ISSUE_CREATE_INSPECTION,
      snapshot: {
        ...ISSUE_CREATE_INSPECTION.snapshot,
        outcome: { state },
      },
    }
    expect(githubIssueCreateInspectionSchema.parse(inspection)).toEqual(inspection)
    expect(githubIssueCreateInspectionSchema.safeParse({
      ...inspection,
      snapshot: {
        ...inspection.snapshot,
        outcome: { state, diagnostic: 'provider-private' },
      },
    }).success).toBe(false)
  }

  expect(githubIssueCreateInspectionSchema.safeParse({
    ...ISSUE_CREATE_INSPECTION,
    snapshot: {
      ...ISSUE_CREATE_INSPECTION.snapshot,
      outcome: { state: 'unique-issue', issue: { ...ISSUE, repositoryId: 'R_other' } },
    },
  }).success).toBe(false)
})
