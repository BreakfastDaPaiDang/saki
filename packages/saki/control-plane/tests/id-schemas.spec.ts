import { describe, expect, it } from 'vitest'
import {
  bootstrapChallengeRecordSchema,
  bootstrapCompletionRecordSchema,
  browserSessionRecordSchema,
  controlStateRecordSchema,
  grantRecordSchema,
  hostRecordSchema,
  installationAccessRecordSchema,
  installationRecordSchema,
  principalRecordSchema,
} from '../src/spec.ts'

const UUIDS = {
  installation: '00000000-0000-4000-8000-000000000001',
  generation: '00000000-0000-4000-8000-000000000002',
  host: '00000000-0000-4000-8000-000000000003',
  principal: '00000000-0000-4000-8000-000000000004',
  grant: '00000000-0000-4000-8000-000000000005',
  access: '00000000-0000-4000-8000-000000000006',
} as const

const IDS = {
  installation: `installation-${UUIDS.installation}`,
  generation: `installation-generation-${UUIDS.generation}`,
  host: `host-${UUIDS.host}`,
  principal: `principal-${UUIDS.principal}`,
  grant: `grant-${UUIDS.grant}`,
  access: `access-${UUIDS.access}`,
} as const

const CHILD_IDS = {
  challenge: `${IDS.access}:challenge:0`,
  session: `${IDS.access}:session:0`,
} as const

const CONTROL = {
  schemaVersion: 1,
  revision: 0,
  phase: 'ready',
  installationId: IDS.installation,
  initialInstallationGenerationId: IDS.generation,
  initialHostId: IDS.host,
  hostOperatorPrincipalId: IDS.principal,
  hostOperatorGrantId: IDS.grant,
  installationAccessId: IDS.access,
} as const

const INSTALLATION = {
  id: IDS.installation,
  revision: 0,
  state: 'active',
  currentInstallationGenerationId: IDS.generation,
  currentHostId: IDS.host,
} as const

const HOST = {
  id: IDS.host,
  revision: 0,
  installationId: IDS.installation,
  state: 'enrolled',
} as const

const PRINCIPAL = {
  id: IDS.principal,
  revision: 0,
  kind: 'human',
  displayName: 'Host Operator',
  state: 'active',
} as const

const GRANT = {
  id: IDS.grant,
  revision: 0,
  installationId: IDS.installation,
  principalId: IDS.principal,
  state: 'active',
  actions: ['project-index:read'],
  scope: { kind: 'installation', installationId: IDS.installation },
} as const

const CHALLENGE = {
  id: CHILD_IDS.challenge,
  ordinal: 0,
  revision: 1,
  purpose: 'initial-bootstrap',
  installationId: IDS.installation,
  installationGenerationId: IDS.generation,
  hostId: IDS.host,
  principalId: IDS.principal,
  verifierDigest: 'a'.repeat(64),
  issuedAt: 1,
  expiresAt: 2,
  state: 'consumed',
  terminalAt: 1,
  browserSessionId: CHILD_IDS.session,
} as const

const SESSION = {
  id: CHILD_IDS.session,
  ordinal: 0,
  revision: 0,
  installationId: IDS.installation,
  installationGenerationId: IDS.generation,
  principalId: IDS.principal,
  cookieDigest: 'b'.repeat(64),
  createdAt: 1,
  expiresAt: 2,
  state: 'active',
} as const

const COMPLETION = {
  challengeId: CHILD_IDS.challenge,
  sessionId: CHILD_IDS.session,
  hostId: IDS.host,
  principalId: IDS.principal,
  completedAt: 1,
} as const

const ACCESS = {
  id: IDS.access,
  schemaVersion: 1,
  revision: 1,
  installationId: IDS.installation,
  nextChallengeOrdinal: 1,
  nextSessionOrdinal: 1,
  bootstrapCompletion: COMPLETION,
  requestTokenDerivation: {
    version: 1,
    domain: 'saki/browser-request-token',
  },
  challenges: [CHALLENGE],
  sessions: [SESSION],
} as const

