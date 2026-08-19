/**
 * Event-driven file handshakes for the process-exit fixture. Child settlement
 * is captured as data before any filesystem wait begins, so an already-present
 * handshake cannot leave a rejected process promise unobserved.
 */

import { once } from 'node:events'
import { watch } from 'node:fs'
import { access } from 'node:fs/promises'
import { dirname } from 'node:path'

interface ProcessOutcomeLike {
  readonly exitCode?: number | null | undefined
  readonly signal?: string | null | undefined
}

/** Phase-neutral settlement facts for one fixture process. */
export type ProcessExitObservation = {
  readonly kind: 'outcome'
  readonly subject: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly output: string
} | {
  readonly kind: 'failure'
  readonly subject: string
  readonly failure: string
  readonly output: string
}

function printable(value: unknown): string {
  try {
    return value instanceof Error ? value.message : String(value)
  } catch {
    return 'unprintable process failure'
  }
}

function capturedOutput(readOutput: () => string): string {
  try {
    return readOutput().trim()
  } catch {
    return 'process output unavailable'
  }
}

/**
 * Convert a process promise into a non-rejecting, phase-neutral observation.
 * @param done - process settlement promise; transport failures may reject it.
 * @param subject - process name used in later diagnostics.
 * @param readOutput - reads diagnostic output after settlement.
 * @returns a promise that always resolves with exit or transport-failure facts.
 */
export function observeProcessExit(
  done: Promise<ProcessOutcomeLike>,
  subject: string,
  readOutput: () => string,
): Promise<ProcessExitObservation> {
  return done.then<ProcessExitObservation, ProcessExitObservation>(
    outcome => ({
      kind: 'outcome',
      subject,
      exitCode: outcome.exitCode ?? null,
      signal: outcome.signal ?? null,
      output: capturedOutput(readOutput),
    }),
    (error: unknown) => ({
      kind: 'failure',
      subject,
      failure: printable(error),
      output: capturedOutput(readOutput),
    }),
  )
}

function exitError(observation: ProcessExitObservation, phase: string): Error {
  const output = observation.output.length === 0 ? '' : `: ${observation.output}`
  if (observation.kind === 'failure') {
    return new Error(`${observation.subject} failed during ${phase}: ${observation.failure}${output}`)
  }
  return new Error(
    `${observation.subject} exited during ${phase}`
    + ` (code ${String(observation.exitCode)}, signal ${String(observation.signal)})${output}`,
  )
}

function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

async function observeAccess(path: string): Promise<{ kind: 'exists' } | { kind: 'missing' }> {
  try {
    await access(path)
    return { kind: 'exists' }
  } catch (error) {
    if (isENOENT(error)) return { kind: 'missing' }
    throw error
  }
}

/**
 * Wait for a file without polling while failing immediately if its process
 * exits. The watcher is active before the first access, and every listener is
 * aborted before the watcher closes.
 * @param path - handshake file to observe.
 * @param exit - non-rejecting process settlement observation.
 * @param phase - operation named if the process settles before the file exists.
 * @returns after the file is observable.
 */
export async function waitForFile(
  path: string,
  exit: Promise<ProcessExitObservation>,
  phase: string,
): Promise<void> {
  const watcher = watch(dirname(path))
  const exited = exit.then(observation => ({ kind: 'exit' as const, observation }))
  try {
    for (;;) {
      const controller = new AbortController()
      const changed = once(watcher, 'change', { signal: controller.signal }).then(
        () => ({ kind: 'changed' as const }),
        (error: unknown) => {
          if (controller.signal.aborted) return { kind: 'cancelled' as const }
          throw error
        },
      )
      try {
        const initial = await Promise.race([exited, observeAccess(path)])
        if (initial.kind === 'exit') throw exitError(initial.observation, phase)
        if (initial.kind === 'exists') return
        const wake = await Promise.race([exited, changed])
        if (wake.kind === 'exit') throw exitError(wake.observation, phase)
      } finally {
        controller.abort()
      }
    }
  } finally {
    watcher.close()
  }
}
