import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  ACTIVE_OPERATION_LEAF,
  activeOperationSelectorSchema,
  createOperationJournal,
  createSakiMaintenanceOperationId,
  createSakiRecoveryBackupId,
  freshOperationJournalSchema,
  operationJournalLeaf,
  operationJournalReference,
  operationJournalSchema,
  readActiveOperation,
  renderActiveOperationSelector,
  renderOperationJournal,
  sakiMaintenanceOperationIdSchema,
  sakiRecoveryBackupIdSchema,
} from '../src/journal.ts'
import type {
  SakiMaintenanceOperationId,
  SakiRecoveryBackupId,
} from '../src/journal.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OPERATION_ID = 'operation-00000000-0000-4000-8000-000000000002' as SakiMaintenanceOperationId
const OTHER_OPERATION_ID = 'operation-00000000-0000-4000-8000-000000000102' as SakiMaintenanceOperationId
const BACKUP_ID = 'backup-00000000-0000-4000-8000-000000000003' as SakiRecoveryBackupId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000004' as SakiStorageGenerationId
const SOURCE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000005' as SakiStorageGenerationId
const SOURCE_BUILD_ID = 'saki-build-journal-source' as SakiBuildId
const UPGRADE_SOURCE = {
  sourceStateVersion: 3,
  sourceStorageGenerationId: SOURCE_GENERATION_ID,
  sourceBuildId: SOURCE_BUILD_ID,
} as const
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-journal-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function writeActive(
  installationRoot: string,
  operationId: SakiMaintenanceOperationId,
  journalBytes: Buffer,
): Promise<void> {
  const journalPath = join(installationRoot, ...operationJournalLeaf(operationId).split('/'))
  await mkdir(dirname(journalPath), { recursive: true })
  await writeFile(journalPath, journalBytes)
  await writeFile(
    join(installationRoot, ACTIVE_OPERATION_LEAF),
    renderActiveOperationSelector(operationId, operationJournalReference(operationId, journalBytes)),
  )
}

