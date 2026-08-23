/** Local filesystem identities for Git administrative directories. @module @breakfastdapaidang/saki-execution-local/identity */

import { stat } from 'node:fs/promises'
import { canonicalDigest, type RepositoryAdministrativeIdentity } from '@breakfastdapaidang/saki-execution'

/**
 * Read a stable opaque identity for one canonical Git administrative directory.
 * @param path - canonical same-Host directory path.
 * @param signal - caller lifetime checked around the filesystem probe.
 * @returns versioned identity that survives ordinary changes below the directory.
 */
export async function readLocalAdministrativeDirectoryIdentity(
  path: string,
  signal: AbortSignal,
): Promise<RepositoryAdministrativeIdentity> {
  signal.throwIfAborted()
  const value = await stat(path, { bigint: true })
  signal.throwIfAborted()
  if (!value.isDirectory()) throw new Error('Git administrative identity target is not a directory')
  return {
    version: 1,
    digest: canonicalDigest('saki/local-administrative-directory-identity/v1', {
      device: value.dev.toString(),
      inode: value.ino.toString(),
      birthtimeNs: value.birthtimeNs.toString(),
    }),
  }
}
