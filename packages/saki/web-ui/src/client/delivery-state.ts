/** Principal-scoped PR drafts and original delivery requests retained across browser reload. */
import { z } from 'zod'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { sakiSaveBranchDeliveryIntentSchema, sakiPushBranchDeliveryIntentSchema, sakiCreateBranchDeliveryPullRequestIntentSchema, sakiAssociateBranchDeliveryPullRequestIntentSchema, sakiMarkBranchDeliveryInReviewIntentSchema, sakiAcceptBranchDeliveryIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'

/** Closed, path-free requests accepted by the delivery API. */
export const deliveryIntentSchema = z.discriminatedUnion('type', [sakiSaveBranchDeliveryIntentSchema, sakiPushBranchDeliveryIntentSchema, sakiCreateBranchDeliveryPullRequestIntentSchema, sakiAssociateBranchDeliveryPullRequestIntentSchema, sakiMarkBranchDeliveryInReviewIntentSchema, sakiAcceptBranchDeliveryIntentSchema])
/** Exact admitted payload; retries never replace its revisions or text. */
export type DeliveryIntent = z.infer<typeof deliveryIntentSchema>

const draftSchema = z.object({
  headRef: z.string().nullable(), baseRef: z.string().nullable(), title: z.string().nullable(), body: z.string(),
}).strict()
const confirmationSchema = z.object({
  request: deliveryIntentSchema,
  workItemId: sakiSaveBranchDeliveryIntentSchema.shape.workItemId,
  summary: z.object({
    repository: z.string(), commitId: z.string(), headRef: z.string(), baseRef: z.string(),
    helper: z.string().nullable(), appId: z.string(), installationId: z.string(),
  }).strict(),
}).strict()
const projectSchema = z.object({ drafts: z.record(z.string(), draftSchema), pending: confirmationSchema.nullable() }).strict()
const stateSchema = z.object({ scopes: z.record(z.string(), z.record(z.string(), projectSchema)) }).strict()
type State = z.infer<typeof stateSchema>
/** User-editable branch and Pull Request text for one Work Item. */
export type DeliveryDraft = z.infer<typeof draftSchema>
/** Frozen confirmation accompanies the original request during recovery. */
export type DeliveryConfirmation = z.infer<typeof confirmationSchema>
/** A Project has one unresolved gesture across its Work Items. */
export type DeliveryProjectState = z.infer<typeof projectSchema>

/**
 * Declare browser persistence for explicit delivery interactions.
 * @returns store factory partitioned by Principal and Project.
 */
export function createDeliveryStore(): EngineStoreHandle<State, {
  hydrate: (state: State, input: unknown) => void
  project: (state: State, principalId: string, projectId: string, value: DeliveryProjectState) => void
}> {
  return defineStore({
    init: (): State => ({ scopes: {} }), persist: 'saki.delivery',
    actions: {
      hydrate: (state: State, input: unknown) => {
        const parsed = stateSchema.safeParse(input); state.scopes = parsed.success ? parsed.data.scopes : {}
      },
      project: (state: State, principalId: string, projectId: string, value: DeliveryProjectState) => {
        const scope = state.scopes[principalId] ??= {}; scope[projectId] = value
      },
    },
  })
}
