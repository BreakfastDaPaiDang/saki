/** Principal-scoped requirement drafts, return addresses, and exact submitted Work Intents. */
import { z } from 'zod'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { sakiCreateWorkItemIntentSchema, sakiGiveWorkItemToAgentIntentSchema, sakiAnswerInterventionIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'

const intentSchema = z.discriminatedUnion('type', [sakiCreateWorkItemIntentSchema, sakiGiveWorkItemToAgentIntentSchema, sakiAnswerInterventionIntentSchema])
const draftSchema = z.object({ title: z.string(), intendedOutcome: z.string(), acceptanceCriteria: z.string() }).strict()
const scopeSchema = z.object({
  projectId: sakiCreateWorkItemIntentSchema.shape.projectId.nullable(),
  drafts: z.record(z.string(), draftSchema),
  answers: z.record(z.string(), z.string()),
  pending: z.record(z.string(), intentSchema),
}).strict()
const stateSchema = z.object({ scopes: z.record(z.string(), scopeSchema) }).strict()
type State = z.infer<typeof stateSchema>
/** Persisted input remains editable only before an Intent is submitted. */
export type WorkDraft = z.infer<typeof draftSchema>
/** The exact effect request survives transport loss and browser restart. */
export type WorkIntent = z.infer<typeof intentSchema>
/** Interaction data belongs to one authenticated Principal. */
export type WorkScope = z.infer<typeof scopeSchema>

/**
 * Construct a fresh empty requirement draft.
 * @returns editable product fields.
 */
export function emptyWorkDraft(): WorkDraft { return { title: '', intendedOutcome: '', acceptanceCriteria: '' } }

/**
 * Construct persisted Work interactions without credentials or cached business facts.
 * @returns the store factory; its owner validates hydration before use.
 */
export function createWorkStore(): EngineStoreHandle<State, {
  hydrate: (state: State, input: unknown) => void
  scope: (state: State, principalId: string, scope: WorkScope) => void
}> {
  return defineStore({
    init: (): State => ({ scopes: {} }), persist: 'saki.work',
    actions: {
      hydrate: (state: State, input: unknown) => {
        const parsed = stateSchema.safeParse(input)
        state.scopes = parsed.success ? parsed.data.scopes : {}
      },
      scope: (state: State, principalId: string, scope: WorkScope) => { state.scopes[principalId] = scope },
    },
  })
}

/**
 * Resolve an untouched Principal's viewing and input state.
 * @returns no implicit Project selection.
 */
export function emptyWorkScope(): WorkScope { return { projectId: null, drafts: {}, answers: {}, pending: {} } }
