import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageSqlite from '@deepseek-ai/dsh-storage-sqlite'

/** Mount one isolated durable domain backend for a Local Host provider test. */
export async function mountLocalHostOperationStorage(
  ctx: Context,
  cleanupRoots: string[],
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'saki-execution-local-storage-'))
  cleanupRoots.push(root)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageSqlite, { path: join(root, 'saki.db'), journalMode: 'delete' })
  await ctx.plugin(StorageDomain, { backend: 'sqlite' })
}
