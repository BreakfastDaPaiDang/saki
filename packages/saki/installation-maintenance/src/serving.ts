/** Installation-scoped serving preparation and fresh-generation activation. */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  sakiStorageGenerationIdSchema,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import {
  INSTALLATION_MANIFEST_LEAF,
  readInstallationManifest,
  readSelectedGeneration,
  renderInstallationManifest,
} from './manifest.ts'
import type { GenerationManifest, InstallationManifest } from './manifest.ts'
import {
  clearActiveOperation,
  publishActiveOperation,
} from './operation-files.ts'
import {
  createOperationJournal,
  createSakiMaintenanceOperationId,
} from './journal.ts'
import type { SakiOperationJournal } from './journal.ts'
import { materializeFreshSakiGeneration } from './generation.ts'
import {
  readClosedCurrentSakiState,
  readClosedProvisioningSakiState,
  readClosedSakiV3State,
  readClosedSakiV4State,
  readClosedSakiV5State,
  readClosedSakiV6State,
} from './closed-state.ts'
import { publishMissingFile, replaceFileDurably } from './durable-files.ts'
import type { DurableFileResult } from './durable-files.ts'
import { selectSakiInstallationSource } from './layout.ts'
import { withInstallationLease } from './lease.ts'
import { SakiMaintenanceError } from './error.ts'
import type { PreparedSakiState } from './prepared-state.ts'
import { validateClosedSakiV2Source } from './legacy-state.ts'
import { publishSakiGenerationCandidate } from './candidate.ts'
import { recoverActiveSakiOperation } from './recovery.ts'
import { sakiStateCapability } from './state-version.ts'

/** Filesystem and build inputs fixed for one Saki serving process. */
export interface SakiServingInstallationOptions {
  /** Absolute root containing the Installation selector and generations. */
  readonly installationRoot: string
  /** Exact absolute B03 database path used only while no Installation manifest exists. */
  readonly legacyDatabasePath: string
  /** Provenance recorded only when this build creates a new generation. */
  readonly currentBuildId: SakiBuildId
}

function requireAbsolutePath(path: string, subject: string): string {
  const absolute = resolve(path)
  if (path === ':memory:' || absolute !== path) {
    throw new Error(`${subject} must be an absolute filesystem path`)
  }
  return absolute
}

function requireDurable(result: DurableFileResult, subject: string): void {
  if (result.outcome === 'published') {
    throw new SakiMaintenanceError(
      'recovery-required',
      `${subject} is visible but its namespace durability is uncertain`,
      { cause: result.cause },
    )
  }
}

function newInstallationId(): SakiInstallationId {
  return sakiInstallationIdSchema.parse(`installation-${randomUUID()}`)
}

function newStorageGenerationId(): SakiStorageGenerationId {
  return sakiStorageGenerationIdSchema.parse(`storage-generation-${randomUUID()}`)
}

function preparedExpectation(generation: GenerationManifest): {
  readonly installationId: SakiInstallationId
  readonly storageGenerationId: SakiStorageGenerationId
  readonly stateVersion: 7
  readonly createdByBuildId: SakiBuildId
} {
  return {
    installationId: generation.installationId,
    storageGenerationId: generation.storageGenerationId,
    stateVersion: sakiStateCapability.writable.version,
    createdByBuildId: generation.createdByBuildId,
  }
}

async function promoteProvisioningManifest(
  root: string,
  selectedManifest: InstallationManifest,
  selectedManifestBytes: Buffer,
  generation: GenerationManifest,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const current = await readInstallationManifest(root, signal)
  if (current === undefined
    || !current.bytes.equals(selectedManifestBytes)) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'Saki provisioning authority changed before ready publication',
    )
  }
  const readyBytes = renderInstallationManifest('ready', generation, selectedManifest.generationJson)
  requireDurable(
    await replaceFileDurably(resolve(root, INSTALLATION_MANIFEST_LEAF), readyBytes, signal),
    'Saki ready Installation manifest',
  )
  const published = await readInstallationManifest(root, new AbortController().signal)
  if (published === undefined || !published.bytes.equals(readyBytes)) {
    throw new SakiMaintenanceError('recovery-required', 'Saki ready manifest failed exact readback')
  }
}

