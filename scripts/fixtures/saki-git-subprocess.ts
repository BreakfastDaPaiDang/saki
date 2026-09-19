/** Process provider for Saki's real-Git behavior fixtures. */

import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'

/**
 * Exercise real Git with the provider's platform fallback, avoiding a source-runner
 * bootstrap for every command. GitRunner, process expectations, and launcher smokes retain native ownership.
 */
export default class SakiGitFixtureSubprocess extends LocalSubprocessRuntime {
  /** @inheritdoc */
  protected override selectContainmentMode(): 'fallback' { return 'fallback' }
}
