/**
 * One Saki primary navigation entry in the sidebar. Pure presentation: the
 * active state and the open action arrive through the props shares; the row
 * renders its rail form from the shell's `wide` flag.
 */
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiNavigationState } from '../navigation.ts'
import type { NS } from '../locales.ts'
import css from './SakiNavEntry.module.css'

/** Inject face produced by the entry's register call. */
export interface SakiNavEntryInjected {
  /** Open this entry's surface. */
  open: () => void
  /** The entry's own surface, for active-state projection. */
  sakiSurface: 'work' | 'project'
}

/** Full composed props for a Saki primary navigation entry. */
export type SakiNavEntryProps =
  PropsRuntime<'sidebar.primary.action'>
  & SakiNavEntryInjected
  & PropsLocale<typeof NS>
  & {
    /** Bound from the inject hooks compartment by the renderer. */
    useNavigation: <S>(select: (state: SakiNavigationState) => S) => S
  }

/**
 * Render one 「工作」/「项目」 entry row; the collapsed rail keeps the icon.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function SakiNavEntry(props: SakiNavEntryProps & { t: TranslateNS<typeof NS> }) {
  const active = props.useNavigation(state => state.surface === props.sakiSurface)
  const label = props.t(props.sakiSurface === 'work' ? 'nav.work' : 'nav.project')
  return (
    <button
      type="button"
      className={[css.entry, active ? css.active : '', props.wide ? '' : css.rail].filter(Boolean).join(' ')}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      onClick={() => { props.open() }}
    >
      <span className={css.icon} aria-hidden="true">{props.sakiSurface === 'work' ? '▤' : '▦'}</span>
      {props.wide ? <span className={css.label}>{label}</span> : null}
    </button>
  )
}
