/** Project return addresses contributed to the inherited Conversation header. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PlanningController } from '../planning-controller.ts'
import type { SakiNavigationActionsFace } from '../navigation.ts'
import { NS } from '../locales.ts'

/** Navigation-only face; the persisted address carries no execution authority. */
export interface SessionReturnInjected {
  openProject: SakiNavigationActionsFace['showProject']
  hooks: { planning: PlanningController }
}
/**
 * Return from the exact Conversation opened by Saki to its retained Project destination.
 * @param props - authenticated planning address and the current Conversation identity.
 * @returns a return action for that address, or no unrelated Session chrome.
 */
export function SessionReturn({ sessionId, usePlanning, openProject, t }: PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<SessionReturnInjected>) {
  const project = usePlanning(state => state.project)
  if (project?.address.conversationSessionId !== sessionId) return null
  return <Button size="sm" variant="outline" onClick={openProject}>{t(project.address.view === 'run' ? 'runs.back' : 'runs.returnProject')}</Button>
}
