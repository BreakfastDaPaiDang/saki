import { Context } from '@deepseek-ai/cordis'
import { generateKeyPairSync } from 'node:crypto'
import {
  CREDENTIAL_PROTECTION_EPHEMERAL,
  CREDENTIAL_PROTECTION_LOCAL_USER_TRUST,
  CredentialProvider,
} from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

export class TestCredentials extends CredentialProvider {
  /** Number of operation-time value resolutions performed by the provider. */
  resolveCalls = 0

  constructor(
    ctx: Context,
    private readonly secret: string,
    private readonly locallyProtected: boolean,
  ) {
    super(ctx)
  }

  override resolve(_ref: CredentialRef): Promise<ResolvedCredential> {
    this.resolveCalls += 1
    return Promise.resolve({
      value: this.secret,
      source: 'test-memory',
      protectionLevel: this.locallyProtected
        ? CREDENTIAL_PROTECTION_LOCAL_USER_TRUST
        : CREDENTIAL_PROTECTION_EPHEMERAL,
    })
  }

  override describe(ref: CredentialRef): Promise<CredentialInfo> {
    return Promise.resolve({
      ref,
      configured: true,
      source: 'test-memory',
      protectionLevel: this.locallyProtected
        ? CREDENTIAL_PROTECTION_LOCAL_USER_TRUST
        : CREDENTIAL_PROTECTION_EPHEMERAL,
      writable: true,
      health: 'available',
      observedAt: Date.now(),
    })
  }

  override set(): Promise<void> { return Promise.resolve() }
  override unset(): Promise<void> { return Promise.resolve() }
  override readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }
  override describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  override listRecords(): Promise<readonly CredentialRecordEntry[]> { return Promise.resolve([]) }
  override modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> { return Promise.resolve(undefined) }

  override deleteRecord(): Promise<void> { return Promise.resolve() }
}

export const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
  publicKeyEncoding: { format: 'pem', type: 'spki' },
}).privateKey

export const expectedReadPermissions = {
  actions: 'read',
  checks: 'read',
  contents: 'read',
  issues: 'read',
  metadata: 'read',
  organization_projects: 'read',
  pull_requests: 'read',
  statuses: 'read',
} as const

export const expectedProjectWritePermissions = {
  metadata: 'read',
  organization_projects: 'write',
} as const

export const expectedIssueWritePermissions = {
  issues: 'write',
  metadata: 'read',
} as const

export const expectedIssueReadPermissions = {
  issues: 'read',
  metadata: 'read',
} as const

export const expectedPullRequestWritePermissions = {
  metadata: 'read',
  pull_requests: 'write',
} as const

export const expectedPullRequestReadPermissions = {
  metadata: 'read',
  pull_requests: 'read',
} as const

export const expectedProjectReadPermissions = {
  issues: 'read',
  metadata: 'read',
  organization_projects: 'read',
} as const

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  })
}
