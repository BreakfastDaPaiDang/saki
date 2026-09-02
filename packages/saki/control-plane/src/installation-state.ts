/** Verified Saki Installation state Service Definition. @module @breakfastdapaidang/saki-control-plane/installation-state */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SakiBuildId, SakiInstallationId, SakiStorageGenerationId } from './types.ts'

/** Maintenance-owned active Installation and storage-generation identity. */
export abstract class SakiInstallationState extends Service {
  /** Manifest phase selected for this process. */
  abstract readonly phase: 'provisioning' | 'ready'
  /** Product Installation identity fixed across storage generations. */
  abstract readonly installationId: SakiInstallationId
  /** Physical storage generation selected as active for this process. */
  abstract readonly storageGenerationId: SakiStorageGenerationId
  /** State-format version selected by the Installation manifest. */
  abstract readonly stateVersion: 8
  /** Build provenance recorded when this storage generation was created. */
  abstract readonly createdByBuildId: SakiBuildId

  /**
   * Promote an already-published provisioning manifest to ready after product validation.
   * A generation selected by a ready manifest treats this as an idempotent validation point.
   * @param signal - control-plane startup lifetime.
   */
  abstract activateAfterValidation(signal: AbortSignal): Promise<void>

  /** @param ctx - owning Cordis context. */
  constructor(ctx: Context) {
    super(ctx, 'sakiInstallationState')
  }
}

export default SakiInstallationState
