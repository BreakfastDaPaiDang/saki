/** Fixed safe Git query grammar for Local Host file Diff reads. @module @breakfastdapaidang/saki-execution-local/diff-query */

import {
  isGitObjectId,
  isRepositoryRelativeGitPath,
} from '@breakfastdapaidang/saki-execution'
import type {
  ProjectGitDiffLayer,
  ProjectGitHead,
} from '@breakfastdapaidang/saki-execution'

/** Closed output forms used by the two-pass file Diff reader. */
export type ProjectDiffQueryKind = 'binary-preflight' | 'patch'

/** Layers represented by an ordinary staged or worktree Git Diff. */
export type ReadableProjectGitDiffLayer = Extract<ProjectGitDiffLayer, 'staged' | 'unstaged'>

const QUERY_PREFIX = [
  '--literal-pathspecs',
  '-c', 'core.quotePath=true',
  'diff',
] as const

const SEMANTIC_OPTIONS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--ignore-submodules=all',
  '--submodule=short',
  '--ita-invisible-in-index',
] as const

const PATCH_OPTIONS = [
  '--patch',
  '--no-color',
  '--default-prefix',
  '--full-index',
  '--diff-algorithm=default',
  '--no-indent-heuristic',
  '--unified=3',
  '--inter-hunk-context=0',
] as const

const PREFLIGHT_OPTIONS = ['--numstat', '-z'] as const

/**
 * Construct one exact file-scoped Git Diff query from provider-owned evidence.
 * @param kind - binary preflight or unified patch output form.
 * @param path - exact UTF-8 repository-relative path resolved from a change id.
 * @param layer - index side compared by the request.
 * @param head - exact observed HEAD used to pin staged comparison.
 * @returns complete arguments after the shared Git runner safety prefix.
 */
export function projectDiffQueryArguments(
  kind: ProjectDiffQueryKind,
  path: string,
  layer: ReadableProjectGitDiffLayer,
  head: ProjectGitHead,
): readonly string[] {
  const output = kind === 'patch' ? PATCH_OPTIONS : PREFLIGHT_OPTIONS
  const revision = layer === 'unstaged'
    ? []
    : head.kind === 'commit' ? ['--cached', head.objectId] : ['--cached']
  return [
    ...QUERY_PREFIX,
    ...output,
    ...SEMANTIC_OPTIONS,
    ...revision,
    '--',
    path,
  ]
}

/**
 * Test whether arguments are one exact query constructible by this module.
 * @param args - candidate repository-aware Git arguments.
 * @param objectFormat - admitted repository object format.
 * @returns whether the query is a fixed read-only file Diff form.
 */
export function isSafeProjectDiffQuery(
  args: readonly string[],
  objectFormat: 'sha1' | 'sha256',
): boolean {
  const path = args.at(-1)
  if (path === undefined || !isRepositoryRelativeGitPath(path)) return false
  const unborn: ProjectGitHead = { kind: 'unborn', symbolicRef: 'refs/heads/unborn' }
  for (const kind of ['binary-preflight', 'patch'] as const) {
    if (argsEqual(args, projectDiffQueryArguments(kind, path, 'unstaged', unborn))
      || argsEqual(args, projectDiffQueryArguments(kind, path, 'staged', unborn))) {
      return true
    }
    const objectId = args.at(-3)
    if (objectId !== undefined && isGitObjectId(objectId, objectFormat)) {
      const head: ProjectGitHead = { kind: 'commit', objectId }
      if (argsEqual(args, projectDiffQueryArguments(kind, path, 'staged', head))) return true
    }
  }
  return false
}

function argsEqual(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index])
}
