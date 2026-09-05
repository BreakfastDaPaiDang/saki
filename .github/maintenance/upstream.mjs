#!/usr/bin/env node

/** GitHub-backed upstream work ownership; the CLI uses the same operations as Actions. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SYNC_BRANCH = 'automation/upstream-sync'
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const COMPATIBILITY_MARKER = '<!-- saki-upstream-compatibility -->'
const EVIDENCE_MARKER = '<!-- saki-upstream-evidence -->'

function oneOrNone(values, subject) {
  if (!Array.isArray(values)) throw new Error(`${subject}: expected an API collection`)
  if (values.length > 1) throw new Error(`${subject}: multiple records require manual reconciliation`)
  return values[0] ?? null
}

function currentPull(io, repository) {
  const owner = repository.split('/')[0]
  const query = new URLSearchParams({ state: 'open', base: 'master', head: `${owner}:${SYNC_BRANCH}`, per_page: '100' })
  return oneOrNone(io.list(`repos/${repository}/pulls?${query}`), 'upstream pull request')
}

function isSyncPull(pull, repository) {
  return Number.isSafeInteger(pull?.number) && pull.number > 0
    && /^[a-f0-9]{40}$/.test(pull?.head?.sha ?? '')
    && pull.html_url === `https://github.com/${repository}/pull/${pull.number}`
    && pull?.base?.ref === 'master'
    && pull?.head?.ref === SYNC_BRANCH
    && pull?.head?.repo?.full_name === repository
    && pull?.base?.repo?.full_name === repository
}

function compatibilityIssue(io, repository, pull) {
  const marker = `<!-- saki-upstream-pr:${pull.number} -->`
  const issues = io.list(`repos/${repository}/issues?state=open&per_page=100`)
  return oneOrNone(issues.filter(issue => {
    if (issue.pull_request || typeof issue.body !== 'string') return false
    if (issue.body.includes(marker)) return true
    // Legacy work retains its Issue id when the ready label is removed on claim.
    return issue.body.includes(COMPATIBILITY_MARKER)
      && issue.body.split(/\r?\n/).some(line => line.trim() === `- sync PR: ${pull.html_url}`)
  }), 'upstream compatibility issue')
}

function recordEvidence(io, repository, issue, body) {
  const comments = io.list(`repos/${repository}/issues/${issue.number}/comments?per_page=100`)
  const comment = oneOrNone(comments.filter(item => item.body?.startsWith(EVIDENCE_MARKER)), 'upstream evidence comment')
  const payload = { body: `${EVIDENCE_MARKER}\n\n${body}` }
  if (comment?.body === payload.body) return
  if (comment) io.api('PATCH', `repos/${repository}/issues/comments/${comment.id}`, payload)
  else io.api('POST', `repos/${repository}/issues/${issue.number}/comments`, payload)
}

function ensureCompatibility(io, repository, pull, diagnosis) {
  const issue = compatibilityIssue(io, repository, pull)
  const evidence = `- sync PR: ${pull.html_url}\n- head: \`${pull.head.sha}\`\n\n${diagnosis}`
  if (issue) {
    recordEvidence(io, repository, issue, evidence)
    return issue.number
  }
  const created = io.api('POST', `repos/${repository}/issues`, {
    title: `兼容上游 DeepSeek Harness ${pull.head.sha.slice(0, 12)}`,
    body: `${COMPATIBILITY_MARKER}\n<!-- saki-upstream-pr:${pull.number} -->\n\n保留 Saki 行为并完成当前固定目标的上游兼容。\n\n<details>\n<summary>证据与验收</summary>\n\n${evidence}\n\n## 验收条件\n\n- 保留 Saki 产品行为和已有持久状态。\n- 解决同步 PR 的冲突与失败检查。\n- 通过必需 CI 并以 merge commit 合入；成功 CI 本身不代表完成。\n\n操作流程见 docs/saki/upstream-sync.md。\n\n</details>`,
    labels: ['ready-for-agent', 'area/infra'],
    type: 'Bug',
  })
  return created.number
}

function held(pull) {
  return { state: 'held', pull: pull.number, head: pull.head.sha, url: pull.html_url }
}

function prepare(io, repository) {
  const existing = currentPull(io, repository)
  if (existing) {
    if (!isSyncPull(existing, repository)) throw new Error('upstream pull request has an unexpected repository or base')
    return held(existing)
  }
  const remote = io.git(['ls-remote', '--heads', 'origin', `refs/heads/${SYNC_BRANCH}`]).stdout.trim()
  const remoteOid = remote === '' ? '' : remote.split(/\s+/)[0]
  if (remoteOid !== '' && !/^[a-f0-9]{40}$/.test(remoteOid)) throw new Error('upstream branch has an invalid remote OID')
  const base = io.git(['rev-parse', 'HEAD']).stdout.trim()
  io.git(['fetch', '--no-tags', UPSTREAM_URL, 'master'])
  const upstream = io.git(['rev-parse', 'FETCH_HEAD']).stdout.trim()
  if (!/^[a-f0-9]{40}$/.test(base) || !/^[a-f0-9]{40}$/.test(upstream)) throw new Error('upstream comparison requires exact commit OIDs')
  if (io.git(['merge-base', '--is-ancestor', upstream, base], [0, 1]).code === 0) {
    return { state: 'current', base, upstream }
  }
  const merge = io.git(['-c', 'merge.renameLimit=10000', 'merge-tree', '--write-tree', '--name-only', base, upstream], [0, 1])
  const conflict = merge.code === 1
  const conflictFiles = merge.stdout.split(/\r?\n/).slice(1).join('\n').split('\n\n')[0].trim()
  if (conflict && conflictFiles === '') throw new Error('upstream merge failed without conflicted paths')
  const concurrent = currentPull(io, repository)
  if (concurrent) {
    if (!isSyncPull(concurrent, repository)) throw new Error('upstream pull request has an unexpected repository or base')
    return held(concurrent)
  }
  io.git(['push', `--force-with-lease=refs/heads/${SYNC_BRANCH}:${remoteOid}`, 'origin', `${upstream}:refs/heads/${SYNC_BRANCH}`])
  const pull = io.api('POST', `repos/${repository}/pulls`, {
    title: `sync upstream DeepSeek Harness ${upstream.slice(0, 12)}`,
    head: SYNC_BRANCH,
    base: 'master',
    draft: conflict,
    body: `<!-- saki-upstream-target:${upstream} -->\n\n## Upstream\n\n- repository: \`deepseek-ai/deepseek-harness\`\n- base: \`${base}\`\n- upstream: \`${upstream}\`\n\nThis target stays fixed while the pull request is open. Compatibility fixes may advance this branch; scheduled synchronization preserves them. Required Saki CI validates the combined tree before a merge commit incorporates the official history.\n\nMaintenance procedure: docs/saki/upstream-sync.md.`,
  })
  io.api('POST', `repos/${repository}/issues/${pull.number}/labels`, { labels: ['kind/dependency', 'area/infra'] })
  if (conflict) {
    const issue = ensureCompatibility(io, repository, pull, `上游合并存在文本冲突。\n\n\`\`\`text\n${conflictFiles}\n\`\`\``)
    return { state: 'compatibility-required', pull: pull.number, issue, base, upstream }
  }
  io.api('POST', 'graphql', {
    query: 'mutation($id: ID!, $oid: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: MERGE, expectedHeadOid: $oid}) { pullRequest { id } } }',
    variables: { id: pull.node_id, oid: upstream },
  })
  return { state: 'awaiting-ci', pull: pull.number, base, upstream }
}

function routeCi(io, repository, event) {
  const run = event.workflow_run
  if (!run) throw new Error('CI routing requires a workflow_run event')
  if (run.name !== 'CI' || run.event !== 'pull_request' || run.head_branch !== SYNC_BRANCH
    || run.head_repository?.full_name !== repository || run.status !== 'completed') return { state: 'ignored' }
  const pull = currentPull(io, repository)
  if (!isSyncPull(pull, repository) || pull.draft !== false || pull.head.sha !== run.head_sha) return { state: 'ignored' }
  if (run.conclusion === 'success') return { state: 'awaiting-merge', pull: pull.number, head: pull.head.sha }
  if (!['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale', 'neutral', 'skipped'].includes(run.conclusion)) {
    throw new Error('CI routing received an unknown completed conclusion')
  }
  const issue = ensureCompatibility(io, repository, pull, `必需 CI 未通过。\n\n- CI: ${run.html_url}\n- conclusion: \`${run.conclusion}\``)
  return { state: 'compatibility-required', pull: pull.number, issue, head: pull.head.sha }
}

function routeClosed(io, repository, event) {
  const reported = event.pull_request
  if (event.action !== 'closed' || !isSyncPull(reported, repository)) return { state: 'ignored' }
  const pull = io.api('GET', `repos/${repository}/pulls/${reported.number}`)
  if (!isSyncPull(pull, repository) || pull.state !== 'closed' || pull.head.sha !== reported.head.sha) return { state: 'ignored' }
  if (typeof pull.merged !== 'boolean') throw new Error('closed upstream PR is missing its merge result')
  const issue = compatibilityIssue(io, repository, pull)
  if (issue) {
    const reason = pull.merged === true ? 'completed' : 'not_planned'
    recordEvidence(io, repository, issue, `- sync PR: ${pull.html_url}\n- head: \`${pull.head.sha}\`\n\n${pull.merged === true ? '同步 PR 已合并。' : '同步 PR 已关闭且未合并；该目标已放弃。'}`)
    io.api('PATCH', `repos/${repository}/issues/${issue.number}`, { state: 'closed', state_reason: reason })
  }
  return { state: pull.merged === true ? 'merged' : 'abandoned', pull: pull.number, issue: issue?.number ?? null }
}

/**
 * Maintain one upstream PR and its Issue through injected Git and GitHub operations.
 * @param {{mode: string, repository: string, event?: object}} input Selected operation and trusted workflow context.
 * @param {{git: Function, api: Function, list: Function}} io Git commands and JSON GitHub API operations.
 * @returns {object} Operation result; an open PR is never rewritten by prepare, and status is read-only.
 */
