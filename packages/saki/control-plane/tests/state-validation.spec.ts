import { describe, expect, it } from 'vitest'
import type { Domain, KvTable, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import { canonicalDigest } from '@breakfastdapaidang/saki-execution'
import {
  SAKI_PROJECT_PROJECTION_FIXTURES,
  SAKI_PROJECT_REQUEST_FIXTURES,
} from '../src/fixtures.ts'
import { sakiControlPlaneV2DomainSpec } from '../src/migration.ts'
import {
  CONTROL_STATE_KEY,
  DEVELOPMENT_PROJECT_REGISTRY_KEY,
  controlStateRecordSchema,
  developmentProjectRegistryRecordSchema,
  grantRecordSchema,
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
} from '../src/spec.ts'
import type {
  ControlStateRecord,
  DevelopmentProjectRegistryRecord,
  GrantRecord,
  HostRecord,
  InstallationAccessRecord,
  InstallationRecord,
  PrincipalRecord,
  RegistrationIntentRecord,
} from '../src/spec.ts'
import {
  validateCurrentSakiState,
  validateSakiV2SourceState,
} from '../src/state-validation.ts'
import {
  createStorageGenerationSeal,
  sakiStorageGenerationDomainSpec,
  STORAGE_GENERATION_KEY,
} from '../src/state-version.ts'
import type { StorageGenerationSealRecord } from '../src/state-version.ts'
import type {
  SakiBuildId,
  SakiControlIntentId,
  SakiGrantId,
  SakiHostId,
  SakiInstallationAccessId,
  SakiInstallationId,
  SakiPrincipalId,
  SakiStorageGenerationId,
} from '../src/types.ts'

const INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000001' as SakiInstallationId
const OTHER_INSTALLATION_ID = 'installation-00000000-0000-4000-8000-000000000101' as SakiInstallationId
const STORAGE_GENERATION_ID = 'storage-generation-00000000-0000-4000-8000-000000000002' as SakiStorageGenerationId
const OTHER_STORAGE_GENERATION_ID =
  'storage-generation-00000000-0000-4000-8000-000000000102' as SakiStorageGenerationId
const HOST_ID = 'host-00000000-0000-4000-8000-000000000002' as SakiHostId
const OTHER_HOST_ID = 'host-00000000-0000-4000-8000-000000000102' as SakiHostId
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000003' as SakiPrincipalId
const GRANT_ID = 'grant-00000000-0000-4000-8000-000000000004' as SakiGrantId
const OTHER_GRANT_ID = 'grant-00000000-0000-4000-8000-000000000104' as SakiGrantId
const ACCESS_ID = 'access-00000000-0000-4000-8000-000000000005' as SakiInstallationAccessId
const OTHER_ACCESS_ID = 'access-00000000-0000-4000-8000-000000000105' as SakiInstallationAccessId
const BUILD_ID = 'saki-build-state-validation-test' as SakiBuildId
const INITIAL_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000002'
const CURRENT_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000003'
const OTHER_INSTALLATION_GENERATION_ID = 'installation-generation-00000000-0000-4000-8000-000000000104'

interface CurrentFixture {
  readonly controlState: Map<typeof CONTROL_STATE_KEY, ControlStateRecord>
  readonly installations: Map<SakiInstallationId, InstallationRecord>
  readonly hosts: Map<SakiHostId, HostRecord>
  readonly principals: Map<SakiPrincipalId, PrincipalRecord>
  readonly grants: Map<SakiGrantId, GrantRecord>
  readonly access: Map<SakiInstallationAccessId, InstallationAccessRecord>
  readonly registries: Map<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
  readonly intents: Map<SakiControlIntentId, RegistrationIntentRecord>
  readonly seals: Map<string, StorageGenerationSealRecord>
}

type HistoricalControl = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'control_state'>
type HistoricalInstallation = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installations'>
type HistoricalAccess = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'installation_access'>
type HistoricalIntent = TableValueOf<typeof sakiControlPlaneV2DomainSpec, 'registration_intents'>

interface HistoricalFixture {
  readonly controlState: Map<typeof CONTROL_STATE_KEY, HistoricalControl>
  readonly installations: Map<SakiInstallationId, HistoricalInstallation>
  readonly hosts: Map<SakiHostId, HostRecord>
  readonly principals: Map<SakiPrincipalId, PrincipalRecord>
  readonly grants: Map<SakiGrantId, GrantRecord>
  readonly access: Map<SakiInstallationAccessId, HistoricalAccess>
  readonly registries: Map<typeof DEVELOPMENT_PROJECT_REGISTRY_KEY, DevelopmentProjectRegistryRecord>
  readonly intents: Map<SakiControlIntentId, HistoricalIntent>
}

function currentFixture(): CurrentFixture {
  const control = controlStateRecordSchema.parse({
    schemaVersion: 2,
    revision: 1,
    phase: 'ready',
    installationId: INSTALLATION_ID,
    initialHostId: HOST_ID,
    hostOperatorPrincipalId: PRINCIPAL_ID,
    hostOperatorGrantId: GRANT_ID,
    installationAccessId: ACCESS_ID,
  })
  const installation = installationRecordSchema.parse({
    id: INSTALLATION_ID,
    revision: 1,
    state: 'active',
    currentHostId: HOST_ID,
  })
  const host = hostRecordSchema.parse({
    id: HOST_ID,
    revision: 1,
    installationId: INSTALLATION_ID,
    state: 'enrolled',
  })
  const principal = principalRecordSchema.parse({
    id: PRINCIPAL_ID,
    revision: 4,
    kind: 'human',
    displayName: 'Host Operator',
    state: 'active',
  })
  const grant = grantRecordSchema.parse({
    id: GRANT_ID,
    revision: 5,
    installationId: INSTALLATION_ID,
    principalId: PRINCIPAL_ID,
    state: 'active',
    actions: ['development-project:register'],
    scope: { kind: 'installation', installationId: INSTALLATION_ID },
  })
  const access = installationAccessRecordSchema.parse({
    id: ACCESS_ID,
    schemaVersion: 2,
    revision: 0,
    installationId: INSTALLATION_ID,
    nextChallengeOrdinal: 0,
    nextSessionOrdinal: 0,
    requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
    challenges: [],
    sessions: [],
  })
  const registry = developmentProjectRegistryRecordSchema.parse({
    id: DEVELOPMENT_PROJECT_REGISTRY_KEY,
    schemaVersion: 1,
    revision: 0,
    projects: [],
    resourceBindings: [],
    canonicalWorktreeIndex: [],
    gitDirectoryIndex: [],
    intentMappings: [],
  })
  return {
    controlState: new Map([[CONTROL_STATE_KEY, control]]),
    installations: new Map([[INSTALLATION_ID, installation]]),
    hosts: new Map([[HOST_ID, host]]),
    principals: new Map([[PRINCIPAL_ID, principal]]),
    grants: new Map([[GRANT_ID, grant]]),
    access: new Map([[ACCESS_ID, access]]),
    registries: new Map([[DEVELOPMENT_PROJECT_REGISTRY_KEY, registry]]),
    intents: new Map(),
    seals: new Map([[
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID),
    ]]),
  }
}

