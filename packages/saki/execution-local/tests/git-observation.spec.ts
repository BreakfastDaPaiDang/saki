import { describe, expect, it } from 'vitest'
import {
  GitInventoryLimitError,
  parseCheckAttrConversion,
  parseLsFilesStage,
  parseLsTree,
  parseNulPaths,
  parseWorktreeList,
} from '../src/git-observation.ts'

const INVENTORY_BOUNDS = { maxEntries: 100, maxPathBytes: 1_000 }
const OBJECT = '0123456789012345678901234567890123456789'

describe('Git worktree observation', () => {
  it('parses the closed HEAD, index-stage, and untracked inventories without decoding paths', () => {
    const invalidPath = Buffer.from([0x64, 0x69, 0x72, 0x2f, 0xff])
    const object = '0123456789012345678901234567890123456789'
    const tree = Buffer.concat([
      Buffer.from(`100644 blob ${object}\t`), invalidPath, Buffer.from('\0'),
      Buffer.from(`160000 commit ${object}\tmodule\0`),
    ])
    const index = Buffer.concat([
      Buffer.from(`H 100755 ${object} 0\t`), invalidPath, Buffer.from('\0'),
      Buffer.from(`M 100644 ${object} 1\tconflict\0`),
      Buffer.from(`M 100644 ${object} 2\tconflict\0`),
      Buffer.from(`S 040000 ${object} 0\tsparse-directory/\0`),
    ])
    const untracked = Buffer.concat([Buffer.from('new\0'), invalidPath, Buffer.from('\0')])

    expect(parseLsTree(tree, INVENTORY_BOUNDS)).toMatchObject([
      { mode: '100644', objectId: object },
      { mode: '160000', objectId: object },
    ])
    expect(Buffer.from(parseLsTree(tree, INVENTORY_BOUNDS)[0]!.path)).toEqual(invalidPath)
    expect(parseLsFilesStage(index, INVENTORY_BOUNDS).map(entry => ({ mode: entry.mode, stage: entry.stage, tag: entry.tag }))).toEqual([
      { mode: '100755', stage: 0, tag: 'H' },
      { mode: '100644', stage: 1, tag: 'M' },
      { mode: '100644', stage: 2, tag: 'M' },
      { mode: '040000', stage: 0, tag: 'S' },
    ])
    expect(parseNulPaths(untracked, INVENTORY_BOUNDS).map(path => Buffer.from(path))).toEqual([Buffer.from('new'), invalidPath])
  })

  it('rejects malformed inventory records, duplicate stage slots, and partial framing', () => {
    const object = OBJECT
    for (const value of [
      `100644 tree ${object}\tfile\0`,
      `040000 tree ${object}\tdirectory\0`,
      `100664 blob ${object}\tfile\0`,
      `100644 blob ${object}\t\0`,
      `100644 blob ${object}\tfile`,
    ]) expect(() => parseLsTree(Buffer.from(value), INVENTORY_BOUNDS)).toThrow()
    expect(() => parseLsFilesStage(Buffer.from(
      `H 100644 ${object} 0\tfile\0` + `H 100644 ${object} 0\tfile\0`,
    ), INVENTORY_BOUNDS)).toThrow(/duplicate/u)
    for (const value of [
      `M 100644 ${object} 0\tfile\0`,
      `H 100644 ${object} 1\tfile\0`,
    ]) expect(() => parseLsFilesStage(Buffer.from(value), INVENTORY_BOUNDS)).toThrow(/tag/u)
    for (const conflictStage of [1, 2, 3]) {
      expect(() => parseLsFilesStage(Buffer.from(
        `H 100644 ${object} 0\tfile\0M 100644 ${object} ${conflictStage}\tfile\0`,
      ), INVENTORY_BOUNDS)).toThrow(/mixes stage zero/u)
    }
    expect(() => parseNulPaths(Buffer.from('file'), INVENTORY_BOUNDS)).toThrow(/NUL/u)
  })

  it('accepts every Git conflict-stage subset from the combined tagged index inventory', () => {
    const object = '0123456789012345678901234567890123456789'
    for (const stages of [[1], [2], [3], [1, 2], [1, 3], [2, 3], [1, 2, 3]]) {
      const bytes = Buffer.from(stages.map(stage => `M 100644 ${object} ${stage}\tfile\0`).join(''))
      expect(parseLsFilesStage(bytes, INVENTORY_BOUNDS).map(entry => entry.stage)).toEqual(stages)
    }
  })

  it('enforces distinct membership limits while raw records are parsed', () => {
    const object = '0123456789012345678901234567890123456789'
    const twoPaths = Buffer.from(`100644 blob ${object}\ta\0` + `100644 blob ${object}\tb\0`)
    const twoIndexPaths = Buffer.from(`H 100644 ${object} 0\ta\0` + `H 100644 ${object} 0\tb\0`)

    expect(() => parseLsTree(twoPaths, { maxEntries: 1, maxPathBytes: 2 })).toThrow(GitInventoryLimitError)
    expect(() => parseLsFilesStage(twoIndexPaths, { maxEntries: 1, maxPathBytes: 2 })).toThrow(GitInventoryLimitError)
    expect(() => parseNulPaths(Buffer.from('a\0b\0'), { maxEntries: 1, maxPathBytes: 2 }))
      .toThrow(GitInventoryLimitError)
    expect(() => parseNulPaths(Buffer.from('aa\0b\0'), { maxEntries: 2, maxPathBytes: 2 }))
      .toThrow(GitInventoryLimitError)
  })

  it('reduces only present check-attr --all triplets by their exact input path', () => {
    const paths = [Buffer.from('a'), Buffer.from('b')]
    const records = Buffer.from([
      'a\0text\0set\0',
      'a\0_unrelated\0secret value\0',
      'a\0' + '1unrelated\0secret value\0',
      'a\0.unrelated\0secret value\0',
      'b\0filter\0unspecified\0',
      'b\0ident\0unset\0',
    ].join(''))
    expect(parseCheckAttrConversion(records, paths)).toEqual([
      { path: paths[0], executableFilter: false, lineEnding: true, unmodeled: false },
      { path: paths[1], executableFilter: true, lineEnding: false, unmodeled: true },
    ])

    expect(() => parseCheckAttrConversion(Buffer.from('a\0text\0set\0a\0text\0unset\0'), paths)).toThrow(/duplicate/u)
    expect(() => parseCheckAttrConversion(Buffer.from('outside\0text\0set\0'), paths)).toThrow(/path inventory/u)
    expect(() => parseCheckAttrConversion(Buffer.from('a\0text\0'), paths)).toThrow(/triplets/u)
  })

  it('parses NUL-framed linked, detached, locked, prunable, bare, and extension facts', () => {
    const bytes = Buffer.from([
      'worktree C:/repo\0HEAD 0123456789012345678901234567890123456789\0branch refs/heads/main\0extension value\0\0',
      'worktree C:/repo-linked\0HEAD 1123456789012345678901234567890123456789\0detached\0locked provider text\0\0',
      'worktree C:/gone\0HEAD 2123456789012345678901234567890123456789\0branch refs/heads/gone\0prunable provider text\0\0',
      'worktree C:/bare.git\0bare\0\0',
    ].join(''))

    expect(parseWorktreeList(bytes)).toEqual([
      {
        path: 'C:/repo',
        head: '0123456789012345678901234567890123456789',
        branch: 'refs/heads/main',
        detached: false,
        locked: false,
        prunable: false,
        bare: false,
      },
      {
        path: 'C:/repo-linked',
        head: '1123456789012345678901234567890123456789',
        detached: true,
        locked: true,
        prunable: false,
        bare: false,
      },
      {
        path: 'C:/gone',
        head: '2123456789012345678901234567890123456789',
        branch: 'refs/heads/gone',
        detached: false,
        locked: false,
        prunable: true,
        bare: false,
      },
      {
        path: 'C:/bare.git',
        detached: false,
        locked: false,
        prunable: false,
        bare: true,
      },
    ])
  })

  it('discards non-UTF-8 lock, prune, and extension values after recognizing their ASCII names', () => {
    const object = '0123456789012345678901234567890123456789'
    const bytes = Buffer.concat([
      Buffer.from(`worktree C:/repo\0HEAD ${object}\0branch refs/heads/main\0locked `),
      Buffer.from([0xff, 0]),
      Buffer.from('prunable '),
      Buffer.from([0xfe, 0]),
      Buffer.from('future-extension '),
      Buffer.from([0xfd, 0, 0]),
    ])

    const records = parseWorktreeList(bytes)
    expect(records).toEqual([{
      path: 'C:/repo',
      head: object,
      branch: 'refs/heads/main',
      detached: false,
      locked: true,
      prunable: true,
      bare: false,
    }])
    expect(JSON.stringify(records)).not.toMatch(/255|254|253/u)
  })

  it('rejects extra empty worktree records', () => {
    const object = '0123456789012345678901234567890123456789'
    expect(() => parseWorktreeList(Buffer.from(
      `worktree C:/repo\0HEAD ${object}\0branch refs/heads/main\0\0\0`,
    ))).toThrow(/empty record/u)
  })

  it('rejects every malformed tree and path membership class', () => {
    for (const value of [
      '\0',
      'record\0',
      '100644 blob\tfile\0',
      `100644 blob ${'f'.repeat(39)}\tfile\0`,
      `100644 blob ${'0'.repeat(40)}\tfile\0`,
      `160000 blob ${OBJECT}\tfile\0`,
    ]) expect(() => parseLsTree(Buffer.from(value), INVENTORY_BOUNDS)).toThrow()
    expect(() => parseLsTree(Buffer.from(
      `100644 blob ${OBJECT}\tfile\0` + `100644 blob ${OBJECT}\tfile\0`,
    ), INVENTORY_BOUNDS)).toThrow(/duplicate/u)
    expect(() => parseLsTree(Buffer.from(`100644 blob ${OBJECT}\tlong\0`), {
      maxEntries: 1,
      maxPathBytes: 3,
    })).toThrow(GitInventoryLimitError)

    expect(() => parseNulPaths(Buffer.from('\0'), INVENTORY_BOUNDS)).toThrow(/empty/u)
    expect(() => parseNulPaths(Buffer.from('same\0same\0'), INVENTORY_BOUNDS)).toThrow(/duplicate/u)
    expect(() => parseNulPaths(Buffer.from('long\0'), { maxEntries: 1, maxPathBytes: 3 }))
      .toThrow(GitInventoryLimitError)
  })

  it('keeps duplicate membership malformed after the distinct-path limit is full', () => {
    const duplicateTree = Buffer.from(
      `100644 blob ${OBJECT}\ta\0` + `100644 blob ${OBJECT}\ta\0`,
    )
    const duplicateIndexSlot = Buffer.from(
      [1, 2, 3, 1].map(stage => `M 100644 ${OBJECT} ${stage}\ta\0`).join(''),
    )

    expect(() => parseLsTree(duplicateTree, { maxEntries: 1, maxPathBytes: 1 }))
      .toThrow(/duplicate/u)
    expect(() => parseLsFilesStage(duplicateIndexSlot, { maxEntries: 1, maxPathBytes: 1 }))
      .toThrow(/duplicate/u)
    expect(() => parseNulPaths(Buffer.from('a\0a\0'), { maxEntries: 1, maxPathBytes: 1 }))
      .toThrow(/duplicate/u)
  })

  it('rejects every malformed index record and slot relationship', () => {
    for (const value of [
      '\0',
      'record\0',
      `H 100644 ${OBJECT}\tfile\0`,
      `X 100644 ${OBJECT} 0\tfile\0`,
      `H 100664 ${OBJECT} 0\tfile\0`,
      `H 100644 ${'f'.repeat(39)} 0\tfile\0`,
      `H 100644 ${OBJECT} 4\tfile\0`,
      `H 100644 ${'0'.repeat(40)} 0\tfile\0`,
      `M 040000 ${OBJECT} 1\tfile\0`,
    ]) expect(() => parseLsFilesStage(Buffer.from(value), INVENTORY_BOUNDS)).toThrow()
    expect(() => parseLsFilesStage(Buffer.from(
      `M 100644 ${OBJECT} 1\tfile\0H 100644 ${OBJECT} 0\tfile\0`,
    ), INVENTORY_BOUNDS)).toThrow(/mixes stage zero/u)
    expect(() => parseLsFilesStage(Buffer.from(`H 100644 ${OBJECT} 0\tlong\0`), {
      maxEntries: 1,
      maxPathBytes: 3,
    })).toThrow(GitInventoryLimitError)
    const sixSlots = ['a', 'b'].flatMap(path => [1, 2, 3].map(stage =>
      `M 100644 ${OBJECT} ${stage}\t${path}\0`)).join('')
    expect(() => parseLsFilesStage(Buffer.from(
      `${sixSlots}M 100644 ${OBJECT} 1\tc\0`,
    ), { maxEntries: 2, maxPathBytes: 100 })).toThrow(GitInventoryLimitError)
  })

  it('rejects invalid parser bounds before retaining output', () => {
    for (const bounds of [
      { maxEntries: 1.5, maxPathBytes: 1 },
      { maxEntries: 0, maxPathBytes: 1 },
      { maxEntries: Math.floor(Number.MAX_SAFE_INTEGER / 3) + 1, maxPathBytes: 1 },
      { maxEntries: 1, maxPathBytes: 1.5 },
      { maxEntries: 1, maxPathBytes: 0 },
    ]) {
      expect(() => parseNulPaths(Buffer.alloc(0), bounds)).toThrow(GitInventoryLimitError)
    }
  })

  it('validates attribute input identity, names, and all conversion classes', () => {
    expect(() => parseCheckAttrConversion(Buffer.alloc(0), [Buffer.alloc(0)]))
      .toThrow(/input path inventory/u)
    expect(() => parseCheckAttrConversion(Buffer.alloc(0), [Buffer.from('a'), Buffer.from('a')]))
      .toThrow(/input path inventory/u)
    expect(() => parseCheckAttrConversion(Buffer.from('a\0-bad\0set\0'), [Buffer.from('a')]))
      .toThrow(/attribute name/u)
    expect(() => parseCheckAttrConversion(
      Buffer.concat([Buffer.from('a\0'), Buffer.from([0xff]), Buffer.from('\0set\0')]),
      [Buffer.from('a')],
    )).toThrow(/UTF-8/u)

    const attributes = ['working-tree-encoding', 'eol', 'crlf', 'unrelated']
      .map(attribute => `a\0${attribute}\0value\0`).join('')
    expect(parseCheckAttrConversion(Buffer.from(attributes), [Buffer.from('a')]))
      .toEqual([{
        path: Buffer.from('a'), executableFilter: false, unmodeled: true, lineEnding: true,
      }])
  })

  it('rejects malformed worktree framing and duplicate identity facts', () => {
    const validPrefix = `worktree C:/repo\0HEAD ${OBJECT}\0`
    for (const [value, message] of [
      ['', /no records/u],
      ['worktree C:/repo\0', /ends inside/u],
      ['worktree C:/one\0worktree C:/two\0', /terminator/u],
      ['worktree \0', /empty path/u],
      [`HEAD ${OBJECT}\0`, /before a worktree/u],
      ['worktree C:/repo\0HEAD short\0\0', /invalid or duplicate HEAD/u],
      [`${validPrefix}HEAD ${OBJECT}\0detached\0\0`, /invalid or duplicate HEAD/u],
      [`${validPrefix}branch refs/heads/main\0branch refs/heads/other\0\0`, /branch state/u],
      [`${validPrefix}detached\0branch refs/heads/main\0\0`, /branch state/u],
      [`${validPrefix}branch \0\0`, /branch state/u],
      [`${validPrefix}detached\0detached\0\0`, /duplicate branch state/u],
      [`${validPrefix}branch refs/heads/main\0detached\0\0`, /duplicate branch state/u],
      ['worktree C:/repo\0bare\0bare\0\0', /duplicate bare/u],
      [`${validPrefix}branch refs/heads/main\0locked\0locked reason\0\0`, /duplicate locked/u],
      [`${validPrefix}branch refs/heads/main\0prunable\0prunable reason\0\0`, /duplicate prunable/u],
      [`${validPrefix}branch refs/heads/main\0 value\0\0`, /malformed extension/u],
      [`${validPrefix}branch refs/heads/main\0` + '1bad\0\0', /malformed extension/u],
      [`${validPrefix}branch refs/heads/main\0bad_name\0\0`, /malformed extension/u],
    ] as const) expect(() => parseWorktreeList(Buffer.from(value))).toThrow(message)
  })

  it('rejects incomplete bare and non-bare worktree identities', () => {
    for (const value of [
      `worktree C:/bare\0bare\0HEAD ${OBJECT}\0\0`,
      'worktree C:/bare\0bare\0branch refs/heads/main\0\0',
      'worktree C:/bare\0bare\0detached\0\0',
      'worktree C:/repo\0\0',
      `worktree C:/repo\0HEAD ${OBJECT}\0\0`,
    ]) expect(() => parseWorktreeList(Buffer.from(value))).toThrow()

    expect(parseWorktreeList(Buffer.from(
      `worktree C:/repo\0HEAD ${OBJECT}\0branch refs/heads/main\0Extension.2-name value\0\0`,
    ))).toHaveLength(1)
  })

  it('contains invalid UTF-8 in decoded worktree identity fields', () => {
    expect(() => parseWorktreeList(Buffer.concat([
      Buffer.from('worktree '), Buffer.from([0xff]), Buffer.from('\0\0'),
    ]))).toThrow(/UTF-8/u)
  })
})
