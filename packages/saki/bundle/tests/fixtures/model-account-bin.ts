/** Real Loader composition with fixture-only OAuth and model responses. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'
import type { Context } from '@deepseek-ai/cordis'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { boot, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { credentialKey, CREDENTIAL_PROTECTION_LOCAL_USER_TRUST } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { modelAccountProfileId, modelAccountProviderId, modelAccountRouteId } from '@breakfastdapaidang/saki-model-account'
import type { ModelAccountBinding } from '@breakfastdapaidang/saki-model-account'

const rootConfig = fileURLToPath(new URL('../../cordis.yml', import.meta.url))
const patch = fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url))
const rows = new Set(['llm', 'session', 'saki-credentials', 'saki-model-authorization', 'saki-model-accounts', 'saki-model-account-codex'])
const access = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.fixture`
const textItem = { type: 'message', id: 'fixture-message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'fixture-ok', annotations: [] }] }
const events = [
  { type: 'response.output_item.added', output_index: 0, item: { ...textItem, content: [] } },
  { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'fixture-ok' },
  { type: 'response.output_item.done', output_index: 0, item: textItem },
  { type: 'response.completed', response: { id: 'fixture-response', status: 'completed', output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]
const toolItem = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'lookup', arguments: '{}' }
const toolEvents = [
  { type: 'response.output_item.added', output_index: 0, item: { ...toolItem, arguments: '' } },
  { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{}' },
  { type: 'response.output_item.done', output_index: 0, item: toolItem },
  { type: 'response.completed', response: { id: 'fixture-tool-response', status: 'completed', output: [toolItem],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
]

async function run(): Promise<void> {
  let ctx: Context | undefined
  const originalFetch = globalThis.fetch
  const requests: Array<{ session: string | null; thread: string | null; state: string | null; account: string | null }> = []
  globalThis.fetch = async (input, init) => {
    const url = (input instanceof Request ? input.url : input.toString())
    if (url === 'https://chatgpt.com/backend-api/wham/usage') return Response.json({})
    if (url !== 'https://chatgpt.com/backend-api/codex/responses') throw new Error('Unexpected model fixture endpoint')
    const headers = new Headers(init?.headers)
    if (headers.get('authorization') !== `Bearer ${access}`) throw new Error('Fixture account credential mismatch')
    requests.push({ session: headers.get('session-id'), thread: headers.get('thread-id'),
      state: headers.get('x-codex-turn-state'), account: headers.get('chatgpt-account-id') })
    if (requests.length === 5) {
      const body = init?.body instanceof Uint8Array && headers.get('content-encoding') === 'zstd'
        ? zstdDecompressSync(init.body).toString('utf8') : init?.body
      if (typeof body !== 'string' || !body.includes('function_call_output')) {
        throw new Error('Fixture tool result did not reach the maintained transport')
      }
    }
    return new Response((requests.length === 4 ? toolEvents : events).map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream', 'x-codex-turn-state': 'fixture-state' } })
  }
  try {
    const patches = loadOverlayPatches('saki-account-test', patch)
    const inserted = (patches[0] as { insert?: EntryOptions[] } | undefined)?.insert
    if (inserted === undefined) throw new Error('Missing production account rows')
    ctx = await boot('saki-account-test', rootConfig, [
      { insert: inserted.filter(entry => typeof entry.id === 'string' && rows.has(entry.id)) },
      { id: 'saki-credentials', config: { path: join(process.cwd(), 'credentials.json') } },
    ], undefined, import.meta.url)
    const provider = ctx.sakiModelAccounts.get(modelAccountProviderId('codex'))
    if (provider === undefined) throw new Error('Codex Provider unavailable')
    const profileId = modelAccountProfileId('00000000-0000-4000-8000-000000000001')
    const binding: ModelAccountBinding = { profileId, providerId: provider.id, revision: 1,
      routeId: modelAccountRouteId(profileId, 1), accountIdentity: null,
      credentialKey: credentialKey('saki-model-account-codex', 'fixture'),
      requiredProtection: CREDENTIAL_PROTECTION_LOCAL_USER_TRUST, configuration: provider.resolveConfiguration({ models: ['gpt-5.6-sol'] }) }
    await ctx.credentials.modifyRecordProtected(binding.credentialKey, binding.requiredProtection, async () => ({
      kind: 'grant', payload: { type: 'oauth', access, refresh: 'fixture-refresh', expires: Date.now() + 3_600_000 },
    }))
    const signal = new AbortController().signal
    const snapshot = await provider.inspect(binding, signal)
    const activation = provider.createAdapter({ ...binding, accountIdentity: snapshot.identity })
    try {
      const output: string[] = []
      for (const turn of [1, 1, 2]) {
        for await (const chunk of activation.adapter.stream({ provider: binding.routeId, model: 'gpt-5.6-sol',
          sessionId: SessionId('fixture-session'), turn, messages: [createUserMessage({
            content: [{ type: 'text', text: 'fixture' }], source: { kind: 'plugin', plugin: 'fixture' },
          })], signal })) {
          if (chunk.type === 'text-delta') output.push(chunk.text)
          if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error('Fixture model did not complete')
        }
      }
      const tools: ToolSchema[] = [{ name: 'lookup', description: 'Read fixture value',
        parameters: { type: 'object', properties: {}, required: [] } }]
      const prompt = createUserMessage({ content: [{ type: 'text', text: 'Use lookup' }],
        source: { kind: 'plugin', plugin: 'fixture' } })
      const request = { provider: binding.routeId, model: 'gpt-5.6-sol', sessionId: SessionId('fixture-session'), turn: 3,
        messages: [prompt], tools, signal }
      const first = new BlockAssembler()
      for await (const chunk of activation.adapter.stream(request)) first.push(chunk)
      const call = first.blocks().find(block => block.type === 'tool-call')
      if (call === undefined || first.finish.kind !== 'tool-calls') throw new Error('Fixture tool call missing')
      const assistant = first.message({ kind: 'model', provider: binding.routeId, model: request.model,
        ...first.replayState === undefined ? {} : { replayState: first.replayState } })
      const second = new BlockAssembler()
      for await (const chunk of activation.adapter.stream({ ...request, messages: [prompt, assistant,
        createUserMessage({ content: [{ type: 'tool-result', toolCallId: call.id,
          content: [{ type: 'text', text: 'fixture value' }] }], source: { kind: 'plugin', plugin: 'fixture' } }),
      ] })) second.push(chunk)
      if (second.finish.kind !== 'stop') throw new Error('Fixture tool follow-up did not complete')
      process.stdout.write(`${JSON.stringify({ authentication: snapshot.authentication, output, requests,
        tool: { name: call.name, arguments: call.arguments, finish: second.finish.kind } })}\n`)
    } finally { activation.dispose() }
  } finally {
    await ctx?.fiber.dispose()
    globalThis.fetch = originalFetch
  }
}

await run().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
