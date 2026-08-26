/**
 * 「工作」 page. This slice ships no My Work Projection, so the page says so
 * honestly and points to 「项目」 — an explicit unavailable state rather than
 * a silently hidden control (the frontend contract's unavailable semantics).
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import css from './WorkPage.module.css'

/** Props for the Work page placeholder. */
export interface WorkPageProps {
  /** Open the 「项目」 surface. */
  openProject: () => void
  t: TranslateNS<typeof NS>
}

/**
 * Render the Work page's unavailable state.
 * @param props - callbacks and copy.
 * @returns the page element.
 */
export function WorkPage(props: WorkPageProps) {
  const { t } = props
  return (
    <div className={css.page}>
      <h1 className={css.title}>{t('work.title')}</h1>
      <div className={css.card} role="status">
        <p className={css.cardTitle}>{t('work.unavailable.title')}</p>
        <p className={css.detail}>{t('work.unavailable.detail')}</p>
        <button type="button" className={css.action} onClick={props.openProject}>
          {t('work.unavailable.openProject')}
        </button>
      </div>
    </div>
  )
}
