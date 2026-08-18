/** Secret-free B01 Projection and access fixtures for frontend Consumers. @module @breakfastdapaidang/saki-control-plane/fixtures */

import type {
  AccessProjection,
  SakiAccessExchangeResult,
  SakiAccessLogoutResult,
  SakiIntentReceipt,
  SakiProjectIndexProjection,
  SakiQueryResult,
} from './types.ts'

/** Display-only placeholder Principal id used by authenticated fixtures. */
const PRINCIPAL_ID = 'principal-00000000-0000-4000-8000-000000000001' as import('./types.ts').SakiPrincipalId

/** Closed Access fixtures with no Installation or challenge identifiers. */
export const SAKI_ACCESS_FIXTURES = Object.freeze({
  bootstrapRequired: { kind: 'bootstrap-required', message: 'Local bootstrap is required.' },
  sessionRequired: { kind: 'session-required', message: 'A local browser session is required.' },
  unavailable: { kind: 'unavailable', message: 'Local access is temporarily unavailable.' },
  authenticated: {
    kind: 'authenticated',
    principal: { id: PRINCIPAL_ID, displayName: 'Host Operator' },
    expiresAt: 1_787_104_800_000,
    requestToken: '<session-derived-request-token>',
  },
} as const satisfies Record<string, AccessProjection>)

/** Empty authenticated Project-index Projection fixture. */
export const SAKI_EMPTY_PROJECT_INDEX_FIXTURE = Object.freeze({
  type: 'project-index',
  revision: 0,
  projects: [],
} as const satisfies SakiProjectIndexProjection)

/** Stable access mutation fixtures; cookie material is deliberately absent. */
export const SAKI_ACCESS_RESULT_FIXTURES = Object.freeze({
  exchangeConfirmed: { ok: true, access: SAKI_ACCESS_FIXTURES.authenticated },
  exchangeConflict: { ok: false, reason: 'unavailable' },
  replay: { ok: false, reason: 'unavailable' },
  originRejected: { ok: false, reason: 'unavailable' },
  requestTokenRejected: { ok: false, reason: 'unavailable' },
  logoutConfirmed: { ok: true },
} as const satisfies Record<string, SakiAccessExchangeResult | SakiAccessLogoutResult>)

/** Protected query and empty-Intent fixtures. */
export const SAKI_CONTROL_RESULT_FIXTURES = Object.freeze({
  emptyProjectIndex: { ok: true, projection: SAKI_EMPTY_PROJECT_INDEX_FIXTURE },
  currentGrantDenied: { ok: false, reason: 'denied' },
  intentUnavailable: { ok: false, reason: 'intent-unavailable' },
} as const satisfies Record<string, SakiQueryResult | SakiIntentReceipt>)

/** Redacted lifecycle fixtures for durable access-state presentation tests. */
export const SAKI_ACCESS_LIFECYCLE_FIXTURES = Object.freeze({
  challenges: ['issued', 'consumed', 'expired', 'revoked'],
  sessions: ['active', 'expired', 'revoked', 'restart-restored', 'principal-unavailable', 'current-grant-denied'],
  exchange: ['in-progress', 'confirmed', 'conflict'],
} as const)

/** Redacted durable-record fixtures with identities, revisions, server times, and no verifier bytes. */
export const SAKI_SECURITY_RECORD_FIXTURES = Object.freeze({
  challenges: {
    issued: {
      id: 'challenge-issued', revision: 0, state: 'issued', issuedAt: 1_787_101_200_000,
      expiresAt: 1_787_102_100_000, verifier: { algorithm: 'sha-256', redacted: true },
    },
    consumed: {
      id: 'challenge-consumed', revision: 1, state: 'consumed', terminalAt: 1_787_101_260_000,
      browserSessionId: 'browser-session-active', verifier: { algorithm: 'sha-256', redacted: true },
    },
    expired: {
      id: 'challenge-expired', revision: 1, state: 'expired', terminalAt: 1_787_102_100_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
    revoked: {
      id: 'challenge-revoked', revision: 1, state: 'revoked', terminalAt: 1_787_101_230_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
  },
  sessions: {
    active: {
      id: 'browser-session-active', revision: 0, state: 'active', createdAt: 1_787_101_260_000,
      expiresAt: 1_787_144_460_000, verifier: { algorithm: 'sha-256', redacted: true },
    },
    expired: {
      id: 'browser-session-expired', revision: 1, state: 'expired', terminalAt: 1_787_144_460_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
    revoked: {
      id: 'browser-session-revoked', revision: 1, state: 'revoked', terminalAt: 1_787_101_320_000,
      verifier: { algorithm: 'sha-256', redacted: true },
    },
  },
} as const)
