/**
 * The elected Saki main surface: owns the access read for both pages and
 * renders the page the chain selector matched. Authentication gates the
 * pages; nothing Projection-backed renders before it resolves.
 */
import { useCallback, useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiWireAccessProjection } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiInjected } from '../index.ts'
import { NS } from '../locales.ts'
import { AccessGate } from './AccessGate.tsx'
import { WorkPage } from './WorkPage.tsx'
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
  const [access, setAccess] = useState<SakiWireAccessProjection | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Hooks run unconditionally before any early return below.
  const projectId = props.useNavigation(state => state.projectId)

  useEffect(() => {
    let cancelled = false
    void props.readAccess().then((projection) => {
      if (!cancelled) setAccess(projection)
    }).catch(() => {
      if (!cancelled) setAccess({ kind: 'unavailable', message: 'Local access is temporarily unavailable.' })
    })
    return () => { cancelled = true }
    // The inject face is created once per apply, so readAccess is stable.
  }, [props.readAccess, reloadKey])

  const reload = useCallback(() => { setReloadKey(key => key + 1) }, [])
  const exchange = props.exchangeBootstrap

  if (access === null || access.kind !== 'authenticated') {
    return <AccessGate access={access} reload={reload} t={props.t} exchange={async (secret) => {
      const result = await exchange(secret)
      if (result.ok) {
        setAccess(result.access)
      }
      return result
    }} />
  }
  if (props.matched.page === 'work') {
    return <WorkPage openProject={() => { props.nav.showProject() }} t={props.t} />
  }
  return (
    <ProjectPage
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
