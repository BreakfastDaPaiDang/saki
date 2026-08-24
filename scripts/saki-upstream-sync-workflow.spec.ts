import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const workflowPath = resolve(root, '.github/workflows/upstream-sync.yml')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function loadWorkflow(): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(workflowPath, 'utf8'))
  if (!isRecord(workflow)) throw new TypeError('Upstream sync workflow must be an object')
  return workflow
}

function jobScript(workflow: Record<string, unknown>, jobName: string): string {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[jobName])) {
    throw new TypeError(`Upstream sync workflow must define ${jobName}`)
  }
  const steps = workflow.jobs[jobName].steps
  if (!Array.isArray(steps)) throw new TypeError(`${jobName} must define steps`)
  return steps.flatMap(step => isRecord(step) && typeof step.run === 'string' ? [step.run] : []).join('\n')
}

function workflowJob(workflow: Record<string, unknown>, jobName: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[jobName])) {
    throw new TypeError(`Upstream sync workflow must define ${jobName}`)
  }
  return workflow.jobs[jobName]
}

describe('Saki upstream sync workflow', () => {
  it('supports scheduled, manual, and CI-completion routing', () => {
    const workflow = loadWorkflow()
    expect(isRecord(workflow.on)).toBe(true)
    if (!isRecord(workflow.on)) return
    expect(workflow.on).toHaveProperty('schedule')
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflow.on).toHaveProperty('workflow_run')
  })

  it('uses a GitHub App token for branches and pull requests', () => {
    const workflow = loadWorkflow()
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs.sync) || !Array.isArray(workflow.jobs.sync.steps)) {
      throw new TypeError('Upstream sync workflow must define sync steps')
    }
    const steps: unknown[] = workflow.jobs.sync.steps
    const tokenStep = steps.find(step => (
      isRecord(step) && step.uses === 'actions/create-github-app-token@v3'
    ))
    expect(tokenStep).toMatchObject({
      with: {
        'client-id': '${{ vars.SAKI_AUTOMATION_CLIENT_ID }}',
        'private-key': '${{ secrets.SAKI_AUTOMATION_PRIVATE_KEY }}',
      },
    })
  })

  it('lease-protects the sync branch and enables merge only for clean updates', () => {
    const workflow = loadWorkflow()
    const sync = workflowJob(workflow, 'sync')
    if (!Array.isArray(sync.steps)) throw new TypeError('sync must define steps')
    const steps: unknown[] = sync.steps
    const automaticMerge = steps.find(step => (
      isRecord(step) && step.name === 'Enable automatic merge after required CI'
    ))
    const script = jobScript(workflow, 'sync')
    expect(script).toContain('--force-with-lease=')
    expect(script).not.toMatch(/git push[^\n]*\s--force(?:\s|$)/)
    expect(script).toContain('enablePullRequestAutoMerge')
    expect(automaticMerge).toMatchObject({
      if: "steps.prepare.outputs.updated == 'true' && steps.prepare.outputs.conflict == 'false'",
    })
  })

  it('sets a repository-local identity before probing the upstream merge', () => {
    const script = jobScript(loadWorkflow(), 'sync')
    const identityOffset = script.indexOf("git config --local user.name 'Saki upstream automation'")
    const emailOffset = script.indexOf("git config --local user.email 'saki-upstream-automation@users.noreply.github.com'")
    const mergeOffset = script.indexOf('git merge --no-commit --no-ff')
    expect(identityOffset).toBeGreaterThanOrEqual(0)
    expect(emailOffset).toBeGreaterThan(identityOffset)
    expect(mergeOffset).toBeGreaterThan(emailOffset)
  })

  it('routes current non-draft CI results to one Agent-ready compatibility issue', () => {
    const workflow = loadWorkflow()
    const syncScript = jobScript(workflow, 'sync')
    const routeScript = jobScript(workflow, 'route-ci')
    expect(syncScript).toContain('ready-for-agent')
    expect(syncScript).toContain('git diff --name-only --diff-filter=U')
    expect(routeScript).toContain('ready-for-agent')
    expect(routeScript).toContain('state_reason=completed')
    if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs['route-ci'])) {
      throw new TypeError('Upstream sync workflow must define route-ci')
    }
    const route = workflow.jobs['route-ci']
    expect(route.if).toContain("head_branch == 'automation/upstream-sync'")
    expect(route.if).toContain('head_repository.full_name == github.repository')
    expect(routeScript).toContain("pr_head_sha=$(jq -r '.[0].head.sha // empty'")
    expect(routeScript).toContain('[[ "$pr_head_sha" == "$HEAD_SHA" ]] || exit 0')
    expect(routeScript).toContain("pr_is_draft=$(jq -r '.[0].draft // true'")
    expect(routeScript).toContain('[[ "$pr_is_draft" == \'false\' ]] || exit 0')
  })
})
