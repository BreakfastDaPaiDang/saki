/** Cross-Project Work, explicit requirement creation, and operator gestures. */
import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiWireProjectId } from '@breakfastdapaidang/saki-host-api/wire'
import type { NS, SakiKey } from '../locales.ts'
import type { WorkActions, WorkItem, WorkOffer, WorkOperation, WorkSnapshot } from '../work-controller.ts'
import { emptyWorkDraft } from '../work-state.ts'
import css from './WorkPage.module.css'

/** Rendering facts and user gesture callbacks for My Work. */
export interface WorkPageProps {
  state: WorkSnapshot
  actions: WorkActions
  openProject: () => void
  openBoard: (id: SakiWireProjectId) => void
  openItem: (projectId: SakiWireProjectId, id: WorkItem['workItem']['id']) => void
  t: TranslateNS<typeof NS>
}
const unavailableLabels = new Map<string, SakiKey>([
  ['active-work', 'work.reason.active'], ['action-denied', 'work.reason.denied'],
  ['acceptance-not-available', 'work.reason.acceptance'], ['terminal-work-item', 'work.reason.terminal'],
  ['reconciliation-required', 'work.reason.reconciliation'], ['binding-unavailable', 'work.reason.binding'],
  ['synchronization-unavailable', 'work.reason.synchronization'], ['operation-conditions-unavailable', 'work.reason.configuration'],
  ['automation-policy-unavailable', 'work.reason.policy'], ['budget-unavailable', 'work.reason.budget'],
  ['git-unavailable', 'work.reason.git'], ['production-credential-unavailable', 'work.reason.credentials'],
])
const groups = ['ready-to-start', 'active', 'waiting-for-operator', 'recently-finished'] as const

/**
 * Render backend groups and persist editable fields through the owner.
 * @param props - authenticated Work facts, actions, and localized copy.
 * @returns the Work page.
 */
export function WorkPage(props: WorkPageProps) {
  const { state, actions, t } = props
  const project = state.projects.value?.find(value => value.project.id === state.scope.projectId)
  const draft = state.scope.projectId === null ? emptyWorkDraft() : state.scope.drafts[state.scope.projectId] ?? emptyWorkDraft()
  const pendingCreate = state.operations.some(operation => operation.intent.type === 'create-work-item' && operation.intent.projectId === state.scope.projectId)
  const canCreate = !state.offline && !state.projects.loading && state.projects.failure === null && project?.board.failure === null && project.board.value?.effectiveMutationAvailability.available === true && project.board.value.mapping.state === 'valid' && !pendingCreate
  return <div className={css.page}>
    <header className={css.header}><h1 className={css.title}>{t('work.title')}</h1><div className={css.actions}>
      <Button variant="outline" onClick={() => { void actions.refresh() }}>{t('work.refresh')}</Button>
      <Button variant="outline" onClick={props.openProject}>{t('work.openProjects')}</Button>
    </div></header>
    <div role="status" aria-live="polite">
      {state.offline ? <p>{t('work.offline')}</p> : null}
      {state.items.loading || state.projects.loading ? <p>{t('work.loading')}</p> : null}
      {state.items.failure !== null || state.projects.failure !== null ? <p>{t('work.failedRead')}</p> : null}
      {state.inputError ? <p>{t('work.invalid')}</p> : null}
    </div>
    <section className={css.card} aria-labelledby="work-create-heading">
      <h2 id="work-create-heading" className={css.cardTitle}>{t('work.create')}</h2>
      <form className={css.form} onSubmit={(event) => { event.preventDefault(); void actions.create() }}>
        <label htmlFor="work-target-project">{t('work.project')}</label><select id="work-target-project" value={state.scope.projectId ?? ''} onChange={(event) => { actions.selectProject(state.projects.value?.find(value => value.project.id === event.target.value)?.project.id ?? null) }}>
          <option value="">{t('work.chooseProject')}</option>
          {state.projects.value?.map(value =>
            <option key={value.project.id} value={value.project.id}>{value.project.projectTitle}</option>)}
        </select>
        {project === undefined ? null : <>
          <label>{t('work.requirementTitle')}<input required value={draft.title} disabled={pendingCreate} onChange={(event) => { actions.editDraft({ title: event.target.value }) }} /></label>
          <label>{t('work.outcome')}<textarea required value={draft.intendedOutcome} disabled={pendingCreate} onChange={(event) => { actions.editDraft({ intendedOutcome: event.target.value }) }} /></label>
          <label>{t('work.criteria')}<textarea required value={draft.acceptanceCriteria} disabled={pendingCreate} onChange={(event) => { actions.editDraft({ acceptanceCriteria: event.target.value }) }} /></label>
          {!canCreate && !pendingCreate ? <p>{t('work.mappingBlocked')}</p> : null}
          <div className={css.actions}><Button type="submit" disabled={!canCreate}>{t('work.submit')}</Button>
            <Button variant="outline" onClick={() => { props.openBoard(project.project.id) }}>{t('work.openBoard')}</Button></div>
        </>}
      </form>
    </section>
    {state.operations.length === 0 ? null : <section className={css.card} aria-labelledby="work-results-heading">
      <h2 id="work-results-heading" className={css.cardTitle}>{t('work.operations')}</h2>
      {state.operations.map(operation => <Operation key={operation.intent.intentId} operation={operation} {...props} />)}
    </section>}
    <div className={css.groups}>{groups.map(group => <section key={group} className={css.group} aria-labelledby={`work-${group}`}>
      <h2 id={`work-${group}`}>{t(`work.group.${group}`)}</h2>
      {state.items.value?.filter(item => item.group === group).map(item => <WorkCard key={`${item.project.id}:${item.workItem.id}`} {...props} item={item} />)}
      {state.items.value !== null && !state.items.value.some(item => item.group === group) ? <p className={css.detail}>{t('work.empty')}</p> : null}
    </section>)}</div>
    {state.confirmation === null ? null : <Confirmation {...props} offer={state.confirmation} />}
  </div>
}