describe('Saki immutable operation journals', () => {
  it('owns strict unique brands for operation and Recovery Backup identities', () => {
    const operationId = createSakiMaintenanceOperationId()
    const otherOperationId = createSakiMaintenanceOperationId()
    const backupId = createSakiRecoveryBackupId()
    expect(operationId).not.toBe(otherOperationId)
    expect(sakiMaintenanceOperationIdSchema.safeParse(operationId).success).toBe(true)
    expect(sakiRecoveryBackupIdSchema.safeParse(backupId).success).toBe(true)
  })

  it('derives strict destinations for fresh, backup, and upgrade operations', () => {
    const fresh = createOperationJournal({
      kind: 'fresh',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    expect(fresh).toEqual({
      formatVersion: 1,
      kind: 'fresh',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
      candidate: {
        partialLeaf: `generations/${GENERATION_ID}.partial`,
        finalLeaf: `generations/${GENERATION_ID}`,
      },
    })

    const backup = createOperationJournal({
      kind: 'backup',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      backupId: BACKUP_ID,
    })
    if (fresh.kind !== 'fresh' || backup.kind !== 'backup') {
      throw new Error('operation journal constructor returned the wrong discriminator')
    }
    expect(backup).toMatchObject({
      kind: 'backup',
      backup: {
        partialLeaf: `backups/${BACKUP_ID}.partial`,
        finalLeaf: `backups/${BACKUP_ID}`,
      },
    })
    expect(operationJournalSchema.safeParse({
      ...backup,
      backup: { ...backup.backup, partialLeaf: '../backup.partial' },
    }).success).toBe(false)
    expect(operationJournalSchema.safeParse({
      ...backup,
      backup: {
        ...backup.backup,
        finalLeaf: 'backups/backup-00000000-0000-4000-8000-000000000099',
      },
    }).success).toBe(false)

    const upgrade = createOperationJournal({
      kind: 'upgrade',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      ...UPGRADE_SOURCE,
      backupId: BACKUP_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    if (upgrade.kind !== 'upgrade') {
      throw new Error('operation journal constructor returned the wrong discriminator')
    }
    expect(upgrade).toMatchObject({
      kind: 'upgrade',
      ...UPGRADE_SOURCE,
      backup: backup.backup,
      candidate: fresh.candidate,
    })
    expect(operationJournalSchema.parse(JSON.parse(renderOperationJournal(upgrade).toString('utf8'))))
      .toEqual(upgrade)
    expect(operationJournalSchema.safeParse({ ...upgrade, servingGenerationId: GENERATION_ID }).success)
      .toBe(false)
    expect(operationJournalSchema.safeParse({
      ...upgrade,
      sourceStateVersion: undefined,
      sourceStorageGenerationId: undefined,
      sourceBuildId: undefined,
    }).success).toBe(false)
    expect(operationJournalSchema.safeParse({
      ...upgrade,
      candidateStorageGenerationId: SOURCE_GENERATION_ID,
      candidate: {
        partialLeaf: `generations/${SOURCE_GENERATION_ID}.partial`,
        finalLeaf: `generations/${SOURCE_GENERATION_ID}`,
      },
    }).success).toBe(false)
  })

  it('reads only the exact active-operation reference', async () => {
    const installationRoot = await root()
    const journal = createOperationJournal({
      kind: 'upgrade',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      ...UPGRADE_SOURCE,
      backupId: BACKUP_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    await writeActive(installationRoot, OPERATION_ID, journalBytes)

    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).resolves.toMatchObject({
      selector: { operationId: OPERATION_ID },
      journal,
      journalEvidence: {
        byteLength: journalBytes.byteLength,
      },
      journalPath: join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/')),
    })
  })

  it('rejects traversal and identity-disagreeing derived leaves', () => {
    const journal = createOperationJournal({
      kind: 'fresh',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      candidateStorageGenerationId: GENERATION_ID,
    })
    if (journal.kind !== 'fresh') {
      throw new Error('operation journal constructor returned the wrong discriminator')
    }
    expect(freshOperationJournalSchema.safeParse({
      ...journal,
      candidate: { ...journal.candidate, partialLeaf: '../candidate' },
    }).success).toBe(false)
    expect(freshOperationJournalSchema.safeParse({
      ...journal,
      candidate: {
        ...journal.candidate,
        finalLeaf: 'generations/storage-generation-00000000-0000-4000-8000-000000000099',
      },
    }).success).toBe(false)

    const bytes = renderOperationJournal(journal)
    const reference = operationJournalReference(OPERATION_ID, bytes)
    expect(activeOperationSelectorSchema.safeParse({
      formatVersion: 1,
      operationId: OPERATION_ID,
      journal: { ...reference, leaf: '../operation.json' },
    }).success).toBe(false)
    expect(activeOperationSelectorSchema.safeParse({
      formatVersion: 1,
      operationId: OTHER_OPERATION_ID,
      journal: reference,
    }).success).toBe(false)
  })

  it('rejects duplicate JSON members in the selector and journal', async () => {
    const installationRoot = await root()
    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      '{"formatVersion":1,"formatVersion":1}\n',
    )
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const duplicateJournal = Buffer.from(
      `{"formatVersion":1,"formatVersion":1,"kind":"backup","operationId":"${OPERATION_ID}"}\n`,
      'utf8',
    )
    await writeActive(installationRoot, OPERATION_ID, duplicateJournal)
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires recovery for strict JSON with invalid selector fields', async () => {
    const installationRoot = await root()
    await writeFile(join(installationRoot, ACTIVE_OPERATION_LEAF), '{}\n')
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('rejects non-UTF-8 and oversized operation metadata', async () => {
    const installationRoot = await root()
    await writeActive(installationRoot, OPERATION_ID, Buffer.from([0xc3, 0x28]))
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      Buffer.alloc((16 * 1_024) + 1, 0x20),
    )
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires recovery when exact journal bytes or identity disagree', async () => {
    const installationRoot = await root()
    const journal = createOperationJournal({
      kind: 'backup',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      backupId: BACKUP_ID,
    })
    const journalBytes = renderOperationJournal(journal)
    await writeActive(installationRoot, OPERATION_ID, journalBytes)
    await writeFile(
      join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/')),
      Buffer.concat([journalBytes, Buffer.from(' ')]),
    )
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })

    const otherJournal = createOperationJournal({
      kind: 'backup',
      operationId: OTHER_OPERATION_ID,
      installationId: INSTALLATION_ID,
      backupId: BACKUP_ID,
    })
    const otherBytes = renderOperationJournal(otherJournal)
    const selectedPath = join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/'))
    await writeFile(selectedPath, otherBytes)
    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      renderActiveOperationSelector(
        OPERATION_ID,
        operationJournalReference(OPERATION_ID, otherBytes),
      ),
    )
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('never scans operation journals when the active selector is absent or points elsewhere', async () => {
    const installationRoot = await root()
    const orphan = createOperationJournal({
      kind: 'backup',
      operationId: OPERATION_ID,
      installationId: INSTALLATION_ID,
      backupId: BACKUP_ID,
    })
    const orphanPath = join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/'))
    await mkdir(dirname(orphanPath), { recursive: true })
    await writeFile(orphanPath, renderOperationJournal(orphan))
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).resolves.toBeUndefined()

    const missing = createOperationJournal({
      kind: 'backup',
      operationId: OTHER_OPERATION_ID,
      installationId: INSTALLATION_ID,
      backupId: BACKUP_ID,
    })
    const missingBytes = renderOperationJournal(missing)
    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      renderActiveOperationSelector(
        OTHER_OPERATION_ID,
        operationJournalReference(OTHER_OPERATION_ID, missingBytes),
      ),
    )
    await expect(readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('observes caller cancellation before reading the selector', async () => {
    const installationRoot = await root()
    const controller = new AbortController()
    controller.abort(new Error('cancel journal read'))
    await expect(readActiveOperation(installationRoot, controller.signal))
      .rejects.toThrow('cancel journal read')
  })
})
