/** Explicit Project defaults with account revisions retained in every submitted request. */
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SakiWireProjectId, SakiWireSwitchWorkSessionModelIntent } from '@breakfastdapaidang/saki-host-api/wire'
import type { ModelAccountsActions, ModelAccountsSnapshot } from '../model-accounts-controller.ts'
import type { NS } from '../locales.ts'
import css from './ModelAccountsPage.module.css'

/**
 * Render the Project default for new chats and Runs without changing existing selections.
 * @param props - selected Project, observed accounts, durable actions and localized copy.
 * @returns Project model settings and exact-request retries.
 */
export function ProjectModelSelection(props: {
  workSession?: Pick<SakiWireSwitchWorkSessionModelIntent, 'workSessionId' | 'expectedWorkSessionRevision' | 'expectedAgentRunId'>
  projectId: SakiWireProjectId
  state: ModelAccountsSnapshot
  actions: ModelAccountsActions
  t: TranslateNS<typeof NS>
}) {
  const { state, actions, t } = props
  const [choice, setChoice] = useState('')
  const route = state.projectRoute?.projectId === props.projectId ? state.projectRoute : null
  const options = state.supply?.profiles.filter(profile => profile.connected && profile.effectiveActive)
    .flatMap(profile => profile.snapshot?.models.map(model => ({
      key: JSON.stringify([profile.id, profile.configurationRevision, model.id]),
      label: `${profile.name} · ${model.name}`,
      selection: { accountProfileId: profile.id, configurationRevision: profile.configurationRevision, model: model.id },
    })) ?? []) ?? []
  const selected = options.find(option => option.key === choice)
  const pending = state.pending.filter(intent => props.workSession === undefined
    ? intent.type === 'configure-project-model-route' && intent.projectId === props.projectId
    : intent.type === 'switch-work-session-model' && intent.workSessionId === props.workSession.workSessionId)
  const account = state.supply?.profiles.find(profile => profile.id === route?.profile.account?.selection.accountProfileId)
  return <section className={css.card}>
    <h2>{t(props.workSession === undefined ? 'modelRoute.title' : 'modelSwitch.title')}</h2>
    <p>{t(props.workSession === undefined ? 'modelRoute.help' : 'modelSwitch.help')}</p>
    {props.workSession === undefined ? <p>{t('modelRoute.current')}: {route?.profile.model === null || route === null ? t('modelRoute.unconfigured')
      : `${account?.name ?? route.profile.provider} · ${route.profile.model} · ${t('modelRoute.version', { version: route.profile.version })}`}</p> : null}
    {state.failure === null ? null : <p role="alert">{t(`accounts.failure.${state.failure}`)}</p>}
    <label>{t('modelRoute.choose')}<select value={selected?.key ?? ''} onChange={(event) => { setChoice(event.target.value) }}>
      <option value="">{t('modelRoute.placeholder')}</option>
      {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
    </select></label>
    {options.length === 0 ? <p>{t('modelRoute.noAccounts')}</p> : null}
    <div className={css.actions}>
      <button type="button" disabled={(props.workSession === undefined && route === null) || selected === undefined || state.loading || pending.length > 0}
        onClick={() => {
          if (selected === undefined) return
          if (props.workSession !== undefined) void actions.submit({ type: 'switch-work-session-model',
            projectId: props.projectId, ...props.workSession, selection: selected.selection })
          else if (route !== null) void actions.submit({ type: 'configure-project-model-route',
            projectId: props.projectId, expectedProjectRevision: route.projectRevision, selection: selected.selection })
        }}>
        {t(props.workSession === undefined ? 'modelRoute.save' : 'modelSwitch.save')}
      </button>
      <button type="button" disabled={state.loading} onClick={() => { void actions.refresh() }}>{t('accounts.refresh')}</button>
    </div>
    {pending.map(intent => <div key={intent.intentId}><p>{t('accounts.unacknowledged')}</p>
      <button type="button" onClick={() => { void actions.retry(intent) }}>{t('accounts.retry')}</button></div>)}
  </section>
}
