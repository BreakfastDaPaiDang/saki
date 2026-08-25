import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SakiInstallationId, SakiStorageGenerationId } from '@breakfastdapaidang/saki-control-plane'

type PublicationResult =
  | { readonly outcome: 'durable' }
  | { readonly outcome: 'published'; readonly cause: Error }

const publications = vi.hoisted(() => ({
  file: vi.fn<(path: string, bytes: Buffer, signal: AbortSignal) => Promise<PublicationResult>>(),
}))

vi.mock('../src/durable-files.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/durable-files.ts')>()
  return { ...original, publishMissingFile: publications.file }
})

import { publishActiveOperation } from '../src/operation-files.ts'
import { createOperationJournal, createSakiMaintenanceOperationId } from '../src/journal.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const roots: string[] = []

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-operation-publication-'))
  roots.push(value)
  return value
}

function journal(): ReturnType<typeof createOperationJournal> {
  return createOperationJournal({
    kind: 'fresh',
    operationId: createSakiMaintenanceOperationId(),
    installationId: INSTALLATION_ID,
    candidateStorageGenerationId: GENERATION_ID,
  })
}

async function publishBytes(path: string, bytes: Buffer): Promise<PublicationResult> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' })
  return { outcome: 'durable' }
}

afterEach(async () => {
  publications.file.mockReset()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('active operation publication failures', () => {
  it('requires every visible operation file publication to be durable', async () => {
    const failure = new Error('pending parent sync failed')
    publications.file.mockResolvedValueOnce({ outcome: 'published', cause: failure })

    await expect(publishActiveOperation(
      await root(),
      journal(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required', cause: failure })
  })

  it('requires exact pending-intent readback after reported publication', async () => {
    publications.file.mockResolvedValueOnce({ outcome: 'durable' })

    await expect(publishActiveOperation(
      await root(),
      journal(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })

  it('classifies an EEXIST journal race as another active operation', async () => {
    publications.file
      .mockImplementationOnce(publishBytes)
      .mockRejectedValueOnce(Object.assign(new Error('journal exists'), { code: 'EEXIST' }))

    await expect(publishActiveOperation(
      await root(),
      journal(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'operation-active' })
  })

  it('propagates a journal publication failure that is not EEXIST', async () => {
    const failure = new Error('journal write failed')
    publications.file
      .mockImplementationOnce(publishBytes)
      .mockRejectedValueOnce(failure)

    await expect(publishActiveOperation(
      await root(),
      journal(),
      AbortSignal.timeout(2_000),
    )).rejects.toBe(failure)
  })

  it('requires exact active-selector readback after reported publication', async () => {
    let publication = 0
    publications.file.mockImplementation(async (path, bytes) => {
      publication += 1
      if (publication < 3) return await publishBytes(path, bytes)
      return { outcome: 'durable' }
    })

    await expect(publishActiveOperation(
      await root(),
      journal(),
      AbortSignal.timeout(2_000),
    )).rejects.toMatchObject({ code: 'recovery-required' })
  })
})
