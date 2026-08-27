import { describe, expect, it } from 'vitest'
import {
  sakiCreateCommitIntentSchema,
  sakiCreateCommitResultSchema,
  sakiCurrentGitOperationProjectionSchema,
  sakiProjectChangesResultSchema,
  sakiStageFilesIntentSchema,
  sakiStageFilesResultSchema,
  sakiUnstageFilesIntentSchema,
  sakiUnstageFilesResultSchema,
} from '../src/wire.ts'

const INTENT_ID = 'intent-11111111-1111-4111-8111-111111111111'
const PROJECT_ID = 'project-22222222-2222-4222-8222-222222222222'
const BINDING_ID = 'binding-33333333-3333-4333-8333-333333333333'
const DIGEST = '4'.repeat(64)
const CHANGE_ID = `git-change-${'5'.repeat(64)}`

const expected = {
  projectId: PROJECT_ID,
  expectedRegistryRevision: 7,
  expectedProjectRevision: 3,
  expectedBinding: { id: BINDING_ID, revision: 2 },
  expectedStatus: { version: 1, digest: DIGEST },
  expectedHead: { kind: 'commit', objectId: '6'.repeat(40), symbolicRef: 'refs/heads/main' },
  expectedIndex: { kind: 'tree', treeId: '7'.repeat(40) },
  expectedWorktree: { version: 1, digest: '8'.repeat(64) },
} as const

