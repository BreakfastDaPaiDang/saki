import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

type PublicationResult =
  | { readonly outcome: 'durable' }
  | { readonly outcome: 'published'; readonly cause: Error }

const publications = vi.hoisted(() => ({
  file: vi.fn<(...args: unknown[]) => Promise<PublicationResult>>(),
  directory: vi.fn<(...args: unknown[]) => Promise<PublicationResult>>(),
}))

vi.mock('../src/durable-files.ts', () => ({ publishMissingFile: publications.file }))
vi.mock('../src/durable-directories.ts', () => ({ publishMissingDirectory: publications.directory }))

import { publishSakiGenerationCandidate } from '../src/candidate.ts'
import { createOperationJournal, createSakiMaintenanceOperationId } from '../src/journal.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-candidate-durability-'))
  roots.push(value)
  return value
}

function freshJournal(): Extract<ReturnType<typeof createOperationJournal>, { kind: 'fresh' }> {
  const journal = createOperationJournal({
    kind: 'fresh',
    operationId: createSakiMaintenanceOperationId(),
    installationId: INSTALLATION_ID,
    candidateStorageGenerationId: GENERATION_ID,
  })
  if (journal.kind !== 'fresh') throw new Error('fresh journal factory returned another operation kind')
  return journal
}

const identity = {
  installationId: INSTALLATION_ID,
  storageGenerationId: GENERATION_ID,
  createdByBuildId: BUILD_ID,
}

afterEach(async () => {
  vi.clearAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki candidate durability outcomes', () => {
  it('requires durable generation metadata before publishing the directory', async () => {
    const failure = new Error('generation metadata parent sync failed')
    publications.file.mockResolvedValueOnce({ outcome: 'published', cause: failure })

    await expect(publishSakiGenerationCandidate(
      await root(),
      freshJournal(),
      identity,
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required', cause: failure })
    expect(publications.directory).not.toHaveBeenCalled()
  })

  it('requires a durable final generation directory', async () => {
    const failure = new Error('generation directory parent sync failed')
    publications.file.mockResolvedValueOnce({ outcome: 'durable' })
    publications.directory.mockResolvedValueOnce({ outcome: 'published', cause: failure })

    await expect(publishSakiGenerationCandidate(
      await root(),
      freshJournal(),
      identity,
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toMatchObject({ code: 'recovery-required', cause: failure })
  })
})