function historicalFixture(): HistoricalFixture {
  const current = currentFixture()
  const control = historicalControlStateRecordSchema.parse({
    ...current.controlState.get(CONTROL_STATE_KEY),
    schemaVersion: 1,
    initialInstallationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
  })
  const installation = historicalInstallationRecordSchema.parse({
    ...current.installations.get(INSTALLATION_ID),
    currentInstallationGenerationId: CURRENT_INSTALLATION_GENERATION_ID,
  })
  const challengeId = `${ACCESS_ID}:challenge:0`
  const sessionId = `${ACCESS_ID}:session:0`
  const access = historicalInstallationAccessRecordSchema.parse({
    id: ACCESS_ID,
    schemaVersion: 1,
    revision: 2,
    installationId: INSTALLATION_ID,
    nextChallengeOrdinal: 1,
    nextSessionOrdinal: 1,
    bootstrapCompletion: {
      challengeId,
      sessionId,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      completedAt: 11,
    },
    requestTokenDerivation: { version: 1, domain: 'saki/browser-request-token' },
    challenges: [{
      id: challengeId,
      ordinal: 0,
      revision: 1,
      purpose: 'initial-bootstrap',
      installationId: INSTALLATION_ID,
      installationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
      hostId: HOST_ID,
      principalId: PRINCIPAL_ID,
      verifierDigest: 'a'.repeat(64),
      issuedAt: 10,
      expiresAt: 20,
      state: 'consumed',
      terminalAt: 11,
      browserSessionId: sessionId,
    }],
    sessions: [{
      id: sessionId,
      ordinal: 0,
      revision: 0,
      installationId: INSTALLATION_ID,
      installationGenerationId: INITIAL_INSTALLATION_GENERATION_ID,
      principalId: PRINCIPAL_ID,
      cookieDigest: 'b'.repeat(64),
      createdAt: 11,
      expiresAt: 21,
      state: 'active',
    }],
  })
  const intent = historicalIntent(CURRENT_INSTALLATION_GENERATION_ID, GRANT_ID)
  return {
    controlState: new Map([[CONTROL_STATE_KEY, control]]),
    installations: new Map([[INSTALLATION_ID, installation]]),
    hosts: current.hosts,
    principals: current.principals,
    grants: current.grants,
    access: new Map([[ACCESS_ID, access]]),
    registries: current.registries,
    intents: new Map([[intent.id, intent]]),
  }
}