describe('Saki structured Git operation wire schemas', () => {
  it('accepts an opaque StageFiles selection and rejects browser-supplied path authority', () => {
    const intent = {
      type: 'stage-files',
      intentId: INTENT_ID,
      expected,
      changes: [{ id: CHANGE_ID, fingerprint: { version: 1, digest: '9'.repeat(64) } }],
    } as const

    expect(sakiStageFilesIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiStageFilesIntentSchema.safeParse({
      ...intent,
      changes: [{ ...intent.changes[0], path: 'src/private.ts' }],
    }).success).toBe(false)
  })

  it('rejects every browser-supplied authority and Host execution sentinel', () => {
    const intent = {
      type: 'stage-files',
      intentId: INTENT_ID,
      expected,
      changes: [{ id: CHANGE_ID, fingerprint: { version: 1, digest: '9'.repeat(64) } }],
    } as const
    for (const reserved of [
      { acceptance: { capability: true } },
      { callback: 'callback-sentinel' },
      { bindingWriteAdmission: { state: 'manual-host-operation' } },
      { request: { type: 'stage-files' } },
      { binding: { id: BINDING_ID, revision: 2 } },
      { preEffectBaseline: { kind: 'complete' } },
      { actor: { principalId: 'principal-sentinel' } },
      { principal: { id: 'principal-sentinel' } },
      { grant: { revision: 1 } },
      { hostId: 'host-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { browserSessionId: 'browser-session-sentinel' },
      { storageGenerationId: 'storage-generation-sentinel' },
      { installationGenerationId: 'installation-generation-sentinel' },
      { source: { kind: 'control-intent' } },
      { payloadDigest: DIGEST },
      { intentRevision: 1 },
      { argv: ['git', 'add'] },
      { env: { GIT_INDEX_FILE: 'sentinel' } },
      { path: 'src/private.ts' },
      { canonicalWorktreePath: 'C:/host/repository' },
      { canonicalGitDirectory: 'C:/host/repository/.git' },
      { indexPath: 'C:/host/repository/.git/index' },
      { temporaryPath: 'C:/host/temp/index' },
      { lockPath: 'C:/host/repository/.git/index.lock' },
      { rawPorcelain: 'raw-git-sentinel' },
    ]) {
      expect(sakiStageFilesIntentSchema.safeParse({ ...intent, ...reserved }).success).toBe(false)
    }
    for (const reserved of [
      { binding: { expectedInspection: { trusted: {} } } },
      { preEffectBaseline: { kind: 'complete' } },
      { canonicalWorktreePath: 'C:/host/repository' },
      { rawIndex: 'raw-index-sentinel' },
    ]) {
      expect(sakiStageFilesIntentSchema.safeParse({
        ...intent,
        expected: { ...intent.expected, ...reserved },
      }).success).toBe(false)
    }
  })

  it('accepts an opaque UnstageFiles selection and rejects duplicate identities', () => {
    const selected = { id: CHANGE_ID, fingerprint: { version: 1 as const, digest: '9'.repeat(64) } }
    const intent = {
      type: 'unstage-files',
      intentId: INTENT_ID,
      expected,
      changes: [selected],
    } as const

    expect(sakiUnstageFilesIntentSchema.parse(intent)).toEqual(intent)
    expect(sakiUnstageFilesIntentSchema.safeParse({ ...intent, changes: [] }).success).toBe(false)
    expect(sakiUnstageFilesIntentSchema.safeParse({ ...intent, changes: [selected, selected] }).success).toBe(false)
  })

  it('accepts only a bounded Commit message and expected Git evidence', () => {
    const intent = {
      type: 'create-commit',
      intentId: INTENT_ID,
      expected,
      message: 'subject\n\nbody',
    } as const

    expect(sakiCreateCommitIntentSchema.parse(intent)).toEqual(intent)
    for (const reserved of [
      { author: { name: 'Browser', email: 'browser@example.test' } },
      { target: { kind: 'symbolic-ref', ref: 'refs/heads/other' } },
      { path: 'src/private.ts' },
      { argv: ['commit'] },
      { env: { GIT_AUTHOR_NAME: 'Browser' } },
    ]) {
      expect(sakiCreateCommitIntentSchema.safeParse({ ...intent, ...reserved }).success).toBe(false)
    }
    expect(sakiCreateCommitIntentSchema.safeParse({ ...intent, message: '' }).success).toBe(false)
    expect(sakiCreateCommitIntentSchema.safeParse({ ...intent, message: 'subject\0body' }).success).toBe(false)
  })

  it('exposes repository-level eligibility and only a safe current operation reference', () => {
    const result = {
      ok: true,
      projection: {
        type: 'project-changes',
        registryRevision: 7,
        projectId: PROJECT_ID,
        projectRevision: 3,
        result: { ok: false, reason: 'unavailable' },
        gitOperations: {
          stageFiles: { available: false, reasons: ['status-unavailable', 'write-admission-busy'] },
          unstageFiles: { available: false, reasons: ['status-unavailable', 'write-admission-busy'] },
          createCommit: { available: false, reasons: ['status-unavailable', 'write-admission-busy'] },
          current: {
            intentId: INTENT_ID,
            type: 'stage-files',
            state: 'host-prepared',
            operation: {
              id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              type: 'stage-files',
              revision: 0,
              state: 'prepared',
            },
          },
        },
      },
    } as const

    expect(sakiProjectChangesResultSchema.parse(result)).toEqual(result)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        gitOperations: {
          ...result.projection.gitOperations,
          current: {
            ...result.projection.gitOperations.current,
            operation: {
              ...result.projection.gitOperations.current.operation,
              hostId: 'host-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            },
          },
        },
      },
    }).success).toBe(false)
    for (const reserved of [
      { freshBaseline: { kind: 'complete' } },
      { registrationBaseline: { kind: 'complete' } },
      { preEffectBaseline: { kind: 'complete' } },
      { expectedInspection: { trusted: { canonicalWorktreePath: 'C:/host/repository' } } },
    ]) {
      expect(sakiProjectChangesResultSchema.safeParse({
        ...result,
        projection: { ...result.projection, ...reserved },
      }).success).toBe(false)
    }
    expect(sakiProjectChangesResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        gitOperations: {
          ...result.projection.gitOperations,
          stageFiles: {
            available: false,
            reasons: ['write-admission-busy', 'status-unavailable'],
          },
        },
      },
    }).success).toBe(false)
    expect(sakiProjectChangesResultSchema.safeParse({
      ...result,
      projection: {
        ...result.projection,
        gitOperations: {
          ...result.projection.gitOperations,
          current: {
            ...result.projection.gitOperations.current,
            operation: {
              ...result.projection.gitOperations.current.operation,
              type: 'commit',
            },
          },
        },
      },
    }).success).toBe(false)
  })

  it('accepts only Intent-correlated current Host Operation references', () => {
    const operation = {
      id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revision: 0,
    } as const
    const valid = [
      {
        intentId: INTENT_ID,
        type: 'stage-files',
        state: 'host-prepared',
        operation: { ...operation, type: 'stage-files', state: 'prepared' },
      },
      {
        intentId: INTENT_ID,
        type: 'unstage-files',
        state: 'accepted',
        operation: { ...operation, type: 'unstage-files', state: 'planning' },
      },
      {
        intentId: INTENT_ID,
        type: 'create-commit',
        state: 'reconciliation-required',
        operation: { ...operation, type: 'commit', state: 'reconciliation-required' },
      },
    ] as const

    for (const projection of valid) {
      expect(sakiCurrentGitOperationProjectionSchema.parse(projection)).toEqual(projection)
    }
    expect(sakiCurrentGitOperationProjectionSchema.safeParse({
      ...valid[0],
      operation: { ...valid[0].operation, type: 'commit' },
    }).success).toBe(false)
  })

  it('returns a path-bounded StageFiles result without Host execution authority', () => {
    const result = {
      ok: true,
      receipt: {
        id: 'receipt-11111111-1111-4111-8111-111111111111',
        intentId: INTENT_ID,
        type: 'stage-files',
        projectId: PROJECT_ID,
        state: 'succeeded',
        operation: {
          id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          type: 'stage-files',
          revision: 4,
          state: 'succeeded',
        },
        result: {
          type: 'stage-files',
          changes: [{
            id: CHANGE_ID,
            fingerprint: { version: 1, digest: '9'.repeat(64) },
            path: 'src/file.ts',
          }],
          resultingIndex: { kind: 'tree', treeId: 'a'.repeat(40) },
        },
      },
    } as const

    expect(sakiStageFilesResultSchema.parse(result)).toEqual(result)
    expect(sakiStageFilesResultSchema.safeParse({
      ...result,
      receipt: {
        ...result.receipt,
        result: {
          ...result.receipt.result,
          changes: [{ ...result.receipt.result.changes[0], path: 'C:/host/private.ts' }],
        },
      },
    }).success).toBe(false)
    for (const reserved of [
      { callback: 'callback-sentinel' },
      { bindingWriteAdmission: { state: 'manual-host-operation' } },
      { request: { type: 'stage-files' } },
      { hostId: 'host-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { source: { kind: 'control-intent', payloadDigest: DIGEST } },
      { acceptance: {} },
      { admission: { revision: 1 } },
      { binding: { id: BINDING_ID, revision: 2 } },
      { preEffectBaseline: { kind: 'complete' } },
      { preparation: { preparationRevision: 1 } },
      { actor: { principalId: 'principal-sentinel' } },
      { principal: { id: 'principal-sentinel' } },
      { grant: { revision: 1 } },
      { browserSessionId: 'browser-session-sentinel' },
      { storageGenerationId: 'storage-generation-sentinel' },
      { installationGenerationId: 'installation-generation-sentinel' },
      { payloadDigest: DIGEST },
      { intentRevision: 1 },
      { argv: ['git', 'add'] },
      { env: { GIT_INDEX_FILE: 'sentinel' } },
      { path: 'src/private.ts' },
      { canonicalWorktreePath: 'C:/host/repository' },
      { canonicalGitDirectory: 'C:/host/repository/.git' },
      { canonicalCommonGitDirectory: 'C:/host/repository/.git' },
      { indexPath: 'C:/host/repository/.git/index' },
      { temporaryPath: 'C:/host/temp/index' },
      { lockPath: 'C:/host/repository/.git/index.lock' },
      { rawPorcelain: 'raw-git-sentinel' },
      { rawIndex: 'raw-index-sentinel' },
    ]) {
      expect(sakiStageFilesResultSchema.safeParse({
        ...result,
        receipt: { ...result.receipt, ...reserved },
      }).success).toBe(false)
    }
    for (const reserved of [
      { hostId: 'host-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { source: { kind: 'control-intent', payloadDigest: DIGEST } },
      { bindingId: BINDING_ID },
      { bindingRevision: 2 },
      { requestFingerprint: { version: 1, digest: DIGEST } },
      { admission: { kind: 'accepted', revision: 1 } },
      { createdAt: 1 },
      { updatedAt: 2 },
      { preEffectBaseline: { kind: 'complete' } },
      { result: result.receipt.result },
    ]) {
      expect(sakiStageFilesResultSchema.safeParse({
        ...result,
        receipt: {
          ...result.receipt,
          operation: { ...result.receipt.operation, ...reserved },
        },
      }).success).toBe(false)
    }
  })

  it('correlates UnstageFiles and CreateCommit success evidence to the Intent kind', () => {
    const unstage = {
      ok: true,
      receipt: {
        id: 'receipt-11111111-1111-4111-8111-111111111111',
        intentId: INTENT_ID,
        type: 'unstage-files',
        projectId: PROJECT_ID,
        state: 'succeeded',
        operation: {
          id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          type: 'unstage-files',
          revision: 0,
          state: 'succeeded',
        },
        result: {
          type: 'unstage-files',
          changes: [{
            id: CHANGE_ID,
            fingerprint: { version: 1, digest: '9'.repeat(64) },
            path: 'src/file.ts',
          }],
          resultingIndex: { kind: 'tree', treeId: 'a'.repeat(40) },
        },
      },
    } as const
    const signature = {
      name: 'Saki User',
      email: 'local-address',
      timestamp: 1,
      timezone: '+0800',
      source: 'git-config',
    } as const
    const commit = {
      ok: true,
      receipt: {
        id: 'receipt-11111111-1111-4111-8111-111111111111',
        intentId: INTENT_ID,
        type: 'create-commit',
        projectId: PROJECT_ID,
        state: 'succeeded',
        operation: {
          id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          type: 'commit',
          revision: 1,
          state: 'succeeded',
        },
        result: {
          type: 'commit',
          commitId: 'b'.repeat(40),
          treeId: 'a'.repeat(40),
          parent: { kind: 'commit', objectId: 'c'.repeat(40) },
          target: { kind: 'symbolic-ref', ref: 'refs/heads/main' },
          author: signature,
          committer: signature,
        },
      },
    } as const

    expect(sakiUnstageFilesResultSchema.parse(unstage)).toEqual(unstage)
    expect(sakiCreateCommitResultSchema.parse(commit)).toEqual(commit)
    expect(sakiCreateCommitResultSchema.safeParse({
      ...commit,
      receipt: {
        ...commit.receipt,
        result: { ...commit.receipt.result, postObservation: { trusted: true } },
      },
    }).success).toBe(false)
    expect(sakiCreateCommitResultSchema.safeParse({
      ...commit,
      receipt: {
        ...commit.receipt,
        operation: { ...commit.receipt.operation, type: 'stage-files' },
      },
    }).success).toBe(false)
  })

  it('keeps retryable, conflict, failed, canceled, and reconciliation receipts phase-specific', () => {
    const identity = {
      id: 'receipt-11111111-1111-4111-8111-111111111111',
      intentId: INTENT_ID,
      type: 'stage-files',
      projectId: PROJECT_ID,
    } as const
    const operation = {
      id: 'host-operation-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'stage-files',
      revision: 0,
      state: 'failed',
    } as const
    for (const result of [
      { ok: false, reason: 'unavailable', receipt: { ...identity, state: 'prepared' } },
      {
        ok: false,
        reason: 'unavailable',
        receipt: { ...identity, state: 'host-prepared', operation: { ...operation, state: 'prepared' } },
      },
      {
        ok: false,
        reason: 'unavailable',
        receipt: { ...identity, state: 'accepted', operation: { ...operation, state: 'planning' } },
      },
      {
        ok: false,
        reason: 'conflict',
        receipt: {
          ...identity,
          state: 'conflict',
          reason: 'expected-evidence',
          operation: { ...operation, state: 'prepared' },
        },
      },
      { ok: false, reason: 'failure', receipt: { ...identity, state: 'failed', reason: 'binding-stale', operation } },
      { ok: false, reason: 'failure', receipt: { ...identity, state: 'failed', reason: 'invalid-selection', operation } },
      {
        ok: false,
        reason: 'canceled',
        receipt: {
          ...identity,
          state: 'canceled',
          reason: 'source-canceled',
          operation: { ...operation, state: 'canceled' },
        },
      },
      {
        ok: false,
        reason: 'reconciliation-required',
        receipt: {
          ...identity,
          state: 'reconciliation-required',
          reason: 'effect-unknown',
          operation: { ...operation, state: 'reconciliation-required' },
        },
      },
    ] as const) {
      expect(sakiStageFilesResultSchema.parse(result)).toEqual(result)
    }
    expect(sakiStageFilesResultSchema.safeParse({
      ok: false,
      reason: 'failure',
      receipt: { ...identity, state: 'failed', reason: 'binding-stale' },
    }).success).toBe(false)
    expect(sakiStageFilesResultSchema.safeParse({
      ok: false,
      reason: 'reconciliation-required',
      receipt: { ...identity, state: 'reconciliation-required', reason: 'effect-unknown' },
    }).success).toBe(false)
    expect(sakiStageFilesResultSchema.safeParse({
      ok: false,
      reason: 'conflict',
      receipt: { ...identity, state: 'failed', reason: 'binding-stale', operation },
    }).success).toBe(false)
    for (const receipt of [
      { ...identity, state: 'host-prepared', operation: { ...operation, state: 'accepted' } },
      { ...identity, state: 'accepted', operation: { ...operation, state: 'prepared' } },
      { ...identity, state: 'conflict', reason: 'protocol', operation: { ...operation, state: 'failed' } },
      { ...identity, state: 'canceled', reason: 'authority-revoked', operation },
    ] as const) {
      expect(sakiStageFilesResultSchema.safeParse({
        ok: false,
        reason: receipt.state === 'conflict'
          ? 'conflict'
          : receipt.state === 'canceled' ? 'canceled' : 'unavailable',
        receipt,
      }).success).toBe(false)
    }
  })
})
