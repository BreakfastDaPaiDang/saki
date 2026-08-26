/** Historical schemas and pure Saki control-plane migration. @module @breakfastdapaidang/saki-control-plane/src/migration */

import type { z } from 'zod'
import type { DomainMigrationSnapshot } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, defineDomainMigrations, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import { recoverBootstrapCompletion } from './bootstrap-completion.ts'
import { sakiStorageGenerationIdSchema } from './ids.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  controlStateRecordSchema,
  developmentProjectRegistryRecordSchema,
  HOST_OPERATOR_ACTIONS,
  historicalGrantRecordSchema,
  historicalControlStateRecordSchema,
  historicalInstallationAccessRecordSchema,
  historicalInstallationRecordSchema,
  historicalRegistrationIntentRecordSchema,
  hostRecordSchema,
  installationAccessRecordSchema,
  installationRecordSchema,
  principalRecordSchema,
  registrationIntentRecordSchema,
  sakiControlPlaneDomainSpec,
} from './spec.ts'
import type {
  ControlStateRecord,
  DevelopmentProjectRegistryRecord,
  GrantRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  PrincipalRecord,
  RegistrationIntentRecord,
} from './spec.ts'
import type {
  SakiControlIntentId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationGenerationId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from './types.ts'

type HistoricalControlStateRecord = z.infer<typeof historicalControlStateRecordSchema>
type HistoricalInstallationRecord = z.infer<typeof historicalInstallationRecordSchema>
type HistoricalInstallationAccessRecord = z.infer<typeof historicalInstallationAccessRecordSchema>
type HistoricalRegistrationIntentRecord = z.infer<typeof historicalRegistrationIntentRecordSchema>
type HistoricalGrantRecord = z.infer<typeof historicalGrantRecordSchema>

/** Exact B03 control-plane schema accepted as the sole v2 migration source. */
export const sakiControlPlaneV2DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 2,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, HistoricalControlStateRecord>(
      historicalControlStateRecordSchema,
    ),
    installations: domainTable<SakiInstallationId, HistoricalInstallationRecord>(historicalInstallationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, HistoricalGrantRecord>(historicalGrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, HistoricalInstallationAccessRecord>(
      historicalInstallationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryRecord
    >(developmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, HistoricalRegistrationIntentRecord>(
      historicalRegistrationIntentRecordSchema,
    ),
  },
})

/** Exact post-B18 v3 control-plane schema retained as the adjacent B05 migration source. */
export const sakiControlPlaneV3DomainSpec = defineDomain({
  name: 'saki_control_plane',
  version: 3,
  tables: {
    control_state: domainTable<typeof CONTROL_STATE_KEY, ControlStateRecord>(
      controlStateRecordSchema,
    ),
    installations: domainTable<SakiInstallationId, InstallationRecord>(installationRecordSchema),
    hosts: domainTable<SakiHostId, HostRecord>(hostRecordSchema),
    principals: domainTable<SakiPrincipalId, PrincipalRecord>(principalRecordSchema),
    grants: domainTable<SakiGrantId, HistoricalGrantRecord>(historicalGrantRecordSchema),
    installation_access: domainTable<SakiInstallationAccessId, InstallationAccessRecord>(
      installationAccessRecordSchema,
    ),
    development_project_registry: domainTable<
      typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      DevelopmentProjectRegistryRecord
    >(developmentProjectRegistryRecordSchema),
    registration_intents: domainTable<SakiControlIntentId, RegistrationIntentRecord>(
      registrationIntentRecordSchema,
    ),
  },
})

function sourceTable<T>(snapshot: DomainMigrationSnapshot, name: string): Readonly<Record<string, T>> {
  return snapshot.tables[name] as Readonly<Record<string, T>>
}

function mapTable<S, T>(records: Readonly<Record<string, S>>, transform: (value: S) => T): Record<string, T> {
  return Object.fromEntries(Object.entries(records).map(([key, value]) => [key, transform(value)]))
}

/**
 * Retain historical generation attribution under the v3 storage-generation identity vocabulary.
 * @param value - schema-validated historical Installation State Generation identity.
 * @returns the corresponding retained storage-generation identity.
 */
export function migratedStorageGenerationId(
  value: SakiInstallationGenerationId,
): SakiStorageGenerationId {
  const uuid = value.slice('installation-generation-'.length)
  return sakiStorageGenerationIdSchema.parse(`storage-generation-${uuid}`)
}

function migrateControlState(value: HistoricalControlStateRecord): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...value }
  delete migrated['initialInstallationGenerationId']
  migrated['schemaVersion'] = 2
  return migrated
}

function migrateInstallation(value: HistoricalInstallationRecord): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...value }
  delete migrated['currentInstallationGenerationId']
  return migrated
}

