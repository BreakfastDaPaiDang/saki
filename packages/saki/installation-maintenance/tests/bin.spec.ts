import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function resolvePowerShellPath(): string {
  const result = spawnSync(
    'pwsh',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName',
    ],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error('PowerShell executable resolution failed')
  const path = result.stdout.trim()
  if (path === '') throw new Error('PowerShell executable resolution returned an empty path')
  return path
}

function environmentWithPath(path: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'),
    ),
    PATH: path,
  }
}

describe('Saki maintenance executable', () => {
  it('writes one JSON usage line and exits with code 2', () => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx/esm', resolve('packages/saki/installation-maintenance/src/bin.ts')],
      { cwd: resolve('.'), encoding: 'utf8' },
    )

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr.trim().split(/\r?\n/u)).toHaveLength(1)
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: 'usage',
      usage: 'Usage: saki-maintenance (backup | verify <backup-id> | upgrade) [--installation-root <absolute-path>] [--legacy-database <absolute-path>]',
    })
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('forwards the maintenance exit code through the PowerShell wrapper', () => {
    const result = spawnSync(
      resolvePowerShellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/saki-maintenance.ps1'),
      ],
      { cwd: resolve('.'), encoding: 'utf8' },
    )

    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr)).toMatchObject({ ok: false, error: 'usage' })
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('fails when the PowerShell wrapper cannot find Node', () => {
    const powershellPath = resolvePowerShellPath()
    const result = spawnSync(
      powershellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        resolve('scripts/saki-maintenance.ps1'),
      ],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: environmentWithPath(dirname(powershellPath)),
      },
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('node is not available on PATH')
  }, 20_000)

  it.skipIf(process.platform !== 'win32')('fails when the PowerShell wrapper cannot start Node', () => {
    const powershellPath = resolvePowerShellPath()
    const fakeBin = mkdtempSync(join(tmpdir(), 'saki-maintenance-node-'))
    try {
      writeFileSync(join(fakeBin, 'node.exe'), 'not an executable')
      const result = spawnSync(
        powershellPath,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-File',
          resolve('scripts/saki-maintenance.ps1'),
        ],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          env: environmentWithPath([fakeBin, dirname(powershellPath)].join(delimiter)),
        },
      )

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('node was found on PATH but could not be started')
    } finally {
      rmSync(fakeBin, { recursive: true, force: true })
    }
  }, 20_000)
})
