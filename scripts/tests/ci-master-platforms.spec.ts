/** Platform scheduling for Saki’s ready-PR gate and complete release matrix. */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { gatesForMode } from '../run-gates.ts'

const root = resolve(import.meta.dirname, '../..')
const readyPullRequest = "github.event_name == 'pull_request' && github.event.pull_request.draft == false"
const runtimeBuilder = './.github/workflows/build-exe-for-python-sdk.yml'

interface Job {
  if?: string | boolean
  uses?: string
  needs?: string[]
  with?: Record<string, unknown>
  steps?: Array<{ name?: string; run?: string; if?: string; uses?: string; with?: Record<string, unknown> }>
  'runs-on'?: string | string[]
  'continue-on-error'?: boolean
}

interface Workflow {
  on: Record<string, unknown>
  jobs: Record<string, Job>
}

function workflow(name: string): Workflow {
  return load(readFileSync(resolve(root, '.github/workflows', name), 'utf8')) as Workflow
}

function commands(job: Job): string[] {
  return (job.steps ?? []).flatMap(step => step.run ? [step.run] : [])
}

describe('Saki platform scheduling', () => {
  it('requires Linux x64 runtime and Wine on ready PRs without a master workflow', () => {
    const pr = workflow('ci.yml')
    expect(Object.keys(pr.on)).toEqual(['pull_request', 'workflow_dispatch'])
    expect(pr.jobs['python-runtime']).toMatchObject({
      if: readyPullRequest,
      uses: runtimeBuilder,
      with: { ci: true, targets: 'node24-linux-x64' },
    })
    expect(existsSync(resolve(root, '.github/workflows/ci-master.yml'))).toBe(false)
    const aggregate = pr.jobs['all-checks-passed']!
    expect(aggregate.needs).toContain('python-runtime')
    expect(aggregate.needs).toContain('windows')
    expect(aggregate.needs!.every(id => id in pr.jobs)).toBe(true)
    expect(aggregate.if).toBe(`always() && ${readyPullRequest}`)
    expect(aggregate.steps).toContainEqual(expect.objectContaining({
      if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
    }))
  })

  it('runs Wine once on hosted PR CI with cached packages and unconditional cleanup', () => {
    const pr = workflow('ci.yml')
    const wine = pr.jobs.windows!
    expect(wine).toMatchObject({ if: readyPullRequest, 'runs-on': 'ubuntu-latest' })
    expect(wine.needs).toBeUndefined()
    expect(wine['continue-on-error']).toBeUndefined()
    expect(pr.jobs['wine-apt-cache']).toBeUndefined()
    expect(Object.values(pr.jobs).flatMap(commands).filter(command => command.includes('wine-windows-gates.sh')))
      .toEqual(['bash scripts/wine-windows-gates.sh'])
    expect(wine.steps).toContainEqual(expect.objectContaining({
      uses: 'actions/cache@v4', with: { path: '~/wine-debs', key: '${{ steps.wine-cache-key.outputs.key }}' },
    }))
    expect(commands(wine).join('\n')).toContain('--download-only wine')
    expect(wine.steps).toContainEqual(expect.objectContaining({ name: 'Shut down wineserver', if: 'always()' }))
    // Graph construction needs a pnpm entrypoint but never launches it.
    const previous = process.env.npm_execpath
    process.env.npm_execpath = '/test/pnpm.cjs'
    try {
      for (const mode of ['ci-linux-primary', 'ci-windows-complete'] as const) {
        expect(gatesForMode(mode).map(gate => gate.displayCommand).join('\n')).not.toMatch(/wine/i)
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'npm_execpath')
      else process.env.npm_execpath = previous
    }
    expect(process.env.npm_execpath).toBe(previous)
  })

  it('retains the complete release matrix independently of CI scheduling', () => {
    const release = workflow('python-release.yml')
    const calls = Object.values(release.jobs).filter(job => job.uses === runtimeBuilder)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.with).toMatchObject({
      release: true,
      targets: 'node24-linux-x64,node24-linux-arm64,node24-macos-arm64,node24-macos-x64,node24-win-x64',
    })
  })
})
