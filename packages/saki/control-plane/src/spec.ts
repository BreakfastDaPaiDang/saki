/** Durable Saki bootstrap and authority record schemas. @module @breakfastdapaidang/saki-control-plane/src/spec */

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

const branded = <T extends string>() => z.string().min(1).transform(value => value as T)
const revision = z.number().int().nonnegative()
const timestamp = z.number().int().nonnegative()
const digest = z.string().regex(/^[0-9a-f]{64}$/)

/** Stable key of the one foundation record. */
export const FOUNDATION_KEY = 'foundation' as const
/** Stable key of the one Installation Access aggregate owner record. */
export const INSTALLATION_ACCESS_KEY = 'installation-access' as const

/** Durable Installation, Host, Principal, and Host Operator Grant facts. */
export const foundationRecordSchema = z.object({
  schemaVersion: z.literal(1),
  installation: z.object({
    id: branded<SakiInstallationId>(),
    generationId: branded<SakiInstallationGenerationId>(),
    state: z.literal('active'),
  }).strict(),
  host: z.object({
    id: branded<SakiHostId>(),
    installationId: branded<SakiInstallationId>(),
    state: z.literal('enrolled'),
  }).strict(),
  principal: z.object({
    id: branded<SakiPrincipalId>(),
    kind: z.literal('human'),
    displayName: z.string().min(1),
    state: z.enum(['active', 'retired']),
  }).strict(),
  grant: z.object({
    id: branded<SakiGrantId>(),
    principalId: branded<SakiPrincipalId>(),
    revision: revision,
    state: z.enum(['active', 'revoked']),
    actions: z.array(z.literal('project-index:read')),
    installationId: branded<SakiInstallationId>(),
  }).strict(),
}).strict()

/** Parsed durable foundation record. */
export type FoundationRecord = z.infer<typeof foundationRecordSchema>

/** One digest-only Bootstrap Challenge entry. */
export const bootstrapChallengeRecordSchema = z.object({
  id: branded<SakiBootstrapChallengeId>(),
  revision: revision,
  installationId: branded<SakiInstallationId>(),
  generationId: branded<SakiInstallationGenerationId>(),
  hostId: branded<SakiHostId>(),
  principalId: branded<SakiPrincipalId>(),
  verifierDigest: digest,
  issuedAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['issued', 'consumed', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
  browserSessionId: branded<SakiBrowserSessionId>().optional(),
}).strict()

/** Parsed durable Bootstrap Challenge entry. */
export type BootstrapChallengeRecord = z.infer<typeof bootstrapChallengeRecordSchema>

/** One digest-only Browser Session entry. */
export const browserSessionRecordSchema = z.object({
  id: branded<SakiBrowserSessionId>(),
  revision: revision,
  installationId: branded<SakiInstallationId>(),
  generationId: branded<SakiInstallationGenerationId>(),
  principalId: branded<SakiPrincipalId>(),
  cookieDigest: digest,
  createdAt: timestamp,
  expiresAt: timestamp,
  state: z.enum(['active', 'expired', 'revoked']),
  terminalAt: timestamp.optional(),
}).strict()

/** Parsed durable Browser Session entry. */
export type BrowserSessionRecord = z.infer<typeof browserSessionRecordSchema>

/** Single versioned Installation Access aggregate owner record. */
export const installationAccessRecordSchema = z.object({
  id: branded<SakiInstallationAccessId>(),
  schemaVersion: z.literal(1),
  revision,
  installationId: branded<SakiInstallationId>(),
  bootstrapCompleted: z.boolean(),
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
    foundation: domainTable<typeof FOUNDATION_KEY, FoundationRecord>(foundationRecordSchema),
    installation_access: domainTable<typeof INSTALLATION_ACCESS_KEY, InstallationAccessRecord>(installationAccessRecordSchema),
  },
})
