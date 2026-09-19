/** Process provider for Saki's real-Git behavior fixtures. */

import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * Exercise real Git with the provider's platform fallback, avoiding a source-runner
 * bootstrap for every command. GitRunner and assembled Saki cases retain native ownership.
 */
export default class SakiGitFixtureSubprocess extends LocalSubprocessRuntime {
  /** @inheritdoc */
  protected override selectContainmentMode(): 'fallback' { return 'fallback' }
}
