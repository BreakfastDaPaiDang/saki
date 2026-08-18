import { readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Process identities published by the managed-tree fixture. */
export interface ManagedTreeState {
  /** Root process id. */
  readonly root: number
  /** Descendant process id. */
  readonly descendant: number
  readonly [key: string]: unknown
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Read one atomically published process-tree observation. A missing target is
 * the only unpublished state; other read failures and invalid committed JSON
 * fail immediately.
 * @param path - Target observed by the parent process.
 * @returns The complete state, or undefined before its first publication.
 */
export async function readTreeState(path: string): Promise<ManagedTreeState | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
  const state = JSON.parse(text) as Partial<ManagedTreeState>
  if (!Number.isSafeInteger(state.root) || !Number.isSafeInteger(state.descendant)
    || (state.root ?? 0) <= 0 || (state.descendant ?? 0) <= 0 || state.root === state.descendant) {
    throw new Error(`invalid managed-tree state: ${text}`)
  }
  return state as ManagedTreeState
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
