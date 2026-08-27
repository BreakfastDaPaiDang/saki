import { describe, expect, it } from 'vitest'
import { parseStatusPorcelainV2 } from '../src/status-porcelain-v2.ts'

const OBJECT = '0123456789012345678901234567890123456789'

describe('Git status porcelain v2 observation', () => {
  it('parses attached branch, ordinary change, and untracked raw path facts', () => {
    const invalidUtf8Path = Buffer.from([0x6e, 0x65, 0x77, 0x2f, 0xff])
    const bytes = Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\0`),
      Buffer.from('# branch.head main\0'),
      Buffer.from('# branch.upstream origin/main\0'),
      Buffer.from('# branch.ab +2 -3\0'),
      Buffer.from(`1 M. N... 100644 100755 100755 ${OBJECT} ${OBJECT} tracked file\0`),
      Buffer.from('? '), invalidUtf8Path, Buffer.from('\0'),
    ])

    const parsed = parseStatusPorcelainV2(bytes)

    expect(parsed.branch).toEqual({
      oid: { kind: 'commit', objectId: OBJECT },
      head: { kind: 'attached', name: 'main' },
      upstream: { name: 'origin/main', ahead: 2, behind: 3 },
    })
    expect(parsed.objectIdWidth).toBe(40)
    expect(parsed.entries[0]).toEqual({
      kind: 'ordinary',
      path: Buffer.from('tracked file'),
      indexStatus: 'modified',
      worktreeStatus: 'unchanged',
      submodule: { kind: 'not-submodule' },
      head: { mode: '100644', objectId: OBJECT },
      index: { mode: '100755', objectId: OBJECT },
      worktreeMode: '100755',
    })
    expect(parsed.entries[1]).toEqual({
      kind: 'untracked',
      path: invalidUtf8Path,
      indexStatus: 'absent',
      worktreeStatus: 'untracked',
      submodule: { kind: 'not-submodule' },
    })
  })

  it('parses unmerged stage slots, conflict meaning, and submodule dirtiness', () => {
    const ours = `1${OBJECT.slice(1)}`
    const theirs = `2${OBJECT.slice(1)}`
    const parsed = parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head (detached)\0',
      `u UU SCMU 160000 160000 160000 160000 ${OBJECT} ${ours} ${theirs} conflict path\0`,
    ].join('')))

    expect(parsed.branch).toEqual({
      oid: { kind: 'commit', objectId: OBJECT },
      head: { kind: 'detached' },
    })
    expect(parsed.entries).toEqual([{
      kind: 'unmerged',
      path: Buffer.from('conflict path'),
      indexStatus: 'unmerged',
      worktreeStatus: 'present',
      conflict: 'both-modified',
      submodule: {
        kind: 'submodule',
        commitChanged: true,
        trackedChanges: true,
        untrackedChanges: true,
      },
      base: { mode: '160000', objectId: OBJECT },
      ours: { mode: '160000', objectId: ours },
      theirs: { mode: '160000', objectId: theirs },
      worktreeMode: '160000',
    }])
  })

  it('reports an absent unmerged worktree separately from its conflict type', () => {
    const zero = '0'.repeat(40)
    const parsed = parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `u DD N... 100644 000000 000000 000000 ${OBJECT} ${zero} ${zero} deleted-conflict\0`,
    ].join('')))

    expect(parsed.entries[0]).toMatchObject({
      kind: 'unmerged',
      indexStatus: 'unmerged',
      worktreeStatus: 'absent',
      conflict: 'both-deleted',
    })
  })

  it('keeps an unborn attached branch without inventing an object width', () => {
    const parsed = parseStatusPorcelainV2(Buffer.from(
      '# branch.oid (initial)\0# branch.head topic\0? first\0',
    ))

    expect(parsed.branch).toEqual({
      oid: { kind: 'initial' },
      head: { kind: 'attached', name: 'topic' },
    })
    expect(parsed.objectIdWidth).toBeUndefined()
    expect(parsed.entries).toHaveLength(1)
  })

  it('rejects a detached unborn branch identity', () => {
    expect(() => parseStatusPorcelainV2(Buffer.from(
      '# branch.oid (initial)\0# branch.head (detached)\0',
    ))).toThrow(/branch identity/u)
  })

  it('rejects duplicate raw path identities across record kinds', () => {
    const bytes = Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `1 .M N... 100644 100644 100644 ${OBJECT} ${OBJECT} same\0`,
      '? same\0',
    ].join(''))

    expect(() => parseStatusPorcelainV2(bytes)).toThrow(/duplicate path/u)
  })

  it('rejects rename, ignored, and unknown record classes', () => {
    const prefix = `# branch.oid ${OBJECT}\0# branch.head main\0`
    for (const record of [
      `2 R. N... 100644 100644 100644 ${OBJECT} ${OBJECT} R100 target\0source\0`,
      '! ignored\0',
      'x future\0',
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(prefix + record))).toThrow(/unsupported record/u)
    }
  })

  it('rejects an ordinary record that reports no index or worktree change', () => {
    const bytes = Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `1 .. N... 100644 100644 100644 ${OBJECT} ${OBJECT} unchanged\0`,
    ].join(''))

    expect(() => parseStatusPorcelainV2(bytes)).toThrow(/ordinary status/u)
  })

  it('rejects object ids whose presence disagrees with their object slot mode', () => {
    const zero = '0'.repeat(40)
    const prefix = `# branch.oid ${OBJECT}\0# branch.head main\0`
    for (const record of [
      `1 A. N... 000000 100644 100644 ${OBJECT} ${OBJECT} added\0`,
      `1 M. N... 100644 100644 100644 ${zero} ${OBJECT} modified\0`,
      `1 D. N... 100644 000000 000000 ${OBJECT} ${OBJECT} deleted\0`,
      `1 M. N... 100644 100644 100644 ${OBJECT} ${zero} modified\0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(prefix + record))).toThrow(/object slot/u)
    }
  })

  it('rejects branch tracking counts without a present attached upstream commit', () => {
    for (const value of [
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.ab +1 -0\0`,
      '# branch.oid (initial)\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -0\0',
      `# branch.oid ${OBJECT}\0# branch.head (detached)\0# branch.upstream origin/main\0# branch.ab +1 -0\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +9007199254740992 -0\0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(value))).toThrow(/branch tracking/u)
    }
    expect(() => parseStatusPorcelainV2(Buffer.from(
      `# branch.oid ${OBJECT}\0# branch.head (detached)\0# branch.upstream origin/main\0`,
    ))).toThrow(/branch tracking state/u)
  })

  it('keeps an attached upstream when ahead and behind were not emitted', () => {
    const parsed = parseStatusPorcelainV2(Buffer.from(
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0`,
    ))

    expect(parsed.branch.upstream).toEqual({ name: 'origin/main' })
  })

  it('rejects every duplicate supported header', () => {
    for (const value of [
      `# branch.oid ${OBJECT}\0# branch.oid ${OBJECT}\0# branch.head main\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.head topic\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.upstream origin/topic\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0# branch.ab +0 -0\0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(value))).toThrow(/duplicate .* header/u)
    }
  })

  it('rejects mixed SHA-1 and SHA-256 object widths', () => {
    const sha256 = '1'.repeat(64)
    const zero256 = '0'.repeat(64)
    expect(() => parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `1 A. N... 000000 100644 100644 ${zero256} ${sha256} added\0`,
    ].join('')))).toThrow(/mixes object id widths/u)
  })

  it('rejects partial NUL framing, empty records, and headers after paths', () => {
    const prefix = `# branch.oid ${OBJECT}\0# branch.head main\0`
    expect(() => parseStatusPorcelainV2(Buffer.from(prefix.slice(0, -1)))).toThrow(/NUL terminated/u)
    expect(() => parseStatusPorcelainV2(Buffer.from(`${prefix}\0`))).toThrow(/empty record/u)
    expect(() => parseStatusPorcelainV2(Buffer.from(`${prefix}? new\0# branch.upstream origin/main\0`)))
      .toThrow(/header follows path/u)
  })

  it('applies fatal UTF-8 decoding to branch references but never to paths', () => {
    const invalidRef = Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\0# branch.head `),
      Buffer.from([0xff]),
      Buffer.from('\0'),
    ])
    expect(() => parseStatusPorcelainV2(invalidRef)).toThrow(/UTF-8/u)

    const invalidPath = Buffer.from([0x66, 0x69, 0x6c, 0x65, 0xff])
    const valid = Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\0# branch.head main\0? `),
      invalidPath,
      Buffer.from('\0'),
    ])
    expect(parseStatusPorcelainV2(valid).entries[0]?.path).toEqual(invalidPath)

    const tracked = Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\0# branch.head main\0`),
      Buffer.from(`1 .M N... 100644 100644 100644 ${OBJECT} ${OBJECT} `),
      invalidPath,
      Buffer.from('\0'),
    ])
    expect(parseStatusPorcelainV2(tracked).entries[0]?.path).toEqual(invalidPath)
  })

  it('ignores structurally valid forward-compatible headers', () => {
    const parsed = parseStatusPorcelainV2(Buffer.from(
      `# branch.oid ${OBJECT}\0# extension.example value with spaces\0# extension.example repeated\0# branch.head main\0`,
    ))
    expect(parsed.branch).toEqual({
      oid: { kind: 'commit', objectId: OBJECT },
      head: { kind: 'attached', name: 'main' },
    })
  })

  it('rejects structurally malformed unknown headers and missing required branch identity headers', () => {
    for (const value of [
      `# branch.oid ${OBJECT}\0# branch.head main\0# missing-value\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0#  value\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# bad\tname value\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# extension value\r\n\0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(value))).toThrow(/header/u)
    }
    expect(() => parseStatusPorcelainV2(Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\0# branch.head main\0# extension `),
      Buffer.from([0xff]),
      Buffer.from('\0'),
    ]))).toThrow(/UTF-8/u)
    expect(() => parseStatusPorcelainV2(Buffer.from(`# branch.oid ${OBJECT}\0`)))
      .toThrow(/missing required branch headers/u)
    expect(() => parseStatusPorcelainV2(Buffer.from('# branch.head main\0')))
      .toThrow(/missing required branch headers/u)
  })

  it('projects every no-renames ordinary index and worktree status explicitly', () => {
    const zero = '0'.repeat(40)
    const parsed = parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `1 M. N... 100644 100644 100644 ${OBJECT} ${OBJECT} index-modified\0`,
      `1 T. N... 100644 120000 120000 ${OBJECT} ${OBJECT} index-type\0`,
      `1 A. N... 000000 100644 100644 ${zero} ${OBJECT} index-added\0`,
      `1 D. N... 100644 000000 000000 ${OBJECT} ${zero} index-deleted\0`,
      `1 .M N... 100644 100644 100644 ${OBJECT} ${OBJECT} worktree-modified\0`,
      `1 .T N... 100644 100644 120000 ${OBJECT} ${OBJECT} worktree-type\0`,
      `1 .A N... 000000 000000 100644 ${zero} ${zero} intent-to-add\0`,
      `1 .D N... 100644 100644 000000 ${OBJECT} ${OBJECT} worktree-deleted\0`,
    ].join('')))

    expect(parsed.entries.map(entry => [entry.indexStatus, entry.worktreeStatus])).toEqual([
      ['modified', 'unchanged'],
      ['type-changed', 'unchanged'],
      ['added', 'unchanged'],
      ['deleted', 'unchanged'],
      ['unchanged', 'modified'],
      ['unchanged', 'type-changed'],
      ['unchanged', 'added'],
      ['unchanged', 'deleted'],
    ])
  })

  it('rejects malformed tracked and untracked record fields', () => {
    const prefix = `# branch.oid ${OBJECT}\0# branch.head main\0`
    for (const record of [
      `1 M N... 100644 100644 100644 ${OBJECT} ${OBJECT} bad-xy\0`,
      `1 R. N... 100644 100644 100644 ${OBJECT} ${OBJECT} rename-code\0`,
      `1 .M X... 100644 100644 100644 ${OBJECT} ${OBJECT} bad-submodule\0`,
      `1 .M N... 100664 100644 100644 ${OBJECT} ${OBJECT} bad-mode\0`,
      `1 .M N... 100644 100644 100644 ${OBJECT.slice(1)} ${OBJECT} short-object\0`,
      `u XX N... 100644 100644 100644 100644 ${OBJECT} ${OBJECT} ${OBJECT} bad-conflict\0`,
      `u UU N... 100644 100644 100644 100644 ${OBJECT} ${OBJECT} path-only\0`,
      '? \0',
      `1 .M N... 100644 100644 100644 ${OBJECT} ${OBJECT} \0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(prefix + record))).toThrow()
    }
  })

  it('rejects malformed branch identity and tracking header values', () => {
    for (const value of [
      `# branch.oid ${'0'.repeat(40)}\0# branch.head main\0`,
      `# branch.oid ${'A'.repeat(40)}\0# branch.head main\0`,
      `# branch.oid ${OBJECT.slice(1)}\0# branch.head main\0`,
      '# branch.oid initial\0# branch.head main\0',
      `# branch.oid ${OBJECT}\0# branch.head \0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream \0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +01 -0\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -01\0`,
      `# branch.oid ${OBJECT}\0# branch.head main\0# branch.upstream origin/main\0# branch.ab 0 0\0`,
    ]) {
      expect(() => parseStatusPorcelainV2(Buffer.from(value))).toThrow()
    }
  })

  it('accepts one consistent SHA-256 object width', () => {
    const sha256 = '1'.repeat(64)
    const parsed = parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${sha256}\0`,
      '# branch.head main\0',
      `1 .M N... 100644 100644 100644 ${sha256} ${sha256} file\0`,
    ].join('')))

    expect(parsed.objectIdWidth).toBe(64)
  })

  it('maps every unmerged XY conflict class', () => {
    const zero = '0'.repeat(40)
    const parsed = parseStatusPorcelainV2(Buffer.from([
      `# branch.oid ${OBJECT}\0`,
      '# branch.head main\0',
      `u AU N... 000000 100644 000000 100644 ${zero} ${OBJECT} ${zero} au\0`,
      `u UD N... 100644 100644 000000 100644 ${OBJECT} ${OBJECT} ${zero} ud\0`,
      `u UA N... 000000 000000 100644 100644 ${zero} ${zero} ${OBJECT} ua\0`,
      `u DU N... 100644 000000 100644 100644 ${OBJECT} ${zero} ${OBJECT} du\0`,
      `u AA N... 000000 100644 100644 100644 ${zero} ${OBJECT} ${OBJECT} aa\0`,
    ].join('')))

    expect(parsed.entries.map(entry => entry.kind === 'unmerged' ? entry.conflict : undefined)).toEqual([
      'added-by-us',
      'deleted-by-them',
      'added-by-them',
      'deleted-by-us',
      'both-added',
    ])
  })

  it('rejects non-ASCII bytes in tracked fixed fields without decoding the path', () => {
    const bytes = Buffer.concat([
      Buffer.from(`# branch.oid ${OBJECT}\u0000# branch.head main\u00001 `),
      Buffer.from([0xff]),
      Buffer.from(` N... 100644 100644 100644 ${OBJECT} ${OBJECT} path\0`),
    ])

    expect(() => parseStatusPorcelainV2(bytes)).toThrow(/not ASCII/u)
  })
})
