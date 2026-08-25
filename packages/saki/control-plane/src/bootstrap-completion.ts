/**
 * Deterministic reconstruction of retained bootstrap-completion evidence.
 * @module @breakfastdapaidang/saki-control-plane/bootstrap-completion
 */

import type { BootstrapCompletionRecord } from './spec.ts'
import type {
  SakiBootstrapChallengeId,
  SakiBrowserSessionId,
  SakiHostId,
  SakiPrincipalId,
} from './types.ts'

interface BootstrapChallengeEvidence {
  readonly id: SakiBootstrapChallengeId
  readonly purpose: 'initial-bootstrap' | 'local-reauthentication'
  readonly state: 'issued' | 'consumed' | 'expired' | 'revoked'
  readonly browserSessionId?: SakiBrowserSessionId | undefined
  readonly hostId: SakiHostId
  readonly principalId: SakiPrincipalId
  readonly terminalAt?: number | undefined
}

interface BrowserSessionEvidence {
  readonly id: SakiBrowserSessionId
}

/**
 * Preserve pre-bootstrap state or reconstruct the immutable summary from one retained initial exchange.
 * @param record - Access children already checked for aggregate consistency.
 * @param subject - Diagnostic owner of the historical evidence.
 * @returns the unique completion summary, or `undefined` before bootstrap completes.
 */
export function recoverBootstrapCompletion(
  record: {
    readonly nextSessionOrdinal: number
    readonly challenges: readonly BootstrapChallengeEvidence[]
    readonly sessions: readonly BrowserSessionEvidence[]
  },
  subject: string,
): BootstrapCompletionRecord | undefined {
  if (record.nextSessionOrdinal === 0
    && record.sessions.length === 0
    && record.challenges.every(challenge =>
      challenge.purpose === 'initial-bootstrap' && challenge.state !== 'consumed')) {
    return undefined
  }
  const challenges = record.challenges.filter(challenge =>
    challenge.purpose === 'initial-bootstrap' && challenge.state === 'consumed')
  if (challenges.length !== 1) {
    throw new Error(`${subject} has no deterministic bootstrap completion evidence`)
  }
  const challenge = challenges[0] as BootstrapChallengeEvidence
  if (challenge.browserSessionId === undefined || challenge.terminalAt === undefined) {
    throw new Error(`${subject} has no deterministic bootstrap completion evidence`)
  }
  const session = record.sessions.find(candidate => candidate.id === challenge.browserSessionId)
  if (session === undefined) {
    throw new Error(`${subject} has no deterministic bootstrap completion evidence`)
  }
  return {
    challengeId: challenge.id,
    sessionId: session.id,
    hostId: challenge.hostId,
    principalId: challenge.principalId,
    completedAt: challenge.terminalAt,
  }
}
