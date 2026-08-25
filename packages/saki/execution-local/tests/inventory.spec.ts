import { createHash } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildInheritedChangeBaseline } from '../src/baseline.ts'
import {
  captureRepositoryInventory,
  createRepositoryObservationRound,
  isSupportedInventoryPath,
  type RepositoryInventoryFileFacts,
} from '../src/inventory.ts'
import { GitCommandError } from '../src/git-runner.ts'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('closed repository inventory', () => {
  it('rejects Win32 alternate data stream path components as non-ordinary entries', () => {
    expect(isSupportedInventoryPath('dir/file', 'win32')).toBe(true)
    expect(isSupportedInventoryPath('tracked.txt:secret', 'win32')).toBe(false)
    expect(isSupportedInventoryPath('dir/stream:name', 'win32')).toBe(false)
    expect(isSupportedInventoryPath('tracked.txt:secret', 'linux')).toBe(true)
    expect(isSupportedInventoryPath('tracked.txt:secret', 'darwin')).toBe(true)
    expect(isSupportedInventoryPath('back\\slash', 'win32')).toBe(false)
    expect(isSupportedInventoryPath('back\\slash', 'linux')).toBe(true)
  })

  it('shares one bounded output and lifetime ledger across an observation round', async () => {
    const caller = new AbortController()
    let budgetResults: boolean[] = []
    using round = createRepositoryObservationRound({
      async run(_cwd, _args, _signal, stdin, outputBudget) {
        expect(stdin?.bytes).toEqual(Buffer.from('input'))
        if (outputBudget === undefined) throw new Error('missing aggregate output budget')
        budgetResults = [
          outputBudget.observe(Number.NaN),
          outputBudget.observe(-1),
          outputBudget.observe(3),
          outputBudget.observe(3),
        ]
        return output('ok')
      },
    }, inventoryBounds({ maxGitOutputBytes: 5 }), caller.signal)

    await expect(round.git.run(
      'root', ['probe'], caller.signal, { bytes: Buffer.from('input'), maxBytes: 5 },
    )).resolves.toEqual(output('ok'))
    expect(budgetResults).toEqual([false, false, true, false])

    using diagnosticRound = createRepositoryObservationRound({
      async run() { return { stdout: Buffer.alloc(0), stderr: Buffer.from('private diagnostic') } },
    }, inventoryBounds(), new AbortController().signal)
    await expect(diagnosticRound.git.run(
      'root', ['probe'], new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('preserves caller cancellation and classifies observation-deadline races as unavailable', async () => {
    const before = new AbortController()
    using beforeRound = createRepositoryObservationRound({
      async run() { throw new Error('must not run after caller cancellation') },
    }, inventoryBounds(), before.signal)
    const beforeReason = new Error('cancelled before observation command')
    before.abort(beforeReason)
    await expect(beforeRound.git.run('root', ['probe'], before.signal)).rejects.toBe(beforeReason)

    using expiredRound = createRepositoryObservationRound({
      async run() { throw new Error('must not run after observation deadline') },
    }, inventoryBounds({ maxCaptureMs: 1 }), new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(expiredRound.git.run(
      'root', ['probe'], new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })

    const during = new AbortController()
    const duringReason = new Error('cancelled while command settled')
    using duringRound = createRepositoryObservationRound({
      async run() {
        during.abort(duringReason)
        return output('ignored')
      },
    }, inventoryBounds(), during.signal)
    await expect(duringRound.git.run('root', ['probe'], during.signal)).rejects.toBe(duringReason)

    using settledAfterDeadline = createRepositoryObservationRound({
      async run() {
        await new Promise(resolve => setTimeout(resolve, 10))
        return output('late')
      },
    }, inventoryBounds({ maxCaptureMs: 1 }), new AbortController().signal)
    await expect(settledAfterDeadline.git.run(
      'root', ['probe'], new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('joins HEAD, stage zero, raw current bytes, and path-local attributes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const content = Buffer.from('clean')
    await writeFile(join(root, 'file.txt'), content)
    const objectId = gitBlobId('sha1', content)
    const run = async (_cwd: string, args: readonly string[]) => {
      const command = args.join(' ')
      if (command === 'ls-tree -r --full-tree -z HEAD') {
        return output(`100644 blob ${objectId}\tfile.txt\0`)
      }
      if (command === 'ls-files -t --stage --full-name -z') {
        return output(`H 100644 ${objectId} 0\tfile.txt\0`)
      }
      if (command === 'ls-files --others --exclude-standard --full-name -z') return output('')
      if (command === 'config --no-includes --null --name-only --list') return output('')
      if (command === 'config --no-includes --null --type=bool --get-all core.fileMode') return output('false\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.symlinks') return output('true\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.autocrlf') return output('false\0')
      if (command === 'check-attr --all -z --stdin') return output('')
      throw new Error(`unexpected command: ${command}`)
    }

    const inventory = await captureRepositoryInventory(
      root,
      { run },
      'sha1',
      {
        maxEntries: 10,
        maxPathBytes: 1_024,
        maxGitOutputBytes: 64 * 1_024,
        maxFileBytes: 1_024,
        maxTotalFileBytes: 4_096,
        maxCaptureMs: 10_000,
      },
      new AbortController().signal,
    )

    expect(inventory).toMatchObject({
      objectFormat: 'sha1',
      comparison: { fileMode: false, symlinks: true, autocrlf: false },
      entries: [{
        head: { mode: '100644', objectId },
        index: { mode: '100644', objectId },
        stages: [undefined, undefined, undefined],
        current: { kind: 'captured', rawObjectId: objectId, rawByteLength: 5 },
        conversion: { executableFilter: false, unmodeled: false, lineEnding: false },
      }],
    })
  })

  it('retains a complete SHA-256 inventory and baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const content = Buffer.from('sha256 current')
    await writeFile(join(root, 'file'), content)
    const retained = '1'.repeat(64)
    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({
        tree: `100644 blob ${retained}\tfile\0`,
        index: `H 100644 ${retained} 0\tfile\0`,
      }) },
      'sha256',
      inventoryBounds(),
      new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory, inventoryBounds(), 1, new AbortController().signal,
    )

    expect(inventory.entries.at(0)?.current).toMatchObject({
      kind: 'captured', rawObjectId: gitBlobId('sha256', content),
    })
    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      baseline: {
        kind: 'complete',
        entries: [{
          head: { kind: 'object', objectId: retained },
          index: { kind: 'object', objectId: retained },
        }],
      },
    })
  })

  it('joins a staged deletion and same-path recreation into one tracked entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'file'), 'recreated')
    const head = '1'.repeat(40)
    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({
        tree: `100644 blob ${head}\tfile\0`,
        index: '',
        untracked: 'file\0',
      }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory, inventoryBounds(), 1, new AbortController().signal,
    )

    expect(inventory.entries).toHaveLength(1)
    expect(inventory.entries.at(0)).toMatchObject({ head: { objectId: head }, untracked: true })
    expect(inventory.entries.at(0)?.index).toBeUndefined()
    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      baseline: {
        kind: 'complete',
        entries: [{ statusKind: 'tracked', head: { kind: 'object' }, index: { kind: 'missing' } }],
      },
    })
  })

  it('classifies an untracked filter path without executing the filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'new.txt'), 'untracked')
    let attributeInput: Buffer | undefined
    const baseRun = inventoryCommands({
      tree: '',
      index: '',
      untracked: 'new.txt\0',
      attributes: 'new.txt\0filter\0driver\0',
    })
    const run = async (
      cwd: string,
      args: readonly string[],
      _signal: AbortSignal,
      stdin?: { readonly bytes: Uint8Array },
    ) => {
      if (args[0] === 'check-attr') attributeInput = Buffer.from(stdin?.bytes ?? [])
      return await baseRun(cwd, args)
    }
    const inventory = await captureRepositoryInventory(
      root, { run }, 'sha1', inventoryBounds(), new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory, inventoryBounds(), 1, new AbortController().signal,
    )

    expect(attributeInput).toEqual(Buffer.from('new.txt\0'))
    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      conversionAmbiguous: true,
      baseline: { kind: 'complete', entries: [{ statusKind: 'untracked' }] },
    })
  })

  it('rejects local and conditional config include declarations before inventory reads', async () => {
    for (const configNames of ['include.path\0', 'includeIf.gitdir:repo.path\0']) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      let commands = 0
      const baseRun = inventoryCommands({ tree: '', index: '', configNames })
      const run = async (cwd: string, args: readonly string[]) => {
        commands += 1
        return await baseRun(cwd, args)
      }

      await expect(captureRepositoryInventory(
        root, { run }, 'sha1', inventoryBounds(), new AbortController().signal,
      )).rejects.toMatchObject({ kind: 'unavailable' })
      expect(commands).toBe(1)
    }
  })

  it('classifies malformed, duplicate, and aggregate-overbound Git membership', async () => {
    const object = '1'.repeat(40)
    const cases: readonly [
      string,
      Parameters<typeof inventoryCommands>[0],
      Partial<ReturnType<typeof inventoryBoundsBase>>,
      'malformed' | 'unavailable',
    ][] = [
      ['parser entry limit', {
        tree: `100644 blob ${object}\ta\0` + `100644 blob ${object}\tb\0`, index: '',
      }, { maxEntries: 1 }, 'unavailable'],
      ['malformed tree record', { tree: 'broken\0', index: '' }, {}, 'malformed'],
      ['directory-shaped path', { tree: `100644 blob ${object}\tdir/\0`, index: '' }, {}, 'unavailable'],
      ['sparse index entry', { tree: '', index: `S 100644 ${object} 0\tfile\0` }, {}, 'unavailable'],
      ['index directory mode', { tree: '', index: `H 040000 ${object} 0\tfile\0` }, {}, 'unavailable'],
      ['index and untracked collision', {
        tree: '', index: `H 100644 ${object} 0\tfile\0`, untracked: 'file\0',
      }, {}, 'malformed'],
      ['duplicate untracked path', { tree: '', index: '', untracked: 'file\0file\0' }, {}, 'malformed'],
      ['aggregate entry limit', {
        tree: `100644 blob ${object}\ta\0`, index: `H 100644 ${object} 0\tb\0`,
      }, { maxEntries: 1 }, 'unavailable'],
      ['aggregate path-byte limit', {
        tree: `100644 blob ${object}\taa\0`, index: `H 100644 ${object} 0\tbb\0`,
      }, { maxPathBytes: 2 }, 'unavailable'],
      ['invalid object syntax', { tree: `100644 blob ${'1'.repeat(39)}\tfile\0`, index: '' }, {}, 'malformed'],
      ['object width disagrees with repository format', {
        tree: `100644 blob ${'1'.repeat(64)}\tfile\0`, index: '',
      }, {}, 'malformed'],
    ]

    for (const [name, commands, bounds, kind] of cases) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      await expect(captureRepositoryInventory(
        root,
        { run: inventoryCommands(commands) },
        'sha1',
        inventoryBounds(bounds),
        new AbortController().signal,
      ), name).rejects.toMatchObject({ kind })
    }
  })

  it('retains every non-zero conflict stage in its exact slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'file'), 'current')
    const objects = ['1', '2', '3'].map(value => value.repeat(40))
    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({
        tree: '',
        index: objects.map((object, index) => `M 100644 ${object} ${index + 1}\tfile\0`).join(''),
      }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )

    expect(inventory.entries[0]?.stages.map(stage => stage?.objectId)).toEqual(objects)
  })

  it('validates missing and malformed Git config values without consulting includes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const empty = inventoryCommands({ tree: '', index: '' })
    const missing = await captureRepositoryInventory(
      root,
      {
        async run(cwd, args) {
          if (args.includes('--get-all')) throw new GitCommandError('nonzero', 1)
          return await empty(cwd, args)
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    expect(missing.comparison).toEqual({ fileMode: true, symlinks: true, autocrlf: false })

    await expect(captureRepositoryInventory(
      root,
      {
        async run(cwd, args) {
          const invocation = args.join(' ')
          if (invocation === 'config --no-includes --null --type=bool --get-all core.autocrlf') {
            throw new GitCommandError('nonzero', 128)
          }
          if (invocation === 'config --no-includes --null --get-all core.autocrlf') {
            throw new GitCommandError('nonzero', 1)
          }
          return await empty(cwd, args)
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })

    for (const [name, command, value, kind] of [
      ['boolean', 'core.fileMode', 'invalid\0', 'malformed'],
      ['autocrlf typed boolean', 'core.autocrlf', 'invalid\0', 'malformed'],
      ['autocrlf fallback', 'core.autocrlf', 'invalid\0', 'unavailable'],
    ] as const) {
      await expect(captureRepositoryInventory(
        root,
        {
          async run(cwd, args) {
            const invocation = args.join(' ')
            if (name === 'autocrlf fallback'
              && invocation === 'config --no-includes --null --type=bool --get-all core.autocrlf') {
              throw new GitCommandError('nonzero', 128)
            }
            if (invocation.endsWith(`--get-all ${command}`)) return output(value)
            return await empty(cwd, args)
          },
        },
        'sha1',
        inventoryBounds(),
        new AbortController().signal,
      ), name).rejects.toMatchObject({ kind })
    }
  })

  it('rejects invalid NUL framing, UTF-8, attributes, diagnostics, and aggregate Git output', async () => {
    const object = '1'.repeat(40)
    for (const [name, run, bounds, kind] of [
      ['empty config key', async () => output('\0'), {}, 'malformed'],
      ['partial config key', async () => output('include.path'), {}, 'malformed'],
      ['invalid config UTF-8', async () => ({ stdout: Buffer.from([0xff, 0]), stderr: Buffer.alloc(0) }), {}, 'malformed'],
      ['Git diagnostic', async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.from('private') }), {}, 'unavailable'],
      ['Git output bound', inventoryCommands({ tree: `100644 blob ${object}\tfile\0`, index: '' }), {
        maxGitOutputBytes: 1,
      }, 'unavailable'],
      ['provider failure', async () => { throw new TypeError('provider implementation failure') }, {}, 'unavailable'],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      await expect(captureRepositoryInventory(
        root, { run }, 'sha1', inventoryBounds(bounds), new AbortController().signal,
      ), name).rejects.toMatchObject({ kind })
    }

    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'file'), 'value')
    await expect(captureRepositoryInventory(
      root,
      { run: inventoryCommands({
        tree: '', index: '', untracked: 'file\0', attributes: 'other\0text\0set\0',
      }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('applies line-ending conversion only to a raw mismatch on the same path', async () => {
    for (const changed of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      const content = Buffer.from('line\n')
      await writeFile(join(root, 'file'), content)
      const current = gitBlobId('sha1', content)
      const index = changed ? '1'.repeat(40) : current
      const inventory = await captureRepositoryInventory(
        root,
        { run: inventoryCommands({
          tree: `100644 blob ${index}\tfile\0`,
          index: `H 100644 ${index} 0\tfile\0`,
          attributes: 'file\0text\0set\0',
        }) },
        'sha1',
        inventoryBounds(),
        new AbortController().signal,
      )
      const result = buildInheritedChangeBaseline(
        inventory, inventoryBounds(), 1, new AbortController().signal,
      )

      expect(result.conversionAmbiguous).toBe(changed)
      expect(result.inheritedChangeEntryCount).toBe(changed ? 1 : 0)
    }
  })

  it('retains duplicate current-file identity as a blocking baseline failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'one'), 'shared')
    await link(join(root, 'one'), join(root, 'two'))
    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: '', index: '', untracked: 'one\0two\0' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory, inventoryBounds(), 1, new AbortController().signal,
    )

    expect(result).toMatchObject({
      inheritedChangeEntryCount: 2,
      baseline: { kind: 'unavailable', reason: 'duplicate-path' },
    })
  })

  it('captures a gitlink-to-file typechange and scans the actual blob path for attributes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const content = Buffer.from('replacement file')
    await writeFile(join(root, 'module'), content)
    const gitlinkObject = '1'.repeat(40)
    let attributeInput: Buffer | undefined
    const run = async (
      _cwd: string,
      args: readonly string[],
      _signal: AbortSignal,
      stdin?: { readonly bytes: Uint8Array },
    ) => {
      const command = args.join(' ')
      if (command === 'ls-tree -r --full-tree -z HEAD') {
        return output(`160000 commit ${gitlinkObject}\tmodule\0`)
      }
      if (command === 'ls-files -t --stage --full-name -z') {
        return output(`H 160000 ${gitlinkObject} 0\tmodule\0`)
      }
      if (command === 'ls-files --others --exclude-standard --full-name -z') return output('')
      if (command === 'config --no-includes --null --name-only --list') return output('')
      if (command === 'config --no-includes --null --type=bool --get-all core.fileMode') return output('false\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.symlinks') return output('true\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.autocrlf') return output('false\0')
      if (command === 'check-attr --all -z --stdin') {
        attributeInput = Buffer.from(stdin!.bytes)
        return output('module\0filter\0unspecified\0')
      }
      throw new Error(`unexpected command: ${command}`)
    }

    const inventory = await captureRepositoryInventory(
      root,
      { run },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      async () => { throw new Error('regular worktree file must not be read as a nested repository') },
    )
    const result = buildInheritedChangeBaseline(
      inventory,
      {
        maxEntries: 10,
        maxPathBytes: 1_024,
        maxGitOutputBytes: 64 * 1_024,
        maxFileBytes: 1_024,
        maxTotalFileBytes: 4_096,
        maxCaptureMs: 10_000,
      },
      1,
      new AbortController().signal,
    )

    expect(attributeInput).toEqual(Buffer.from('module\0'))
    expect(inventory.entries[0]).toMatchObject({
      current: { kind: 'captured', evidence: { kind: 'regular' } },
      conversion: { executableFilter: true },
    })
    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      conversionAmbiguous: true,
      baseline: {
        kind: 'complete',
        entries: [{
          statusKind: 'tracked',
          index: { kind: 'object', mode: '160000', objectId: gitlinkObject },
          worktree: { kind: 'regular' },
        }],
      },
    })
  })

  it('retains known change membership after file-mode and special-file evidence failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const path = join(root, 'file')
    await writeFile(path, 'content')
    const objectId = gitBlobId('sha1', Buffer.from('content'))
    const baseRun = inventoryCommands({
      tree: `100644 blob ${objectId}\tfile\0`,
      index: `H 100644 ${objectId} 0\tfile\0`,
    })
    const run = async (cwd: string, args: readonly string[]) => args.join(' ')
      === 'config --no-includes --null --type=bool --get-all core.fileMode'
      ? output('true\0')
      : await baseRun(cwd, args)

    const executable = await captureRepositoryInventory(
      root,
      { run },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(value) {
          const result = await lstat(value, { bigint: true })
          return value === path ? withOwnerExecute(result) : result
        },
        async open() { throw new Error('provider read failure') },
      }),
    )
    expect(executable.entries.at(0)?.current).toEqual({ kind: 'unavailable', reason: 'io-failure' })

    const special = await captureRepositoryInventory(
      root,
      { run },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(value) {
          const result = await lstat(value, { bigint: true })
          return value === path ? specialFileStat(result) : result
        },
      }),
    )
    expect(special.entries.at(0)?.current).toEqual({ kind: 'unavailable', reason: 'unsupported-state' })
  })

  it('does not downgrade a nested Git transport failure to path-local baseline evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await mkdir(join(root, 'module'))
    const objectId = '1'.repeat(40)

    await expect(captureRepositoryInventory(
      root,
      { run: inventoryCommands({
        tree: `160000 commit ${objectId}\tmodule\0`,
        index: `H 160000 ${objectId} 0\tmodule\0`,
      }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      async () => { throw new GitCommandError('timeout') },
    )).rejects.toMatchObject({ code: 'timeout' })
  })

  it('uses Git canonical booleans while preserving autocrlf input and explicit empty values', async () => {
    for (const [typed, raw, expected] of [
      ['false\0', undefined, false],
      ['true\0', undefined, true],
      [new GitCommandError('nonzero', 128), 'input\0', true],
      [new GitCommandError('nonzero', 128), 'input\0false\0', false],
      [new GitCommandError('nonzero', 128), 'false\0input\0', true],
      [new GitCommandError('nonzero', 128), 'input\0\0', false],
      [new GitCommandError('nonzero', 128), 'input\0yes\0', true],
      [new GitCommandError('nonzero', 128), 'input\0off\0', false],
      [new GitCommandError('nonzero', 128), 'input\0-0002\0', true],
      [new GitCommandError('nonzero', 128), `input\0${'0'.repeat(10_000)}\0`, false],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      let rawReads = 0
      const run = async (_cwd: string, args: readonly string[]) => {
        const command = args.join(' ')
        if (command === 'ls-tree -r --full-tree -z HEAD'
          || command === 'ls-files -t --stage --full-name -z'
          || command === 'ls-files --others --exclude-standard --full-name -z'
          || command === 'config --no-includes --null --name-only --list'
          || command === 'check-attr --all -z --stdin') return output('')
        if (command === 'config --no-includes --null --type=bool --get-all core.fileMode') return output('false\0')
        if (command === 'config --no-includes --null --type=bool --get-all core.symlinks') return output('true\0')
        if (command === 'config --no-includes --null --type=bool --get-all core.autocrlf') {
          if (typed instanceof Error) throw typed
          return output(typed)
        }
        if (command === 'config --no-includes --null --get-all core.autocrlf') {
          rawReads += 1
          return output(raw!)
        }
        throw new Error(`unexpected command: ${command}`)
      }

      const inventory = await captureRepositoryInventory(
        root, { run }, 'sha1', inventoryBounds(), new AbortController().signal,
      )

      expect(inventory.comparison.autocrlf).toBe(expected)
      expect(rawReads).toBe(raw === undefined ? 0 : 1)
    }
  })

  it('does not retry a typed autocrlf query after a transport failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    let rawReads = 0
    const run = async (_cwd: string, args: readonly string[]) => {
      const command = args.join(' ')
      if (command === 'ls-tree -r --full-tree -z HEAD'
        || command === 'ls-files -t --stage --full-name -z'
        || command === 'ls-files --others --exclude-standard --full-name -z'
        || command === 'config --no-includes --null --name-only --list') return output('')
      if (command === 'config --no-includes --null --type=bool --get-all core.fileMode') return output('false\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.symlinks') return output('true\0')
      if (command === 'config --no-includes --null --type=bool --get-all core.autocrlf') {
        throw new GitCommandError('timeout')
      }
      if (command === 'config --no-includes --null --get-all core.autocrlf') rawReads += 1
      throw new Error(`unexpected command: ${command}`)
    }

    await expect(captureRepositoryInventory(
      root, { run }, 'sha1', inventoryBounds(), new AbortController().signal,
    )).rejects.toMatchObject({ code: 'timeout' })
    expect(rawReads).toBe(0)
  })

  it('enforces the inventory clock during Git reads and immediately before publication', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(firstRoot)
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const firstCommands = inventoryCommands({ tree: '', index: '' })
    await expect(captureRepositoryInventory(
      firstRoot,
      {
        async run(cwd, args) {
          const result = await firstCommands(cwd, args)
          if (args[0] === 'ls-tree') clock = 20_000
          return result
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })

    vi.restoreAllMocks()
    const finalRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(finalRoot)
    clock = 0
    let afterAttributes = false
    let finalClockReads = 0
    vi.spyOn(performance, 'now').mockImplementation(() => {
      if (!afterAttributes) return 0
      finalClockReads += 1
      return finalClockReads <= 2 ? 0 : 20_000
    })
    const finalCommands = inventoryCommands({ tree: '', index: '' })
    await expect(captureRepositoryInventory(
      finalRoot,
      {
        async run(cwd, args) {
          const result = await finalCommands(cwd, args)
          if (args[0] === 'check-attr') afterAttributes = true
          return result
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })
    expect(finalClockReads).toBe(3)
  })

  it('classifies an inventory-wide deadline that expires inside an uncooperative provider', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await expect(captureRepositoryInventory(
      root,
      {
        async run() {
          await new Promise(resolve => setTimeout(resolve, 10))
          throw new TypeError('late provider failure')
        },
      },
      'sha1',
      inventoryBounds({ maxCaptureMs: 1 }),
      new AbortController().signal,
    )).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('classifies a deadline that expires during one current-file provider call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'file'), 'value')
    const opened = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const maxCaptureMs = 1
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const pending = captureRepositoryInventory(
        root,
        { run: inventoryCommands({
          tree: `100644 blob ${'1'.repeat(40)}\tfile\0`,
          index: `H 100644 ${'2'.repeat(40)} 0\tfile\0`,
        }) },
        'sha1',
        inventoryBounds({ maxCaptureMs }),
        new AbortController().signal,
        undefined,
        nodeFacts({
          async open() {
            opened.resolve(undefined)
            await release.promise
            throw new TypeError('late file provider failure')
          },
        }),
      )
      const phase = await Promise.race([
        opened.promise.then(() => 'opened' as const),
        pending.then(() => 'settled' as const, () => 'settled' as const),
      ])
      expect(phase).toBe('opened')
      await vi.advanceTimersByTimeAsync(maxCaptureMs)
      release.resolve(undefined)
      await expect(pending).rejects.toMatchObject({ kind: 'unavailable' })
    } finally {
      release.resolve(undefined)
      vi.useRealTimers()
    }
  })

  it('keeps exact-total raw bytes complete when a following changed path is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const content = Buffer.from('four')
    await writeFile(join(root, 'file'), content)
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const run = inventoryCommands({
      tree: `100644 blob ${head}\tfile\0` + `100644 blob ${head}\tmissing\0`,
      index: `H 100644 ${index} 0\tfile\0`,
    })

    const inventory = await captureRepositoryInventory(
      root, { run }, 'sha1', inventoryBounds({ maxTotalFileBytes: 4 }), new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory,
      { ...inventoryBounds({ maxTotalFileBytes: 4 }), maxGitOutputBytes: 64 * 1_024 },
      1,
      new AbortController().signal,
    )

    expect(inventory.capture.rawBytes).toBe(4)
    expect(inventory.entries.map(entry => entry.current)).toMatchObject([
      { kind: 'captured', evidence: { kind: 'regular' } },
      { kind: 'captured', evidence: { kind: 'missing' } },
    ])
    expect(result.baseline.kind).toBe('complete')
  })

  it('does not read a known-changed file that exceeds the remaining aggregate budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await writeFile(join(root, 'first'), 'four')
    await writeFile(join(root, 'second'), 'secret')
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const run = inventoryCommands({
      tree: `100644 blob ${head}\tfirst\0` + `100644 blob ${head}\tsecond\0`,
      index: `H 100644 ${index} 0\tfirst\0` + `H 100644 ${index} 0\tsecond\0`,
    })

    const inventory = await captureRepositoryInventory(
      root, { run }, 'sha1', inventoryBounds({ maxTotalFileBytes: 4 }), new AbortController().signal,
    )

    expect(inventory.capture.rawBytes).toBe(4)
    expect(inventory.entries[1]!.current).toEqual({ kind: 'unavailable', reason: 'hash-limit' })
  })

  it('charges both symlink target reads to the aggregate raw-byte budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const target = join(root, 'target')
    const link = join(root, 'link')
    await mkdir(target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    const targetBytes = await readlink(link, { encoding: 'buffer' })
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const run = inventoryCommands({
      tree: `120000 blob ${head}\tlink\0`,
      index: `H 120000 ${index} 0\tlink\0`,
    })

    const inventory = await captureRepositoryInventory(
      root,
      { run },
      'sha1',
      inventoryBounds({ maxFileBytes: targetBytes.byteLength + 1, maxTotalFileBytes: targetBytes.byteLength }),
      new AbortController().signal,
    )

    expect(inventory.capture.rawBytes).toBe(0)
    expect(inventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'hash-limit' })
  })

  it('captures a stable symlink and meters bytes rather than reported link size', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const target = join(root, 'target')
    const linkPath = join(root, 'link')
    await mkdir(target)
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    const targetBytes = await readlink(linkPath, { encoding: 'buffer' })
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const commands = inventoryCommands({
      tree: `120000 blob ${head}\tlink\0`,
      index: `H 120000 ${index} 0\tlink\0`,
    })

    const captured = await captureRepositoryInventory(
      root, { run: commands }, 'sha1', inventoryBounds(), new AbortController().signal,
    )
    expect(captured.entries[0]?.current).toMatchObject({
      kind: 'captured',
      evidence: { kind: 'symlink' },
      rawObjectId: gitBlobId('sha1', targetBytes),
      rawByteLength: targetBytes.byteLength,
    })

    const sizeBlindFacts = (): RepositoryInventoryFileFacts => nodeFacts({
      async lstat(path) {
        const value = await lstat(path, { bigint: true })
        return path === linkPath ? withStatSize(value, 0n) : value
      },
    })
    const fileLimited = await captureRepositoryInventory(
      root,
      { run: commands },
      'sha1',
      inventoryBounds({ maxFileBytes: 1 }),
      new AbortController().signal,
      undefined,
      sizeBlindFacts(),
    )
    expect(fileLimited.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'file-limit' })

    const totalLimited = await captureRepositoryInventory(
      root,
      { run: commands },
      'sha1',
      inventoryBounds({
        maxFileBytes: targetBytes.byteLength,
        maxTotalFileBytes: targetBytes.byteLength,
      }),
      new AbortController().signal,
      undefined,
      sizeBlindFacts(),
    )
    expect(totalLimited.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'hash-limit' })
  })

  it('rejects a parent directory replacement even when its canonical spelling is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const object = '1'.repeat(40)
    let rootStats = 0
    const facts = nodeFacts({
      async lstat(path) {
        const value = await lstat(path, { bigint: true })
        if (path !== root || ++rootStats <= 3) return value
        return changedStat(value, 'ino')
      },
    })

    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tnested/file\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      facts,
    )

    expect(inventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })
  })

  it('rejects an ancestor whose path entry or resolved target changes during one proof', async () => {
    const object = '1'.repeat(40)
    for (const corrupt of ['entry', 'target'] as const) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      const parent = join(root, 'nested')
      await mkdir(parent)
      let parentReads = 0
      const inventory = await captureRepositoryInventory(
        root,
        { run: inventoryCommands({ tree: `100644 blob ${object}\tnested/file\0`, index: '' }) },
        'sha1',
        inventoryBounds(),
        new AbortController().signal,
        undefined,
        nodeFacts({
          async lstat(path) {
            const value = await lstat(path, { bigint: true })
            if (path !== parent) return value
            parentReads += 1
            if (corrupt === 'entry' && parentReads === 2) return changedStat(value, 'ino')
            if (corrupt === 'target' && parentReads === 3) return specialFileStat(value)
            return value
          },
        }),
      )

      expect(inventory.entries[0]?.current, corrupt).toEqual({
        kind: 'unavailable', reason: 'unstable-content',
      })
    }
  })

  it('does not read through an ancestor link that leaves the canonical root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    const outside = await mkdtemp(join(tmpdir(), 'saki-inventory-outside-'))
    roots.push(root, outside)
    await writeFile(join(outside, 'file'), 'outside secret bytes')
    await symlink(outside, join(root, 'dir'), process.platform === 'win32' ? 'junction' : 'dir')
    const object = '1'.repeat(40)

    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tdir/file\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )

    expect(inventory.capture.rawBytes).toBe(0)
    expect(inventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unsupported-state' })
  })

  it('rejects regular, symlink, and missing-path evidence that changes during capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const object = '1'.repeat(40)

    const regularPath = join(root, 'regular')
    await writeFile(regularPath, 'content')
    let regularStats = 0
    const regular = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tregular\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(path) {
          const value = await lstat(path, { bigint: true })
          if (path !== regularPath || ++regularStats !== 2) return value
          return changedStat(value, 'ino')
        },
      }),
    )
    expect(regular.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })

    const target = join(root, 'target')
    const link = join(root, 'link')
    await mkdir(target)
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    let linkStats = 0
    const symlinkInventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `120000 blob ${object}\tlink\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(path) {
          const value = await lstat(path, { bigint: true })
          if (path !== link || ++linkStats !== 2) return value
          return changedStat(value, 'mtimeNs')
        },
      }),
    )
    expect(symlinkInventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })

    const appearedPath = join(root, 'appeared')
    let missingStats = 0
    const missing = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tappeared\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(path) {
          if (path !== appearedPath) return await lstat(path, { bigint: true })
          missingStats += 1
          if (missingStats === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          await writeFile(appearedPath, 'appeared')
          return await lstat(path, { bigint: true })
        },
      }),
    )
    expect(missing.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })
  })

  it('captures empty and Uint8Array-backed regular streams and rejects cumulative overshoot', async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(emptyRoot)
    await writeFile(join(emptyRoot, 'empty'), '')
    const empty = await captureRepositoryInventory(
      emptyRoot,
      { run: inventoryCommands({ tree: '', index: '', untracked: 'empty\0' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    expect(empty.entries[0]?.current).toMatchObject({
      kind: 'captured', rawByteLength: 0, rawObjectId: gitBlobId('sha1', Buffer.alloc(0)),
    })

    const bytesRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(bytesRoot)
    const bytesPath = join(bytesRoot, 'bytes')
    const bytes = Buffer.from('bytes')
    await writeFile(bytesPath, bytes)
    const byteFacts = nodeFacts({
      async open(path) {
        const handle = await open(path, 'r')
        return {
          async stat(options?: Parameters<typeof handle.stat>[0]) { return await handle.stat(options) },
          createReadStream() {
            return {
              async *[Symbol.asyncIterator]() { yield new Uint8Array(bytes) },
            }
          },
          async close() { await handle.close() },
        } as never
      },
    })
    const byteInventory = await captureRepositoryInventory(
      bytesRoot,
      { run: inventoryCommands({ tree: '', index: '', untracked: 'bytes\0' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      byteFacts,
    )
    expect(byteInventory.entries[0]?.current).toMatchObject({
      kind: 'captured', rawByteLength: bytes.byteLength, rawObjectId: gitBlobId('sha1', bytes),
    })

    const overRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(overRoot)
    const overPath = join(overRoot, 'over')
    await writeFile(overPath, 'ok')
    const overFacts = nodeFacts({
      async open(path) {
        const handle = await open(path, 'r')
        return {
          async stat(options?: Parameters<typeof handle.stat>[0]) { return await handle.stat(options) },
          createReadStream() {
            return {
              async *[Symbol.asyncIterator]() {
                yield Buffer.from('ok')
                yield Buffer.from('!')
              },
            }
          },
          async close() { await handle.close() },
        } as never
      },
    })
    const object = '1'.repeat(40)
    const over = await captureRepositoryInventory(
      overRoot,
      { run: inventoryCommands({
        tree: `100644 blob ${object}\tover\0`, index: `H 100644 ${'2'.repeat(40)} 0\tover\0`,
      }) },
      'sha1',
      inventoryBounds({ maxFileBytes: 2 }),
      new AbortController().signal,
      undefined,
      overFacts,
    )
    expect(over.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'file-limit' })
  })

  it('uses stable handle metadata and core.symlinks to classify regular-file read failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const path = join(root, 'file')
    await writeFile(path, 'four')
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const changedCommands = inventoryCommands({
      tree: `100644 blob ${head}\tfile\0`, index: `H 100644 ${index} 0\tfile\0`,
    })
    const beforeChanged = await captureRepositoryInventory(
      root,
      { run: changedCommands },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async open(value) {
          const handle = await open(value, 'r')
          return {
            async stat() {
              return changedStat(await handle.stat({ bigint: true }), 'ino')
            },
            createReadStream: handle.createReadStream.bind(handle),
            async close() { await handle.close() },
          } as never
        },
      }),
    )
    expect(beforeChanged.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })

    const fileLimited = await captureRepositoryInventory(
      root,
      { run: changedCommands },
      'sha1',
      inventoryBounds({ maxFileBytes: 2 }),
      new AbortController().signal,
    )
    expect(fileLimited.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'file-limit' })

    const linkObject = '3'.repeat(40)
    const linkCommands = inventoryCommands({
      tree: `120000 blob ${linkObject}\tfile\0`, index: `H 120000 ${linkObject} 0\tfile\0`,
    })
    const unreadableFacts = nodeFacts({ async open() { throw new Error('read failed') } })
    const symlinksEnabled = await captureRepositoryInventory(
      root,
      { run: linkCommands },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      unreadableFacts,
    )
    expect(symlinksEnabled.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'io-failure' })

    await expect(captureRepositoryInventory(
      root,
      {
        async run(cwd, args) {
          if (args.join(' ') === 'config --no-includes --null --type=bool --get-all core.symlinks') {
            return output('false\0')
          }
          return await linkCommands(cwd, args)
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      unreadableFacts,
    )).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('classifies an unrelated filesystem provider TypeError as current I/O failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const object = '1'.repeat(40)
    const path = join(root, 'file')

    const inventory = await captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tfile\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(value) {
          if (value === path) throw new TypeError('provider implementation failure at secret path')
          return await lstat(value, { bigint: true })
        },
      }),
    )

    expect(inventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'io-failure' })
  })

  it('retains invalid, unsupported, and unstable current-path evidence by safe category', async () => {
    const object = '1'.repeat(40)
    const invalidRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(invalidRoot)
    const invalidPrefix = Buffer.from(`100644 blob ${object}\t`)
    const invalidRun = inventoryCommands({ tree: '', index: '' })
    const invalid = await captureRepositoryInventory(
      invalidRoot,
      {
        async run(cwd, args) {
          if (args[0] === 'ls-tree') {
            return {
              stdout: Buffer.concat([invalidPrefix, Buffer.from([0xff, 0])]),
              stderr: Buffer.alloc(0),
            }
          }
          return await invalidRun(cwd, args)
        },
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    expect(invalid.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'invalid-utf8' })

    const unsupportedRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(unsupportedRoot)
    const unsupported = await captureRepositoryInventory(
      unsupportedRoot,
      { run: inventoryCommands({ tree: `100644 blob ${object}\t../secret\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    expect(unsupported.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'unsupported-state' })

    const directoryRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(directoryRoot)
    await mkdir(join(directoryRoot, 'directory'))
    const directory = await captureRepositoryInventory(
      directoryRoot,
      { run: inventoryCommands({ tree: '', index: '', untracked: 'directory\0' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    expect(directory.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'unsupported-state' })

    const missingRoot = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(missingRoot)
    const missingPath = join(missingRoot, 'missing')
    let missingReads = 0
    const missing = await captureRepositoryInventory(
      missingRoot,
      { run: inventoryCommands({ tree: `100644 blob ${object}\tmissing\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      undefined,
      nodeFacts({
        async lstat(path) {
          if (path !== missingPath) return await lstat(path, { bigint: true })
          missingReads += 1
          if (missingReads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
          throw new TypeError('provider failed while confirming absence')
        },
      }),
    )
    expect(missing.entries[0]?.current).toEqual({ kind: 'unavailable', reason: 'io-failure' })
  })

  it('classifies incomplete and overbound submodule evidence at the inventory boundary', async () => {
    const object = '1'.repeat(40)
    const cases: readonly [
      string,
      Parameters<typeof captureRepositoryInventory>[5],
      Partial<ReturnType<typeof inventoryBoundsBase>>,
      'malformed' | 'unavailable' | 'unsupported-state',
    ][] = [
      ['missing reader', undefined, {}, 'unsupported-state'],
      ['missing first object', async () => undefined, {}, 'unsupported-state'],
      ['missing confirmation object', (() => {
        let reads = 0
        return async () => ++reads === 1 ? { objectId: '2'.repeat(40), semanticGitOutputBytes: 1 } : undefined
      })(), {}, 'unsupported-state'],
      ['malformed confirmation object', (() => {
        let reads = 0
        return async () => ({
          objectId: (++reads === 1 ? '2' : 'z').repeat(40), semanticGitOutputBytes: 1,
        })
      })(), {}, 'malformed'],
      ['nested Git output limit', async () => ({
        objectId: '2'.repeat(40), semanticGitOutputBytes: 10_000,
      }), { maxGitOutputBytes: 1_024 }, 'unavailable'],
      ['nested Git output overflow', async () => ({
        objectId: '2'.repeat(40), semanticGitOutputBytes: Number.MAX_SAFE_INTEGER,
      }), {}, 'unavailable'],
    ]

    for (const [name, reader, bounds, expected] of cases) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      await mkdir(join(root, 'module'))
      const pending = captureRepositoryInventory(
        root,
        { run: inventoryCommands({
          tree: `160000 commit ${object}\tmodule\0`,
          index: `H 160000 ${object} 0\tmodule\0`,
        }) },
        'sha1',
        inventoryBounds(bounds),
        new AbortController().signal,
        reader,
      )
      if (expected === 'unsupported-state') {
        await expect(pending, name).resolves.toMatchObject({
          entries: [{ current: { kind: 'unavailable', reason: expected } }],
        })
      } else {
        await expect(pending, name).rejects.toMatchObject({ kind: expected })
      }
    }

    const sha256Root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(sha256Root)
    await mkdir(join(sha256Root, 'module'))
    const sha256Object = '3'.repeat(64)
    const sha256 = await captureRepositoryInventory(
      sha256Root,
      { run: inventoryCommands({
        tree: `160000 commit ${sha256Object}\tmodule\0`,
        index: `H 160000 ${sha256Object} 0\tmodule\0`,
      }) },
      'sha256',
      inventoryBounds(),
      new AbortController().signal,
      async () => ({ objectId: sha256Object, semanticGitOutputBytes: 1 }),
    )
    expect(sha256.entries[0]?.current).toMatchObject({
      kind: 'captured', evidence: { kind: 'submodule', objectId: sha256Object },
    })
  })

  it('retains missing evidence when the deleted path parent is also absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const object = '1'.repeat(40)
    const inventory = await captureRepositoryInventory(
      root,
      {
        run: inventoryCommands({
          tree: `100644 blob ${object}\tnested/file\0`,
          index: `H 100644 ${object} 0\tnested/file\0`,
        }),
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
    )
    const result = buildInheritedChangeBaseline(
      inventory,
      { ...inventoryBounds(), maxGitOutputBytes: 64 * 1_024 },
      1,
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      inheritedChangeEntryCount: 1,
      baseline: { kind: 'complete', entries: [{ statusKind: 'tracked', worktree: { kind: 'missing' } }] },
    })
  })

  it('rejects a submodule object that changes between its two reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await mkdir(join(root, 'module'))
    const object = '1'.repeat(40)
    let reads = 0
    const inventory = await captureRepositoryInventory(
      root,
      {
        run: inventoryCommands({
          tree: `160000 commit ${object}\tmodule\0`,
          index: `H 160000 ${object} 0\tmodule\0`,
        }),
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      async () => ({ objectId: (++reads === 1 ? '3' : '4').repeat(40), semanticGitOutputBytes: 1 }),
    )

    expect(reads).toBe(2)
    expect(inventory.entries[0]!.current).toEqual({ kind: 'unavailable', reason: 'unstable-content' })
  })

  it('charges retained nested Git evidence to the independent baseline output bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    await mkdir(join(root, 'module'))
    const head = '1'.repeat(40)
    const index = '2'.repeat(40)
    const current = '3'.repeat(40)
    const inventory = await captureRepositoryInventory(
      root,
      {
        run: inventoryCommands({
          tree: `160000 commit ${head}\tmodule\0`,
          index: `H 160000 ${index} 0\tmodule\0`,
        }),
      },
      'sha1',
      inventoryBounds(),
      new AbortController().signal,
      async () => ({ objectId: current, semanticGitOutputBytes: 7 }),
    )
    const expectedGitBytes = inventory.allowlistedGitEvidenceBytes + 14
    const complete = buildInheritedChangeBaseline(
      inventory,
      { ...inventoryBounds(), maxGitOutputBytes: expectedGitBytes },
      1,
      new AbortController().signal,
    )
    const unavailable = buildInheritedChangeBaseline(
      inventory,
      { ...inventoryBounds(), maxGitOutputBytes: expectedGitBytes - 1 },
      1,
      new AbortController().signal,
    )

    expect(complete.baseline).toMatchObject({
      kind: 'complete',
      observed: { gitOutputBytes: expectedGitBytes },
      entries: [{ worktree: { kind: 'submodule', objectId: current } }],
    })
    expect(unavailable.baseline).toMatchObject({
      kind: 'unavailable', reason: 'git-output-limit', observed: { gitOutputBytes: expectedGitBytes },
    })
  })

  it('keeps malformed nested object evidence out of known and unknown change fallbacks', async () => {
    for (const index of ['1'.repeat(40), '2'.repeat(40)]) {
      const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
      roots.push(root)
      await mkdir(join(root, 'module'))
      await expect(captureRepositoryInventory(
        root,
        {
          run: inventoryCommands({
            tree: `160000 commit ${'1'.repeat(40)}\tmodule\0`,
            index: `H 160000 ${index} 0\tmodule\0`,
          }),
        },
        'sha1',
        inventoryBounds(),
        new AbortController().signal,
        async () => ({ objectId: 'z'.repeat(40), semanticGitOutputBytes: 1 }),
      )).rejects.toMatchObject({ kind: 'malformed' })
    }
  })

  it('settles an active regular-file stream when the caller aborts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'saki-inventory-'))
    roots.push(root)
    const path = join(root, 'file')
    await writeFile(path, 'four')
    const started = Promise.withResolvers<undefined>()
    const controller = new AbortController()
    const reason = new Error('cancel current content read')
    const facts = nodeFacts({
      async open(value) {
        const handle = await open(value, 'r')
        return {
          async stat(options?: Parameters<typeof handle.stat>[0]) { return await handle.stat(options) },
          createReadStream(options: { readonly signal: AbortSignal }) {
            const stream = new Readable({ read() { started.resolve(undefined) } })
            options.signal.addEventListener('abort', () => {
              stream.destroy(options.signal.reason instanceof Error ? options.signal.reason : new Error('read aborted'))
            }, { once: true })
            return stream
          },
          async close() { await handle.close() },
        } as never
      },
    })
    const pending = captureRepositoryInventory(
      root,
      { run: inventoryCommands({ tree: `100644 blob ${'1'.repeat(40)}\tfile\0`, index: '' }) },
      'sha1',
      inventoryBounds(),
      controller.signal,
      undefined,
      facts,
    )
    await started.promise
    controller.abort(reason)

    await expect(pending).rejects.toBe(reason)
  })
})

function inventoryBounds(overrides: Partial<ReturnType<typeof inventoryBoundsBase>> = {}) {
  return { ...inventoryBoundsBase(), ...overrides }
}

function inventoryBoundsBase() {
  return {
    maxEntries: 10,
    maxPathBytes: 1_024,
    maxGitOutputBytes: 64 * 1_024,
    maxFileBytes: 1_024,
    maxTotalFileBytes: 4_096,
    maxCaptureMs: 10_000,
  }
}

function inventoryCommands(values: {
  readonly tree: string
  readonly index: string
  readonly untracked?: string
  readonly attributes?: string
  readonly configNames?: string
}) {
  return async (_cwd: string, args: readonly string[]) => {
    const command = args.join(' ')
    if (command === 'ls-tree -r --full-tree -z HEAD') return output(values.tree)
    if (command === 'ls-files -t --stage --full-name -z') return output(values.index)
    if (command === 'ls-files --others --exclude-standard --full-name -z') return output(values.untracked ?? '')
    if (command === 'config --no-includes --null --name-only --list') return output(values.configNames ?? '')
    if (command === 'config --no-includes --null --type=bool --get-all core.fileMode') return output('false\0')
    if (command === 'config --no-includes --null --type=bool --get-all core.symlinks') return output('true\0')
    if (command === 'config --no-includes --null --type=bool --get-all core.autocrlf') return output('false\0')
    if (command === 'check-attr --all -z --stdin') return output(values.attributes ?? '')
    throw new Error(`unexpected command: ${command}`)
  }
}

function nodeFacts(overrides: Partial<RepositoryInventoryFileFacts>): RepositoryInventoryFileFacts {
  return {
    async lstat(path) { return await lstat(path, { bigint: true }) },
    async readlink(path) { return await readlink(path, { encoding: 'buffer' }) },
    async realpath(path) { return await realpath(path) },
    async open(path) { return await open(path, 'r') },
    ...overrides,
  }
}

function changedStat<T extends Awaited<ReturnType<RepositoryInventoryFileFacts['lstat']>>>(
  value: T,
  field: 'ino' | 'mtimeNs',
): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      return property === field ? target[field] + 1n : Reflect.get(target, property, receiver)
    },
  })
}

function withOwnerExecute<T extends Awaited<ReturnType<RepositoryInventoryFileFacts['lstat']>>>(value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      return property === 'mode' ? target.mode | 0o100n : Reflect.get(target, property, receiver)
    },
  })
}

function withStatSize<T extends Awaited<ReturnType<RepositoryInventoryFileFacts['lstat']>>>(
  value: T,
  size: bigint,
): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      return property === 'size' ? size : Reflect.get(target, property, receiver)
    },
  })
}

function specialFileStat<T extends Awaited<ReturnType<RepositoryInventoryFileFacts['lstat']>>>(value: T): T {
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === 'isFile' || property === 'isDirectory' || property === 'isSymbolicLink') return () => false
      return Reflect.get(target, property, receiver)
    },
  })
}

function output(stdout: string): { stdout: Buffer; stderr: Buffer } {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) }
}

function gitBlobId(format: 'sha1' | 'sha256', bytes: Uint8Array): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}
