/**
 * 「项目」 page: the Project selector and the Development Workspace of the
 * selected Project. All facts arrive through the host-face callbacks; the
 * page distinguishes loading, refreshing, offline, unavailable, denied,
 * stale, not-found, repair-required, and blocked states with text-first
 * semantics, and never reads paths or parses Git output itself.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SakiWireAccessProjection,
  SakiWireProjectIndexResult,
  SakiWireDevelopmentWorkspaceResult,
  SakiWireProjectId,
} from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiInjected } from '../index.ts'
import type { SakiNavigationActionsFace } from '../navigation.ts'
import { NS } from '../locales.ts'
import { RegisterProjectDialog } from './RegisterProjectDialog.tsx'
import css from './ProjectPage.module.css'

/** Props for the 项目 page. */
export interface ProjectPageProps {
  access: Extract<SakiWireAccessProjection, { kind: 'authenticated' }>
  /** Selected Project id from the navigation store (null renders the selector). */
  projectId: SakiWireProjectId | null
  queryProjectIndex: SakiInjected['queryProjectIndex']
  inspectProjectSelection: SakiInjected['inspectProjectSelection']
  queryDevelopmentWorkspace: SakiInjected['queryDevelopmentWorkspace']
  registerDevelopmentProject: SakiInjected['registerDevelopmentProject']
  nav: SakiNavigationActionsFace
  t: TranslateNS<typeof NS>
}

type ProjectIndex = Extract<SakiWireProjectIndexResult, { ok: true }>['projection']
type Workspace = Extract<SakiWireDevelopmentWorkspaceResult, { ok: true }>['projection']

type IndexState =
  | { phase: 'loading' }
  | { phase: 'ready'; projection: ProjectIndex; refreshing: boolean }
  | { phase: 'denied' | 'unavailable' | 'offline' }

type WorkspaceState =
  | { phase: 'loading' }
  | { phase: 'ready'; projection: Workspace; refreshing: boolean }
  | { phase: 'denied' | 'unavailable' | 'stale' | 'not-found' | 'offline' }

/** Health label key per binding health. */
function healthKey(health: Workspace['project']['binding']['health']) {
  switch (health) {
    case 'active': return 'workspace.bindingHealth.active' as const
    case 'missing': return 'workspace.bindingHealth.missing' as const
    case 'repair-required': return 'workspace.bindingHealth.repair-required' as const
  }
}

/** Localized recovery reason. */
function recoveryReasonText(reason: Workspace['recovery']['reasons'][number], t: TranslateNS<typeof NS>): string {
  switch (reason) {
    case 'binding-missing': return t('workspace.gap.binding-missing')
    case 'binding-repair-required': return t('workspace.gap.binding-repair-required')
    case 'baseline-unavailable': return t('workspace.gap.baseline-unavailable')
    case 'conversion-ambiguous': return t('workspace.gap.conversion-ambiguous')
    case 'dirty': return t('workspace.blocked.dirty')
    case 'locked': return t('workspace.blocked.locked')
  }
}

/**
 * Render the 项目 page.
 * @param props - host callbacks, navigation actions, and copy.
 * @returns the page element.
 */
