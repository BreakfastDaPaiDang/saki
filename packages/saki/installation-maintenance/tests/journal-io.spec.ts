import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

type FailureMode = 'normal' | 'read-non-error' | 'close-failure' | 'read-and-close-failure'

const filesystem = vi.hoisted(() => ({ mode: 'normal' as FailureMode }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof original.open>>
  return {
    ...original,
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args)
      const read = filesystem.mode === 'read-non-error'
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- fault injection proves unknown rejection normalization.
        ? async (): Promise<never> => await Promise.reject({ kind: 'operation-read-failure' })
        : filesystem.mode === 'read-and-close-failure'
          ? async (): Promise<never> => await Promise.reject(new Error('operation read failed'))
          : handle.read.bind(handle)
      const close = async (): Promise<void> => {
        await handle.close()
        if (filesystem.mode === 'close-failure' || filesystem.mode === 'read-and-close-failure') {
          throw new Error('operation close failed')
        }
      }
      return {
        stat: handle.stat.bind(handle),
        read,
        close,
      } as unknown as Handle
    },
  }
})

vi.mock('../src/owned-path.ts', () => ({
  requireOwnedPathAncestors: vi.fn(async () => undefined),
  validateOwnedPathAncestors: vi.fn(async () => true),
}))

import {
  ACTIVE_OPERATION_LEAF,
  createOperationJournal,
  operationJournalLeaf,
  operationJournalReference,
  readActiveOperation,
  renderActiveOperationSelector,
  renderOperationJournal,
} from '../src/journal.ts'
import type { SakiMaintenanceOperationId } from '../src/journal.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OPERATION_ID = 'operation-00000000-0000-4000-8000-000000000002' as SakiMaintenanceOperationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000004' as SakiStorageGenerationId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-journal-io-'))
  roots.push(value)
  return value
}

async function writeActive(installationRoot: string): Promise<void> {
  const journal = createOperationJournal({
    kind: 'fresh',
    operationId: OPERATION_ID,
    installationId: INSTALLATION_ID,
    candidateStorageGenerationId: GENERATION_ID,
  })
  const journalBytes = renderOperationJournal(journal)
  const reference = operationJournalReference(OPERATION_ID, journalBytes)
  const journalPath = join(installationRoot, ...operationJournalLeaf(OPERATION_ID).split('/'))
  await mkdir(dirname(journalPath), { recursive: true })
  await writeFile(journalPath, journalBytes)
  await writeFile(
    join(installationRoot, ACTIVE_OPERATION_LEAF),
    renderActiveOperationSelector(OPERATION_ID, reference),
  )
}

afterEach(async () => {
  filesystem.mode = 'normal'
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki operation metadata bounded-read failures', () => {
  it('normalizes a non-Error read failure and preserves a close failure', async () => {
    const installationRoot = await root()
    await writeActive(installationRoot)

    filesystem.mode = 'read-non-error'
    const readFailure = await readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(readFailure).toMatchObject({ code: 'recovery-required' })
    expect((readFailure as Error).cause).toBeInstanceOf(Error)
    expect(((readFailure as Error).cause as Error).cause).toEqual({
      kind: 'operation-read-failure',
    })

    filesystem.mode = 'close-failure'
    await expect(readActiveOperation(installationRoot, AbortSignal.timeout(2_000)))
      .rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('reports an operation read failure together with a close failure', async () => {
    const installationRoot = await root()
    await writeActive(installationRoot)
    filesystem.mode = 'read-and-close-failure'

    const failure = await readActiveOperation(
      installationRoot,
      AbortSignal.timeout(2_000),
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({ code: 'recovery-required' })
    expect((failure as Error).cause).toBeInstanceOf(AggregateError)
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2)
  })
})
