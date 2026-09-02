/** Strict Saki identity schemas shared by product state and maintenance metadata. */

import { z } from 'zod'
import { sakiAgentProfileIdSchema, sakiControlIntentIdSchema } from '@breakfastdapaidang/saki-execution'
import type {
  SakiBootstrapChallengeId,
  SakiBoardRemoteFingerprint,
  SakiBoardWorkItemId,
  SakiBrowserSessionId,
  SakiBuildId,
  SakiDevelopmentProjectId,
  SakiGrantId,
  SakiDispatchClaimId,
  SakiGitHubScanAttemptId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiIntentReceiptId,
  SakiWorkAssignmentId,
  SakiPrincipalId,
  SakiResourceBindingId,
  SakiStorageGenerationId,
  SakiWorkItemRecoveryId,
} from './types.ts'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CHILD_ORDINAL_PATTERN = '(?:0|[1-9][0-9]*)'

const brandedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-${UUID_PATTERN}$`))
  .transform(value => value as T)

const accessChildId = <T extends string>(kind: 'challenge' | 'session') => z.string()
  .regex(new RegExp(`^access-${UUID_PATTERN}:${kind}:${CHILD_ORDINAL_PATTERN}$`))
  .transform(value => value as T)

const digestId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-[0-9a-f]{64}$`))
  .transform(value => value as T)

/** Strict Installation identity. */
export const sakiInstallationIdSchema = brandedId<SakiInstallationId>('installation')
/** Strict historical Installation State Generation identity. */
export const sakiInstallationGenerationIdSchema = brandedId<SakiInstallationGenerationId>(
  'installation-generation',
)
/** Strict physical storage-generation identity. */
export const sakiStorageGenerationIdSchema = brandedId<SakiStorageGenerationId>('storage-generation')
/** Strict independently enrolled Host identity. */
export const sakiHostIdSchema = brandedId<SakiHostId>('host')
/** Strict Principal identity. */
export const sakiPrincipalIdSchema = brandedId<SakiPrincipalId>('principal')
/** Strict authorization Grant identity. */
export const sakiGrantIdSchema = brandedId<SakiGrantId>('grant')
/** Strict Installation Access aggregate identity. */
export const sakiInstallationAccessIdSchema = brandedId<SakiInstallationAccessId>('access')
/** Strict Bootstrap Challenge child identity. */
export const sakiBootstrapChallengeIdSchema = accessChildId<SakiBootstrapChallengeId>('challenge')
/** Strict Browser Session child identity. */
export const sakiBrowserSessionIdSchema = accessChildId<SakiBrowserSessionId>('session')
/** Strict Development Project identity. */
export const sakiDevelopmentProjectIdSchema = brandedId<SakiDevelopmentProjectId>('project')
/** Strict Host-owned Resource Binding identity. */
export const sakiResourceBindingIdSchema = brandedId<SakiResourceBindingId>('binding')
export { sakiAgentProfileIdSchema, sakiControlIntentIdSchema }
/** Strict Intent receipt identity. */
export const sakiIntentReceiptIdSchema = brandedId<SakiIntentReceiptId>('receipt')
/** Strict Work Assignment identity. */
export const sakiWorkAssignmentIdSchema = brandedId<SakiWorkAssignmentId>('assignment')
/** Strict short-lived Execution Dispatch claim identity. */
export const sakiDispatchClaimIdSchema = brandedId<SakiDispatchClaimId>('dispatch-claim')
/** Strict GitHub-backed Work Item identity. */
export const sakiBoardWorkItemIdSchema = digestId<SakiBoardWorkItemId>('work-item')
/** Strict Development-Project-scoped Work Item recovery identity. */
export const sakiWorkItemRecoveryIdSchema = digestId<SakiWorkItemRecoveryId>('work-item-recovery')
/** Strict complete-scan attempt identity. */
export const sakiGitHubScanAttemptIdSchema = brandedId<SakiGitHubScanAttemptId>('scan-attempt')
/** Strict confirmed remote-input fingerprint. */
export const sakiBoardRemoteFingerprintSchema = digestId<SakiBoardRemoteFingerprint>('remote-fingerprint')
/** Bounded non-path build provenance; it never decides format compatibility. */
export const sakiBuildIdSchema = z.string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
  .transform(value => value as SakiBuildId)
