/** Explicit branch publication, PR discovery, exact-Commit CI, and attributed human acceptance. */
import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChangesActions, ChangesSnapshot } from '../changes-controller.ts'
import { deliverySettled, type DeliveryActions, type DeliveryGesture, type DeliverySnapshot, type DeliveryWorkspace } from '../delivery-controller.ts'
import type { DeliveryConfirmation, DeliveryIntent } from '../delivery-state.ts'
import type { PlanningActions, PlanningProject } from '../planning-controller.ts'
import { NS } from '../locales.ts'
import css from './DeliveryPage.module.css'

/** Confirmed delivery and Git facts plus plain user gestures. */
export interface DeliveryPageProps {
  project: PlanningProject
  state: DeliverySnapshot
  actions: DeliveryActions
  git: ChangesSnapshot
  gitActions: ChangesActions
  planning: PlanningActions
  principalName: string
  t: TranslateNS<typeof NS>
}
type Copy = DeliveryPageProps['t']

/**
 * @param props - selected Work Item, safe Host observations, and explicit actions.
 * @returns the delivery destination with durable recovery independent of request transport.
 */
export function DeliveryPage({ project, state, actions, git, gitActions, planning, principalName, t }: DeliveryPageProps) {
  const workspace = state.read.value
  const view = workspace?.branchDelivery
  const record = view?.delivery
  const observation = git.read.value?.result.ok === true ? git.read.value.result.observation : null
  const operation = state.operation
  const busy = state.read.loading || state.read.failure !== null || operation !== null || git.operation !== null
  const item = project.detail.value?.workItem
  const availability = (gesture: DeliveryGesture) => workspace?.actions[gesture]
  const button = (gesture: DeliveryGesture) => <Button variant="primary" disabled={busy || availability(gesture)?.available !== true} onClick={() => { actions.prepare(gesture) }}>{t(`delivery.action.${gesture}`)}</Button>
  const blockers = (gesture: DeliveryGesture) => <ul className={css.blockers}>{availability(gesture)?.reasons.map(reason => <li key={reason}>{t(`delivery.blockage.${reason}`)}</li>)}</ul>
  return <main className={css.page}>
    <header className={css.header}>
      <div><h1>{t('delivery.title')}</h1><p>{item === undefined ? project.board.value?.confirmed?.project.title : `#${item.issueNumber} ${item.title}`}</p></div>
      <div className={css.actions}>
        <Button variant="outline" onClick={() => { planning.navigate({ view: 'detail' }) }}>{t('changes.backItem')}</Button>
        <Button variant="outline" onClick={() => { planning.navigate({ view: 'changes' }) }}>{t('changes.title')}</Button>
        <Button variant="outline" disabled={state.read.loading} onClick={() => { void actions.refresh() }}>{t('delivery.refresh')}</Button>
      </div>
    </header>
    {state.read.loading ? <p role="status">{t('planning.loading')}</p> : null}
    {state.read.failure === null ? null : <p className={css.notice} role="alert">{t('delivery.readFailure')}</p>}
    {state.inputError === null ? null : <p role="alert" className={css.notice}>{t(`delivery.input.${state.inputError}`)}</p>}
    {git.operation === null ? null : <p role="alert" className={css.notice}>{t('delivery.changesPending')}</p>}
    {operation === null ? null : <section aria-label={t('delivery.operation')} className={css.notice}>
      <p role="status">{t(operation.pending ? 'delivery.sending' : operation.result === null || !('receipt' in operation.result) ? 'delivery.unknown' : `delivery.receipt.${operation.result.receipt.state}`)}</p>
      <DeliveryTarget summary={operation.confirmation.summary} t={t} />
      {operation.confirmation.workItemId === project.address.workItemId ? null : <Button onClick={() => { planning.navigate({ workItemId: operation.confirmation.workItemId }) }}>{t('delivery.openPending')}</Button>}
      <details><summary>{t('planning.reference')}</summary><code>{operation.confirmation.request.intentId}</code>{operation.result !== null && 'receipt' in operation.result ? <p><code>{operation.result.receipt.deliveryId}</code></p> : null}</details>
      {operation.pending ? null : deliverySettled(operation.result) ? <Button onClick={actions.dismiss}>{t('changes.acknowledge')}</Button> : <Button onClick={() => { void actions.retry() }}>{t('delivery.retry')}</Button>}
    </section>}
    <div className={css.stages}>
      <section className={css.stage} aria-labelledby="delivery-select">
        <h2 id="delivery-select">{t('delivery.select')}</h2>
        <p>{t('delivery.selectHelp')}</p>
        <p>{t('delivery.localCommit')} <code>{observation?.head.kind === 'commit' ? observation.head.objectId : t('planning.unavailable')}</code></p>
        <Button variant="outline" disabled={git.read.loading} onClick={() => { void gitActions.refresh() }}>{t('delivery.refreshLocal')}</Button>
        {git.read.loading ? <p role="status">{t('changes.loading')}</p> : null}
        {git.read.failure !== null || git.read.value?.result.ok === false ? <p role="alert">{t('delivery.localUnavailable')}</p> : null}
        <fieldset className={css.form} disabled={busy || record?.phase === 'accepted'}>
          <label>{t('delivery.headRef')}<input value={state.draft.headRef ?? (observation?.branch.kind === 'attached' ? observation.branch.name : '')} onChange={(event) => { actions.editDraft({ headRef: event.target.value }) }} /></label>
          <label>{t('delivery.baseRef')}<input value={state.draft.baseRef ?? record?.baseRef ?? ''} onChange={(event) => { actions.editDraft({ baseRef: event.target.value }) }} /></label>
          {button('save')}
        </fieldset>
        {blockers('save')}
      </section>
      <section className={css.stage} aria-labelledby="delivery-push">
        <h2 id="delivery-push">{t('delivery.push')}</h2>
        {record === undefined ? <p>{t('delivery.noSelection')}</p> : <dl className={css.facts}>
          <div><dt>{t('delivery.repository')}</dt><dd>{record.target.repository.nameWithOwner}</dd></div>
          <div><dt>{t('planning.commit')}</dt><dd><code>{record.commitId}</code></dd></div>
          <div><dt>{t('delivery.headRef')}</dt><dd>{record.headRef}</dd></div>
          <div><dt>{t('delivery.baseRef')}</dt><dd>{record.baseRef}</dd></div>
        </dl>}
        <p>{t('delivery.credential')} <code>{workspace?.pushCredentialHelper ?? t('planning.unavailable')}</code></p>
        <p className={css.hint}>{t('delivery.credentialHelp')}</p>
        {record?.push === undefined ? null : <p>{t('delivery.pushedAt', { time: time(record.push.confirmedAt) })}</p>}
        {button('push')}{blockers('push')}
      </section>
      <section className={css.stage} aria-labelledby="delivery-pr">
        <h2 id="delivery-pr">{t('delivery.pullRequest')}</h2>
        <p>{t('delivery.appIdentity', { app: record?.target.installation.appId ?? workspace?.selection?.target.installation.appId ?? '—', installation: record?.target.installation.installationId ?? workspace?.selection?.target.installation.installationId ?? '—' })}</p>
        {view?.pullRequest.confirmed === undefined ? <>
          <p>{t(`delivery.association.${workspace?.association.state ?? 'unobserved'}`)}</p>
          {workspace?.association.state !== 'unique' ? null : <p><a href={workspace.association.pullRequest.url} target="_blank" rel="noreferrer">#{workspace.association.pullRequest.number} {workspace.association.pullRequest.title}</a></p>}
          {button('associate')}{blockers('associate')}
          <fieldset className={css.form} disabled={busy}>
            <label>{t('delivery.prTitle')}<input value={state.draft.title ?? item?.title ?? ''} onChange={(event) => { actions.editDraft({ title: event.target.value }) }} /></label>
            <label>{t('delivery.prBody')}<textarea rows={5} value={state.draft.body} onChange={(event) => { actions.editDraft({ body: event.target.value }) }} /></label>
            {button('create')}
          </fieldset>
          {blockers('create')}
        </> : <>
          <p><a href={view.pullRequest.confirmed.fact.url} target="_blank" rel="noreferrer">#{view.pullRequest.confirmed.fact.number} {view.pullRequest.confirmed.fact.title}</a></p>
          <p>{t(view.pullRequest.confirmed.fact.merged ? 'delivery.prMerged' : view.pullRequest.confirmed.fact.state === 'open' ? 'delivery.prOpen' : 'delivery.prClosed')}</p>
        </>}
        {button('review')}{blockers('review')}
      </section>
      <section className={css.stage} aria-labelledby="delivery-evidence">
        <h2 id="delivery-evidence">{t('delivery.evidence')}</h2>
        {view == null ? <p>{t('planning.noDelivery')}</p> : <DeliveryEvidence view={view} t={t} />}
        <p>{t('delivery.acceptHelp')}</p>
        {item === undefined ? null : <p>{t('delivery.workItemStatus')} {t(`planning.status.${item.status}`)}</p>}
        {record?.acceptance === undefined ? <>{button('accept')}{blockers('accept')}</> : <section className={css.notice} aria-label={t('delivery.acceptance')}>
          <h3>{t('delivery.acceptance')}</h3><p>{t('planning.acceptedAt', { time: time(record.acceptance.acceptedAt) })}</p>
          <p>{t('delivery.actor')} <code>{record.acceptance.actor.principalId}</code></p>
          <details><summary>{t('planning.outcome')}</summary><code>{record.acceptance.evidenceDigest}</code></details>
        </section>}
        {record?.repair === undefined ? null : <p role="alert" className={css.notice}>{t('delivery.receipt.reconciliation-required')}</p>}
      </section>
    </div>
    {state.confirmation === null ? null : <DeliveryDialog
      confirmation={state.confirmation} actions={actions} principalName={principalName} t={t} />}
  </main>
}

function DeliveryEvidence({ view, t }: { view: NonNullable<DeliveryWorkspace['branchDelivery']>; t: Copy }) {
  const ci = view.ci.confirmed?.fact
  return <>
    <p>{t('planning.ci')} <strong>{t(`planning.state.${view.ci.confirmedSummary?.state ?? 'unavailable'}`)}</strong></p>
    <dl className={css.facts}>{(['remoteRef', 'pullRequest', 'reviews', 'ci'] as const).map(source => <div key={source}>
      <dt>{t(`delivery.source.${source}`)}</dt><dd>{t(`planning.state.${view[source].current.state}`)}
        {view[source].confirmed === undefined ? null : <> · <time>{time(view[source].confirmed.confirmedAt)}</time></>}
      </dd>
    </div>)}</dl>
    {ci === undefined ? null : <>
      <p>{t('delivery.ciCommit')} <code>{ci.commitId}</code></p>
      <ul className={css.signals}>
        {ci.workflowRuns.map(run => <li key={`workflow-${run.id}`}><a href={run.url} target="_blank" rel="noreferrer">{run.name}</a> · {t(`delivery.ci.${run.conclusion ?? run.status}`)}</li>)}
        {ci.checkRuns.map(run => <li key={`check-${run.id}`}><a href={run.url} target="_blank" rel="noreferrer">{run.name}</a> · {t(`delivery.ci.${run.conclusion ?? run.status}`)}</li>)}
        {ci.commitStatuses.map(status => <li key={`status-${status.id}`}>{status.targetUrl === undefined ? status.context : <a href={status.targetUrl} target="_blank" rel="noreferrer">{status.context}</a>} · {t(`delivery.ci.${status.state}`)}</li>)}
      </ul>
    </>}
  </>
}
function DeliveryTarget({ summary, t }: { summary: DeliveryConfirmation['summary']; t: Copy }) {
  return <dl className={css.facts}>
    <div><dt>{t('delivery.repository')}</dt><dd>{summary.repository}</dd></div>
    <div><dt>{t('planning.commit')}</dt><dd><code>{summary.commitId}</code></dd></div>
    <div><dt>{t('delivery.headRef')}</dt><dd>{summary.headRef}</dd></div>
    <div><dt>{t('delivery.baseRef')}</dt><dd>{summary.baseRef}</dd></div>
  </dl>
}
function DeliveryDialog({ confirmation, actions, principalName, t }: {
  confirmation: DeliveryConfirmation
  actions: DeliveryActions
  principalName: string
  t: Copy
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close() } }, [])
  const request = confirmation.request
  const type = gestureOf(request)
  return <dialog ref={dialog} className={css.dialog} aria-labelledby="delivery-confirm" onCancel={(event) => { event.preventDefault(); actions.cancel() }}>
    <h2 id="delivery-confirm">{t(`delivery.action.${type}`)}</h2>
    <DeliveryTarget summary={confirmation.summary} t={t} />
    <p>{t('delivery.actor')} {principalName}</p>
    {type === 'push' ? <><p>{t('delivery.credential')} <code>{confirmation.summary.helper}</code></p><p>{t('delivery.credentialHelp')}</p></> : null}
    {type === 'create' || type === 'associate' ? <p>{t('delivery.appIdentity', { app: confirmation.summary.appId, installation: confirmation.summary.installationId })}</p> : null}
    {request.type === 'create-branch-delivery-pull-request' ? <><h3>{request.title}</h3><pre>{request.body}</pre></> : null}
    {request.type === 'associate-branch-delivery-pull-request' ? <p>{t('delivery.pullRequest')} #{request.pullRequestNumber}</p> : null}
    <p>{t(`delivery.confirm.${type}`)}</p>
    <div className={css.actions}><Button onClick={actions.cancel}>{t('common.cancel')}</Button><Button variant="primary" onClick={() => { void actions.confirm() }}>{t('delivery.confirmButton')}</Button></div>
  </dialog>
}
function time(value: number): string { return new Date(value).toLocaleString() }
function gestureOf(request: DeliveryIntent): DeliveryGesture {
  switch (request.type) {
    case 'save-branch-delivery': return 'save'
    case 'push-branch-delivery': return 'push'
    case 'create-branch-delivery-pull-request': return 'create'
    case 'associate-branch-delivery-pull-request': return 'associate'
    case 'mark-branch-delivery-in-review': return 'review'
    case 'accept-branch-delivery': return 'accept'
    /* v8 ignore next -- Persisted and newly prepared requests use the closed wire schemas. */
    default: return assertNever(request)
  }
}
