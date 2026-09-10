/** Shared presentation for independent planning read health. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { PlanningRead } from '../planning-controller.ts'
import { NS } from '../locales.ts'
import css from './PlanningPage.module.css'
type Copy = TranslateNS<typeof NS>

/**
 * @param props - independent read health and copy.
 * @returns localized loading/failure notice.
 */
export function ReadHealth(props: { read: PlanningRead<unknown>; t: Copy }) {
  return <>{props.read.loading ? <p className={css.hint} role="status">{props.t('planning.loading')}</p> : null}
    {props.read.failure === null ? null : <p className={css.notice} role="alert">{props.t(props.read.failure === 'denied' ? 'planning.denied' : props.read.failure === 'not-found' ? 'planning.not-found' : props.read.failure === 'offline' ? 'planning.offline' : 'planning.unavailable')}</p>}</>
}
