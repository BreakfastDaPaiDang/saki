import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspacePackageSet } from './publish-npm-baseline.ts'

let root: string

function writeManifest(directory: string, manifest: Record<string, unknown>): void {
  const absolute = resolve(root, directory)
  mkdirSync(absolute, { recursive: true })
  writeFileSync(resolve(absolute, 'package.json'), `${JSON.stringify(manifest)}\n`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-baseline-selection-'))
  writeFileSync(resolve(root, 'package.json'), '{"version":"1.2.3"}\n')
  writeManifest('vendor/cordis', { name: '@deepseek-ai/cordis', version: '4.0.0' })
  writeManifest('packages/core/agent', { name: '@deepseek-ai/dsh-agent', version: '1.2.3' })
  writeManifest('apps/cli', { name: '@deepseek-ai/dsh', version: '1.2.3' })
  writeManifest('packages/saki/bundle', {
    name: '@breakfastdapaidang/saki-bundle',
    version: '0.1.0',
    private: true,
  })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('npm baseline package selection', () => {
  it('packs exactly the discovered DSH and vendor directories, excluding private Saki packages', () => {
    const packageSet = WorkspacePackageSet.discover(root)
    const calls: Array<{ command: string; args: string[]; cwd: string }> = []
    const destination = resolve(root, '.artifacts/test-npm-baseline')

    packageSet.pack(root, destination, {
      run: (command, args, cwd) => { calls.push({ command, args, cwd }) },
    })

    expect(packageSet.packages).toEqual([
      { name: '@deepseek-ai/cordis', directory: 'vendor/cordis', origin: 'vendor' },
      { name: '@deepseek-ai/dsh', directory: 'apps/cli', origin: 'harness' },
      { name: '@deepseek-ai/dsh-agent', directory: 'packages/core/agent', origin: 'harness' },
    ])
    expect(new Set(packageSet.packages.map(pkg => pkg.directory)).size).toBe(packageSet.packages.length)
    expect(calls).toEqual(packageSet.packages.map(pkg => ({
      command: 'pnpm',
      cwd: root,
      args: [
        '--filter',
        `./${pkg.directory}`,
        'pack',
        '--pack-destination',
        destination,
      ],
    })))
  })

  it('rejects a Saki-only workspace instead of broadening an empty selection', () => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(resolve(root, 'package.json'), '{"version":"1.2.3"}\n')
    writeManifest('packages/saki/bundle', {
      name: '@breakfastdapaidang/saki-bundle',
      version: '0.1.0',
      private: true,
    })

    expect(() => WorkspacePackageSet.discover(root))
      .toThrow('no DSH or vendored packages selected for npm baseline')
  })
})
