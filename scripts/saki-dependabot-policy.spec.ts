import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const configPath = resolve(root, '.github/dependabot.yml')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('Saki Dependabot policy', () => {
  it('inherits routine dependency upgrades from upstream while retaining security update policy', () => {
    const config: unknown = yaml.load(readFileSync(configPath, 'utf8'))
    if (!isRecord(config) || !Array.isArray(config.updates)) {
      throw new TypeError('Dependabot config must define updates')
    }

    const ecosystems = new Map(config.updates.map((update: unknown) => {
      if (!isRecord(update) || typeof update['package-ecosystem'] !== 'string') {
        throw new TypeError('Every Dependabot update must define a package ecosystem')
      }
      return [update['package-ecosystem'], update]
    }))

    expect([...ecosystems.keys()].sort()).toEqual(['github-actions', 'npm', 'uv'])
    for (const update of ecosystems.values()) {
      expect(update['open-pull-requests-limit']).toBe(0)
    }
    expect(ecosystems.get('npm')?.groups).toEqual({
      security: { 'applies-to': 'security-updates', patterns: ['*'] },
    })
  })
})
