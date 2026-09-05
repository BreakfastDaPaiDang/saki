import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GitCommandError,
  GitRunner,
  gitGlobalArguments,
  gitInspectionEnvironment,
  runBoundedCommand,
} from '../src/git-runner.ts'

const fibers: Array<{ dispose(): Promise<void> }> = []
const roots: string[] = []
const GIT_SAFETY_VARIABLES = [
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ATTR_NOSYSTEM',
  'GIT_NO_LAZY_FETCH',
  'GIT_TERMINAL_PROMPT',
  'GIT_ASKPASS',
] as const

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(fibers.splice(0).map(async (fiber) => { await fiber.dispose() }))
  await Promise.all(roots.splice(0).map(async (root) => { await rm(root, { recursive: true, force: true }) }))
})

async function runtime(): Promise<Context> {
  const ctx = new Context()
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  return ctx
}

function stubConflictingGitSafetyEnvironment(): void {
  vi.stubEnv('git_config_nosystem', '0')
  vi.stubEnv('git_attr_nosystem', '0')
  vi.stubEnv('git_no_lazy_fetch', '0')
  vi.stubEnv('git_terminal_prompt', '1')
  vi.stubEnv('git_askpass', 'malicious-program')
}

describe('bounded raw command runner', () => {
  it('tombstones ambient Git config injection and disables lazy object fetches', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'filter.ambient.clean')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'malicious-program')

    const env = gitInspectionEnvironment()

    expect(env).toMatchObject({
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_KEY_0: undefined,
      GIT_CONFIG_VALUE_0: undefined,
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
    })
  })

  it('replaces case variants of fixed Git safety overrides with canonical keys', () => {
    stubConflictingGitSafetyEnvironment()
    const env = gitInspectionEnvironment()
    for (const name of GIT_SAFETY_VARIABLES) {
      expect(Object.keys(env).filter(key => key.toUpperCase() === name)).toEqual([name])
    }
  })

  it.runIf(process.platform === 'win32')('keeps fixed Git safety values in a real Windows child', async () => {
    stubConflictingGitSafetyEnvironment()
    const env = gitInspectionEnvironment()

    const ctx = await runtime()
    const result = await runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', [
        'const names = ["GIT_CONFIG_NOSYSTEM", "GIT_ATTR_NOSYSTEM",',
        '  "GIT_NO_LAZY_FETCH", "GIT_TERMINAL_PROMPT", "GIT_ASKPASS"];',
        'process.stdout.write(JSON.stringify(Object.fromEntries(',
        '  names.map(name => [name, process.env[name]]),',
        ')));',
      ].join('\n')],
      cwd: process.cwd(),
      env,
      maxStdoutBytes: 1_024,
      maxStderrBytes: 1_024,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_LAZY_FETCH: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    })
  })

  it('returns complete raw bytes only after both streams and the process tree settle', async () => {
    const ctx = await runtime()
    const result = await runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0, 255])); process.stderr.write("ok")'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    expect([...result.stdout]).toEqual([0, 255])
    expect(result.stderr.toString('utf8')).toBe('ok')
  })

  it('writes exact bounded stdin bytes and rejects oversized input before spawn', async () => {
    const ctx = await runtime()
    const result = await runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
      cwd: process.cwd(),
      env: {},
      stdin: { bytes: Buffer.from([0, 255]), maxBytes: 2 },
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)
    expect([...result.stdout]).toEqual([0, 255])

    const spawn = vi.fn()
    await expect(runBoundedCommand({ spawn } as unknown as SubprocessRuntime, {
      argv: ['git', 'check-attr'],
      cwd: process.cwd(),
      env: {},
      stdin: { bytes: Buffer.alloc(3), maxBytes: 2 },
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'stdin-limit' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('aborts instead of returning a truncated stream when a byte limit is reached', async () => {
    const ctx = await runtime()
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stdout.write("abc")'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'stdout-limit' })
  })

  it('enforces one streaming budget across commands and concurrent output streams', async () => {
    const ctx = await runtime()
    let remaining = 3
    const outputBudget = {
      observe(bytes: number) {
        if (bytes > remaining) return false
        remaining -= bytes
        return true
      },
    }
    const command = (source: string) => runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', source],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 10,
      maxStderrBytes: 10,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
      outputBudget,
    }, new AbortController().signal)

    await expect(command('process.stdout.write("ab")')).resolves.toMatchObject({ stdout: Buffer.from('ab') })
    const failure = await command('process.stdout.write("c"); process.stderr.write("d")')
      .then<unknown, unknown>(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(GitCommandError)
    if (failure instanceof GitCommandError) expect(failure.code).toMatch(/^(?:stdout|stderr)-limit$/u)
    expect(remaining).toBe(0)
  })

  it('settles a child that closes stdin before consuming the submitted bytes', async () => {
    const ctx = await runtime()
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stdin.destroy(); process.exit(0)'],
      cwd: process.cwd(),
      env: {},
      stdin: { bytes: Buffer.alloc(1024 * 1024), maxBytes: 1024 * 1024 },
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'stream-failure' })
  })

  it('aborts a child that never consumes a backpressured stdin stream', async () => {
    const ctx = await runtime()
    const root = await mkdtemp(join(tmpdir(), 'saki-git-stdin-abort-'))
    roots.push(root)
    const marker = join(root, 'started')
    const controller = new AbortController()
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); process.stdin.pause(); setInterval(() => {}, 1000)`],
      cwd: root,
      env: {},
      stdin: { bytes: Buffer.alloc(8 * 1024 * 1024), maxBytes: 8 * 1024 * 1024 },
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 20,
    }, controller.signal)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(marker).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
  })

  it('rejects a stderr overflow without retaining child diagnostics', async () => {
    const ctx = await runtime()
    const concat = vi.spyOn(Buffer, 'concat')
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stderr.write(Buffer.alloc(1024 * 1024, "s"))'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'stderr-limit' })
    await expect(pending).rejects.not.toThrow(/sss/u)
    expect(concat.mock.calls.every(([, total]) => total === undefined || total <= 2)).toBe(true)
  })

  it('honors caller abort after spawn and settles the child tree', async () => {
    const ctx = await runtime()
    const root = await mkdtemp(join(tmpdir(), 'saki-git-abort-'))
    roots.push(root)
    const marker = join(root, 'started')
    const controller = new AbortController()
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000)`],
      cwd: root,
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 20,
    }, controller.signal)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await readFile(marker).then(() => true, () => false)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(await readFile(marker, 'utf8')).toBe('ready')

    controller.abort(new Error('private abort reason'))

    await expect(pending).rejects.toMatchObject({ code: 'aborted' })
    await expect(pending).rejects.not.toThrow('private abort reason')
  })

  it('waits for a surviving descendant before returning', async () => {
    const ctx = await runtime()
    const root = await mkdtemp(join(tmpdir(), 'saki-git-descendant-'))
    roots.push(root)
    const marker = join(root, 'descendant-finished')
    if (process.platform === 'win32') {
      const controller = new AbortController()
      const descendant = 'setInterval(() => {}, 1000)'
      const parent = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
        `writeFileSync(${JSON.stringify(marker)}, String(child.pid))`,
        'setInterval(() => {}, 1000)',
      ].join(';')
      const pending = runBoundedCommand(ctx.subprocess, {
        argv: [process.execPath, '-e', parent],
        cwd: root,
        env: {},
        maxStdoutBytes: 2,
        maxStderrBytes: 2,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      }, controller.signal)
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await readFile(marker).then(() => true, () => false)) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const childPid = Number(await readFile(marker, 'utf8'))

      controller.abort()
      await expect(pending).rejects.toMatchObject({ code: 'aborted' })
      expect(() => process.kill(childPid, 0)).toThrow()
      return
    }
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 300)`
    const parent = [
      "const { spawn } = require('node:child_process')",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })`,
      'child.unref()',
      'setTimeout(() => {}, 100)',
    ].join(';')

    await runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', parent],
      cwd: root,
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    expect(await readFile(marker, 'utf8')).toBe('done')
  })

  it('does not allocate the observed size after one oversized output chunk', async () => {
    const ctx = await runtime()
    const concat = vi.spyOn(Buffer, 'concat')
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(1024 * 1024))'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'stdout-limit' })
    expect(concat.mock.calls.every(([, total]) => total === undefined || total <= 2)).toBe(true)
  })

  it('classifies timeout without exposing child output', async () => {
    const ctx = await runtime()
    const pending = runBoundedCommand(ctx.subprocess, {
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 20,
      terminationGraceMs: 10,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'timeout' })
  })

  it('retains only the bounded numeric fact needed to distinguish Git config exits', async () => {
    const ctx = await runtime()
    for (const exitCode of [1, 3]) {
      const pending = runBoundedCommand(ctx.subprocess, {
        argv: [process.execPath, '-e', `process.stderr.write("secret"); process.exit(${exitCode})`],
        cwd: process.cwd(),
        env: {},
        maxStdoutBytes: 2,
        maxStderrBytes: 16,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      }, new AbortController().signal)

      await expect(pending).rejects.toMatchObject({ code: 'nonzero', exitCode })
      await expect(pending).rejects.not.toThrow('secret')
    }
  })

  it('contains a synchronous spawn failure without exposing command diagnostics', async () => {
    const secret = 'C:\\private\\customer-secret'
    const subprocess = {
      spawn: () => { throw new Error(`cannot spawn in ${secret}`) },
    } as unknown as SubprocessRuntime
    const pending = runBoundedCommand(subprocess, {
      argv: ['git', 'status'],
      cwd: secret,
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'spawn-failure' })
    await expect(pending).rejects.not.toThrow(secret)
  })

  it('classifies a pre-aborted caller without exposing its reason', async () => {
    const controller = new AbortController()
    controller.abort(new Error('private caller reason'))

    await expect(runBoundedCommand({} as SubprocessRuntime, {
      argv: ['git', 'status'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, controller.signal)).rejects.toMatchObject({ code: 'aborted' })
  })

  it('contains process-tree wait failures and makes a best-effort teardown', async () => {
    const secret = 'C:\\private\\wait-diagnostic'
    const terminate = vi.fn()
    const waitForExit = vi.fn()
      .mockRejectedValueOnce(new Error(`wait failed for ${secret}`))
      .mockResolvedValueOnce(true)
    const subprocess = {
      spawn: () => ({
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate,
        waitForExit,
      }),
    } as unknown as SubprocessRuntime

    const pending = runBoundedCommand(subprocess, {
      argv: ['git', 'status'],
      cwd: secret,
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'spawn-failure' })
    await expect(pending).rejects.not.toThrow(secret)
    expect(terminate).toHaveBeenCalledOnce()
    expect(waitForExit).toHaveBeenCalledTimes(2)
  })

  it('rejects incomplete process handles after bounded best-effort teardown', async () => {
    for (const streams of [
      { stdout: undefined, stderr: Readable.from([]) },
      { stdout: Readable.from([]), stderr: undefined },
      { stdout: Readable.from([]), stderr: Readable.from([]), stdin: undefined },
    ]) {
      const terminate = vi.fn(() => { throw new Error('private terminate diagnostic') })
      const waitForExit = vi.fn().mockResolvedValue(true)
      const subprocess = {
        spawn: () => ({
          ...streams,
          done: Promise.resolve({ exitCode: 0, signal: null }),
          terminate,
          waitForExit,
        }),
      } as unknown as SubprocessRuntime
      const pending = runBoundedCommand(subprocess, {
        argv: ['git', 'status'],
        cwd: process.cwd(),
        env: {},
        ...(Object.hasOwn(streams, 'stdin')
          ? { stdin: { bytes: Buffer.alloc(0), maxBytes: 1 } }
          : {}),
        maxStdoutBytes: 2,
        maxStderrBytes: 2,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      }, new AbortController().signal)

      await expect(pending).rejects.toMatchObject({ code: 'spawn-failure' })
      expect(terminate).toHaveBeenCalledOnce()
      expect(waitForExit).toHaveBeenCalledOnce()
    }
  })

  it('classifies a rejected process result after joining its tree', async () => {
    const terminate = vi.fn()
    const subprocess = {
      spawn: () => ({
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.reject(new Error('private process failure')),
        terminate,
        waitForExit: () => Promise.resolve(true),
      }),
    } as unknown as SubprocessRuntime
    const pending = runBoundedCommand(subprocess, {
      argv: ['git', 'status'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)

    await expect(pending).rejects.toMatchObject({ code: 'spawn-failure' })
    expect(terminate).toHaveBeenCalled()
  })

  it('contains a synchronous stdin stream failure', async () => {
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback() } })
    stdin.end = (() => { throw new Error('private stdin failure') }) as typeof stdin.end
    const subprocess = {
      spawn: () => ({
        stdin,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        waitForExit: () => Promise.resolve(true),
      }),
    } as unknown as SubprocessRuntime
    await expect(runBoundedCommand(subprocess, {
      argv: ['git', 'check-attr'],
      cwd: process.cwd(),
      env: {},
      stdin: { bytes: Buffer.from('path'), maxBytes: 4 },
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'stream-failure' })
  })

  it('normalizes non-Buffer chunks and discards all chunks after overflow', async () => {
    const stdout = Readable.from([Uint8Array.of(1, 2)], { objectMode: true })
    const subprocess = {
      spawn: () => ({
        stdout,
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        waitForExit: () => Promise.resolve(true),
      }),
    } as unknown as SubprocessRuntime
    await expect(runBoundedCommand(subprocess, {
      argv: ['git', 'status'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)).resolves.toMatchObject({ stdout: Buffer.from([1, 2]) })

    const overflowing = {
      spawn: () => ({
        stdout: Readable.from([Buffer.alloc(3), Buffer.from('discarded')]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        waitForExit: () => Promise.resolve(true),
      }),
    } as unknown as SubprocessRuntime
    await expect(runBoundedCommand(overflowing, {
      argv: ['git', 'status'],
      cwd: process.cwd(),
      env: {},
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    }, new AbortController().signal)).rejects.toMatchObject({ code: 'stdout-limit' })
  })

  it.each([
    ['win32', 'NUL', '/dev/null'],
    ['linux', '/dev/null', 'NUL'],
  ] as const)('constructs fixed %s Git isolation with %s', (platform, nullDevice, otherNullDevice) => {
    const globalArguments = gitGlobalArguments(platform)
    expect(globalArguments).toEqual([
      '--no-pager',
      '--no-lazy-fetch',
      '--no-replace-objects',
      '-c', 'core.commitGraph=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'advice.sparseIndexExpanded=false',
      '-c', 'core.pager=cat',
      '-c', 'credential.helper=',
      '-c', 'diff.external=',
      '-c', `core.hooksPath=${nullDevice}`,
      '-c', `core.excludesFile=${nullDevice}`,
      '-c', `core.attributesFile=${nullDevice}`,
      '--no-optional-locks',
    ])
    expect(globalArguments).not.toEqual(expect.arrayContaining([
      `core.excludesFile=${otherNullDevice}`,
      `core.attributesFile=${otherNullDevice}`,
    ]))
    expect(gitInspectionEnvironment(platform)).toMatchObject({ GIT_CONFIG_GLOBAL: nullDevice })
  })

  it('runs Git with the isolation constructed for the current platform', async () => {
    const spawn = vi.fn((_spec: Parameters<SubprocessRuntime['spawn']>[0]) => ({
      stdin: new Writable({ write(_chunk, _encoding, callback) { callback() } }),
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: () => Promise.resolve(true),
    }))
    const runner = new GitRunner({ spawn } as unknown as SubprocessRuntime, 'git', {
      maxStdoutBytes: 2,
      maxStderrBytes: 2,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    })

    await runner.run(process.cwd(), ['status'], new AbortController().signal)
    await runner.run(
      process.cwd(),
      ['check-attr'],
      new AbortController().signal,
      { bytes: Buffer.alloc(0), maxBytes: 1 },
      { observe: () => true },
    )
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
    expect(spawn.mock.calls[1]![0].argv).toEqual([
      'git',
      '--no-pager',
      '--no-lazy-fetch',
      '--no-replace-objects',
      '-c', 'core.commitGraph=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'advice.sparseIndexExpanded=false',
      '-c', 'core.pager=cat',
      '-c', 'credential.helper=',
      '-c', 'diff.external=',
      '-c', `core.hooksPath=${nullDevice}`,
      '-c', `core.excludesFile=${nullDevice}`,
      '-c', `core.attributesFile=${nullDevice}`,
      '--no-optional-locks',
      'check-attr',
    ])
  })

  it('spawns structured mutations with fixed Git isolation and operation-owned state', async () => {
    const ambient = {
      GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_CONFIG_KEY_1: process.env.GIT_CONFIG_KEY_1,
      GIT_CONFIG_VALUE_1: process.env.GIT_CONFIG_VALUE_1,
      GIT_CONFIG_SYSTEM: process.env.GIT_CONFIG_SYSTEM,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
      GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
      GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL,
      GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL,
      GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
      GIT_PAGER: process.env.GIT_PAGER,
      GIT_EDITOR: process.env.GIT_EDITOR,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
      SSH_ASKPASS: process.env.SSH_ASKPASS,
    }
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: 'caller-hooks',
      GIT_CONFIG_KEY_1: 'commit.gpgSign',
      GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_SYSTEM: 'caller-system-config',
      GIT_CONFIG_GLOBAL: 'caller-global-config',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_INDEX_FILE: 'caller-index',
      GIT_OBJECT_DIRECTORY: 'caller-objects',
      GIT_AUTHOR_NAME: 'Caller Author',
      GIT_AUTHOR_EMAIL: 'caller-author@example.invalid',
      GIT_AUTHOR_DATE: 'caller-author-date',
      GIT_COMMITTER_NAME: 'Caller Committer',
      GIT_COMMITTER_EMAIL: 'caller-committer@example.invalid',
      GIT_COMMITTER_DATE: 'caller-committer-date',
      GIT_PAGER: 'caller-pager',
      GIT_EDITOR: 'caller-editor',
      GIT_ASKPASS: 'caller-askpass',
      SSH_ASKPASS: 'caller-ssh-askpass',
    })
    try {
      const spawn = vi.fn((_spec: Parameters<SubprocessRuntime['spawn']>[0]) => ({
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate: vi.fn(),
        waitForExit: () => Promise.resolve(true),
      }))
      const runner = new GitRunner({ spawn } as unknown as SubprocessRuntime, 'git', {
        maxStdoutBytes: 2,
        maxStderrBytes: 3,
        timeoutMs: 5_000,
        terminationGraceMs: 100,
      })
      const operation = {
        hooksDirectory: 'owned-hooks',
        indexFile: 'owned-index',
        objectDirectory: 'owned-objects',
        author: {
          name: 'Owned Author',
          email: 'owned-author@example.invalid',
          date: '1700000000 +0000',
        },
        committer: {
          name: 'Owned Committer',
          email: 'owned-committer@example.invalid',
          date: '1700000001 +0000',
        },
      }

      await runner.runMutation(
        'owned-worktree',
        ['write-tree'],
        new AbortController().signal,
        operation,
      )

      expect(spawn).toHaveBeenCalledOnce()
      const firstCall = spawn.mock.calls[0]
      if (firstCall === undefined) throw new Error('Git mutation did not spawn')
      const spec = firstCall[0]
      const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
      expect(spec).toEqual({
        argv: [
          'git',
          '--no-pager',
          '--no-lazy-fetch',
          '--no-replace-objects',
          '-c', 'core.commitGraph=false',
          '-c', 'core.fsmonitor=false',
          '-c', 'advice.sparseIndexExpanded=false',
          '-c', 'core.pager=cat',
          '-c', 'credential.helper=',
          '-c', 'diff.external=',
          '-c', `core.hooksPath=${nullDevice}`,
          '-c', `core.excludesFile=${nullDevice}`,
          '-c', `core.attributesFile=${nullDevice}`,
          '--no-optional-locks',
          '-c', 'core.hooksPath=owned-hooks',
          '-c', 'commit.gpgSign=false',
          '-c', 'i18n.commitEncoding=UTF-8',
          '-c', 'core.fsyncMethod=fsync',
          '-c', 'core.fsync=loose-object,index,reference',
          'write-tree',
        ],
        cwd: 'owned-worktree',
        env: {
          ...gitInspectionEnvironment(),
          GIT_INDEX_FILE: 'owned-index',
          GIT_OBJECT_DIRECTORY: 'owned-objects',
          GIT_AUTHOR_NAME: 'Owned Author',
          GIT_AUTHOR_EMAIL: 'owned-author@example.invalid',
          GIT_AUTHOR_DATE: '1700000000 +0000',
          GIT_COMMITTER_NAME: 'Owned Committer',
          GIT_COMMITTER_EMAIL: 'owned-committer@example.invalid',
          GIT_COMMITTER_DATE: '1700000001 +0000',
        },
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        graceMs: 100,
        signal: spec.signal,
      })
      const environment = spec.env
      expect(environment).toBeDefined()
      if (environment === undefined) throw new Error('Git mutation spawn has no environment')
      expect(environment).toMatchObject({
        LC_ALL: 'C',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: nullDevice,
        GIT_ATTR_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_EDITOR: 'true',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
      })
      for (const key of [
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_CONFIG_KEY_1',
        'GIT_CONFIG_VALUE_1',
        'GIT_CONFIG_SYSTEM',
      ]) {
        expect(environment[key]).toBeUndefined()
      }

      await runner.runMutation(
        'owned-worktree',
        ['write-tree'],
        new AbortController().signal,
        { hooksDirectory: 'owned-hooks' },
      )

      expect(spawn).toHaveBeenCalledTimes(2)
      const secondCall = spawn.mock.calls[1]
      if (secondCall === undefined) throw new Error('second Git mutation did not spawn')
      const withoutOwnedState = secondCall[0]
      expect(withoutOwnedState.argv).toEqual(spec.argv)
      const cleanEnvironment = withoutOwnedState.env
      expect(cleanEnvironment).toBeDefined()
      if (cleanEnvironment === undefined) throw new Error('second Git mutation spawn has no environment')
      for (const key of [
        'GIT_INDEX_FILE',
        'GIT_OBJECT_DIRECTORY',
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_AUTHOR_DATE',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
        'GIT_COMMITTER_DATE',
      ]) {
        expect(cleanEnvironment[key]).toBeUndefined()
      }
    } finally {
      for (const [key, value] of Object.entries(ambient)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
  })

  it('passes exact binary stdin to a bounded Git mutation', async () => {
    const written: Buffer[] = []
    const spawn = vi.fn((_spec: Parameters<SubprocessRuntime['spawn']>[0]) => ({
      stdin: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          written.push(Buffer.from(chunk))
          callback()
        },
      }),
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: () => Promise.resolve(true),
    }))
    const runner = new GitRunner({ spawn } as unknown as SubprocessRuntime, 'git', {
      maxStdoutBytes: 2,
      maxStderrBytes: 3,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    })
    const bytes = Buffer.from([0, 255])
    await runner.runMutation('owned-worktree', ['hash-object', '-w', '--stdin'],
      new AbortController().signal, { hooksDirectory: 'owned-hooks' }, { bytes, maxBytes: 2 })
    expect(Buffer.concat(written)).toEqual(bytes)
    expect(spawn.mock.calls[0]?.[0].stdio).toMatchObject({ stdin: 'pipe' })
  })

  it.each([
    ['git-credential-manager', 'manager'],
    ['git-credential-manager-core', 'manager-core'],
  ] as const)('runs GitHub transport with the fixed non-interactive %s adapter', async (adapter, helper) => {
    const spawn = vi.fn((_spec: Parameters<SubprocessRuntime['spawn']>[0]) => ({
      stdout: Readable.from([]),
      stderr: Readable.from([]),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: vi.fn(),
      waitForExit: () => Promise.resolve(true),
    }))
    const runner = new GitRunner({ spawn } as unknown as SubprocessRuntime, 'git', {
      maxStdoutBytes: 2,
      maxStderrBytes: 3,
      timeoutMs: 5_000,
      terminationGraceMs: 100,
    })

    await runner.runGitHubTransport(
      'private-git-directory',
      ['ls-remote', '--refs', 'https://github.com/o/r.git', 'refs/heads/main'],
      new AbortController().signal,
      adapter,
    )

    const spec = spawn.mock.calls[0]?.[0]
    if (spec === undefined) throw new Error('GitHub transport did not spawn')
    expect(spec.argv).toEqual(expect.arrayContaining([
      '-c', 'credential.helper=',
      '-c', `credential.helper=${helper}`,
      '-c', 'protocol.allow=never',
      '-c', 'protocol.https.allow=always',
      '-c', 'http.followRedirects=false',
      '--git-dir=private-git-directory',
      'ls-remote', '--refs', 'https://github.com/o/r.git', 'refs/heads/main',
    ]))
    expect(spec.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GCM_INTERACTIVE: 'Never',
      GIT_CREDENTIAL_INTERACTIVE: 'never',
    })
  })
})
