/** Durable account ownership and Control Intent references. @module @breakfastdapaidang/saki-control-plane/model-supply-validation */
import { modelAccountProfileId, modelAccountRouteId } from '@breakfastdapaidang/saki-model-account'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { isDeepStrictEqual } from 'node:util'
import type { ModelAccountTable, ModelAccountIntentTable } from './model-supply.ts'
import type { ModelAccountIntentRecord } from './model-supply-spec.ts'
import type { ControlIntentActor } from './spec.ts'

/**
 * Validate account record relationships without provider I/O or credential reads.
 * @param profiles - complete Profile inventory.
 * @param intents - complete account Intent inventory.
 * @param validateActor - control-plane authority-reference validator.
 * @returns validated Intents for cross-family identity checks.
 */
export function validateModelSupplyRecords(
  profiles: ModelAccountTable,
  intents: ModelAccountIntentTable,
  validateActor: (actor: ControlIntentActor) => void,
): readonly ModelAccountIntentRecord[] {
  const records: ModelAccountIntentRecord[] = []
  for (const [key, intent] of intents.entries()) {
    if (key !== intent.id || key !== intent.request.intentId) throw new Error('Model Account Intent identity mismatch')
    validateActor(intent.actor)
    const request = intent.request
    if (request.type === 'cancel-model-authorization') {
      const target = intents.get(request.authorizationIntentId)
      if (target?.request.type !== 'authorize-model-account' || target.profileId !== intent.profileId
        || intent.binding !== null || intent.implementation !== null) throw new Error('Invalid account cancellation reference')
    } else {
      const expectedId = request.type === 'authorize-model-account'
        ? request.existing?.profileId ?? modelAccountProfileId(request.intentId.slice('intent-'.length)) : request.profileId
      if (intent.profileId !== expectedId || intent.binding?.profileId !== expectedId || intent.implementation === null) {
        throw new Error('Model Account Intent has inconsistent Profile ownership')
      }
      if (intent.binding.routeId !== modelAccountRouteId(expectedId, intent.binding.revision)) {
        throw new Error('Model Account Intent has inconsistent route attribution')
      }
      if (request.type === 'authorize-model-account' && request.providerId !== intent.binding.providerId) {
        throw new Error('Model Account authorization changed Provider identity')
      }
      if (request.type === 'authorize-model-account' && intent.binding.credentialKey
        !== credentialKey(`saki-model-account-${request.providerId}`, `authorization-${intent.id}`)) {
        throw new Error('Model Account authorization has a foreign credential address')
      }
    }
    if (intent.progress !== null && (request.type !== 'authorize-model-account' || intent.state !== 'authorizing')) {
      throw new Error('Terminal Model Account Intent retains a login challenge')
    }
    records.push(intent)
  }
  const credentialOwners = new Map<string, string>()
  for (const [key, profile] of profiles.entries()) {
    if (key !== profile.id || key !== profile.binding.profileId
      || profile.binding.routeId !== modelAccountRouteId(key, profile.binding.revision)
      || profile.binding.accountIdentity === null || (!profile.connected && profile.desiredActive)) {
      throw new Error('Model Account Profile has inconsistent route ownership')
    }
    const previousOwner = credentialOwners.get(profile.binding.credentialKey)
    if (previousOwner !== undefined && previousOwner !== profile.id) throw new Error('Model Accounts share a credential address')
    credentialOwners.set(profile.binding.credentialKey, profile.id)
    const intent = intents.get(profile.changedByIntentId)
    if (intent === undefined || intent.profileId !== profile.id || intent.request.type === 'cancel-model-authorization') {
      throw new Error('Model Account Profile has no owning mutation Intent')
    }
    if (intent.binding === null || !isDeepStrictEqual(profile.binding,
      { ...intent.binding, accountIdentity: profile.binding.accountIdentity })) {
      throw new Error('Model Account Profile binding differs from its owning Intent')
    }
    const authorization = records.find(record => record.request.type === 'authorize-model-account'
      && record.binding?.credentialKey === profile.binding.credentialKey)
    if (authorization?.profileId !== profile.id) {
      throw new Error('Model Account Profile has no owning authorization')
    }
    if (profile.snapshot?.authentication === 'authorized' && profile.snapshot.identity !== profile.binding.accountIdentity) {
      throw new Error('Model Account observation belongs to a different account')
    }
  }
  return records
}
