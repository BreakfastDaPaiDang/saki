import { describe, expect, it } from 'vitest'
import {
  isCommitOutcomeUnknownStorageError,
  isPublishedStorageError,
  StorageError,
} from '../src/error.ts'

describe('StorageError publication evidence', () => {
  it('marks only durability-uncertain failures as already published', () => {
    const cause = new Error('directory sync failed')
    const uncertain = new StorageError('durability-uncertain', 'published without confirmed durability', { cause })
    const prePublication = new StorageError('target-exists', 'target already exists')

    expect(uncertain).toMatchObject({
      code: 'durability-uncertain',
      published: true,
      cause,
    })
    expect(isPublishedStorageError(uncertain)).toBe(true)
    expect(prePublication).not.toHaveProperty('published')
    expect(isPublishedStorageError(prePublication)).toBe(false)
    expect(isPublishedStorageError(new Error('plain failure'))).toBe(false)
  })

  it('marks an unknown commit outcome without claiming publication', () => {
    const cause = new Error('commit returned an ambiguous failure')
    const uncertain = new StorageError('commit-outcome-unknown', 'commit outcome is unknown', { cause })

    expect(uncertain).toMatchObject({
      code: 'commit-outcome-unknown',
      publicationPossible: true,
      cause,
    })
    expect(uncertain).not.toHaveProperty('published')
    expect(isCommitOutcomeUnknownStorageError(uncertain)).toBe(true)
    expect(isPublishedStorageError(uncertain)).toBe(false)
    expect(isCommitOutcomeUnknownStorageError(new Error('plain failure'))).toBe(false)
  })
})