function historicalIntent(installationGenerationId: string, grantId: SakiGrantId): HistoricalIntent {
  const actor = {
    installationId: INSTALLATION_ID,
    installationGenerationId,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId,
    grantRevision: 5,
  }
  const payload = { intent: SAKI_PROJECT_REQUEST_FIXTURES.registration, actor }
  const id = SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId
  return historicalRegistrationIntentRecordSchema.parse({
    id,
    schemaVersion: 1,
    revision: 0,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    payload,
    inspection: fixtureInspection(),
    phase: 'prepared',
    createdAt: 12,
    updatedAt: 12,
  })
}

function currentIntent(): RegistrationIntentRecord {
  const actor = {
    installationId: INSTALLATION_ID,
    storageGenerationId: STORAGE_GENERATION_ID,
    hostId: HOST_ID,
    principalId: PRINCIPAL_ID,
    principalRevision: 4,
    grantId: GRANT_ID,
    grantRevision: 5,
  }
  const payload = { intent: SAKI_PROJECT_REQUEST_FIXTURES.registration, actor }
  const id = SAKI_PROJECT_REQUEST_FIXTURES.registration.intentId
  return registrationIntentRecordSchema.parse({
    id,
    schemaVersion: 2,
    revision: 0,
    receiptId: id.replace(/^intent-/u, 'receipt-'),
    payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    payload,
    inspection: fixtureInspection(),
    phase: 'prepared',
    createdAt: 12,
    updatedAt: 12,
  })
}

function fixtureInspection() {
  return {
    projection: SAKI_PROJECT_PROJECTION_FIXTURES.cleanSelection,
    trusted: {
      canonicalWorktreePath: '/fixture/repository',
      canonicalGitDirectory: '/fixture/repository/.git',
      canonicalCommonGitDirectory: '/fixture/repository/.git',
      gitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      commonGitDirectoryIdentity: { version: 1, digest: '4'.repeat(64) },
      comparison: { fileMode: true, symlinks: true, autocrlf: false },
    },
  }
}

