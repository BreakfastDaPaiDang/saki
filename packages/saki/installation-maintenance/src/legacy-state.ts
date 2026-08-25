/** Exact B03 identity and relationship validation over a closed source. */

import {
  migratedStorageGenerationId,
  validateSakiV2SourceState,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'
import { readClosedSakiV2State } from './closed-state.ts'
import type { ClosedSakiV2State } from './closed-state.ts'
import { SakiMaintenanceError } from './error.ts'

/** Complete validated identity needed to back up or migrate one B03 source. */
export interface ValidatedSakiV2Source extends ClosedSakiV2State {
  /** Installation selected by the exact B03 control owner. */
  readonly installationId: SakiInstallationId
  /** Historical current generation translated to the physical identity vocabulary. */
  readonly storageGenerationId: SakiStorageGenerationId
  /** Initial and current historical identities translated for collision rejection. */
  readonly historicalStorageGenerationIds: ReadonlySet<SakiStorageGenerationId>
}

/**
 * Read exact B03 media, apply only B03 product relationships, and recover its selected identities.
 * @param databasePath - manifest-selected or exact configured legacy SQLite database.
 * @param expectedInstallationId - optional manifest Installation identity.
 * @param expectedStorageGenerationId - optional manifest physical generation identity.
 * @param signal - cancellation throughout the frozen closed read.
 * @returns validated detached source plus retained Installation and generation identities.
 */
export async function validateClosedSakiV2Source(
  databasePath: string,
  expectedInstallationId: SakiInstallationId | undefined,
  expectedStorageGenerationId: SakiStorageGenerationId | undefined,
  signal: AbortSignal,
): Promise<ValidatedSakiV2Source> {
  const legacy = await readClosedSakiV2State(databasePath, signal)
  const control = legacy.controlPlane.table('control_state').get('control-state')
  if (control === undefined) {
    throw new SakiMaintenanceError('recovery-required', 'B03 Saki state has no control singleton')
  }
  if (expectedInstallationId !== undefined && control.installationId !== expectedInstallationId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'B03 control owner disagrees with the selected Installation manifest',
    )
  }
  const installation = legacy.controlPlane.table('installations').get(control.installationId)
  if (installation === undefined) {
    throw new SakiMaintenanceError('recovery-required', 'B03 Saki state has no selected Installation')
  }
  validateSakiV2SourceState(legacy.controlPlane, control.installationId)
  const storageGenerationId = migratedStorageGenerationId(
    installation.currentInstallationGenerationId,
  )
  const historicalStorageGenerationIds = new Set([
    migratedStorageGenerationId(control.initialInstallationGenerationId),
    storageGenerationId,
  ])
  if (expectedStorageGenerationId !== undefined
    && storageGenerationId !== expectedStorageGenerationId) {
    throw new SakiMaintenanceError(
      'recovery-required',
      'B03 current generation disagrees with the selected generation manifest',
    )
  }
  return {
    ...legacy,
    installationId: control.installationId,
    storageGenerationId,
    historicalStorageGenerationIds,
  }
}