describe('Saki durable identity schemas', () => {
  it('accepts only the canonical identity grammar in complete records', () => {
    expect(controlStateRecordSchema.parse(CONTROL)).toEqual(CONTROL)
    expect(installationRecordSchema.parse(INSTALLATION)).toEqual(INSTALLATION)
    expect(hostRecordSchema.parse(HOST)).toEqual(HOST)
    expect(principalRecordSchema.parse(PRINCIPAL)).toEqual(PRINCIPAL)
    expect(grantRecordSchema.parse(GRANT)).toEqual(GRANT)
    expect(bootstrapChallengeRecordSchema.parse(CHALLENGE)).toEqual(CHALLENGE)
    expect(browserSessionRecordSchema.parse(SESSION)).toEqual(SESSION)
    expect(bootstrapCompletionRecordSchema.parse(COMPLETION)).toEqual(COMPLETION)
    expect(installationAccessRecordSchema.parse(ACCESS)).toEqual(ACCESS)
  })

  it('rejects malformed UUIDs and cross-kind prefixes in provisioning records', () => {
    expect(controlStateRecordSchema.safeParse({ ...CONTROL, installationId: IDS.host }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({
      ...CONTROL,
      initialInstallationGenerationId: `storage-generation-${UUIDS.generation}`,
    }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({ ...CONTROL, initialHostId: IDS.principal }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({ ...CONTROL, hostOperatorPrincipalId: IDS.grant }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({ ...CONTROL, hostOperatorGrantId: IDS.access }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({ ...CONTROL, installationAccessId: IDS.installation }).success).toBe(false)
    expect(controlStateRecordSchema.safeParse({
      ...CONTROL,
      installationId: 'installation-not-a-uuid',
    }).success).toBe(false)

    expect(installationRecordSchema.safeParse({ ...INSTALLATION, id: IDS.host }).success).toBe(false)
    expect(installationRecordSchema.safeParse({
      ...INSTALLATION,
      currentInstallationGenerationId: `storage-generation-${UUIDS.generation}`,
    }).success).toBe(false)
    expect(installationRecordSchema.safeParse({ ...INSTALLATION, currentHostId: IDS.principal }).success).toBe(false)
    expect(hostRecordSchema.safeParse({ ...HOST, id: IDS.principal }).success).toBe(false)
    expect(hostRecordSchema.safeParse({ ...HOST, installationId: IDS.host }).success).toBe(false)
    expect(principalRecordSchema.safeParse({ ...PRINCIPAL, id: IDS.grant }).success).toBe(false)
    expect(grantRecordSchema.safeParse({ ...GRANT, id: IDS.principal }).success).toBe(false)
    expect(grantRecordSchema.safeParse({ ...GRANT, installationId: IDS.host }).success).toBe(false)
    expect(grantRecordSchema.safeParse({ ...GRANT, principalId: IDS.grant }).success).toBe(false)
  })

  it('rejects cross-kind prefixes and non-canonical child ordinals in Access records', () => {
    expect(installationAccessRecordSchema.safeParse({ ...ACCESS, id: IDS.installation }).success).toBe(false)
    expect(installationAccessRecordSchema.safeParse({ ...ACCESS, installationId: IDS.host }).success).toBe(false)

    expect(bootstrapChallengeRecordSchema.safeParse({ ...CHALLENGE, id: CHILD_IDS.session }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({
      ...CHALLENGE,
      id: `${IDS.access}:challenge:01`,
    }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({ ...CHALLENGE, installationId: IDS.host }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({
      ...CHALLENGE,
      installationGenerationId: `storage-generation-${UUIDS.generation}`,
    }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({ ...CHALLENGE, hostId: IDS.principal }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({ ...CHALLENGE, principalId: IDS.grant }).success).toBe(false)
    expect(bootstrapChallengeRecordSchema.safeParse({
      ...CHALLENGE,
      browserSessionId: CHILD_IDS.challenge,
    }).success).toBe(false)

    expect(browserSessionRecordSchema.safeParse({ ...SESSION, id: CHILD_IDS.challenge }).success).toBe(false)
    expect(browserSessionRecordSchema.safeParse({
      ...SESSION,
      id: `${IDS.access}:session:01`,
    }).success).toBe(false)
    expect(browserSessionRecordSchema.safeParse({ ...SESSION, installationId: IDS.host }).success).toBe(false)
    expect(browserSessionRecordSchema.safeParse({
      ...SESSION,
      installationGenerationId: `storage-generation-${UUIDS.generation}`,
    }).success).toBe(false)
    expect(browserSessionRecordSchema.safeParse({ ...SESSION, principalId: IDS.grant }).success).toBe(false)

    expect(bootstrapCompletionRecordSchema.safeParse({
      ...COMPLETION,
      challengeId: CHILD_IDS.session,
    }).success).toBe(false)
    expect(bootstrapCompletionRecordSchema.safeParse({
      ...COMPLETION,
      sessionId: CHILD_IDS.challenge,
    }).success).toBe(false)
    expect(bootstrapCompletionRecordSchema.safeParse({ ...COMPLETION, hostId: IDS.principal }).success).toBe(false)
    expect(bootstrapCompletionRecordSchema.safeParse({ ...COMPLETION, principalId: IDS.grant }).success).toBe(false)
  })
})
