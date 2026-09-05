/**
 * Junction-safe fixture cleanup for Windows. Test fixtures junction the REAL
 * `scripts/`, `node_modules`, and tsx package directories so installer probes
 * resolve through them; Windows recursive deletion — both Node's `rmSync` and
 * Git's `worktree remove` — follows MOUNT_POINT junctions into their targets
 * and would delete the repository's own directories. POSIX `unlink`/`rm`
 * already remove symlinks without following them, so the walk is a no-op
 * there.
 */

import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Recursively unlink every symbolic link (junction) under `path`.
 * @param path - the fixture tree whose reparse points are unlinked.
 */
export function unlinkFixtureLinks(path: string): void {
  const visit = (entry: string): void => {
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      if (stat.isSymbolicLink()) unlinkSync(entry)
      return
    }
    for (const child of readdirSync(entry)) visit(join(entry, child))
  }
  visit(path)
}

/**
 * Remove one fixture tree after unlinking its junctions. Awaited removal retries
 * transient Windows process and antivirus handles with bounded delays.
 * @param path - the fixture tree to remove.
 * @returns completion after the tree is removed.
 */
export async function removeFixtureSafely(path: string): Promise<void> {
  unlinkFixtureLinks(path)
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
