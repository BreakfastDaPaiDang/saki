/** Maintenance-verified Installation state injected into one serving composition. */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  sakiBuildIdSchema,
  sakiInstallationIdSchema,
  SakiInstallationState,
  sakiStorageGenerationIdSchema,
} from '@breakfastdapaidang/saki-control-plane'
import type {
  SakiBuildId,
  SakiInstallationId,
  SakiStorageGenerationId,
} from '@breakfastdapaidang/saki-control-plane'

interface PreparedStateBase {
  /** Exact active SQLite database chosen before the serving tree mounts. */
  readonly databasePath: string
  /** Product Installation identity verified against metadata and state. */
  readonly installationId: SakiInstallationId
  /** Physical generation identity verified against metadata and its seal. */
  readonly storageGenerationId: SakiStorageGenerationId
  /** Sole writable state version. */
  readonly stateVersion: 7
  /** Artifact creator provenance; it does not decide compatibility. */
  readonly createdByBuildId: SakiBuildId
}

/** Already-ready state whose authority manifest requires no promotion. */
export interface PreparedReadySakiState extends PreparedStateBase {
  /** Serving authority is already ready. */
  readonly phase: 'ready'
}

/** Fresh state whose provisioning manifest must be promoted after validation. */
export interface PreparedProvisioningSakiState extends PreparedStateBase {
  /** The authority manifest deliberately prevents serving until validation. */
  readonly phase: 'provisioning'
  /**
   * Atomically promote the provisioning authority manifest to ready.
   * @param signal - serving startup lifetime through the authority commit.
   */
  readonly promoteToReady: (signal: AbortSignal) => Promise<void>
}

/** Complete maintenance output consumed by one serving launcher. */
export type PreparedSakiState = PreparedReadySakiState | PreparedProvisioningSakiState

function validatePreparedState(state: PreparedSakiState): void {
  if (state.databasePath === ':memory:' || resolve(state.databasePath) !== state.databasePath) {
    throw new Error('prepared Saki database path must be an absolute filesystem path')
  }
  sakiInstallationIdSchema.parse(state.installationId)
  sakiStorageGenerationIdSchema.parse(state.storageGenerationId)
  sakiBuildIdSchema.parse(state.createdByBuildId)
}

class PreparedSakiInstallationState extends SakiInstallationState {
  readonly phase: PreparedSakiState['phase']
  readonly installationId: SakiInstallationId
  readonly storageGenerationId: SakiStorageGenerationId
  readonly stateVersion = 7 as const
  readonly createdByBuildId: SakiBuildId
  private readonly promoteToReady: ((signal: AbortSignal) => Promise<void>) | undefined
  private activation: Promise<void> | undefined

  constructor(ctx: Context, state: PreparedSakiState) {
    validatePreparedState(state)
    super(ctx)
    this.phase = state.phase
    this.installationId = state.installationId
    this.storageGenerationId = state.storageGenerationId
    this.createdByBuildId = state.createdByBuildId
    this.promoteToReady = state.phase === 'provisioning' ? state.promoteToReady : undefined
  }

  async activateAfterValidation(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.promoteToReady === undefined) return
    this.activation ??= this.promoteToReady(signal)
    await this.activation
  }
}

/**
 * Inject one already-verified Installation selection before the serving tree mounts.
 * @param ctx - root serving Context prepared by the outer launcher.
 * @param state - exact maintenance output and optional ready-promotion effect.
 * @returns registered Installation-state service.
 */
export function providePreparedSakiState(
  ctx: Context,
  state: PreparedSakiState,
): SakiInstallationState {
  return new PreparedSakiInstallationState(ctx, state)
}