function migratedBootstrapCompletion(
  value: HistoricalInstallationAccessRecord,
): HistoricalInstallationAccessRecord['bootstrapCompletion'] {
  if (value.bootstrapCompletion !== undefined) return value.bootstrapCompletion
  return recoverBootstrapCompletion(value, 'B03 Installation Access')
}

function migrateInstallationAccess(value: HistoricalInstallationAccessRecord): Record<string, unknown> {
  const bootstrapCompletion = migratedBootstrapCompletion(value)
  return {
    ...value,
    schemaVersion: 2,
    ...(bootstrapCompletion === undefined ? {} : { bootstrapCompletion }),
    challenges: value.challenges.map((challenge) => {
      const migrated: Record<string, unknown> = { ...challenge }
      delete migrated['installationGenerationId']
      migrated['storageGenerationId'] = migratedStorageGenerationId(challenge.installationGenerationId)
      return migrated
    }),
    sessions: value.sessions.map((session) => {
      const migrated: Record<string, unknown> = { ...session }
      delete migrated['installationGenerationId']
      migrated['storageGenerationId'] = migratedStorageGenerationId(session.installationGenerationId)
      return migrated
    }),
  }
}

function migrateRegistrationIntent(value: HistoricalRegistrationIntentRecord): Record<string, unknown> {
  const actor: Record<string, unknown> = { ...value.payload.actor }
  delete actor['installationGenerationId']
  actor['storageGenerationId'] = migratedStorageGenerationId(value.payload.actor.installationGenerationId)
  const payload = { ...value.payload, actor }
  return {
    ...value,
    schemaVersion: 2,
    payload,
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
  }
}

function migrateGrantsToV4(snapshot: DomainMigrationSnapshot): Record<string, GrantRecord> {
  const control = sourceTable<ControlStateRecord>(snapshot, 'control_state')[CONTROL_STATE_KEY]
  return Object.fromEntries(Object.entries(sourceTable<HistoricalGrantRecord>(snapshot, 'grants')).map(([key, value]) => {
    if (key !== control?.hostOperatorGrantId) return [key, value]
    return [key, {
      ...value,
      revision: value.revision + 1,
      actions: [...HOST_OPERATOR_ACTIONS],
    }]
  }))
}

/** Pure retained migration chain from exact B03 v2 media through frozen v3 to current v4 records. */
export const sakiControlPlaneMigrationPlan = defineDomainMigrations({
  current: sakiControlPlaneDomainSpec,
  steps: [
    {
      from: sakiControlPlaneV2DomainSpec,
      to: sakiControlPlaneV3DomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          control_state: mapTable(
            sourceTable<HistoricalControlStateRecord>(snapshot, 'control_state'),
            migrateControlState,
          ),
          installations: mapTable(
            sourceTable<HistoricalInstallationRecord>(snapshot, 'installations'),
            migrateInstallation,
          ),
          hosts: { ...sourceTable<HostRecord>(snapshot, 'hosts') },
          principals: { ...sourceTable<PrincipalRecord>(snapshot, 'principals') },
          grants: { ...sourceTable<HistoricalGrantRecord>(snapshot, 'grants') },
          installation_access: mapTable(
            sourceTable<HistoricalInstallationAccessRecord>(snapshot, 'installation_access'),
            migrateInstallationAccess,
          ),
          development_project_registry: {
            ...sourceTable<DevelopmentProjectRegistryRecord>(snapshot, 'development_project_registry'),
          },
          registration_intents: mapTable(
            sourceTable<HistoricalRegistrationIntentRecord>(snapshot, 'registration_intents'),
            migrateRegistrationIntent,
          ),
        },
      }),
    },
    {
      from: sakiControlPlaneV3DomainSpec,
      to: sakiControlPlaneDomainSpec,
      migrate: snapshot => ({
        global: snapshot.global,
        tables: {
          control_state: { ...sourceTable<ControlStateRecord>(snapshot, 'control_state') },
          installations: { ...sourceTable<InstallationRecord>(snapshot, 'installations') },
          hosts: { ...sourceTable<HostRecord>(snapshot, 'hosts') },
          principals: { ...sourceTable<PrincipalRecord>(snapshot, 'principals') },
          grants: migrateGrantsToV4(snapshot),
          installation_access: { ...sourceTable<InstallationAccessRecord>(snapshot, 'installation_access') },
          development_project_registry: {
            ...sourceTable<DevelopmentProjectRegistryRecord>(snapshot, 'development_project_registry'),
          },
          registration_intents: { ...sourceTable<RegistrationIntentRecord>(snapshot, 'registration_intents') },
          github_project_sync: {},
          github_sync_configuration_intents: {},
        },
      }),
    },
  ],
})
