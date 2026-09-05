import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { runUpstreamMaintenance } from './upstream.mjs'

const repository = 'BreakfastDaPaiDang/saki'
const base = 'a'.repeat(40)
const upstream = 'b'.repeat(40)
const repaired = 'c'.repeat(40)
const original = 'd'.repeat(40)

function pull(overrides = {}) {
  return {
    number: 70, node_id: 'PR_sync', state: 'open', draft: false, merged: false,
    html_url: `https://github.com/${repository}/pull/70`,
    base: { ref: 'master', repo: { full_name: repository } },
    head: { ref: 'automation/upstream-sync', sha: upstream, repo: { full_name: repository } },
    ...overrides,
  }
}

function issue(overrides = {}) {
  return {
    number: 71, state: 'open', labels: [{ name: 'area/infra' }], assignees: [{ login: 'maintainer' }],
    body: `<!-- saki-upstream-compatibility -->\n\n- sync PR: https://github.com/${repository}/pull/70\n\nAgent checkpoint: preserve these notes.`,
    ...overrides,
  }
}

function runEvent(overrides = {}) {
  return { workflow_run: {
    name: 'CI', event: 'pull_request', head_branch: 'automation/upstream-sync', head_sha: upstream,
    head_repository: { full_name: repository }, status: 'completed', conclusion: 'failure',
    html_url: `https://github.com/${repository}/actions/runs/42`, ...overrides,
  } }
}