export function ProjectPage(props: ProjectPageProps) {
  const { t } = props
  const [index, setIndex] = useState<IndexState>({ phase: 'loading' })
  const [registerOpen, setRegisterOpen] = useState(false)

  const loadIndex = useCallback(async (refreshing: boolean) => {
    if (refreshing) {
      setIndex(current => current.phase === 'ready' ? { ...current, refreshing: true } : current)
    }
    try {
      const result = await props.queryProjectIndex()
      if (result.ok) setIndex({ phase: 'ready', projection: result.projection, refreshing: false })
      else setIndex({ phase: result.reason === 'denied' ? 'denied' : 'unavailable' })
    } catch {
      setIndex(current => current.phase === 'ready' ? { ...current, refreshing: false } : { phase: 'offline' })
    }
    // The inject face is created once per apply, so the callback is stable.
  }, [props.queryProjectIndex])

  useEffect(() => { void loadIndex(false) }, [loadIndex])

  if (props.projectId !== null) {
    return (
      <WorkspaceView
        projectId={props.projectId}
        index={index}
        queryDevelopmentWorkspace={props.queryDevelopmentWorkspace}
        nav={props.nav}
        onRefresh={() => void loadIndex(true)}
        onRefreshIndex={() => void loadIndex(false)}
        t={t}
      />
    )
  }

  return (
    <div className={css.page}>
      <h1 className={css.title}>{t('project.selector.title')}</h1>
      {index.phase === 'loading' ? <p className={css.hint}>{t('workspace.loading')}</p> : null}
      {index.phase === 'offline' ? (
        <div className={css.notice} role="alert">
          <p>{t('workspace.offline')}</p>
          <button type="button" className={css.secondaryAction} onClick={() => void loadIndex(false)}>{t('common.retry')}</button>
        </div>
      ) : null}
      {index.phase === 'denied' ? <p className={css.notice} role="alert">{t('workspace.denied')}</p> : null}
      {index.phase === 'unavailable' ? (
        <div className={css.notice} role="alert">
          <p>{t('workspace.unavailable')}</p>
          <button type="button" className={css.secondaryAction} onClick={() => void loadIndex(false)}>{t('common.retry')}</button>
        </div>
      ) : null}
      {index.phase === 'ready' ? (
        index.projection.projects.length === 0 ? (
          <div className={css.empty}>
            <p>{t('project.selector.empty')}</p>
            <button type="button" className={css.primaryAction} onClick={() => setRegisterOpen(true)}>
              {t('project.selector.register')}
            </button>
          </div>
        ) : (
          <>
            {index.refreshing ? <p className={css.refreshing} role="status">{t('workspace.refreshing')}</p> : null}
            <ul className={css.projectList}>
              {index.projection.projects.map(project => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={css.projectRow}
                    onClick={() => { props.nav.selectProject(project.id) }}
                  >
                    <span className={css.projectName}>{project.projectTitle}</span>
                    <span className={css.projectPath}>{project.binding.displayLocation}</span>
                    <span className={css.projectStates}>
                      <span className={project.binding.health === 'active' ? css.healthOk : css.healthWarn}>
                        {t(healthKey(project.binding.health))}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <div className={css.selectorActions}>
              <button type="button" className={css.secondaryAction} onClick={() => setRegisterOpen(true)}>
                {t('project.selector.register')}
              </button>
            </div>
          </>
        )
      ) : null}
      {registerOpen && index.phase === 'ready' ? (
        <RegisterProjectDialog
          hosts={index.projection.hosts}
          expectedRegistryRevision={index.projection.revision}
          requestToken={props.access.requestToken}
          inspectProjectSelection={props.inspectProjectSelection}
          registerDevelopmentProject={props.registerDevelopmentProject}
          onClose={() => setRegisterOpen(false)}
          onRegistered={(projectId) => {
            setRegisterOpen(false)
            // The registry advanced: refresh the index before opening the
            // workspace so the query carries the current revision.
            void (async () => {
              await loadIndex(false)
              props.nav.selectProject(projectId)
            })()
          }}
          t={t}
        />
      ) : null}
    </div>
  )
}

/** The Development Workspace of one selected Project. */
function WorkspaceView(props: {
  projectId: SakiWireProjectId
  index: IndexState
  queryDevelopmentWorkspace: ProjectPageProps['queryDevelopmentWorkspace']
  nav: SakiNavigationActionsFace
  onRefresh: () => void
  onRefreshIndex: () => void
  t: TranslateNS<typeof NS>
}) {
  const { t } = props
  const [workspace, setWorkspace] = useState<WorkspaceState>({ phase: 'loading' })

  const registryRevision = props.index.phase === 'ready' ? props.index.projection.revision : 0
  const load = useCallback(async (refreshing: boolean) => {
    if (refreshing) {
      setWorkspace(current => current.phase === 'ready' ? { ...current, refreshing: true } : current)
    }
    try {
      const result = await props.queryDevelopmentWorkspace(props.projectId, registryRevision)
      if (result.ok) setWorkspace({ phase: 'ready', projection: result.projection, refreshing: false })
      else setWorkspace({ phase: result.reason })
    } catch {
      setWorkspace(current => current.phase === 'ready' ? { ...current, refreshing: false } : { phase: 'offline' })
    }
    // The inject face callback and the project id are stable across renders.
  }, [props.queryDevelopmentWorkspace, props.projectId, registryRevision])

  useEffect(() => { void load(false) }, [load])

  return (
    <div className={css.page}>
      <div className={css.workspaceHeader}>
        <h1 className={css.title}>
          {workspace.phase === 'ready' ? workspace.projection.project.projectTitle : props.projectId}
        </h1>
        <div className={css.workspaceActions}>
          <button type="button" className={css.secondaryAction} onClick={() => { props.nav.clearProject() }}>
            {t('workspace.backToSelector')}
          </button>
          <button type="button" className={css.secondaryAction} onClick={() => void load(true)} disabled={workspace.phase === 'ready' && workspace.refreshing}>
            {workspace.phase === 'ready' && workspace.refreshing ? t('workspace.refreshing') : t('workspace.refresh')}
          </button>
        </div>
      </div>
      {workspace.phase === 'loading' ? <p className={css.hint}>{t('workspace.loading')}</p> : null}
      {workspace.phase === 'offline' ? (
        <div className={css.notice} role="alert">
          <p>{t('workspace.offline')}</p>
          <button type="button" className={css.secondaryAction} onClick={() => void load(false)}>{t('common.retry')}</button>
        </div>
      ) : null}
      {workspace.phase === 'denied' ? <p className={css.notice} role="alert">{t('workspace.denied')}</p> : null}
      {workspace.phase === 'unavailable' ? <p className={css.notice} role="alert">{t('workspace.unavailable')}</p> : null}
      {workspace.phase === 'stale' ? (
        <div className={css.notice} role="alert">
          <p>{t('workspace.stale')}</p>
          <button type="button" className={css.secondaryAction} onClick={props.onRefreshIndex}>{t('workspace.refresh')}</button>
        </div>
      ) : null}
      {workspace.phase === 'not-found' ? (
        <div className={css.notice} role="alert">
          <p>{t('workspace.notFound')}</p>
          <button type="button" className={css.secondaryAction} onClick={() => { props.nav.clearProject() }}>{t('workspace.backToSelector')}</button>
        </div>
      ) : null}
      {workspace.phase === 'ready' ? (
        <WorkspaceFacts workspace={workspace.projection} refreshing={workspace.refreshing} t={t} />
      ) : null}
    </div>
  )
}

/** The confirmed workspace facts; repair states are read-only in this slice. */
function WorkspaceFacts(props: { workspace: Workspace; refreshing: boolean; t: TranslateNS<typeof NS> }) {
  const { workspace, t } = props
  const binding = workspace.project.binding
  return (
    <div className={css.facts}>
      {props.refreshing ? <p className={css.refreshing} role="status">{t('workspace.refreshing')}</p> : null}
      <dl className={css.factList}>
        <div className={css.factRow}><dt>{t('workspace.facts.location')}</dt><dd className={css.mono}>{binding.displayLocation}</dd></div>
        <div className={css.factRow}>
          <dt>{t('workspace.facts.branch')}</dt>
          <dd className={css.mono}>{binding.detached ? t('workspace.facts.detached') : (binding.branch ?? '—')}</dd>
        </div>
        <div className={css.factRow}><dt>{t('workspace.facts.head')}</dt><dd className={css.mono}>{binding.head.slice(0, 10)}</dd></div>
        <div className={css.factRow}>
          <dt>{t('workspace.facts.inherited')}</dt>
          <dd>{binding.inheritedChangeEntryCount === 0 ? t('workspace.facts.none') : `${binding.inheritedChangeEntryCount} ${t('workspace.facts.inherited.count')}`}</dd>
        </div>
        <div className={css.factRow}>
          <dt>{t('workspace.facts.baseline')}</dt>
          <dd>{binding.baseline === 'complete' ? t('workspace.facts.baseline.complete') : t('workspace.facts.baseline.unavailable')}</dd>
        </div>
        <div className={css.factRow}>
          <dt>{t('workspace.facts.binding')}</dt>
          <dd>
            <span className={binding.health === 'active' ? css.healthOk : css.healthWarn}>{t(healthKey(binding.health))}</span>
          </dd>
        </div>
        <div className={css.factRow}>
          <dt>{t('workspace.facts.gaps')}</dt>
          <dd>
            {binding.configurationGaps.length === 0
              ? t('workspace.facts.none')
              : binding.configurationGaps.map(gap => t(`workspace.gap.${gap}` as Parameters<typeof t>[0])).join('；')}
          </dd>
        </div>
      </dl>
      {workspace.recovery.state === 'blocked' ? (
        <div className={css.notice} role="alert">
          <p className={css.blockedTitle}>{t('workspace.blocked.title')}</p>
          <ul className={css.blockedList}>
            {workspace.recovery.reasons.map(reason => (
              <li key={reason}>{recoveryReasonText(reason, t)}</li>
            ))}
          </ul>
          <p className={css.hint}>{t('workspace.repairNote')}</p>
        </div>
      ) : null}
      {binding.health !== 'active' ? (
        <div className={css.notice} role="alert">
          <p>{t(healthKey(binding.health))} — {t('workspace.repairNote')}</p>
        </div>
      ) : null}
    </div>
  )
}
