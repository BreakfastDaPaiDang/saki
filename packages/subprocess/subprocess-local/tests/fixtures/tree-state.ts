import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

interface ManagedTreeState {
  readonly root: number
  readonly descendant: number
  readonly [key: string]: unknown
}

/**
 * Publish a complete process-tree observation without exposing staged bytes at
 * the target path.
 * @param path - Target observed by the parent process.
 * @param state - Complete root and descendant identity document.
 * @returns A promise that settles after the atomic replacement commits.
 */
export async function publishTreeState(path: string, state: ManagedTreeState): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(state), { mode: 0o600 })
}
