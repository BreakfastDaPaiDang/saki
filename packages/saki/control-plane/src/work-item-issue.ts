/** Deterministic GitHub Issue body material for Saki Work Item creation. */

import { GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT } from '@breakfastdapaidang/saki-github'

const VALIDATION_MARKER_ID = `work-item-marker-${'0'.repeat(64)}`

interface GitHubWorkItemIssueBodyContent {
  readonly intendedOutcome: string
  readonly acceptanceCriteria: readonly string[]
}

interface GitHubWorkItemIssueBodyInput extends GitHubWorkItemIssueBodyContent {
  readonly markerId: string
}

/**
 * Render the exact Markdown body sent to GitHub for one created Work Item.
 * @param input - structured product content and the already-persisted recovery marker.
 * @returns normalized Markdown ending with the one hidden marker comment.
 */
export function renderGitHubWorkItemIssueBody(input: GitHubWorkItemIssueBodyInput): string {
  const criteria = input.acceptanceCriteria
    .map(criterion => `- [ ] ${normalizeMarkdown(criterion).replaceAll('\n', '\n    ')}`)
    .join('\n')
  return [
    '## Intended outcome',
    '',
    normalizeMarkdown(input.intendedOutcome),
    '',
    '## Acceptance criteria',
    '',
    criteria,
    '',
    `<!-- saki-work-item:${input.markerId} -->`,
    '',
  ].join('\n')
}

/**
 * Check the complete rendered body before a create Intent is admitted.
 * @param input - structured browser input; the marker has a fixed rendered length.
 * @returns whether the generated body fits the product-owned UTF-8 budget.
 */
export function githubWorkItemIssueBodyWithinLimit(input: GitHubWorkItemIssueBodyContent): boolean {
  return new TextEncoder().encode(renderGitHubWorkItemIssueBody({
    ...input,
    markerId: VALIDATION_MARKER_ID,
  })).byteLength <= GITHUB_ISSUE_CREATE_BODY_UTF8_LIMIT
}

function normalizeMarkdown(value: string): string {
  return value.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
}
