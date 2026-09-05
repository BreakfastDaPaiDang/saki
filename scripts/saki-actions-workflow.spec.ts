import { describe, expect, it } from 'vitest'
import { isRecord, loadWorkflow, workflowEvent, workflowJob } from './workflow-test-support.ts'

const readyPullRequestTypes = ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']
const readyPullRequestCondition = "github.event_name == 'pull_request' && github.event.pull_request.draft == false"

describe('Saki Actions cost policy', () => {
  it('runs required CI on every ready revision and keeps all other jobs guarded', () => {
    const workflow = loadWorkflow('.github/workflows/ci.yml')
    const events = workflowEvents(workflow)
    const pullRequest = workflowEvent(workflow, 'pull_request')
    const dispatch = workflowEvent(workflow, 'workflow_dispatch')
    if (!isRecord(dispatch.inputs) || !isRecord(dispatch.inputs.suite)) {
      throw new TypeError('CI workflow must define the manual suite selector')
    }

    expect(events).not.toHaveProperty('push')
    expect(pullRequest.types).toEqual(readyPullRequestTypes)
    expect(dispatch.inputs.suite).toMatchObject({
      default: 'windows-native',
      options: ['windows-native', 'larger-runner-benchmark', 'consolidated-runner-benchmark'],
    })
    expect(workflow.concurrency).toMatchObject({ 'cancel-in-progress': true })

    for (const jobName of [
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
    ]) {
      expect(workflowJob(workflow, jobName).if, `${jobName} must skip draft pull requests`)
        .toBe(readyPullRequestCondition)
    }

    const aggregate = workflowJob(workflow, 'all-checks-passed')
    expect(aggregate.name).toBe('all checks passed')
    expect(aggregate.if)
      .toBe(`always() && ${readyPullRequestCondition}`)
    expect(aggregate.needs).toEqual([
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
    ])
    expect(workflowJob(workflow, 'windows-native')).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && inputs.suite == 'windows-native'",
      'runs-on': 'windows-latest',
    })
    expect(workflowJob(workflow, 'serial-linux').if).toBe(false)
    expect(workflowJob(workflow, 'serial-macos').if).toBe(false)
    expect(workflowJob(workflow, 'larger-runner-benchmark').if)
      .toBe("github.event_name == 'workflow_dispatch' && inputs.suite == 'larger-runner-benchmark'")
    expect(workflowJob(workflow, 'consolidated-runner-benchmark').if)
      .toBe("github.event_name == 'workflow_dispatch' && inputs.suite == 'consolidated-runner-benchmark'")
    expect(workflowJobNames(workflow)).toEqual([
      'node-24',
      'node-24-coverage',
      'node-24-consumers',
      'node-compat',
      'python-sdk',
      'python-runtime',
      'windows',
      'windows-native',
      'serial-linux',
      'serial-macos',
      'larger-runner-benchmark',
      'consolidated-runner-benchmark',
      'all-checks-passed',
    ])
  })

  it('binds package release packing to each release tag family or manual dispatch', () => {
    const dsh = loadWorkflow('.github/workflows/release.yml')
    const vendor = loadWorkflow('.github/workflows/release-vendor.yml')

    expect(Object.keys(workflowEvents(dsh)).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(Object.keys(workflowEvents(vendor)).sort()).toEqual(['push', 'workflow_dispatch'])
    expect(workflowEvent(dsh, 'push')).toEqual({ tags: ['dsh-v*'] })
    expect(workflowEvent(vendor, 'push')).toEqual({ tags: ['vendor-*-v*'] })
    expect(workflowJobNames(dsh)).toEqual(['dependencies', 'pack'])
    expect(workflowJobNames(vendor)).toEqual(['pack'])
    for (const workflow of [dsh, vendor]) {
      expect(workflowEvents(workflow).workflow_dispatch).toBeNull()
    }
  })

  it('keeps reference and documentation work on version tags or manual dispatch', () => {
    const sandbox = loadWorkflow('.github/workflows/sandbox.yml')
    const docs = loadWorkflow('.github/workflows/docs-pages.yml')

    expect(workflowEvents(sandbox)).toEqual({
      push: { tags: ['saki-v*', 'dsh-v*'] },
      workflow_dispatch: null,
    })
    expect(workflowEvents(docs)).toEqual({
      push: { tags: ['saki-v*'] },
      workflow_dispatch: null,
    })
    expect(workflowJob(docs, 'build').if).toBe("vars.SAKI_DOCS_PAGES_ENABLED == 'true'")
    expect(workflowJob(docs, 'deploy').if).toBe("vars.SAKI_DOCS_PAGES_ENABLED == 'true'")
  })

  it('runs Landlock only for ready path-matched pull requests or manual dispatch', () => {
    const workflow = loadWorkflow('.github/workflows/landlock-run.yml')
    const events = workflowEvents(workflow)
    const pullRequest = workflowEvent(workflow, 'pull_request')

    expect(events).not.toHaveProperty('push')
    expect(events).toHaveProperty('workflow_dispatch', null)
    expect(pullRequest.types).toEqual(readyPullRequestTypes)
    expect(pullRequest.paths).toEqual(expect.arrayContaining(['native/landlock-run/**']))
    expect(workflowJob(workflow, 'matrix').if)
      .toBe("github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false")
    expect(workflowJob(workflow, 'darwin').if)
      .toBe("github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false")
  })

  it('keeps the secret-bearing DeepSeek suite manual-only', () => {
    const workflow = loadWorkflow('.github/workflows/e2e.yml')

    expect(workflowEvents(workflow)).toEqual({ workflow_dispatch: null })
    expect(workflowJob(workflow, 'e2e').if).toBeUndefined()
  })
})

function workflowEvents(workflow: Record<string, unknown>): Record<string, unknown> {
  if (!isRecord(workflow.on)) throw new TypeError('workflow must define events')
  return workflow.on
}

function workflowJobNames(workflow: Record<string, unknown>): string[] {
  if (!isRecord(workflow.jobs)) throw new TypeError('workflow must define jobs')
  return Object.keys(workflow.jobs)
}