function WorkCard(props: WorkPageProps & { item: WorkItem }) {
  const { state, actions, item, t } = props
  const recommendation = item.recommendation
  return <article className={css.card}>
    <p className={css.detail}>{item.project.title} · {t(`planning.status.${item.workItem.status}`)}</p>
    <h3 className={css.cardTitle}>#{item.workItem.issueNumber} {item.workItem.title}</h3>
    {recommendation.available ? <Button disabled={state.offline || state.items.loading || state.items.failure !== null || state.operations.some(operation => recommendation.offer.type === 'give-work-item-to-agent'
      ? operation.intent.type === 'give-work-item-to-agent' && operation.intent.projectId === item.project.id && operation.intent.workItemId === item.workItem.id
      : operation.intent.type === 'answer-intervention' && operation.intent.interventionId === recommendation.offer.interventionId)}
    onClick={() => { actions.confirm(recommendation.offer) }}>{t(recommendation.offer.type === 'give-work-item-to-agent' ? 'work.give' : 'work.answer')}</Button> : <p className={css.detail}>{t(unavailableLabels.get(recommendation.reason) ?? 'work.noAction')}</p>}
    <div className={css.actions}><Button variant="outline" onClick={() => { props.openItem(item.project.id, item.workItem.id) }}>{t('work.openItem')}</Button>
      <Button variant="outline" onClick={() => { props.openBoard(item.project.id) }}>{t('work.openBoard')}</Button></div>
  </article>
}

function Operation(props: WorkPageProps & { operation: WorkOperation }) {
  const { operation, actions, t } = props
  const result = operation.result
  const receipt = result !== null && 'receipt' in result ? result.receipt : undefined
  const terminal = result != null && (result.ok || result.reason === 'conflict' || result.reason === 'denied' || result.reason === 'canceled')
  const partial = receipt?.state === 'partial-failure'
  const message = operation.state === 'pending' ? 'work.pending' : result === null ? 'work.unknown' : result.ok ? 'work.succeeded' : partial ? 'work.partial' : result.reason === 'reconciliation-required' ? 'work.reconcile' : terminal ? 'work.conflict' : 'work.unavailable'
  const resumable = result === null || (receipt?.state === 'partial-failure' ? receipt.recoveryAction.kind === 'resume-intent' : !terminal && receipt?.state !== 'reconciliation-required')
  const address = receipt !== undefined && 'workItemId' in receipt && receipt.workItemId !== undefined && 'projectId' in receipt ? { projectId: receipt.projectId, workItemId: receipt.workItemId } : null
  const projectId = operation.intent.type === 'answer-intervention' ? null : operation.intent.projectId
  return <article className={css.operation}>
    {operation.intent.type === 'create-work-item' ? <h3>{operation.intent.title}</h3> : null}
    <p role="status">{t(message)}</p>
    <div className={css.actions}>
      {address === null ? null : <Button variant="outline" onClick={() => { props.openItem(address.projectId, address.workItemId) }}>{t('work.openItem')}</Button>}
      {projectId === null ? null : <Button variant="outline" onClick={() => { props.openBoard(projectId) }}>{t('work.openBoard')}</Button>}
      {resumable ? <Button variant="outline" disabled={operation.state === 'pending'} onClick={() => { void actions.retry(operation.intent.intentId) }}>{t('work.retry')}</Button> : null}
      {terminal ? <Button variant="outline" onClick={() => { actions.dismiss(operation.intent.intentId) }}>{t('work.dismiss')}</Button> : null}
    </div>
  </article>
}

function Confirmation(props: WorkPageProps & { offer: WorkOffer }) {
  const { state, actions, t, offer } = props
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { dialog.current?.showModal() }, [])
  return <dialog ref={dialog} className={css.dialog} aria-labelledby="work-confirm-heading" onCancel={() => { actions.confirm(null) }}>
    <h2 id="work-confirm-heading">{t(offer.type === 'give-work-item-to-agent' ? 'work.give' : 'work.answer')}</h2>
    {offer.type === 'give-work-item-to-agent' ? <>
      <p>{t('work.launchProfile', { profile: offer.launch.profileId, version: offer.launch.profileVersion })}</p>
      <p>{t('work.launchRoute', { provider: offer.launch.provider, model: offer.launch.model })}</p>
      <p>{t('work.launchBinding', { location: offer.launch.displayLocation, version: offer.launch.bindingRevision })}</p>
      <p>{t('work.launchChanges', { count: offer.launch.inheritedChangeEntryCount })}</p>
      <p className={css.detail}>{t('work.launchLimits')}</p>
    </> : <div className={css.form}>
      <label htmlFor="work-intervention-answer">{offer.requiredAnswer.prompt}</label>
      <textarea id="work-intervention-answer" maxLength={offer.requiredAnswer.maxLength} value={state.scope.answers[offer.interventionId] ?? ''} onChange={(event) => { actions.editAnswer(offer.interventionId, event.target.value) }} />
    </div>}
    {state.inputError ? <p role="alert">{t('work.invalid')}</p> : null}
    <div className={css.actions}><Button disabled={state.offline} onClick={() => { void actions.submitOffer() }}>{t('work.confirm')}</Button><Button variant="outline" onClick={() => { actions.confirm(null) }}>{t('work.cancel')}</Button></div>
  </dialog>
}
