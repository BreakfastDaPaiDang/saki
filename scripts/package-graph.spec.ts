import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPackageGraph } from './package-graph.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function manifest(root: string, rel: string, value: Record<string, unknown>): void {
  const path = join(root, rel, 'package.json')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

describe('workspace package graph', () => {
  it('includes private Saki packages without colliding with DSH short names', () => {
    const root = mkdtempSync(join(tmpdir(), 'saki-package-graph-'))
    roots.push(root)
    manifest(root, 'packages/core/bundle', { name: '@deepseek-ai/dsh-bundle' })
    manifest(root, 'packages/saki/bundle', {
      name: '@breakfastdapaidang/saki-bundle',
      peerDependencies: { '@deepseek-ai/dsh-bundle': 'workspace:^' },
    })

    expect(collectPackageGraph(root, ['core', 'saki'], 'test')).toEqual([
      {
        short: 'bundle',
        name: '@deepseek-ai/dsh-bundle',
        group: 'core',
        rel: 'packages/core/bundle',
        deps: [],
      },
      {
        short: 'saki/bundle',
        name: '@breakfastdapaidang/saki-bundle',
        group: 'saki',
        rel: 'packages/saki/bundle',
        deps: ['bundle'],
      },
    ])
  })

  it('ignores packages outside the two product namespaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'saki-package-graph-'))
    roots.push(root)
    manifest(root, 'packages/core/agent', { name: '@deepseek-ai/dsh-agent' })
    manifest(root, 'packages/other/plugin', { name: '@example/plugin' })

    expect(collectPackageGraph(root, [], 'test').map(pkg => pkg.name)).toEqual([
      '@deepseek-ai/dsh-agent',
    ])
  })
})
