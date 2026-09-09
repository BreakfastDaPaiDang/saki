// @vitest-environment jsdom
/**
 * displayGitHead mapping: attached, detached, non-standard ref, and unborn
 * wire heads each produce exactly one display triple.
 */
import { describe, expect, it } from 'vitest'
import { displayGitHead } from '../src/client/git-head.ts'

describe('displayGitHead', () => {
  it('maps an attached commit head to its short id and stripped branch name', () => {
    expect(displayGitHead({ kind: 'commit', objectId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e', symbolicRef: 'refs/heads/main' }))
      .toEqual({ detached: false, branch: 'main', shortHead: 'a1b2c3d4e5' })
  })

  it('keeps a non-standard symbolic ref as-is', () => {
    expect(displayGitHead({ kind: 'commit', objectId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e', symbolicRef: 'refs/tags/v1' }))
      .toEqual({ detached: false, branch: 'refs/tags/v1', shortHead: 'a1b2c3d4e5' })
  })

  it('marks a commit without a symbolic ref as detached with no branch', () => {
    expect(displayGitHead({ kind: 'commit', objectId: 'a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e' }))
      .toEqual({ detached: true, branch: null, shortHead: 'a1b2c3d4e5' })
  })

  it('maps an unborn branch to its name with no object id', () => {
    expect(displayGitHead({ kind: 'unborn', symbolicRef: 'refs/heads/main' }))
      .toEqual({ detached: false, branch: 'main', shortHead: null })
  })
})
