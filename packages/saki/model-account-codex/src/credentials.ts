/** Protected pi-ai credential access for one immutable product account. @module @breakfastdapaidang/saki-model-account-codex/credentials */

import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Credential, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai'
import type { ModelAccountBinding, ModelAccountIdentity } from '@breakfastdapaidang/saki-model-account'

const credentialSchema = z.object({
  type: z.literal('oauth'), access: z.string().min(1), refresh: z.string().min(1), expires: z.number(),
}).loose()
const claimsSchema = z.object({
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1) }),
})

/**
 * Read the account claim used by the maintained Codex transport.
 * @param credential - stored OAuth record validated at the credential boundary.
 * @returns account identity; this local claim does not establish current entitlement.
 */
export function codexAccountIdentity(credential: OAuthCredential): ModelAccountIdentity {
  try {
    const encoded = credential.access.split('.')[1]
    if (encoded === undefined) throw new Error('missing claim')
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
    return brandString<ModelAccountIdentity>(claims['https://api.openai.com/auth'].chatgpt_account_id)
  } catch {
    // Only parsing this credential's account claim occurs here; its bytes never enter the failure.
    throw new LlmError('Codex credential has no usable account identity', 'INVALID_CREDENTIAL')
  }
}

/** Parse the owned opaque grant at the durable credential boundary. */
function decode(record: CredentialRecord | undefined, binding: ModelAccountBinding): OAuthCredential | undefined {
  if (record === undefined) return undefined
  const parsed = record.kind === 'grant' ? credentialSchema.safeParse(record.payload) : undefined
  if (!parsed?.success) throw new LlmError('Codex credential requires authorization', 'INVALID_CREDENTIAL')
  const credential = parsed.data
  if (binding.accountIdentity !== null && codexAccountIdentity(credential) !== binding.accountIdentity) {
    throw new LlmError('Codex credential belongs to another account', 'ACCOUNT_CHANGED')
  }
  return credential
}

/**
 * Adapt the DSH record transaction directly to pi-ai's serialized refresh operation.
 * @param credentials - captured Host credential provider.
 * @param binding - immutable key, account owner and protection requirement.
 * @returns store limited to this exact account route; ambient auth is not consulted.
 */
export function accountCredentialStore(credentials: CredentialProvider, binding: ModelAccountBinding): CredentialStore {
  const assertRoute = (id: string): void => {
    if (id !== binding.routeId) throw new LlmError('Credential route does not match account', 'ACCOUNT_CHANGED')
  }
  const read = async (): Promise<OAuthCredential | undefined> => decode(
    await credentials.readRecordProtected(binding.credentialKey, binding.requiredProtection), binding,
  )
  return {
    async read(id, options) {
      assertRoute(id)
      options?.signal?.throwIfAborted()
      const record = await read()
      options?.signal?.throwIfAborted()
      return record
    },
    async list() {
      return await read() === undefined ? [] : [{ providerId: binding.routeId, type: 'oauth' }]
    },
    async modify(id, mutate, options) {
      assertRoute(id)
      options?.signal?.throwIfAborted()
      const result = await credentials.modifyRecordProtected(binding.credentialKey, binding.requiredProtection, async (current) => {
        options?.signal?.throwIfAborted()
        const next: Credential | undefined = await mutate(decode(current, binding))
        options?.signal?.throwIfAborted()
        if (next === undefined) return undefined
        const record: CredentialRecord = { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) }
        decode(record, binding)
        return record
      })
      return decode(result, binding)
    },
    async delete(id, options) {
      assertRoute(id)
      options?.signal?.throwIfAborted()
      await credentials.deleteRecord(binding.credentialKey)
    },
  }
}
