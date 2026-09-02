/** Controllable keyless LLM adapter used only by the Saki composition smoke. */

import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

const INTERVENTION_CALL_ID = CallId('saki-agent-run-intervention')
const INTERVENTION_QUESTION = 'Should this Agent Run preserve the current repository state before continuing?'

/** Observable adapter state published to the smoke driver. */
export interface SakiTestLlmProbe {
  requests: number
  lastAgentRunInput?: GenerateOptions['messages'][number]
  lastInterventionAnswerInput?: GenerateOptions['messages'][number]
  lastAgentRunComposition?: {
    readonly provider: string
    readonly model: string
    readonly developmentPersona: boolean
    readonly filesystemTools: readonly string[]
    readonly interventionTool: boolean
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
    const interventionAnswer = options.messages.findLast(message => message.role === 'user'
      && message.source.kind === 'saki-intervention-answer')
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
        interventionTool: options.tools?.some(tool => tool.name === 'request_intervention') === true,
      }
    }
    if (interventionAnswer !== undefined) {
      this.probe.lastInterventionAnswerInput = structuredClone(interventionAnswer)
    }
    if (process.env.SAKI_AGENT_RUN_SNAPSHOT === '1') {
      process.stdout.write(`${JSON.stringify({
        product: 'saki-agent-run-model-request',
        requests: this.probe.requests,
      })}\n`)
    }
    const alreadyRequested = options.messages.some(message => message.content.some(block =>
      block.type === 'tool-result' && block.toolCallId === INTERVENTION_CALL_ID))
    if (input !== undefined && interventionAnswer === undefined && !alreadyRequested) {
      if (this.probe.lastAgentRunComposition?.interventionTool !== true) {
        throw new Error('Saki Agent Run snapshot is missing request_intervention')
      }
      const argumentsJson = JSON.stringify({ question: INTERVENTION_QUESTION })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: INTERVENTION_CALL_ID,
        name: 'request_intervention',
        argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: INTERVENTION_CALL_ID,
          name: 'request_intervention',
          arguments: argumentsJson,
        },
      }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
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
