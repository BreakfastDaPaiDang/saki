/** Localized recovery guidance for Host Git reads and operation receipts. */
import type { SakiKey } from './locales.ts'

const reasons: Partial<Record<string, SakiKey>> = {
  'binding-stale': 'changes.reason.stale',
  'observation-stale': 'changes.reason.stale',
  'cursor-stale': 'changes.reason.stale',
  'expected-evidence': 'changes.reason.stale',
  'stale': 'changes.reason.stale',
  'change-missing': 'changes.reason.stale',
  'change-ambiguous': 'changes.reason.stale',
  'layer-missing': 'changes.reason.stale',
  'denied': 'changes.reason.denied',
  'action-denied': 'changes.reason.denied',
  'authority-revoked': 'changes.reason.denied',
  'unavailable': 'changes.reason.unavailable',
  'write-admission-unavailable': 'changes.reason.unavailable',
  'status-unavailable': 'changes.reason.unavailable',
  'missing': 'changes.reason.unavailable',
  'baseline-unavailable': 'changes.reason.baseline',
  'conversion-ambiguous': 'changes.reason.conversion',
  'current-unavailable': 'changes.reason.current',
  'index-flags': 'changes.reason.flags',
  'unmerged': 'changes.reason.conflict',
  'conflict': 'changes.reason.conflict',
  'locked': 'changes.reason.locked',
  'detached-head': 'changes.reason.detached',
  'no-staged-changes': 'changes.reason.empty',
  'write-admission-busy': 'changes.reason.busy',
  'admission-reserved': 'changes.reason.busy',
  'host-prepared': 'changes.reason.busy',
  'accepted': 'changes.reason.busy',
  'total-bytes': 'changes.reason.bounded',
  'total-lines': 'changes.reason.bounded',
  'line-bytes': 'changes.reason.bounded',
  'time': 'changes.reason.bounded',
  'limit': 'changes.reason.bounded',
  'command-length': 'changes.reason.bounded',
  'untracked': 'changes.reason.untracked',
  'binary': 'changes.reason.binary',
  'invalid-selection': 'changes.reason.invalid',
  'invalid-cursor': 'changes.reason.invalid',
  'invalid-path': 'changes.reason.invalid',
  'invalid-utf8': 'changes.reason.invalid',
  'malformed': 'changes.reason.invalid',
  'ambiguous': 'changes.reason.invalid',
  'protocol': 'changes.reason.invalid',
  'source-conflict': 'changes.reason.invalid',
  'unsupported-state': 'changes.reason.invalid',
  'reconciliation-required': 'changes.reason.unknown',
  'effect-unknown': 'changes.reason.unknown',
  'evidence-conflict': 'changes.reason.unknown',
  'source-canceled': 'changes.reason.canceled',
  'canceled': 'changes.reason.canceled',
}

/**
 * Select localized guidance for a Host read or mutation outcome.
 * @param reason - safe Host reason from a read or receipt.
 * @returns actionable copy, including a fallback for an unfamiliar Host reason.
 */
export function changesReasonKey(reason: string): SakiKey { return reasons[reason] ?? 'changes.reason.unavailable' }
