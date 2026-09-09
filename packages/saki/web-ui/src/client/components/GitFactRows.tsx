/**
 * Shared Git fact rows (location, branch, HEAD) used by the registration
 * review and the workspace facts; the host component's CSS module supplies
 * the scoped row and mono classes.
 */
import type { ProjectGitHead } from '@breakfastdapaidang/saki-execution'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from '../locales.ts'
import { displayGitHead } from '../git-head.ts'

/** Props for one Git fact row group. */
export interface GitFactRowsProps {
  /** Display-safe directory label. */
  displayLocation: string
  /** Wire HEAD observation. */
  head: ProjectGitHead
  /** The host component's scoped classes (must define `factRow` and `mono`). */
  css: Record<string, string>
  t: TranslateNS<typeof NS>
}

/**
 * Render the location, branch, and HEAD rows.
 * @param props - fact values, scoped classes, and copy.
 * @returns the row group.
 */
export function GitFactRows(props: GitFactRowsProps) {
  const { t } = props
  const head = displayGitHead(props.head)
  return (
    <>
      <div className={props.css.factRow}><dt>{t('workspace.facts.location')}</dt><dd className={props.css.mono}>{props.displayLocation}</dd></div>
      <div className={props.css.factRow}>
        <dt>{t('workspace.facts.branch')}</dt>
        <dd className={props.css.mono}>{head.detached ? t('workspace.facts.detached') : head.branch}</dd>
      </div>
      <div className={props.css.factRow}><dt>{t('workspace.facts.head')}</dt><dd className={props.css.mono}>{head.shortHead ?? '—'}</dd></div>
    </>
  )
}
