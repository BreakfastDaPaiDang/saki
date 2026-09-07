/** Process provider for Saki's real-Git behavior fixtures. */

import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * Use POSIX process groups for Linux Git behavior tests. Native containment is
 * exercised by GitRunner tests and the assembled Saki expected-output cases.
 */
export default class SakiGitFixtureSubprocess extends LocalSubprocessRuntime {
  /** The Darwin selection uses the shared POSIX process-group implementation. */
  override internals = process.platform === 'linux' ? { platform: 'darwin' as const } : {}
}