export function runUpstreamMaintenance({ mode, repository, event = {} }, io) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)
    || ['.', '..'].includes(repository.split('/')[1])) throw new Error('maintenance requires an owner/repository name')
  switch (mode) {
    case 'prepare': return prepare(io, repository)
    case 'route-ci': return routeCi(io, repository, event)
    case 'route-closed': return routeClosed(io, repository, event)
    case 'status': {
      const pull = currentPull(io, repository)
      if (!pull) return { state: 'idle', repository }
      if (!isSyncPull(pull, repository)) throw new Error('upstream pull request has an unexpected repository or base')
      const issue = compatibilityIssue(io, repository, pull)
      return { ...held(pull), draft: pull.draft, issue: issue?.number ?? null, assignees: issue?.assignees?.map(item => item.login) ?? [] }
    }
    default: throw new Error('maintenance mode must be prepare, route-ci, route-closed, or status')
  }
}

function command(executable, args, { input, allowedCodes = [0] } = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', input, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  })
  if (result.error) throw result.error
  if (!allowedCodes.includes(result.status)) throw new Error(`${executable} failed (${result.status}): ${result.stderr.trim()}`)
  return { code: result.status, stdout: result.stdout }
}

function githubApi(method, path, body) {
  const args = ['api', '--method', method, path]
  if (body !== undefined) args.push('--input', '-')
  const result = command('gh', args, { input: body === undefined ? undefined : JSON.stringify(body) })
  const data = result.stdout.trim() === '' ? undefined : JSON.parse(result.stdout)
  if (path === 'graphql' && data?.errors?.length) throw new Error('GitHub GraphQL rejected upstream auto-merge')
  return data
}

function githubList(path) {
  const result = command('gh', ['api', '--paginate', '--slurp', path])
  const pages = JSON.parse(result.stdout)
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) throw new Error('GitHub pagination returned a non-collection')
  return pages.flat()
}

function main() {
  const mode = process.argv[2]
  // gh defaults to a fork's parent unless the repository is named explicitly.
  const repository = process.env.GITHUB_REPOSITORY
    ?? JSON.parse(command('gh', [
      'repo', 'view', command('git', ['remote', 'get-url', 'origin']).stdout.trim(), '--json', 'nameWithOwner',
    ]).stdout).nameWithOwner
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {}
  const result = runUpstreamMaintenance({ mode, repository, event }, {
    git: (args, allowedCodes) => command('git', args, { allowedCodes }), api: githubApi, list: githubList,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
