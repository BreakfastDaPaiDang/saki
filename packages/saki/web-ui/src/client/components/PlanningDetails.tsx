/** Read-only Work Item and Milestone evidence plus explicit Status mapping repair. */
import { Button, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { sakiConfigureGitHubSynchronizationIntentSchema } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiInjected } from '../index.ts'
import type { PlanningActions, PlanningProject } from '../planning-controller.ts'
import { BOARD_STATUSES } from '../planning-cards.ts'
import type { BoardStatus, MilestoneId } from '../planning-state.ts'
import { NS } from '../locales.ts'
import { ReadHealth } from './PlanningReadHealth.tsx'
import css from './PlanningPage.module.css'

type Copy = TranslateNS<typeof NS>
type DetailProps = { project: PlanningProject; actions: PlanningActions; t: Copy }
const time = (value: number) => new Date(value).toLocaleString()

/**
 * @param props - confirmed detail and navigation callbacks.
 * @returns the selected Issue specification and durable evidence.
 */
export function WorkItemView(props: DetailProps & { openSession: SakiInjected['openSession']; openMilestone: (id: MilestoneId) => void }) {
  const { project, actions, t } = props
  const detail = project.detail.value
  const writable = project.board.value?.effectiveMutationAvailability.available === true
  return <section className={css.detail}>
    <Button onClick={actions.closeDetail}>{t(project.address.returnView === 'milestone' ? 'planning.milestones' : 'planning.back')}</Button>
    <ReadHealth read={project.detail} t={t} />
    {detail === null ? null : <>
      <h2>#{detail.workItem.issueNumber} {detail.workItem.title}</h2>
      <div className={css.actions}><span className={css.badge}>{t(`planning.status.${detail.workItem.status}`)}</span>
        <a href={detail.workItem.url} target="_blank" rel="noreferrer">{t('planning.openIssue')}</a>
        <Button variant="outline" disabled={!writable} onClick={() => { actions.beginMove(detail.workItem) }}>{t('planning.move')}</Button>
        <Button variant="outline" onClick={() => { actions.navigate({ view: 'changes', changesRunId: null }) }}>{t('changes.title')}</Button>
      </div>
      {detail.workItem.notInProject ? <p className={css.notice}>{t('planning.inboxMark')}</p> : null}
      <h3>{t('planning.body')}</h3>
      {detail.body.state === 'confirmed' ? <>
        {!detail.body.matchesBoard ? <p className={css.notice}>{t('planning.bodyMismatch')}</p> : null}
        <MarkdownText text={detail.body.markdown} labels={{ code: { copyLabel: t('planning.copy'), copiedLabel: t('planning.copied') }, footnotes: t('planning.footnotes') }} />
      </> : <p className={css.notice}>{t('planning.bodyUnavailable')}</p>}
      <h3>{t('planning.blockages')}</h3>
      {detail.interventions.length === 0 ? <p className={css.hint}>{t('planning.none')}</p> : <ul>{detail.interventions.map((intervention) => { const run = detail.runs.find(run => run.id === intervention.returnAddress.agentRunId); return <li key={intervention.id}>
        <p>{t(`planning.state.${intervention.state}`)} · {intervention.requiredAnswer.prompt}</p>
        {run === undefined ? null : <Button onClick={() => { props.openSession(run.sessionId) }}>{t('planning.openSession')}</Button>}
      </li> })}</ul>}
      <h3>{t('planning.execution')}</h3>
      {detail.runs.length === 0 ? <p className={css.hint}>{t('planning.noExecution')}</p> : <ul className={css.rows}>{detail.runs.map(run => <li key={run.id}>
        <Button onClick={() => { props.openSession(run.sessionId) }}>{t('planning.openSession')}</Button>
        <Button variant="outline" onClick={() => { actions.navigate({ view: 'changes', changesRunId: run.id }) }}>{t('changes.title')}</Button>
        <span>{t(`planning.state.${run.state}`)} · {time(run.updatedAt)}</span><code>{run.id}</code>
      </li>)}</ul>}
      <h3>{t('planning.delivery')}</h3>
      {detail.branchDelivery === null ? <p className={css.hint}>{t('planning.noDelivery')}</p> : <>
        <dl className={css.facts}>
          <div><dt>{t('planning.commit')}</dt><dd><code>{detail.branchDelivery.delivery.commitId}</code></dd></div>
          <div><dt>{t('planning.branches')}</dt><dd>{detail.branchDelivery.delivery.headRef} → {detail.branchDelivery.delivery.baseRef}</dd></div>
          <div><dt>{t('planning.delivery')}</dt><dd>{t(`planning.state.${detail.branchDelivery.delivery.phase}`)}</dd></div>
          <div><dt>{t('planning.ci')}</dt><dd>{t(`planning.state.${detail.branchDelivery.ci.confirmedSummary?.state ?? 'unavailable'}`)} · {t(`planning.state.${detail.branchDelivery.ci.current.state}`)}</dd></div>
        </dl>
        {detail.branchDelivery.pullRequest.confirmed === undefined ? null : <p><a href={detail.branchDelivery.pullRequest.confirmed.fact.url} target="_blank" rel="noreferrer">#{detail.branchDelivery.pullRequest.confirmed.fact.number} {detail.branchDelivery.pullRequest.confirmed.fact.title}</a> · {t(`planning.state.${detail.branchDelivery.pullRequest.current.state}`)}</p>}
        <ul>{detail.branchDelivery.ci.confirmed?.fact.workflowRuns.map(run => <li key={run.id}><a href={run.url} target="_blank" rel="noreferrer">{run.name}</a></li>)}{detail.branchDelivery.ci.confirmed?.fact.checkRuns.map(run => <li key={run.id}><a href={run.url} target="_blank" rel="noreferrer">{run.name}</a></li>)}</ul>
        <h4>{t('planning.outcome')}</h4>
        {detail.branchDelivery.delivery.acceptance === undefined ? <p className={css.hint}>{t('planning.none')}</p> : <>
          <p>{t('planning.acceptedAt', { time: time(detail.branchDelivery.delivery.acceptance.acceptedAt) })}</p>
          <code className={css.reference}>{detail.branchDelivery.delivery.acceptance.evidenceDigest}</code>
        </>}
      </>}
      <h3>{t('planning.milestones')}</h3>
      {detail.milestones.length === 0 ? <p className={css.hint}>{t('planning.none')}</p> : <ul>{detail.milestones.map(milestone => <li key={milestone.id}><Button onClick={() => { props.openMilestone(milestone.id) }}>{milestone.title ?? milestone.tagName}</Button> · {t(`planning.state.${milestone.phase}`)}</li>)}</ul>}
      <h3>{t('planning.activity')}</h3>
      {detail.activity.length === 0 ? <p className={css.hint}>{t('planning.none')}</p> : <ol className={css.rows}>{detail.activity.map(activity => <li key={activity.intentId}><time>{time(activity.updatedAt)}</time> · {t(`planning.state.${activity.state}`)}<details><summary>{t('planning.reference')}</summary><code>{activity.intentId}</code></details></li>)}</ol>}
      {detail.earlierActivity ? <p className={css.hint}>{t('planning.earlierActivity')}</p> : null}
    </>}
  </section>
}

/**
 * @param props - exact Milestone sources and existing destinations.
 * @returns scope, Saki phase, and Release evidence without inferred readiness.
 */
export function MilestoneView(props: DetailProps & { openMilestone: (id: MilestoneId) => void }) {
  const { project, actions, t } = props
  const view = project.milestone.value?.milestoneView
  const milestone = view?.sources.milestone.confirmed?.value
  const release = view?.sources.release.confirmed?.value
  const scope = view?.scope
  return <section className={css.detail}>
    <h2>{t('planning.milestones')}</h2>
    <ReadHealth read={project.milestones} t={t} />
    <div className={css.destinations}>{project.milestones.value?.items.map(item => <Button key={item.id} aria-current={project.address.milestoneId === item.id ? 'page' : undefined} onClick={() => { props.openMilestone(item.id) }}>{item.title ?? item.tagName} · {t(`planning.state.${item.phase}`)}</Button>)}</div>
    {project.milestones.value?.items.length === 0 ? <p className={css.hint}>{t('planning.noMilestones')}</p> : null}
    {project.address.milestoneId === null ? <p>{t('planning.chooseMilestone')}</p> : <ReadHealth read={project.milestone} t={t} />}
    {view === undefined ? null : <>
      <h3>{milestone?.title ?? view.delivery.release.tagName}</h3>
      <dl className={css.facts}>
        <div><dt>{t('planning.phase')}</dt><dd>{t(`planning.state.${view.delivery.phase}`)}</dd></div>
        <div><dt>{t('planning.due')}</dt><dd>{milestone?.dueOn == null ? t('planning.none') : time(milestone.dueOn)}</dd></div>
        <div><dt>{t('planning.releaseTag')}</dt><dd>{view.delivery.release.tagName}</dd></div>
        <div><dt>{t('planning.releaseCommit')}</dt><dd><code>{view.delivery.release.releaseCommitId}</code></dd></div>
        <div><dt>{t('planning.upstream')}</dt><dd>{view.delivery.release.upstreamRepositoryNameWithOwner}<br /><code>{view.delivery.release.upstreamCommitId}</code></dd></div>
        <div><dt>{t('planning.release')}</dt><dd>{release?.kind === 'present' ? <a href={release.release.url} target="_blank" rel="noreferrer">{release.release.tagName}</a> : t('planning.none')}</dd></div>
      </dl>
      {view.delivery.releaseEvidence === undefined ? null : <p className={css.notice}>{t('planning.released')}</p>}
      <h3>{t('planning.sourceHealth')}</h3>
      <ul>{Object.entries(view.sources).map(([source, value]) => <li key={source}>{t(source === 'board' ? 'planning.board' : source === 'milestone' ? 'planning.milestones' : source === 'release' ? 'planning.release' : source === 'tag' ? 'planning.releaseTag' : source === 'releaseCommit' ? 'planning.releaseCommit' : source === 'upstreamAncestry' ? 'planning.upstreamAncestry' : 'planning.upstream')} · {t(`planning.state.${value.current.state}`)}</li>)}</ul>
      <h3>{t('planning.scope')}</h3>
      {scope === undefined ? <p className={css.notice}>{t('planning.scopeUnavailable')}</p> : <>
        <div className={css.distribution}>{BOARD_STATUSES.map(status => <span key={status}>{t(`planning.status.${status}`)} {scope.statusCounts[status]}</span>)}</div>
        <ul className={css.rows}>{scope.items.map((item) => {
          const id = item.workItemId
          return <li key={item.issueId}>{id === undefined ? <a href={item.url} target="_blank" rel="noreferrer">#{item.number} {item.title}</a> : <Button onClick={() => { actions.openItem(id) }}>#{item.number} {item.title}</Button>} · {item.status === undefined ? t('planning.unavailable') : t(`planning.status.${item.status}`)}</li>
        })}</ul>
      </>}
      {(view.blockages.length > 0 || view.delivery.repair !== undefined) ? <div className={css.notice} role="alert">
        <h3>{t('planning.blockages')}</h3>
        <ul>{[...view.blockages, ...(view.delivery.repair?.blockages ?? [])].map((blockage, index) => <li key={index}>
          {t(`planning.blockage.${blockage.kind}`)}
          {blockage.kind === 'view-source' ? ` · ${t(blockage.source === 'board' ? 'planning.board' : 'planning.milestones')} · ${t(`planning.state.${blockage.state}`)}` : null}
          {'workItemId' in blockage ? <Button onClick={() => { actions.openItem(blockage.workItemId) }}>{view.scope?.items.find(item => item.workItemId === blockage.workItemId)?.title ?? t('planning.reference')}</Button> : null}
          {'issueId' in blockage ? <code className={css.reference}>{blockage.issueId}</code> : null}
        </li>)}</ul>
      </div> : null}
    </>}
  </section>
}

/**
 * @param props - current field discovery and exact configuration revision.
 * @returns an explicit seven-state mapping form.
 */
export function MappingView(props: DetailProps) {
  const { project, actions, t } = props
  const choices = project.mapping.value
  const draft = project.address.mappingDraft ?? { fieldId: null, options: {} }
  const fields = choices?.choices.fields.filter(field => field.kind === 'single-select') ?? []
  const field = fields.find(field => field.id === draft.fieldId)
  const option = (status: BoardStatus) => field?.options.find(option => option.id === draft.options[status])?.id
  const mapping = sakiConfigureGitHubSynchronizationIntentSchema.shape.patch.safeParse({
    statusFieldNodeId: field?.id,
    statusOptionNodeIds: {
      inbox: option('inbox'), backlog: option('backlog'), ready: option('ready'),
      inProgress: option('in-progress'), inReview: option('in-review'), done: option('done'), canceled: option('canceled'),
    },
  })
  const valid = mapping.success
  const pending = project.mappingResult === 'pending' || project.mappingResult === 'unacknowledged'
  return <section className={css.detail}>
    <h2>{t('planning.mapping')}</h2><p>{t('planning.mappingHelp')}</p>
    <ReadHealth read={project.mapping} t={t} />
    {choices !== null && fields.length === 0 ? <p className={css.notice}>{t('planning.noFields')}</p> : null}
    <form className={css.mappingForm} onSubmit={(event) => {
      event.preventDefault()
      if (!mapping.success) return
      void actions.repairMapping(mapping.data)
    }}>
      <fieldset disabled={choices?.canConfigure !== true || pending}>
        <label>{t('planning.field')}<select aria-label={t('planning.field')} value={draft.fieldId ?? ''} onChange={(event) => { actions.navigate({ mappingDraft: { fieldId: event.target.value || null, options: {} } }) }}><option value="">{t('planning.choose')}</option>{fields.map(field => <option key={field.id} value={field.id}>{field.name}</option>)}</select></label>
        {BOARD_STATUSES.map(status => <label key={status}>{t(`planning.status.${status}`)}<select aria-label={t(`planning.status.${status}`)} value={draft.options[status] ?? ''} onChange={(event) => { actions.navigate({ mappingDraft: { ...draft, options: { ...draft.options, [status]: event.target.value } } }) }}><option value="">{t('planning.choose')}</option>{field?.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>)}
        {!valid ? <p className={css.hint}>{t('planning.mappingInvalid')}</p> : null}
        <Button type="submit" variant="primary" disabled={!valid}>{t('planning.saveMapping')}</Button>
      </fieldset>
    </form>
    {project.mappingResult === 'pending' ? <p role="status">{t('planning.loading')}</p> : project.mappingResult === 'unacknowledged' ? <div className={css.notice} role="alert"><p>{t('planning.mappingPending')}</p><Button onClick={() => { void actions.retryMapping() }}>{t('planning.retryMapping')}</Button></div> : project.mappingResult === null ? null : <p className={css.notice} role="status">{t(project.mappingResult.ok ? 'planning.mappingSaved' : project.mappingResult.reason === 'conflict' ? 'planning.mappingConflict' : 'planning.unavailable')}</p>}
  </section>
}
