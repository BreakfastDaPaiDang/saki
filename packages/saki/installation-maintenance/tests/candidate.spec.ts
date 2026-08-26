import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createOperationJournal,
  createSakiMaintenanceOperationId,
  publishSakiGenerationCandidate,
} from '../src/index.ts'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const BUILD_ID = 'saki-build-test' as SakiBuildId
const roots: string[] = []

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

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'saki-candidate-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Saki generation candidate ownership', () => {
  it('refuses to create a candidate through a Windows junction or POSIX symlink', async () => {
    const installationRoot = await root()
    const external = await root()
    const valuable = join(external, 'valuable.txt')
    await writeFile(valuable, 'outside')
    await symlink(external, join(installationRoot, 'generations'), process.platform === 'win32' ? 'junction' : 'dir')
    const materialize = vi.fn<(databasePath: string) => Promise<void>>()
    const journal = freshJournal()

    try {
      await expect(publishSakiGenerationCandidate(
        installationRoot,
        journal,
        {
          installationId: INSTALLATION_ID,
          storageGenerationId: GENERATION_ID,
          createdByBuildId: BUILD_ID,
        },
        AbortSignal.timeout(2_000),
        materialize,
      )).rejects.toMatchObject({ code: 'recovery-required' })
      expect(materialize).not.toHaveBeenCalled()
    } finally {
      await expect(readFile(valuable, 'utf8')).resolves.toBe('outside')
    }
  })

  it('rejects identities that disagree with the immutable journal', async () => {
    await expect(publishSakiGenerationCandidate(
      await root(),
      freshJournal(),
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000003' as SakiStorageGenerationId,
        createdByBuildId: BUILD_ID,
      },
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toThrow('candidate identity disagrees')
  })

  it('refuses an already-existing journal-owned partial candidate', async () => {
    const installationRoot = await root()
    const journal = freshJournal()
    await mkdir(join(installationRoot, ...journal.candidate.partialLeaf.split('/')), { recursive: true })

    await expect(publishSakiGenerationCandidate(
      installationRoot,
      journal,
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: GENERATION_ID,
        createdByBuildId: BUILD_ID,
      },
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toMatchObject({ code: 'target-exists' })
  })

  it('rejects an escaping candidate leaf before touching its destination', async () => {
    const journal = freshJournal()
    const malformed = {
      ...journal,
      candidate: { ...journal.candidate, partialLeaf: '../outside.partial' },
    } as typeof journal

    await expect(publishSakiGenerationCandidate(
      await root(),
      malformed,
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: GENERATION_ID,
        createdByBuildId: BUILD_ID,
      },
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toThrow('escapes its Installation root')
  })

  it('propagates a non-absence failure while checking a candidate destination', async () => {
    const journal = freshJournal()
    const malformed = {
      ...journal,
      candidate: { ...journal.candidate, partialLeaf: 'generations/\0.partial' },
    } as typeof journal

    await expect(publishSakiGenerationCandidate(
      await root(),
      malformed,
      {
        installationId: INSTALLATION_ID,
        storageGenerationId: GENERATION_ID,
        createdByBuildId: BUILD_ID,
      },
      AbortSignal.timeout(2_000),
      async () => undefined,
    )).rejects.toThrow()
  })
})
