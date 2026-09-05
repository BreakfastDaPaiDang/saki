import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRecord, loadWorkflow, workflowEvent, workflowJob } from './workflow-test-support.ts'

const root = resolve(import.meta.dirname, '..')
const path = '.github/workflows/upstream-sync.yml'

describe('Saki upstream maintenance', () => {
  it('runs the GitHub operation regressions through the same Node module as Actions', () => {
    const output = execFileSync(process.execPath, ['--test', '.github/maintenance/upstream.test.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })
    expect(output).toMatch(/(?:#|ℹ) fail 0/)
  }, 35_000)

  it('supports scheduled preparation and current CI or closed-PR reconciliation', () => {
    const workflow = loadWorkflow(path)
    expect(workflow.on).toMatchObject({ schedule: [{ cron: '17 19 * * *' }] })
    expect(workflow.on).toHaveProperty('workflow_dispatch')
    expect(workflowEvent(workflow, 'workflow_run')).toMatchObject({ workflows: ['CI'], types: ['completed'] })
    expect(workflowEvent(workflow, 'pull_request')).toMatchObject({ types: ['closed'] })
    expect(workflow.concurrency).toMatchObject({ group: 'saki-upstream-sync', 'cancel-in-progress': false })
  })

  it('uses the GitHub App only for preparation and runs all modes from trusted master code', () => {
    const workflow = loadWorkflow(path)
    const modes = { sync: 'prepare', 'route-ci': 'route-ci', 'route-closed': 'route-closed' }
    for (const [name, mode] of Object.entries(modes)) {
      const job = workflowJob(workflow, name)
      if (!Array.isArray(job.steps)) throw new TypeError(`${name} must define steps`)
      const steps = job.steps.filter(isRecord)
      const checkout = steps.find(step => step.uses === 'actions/checkout@v6')
      expect(checkout).toMatchObject({ with: { ref: 'master' } })
      expect(steps.some(step => step.run === `node .github/maintenance/upstream.mjs ${mode}`)).toBe(true)
      if (name === 'sync') {
        expect(steps.find(step => step.uses === 'actions/create-github-app-token@v3')).toMatchObject({
          with: {
            'client-id': '${{ vars.SAKI_AUTOMATION_CLIENT_ID }}',
            'private-key': '${{ secrets.SAKI_AUTOMATION_PRIVATE_KEY }}',
            'permission-contents': 'write',
            'permission-workflows': 'write',
          },
        })
      } else {
        expect(checkout).toMatchObject({ with: { 'persist-credentials': false } })
        expect(job.permissions).toEqual({ contents: 'read', issues: 'write', 'pull-requests': 'read' })
      }
    }
  })

  it('filters fork results before allocating reconciliation runners', () => {
    const workflow = loadWorkflow(path)
    expect(workflowJob(workflow, 'route-ci').if).toContain('head_repository.full_name == github.repository')
    expect(workflowJob(workflow, 'route-closed').if).toContain('head.repo.full_name == github.repository')
    expect(workflowJob(workflow, 'sync').if).toContain("github.event_name == 'schedule'")
    expect(workflowJob(workflow, 'sync').if).toContain("github.event_name == 'workflow_dispatch'")
  })
})
