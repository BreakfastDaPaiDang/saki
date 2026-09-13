/** Project-wide Git review with bounded Diff pages and explicit index/commit gestures. */
import { useEffect, useRef } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiInjected } from '../index.ts'
import type { PlanningActions, PlanningProject } from '../planning-controller.ts'
import { changesSettled, type ChangesActions, type ChangesSnapshot } from '../changes-controller.ts'
import type { ChangesIntent } from '../changes-state.ts'
import { NS } from '../locales.ts'
import { changesReasonKey } from '../changes-feedback.ts'
import css from './ChangesPage.module.css'

/** Project destination, confirmed Git facts, and plain gestures. */
export interface ChangesPageProps {
  project: PlanningProject
  state: ChangesSnapshot
  actions: ChangesActions
  planning: PlanningActions
  openSession: SakiInjected['openSession']
  t: TranslateNS<typeof NS>
}

/**
 * @param props - Project context and controller-owned observations and requests.
 * @returns the Changes workspace, including recovery and commit confirmation.
 */
export function ChangesPage(props: ChangesPageProps) {
  const { state, actions, project, planning, t } = props
  const projection = state.read.value
  const observation = projection?.result.ok === true ? projection.result.observation : null
  const operation = state.operation
  const busy = state.read.loading || state.read.failure !== null || operation !== null
  const selectedRun = project.detail.value?.runs.find(run => run.id === project.address.changesRunId)
  const page = state.diff.value?.ok === true ? state.diff.value.page : null
  const request = state.selection
  const nextCursor = page?.nextCursor
  const failure = state.read.failure ?? (projection?.result.ok === false ? projection.result.reason : null)
  const diffFailure = state.diff.failure ?? (state.diff.value?.ok === false ? state.diff.value.reason : null)
  const result = operation?.result
  return <div className={css.page}>
    <header className={css.header}>
      <div><h1>{t('changes.title')}</h1><p>{project.board.value?.confirmed?.project.title}</p></div>
      <div className={css.actions}>
        <Button variant="outline" onClick={() => { planning.navigate({ view: project.address.workItemId === null ? 'board' : 'detail' }) }}>{t(project.address.workItemId === null ? 'planning.back' : 'changes.backItem')}</Button>
        {selectedRun === undefined ? null : <Button onClick={() => { props.openSession(selectedRun.sessionId) }}>{t('planning.openSession')}</Button>}
        <Button variant="outline" disabled={state.read.loading} onClick={() => { void actions.refresh() }}>{t('changes.refresh')}</Button>
      </div>
    </header>
    <p className={css.notice}>{t('changes.scope')}</p>
    {selectedRun === undefined ? null : <p>{t('changes.fromRun')} <code>{selectedRun.id}</code></p>}
    {state.read.loading ? <p role="status">{t('changes.loading')}</p> : null}
    {failure === null ? null : <p role="alert">{t('changes.readFailure')} <span>{t(changesReasonKey(failure))}</span></p>}
    {operation === null ? null : <section className={css.notice} aria-label={t('changes.operation')}>
      <p role="status">{t(operation.pending ? 'changes.pending' : result == null || !('receipt' in result) ? 'changes.unknown' : result.ok ? 'changes.succeeded' : result.reason === 'reconciliation-required' ? 'changes.reconciliation' : result.reason === 'unavailable' ? 'changes.accepted' : 'changes.rejected')}</p>
      {result?.ok === true && result.receipt.result.type === 'commit' ? <p>{t('planning.commit')} <code>{result.receipt.result.commitId}</code></p> : null}
      {result?.ok === false ? <p>{t(changesReasonKey('receipt' in result && 'reason' in result.receipt ? result.receipt.reason : result.reason))}</p> : null}
      <details><summary>{t('planning.reference')}</summary><code>{operation.intent.intentId}</code></details>
      {operation.pending ? null : changesSettled(operation.result) ? <Button onClick={actions.dismiss}>{t('changes.acknowledge')}</Button> : <Button onClick={() => { void actions.retry() }}>{t('changes.retry')}</Button>}
    </section>}
    {projection?.gitOperations.current === undefined ? null : <p className={css.notice}>{t('changes.writer')} <code>{projection.gitOperations.current.intentId}</code> · {t(changesReasonKey(projection.gitOperations.current.state))}</p>}
    {observation === null || projection === null ? null : <>
      <dl className={css.facts}>
        <div><dt>{t('changes.branch')}</dt><dd>{observation.branch.kind === 'attached' ? observation.branch.name : t('changes.detached')}</dd></div>
        <div><dt>{t('planning.commit')}</dt><dd><code>{observation.head.kind === 'commit' ? observation.head.objectId : t('changes.unborn')}</code></dd></div>
        <div><dt>{t('changes.observed')}</dt><dd><time dateTime={new Date(observation.observedAt).toISOString()}>{new Date(observation.observedAt).toLocaleString()}</time></dd></div>
      </dl>
      <p>{t('changes.refreshHint')}</p>
      <div className={css.workspace}>
        <section aria-label={t('changes.files')} className={css.files}>
          <h2>{t('changes.files', { count: observation.changes.length })}</h2>
          {observation.changes.length === 0 ? <p>{t('changes.clean')}</p> : <ul>{observation.changes.map(row => <li key={row.id}>
            <code className={css.path}>{row.path}</code>
            <p>{t(`changes.attribution.${row.attribution}`)}</p>
            <div className={css.actions}>
              {row.kind === 'ordinary' && row.indexStatus !== 'unchanged' ? <>
                <Button size="sm" disabled={state.read.loading || state.read.failure !== null} onClick={() => { void actions.selectDiff({ expectedStatus: observation.fingerprint, changeId: row.id, layer: 'staged' }) }}>{t('changes.stagedDiff')}</Button>
                <Button size="sm" variant="outline" disabled={busy || !projection.gitOperations.unstageFiles.available} onClick={() => { void actions.changeIndex(row, 'unstage-files') }}>{t('changes.unstage')}</Button>
              </> : null}
              {row.kind !== 'ordinary' || row.worktreeStatus !== 'unchanged' ? <>
                <Button size="sm" disabled={state.read.loading || state.read.failure !== null} onClick={() => { void actions.selectDiff({ expectedStatus: observation.fingerprint, changeId: row.id, layer: row.kind === 'unmerged' ? 'conflict' : 'unstaged' }) }}>{t(row.kind === 'unmerged' ? 'changes.conflictDiff' : 'changes.unstagedDiff')}</Button>
                <Button size="sm" variant="outline" disabled={busy || !projection.gitOperations.stageFiles.available} onClick={() => { void actions.changeIndex(row, 'stage-files') }}>{t('changes.stage')}</Button>
              </> : null}
            </div>
          </li>)}</ul>}
          <>{(['stageFiles', 'unstageFiles', 'createCommit'] as const).map((action) => {
            const availability = projection.gitOperations[action]
            return availability.available ? null : <p key={action} className={css.notice}>{t(`changes.action.${action}`)}: {availability.reasons.map(reason => t(changesReasonKey(reason))).join(' · ')}</p>
          })}</>
        </section>
        <section className={css.diff} aria-label={t('changes.diff')}>
          <h2>{t('changes.diff')}</h2>
          {state.selection === null ? <p>{t('changes.chooseFile')}</p> : <p><code>{observation.changes.find(row => row.id === state.selection?.changeId)?.path}</code> · {t(state.selection.layer === 'staged' ? 'changes.stagedDiff' : state.selection.layer === 'conflict' ? 'changes.conflictDiff' : 'changes.unstagedDiff')}</p>}
          {state.diff.loading ? <p role="status">{t('changes.loading')}</p> : null}
          {diffFailure === null ? null : <p role="alert">{t('changes.diffFailure')} {t(changesReasonKey(diffFailure))}</p>}
          {page === null || request === null ? null : <>
            <p>{t('changes.range', { from: page.range.startLine + 1, to: page.range.endLineExclusive, total: page.range.totalLines })}</p>
            {page.truncated ? <p className={css.notice}>{t('changes.bounded', { before: page.omittedBeforeLines, after: page.omittedAfterLines })}</p> : null}
            <pre tabIndex={0}>{page.lines.map((line, index) => <span key={index} className={line.startsWith('+') ? css.added : line.startsWith('-') ? css.removed : undefined}>{line}{'\n'}</span>)}</pre>
            <div className={css.actions}>
              {page.omittedBeforeLines === 0 ? null : <Button onClick={() => { const { cursor: _cursor, ...first } = request; void actions.selectDiff(first) }}>{t('changes.firstPage')}</Button>}
              {nextCursor === undefined ? null : <Button onClick={() => { void actions.selectDiff({ ...request, cursor: nextCursor }) }}>{t('changes.nextPage')}</Button>}
            </div>
          </>}
        </section>
      </div>
      <form className={css.commit} onSubmit={(event) => { event.preventDefault(); actions.prepareCommit() }}>
        <label htmlFor="saki-commit-message">{t('changes.message')}</label>
        <textarea id="saki-commit-message" value={state.draft.message} disabled={operation !== null} onChange={(event) => { actions.editMessage(event.target.value) }} />
        {state.inputError ? <p role="alert">{t('changes.messageInvalid')}</p> : null}
        <Button type="submit" variant="primary" disabled={busy || !projection.gitOperations.createCommit.available}>{t('changes.reviewCommit')}</Button>
      </form>
    </>}
    {state.confirmation?.type !== 'create-commit' || observation === null ? null : <CommitDialog intent={state.confirmation} actions={actions} t={t}
      paths={observation.changes.filter(row => row.kind === 'ordinary' && row.indexStatus !== 'unchanged').map(row => ({ path: row.path, attribution: row.attribution }))} />}
  </div>
}

function CommitDialog({ intent, paths, actions, t }: {
  intent: Extract<ChangesIntent, { type: 'create-commit' }>
  paths: readonly { path: string; attribution: 'inherited' | 'not-inherited' | 'unattributed' }[]
  actions: ChangesActions
  t: ChangesPageProps['t']
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => { node?.close() } }, [])
  return <dialog ref={dialog} className={css.dialog} aria-labelledby="saki-commit-confirm" onCancel={(event) => { event.preventDefault(); actions.cancelCommit() }}>
    <h2 id="saki-commit-confirm">{t('changes.confirmTitle')}</h2>
    <p>{t('changes.commitScope')}</p>
    <pre>{intent.message}</pre>
    <ul>{paths.map(row => <li key={row.path}><code>{row.path}</code> · {t(`changes.attribution.${row.attribution}`)}</li>)}</ul>
    <div className={css.actions}><Button onClick={actions.cancelCommit}>{t('planning.cancel')}</Button><Button variant="primary" onClick={() => { void actions.confirmCommit() }}>{t('changes.confirmCommit')}</Button></div>
  </dialog>
}
