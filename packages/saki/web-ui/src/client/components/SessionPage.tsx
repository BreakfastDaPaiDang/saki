/** Retained Work Sessions, Run evidence, and owner-scoped Terminal scrollback. */
import { Button, CodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiInjected } from '../index.ts'
import type { PlanningActions, PlanningProject } from '../planning-controller.ts'
import { NS } from '../locales.ts'
import { ReadHealth } from './PlanningReadHealth.tsx'
import css from './SessionPage.module.css'

type Copy = TranslateNS<typeof NS>
type RunView = NonNullable<PlanningProject['run']['value']>
/** Protected execution reads and ordinary navigation gestures. */
export interface SessionPageProps {
  project: PlanningProject
  actions: PlanningActions
  openSession: SakiInjected['openSession']
  openWork: () => void
  offline: boolean
  t: Copy
}
const time = (value: number) => new Date(value).toLocaleString()

/**
 * Render retained Sessions or the selected Run without starting or restoring an Agent.
 * @param props - current Project reads and navigation callbacks.
 * @returns bounded execution evidence with independent read health.
 */
export function SessionPage(props: SessionPageProps) {
  const { project, actions, t } = props
  const isRun = project.address.view === 'run'
  return <main className={css.page}>
    <header className={css.header}>
      <div><h1>{t(isRun ? 'runs.title' : 'sessions.title')}</h1><p>{project.board.value?.confirmed?.project.title}</p></div>
      <div className={css.actions}>
        <Button variant="outline" onClick={actions.backToBoard}>{t('planning.back')}</Button>
        {isRun ? <Button variant="outline" onClick={() => { actions.navigate({ view: project.address.runReturnView }) }}>{t(project.address.runReturnView === 'detail' ? 'changes.backItem' : 'sessions.title')}</Button> : null}
        <Button variant="outline" onClick={() => { void actions.refresh() }}>{t('runs.refresh')}</Button>
      </div>
    </header>
    {props.offline ? <p role="alert" className={css.notice}>{t('planning.offline')}</p> : null}
    <ReadHealth read={isRun ? project.run : project.sessions} t={t} />
    {isRun ? project.run.value === null ? null : <RunDetails {...props} view={project.run.value} />
      : <Sessions project={project} actions={actions} t={t} /> }
  </main>
}
function Sessions({ project, actions, t }: Pick<SessionPageProps, 'project' | 'actions' | 't'>) {
  const page = project.sessions.value
  return <section aria-label={t('sessions.title')}>
    <p className={css.notice}>{t('sessions.help')}</p>
    {project.address.sessionsWorkItemId === null ? null : <Button variant="outline" onClick={() => { actions.navigate({ sessionsWorkItemId: null, sessionsAfter: null }) }}>{t('sessions.all')}</Button>}
    {page === null ? null : <>
      {page.items.length === 0 ? <p>{t('sessions.empty')}</p> : <ul className={css.sessions}>{page.items.map(session => <li className={css.card} key={session.id}>
        <h2><Button variant="outline" onClick={() => { actions.openItem(session.workItem.id) }}>#{session.workItem.issueNumber} {session.workItem.title}</Button></h2>
        <p>{t('sessions.primary')} · {t(`planning.state.${session.state}`)} · {time(session.updatedAt)}</p>
        <p>{t('delivery.workItemStatus')} {session.workItem.status === null ? t('planning.unavailable') : t(`planning.status.${session.workItem.status}`)}</p>
        <ul className={css.rows}>{session.runs.map(run => <li key={run.id}>
          <Button onClick={() => { actions.navigate({ view: 'run', agentRunId: run.id, workItemId: session.workItem.id, runReturnView: 'sessions', runTab: 'overview', dispatchAfter: null, terminal: null, runReferencesOpen: false }) }}>{t(run.id === session.assignment.currentAgentRunId ? 'runs.current' : 'runs.history')}</Button>
          <span>{t(`planning.state.${run.state}`)} · {time(run.updatedAt)}</span>
          <code>{run.id}</code>
        </li>)}</ul>
      </li>)}</ul>}
      <div className={css.actions}>
        {project.address.sessionsAfter === null ? null : <Button onClick={() => { actions.navigate({ sessionsAfter: null }) }}>{t('runs.firstPage')}</Button>}
        {page.next === null ? null : <Button onClick={() => { actions.navigate({ sessionsAfter: page.next }) }}>{t('runs.nextPage')}</Button>}
      </div>
    </>}
  </section>
}
function RunDetails(props: SessionPageProps & { view: RunView }) {
  const { project, actions, view, t } = props
  const session = view.observation.session
  const item = view.workSession.workItem
  return <>
    <h2>#{item.issueNumber} {item.title}</h2>
    <p role="status" aria-live="polite" className={css.status}>{t(`runs.state.${view.status}`)}</p>
    <p className={css.notice}>{t('runs.outcomeHelp')}</p>
    <div className={css.actions}>
      <Button onClick={() => { props.openSession(view.run.sessionId) }}>{t('planning.openSession')}</Button>
      <Button variant="outline" onClick={() => { actions.openItem(item.id) }}>{t('changes.backItem')}</Button>
      <Button variant="outline" onClick={() => { actions.navigate({ view: 'changes', workItemId: item.id, changesRunId: view.run.id, executionReturnView: 'run' }) }}>{t('changes.title')}</Button>
      <Button variant="outline" onClick={() => { actions.navigate({ view: 'delivery', workItemId: item.id, changesRunId: view.run.id, executionReturnView: 'run' }) }}>{t('delivery.title')}</Button>
    </div>
    <nav className={css.tabs} aria-label={t('runs.details')}>
      {(['overview', 'trace', 'terminal'] as const).map(tab => <Button key={tab} aria-current={project.address.runTab === tab ? 'page' : undefined} onClick={() => { actions.navigate({ runTab: tab }) }}>{t(`runs.tab.${tab}`)}</Button>)}
    </nav>
    {project.address.runTab === 'overview' ? <section>
      <dl className={css.facts}>
        <div><dt>{t('sessions.primary')}</dt><dd>{t(`planning.state.${view.workSession.state}`)}</dd></div>
        <div><dt>{t('runs.requestState')}</dt><dd>{t(`planning.state.${view.run.state}`)}</dd></div>
        <div><dt>{t('runs.source')}</dt><dd>{t('runs.manual')}</dd></div>
        <div><dt>{t('runs.actor')}</dt><dd><code>{view.run.source.principalId}</code></dd></div>
        <div><dt>{t('runs.profile')}</dt><dd>{t('runs.profileVersion', { id: view.run.profile.id, version: view.run.profile.version })}</dd></div>
        <div><dt>{t('runs.model')}</dt><dd>{view.run.profile.modelRoute.provider} / {view.run.profile.modelRoute.model}</dd></div>
        <div><dt>{t('runs.created')}</dt><dd>{time(view.run.createdAt)}</dd></div>
        <div><dt>{t('changes.observed')}</dt><dd>{time(view.observation.observedAt)}</dd></div>
        <div><dt>{t('delivery.workItemStatus')}</dt><dd>{item.status === null ? t('planning.unavailable') : t(`planning.status.${item.status}`)}</dd></div>
      </dl>
      {session.state === 'confirmed' ? <>
        <p>{t('runs.historyAvailable')}</p>
        <p>{t(`runs.runtime.${session.runtime}`)}</p>
        {session.activity.endedAt === null ? null : <p>{t('runs.ended', { time: time(session.activity.endedAt) })}</p>}
      </> : <p className={css.notice}>{t(`runs.session.${session.reason}`)}</p>}
      <p>{view.observation.terminals.state === 'unavailable' ? t(`runs.terminal.${view.observation.terminals.reason}`) : t('runs.terminal.available', { count: view.observation.terminals.items.length })}</p>
      <details open={project.address.runReferencesOpen} onToggle={(event) => {
        if (event.currentTarget.open !== project.address.runReferencesOpen) {
          actions.navigate({ runReferencesOpen: event.currentTarget.open })
        }
      }}>
        <summary>{t('planning.reference')}</summary>
        <dl className={css.facts}>
          <div><dt>{t('sessions.workSession')}</dt><dd><code>{view.workSession.id}</code></dd></div>
          <div><dt>{t('sessions.dshSession')}</dt><dd><code>{view.run.sessionId}</code></dd></div>
          <div><dt>{t('runs.title')}</dt><dd><code>{view.run.id}</code></dd></div>
          <div><dt>{t('runs.intent')}</dt><dd><code>{view.run.source.intentId}</code></dd></div>
        </dl>
      </details>
    </section> : null}
    {project.address.runTab === 'trace' ? <section>
      <h3>{t('runs.dispatches')}</h3><p className={css.notice}>{t('runs.dispatchHelp')}</p>
      {view.dispatches.length === 0 ? <p>{t('planning.none')}</p> : <ol className={css.rows}>{view.dispatches.map(dispatch => <li key={dispatch.id}>
        <p><time>{time(dispatch.updatedAt)}</time> · {t(`runs.dispatch.${dispatch.state}`)}</p>
        {dispatch.reason === null ? null : <p>{t(`runs.dispatchReason.${dispatch.reason}`)}</p>}
        {dispatch.operation === null ? <p>{t('runs.noOperation')}</p> : <p>{t('runs.operation')} · {t(dispatch.operation.state === 'succeeded' ? 'runs.inputDelivered' : `planning.state.${dispatch.operation.state}`)}</p>}
        <details><summary>{t('planning.reference')}</summary><code>{dispatch.id}</code><br /><code>{dispatch.intentId}</code><br /><code>{dispatch.operation?.id}</code></details>
      </li>)}</ol>}
      <div className={css.actions}>
        {project.address.dispatchAfter === null ? null : <Button onClick={() => { actions.navigate({ dispatchAfter: null }) }}>{t('runs.firstPage')}</Button>}
        {view.nextDispatch === null ? null : <Button onClick={() => { actions.navigate({ dispatchAfter: view.nextDispatch }) }}>{t('runs.nextPage')}</Button>}
      </div>
      <h3>{t('planning.blockages')}</h3>
      {view.interventions.length === 0 ? <p>{t('planning.none')}</p> : <ul className={css.rows}>{view.interventions.map(intervention => <li key={intervention.id}>
        <p>{t(`planning.state.${intervention.state}`)} · {intervention.requiredAnswer.prompt}</p>
        {intervention.state === 'open' ? <Button onClick={props.openWork}>{t('runs.answer')}</Button> : null}
        <details><summary>{t('planning.reference')}</summary><code>{intervention.id}</code></details>
      </li>)}</ul>}
      {view.earlierInterventions ? <p>{t('runs.earlierInterventions')}</p> : null}
    </section> : null}
    {project.address.runTab === 'terminal' ? <RunTerminal project={project} actions={actions} view={view} t={t} /> : null}
  </>
}
function RunTerminal({ project, actions, view, t }: Pick<SessionPageProps, 'project' | 'actions' | 't'> & { view: RunView }) {
  const terminals = view.observation.terminals
  if (terminals.state === 'unavailable') return <p className={css.notice}>{t(`runs.terminal.${terminals.reason}`)}</p>
  const selected = terminals.selected
  return <section aria-label={t('runs.tab.terminal')}>
    <p className={css.notice}>{t('runs.terminalHelp')}</p>
    {terminals.items.length === 0 ? <p>{t('runs.terminal.empty')}</p> : <ul className={css.rows}>{terminals.items.map(terminal => <li key={terminal.id}>
      <Button aria-current={selected?.id === terminal.id ? 'true' : undefined} onClick={() => { actions.navigate({ terminal: { id: terminal.id, offset: 0 } }) }}>{terminal.name ?? terminal.type}</Button>
      <span>{t(terminal.process.state === 'running' ? 'runs.terminal.running' : 'runs.terminal.exited')}</span>
      {terminal.process.state === 'exited' ? <span>{t('runs.terminal.exit', { code: terminal.process.exitCode ?? t('planning.unavailable'), signal: terminal.process.signal ?? t('planning.none') })}</span> : null}
    </li>)}</ul>}
    {terminals.more ? <p>{t('runs.terminal.more')}</p> : null}
    {selected?.state === 'missing' ? <p role="alert">{t('runs.terminal.missing')}</p> : null}
    {selected?.state === 'confirmed' ? <>
      <p>{t('runs.terminal.range', { begin: selected.lineBegin, end: selected.lineEnd, total: selected.totalLines })}</p>
      {selected.truncated ? <p className={css.notice}>{t('runs.terminal.truncated')}</p> : null}
      <CodeBlock code={selected.text} lang="text" copyLabel={t('planning.copy')} copiedLabel={t('planning.copied')} />
      <div className={css.actions}>
        {project.address.terminal?.offset === 0 ? null : <Button onClick={() => { actions.navigate({ terminal: { id: selected.id, offset: 0 } }) }}>{t('runs.firstPage')}</Button>}
        {selected.lineEnd >= selected.totalLines ? null : <Button onClick={() => { actions.navigate({ terminal: { id: selected.id, offset: selected.lineEnd } }) }}>{t('runs.nextPage')}</Button>}
      </div>
    </> : null}
  </section>
}
