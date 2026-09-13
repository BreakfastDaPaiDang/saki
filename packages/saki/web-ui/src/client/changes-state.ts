/** Principal-scoped commit drafts and exact Git requests retained until acknowledged. */
import { z } from 'zod'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { sakiStageFilesIntentSchema, sakiUnstageFilesIntentSchema, sakiCreateCommitIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'

/** Strict persisted Git request without browser-supplied paths or credentials. */
export const changesIntentSchema = z.discriminatedUnion('type', [sakiStageFilesIntentSchema, sakiUnstageFilesIntentSchema, sakiCreateCommitIntentSchema])
const projectSchema = z.object({ message: z.string(), pending: changesIntentSchema.nullable() }).strict()
const stateSchema = z.object({ scopes: z.record(z.string(), z.record(z.string(), projectSchema)) }).strict()
type State = z.infer<typeof stateSchema>
/** An original request is the only source for retry. */
export type ChangesIntent = z.infer<typeof changesIntentSchema>
/** Editable draft and unresolved request for one Project. */
export type ChangesDraft = z.infer<typeof projectSchema>

/**
 * Construct durable browser interaction state; the controller validates hydration.
 * @returns a store factory partitioned by Principal and Project.
 */
export function createChangesStore(): EngineStoreHandle<State, {
  hydrate: (state: State, input: unknown) => void
  project: (state: State, principalId: string, projectId: string, value: ChangesDraft) => void
}> {
  return defineStore({
    init: (): State => ({ scopes: {} }), persist: 'saki.changes',
    actions: {
      hydrate: (state: State, input: unknown) => {
        const parsed = stateSchema.safeParse(input)
        state.scopes = parsed.success ? parsed.data.scopes : {}
      },
      project: (state: State, principalId: string, projectId: string, value: ChangesDraft) => {
        const scope = state.scopes[principalId] ??= {}
        scope[projectId] = value
      },
    },
  })
}