function currentDomains(fixture: CurrentFixture) {
  const tables = {
    control_state: readonlyTable(fixture.controlState),
    installations: readonlyTable(fixture.installations),
    hosts: readonlyTable(fixture.hosts),
    principals: readonlyTable(fixture.principals),
    grants: readonlyTable(fixture.grants),
    installation_access: readonlyTable(fixture.access),
    development_project_registry: readonlyTable(fixture.registries),
    registration_intents: readonlyTable(fixture.intents),
    github_project_sync: readonlyTable(new Map()),
    github_sync_configuration_intents: readonlyTable(new Map()),
  }
  const controlPlane = {
    name: sakiControlPlaneDomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneDomainSpec>
  const storageTables = { storage_generation: readonlyTable(fixture.seals) }
  const storageGeneration = {
    name: sakiStorageGenerationDomainSpec.name,
    table: (name: keyof typeof storageTables) => storageTables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiStorageGenerationDomainSpec>
  return { controlPlane, storageGeneration }
}

function historicalDomain(fixture: HistoricalFixture): Domain<typeof sakiControlPlaneV2DomainSpec> {
  const tables = {
    control_state: readonlyTable(fixture.controlState),
    installations: readonlyTable(fixture.installations),
    hosts: readonlyTable(fixture.hosts),
    principals: readonlyTable(fixture.principals),
    grants: readonlyTable(fixture.grants),
    installation_access: readonlyTable(fixture.access),
    development_project_registry: readonlyTable(fixture.registries),
    registration_intents: readonlyTable(fixture.intents),
  }
  return {
    name: sakiControlPlaneV2DomainSpec.name,
    table: (name: keyof typeof tables) => tables[name],
    close: rejectUnexpectedMutation,
  } as unknown as Domain<typeof sakiControlPlaneV2DomainSpec>
}

function readonlyTable<K extends string, V>(records: ReadonlyMap<K, V>): KvTable<K, V> {
  return {
    get: key => records.get(key),
    entries: () => [...records.entries()][Symbol.iterator](),
    keys: () => [...records.keys()][Symbol.iterator](),
    get size() { return records.size },
    put: rejectUnexpectedMutation,
    delete: rejectUnexpectedMutation,
    update: rejectUnexpectedMutation,
  }
}

function rejectUnexpectedMutation<T>(): Promise<T> {
  return Promise.reject(new Error('pure validation attempted a mutation'))
}

function requiredMapRecord<K, V>(records: ReadonlyMap<K, V>, key: K): V {
  const record = records.get(key)
  if (record === undefined) throw new Error('test fixture record is missing')
  return record
}

describe('current Saki state validation', () => {
  it('accepts a complete ready generation without writes or external calls', () => {
    const fixture = currentFixture()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })

  it('rejects a missing current control singleton', () => {
    const fixture = currentFixture()
    fixture.controlState.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('control state is not the required singleton')
  })

  it('rejects unfinished current provisioning', () => {
    const fixture = currentFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, phase: 'provisioning' })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('provisioning is not ready')
  })

  it('rejects a current control owner other than the selected Installation', () => {
    const fixture = currentFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, installationId: OTHER_INSTALLATION_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('control state belongs to another Installation')
  })

  it('rejects a non-human current Host Operator', () => {
    const fixture = currentFixture()
    const principal = requiredMapRecord(fixture.principals, PRINCIPAL_ID)
    fixture.principals.set(PRINCIPAL_ID, { ...principal, kind: 'automation' })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host Operator Principal must be human')
  })

  it('rejects inconsistent current Foundation relationships', () => {
    const fixture = currentFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, installationId: OTHER_INSTALLATION_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Foundation relationships are inconsistent')
  })

  it('rejects an invalid current Access singleton count', () => {
    const fixture = currentFixture()
    fixture.access.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Installation Access is not the required singleton')
  })

  it('rejects a current Access singleton owned under another key', () => {
    const fixture = currentFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.clear()
    fixture.access.set(OTHER_ACCESS_ID, { ...access, id: OTHER_ACCESS_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('belongs to another provisioning owner')
  })

  it('rejects a current record whose id disagrees with its table key', () => {
    const fixture = currentFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, id: OTHER_HOST_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('record id disagrees with its table key')
  })

  it('rejects a Foundation reference to a missing current Host', () => {
    const fixture = currentFixture()
    const installation = requiredMapRecord(fixture.installations, INSTALLATION_ID)
    fixture.installations.set(INSTALLATION_ID, { ...installation, currentHostId: OTHER_HOST_ID })
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host')
  })

  it('rejects an Access challenge that references a missing Host', () => {
    const fixture = currentFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, installationAccessRecordSchema.parse({
      ...access,
      nextChallengeOrdinal: 1,
      challenges: [{
        id: `${ACCESS_ID}:challenge:0`,
        ordinal: 0,
        revision: 0,
        purpose: 'initial-bootstrap',
        installationId: INSTALLATION_ID,
        storageGenerationId: STORAGE_GENERATION_ID,
        hostId: OTHER_HOST_ID,
        principalId: PRINCIPAL_ID,
        verifierDigest: 'a'.repeat(64),
        issuedAt: 10,
        expiresAt: 20,
        state: 'issued',
      }],
    }))
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Host')
  })

  it('rejects registration Intents without the Registry singleton', () => {
    const fixture = currentFixture()
    const intent = currentIntent()
    fixture.intents.set(intent.id, intent)
    fixture.registries.clear()
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('Intents exist without the Project Registry')
  })

  it('rejects a registration actor whose captured Principal revision is from the future', () => {
    const fixture = currentFixture()
    const intent = currentIntent()
    const payload = {
      ...intent.payload,
      actor: {
        ...intent.payload.actor,
        principalRevision: intent.payload.actor.principalRevision + 1,
      },
    }
    fixture.intents.set(intent.id, registrationIntentRecordSchema.parse({
      ...intent,
      payload,
      payloadDigest: canonicalDigest('saki/register-development-project/v1', payload),
    }))
    const domains = currentDomains(fixture)

    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('registration Intent actor reference is inconsistent')
  })

  it.each([
    ['Installation', OTHER_INSTALLATION_ID, STORAGE_GENERATION_ID],
    ['physical generation', INSTALLATION_ID, OTHER_STORAGE_GENERATION_ID],
  ] as const)('rejects a seal for another %s', (_name, installationId, generationId) => {
    const fixture = currentFixture()
    fixture.seals.set(
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(installationId, generationId, BUILD_ID),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow(`another ${_name}`)
  })

  it('rejects seal provenance that disagrees with generation.json', () => {
    const fixture = currentFixture()
    fixture.seals.set(
      STORAGE_GENERATION_KEY,
      createStorageGenerationSeal(
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        'saki-build-other' as SakiBuildId,
      ),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('build provenance')
  })

  it('rejects a non-singleton storage-generation seal table', () => {
    const fixture = currentFixture()
    fixture.seals.set(
      'storage-generation-shadow',
      createStorageGenerationSeal(INSTALLATION_ID, STORAGE_GENERATION_ID, BUILD_ID),
    )
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).toThrow('required singleton')
  })

  it('retains unreferenced Foundation history without imposing current-owner relationships', () => {
    const fixture = currentFixture()
    fixture.installations.set(OTHER_INSTALLATION_ID, installationRecordSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'retired',
      currentHostId: OTHER_HOST_ID,
    }))
    const domains = currentDomains(fixture)
    expect(() => {
      validateCurrentSakiState(
        domains.controlPlane,
        domains.storageGeneration,
        INSTALLATION_ID,
        STORAGE_GENERATION_ID,
        BUILD_ID,
      )
    }).not.toThrow()
  })
})

