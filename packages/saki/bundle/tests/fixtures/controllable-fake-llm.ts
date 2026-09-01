/** Controllable keyless LLM adapter used only by the Saki composition smoke. */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

/** Observable adapter state published to the smoke driver. */
export interface SakiTestLlmProbe {
  requests: number
  lastAgentRunInput?: GenerateOptions['messages'][number]
  lastAgentRunComposition?: {
    readonly provider: string
    readonly model: string
    readonly developmentPersona: boolean
    readonly filesystemTools: readonly string[]
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Test-only count of requests that crossed the fake route. */
    sakiTestLlm: SakiTestLlmProbe
  }
}

export const name = 'saki-test-llm'
export const inject = ['llm']

class ControllableFakeLlm extends LlmAdapter {
  constructor(private readonly probe: SakiTestLlmProbe) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.probe.requests += 1
    const input = options.messages.find(message => message.role === 'user'
      && message.source.kind === 'saki-agent-run')
    if (input !== undefined) {
      this.probe.lastAgentRunInput = structuredClone(input)
      this.probe.lastAgentRunComposition = {
        provider: options.provider,
        model: options.model,
        developmentPersona: options.system?.includes("You are Saki's Development Agent.") === true,
        filesystemTools: (options.tools ?? [])
          .map(tool => tool.name)
          .filter(name => name === 'read' || name === 'write' || name === 'edit')
          .sort(),
      }
    }
    if (process.env.SAKI_AGENT_RUN_SNAPSHOT === '1') {
      process.stdout.write(`${JSON.stringify({
        product: 'saki-agent-run-model-request',
        requests: this.probe.requests,
      })}\n`)
    }
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Install one test-only provider route and its request counter. */
export function apply(ctx: Context): void {
  const probe = { requests: 0 }
  ctx.provide('sakiTestLlm', probe)
  ctx.llm.registerAdapter(['saki-test'], new ControllableFakeLlm(probe))
}
