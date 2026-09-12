import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { writeNodeZipExecutable } from '../scripts/node-zip-executable.ts'

const executableEntry = 'node-v24.17.0-win-x64/node.exe'
const executable = strToU8('node executable fixture')

describe('desktop Node.js ZIP selection', () => {
  let root: string
  let destination: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-node-zip-'))
    const extraction = join(root, 'extraction')
    await mkdir(extraction)
    destination = join(extraction, 'node.exe')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes only the selected binary and leaves traversal and symbolic-link entries unmaterialized', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'preserved')
    const archive = zipSync({
      [executableEntry]: executable,
      '../outside.txt': strToU8('replaced'),
      [outside.replaceAll('\\', '/')]: strToU8('replaced'),
      redirect: [strToU8('..'), { os: 3, attrs: 0o120777 << 16 }],
      'redirect/outside.txt': strToU8('replaced'),
      'node-v24.17.0-win-x64/npm.cmd': strToU8('unused'),
    })

    await writeNodeZipExecutable(archive, executableEntry, destination)

    expect(await readFile(destination)).toEqual(Buffer.from(executable))
    expect(await readdir(join(root, 'extraction'))).toEqual(['node.exe'])
    expect(await readFile(outside, 'utf8')).toBe('preserved')
  })

  it('rejects an archive without the exact requested executable before creating output', async () => {
    const archive = zipSync({ 'another-release/node.exe': executable })

    await expect(writeNodeZipExecutable(archive, executableEntry, destination)).rejects.toThrow('is absent')
    expect(await readdir(join(root, 'extraction'))).toEqual([])
  })

  it('rejects malformed ZIP bytes before creating output', async () => {
    await expect(writeNodeZipExecutable(strToU8('not a ZIP'), executableEntry, destination)).rejects.toThrow()
    expect(await readdir(join(root, 'extraction'))).toEqual([])
  })

  it('refuses to overwrite an existing output', async () => {
    await writeFile(destination, 'preserved')

    await expect(writeNodeZipExecutable(zipSync({ [executableEntry]: executable }), executableEntry, destination))
      .rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(destination, 'utf8')).toBe('preserved')
  })
})
