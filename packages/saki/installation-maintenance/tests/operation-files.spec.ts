import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SakiInstallationId, SakiStorageGenerationId } from '@breakfastdapaidang/saki-control-plane'
import {
  clearActiveOperation,
  createOperationJournal,
  createSakiMaintenanceOperationId,
  durableFileTemporaryPath,
  operationJournalReference,
  PENDING_OPERATION_LEAF,
  publishActiveOperation,
  readActiveOperation,
  readPendingOperation,
  readSettledOperation,
  reconcileOperationMetadata,
  renderActiveOperationSelector,
  renderOperationJournal,
  renderPendingOperationIntent,
  SETTLED_OPERATION_JOURNAL_LEAF,
  SETTLED_OPERATION_LEAF,
  settleClearedOperationMetadata,
} from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-operation-files-'))
  roots.push(value)
  return value
}

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId

describe('selected Saki operation files', () => {
  it('clears a pending intent when a crash happened before journal publication', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    const journalPath = join(directory, ...operationJournalReference(
      journal.operationId,
      journalBytes,
    ).leaf.split('/'))
    await writeFile(
      join(directory, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(
        journal.operationId,
        operationJournalReference(journal.operationId, journalBytes),
      ),
    )
    await mkdir(dirname(journalPath), { recursive: true })
    await writeFile(durableFileTemporaryPath(journalPath), journalBytes)

    await reconcileOperationMetadata(directory, signal)

    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readFile(durableFileTemporaryPath(journalPath)))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readPendingOperation(directory, signal)).resolves.toMatchObject({
      state: { status: 'cleared' },
    })
  })

  it('discards only deterministic temps for fixed operation metadata targets', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const targets = [
      join(directory, PENDING_OPERATION_LEAF),
      join(directory, 'active-operation.json'),
      join(directory, ...SETTLED_OPERATION_LEAF.split('/')),
      join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    ]
    for (const target of targets) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(durableFileTemporaryPath(target), 'interrupted publication')
    }

    await reconcileOperationMetadata(directory, signal)

    for (const target of targets) {
      await expect(readFile(durableFileTemporaryPath(target)))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('settles the exact pending journal when a crash happened before active publication', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    const reference = operationJournalReference(journal.operationId, journalBytes)
    const journalPath = join(directory, ...reference.leaf.split('/'))
    await mkdir(join(directory, 'operations'), { recursive: true })
    await writeFile(
      join(directory, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(journal.operationId, reference),
    )
    await writeFile(journalPath, journalBytes)

    await reconcileOperationMetadata(directory, signal)

    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readPendingOperation(directory, signal)).resolves.toMatchObject({
      state: { status: 'cleared' },
    })
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
      journalPath: join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    })
    await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('clears a matching pending intent when active publication already committed', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    const reference = operationJournalReference(journal.operationId, journalBytes)
    await mkdir(join(directory, 'operations'), { recursive: true })
    await writeFile(
      join(directory, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(journal.operationId, reference),
    )
    await writeFile(join(directory, ...reference.leaf.split('/')), journalBytes)
    await writeFile(
      join(directory, 'active-operation.json'),
      renderActiveOperationSelector(journal.operationId, reference),
    )

    await reconcileOperationMetadata(directory, signal)

    await expect(readActiveOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
    await expect(readPendingOperation(directory, signal)).resolves.toMatchObject({
      state: { status: 'cleared' },
    })
  })

  it('publishes an immutable journal before its exact selector and clears only that pair', async () => {
    const directory = await root()
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const signal = new AbortController().signal

    const selected = await publishActiveOperation(directory, journal, signal)
    expect((await readActiveOperation(directory, signal))?.journal).toEqual(journal)
    await expect(readPendingOperation(directory, signal)).resolves.toMatchObject({
      state: { status: 'cleared' },
    })
    expect(await readFile(selected.journalPath, 'utf8')).toContain(journal.operationId)

    await clearActiveOperation(directory, selected)
    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readFile(selected.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects another publication while an active selector exists', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const first = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, first, signal)
    const second = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })

    await expect(publishActiveOperation(directory, second, signal))
      .rejects.toMatchObject({ code: 'operation-active' })
  })

  it('replaces the cleared pending slot when publishing after an exact clear', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const first = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const firstSelected = await publishActiveOperation(directory, first, signal)
    await clearActiveOperation(directory, firstSelected)
    const second = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })

    await expect(publishActiveOperation(directory, second, signal)).resolves.toMatchObject({
      journal: { operationId: second.operationId },
    })
  })

  it('accepts only the selected dynamic journal while an operation is active', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const selectedJournal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, selectedJournal, signal)
    await expect(reconcileOperationMetadata(directory, signal)).resolves.toBeUndefined()

    const orphan = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const orphanBytes = renderOperationJournal(orphan)
    const orphanPath = join(directory, ...operationJournalReference(
      orphan.operationId,
      orphanBytes,
    ).leaf.split('/'))
    await writeFile(orphanPath, orphanBytes)

    await expect(reconcileOperationMetadata(directory, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readActiveOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: selected.journal.operationId },
    })
  })

  it('rejects a fixed settled journal without its exact settled selector', async () => {
    const directory = await root()
    const fixedJournalPath = join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/'))
    await mkdir(dirname(fixedJournalPath), { recursive: true })
    await writeFile(fixedJournalPath, 'orphan fixed journal')

    await expect(reconcileOperationMetadata(directory, new AbortController().signal))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires recovery when fixed pending metadata disagrees with the active operation', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const activeJournal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, activeJournal, signal)
    const otherJournal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const otherBytes = renderOperationJournal(otherJournal)
    await writeFile(
      join(directory, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(
        otherJournal.operationId,
        operationJournalReference(otherJournal.operationId, otherBytes),
      ),
    )

    await expect(reconcileOperationMetadata(directory, signal))
      .rejects.toMatchObject({ code: 'recovery-required' })
    await expect(readActiveOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: activeJournal.operationId },
    })
    await expect(readPendingOperation(directory, signal)).resolves.toMatchObject({
      state: { operationId: otherJournal.operationId },
    })
  })

  it('refuses a Windows junction or POSIX symlink as the operations directory', async () => {
    const directory = await root()
    const external = await root()
    const valuable = join(external, 'valuable.txt')
    await writeFile(valuable, 'outside')
    const operations = join(directory, 'operations')
    await symlink(external, operations, process.platform === 'win32' ? 'junction' : 'dir')
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const signal = new AbortController().signal

    try {
      await expect(publishActiveOperation(
        directory,
        journal,
        signal,
      )).rejects.toMatchObject({ code: 'recovery-required' })

      await expect(readFile(valuable, 'utf8')).resolves.toBe('outside')
      await expect(readdir(external)).resolves.toEqual(['valuable.txt'])
      await expect(readPendingOperation(directory, signal)).resolves.toBeUndefined()
    } finally {
      await unlink(operations)
    }

    await reconcileOperationMetadata(directory, signal)
    await expect(readPendingOperation(directory, signal)).resolves.toBeUndefined()
  })

  it('durably clears Windows metadata through the fixed settled pair', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    const moves: Array<{ readonly replace: boolean }> = []

    await clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async (from, to, replace) => {
        moves.push({ replace })
        await rename(from, to)
      },
    })

    expect(moves).toEqual([{ replace: true }, { replace: true }])
    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
    await expect(readFile(selected.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('durably clears POSIX metadata through same-parent settled moves', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    const syncs: string[] = []

    await clearActiveOperation(directory, selected, {
      platform: 'posix',
      syncDirectory: async (path) => { syncs.push(path) },
    })

    expect(syncs).toEqual([
      directory,
      join(directory, 'operations'),
    ])
    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
      journalPath: join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    })
    await expect(readFile(selected.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not accept exact readback when the POSIX selector-parent sync fails', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    const failure = new Error('selector parent sync failed')

    await expect(clearActiveOperation(directory, selected, {
      platform: 'posix',
      syncDirectory: async () => { throw failure },
    })).rejects.toMatchObject({ cause: failure })

    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readFile(selected.journalPath)).resolves.toEqual(selected.journalEvidence.bytes)
    await settleClearedOperationMetadata(directory, signal, {
      platform: 'posix',
      syncDirectory: async () => undefined,
    })
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journalPath: join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    })
  })

  it('does not accept exact readback when the POSIX journal-parent sync fails', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    const failure = new Error('journal parent sync failed')
    let syncCount = 0

    await expect(clearActiveOperation(directory, selected, {
      platform: 'posix',
      syncDirectory: async () => {
        syncCount += 1
        if (syncCount === 2) throw failure
      },
    })).rejects.toMatchObject({ cause: failure })

    expect(syncCount).toBe(2)
    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
      journalPath: join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    })
  })

  it('finishes the journal move after a crash between Windows settled-pair commits', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    const settledSelector = join(directory, ...SETTLED_OPERATION_LEAF.split('/'))
    await mkdir(join(directory, 'operations'), { recursive: true })
    await rename(join(directory, 'active-operation.json'), settledSelector)

    await settleClearedOperationMetadata(directory, signal, {
      platform: 'win32',
      movePathWin32: async (from, to) => {
        await rename(from, to)
      },
    })

    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    const settled = await readSettledOperation(directory, signal)
    expect(settled?.journal.operationId).toBe(journal.operationId)
    expect(settled?.journalPath).not.toBe(selected.journalPath)
    await expect(readFile(selected.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finishes the journal move after a crash between POSIX settled-pair commits', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    await rename(
      join(directory, 'active-operation.json'),
      join(directory, ...SETTLED_OPERATION_LEAF.split('/')),
    )
    const syncs: string[] = []

    await settleClearedOperationMetadata(directory, signal, {
      platform: 'posix',
      syncDirectory: async (path) => { syncs.push(path) },
    })

    expect(syncs).toEqual([join(directory, 'operations')])
    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
      journalPath: join(directory, ...SETTLED_OPERATION_JOURNAL_LEAF.split('/')),
    })
    await expect(readFile(selected.journalPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not accept a settled journal move whose POSIX sync fails', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, journal, signal)
    await rename(
      join(directory, 'active-operation.json'),
      join(directory, ...SETTLED_OPERATION_LEAF.split('/')),
    )
    const failure = new Error('settled journal parent sync failed')

    await expect(settleClearedOperationMetadata(directory, signal, {
      platform: 'posix',
      syncDirectory: async () => { throw failure },
    })).rejects.toMatchObject({ cause: failure })
  })

  it('propagates a pre-commit settled journal move failure', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, journal, signal)
    await rename(
      join(directory, 'active-operation.json'),
      join(directory, ...SETTLED_OPERATION_LEAF.split('/')),
    )

    await expect(settleClearedOperationMetadata(directory, signal, {
      platform: 'win32',
      movePathWin32: async () => { throw 'move failed' },
    })).rejects.toMatchObject({
      message: 'moving settled Saki operation journal failed',
      cause: 'move failed',
    })
  })

  it('requires exact fixed-path readback after a reported successful settled move', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, journal, signal)
    await rename(
      join(directory, 'active-operation.json'),
      join(directory, ...SETTLED_OPERATION_LEAF.split('/')),
    )

    await expect(settleClearedOperationMetadata(directory, signal, {
      platform: 'win32',
      movePathWin32: async () => undefined,
    })).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('returns when the expected active operation was already cleared', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    await clearActiveOperation(directory, selected)

    await expect(clearActiveOperation(directory, selected)).resolves.toBeUndefined()
  })

  it('refuses to clear an active operation using another selected operation', async () => {
    const directory = await root()
    const otherDirectory = await root()
    const signal = new AbortController().signal
    const first = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const other = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    await publishActiveOperation(directory, first, signal)
    const otherSelected = await publishActiveOperation(otherDirectory, other, signal)

    await expect(clearActiveOperation(directory, otherSelected))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('propagates a pre-commit selector move failure', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)

    await expect(clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async () => { throw 'selector move failed' },
    })).rejects.toMatchObject({
      message: 'moving active Saki operation selector failed',
      cause: 'selector move failed',
    })
  })

  it('requires exact selector readback after a reported successful move', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)

    await expect(clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async () => undefined,
    })).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('propagates a pre-commit journal move failure after the selector commits', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    let moves = 0

    await expect(clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async (from, to) => {
        moves += 1
        if (moves === 2) throw 'journal move failed'
        await rename(from, to)
      },
    })).rejects.toMatchObject({
      message: 'moving active Saki operation journal failed',
      cause: 'journal move failed',
    })
  })

  it('requires exact journal readback after a reported successful move', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)
    let moves = 0

    await expect(clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async (from, to) => {
        moves += 1
        if (moves === 1) await rename(from, to)
      },
    })).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('accepts an exact selector or journal move that reports failure after committing', async () => {
    const directory = await root()
    const signal = new AbortController().signal
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: createSakiMaintenanceOperationId(),
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const selected = await publishActiveOperation(directory, journal, signal)

    await expect(clearActiveOperation(directory, selected, {
      platform: 'win32',
      movePathWin32: async (from, to) => {
        await rename(from, to)
        throw new Error('fault after committed move')
      },
    })).resolves.toBeUndefined()

    await expect(readActiveOperation(directory, signal)).resolves.toBeUndefined()
    await expect(readSettledOperation(directory, signal)).resolves.toMatchObject({
      journal: { operationId: journal.operationId },
    })
  })
})
