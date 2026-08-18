/** Durable Saki provisioning, entity, and Installation Access schemas. @module @breakfastdapaidang/saki-control-plane/src/spec */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  SakiBootstrapChallengeId,
  SakiBrowserSessionId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiPrincipalId,
} from './types.ts'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const CHILD_ORDINAL_PATTERN = '(?:0|[1-9][0-9]*)'
const brandedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}-${UUID_PATTERN}$`))
  .transform(value => value as T)
const accessChildId = <T extends string>(kind: 'challenge' | 'session') => z.string()
  .regex(new RegExp(`^access-${UUID_PATTERN}:${kind}:${CHILD_ORDINAL_PATTERN}$`))
  .transform(value => value as T)
const installationId = brandedId<SakiInstallationId>('installation')
const installationGenerationId = brandedId<SakiInstallationGenerationId>('installation-generation')
const hostId = brandedId<SakiHostId>('host')
const principalId = brandedId<SakiPrincipalId>('principal')
const grantId = brandedId<SakiGrantId>('grant')
const installationAccessId = brandedId<SakiInstallationAccessId>('access')
const bootstrapChallengeId = accessChildId<SakiBootstrapChallengeId>('challenge')
const browserSessionId = accessChildId<SakiBrowserSessionId>('session')
const revision = z.number().int().nonnegative()
const ordinal = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)

/** Stable key of the one provisioning owner record. */
export const CONTROL_STATE_KEY = 'control-state' as const

/** Provisioning owner that records child identities before any child write. */
export const controlStateRecordSchema = z.object({
  schemaVersion: z.literal(1),
  revision,
  phase: z.enum(['provisioning', 'ready']),
  installationId,
  initialInstallationGenerationId: installationGenerationId,
  initialHostId: hostId,
  hostOperatorPrincipalId: principalId,
  hostOperatorGrantId: grantId,
  installationAccessId,
}).strict()

/** Parsed durable control-state record. */
export type ControlStateRecord = z.infer<typeof controlStateRecordSchema>

/** Independently revisioned Saki Installation entity. */
export const installationRecordSchema = z.object({
  id: installationId,
  revision,
  state: z.enum(['active', 'retired']),
  currentInstallationGenerationId: installationGenerationId,
  currentHostId: hostId,
}).strict()

/** Parsed durable Installation entity. */
export type InstallationRecord = z.infer<typeof installationRecordSchema>

/** Independently revisioned enrolled Host entity. */
export const hostRecordSchema = z.object({
  id: hostId,
  revision,
  installationId,
  state: z.enum(['enrolled', 'retired']),
}).strict()

/** Parsed durable Host entity. */
export type HostRecord = z.infer<typeof hostRecordSchema>

/** Independently revisioned human or automation Principal entity. */
export const principalRecordSchema = z.object({
  id: principalId,
  revision,
  kind: z.enum(['human', 'automation']),
  displayName: z.string().min(1),
  state: z.enum(['active', 'retired']),
}).strict()

/** Parsed durable Principal entity. */
export type PrincipalRecord = z.infer<typeof principalRecordSchema>

/** Independently revisioned Host Operator Grant entity. */
export const grantRecordSchema = z.object({
  id: grantId,
  revision,
  installationId,
  principalId,
  state: z.enum(['active', 'revoked']),
  actions: z.array(z.literal('project-index:read')),
}).strict()

/** Parsed durable Grant entity. */
export type GrantRecord = z.infer<typeof grantRecordSchema>

/** One digest-only Bootstrap Challenge entry. */
export const bootstrapChallengeRecordSchema = z.object({
  id: bootstrapChallengeId,
  ordinal,
  revision,
  purpose: z.enum(['initial-bootstrap', 'local-reauthentication']),
  installationId,
  installationGenerationId,
  hostId,
  principalId,
  verifierDigest: digest,
  issuedAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['issued', 'consumed', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
  browserSessionId: browserSessionId.optional(),
}).strict()

/** Parsed durable Bootstrap Challenge entry. */
export type BootstrapChallengeRecord = z.infer<typeof bootstrapChallengeRecordSchema>

/** One digest-only Browser Session entry. */
export const browserSessionRecordSchema = z.object({
  id: browserSessionId,
  ordinal,
  revision,
  installationId,
  installationGenerationId,
  principalId,
  cookieDigest: digest,
  createdAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['active', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
}).strict()

/** Parsed durable Browser Session entry. */
export type BrowserSessionRecord = z.infer<typeof browserSessionRecordSchema>

/** Immutable audit summary retained after detailed terminal records are cleaned. */
export const bootstrapCompletionRecordSchema = z.object({
  challengeId: bootstrapChallengeId,
  sessionId: browserSessionId,
  hostId,
  principalId,
  completedAt: timestamp,
}).strict()

/** Parsed durable initial-bootstrap completion summary. */
export type BootstrapCompletionRecord = z.infer<typeof bootstrapCompletionRecordSchema>

/** Single versioned Installation Access aggregate owner record. */
export const installationAccessRecordSchema = z.object({
  id: installationAccessId,
  schemaVersion: z.literal(1),
  revision,
  installationId,
  nextChallengeOrdinal: ordinal,
  nextSessionOrdinal: ordinal,
  bootstrapCompletion: bootstrapCompletionRecordSchema.optional(),
  requestTokenDerivation: z.object({
    version: z.literal(1),
    domain: z.literal('saki/browser-request-token'),
  }).strict(),
  challenges: z.array(bootstrapChallengeRecordSchema),
  sessions: z.array(browserSessionRecordSchema),
}).strict()

/** Parsed durable Installation Access aggregate. */
export type InstallationAccessRecord = z.infer<typeof installationAccessRecordSchema>

/** Saki control-plane domain declaration for B01 records. */
export const sakiControlPlaneDomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 1,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(controlStateRecordSchema),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, GrantRecord>(grantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(installationAccessRecordSchema),
  },
})