describe('historical Saki v2 source validation', () => {
  it('accepts initial and current Foundation generation references without writes', () => {
    const fixture = historicalFixture()
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects unfinished historical provisioning', () => {
    const fixture = historicalFixture()
    const control = requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY)
    fixture.controlState.set(CONTROL_STATE_KEY, { ...control, phase: 'provisioning' })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('provisioning is not ready')
  })

  it('rejects a non-human historical Host Operator', () => {
    const fixture = historicalFixture()
    const principal = requiredMapRecord(fixture.principals, PRINCIPAL_ID)
    fixture.principals.set(PRINCIPAL_ID, { ...principal, kind: 'automation' })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Host Operator Principal must be human')
  })

  it('rejects inconsistent historical Foundation relationships', () => {
    const fixture = historicalFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, installationId: OTHER_INSTALLATION_ID })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Foundation relationships are inconsistent')
  })

  it('rejects a historical record whose id disagrees with its table key', () => {
    const fixture = historicalFixture()
    const host = requiredMapRecord(fixture.hosts, HOST_ID)
    fixture.hosts.set(HOST_ID, { ...host, id: OTHER_HOST_ID })
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('record id disagrees with its table key')
  })

  it('accepts exact B03 bootstrap evidence whose completion summary is absent', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse(withoutCompletion))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it.each([
    ['empty', undefined],
    ['issued', 'issued'],
    ['terminal', 'expired'],
  ] as const)('accepts %s exact B03 Access before bootstrap completion', (_name, state) => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    const retained = access.challenges[0]!
    const challenges = state === undefined
      ? []
      : [{
        ...retained,
        revision: state === 'issued' ? 0 : 1,
        state,
        terminalAt: state === 'issued' ? undefined : retained.expiresAt,
        browserSessionId: undefined,
      }]
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      nextChallengeOrdinal: challenges.length,
      nextSessionOrdinal: 0,
      challenges,
      sessions: [],
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects missing B03 completion evidence after a Browser Session was allocated', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      nextChallengeOrdinal: 0,
      nextSessionOrdinal: 1,
      challenges: [],
      sessions: [],
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('deterministic bootstrap completion evidence')
  })

  it('rejects exact B03 state whose absent completion cannot be reconstructed', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    const { bootstrapCompletion: _completion, ...withoutCompletion } = access
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...withoutCompletion,
      challenges: withoutCompletion.challenges.map(challenge => ({
        ...challenge,
        revision: 1,
        state: 'expired',
        terminalAt: challenge.expiresAt,
        browserSessionId: undefined,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('bootstrap completion evidence')
  })

  it('rejects a historical Bootstrap Challenge whose child identity disagrees with its ordinal', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        id: `${ACCESS_ID}:challenge:1`,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('invalid Bootstrap Challenge')
  })

  it('compares historical consumed pairs by Installation State Generation', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      sessions: access.sessions.map(session => ({
        ...session,
        installationGenerationId: CURRENT_INSTALLATION_GENERATION_ID,
      })),
    }))

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('consumed Bootstrap Challenge references an inconsistent Browser Session')
  })

  it('rejects a historical Project Registry with an invalid singleton key', () => {
    const fixture = historicalFixture()
    fixture.registries.set(
      'shadow-project-registry' as typeof DEVELOPMENT_PROJECT_REGISTRY_KEY,
      requiredMapRecord(fixture.registries, DEVELOPMENT_PROJECT_REGISTRY_KEY),
    )

    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('invalid singleton key')
  })

  it('rejects a control owner other than the selected Installation', () => {
    const fixture = historicalFixture()
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), OTHER_INSTALLATION_ID)
    }).toThrow('belongs to another Installation')
  })

  it('accepts terminal Access history from outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
      sessions: access.sessions.map(session => ({
        ...session,
        revision: 1,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
        state: 'revoked',
        terminalAt: 12,
      })),
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects an issued Access challenge outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      nextChallengeOrdinal: 2,
      challenges: [...access.challenges, {
        id: `${ACCESS_ID}:challenge:1`,
        ordinal: 1,
        revision: 0,
        purpose: 'local-reauthentication',
        installationId: INSTALLATION_ID,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
        hostId: HOST_ID,
        principalId: PRINCIPAL_ID,
        verifierDigest: 'c'.repeat(64),
        issuedAt: 12,
        expiresAt: 22,
        state: 'issued',
      }],
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('issued Bootstrap Challenge references an unrelated Installation State Generation')
  })

  it('rejects an active Access session outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const access = requiredMapRecord(fixture.access, ACCESS_ID)
    fixture.access.set(ACCESS_ID, historicalInstallationAccessRecordSchema.parse({
      ...access,
      challenges: access.challenges.map(challenge => ({
        ...challenge,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
      sessions: access.sessions.map(session => ({
        ...session,
        installationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      })),
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('active Browser Session references an unrelated Installation State Generation')
  })

  it('rejects a registration actor outside the initial and current generations', () => {
    const fixture = historicalFixture()
    const intent = historicalIntent(OTHER_INSTALLATION_GENERATION_ID, GRANT_ID)
    fixture.intents.set(intent.id, intent)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('unrelated Installation State Generation')
  })

  it('does not impose current-Foundation relationships on unreferenced B03 records', () => {
    const fixture = historicalFixture()
    fixture.installations.set(OTHER_INSTALLATION_ID, historicalInstallationRecordSchema.parse({
      id: OTHER_INSTALLATION_ID,
      revision: 0,
      state: 'retired',
      currentInstallationGenerationId: OTHER_INSTALLATION_GENERATION_ID,
      currentHostId: OTHER_HOST_ID,
    }))
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).not.toThrow()
  })

  it('rejects a historical registration actor whose Grant is absent', () => {
    const fixture = historicalFixture()
    const intent = historicalIntent(CURRENT_INSTALLATION_GENERATION_ID, OTHER_GRANT_ID)
    fixture.intents.set(intent.id, intent)
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    }).toThrow('Grant')
  })

  it('rejects a non-singleton historical control owner', () => {
    const fixture = historicalFixture()
    fixture.controlState.set(
      'shadow-control' as typeof CONTROL_STATE_KEY,
      requiredMapRecord(fixture.controlState, CONTROL_STATE_KEY),
    )
    expect(() => {
      validateSakiV2SourceState(historicalDomain(fixture), INSTALLATION_ID)
    })
      .toThrow('required singleton')
  })
})
