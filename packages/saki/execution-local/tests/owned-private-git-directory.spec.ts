import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTransportGitDirectory } from '../src/git-push.ts'
import { createOwnedPrivateGitDirectory } from '../src/owned-private-git-directory.ts'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}))

const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
const CONFIG = Buffer.from('[core]\n\tbare = true\n')
const SEAL = { config: CONFIG, objectAlternates: { kind: 'absent' as const } }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(async (path) => {
    await native.rm(path, { recursive: true, force: true, maxRetries: 10 })
  }))
})

async function draft() {
  const owner = await createOwnedPrivateGitDirectory('transport')
  roots.push(owner.path)
  await fs.mkdir(join(owner.path, 'objects', 'info'), { recursive: true })
  await fs.writeFile(join(owner.path, 'config'), CONFIG)
  return owner
}

function ioError(code = 'EACCES'): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

// Intercept only the OS operation where a competing filesystem actor wins the race.
function beforeStat(path: string, occurrence: number, action: () => Promise<void>): void {
  let seen = 0
  vi.spyOn(fs, 'lstat').mockImplementation(async (candidate, options) => {
    if (candidate === path && ++seen === occurrence) await action()
    return await native.lstat(candidate, options)
  })
}

describe('owned private Git directory filesystem lifecycle', () => {
  it('rejects a second seal and use after disposal, while disposal remains idempotent', async () => {
    const owner = await draft()
    const sealed = await owner.seal(SEAL)
    await expect(owner.seal(SEAL)).rejects.toThrow('integrity changed')
    await sealed[Symbol.asyncDispose]()
    await sealed[Symbol.asyncDispose]()
    await expect(sealed.assertIntegrity()).rejects.toThrow('integrity changed')
    await expect(fs.lstat(owner.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const unsealed = await draft()
    await unsealed[Symbol.asyncDispose]()
    await expect(unsealed.seal(SEAL)).rejects.toThrow('integrity changed')
  })

  it('cleans its root if permission setup fails', async () => {
    const failure = ioError()
    let created: string | undefined
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
      created = await native.mkdtemp(prefix)
      roots.push(created)
      return created
    })
    vi.spyOn(fs, 'chmod').mockRejectedValueOnce(failure)
    await expect(createOwnedPrivateGitDirectory('repository-view')).rejects.toBe(failure)
    expect(created).toBeDefined()
    await expect(fs.lstat(created!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a temporary root replaced before its first identity capture', async () => {
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
      const path = await native.mkdtemp(prefix)
      roots.push(path)
      await native.rmdir(path)
      await native.writeFile(path, 'foreign')
      return path
    })
    await expect(createOwnedPrivateGitDirectory('transport')).rejects.toThrow('integrity changed')
    expect(await fs.readFile(roots[0]!, 'utf8')).toBe('foreign')
  })

  it('rolls back transport construction without hiding its filesystem error', async () => {
    let created: string | undefined
    vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix) => {
      created = await native.mkdtemp(prefix)
      roots.push(created)
      return created
    })
    const failure = ioError('ENOSPC')
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(failure)
    await expect(createTransportGitDirectory()).rejects.toBe(failure)
    await expect(fs.lstat(created!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['config', 'objects', 'objects/info'])('rejects a wrong node kind at %s during sealing', async (relative) => {
    const owner = await draft()
    const path = join(owner.path, relative)
    await fs.rm(path, { recursive: true })
    if (relative === 'config') await fs.mkdir(path)
    else await fs.writeFile(path, 'not a directory')
    await expect(owner.seal(SEAL)).rejects.toThrow('integrity changed')
  })

  it.each(['seal', 'inspect'] as const)('rejects a config removed during %s', async (phase) => {
    const owner = await draft()
    const sealed = phase === 'inspect' ? await owner.seal(SEAL) : undefined
    beforeStat(join(owner.path, 'config'), 2, async () => {
      await fs.unlink(join(owner.path, 'config'))
    })
    await expect(sealed === undefined ? owner.seal(SEAL) : sealed.assertIntegrity()).rejects.toThrow()
  })

  it.each(['seal', 'inspect'] as const)('rejects config replacement during %s', async (phase) => {
    const owner = await draft()
    const sealed = phase === 'inspect' ? await owner.seal(SEAL) : undefined
    beforeStat(join(owner.path, 'config'), 2, async () => {
      await fs.rename(join(owner.path, 'config'), join(owner.path, 'original'))
      await fs.writeFile(join(owner.path, 'config'), CONFIG)
    })
    await expect(sealed === undefined ? owner.seal(SEAL) : sealed.assertIntegrity())
      .rejects.toThrow('integrity changed')
  })

  it.each(['seal', 'inspect'] as const)('rejects config bytes that change size during %s', async (phase) => {
    const owner = await draft()
    const sealed = phase === 'inspect' ? await owner.seal(SEAL) : undefined
    beforeStat(join(owner.path, 'config'), 2, async () => {
      await fs.appendFile(join(owner.path, 'config'), '\n')
    })
    await expect(sealed === undefined ? owner.seal(SEAL) : sealed.assertIntegrity())
      .rejects.toThrow('integrity changed')
  })

  it.each(['seal', 'inspect'] as const)('rejects config modification time changes during %s', async (phase) => {
    const owner = await draft()
    const sealed = phase === 'inspect' ? await owner.seal(SEAL) : undefined
    beforeStat(join(owner.path, 'config'), 2, async () => {
      await fs.utimes(join(owner.path, 'config'), 1, 1)
    })
    await expect(sealed === undefined ? owner.seal(SEAL) : sealed.assertIntegrity())
      .rejects.toThrow('integrity changed')
  })

  it('contains missing and unreadable sealed config files', async () => {
    const owner = await draft()
    const sealed = await owner.seal(SEAL)
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(ioError())
    await expect(sealed.assertIntegrity()).rejects.toThrow('integrity changed')
    await fs.unlink(join(owner.path, 'config'))
    await expect(sealed.assertIntegrity()).rejects.toThrow('integrity changed')
  })

  it('contains access errors while checking forbidden control files', async () => {
    const owner = await draft()
    const sealed = await owner.seal(SEAL)
    beforeStat(join(owner.path, 'config.worktree'), 1, async () => { throw ioError() })
    await expect(sealed.assertIntegrity()).rejects.toThrow('integrity changed')
  })

  it('contains a missing owned root and accepts cleanup after external removal', async () => {
    const owner = await draft()
    const sealed = await owner.seal(SEAL)
    await fs.rm(owner.path, { recursive: true })
    await expect(sealed.assertIntegrity()).rejects.toThrow('integrity changed')
    await sealed[Symbol.asyncDispose]()
  })

  it.each(['missing', 'denied'] as const)('handles a root %s while listing entries', async (outcome) => {
    const owner = await draft()
    const failure = ioError()
    vi.spyOn(fs, 'readdir').mockImplementationOnce(async () => {
      if (outcome === 'missing') await native.rm(owner.path, { recursive: true })
      throw failure
    })
    const removal = owner[Symbol.asyncDispose]()
    if (outcome === 'missing') await removal
    else await expect(removal).rejects.toBe(failure)
  })

  it.each([2, 3, 4])('preserves a foreign root replacing the owner at cleanup check %s', async (occurrence) => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    if (occurrence > 2) await fs.writeFile(join(owner.path, 'entry'), 'owned')
    const retained = `${owner.path}-retained`
    roots.push(retained)
    beforeStat(owner.path, occurrence, async () => {
      await fs.rename(owner.path, retained)
      await fs.mkdir(owner.path)
      await fs.writeFile(join(owner.path, 'foreign'), 'keep')
    })
    await expect(owner[Symbol.asyncDispose]()).rejects.toThrow('ownership changed')
    expect(await fs.readFile(join(owner.path, 'foreign'), 'utf8')).toBe('keep')
  })

  it('accepts a root removed immediately before its final removal', async () => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    beforeStat(owner.path, 3, async () => { await fs.rmdir(owner.path) })
    await owner[Symbol.asyncDispose]()
  })

  it.each(['missing', 'denied'] as const)('handles a root %s during rmdir', async (outcome) => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    const failure = ioError()
    vi.spyOn(fs, 'rmdir').mockImplementationOnce(async (path) => {
      if (outcome === 'missing') await native.rmdir(path)
      throw failure
    })
    const removal = owner[Symbol.asyncDispose]()
    if (outcome === 'missing') await removal
    else await expect(removal).rejects.toBe(failure)
  })

  it.each([1, 2])('accepts an entry removed before identity read %s', async (occurrence) => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    const path = join(owner.path, 'entry')
    await fs.writeFile(path, 'owned')
    beforeStat(path, occurrence, async () => { await fs.unlink(path) })
    await owner[Symbol.asyncDispose]()
  })

  it.each([1, 2])('reports entry access failure at identity read %s', async (occurrence) => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    const path = join(owner.path, 'entry')
    await fs.writeFile(path, 'owned')
    const failure = ioError()
    beforeStat(path, occurrence, async () => { throw failure })
    await expect(owner[Symbol.asyncDispose]()).rejects.toBe(failure)
    expect(await fs.readFile(path, 'utf8')).toBe('owned')
  })

  it('preserves an entry replaced between its ownership checks', async () => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    const path = join(owner.path, 'entry')
    await fs.writeFile(path, 'owned')
    beforeStat(path, 2, async () => {
      await fs.rename(path, join(owner.path, 'original'))
      await fs.mkdir(path)
      await fs.writeFile(join(path, 'foreign'), 'keep')
    })
    await expect(owner[Symbol.asyncDispose]()).rejects.toThrow('entry ownership changed')
    expect(await fs.readFile(join(path, 'foreign'), 'utf8')).toBe('keep')
  })

  it.each(['missing', 'denied', 'stat-denied'] as const)('handles an entry %s during unlink', async (outcome) => {
    const owner = await createOwnedPrivateGitDirectory('transport')
    roots.push(owner.path)
    const path = join(owner.path, 'entry')
    await fs.writeFile(path, 'owned')
    const failure = ioError()
    vi.spyOn(fs, 'unlink').mockImplementationOnce(async (candidate) => {
      if (outcome === 'missing') await native.unlink(candidate)
      if (outcome === 'stat-denied') beforeStat(path, 1, async () => { throw failure })
      throw failure
    })
    const removal = owner[Symbol.asyncDispose]()
    if (outcome === 'missing') await removal
    else await expect(removal).rejects.toBe(failure)
  })

  it('reports root access failure without attempting cleanup', async () => {
    const owner = await draft()
    const failure = ioError()
    beforeStat(owner.path, 1, async () => { throw failure })
    await expect(owner[Symbol.asyncDispose]()).rejects.toBe(failure)
    expect(await fs.readFile(join(owner.path, 'config'))).toEqual(CONFIG)
  })
})
