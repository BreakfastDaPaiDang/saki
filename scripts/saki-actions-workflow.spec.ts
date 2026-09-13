import { describe, expect, it } from 'vitest'
import { isRecord, loadWorkflow, workflowEvent, workflowJob } from './workflow-test-support.ts'

const readyPullRequestTypes = ['opened', 'synchronize', 'reopened', 'ready_for_review', 'converted_to_draft']
const readyPullRequestCondition = "github.event_name == 'pull_request' && github.event.pull_request.draft == false"

describe('Saki Actions cost policy', () => {
  it('retains planning diagnostics after successful or failed consumer gates', () => {
    const job = workflowJob(loadWorkflow('.github/workflows/ci.yml'), 'node-24-consumers')
    if (!Array.isArray(job.steps)) throw new TypeError('Consumer job must define steps')
    const gates = job.steps.findIndex(step => isRecord(step) && step.run === 'pnpm run check:ci:consumers')
    const upload = job.steps.findIndex(step => isRecord(step) && step.name === 'Retain Saki planning diagnostics')
    expect(gates).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(gates)
    expect(job.steps[upload]).toMatchObject({
      if: 'always()', uses: 'actions/upload-artifact@v7',
      with: {
        name: 'saki-planning-${{ github.run_id }}-${{ github.run_attempt }}',
        path: '.playwright-mcp/planning-*/',
        'include-hidden-files': true, 'if-no-files-found': 'ignore', 'retention-days': 7,
      },
    })
  })

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
      'node-24-bench',
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
    expect(aggregate.name)
      .toBe("${{ github.event_name == 'pull_request' && 'all checks passed' || 'manual suite (no merge verdict)' }}")
    expect(aggregate.if)
      .toBe("always() && github.event_name == 'pull_request'")
    expect(aggregate.steps).toContainEqual({
      name: 'Fail if any needed job did not succeed',
      if: "contains(needs.*.result, 'failure') || contains(needs.*.result, 'cancelled') || contains(needs.*.result, 'skipped')",
      run: 'echo "::error::Needed job results: ${{ join(needs.*.result, \', \') }}"\nexit 1\n',
    })
    expect(aggregate.needs).toEqual([
      'node-24',
      'node-24-coverage',
      'node-24-bench',
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
      'node-24-bench',
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

  it('runs Node Addon System only for ready path-matched pull requests or manual dispatch', () => {
    const workflow = loadWorkflow('.github/workflows/node-addon-system.yml')
    const events = workflowEvents(workflow)
    const pullRequest = workflowEvent(workflow, 'pull_request')

    expect(events).not.toHaveProperty('push')
    expect(events).toHaveProperty('workflow_dispatch', null)
    expect(pullRequest.types).toEqual(readyPullRequestTypes)
    expect(pullRequest.paths).toEqual(expect.arrayContaining(['native/system/**']))
    expect(workflowJob(workflow, 'matrix').if)
      .toBe("github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false")
    expect(workflowJob(workflow, 'native').needs).toBe('matrix')
    expect(workflowJobNames(workflow)).toEqual(['matrix', 'native'])
  })

  it('restricts the upstream reviewer policy to its owning repository', () => {
    const workflow = loadWorkflow('.github/workflows/request-review.yml')

    expect(workflowJobNames(workflow)).toEqual(['request-review'])
    expect(workflowJob(workflow, 'request-review').if)
      .toBe("github.repository == 'deepseek-ai/deepseek-harness'")
  })

  it('keeps upstream weighted-review automation outside Saki', () => {
    const publisher = loadWorkflow('.github/workflows/weighted-approval.yml')
    const reviewEvent = loadWorkflow('.github/workflows/weighted-approval-review-event.yml')
    expect(workflowJob(publisher, 'publish-status').if)
      .toBe("github.repository == 'deepseek-ai/deepseek-harness' && (github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success')")
    expect(workflowJob(reviewEvent, 'record-review-event').if)
      .toBe("github.repository == 'deepseek-ai/deepseek-harness'")
  })

  it('keeps optional Blacksmith capacity limited to the filename check and bwrap', () => {
    const filenames = workflowJob(loadWorkflow('.github/workflows/expected-filenames.yml'), 'expected-filenames')
    const sandbox = workflowJob(loadWorkflow('.github/workflows/sandbox.yml'), 'sandbox-e2e')
    expect(filenames['runs-on']).toContain("vars.DSH_CI_FAILOVER_LINUX == 'blacksmith' && 'blacksmith-4vcpu-ubuntu-2404'")
    expect(filenames['runs-on']).toContain("|| 'ubuntu-latest'")
    expect(sandbox['runs-on']).toContain("matrix.runner == 'bwrap' && vars.DSH_CI_FAILOVER_LINUX == 'blacksmith'")
    expect(sandbox['runs-on']).toContain('|| matrix.os')
    expect(JSON.stringify(loadWorkflow('.github/workflows/ci.yml'))).not.toContain('blacksmith-')
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
