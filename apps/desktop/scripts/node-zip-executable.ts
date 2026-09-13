/** Select the Node executable without materializing ZIP entry paths or symbolic links. */

import { writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'

/**
 * Write the selected executable as a new regular file.
 * @param archive - Node.js ZIP bytes verified against the release checksum.
 * @param entryName - exact executable entry for the requested Node.js release and architecture.
 * @param destination - caller-owned output path, independent of archive entry names.
 * @returns completion after writing the executable; rejects malformed archives, missing entries, and existing outputs.
 */
export async function writeNodeZipExecutable(archive: Uint8Array, entryName: string, destination: string): Promise<void> {
  const executable = unzipSync(archive, { filter: entry => entry.name === entryName })[entryName]
  if (executable === undefined) throw new Error(`desktop runtime: ${entryName} is absent from the Node.js ZIP`)
  await writeFile(destination, executable, { flag: 'wx' })
}
