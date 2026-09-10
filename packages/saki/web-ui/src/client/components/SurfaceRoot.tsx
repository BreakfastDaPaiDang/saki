/**
 * The elected Saki main surface: owns the access read for both pages and
 * renders the page the chain selector matched. Authentication gates the
 * pages; nothing Projection-backed renders before it resolves.
 */
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiInjected } from '../index.ts'
import { NS } from '../locales.ts'
import { AccessGate } from './AccessGate.tsx'
import { WorkPage } from './WorkPage.tsx'
import { PlanningPage } from './PlanningPage.tsx'
import { ProjectPage } from './ProjectPage.tsx'

/** Full composed props for the Saki surface root. */
export type SurfaceRootProps =
  PropsRuntime<'main.surface'>
  & { matched: { page: 'work' | 'project' } }
  & InjectFace<SakiInjected>
  & PropsLocale<typeof NS>

/**
 * Render the elected Saki page behind the access gate.
 * @param props - matched page, host face, navigation actions, and copy.
 * @returns the surface element.
 */
export function SakiSurfaceRoot(props: SurfaceRootProps & { t: TranslateNS<typeof NS> }) {
  const state = props.usePlanning(snapshot => snapshot)
  const work = props.useWork(snapshot => snapshot)
  const access = state.access
  const projectId = props.useNavigation(snapshot => snapshot.projectId)
  if (access === null || access === 'unavailable' || access.kind !== 'authenticated') {
    return <AccessGate access={access} reload={() => { void props.planning.reloadAccess() }}
      t={props.t} exchange={props.exchangeBootstrap} />
  }
  if (props.matched.page === 'work') {
    return <WorkPage state={work} actions={props.work} openProject={() => { props.nav.showProject() }}
      openBoard={(id) => { props.nav.selectProject(id); props.planning.navigate({ view: 'board' }) }}
      openItem={(projectId, id) => { props.nav.selectProject(projectId); props.planning.openItem(id) }} t={props.t} />
  }
  if (state.project !== null && state.project.address.view !== 'workspace') {
    return <PlanningPage project={state.project} offline={state.offline} actions={props.planning}
      nav={props.nav} openSession={props.openSession} t={props.t} />
  }
  return (
    <ProjectPage
      showRegisteredWorkspace={() => { props.planning.navigate({ view: 'workspace' }) }}
      openBoard={() => { props.planning.navigate({ view: 'board' }) }}
      access={access}
      projectId={projectId}
      queryProjectIndex={props.queryProjectIndex}
      inspectProjectSelection={props.inspectProjectSelection}
      queryDevelopmentWorkspace={props.queryDevelopmentWorkspace}
      registerDevelopmentProject={props.registerDevelopmentProject}
      nav={props.nav}
      t={props.t}
    />
  )
}
