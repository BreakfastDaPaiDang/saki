/** Responsive Project planning destinations; all network and Intent ownership stays outside React. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiInjected } from '../index.ts'
import type { PlanningActions, PlanningItem, PlanningMove, PlanningProject } from '../planning-controller.ts'
import type { SakiNavigationActionsFace } from '../navigation.ts'
import { BOARD_STATUSES, planningCards } from '../planning-cards.ts'
import type { BoardStatus, WorkItemId } from '../planning-state.ts'
import { NS } from '../locales.ts'
import { ReadHealth } from './PlanningReadHealth.tsx'
import { MappingView, MilestoneView, WorkItemView } from './PlanningDetails.tsx'
import css from './PlanningPage.module.css'

type Copy = TranslateNS<typeof NS>
/** Plain planning facts, gestures, and navigation callbacks. */
export interface PlanningPageProps {
  project: PlanningProject
  offline: boolean
  actions: PlanningActions
  nav: SakiNavigationActionsFace
  openSession: SakiInjected['openSession']
  t: Copy
}
/**
 * Render the selected Project destination, with its last confirmations and independent read health.
 * @param props - current Project snapshot and plain callbacks.
 * @returns responsive Board, detail, Milestone, or mapping repair view.
 */
export function PlanningPage(props: PlanningPageProps) {
  const { project, actions, t } = props
  const board = project.board.value
  const cards = planningCards(board, project.moves)
  const itemButtons = useRef(new Map<WorkItemId, HTMLButtonElement>())
  const [announcement, setAnnouncement] = useState('')
  useEffect(() => {
    if (project.address.view === 'board' && project.address.workItemId !== null && project.address.moveDraft === null) itemButtons.current.get(project.address.workItemId)?.focus()
  }, [project.focusVersion, project.address.view, project.address.workItemId, project.address.moveDraft])
  const showMilestone = (id: NonNullable<PlanningProject['address']['milestoneId']>) => { actions.navigate({ view: 'milestone', milestoneId: id }) }
  const lastMove = project.moves.findLast(move => move.state !== 'settled') ?? project.moves.at(-1)
  const resultAnnouncement = lastMove === undefined ? '' : moveText(lastMove, t)
  const writable = board?.effectiveMutationAvailability.available === true && !props.offline
  return <div className={css.page}>
    <header className={css.header}>
      <div><h1>{board?.confirmed?.project.title ?? t('nav.project')}</h1>
        {board?.confirmed === undefined ? null : <a href={board.confirmed.repository.url} target="_blank" rel="noreferrer">{board.confirmed.repository.nameWithOwner}</a>}
      </div>
      <div className={css.actions}>
        <Button variant="outline" onClick={() => { props.nav.clearProject() }}>{t('planning.selectProject')}</Button>
        <Button variant="outline" onClick={() => { void actions.refresh() }}>{t('planning.refresh')}</Button>
      </div>
    </header>
    <nav className={css.tabs} aria-label={t('nav.project')}>
      <Button aria-current={project.address.view === 'board' ? 'page' : undefined} onClick={actions.backToBoard}>{t('planning.board')}</Button>
      <Button aria-current={project.address.view === 'milestone' ? 'page' : undefined} onClick={() => { actions.navigate({ view: 'milestone' }) }}>{t('planning.milestones')}</Button>
      <Button onClick={() => { actions.navigate({ view: 'workspace' }) }}>{t('planning.workspace')}</Button>
      <Button onClick={() => { actions.navigate({ view: 'changes', workItemId: null, changesRunId: null }) }}>{t('changes.title')}</Button>
      <Button aria-current={project.address.view === 'mapping' ? 'page' : undefined} onClick={() => { actions.navigate({ view: 'mapping' }) }}>{t('planning.mapping')}</Button>
    </nav>
    <div className={css.live} role="status" aria-live="polite" aria-atomic="true">{announcement} {resultAnnouncement}</div>
    {props.offline ? <p className={css.notice} role="alert">{t('planning.offline')}</p> : null}
    <ReadHealth read={project.board} t={t} />
    {project.board.failure === 'denied' ? null : <>
      {board === null ? null : <div className={css.sync}>
        <span>{t(`planning.state.${board.mapping.state}`)}</span>
        <span>{t('planning.scan', { state: t(`planning.state.${board.scan.state}`) })}</span>
        {board.freshness.state === 'unavailable' ? null : <span>{t('planning.age', { seconds: Math.floor(board.freshness.ageMs / 1_000) })}</span>}
        {board.checkpoint === undefined ? null : <time dateTime={new Date(board.checkpoint.confirmedAt).toISOString()}>{t('planning.confirmedAt', { time: new Date(board.checkpoint.confirmedAt).toLocaleString() })}</time>}
        {board.failure === undefined ? null : <p role="alert">{t('planning.failure', { source: t(`planning.failure.${board.failure.failure.kind}`) })}</p>}
        {board.scan.state === 'in-flight' ? <p>{t('planning.retained')}</p> : null}
      </div>}
      {!writable && board !== null ? <p className={css.notice}>{t('planning.readOnly')}</p> : null}
      {project.address.view === 'board' ? <>
        <div className={css.filters}>
          <Input aria-label={t('planning.search')} value={project.address.filter} onChange={(event) => { actions.navigate({ filter: event.target.value }) }} />
          <label><input type="checkbox" checked={project.address.includeCanceled} onChange={(event) => { actions.navigate({ includeCanceled: event.target.checked }) }} />{t('planning.showCanceled')}</label>
        </div>
        {board?.confirmed === undefined ? <p className={css.notice}>{t('planning.noBoard')}</p> : null}
        <div className={css.board}>
          {BOARD_STATUSES.filter(status => status !== 'canceled' || project.address.includeCanceled).map((status) => {
            const all = cards.filter(card => card.status === status)
            const visible = all.filter(card => `${card.item.issueNumber} ${card.item.title}`.toLocaleLowerCase().includes(project.address.filter.toLocaleLowerCase()))
            return <section key={status} className={css.column} aria-label={t(`planning.status.${status}`)} onDragOver={(event) => { if (writable) event.preventDefault() }} onDrop={(event) => {
              event.preventDefault()
              if (writable) void actions.drop(event.dataTransfer.getData('text/plain'), status, all.at(-1)?.item ?? null)
            }}>
              <h2>{t(`planning.status.${status}`)} <span>{visible.length}</span></h2>
              {visible.length === 0 ? <p className={css.hint}>{t('planning.empty')}</p> : null}
              {visible.map(({ item, pending }) => {
                const blocked = project.moves.some(move => move.intent.workItemId === item.id && move.state !== 'settled')
                const repair = board?.mutationOverlays.find(overlay => overlay.state === 'repair-required' && overlay.workItemId === item.id)
                return <article key={item.id} className={`${css.card} ${pending ? css.pending : ''}`} draggable={writable && !blocked} onDragStart={(event) => {
                  event.dataTransfer.setData('text/plain', `${item.id} ${item.remoteFingerprint}`)
                  event.dataTransfer.effectAllowed = 'move'
                }} onDragOver={(event) => { if (writable) event.preventDefault() }} onDrop={(event) => {
                  event.preventDefault(); event.stopPropagation()
                  if (writable) void actions.drop(event.dataTransfer.getData('text/plain'), status, item)
                }}>
                  <button type="button" className={css.cardTitle} ref={(element) => { if (element === null) itemButtons.current.delete(item.id); else itemButtons.current.set(item.id, element) }} onClick={() => { actions.openItem(item.id) }}>#{item.issueNumber} {item.title}</button>
                  <p className={css.meta}>{t(`planning.status.${item.status}`)}{pending ? ` · ${t('planning.pendingLabel', { status: t(`planning.status.${status}`) })}` : ''}</p>
                  {item.notInProject ? <p className={css.badge}>{t('planning.inboxMark')}</p> : null}
                  {item.archived ? <p className={css.badge}>{t('planning.archived')}</p> : null}
                  {repair?.state === 'repair-required' ? <p className={css.hint}>{t(repair.reason === 'external-close' ? 'planning.classifyClose' : 'planning.repairReopen')}</p> : null}
                  <Button size="sm" variant="outline" disabled={!writable || blocked} onClick={() => { actions.beginMove(item) }}>{t('planning.move')}</Button>
                  {item.issueState === 'closed' && (item.status === 'done' || item.status === 'canceled') ? <Button size="sm" disabled={!writable || blocked} onClick={() => { void actions.move(item.id, item.remoteFingerprint, item.latestNonTerminalStatus ?? 'backlog') }}>{t('planning.reopen')}</Button> : null}
                </article>
              })}
            </section>
          })}
        </div>
        <MutationNotices project={project} actions={actions} openWork={props.nav.showWork} t={t} />
      </> : null}
      {project.address.view === 'detail' ? <WorkItemView project={project} actions={actions} openSession={props.openSession} openMilestone={showMilestone} t={t} /> : null}
      {project.address.view === 'milestone' ? <MilestoneView project={project} actions={actions} openMilestone={showMilestone} t={t} /> : null}
      {project.address.view === 'mapping' ? <MappingView project={project} actions={actions} t={t} /> : null}
    </>}
    {project.address.moveDraft === null || project.board.failure === 'denied' ? null : <MoveDialog draft={project.address.moveDraft} items={cards.map(card => card.item)} actions={actions} writable={writable} announce={setAnnouncement} t={t} />}
  </div>
}


