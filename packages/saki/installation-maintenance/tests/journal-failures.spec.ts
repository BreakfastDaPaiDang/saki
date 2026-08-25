import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  ACTIVE_OPERATION_LEAF,
  createOperationJournal,
  operationJournalLeaf,
  operationJournalReference,
  pendingOperationIntentSchema,
  PENDING_OPERATION_LEAF,
  readActiveOperation,
  readPendingOperation,
  readSettledOperation,
  renderActiveOperationSelector,
  renderOperationJournal,
  renderPendingOperationIntent,
  SETTLED_OPERATION_LEAF,
} from '../src/journal.ts'
import type { SakiMaintenanceOperationId } from '../src/journal.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OPERATION_ID = 'operation-00000000-0000-4000-8000-000000000002' as SakiMaintenanceOperationId
const OTHER_OPERATION_ID = 'operation-00000000-0000-4000-8000-000000000102' as SakiMaintenanceOperationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000004' as SakiStorageGenerationId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-journal-failure-'))
  roots.push(value)
  return value
}

function freshJournal() {
  return createOperationJournal({
    kind: 'fresh',
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    candidateStorageGenerationId: GENERATION_ID,
  })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki operation metadata failures', () => {
  it('rejects a pending reference that disagrees with its operation identity', () => {
    const bytes = renderOperationJournal(freshJournal())
    const reference = operationJournalReference(OPERATION_ID, bytes)

    expect(pendingOperationIntentSchema.safeParse({
      formatVersion: 1,
      status: 'pending',
      operationId: OTHER_OPERATION_ID,
      journal: reference,
    }).success).toBe(false)
  })

  it('requires a regular selected journal', async () => {
    const installationRoot = await root()
    const journalBytes = renderOperationJournal(freshJournal())
    const reference = operationJournalReference(OPERATION_ID, journalBytes)
    const journalPath = join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/'))
    await mkdir(journalPath, { recursive: true })
    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      renderActiveOperationSelector(OPERATION_ID, reference),
    )

    await expect(readActiveOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('treats a missing selector root as absent and a missing selected-journal parent as recovery', async () => {
    const installationRoot = await root()
    await expect(readActiveOperation(
      join(installationRoot, 'missing'),
      AbortSignal.timeout(2_000),
    )).resolves.toBeUndefined()

    const journalBytes = renderOperationJournal(freshJournal())
    const reference = operationJournalReference(OPERATION_ID, journalBytes)
    await writeFile(
      join(installationRoot, ACTIVE_OPERATION_LEAF),
      renderActiveOperationSelector(OPERATION_ID, reference),
    )
    await expect(readActiveOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires the fixed settled fallback journal selected by a committed selector', async () => {
    const installationRoot = await root()
    const journalBytes = renderOperationJournal(freshJournal())
    const reference = operationJournalReference(OPERATION_ID, journalBytes)
    await mkdir(join(installationRoot, 'operations'))
    await writeFile(
      join(installationRoot, SETTLED_OPERATION_LEAF),
      renderActiveOperationSelector(OPERATION_ID, reference),
    )

    await expect(readSettledOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('treats a missing pending root as absent and malformed pending metadata as recovery', async () => {
    const installationRoot = await root()
    await expect(readPendingOperation(
      join(installationRoot, 'missing'),
      AbortSignal.timeout(2_000),
    )).resolves.toBeUndefined()

    await mkdir(join(installationRoot, PENDING_OPERATION_LEAF))
    await expect(readPendingOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('requires a regular journal when a pending intent has been materialized', async () => {
    const installationRoot = await root()
    const journalBytes = renderOperationJournal(freshJournal())
    const reference = operationJournalReference(OPERATION_ID, journalBytes)
    const journalPath = join(installationRoot, ...reference.leaf.split('/'))
    await mkdir(dirname(journalPath), { recursive: true })
    await mkdir(journalPath)
    await writeFile(
      join(installationRoot, PENDING_OPERATION_LEAF),
      renderPendingOperationIntent(OPERATION_ID, reference),
    )

    await expect(readPendingOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })
})
