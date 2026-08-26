/** Safe removal of a journal-owned directory entry during deterministic recovery. */

import { lstatSync, rmSync, unlinkSync } from 'node:fs'
import { SakiMaintenanceError } from './error.ts'

/**
 * Remove one exact journal-owned directory entry without following a symlink or Windows junction.
 * @param path - resolved Installation-internal path selected by an immutable journal.
 * @param signal - cancellation checked before touching the filesystem.
 * @returns after the entry is missing or safely removed.
 */
export function removeOwnedDirectory(path: string, signal: AbortSignal): void {
  signal.throwIfAborted()
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return
    throw error
  }
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stat.isDirectory()) {
    throw new SakiMaintenanceError(
      'recovery-required',
      `journal-owned directory path '${path}' contains an unexpected filesystem entry`,
    )
  }
  rmSync(path, { recursive: true })
}
