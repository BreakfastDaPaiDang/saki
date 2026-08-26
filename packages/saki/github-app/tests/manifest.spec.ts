import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Saki Product GitHub App manifest', () => {
  it('publishes the exact 0.1.0 permission ceiling without Contents or Workflows write', () => {
    const path = fileURLToPath(new URL('../product-app-manifest.json', import.meta.url))
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      default_events?: unknown
      default_permissions?: Record<string, unknown>
      hook_attributes?: { active?: unknown }
      request_oauth_on_install?: unknown
    }

    expect(manifest.default_permissions).toEqual({
      actions: 'read',
      checks: 'read',
      contents: 'read',
      issues: 'write',
      metadata: 'read',
      organization_projects: 'write',
      pull_requests: 'write',
      statuses: 'read',
    })
    expect(manifest.default_permissions).not.toHaveProperty('workflows')
    expect(manifest.default_events).toEqual([])
    expect(manifest.hook_attributes?.active).toBe(false)
    expect(manifest.request_oauth_on_install).toBe(false)
  })
})
