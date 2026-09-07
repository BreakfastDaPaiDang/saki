/** Observe one fixture runtime's collected stdout without consuming its output. */

import type { SubprocessRuntime, SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { vi } from 'vitest'

/**
 * Observe the latest real process spawned by one runtime and restore its method on disposal.
 * @param runtime - fixture-owned subprocess service.
 * @returns non-consuming stdout observation and instance-spy disposal.
 */
export function observeSubprocessStdout(runtime: SubprocessRuntime): Disposable & {
  readonly text: () => string | undefined
} {
  const spawn = runtime.spawn.bind(runtime)
  let child: SubprocessHandle | undefined
  const observation = vi.spyOn(runtime, 'spawn').mockImplementation((spec) => {
    child = spawn(spec)
    return child
  })
  return {
    text: () => child?.collected.stdout?.readFrom(0).text,
    [Symbol.dispose]: () => { observation.mockRestore() },
  }
}
