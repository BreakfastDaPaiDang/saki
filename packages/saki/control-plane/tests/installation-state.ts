import { type Context } from '@deepseek-ai/cordis'
import {
  createStorageGenerationSeal,
  SakiInstallationState,
  sakiStorageGenerationDomainSpec,
  STORAGE_GENERATION_KEY,
  type StorageGenerationSealRecord,
  type SakiBuildId,
  type SakiInstallationId,
  type SakiStorageGenerationId,
} from '../src/index.ts'

/** Active Installation identity values supplied by one test composition. */
export type TestSakiInstallationState = Readonly<Pick<
  SakiInstallationState,
  'phase' | 'installationId' | 'storageGenerationId' | 'stateVersion' | 'createdByBuildId'
>>

class FixedSakiInstallationState extends SakiInstallationState {
  readonly phase: 'provisioning' | 'ready'
  readonly installationId: SakiInstallationId
  readonly storageGenerationId: SakiStorageGenerationId
  readonly stateVersion = 7 as const
  readonly createdByBuildId: SakiBuildId

  constructor(ctx: Context, state: TestSakiInstallationState) {
    super(ctx)
    this.phase = state.phase
    this.installationId = state.installationId
    this.storageGenerationId = state.storageGenerationId
    this.createdByBuildId = state.createdByBuildId
  }

  async activateAfterValidation(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
  }
}

/** Fixed verified state used by control-plane composition tests. */
export const TEST_SAKI_INSTALLATION_STATE: TestSakiInstallationState = Object.freeze({
  phase: 'provisioning',
  installationId: 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId,
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId,
  stateVersion: 7,
  createdByBuildId: 'saki-build-test' as SakiBuildId,
})

/** Ready selection of the ordinary test storage generation. */
const READY_SAKI_INSTALLATION_STATE: TestSakiInstallationState = Object.freeze({
  ...TEST_SAKI_INSTALLATION_STATE,
  phase: 'ready',
})

/** Different active storage generation for restart and stale-authority tests. */
export const NEXT_SAKI_INSTALLATION_STATE: TestSakiInstallationState = Object.freeze({
  phase: 'ready',
  installationId: TEST_SAKI_INSTALLATION_STATE.installationId,
  storageGenerationId: 'storage-generation-00000000-0000-4000-8000-000000000003' as SakiStorageGenerationId,
  stateVersion: 7,
  createdByBuildId: TEST_SAKI_INSTALLATION_STATE.createdByBuildId,
})

/** Historical storage generation retained only for attribution tests. */
export const HISTORICAL_STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000004' as SakiStorageGenerationId

function sealMatches(
  actual: StorageGenerationSealRecord,
  expected: StorageGenerationSealRecord,
): boolean {
  return actual.schemaVersion === expected.schemaVersion
    && actual.installationId === expected.installationId
    && actual.storageGenerationId === expected.storageGenerationId
    && actual.stateVersion === expected.stateVersion
    && actual.createdByBuildId === expected.createdByBuildId
}

async function readOrMaterializeSeal(
  ctx: Context,
  requestedState: TestSakiInstallationState | undefined,
): Promise<TestSakiInstallationState> {
  const referenceState = requestedState ?? TEST_SAKI_INSTALLATION_STATE
  const expected = createStorageGenerationSeal(
    referenceState.installationId,
    referenceState.storageGenerationId,
    referenceState.createdByBuildId,
  )
  const domain = await ctx.storageDomain.open(sakiStorageGenerationDomainSpec)
  try {
    const existing = domain.table('storage_generation').get(STORAGE_GENERATION_KEY)
    if (existing === undefined) {
      if (requestedState?.phase === 'ready') {
        throw new Error('test ready storage generation is missing its seal')
      }
      await domain.table('storage_generation').put(STORAGE_GENERATION_KEY, expected)
      return requestedState ?? TEST_SAKI_INSTALLATION_STATE
    }
    if (!sealMatches(existing, expected)) {
      throw new Error('test Installation state disagrees with the existing storage-generation seal')
    }
    return requestedState ?? READY_SAKI_INSTALLATION_STATE
  } finally {
    await domain.close()
  }
}

/** Publish one maintenance-verified state into a test Context. */
export async function provideSakiInstallationState(
  ctx: Context,
  state?: TestSakiInstallationState,
): Promise<void> {
  const selectedState = await readOrMaterializeSeal(ctx, state)
  new FixedSakiInstallationState(ctx, selectedState)
}

/** Replace a copied candidate's inherited seal with its new physical-generation identity. */
export async function materializeCandidateStorageGenerationSeal(
  ctx: Context,
  state: TestSakiInstallationState,
): Promise<void> {
  const expected = createStorageGenerationSeal(
    state.installationId,
    state.storageGenerationId,
    state.createdByBuildId,
  )
  const domain = await ctx.storageDomain.open(sakiStorageGenerationDomainSpec)
  try {
    const existing = domain.table('storage_generation').get(STORAGE_GENERATION_KEY)
    if (existing !== undefined && sealMatches(existing, expected)) return
    await domain.table('storage_generation').put(STORAGE_GENERATION_KEY, expected)
  } finally {
    await domain.close()
  }
}
