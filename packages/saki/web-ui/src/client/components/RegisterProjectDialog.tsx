/**
 * Register Development Project dialog: the operator supplies an existing
 * directory, the host resolves it into evidence (Git top level, branch/HEAD,
 * remotes, GitHub candidates, inherited-change baseline, duplicate/blocking
 * reasons), and only an explicit confirm submits the typed Intent carrying
 * the fingerprint and baseline from that evidence plus the expected registry
 * revision. Non-converged outcomes keep the dialog open with the completed
 * facts visible; nothing is blindly retried or duplicated.
 */
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProjectSelectionProjection } from '@breakfastdapaidang/saki-execution'
import type { SakiWireIntent, SakiWireProjectId, SakiWireProjectIndexResult } from '@breakfastdapaidang/saki-host-api/wire'
import type { SakiInjected } from '../index.ts'
import type { NS } from '../locales.ts'
import css from './RegisterProjectDialog.module.css'

/** Inspection evidence the operator reviews before confirming. */
type Selection = ProjectSelectionProjection

/** Props for the registration dialog. */
export interface RegisterProjectDialogProps {
  /** Enrolled Host choices from the Project index (exactly one today). */
  hosts: Extract<SakiWireProjectIndexResult, { ok: true }>['projection']['hosts']
  /** The revision the observed Project index carried. */
  expectedRegistryRevision: number
  /** Session-derived request token echoed on the mutation. */
  requestToken: string
  inspectProjectSelection: SakiInjected['inspectProjectSelection']
  registerDevelopmentProject: SakiInjected['registerDevelopmentProject']
  onClose: () => void
  onRegistered: (projectId: SakiWireProjectId) => void
  t: TranslateNS<typeof NS>
}

type Phase =
  | { step: 'input' }
  | { step: 'review'; selection: Selection }
  | { step: 'rejected'; reason: string }

/**
 * Render the registration dialog.
 * @param props - hosts, revisions, callbacks, and copy.
 * @returns the dialog element.
 */