async function prepareSelectedGeneration(
  root: string,
  selected: Awaited<ReturnType<typeof readSelectedGeneration>>,
  signal: AbortSignal,
): Promise<PreparedSakiState> {
  const readable = sakiStateCapability.resolveReadable(selected.installation.stateVersion)
  if (readable?.version === 2) {
    await validateClosedSakiV2Source(
      selected.databasePath,
      selected.installation.installationId,
      selected.installation.storageGenerationId,
      signal,
    )
    throw new SakiMaintenanceError(
      'upgrade-required',
      'Saki state version 2 is valid but requires the offline upgrade command before serving',
    )
  }
  if (readable?.version === 3) {
    await readClosedSakiV3State(
      selected.databasePath,
      {
        installationId: selected.installation.installationId,
        storageGenerationId: selected.installation.storageGenerationId,
        createdByBuildId: selected.generation.createdByBuildId,
      },
      signal,
    )
    throw new SakiMaintenanceError(
      'upgrade-required',
      'Saki state version 3 is valid but requires the offline upgrade command before serving',
    )
  }
  if (readable?.version === 4) {
    await readClosedSakiV4State(
      selected.databasePath,
      {
        installationId: selected.installation.installationId,
        storageGenerationId: selected.installation.storageGenerationId,
        createdByBuildId: selected.generation.createdByBuildId,
      },
      signal,
    )
    throw new SakiMaintenanceError(
      'upgrade-required',
      'Saki state version 4 is valid but requires the offline upgrade command before serving',
    )
  }
  if (readable?.version === 5) {
    await readClosedSakiV5State(
      selected.databasePath,
      {
        installationId: selected.installation.installationId,
        storageGenerationId: selected.installation.storageGenerationId,
        createdByBuildId: selected.generation.createdByBuildId,
      },
      signal,
    )
    throw new SakiMaintenanceError(
      'upgrade-required',
      'Saki state version 5 is valid but requires the offline upgrade command before serving',
    )
  }
  if (readable?.version === 6) {
    await readClosedSakiV6State(
      selected.databasePath,
      {
        installationId: selected.installation.installationId,
        storageGenerationId: selected.installation.storageGenerationId,
        createdByBuildId: selected.generation.createdByBuildId,
      },
      signal,
    )
    throw new SakiMaintenanceError(
      'upgrade-required',
      'Saki state version 6 is valid but requires the offline upgrade command before serving',
    )
  }
  if (readable?.version !== sakiStateCapability.writable.version) {
    throw new SakiMaintenanceError(
      'state-unsupported',
      `Saki state version ${String(selected.installation.stateVersion)} is not readable by this build`,
    )
  }
  const expectation = preparedExpectation(selected.generation)
  if (selected.installation.phase === 'ready') {
    await readClosedCurrentSakiState(selected.databasePath, expectation, signal)
    return { phase: 'ready', databasePath: selected.databasePath, ...expectation }
  }
  await readClosedProvisioningSakiState(selected.databasePath, expectation, signal)
  const selectedManifest = await readInstallationManifest(root, signal)
  if (selectedManifest === undefined || selectedManifest.value.phase !== 'provisioning') {
    throw new SakiMaintenanceError('recovery-required', 'Saki provisioning manifest disappeared during preflight')
  }
  return {
    phase: 'provisioning',
    databasePath: selected.databasePath,
    ...expectation,
    promoteToReady: async (activationSignal) => {
      await promoteProvisioningManifest(
        root,
        selectedManifest.value,
        selectedManifest.bytes,
        selected.generation,
        activationSignal,
      )
    },
  }
}

async function createFreshPreparedState(
  root: string,
  currentBuildId: SakiBuildId,
  signal: AbortSignal,
): Promise<PreparedSakiState> {
  const installationId = newInstallationId()
  const storageGenerationId = newStorageGenerationId()
  const journal = createOperationJournal({
    kind: 'fresh',
    operationId: createSakiMaintenanceOperationId(),
    installationId,
    candidateStorageGenerationId: storageGenerationId,
  }) as Extract<SakiOperationJournal, { readonly kind: 'fresh' }>
  const active = await publishActiveOperation(root, journal, signal)
  const identity = { installationId, storageGenerationId, createdByBuildId: currentBuildId }
  const selected = await publishSakiGenerationCandidate(
    root,
    journal,
    identity,
    signal,
    async (databasePath) => {
      await materializeFreshSakiGeneration(databasePath, identity, signal)
    },
  )
  const provisioningBytes = renderInstallationManifest(
    'provisioning',
    selected.generation,
    selected.installation.generationJson,
  )
  requireDurable(
    await publishMissingFile(resolve(root, INSTALLATION_MANIFEST_LEAF), provisioningBytes, signal),
    'Saki provisioning Installation manifest',
  )
  const selectedManifest = await readInstallationManifest(root, signal)
  if (selectedManifest === undefined || !selectedManifest.bytes.equals(provisioningBytes)) {
    throw new SakiMaintenanceError('recovery-required', 'fresh Saki manifest failed exact readback')
  }
  const published = await readSelectedGeneration(root, selectedManifest.value, signal)
  await readClosedProvisioningSakiState(
    published.databasePath,
    { ...identity, stateVersion: sakiStateCapability.writable.version },
    signal,
  )
  await clearActiveOperation(root, active)
  return await prepareSelectedGeneration(root, published, signal)
}

async function prepareSakiServingState(
  options: SakiServingInstallationOptions,
  signal: AbortSignal,
): Promise<PreparedSakiState> {
  const root = requireAbsolutePath(options.installationRoot, 'Saki Installation root')
  const legacyDatabasePath = requireAbsolutePath(options.legacyDatabasePath, 'legacy Saki database path')
  const currentBuildId = sakiBuildIdSchema.parse(options.currentBuildId)
  await recoverActiveSakiOperation(root, legacyDatabasePath, signal)
  const source = await selectSakiInstallationSource(root, legacyDatabasePath, signal)
  switch (source.kind) {
    case 'selected-generation':
      return await prepareSelectedGeneration(root, source.selected, signal)
    case 'legacy-v2': {
      await validateClosedSakiV2Source(source.databasePath, undefined, undefined, signal)
      throw new SakiMaintenanceError(
        'upgrade-required',
        'B03 Saki state is valid but requires the offline upgrade command before serving',
      )
    }
    case 'fresh':
      return await createFreshPreparedState(root, currentBuildId, signal)
  }
}

/**
 * Hold the Installation lease across preflight, boot, the complete serving lifetime, and teardown.
 * @param options - exact Installation paths and current creator provenance.
 * @param signal - cancellation during lock acquisition and pre-serving maintenance.
 * @param serve - callback whose settlement means every storage writer has closed.
 * @returns callback result after the crash-released Installation lease is released.
 */
export async function withPreparedSakiServingState<T>(
  options: SakiServingInstallationOptions,
  signal: AbortSignal,
  serve: (prepared: PreparedSakiState) => Promise<T>,
): Promise<T> {
  const root = requireAbsolutePath(options.installationRoot, 'Saki Installation root')
  return await withInstallationLease(root, signal, async () => {
    const prepared = await prepareSakiServingState(options, signal)
    return await serve(prepared)
  })
}