function fixture(options = {}) {
  const state = {
    pulls: options.pulls ?? [], issues: options.issues ?? [], comments: options.comments ?? [],
    writes: [], gitCalls: [], lists: [], remote: original, listCount: 0,
  }
  const io = {
    list(path) {
      state.lists.push(path)
      if (path.includes('/pulls?')) {
        state.listCount += 1
        if (options.concurrentPull && state.listCount === 2) state.pulls = [options.concurrentPull]
        return structuredClone(state.pulls.filter(item => item.state === 'open'))
      }
      if (path.includes('/comments?')) return structuredClone(state.comments)
      if (path.includes('/issues?')) return structuredClone(state.issues.filter(item => item.state === 'open'))
      throw new Error(`unexpected list: ${path}`)
    },
    api(method, path, body) {
      if (method === 'GET' && path.endsWith('/pulls/70')) return structuredClone(state.pulls[0])
      state.writes.push({ method, path, body })
      if (path.endsWith('/pulls')) {
        const created = pull({ draft: body.draft, body: body.body })
        state.pulls.push(created)
        return structuredClone(created)
      }
      if (path.endsWith('/issues')) {
        const created = issue({ number: 72, ...body })
        state.issues.push(created)
        return structuredClone(created)
      }
      if (path.endsWith('/comments')) {
        const created = { id: 1, ...body }
        state.comments.push(created)
        return structuredClone(created)
      }
      if (path.endsWith('/issues/comments/1')) {
        Object.assign(state.comments[0], body)
        return structuredClone(state.comments[0])
      }
      if (path.endsWith('/issues/71')) {
        Object.assign(state.issues.find(item => item.number === 71), body)
        return structuredClone(state.issues.find(item => item.number === 71))
      }
      if (path.endsWith('/labels') || path === 'graphql') return {}
      throw new Error(`unexpected API call: ${method} ${path}`)
    },
    git(args, allowedCodes = [0]) {
      state.gitCalls.push(args)
      if (args[0] === 'ls-remote') return { code: 0, stdout: `${state.remote}\trefs/heads/automation/upstream-sync\n` }
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${args[1] === 'HEAD' ? base : upstream}\n` }
      if (args[0] === 'fetch') return { code: 0, stdout: '' }
      if (args[0] === 'merge-base') return { code: options.current ? 0 : 1, stdout: '' }
      if (args.includes('merge-tree')) {
        if (options.mergeError) throw new Error('merge-tree failed before producing a candidate')
        assert.deepEqual(allowedCodes, [0, 1])
        return options.conflict
          ? { code: 1, stdout: `${'e'.repeat(40)}\npackages/storage/index.ts\n\nCONFLICT details\n` }
          : { code: 0, stdout: `${'e'.repeat(40)}\n` }
      }
      if (args[0] === 'push') {
        if (options.remoteMoved) throw new Error('stale lease')
        assert.equal(args[1], `--force-with-lease=refs/heads/automation/upstream-sync:${original}`)
        state.remote = upstream
        return { code: 0, stdout: '' }
      }
      throw new Error(`unexpected Git command: ${args.join(' ')}`)
    },
  }
  return { state, io, run: (mode, event) => runUpstreamMaintenance({ mode, repository, event }, io) }
}

test('an open compatibility PR preserves its repaired head without fetching or writing', () => {
  const current = pull({ draft: true, head: { ...pull().head, sha: repaired } })
  const f = fixture({ pulls: [current], issues: [issue()] })
  assert.deepEqual(f.run('prepare'), { state: 'held', pull: 70, head: repaired, url: current.html_url })
  assert.equal(f.state.pulls[0].head.sha, repaired)
  assert.deepEqual(f.state.gitCalls, [])
  assert.deepEqual(f.state.writes, [])
})

test('an open clean PR keeps its CI candidate and review state', () => {
  const f = fixture({ pulls: [pull()] })
  assert.equal(f.run('prepare').state, 'held')
  assert.deepEqual(f.state.gitCalls, [])
  assert.deepEqual(f.state.writes, [])
})

test('an incorporated upstream has no branch or PR side effects', () => {
  const f = fixture({ current: true })
  assert.deepEqual(f.run('prepare'), { state: 'current', base, upstream })
  assert.equal(f.state.remote, original)
  assert.deepEqual(f.state.writes, [])
})

test('a clean candidate is lease-published and requests merge-commit auto-merge at its exact head', () => {
  const f = fixture()
  assert.deepEqual(f.run('prepare'), { state: 'awaiting-ci', pull: 70, base, upstream })
  assert.equal(f.state.remote, upstream)
  assert.equal(f.state.pulls[0].draft, false)
  assert.match(f.state.pulls[0].body, new RegExp(`saki-upstream-target:${upstream}`))
  const mutation = f.state.writes.find(item => item.path === 'graphql')
  assert.match(mutation.body.query, /mergeMethod: MERGE/)
  assert.deepEqual(mutation.body.variables, { id: 'PR_sync', oid: upstream })
  assert.equal(f.state.issues.length, 0)
})

test('a conflicted candidate opens one typed, Agent-ready Issue and remains a draft', () => {
  const f = fixture({ conflict: true })
  assert.equal(f.run('prepare').state, 'compatibility-required')
  assert.equal(f.state.pulls[0].draft, true)
  assert.equal(f.state.issues.length, 1)
  assert.equal(f.state.issues[0].type, 'Bug')
  assert.deepEqual(f.state.issues[0].labels, ['ready-for-agent', 'area/infra'])
  assert.match(f.state.issues[0].body, /saki-upstream-pr:70/)
  assert.match(f.state.issues[0].body, /packages\/storage\/index.ts/)
  assert.ok(!f.state.writes.some(item => item.path === 'graphql'))
  assert.equal(f.run('prepare').state, 'held')
  assert.equal(f.state.issues.length, 1)
})

test('a PR created during the probe prevents branch publication', () => {
  const f = fixture({ concurrentPull: pull() })
  assert.equal(f.run('prepare').state, 'held')
  assert.equal(f.state.remote, original)
  assert.deepEqual(f.state.writes, [])
})

test('a moved remote lease and a merge process failure cannot create a PR', () => {
  for (const options of [{ remoteMoved: true }, { mergeError: true }]) {
    const f = fixture(options)
    assert.throws(() => f.run('prepare'), /stale lease|merge-tree failed/)
    assert.equal(f.state.remote, original)
    assert.deepEqual(f.state.writes, [])
  }
})

test('non-draft failing CI finds a claimed legacy Issue without resetting its body, owner, or labels', () => {
  const originalIssue = issue()
  const f = fixture({ pulls: [pull()], issues: [structuredClone(originalIssue)] })
  assert.equal(f.run('route-ci', runEvent()).issue, 71)
  assert.deepEqual(f.state.issues, [originalIssue])
  assert.equal(f.state.comments.length, 1)
  assert.match(f.state.comments[0].body, /actions\/runs\/42/)
  assert.ok(!f.state.lists.some(path => path.includes('labels=ready-for-agent')))
  const writes = f.state.writes.length
  f.run('route-ci', runEvent())
  assert.equal(f.state.writes.length, writes)
  f.run('route-ci', runEvent({ html_url: `https://github.com/${repository}/actions/runs/43` }))
  assert.equal(f.state.comments.length, 1)
  assert.match(f.state.comments[0].body, /actions\/runs\/43/)
})

test('a current CI failure creates missing compatibility work once', () => {
  const f = fixture({ pulls: [pull()] })
  f.run('route-ci', runEvent())
  f.run('route-ci', runEvent())
  assert.equal(f.state.issues.length, 1)
  assert.match(f.state.issues[0].body, /saki-upstream-pr:70/)
})

test('successful CI leaves the Issue open until GitHub reports the PR merged', () => {
  const f = fixture({ pulls: [pull()], issues: [issue()] })
  assert.equal(f.run('route-ci', runEvent({ conclusion: 'success' })).state, 'awaiting-merge')
  assert.equal(f.state.issues[0].state, 'open')
  assert.deepEqual(f.state.writes, [])
  f.state.pulls[0].state = 'closed'
  f.state.pulls[0].merged = true
  const event = { action: 'closed', pull_request: structuredClone(f.state.pulls[0]) }
  assert.equal(f.run('route-closed', event).state, 'merged')
  assert.equal(f.state.issues[0].state, 'closed')
  assert.equal(f.state.issues[0].state_reason, 'completed')
  const writes = f.state.writes.length
  f.run('route-closed', event)
  assert.equal(f.state.writes.length, writes)
})

test('a PR closed without merging cancels its target without recording successful delivery', () => {
  const current = pull({ state: 'closed', merged: false })
  const f = fixture({ pulls: [current], issues: [issue()] })
  assert.equal(f.run('route-closed', { action: 'closed', pull_request: current }).state, 'abandoned')
  assert.equal(f.state.issues[0].state_reason, 'not_planned')
})

test('fork, stale, unrelated, incomplete, and draft CI events cannot mutate work', () => {
  const cases = [
    { event: runEvent({ head_repository: { full_name: 'someone/fork' } }) },
    { event: runEvent({ head_sha: repaired }) },
    { event: runEvent({ head_branch: 'feature/unrelated' }) },
    { event: runEvent({ name: 'Unrelated workflow' }) },
    { event: runEvent({ event: 'push' }) },
    { event: runEvent({ status: 'in_progress' }) },
    { event: runEvent(), current: pull({ draft: true }) },
    { event: runEvent(), current: pull({ base: { ref: 'feature/other', repo: { full_name: repository } } }) },
  ]
  for (const scenario of cases) {
    const f = fixture({ pulls: [scenario.current ?? pull()], issues: [issue()] })
    assert.equal(f.run('route-ci', scenario.event).state, 'ignored')
    assert.deepEqual(f.state.writes, [])
  }
})

test('an unrelated or stale close event cannot complete compatibility work', () => {
  const f = fixture({ pulls: [pull()], issues: [issue()] })
  assert.equal(f.run('route-closed', { action: 'closed', pull_request: pull() }).state, 'ignored')
  f.state.pulls[0] = pull({ state: 'closed', merged: true })
  assert.equal(f.run('route-closed', {
    action: 'closed', pull_request: pull({ head: { ...pull().head, sha: repaired } }),
  }).state, 'ignored')
  assert.deepEqual(f.state.writes, [])
})

test('status reports a claimed task without writing or running Git', () => {
  const f = fixture({ pulls: [pull()], issues: [issue()] })
  const result = f.run('status')
  assert.equal(result.issue, 71)
  assert.deepEqual(result.assignees, ['maintainer'])
  assert.deepEqual(f.state.writes, [])
  assert.deepEqual(f.state.gitCalls, [])
  assert.deepEqual(fixture().run('status'), { state: 'idle', repository })
})

test('duplicate work identities fail visibly instead of selecting an arbitrary task', () => {
  assert.throws(() => fixture({ pulls: [pull(), pull({ number: 700 })] }).run('status'), /multiple records/)
  const f = fixture({ pulls: [pull()], issues: [issue(), issue({ number: 72 })] })
  assert.throws(() => f.run('route-ci', runEvent()), /multiple records/)
  assert.deepEqual(f.state.writes, [])
})

test('a different PR number and an Issue API pull-request entry do not match legacy work', () => {
  const f = fixture({ pulls: [pull()], issues: [
    issue({ body: `<!-- saki-upstream-compatibility -->\n- sync PR: https://github.com/${repository}/pull/700` }),
    issue({ number: 700, pull_request: {} }),
  ] })
  assert.equal(f.run('status').issue, null)
})

test('unknown modes, repositories, and completed conclusions fail before a mutation', () => {
  const f = fixture({ pulls: [pull()] })
  assert.throws(() => f.run('unknown'), /maintenance mode/)
  assert.throws(() => runUpstreamMaintenance({ mode: 'prepare', repository: '../invalid' }, f.io), /owner\/repository/)
  assert.throws(() => f.run('route-ci', runEvent({ conclusion: 'unexpected' })), /unknown completed conclusion/)
  assert.throws(() => f.run('route-ci', {}), /workflow_run event/)
  assert.deepEqual(f.state.writes, [])
})

for (const conflict of [false, true]) {
  test(`real Git ${conflict ? 'conflict' : 'clean merge'} publishes the upstream commit without changing the checkout`, t => {
    const root = mkdtempSync(join(tmpdir(), 'saki-maintenance-'))
    t.after(() => {
      assert.equal(dirname(resolve(root)), resolve(tmpdir()))
      rmSync(root, { recursive: true, force: true })
    })
    const checkout = join(root, 'checkout')
    const origin = join(root, 'origin.git')
    const official = join(root, 'official.git')
    mkdirSync(checkout)
    const git = (args, allowedCodes = [0]) => {
      const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8', windowsHide: true })
      if (result.error) throw result.error
      assert.ok(allowedCodes.includes(result.status), result.stderr)
      return { code: result.status, stdout: result.stdout }
    }
    git(['init', '--quiet', '--initial-branch=master'])
    git(['config', 'user.name', 'Maintenance test'])
    git(['config', 'user.email', 'maintenance@example.invalid'])
    writeFileSync(join(checkout, 'shared.txt'), 'base\n')
    git(['add', 'shared.txt'])
    git(['commit', '--quiet', '-m', 'base'])
    git(['init', '--quiet', '--bare', origin])
    git(['init', '--quiet', '--bare', official])
    git(['remote', 'add', 'origin', origin])
    git(['checkout', '--quiet', '-b', 'official'])
    writeFileSync(join(checkout, 'shared.txt'), 'upstream\n')
    git(['commit', '--quiet', '-am', 'upstream change'])
    const officialHead = git(['rev-parse', 'HEAD']).stdout.trim()
    git(['push', '--quiet', official, 'HEAD:refs/heads/master'])
    git(['checkout', '--quiet', 'master'])
    writeFileSync(join(checkout, conflict ? 'shared.txt' : 'saki.txt'), 'saki\n')
    git(['add', '.'])
    git(['commit', '--quiet', '-m', 'Saki change'])
    const checkoutHead = git(['rev-parse', 'HEAD']).stdout.trim()
    const f = fixture()
    const api = f.io.api
    f.io.api = (method, path, body) => {
      const result = api(method, path, body)
      if (path.endsWith('/pulls')) {
        result.head.sha = officialHead
        f.state.pulls[0].head.sha = officialHead
      }
      return result
    }
    // Only the official network transport is replaced; merge-tree and lease publication use real Git.
    f.io.git = (args, allowedCodes) => git(args.map(arg => arg === 'https://github.com/deepseek-ai/deepseek-harness.git' ? official : arg), allowedCodes)
    const result = f.run('prepare')
    assert.equal(result.state, conflict ? 'compatibility-required' : 'awaiting-ci')
    assert.equal(git(['rev-parse', 'HEAD']).stdout.trim(), checkoutHead)
    assert.equal(git(['status', '--porcelain']).stdout, '')
    assert.equal(git(['--git-dir', origin, 'rev-parse', 'refs/heads/automation/upstream-sync']).stdout.trim(), officialHead)
    if (conflict) assert.match(f.state.issues[0].body, /shared\.txt/)
  })
}