export function RegisterProjectDialog(props: RegisterProjectDialogProps) {
  const { t } = props
  const [directory, setDirectory] = useState('')
  const [title, setTitle] = useState('')
  const [phase, setPhase] = useState<Phase>({ step: 'input' })
  const [pending, setPending] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)

  const inspect = async () => {
    setPending(true)
    setOutcome(null)
    const host = props.hosts[0]
    if (!host) {
      setOutcome(t('project.register.unavailable'))
      setPending(false)
      return
    }
    const result = await props.inspectProjectSelection(host.id, directory)
    setPending(false)
    if (!result.ok) {
      setOutcome(result.reason === 'denied' ? t('project.register.denied') : t('project.register.unavailable'))
      return
    }
    const inner = result.projection.result
    if (inner.ok) {
      setPhase({ step: 'review', selection: inner.selection })
      /* v8 ignore next -- String.split always yields at least one segment, so pop() never yields undefined */
      setTitle(inner.selection.displayLocation.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '')
    } else {
      setPhase({ step: 'rejected', reason: inner.reason })
    }
  }

  const confirm = async (selection: Selection) => {
    setPending(true)
    setOutcome(null)
    let result: Awaited<ReturnType<SakiInjected['registerDevelopmentProject']>>
    try {
      result = await props.registerDevelopmentProject({
        type: 'register-development-project',
        intentId: `intent-${crypto.randomUUID()}` as SakiWireIntent['intentId'],
        projectTitle: title,
        hostId: selection.hostId,
        directoryLocator: directory,
        expectedRegistryRevision: props.expectedRegistryRevision,
        confirmedFingerprint: selection.fingerprint,
        confirmedBaseline: selection.baseline,
      }, props.requestToken)
    } catch {
      // A transport or parse failure keeps the dialog open with a plain reason.
      setOutcome(t('project.register.unavailable'))
      setPending(false)
      return
    }
    setPending(false)
    if (result.ok) {
      props.onRegistered(result.receipt.projectId)
      return
    }
    switch (result.reason) {
      case 'denied': setOutcome(t('project.register.denied')); break
      case 'conflict': setOutcome(t('project.register.conflict')); break
      case 'reconciliation-required': setOutcome(t('project.register.reconciliation')); break
      default: setOutcome(t('project.register.unavailable')); break
    }
  }

  return (
    <div className={css.backdrop} role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose() }}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t('project.register.title')}>
        <header className={css.header}>
          <h2 className={css.dialogTitle}>{t('project.register.title')}</h2>
          <button type="button" className={css.close} onClick={props.onClose} aria-label={t('common.close')}>✕</button>
        </header>

        <div className={css.body}>
          <label className={css.field}>
            {t('project.register.pathLabel')}
            <input
              className={css.input}
              value={directory}
              onChange={(event) => { setDirectory(event.target.value); setPhase({ step: 'input' }) }}
              placeholder={t('project.register.pathPlaceholder')}
            />
          </label>
          {phase.step === 'input' ? (
            <div className={css.actions}>
              <button type="button" className={css.primary} disabled={!directory.trim() || pending} onClick={() => void inspect()}>
                {pending ? t('workspace.loading') : t('project.register.inspect')}
              </button>
            </div>
          ) : null}

          {phase.step === 'rejected' ? (
            <p className={css.error} role="alert">{t(`project.register.rejected.${phase.reason}` as Parameters<typeof t>[0])}</p>
          ) : null}

          {phase.step === 'review' ? (
            <>
              <dl className={css.evidence}>
                <div className={css.factRow}><dt>{t('workspace.facts.location')}</dt><dd className={css.mono}>{phase.selection.displayLocation}</dd></div>
                <div className={css.factRow}>
                  <dt>{t('workspace.facts.branch')}</dt>
                  <dd className={css.mono}>{phase.selection.detached ? t('workspace.facts.detached') : (phase.selection.branch ?? '—')}</dd>
                </div>
                <div className={css.factRow}><dt>{t('workspace.facts.head')}</dt><dd className={css.mono}>{phase.selection.head.slice(0, 10)}</dd></div>
                <div className={css.factRow}>
                  <dt>{t('project.register.remotes')}</dt>
                  <dd className={css.mono}>{phase.selection.remotes.length === 0 ? t('workspace.facts.none') : phase.selection.remotes.map(remote => remote.coordinate ?? remote.transport).join('，')}</dd>
                </div>
                <div className={css.factRow}>
                  <dt>{t('project.register.github')}</dt>
                  <dd className={css.mono}>{phase.selection.githubRepositoryCandidates?.join('，') ?? t('workspace.facts.none')}</dd>
                </div>
                <div className={css.factRow}>
                  <dt>{t('workspace.facts.inherited')}</dt>
                  <dd>
                    {phase.selection.inheritedChangeEntryCount === 0
                      ? t('workspace.facts.none')
                      : `${phase.selection.inheritedChangeEntryCount} ${t('workspace.facts.inherited.count')}`}
                    {phase.selection.baseline.kind === 'unavailable' ? `（${t('workspace.facts.baseline.unavailable')}）` : ''}
                  </dd>
                </div>
                {phase.selection.blockingReasons.length > 0 ? (
                  <div className={css.factRow}>
                    <dt>{t('project.register.blocking')}</dt>
                    <dd>{phase.selection.blockingReasons.join('；')}</dd>
                  </div>
                ) : null}
              </dl>
              <label className={css.field}>
                {t('project.register.nameLabel')}
                <input className={css.input} value={title} onChange={(event) => { setTitle(event.target.value) }} />
              </label>
              <div className={css.actions}>
                <button type="button" className={css.primary} disabled={!title.trim() || pending} onClick={() => void confirm(phase.selection)}>
                  {pending ? t('workspace.loading') : t('project.register.confirm')}
                </button>
              </div>
            </>
          ) : null}

          {outcome !== null ? <p className={css.error} role="alert">{outcome}</p> : null}
        </div>
      </div>
    </div>
  )
}
