import { test } from 'vitest'

import type {
  SakiControlIntentId,
  SakiCurrentGitOperationProjection,
  SakiDevelopmentProjectId,
  SakiGitOperationIntent,
  SakiGitOperationIntentReceipt,
  SakiGitOperationReceipt,
  SakiGitOperationReferenceProjection,
  SakiIntentReceiptId,
} from '../src/index.ts'

type OperationReference<
  Type extends SakiGitOperationReferenceProjection['type'],
  State extends SakiGitOperationReferenceProjection['state'],
> = Omit<SakiGitOperationReferenceProjection, 'type' | 'state'> & {
  readonly type: Type
  readonly state: State
}

type ReceiptBase<Type extends SakiGitOperationIntent['type']> = {
  readonly id: SakiIntentReceiptId
  readonly intentId: SakiControlIntentId
  readonly type: Type
  readonly projectId: SakiDevelopmentProjectId
}

test('current Git operation correlates the Intent and Host operation kinds', () => {
  type StageIntentWithCommitOperation = {
    readonly intentId: SakiControlIntentId
    readonly type: 'stage-files'
    readonly state: 'host-prepared'
    readonly operation: OperationReference<'commit', 'prepared'>
  }
  type HostPreparedWithAcceptedOperation = {
    readonly intentId: SakiControlIntentId
    readonly type: 'stage-files'
    readonly state: 'host-prepared'
    readonly operation: OperationReference<'stage-files', 'accepted'>
  }
  type AcceptedWithTerminalOperation = {
    readonly intentId: SakiControlIntentId
    readonly type: 'stage-files'
    readonly state: 'accepted'
    readonly operation: OperationReference<'stage-files', 'failed'>
  }
  type ValidStageHostPrepared = {
    readonly intentId: SakiControlIntentId
    readonly type: 'stage-files'
    readonly state: 'host-prepared'
    readonly operation: OperationReference<'stage-files', 'prepared'>
  }

  const valid: SakiCurrentGitOperationProjection = null as unknown as ValidStageHostPrepared
  // @ts-expect-error A StageFiles Intent cannot own a Commit Host Operation.
  const wrongKind: SakiCurrentGitOperationProjection = null as unknown as StageIntentWithCommitOperation
  // @ts-expect-error Host-prepared requires a prepared Host Operation.
  const wrongPreparedState: SakiCurrentGitOperationProjection = null as unknown as HostPreparedWithAcceptedOperation
  // @ts-expect-error Accepted permits only accepted, planning, or publishing Host Operations.
  const wrongAcceptedState: SakiCurrentGitOperationProjection = null as unknown as AcceptedWithTerminalOperation
  void [valid, wrongKind, wrongPreparedState, wrongAcceptedState]
})

test('Git operation receipts correlate operation kind and lifecycle state', () => {
  type StageHostPreparedWithCommit = ReceiptBase<'stage-files'> & {
    readonly state: 'host-prepared'
    readonly operation: OperationReference<'commit', 'prepared'>
  }
  type HostPreparedWithAcceptedOperation = ReceiptBase<'stage-files'> & {
    readonly state: 'host-prepared'
    readonly operation: OperationReference<'stage-files', 'accepted'>
  }
  type AcceptedWithTerminalOperation = ReceiptBase<'stage-files'> & {
    readonly state: 'accepted'
    readonly operation: OperationReference<'stage-files', 'failed'>
  }
  type ConflictWithAcceptedOperation = ReceiptBase<'stage-files'> & {
    readonly state: 'conflict'
    readonly reason: 'source-conflict'
    readonly operation: OperationReference<'stage-files', 'accepted'>
  }
  type CanceledWithFailedOperation = ReceiptBase<'stage-files'> & {
    readonly state: 'canceled'
    readonly reason: 'source-canceled'
    readonly operation: OperationReference<'stage-files', 'failed'>
  }
  type ValidConflict = ReceiptBase<'stage-files'> & {
    readonly state: 'conflict'
    readonly reason: 'source-conflict'
    readonly operation: OperationReference<'stage-files', 'prepared'>
  }

  const valid: SakiGitOperationReceipt<'stage-files'> = null as unknown as ValidConflict
  // @ts-expect-error A StageFiles receipt cannot reference a Commit Host Operation.
  const wrongKind: SakiGitOperationReceipt<'stage-files'> = null as unknown as StageHostPreparedWithCommit
  // @ts-expect-error Host-prepared requires a prepared Host Operation.
  const wrongPreparedState: SakiGitOperationReceipt<'stage-files'>
    = null as unknown as HostPreparedWithAcceptedOperation
  // @ts-expect-error Accepted cannot retain terminal Host Operation evidence.
  const wrongAcceptedState: SakiGitOperationReceipt<'stage-files'>
    = null as unknown as AcceptedWithTerminalOperation
  // @ts-expect-error A conflicted receipt may retain only prepared Host Operation evidence.
  const wrongConflictState: SakiGitOperationReceipt<'stage-files'>
    = null as unknown as ConflictWithAcceptedOperation
  // @ts-expect-error A canceled receipt may retain only canceled Host Operation evidence.
  const wrongCanceledState: SakiGitOperationReceipt<'stage-files'>
    = null as unknown as CanceledWithFailedOperation
  void [valid, wrongKind, wrongPreparedState, wrongAcceptedState, wrongConflictState, wrongCanceledState]
})

test('Git operation result reasons correlate with receipt states', () => {
  type FailedReceipt = ReceiptBase<'stage-files'> & {
    readonly state: 'failed'
    readonly reason: 'unsupported-state'
    readonly operation: OperationReference<'stage-files', 'failed'>
  }
  type CanceledReceipt = ReceiptBase<'stage-files'> & {
    readonly state: 'canceled'
    readonly reason: 'source-canceled'
    readonly operation: OperationReference<'stage-files', 'canceled'>
  }
  type ReconciliationReceipt = ReceiptBase<'stage-files'> & {
    readonly state: 'reconciliation-required'
    readonly reason: 'effect-unknown'
    readonly operation: OperationReference<'stage-files', 'reconciliation-required'>
  }

  const validFailure: SakiGitOperationIntentReceipt<'stage-files'> = {
    ok: false,
    reason: 'failure',
    receipt: null as unknown as FailedReceipt,
  }
  // @ts-expect-error Failure results require failed receipts.
  const failureWithCanceled: SakiGitOperationIntentReceipt<'stage-files'> = {
    ok: false,
    reason: 'failure',
    receipt: null as unknown as CanceledReceipt,
  }
  // @ts-expect-error Canceled results require canceled receipts.
  const canceledWithReconciliation: SakiGitOperationIntentReceipt<'stage-files'> = {
    ok: false,
    reason: 'canceled',
    receipt: null as unknown as ReconciliationReceipt,
  }
  // @ts-expect-error Reconciliation results require reconciliation-required receipts.
  const reconciliationWithFailure: SakiGitOperationIntentReceipt<'stage-files'> = {
    ok: false,
    reason: 'reconciliation-required',
    receipt: null as unknown as FailedReceipt,
  }
  void [validFailure, failureWithCanceled, canceledWithReconciliation, reconciliationWithFailure]
})
