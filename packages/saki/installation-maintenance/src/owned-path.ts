/** Validation for filesystem paths owned by one Saki Installation. */

import { lstat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { SakiMaintenanceError } from './error.ts'

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isInside(root: string, path: string): boolean {
  const value = relative(root, path)
  if (value === '' || value === '..' || value.startsWith(`..${sep}`)) return false
  /* v8 ignore next -- path.relative returns an absolute result only across Windows volumes. */
  return !isAbsolute(value)
}

function unsafeAncestor(path: string, cause?: unknown): SakiMaintenanceError {
  return new SakiMaintenanceError(
    'recovery-required',
    `Saki Installation path ancestor '${path}' is not a readable real directory`,
    cause === undefined ? undefined : { cause },
  )
}

/**
 * Validate every existing directory from an Installation root through a target's parent.
 * @param installationRoot - lexical root that must itself be a real directory.
 * @param targetPath - lexical Installation-owned file or directory entry below the root.
 * @param signal - cancellation during ancestor inspection.
 * @returns `true` when the complete parent chain exists, or `false` at its first missing entry.
 */
export async function validateOwnedPathAncestors(
  installationRoot: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  const root = resolve(installationRoot)
  const target = resolve(targetPath)
  if (!isInside(root, target)) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki Installation-owned path '${target}' escapes its root '${root}'`,
    )
  }
  const parent = dirname(target)
  const relativeParent = relative(root, parent)
  const ancestors = [root]
  let current = root
  if (relativeParent !== '') {
    for (const segment of relativeParent.split(sep)) {
      current = resolve(current, segment)
      ancestors.push(current)
    }
  }
  for (const ancestor of ancestors) {
    signal.throwIfAborted()
    let info
    try {
      info = await lstat(ancestor)
    } catch (error) {
      if (isMissing(error)) return false
      throw unsafeAncestor(ancestor, error)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafeAncestor(ancestor)
  }
  signal.throwIfAborted()
  return true
}

/**
 * Require the complete parent chain for an Installation-owned path.
 * @param installationRoot - lexical root that must itself be a real directory.
 * @param targetPath - lexical Installation-owned file or directory entry below the root.
 * @param signal - cancellation during ancestor inspection.
 * @returns after the complete parent chain is verified.
 */
export async function requireOwnedPathAncestors(
  installationRoot: string,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  if (!await validateOwnedPathAncestors(installationRoot, targetPath, signal)) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `Saki Installation-owned path '${resolve(targetPath)}' has a missing ancestor`,
    )
  }
}