function moveText(move: PlanningMove, t: Copy): string {
  if (move.state === 'pending') return t('planning.moving')
  const result = move.result
  if (result === null) return t('planning.unacknowledged')
  if (result.ok) return t('planning.succeeded')
  if (result.reason === 'conflict') return t('planning.conflict')
  if (result.reason === 'reconciliation-required') return t('planning.reconciliation')
  if ('receipt' in result && result.receipt.state === 'partial-failure') return `${t('planning.state.partial-failure')} · ${t(`planning.stage.${result.receipt.stage}`)}`
  if (result.reason === 'canceled' || result.reason === 'denied') return t('planning.state.canceled')
  return t('planning.unacknowledged')
}
function MutationNotices(props: { project: PlanningProject; actions: PlanningActions; openWork: () => void; t: Copy }) {
  const { project, actions, t } = props
  const external = project.board.value?.mutationOverlays.filter(overlay => 'intentId' in overlay && !project.moves.some(move => move.intent.intentId === overlay.intentId)) ?? []
  return <div className={css.notices}>
    {project.moves.map(move => <div className={css.notice} key={move.intent.intentId}>
      <p>{t('planning.moveTargetLabel', { status: t(`planning.status.${move.intent.targetStatus}`) })} · {moveText(move, t)}</p>
      {move.state === 'unacknowledged' && (move.result === null || move.result.ok || move.result.reason !== 'reconciliation-required') ? <Button onClick={() => { void actions.retryMove(move.intent.intentId) }}>{t('planning.retryMove')}</Button> : null}
    </div>)}
    {external.map(overlay => 'intentId' in overlay && (overlay.state === 'partial-failure' || overlay.state === 'reconciliation-required' || (overlay.state === 'optimistic' && overlay.type === 'create-work-item')) ? <div key={overlay.intentId} className={css.notice}>
      <p>{t(overlay.type === 'create-work-item' ? 'planning.createPending' : 'planning.reconciliation')}{'stage' in overlay ? ` · ${t(`planning.stage.${overlay.stage}`)}` : ''}</p>
      {overlay.type === 'create-work-item' ? <Button onClick={props.openWork}>{t('planning.workRecovery')}</Button> : null}
    </div> : null)}
  </div>
}
function MoveDialog(props: {
  draft: NonNullable<PlanningProject['address']['moveDraft']>
  items: readonly PlanningItem[]
  actions: PlanningActions
  writable: boolean
  announce: (message: string) => void
  t: Copy
}) {
  const { draft, actions, t } = props
  const item = props.items.find(item => item.id === draft.workItemId)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close() } }, [])
  const candidates = props.items.filter(item => item.id !== draft.workItemId && item.status === draft.targetStatus)
  return <dialog ref={dialog} className={css.dialog} onCancel={(event) => { event.preventDefault(); actions.closeMove() }} aria-labelledby="saki-move-title">
    <form onSubmit={(event) => {
      event.preventDefault()
      if (item === undefined || !props.writable) return
      const after = draft.position === 'keep' ? undefined : draft.position === 'top' ? null : draft.afterFingerprint === null ? undefined : { id: draft.position, fingerprint: draft.afterFingerprint }
      props.announce(t('planning.moveAnnounce', { source: t(`planning.status.${item.status}`), target: t(`planning.status.${draft.targetStatus}`), position: draft.position === 'keep' ? t('planning.keepPosition') : draft.position === 'top' ? t('planning.topPosition') : t('planning.afterPosition', { number: candidates.find(item => item.id === draft.position)?.issueNumber ?? '' }) }))
      void actions.move(draft.workItemId, draft.expectedRemoteFingerprint, draft.targetStatus, after)
      actions.closeMove()
    }}>
      <h2 id="saki-move-title">{t('planning.moveTitle')}</h2>
      <p>{item?.title}</p>
      <label>{t('planning.moveTarget')}<select aria-label={t('planning.moveTarget')} autoFocus value={draft.targetStatus} onChange={(event) => { actions.navigate({ moveDraft: { ...draft, targetStatus: event.target.value as BoardStatus, position: 'keep', afterFingerprint: null } }) }}>{BOARD_STATUSES.map(status => <option key={status} value={status}>{t(`planning.status.${status}`)}</option>)}</select></label>
      <label>{t('planning.movePosition')}<select aria-label={t('planning.movePosition')} value={draft.position} onChange={(event) => {
        const position = event.target.value
        const after = candidates.find(item => item.id === position)
        if (position === 'keep' || position === 'top' || after !== undefined) actions.navigate({ moveDraft: { ...draft, position: after?.id ?? position as 'keep' | 'top', afterFingerprint: after?.remoteFingerprint ?? null } })
      }}><option value="keep">{t('planning.keepPosition')}</option><option value="top">{t('planning.topPosition')}</option>{candidates.map(item => <option key={item.id} value={item.id}>{t('planning.afterPosition', { number: item.issueNumber })} · {item.title}</option>)}</select></label>
      <div className={css.actions}><Button onClick={actions.closeMove}>{t('planning.cancel')}</Button><Button type="submit" variant="primary" disabled={!props.writable || item === undefined}>{t('planning.confirmMove')}</Button></div>
    </form>
  </dialog>
}
